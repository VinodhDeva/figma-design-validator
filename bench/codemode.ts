// Benchmark (npm run bench:codemode): direct tool calling vs code mode on three workflows against the real figma-design-validator.
// There is no LLM in the loop. Each workflow is a fixed plan a model would follow; we measure what that plan
// puts into the model's context, how many model turns it needs, and how long the tools take.
//   tokens  ~= characters / 4 of tool definitions + call arguments (incl. code) + results
//   turns    = sequential model steps (parallel calls count once) + 1 final answer
//   time     = wall-clock of the tool work only (real runs add model latency per turn)
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repo = new URL('..', import.meta.url).pathname;
const tok = (s: string) => Math.round(s.length / 4);

const list = `<!doctype html><style>body{margin:0}li{height:40px}li.tall{height:60px}</style><ul>${Array.from({ length: 1000 }, (_, i) => `<li${i % 97 === 0 ? ' class="tall"' : ''}>Item ${i}</li>`).join('')}</ul>`;
const app = await readFile(join(repo, 'test/fixtures/app/index.html'));
const http = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html' }).end(req.url === '/list' ? list : app));
await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}`;

const dir = await mkdtemp(join(tmpdir(), 'cm-bench-'));
const viewports = [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 375, height: 812 }];
// Names match the design spec keys so W1 has expected values to compare.
const parts = { Card: 'card', Title: 'title', Hint: 'hint', PrimaryButton: 'primary-btn' };
const comps = Object.keys(parts);
// References = captures of the implementation, except one deliberately stale reference so W3 has something to find.
const { captureScreenshot, closeBrowser } = (await import(join(repo, 'dist/browser/inspector.js'))) as {
  captureScreenshot: (o: object) => Promise<unknown>;
  closeBrowser: () => Promise<void>;
};
for (const vp of viewports)
  for (const c of comps)
    await captureScreenshot({ url: baseUrl, viewport: vp, selector: `[data-testid=${parts[c as keyof typeof parts]}]`, outPath: join(dir, `${c}.${vp.name}.png`) });
await captureScreenshot({ url: baseUrl, viewport: viewports[0], selector: '[data-testid=title]', outPath: join(dir, 'PrimaryButton.desktop.png') });
await closeBrowser();
await writeFile(join(dir, 'spec.json'), await readFile(join(repo, 'test/fixtures/design-spec.json')));
await writeFile(
  join(dir, 'ui.json'),
  JSON.stringify({
    baseUrl,
    viewports,
    designSpecPath: 'spec.json',
    components: comps.map((c) => ({
      name: c,
      selector: `[data-testid=${parts[c as keyof typeof parts]}]`,
      reference: `${c}.desktop.png`,
      responsive: { mobile: { reference: `${c}.mobile.png` } },
    })),
  }),
);

async function connect(args: string[]) {
  const c = new Client({ name: 'bench', version: '0' });
  await c.connect(new StdioClientTransport({ command: process.execPath, args, cwd: dir, stderr: 'ignore' }));
  return c;
}
const direct = await connect([join(repo, 'dist/index.js')]);
const code = await connect([join(repo, 'dist/index.js'), '--codemode']);

type Call = { name: string; arguments: Record<string, unknown> };
/** Run a plan: steps run in order, calls within a step in parallel. */
async function measure(c: Client, defs: string, steps: Call[][]) {
  let chars = 0;
  const t0 = Date.now();
  let last = '';
  for (const step of steps) {
    const rs = await Promise.all(step.map((call) => c.callTool(call, undefined, { timeout: 300_000 }) as Promise<{ content: { text: string }[] }>));
    step.forEach((call, i) => {
      last = rs[i].content[0].text;
      chars += JSON.stringify(call.arguments).length + last.length;
    });
  }
  return { work: tok(' '.repeat(chars)), tokens: tok(' '.repeat(chars + defs.length)), turns: steps.length + 1, ms: Date.now() - t0, last };
}

const directDefs = JSON.stringify((await direct.listTools()).tools);
const codeDefs = JSON.stringify((await code.listTools()).tools);
const search = (query: string): Call => ({ name: 'search_tools', arguments: { query, detail: 'signature', limit: 1 } });
const exec = (src: string): Call => ({ name: 'execute_code', arguments: { code: src } });
const selectors = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`item${i}`, `li:nth-child(${i + 1})`]));

const workflows = [
  {
    name: 'W1 Deep validation, worst issue per component',
    direct: [[{ name: 'validate_layout', arguments: { configPath: 'ui.json', mode: 'deep' } }]],
    code: [
      [search('validate layout')],
      [
        exec(`const r = await tools.validateLayout({ configPath: "ui.json", mode: "deep" });
