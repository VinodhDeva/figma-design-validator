# Configuration

The server reads one JSON file per app. Each tool takes an optional `configPath`. Without one, the server uses `$UI_VALIDATION_CONFIG`, then `./ui-validation.config.json` relative to the server's working directory. Relative paths inside the file resolve from the file's own folder.

A full example is in [../examples/ui-validation.config.json](../examples/ui-validation.config.json).

## Top-level keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `baseUrl` | URL | required | Running dev server, e.g. `http://localhost:5173` |
| `viewports` | `{name,width,height}[]` | `[desktop 1440×900]` | Quick mode uses the first one only |
| `figma` | object | — | `fileKey` (required), `frameNodeId`, `cacheTtlHours` (24) |
| `designSpecPath` | path | — | Local design JSON, used when Figma is unavailable |
| `tolerances` | object | see below | Per-category allowed difference |
| `screenshot` | object | `{threshold: 0.1, maxDiffRatio: 0.01}` | Pixel diff settings |
| `quickProperties` | prop[] | see below | Properties compared in quick mode |
| `cacheDir` | path | `.ui-validation-cache` | Figma cache |
| `outputDir` | path | `ui-validation-reports` | Reports, captures, diff images |
| `components` | object[] | required, ≥ 1 | What to validate |

Unknown keys inside `components`, `expected` and `responsive` are rejected, so typos like `widht` fail fast.

## Components

| Key | Meaning |
|---|---|
| `name` | Unique label used in tool calls and reports |
| `selector` | CSS selector. The first match is inspected |
| `path` | URL path relative to `baseUrl` (default `/`) |
| `figmaNodeId` | Figma node id, e.g. `12:34` |
| `expected` | Inline expected props. These override every other source |
| `reference` | Reference PNG for screenshot diffs. Without it, the Figma export of `figmaNodeId` is used |
| `ignore` | Props to skip, e.g. `["x", "y"]` |
| `responsive` | `{ "<viewport name>": { figmaNodeId?, expected?, reference? } }` overrides |

## Properties

`width height x y paddingTop paddingRight paddingBottom paddingLeft gap borderRadius borderWidth borderColor color backgroundColor fontFamily fontSize fontWeight lineHeight letterSpacing textAlign opacity`

Default `quickProperties`: `width height paddingTop paddingRight paddingBottom paddingLeft gap color backgroundColor fontSize fontWeight lineHeight borderRadius`.

## Design sources

Expected props are resolved in this order. Inline `expected` is merged last, so it always wins.

1. **Figma REST API.** Used when `figma.fileKey` is set, the component has a `figmaNodeId`, and `FIGMA_TOKEN` (or `FIGMA_ACCESS_TOKEN`) is set. Responses are cached on disk.
2. **`designSpecPath`.** Two formats are accepted:
   - Simple map:
     ```json
     { "components": { "PrimaryButton": { "width": 120, "backgroundColor": "#2563eb", "children": ["Label"] } } }
     ```
   - A saved Figma `GET /v1/files/:key/nodes?ids=...` response (any JSON with a top-level `nodes` key). This lets you export once and validate offline:
     ```bash
     curl -H "X-Figma-Token: $FIGMA_TOKEN" "https://api.figma.com/v1/files/FILE_KEY/nodes?ids=12:34,12:40" -o design-spec.json
     ```
3. **Inline `expected`** in the config.

The response's `designSource` field says which source was used: `figma`, `figma-cache`, `spec-file`, `config` or `none`. If a source fails, the reason appears in `warnings`.

## Tolerances

| Key | Default | Applies to |
|---|---|---|
| `size` | 2 | width, height (px) |
| `position` | 4 | x, y (px) |
| `spacing` | 1 | padding, gap, borderWidth (px) |
| `radius` | 1 | borderRadius (px) |
| `fontSize` | 0 | px |
| `lineHeight` | 1 | px |
| `letterSpacing` | 0.2 | px |
| `fontWeight` | 0 | numeric weight |
| `color` | 4 | max RGB channel delta (0–255; alpha scaled to the same range) |
| `opacity` | 0.02 | 0–1 |

## Rules

| Result | Condition |
|---|---|
| pass | `|diff| ≤ tolerance` |
| WARNING / low | `|diff| ≤ max(2 × tolerance, tolerance + 1)` |
| FAIL / high | relative diff > 20 % (color: channel delta > 64) |
| FAIL / medium | any other mismatch |

Other rules:

- `fontFamily` compares the first family, case-insensitive, without quotes. `textAlign` treats `start` as `left` and `end` as `right`. Both must match exactly; a mismatch is FAIL / medium.
- A prop the design has but the browser lacks is FAIL / medium.
- A missing element is FAIL / high (`property: "element"`).
- axe `critical` and `serious` are FAIL / high, `moderate` is WARNING / medium, `minor` is WARNING / low.
- A screenshot is FAIL when `diffRatio > maxDiffRatio`. Severity is high when the ratio is above 0.1. If the ratio is within the limit but the sizes differ, the result is WARNING.

Overall status: any FAIL → `FAIL`, else any WARNING → `WARNING`, else `PASS`.

## Modes

| | quick (default) | deep |
|---|---|---|
| Viewports | first only | all (or those passed) |
| Properties | `quickProperties` | every prop the design has |
| Screenshot diff | no | yes, when a reference or Figma export exists |
| axe-core | no | yes, scoped to components |

## Environment variables

| Variable | Use |
|---|---|
| `UI_VALIDATION_CONFIG` | Default config path |
| `FIGMA_TOKEN` / `FIGMA_ACCESS_TOKEN` | Figma personal access token (read-only scope is enough) |

Never commit a token. Pass it through your shell or the client's `env` block.
