import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import type { ComponentConfig, ValidationConfig } from './types.ts';

const num = z.number().nonnegative();

const styleProps = z
  .object({
    width: z.number(), height: z.number(), x: z.number(), y: z.number(),
    paddingTop: z.number(), paddingRight: z.number(), paddingBottom: z.number(), paddingLeft: z.number(),
    gap: z.number(), borderRadius: z.number(), borderWidth: z.number(), borderColor: z.string(),
    color: z.string(), backgroundColor: z.string(), fontFamily: z.string(), fontSize: z.number(),
    fontWeight: z.number(), lineHeight: z.number(), letterSpacing: z.number(), textAlign: z.string(),
    opacity: z.number(),
  })
  .partial()
  .strict();

export const stylePropsSchema = styleProps;
export const propNames = Object.keys(styleProps.shape) as (keyof z.infer<typeof styleProps>)[];

const configSchema = z.object({
  baseUrl: z.string().url(),
  viewports: z
    .array(z.object({ name: z.string(), width: z.number().int().positive(), height: z.number().int().positive() }))
    .min(1)
    .default([{ name: 'desktop', width: 1440, height: 900 }]),
  figma: z.object({ fileKey: z.string().min(1), frameNodeId: z.string().optional(), cacheTtlHours: num.optional() }).optional(),
  designSpecPath: z.string().optional(),
  tolerances: z
    .object({
      size: num, position: num, spacing: num, radius: num, fontSize: num,
      lineHeight: num, letterSpacing: num, fontWeight: num, color: num, opacity: num,
    })
    .partial()
    .default({}),
  screenshot: z
    .object({ threshold: z.number().min(0).max(1), maxDiffRatio: z.number().min(0).max(1) })
    .partial()
    .default({}),
  quickProperties: z.array(z.enum(propNames as [string, ...string[]])).optional(),
  cacheDir: z.string().default('.ui-validation-cache'),
  outputDir: z.string().default('ui-validation-reports'),
  components: z
    .array(
      z
        .object({
          name: z.string().min(1),
          selector: z.string().min(1),
          path: z.string().optional(),
          figmaNodeId: z.string().optional(),
          expected: styleProps.optional(),
          reference: z.string().optional(),
          ignore: z.array(z.enum(propNames as [string, ...string[]])).optional(),
          responsive: z
            .record(
              z.string(),
              z.object({ figmaNodeId: z.string().optional(), expected: styleProps.optional(), reference: z.string().optional() }).strict(),
            )
            .optional(),
        })
        .strict(),
    )
    .min(1),
});

export const DEFAULT_TOLERANCES = {
  size: 2, position: 4, spacing: 1, radius: 1, fontSize: 0,
  lineHeight: 1, letterSpacing: 0.2, fontWeight: 0, color: 4, opacity: 0.02,
};

export const DEFAULT_QUICK_PROPERTIES = [
  'width', 'height', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'gap',
  'color', 'backgroundColor', 'fontSize', 'fontWeight', 'lineHeight', 'borderRadius',
] as const;

export function parseConfig(raw: unknown, baseDir = process.cwd()): ValidationConfig {
  const c = configSchema.parse(raw);
  const rel = (p: string) => resolve(baseDir, p);
  return {
    ...c,
    tolerances: { ...DEFAULT_TOLERANCES, ...c.tolerances },
    screenshot: { threshold: 0.1, maxDiffRatio: 0.01, ...c.screenshot },
    quickProperties: (c.quickProperties ?? [...DEFAULT_QUICK_PROPERTIES]) as ValidationConfig['quickProperties'],
    designSpecPath: c.designSpecPath && rel(c.designSpecPath),
    cacheDir: rel(c.cacheDir),
    outputDir: rel(c.outputDir),
    components: c.components.map((comp) => ({
      ...comp,
      reference: comp.reference && rel(comp.reference),
      responsive:
        comp.responsive &&
        Object.fromEntries(
          Object.entries(comp.responsive).map(([k, v]) => [k, { ...v, reference: v.reference && rel(v.reference) }]),
        ),
    })),
  } as ValidationConfig;
}

export async function loadConfig(path: string): Promise<ValidationConfig> {
  const abs = resolve(path);
  const raw = JSON.parse(await readFile(abs, 'utf8'));
  return parseConfig(raw, dirname(abs));
}

export function pickComponents(config: ValidationConfig, names?: string[]) {
  if (!names?.length) return config.components;
  const unknown = names.filter((n) => !config.components.some((c) => c.name === n));
  if (unknown.length) throw new Error(`Unknown component(s): ${unknown.join(', ')}`);
  return config.components.filter((c) => names.includes(c.name));
}

export function pickViewports(config: ValidationConfig, mode: 'quick' | 'deep', names?: string[]) {
  if (names?.length) {
    const vs = config.viewports.filter((v) => names.includes(v.name));
    if (!vs.length) throw new Error(`Unknown viewport(s): ${names.join(', ')}`);
    return vs;
  }
  return mode === 'quick' ? config.viewports.slice(0, 1) : config.viewports;
}

/** Component config with the viewport's responsive overrides applied. */
export function forViewport(c: ComponentConfig, viewport: string): ComponentConfig {
  const r = c.responsive?.[viewport];
  if (!r) return c;
  return {
    ...c,
    figmaNodeId: r.figmaNodeId ?? c.figmaNodeId,
    reference: r.reference ?? c.reference,
    expected: { ...c.expected, ...r.expected },
  };
}
