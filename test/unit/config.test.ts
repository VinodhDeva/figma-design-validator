import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forViewport, parseConfig, pickViewports } from '../../src/config.ts';

const raw = {
  baseUrl: 'http://localhost:5173',
  viewports: [{ name: 'desktop', width: 1440, height: 900 }, { name: 'mobile', width: 375, height: 812 }],
  tolerances: { size: 3 },
  components: [{ name: 'Card', selector: '.card', expected: { width: 320 }, responsive: { mobile: { expected: { width: 375 } } } }],
};

test('applies defaults and merges tolerances', () => {
  const c = parseConfig(raw, '/proj');
  assert.equal(c.tolerances.size, 3);
  assert.equal(c.tolerances.spacing, 1);
  assert.equal(c.cacheDir, '/proj/.ui-validation-cache');
  assert.equal(c.screenshot.maxDiffRatio, 0.01);
});

test('quick mode uses first viewport; responsive overrides apply', () => {
  const c = parseConfig(raw, '/proj');
  assert.deepEqual(pickViewports(c, 'quick').map((v) => v.name), ['desktop']);
  assert.equal(pickViewports(c, 'deep').length, 2);
  assert.equal(forViewport(c.components[0], 'mobile').expected!.width, 375);
});

test('rejects unknown style properties', () => {
  assert.throws(() => parseConfig({ ...raw, components: [{ name: 'x', selector: 'x', expected: { widht: 1 } }] }));
});
