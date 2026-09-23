# Where the defects were

~110 defects from the first hardening pass, grouped by the kind of place they hid. When tracing a
changed function, check each group explicitly. The examples are real; unit IDs refer to
`hardening/units/`.

## Limits and capacities

Any fixed number is a branch: the cases just below, at, and just above it.

- 128-byte grapheme cluster: a "Zalgo" paste made every frame fail (U21 D4); the same limit broke
  the embedded terminal (U06 D1).
- 128-entry split-footer capture queue: a `console.log` of 129 lines lost all of them (U18, high).
- 255 memory-registry slots: `TextBuffer.append` failed after 254 appends (U04 D4).
- 256 queued spans: the span feed stopped delivering after a handler threw (U24 D4).
- 64 diagnostics: warnings were dropped silently once the queue filled (U02 D2).

## Units of text measurement

Bytes, UTF-16 code units, code points, graphemes, and display cells are five different numbers.
Any arithmetic that mixes two is a defect waiting for a wide character.

- A selection drawn by UTF-16 offsets lands in the wrong column after a CJK character (U15).
- `Input` places its cursor by UTF-16 length (U21 D9); TabSelect truncates by it (U22).
- Cursor up/down lands inside a wide grapheme (U05 D2).
- Test with the corpus: ASCII, 2-cell CJK, 0-cell combining mark, ZWJ emoji, tab, `\r\n`, C0/C1
  controls, a 129-byte cluster.

## Lifecycle: destroy, close, suspend, resume

- Writes to a destroyed renderable threw where `main` ignored them; React's unmount order writes
  after destroy (U19 D2, U25).
- `blur()` called native before updating JS state, so a failed flush left focus on a destroyed node
  (U19 D4).
- A terminated Worker left a dangling log callback; the next native log segfaulted (U12 D1).
- `dispose()` destroyed audio engines before checking whether it would refuse (U12 D2).
- A mode change during a frame plus `suspend()` made the render loop's `finally` throw (U17 D2).
- Normal SSH teardown was reported as an error (U16 D2/D3).

## Busy, pressure, and retry states

- A frame that did not fit the output queue returned `FAILED` instead of `SKIPPED`; the loop stopped
  for good and Kitty file transport was disabled (U11 D1).
- `resize()` threw `OutputBusy` whenever output was queued; `main` never did (U17 D1, U11 R1).
- A staged record native rejected stayed at the queue head and blocked every later flush (U13 D2).
- A resize during a paused paint was lost (U14 D3).

## Inputs the caller can hand you

- `null`/`undefined` to a setter: 38 props in 17 classes threw; frameworks write `null` on prop
  removal (U25 D1, high). Fix was `value ?? default` with the constructor's default.
- `Infinity` from a measure callback froze the UI; `main` kept the previous size (U08 D1).
- `-0` coordinates threw on Node (U15 D3).
- Control characters in `drawText`: `main` skipped them, the branch threw (U15 D1).
- Extmark priority above 255 was stored though native rejected its highlight (U21).

## Cross-layer contracts

- The header said one thing, the code another: scene text control characters, env-value encoding,
  the resize gate (U08 D3, U10 D5, U01).
- The generator checked prototypes but not record layouts; `#pragma pack` passed silently (U01 D1).
- A TS shortcut skipped a native call the native side relied on (`setStyledText([])` kept
  highlights, U20).
- A validator rethrown into the input parser dropped the keystrokes in the same chunk (U10 D4).

## Caches and fast paths

- `getLineSources` copied the whole line table per call after a windowed `main` fix was lost (U20).
- Range highlights walked every line: 435x slower, a lost `main` fix (U04 D1). Assert work counts
  (lines visited, remeasures), not wall time; timing tests flaked and missed this.
- Style setters that only set a dirty flag never requested a frame (U23 D2).

## Rebase and conflict resolution

The large foundation commit dropped three `main` optimizations and about eight regression tests
(#1382, #1442, #1450, #1456, #1462, #1467, #1470). Only long-lived branches rebased over large
conflicts are at risk. For those, list the `main` commits since the branch was started (not since
the merge base: a rebase moves the merge base past the commits whose work may be lost) that touch
files the branch changed, and check that each one's test names still exist in HEAD:

```sh
files=$(git diff --name-only main...HEAD)
git log --oneline --since=<branch start date> main -- $files
git show <commit> -- $files | grep -E '^\+\s*(test "|test\(|it\()'   # then: git grep -F "<name>"
```

A missing name is either a test merged into a table on purpose or lost work; read the commit to
tell which.

## Defects in fixes

Review caught: a crash fix that moved the crash to another thread; a test consolidation that no
longer caught three deliberate breaks; a resize fix that made `resize()` wait for a debounce; a
removed CI step that had been the only `-Werror` compile of the header. Every fix gets the same
treatment as the code it fixes.
