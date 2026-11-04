# figma-design-validator

[![npm](https://img.shields.io/npm/v/figma-design-validator)](https://www.npmjs.com/package/figma-design-validator)

A small MCP server that checks a running React app against its Figma design. Run it with `npx -y figma-design-validator`; no clone needed. It reports layout, typography, color, screenshot and accessibility mismatches.

All comparisons run in TypeScript with fixed rules. The server never calls an LLM and has no AI API dependency. It returns compact JSON with **mismatches only**, so the AI client spends few tokens. It speaks standard MCP over STDIO, so it works with Claude Code, KIRO CLI, KIRO IDE and any other MCP client.

**New in 0.5.0:** optional [code mode](#code-mode-optional). Add `--codemode` and the model filters large results in a sandbox instead of reading them, using up to 98% fewer tokens on bulk work. Without the flag, nothing changes. See the [changelog](CHANGELOG.md#050--2026-11-04).

The server is **read-only toward your app**. It never edits source code. It writes only to its cache and report folders. Any fix must be proposed to the user and approved before code changes. The server's MCP `instructions` tell the client this.

## Architecture

```
src/
  index.ts              STDIO entry (stdout = protocol, stderr = logs)
  server.ts             6 tool definitions + zod input schemas
  config.ts             JSON config schema, defaults, responsive overrides
  validate.ts           pipeline: design -> browser -> rules (+ screenshots, axe)
  draft.ts              draft_config: write a reviewable draft config
  design/match.ts       Figma layer -> DOM element matching
  cache.ts              file cache (Figma, TTL) + in-memory memo (inspections, 30 s)
  design/figma.ts       Figma REST adapter, node -> props extraction, fallbacks
  browser/inspector.ts  Playwright: computed CSS for requested selectors, axe-core, captures
  compare/layout.ts     deterministic property rules
  compare/color.ts      color parsing / distance
  compare/screenshot.ts pixelmatch diff + diff bounding box
  report/report.ts      JSON + Markdown reports
  report/html.ts        HTML summary report
  codemode/             optional code mode (--codemode): MCP client, Deno sandbox, bridge, wrapper generator
```

Each engine (design, browser, comparison, report) is a separate module and can be used on its own.

## Documentation

- [docs/architecture.md](docs/architecture.md): modules, data flow, property model, caching, design decisions
- [docs/configuration.md](docs/configuration.md): config keys, design sources, tolerances, rules, modes
- [docs/tools.md](docs/tools.md): every tool's inputs and outputs, with examples
- [docs/codemode.md](docs/codemode.md): optional code mode (`--codemode`)
- [CHANGELOG.md](CHANGELOG.md)

## Install

Nothing to clone or build. MCP clients start the server with `npx`, which downloads and caches it. Requires Node ≥ 22.18.

| Source | `args` for `npx` | Status |
|---|---|---|
| npm | `["-y", "figma-design-validator"]` | Recommended. Latest release on [npm](https://www.npmjs.com/package/figma-design-validator) |
| GitHub | `["-y", "github:VinodhDeva/figma-design-validator"]` | Latest `main`, including unreleased changes. The first start compiles TypeScript, so it is slower |

The server runs on your machine, because Playwright must reach your `localhost` app.

**Browser.** On first use the server looks for Playwright's Chromium, then Google Chrome, then Microsoft Edge. If none is found, it installs Playwright's Chromium once (about 150 MB, into Playwright's normal cache) and retries. To install it ahead of time:

```bash
npx playwright install chromium
```

### Local development

```bash
git clone https://github.com/VinodhDeva/figma-design-validator.git
```

```bash
cd figma-design-validator
```

```bash
npm install
```

`npm install` also builds `dist/` through the `prepare` script. Point a client at `node /ABSOLUTE/PATH/TO/figma-design-validator/dist/index.js` to run your local copy.

## Configure

Put `ui-validation.config.json` in your app's root:

```json
{
  "baseUrl": "http://localhost:5173",
  "viewports": [{ "name": "desktop", "width": 1440, "height": 900 }, { "name": "mobile", "width": 375, "height": 812 }],
  "figma": { "fileKey": "YOUR_FILE_KEY" },
  "components": [
    { "name": "PrimaryButton", "path": "/", "selector": "[data-testid=primary-btn]", "figmaNodeId": "12:34" }
  ]
}
```

Expected values are resolved in this order; inline `expected` always wins.

1. Figma REST API, when `FIGMA_TOKEN` is set. Results are cached on disk.
2. A local `designSpecPath` file.
3. Inline `expected` values.

If Figma is down, the token is missing, or no Figma MCP is available, the server does not fail. It falls back to the next source and adds a `warnings` entry.

### Team decisions

Three things only your team can decide. The server makes them easy to set but never guesses them.

1. **Which components to check.** Run `draft_config` to get a first draft. It matches the page's Figma frame to DOM elements by visible text and by layer name vs `data-testid`/`id`/`aria-label`. It writes `ui-validation.config.draft.json` with selectors and node ids, plus a score per match. Review the selectors, especially scores below 0.8, then rename the file to `ui-validation.config.json`.
2. **Screenshot limits.** Set `screenshot.threshold` and `screenshot.maxDiffRatio` globally, and override them per component where fonts, charts or images render differently. Example: `{ "name": "Chart", ..., "screenshot": { "maxDiffRatio": 0.03 } }`.
3. **Tolerances and intentional differences.** Set `tolerances` globally or per component. Use `ignore` for props the team deliberately built differently from Figma.

Precedence: tool arguments > component values > global values > defaults.

Full reference: [docs/configuration.md](docs/configuration.md). Full example: [examples/ui-validation.config.json](examples/ui-validation.config.json).

## Tools

| Tool | Does | Key inputs |
|---|---|---|
| `inspect_design` | Expected props and 2-level child hierarchy per component | `configPath?`, `components?`, `viewport?`, `refresh?` |
| `inspect_ui` | Box and computed CSS for the requested selectors only. Optional axe-core scan | config `components`, **or** ad hoc `url` + `selectors`; `viewport`, `properties?`, `accessibility?` |
| `validate_layout` | Design vs live page in one call. Returns mismatches only. On issues, also writes `report.html` and returns its path | `mode`, `components?`, `viewports?`; **or** direct `expected` + `actual` (no browser) |
| `compare_screenshots` | pixelmatch diff. Returns ratio + diff bounding box. The diff PNG is written to disk, not returned. Transparent references are flattened onto the page background | two PNG paths, **or** config `component` (live capture vs `reference` or Figma export); `threshold`, `maxDiffRatio`, `viewport` |
| `draft_config` | Drafts a config for one page: Figma layers matched to DOM selectors. Writes `*.draft.json` only, never a live config | `baseUrl`, `path?`, `frameNodeId?`, `figmaFileKey?`, `designSpecPath?`, `output?`, `minScore?` |
| `generate_report` | Runs validation (or formats `findings` you pass). Writes `report.html`, `report.json`, `report.md` | `mode`, `format: json\|markdown`, `name?` |

`configPath` defaults to `$UI_VALIDATION_CONFIG`, then `./ui-validation.config.json`.

### Modes

- **quick** (default): first viewport, `quickProperties` only, no screenshots, no axe.
- **deep**: all viewports, every property the design has, screenshot diffs (when a reference exists), and axe-core scoped to the components.

### Rules

Each property is compared against a tolerance:

- Within tolerance: pass.
- Slightly over: WARNING.
- Further over: FAIL, with high severity above 20 % relative difference.

A missing element is FAIL / high. Details: [docs/configuration.md#rules](docs/configuration.md#rules).

## Token use

- Only the requested selectors are read. The server never sends a DOM tree or CSS file.
- Findings list mismatches only. Passing checks appear only as a count.
- Figma responses are cached on disk. Inspections are memoized for 30 s, so repeat calls reuse page loads.
- Screenshots are taken in deep mode or on request only. Images stay on disk; the response holds numbers and a diff box.
- Use `validate_layout` or `generate_report` as one call, rather than chaining `inspect_*` calls.
- For bulk work (hundreds of elements, many screenshots), turn on [code mode](#code-mode-optional) so the model filters results in a sandbox instead of reading them.

## Claude Code setup

Option A, project-scoped `.mcp.json` in your app root (see [examples/clients/claude-code.mcp.json](examples/clients/claude-code.mcp.json)):

```json
{
  "mcpServers": {
    "ui-validation": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "figma-design-validator"],
      "env": { "UI_VALIDATION_CONFIG": "./ui-validation.config.json", "FIGMA_TOKEN": "${FIGMA_TOKEN}" }
    }
  }
}
```

To run the latest unreleased `main` instead, use `"args": ["-y", "github:VinodhDeva/figma-design-validator"]`.

Option B, the CLI:

```bash
claude mcp add ui-validation -s project -e UI_VALIDATION_CONFIG=./ui-validation.config.json -- npx -y figma-design-validator
```

Check it:

```bash
claude mcp get ui-validation
```

For [code mode](#code-mode-optional), use `"args": ["-y", "figma-design-validator", "--codemode"]`.

## KIRO CLI / KIRO IDE setup

Both read the same file: `.kiro/settings/mcp.json` in the workspace, or `~/.kiro/settings/mcp.json` for every project. See [examples/clients/kiro.mcp.json](examples/clients/kiro.mcp.json):

```json
{
  "mcpServers": {
    "ui-validation": {
      "command": "npx",
      "args": ["-y", "figma-design-validator"],
      "env": { "UI_VALIDATION_CONFIG": "./ui-validation.config.json" },
      "disabled": false,
      "autoApprove": ["inspect_design", "inspect_ui", "validate_layout", "compare_screenshots"]
    }
  }
}
```

Set `FIGMA_TOKEN` in the shell that launches KIRO, or add it to `env` with its real value. Do not commit the token.

Or use the CLI:

```bash
kiro-cli mcp add --name ui-validation --scope workspace --command npx --args '["-y", "figma-design-validator"]'
```

In KIRO IDE, open the MCP Servers panel and confirm that `ui-validation` lists 6 tools. In [code mode](#code-mode-optional) (`"args": ["-y", "figma-design-validator", "--codemode"]`) it lists 4: `search_tools`, `execute_code`, `generate_report` and `draft_config`.

The first start downloads the package, so it can take up to a minute. If a client times out on that first start, run `npx -y figma-design-validator --version` once in a terminal to fill the cache, then restart the client.

## Usage prompts

- "Run draft_config for http://localhost:5173 page /checkout with Figma frame 12:1."
- "Run validate_layout quick for PrimaryButton."
- "Run generate_report in deep mode, markdown format."
- "compare_screenshots for Card on the mobile viewport, threshold 0.05."

## Sample reports

Real output from the fixture app is in [examples/reports](examples/reports):

- [sample-quick.json](examples/reports/sample-quick.json)
- [sample-deep.md](examples/reports/sample-deep.md)
- [sample-deep.html](examples/reports/sample-deep.html): open in a browser

Excerpt:

```
| Status | Severity | Component | Viewport | Property | Expected | Actual |
|---|---|---|---|---|---|---|
| FAIL | high | Hint | desktop | a11y:color-contrast | no violation | 1 node(s): Elements must meet minimum color contrast ratio thresholds |
| FAIL | medium | PrimaryButton | desktop | fontSize | 16 | 14 |
```

## Tests

Unit tests cover the color, layout rules, Figma extraction and fallback, screenshot diff, report and config modules:

```bash
npm test
```

Integration tests build the server, spawn `dist/index.js` over real STDIO with the MCP SDK client, and call all 6 tools against a fixture page:

```bash
npm run test:integration
```

## Limits

- Chromium only.
- Colors in `oklch()`/`color()` are not parsed. They are reported as WARNING / low.
- `line-height: normal` is approximated as 1.2 × font-size.
- Figma `x`/`y` are only meaningful with `frameNodeId` set and a frame matching the viewport. Add them to `ignore` otherwise.
- Pages must be reachable without login. Pages that need auth are not supported yet.

## Code mode (optional)

Code mode is new in 0.5.0. Turn it on by adding `--codemode` to the server's args:

```json
"args": ["-y", "figma-design-validator", "--codemode"]
```

Without the flag, the server behaves exactly as in 0.4.0.

### How it works

In regular mode, the model calls each tool, and every full result enters its context. In code mode, the model writes TypeScript that calls the same tools inside a sandbox, and only what the code returns enters its context:

```
regular:    model → inspect_ui(1000 selectors) → ~70 KB result → model context
code mode:  model → execute_code(code) → sandbox → same tool → ~70 KB stays in the sandbox
                                                   code filters it → ~300 bytes → model context
```

Example of model-written code:

```ts
const selectors = Object.fromEntries(
  Array.from({ length: 1000 }, (_, i) => ["item" + i, "li:nth-child(" + (i + 1) + ")"]),
);
const r = await tools.inspectUi({ url: "http://localhost:5173/list", selectors, properties: ["height"] });
const rows = r.pages[0].components;
return { rows: rows.length, wrong: rows.filter((c) => c.props.height !== 40).map((c) => c.name) };
```

Code mode doesn't reimplement anything. It starts the regular server as a separate process and forwards every call to it, so results are identical.

| | Regular mode | Code mode |
|---|---|---|
| Tools the model sees | 6 validator tools | `search_tools`, `execute_code`, plus `generate_report` and `draft_config` passed through |
| Tool definitions in context | about 2,600 tokens | about 1,100 tokens |
| Large results | enter the model's context in full | stay in the sandbox; only the code's return value comes back |
| Extra install | none | Deno, about 80 MB, downloaded once on first use |

### How it reduces tokens

1. **Large results stay out of context.** The code filters the tool output and returns only what matters. This is the main saving.
2. **Smaller tool definitions.** 4 short tools instead of 6 full schemas; the model looks up details with `search_tools` only when needed.
3. **Many calls in one step.** A loop over many tool calls runs inside one `execute_code`, and only the summary comes back.

| Workflow | Regular | Code mode |
|---|---|---|
| 1,000 list rows, find wrong heights | 20,278 tokens | 1,395 (−93%) |
| 8 screenshot diffs, list failures | 3,280 | 1,302 (−60%) |
| Deep validation, worst issue per component | 2,871 | 1,542 (−46%, all from smaller definitions) |

### When to use it

- **Use it** for bulk work: hundreds of `inspect_ui` rows, or many screenshot comparisons.
- **Skip it** for everyday `validate_layout` checks. They already return only mismatches, so code mode adds code tokens and usually one extra model turn.

### Safety

The sandbox is a Deno process with no network, file, environment or process access. Each call from code is checked before it reaches the server:
- input is validated against the tool's schema;
- URLs are allowed only to localhost, and paths only inside the working directory;
- tools with side effects need your approval.

Full details, configuration and the full benchmark: [docs/codemode.md](docs/codemode.md).

## License

MIT. See [LICENSE](LICENSE).
