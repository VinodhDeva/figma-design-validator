import { relative } from 'node:path';
import type { Finding } from '../types.ts';
import { parseColor } from '../compare/color.ts';
import { sortFindings, type ReportInput } from './report.ts';

const esc = (v: unknown) =>
  v === null || v === undefined
    ? '—'
    : String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const SEV_RANK = { high: 3, medium: 2, low: 1 } as const;

/** Value cell: color swatch for colors, plain text otherwise. */
const val = (v: Finding['expected']) =>
  typeof v === 'string' && /^#[0-9a-f]{6,8}$/i.test(v) && parseColor(v)
    ? `<span class="sw" style="background:${v}"></span><code>${esc(v)}</code>`
    : `<code>${esc(v)}</code>`;

const delta = (f: Finding) =>
  typeof f.expected === 'number' && typeof f.actual === 'number'
    ? `${f.actual - f.expected > 0 ? '+' : ''}${Math.round((f.actual - f.expected) * 100) / 100}`
    : '';

/** Self-contained HTML summary: status, counts, per-component rollup, findings, screenshot diffs. */
export function toHtml(r: ReportInput, outputDir: string, title = 'UI Validation Report'): string {
  const s = r.summary;
  const findings = sortFindings(r.findings);
  const byComp = Map.groupBy(findings, (f) => f.component);
  const rollup = [...byComp]
    .map(([name, fs]) => ({
      name,
      fail: fs.filter((f) => f.status === 'FAIL').length,
      warn: fs.filter((f) => f.status === 'WARNING').length,
      worst: fs.reduce((m, f) => Math.max(m, SEV_RANK[f.severity]), 0),
      props: [...new Set(fs.map((f) => f.property))],
    }))
    .sort((a, b) => b.worst - a.worst || b.fail - a.fail);
  const sevName = ['', 'low', 'medium', 'high'];
  const shots = (r.screenshots ?? []).filter((x) => x.status !== 'PASS');
  const img = (p?: string) => (p ? `<img src="${esc(relative(outputDir, p))}" alt="" loading="lazy">` : '');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
:root{--bg:#f7f7f8;--card:#fff;--ink:#1d1d22;--muted:#61616b;--line:#e3e3e8;--fail:#c4314b;--warn:#a86400;--pass:#1f7a4d;--failbg:#fdecef;--warnbg:#fff4e0;--passbg:#e7f6ee}
@media (prefers-color-scheme:dark){:root{--bg:#141418;--card:#1d1d23;--ink:#ececf1;--muted:#a3a3ae;--line:#33333c;--fail:#ff7a90;--warn:#f0b357;--pass:#5fd39a;--failbg:#3a1820;--warnbg:#3a2a10;--passbg:#123124}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 12px}
.meta{color:var(--muted);font-size:13px}.pill{display:inline-block;padding:2px 10px;border-radius:99px;font-weight:600;font-size:12px}
.FAIL{color:var(--fail);background:var(--failbg)}.WARNING{color:var(--warn);background:var(--warnbg)}.PASS{color:var(--pass);background:var(--passbg)}
.banner{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:16px 0;padding:16px;border-radius:12px;border:1px solid var(--line);background:var(--card)}
.banner .pill{font-size:16px;padding:4px 14px}.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 16px}.kpi b{display:block;font-size:24px}.kpi span{color:var(--muted);font-size:12px}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:12px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}tr:last-child td{border-bottom:0}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace}.sw{display:inline-block;width:12px;height:12px;border-radius:3px;border:1px solid var(--line);margin-right:6px;vertical-align:-1px}
.sev-high{color:var(--fail);font-weight:600}.sev-medium{color:var(--warn);font-weight:600}.sev-low{color:var(--muted)}
details{margin-bottom:12px}summary{cursor:pointer;font-weight:600;padding:8px 0}
.shots{display:grid;gap:16px}.shot{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
.imgs{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:8px}.imgs img{max-width:100%;border:1px solid var(--line);border-radius:6px;background:repeating-conic-gradient(#ccc 0 25%,#fff 0 50%) 0 0/12px 12px}
ul{margin:0;padding-left:20px}.muted{color:var(--muted)}
</style></head><body><main>
<h1>${esc(title)}</h1>
<div class="meta">Generated ${esc(new Date().toISOString())}${r.mode ? ` · mode ${esc(r.mode)}` : ''}${r.designSource ? ` · design source ${esc(r.designSource)}` : ''}${r.viewports?.length ? ` · viewports ${esc(r.viewports.join(', '))}` : ''}</div>
<div class="banner"><span class="pill ${s.status}">${s.status}</span><span>${
    s.status === 'PASS'
      ? 'All checked properties match the design.'
      : `${s.failed} failure${s.failed === 1 ? '' : 's'} and ${s.warnings} warning${s.warnings === 1 ? '' : 's'} across ${rollup.length} component${rollup.length === 1 ? '' : 's'}.`
  }</span></div>
<div class="kpis">
<div class="kpi"><b>${s.checked}</b><span>checks run</span></div>
<div class="kpi"><b style="color:var(--fail)">${s.failed}</b><span>failures</span></div>
<div class="kpi"><b style="color:var(--warn)">${s.warnings}</b><span>warnings</span></div>
<div class="kpi"><b>${rollup.length}</b><span>components with issues</span></div>
</div>
${
  rollup.length
    ? `<h2>Issues by component</h2><div class="wrap"><table><thead><tr><th>Component</th><th>Worst</th><th>Fail</th><th>Warn</th><th>Properties</th></tr></thead><tbody>
${rollup.map((c) => `<tr><td><a href="#c-${esc(c.name)}">${esc(c.name)}</a></td><td class="sev-${sevName[c.worst]}">${sevName[c.worst]}</td><td>${c.fail}</td><td>${c.warn}</td><td><code>${esc(c.props.join(', '))}</code></td></tr>`).join('\n')}
</tbody></table></div>
<h2>Findings</h2>
${rollup
  .map(
    (c) => `<details open id="c-${esc(c.name)}"><summary>${esc(c.name)} <span class="muted">(${c.fail + c.warn})</span></summary><div class="wrap"><table>
<thead><tr><th>Status</th><th>Severity</th><th>Viewport</th><th>Property</th><th>Expected</th><th>Actual</th><th>Δ</th></tr></thead><tbody>
${byComp
  .get(c.name)!
  .map((f) => `<tr><td><span class="pill ${f.status}">${f.status}</span></td><td class="sev-${f.severity}">${f.severity}</td><td>${esc(f.viewport)}</td><td><code>${esc(f.property)}</code></td><td>${val(f.expected)}</td><td>${val(f.actual)}</td><td><code>${esc(delta(f))}</code></td></tr>`)
  .join('\n')}
</tbody></table></div></details>`,
  )
  .join('\n')}`
    : ''
}
${
  shots.length
    ? `<h2>Screenshot differences</h2><div class="shots">${shots
        .map(
          (x) => `<div class="shot"><b>${esc(x.component)}</b> <span class="muted">${esc(x.viewport)}</span> <span class="pill ${x.status}">${x.status}</span>
<div class="meta">diff ratio ${esc(x.diffRatio)} (${esc(x.diffPixels)} px)${x.diffBox ? ` · region x${x.diffBox.x} y${x.diffBox.y} ${x.diffBox.width}×${x.diffBox.height}` : ''}${x.sizeMismatch ? ` · size ${x.sizeMismatch.actual.join('×')} vs reference ${x.sizeMismatch.reference.join('×')}` : ''}</div>
<div class="imgs">${img(x.actualImage)}${img(x.diffImage)}</div></div>`,
        )
        .join('\n')}</div>`
    : ''
}
${r.warnings?.length ? `<h2>Notes</h2><ul>${r.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
</main></body></html>
`;
}
