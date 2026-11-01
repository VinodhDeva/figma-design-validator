import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { MemoryCache, hashKey } from '../cache.ts';
import { normalizeColor } from '../compare/color.ts';
import type { InspectedComponent, StyleProps, Viewport } from '../types.ts';

const require = createRequire(import.meta.url);

let browser: Promise<Browser> | undefined;

/** One headless browser per server process, launched lazily. */
function getBrowser() {
  browser ??= chromium.launch({ headless: true }).catch((e) => {
    browser = undefined;
    throw new Error(
      `Cannot launch Chromium (${(e as Error).message.split('\n')[0]}). Run: npx playwright install chromium`,
    );
  });
  return browser;
}

export async function closeBrowser() {
  const b = browser;
  browser = undefined;
  if (b) await (await b).close().catch(() => {});
}

async function withPage<T>(url: string, vp: Viewport, fn: (page: Page) => Promise<T>, waitFor?: string): Promise<T> {
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 1 });
  try {
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    if (waitFor) await page.waitForSelector(waitFor, { timeout: 10_000 });
    return await fn(page);
  } finally {
    await ctx.close();
  }
}

export interface Target {
  name: string;
  selector: string;
}

export interface A11yViolation {
  component: string;
  rule: string;
  impact: string | null;
  nodes: number;
  help: string;
}

export interface InspectResult {
  url: string;
  viewport: string;
  components: InspectedComponent[];
  accessibility?: A11yViolation[];
}

type RawProps = Record<string, string | number>;

// Runs in the browser. Returns only the requested elements' box + selected computed styles.
function extract(selectors: string[]): (RawProps | null)[] {
  const px = (v: string) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return selectors.map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    const fontSize = px(s.fontSize) ?? 16;
    const flex = s.display.includes('flex');
    const grid = s.display.includes('grid');
    const gap = flex ? px(s.flexDirection.startsWith('column') ? s.rowGap : s.columnGap) : grid ? px(s.rowGap) : undefined;
    const bw = px(s.borderTopWidth) ?? 0;
    const out: Record<string, string | number | undefined> = {
      width: r.width,
      height: r.height,
      x: r.left + window.scrollX,
      y: r.top + window.scrollY,
      paddingTop: px(s.paddingTop),
      paddingRight: px(s.paddingRight),
      paddingBottom: px(s.paddingBottom),
      paddingLeft: px(s.paddingLeft),
      gap,
      borderRadius: px(s.borderTopLeftRadius),
      borderWidth: bw,
      borderColor: bw > 0 ? s.borderTopColor : undefined,
      color: s.color,
      backgroundColor: s.backgroundColor,
      fontFamily: s.fontFamily,
      fontSize,
      fontWeight: Number(s.fontWeight),
      // "normal" line-height is font dependent; 1.2 is the common UA approximation.
      lineHeight: s.lineHeight === 'normal' ? fontSize * 1.2 : px(s.lineHeight),
      letterSpacing: s.letterSpacing === 'normal' ? 0 : px(s.letterSpacing),
      textAlign: s.textAlign,
      opacity: Number(s.opacity),
    };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out as RawProps;
  });
}

const round = (n: number) => Math.round(n * 100) / 100;

function normalize(raw: RawProps): StyleProps {
  const p: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(raw)) {
    p[k] = typeof v === 'number' ? round(v) : /color$/i.test(k) ? normalizeColor(v) : v;
  }
  return p as StyleProps;
}

const memo = new MemoryCache<InspectResult>(30_000);

export async function inspectUI(opts: {
  url: string;
  targets: Target[];
  viewport: Viewport;
  accessibility?: boolean;
  waitFor?: string;
  refresh?: boolean;
}): Promise<InspectResult> {
  const { url, targets, viewport, accessibility = false } = opts;
  const key = hashKey(url, viewport, targets, accessibility);
  if (!opts.refresh) {
    const hit = memo.get(key);
    if (hit) return hit;
  }
  const result = await withPage(
    url,
    viewport,
    async (page) => {
      const raw = await page.evaluate(extract, targets.map((t) => t.selector));
      const components = targets.map((t, i) => ({
        name: t.name,
        selector: t.selector,
        found: raw[i] !== null,
        props: raw[i] ? normalize(raw[i]!) : {},
      }));
      const res: InspectResult = { url, viewport: viewport.name, components };
      if (accessibility) res.accessibility = await runAxe(page, targets.filter((_, i) => raw[i] !== null));
      return res;
    },
    opts.waitFor,
  );
  memo.set(key, result);
  return result;
}

interface AxeResults {
  violations: { id: string; impact: string | null; help: string; nodes: { target: unknown }[] }[];
}

/** axe-core scoped to the requested components. A node inside nested components is reported once, on the innermost. */
async function runAxe(page: Page, targets: Target[]): Promise<A11yViolation[]> {
  if (!targets.length) return [];
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  const depths = await page.evaluate(
    (sels) => sels.map((s) => {
      let d = 0;
      for (let e = document.querySelector(s); e; e = e.parentElement) d++;
      return d;
    }),
    targets.map((t) => t.selector),
  );
  const ordered = targets.map((t, i) => ({ t, d: depths[i] })).sort((a, b) => b.d - a.d).map((x) => x.t);
  const seen = new Set<string>();
  const out: A11yViolation[] = [];
  for (const t of ordered) {
    const r = (await page.evaluate(
      (sel) => (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<unknown> } }).axe.run(
        { include: [sel] },
        { resultTypes: ['violations'] },
      ),
      t.selector,
    )) as AxeResults;
    for (const v of r.violations) {
      const fresh = v.nodes.filter((n) => {
        const k = `${v.id}|${JSON.stringify(n.target)}`;
        return !seen.has(k) && seen.add(k);
      });
      if (fresh.length) out.push({ component: t.name, rule: v.id, impact: v.impact, nodes: fresh.length, help: v.help });
    }
  }
  return out.sort((a, b) => targets.findIndex((t) => t.name === a.component) - targets.findIndex((t) => t.name === b.component));
}

/** Screenshot one element (or the full page when selector is omitted) to `outPath`. */
export async function captureScreenshot(opts: {
  url: string;
  viewport: Viewport;
  outPath: string;
  selector?: string;
  waitFor?: string;
}): Promise<string> {
  await mkdir(dirname(opts.outPath), { recursive: true });
  await withPage(
    opts.url,
    opts.viewport,
    async (page) => {
      // Freeze animations/caret so captures are deterministic.
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
      if (opts.selector) await page.locator(opts.selector).first().screenshot({ path: opts.outPath });
      else await page.screenshot({ path: opts.outPath, fullPage: true });
    },
    opts.waitFor,
  );
  return opts.outPath;
}
