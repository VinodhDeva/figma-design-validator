import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { inspectUI } from './browser/inspector.ts';
import { compareProps } from './compare/layout.ts';
import { compareImages } from './compare/screenshot.ts';
import { DEFAULT_TOLERANCES, forViewport, loadConfig, pickComponents, propNames, stylePropsSchema } from './config.ts';
import { FigmaAdapter } from './design/figma.ts';
import { toJson, toMarkdown, writeReports } from './report/report.ts';
import type { Finding, StyleProps, ValidationConfig, Viewport } from './types.ts';
import { runValidation, screenshotComponent, summarize } from './validate.ts';

export const VERSION = '0.2.0';

const INSTRUCTIONS = `Deterministic UI-vs-design validation. All comparisons run in this server; results are compact JSON.
Prefer one call to validate_layout or generate_report (mode "quick" by default) over chaining inspect_* calls.
Use mode "deep" (all viewports, all properties, screenshots, axe-core) only when needed.
This server never modifies application source. Propose fixes to the user and get explicit approval before editing code.`;

const configPath = z.string().optional().describe('Path to validation config JSON. Default: $UI_VALIDATION_CONFIG or ./ui-validation.config.json');
const components = z.array(z.string()).optional().describe('Component names from config. Default: all');
const mode = z.enum(['quick', 'deep']).optional().describe('quick (default): first viewport, key properties. deep: all viewports/properties + screenshots + a11y');
const refresh = z.boolean().optional().describe('Bypass caches');
const viewportArg = z
  .union([z.string(), z.object({ width: z.number().int().positive(), height: z.number().int().positive() })])
  .optional()
  .describe('Viewport name from config, or {width,height}');
