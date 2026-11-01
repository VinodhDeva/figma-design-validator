import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Finding, Summary } from '../types.ts';

export interface ReportInput {
  summary: Summary;
  findings: Finding[];
  mode?: string;
  designSource?: string;
  viewports?: string[];
  warnings?: string[];
}

const SEV_ORDER = { high: 0, medium: 1, low: 2 } as const;

export const sortFindings = (f: Finding[]) =>
  [...f].sort((a, b) => (a.status === b.status ? 0 : a.status === 'FAIL' ? -1 : 1) || SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);

export function toJson(r: ReportInput) {
  return {
    status: r.summary.status,
    summary: r.summary,
    ...(r.mode && { mode: r.mode }),
    ...(r.designSource && { designSource: r.designSource }),
    ...(r.viewports && { viewports: r.viewports }),
    findings: sortFindings(r.findings),
    ...(r.warnings?.length && { warnings: r.warnings }),
  };
}

const cell = (v: unknown) => (v === null || v === undefined ? '—' : String(v).replace(/\|/g, '\\|'));

export function toMarkdown(r: ReportInput, title = 'UI Validation Report'): string {
  const s = r.summary;
  const lines = [
    `# ${title}`,
    '',
    `**Status:** ${s.status} · checked ${s.checked} · failed ${s.failed} · warnings ${s.warnings}` +
      (r.mode ? ` · mode ${r.mode}` : '') +
      (r.designSource ? ` · design ${r.designSource}` : '') +
      (r.viewports?.length ? ` · viewports ${r.viewports.join(', ')}` : ''),
    '',
  ];
  if (r.findings.length) {
    lines.push('| Status | Severity | Component | Viewport | Property | Expected | Actual |', '|---|---|---|---|---|---|---|');
    for (const f of sortFindings(r.findings))
      lines.push(`| ${f.status} | ${f.severity} | ${cell(f.component)} | ${cell(f.viewport)} | ${cell(f.property)} | ${cell(f.expected)} | ${cell(f.actual)} |`);
  } else lines.push('No mismatches found.');
  if (r.warnings?.length) lines.push('', '## Notes', ...r.warnings.map((w) => `- ${w}`));
  return lines.join('\n') + '\n';
}

export async function writeReports(r: ReportInput, outputDir: string, name = 'report') {
  await mkdir(outputDir, { recursive: true });
  const json = join(outputDir, `${name}.json`);
  const md = join(outputDir, `${name}.md`);
  await Promise.all([writeFile(json, JSON.stringify(toJson(r), null, 2)), writeFile(md, toMarkdown(r))]);
  return { json, markdown: md };
}
