import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Ajv } from 'ajv';
import { createBridge, isSideEffect, loadPolicy, type Confirm, type Policy } from './bridge.ts';
import { camel, renderTool, signature } from './generate.ts';
import { runCode, type SandboxTool } from './sandbox.ts';
import { connectUpstream, type Tool, type Upstream } from './upstream.ts';

export const VERSION = '0.1.0';

const text = (t: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text: t }], ...(isError && { isError: true }) });

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

/** Rank tools by how many query words appear in their name and description. Empty query lists all. */
export function searchTools(tools: Tool[], server: string, query = '', detail: 'name' | 'signature' | 'full' = 'signature', limit = 10): string {
  const q = words(query);
  const hits = tools
    .map((t) => {
      const hay = `${t.name} ${camel(t.name)} ${t.description ?? ''}`.toLowerCase();
      return { t, score: q.length ? q.filter((w) => hay.includes(w)).length : 1 };
    })
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
    .slice(0, limit);
  if (!hits.length) return `No tools match "${query}". Tools: ${tools.map((t) => camel(t.name)).join(', ')}`;
  if (detail === 'name') return hits.map((h) => camel(h.t.name)).join('\n');
  if (detail === 'full') return hits.map((h) => renderTool(h.t, server)).join('\n');
  return hits.map((h) => signature(h.t)).join('\n');
}

export function createCodemodeServer(up: Upstream, policy: Policy) {
  const server = new Server(
    { name: `${up.name}-codemode`, version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: `Code mode for ${up.name}. Find APIs with search_tools, then call execute_code with TypeScript that uses \`tools.<name>(input)\` and returns or console.logs only what you need. Filter large results in code. Tools with side effects need confirmation from code; they are also offered as direct tools.`,
    },
  );

  // Ask the user through MCP elicitation when the client supports it; otherwise deny.
  const confirm: Confirm = async (tool, input) => {
    if (!server.getClientCapabilities()?.elicitation) return false;
    const r = await server.elicitInput({
      mode: 'form',
      message: `Code mode wants to call ${tool} (it has side effects) with: ${JSON.stringify(input).slice(0, 500)}`,
      requestedSchema: { type: 'object', properties: { allow: { type: 'boolean', title: `Allow ${tool}` } }, required: ['allow'] },
    });
    return r.action === 'accept' && r.content?.allow === true;
  };
  const bridge = createBridge(up, policy, confirm);
  const sandboxTools: SandboxTool[] = up.tools.map((t) => ({
    fn: camel(t.name),
    name: t.name,
    required: ((t.inputSchema as { required?: string[] }).required ?? []).length > 0,
  }));
  const passThrough = up.tools.filter((t) => isSideEffect(t, policy) && !policy.denyTools.includes(t.name));

  const own: Tool[] = [
    {
      name: 'search_tools',
      description: `Find ${up.name} functions callable from execute_code. detail: "name" (names only), "signature" (one line each, default), "full" (typed wrapper with docs). Load only what you need.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to match in tool names and descriptions. Empty lists all.' },
          detail: { type: 'string', enum: ['name', 'signature', 'full'] },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'execute_code',
      description: `Run TypeScript in a sandbox (no network, files, env or processes). Call tools as \`await tools.<name>(input)\`; results are parsed JSON. Return a value or console.log what you need; only that is sent back (max ${policy.limits.maxOutputBytes} bytes, ${policy.limits.timeoutMs} ms, ${policy.limits.maxCalls} tool calls).`,
      inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'Body of an async function. May use await and return.' } }, required: ['code'] },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
  ];
  const ajv = new Ajv({ strict: false });
  const validateOwn = new Map(own.map((t) => [t.name, ajv.compile(t.inputSchema)]));

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...own, ...passThrough] }));
  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const { name } = req.params;
    const args = req.params.arguments ?? {};
    const v = validateOwn.get(name);
    if (v && !v(args)) return text(`Error: invalid input: ${ajv.errorsText(v.errors)}`, true);
    if (name === 'search_tools') {
      const a = args as { query?: string; detail?: 'name' | 'signature' | 'full'; limit?: number };
      return text(searchTools(up.tools, up.name, a.query, a.detail, a.limit));
    }
    if (name === 'execute_code') {
      const r = await runCode((args as { code: string }).code, sandboxTools, bridge, policy.limits);
      return text(r.output || '(no output)', !r.ok);
    }
    // Direct call of a side-effect tool: the client's own permission prompt is the gate.
    if (passThrough.some((t) => t.name === name)) {
      const r = await up.callTool(name, args);
      return text(r.text, r.isError);
    }
    return text(`Error: unknown tool ${name}`, true);
  });
  return server;
}

export async function serve(upstream: { command: string; args: string[] }, configPath?: string) {
  const policy = await loadPolicy(configPath);
  const up = await connectUpstream(upstream.command, upstream.args);
  const server = createCodemodeServer(up, policy);
  await server.connect(new StdioServerTransport());
  console.error(`${up.name}-codemode ready (stdio), ${up.tools.length} upstream tools`);
  const shutdown = async () => {
    await up.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
}
