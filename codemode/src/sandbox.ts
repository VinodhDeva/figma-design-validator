import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export interface Limits {
  timeoutMs: number;
  memoryMb: number;
  maxOutputBytes: number;
  maxCalls: number;
}

export const DEFAULT_LIMITS: Limits = { timeoutMs: 30_000, memoryMb: 128, maxOutputBytes: 8_192, maxCalls: 50 };

export interface SandboxTool {
  /** Function name inside the sandbox (`tools.<fn>`). */
  fn: string;
  /** Upstream MCP tool name. */
  name: string;
  required: boolean;
}

export type Bridge = (name: string, input: unknown) => Promise<unknown>;

export interface RunResult {
  ok: boolean;
  output: string;
  truncated: boolean;
  calls: number;
  ms: number;
}

let denoPath: string | undefined;
function deno(): string {
  if (denoPath) return denoPath;
  const env = process.env.CODEMODE_DENO;
  if (env) return (denoPath = env);
  try {
    // The `deno` npm package ships the binary; runInstall() returns its path (installing it on first use).
    const api = createRequire(import.meta.url)('deno/install_api.cjs') as { runInstall(): string };
    return (denoPath = api.runInstall());
  } catch {
    return (denoPath = 'deno');
  }
}

// Inside the sandbox: stdout carries JSON messages to the host, stdin carries tool results back.
// Every message is checked again on the host, so code that forges messages gains nothing.
const PRELUDE = (tools: SandboxTool[]) => `const enc = new TextEncoder();
const send = (m) => { const b = enc.encode(JSON.stringify(m) + "\\n"); let n = 0; while (n < b.length) n += Deno.stdout.writeSync(b.subarray(n)); };
const pending = new Map(); let seq = 0;
(async () => {
  let buf = "";
  for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
    buf += chunk; let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      const p = pending.get(m.id); if (!p) continue; pending.delete(m.id);
      if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error));
    }
  }
})();
const callTool = (name, input = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); send({ t: "call", id, name, input }); });
const fmt = (a) => a.map((x) => typeof x === "string" ? x : Deno.inspect(x, { depth: 6, colors: false, compact: true, breakLength: Infinity })).join(" ");
for (const k of ["log", "info", "warn", "error", "debug"]) console[k] = (...a) => send({ t: "log", s: fmt(a) });
const tools = Object.freeze({
${tools.map((t) => `  ${t.fn}: (input${t.required ? '' : ' = {}'}) => callTool(${JSON.stringify(t.name)}, input),`).join('\n')}
});
try {
  const v = await (await import("./code.ts")).default(tools, callTool);
  let value; try { value = v === undefined ? undefined : JSON.stringify(v); } catch { value = JSON.stringify(Deno.inspect(v)); }
  send({ t: "done", value });
} catch (e) {
  send({ t: "error", stack: String(e && e.stack || e) });
}
Deno.exit(0);
`;

// User code becomes a module function on line 1, so its line numbers stay exact.
const HEADER = 'export default async function (tools, callTool) {';

/** Rewrite sandbox file URLs to `code.ts:L:C` and drop frames outside the model's code. */
export function mapStack(stack: string, dir: string): string {
  const codeUrl = `file://${join(dir, 'code.ts')}`;
  const fix = (s: string) =>
    s.split(codeUrl).join('code.ts').replace(/code\.ts:1:(\d+)/g, (_, c: string) => `code.ts:1:${Math.max(1, Number(c) - HEADER.length)}`);
  const lines = stack.split('\n');
  const head = lines.filter((l) => !/^\s+at /.test(l));
  const frames = lines.filter((l) => /^\s+at /.test(l) && l.includes(codeUrl));
  return fix([...head, ...frames].join('\n')).replaceAll(`file://${dir}/`, '');
}

function cap(s: string, max: number) {
  const b = Buffer.from(s);
  if (b.length <= max) return { text: s, truncated: false };
  return { text: `${b.subarray(0, max).toString('utf8')}\n…[truncated ${b.length - max} bytes]`, truncated: true };
}

