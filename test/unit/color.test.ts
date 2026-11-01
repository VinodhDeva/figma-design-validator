import { test } from 'node:test';
import assert from 'node:assert/strict';
import { colorDistance, normalizeColor, parseColor } from '../../src/compare/color.ts';

test('parses hex and rgb forms', () => {
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
  assert.deepEqual(parseColor('rgb(37, 99, 235)'), [37, 99, 235, 1]);
  assert.deepEqual(parseColor('rgba(0 0 0 / 50%)'), [0, 0, 0, 0.5]);
  assert.equal(parseColor('oklch(0.5 0.1 200)'), undefined);
});

test('normalizes to hex', () => {
  assert.equal(normalizeColor('rgb(37, 99, 235)'), '#2563eb');
  assert.equal(normalizeColor('rgba(0, 0, 0, 0)'), '#00000000');
});

test('distance is max channel delta; transparent equals transparent', () => {
  assert.equal(colorDistance('#000000', '#030102'), 3);
  assert.equal(colorDistance('rgba(255,0,0,0)', 'transparent'), 0);
  assert.equal(colorDistance('#000', 'nope'), undefined);
});
