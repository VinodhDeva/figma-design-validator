# Changelog

## 0.5.0 — 2026-11-04

Released on npm: https://www.npmjs.com/package/figma-design-validator/v/0.5.0

**Summary:** adds an optional code mode, turned on with `--codemode`. Without the flag, 0.5.0 behaves exactly like 0.4.0: same 6 tools, same results, same config. Nothing needs to change when you upgrade.

### Added

- **Code mode** (`figma-design-validator --codemode`). The model writes TypeScript that calls the tools inside a sandbox, and only what the code returns enters its context. Details: [docs/codemode.md](docs/codemode.md).
  - **Adopts the regular server.** It starts this package's regular server as a separate stdio process, connects as an MCP client, and forwards every call with `callTool`. No tool is reimplemented, so results are identical.
  - **Tools in code mode:** `search_tools` (find functions on demand: `name`, `signature` or `full`), `execute_code` (run TypeScript), and `generate_report` / `draft_config` passed through unchanged.
  - **Sandbox:** a Deno subprocess with no permissions and an empty environment. Network, files, environment variables, subprocesses, FFI and remote or npm imports are all blocked. Each run has a timeout (30 s), a heap limit (128 MB), an output cap (8 KB) and a tool-call cap (50); all are configurable.
  - **Bridge:** every call from code is checked before it reaches the server. It validates input against the tool's JSON Schema, applies allow/deny lists, allows URLs only to `localhost` / `127.0.0.1` / `[::1]`, and keeps paths inside the working directory. Tools with side effects need your approval via MCP elicitation; without elicitation they are denied from code and offered as direct tools instead.
  - **Deno on first use.** Deno is not a package dependency. The first code-mode run installs it (about 80 MB) into `~/.cache/figma-design-validator/deno-2.9.6`. `CODEMODE_DENO=/path/to/deno` uses an existing binary.
  - **Typed wrappers:** `--codemode generate [--check]` writes one typed function per tool from the live tool list to `servers/`. CI fails if they are stale (`npm run codemode:check`).
  - **Any MCP server:** `--codemode -- <command> <args...>` adopts another server instead.
- CI workflow (`.github/workflows/ci.yml`): all tests plus the wrapper check.
- Scripts: `codemode:generate`, `codemode:check`, `bench:codemode`.

### Changed

- `ajv` is now an explicit dependency. It was already installed through the MCP SDK.
- The package is 54 kB, up from 40 kB, and still has no Deno inside.

### Compared with 0.4.0

| | 0.4.0 | 0.5.0 without flag | 0.5.0 with `--codemode` |
|---|---|---|---|
| Client `args` | `["-y", "figma-design-validator"]` | same | `["-y", "figma-design-validator", "--codemode"]` |
| Tools the model sees | 6 | same 6 | `search_tools`, `execute_code`, `generate_report`, `draft_config` |
| How tools run | Model calls each tool; every full result enters its context | same | Model writes code; results stay in the sandbox; only the return value enters its context |
| Tool definitions in context | about 2,600 tokens | same | about 1,100 tokens |
| Install | 40 kB | 54 kB | 54 kB + Deno (about 80 MB, once) |

### How code mode reduces tokens

1. **Large results stay out of context.** The full tool output stays in the sandbox; the code filters it and returns only what matters. This is the main saving.
2. **Smaller tool definitions.** 4 short tools instead of 6 full schemas (about 1,100 vs 2,600 tokens). The model loads a tool's details with `search_tools` only when it needs them.
3. **Many calls in one step.** A loop over many tool calls runs inside one `execute_code`, and only the summary comes back.

Benchmark against the real server (`npm run bench:codemode`, tokens ≈ characters ÷ 4, no LLM in the loop):

| Workflow | Regular | Code mode | Without definitions |
|---|---|---|---|
| 1,000 list rows, find wrong heights | 20,278 | 1,395 (−93%) | 17,708 → 306 (−98%) |
| 8 screenshot diffs, list failures | 3,280 | 1,302 (−60%) | 711 → 214 (−70%) |
| Deep validation, worst issue per component | 2,871 | 1,542 (−46%) | 301 → 453 (+50%) |

### When not to use it

- **Results that are already small.** `validate_layout` already returns only mismatches, so the code costs more than it saves (+50% without definitions).
- **Turns:** code mode usually needs 3 model turns instead of 2 (`search_tools`, then `execute_code`, then the answer).
- **Startup:** each run adds about 20–35 ms to start Deno. The first run downloads Deno, which needs `npm` on the `PATH` and can be slow enough to hit a client timeout once.

Use `--codemode` for bulk work (hundreds of elements, many screenshots). Keep regular mode for everyday validation.

### Upgrade notes

- Nothing to do. `npx -y figma-design-validator` picks up 0.5.0, and behavior is unchanged without the flag.
- To try code mode, add `"--codemode"` to `args` and restart your client.

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
