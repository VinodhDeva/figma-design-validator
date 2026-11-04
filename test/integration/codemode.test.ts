// End to end: `figma-design-validator --codemode` over stdio, adopting its own server, against a fixture app.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const repo = new URL('../..', import.meta.url).pathname;
let http: Server;
let dir: string;
let baseUrl: string;
const clients: Client[] = [];

/** 1000 list items; every 97th is taller than the rest. */
export const listPage = () =>
  `<!doctype html><style>body{margin:0}li{height:40px}li.tall{height:60px}</style><ul>${Array.from({ length: 1000 }, (_, i) => `<li${i % 97 === 0 ? ' class="tall"' : ''}>Item ${i}</li>`).join('')}</ul>`;

async function connect(elicit?: 'accept' | 'decline') {
  const c = new Client({ name: 'test', version: '0' }, elicit ? { capabilities: { elicitation: { form: {} } } } : {});
  if (elicit) c.setRequestHandler(ElicitRequestSchema, async () => (elicit === 'accept' ? { action: 'accept', content: { allow: true } } : { action: 'decline' }));
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, 'dist/index.js'), '--codemode'], cwd: dir, stderr: 'ignore' }));
  clients.push(c);
  return c;
}

const run = async (c: Client, code: string) => {
  const r = (await c.callTool({ name: 'execute_code', arguments: { code } }, undefined, { timeout: 120_000 })) as { content: { text: string }[]; isError?: boolean };
  return { ok: !r.isError, text: r.content[0].text };
};

let plain: Client;

before(async () => {
  const app = await readFile(join(repo, 'test/fixtures/app/index.html'));
  const list = listPage();
  http = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(req.url === '/list' ? list : app));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  dir = await mkdtemp(join(tmpdir(), 'cm-it-'));
  await writeFile(join(dir, 'spec.json'), await readFile(join(repo, 'test/fixtures/design-spec.json')));
  await writeFile(
    join(dir, 'ui.json'),
    JSON.stringify({
      baseUrl,
      designSpecPath: 'spec.json',
      components: [
        { name: 'Card', selector: '[data-testid=card]' },
        { name: 'PrimaryButton', selector: '[data-testid=primary-btn]' },
      ],
    }),
  );
  plain = await connect();
});

after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  http?.close();
});

test('exposes search_tools, execute_code and only side-effect tools as pass-through', async () => {
  const { tools } = await plain.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['draft_config', 'execute_code', 'generate_report', 'search_tools']);
});

test('search_tools discloses progressively', async () => {
  const r = (await plain.callTool({ name: 'search_tools', arguments: { query: 'validate layout', detail: 'signature', limit: 1 } })) as { content: { text: string }[] };
  assert.match(r.content[0].text, /^tools\.validateLayout\(input\?: \{/);
  const names = (await plain.callTool({ name: 'search_tools', arguments: { detail: 'name' } })) as { content: { text: string }[] };
  assert.equal(names.content[0].text.split('\n').length, 6);
});

test('code calls tools and returns only what it selects', async () => {
  const r = await run(plain, 'const v = await tools.validateLayout({ configPath: "ui.json" }); return v.findings.map((f) => `${f.component}.${f.property}`);');
  assert.equal(r.ok, true, r.text);
  assert.equal(r.text, '=> ["PrimaryButton.fontSize"]');
});

test('bridge validates input against the tool schema', async () => {
  const r = await run(plain, 'return await tools.inspectUi({ url: "http://127.0.0.1/", selectors: 5 });');
  assert.equal(r.ok, false);
  assert.match(r.text, /inspect_ui: invalid input: data\/selectors must be object/);
});

test('bridge blocks URLs outside allowed hosts and paths outside the root', async () => {
  const url = await run(plain, 'return await tools.inspectUi({ url: "http://169.254.169.254/latest", selectors: { a: "body" } });');
  assert.match(url.text, /URL host "169\.254\.169\.254" is not allowed/);
  const path = await run(plain, 'return await tools.inspectDesign({ configPath: "../../etc/passwd" });');
  assert.match(path.text, /configPath must stay inside/);
});

test('side-effect tool from code is denied without elicitation support', async () => {
  const r = await run(plain, 'return await tools.generateReport({ configPath: "ui.json" });');
  assert.equal(r.ok, false);
  assert.match(r.text, /generate_report has side effects and was not confirmed/);
});

test('side-effect tool from code runs only when the user accepts', async () => {
  const yes = await connect('accept');
  const ok = await run(yes, 'const r = await tools.generateReport({ configPath: "ui.json" }); return r.status;');
  assert.equal(ok.text, '=> "FAIL"');
  const no = await connect('decline');
  const denied = await run(no, 'return await tools.generateReport({ configPath: "ui.json" });');
  assert.match(denied.text, /not confirmed/);
});

test('pass-through side-effect tool works as a direct call', async () => {
  const r = (await plain.callTool({ name: 'generate_report', arguments: { configPath: 'ui.json', format: 'markdown' } })) as { content: { text: string }[] };
  assert.match(r.content[0].text, /PrimaryButton/);
});

test('1000-row result from a real tool is filtered in code to under 1 KB', async () => {
  const code = `
const selectors = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ["item" + i, "li:nth-child(" + (i + 1) + ")"]));
const r = await tools.inspectUi({ url: "${'BASE'}/list", selectors, properties: ["height"] });
const rows = r.pages[0].components;
const tall = rows.filter((c) => c.props.height !== 40).map((c) => c.name);
return { rows: rows.length, tall };`;
  const r = await run(plain, code.replace('BASE', baseUrl));
  assert.equal(r.ok, true, r.text);
  assert.ok(Buffer.byteLength(r.text) < 1_024, `${Buffer.byteLength(r.text)} bytes`);
  const v = JSON.parse(r.text.replace(/^=> /, ''));
  assert.equal(v.rows, 1000);
  assert.deepEqual(v.tall, Array.from({ length: 11 }, (_, i) => `item${i * 97}`));
});
