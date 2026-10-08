# Where defects hide

When you trace a changed function, examine each group.

## Limits and capacities

Test each fixed limit just below, at, and just above the limit. When a capacity is full, the
operation must fail clearly. It must not drop data silently or block later operations.

## Units of text measurement

Bytes, UTF-16 code units, code points, graphemes, and display cells are different numbers.
Arithmetic that mixes two of them is a defect. Test text APIs with ASCII, wide characters,
zero-width combining marks, multi-code-point emoji, tabs, `\r\n`, control characters, and a grapheme
cluster longer than the limit.

## Lifecycle

Examine calls after destroy, close, or suspend, and calls during teardown. A failed native call must
not leave JS state that refers to a destroyed object. Native code must not keep a callback after its
owner stops. A normal shutdown must not report an error.

## Busy and retry states

When a queue is full or output is busy, the caller must get a result that it can retry, not a
permanent failure. A rejected item must not block the items after it. The code must not lose an
event that arrives during a busy state. Compare each behavior with `main`.

## Caller inputs

Give setters and callbacks `null`, `undefined`, `NaN`, `Infinity`, `-0`, negative values, and very
large values. Give text APIs control characters. TypeScript must not keep a value that native code
rejects.

## Cross-layer contracts

The header, the docs, and the code must agree. ABI checks must cover record layouts, not only
function prototypes. A TypeScript shortcut must not skip a native call that native code needs. An
error in one layer must not drop the rest of a batch in another layer.

## Caches and fast paths

Work must be proportional to what the call needs, not to the whole structure. Each dirty flag must
schedule the work that it promises. Assert work counts, not wall-clock time.

## Fixes

A fix can move a failure instead of removing it, change the timing of an API, or remove the only
check of a property. Review each fix as carefully as the code that it fixes.