/** Run untrusted code in a Deno subprocess with no permissions. The bridge is its only capability. */
export async function runCode(code: string, tools: SandboxTool[], bridge: Bridge, limits: Limits = DEFAULT_LIMITS): Promise<RunResult> {
  const started = Date.now();
  const dir = await mkdtemp(join(tmpdir(), 'fdv-codemode-'));
  await writeFile(join(dir, 'main.ts'), PRELUDE(tools));
  await writeFile(join(dir, 'code.ts'), `${HEADER}${code}\n}\n`);

  const child = spawn(
    deno(),
    ['run', '--no-prompt', '--no-remote', '--no-npm', '--no-config', '--no-lock', '--quiet', `--v8-flags=--max-old-space-size=${limits.memoryMb}`, join(dir, 'main.ts')],
    // No inherited env: secrets like FIGMA_TOKEN never reach the sandbox process.
    { env: { NO_COLOR: '1', DENO_NO_UPDATE_CHECK: '1', DENO_DIR: join(tmpdir(), 'fdv-codemode-deno') }, stdio: ['pipe', 'pipe', 'pipe'] },
  );

  const logs: string[] = [];
  let logBytes = 0;
  let dropped = 0;
  // Keep at most 2x the output limit in memory; a print loop cannot exhaust the host.
  const log = (s: string) => {
    if (logBytes > limits.maxOutputBytes * 2) return void (dropped += Buffer.byteLength(s) + 1);
    logBytes += Buffer.byteLength(s) + 1;
    logs.push(s);
  };
  let calls = 0;
  let stderr = '';
  let result: { ok: boolean; text: string } | undefined;
  child.stderr.on('data', (d: Buffer) => {
    if (stderr.length < 8_192) stderr += d.toString();
  });
  child.stdin.on('error', () => {});

  const timer = setTimeout(() => {
    result ??= { ok: false, text: `Error: timed out after ${limits.timeoutMs} ms` };
    child.kill('SIGKILL');
  }, limits.timeoutMs);

  const reply = (id: number, r: { ok: true; value: unknown } | { ok: false; error: string }) => {
    if (!child.killed && child.stdin.writable) child.stdin.write(JSON.stringify({ id, ...r }) + '\n');
  };

  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    let m: { t?: string; id?: number; name?: string; input?: unknown; s?: string; value?: string; stack?: string };
    try {
      m = JSON.parse(line);
    } catch {
      log(line);
      return;
    }
    if (m.t === 'log') log(String(m.s));
    else if (m.t === 'call' && typeof m.id === 'number') {
      const id = m.id;
      if (++calls > limits.maxCalls) return reply(id, { ok: false, error: `Tool call limit (${limits.maxCalls}) reached` });
      bridge(String(m.name), m.input).then(
        (value) => reply(id, { ok: true, value }),
        (e: unknown) => reply(id, { ok: false, error: e instanceof Error ? e.message : String(e) }),
      );
    } else if (m.t === 'done') result ??= { ok: true, text: m.value === undefined ? '' : `=> ${m.value}` };
    else if (m.t === 'error') result ??= { ok: false, text: mapStack(String(m.stack), dir) };
    else log(line);
  });

  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.on('close', (code, signal) => resolve({ code, signal })),
  );
  clearTimeout(timer);
  await rm(dir, { recursive: true, force: true });

  if (!result) {
    const oom = /out of memory|heap limit|OOM/i.test(stderr) || exit.signal === 'SIGABRT' || exit.signal === 'SIGTRAP';
    result = {
      ok: false,
      text: oom ? `Error: memory limit (${limits.memoryMb} MB) exceeded` : mapStack(stderr.trim() || `Error: sandbox exited (${exit.signal ?? exit.code})`, dir),
    };
  }
  const out = cap([...logs, result.text].filter(Boolean).join('\n'), limits.maxOutputBytes);
  const output = dropped && !out.truncated ? `${out.text}\n…[truncated ${dropped} bytes]` : out.text.replace(/\[truncated (\d+) bytes\]$/, (_, n: string) => `[truncated ${Number(n) + dropped} bytes]`);
  return { ok: result.ok, output, truncated: out.truncated || dropped > 0, calls, ms: Date.now() - started };
}
