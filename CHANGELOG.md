# Changelog

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
