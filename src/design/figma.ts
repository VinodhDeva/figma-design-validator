import { readFile } from 'node:fs/promises';
import { FileCache, hashKey } from '../cache.ts';
import { toHex } from '../compare/color.ts';
import type { ComponentConfig, ComponentSpec, StyleProps, ValidationConfig } from '../types.ts';

const API = 'https://api.figma.com/v1';
const HOUR = 3_600_000;

// Minimal subset of the Figma REST node shape that we read.
export interface FigmaNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  itemSpacing?: number;
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  strokeWeight?: number;
  strokes?: Paint[];
  fills?: Paint[];
  opacity?: number;
  style?: {
    fontFamily?: string;
    fontWeight?: number;
    fontSize?: number;
    lineHeightPx?: number;
    letterSpacing?: number;
    textAlignHorizontal?: string;
  };
  children?: FigmaNode[];
}
interface Paint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: { r: number; g: number; b: number; a: number };
}
type NodesResponse = { nodes: Record<string, { document: FigmaNode } | null> };

const solid = (paints?: Paint[]) => {
  const p = paints?.find((f) => f.type === 'SOLID' && f.visible !== false && f.color);
  if (!p?.color) return undefined;
  const { r, g, b, a } = p.color;
  return toHex([r * 255, g * 255, b * 255, a * (p.opacity ?? 1)]);
};

function firstText(n: FigmaNode): FigmaNode | undefined {
  if (n.type === 'TEXT') return n;
  for (const c of n.children ?? []) {
    if (c.visible === false) continue;
    const t = firstText(c);
    if (t) return t;
  }
  return undefined;
}

const ALIGN: Record<string, string> = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' };

/** Map a Figma node to normalized props. Typography comes from the node itself or its first text descendant. */
export function extractProps(n: FigmaNode, frame?: FigmaNode): StyleProps {
  const p: StyleProps = {};
  const box = n.absoluteBoundingBox;
  if (box) {
    p.width = box.width;
    p.height = box.height;
    const fb = frame?.absoluteBoundingBox;
    if (fb) {
      p.x = box.x - fb.x;
      p.y = box.y - fb.y;
    }
  }
  if (n.paddingTop !== undefined) p.paddingTop = n.paddingTop;
  if (n.paddingRight !== undefined) p.paddingRight = n.paddingRight;
  if (n.paddingBottom !== undefined) p.paddingBottom = n.paddingBottom;
  if (n.paddingLeft !== undefined) p.paddingLeft = n.paddingLeft;
  if (n.itemSpacing !== undefined) p.gap = n.itemSpacing;
  if (n.cornerRadius !== undefined) p.borderRadius = n.cornerRadius;
  else if (n.rectangleCornerRadii) p.borderRadius = n.rectangleCornerRadii[0];
  const stroke = solid(n.strokes);
  if (stroke) {
    p.borderColor = stroke;
    if (n.strokeWeight !== undefined) p.borderWidth = n.strokeWeight;
  }
  if (n.opacity !== undefined && n.opacity !== 1) p.opacity = n.opacity;
  if (n.type !== 'TEXT') {
    const bg = solid(n.fills);
    if (bg) p.backgroundColor = bg;
  }
  const t = firstText(n);
  if (t?.style) {
    const s = t.style;
    if (s.fontFamily) p.fontFamily = s.fontFamily;
    if (s.fontSize !== undefined) p.fontSize = s.fontSize;
    if (s.fontWeight !== undefined) p.fontWeight = s.fontWeight;
    if (s.lineHeightPx !== undefined) p.lineHeight = Math.round(s.lineHeightPx * 100) / 100;
    if (s.letterSpacing !== undefined) p.letterSpacing = s.letterSpacing;
    if (s.textAlignHorizontal) p.textAlign = ALIGN[s.textAlignHorizontal] ?? s.textAlignHorizontal.toLowerCase();
    const c = solid(t.fills);
    if (c) p.color = c;
  }
  return p;
}

/** Child names only, 2 levels deep: enough to check hierarchy without shipping the tree to the model. */
export const hierarchy = (n: FigmaNode, depth = 2): string[] =>
  depth <= 0
    ? []
    : (n.children ?? [])
        .filter((c) => c.visible !== false)
        .flatMap((c) => [c.name, ...hierarchy(c, depth - 1).map((g) => `${c.name} > ${g}`)]);

export type DesignSource = 'figma' | 'figma-cache' | 'spec-file' | 'config' | 'none';

export interface DesignResult {
  source: DesignSource;
  specs: ComponentSpec[];
  warnings: string[];
}

