import { join } from 'node:path';
import { captureScreenshot, inspectUI } from './browser/inspector.ts';
import { compareProps } from './compare/layout.ts';
import { compareImages, type ScreenshotDiff } from './compare/screenshot.ts';
import { forViewport, pickComponents, pickViewports, screenshotFor, tolerancesFor } from './config.ts';
import { FigmaAdapter, type DesignSource } from './design/figma.ts';
import type { ComponentConfig, Finding, Mode, Severity, Summary, ValidationConfig, Viewport } from './types.ts';

export interface ValidationRun {
  summary: Summary;
  mode: Mode;
  designSource: DesignSource;
  viewports: string[];
  findings: Finding[];
  screenshots?: (ScreenshotDiff & { component: string; viewport: string })[];
  warnings: string[];
}

export function summarize(findings: Finding[], checked: number): Summary {
  const failed = findings.filter((f) => f.status === 'FAIL').length;
  const warnings = findings.length - failed;
  return { status: failed ? 'FAIL' : warnings ? 'WARNING' : 'PASS', checked, failed, warnings };
}

const urlFor = (config: ValidationConfig, c: ComponentConfig) => new URL(c.path ?? '/', config.baseUrl).toString();

const AXE_SEVERITY: Record<string, Severity> = { critical: 'high', serious: 'high', moderate: 'medium', minor: 'low' };

/**
 * Full deterministic pipeline: design props -> browser props -> rule comparison (+ screenshots and axe in deep mode).
 * Quick mode: first viewport, `quickProperties` only, no screenshots, no axe.
 */
export async function runValidation(
  config: ValidationConfig,
  opts: { components?: string[]; viewports?: string[]; mode?: Mode; refresh?: boolean; screenshots?: boolean; accessibility?: boolean },
): Promise<ValidationRun> {
  const mode = opts.mode ?? 'quick';
  const deep = mode === 'deep';
  const base = pickComponents(config, opts.components);
  const viewports = pickViewports(config, mode, opts.viewports);
  const figma = new FigmaAdapter(config);
  const findings: Finding[] = [];
  const warnings = new Set<string>();
  const screenshots: ValidationRun['screenshots'] = [];
  let checked = 0;
  let designSource: DesignSource = 'none';

  for (const vp of viewports) {
    const comps = base.map((c) => forViewport(c, vp.name));
    const design = await figma.inspect(comps, opts.refresh);
    designSource = design.source;
    design.warnings.forEach((w) => warnings.add(w));
    const specs = new Map(design.specs.map((s) => [s.name, s]));

    // One page load per distinct URL.
    const byUrl = Map.groupBy(comps, (c) => urlFor(config, c));
    for (const [url, group] of byUrl) {
      const ui = await inspectUI({
        url,
        viewport: vp,
        targets: group.map((c) => ({ name: c.name, selector: c.selector })),
        accessibility: opts.accessibility ?? deep,
        refresh: opts.refresh,
      });
      for (const comp of ui.components) {
        checked++;
        if (!comp.found) {
          findings.push({ component: comp.name, property: 'element', expected: comp.selector, actual: null, status: 'FAIL', severity: 'high', viewport: vp.name });
          continue;
        }
        const r = compareProps(comp.name, specs.get(comp.name)?.props ?? {}, comp.props, tolerancesFor(config, group.find((g) => g.name === comp.name)!), deep ? undefined : config.quickProperties, vp.name);
        checked += r.checked;
        findings.push(...r.findings);
      }
      for (const v of ui.accessibility ?? []) {
        const severity = AXE_SEVERITY[v.impact ?? ''] ?? 'low';
        findings.push({
          component: v.component,
          property: `a11y:${v.rule}`,
          expected: 'no violation',
          actual: `${v.nodes} node(s): ${v.help}`,
          status: severity === 'high' ? 'FAIL' : 'WARNING',
          severity,
          viewport: vp.name,
        });
      }
      if (opts.screenshots ?? deep) {
        for (const c of group) {
          if (!ui.components.find((x) => x.name === c.name)?.found) continue;
          const s = await screenshotComponent(config, figma, c, vp, opts.refresh);
          if (!s) continue;
          screenshots.push({ ...s, component: c.name, viewport: vp.name });
          checked++;
          if (s.status !== 'PASS')
            findings.push({
              component: c.name,
              property: 'screenshot',
              expected: `diffRatio<=${screenshotFor(config, c).maxDiffRatio}`,
              actual: `diffRatio=${s.diffRatio}${s.sizeMismatch ? ` size ${s.sizeMismatch.actual.join('x')} vs ${s.sizeMismatch.reference.join('x')}` : ''}`,
              status: s.status,
              severity: s.status === 'FAIL' ? (s.diffRatio > 0.1 ? 'high' : 'medium') : 'low',
              viewport: vp.name,
            });
        }
      }
    }
  }

  const run: ValidationRun = {
    summary: summarize(findings, checked),
    mode,
    designSource,
    viewports: viewports.map((v) => v.name),
    findings,
    warnings: [...warnings],
  };
  if (screenshots.length) run.screenshots = screenshots;
  return run;
}

const safe = (s: string) => s.replace(/[^a-z0-9_-]+/gi, '_');

/** Screenshot diff for one component; reference = local file, else Figma export. Undefined when no reference exists. */
export async function screenshotComponent(
  config: ValidationConfig,
  figma: FigmaAdapter,
  c: ComponentConfig,
  vp: Viewport,
  refresh?: boolean,
): Promise<ScreenshotDiff | undefined> {
  const reference = c.reference ?? (c.figmaNodeId ? await figma.exportImage(c.figmaNodeId, 1, refresh).catch(() => undefined) : undefined);
  if (!reference) return undefined;
  const stem = join(config.outputDir, 'screenshots', `${safe(c.name)}.${safe(vp.name)}`);
  const { path: actual, background } = await captureScreenshot({ url: urlFor(config, c), viewport: vp, selector: c.selector, outPath: `${stem}.actual.png` });
  return { ...(await compareImages({ reference, actual, background, ...screenshotFor(config, c), diffOutput: `${stem}.diff.png` })), actualImage: actual };
}
