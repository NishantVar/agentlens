#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();
program.name('lens').description('Observability for coding agents').version('0.1.0');
program.parse();
