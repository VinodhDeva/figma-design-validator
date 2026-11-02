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
    fontFamily: 'Inter', fontSize: 14, fontWeight: 500, lineHeight: 20, letterSpacing: 0, color: '#ffffff',
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

test('gap follows auto-layout axis; grid gives row/column gaps; text align only on text nodes', () => {
  const base = { id: '1', name: 'n', type: 'FRAME' };
  assert.deepEqual(extractProps({ ...base, itemSpacing: 8 }), {}, 'no auto layout -> no gap');
  assert.deepEqual(extractProps({ ...base, layoutMode: 'VERTICAL', itemSpacing: 8 }), { gap: 8 });
  assert.deepEqual(extractProps({ ...base, layoutMode: 'HORIZONTAL', layoutWrap: 'WRAP', itemSpacing: 8, counterAxisSpacing: 16 }), { gap: 8, rowGap: 16 });
  assert.deepEqual(extractProps({ ...base, layoutMode: 'GRID', gridRowGap: 4, gridColumnGap: 12, itemSpacing: 99 }), { rowGap: 4, columnGap: 12 });
  const text = { id: '2', name: 't', type: 'TEXT', style: { textAlignHorizontal: 'RIGHT' } };
  assert.equal(extractProps(text).textAlign, 'right');
});

test('border width uses the widest individual stroke', () => {
  const p = extractProps({
    id: '1', name: 'n', type: 'FRAME', strokeWeight: 1,
    individualStrokeWeights: { top: 0, right: 0, bottom: 2, left: 0 },
    strokes: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
  });
  assert.deepEqual(p, { borderColor: '#ff0000', borderWidth: 2 });
});
