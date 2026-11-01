export type RGBA = [number, number, number, number];

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

/** Parse #rgb, #rrggbb, #rrggbbaa, rgb(), rgba() (comma or space syntax). Returns undefined when unparseable. */
export function parseColor(input: string): RGBA | undefined {
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return undefined;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return undefined;
    const [r, g, b] = parts.slice(0, 3).map(Number);
    const a = parts[3] === undefined ? 1 : parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : Number(parts[3]);
    if ([r, g, b, a].some(Number.isNaN)) return undefined;
    return [clamp(r), clamp(g), clamp(b), a];
  }
  return undefined;
}

export function toHex([r, g, b, a]: RGBA): string {
  const h = (n: number) => clamp(n).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}${a < 1 ? h(a * 255) : ''}`;
}

export const normalizeColor = (input: string) => {
  const c = parseColor(input);
  return c ? toHex(c) : input;
};

/** Max per-channel difference (0-255); alpha scaled to the same range. */
export function colorDistance(a: string, b: string): number | undefined {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return undefined;
  // Two fully transparent colors are equal regardless of RGB.
  if (x[3] === 0 && y[3] === 0) return 0;
  return Math.max(Math.abs(x[0] - y[0]), Math.abs(x[1] - y[1]), Math.abs(x[2] - y[2]), Math.abs(x[3] - y[3]) * 255);
}
