# FFI Fast Path Benchmarks

## Purpose

This suite evaluates OpenTUI FFI wrapper overhead across Bun and Node without changing native behavior. It exists because an optimization may help one runtime while regressing the other.

## Constraints

- Bun and Node are evaluated together; optimizing one must not materially regress the other.
- Public result objects stay fresh, and returned byte ranges stay independently owned.
- Experimental native signature or layout changes are not retained.

## Rejected Alternatives

- Packed/descriptor ABI rewrites that regressed a runtime, regressed another workload, or did not produce reliable reports.
- One-pointer seven-argument specialization because it was slower.
- Shared transfer-based trimming because it regressed Bun.

## Method

Scenarios use production wrappers and live native objects. Setup, calibration, verification, and teardown are outside the retained sample. Output probes reject incorrect work.

`ffi-fast-path-paired-benchmark.ts` is the preferred comparison: it balances revision order, runs retained batches sequentially, records provenance and diagnostics, and reports paired nominal and multiplicity-adjusted bootstrap intervals. Negative deltas are faster; safety requires the adjusted upper bound to stay at or below a 3% regression.

Calibration failures retry a complete pair. Retained timing and pair-gap drift are reported without censoring; lifecycle failures abort the run.

`ffi-fast-path-benchmark.ts` creates independent reports, `ffi-fast-path-compare.ts` applies the stricter ABI-admission gate to them, and `ffi-fast-path-stress.ts` diagnoses x64 Node process lifecycle failures. Results are intentionally not stored here; regenerate them for the revisions and environment being evaluated.

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

Run paired comparisons from the candidate worktree. Roots must be absolute and use matching scenario/calibration sources and native libraries; pair counts must be even. Worktrees must be clean unless `--allow-dirty` is passed.

If the baseline predates this suite, copy `ffi-fast-path-scenarios.ts` and `ffi-fast-path-calibration.ts` from the candidate into the same baseline paths, then pass `--allow-dirty`. The report records the copied files.
