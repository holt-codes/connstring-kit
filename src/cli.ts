#!/usr/bin/env node
import { parseConnectionString, redactConnectionString, ConnectionStringError } from './index.js';

function printUsage(): void {
  console.error(`usage: connstring <command> [options] <connection-string>

commands:
  parse <string>    parse and print the connection string as JSON
  redact <string>   parse and print the string with the password masked

options:
  --lenient         tolerate malformed input instead of failing
  --help            show this message
`);
}

function main(argv: string[]): number {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    printUsage();
    return args.includes('--help') ? 0 : 1;
  }

  const lenient = args.includes('--lenient');
  const positional = args.filter((a) => a !== '--lenient');
  const [command, ...rest] = positional;
  const target = rest.join(' ');

  if (!target) {
    console.error('error: missing connection string argument');
    printUsage();
    return 1;
  }

  try {
    if (command === 'parse') {
      const parsed = parseConnectionString(target, { lenient });
      console.log(JSON.stringify(parsed, null, 2));
      return 0;
    }
    if (command === 'redact') {
      console.log(redactConnectionString(target, { lenient }));
      return 0;
    }
    console.error(`error: unknown command "${command}"`);
    printUsage();
    return 1;
  } catch (err) {
    if (err instanceof ConnectionStringError) {
      console.error(`error [${err.code}]: ${err.message}`);
      console.error('rerun with --lenient to tolerate this instead of failing');
    } else {
      console.error(`error: ${(err as Error).message}`);
    }
    return 1;
  }
}

process.exit(main(process.argv));
