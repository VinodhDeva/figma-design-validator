import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { compareImages } from '../../src/compare/screenshot.ts';

function png(w: number, h: number, paint?: (x: number, y: number) => [number, number, number] | undefined, alpha = 255) {
  const p = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const [r, g, b] = paint?.(x, y) ?? [255, 255, 255];
      p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = alpha;
    }
  return PNG.sync.write(p);
}

test('identical images pass', async () => {
  const r = await compareImages({ reference: png(20, 20), actual: png(20, 20), threshold: 0.1, maxDiffRatio: 0 });
  assert.equal(r.status, 'PASS');
  assert.equal(r.diffPixels, 0);
});

test('diff box locates the changed region', async () => {
  const actual = png(20, 20, (x, y) => (x >= 5 && x < 10 && y >= 2 && y < 4 ? [0, 0, 0] : undefined));
  const r = await compareImages({ reference: png(20, 20), actual, threshold: 0.1, maxDiffRatio: 0.01 });
  assert.equal(r.status, 'FAIL');
  assert.equal(r.diffPixels, 10);
  assert.deepEqual(r.diffBox, { x: 5, y: 2, width: 5, height: 2 });
});

test('size mismatch counts non-overlap and is reported', async () => {
  const r = await compareImages({ reference: png(20, 20), actual: png(20, 19), threshold: 0.1, maxDiffRatio: 0.1 });
  assert.equal(r.status, 'WARNING');
  assert.deepEqual(r.sizeMismatch, { reference: [20, 20], actual: [20, 19] });
  assert.equal(r.diffRatio, 0.05);
});

test('transparent reference is flattened onto the page background', async () => {
  const bg: [number, number, number] = [255, 244, 234];
  // Transparent frame with an opaque 4x4 dark block, vs. a capture of the same block on the peach page.
  const ref = new PNG({ width: 20, height: 20 });
  for (let i = 0; i < 20 * 20; i++) {
    const x = i % 20, y = Math.floor(i / 20);
    if (x < 4 && y < 4) ref.data.set([0, 0, 0, 255], i * 4);
  }
  const actual = png(20, 20, (x, y) => (x < 4 && y < 4 ? [0, 0, 0] : bg));
  const r = await compareImages({ reference: PNG.sync.write(ref), actual, threshold: 0.1, maxDiffRatio: 0, background: '#fff4ea' });
  assert.equal(r.status, 'PASS');
  const unflattened = await compareImages({ reference: PNG.sync.write(ref), actual, threshold: 0.1, maxDiffRatio: 0, background: '#000000' });
  assert.equal(unflattened.status, 'FAIL');
});
