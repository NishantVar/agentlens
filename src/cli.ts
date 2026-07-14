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

program.parse();
