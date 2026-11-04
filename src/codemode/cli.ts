import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAll, syncFiles } from './generate.ts';
import { connectUpstream } from './upstream.ts';

/** By default code mode adopts this package's own server, started as a separate stdio process. */
// src/codemode/cli.ts (tests) -> src/index.ts; dist/codemode/cli.js -> dist/index.js.
export const SELF = { command: process.execPath, args: [fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../index.ts' : '../index.js', import.meta.url))] };

const USAGE = `figma-design-validator --codemode [--config <file>] [-- <command> <args...>]
figma-design-validator --codemode generate [--out <dir>] [--check] [-- <command> <args...>]

Without "-- <command>", code mode adopts this package's own server.
--config <file>  code mode limits and policy (JSON)
`;

/** `argv` is everything after the program name, including --codemode. */
export async function runCodemode(argv: string[]) {
  const sep = argv.indexOf('--');
  const own = (sep === -1 ? argv : argv.slice(0, sep)).filter((a) => a !== '--codemode');
  const upstream = sep === -1 ? SELF : { command: argv[sep + 1], args: argv.slice(sep + 2) };
  const flag = (name: string) => {
    const i = own.indexOf(name);
    return i === -1 ? undefined : own[i + 1];
  };

  if (own.includes('--help')) {
    console.log(USAGE);
    process.exit(0);
  }
  if (!upstream.command) {
    console.error(USAGE);
    process.exit(2);
  }

  if (own[0] === 'generate') {
    const up = await connectUpstream(upstream.command, upstream.args);
    const check = own.includes('--check');
    const out = resolve(flag('--out') ?? 'servers');
    const changed = await syncFiles(out, up.name, renderAll(up.name, up.tools), check);
    await up.close();
    if (check && changed.length) {
      console.error(`Generated wrappers are out of date (${changed.join(', ')}). Run: npm run codemode:generate`);
      process.exit(1);
    }
    console.error(check ? 'Wrappers are up to date.' : `Wrote ${changed.length} file(s) to ${out}`);
    process.exit(0);
  }

  const { serve } = await import('./server.ts');
  await serve(upstream, flag('--config'));
}
