# Tool reference

All tools return a single text content block holding compact JSON. The exception is `generate_report` with `format: "markdown"`. Errors come back as `isError: true` with an `Error: ...` message; they never crash the server.

Every tool accepts `configPath` (see [configuration.md](configuration.md)) and `refresh: true` to skip caches.

## inspect_design

Expected props and a 2-level child hierarchy per component.

| Input | Type | Notes |
|---|---|---|
| `components` | string[] | Default: all |
| `viewport` | string | Applies that viewport's `responsive` overrides |

```json
{"source":"spec-file","viewport":"desktop","components":[{"name":"PrimaryButton","props":{"width":120,"height":40,"backgroundColor":"#2563eb","fontSize":16}}]}
```

## inspect_ui

Box and computed CSS for the requested selectors only.

| Input | Type | Notes |
|---|---|---|
| `components` | string[] | From config |
| `url` + `selectors` | string + `{name: selector}` | Ad hoc mode, no config needed |
| `viewport` | name or `{width,height}` | Default: first config viewport, or 1440×900 |
| `properties` | prop[] | Return only these |
| `accessibility` | boolean | axe-core scoped to the components |

```json
{"viewport":"desktop","pages":[{"url":"http://localhost:5173/","components":[{"name":"PrimaryButton","props":{"width":120,"backgroundColor":"#2563eb"}}]}]}
```

A selector with no match returns `{"name":"X","found":false}`.

## validate_layout

Compares design props with the live page in one call. Returns mismatches only.

| Input | Type | Notes |
|---|---|---|
| `mode` | `quick` \| `deep` | Default `quick` |
| `components`, `viewports` | string[] | Default: all components; quick = first viewport, deep = all |
| `expected` + `actual` (+ `component`) | props | Direct mode: pure comparison, no browser, default tolerances (or the config's when `configPath` is given) |

Config mode never runs screenshot diffs; use `compare_screenshots` or `generate_report` for those. Deep mode adds axe-core.

```json
{"status":"FAIL","summary":{"status":"FAIL","checked":23,"failed":1,"warnings":0},"mode":"quick","designSource":"spec-file","viewports":["desktop"],"findings":[{"component":"PrimaryButton","property":"fontSize","viewport":"desktop","expected":16,"actual":14,"status":"FAIL","severity":"medium"}]}
```

## compare_screenshots

Pixel diff with pixelmatch on the overlapping area. Pixels outside the overlap count as different.

| Input | Type | Notes |
|---|---|---|
| `reference` + `actual` | PNG paths | File mode |
| `component` | string | Live mode: captures the element and diffs it against `reference`, or the Figma export |
| `viewport` | name or `{width,height}` | |
| `threshold` | 0–1 | Per-pixel sensitivity (default 0.1) |
| `maxDiffRatio` | 0–1 | Allowed share of differing pixels (default 0.01) |
| `diffOutput` | path | File mode only. Live mode writes to `outputDir/screenshots/` |

Illustrative values:

```json
{"component":"Card","viewport":"desktop","status":"FAIL","diffPixels":812,"totalPixels":96000,"diffRatio":0.0085,"diffBox":{"x":24,"y":60,"width":120,"height":18},"diffImage":".../Card.desktop.diff.png"}
```

`diffBox` tells the model where to look if a human-style judgment is needed. The image itself stays on disk.

## generate_report

Runs the full pipeline, including screenshots in deep mode. Or it formats `findings` you pass in. It always writes `<name>.json` and `<name>.md` to `outputDir`.

| Input | Type | Notes |
|---|---|---|
| `mode`, `components`, `viewports` | | Same as `validate_layout` |
| `findings` | Finding[] | Format these instead of running |
| `format` | `json` \| `markdown` | Inline response format (default `json`) |
| `name` | string | File base name (default `report`) |

A finding has this shape:

```json
{"component":"Hint","property":"a11y:color-contrast","expected":"no violation","actual":"1 node(s): Elements must meet minimum color contrast ratio thresholds","status":"FAIL","severity":"high","viewport":"desktop"}
```

Sample output: [../examples/reports](../examples/reports).

## Suggested call patterns

| Goal | Calls |
|---|---|
| Fast check after a change | `validate_layout` (quick) |
| Release check | `generate_report` with `mode: "deep"` |
| Debug one component | `inspect_design` + `inspect_ui` with `properties` |
| Visual-only regression | `compare_screenshots` |
