# Changelog

## 0.4.0 — 2026-11-02

First release on npm: https://www.npmjs.com/package/figma-design-validator

### Changed

- Package renamed to `figma-design-validator`, matching the repository. Clients run it with `npx -y figma-design-validator`, or `npx -y github:VinodhDeva/figma-design-validator` for the latest `main`. No clone or build is needed.
- The browser is found automatically: Playwright's Chromium, then Google Chrome, then Microsoft Edge. If none exists, Playwright's Chromium is installed once on first use.
- The MCP server name reported to clients is now `figma-design-validator`.

### Added

- `prepare` script: builds `dist/` on `npm install`, `npm publish` and GitHub installs.
- `--version` flag, to check an install or warm the npx cache.

## 0.3.0 — 2026-11-02

### Added

- `draft_config` tool. It drafts a config for one page by matching Figma frame layers to DOM elements (identical visible text; layer name vs `data-testid`/`id`/`aria-label`). It writes `*.draft.json` with unique selectors, node ids and a score per match. It never overwrites a live config.
- Per-component `tolerances` and `screenshot` (`threshold`, `maxDiffRatio`) overrides. Precedence: tool arguments > component > global > defaults.
- Docs: a "Team decisions" section covering which components to check, screenshot limits, tolerances and `ignore`.

## 0.2.0 — 2026-11-02

### Fixed

- Screenshot diffs against transparent references (Figma exports of frames with no fill) reported 76–93 % different pixels. Both images are now composited onto the page background behind the element before diffing.
- `gap` was read as the row gap for grids. `gap` is now flex main-axis spacing only; new `rowGap` and `columnGap` props cover grids and wrapped rows. The Figma side maps `itemSpacing`, `counterAxisSpacing` and grid gaps by `layoutMode`.
- `borderColor`/`borderWidth` were read from the top border only. They now come from the widest visible side, and from `individualStrokeWeights` in Figma.
- `textAlign` was checked on flex/grid containers and Figma frames, where it does not position content. It is now read from text elements only.

### Added

- `report.html`: a self-contained, readable summary report. `generate_report` always writes it; `validate_layout` writes it whenever it finds issues and returns its path.
- `compare_screenshots` file mode takes a `background` color.

## 0.1.0 — 2026-11-01

First release.

- MCP server over STDIO with 5 tools: `inspect_design`, `inspect_ui`, `validate_layout`, `compare_screenshots`, `generate_report`.
- Figma REST adapter with disk cache, plus fallback to a local design spec file or inline `expected` values.
- Playwright inspection of computed CSS for requested selectors only, with optional axe-core scan.
- Deterministic layout rules with configurable tolerances.
- pixelmatch screenshot diff with a diff bounding box.
- Quick (default) and deep validation modes.
- JSON and Markdown reports.
- Setup examples for Claude Code and KIRO CLI/IDE.
- Unit tests and STDIO integration tests.
