# Benchmark results

Node v26.5.0, 2026-11-04. Method: see bench/bench.ts header.

Tool definitions: direct 2,570 tokens (6 tools), code mode 1,089 tokens (search_tools, execute_code + 2 pass-through). Counted once per workflow.

| Workflow | Tokens direct | Tokens code mode | Excl. definitions: direct | Excl. definitions: code mode | Turns direct | Turns code mode | Tool ms direct | Tool ms code mode |
|---|---|---|---|---|---|---|---|---|
| W1 Deep validation, worst issue per component | 2,871 | 1,542 (−46%) | 301 | 453 (+50%) | 2 | 3 (2 if API known) | 1439 | 1470 |
| W2 1000 list rows, find wrong heights | 20,278 | 1,395 (−93%) | 17,708 | 306 (−98%) | 2 | 3 (2 if API known) | 651 | 668 |
| W3 Screenshot 4 components x 2 viewports, list diffs | 3,280 | 1,302 (−60%) | 711 | 214 (−70%) | 2 | 3 (2 if API known) | 748 | 772 |
