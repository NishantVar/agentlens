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

program.parse();
