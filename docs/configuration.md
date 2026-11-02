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
| `ignore` | Props to skip because the team built them differently on purpose, e.g. `["x", "y"]` |
| `tolerances` | Per-component tolerance overrides, same keys as the top-level `tolerances` |
| `screenshot` | Per-component `{threshold?, maxDiffRatio?}` overrides |
| `responsive` | `{ "<viewport name>": { figmaNodeId?, expected?, reference? } }` overrides |

## Team decisions

Some settings depend on the app, the browser and the team, so the server never infers them:

| Decision | Where | Notes |
|---|---|---|
| Components to check | `components[]` | Start from `draft_config`, then review the selectors |
| Acceptable rendering difference | `screenshot` (global) and `components[].screenshot` | Raising `maxDiffRatio` from 0.01 to 0.03 for one component is a choice about this app, not a bug fix |
| Size and spacing slack | `tolerances` (global) and `components[].tolerances` | Unknown keys are rejected |
| Deliberate differences from Figma | `components[].ignore` | Keep the list short and specific |

Precedence: tool arguments (`compare_screenshots`' `threshold`/`maxDiffRatio`) > component values > global values > defaults.

## Drafting a config

`draft_config` writes a draft for one page per call. It does not touch a live config: the output name must end with `.draft.json`. Running it again for another page appends the new components to the same draft.

1. It lists the page's visible, nameable elements (`data-testid`, `id`, `aria-label`, `role`, headings, controls, landmarks) with the shortest unique CSS selector for each.
2. It collects the Figma frame's FRAME, COMPONENT, INSTANCE and TEXT layers. It does not descend into instances.
3. It scores each pair:
   - identical visible text: 0.75–0.95, depending on whether the layer and the element are both text or both controls;
   - token overlap between the layer name and the element's `data-testid`/`id`/`aria-label` (Jaccard, 0–1). `PrimaryButton`, `primary-btn` and `Primary / Button` all become `primary button`.
4. It assigns pairs one-to-one, highest score first, keeping those at or above `minScore` (0.5).
5. It returns the matches with scores, plus Figma layers it could not match.

Without a Figma frame (no token and no saved `/nodes` response), it drafts components from elements with a `data-testid`, an `aria-label`, or the page's `h1`. You then add `figmaNodeId` or `expected` values.

The draft leaves `tolerances` and `screenshot` empty, so they fall back to the defaults until the team sets them.

## Properties

`width height x y paddingTop paddingRight paddingBottom paddingLeft gap rowGap columnGap borderRadius borderWidth borderColor color backgroundColor fontFamily fontSize fontWeight lineHeight letterSpacing textAlign opacity`

Default `quickProperties`: `width height paddingTop paddingRight paddingBottom paddingLeft gap rowGap columnGap color backgroundColor fontSize fontWeight lineHeight borderRadius`.

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
| `spacing` | 1 | padding, gap, rowGap, columnGap, borderWidth (px) |
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

- `fontFamily` compares the first family, case-insensitive, without quotes. `textAlign` treats `start` as `left` and `end` as `right`. Both must match exactly; a mismatch is FAIL / medium. `textAlign` is not read from flex/grid containers or from Figma frames, only from text elements.
- `gap` is the main-axis spacing of a flex container. For grids, and for the cross axis of wrapped rows, use `rowGap`/`columnGap`.
- `borderWidth`/`borderColor` come from the widest visible side, so bottom-border-only inputs are measured correctly.
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
