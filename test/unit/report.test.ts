import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toJson, toMarkdown } from '../../src/report/report.ts';
import { toHtml } from '../../src/report/html.ts';
import { summarize } from '../../src/validate.ts';
import type { Finding } from '../../src/types.ts';

const findings: Finding[] = [
  { component: 'Btn', property: 'width', expected: 120, actual: 123, status: 'WARNING', severity: 'low' },
  { component: 'Btn', property: 'fontSize', expected: 16, actual: 14, status: 'FAIL', severity: 'medium' },
];

test('summary status', () => {
  assert.equal(summarize([], 3).status, 'PASS');
  assert.equal(summarize([findings[0]], 3).status, 'WARNING');
  assert.deepEqual(summarize(findings, 5), { status: 'FAIL', checked: 5, failed: 1, warnings: 1 });
});

test('json sorts FAIL first; markdown has a table row per finding', () => {
  const input = { summary: summarize(findings, 5), findings };
  assert.equal(toJson(input).findings[0].property, 'fontSize');
  const md = toMarkdown(input);
  assert.match(md, /\*\*Status:\*\* FAIL/);
  assert.equal(md.split('\n').filter((l) => l.startsWith('| FAIL') || l.startsWith('| WARNING')).length, 2);
});

test('html report has status, rollup, swatches and escapes input', () => {
  const html = toHtml(
    {
      summary: summarize(findings, 5),
      findings: [...findings, { component: '<script>x</script>', property: 'color', expected: '#2563eb', actual: '#dc2626', status: 'FAIL', severity: 'high' }],
    },
    '/out',
  );
  assert.match(html, /class="pill FAIL">FAIL</);
  assert.match(html, /Issues by component/);
  assert.match(html, /class="sw" style="background:#2563eb"/);
  assert.ok(!html.includes('<script>x'));
  assert.match(html, /&lt;script&gt;x/);
  assert.match(html, /<code>-2<\/code>/, 'numeric delta');
});