async function figmaGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { 'X-Figma-Token': token } });
  if (!res.ok) throw new Error(`Figma API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

export class FigmaAdapter {
  private config: ValidationConfig;
  private cache: FileCache;
  private token = process.env.FIGMA_TOKEN ?? process.env.FIGMA_ACCESS_TOKEN;

  constructor(config: ValidationConfig) {
    this.config = config;
    this.cache = new FileCache(config.cacheDir);
  }

  private ttl() {
    return (this.config.figma?.cacheTtlHours ?? 24) * HOUR;
  }

  /** Fetch node subtrees, served from file cache when fresh. */
  private async nodes(ids: string[], refresh: boolean): Promise<{ data: NodesResponse; cached: boolean }> {
    const fileKey = this.config.figma!.fileKey;
    const key = hashKey('nodes', fileKey, [...ids].sort());
    if (!refresh) {
      const hit = await this.cache.getJson<NodesResponse>(key, this.ttl());
      if (hit) return { data: hit, cached: true };
    }
    if (!this.token) throw new Error('FIGMA_TOKEN not set');
    const data = await figmaGet<NodesResponse>(
      `/files/${encodeURIComponent(fileKey)}/nodes?ids=${encodeURIComponent(ids.join(','))}&depth=4`,
      this.token,
    );
    await this.cache.put(key, data);
    return { data, cached: false };
  }

  private async specFile(): Promise<Record<string, unknown> | undefined> {
    if (!this.config.designSpecPath) return undefined;
    return JSON.parse(await readFile(this.config.designSpecPath, 'utf8'));
  }

  /**
   * Resolve expected props per component. Order: Figma (cache/API) -> local spec file -> inline `expected`.
   * Inline `expected` always overrides. Never throws for an unavailable source; reports a warning instead.
   */
  async inspect(components: ComponentConfig[], refresh = false): Promise<DesignResult> {
    const frameNodeId = this.config.figma?.frameNodeId;
    const warnings: string[] = [];
    let source: DesignSource = 'none';
    const fromDesign = new Map<string, { props: StyleProps; children: string[] }>();

    const withNode = components.filter((c) => c.figmaNodeId);
    const useNodes = (data: NodesResponse) => {
      const frame = frameNodeId ? data.nodes[frameNodeId]?.document : undefined;
      for (const c of withNode) {
        const n = data.nodes[c.figmaNodeId!]?.document;
        if (!n) warnings.push(`${c.name}: Figma node ${c.figmaNodeId} not found`);
        else fromDesign.set(c.name, { props: extractProps(n, frame), children: hierarchy(n) });
      }
    };

    if (this.config.figma && withNode.length) {
      try {
        const ids = withNode.map((c) => c.figmaNodeId!);
        if (frameNodeId) ids.push(frameNodeId);
        const { data, cached } = await this.nodes(ids, refresh);
        useNodes(data);
        source = cached ? 'figma-cache' : 'figma';
      } catch (e) {
        warnings.push(`Figma unavailable (${(e as Error).message}); falling back to spec file / inline expected values`);
      }
    }

    if (source === 'none') {
      try {
        const spec = await this.specFile();
        if (spec && 'nodes' in spec) {
          // A saved Figma REST /nodes response (e.g. exported once with curl or by another MCP client).
          useNodes(spec as unknown as NodesResponse);
          source = 'spec-file';
        } else if (spec) {
          const map = (spec.components ?? spec) as Record<string, StyleProps & { children?: string[] }>;
          for (const c of components) {
            const s = map[c.name];
            if (!s) continue;
            const { children, ...props } = s;
            fromDesign.set(c.name, { props, children: children ?? [] });
          }
          source = 'spec-file';
        }
      } catch (e) {
        warnings.push(`Design spec file unreadable: ${(e as Error).message}`);
      }
    }

    const specs = components.map((c) => {
      const d = fromDesign.get(c.name);
      const props = { ...(d?.props ?? {}), ...(c.expected ?? {}) };
      for (const p of c.ignore ?? []) delete props[p];
      return { name: c.name, props, ...(d?.children.length ? { children: d.children } : {}) };
    });
    if (source === 'none' && components.some((c) => c.expected)) source = 'config';
    for (const s of specs) if (!Object.keys(s.props).length) warnings.push(`${s.name}: no expected values from any source`);
    return { source, specs, warnings };
  }

  /** Export a node as PNG via Figma (cached on disk). Returns local path or undefined if unavailable. */
  async exportImage(nodeId: string, scale = 1, refresh = false): Promise<string | undefined> {
    if (!this.config.figma) return undefined;
    const key = hashKey('img', this.config.figma.fileKey, nodeId, scale);
    if (!refresh && (await this.cache.fresh(key, this.ttl(), 'png'))) return this.cache.path(key, 'png');
    if (!this.token) return undefined;
    const r = await figmaGet<{ images: Record<string, string | null> }>(
      `/images/${encodeURIComponent(this.config.figma.fileKey)}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`,
      this.token,
    );
    const url = r.images[nodeId];
    if (!url) return undefined;
    const img = await fetch(url);
    if (!img.ok) return undefined;
    return this.cache.put(key, Buffer.from(await img.arrayBuffer()), 'png');
  }
}
