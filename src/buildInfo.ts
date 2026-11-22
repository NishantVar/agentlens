// `lens --version`: "<package version> <build commit>". The commit comes from
// dist/build-info.json, which `npm run build` (scripts/build.mjs) writes only
// after every build step succeeded; with no readable record it is "unknown".
// Both files are found from this module's own location, so the answer does not
// depend on the working directory or on the checkout's current HEAD.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

function read(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function buildIdentity(): string {
  const pkg = read(join(here, '..', 'package.json')) as { version?: unknown } | null;
  const version = typeof pkg?.version === 'string' ? pkg.version : 'unknown';
  const rec = read(join(here, 'build-info.json')) as { commit?: unknown } | null;
  const commit = typeof rec?.commit === 'string' && /^[0-9a-f]{40}$/.test(rec.commit) ? rec.commit : 'unknown';
  return `${version} ${commit}`;
}
