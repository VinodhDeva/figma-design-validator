# Code mode

Code mode is optional. Instead of calling tools one by one, the model writes a short TypeScript program that calls them inside a sandbox. Only what the program prints or returns goes back into the model's context.

Turn it on with the `--codemode` flag. Without the flag the server behaves exactly as before.

Code mode **adopts** the regular server; it doesn't reimplement it. With `--codemode`, the package starts its own regular server as a separate stdio process, connects to it as an MCP client, reads its live `listTools()`, and forwards every call with `callTool`.

## When to use it

Use it when results are bulky and the model needs only a slice of them: hundreds of `inspect_ui` rows, or many screenshot diffs. For the everyday `validate_layout` check, the regular mode is as good or better. See [Benchmark](#benchmark).

## Enable it

Add `--codemode` to the server's `args`. Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "ui-validation": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "figma-design-validator", "--codemode"],
      "env": { "FIGMA_TOKEN": "${FIGMA_TOKEN}" }
    }
  }
}
```

KIRO (`.kiro/settings/mcp.json`) takes the same `command` and `args`.

**Deno.** The sandbox runs on Deno, which isn't a package dependency, so regular users don't download it. On the first code-mode run, the pinned `deno` npm package (about 80 MB) is installed into `~/.cache/figma-design-validator/deno-<version>`, and later runs reuse it. This needs `npm` on the `PATH`. To use a Deno binary you already have, set `CODEMODE_DENO=/path/to/deno`.

To warm the cache before a client starts the server:

```bash
npx -y figma-design-validator --codemode --help
```

That command only warms the package cache. Deno itself is installed on the first `execute_code` call.

**Other servers.** To adopt a different MCP server, put its command after `--`:

```bash
npx -y figma-design-validator --codemode -- npx -y some-other-mcp-server
```

## Tools it exposes

| Tool | Purpose |
|---|---|
| `search_tools(query?, detail?, limit?)` | Find functions on demand. `detail`: `name`, `signature` (one line each, default) or `full` (typed wrapper with docs) |
| `execute_code(code)` | Run TypeScript in the sandbox. Call tools as `await tools.<name>(input)`; results arrive as parsed JSON |
| Side-effect tools, unchanged | For figma-design-validator: `generate_report` and `draft_config`. Exposed directly so your client's own permission prompt applies |

Example of model-written code:

```ts
const selectors = Object.fromEntries(
  Array.from({ length: 1000 }, (_, i) => ["item" + i, "li:nth-child(" + (i + 1) + ")"]),
);
const r = await tools.inspectUi({ url: "http://localhost:5173/list", selectors, properties: ["height"] });
const rows = r.pages[0].components;
return { rows: rows.length, wrong: rows.filter((c) => c.props.height !== 40).map((c) => c.name) };
```

The tool returns about 70 KB. The model sees:

```
=> {"rows":1000,"wrong":["item0","item97","item194","item291","item388","item485","item582","item679","item776","item873","item970"]}
```

## Security model

Model-written code is untrusted.

**Sandbox.** Each `execute_code` call runs in a fresh Deno subprocess:

- No `--allow-*` flags, plus `--no-prompt`, `--no-remote` and `--no-npm`. Network, file reads and writes, environment, subprocesses, FFI, and remote or npm imports all fail with `NotCapable` or a loader error.
- The process starts with an empty environment, so secrets such as `FIGMA_TOKEN` never reach it.
- Its only capability is sending tool calls to the host over stdio.

**Bridge.** Every call from code is checked on the host before it reaches the server:

1. The tool exists and passes `allowTools` / `denyTools`.
2. The input matches the tool's JSON Schema (ajv).
3. Every URL argument, and any `http(s)://` string, points at an allowed host. The default is `localhost`, `127.0.0.1` and `[::1]`.
4. Path arguments (`configPath`, `output`, `reference`, `actual`, `diffOutput`, `designSpecPath`) stay inside the working directory.
5. Side-effect tools are confirmed (see below).

Code that forges bridge messages gains nothing, because every check runs on the host. Each call is logged to stderr.

