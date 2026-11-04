#!/usr/bin/env node
import { resolve } from 'node:path';
import { renderAll, syncFiles } from './generate.ts';
import { connectUpstream, DEFAULT_UPSTREAM } from './upstream.ts';

const USAGE = `figma-design-validator-codemode [options] [-- <command> <args...>]
figma-design-validator-codemode generate [--out <dir>] [--check] [-- <command> <args...>]

Without "-- <command>", adopts: ${DEFAULT_UPSTREAM.command} ${DEFAULT_UPSTREAM.args.join(' ')}
Options: --config <file>  code mode limits and policy (JSON)
`;

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep === -1 ? argv : argv.slice(0, sep);
const upstreamCmd = sep === -1 ? DEFAULT_UPSTREAM : { command: argv[sep + 1], args: argv.slice(sep + 2) };
const flag = (name: string) => {
  const i = own.indexOf(name);
  return i === -1 ? undefined : own[i + 1];
};

if (own.includes('--help')) {
  console.log(USAGE);
  process.exit(0);
}
if (!upstreamCmd.command) {
  console.error(USAGE);
  process.exit(2);
}

if (own[0] === 'generate') {
  const up = await connectUpstream(upstreamCmd.command, upstreamCmd.args);
  const check = own.includes('--check');
  const out = resolve(flag('--out') ?? 'servers');
  const changed = await syncFiles(out, up.name, renderAll(up.name, up.tools), check);
  await up.close();
  if (check && changed.length) {
    console.error(`Generated wrappers are out of date (${changed.join(', ')}). Run: figma-design-validator-codemode generate`);
    process.exit(1);
  }
  console.error(check ? 'Wrappers are up to date.' : `Wrote ${changed.length} file(s) to ${out}`);
  process.exit(0);
}

const { serve } = await import('./server.ts');
await serve(upstreamCmd, flag('--config'));
