# Coverage tools and baseline commands

## Native: `packages/native/scripts/branch-cov.ts`

```sh
cd packages/native
bun run test:branch-cov                       # Zig files changed in main...HEAD, full suite
bun scripts/branch-cov.ts --diff <range>      # files changed in another range
bun scripts/branch-cov.ts --files <file>...   # explicit files
bun scripts/branch-cov.ts --all               # every file under src/ except vendor, tests, bench
bun scripts/branch-cov.ts ... --filter <name> # only tests whose name contains <name>
bun scripts/branch-cov.ts ... --json <path>   # also write the per-arm table
```

`zig build test-cov` builds the tests with `fuzz = true`, so LLVM gives each basic block a counter.
`src/cov_runner.zig` runs the tests and writes the counters. The script maps each counter to a
source location with `objdump` and `llvm-symbolizer`, which must be on `PATH`. A filtered run takes
about 15 s, and the full suite takes about 60 s.

Limits:

- All instantiations of a generic function share one site.
- The report excludes vendored C/C++.
- Zig does not compile unreferenced functions, so the report does not show them. Use `grep` to make
  sure that a function still has callers.

## Core TypeScript: `packages/core/scripts/branch-cov.ts`

```sh
cd packages/core
bun run test:branch-cov                       # TS files changed in main...HEAD, whole suite (~1 min)
bun scripts/branch-cov.ts --diff <range>      # files changed in another range
bun scripts/branch-cov.ts --files <file>... --tests <test file>...
bun scripts/branch-cov.ts ... --json <path>   # also write the per-arm table
```

`scripts/branch-cov-preload.ts` collects JavaScriptCore block coverage through `node:inspector`.
`scripts/branch-cov-map.ts` maps the ranges in the transpiled JavaScript back to TypeScript lines.
Line numbers are 98 to 100 % accurate. Columns are approximate.

Limits:

- The report excludes `import` lines.
- For a file that no test imports, the tool prints "not loaded by any test".
- The tool runs under Bun only, not Node.

## Baseline suites

Run each suite before and after you edit.

| Suite                             | Directory                           | Command                                                             |
| --------------------------------- | ----------------------------------- | ------------------------------------------------------------------- |
| Native                            | `packages/core`                     | `bun run test:native`                                               |
| Native lifetime / ABI             | `packages/core` / `packages/native` | `bun run test:native:lifetime` / `zig build test-abi --summary all` |
| ABI against header, all targets   | `packages/core`                     | `bun run check:abi --all-targets`                                   |
| Core (Bun / Node)                 | `packages/core`                     | `bun run test` / `bun run test:js:node`                             |
| Core dist                         | `packages/core`                     | `bun run test:dist` (not in parallel with the solid tests)          |
| ssh, react, solid, qrcode, keymap | each package                        | `bun run test`                                                      |
| Format / lint                     | root                                | `bun run fmt:check` / `bun run lint`                                |

The build fails if an exported `ot_*` function does not match `opentui.h`. For each ABI change,
update the header and run `bun run generate:abi` in `packages/core`.
