import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import node from '../fixtures/figma-node.json' with { type: 'json' };
import { FigmaAdapter, extractProps, hierarchy, type FigmaNode } from '../../src/design/figma.ts';
import { parseConfig } from '../../src/config.ts';

test('extracts normalized props from a Figma node', () => {
  const frame = { id: '0:1', name: 'Page', type: 'FRAME', absoluteBoundingBox: { x: 100, y: 100, width: 1440, height: 900 } };
  const p = extractProps(node as FigmaNode, frame);
  assert.deepEqual(p, {
    width: 120, height: 40, x: 16, y: 100,
    paddingTop: 8, paddingRight: 16, paddingBottom: 8, paddingLeft: 16, gap: 4, borderRadius: 8,
    backgroundColor: '#2563eb',
    fontFamily: 'Inter', fontSize: 14, fontWeight: 500, lineHeight: 20, letterSpacing: 0, textAlign: 'center', color: '#ffffff',
  });
  assert.deepEqual(hierarchy(node as FigmaNode), ['Label']);
});

test('falls back to spec file without Figma token, inline expected overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uiv-'));
  await writeFile(join(dir, 'spec.json'), JSON.stringify({ components: { Btn: { width: 100, height: 40 } } }));
  const prev = process.env.FIGMA_TOKEN;
  delete process.env.FIGMA_TOKEN;
  const config = parseConfig(
    {
      baseUrl: 'http://localhost:3000',
      figma: { fileKey: 'abc' },
      designSpecPath: 'spec.json',
      cacheDir: 'cache',
      components: [{ name: 'Btn', selector: '.btn', figmaNodeId: '1:2', expected: { height: 44 } }],
    },
    dir,
  );
  const r = await new FigmaAdapter(config).inspect(config.components);
  process.env.FIGMA_TOKEN = prev;
  assert.equal(r.source, 'spec-file');
  assert.deepEqual(r.specs[0].props, { width: 100, height: 44 });
  assert.match(r.warnings[0], /Figma unavailable/);
});

test('uses a saved Figma /nodes response as spec file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uiv-'));
  await writeFile(join(dir, 'nodes.json'), JSON.stringify({ nodes: { '1:2': { document: node } } }));
  const config = parseConfig(
    { baseUrl: 'http://localhost:3000', designSpecPath: 'nodes.json', components: [{ name: 'Btn', selector: '.btn', figmaNodeId: '1:2' }] },
    dir,
  );
  const r = await new FigmaAdapter(config).inspect(config.components);
  assert.equal(r.specs[0].props.backgroundColor, '#2563eb');
  assert.deepEqual(r.specs[0].children, ['Label']);
});
