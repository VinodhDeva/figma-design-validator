// End-to-end over real STDIO: spawns dist/index.js exactly as Claude Code / KIRO would.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readFile, mkdtemp, writeFile, copyFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { captureScreenshot, closeBrowser } from '../../src/browser/inspector.ts';

const root = new URL('../..', import.meta.url).pathname;
let http: Server;
let client: Client;
let dir: string;
let configPath: string;

const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  assert.ok(!r.isError, r.content[0].text);
  const t = r.content[0].text;
  return t.startsWith('{') ? JSON.parse(t) : t;
};

before(async () => {
  const html = await readFile(join(root, 'test/fixtures/app/index.html'));
  http = createServer((_, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(html));
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  dir = await mkdtemp(join(tmpdir(), 'uiv-int-'));
  await copyFile(join(root, 'test/fixtures/design-spec.json'), join(dir, 'design-spec.json'));
  // Reference = current implementation, so the pixel diff must PASS.
  await captureScreenshot({ url: baseUrl, viewport: { name: 'desktop', width: 1440, height: 900 }, selector: '[data-testid=primary-btn]', outPath: join(dir, 'btn.png') });
  await closeBrowser();
  configPath = join(dir, 'ui-validation.config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      baseUrl,
      viewports: [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 375, height: 812 }],
      designSpecPath: 'design-spec.json',
      components: [
        { name: 'Card', selector: '[data-testid=card]', responsive: { mobile: { expected: { width: 375 } } } },
        { name: 'Title', selector: '[data-testid=title]' },
        { name: 'Hint', selector: '[data-testid=hint]', expected: { fontSize: 12 } },
        { name: 'PrimaryButton', selector: '[data-testid=primary-btn]', reference: 'btn.png' },
        { name: 'Missing', selector: '[data-testid=nope]', expected: { width: 10 } },
      ],
    }),
  );

  client = new Client({ name: 'it', version: '0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'dist/index.js')], cwd: dir, stderr: 'ignore' }));
});

after(async () => {
  await client?.close();
  http?.close();
});

test('registers exactly the 5 tools with schemas', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['compare_screenshots', 'generate_report', 'inspect_design', 'inspect_ui', 'validate_layout']);
  for (const t of tools) assert.equal(t.inputSchema.type, 'object');
});

test('inspect_design reads the spec file', async () => {
  const r = await call('inspect_design', { configPath, components: ['PrimaryButton'] });
  assert.equal(r.source, 'spec-file');
  assert.equal(r.components[0].props.backgroundColor, '#2563eb');
});

test('inspect_ui returns only requested props', async () => {
  const r = await call('inspect_ui', { configPath, components: ['PrimaryButton'], properties: ['width', 'backgroundColor'] });
  assert.deepEqual(r.pages[0].components[0].props, { width: 120, backgroundColor: '#2563eb' });
});

test('inspect_ui ad hoc url + selectors', async () => {
  const cfg = JSON.parse(await readFile(configPath, 'utf8'));
  const r = await call('inspect_ui', { url: cfg.baseUrl, selectors: { t: '.title' }, viewport: { width: 800, height: 600 }, properties: ['fontSize'] });
  assert.equal(r.pages[0].components[0].props.fontSize, 20);
});

test('validate_layout quick finds the seeded mismatches only', async () => {
  const r = await call('validate_layout', { configPath });
  assert.equal(r.status, 'FAIL');
  assert.deepEqual(r.viewports, ['desktop']);
  const keys = r.findings.map((f: { component: string; property: string }) => `${f.component}.${f.property}`).sort();
  assert.deepEqual(keys, ['Missing.element', 'PrimaryButton.fontSize']);
});

test('validate_layout direct mode needs no browser', async () => {
  const r = await call('validate_layout', { expected: { width: 100 }, actual: { width: 100.5 } });
  assert.equal(r.summary.status, 'PASS');
});

test('deep mode adds viewports, a11y and screenshot checks', async () => {
  const r = await call('validate_layout', { configPath, mode: 'deep', components: ['Card', 'Hint'] });
  assert.deepEqual(r.viewports, ['desktop', 'mobile']);
  const a11y = r.findings.filter((f: { property: string }) => f.property === 'a11y:color-contrast');
  assert.deepEqual(a11y.map((f: { component: string }) => f.component), ['Hint', 'Hint'], 'nested violation reported once, on innermost');
  const mobileCard = r.findings.filter((f: { component: string; viewport: string; property: string }) => f.component === 'Card' && f.viewport === 'mobile');
  assert.deepEqual(mobileCard, [], JSON.stringify(mobileCard));
});

test('compare_screenshots: live capture vs reference passes', async () => {
  const r = await call('compare_screenshots', { configPath, component: 'PrimaryButton' });
  assert.equal(r.status, 'PASS');
  assert.equal(r.diffRatio, 0);
});

test('generate_report writes JSON + Markdown', async () => {
  const md = await call('generate_report', { configPath, components: ['PrimaryButton'], format: 'markdown' });
  assert.match(md, /\| FAIL \| medium \| PrimaryButton \| desktop \| fontSize \| 16 \| 14 \|/);
  const json = JSON.parse(await readFile(join(dir, 'ui-validation-reports/report.json'), 'utf8'));
  assert.equal(json.status, 'FAIL');
  assert.ok((await stat(join(dir, 'ui-validation-reports/report.md'))).size > 0);
});

test('tool errors are returned, not thrown', async () => {
  const r = (await client.callTool({ name: 'inspect_design', arguments: { configPath: join(dir, 'missing.json') } })) as { isError?: boolean };
  assert.equal(r.isError, true);
});
