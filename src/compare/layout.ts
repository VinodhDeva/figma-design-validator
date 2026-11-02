import type { Finding, PropName, Severity, StyleProps, Tolerances } from '../types.ts';
import { colorDistance, normalizeColor } from './color.ts';

type Kind = 'size' | 'position' | 'spacing' | 'radius' | 'fontSize' | 'lineHeight' | 'letterSpacing' | 'fontWeight' | 'color' | 'opacity' | 'text';

const KIND: Record<PropName, Kind> = {
  width: 'size', height: 'size', x: 'position', y: 'position',
  paddingTop: 'spacing', paddingRight: 'spacing', paddingBottom: 'spacing', paddingLeft: 'spacing', gap: 'spacing', rowGap: 'spacing', columnGap: 'spacing',
  borderRadius: 'radius', borderWidth: 'spacing', borderColor: 'color', color: 'color', backgroundColor: 'color',
  fontFamily: 'text', fontSize: 'fontSize', fontWeight: 'fontWeight', lineHeight: 'lineHeight',
  letterSpacing: 'letterSpacing', textAlign: 'text', opacity: 'opacity',
};

const normFont = (f: string) => f.split(',')[0].replace(/["']/g, '').trim().toLowerCase();
const normText = (p: PropName, v: string) => {
  if (p === 'fontFamily') return normFont(v);
  const t = v.trim().toLowerCase();
  // CSS "start" is "left" for LTR documents.
  return p === 'textAlign' ? ({ start: 'left', end: 'right' } as Record<string, string>)[t] ?? t : t;
};

export interface CompareResult {
  findings: Finding[];
  checked: number;
}

/**
 * Deterministic rule set:
 *  - |diff| <= tolerance                -> pass
 *  - |diff| <= 2 x tolerance (or +1px)  -> WARNING / low
 *  - otherwise                          -> FAIL, high if relative diff > 20% (or color diff > 64), else medium
 *  - text props (fontFamily, textAlign) are exact after normalization -> FAIL / medium
 */
export function compareProps(
  component: string,
  expected: StyleProps,
  actual: StyleProps,
  tol: Tolerances,
  only?: readonly PropName[],
  viewport?: string,
): CompareResult {
  const findings: Finding[] = [];
  let checked = 0;
  for (const p of Object.keys(expected) as PropName[]) {
    if (only && !only.includes(p)) continue;
    const exp = expected[p];
    if (exp === undefined || exp === null) continue;
    checked++;
    const act = actual[p];
    const base = { component, property: p, viewport };
    if (act === undefined) {
      findings.push({ ...base, expected: exp, actual: null, status: 'FAIL', severity: 'medium' });
      continue;
    }
    const kind = KIND[p];
    if (kind === 'text') {
      if (normText(p, String(exp)) !== normText(p, String(act)))
        findings.push({ ...base, expected: exp, actual: act, status: 'FAIL', severity: 'medium' });
      continue;
    }
    if (kind === 'color') {
      const d = colorDistance(String(exp), String(act));
      const t = tol.color;
      if (d === undefined) {
        findings.push({ ...base, expected: exp, actual: act, status: 'WARNING', severity: 'low' });
      } else if (d > t) {
        const sev: Severity = d > 64 ? 'high' : 'medium';
        findings.push({
          ...base,
          expected: normalizeColor(String(exp)),
          actual: normalizeColor(String(act)),
          status: d <= t * 2 ? 'WARNING' : 'FAIL',
          severity: d <= t * 2 ? 'low' : sev,
        });
      }
      continue;
    }
    const e = Number(exp);
    const a = Number(act);
    const diff = Math.abs(e - a);
    const t = tol[kind];
    if (diff <= t + 1e-6) continue;
    const round = (n: number) => Math.round(n * 100) / 100;
    if (diff <= Math.max(t * 2, t + 1)) {
      findings.push({ ...base, expected: round(e), actual: round(a), status: 'WARNING', severity: 'low' });
    } else {
      const rel = e === 0 ? Infinity : diff / Math.abs(e);
      findings.push({ ...base, expected: round(e), actual: round(a), status: 'FAIL', severity: rel > 0.2 ? 'high' : 'medium' });
    }
  }
  return { findings, checked };
}