const rank = { high: 3, medium: 2, low: 1 };
const worst = {};
for (const f of r.findings) if (!worst[f.component] || rank[f.severity] > rank[worst[f.component].severity]) worst[f.component] = f;
return { status: r.status, worst: Object.values(worst).map((f) => \`\${f.component}: \${f.property} (\${f.severity})\`) };`),
      ],
    ],
  },
  {
    name: 'W2 1000 list rows, find wrong heights',
    direct: [[{ name: 'inspect_ui', arguments: { url: `${baseUrl}/list`, selectors, properties: ['height'] } }]],
    code: [
      [search('inspect ui computed')],
      [
        exec(`const selectors = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => ["item" + i, "li:nth-child(" + (i + 1) + ")"]));
const r = await tools.inspectUi({ url: "${baseUrl}/list", selectors, properties: ["height"] });
const rows = r.pages[0].components;
return { rows: rows.length, wrong: rows.filter((c) => c.props.height !== 40).map((c) => c.name) };`),
      ],
    ],
  },
  {
    name: 'W3 Screenshot 4 components x 2 viewports, list diffs',
    direct: [viewports.flatMap((vp) => comps.map((c) => ({ name: 'compare_screenshots', arguments: { configPath: 'ui.json', component: c, viewport: vp.name } })))],
    code: [
      [search('compare screenshots')],
      [
        exec(`const comps = ${JSON.stringify(comps)};
const runs = ["desktop", "mobile"].flatMap((viewport) => comps.map((component) => tools.compareScreenshots({ configPath: "ui.json", component, viewport })));
const rs = await Promise.all(runs);
return rs.filter((r) => r.status !== "PASS").map((r) => \`\${r.component}@\${r.viewport}: \${r.status} \${r.diffRatio}\`);`),
      ],
    ],
  },
];

const rows: string[] = [];
for (const w of workflows) {
  const d = await measure(direct, directDefs, w.direct);
  const c = await measure(code, codeDefs, w.code);
  const pct = (a: number, b: number) => `${b < a ? '−' : '+'}${Math.abs(Math.round((1 - b / a) * 100))}%`;
  rows.push(
    `| ${w.name} | ${d.tokens.toLocaleString()} | ${c.tokens.toLocaleString()} (${pct(d.tokens, c.tokens)}) | ${d.work.toLocaleString()} | ${c.work.toLocaleString()} (${pct(d.work, c.work)}) | ${d.turns} | ${c.turns} (${c.turns - 1} if API known) | ${d.ms} | ${c.ms} |`,
  );
  console.error(`${w.name}\n  code result: ${c.last.slice(0, 300)}`);
}
const table = [
  `Tool definitions: direct ${tok(directDefs).toLocaleString()} tokens (6 tools), code mode ${tok(codeDefs).toLocaleString()} tokens (search_tools, execute_code + 2 pass-through). Counted once per workflow.`,
  '',
  '| Workflow | Tokens direct | Tokens code mode | Excl. definitions: direct | Excl. definitions: code mode | Turns direct | Turns code mode | Tool ms direct | Tool ms code mode |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows,
].join('\n');
console.log(table);
await writeFile(join(repo, 'bench/codemode-results.md'), `# Benchmark results\n\nNode ${process.version}, ${new Date().toISOString().slice(0, 10)}. Method: see bench/codemode.ts header.\n\n${table}\n`);

await direct.close();
await code.close();
http.close();
