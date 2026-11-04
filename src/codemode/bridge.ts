import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import { DEFAULT_LIMITS, type Limits } from './sandbox.ts';
import type { Tool, Upstream } from './upstream.ts';

export interface Policy {
  limits: Limits;
  /** When set, only these tools are callable from code. */
  allowTools?: string[];
  denyTools: string[];
  /** Tools that need confirmation from code. Default: tools not annotated readOnly, or annotated destructive. */
  sideEffectTools?: string[];
  /** Hostnames URL arguments may point at. Any http(s) string argument is checked too. */
  allowedHosts: string[];
  urlArgs: string[];
  /** Arguments that are file paths; they must resolve inside `root`. */
  pathArgs: string[];
  root: string;
}

export const DEFAULT_POLICY: Policy = {
  limits: DEFAULT_LIMITS,
  denyTools: [],
  allowedHosts: ['localhost', '127.0.0.1', '[::1]'],
  urlArgs: ['url', 'baseUrl'],
  pathArgs: ['configPath', 'output', 'reference', 'actual', 'diffOutput', 'designSpecPath'],
  root: process.cwd(),
};

export async function loadPolicy(path?: string): Promise<Policy> {
  if (!path) return { ...DEFAULT_POLICY, root: process.cwd() };
  const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<Policy>;
  const strList = (v: unknown, k: string) => {
    if (v !== undefined && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) throw new Error(`${k} must be a string array`);
    return v as string[] | undefined;
  };
  for (const k of ['allowTools', 'denyTools', 'sideEffectTools', 'allowedHosts', 'urlArgs', 'pathArgs'] as const) strList(raw[k], k);
  const limits = { ...DEFAULT_LIMITS, ...raw.limits };
  for (const [k, v] of Object.entries(limits)) if (!(typeof v === 'number' && v > 0)) throw new Error(`limits.${k} must be a positive number`);
  return { ...DEFAULT_POLICY, ...raw, limits, root: resolve(raw.root ?? process.cwd()) };
}

export const isSideEffect = (t: Tool, policy: Policy) =>
  policy.sideEffectTools ? policy.sideEffectTools.includes(t.name) : t.annotations?.readOnlyHint !== true || t.annotations?.destructiveHint === true;

export type Confirm = (tool: string, input: Record<string, unknown>) => Promise<boolean>;

function checkArgs(v: unknown, policy: Policy, key = ''): void {
  if (typeof v === 'string') {
    if (policy.urlArgs.includes(key) || /^https?:\/\//i.test(v)) {
      let host: string;
      try {
        host = new URL(v).hostname;
      } catch {
        throw new Error(`${key || 'argument'} is not a valid URL`);
      }
      if (!policy.allowedHosts.includes(host)) throw new Error(`URL host "${host}" is not allowed (allowed: ${policy.allowedHosts.join(', ')})`);
    }
    if (policy.pathArgs.includes(key)) {
      const p = resolve(policy.root, v);
      if (p !== policy.root && !p.startsWith(policy.root + sep)) throw new Error(`${key} must stay inside ${policy.root}`);
    }
  } else if (Array.isArray(v)) v.forEach((x) => checkArgs(x, policy, key));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) checkArgs(x, policy, k);
}

/**
 * The sandbox's only path to tools. Every call: tool exists and is allowed, input matches the tool's schema,
 * URLs and paths pass policy, side-effect tools are confirmed, then it forwards to the upstream server.
 */
export function createBridge(up: Upstream, policy: Policy, confirm: Confirm) {
  const ajv = new Ajv({ strict: false });
  const validators = new Map<string, ValidateFunction>();
  const byName = new Map(up.tools.map((t) => [t.name, t]));

  return async (name: string, input: unknown): Promise<unknown> => {
    const started = Date.now();
    const log = (outcome: string) => console.error(`codemode: ${name} ${outcome} ${Date.now() - started}ms`);
    try {
      const tool = byName.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      if (policy.denyTools.includes(name) || (policy.allowTools && !policy.allowTools.includes(name))) throw new Error(`Tool ${name} is not allowed from code`);
      const args = (input ?? {}) as Record<string, unknown>;
      if (typeof args !== 'object' || Array.isArray(args)) throw new Error(`${name}: input must be an object`);
      let validate = validators.get(name);
      if (!validate) validators.set(name, (validate = ajv.compile(tool.inputSchema)));
      if (!validate(args)) throw new Error(`${name}: invalid input: ${ajv.errorsText(validate.errors)}`);
      checkArgs(args, policy);
      if (isSideEffect(tool, policy) && !(await confirm(name, args)))
        throw new Error(`${name} has side effects and was not confirmed. Call the ${name} tool directly instead.`);
      const r = await up.callTool(name, args);
      if (r.isError) throw new Error(r.text.replace(/^Error:\s*/, ''));
      log('ok');
      try {
        return JSON.parse(r.text);
      } catch {
        return r.text;
      }
    } catch (e) {
      log(`denied/failed: ${(e as Error).message}`);
      throw e;
    }
  };
}
