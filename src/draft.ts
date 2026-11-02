import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { listCandidates } from './browser/inspector.ts';
import { parseConfig } from './config.ts';
import { FigmaAdapter } from './design/figma.ts';
import { collectLayers, componentName, matchLayers } from './design/match.ts';
import type { ValidationConfig, Viewport } from './types.ts';

export interface DraftOptions {
  baseUrl: string;
  path?: string;
  viewport?: Viewport;
  figmaFileKey?: string;
  frameNodeId?: string;
  designSpecPath?: string;
  output?: string;
  minScore?: number;
}

type RawComponent = { name: string; selector: string; path?: string; figmaNodeId?: string };

/**
 * Draft a config for one page: list the page's nameable elements, match them to the Figma frame's layers by visible text
 * and by name vs data-testid/id/aria-label, and write a draft file for the team to review.
 * Tolerances, screenshot limits and `ignore` lists are left empty on purpose: they are the team's decisions.
 */
export async function draftConfig(o: DraftOptions) {
  const output = resolve(o.output ?? 'ui-validation.config.draft.json');
  // Never touch a live config: drafts only.
  if (!basename(output).endsWith('.draft.json')) throw new Error('output must end with .draft.json');
  const path = o.path ?? '/';
  const viewport = o.viewport ?? { name: 'desktop', width: 1440, height: 900 };
  const warnings: string[] = [];

  const existing = await readFile(output, 'utf8').then(JSON.parse, () => undefined);
  const components: RawComponent[] = existing?.components ?? [];
  const taken = new Set(components.map((c) => c.name));
  const seen = new Set(components.map((c) => `${c.path ?? '/'}|${c.selector}`));

  const cands = await listCandidates(new URL(path, o.baseUrl).toString(), viewport);
  const added: (RawComponent & { score?: number; by?: string })[] = [];
  let source = 'none';
  let unmatched: string[] = [];

  if (o.frameNodeId) {
    const adapter = new FigmaAdapter({
      figma: o.figmaFileKey ? { fileKey: o.figmaFileKey } : undefined,
      designSpecPath: o.designSpecPath && resolve(o.designSpecPath),
      cacheDir: resolve('.ui-validation-cache'),
    } as ValidationConfig);
    const t = await adapter.tree(o.frameNodeId);
    source = t.source;
    if (t.warning) warnings.push(t.warning);
    if (t.node) {
      const r = matchLayers(collectLayers(t.node), cands, o.minScore ?? 0.5);
      for (const m of r.matches) {
        if (seen.has(`${path}|${m.candidate.selector}`)) continue;
        added.push({ name: componentName(m.layer.name, taken), path, selector: m.candidate.selector, figmaNodeId: m.layer.id, score: m.score, by: m.by });
      }
      unmatched = r.unmatched.map((l) => l.name);
    }
  }
  if (!o.frameNodeId || source === 'none') {
    // No design available: list elements with explicit names so the team only adds expected values or node ids.
    for (const c of cands.filter((c) => c.testId || c.label || c.tag === 'h1').slice(0, 30)) {
      if (seen.has(`${path}|${c.selector}`)) continue;
      added.push({ name: componentName(c.testId ?? c.label ?? c.text ?? c.tag, taken), path, selector: c.selector });
    }
    warnings.push('No design layers matched: fill in figmaNodeId or expected values for each component');
  }

  const all = [...components, ...added.map(({ score: _s, by: _b, ...c }) => c)];
  if (!all.length) return { output: null, source, added: [], unmatchedLayers: unmatched.slice(0, 20), warnings };

  const figmaKey = o.figmaFileKey ?? existing?.figma?.fileKey;
  const draft = {
    baseUrl: o.baseUrl,
    viewports: existing?.viewports ?? [viewport],
    ...(figmaKey && { figma: { fileKey: figmaKey, ...(o.frameNodeId && { frameNodeId: o.frameNodeId }) } }),
    ...((o.designSpecPath ?? existing?.designSpecPath) && { designSpecPath: o.designSpecPath ?? existing.designSpecPath }),
    tolerances: existing?.tolerances ?? {},
    screenshot: existing?.screenshot ?? {},
    components: all,
  };
  parseConfig(draft); // fail before writing anything invalid
  await writeFile(output, JSON.stringify(draft, null, 2) + '\n');
  return {
    output,
    source,
    added,
    ...(unmatched.length && { unmatchedLayers: unmatched.slice(0, 20), unmatchedCount: unmatched.length }),
    ...(warnings.length && { warnings }),
    next: 'Review each selector (check scores below 0.8), set tolerances/screenshot/ignore for this app, then rename to ui-validation.config.json',
  };
}
