# NativeSpanFeed Benchmarks

## Renderer formatting coverage

The producer benchmarks below copy prebuilt byte patterns through `benchProduce` or
`benchProduceWrite`. Even the ANSI pattern is already encoded. They measure feed
reserve/write/drain behavior, not the renderer's per-cell ANSI formatting, so they
can miss dense-output regressions in the renderer's feed writer.

Use the existing render-traversal scenario `grayscale_changed` for that path. It draws
one full-screen `FrameBufferRenderable` with standard and 2x supersampled grayscale
panels. Two precomputed phases alternate every iteration. Every panel cell changes,
with many different foreground colors per row; fixture generation is outside timing.
This uses the same draw APIs as `grayscale-buffer-demo.ts`, without importing examples.

Run from `packages/core` after building the native library:

```bash
bun run bench:render-traversal --scenario=grayscale_changed --verify-only
bun run bench:render-traversal --scenario=grayscale_changed --suite=quick
bun run bench:render-runtimes --scenario=grayscale_changed --runs=7 --json=grayscale.json
bun run bench:render-compare baseline.json grayscale.json
```

The default surface is 140x44 cells. Traversal runs also accept `--width` and `--height`.
The renderer uses native scenes, no render thread, and host-independent terminal capabilities.
With `bufferedOutput: "memory"`, output goes through the Session feed to a discarding `Writable`.
Preflight checks frame completion, cell planes, geometry, hits, and changed-cell counts for initial,
unchanged, changed, and restored frames. At 140x44 and 41x21, it compares those snapshots with
frozen pre-deletion goldens in `render-traversal-goldens.ts`. Other dimensions run invariant checks
and report `golden: false`. The runtime harness also compares the evidence between Bun and Node
before timing. No second rendering implementation ships with the benchmark.

Completed-frame wall time includes framebuffer clear/draw, scene work, native encoding,
and output handling, but not terminal emulator processing.
`scene` reports scene work; `nativeRender` reports native diff/ANSI-encode time, converted
from microseconds to milliseconds. For before/after comparisons,
keep the benchmark source, dimensions, iteration counts, runtime versions, and native
build mode identical. Compare reports from frozen revisions for historical measurements;
the backend selector and traversal-only microbenchmarks have been removed. Run timing
benchmarks without concurrent builds or test suites.

The five retained scene workloads are `boxes_steady_10000`, `boxes_changed_10000`,
`log_unchanged_10000`, `log_append_10000`, and `log_scroll_10000`. Run all preflights with
`bun run bench:render-traversal --verify-only`. Their 140x44 goldens include full-node geometry,
hit targets, cell planes, and changed-cell counts. Log frames also include resolved UTF-8 bytes,
cell byte lengths, and wide-cell continuation markers. The checks retain append limits, exact
scroll deltas, bottom anchoring, older-reader stability, resize, and cleanup validation.

The goldens were captured at `b1618ec4b45e5fa2f999fb605ec408d5d1c04db8` on Linux x64 with
Bun 1.3.14, after the legacy/native preflight agreed on every frame. The loaded library SHA-256
was `5260c407e269c26716a3164cd704d19b1b474164f1e800384b504ff9d1ee1bbb`.
Changing a golden requires separate evidence of the intended rendering change, not a fresh
capture accepted only because the current implementation produced it.

`bench:layout` retains the full-render mutation workloads and validates changed geometry or text line info.
It now settles requested frames with `TestRenderer.flush()` instead of reading Yoga dirty flags or collecting
JavaScript render commands. Its `settle-frames` results are not the old layout-only measurements.
The synchronous JS `leaf-width-calculate` case uses standalone Yoga and has workload version 3.
Direct box and text-buffer workloads draw into owned scratch buffers, not inactive renderer frame buffers.

## Benchmark

### Build

The Zig `bench-ffi` step builds `libnative_span_feed_bench` with `ReleaseFast` by default.
Use `-Dbench-optimize=` to select a different mode.

```bash
cd packages/core
bun run bench:native:ffi
```

This installs `packages/native/zig-out/lib/libnative_span_feed_bench.*`, which
`src/benchmark/native-span-feed-benchmark.ts` loads by default.

Run `bun run bench:native` to build the benchmark runner and install the FFI benchmark library.

### Run

```bash
cd packages/core
bun run bench:ts
```

```bash
bun src/benchmark/native-span-feed-benchmark.ts --bytes=100000 --iters=1000 --chunk=65536 --initial=2
```

### Options

The default configuration enables batch-drain, reserve-path, and chunk-release flags.
You do not need other flags.

- `--bytes=<n>` number of bytes that Zig produces each iteration (default: 100000)
- `--iters=<n>` base iteration count. Suite scenarios scale this value and use optimized defaults
- `--suite=<quick|default|large|all>` run a scenario suite
- `--chunk=<n>` chunk size in bytes
- `--initial=<n>` initial chunk count
- `--auto=<0|1>` enable auto-commit on full chunks (default: 1)
- `--commit=<n>` commit every N bytes (0 disables)
- `--pattern=<str>` override the default ANSI pattern (single-run)
- `--pattern-type=<ansi|ascii|binary|random>` choose pattern kind (single-run)
- `--pattern-size=<n>` pattern size in bytes (single-run)
- `--stdout` write received bytes to stdout
- `--reuse` reuse a single stream across iterations (may grow memory)
- `--mem` enable memory tracking
- `--mem-sample=<n>` sample memory every N iterations (default: 1)
- `--json[=<path>]` write results to JSON. If you set `--suite`, the default path is `latest-<suite>-bench-run.json`. Otherwise, it is `latest-bench-run.json`
