# Changelog

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
