# FFI Fast Path Benchmarks

## Purpose

This suite measures OpenTUI FFI wrapper overhead in Bun and Node without changing native behavior. It exists because an optimization can help one runtime and regress the other.

## Constraints

- The suite measures Bun and Node together. An optimization for one runtime must not materially regress the other.
- Public result objects stay fresh, and returned byte ranges stay independently owned.
- Experimental native signature or layout changes are not retained.

## Rejected Alternatives

- Packed/descriptor ABI rewrites that regressed a runtime, regressed another workload, or did not produce reliable reports.
- One-pointer seven-argument specialization because it was slower.
- Shared transfer-based trimming because it regressed Bun.

## Method

Scenarios use production wrappers and live native objects. Setup, calibration, verification, and teardown are outside the retained sample. Output probes reject incorrect work.

The retired RendererHandle split-transition and split-snapshot calls are no longer benchmark scenarios.
The remaining scenarios cover standalone buffers, text, editors, images, audio, and span decoding.
Use the render workload preflights and packed-distribution fixtures for retained Context/Session frame and split-output checks.
Historical comparisons must select matching retained scenarios from recorded reports or frozen revisions.

`ffi-fast-path-paired-benchmark.ts` is the preferred comparison. It balances revision order, runs retained batches sequentially, records provenance and diagnostics, and reports paired nominal and multiplicity-adjusted bootstrap intervals. Negative deltas are faster. Safety requires at least 10 pairs and an adjusted upper bound at or below a 3% regression.

Calibration failures retry a complete pair. The report includes all retained timing and pair-gap drift without censoring. Lifecycle failures abort the run.

`ffi-fast-path-benchmark.ts` creates independent reports, `ffi-fast-path-compare.ts` applies the stricter ABI-admission gate to them, and `ffi-fast-path-stress.ts` diagnoses x64 Node process lifecycle failures. The repository intentionally stores no results for this suite. Regenerate them for the revisions and environment that you evaluate.

## Run

From `packages/core`, set `NODE26_PATH` to Node 26.4 or later:

```sh
export NODE26_PATH=/absolute/path/to/node
bun run bench:ffi-fast-path --list-targeted-scenarios
# Run in the prepared baseline worktree.
bun run bench:ffi-fast-path --suite=default --runs=9 --json=/tmp/base.json
# Run in the candidate worktree.
bun run bench:ffi-fast-path --suite=default --runs=9 --json=/tmp/candidate.json
bun run bench:ffi-fast-path-paired --baseline-root=/absolute/base --candidate-root=/absolute/candidate --runs=40
bun run bench:ffi-fast-path-compare /tmp/base.json /tmp/candidate.json
```

Default runs omit the separately listed reusable-storage scenarios. Pass their comma-separated names with `--scenario=<names>` to either runner.

Run paired comparisons from the candidate worktree. Roots must be absolute and use matching scenario/calibration sources. Their native libraries must match unless you pass `--allow-native-drift`. Pair counts must be even. Worktrees must be clean unless you pass `--allow-dirty`.

If the baseline predates this suite, copy `ffi-fast-path-scenarios.ts` and `ffi-fast-path-calibration.ts` from the candidate into the same baseline paths, then pass `--allow-dirty`. The report records the copied files.