const propList = z.array(z.enum(propNames as [string, ...string[]]));

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: typeof data === 'string' ? data : JSON.stringify(data) }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${(e as Error).message ?? e}` }], isError: true });

function safely<A>(fn: (a: A) => Promise<unknown>) {
  return async (a: A) => {
    try {
      return ok(await fn(a));
    } catch (e) {
      return fail(e);
    }
  };
}

const getConfig = (p?: string) => loadConfig(resolve(p ?? process.env.UI_VALIDATION_CONFIG ?? 'ui-validation.config.json'));

function resolveViewport(config: ValidationConfig | undefined, v: z.infer<typeof viewportArg>): Viewport {
  if (v && typeof v === 'object') return { name: `${v.width}x${v.height}`, ...v };
  if (!config) return { name: 'desktop', width: 1440, height: 900 };
  if (!v) return config.viewports[0];
  const found = config.viewports.find((x) => x.name === v);
  if (!found) throw new Error(`Unknown viewport: ${v}`);
  return found;
}

const pick = (p: StyleProps, only?: string[]) =>
  only?.length ? Object.fromEntries(Object.entries(p).filter(([k]) => only.includes(k))) : p;

export function createServer() {
  const server = new McpServer({ name: 'ui-validation-mcp', version: VERSION }, { instructions: INSTRUCTIONS });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    'inspect_design',
    {
      description: 'Expected design properties (size, spacing, typography, colors, child hierarchy) per component from Figma (cached), a local spec file, or inline config values.',
      inputSchema: { configPath, components, viewport: z.string().optional().describe('Viewport name for responsive overrides'), refresh },
      annotations: readOnly,
    },
    safely(async (a) => {
      const config = await getConfig(a.configPath);
      const vp = resolveViewport(config, a.viewport);
      const comps = pickComponents(config, a.components).map((c) => forViewport(c, vp.name));
      const r = await new FigmaAdapter(config).inspect(comps, a.refresh);
      return { source: r.source, viewport: vp.name, components: r.specs, ...(r.warnings.length && { warnings: r.warnings }) };
    }),
  );

  server.registerTool(
    'inspect_ui',
    {
      description: 'Box + computed CSS for requested components only, via Playwright. Use config components, or ad hoc url + selectors.',
      inputSchema: {
        configPath,
        components,
        url: z.string().url().optional().describe('Ad hoc: page URL (skips config)'),
        selectors: z.record(z.string(), z.string()).optional().describe('Ad hoc: {name: cssSelector}'),
        viewport: viewportArg,
        properties: propList.optional().describe('Return only these properties'),
        accessibility: z.boolean().optional().describe('Run axe-core scoped to the components'),
        refresh,
      },
      annotations: { ...readOnly, openWorldHint: true },
    },
    safely(async (a) => {
      let groups: { url: string; targets: { name: string; selector: string }[] }[];
      let config: ValidationConfig | undefined;
      if (a.url) {
        if (!a.selectors || !Object.keys(a.selectors).length) throw new Error('selectors required with url');
        groups = [{ url: a.url, targets: Object.entries(a.selectors).map(([name, selector]) => ({ name, selector })) }];
      } else {
        config = await getConfig(a.configPath);
        const cs = pickComponents(config, a.components);
        const byUrl = Map.groupBy(cs, (c) => new URL(c.path ?? '/', config!.baseUrl).toString());
        groups = [...byUrl].map(([url, g]) => ({ url, targets: g.map((c) => ({ name: c.name, selector: c.selector })) }));
      }
      const vp = resolveViewport(config, a.viewport);
      const out = [];
      for (const g of groups) {
        const r = await inspectUI({ ...g, viewport: vp, accessibility: a.accessibility, refresh: a.refresh });
        out.push({
          url: r.url,
          components: r.components.map((c) => (c.found ? { name: c.name, props: pick(c.props, a.properties) } : { name: c.name, found: false })),
          ...(r.accessibility && { accessibility: r.accessibility }),
        });
      }
      return { viewport: vp.name, pages: out };
    }),
  );

  server.registerTool(
    'validate_layout',
    {
      description: 'Deterministic comparison of expected vs actual layout (dimensions, spacing, alignment, typography, colors). Either pass expected+actual props directly, or let it resolve both from config (design + live page) in one call. Returns only mismatches. When issues are found it also writes report.html/json/md and returns the HTML path.',
      inputSchema: {
        configPath,
        components,
        viewports: z.array(z.string()).optional().describe('Viewport names. Default: quick=first, deep=all'),
        mode,
        refresh,
        component: z.string().optional().describe('Direct mode: component label'),
        expected: stylePropsSchema.optional().describe('Direct mode: expected props'),
        actual: stylePropsSchema.optional().describe('Direct mode: actual props'),
      },
      annotations: { ...readOnly, openWorldHint: true },
    },
    safely(async (a) => {
      if (a.expected || a.actual) {
        if (!a.expected || !a.actual) throw new Error('Direct mode needs both expected and actual');
        const tol = a.configPath ? (await getConfig(a.configPath)).tolerances : DEFAULT_TOLERANCES;
        const r = compareProps(a.component ?? 'component', a.expected, a.actual, tol);
        return { summary: summarize(r.findings, r.checked), findings: r.findings };
      }
      const config = await getConfig(a.configPath);
      const run = await runValidation(config, { ...a, screenshots: false });
      // Issues found: also write the HTML/JSON/Markdown report so a human gets a readable summary.
      const report = run.summary.status === 'PASS' ? undefined : (await writeReports(run, config.outputDir)).html;
      return { ...toJson(run), ...(report && { report }) };
    }),
  );

  server.registerTool(
    'compare_screenshots',
    {
      description: 'Pixel diff (pixelmatch) between reference and implementation. Pass two PNG paths, or a config component to capture it live and diff against its reference/Figma export. Returns ratio + bounding box of differences; diff image is written to disk, not returned.',
      inputSchema: {
        configPath,
        component: z.string().optional().describe('Config component to capture and compare'),
        viewport: viewportArg,
        reference: z.string().optional().describe('Reference PNG path'),
        actual: z.string().optional().describe('Implementation PNG path'),
        threshold: z.number().min(0).max(1).optional().describe('Per-pixel sensitivity 0-1 (default 0.1)'),
        maxDiffRatio: z.number().min(0).max(1).optional().describe('Allowed differing pixel share (default 0.01)'),
        diffOutput: z.string().optional().describe('Where to write the diff PNG'),
        background: z.string().optional().describe('File mode: color behind transparent pixels (default #ffffff). Live mode reads it from the page'),
        refresh,
      },
      annotations: { ...readOnly, openWorldHint: true },
    },
    safely(async (a) => {
      if (a.reference && a.actual) {
        return compareImages({
          reference: resolve(a.reference),
          actual: resolve(a.actual),
          threshold: a.threshold ?? 0.1,
          maxDiffRatio: a.maxDiffRatio ?? 0.01,
          diffOutput: a.diffOutput && resolve(a.diffOutput),
          background: a.background,
        });
      }
      if (!a.component) throw new Error('Pass reference+actual paths, or a config component');
      const config = await getConfig(a.configPath);
      const vp = resolveViewport(config, a.viewport);
      const c = forViewport(pickComponents(config, [a.component])[0], vp.name);
      const cfg = {
        ...config,
        screenshot: { threshold: a.threshold ?? config.screenshot.threshold, maxDiffRatio: a.maxDiffRatio ?? config.screenshot.maxDiffRatio },
      };
      const r = await screenshotComponent(cfg, new FigmaAdapter(config), c, vp, a.refresh);
      if (!r) return { status: 'WARNING', component: c.name, message: 'No reference image (set "reference" or figmaNodeId with FIGMA_TOKEN)' };
      return { component: c.name, viewport: vp.name, ...r };
    }),
  );

  const findingSchema = z.object({
    component: z.string(),
    property: z.string(),
    expected: z.union([z.string(), z.number(), z.null()]),
    actual: z.union([z.string(), z.number(), z.null()]),
    status: z.enum(['FAIL', 'WARNING']),
    severity: z.enum(['low', 'medium', 'high']),
    viewport: z.string().optional(),
  });

  server.registerTool(
    'generate_report',
    {
      description: 'PASS/FAIL/WARNING report with component, property, expected, actual, severity. Runs the full validation (or formats findings you pass) and writes report.html (readable summary), report.json and report.md to the output dir.',
      inputSchema: {
        configPath,
        components,
        viewports: z.array(z.string()).optional(),
        mode,
        refresh,
        findings: z.array(findingSchema).optional().describe('Format these instead of running validation'),
        format: z.enum(['json', 'markdown']).optional().describe('Inline response format (default json). Both files are always written.'),
        name: z.string().regex(/^[\w.-]+$/).optional().describe('Report file base name (default "report")'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safely(async (a) => {
      let input;
      let outputDir = resolve('ui-validation-reports');
      if (a.findings) {
        const checked = a.findings.length;
        input = { summary: summarize(a.findings as Finding[], checked), findings: a.findings as Finding[] };
        if (a.configPath) outputDir = (await getConfig(a.configPath)).outputDir;
      } else {
        const config = await getConfig(a.configPath);
        outputDir = config.outputDir;
        input = await runValidation(config, a);
      }
      const files = await writeReports(input, outputDir, a.name);
      return a.format === 'markdown' ? `${toMarkdown(input)}\nFiles: ${files.html}, ${files.json}, ${files.markdown}` : { ...toJson(input), files };
    }),
  );

  return server;
}
