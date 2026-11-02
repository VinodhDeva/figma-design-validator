import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forViewport, parseConfig, pickViewports, screenshotFor, tolerancesFor } from '../../src/config.ts';

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

test('component tolerances and screenshot settings override global ones', () => {
  const c = parseConfig({
    ...raw,
    screenshot: { maxDiffRatio: 0.01 },
    components: [{ name: 'Chart', selector: '.chart', tolerances: { size: 6 }, screenshot: { maxDiffRatio: 0.03 } }],
  });
  const comp = c.components[0];
  assert.equal(tolerancesFor(c, comp).size, 6);
  assert.equal(tolerancesFor(c, comp).spacing, 1);
  assert.deepEqual(screenshotFor(c, comp), { threshold: 0.1, maxDiffRatio: 0.03 });
  assert.throws(() => parseConfig({ ...raw, components: [{ name: 'x', selector: 'x', tolerances: { sise: 1 } }] }));
});
