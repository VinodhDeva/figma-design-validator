#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeBrowser } from './browser/inspector.ts';
import { VERSION, createServer } from './server.ts';

// Lets users warm the npx cache (or check the install) without starting a stdio session.
if (process.argv.includes('--version')) {
  console.log(VERSION);
  process.exit(0);
}

// Opt-in code mode: a separate MCP server that adopts this one. Without the flag nothing changes.
if (process.argv.includes('--codemode')) {
  const { runCodemode } = await import('./codemode/cli.ts');
  await runCodemode(process.argv.slice(2));
} else {
  // stdout carries the MCP protocol; diagnostics go to stderr only.
  const server = createServer();
  await server.connect(new StdioServerTransport());
  console.error('figma-design-validator ready (stdio)');

  const shutdown = async () => {
    await closeBrowser();
    await server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.stdin.on('close', shutdown);
}
