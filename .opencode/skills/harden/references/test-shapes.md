# Test shapes

Use these shapes instead of a new test with one hand-written sequence.

## Seeded model test

For a stateful structure, apply the same random operations from a fixed seed to the real structure
and to a small reference model. Compare the observable state after each step. Limit the number of
operations, and print the seed and step on failure. Write the model independently of the
implementation. Include stale and invalid inputs in the operations.

## Differential test

For a cache, batch, reuse pool, incremental update, or recording, assert that the fast path and a
fresh reference path give the same result on random inputs.

## Reflection sweep

To cover a whole API surface, enumerate it from the code, not from a hand-written list. Then the
test covers new members automatically. Keep an exclusion list with a reason for each entry.

## Table test

If tests repeat the same calls with different literals, make the literals rows. Name the bug that a
row pins. When you convert tests to a table, compare the old assertions one by one, because
conversions lose rows.

## Fixture checks

Put the checks that every test needs into the shared fixture, such as leaks, live handles, pending
timers, and listeners. Then each existing test does these checks.

## Do not write

- A scenario test for one happy path. Make it a table row.
- A wall-clock timing assertion. Count work instead.
- A test that repeats the implementation.
- A regression test that you did not see fail on the unfixed code.
