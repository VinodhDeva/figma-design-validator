/** Subset of JSON Schema emitted by zod and most MCP servers. Unknown shapes become `unknown`. */
export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  description?: string;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;
const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
const pad = (n: number) => '  '.repeat(n);

/** Render a JSON Schema as a TypeScript type expression. Deterministic, so generated files diff cleanly. */
export function schemaToTs(s: JsonSchema | undefined, depth = 0): string {
  if (!s || typeof s !== 'object') return 'unknown';
  if (s.const !== undefined) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v) => JSON.stringify(v)).join(' | ') || 'never';
  const union = s.anyOf ?? s.oneOf;
  if (union) return union.map((u) => wrap(schemaToTs(u, depth))).join(' | ');
  if (Array.isArray(s.type)) return s.type.map((t) => schemaToTs({ ...s, type: t }, depth)).join(' | ');
  switch (s.type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return `${wrap(schemaToTs(s.items, depth))}[]`;
    case 'object':
    case undefined: {
      if (!s.properties && s.type === undefined) return 'unknown';
      const req = new Set(s.required ?? []);
      const lines = Object.entries(s.properties ?? {}).map(([k, v]) => {
        const doc = v.description ? `${pad(depth + 1)}/** ${v.description.replace(/\*\//g, '* /')} */\n` : '';
        return `${doc}${pad(depth + 1)}${key(k)}${req.has(k) ? '' : '?'}: ${schemaToTs(v, depth + 1)};`;
      });
      const ap = s.additionalProperties;
      if (ap && typeof ap === 'object') lines.push(`${pad(depth + 1)}[key: string]: ${schemaToTs(ap, depth + 1)};`);
      return lines.length ? `{\n${lines.join('\n')}\n${pad(depth)}}` : 'Record<string, unknown>';
    }
    default:
      return 'unknown';
  }
}

const wrap = (t: string) => (/[|&]/.test(t) && !t.startsWith('{') ? `(${t})` : t);
