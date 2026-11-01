# Architecture

## Goals

- **Deterministic.** The same inputs always give the same findings. All comparisons are plain TypeScript; the server makes no LLM calls.
- **Low token cost.** Responses hold mismatches only. DOM trees, CSS files and images never go to the model.
- **Portable.** Standard MCP over STDIO. No client-specific APIs, so Claude Code, KIRO CLI and KIRO IDE use the same build.
- **Read-only toward the app.** The server never edits application source. It writes only to its cache and report folders.

## Data flow

```
                    ┌──────────────────────┐
 AI client ── MCP ──▶  server.ts (5 tools) │
 (STDIO)            └──────────┬───────────┘
                               │
                        validate.ts pipeline
          ┌────────────────────┼─────────────────────┐
          ▼                    ▼                     ▼
  design/figma.ts      browser/inspector.ts    compare/*.ts
  expected props       actual props            rules + pixel diff
  (Figma ▸ spec file   (Playwright, axe-core)        │
   ▸ inline expected)          │                     ▼
          │                    │              report/report.ts
          └──── cache.ts ──────┘              JSON + Markdown
```

For each viewport, `runValidation` in `src/validate.ts` does the following:

1. Applies the viewport's `responsive` overrides to each component.
2. Resolves expected props through `FigmaAdapter.inspect`.
3. Groups components by URL, so each page loads once per viewport.
4. Reads box and computed style for the requested selectors only.
5. Compares props with `compareProps`. Quick mode uses `quickProperties` only.
6. In deep mode, runs axe-core and screenshot diffs.
7. Returns the summary and findings.

## Modules

| File | Role | Depends on |
|---|---|---|
| `src/index.ts` | STDIO entry and shutdown (closes the browser) | server |
| `src/server.ts` | Tool registration, zod input schemas, error wrapping | all engines |
| `src/config.ts` | Config schema, defaults, `forViewport`, component/viewport selection | zod |
| `src/validate.ts` | Pipeline used by `validate_layout` and `generate_report` | engines |
| `src/cache.ts` | `FileCache` (disk, TTL) and `MemoryCache` (in-process, TTL) | node:fs |
| `src/design/figma.ts` | Figma REST calls, node-to-props extraction, fallbacks, image export | cache |
| `src/browser/inspector.ts` | Shared headless Chromium, `inspectUI`, `runAxe`, `captureScreenshot` | playwright, axe-core |
| `src/compare/layout.ts` | Property rules | color |
| `src/compare/color.ts` | Color parse, hex normalize, channel distance | — |
| `src/compare/screenshot.ts` | pixelmatch diff, diff bounding box | pixelmatch, pngjs |
| `src/report/report.ts` | Sorting, JSON and Markdown output, file writing | — |

The engines do not import each other, except comparison importing color. Each one can be used on its own.

## Normalized property model

Both sides map to the same `StyleProps` shape (`src/types.ts`). Numbers are CSS px. Colors are lowercase `#rrggbb` or `#rrggbbaa`.

| Prop | From Figma | From the browser |
|---|---|---|
| `width`, `height` | `absoluteBoundingBox` | `getBoundingClientRect()` |
| `x`, `y` | box minus `frameNodeId` box | rect plus scroll offset |
| `padding*` | `padding*` | computed padding |
| `gap` | `itemSpacing` | `row-gap`/`column-gap` along the flex axis; `row-gap` for grid |
| `borderRadius` | `cornerRadius` / `rectangleCornerRadii[0]` | `border-top-left-radius` |
| `borderWidth`, `borderColor` | `strokeWeight`, first solid stroke | top border |
| `backgroundColor` | first visible solid fill (non-text node) | `background-color` |
| `color` and typography | first visible TEXT descendant: fills, `style.*` | computed `color`, `font-*`, `line-height`, `letter-spacing`, `text-align` |
| `opacity` | `opacity` | `opacity` |

## Caching

| What | Where | Key | TTL |
|---|---|---|---|
| Figma `/nodes` responses | `cacheDir/*.json` | file key + sorted node ids | `figma.cacheTtlHours` (24 h) |
| Figma PNG exports | `cacheDir/*.png` | file key + node id + scale | same |
| Browser inspection results | process memory | URL + viewport + selectors + a11y flag | 30 s |

Pass `refresh: true` to any tool to skip the caches.

## Design decisions

- **No AI dependency.** Ambiguous visual issues are left to the client's model. The server hands it a diff ratio, a bounding box, and a diff PNG on disk.
- **Mismatches only.** Passing checks are just counted. This keeps responses small. In tests, a 58-check run returned 159 characters.
- **One browser per process.** Chromium launches on first use. Each inspection gets a fresh context with `deviceScaleFactor: 1`, so pixel sizes are stable.
- **Deterministic captures.** Animations, transitions and the text caret are disabled before screenshots.
- **Graceful degradation.** A missing Figma token, a network failure or a missing node becomes a `warnings` entry, and the next design source is used.
- **Nested a11y deduplication.** axe runs on the innermost component first. A failing node is reported once, on the most specific component.
