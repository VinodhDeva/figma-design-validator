import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type { Tool };

/** The server code mode adopts. Its tools are the single source of truth. */
export const DEFAULT_UPSTREAM = { command: 'npx', args: ['-y', 'figma-design-validator'] };

export interface Upstream {
  name: string;
  tools: Tool[];
  /** The only path to the upstream server's tools. */
  callTool(name: string, args: Record<string, unknown>): Promise<CallResult>;
  close(): Promise<void>;
}

export interface CallResult {
  isError: boolean;
  text: string;
}

export async function connectUpstream(command: string, args: string[]): Promise<Upstream> {
  const client = new Client({ name: 'figma-design-validator-codemode', version: '0.1.0' });
  // Upstream inherits our env (it may need FIGMA_TOKEN); the sandbox never does.
  await client.connect(new StdioClientTransport({ command, args, stderr: 'inherit' }));
  const { tools } = await client.listTools();
  return {
    name: client.getServerVersion()?.name ?? command,
    tools,
    async callTool(name, a) {
      const r = await client.callTool({ name, arguments: a }, undefined, { timeout: 10 * 60_000 });
      const content = (r.content ?? []) as { type: string; text?: string }[];
      const text = content.map((c) => (c.type === 'text' ? c.text : `[${c.type} content]`)).join('\n');
      return { isError: r.isError === true, text };
    },
    close: () => client.close(),
  };
}