**Side-effect tools.** A tool counts as side-effecting unless it is annotated `readOnlyHint: true` and not `destructiveHint: true`; `sideEffectTools` overrides this. From code:

- If the client supports MCP elicitation, the user is asked to approve each call.
- Otherwise the call is denied, and the model is told to call the tool directly.

**Limits.** Each run has a timeout, a V8 heap limit, an output cap with a `…[truncated N bytes]` marker, and a maximum number of tool calls.

**Errors.** Stack traces point at the model's code (`code.ts:line:col`), with sandbox and host frames removed.

figma-design-validator's `validate_layout` and `compare_screenshots` are annotated read-only, but they write report and diff files under the output directory. Code mode treats them as read-only, as annotated. To gate them as well, list them in `sideEffectTools`.

## Configuration

Pass a JSON file with `--codemode --config codemode.json`. All keys are optional:

```json
{
  "limits": { "timeoutMs": 30000, "memoryMb": 128, "maxOutputBytes": 8192, "maxCalls": 50 },
  "allowTools": ["inspect_ui", "validate_layout"],
  "denyTools": [],
  "sideEffectTools": ["generate_report", "draft_config"],
  "allowedHosts": ["localhost", "127.0.0.1", "[::1]"],
  "urlArgs": ["url", "baseUrl"],
  "pathArgs": ["configPath", "output", "reference", "actual", "diffOutput", "designSpecPath"]
}
```

## Typed wrappers

[`servers/figma-design-validator/`](../servers/figma-design-validator) in the repository holds one generated wrapper per tool, with types from its JSON Schema and docs from its description. Each wrapper only forwards to `callTool`. `search_tools` serves the same text, generated from the live server at startup.

Regenerate the wrappers after a tool changes:

```bash
npm run codemode:generate
```

CI fails if the committed wrappers are stale:

```bash
npm run codemode:check
```

For another server:

```bash
npx figma-design-validator --codemode generate --out servers -- <command> <args...>
```

## Benchmark

`npm run bench:codemode` runs three workflows against the real validator, once with direct tool calls and once in code mode. There is no LLM in the loop: each workflow is a fixed plan, and the benchmark measures what that plan puts into context (characters ÷ 4), how many model turns it needs, and how long the tools take. Latest results: [bench/codemode-results.md](../bench/codemode-results.md).

| Workflow | Tokens direct | Tokens code mode | Excl. definitions: direct | Excl. definitions: code mode | Turns direct | Turns code mode | Tool ms direct | Tool ms code mode |
|---|---|---|---|---|---|---|---|---|
| W1 Deep validation, worst issue per component | 2,871 | 1,542 (−46%) | 301 | 453 (+50%) | 2 | 3 (2 if API known) | 1439 | 1470 |
| W2 1000 list rows, find wrong heights | 20,278 | 1,395 (−93%) | 17,708 | 306 (−98%) | 2 | 3 (2 if API known) | 651 | 668 |
| W3 Screenshot 4 components × 2 viewports, list diffs | 3,280 | 1,302 (−60%) | 711 | 214 (−70%) | 2 | 3 (2 if API known) | 748 | 772 |

How to read it:

- **Definitions** (2,570 tokens direct, 1,089 code mode) explain most of the W1 and W3 savings. They are a fixed cost per conversation, which clients usually cache.
- **Bulky results** are where code mode clearly wins. W2 drops from about 17.7K tokens to about 300.
- **Already-compact results** are where it loses. `validate_layout` returns mismatches only, so the code costs more than it saves (W1, +50% excluding definitions).
- **Turns:** code mode needs one extra turn when the model must discover the API with `search_tools`.
- **Overhead:** about 20–35 ms per run to start Deno.

Recommendation: keep code mode opt-in, for bulk-inspection workflows. Keep regular mode as the default.

## Limits

- The sandbox runs code with type checking off; type errors surface only as runtime errors.
- Elicitation support varies by client. Without it, side-effect tools can't be called from code.
- URL and path checks rely on argument names (`urlArgs`, `pathArgs`) and on strings that look like URLs. For another server, set these to match its schema.
- A tool that reads URLs from a config file (such as `baseUrl` via `configPath`) is not URL-checked; the config file is trusted as your own.
