import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { MemoryCache, hashKey } from '../cache.ts';
import { normalizeColor } from '../compare/color.ts';
import type { InspectedComponent, StyleProps, Viewport } from '../types.ts';

const require = createRequire(import.meta.url);

let browser: Promise<Browser> | undefined;

const execFileAsync = promisify(execFile);

/**
 * Playwright's Chromium, else an installed Chrome/Edge. On a first run via npx none may exist:
 * install Playwright's Chromium once (to its normal cache), then retry.
 */
async function launch(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true });
  } catch {}
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ headless: true, channel });
    } catch {}
  }
  console.error('figma-design-validator: no browser found, installing Chromium (first run only)...');
  const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
  // Output is captured, never written to stdout: stdout carries the MCP protocol.
  await execFileAsync(process.execPath, [cli, 'install', 'chromium'], { timeout: 10 * 60_000 });
  return chromium.launch({ headless: true });
}

/** One headless browser per server process, launched lazily. */
function getBrowser() {
  browser ??= launch().catch((e) => {
    browser = undefined;
    throw new Error(
      `Cannot launch a browser (${(e as Error).message.split('\n')[0]}). Run: npx playwright install chromium`,
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
    // `gap` = main-axis spacing of a flex container (Figma itemSpacing). Grid has no main axis: use rowGap/columnGap.
    const gap = flex ? px(s.flexDirection.startsWith('column') ? s.rowGap : s.columnGap) : undefined;
    // Use the widest visible side, not just the top (e.g. bottom-border-only inputs).
    const sides = (['Top', 'Right', 'Bottom', 'Left'] as const)
      .map((k) => ({ w: px(s.getPropertyValue(`border-${k.toLowerCase()}-width`)) ?? 0, c: s.getPropertyValue(`border-${k.toLowerCase()}-color`), st: s.getPropertyValue(`border-${k.toLowerCase()}-style`) }))
      .filter((b) => b.w > 0 && b.st !== 'none' && b.st !== 'hidden');
    const border = sides.sort((a, b) => b.w - a.w)[0];
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
      rowGap: flex || grid ? px(s.rowGap) : undefined,
      columnGap: flex || grid ? px(s.columnGap) : undefined,
      borderRadius: px(s.borderTopLeftRadius),
      borderWidth: border?.w ?? 0,
      borderColor: border?.c,
      color: s.color,
      backgroundColor: s.backgroundColor,
      fontFamily: s.fontFamily,
      fontSize,
      fontWeight: Number(s.fontWeight),
      // "normal" line-height is font dependent; 1.2 is the common UA approximation.
      lineHeight: s.lineHeight === 'normal' ? fontSize * 1.2 : px(s.lineHeight),
      letterSpacing: s.letterSpacing === 'normal' ? 0 : px(s.letterSpacing),
      // text-align does not position flex/grid children (justify-content does), so it is meaningless there.
      textAlign: flex || grid ? undefined : s.textAlign,
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

/**
 * Screenshot one element (or the full page when selector is omitted) to `outPath`.
 * Also returns the first opaque background at or behind the element, used to flatten transparent references.
 */
export async function captureScreenshot(opts: {
  url: string;
  viewport: Viewport;
  outPath: string;
  selector?: string;
  waitFor?: string;
}): Promise<{ path: string; background: string }> {
  await mkdir(dirname(opts.outPath), { recursive: true });
  return withPage(
    opts.url,
    opts.viewport,
    async (page) => {
      // Freeze animations/caret so captures are deterministic.
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
      const background = await page.evaluate((sel) => {
        for (let e = sel ? document.querySelector(sel) : document.body; e; e = e.parentElement) {
          const c = getComputedStyle(e).backgroundColor;
          if (c && c !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(c)) return c;
        }
        return '#ffffff';
      }, opts.selector ?? null);
      if (opts.selector) await page.locator(opts.selector).first().screenshot({ path: opts.outPath });
      else await page.screenshot({ path: opts.outPath, fullPage: true });
      return { path: opts.outPath, background: normalizeColor(background) };
    },
    opts.waitFor,
  );
}

export interface DomCandidate {
  selector: string;
  tag: string;
  testId?: string;
  id?: string;
  label?: string;
  text?: string;
}

// Runs in the browser: visible, nameable elements with the shortest unique CSS selector for each.
function candidates(limit: number): DomCandidate[] {
  const unique = (sel: string, el: Element) => {
    try {
      const m = document.querySelectorAll(sel);
      return m.length === 1 && m[0] === el;
    } catch {
      return false;
    }
  };
  const q = (v: string) => JSON.stringify(v);
  const selectorFor = (el: Element): string => {
    const tag = el.tagName.toLowerCase();
    const tries = [
      el.getAttribute('data-testid') && `[data-testid=${q(el.getAttribute('data-testid')!)}]`,
      el.id && `#${CSS.escape(el.id)}`,
      el.getAttribute('aria-label') && `${tag}[aria-label=${q(el.getAttribute('aria-label')!)}]`,
      el.getAttribute('name') && `${tag}[name=${q(el.getAttribute('name')!)}]`,
      ['main', 'nav', 'header', 'footer', 'h1'].includes(tag) && tag,
    ].filter(Boolean) as string[];
    for (const t of tries) if (unique(t, el)) return t;
    // Fallback: nth-of-type chain up to the nearest uniquely selectable ancestor.
    const parent = el.parentElement;
    if (!parent || parent === document.documentElement) return tag;
    const same = [...parent.children].filter((c) => c.tagName === el.tagName);
    const part = same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(el) + 1})` : tag;
    const sel = `${parent === document.body ? 'body' : selectorFor(parent)} > ${part}`;
    return sel;
  };
  const pick =
    '[data-testid],[id],[aria-label],[role],h1,h2,h3,h4,h5,h6,button,a[href],input,select,textarea,label,img[alt],nav,header,footer,main,section,form,dialog,li';
  const out: DomCandidate[] = [];
  for (const el of document.querySelectorAll(pick)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
    const text = ((el as HTMLElement).innerText || (el as HTMLInputElement).placeholder || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ');
    const c: DomCandidate = { selector: selectorFor(el), tag: el.tagName.toLowerCase() };
    if (el.getAttribute('data-testid')) c.testId = el.getAttribute('data-testid')!;
    if (el.id) c.id = el.id;
    if (el.getAttribute('aria-label')) c.label = el.getAttribute('aria-label')!;
    if (text) c.text = text.slice(0, 80);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

/** Nameable, visible elements of a page with unique selectors; input for drafting a config. */
export async function listCandidates(url: string, viewport: Viewport, limit = 400): Promise<DomCandidate[]> {
  return withPage(url, viewport, (page) => page.evaluate(candidates, limit));
}
