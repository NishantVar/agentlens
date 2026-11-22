// Process identity: a pid plus its start time, so a reused pid is never taken
// for the process that was recorded. The same `ps` text is produced at record
// time and at check time, normalized the same way, so the two always compare.
import { execFile, execFileSync } from 'node:child_process';

export interface ProcIdentity { pid: number; startTime: string | null }
export type Liveness = 'alive' | 'gone' | 'unknown';

const norm = (s: string) => s.trim().replace(/\s+/g, ' ');
const PS = () => process.env.AGENTLENS_PS || 'ps'; // test override, like AGENTLENS_LSOF

// `stat` comes first so a zombie (exited, not yet reaped) reads as gone.
function psStat(pid: number): { stat: string; startTime: string } | null {
  let out: string;
  try {
    out = execFileSync(PS(), ['-o', 'stat=,lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
  } catch { return null; }
  const m = /^\s*(\S+)\s+(.+?)\s*$/.exec(out);
  return m ? { stat: m[1], startTime: norm(m[2]) } : null;
}

export function identityOf(pid: number): ProcIdentity | null {
  const s = psStat(pid);
  return s && !s.stat.startsWith('Z') ? { pid, startTime: s.startTime } : null;
}

export function liveness(id: ProcIdentity): Liveness {
  try { process.kill(id.pid, 0); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ESRCH') return 'gone'; }
  if (id.startTime === null) return 'unknown';
  const s = psStat(id.pid);
  if (!s) return 'unknown';
  if (s.stat.startsWith('Z')) return 'gone';
  return s.startTime === norm(id.startTime) ? 'alive' : 'gone';
}

// One `ps -A` snapshot: parent links and start times of every process.
export interface ProcTable { ppid: Map<number, number>; start: Map<number, string> }
export function procTable(): Promise<ProcTable | null> {
  return new Promise((resolve) => {
    execFile(PS(), ['-A', '-o', 'pid=,ppid=,stat=,lstart='], { timeout: 2000, maxBuffer: 16 << 20 }, (err, stdout) => {
      if (err && !stdout) return resolve(null);
      const ppid = new Map<number, number>(); const start = new Map<number, string>();
      for (const line of String(stdout).split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
        if (!m || m[3].startsWith('Z')) continue;
        ppid.set(Number(m[1]), Number(m[2])); start.set(Number(m[1]), norm(m[4]));
      }
      resolve({ ppid, start });
    });
  });
}

export function descendantsIn(t: ProcTable, roots: number[]): number[] {
  const kids = new Map<number, number[]>();
  for (const [pid, pp] of t.ppid) { const k = kids.get(pp) ?? []; k.push(pid); kids.set(pp, k); }
  const out: number[] = []; const seen = new Set(roots); const q = [...roots];
  while (q.length) {
    for (const k of kids.get(q.shift()!) ?? []) if (!seen.has(k)) { seen.add(k); out.push(k); q.push(k); }
  }
  return out;
}

export async function descendants(roots: number[]): Promise<number[]> {
  const t = await procTable();
  return t ? descendantsIn(t, roots) : [];
}
