import type { DomCandidate } from '../browser/inspector.ts';
import { firstText, type FigmaNode } from './figma.ts';

export interface DesignLayer {
  id: string;
  name: string;
  type: string;
  text?: string;
}

export interface Match {
  layer: DesignLayer;
  candidate: DomCandidate;
  score: number;
  by: 'text' | 'name';
}

const LAYER_TYPES = new Set(['FRAME', 'COMPONENT', 'INSTANCE', 'TEXT']);

/**
 * Nameable layers under a frame. Internals of components/instances are skipped: the instance itself is the unit
 * a team validates, and its text still helps match it through `text`.
 */
export function collectLayers(root: FigmaNode, maxDepth = 6): DesignLayer[] {
  const out: DesignLayer[] = [];
  const walk = (n: FigmaNode, depth: number) => {
    for (const c of n.children ?? []) {
      if (c.visible === false) continue;
      if (LAYER_TYPES.has(c.type)) {
        const text = (c.type === 'TEXT' ? c.characters : firstText(c)?.characters)?.trim();
        out.push({ id: c.id, name: c.name, type: c.type, ...(text && { text }) });
      }
      if (c.type !== 'INSTANCE' && c.type !== 'COMPONENT' && depth < maxDepth) walk(c, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

/** "PrimaryButton", "primary-btn", "Primary / Button" -> ["primary", "button"]. */
export const tokens = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\bbtn\b/g, 'button')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !['frame', 'group', 'instance', 'component', 'default', 'container', 'wrapper'].includes(t));

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function jaccard(a: string[], b: string[]) {
  if (!a.length || !b.length) return 0;
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((t) => B.has(t)).length;
  return inter / (A.size + B.size - inter);
}

function score(l: DesignLayer, c: DomCandidate): { score: number; by: Match['by'] } {
  let best = { score: 0, by: 'name' as Match['by'] };
  // Identical visible text is the strongest deterministic signal when the app has no test ids.
  if (l.text && c.text && norm(l.text) === norm(c.text)) {
    // Prefer the innermost element with that text: a TEXT layer maps to a text tag, a frame to a control.
    const textTag = /^(h[1-6]|p|span|label|li|a)$/.test(c.tag);
    best = { score: l.type === 'TEXT' ? (textTag ? 0.95 : 0.8) : textTag ? 0.75 : 0.9, by: 'text' };
  }
  const lt = tokens(l.name);
  for (const name of [c.testId, c.id, c.label]) {
    if (!name) continue;
    const s = jaccard(lt, tokens(name));
    if (s > best.score) best = { score: s, by: 'name' };
  }
  return best;
}

/** Greedy one-to-one assignment, highest score first. Deterministic for the same inputs. */
export function matchLayers(layers: DesignLayer[], cands: DomCandidate[], minScore = 0.5): { matches: Match[]; unmatched: DesignLayer[] } {
  const pairs: Match[] = [];
  for (const layer of layers)
    for (const candidate of cands) {
      const s = score(layer, candidate);
      if (s.score >= minScore) pairs.push({ layer, candidate, ...s });
    }
  pairs.sort((a, b) => b.score - a.score || a.layer.id.localeCompare(b.layer.id) || a.candidate.selector.localeCompare(b.candidate.selector));
  const usedL = new Set<string>();
  const usedC = new Set<string>();
  const matches: Match[] = [];
  for (const p of pairs) {
    if (usedL.has(p.layer.id) || usedC.has(p.candidate.selector)) continue;
    usedL.add(p.layer.id);
    usedC.add(p.candidate.selector);
    matches.push({ ...p, score: Math.round(p.score * 100) / 100 });
  }
  return { matches, unmatched: layers.filter((l) => !usedL.has(l.id)) };
}

/** Unique PascalCase component name from a layer name. */
export function componentName(name: string, taken: Set<string>) {
  const base = tokens(name).map((t) => t[0].toUpperCase() + t.slice(1)).join('') || 'Component';
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${base}${i}`;
  taken.add(n);
  return n;
}
