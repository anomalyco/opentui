# NativeSpanFeed Benchmarks

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
