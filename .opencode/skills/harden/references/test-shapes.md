# Test shapes that replaced example tests

The first pass removed thousands of test lines while covering hundreds of previously untested
branches. Four shapes did almost all of that work. Prefer them over a new `test("...")` with one
hand-written sequence.

## 1. Seeded model test (any stateful structure)

Drive the real structure and a tiny reference model with the same random operation sequence from a
fixed seed; compare observable state after every step. Print the seed and step on failure. Bound the
operation count. The model must be independent of the implementation (a map and an array, not a
copy of the code), and must call the API with stale and invalid inputs too (a model that only
replays valid IDs missed a generation bug; U02 review R1).

Repo examples: handle table, grapheme/link pools, `MemRegistry` (`packages/native/src/tests/`,
U02); buffer leases (U03); edit buffer with a string-and-cursor model (U05/U21); scene tree against a
parent/child/order model (U08); span feed FIFO (U11); `SceneStaging` against a Yoga write model
(`packages/core/src/tests/`, U13: 19 of 21 injected bugs caught).

## 2. Differential test (fast path vs reference path)

Whenever there is a cache, batch, reuse pool, incremental update, or recording, assert
`optimized(ops) == fresh(ops)` on random inputs.

Repo examples: text edited then rewrapped vs the same text loaded fresh (U04: 8,574 mismatches
before the fix, 0 after); reused prepared frame vs fresh frame (U08/U09); every paint-hook
recording command vs the direct draw (U14, 12 commands in one table); checked vs unchecked draw
paths (U03).

## 3. Reflection sweep (a whole API surface at once)

Enumerate the surface from the code, not a hand list, so new members are covered automatically.
Keep an explicit exclusion list with a reason per entry.

Repo example: `renderable-nullish-props.test.ts` walks all `Renderable` classes and every public
setter: `valid -> null -> undefined -> valid`, with a focused frame, and after `destroy()`. 23
classes, ~1,660 setters, one test file (U25a). Candidates: every text-accepting API against the
text-unit corpus; every `ot_*` function against `NULL`, a stale handle, the wrong kind, and a busy
Context (the ABI tables in U06/U10).

## 4. Table test (one shape, many rows)

When an example test repeats the same calls with different literals, make the literals rows. Keep
the rows that pin a specific past bug and say so in the row. Work-count assertions belong here:
"adding one highlight visits at most `log2(lines) + 1` markers", not "takes under 5 ms".

Repo examples: the control-state table in `renderer.control.test.ts` (U17; review added two rows
that the conversion had lost, so check the old assertions one by one); checked-draw inputs ×
positions × clip in `buffer_test.zig` (U03); ABI argument tables (U10).

## Harness invariants (zero lines per test)

Put the checks every test should make into the fixture, so existing tests become lifecycle and
leak tests for free:

- Native: `createTestContext` uses `std.testing.allocator`; a leaked allocation fails the test
  (U02, `7359c21a2`). Add: zero live handles and zero pool refcounts at `deinit`.
- Core: `createTestRenderer` disposal should run `assertRendererReleased` (no pending timers, no
  stream listeners, Session closed) and fail on unexpected native diagnostics. The helpers exist in
  `packages/core/src/testing/` (U17); wiring them into every disposal is the open step.

## What not to write

- A scenario test that exercises one happy path with literals; fold it into a table.
- A wall-clock timing assertion; count work instead.
- A test that mirrors the implementation (`expect(impl(x)).toBe(implAgain(x))`).
- A regression test without first watching it fail on the unfixed code.
