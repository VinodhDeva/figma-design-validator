import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { camel, renderAll, signature, syncFiles } from '../../src/codemode/generate.ts';
import { schemaToTs } from '../../src/codemode/schema-to-ts.ts';
import type { Tool } from '../../src/codemode/upstream.ts';

const root = new URL('../..', import.meta.url).pathname;

const tool: Tool = {
  name: 'compare_screenshots',
  description: 'Pixel diff. Returns a ratio.',
  inputSchema: {
    type: 'object',
    properties: {
      component: { type: 'string', description: 'Config component' },
      viewport: { anyOf: [{ type: 'string' }, { type: 'object', properties: { width: { type: 'integer' } }, required: ['width'] }] },
      mode: { type: 'string', enum: ['quick', 'deep'] },
      selectors: { type: 'object', additionalProperties: { type: 'string' } },
      'odd-key': { type: 'array', items: { type: 'number' } },
    },
    required: ['component'],
  },
};

test('schemaToTs covers unions, enums, records, arrays and quoted keys', () => {
  const ts = schemaToTs(tool.inputSchema as never);
  assert.match(ts, /component: string;/);
  assert.match(ts, /viewport\?: string \| \{/);
  assert.match(ts, /mode\?: "quick" \| "deep";/);
  assert.match(ts, /\[key: string\]: string;/);
  assert.match(ts, /"odd-key"\?: number\[\];/);
  assert.equal(schemaToTs({}), 'unknown');
});

test('wrappers only forward to callTool; required input has no default', () => {
  const files = renderAll('My Server', [tool]);
  const src = files.get('my-server/compareScreenshots.ts')!;
  assert.match(src, /export function compareScreenshots\(input: CompareScreenshotsInput\): Promise<unknown> \{\n  return callTool\("compare_screenshots", input\);\n\}/);
  assert.equal(camel('draft_config'), 'draftConfig');
  assert.equal(signature(tool), 'tools.compareScreenshots(input: { component: string; viewport?: string | { width: number }; mode?: "quick" | "deep"; selectors?: { [key: string]: string }; "odd-key"?: number[] }): Promise<unknown> // Pixel diff.');
});

test('check reports changed and stale files without writing; write fixes them', async () => {
  const out = await mkdtemp(join(tmpdir(), 'cm-gen-'));
  const files = renderAll('srv', [tool]);
  assert.equal((await syncFiles(out, 'srv', files, false)).length, 3);
  assert.deepEqual(await syncFiles(out, 'srv', files, true), []);
  await writeFile(join(out, 'srv/compareScreenshots.ts'), '// edited');
  await writeFile(join(out, 'srv/removedTool.ts'), '// old');
  assert.deepEqual((await syncFiles(out, 'srv', files, true)).sort(), ['srv/compareScreenshots.ts', 'srv/removedTool.ts']);
  assert.equal(await readFile(join(out, 'srv/compareScreenshots.ts'), 'utf8'), '// edited', 'check must not write');
  await syncFiles(out, 'srv', files, false);
  assert.deepEqual(await syncFiles(out, 'srv', files, true), []);
});

test('committed wrappers type-check', () => {
  const tsc = join(root, 'node_modules/typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '--ignoreConfig', '--noEmit', '--strict', '--allowImportingTsExtensions', '--module', 'nodenext', '--target', 'es2024', join(root, 'servers/figma-design-validator/index.ts')], { stdio: 'pipe' });
});
