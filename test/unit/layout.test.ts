import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareProps } from '../../src/compare/layout.ts';
import { DEFAULT_TOLERANCES as T } from '../../src/config.ts';

test('within tolerance passes', () => {
  const r = compareProps('Btn', { width: 120, color: '#ffffff' }, { width: 121.5, color: '#fdfdfd' }, T);
  assert.equal(r.checked, 2);
  assert.deepEqual(r.findings, []);
});

test('small overshoot is WARNING/low, large is FAIL', () => {
  const r = compareProps('Btn', { width: 120, height: 40, fontSize: 16 }, { width: 123, height: 60, fontSize: 14 }, T);
  const by = Object.fromEntries(r.findings.map((f) => [f.property, f]));
  assert.equal(by.width.status, 'WARNING');
  assert.equal(by.width.severity, 'low');
  assert.equal(by.height.status, 'FAIL');
  assert.equal(by.height.severity, 'high'); // 50% off
  assert.equal(by.fontSize.status, 'FAIL');
  assert.equal(by.fontSize.severity, 'medium'); // 12.5% off
});

test('text props normalize fonts and alignment', () => {
  const r = compareProps('T', { fontFamily: 'Inter', textAlign: 'left' }, { fontFamily: '"Inter", Arial, sans-serif', textAlign: 'start' }, T);
  assert.deepEqual(r.findings, []);
  const bad = compareProps('T', { fontFamily: 'Inter' }, { fontFamily: 'Arial' }, T);
  assert.equal(bad.findings[0].status, 'FAIL');
});

test('color mismatch reports normalized hex and severity', () => {
  const r = compareProps('B', { backgroundColor: '#2563eb' }, { backgroundColor: 'rgb(220, 38, 38)' }, T);
  assert.equal(r.findings[0].expected, '#2563eb');
  assert.equal(r.findings[0].actual, '#dc2626');
  assert.equal(r.findings[0].severity, 'high');
});

test('missing actual prop fails; `only` filters props', () => {
  const r = compareProps('B', { gap: 8, width: 10 }, { width: 10 }, T, ['gap']);
  assert.equal(r.checked, 1);
  assert.equal(r.findings[0].actual, null);
});
