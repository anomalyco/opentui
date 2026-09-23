# Coverage tools and baseline commands

All tools below use the engine's own coverage data. Nothing rewrites source. Each prints one
`UNCOVERED file:line:col` line per branch arm no test executed, and a `reached/total` summary.

## Native: `packages/native/scripts/branch-cov.ts`

```sh
cd packages/native
bun run test:branch-cov                         # Zig files changed in main...HEAD, full suite
bun scripts/branch-cov.ts --diff <range>        # another range
bun scripts/branch-cov.ts --files src/scene.zig src/buffer.zig
bun scripts/branch-cov.ts --all                 # every file under src/ (not vendor, tests, bench)
bun scripts/branch-cov.ts ... --filter "Scene"  # only tests whose name contains "Scene" (faster)
bun scripts/branch-cov.ts ... --json out.json   # per-arm table
```

How it works: `zig build test-cov` compiles `src/test.zig` with `fuzz = true`, so LLVM emits one
8-bit counter per basic block (`__sancov_cntrs`): every branch arm, error return, and switch case
has its own counter. `src/cov_runner.zig` is the test runner; it runs the tests and dumps the
counters. The script finds each counter's instruction with `objdump`, symbolizes it with
`llvm-symbolizer`, and reports the zero-hit ones. About 15 s for a filtered run, about 60 s for the
full suite. Needs `objdump` and `llvm-symbolizer` on `PATH`.

Limits: generic instantiations merge into one site; vendored C/C++ is instrumented but filtered out
of the report; a function nothing references is not compiled, so it does not appear at all (check
with `grep` that the function is still called).

Only the `fuzz = true` test module runs the alternate runner; `zig build test` is unchanged.

## Core TypeScript: `packages/core/scripts/branch-cov.ts`

```sh
cd packages/core
bun run test:branch-cov                         # TS files changed in main...HEAD, whole core suite (~1 min)
bun scripts/branch-cov.ts --files src/renderer.ts --tests src/tests/renderer.*.test.ts
bun scripts/branch-cov.ts ... --json out.json
```

How it works: `scripts/branch-cov-preload.ts` opens a `node:inspector` session and calls
`Profiler.startPreciseCoverage({ detailed: true })`, which JavaScriptCore implements: per function,
byte ranges with execution counts, one range per conditional arm. A preload's `afterAll` runs once
after the last file and writes them out. The offsets are into the JavaScript Bun ran;
`scripts/branch-cov-map.ts` reproduces that text with `Bun.Transpiler` and aligns its tokens with
the TypeScript source (Myers diff), so each arm maps to a TypeScript line. Line accuracy in testing
was 98–100 %; columns are approximate.

Limits: `import` lines are filtered (JSC reports them as zero-count ranges). A file no test imports
prints "not loaded by any test". Node is not wired up yet; V8 has the same protocol, so the preload
would work under `scripts/test-node.ts` with a small change.

## Baseline suites (run once before editing, once after)

| Suite                             | Directory                           | Command                                                             |
| --------------------------------- | ----------------------------------- | ------------------------------------------------------------------- |
| Native                            | `packages/core`                     | `bun run test:native`                                               |
| Native lifetime / ABI             | `packages/core` / `packages/native` | `bun run test:native:lifetime` / `zig build test-abi --summary all` |
| ABI vs header, all targets        | `packages/core`                     | `bun run check:abi --all-targets`                                   |
| Core (Bun / Node)                 | `packages/core`                     | `bun run test` / `bun run test:js:node`                             |
| Core dist                         | `packages/core`                     | `bun run test:dist` (not at the same time as solid tests)           |
| ssh, react, solid, qrcode, keymap | each package                        | `bun run test`                                                      |
| Format / lint                     | root                                | `bun run fmt:check` / `bun run lint`                                |

The build fails if an exported `ot_*` function does not match `opentui.h`; any ABI change needs the
header updated and `bun run generate:abi` in `packages/core`.
