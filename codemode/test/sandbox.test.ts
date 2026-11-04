import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCode, type Bridge, type SandboxTool } from '../src/sandbox.ts';

const tools: SandboxTool[] = [{ fn: 'echo', name: 'echo', required: false }];
const echo: Bridge = async (_name, input) => input;
const limits = { timeoutMs: 5_000, memoryMb: 64, maxOutputBytes: 1_024, maxCalls: 5 };
const run = (code: string, bridge: Bridge = echo, l = limits) => runCode(code, tools, bridge, l);

test('returns logs and the return value', async () => {
  const r = await run('console.log("hi", { a: 1 }); const x: number = 2; return { x };');
  assert.equal(r.ok, true, r.output);
  assert.equal(r.output, 'hi { a: 1 }\n=> {"x":2}');
});

test('tool calls go through the bridge and are counted', async () => {
  const seen: unknown[] = [];
  const r = await run('const v = await tools.echo({ n: 1 }); return v;', async (name, input) => (seen.push([name, input]), { got: input }));
  assert.equal(r.output, '=> {"got":{"n":1}}');
  assert.deepEqual(seen, [['echo', { n: 1 }]]);
  assert.equal(r.calls, 1);
});

test('bridge errors reject inside the code', async () => {
  const r = await run('try { await tools.echo({}); } catch (e) { return "caught: " + e.message; }', async () => {
    throw new Error('denied');
  });
  assert.equal(r.output, '=> "caught: denied"');
});

test('call limit is enforced', async () => {
  const r = await run('for (let i = 0; i < 10; i++) await tools.echo({ i });');
  assert.equal(r.ok, false);
  assert.match(r.output, /Tool call limit \(5\) reached/);
});

const blocked: [string, string, RegExp][] = [
  ['fetch', 'await fetch("https://example.com")', /NotCapable|net access/],
  ['remote import', 'await import("https://deno.land/std/version.ts")', /remote specifier/],
  ['npm import', 'await import("npm:left-pad")', /npm specifiers/],
  ['node:fs', 'return (await import("node:fs")).readFileSync("/etc/hosts", "utf8")', /NotCapable|read access/],
  ['node:net', 'const net = await import("node:net"); await new Promise((res, rej) => net.connect(80, "127.0.0.1").on("connect", res).on("error", rej))', /NotCapable|net access/],
  ['node:child_process', 'return (await import("node:child_process")).execSync("/usr/bin/id").toString()', /NotCapable/],
  ['require', 'return require("fs")', /require is not defined/],
  ['Deno.env', 'return Deno.env.toObject()', /NotCapable|env access/],
  ['process.env', 'return (await import("node:process")).env.HOME', /NotCapable|env access/],
  ['Deno.Command', 'return await new Deno.Command("/usr/bin/id").output()', /NotCapable|run access/],
  ['write file', 'Deno.writeTextFileSync("/tmp/codemode-escape", "x")', /NotCapable|write access/],
];
for (const [name, code, err] of blocked) {
  test(`blocked: ${name}`, async () => {
    const r = await run(code);
    assert.equal(r.ok, false, `${name} was allowed: ${r.output}`);
    assert.match(r.output, err);
  });
}

test('infinite loop is killed at the timeout', async () => {
  const r = await run('while (true) {}', echo, { ...limits, timeoutMs: 1_500 });
  assert.equal(r.ok, false);
  assert.match(r.output, /timed out after 1500 ms/);
  assert.ok(r.ms < 4_000);
});

test('memory limit stops runaway allocation', async () => {
  const r = await run('const a = []; while (true) a.push(new Array(1e6).fill(1));', echo, { ...limits, timeoutMs: 20_000 });
  assert.equal(r.ok, false);
  assert.match(r.output, /memory limit \(64 MB\) exceeded/);
});

test('output is truncated with a marker, including print loops', async () => {
  const r = await run('for (let i = 0; i < 5000; i++) console.log("line " + i);');
  assert.equal(r.truncated, true);
  assert.ok(Buffer.byteLength(r.output) < 1_200);
  assert.match(r.output, /…\[truncated \d+ bytes\]$/);
});

test('errors point at the model code, not internals', async () => {
  const r = await run('const a = 1;\nconst b = 2;\nthrow new Error("bad " + (a + b));');
  assert.equal(r.ok, false);
  assert.match(r.output, /^Error: bad 3\n\s+at .*code\.ts:3:7/);
  assert.doesNotMatch(r.output, /main\.ts|file:\/\/|fdv-codemode/);
});

test('syntax errors are mapped too', async () => {
  const r = await run('const x = ;');
  assert.equal(r.ok, false);
  assert.match(r.output, /code\.ts/);
  assert.doesNotMatch(r.output, /fdv-codemode-/);
});

test('1000-row payload filtered in code stays under 1 KB', async () => {
  const rows = Array.from({ length: 1500 }, (_, i) => ({ name: `item-${i}`, height: i % 97 === 0 ? 60 : 40, width: 320 }));
  const r = await run('const { rows } = await tools.echo(); const bad = rows.filter((r) => r.height !== 40); return { total: rows.length, bad: bad.map((r) => r.name) };', async () => ({ rows }));
  assert.equal(r.ok, true, r.output);
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) > 50_000);
  assert.ok(Buffer.byteLength(r.output) < 1_024, `${Buffer.byteLength(r.output)} bytes`);
  assert.match(r.output, /"total":1500/);
});
