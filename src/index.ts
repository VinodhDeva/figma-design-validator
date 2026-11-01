#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeBrowser } from './browser/inspector.ts';
import { createServer } from './server.ts';

// stdout carries the MCP protocol; diagnostics go to stderr only.
const server = createServer();
await server.connect(new StdioServerTransport());
console.error('ui-validation-mcp ready (stdio)');

const shutdown = async () => {
  await closeBrowser();
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);
