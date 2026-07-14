#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();
program.name('lens').description('Observability for coding agents').version('0.1.0');
program.enablePositionalOptions();

program.command('run')
  .description('Run a coding agent CLI with capture')
  .option('--tag <k=v...>', 'attribution tag (repeatable)', (v: string, p: string[]) => [...p, v], [] as string[])
  .allowExcessArguments(true)
  .passThroughOptions(true)
  .argument('<command...>', 'the agent command, e.g. -- claude -p "hi"')
  .action(async (command: string[], opts: { tag: string[] }) => {
    const { lensRun } = await import('./run.js');
    process.exit(await lensRun({ tags: opts.tag, argv: command }));
  });

const tagOpt = (v: string, p: string[]) => [...p, v];

program.command('stats')
  .description('Aggregate token/cost stats')
  .option('--by <key>', 'group by: agent|model|runtime|run|stage|<any tag>')
  .option('--tag <k=v>', 'filter tag (repeatable)', tagOpt, [] as string[])
  .option('--since <dur>', 'e.g. 7d, 24h, 30m')
  .option('--runtime <rt>', 'claude|codex')
  .option('--json', 'machine-readable output')
  .action(async (opts) => {
    const { statsCommand } = await import('./stats.js');
    process.stdout.write(statsCommand(opts) + '\n');
  });

program.command('sessions')
  .description('List captured sessions')
  .option('--tag <k=v>', 'filter tag (repeatable)', tagOpt, [] as string[])
  .option('--since <dur>', 'e.g. 7d')
  .option('--json', 'machine-readable output')
  .action(async (opts) => {
    const { sessionsCommand } = await import('./stats.js');
    process.stdout.write(sessionsCommand(opts) + '\n');
  });

program.command('report')
  .description('Generate a self-contained HTML trace report')
  .argument('[sessionIds...]')
  .option('--tag <k=v>', 'include all sessions matching tag (repeatable)', tagOpt, [] as string[])
  .option('--out <path>', 'output file')
  .action(async (sessionIds: string[], opts: { tag: string[]; out?: string }) => {
    const { generateReport } = await import('./report.js');
    const { StoreReader } = await import('./store.js');
    const { filterIndex } = await import('./query.js');
    const { resolveTags } = await import('./tags.js');
    const { writeFileSync } = await import('node:fs');
    const reader = new StoreReader();
    let ids = sessionIds;
    if (!ids.length && opts.tag.length) {
      ids = filterIndex(reader.listIndex(), { tags: resolveTags(opts.tag, undefined) }).map((e) => e.id);
    }
    if (!ids.length) { console.error('agentlens: no sessions selected (pass ids or --tag)'); process.exit(2); }
    const out = opts.out ?? `lens-report-${ids[0]}.html`;
    writeFileSync(out, generateReport(ids, reader));
    console.log(out);
  });

program.parse();
