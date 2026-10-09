# Native Input Parser

Design reference for moving terminal input parsing from `packages/core/src/lib/stdin-parser.ts`
(plus `parse.keypress.ts`, `parse.keypress-kitty.ts`, `parse.mouse.ts`) into
`packages/native/src/input-parser.zig`, owned by `Session`, exposed through the `ot_session_input_*`
C ABI, and consumed by a thin TypeScript adapter.

This document is self-contained. It records the background, the grammar, the state machine, the
decode tables, the event model, the Zig and C layouts, the TypeScript mapping, the bounds, the test
plan, and the migration order. Read it before changing any of those files; update it when a decision
changes.

Branch: `ot-native-input-parser`. Worktree: `/home/simon/src/wt/ot-native-input-parser`.

Status: phases 1 to 3 of §14.1 are implemented. The native parser runs behind
`experimental_nativeInput` / `OTUI_NATIVE_INPUT_PARSER`; the legacy parser is still the default.

---

## 1. Scope

In scope:

- Byte framing of the terminal-to-application stream (`stdin`): ESC disambiguation by time, CSI,
  SS3, OSC, DCS, APC, X10 and SGR mouse reports, bracketed paste, UTF-8, eight-bit Alt bytes.
- Decoding framed units into typed events: key, mouse, paste, focus, reply.
- A bounded, allocation-free Zig state machine with an explicit monotonic clock.
- A Session-owned instance and a C ABI that writes events into caller-owned records.
- A TypeScript adapter that produces today's `StdinEvent` / `ParsedKey` / `RawMouseEvent` shapes.

Out of scope (unchanged):

- Reading `stdin`. The host still reads bytes and feeds them. Native has no event loop.
- Routing replies to `Terminal` capability detection. Replies still cross to the host as events and
  the host still calls `ot_session_control(OT_CONTROL_CAPABILITY_RESPONSE)`. See §11.6 for the
  later option of native routing.
- Key binding policy (`keybinding.internal.ts`), `KeyHandler` dispatch, renderer mouse capture.
- The embedded terminal (`embedded-terminal/`), which encodes in the other direction.

---

## 2. Background

### 2.1 The application side is not a terminal emulator

The references collected after the first implementation (`opendocs/stdin-refactor/references.md`)
describe the terminal side: Paul Flo Williams' DEC ANSI parser, ECMA-48, xterm's `ctlseqs`. They
define the grammar we reuse, but OpenTUI sits on the other end of the pipe. Five assumptions invert:

|                          | Terminal emulator (app → terminal)                                       | TUI client (terminal → app)                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Meaning of `ESC`         | Only a sequence introducer. A lone `ESC` waits forever.                  | Five things: the Escape key; `Alt+<char>`; `Alt+Escape` (`ESC ESC`); `Alt+<CSI/SS3 key>` (`ESC ESC [ A`); a sequence introducer. **Time is an input to the grammar.**                |
| C0 or `ESC` inside a CSI | C0 executes in place without leaving CSI. A new `ESC` silently restarts. | The unit was cut short or interleaved. Flush the fragment as an opaque reply, never as typed text, then process the new byte normally.                                               |
| CSI framing exceptions   | Every `0x40..0x7E` ends a CSI. `$` is an intermediate.                   | `ESC [ M` is followed by three raw bytes (X10 mouse). `ESC [ [ A` is the Linux console (second `[` is not final). `ESC [ 2 $` is rxvt Shift+Insert (`$` is final after digits only). |
| Bracketed paste          | A normal CSI, if seen at all.                                            | `ESC [ 200 ~` switches the lexical mode of the stream until the exact six bytes `ESC [ 201 ~`. Everything between is literal, including `ESC`.                                       |
| Unknown sequence         | Ignore (`csi_ignore`) or print replacement characters.                   | Must become a reply event. Capability replies, focus reports, and split mouse traffic must never type into a focused editor.                                                         |

Everything in this design follows from those five rows.

### 2.2 What went wrong in the TypeScript parser

`stdin-parser.ts` is 2,074 lines with 18 state tags; `parse.keypress*.ts` and `parse.mouse.ts`
add 1,180 lines and re-parse framed units with regular expressions after decoding bytes to
strings. The hardening pass (`opendocs/native-hardening/issues/044..050`) found these defects,
all structural:

| Issue | Symptom                                                                                                     | Cause                                                                                                                                                            |
| ----- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 044   | Escape then a mouse report, reply, paste, `Alt+a`, or a third Escape in one 20 ms window loses both events. | The `esc` state keeps a second `ESC` in the same unit; every later check assumes one leading `ESC` (`cursor === unitStart + 2`, `bytesEqual(raw, "\x1b[200~")`). |
| 046   | `Alt+.`, `Alt+/`, `Alt+<` give an empty key name.                                                           | `metaKeyCodeRe = /^\x1b([a-zA-Z0-9])$/`, inherited from enquirer.                                                                                                |
| 047   | `Alt+é` gives two empty keys; `Alt+ж` fires `Alt+6`.                                                        | The `esc` default branch takes one byte after `ESC`; the UTF-8 continuation bytes then decode as eight-bit Alt keys.                                             |
| 048   | An SGR wheel release (`CSI < 64 ; x ; y m`) becomes a left-button release and ends a drag.                  | `decodeSgrEvent` treats a wheel code as scroll only for `M`.                                                                                                     |
| 049   | X10 coordinate byte `0` (xterm's past-end marker) reports `x = -33`.                                        | `byte - 33` without the wrap.                                                                                                                                    |
| 050   | Dvorak `Ctrl+J` quits the app.                                                                              | Key-binding fallback to the base-layout code on every layout; a binding-layer bug, but the parser must still pass `base_code` through.                           |

And three structural costs without a numbered issue:

- Six `csi_*` states exist only to guess whether an incomplete CSI may wait past the timeout, because
  parameters are not parsed as bytes arrive.
- `pausePendingTimeout`, `resumePendingTimeout`, `hasPendingPixelResolutionResponse`,
  `abortPendingStartupCursorCpr`, and `csi_parametric_ignored` exist to coordinate parser state with
  renderer state across the FFI boundary.
- Every key goes bytes → `string` → regex → `ParsedKey` → `KeyEvent`.

### 2.3 Prior art used here

- `opentui-rust/crates/opentui/src/input/parser.rs` (and `core_tests.rs`): a single-pass port of the
  same grammar in ~600 lines, 12 states, no regexes, with Core's test vectors translated. It fixes
  044 through 049. This design is a Zig port of that machine with the OpenTUI ABI conventions.
- crossterm `src/event/sys/unix/parse.rs`: single-pass bytes → typed events; dispatch on the first
  byte; 1024-byte read buffer.
- libtermkey: the reference for timeout-based disambiguation and partial-sequence handling.
- Williams' state machine: the CSI/OSC/DCS grammar and the "anywhere" rules we deliberately do not
  apply (§2.1 row 2).
- Kitty keyboard protocol: the functional key code table (§7.6) and the `CSI u` grammar.
- xterm ctlseqs: "PC-Style Function Keys" and "Mouse Tracking".

---

## 3. Terminology

| Term         | Meaning                                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ESC`        | 0x1B. `CSI` = `ESC [`. `SS3` = `ESC O`. `OSC` = `ESC ]`. `DCS` = `ESC P`. `APC` = `ESC _`. `ST` = `ESC \`. `BEL` = 0x07.                                   |
| unit         | The bytes of one complete or partial protocol element: one key, one report, one reply.                                                                     |
| reply        | A framed unit that is not a key, mouse, paste, or focus event. Includes capability responses and fragments cut short by a timeout or an interrupting byte. |
| fragment     | A unit ended by something other than its own terminator (timeout, `ESC`, C0 byte, overlong). Reported as a reply with the `FRAGMENT` flag.                 |
| expectations | Two host-set facts that change timeout behavior: Kitty keyboard is on; the host is waiting for replies.                                                    |
| sink         | Caller-owned event records plus a caller-owned payload byte buffer that one feed writes into.                                                              |
| `now_ns`     | A host monotonic clock in nanoseconds for input. It is independent of the `ot_session_pump` clock (§10.6).                                                 |

---

## 4. Guarantees

Numbered so tests can cite them.

- **G1 Chunk-shape invariance.** For any byte stream and any partition into chunks fed with
  `now_ns` values within the timeout of each other, the event sequence is identical after joining
  consecutive paste records (§8.5).
- **G2 No protocol bytes become text.** A byte that starts or continues a sequence introducer is
  never reported as a character key unless the timeout proves it was a key. Fragments are replies.
- **G3 Every input byte is accounted for.** Each byte ends up in exactly one event's `raw` span, in
  one paste record's text or its `200~`/`201~` markers, in a discarded unit, or in the parser's
  pending unit. The one exception is deliberate: a mouse report recovered after a timed-out Escape
  reinstates that `ESC` in its `raw` (§6.2 `recover_sgr`), so the `ESC` also appears in the Escape
  key's `raw`.
- **G4 Bounded memory.** The parser holds at most `unit_bytes_max` (4096) bytes of pending unit plus
  fixed scalar state. Paste is streamed; nothing grows with input size.
- **G5 Bounded work.** One byte emits at most `events_per_byte_max` (4) records and at most
  `payload_per_byte_max` bytes of payload. A feed stops consuming when the sink cannot hold that, and
  reports `consumed` so the host resumes without loss.
- **G6 Time is explicit.** The parser never reads a clock or owns a timer. `feed` takes `now_ns`;
  `deadline_ns` tells the host when to call again with zero bytes.
- **G7 Deterministic timeout resolution.** A partial unit resolves in exactly one way on timeout
  (§6.4), and never byte by byte.
- **G8 `ESC ESC` is never one unit.** A second `ESC` restarts the unit and records an Alt prefix;
  the prefix applies only to a key, otherwise the first `ESC` is an Escape key of its own.
- **G9 Mouse reports, Kitty keys, and awaited replies never time out mid-way.** A CSI whose prefix
  can still be an SGR mouse report, a Kitty key, or an awaited CSI reply (§6.6) waits without a
  deadline for bytes that continue it; a byte that cannot continue it flushes a fragment. Shorter
  prefixes, X10 reports, and OSC/DCS/APC strings keep their deadline, as in Core.
- **G10 Alt + any character.** `ESC` followed by any printable ASCII, any control byte, or any
  complete UTF-8 scalar is that key with Alt.

---

## 5. Wire grammar (what the terminal sends)

Byte classes used below: `digit` = `0x30..0x39`; `param` = `0x30..0x3F` (`0-9 : ; < = > ?`);
`intermediate` = `0x20..0x2F`; `final` = `0x40..0x7E`; `C0` = `0x00..0x1F`; `DEL` = `0x7F`;
`lead2` = `0xC2..0xDF`; `lead3` = `0xE0..0xEF`; `lead4` = `0xF0..0xF4`; `cont` = `0x80..0xBF`.

```
text        := 0x20..0x7E | C0 | DEL | lead2 cont | lead3 cont cont | lead4 cont cont cont
eightbit    := 0x80..0xC1 | 0xF5..0xFF              ; legacy Alt: byte & 0x7F with Alt
escape      := ESC                                    ; a key only after the timeout
alt_key     := ESC text                                ; Alt + the key text would produce
alt_seq     := ESC (csi | ss3)                         ; Alt + a key sequence
csi         := ESC '[' param* intermediate* final
csi_linux   := ESC '[' '[' ('A'..'E' | digit+ '~')     ; Linux console / PuTTY
csi_rxvt    := ESC '[' digit+ ('$' | '^' | '@')        ; rxvt Shift / Ctrl / both
x10_mouse   := ESC '[' 'M' byte byte byte              ; bytes may be 0x00 or >= 0x20, incl. >= 0x80
sgr_mouse   := ESC '[' '<' digit+ ';' digit+ ';' digit+ ('M' | 'm')
ss3         := ESC 'O' digit* final
osc         := ESC ']' payload (BEL | ST)
dcs         := ESC 'P' payload ST
apc         := ESC '_' payload ST
paste       := ESC '[' '2' '0' '0' '~' byte* ESC '[' '2' '0' '1' '~'
focus       := ESC '[' ('I' | 'O')
```

Key sequence families inside `csi`:

```
CSI [1;] mods[:event] LETTER           LETTER in A B C D E F H P Q S Z a b c d e
CSI number [; mods[:event]] ~          number in 1..8, 11..15, 17..21, 23..26, 28, 29, 31..34, 57427
CSI 27 ; mods ; codepoint ~            xterm modifyOtherKeys
CSI code[:shifted[:base]] [; mods[:event] [; text[:text...]]] u    Kitty
```

Reply families the host asks for (`packages/native/src/ansi.zig`):

```
CSI ? mode ; value $ y        DECRPM          CSI ? ... c           DA1
CSI row ; col R               CPR             CSI ? flags u         Kitty keyboard flags
CSI 4 ; height ; width t      pixel size      CSI ? 997 ; n n       theme (not sent; parsed)
DCS > | name version ST       XTVERSION       DCS 1 + r 4d73 = hex ST   XTGETTCAP Ms
APC G i=31337 ... ST          Kitty graphics  OSC 10/11/4 ; ... (BEL|ST)   colors
OSC 99 ; i=opentui-notifications ... ST       OSC 1337 ; Capabilities=... ST
```

Notes:

- The eight-bit C1 forms (`0x9B` CSI, `0x9C` ST) are not recognized. In a UTF-8 stream they are
  continuation bytes.
- `DEL` (0x7F) is Backspace. `0x08` is also Backspace (Core's choice; both are common).
- An `ESC` inside an OSC/DCS/APC payload that is not followed by `\` ends the string as a fragment
  and starts a new unit. Core waits for the timeout instead; the fragment rule is strictly better
  because no reply can contain a bare `ESC`.

---

## 6. The state machine

### 6.1 States

Twelve states. Fields are part of the state value (Zig tagged union, §10.2).

| State         | Fields                                 | Waits with deadline | Meaning                                                                                                                                     |
| ------------- | -------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `ground`      |                                        | no                  | Nothing pending.                                                                                                                            |
| `expired`     |                                        | no                  | `ground` immediately after a lone `ESC` timed out. A following `[` may be the rest of a mouse report that a slow link split from its `ESC`. |
| `utf8`        | `expected: u3` (2..4), `alt: bool`     | yes                 | Lead byte seen; waiting for continuation bytes.                                                                                             |
| `escape`      | `alt: bool`                            | yes                 | One `ESC` seen (`alt = false`) or two (`alt = true`).                                                                                       |
| `recover`     |                                        | yes                 | `[` after a timed-out `ESC`. Waiting for `<` (SGR) or `M` (X10); otherwise `[` was a key.                                                   |
| `recover_sgr` |                                        | yes                 | `[ <` after a timed-out `ESC`; reading SGR parameters.                                                                                      |
| `csi`         | `alt: bool`, `deferred: bool`          | unless deferred     | Inside `ESC [`. `deferred` means the timeout passed on a unit that may still be a mouse report, a Kitty key, or an awaited reply (§6.6).    |
| `ss3`         | `alt: bool`                            | yes                 | Inside `ESC O`.                                                                                                                             |
| `x10`         | `alt: bool`, `recovered: bool`         | yes                 | Reading the three raw bytes after `ESC [ M`. `recovered`: the unit's `ESC` was reinstated by `recover`; fragments omit it.                  |
| `string`      | `kind: osc\|dcs\|apc`, `escaped: bool` | yes                 | Inside OSC, DCS, or APC until `BEL` (OSC only) or `ST`. `escaped` means the previous byte was `ESC`, which can split across chunks.         |
| `discard`     | `string`, `escaped`, `osc: bool`       | yes                 | An overlong CSI (until a `final`) or string (until its terminator) being dropped. `osc`: `BEL` also ends it.                                |
| `paste`       | `matched: u3` (0..6)                   | no                  | Inside bracketed paste. `matched` counts how many bytes of `ESC [ 2 0 1 ~` the tail of the payload matches so far.                          |

Scalar state outside the union: `unit: [4096]u8`, `unit_len: u16`, `since_ns: u64` (time of the
last byte of the pending unit), `expect: Expectations`, `x10_button: u8` (last pressed button, for
X10 releases), `discarded_count: u32`.

States removed relative to `stdin-parser.ts`, and why:

| Removed                                                                            | Replacement                                                                                                                                  |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `csi_sgr_mouse`, `csi_parametric`, `csi_private_reply` and their `_deferred` twins | One `csi` state with `deferred: bool`; deferral decided by inspecting the parsed prefix (§6.6).                                              |
| `csi_parametric_ignored`, `abortPendingStartupCursorCpr()`                         | CPR is always a reply (`CSI 1;N R` is F3 only when no replies are expected). The host ignores a stale CPR; the parser does not need to know. |
| `esc_recovery`, `esc_less_mouse`, `esc_less_x10_mouse`, `justFlushedEsc`           | `expired`, `recover`, `recover_sgr`; X10 recovery reuses `x10`.                                                                              |
| `pausePendingTimeout`, `resumePendingTimeout`, `hasPendingPixelResolutionResponse` | A deferred unit has no deadline; the adapter stops input time across suspension (§11.5).                                                     |
| `maxPendingBytes` (64 MiB) and the paste collector                                 | 4 KiB unit buffer; paste streams through the sink (§8.5).                                                                                    |

### 6.2 Byte transitions

Notation: `emit X` writes an event; `re-step` processes the current byte again in the new state
(bounded loop, at most 3 iterations, §10.4); `cut_short(alt)` = `if alt: emit Escape` then
`emit reply(unit, FRAGMENT)` then `ground`; `begin(S, intro)` = clear `unit`, store `ESC intro`,
enter `S`; `escape(now)` = clear `unit`, enter `escape{alt=false}`, `since = now`.

**`ground`** (also the target of `ground(byte, alt)` helper used by other states):

| Byte                    | Action                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `ESC`                   | `escape(now)`                                                                               |
| `0x0D`, `0x0A`          | emit key Enter (+Alt if `alt`)                                                              |
| `0x09`                  | emit key Tab                                                                                |
| `0x7F`, `0x08`          | emit key Backspace                                                                          |
| `0x00`                  | emit key `' '` + Ctrl                                                                       |
| `0x01..0x1A`            | emit key `'a' + byte - 1` + Ctrl                                                            |
| `0x1C..0x1F`            | emit key `'\\' + byte - 0x1C` + Ctrl (`\ ] ^ _`)                                            |
| `0x20..0x7E`            | emit key char                                                                               |
| `lead2`/`lead3`/`lead4` | `unit = [byte]`, enter `utf8{expected, alt}`                                                |
| `eightbit`              | eight-bit: `b = byte & 0x7F`; if `b == ESC` emit key Escape+Alt, else `ground(b, alt=true)` |

**`expired`:** `[` → enter `recover`, `since = now`; anything else → `ground`, re-step.

**`utf8{expected, alt}`:**

| Byte   | Action                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------- |
| `cont` | append; if `unit_len == expected`: decode (invalid scalar → U+FFFD), emit key char (+Alt), `ground` |
| other  | for each buffered byte: eight-bit (as in ground); then `ground`, re-step                            |

The first fallback key's `raw` carries the `ESC` of an Alt prefix (`ESC 0xE4 a` → Alt+d with raw
`ESC 0xE4`, then `a`), so G3 holds without a fifth event.

**`escape{alt}`:**

| Byte          | `alt = false`                              | `alt = true`                                            |
| ------------- | ------------------------------------------ | ------------------------------------------------------- |
| `[`           | `begin(csi{alt, deferred=false}, '[')`     | same, carrying `alt = true`                             |
| `O`           | `begin(ss3{alt}, 'O')`                     | same                                                    |
| `ESC`         | enter `escape{alt=true}`, `since = now`    | emit key Escape; stay `escape{alt=true}`, `since = now` |
| `]`, `P`, `_` | `begin(string{kind, escaped=false}, byte)` | emit key Escape; then as `alt = false`                  |
| `B`           | emit key Left + Alt                        | emit key Escape; then as `alt = false`                  |
| `F`           | emit key Right + Alt                       | emit key Escape; then as `alt = false`                  |
| other         | `ground(byte, alt=true)` (G10)             | emit key Escape; then as `alt = false`                  |

`ESC B` / `ESC F` are Terminal.app's old Option+arrow forms; Core maps them and the vectors depend
on it. Every other `ESC <uppercase>` is Alt + that character (the adapter adds Shift, §12.3).

**`recover`:**

| Byte  | Action                                                                          |
| ----- | ------------------------------------------------------------------------------- |
| `<`   | `begin(recover_sgr, '[')`, append `<` (unit is `ESC [ <`, the `ESC` reinstated) |
| `M`   | `begin(x10{alt=false, recovered=true}, '[')`, append `M`                        |
| other | emit key `'['`; `ground`, re-step                                               |

**`recover_sgr`:**

| Byte                                               | Action                                                                                                    |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `digit`, `;` (and `unit_len < sequence_bytes_max`) | append                                                                                                    |
| `M`, `m`                                           | decode SGR from `unit[3..]`; ok → emit mouse; else append and emit reply(`unit[1..]`, FRAGMENT); `ground` |
| other                                              | emit reply(`unit[1..]`, FRAGMENT); `ground`, re-step                                                      |

Recovery replies omit the reinstated `ESC`: raw bytes are reported as received. A recovered mouse
event's `raw` includes the reinstated `ESC` so that it is a well-formed report for handlers.

**`csi{alt, deferred=false}` and `ss3{alt}`:**

| Byte                                                        | Action                                                |
| ----------------------------------------------------------- | ----------------------------------------------------- |
| `ESC`                                                       | `cut_short(alt)`; `escape(now)`                       |
| `C0` or `DEL`                                               | `cut_short(alt)`; `ground(byte, false)`               |
| csi only, `unit_len == 2`, `M`                              | append; enter `x10{alt, recovered=false}`             |
| csi only, `unit_len == 2`, `[`                              | append (Linux console / PuTTY)                        |
| `final`, or csi with `$` after digits only (`unit_len > 2`) | append; `ground`; dispatch (§6.3)                     |
| `unit_len >= sequence_bytes_max`                            | enter `discard{string=false}`; `discarded_count += 1` |
| other (`param`, `intermediate`, `>= 0x80`)                  | append                                                |

**`csi{alt, deferred=true}`:** if `continues_deferred(byte)` (§6.6): enter `csi{alt, deferred=false}`
and re-step; else `cut_short(alt)` and re-step in `ground`.

**`x10{alt, recovered}`:**

| Byte         | Action                                                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `0x01..0x1F` | `cut_short(alt)`; `ground(byte, false)` (a control byte cannot be a payload byte; `0x00` can: xterm's past-end marker) |
| other        | append; when `unit_len == 6`: decode (§7.8); `ground`                                                                  |

A recovered unit's fragment omits the reinstated `ESC`, like `recover_sgr`.

**`string{kind, escaped}`:**

| Byte                                | `escaped = false`                                                   | `escaped = true`                                                   |
| ----------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `\`                                 | append                                                              | append; emit reply(kind); `ground`                                 |
| `BEL`, kind `osc`                   | append; emit reply(osc); `ground`                                   | (pop the `ESC`; emit reply(osc, FRAGMENT); `escape(now)`; re-step) |
| `ESC`                               | append; `escaped = true`                                            | pop the `ESC`; emit reply(kind, FRAGMENT); `escape(now)`; re-step  |
| other, `unit_len >= unit_bytes_max` | enter `discard{string=true, escaped=false}`; `discarded_count += 1` | pop the `ESC`; emit reply(kind, FRAGMENT); `escape(now)`; re-step  |
| other                               | append                                                              | pop the `ESC`; emit reply(kind, FRAGMENT); `escape(now)`; re-step  |

`BEL` ends only OSC. In DCS and APC it is payload (Core's rule; ECMA-48).

At the `unit_bytes_max` boundary the terminator must still fit: an `ESC` needs room for itself and
the `\` after it, or the string enters `discard{string=true, escaped=true}`; an OSC `BEL` that does
not fit drops the whole string (`discarded_count += 1`, `ground`).

**`discard{string=false}`:** `ESC` → `escape(now)`; `final` → `ground`; else stay.

**`discard{string=true, escaped, osc}`:** `(false, BEL)` with `osc` → `ground`; `(false, ESC)` →
`escaped = true`; `(true, '\')` → `ground`; `(true, other)` → `escape(now)`, re-step;
`(false, other)` → stay. As in a short string, `BEL` is payload in an overlong DCS or APC.

**`paste{matched}`:** with `END = ESC [ 2 0 1 ~`:

| Condition                                     | Action                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `byte == END[matched]` and `matched + 1 == 6` | emit paste END (closing the open record, §8.5); `ground`                                                  |
| `byte == END[matched]`                        | `matched += 1`                                                                                            |
| else                                          | append `END[0..matched]` to paste text; if `byte == ESC`: `matched = 1` else append `byte`, `matched = 0` |

### 6.3 CSI and SS3 dispatch

After a `final` byte, with `params = unit[2 .. len-1]` and `final = unit[len-1]`:

**CSI**, in order:

1. `params == "200"` and `final == '~'` → if `alt`: emit Escape; clear paste state; enter `paste{0}`.
   (`201~` outside a paste is a reply.)
2. `params` empty and `final` is `I` / `O` → focus in / out (Escape first if `alt`).
3. `params[0] == '<'` and `final` is `M` / `m` → SGR mouse (§7.8); decode failure → reply.
4. `params[0] == '['` → Linux console: `[` + `A..E` → F1..F5; `[` + `number ~` → tilde key (§7.3).
   Else reply.
5. `params[0]` is `?`, `>`, `=`, or any intermediate present (other than the rxvt `$` final form) →
   reply. Private-prefixed and intermediate-bearing sequences are never keys.
6. `params` is only digits, `:`, `;` → parse fields (§7.1) and decode by `final`:
   - `u` → Kitty key (§7.6)
   - `~` → tilde key (§7.3), including `27 ; mods ; code ~` (§7.5)
   - `$`, `^`, `@` with exactly one field → tilde key with Shift / Ctrl / Shift+Ctrl (rxvt)
   - `R` → F3 only as `1 ; mods R` with mods > 1 and `expect.replies == false`; else reply (CPR)
   - `A..H`, `P..S`, `Z`, `a..e` → letter key (§7.2)
   - anything else → reply
7. Otherwise → reply.

A key result gets `| Alt` when `alt`. A non-key result (mouse, focus, paste, reply) is preceded by
an Escape key when `alt` (G8).

**SS3**: `ESC O [digits] final`. Optional digits are a modifier parameter. Decode by final (§7.4);
unknown → reply.

### 6.4 Timeout resolution (`expire`)

`deadline_ns()` is `since_ns + timeout_ns` when the state "waits with deadline" (§6.1), and also
when the state is `csi{deferred=true}` but `deferrable()` is now false (expectations changed).
Otherwise there is no deadline. `expire(now_ns)` does nothing before the deadline. At or after it:

| State                                    | Resolution                                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `escape{alt=false}`                      | emit key Escape; enter `expired`                                                                |
| `escape{alt=true}`                       | emit key Escape + Alt; `ground`                                                                 |
| `recover`                                | emit key `'['`; `ground`                                                                        |
| `recover_sgr`                            | emit reply(`unit[1..]`, FRAGMENT); `ground`                                                     |
| `utf8`                                   | for each buffered byte: eight-bit key; `ground`                                                 |
| `csi{deferred=false}` and `deferrable()` | enter `csi{deferred=true}` (no event; no deadline)                                              |
| `csi` otherwise, `ss3`, `x10`            | `cut_short(alt)`                                                                                |
| `string`                                 | emit reply(kind, FRAGMENT); `ground`                                                            |
| `discard`                                | `ground` (the rest of the garbage will be text; after 20 ms of silence that is the right guess) |
| `ground`, `expired`, `paste`             | no deadline                                                                                     |

`timeout_ns = 20_000_000` (20 ms). Core and Codex use 20 ms; Gemini and Claude Code use 50 ms. It
is a constant, not an option: Core hard-codes `timeoutMs: 20` in `renderer.ts`.

### 6.5 Feed order

```
feed(bytes, now_ns, sink):
    expire(now_ns, sink)                        -- a new batch never extends an expired unit
    consumed = 0
    for byte in bytes:
        if !sink.has_room_for_one_byte(): break -- G5
        step(byte, now_ns, sink)
        consumed += 1
    if consumed > 0: since_ns = now_ns
    return consumed
```

`feed` with zero bytes is `expire`. The host calls it when `deadline_ns` passes, and after changing
expectations (§6.6).

### 6.6 Deferral: units that wait without a deadline

A `csi` unit whose timeout passes is deferred instead of cut short when its prefix can still be one
of three things the host must never see as text:

| Prefix (`unit[2..]`)          | Deferrable when                                                                           | Continues with    | Completes with                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `<` then `digit`/`;` only     | always                                                                                    | `digit`, `;`      | `M`, `m`                                                                                                                               |
| `?` then `digit`/`;`/`$` only | `expect.replies`                                                                          | `digit`, `;`, `$` | `y` after `$` and a digit; `c` after a digit or `;`; `n`, `u` after a digit                                                            |
| numeric `d+(:d*)*(;…){1,2}`   | `expect.kitty_keyboard`; or `expect.replies` and (one `;`, or two `;` with first field 4) | `digit`, `:`, `;` | kitty: `u` after a digit, or `~`/`A..Z` with one `;` and a `:` subfield; replies: `R` with one `;`, `t` with two `;` and first field 4 |

"Numeric" with Kitty on also admits a first field `d+(:d*)*` (alternate keys). The shape checks are
over the bytes in `unit`, not a second parse.

Why: a slow link can split `ESC [ < 35 ; 20` from `; 5 m` by more than 20 ms. Without deferral the
tail `;5m` would be typed. With deferral the unit waits, and a byte that cannot continue it (a
letter, another `ESC`) flushes a fragment and is then processed normally. The cost is one swallowed
20 ms timeout for a genuinely truncated report, which then resolves on the next byte.

`expect` flags come from the host (§11.3). Setting them never emits; the next `feed` or `expire`
re-evaluates a deferred unit and cuts it short if it is no longer deferrable.

### 6.7 Alt-prefix rules in one place (G8)

- `ESC ESC` + timeout → Alt+Escape.
- `ESC ESC [ …` / `ESC ESC O …` that decode to a key → that key with Alt.
- `ESC ESC [ …` that decodes to a mouse report, focus, paste start, or reply → Escape, then that.
- `ESC ESC x` for any other `x` → Escape, then `ESC x` handled normally (`Alt+x`, or a string
  introducer, or a third Escape).

---

## 7. Decoding tables

### 7.1 Fields

`fields(params)` splits numeric CSI parameters into at most `params_max = 16` fields separated by
`;`, each with at most `subparams_max = 8` subfields separated by `:`. Each value is `?u32` (absent
when empty), accumulated with saturating arithmetic. Any byte other than `digit`, `;`, `:` makes
the parameters non-numeric (→ reply). Extra fields and subfields are ignored; a Kitty text field
with more than 8 subfields sets `TEXT_TRUNCATED`. Field index notation below: `f[i][j]`.

Modifier parameter: `mods = f[1][0] - 1` (default 0, and 0 when the value exceeds 256), bits as §8.3. Event subfield
`f[1][1]`: 1 press (default), 2 repeat, 3 release.

### 7.2 Letter keys: `CSI [1;] mods[:event] LETTER`

Accepted field shapes: none; `mods` (one field, older terminals); `1 ; mods[:event]`.

| Final | Key                                                   | Final | Key                 |
| ----- | ----------------------------------------------------- | ----- | ------------------- |
| `A`   | Up                                                    | `a`   | Up + Shift (rxvt)   |
| `B`   | Down                                                  | `b`   | Down + Shift        |
| `C`   | Right                                                 | `c`   | Right + Shift       |
| `D`   | Left                                                  | `d`   | Left + Shift        |
| `E`   | KeypadBegin (Core: `clear`)                           | `e`   | KeypadBegin + Shift |
| `F`   | End                                                   | `H`   | Home                |
| `P`   | F1                                                    | `Q`   | F2                  |
| `R`   | F3 only as `1;mods R`, mods > 1, replies not expected | `S`   | F4                  |
| `Z`   | Tab + Shift                                           |       |                     |

### 7.3 Tilde keys: `CSI number [; mods[:event]] ~`

| number | Key      | number | Key                                                          |
| ------ | -------- | ------ | ------------------------------------------------------------ |
| 1, 7   | Home     | 17..21 | F6..F10                                                      |
| 2      | Insert   | 23..26 | F11..F14                                                     |
| 3      | Delete   | 28     | F15                                                          |
| 4, 8   | End      | 29     | Menu (rxvt sends Shift+F6 here; xterm, Kitty, VTE send Menu) |
| 5      | PageUp   | 31..34 | F17..F20                                                     |
| 6      | PageDown | 27     | modifyOtherKeys (§7.5)                                       |
| 11..15 | F1..F5   | 57427  | KeypadBegin                                                  |

Unknown number → reply.

### 7.4 SS3: `ESC O [mods] final`

| Final    | Key                | Final         | Key                |
| -------- | ------------------ | ------------- | ------------------ |
| `A`..`D` | Up Down Right Left | `a`..`e`      | same + Ctrl (rxvt) |
| `E`      | KeypadBegin        | `F` / `H`     | End / Home         |
| `M`      | Enter (keypad)     | `P`..`S`      | F1..F4             |
| `X`      | `=`                | `j k l m n o` | `* + , - . /`      |
| `p`..`y` | `0`..`9`           | other         | reply              |

Keypad characters carry `text` so editors insert them (Core's `ss3NumpadPrintable`).

### 7.5 modifyOtherKeys: `CSI 27 ; mods ; codepoint ~`

`codepoint` decodes like a Kitty code (§7.6) without shifted/base/text fields. A character key's
text is the character as sent, without Shift applied (xterm already sends the shifted character).
Examples: `27;5;13~` = Ctrl+Enter, `27;2;9~` = Shift+Tab, `27;5;27~` = Ctrl+Escape.

### 7.6 Kitty: `CSI code[:shifted[:base]] ; mods[:event] ; text[:text…] u`

- `code == 0`: a text-only event (input method). Requires text; otherwise reply.
- `code` in the functional table below → that key. `27, 13, 9, 127` are Escape, Enter, Tab,
  Backspace and are canonical; `57344..57347` normalize to them. `8` is also Backspace.
- Any other scalar (≤ 0x10FFFF, not a control) → character key with `code` as reported.
  `base_code = f[0][2]` when present and nonzero (the adapter and key bindings decide policy;
  issue 050 lives in `keybinding.internal.ts`). Values above 0x10FFFF → reply.
- `text`: the text codepoints joined as UTF-8. At most `subparams_max = 8` codepoints are kept, so
  it always fits `key_text_bytes_max = 32` bytes; more codepoints set `TEXT_TRUNCATED`. When absent,
  derived as in §7.7.

Functional codes (Kitty's private-use assignments; the native key enum uses them verbatim):

| Code         | Key                                | Code         | Key                                                        | Code         | Key                                                                                      |
| ------------ | ---------------------------------- | ------------ | ---------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| 57344        | Escape (→27)                       | 57345        | Enter (→13)                                                | 57346        | Tab (→9)                                                                                 |
| 57347        | Backspace (→127)                   | 57348        | Insert                                                     | 57349        | Delete                                                                                   |
| 57350        | Left                               | 57351        | Right                                                      | 57352        | Up                                                                                       |
| 57353        | Down                               | 57354        | PageUp                                                     | 57355        | PageDown                                                                                 |
| 57356        | Home                               | 57357        | End                                                        | 57358        | CapsLock                                                                                 |
| 57359        | ScrollLock                         | 57360        | NumLock                                                    | 57361        | PrintScreen                                                                              |
| 57362        | Pause                              | 57363        | Menu                                                       | 57364..57398 | F1..F35                                                                                  |
| 57399..57408 | KP0..KP9                           | 57409        | KPDecimal                                                  | 57410        | KPDivide                                                                                 |
| 57411        | KPMultiply                         | 57412        | KPSubtract                                                 | 57413        | KPAdd                                                                                    |
| 57414        | KPEnter                            | 57415        | KPEqual                                                    | 57416        | KPSeparator                                                                              |
| 57417..57420 | KPLeft KPRight KPUp KPDown         | 57421..57422 | KPPageUp KPPageDown                                        | 57423..57424 | KPHome KPEnd                                                                             |
| 57425..57426 | KPInsert KPDelete                  | 57427        | KPBegin                                                    | 57428..57437 | MediaPlay Pause PlayPause Reverse Stop FastForward Rewind TrackNext TrackPrevious Record |
| 57438..57440 | LowerVolume RaiseVolume MuteVolume | 57441..57446 | LeftShift LeftControl LeftAlt LeftSuper LeftHyper LeftMeta | 57447..57452 | RightShift RightControl RightAlt RightSuper RightHyper RightMeta                         |
| 57453        | IsoLevel3Shift                     | 57454        | IsoLevel5Shift                                             |              |                                                                                          |

Legacy aliases carrying `mods:event` (`CSI 1;1:3A`, `CSI 5;1:2~`) are handled by §7.2 and §7.3
because `event` is read from `f[1][1]` there too.

### 7.7 Text derivation

`text` is what an editor should insert for the key; empty when nothing should be inserted.

- Kitty: the text field if present. Else, for a character key or keypad character key: if Shift
  and `shifted` present → `shifted`; else if Shift and the character has a single-scalar uppercase →
  that; else the character. Functional keys get no text; keypad characters do (Core's
  `printableKeypadText`). Native has no Unicode case tables: `upper` covers the scripts keyboards
  type (ASCII, Latin-1 and Latin Extended, Greek, Cyrillic, Armenian, fullwidth Latin). Terminals
  that report `shifted` codes make it unnecessary.
- Legacy: a character key without Alt → the character. With Alt → empty (Core's `sequence` stays
  the raw `ESC x`, which stops editors inserting it). Control keys, SS3 keypad characters as §7.4.

### 7.8 Mouse

SGR `code ; col ; row` + `M`/`m`, X10 `code = cb - 32` (wrapping), `col = cx - 33`, `row = cy - 33`
(wrapping u8, so xterm's past-end `0x00` becomes 223).

```
button  = code & 3          0 left, 1 middle, 2 right, 3 none
shift   = code & 4          alt = code & 8          ctrl = code & 16
motion  = code & 32         wheel = code & 64       extra = code & 128 (buttons 8 + button)
```

| Condition                           | Event                                                      |
| ----------------------------------- | ---------------------------------------------------------- |
| motion and button ≠ 3 and not wheel | drag(button)                                               |
| motion otherwise                    | move (URxvt sets the wheel bit on motion while scrolling)  |
| wheel and press (`M`, or X10)       | scroll, direction = button (0 up, 1 down, 2 left, 3 right) |
| wheel and release (`m`)             | no event: reply (issue 048)                                |
| press (`M`)                         | down(button); button 3 → reply                             |
| release (`m`)                       | up(button); button 3 → reply                               |
| X10 `code & 0xE3 == 3`              | up(`x10_button`); X10 reports every release as button 3    |

Coordinates: SGR values are 1-based, reported 0-based (saturating at 0); X10 wraps as above.
Mouse decoding is stateless except `x10_button`. Core kept a pressed-button set to decide drag
versus move; the wire bits already carry the held button and the renderer tracks capture itself.

---

## 8. Event model

### 8.1 Kinds and actions

| `kind`      | `action`                               | `code`                                              | `x`, `y`      | `raw`      | `text`             |
| ----------- | -------------------------------------- | --------------------------------------------------- | ------------- | ---------- | ------------------ |
| `KEY` (1)   | 1 press, 2 repeat, 3 release           | key code (§8.2)                                     | 0             | wire bytes | insert text (§7.7) |
| `MOUSE` (2) | 1 down, 2 up, 3 move, 4 drag, 5 scroll | button (0..2, 8+), 255 none; scroll: direction 0..3 | cell, 0-based | wire bytes | empty              |
| `PASTE` (3) | 0                                      | 0                                                   | 0             | empty      | chunk bytes        |
| `FOCUS` (4) | 1 in, 0 out                            | 0                                                   | 0             | wire bytes | empty              |
| `REPLY` (5) | 0                                      | protocol: 1 csi, 2 ss3, 3 osc, 4 dcs, 5 apc         | 0             | wire bytes | empty              |

### 8.2 Key codes

`code` is a Unicode scalar. Character keys use their scalar. Functional keys use the Kitty table
(§7.6). `27`, `13`, `9`, `127` are Escape, Enter, Tab, Backspace. `0` never appears (text-only
Kitty events report `code = 0` with text; the adapter names them by their text).

The header defines `OT_INPUT_KEY_*` for every functional code. A character typed from Unicode's
private-use area collides with the Kitty range; this is the protocol's own convention and every
Kitty-protocol terminal shares it.

### 8.3 Modifiers (`uint8_t`, Kitty's layout, value is the wire parameter minus one)

| Bit | Modifier | Bit | Modifier |
| --- | -------- | --- | -------- |
| 1   | Shift    | 16  | Hyper    |
| 2   | Alt      | 32  | Meta     |
| 4   | Ctrl     | 64  | CapsLock |
| 8   | Super    | 128 | NumLock  |

Mouse events use the same byte (Shift, Alt, Ctrl only).

### 8.4 Flags

| Kind    | Flag                                 | Meaning                                                                       |
| ------- | ------------------------------------ | ----------------------------------------------------------------------------- |
| `KEY`   | `OT_INPUT_KEY_KITTY` (1)             | Decoded from a Kitty `CSI u` or `mods:event` form (Core's `source: "kitty"`). |
| `KEY`   | `OT_INPUT_KEY_TEXT_TRUNCATED` (2)    | The Kitty text field had more than 8 codepoints.                              |
| `PASTE` | `OT_INPUT_PASTE_START` (1)           | First record of a paste.                                                      |
| `PASTE` | `OT_INPUT_PASTE_END` (2)             | Last record of a paste.                                                       |
| `REPLY` | `OT_INPUT_REPLY_FRAGMENT` (1)        | Cut short by timeout, `ESC`, control byte, or failed recovery.                |
| `REPLY` | `OT_INPUT_REPLY_CURSOR_POSITION` (2) | `CSI row ; col R` with numeric fields only.                                   |

### 8.5 Paste records

Paste is streamed. The parser appends bytes to the _open_ paste record: the last record in the
sink. Paste state writes only paste records and begins with the `START` record, so a nonempty sink
always ends with it (asserted; a sink must hold only this parser's records). In an empty sink it
opens a new `PASTE` record without `START`. `201~` sets `END` on the open record, opening an empty one if needed.
An empty paste is one record with `START | END` and `text_len = 0`. A paste that spans feeds
produces several records; G1 holds on the joined text.

### 8.6 Payload spans

`raw` and `text` are `(offset, len)` into the sink's payload buffer, valid for the records of one
feed call. The parser copies bytes; the host must not retain the sink across calls.

---

## 9. Bounds

| Constant                      | Value                                                             | Why                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeout_ns`                  | 20 ms                                                             | §6.4.                                                                                                                                                                                                          |
| `unit_bytes_max`              | 4096                                                              | One pending unit. Capability replies are bounded by `OT_SESSION_CONTROL_PACKET_BYTES` (4096); palette, DECRPM, DA, XTVERSION, XTGETTCAP, Kitty graphics replies are far smaller. Longer strings are discarded. |
| `sequence_bytes_max`          | 256                                                               | CSI, SS3, X10, UTF-8, recovery units. A real key or mouse report is under 32 bytes.                                                                                                                            |
| `params_max`, `subparams_max` | 16, 8                                                             | Kitty uses 3 fields; mouse 3; CPR 2. Extra fields are ignored by decoders.                                                                                                                                     |
| `key_text_bytes_max`          | 32                                                                | IME commits of several scalars; 8 scalars × 4 bytes.                                                                                                                                                           |
| `events_per_byte_max`         | 4                                                                 | `utf8` fallback: 3 eight-bit keys + re-step of the byte. All other paths emit ≤ 3 (§10.5).                                                                                                                     |
| `payload_per_byte_max`        | `unit_bytes_max + sequence_bytes_max + key_text_bytes_max` = 4384 | A string fragment (≤ 4096 raw) plus the re-stepped byte's event.                                                                                                                                               |
| `OT_INPUT_EVENTS_MIN`         | 4                                                                 | = `events_per_byte_max`; a sink below this can never make progress.                                                                                                                                            |
| `OT_INPUT_PAYLOAD_BYTES_MIN`  | 4384                                                              | = `payload_per_byte_max`. The adapter uses 64 records and 16 KiB.                                                                                                                                              |

Memory per parser: `unit` 4096 + ~32 bytes of scalars. No allocation, ever. Paste state is one
`u3`. Overlong units increment `discarded_count` (saturating) and are reported in every drain.

---

## 10. Zig module: `packages/native/src/input-parser.zig`

### 10.1 Placement and conventions

- File `src/input-parser.zig`, type `InputParser`, tests in `src/tests/input-parser_test.zig`
  registered in `src/test.zig`. Kebab-case files, `snake_case` functions, 4-space `zig fmt`,
  100 columns. Zig 0.16 (`build.zig.zon` minimum).
- No allocator. No `std.Io`. No clock. The struct is a value inside `Session`.
- Hot loop: `step` is one switch over `State`; decoders are free functions over parsed fields or
  `[]const u8` and return `?Key` / `?Mouse`, which dispatch turns into events.
- Assertions: pair checks at the sink boundary (room before, counts after), state-field invariants
  (`utf8.expected` in 2..4, `paste.matched` < 6, `unit_len ≤ unit_bytes_max`), re-step iteration
  bound, `comptime` equality of `Event` and `c.ot_input_event` size and field offsets.

### 10.2 Types

```zig
pub const timeout_ns: u64 = 20 * std.time.ns_per_ms;
pub const unit_bytes_max: u16 = 4096;
pub const sequence_bytes_max: u16 = 256;
pub const key_text_bytes_max: u8 = 32;
pub const events_per_byte_max: u32 = 4;
pub const payload_per_byte_max: u32 = unit_bytes_max + sequence_bytes_max + key_text_bytes_max;

pub const Expectations = packed struct(u8) {
    replies: bool = false,
    kitty_keyboard: bool = false,
    _reserved: u6 = 0,
};

pub const Modifiers = packed struct(u8) {
    shift: bool = false, alt: bool = false, ctrl: bool = false, super: bool = false,
    hyper: bool = false, meta: bool = false, caps_lock: bool = false, num_lock: bool = false,
};

pub const Kind = enum(u8) { key = 1, mouse = 2, paste = 3, focus = 4, reply = 5 };

/// Identical to ot_input_event. Written straight into the caller's records.
pub const Event = extern struct {
    kind: u8,
    action: u8,
    modifiers: u8,
    flags: u8,
    code: u32,
    base_code: u32,
    x: u16,
    y: u16,
    raw_offset: u32,
    raw_len: u32,
    text_offset: u32,
    text_len: u32,
};

const StringKind = enum(u8) { osc, dcs, apc };

const State = union(enum) {
    ground,
    expired,
    utf8: struct { expected: u3, alt: bool },
    escape: struct { alt: bool },
    recover,
    recover_sgr,
    csi: struct { alt: bool, deferred: bool },
    ss3: struct { alt: bool },
    x10: struct { alt: bool, recovered: bool },
    string: struct { kind: StringKind, escaped: bool },
    discard: struct { string: bool, escaped: bool },
    paste: struct { matched: u3 },
};

pub const Sink = struct {
    events: []Event,
    payload: []u8,
    count: u32 = 0,
    payload_len: u32 = 0,

    pub fn hasRoomForOneByte(self: *const Sink) bool;   // events_per_byte_max, payload_per_byte_max
    fn push(self: *Sink, event: Event) void;             // asserts room
    fn copy(self: *Sink, bytes: []const u8) Span;        // asserts room; returns (offset, len)
    fn appendPaste(self: *Sink, bytes: []const u8) void; // extends the open paste record or opens one
};

pub const InputParser = struct {
    state: State = .ground,
    expect: Expectations = .{},
    unit: [unit_bytes_max]u8 = undefined,
    unit_len: u16 = 0,
    since_ns: u64 = 0,
    x10_button: u8 = 0,
    discarded_count: u32 = 0,

    /// Parses bytes that arrived at now_ns. Returns the number consumed (G5).
    /// Zero bytes only expires. now_ns must not go backwards (caller-checked).
    pub fn feed(self: *InputParser, bytes: []const u8, now_ns: u64, sink: *Sink) u32;
    /// When the host should call feed with zero bytes, or null.
    pub fn deadlineNs(self: *const InputParser) ?u64;
    /// Changes expectations without emitting; the next feed re-evaluates a deferred unit.
    pub fn setExpectations(self: *InputParser, expect: Expectations) void;
    /// Drops the pending unit and mouse state; keeps expectations.
    pub fn reset(self: *InputParser) void;
};
```

### 10.3 Function layout (entry points first)

```
feed, deadlineNs, setExpectations, reset
expire(self, now_ns, sink)
step(self, byte, sink)                        -- one switch over State; bounded re-step loop
ground(self, byte, alt, wire, sink)           -- §6.2 ground table; wire = raw bytes with an Alt ESC
eightBit(self, byte, wire, sink)
escapeByte, recoverSgrByte, sequenceByte, stringByte, discardByte, pasteByte  -- one per state arm
dispatchCsi(self, alt, sink), dispatchSs3(self, alt, sink), dispatchX10(self, alt, recovered, sink)
cutShort(self, alt, protocol, sink), begin(self, state, introducer), escape(self)
deferrable(self) bool, continuesDeferred(self, byte) bool  -- §6.6 shape checks over unit
-- pure decoders:
Fields.parse(params) ?Fields, Shape.of(params, kitty) ?Shape, modsAndAction(fields)
letterKey, tildeKey, kittyKey, codeKey, ss3Key, bracketKey -> ?Key
sgrMouse(params, pressed), mouseKind(code, release) -> ?Mouse
upper(scalar) ?u32                            -- single-scalar uppercase for Kitty text (§7.7)
```

Keep each under 70 lines; `step` is the one long switch and should stay a flat table of arms that
call helpers.

### 10.4 Re-step without recursion

Several arms process the current byte again in a new state. Implement as a loop:

```zig
var pending: ?u8 = byte;
var iterations: u8 = 0;
while (pending) |b| {
    pending = null;
    iterations += 1;
    std.debug.assert(iterations <= 3);
    switch (self.state) { ... => { ...; pending = b; }, ... }
}
```

Longest chain: `string{escaped}` + non-`\` → fragment, `escape(now)`, re-step `b` in `escape` →
`ground(b, alt=true)` (one more step inside `ground`, not a re-step). `csi{deferred}` + `ESC` →
cut short, re-step in `ground` → `escape`. Every chain is at most two iterations; the assertion
allows three.

### 10.5 Per-byte emission bound (G5)

| Path                                                                   | Events |
| ---------------------------------------------------------------------- | ------ |
| `utf8` + non-continuation: 3 buffered eight-bit keys + re-step (1)     | 4      |
| `csi{alt, deferred}` + non-continuing: Escape + fragment + re-step (1) | 3      |
| `x10{alt}` + control: Escape + fragment + ground (1)                   | 3      |
| `escape{alt=true}` + `x`: Escape + Alt+x                               | 2      |
| `csi{alt}` completing as mouse/focus/paste/reply: Escape + event       | 2      |
| `recover`/`recover_sgr` + other: `[` key or fragment + re-step (1)     | 2      |
| `expire` in `utf8`                                                     | 3      |

Payload: a string fragment is at most `unit_bytes_max` raw bytes; the re-stepped byte's event is at
most `sequence_bytes_max` raw plus `key_text_bytes_max` text.

### 10.6 Session ownership

`Session` gains `input: input_parser.InputParser = .{}`, the host's `input_expect`, and
`last_input_ns`. Effective expectations at feed time:

```
kitty_keyboard = input_expect.kitty_keyboard or (renderer != null and renderer.terminal.state.kitty_keyboard)
replies        = input_expect.replies
```

`terminal.state.kitty_keyboard` becomes true when `setKittyKeyboard` writes the push packet, which
precedes any Kitty-encoded input. The host flag lets Core keep its optimistic `useKittyKeyboard`
setting. `reset` is called by nothing in Session today; suspend and resume do not touch the parser
(§11.5). `deinit` has nothing to free.

`Session.feedInput(bytes, now_ns, sink)` checks `checkOpen()` and that `now_ns` is not before
`last_input_ns`, applies the effective expectations, and calls `input.feed`. It returns `consumed`,
`discarded_count`, and `deadlineNs()` for the drain record.

Input time is its own monotonic clock, not the pump's `last_pump_ns`. The parser's deadlines are
relative to its own `since_ns`, so nothing needs the two clocks to agree, and the host's input timer
runs on a different clock than its pump: Core's renderer arms input timeouts on its `Clock`
(`performance.now()`, or a `ManualClock` in tests) while `NativeSession` pumps with
`process.hrtime.bigint()`. A shared rule would reject the first feed after any pump.

---

## 11. C ABI: `ot_session_input_*`

### 11.1 Header additions (`include/opentui.h`)

```c
#define OT_INPUT_KEY UINT32_C(1)
#define OT_INPUT_MOUSE UINT32_C(2)
#define OT_INPUT_PASTE UINT32_C(3)
#define OT_INPUT_FOCUS UINT32_C(4)
#define OT_INPUT_REPLY UINT32_C(5)

#define OT_INPUT_KEY_PRESS UINT32_C(1)
#define OT_INPUT_KEY_REPEAT UINT32_C(2)
#define OT_INPUT_KEY_RELEASE UINT32_C(3)
#define OT_INPUT_MOUSE_DOWN UINT32_C(1)
#define OT_INPUT_MOUSE_UP UINT32_C(2)
#define OT_INPUT_MOUSE_MOVE UINT32_C(3)
#define OT_INPUT_MOUSE_DRAG UINT32_C(4)
#define OT_INPUT_MOUSE_SCROLL UINT32_C(5)
#define OT_INPUT_MOUSE_BUTTON_NONE UINT32_C(255)
#define OT_INPUT_FOCUS_OUT UINT32_C(0)
#define OT_INPUT_FOCUS_IN UINT32_C(1)

#define OT_INPUT_MOD_SHIFT UINT32_C(1)
#define OT_INPUT_MOD_ALT UINT32_C(2)
#define OT_INPUT_MOD_CTRL UINT32_C(4)
#define OT_INPUT_MOD_SUPER UINT32_C(8)
#define OT_INPUT_MOD_HYPER UINT32_C(16)
#define OT_INPUT_MOD_META UINT32_C(32)
#define OT_INPUT_MOD_CAPS_LOCK UINT32_C(64)
#define OT_INPUT_MOD_NUM_LOCK UINT32_C(128)

#define OT_INPUT_KEY_KITTY UINT32_C(1)
#define OT_INPUT_KEY_TEXT_TRUNCATED UINT32_C(2)
#define OT_INPUT_PASTE_START UINT32_C(1)
#define OT_INPUT_PASTE_END UINT32_C(2)
#define OT_INPUT_REPLY_FRAGMENT UINT32_C(1)
#define OT_INPUT_REPLY_CURSOR_POSITION UINT32_C(2)

#define OT_INPUT_REPLY_CSI UINT32_C(1)
#define OT_INPUT_REPLY_SS3 UINT32_C(2)
#define OT_INPUT_REPLY_OSC UINT32_C(3)
#define OT_INPUT_REPLY_DCS UINT32_C(4)
#define OT_INPUT_REPLY_APC UINT32_C(5)

/* Key codes are Unicode scalars; functional keys use the Kitty keyboard protocol
 * assignments. Escape, Enter, Tab, and Backspace are 27, 13, 9, and 127. */
#define OT_INPUT_KEY_ESCAPE UINT32_C(27)
#define OT_INPUT_KEY_ENTER UINT32_C(13)
#define OT_INPUT_KEY_TAB UINT32_C(9)
#define OT_INPUT_KEY_BACKSPACE UINT32_C(127)
#define OT_INPUT_KEY_INSERT UINT32_C(57348)
/* ... one define per row of §7.6 through OT_INPUT_KEY_ISO_LEVEL5_SHIFT UINT32_C(57454) ... */
#define OT_INPUT_KEY_F1 UINT32_C(57364)      /* F(n) is 57363 + n, n in 1..35 */
#define OT_INPUT_KEY_KP0 UINT32_C(57399)     /* KP(n) is 57399 + n, n in 0..9 */

#define OT_INPUT_EXPECT_REPLIES UINT32_C(1)
#define OT_INPUT_EXPECT_KITTY_KEYBOARD UINT32_C(2)

#define OT_INPUT_EVENTS_MIN UINT32_C(4)
#define OT_INPUT_PAYLOAD_BYTES_MIN UINT32_C(4384)
#define OT_INPUT_TIMEOUT_NS UINT64_C(20000000)

/* One parsed input event. raw and text are byte spans into the payload buffer of
 * the same call. kind selects the meaning of action, code, x, and y (see docs). */
typedef struct ot_input_event {
    uint8_t kind;
    uint8_t action;
    uint8_t modifiers;
    uint8_t flags;
    uint32_t code;
    uint32_t base_code;
    uint16_t x;
    uint16_t y;
    uint32_t raw_offset;
    uint32_t raw_len;
    uint32_t text_offset;
    uint32_t text_len;
} ot_input_event;

/* Initialize struct_size and abi_version. The remaining fields are output-only.
 * consumed is the number of input bytes parsed; call again with the rest when it
 * is less than byte_count. deadline_ns is nonzero when a partial unit waits for
 * the timeout: call feed with zero bytes at or after it. discarded is a
 * saturating lifetime count of overlong units dropped. */
typedef struct ot_input_drain {
    uint32_t struct_size;
    uint32_t abi_version;
    uint32_t consumed;
    uint32_t count;
    uint32_t payload_len;
    uint32_t discarded;
    uint64_t deadline_ns;
} ot_input_drain;

/* Parse terminal input into events written to caller-owned records and payload.
 * bytes may be NULL only when byte_count is zero; zero bytes only resolves the
 * timeout. now_ns is a host monotonic clock in nanoseconds that must not go
 * backwards across feeds; it is independent of the pump clock. capacity must be
 * at least OT_INPUT_EVENTS_MIN and payload_capacity at least
 * OT_INPUT_PAYLOAD_BYTES_MIN; the call consumes input until either runs low and
 * reports consumed. Records and payload are borrowed for the call and never
 * retained. bytes, records, payload, and out_drain must not overlap. Accepted in any open session state; closing, closed, failed, and
 * cancelled sessions reject. No allocation, no I/O. */
ot_status ot_session_input_feed(
    ot_context *context,
    const ot_handle *session,
    const uint8_t *bytes,
    uint32_t byte_count,
    uint64_t now_ns,
    ot_input_event *records,
    uint32_t capacity,
    uint8_t *payload,
    uint32_t payload_capacity,
    ot_input_drain *out_drain);

/* flags is a combination of OT_INPUT_EXPECT_* bits; other bits must be zero.
 * Set REPLIES while any query is outstanding, including the capability queries
 * that setup and resume publish. It keeps a partial CSI reply waiting past the
 * timeout, and it makes a complete CSI 1 ; N R (N >= 2) a CURSOR_POSITION reply
 * instead of a modified F3 key. KITTY_KEYBOARD keeps a partial Kitty key waiting;
 * the session also applies it while its terminal has Kitty keyboard enabled.
 * Changing flags emits nothing; the next feed resolves a unit that may no longer wait. */
ot_status ot_session_input_expect(ot_context *context, const ot_handle *session, uint32_t flags);

#define OT_INPUT_RESET_KEEP_REPLY UINT32_C(1)

/* Drop any partial unit and mouse button state. Expectations are kept. flags is
 * 0 or OT_INPUT_RESET_KEEP_REPLY. Call with KEEP_REPLY after feeding the input
 * drained on resume: then a partial CSI unit that may begin a reply survives
 * while REPLIES is set, and waits for its rest without a deadline. */
ot_status ot_session_input_reset(ot_context *context, const ot_handle *session, uint32_t flags);
```

### 11.2 Statuses

| Status                                                                      | When                                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OT_INVALID_ARGUMENT`                                                       | null pointers with nonzero counts, `capacity < OT_INPUT_EVENTS_MIN`, `payload_capacity < OT_INPUT_PAYLOAD_BYTES_MIN`, wrong `struct_size`/`abi_version`, unknown `expect` bits, non-monotonic `now_ns`. |
| `OT_UNSUPPORTED_VERSION`                                                    | `abi_version` mismatch (as other records).                                                                                                                                                              |
| `OT_SESSION_CLOSED`                                                         | closing, closed, or cancelled session.                                                                                                                                                                  |
| `OT_OUTPUT_FAILED`                                                          | failed session (`SessionFailed`, as every session call).                                                                                                                                                |
| `OT_STALE_HANDLE`, `OT_WRONG_CONTEXT`, `OT_WRONG_THREAD`, `OT_CONTEXT_BUSY` | as every session call.                                                                                                                                                                                  |

A rejected call leaves `out_drain`, the records, and parser state unchanged.

With buffers at exactly the minimums, a call makes progress one event at a time: after one event the
sink no longer has room for a byte's worst case. A call that resolved an expired unit into a full
sink can consume no bytes; hosts loop until `consumed` covers the input, and treat a call that
consumed nothing and reported nothing as a bug.

### 11.3 Expectations mapping from Core

| Core `StdinParserProtocolContext` field                                                                            | New                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kittyKeyboardEnabled`                                                                                             | `OT_INPUT_EXPECT_KITTY_KEYBOARD` (plus the terminal-state OR).                                                                                                            |
| `privateCapabilityRepliesActive`, `explicitWidthCprActive`, `startupCursorCprActive`, `pixelResolutionQueryActive` | `OT_INPUT_EXPECT_REPLIES`, set when any query is outstanding, cleared when the last one completes or times out. The Rust port made the same reduction (`cursor_reports`). |

### 11.4 ABI plumbing

- `src/context-input-abi.zig` with the three exports, following `context-terminal-abi.zig`
  (`abi.sessionContextStatus`, `transport.record`, `fail`). `comptime` assert `@sizeOf(Event) ==
@sizeOf(c.ot_input_event)` and every `@offsetOf`.
- Register in `context-abi.zig`'s `abi_modules` (the export list `lib.zig` reaches) and in `test.zig`.
- `scripts/native-abi-pointers.ts`: `ot_session_input_feed: { 0: context, 1: buffer, 2: empty,
5: buffer, 7: buffer, 9: buffer }`, `ot_session_input_expect: { 0: context, 1: buffer }`,
  `ot_session_input_reset: { 0: context, 1: buffer }`.
- From `packages/core`: `bun run generate:abi`, `bun run check:abi`, `bun run test:abi`.
- `src/tests/context-abi.c` fixture: record sizes, prototypes, and a feed/expire/expect/reset run
  through the static and shared libraries (`zig build test-abi`).

### 11.5 Lifecycle

- Feed is accepted in every lifecycle phase of an open session, including `setting_up` (replies
  arrive then) and `suspended`.
- Suspend does not reset the parser. The adapter stops input time while suspended: no timer runs
  and `now_ns` holds, so a unit pending at suspension (even a lone `ESC` that begins a
  pixel-resolution reply) still completes with the bytes drained on resume. After that drain, input
  sent before suspension has arrived, and another process (a shell, an editor) may have read the
  rest of a pending paste, mouse report, or key. The adapter calls
  `ot_session_input_reset(…, OT_INPUT_RESET_KEEP_REPLY)`: it drops the pending unit, unless REPLIES
  is set and the unit is a CSI that may begin a reply (the shapes §6.3 defers for REPLIES). That unit
  becomes deferred and waits for its rest. Otherwise an open paste would swallow all later typing,
  and a deferred mouse prefix would swallow typed digits. This replaces
  `hasPendingPixelResolutionResponse` and its pause/reset dance; the parser knows reply shapes, not
  pixel replies.
- `ot_terminal_flush_input` is unrelated: it discards OS-level unread bytes at shutdown.
- `ot_session_destroy` frees nothing for the parser.

### 11.6 Later: native reply routing

Once the adapter is the only consumer, `Session.feedInput` can recognize capability replies (the
shapes `applyCapabilityResponses` already validates) and apply them without a round trip. That
changes output admission (`enableDetectedFeatures` writes a packet) and is deliberately not part of
this design. Replies stay events.

---

## 12. TypeScript adapter

File: `packages/core/src/lib/stdin-parser-native.ts` (`NativeStdinParser`) during migration; it
replaces `stdin-parser.ts` at the end (§14). It keeps the surface `renderer.ts` uses: `push`, `read`,
`drain`, `flushTimeout`, `reset`, `destroy`, and `updateProtocolContext`, and adds `suspend` and
`resume` (§11.5). It drops `abortPendingStartupCursorCpr`, `pausePendingTimeout`,
`resumePendingTimeout`, `hasPendingPixelResolutionResponse`, and `resetMouseState`; while the legacy
parser is the default, the renderer calls those only on a legacy parser.

The constructor takes the legacy options it needs (`armTimeouts`, `onTimeoutFlush`,
`protocolContext`, `clock`) and an optional `session: { lib, context, session }`. The renderer passes
its `NativeSession`; without one the adapter owns a private Context and Session, which tests and
benchmarks use. `timeoutMs`, `maxPendingBytes`, and `useKittyKeyboard` are ignored (§6.4, §9,
§14.3).

A Session or Context that closes, fails, or is destroyed under the adapter ends parsing quietly:
`SessionClosed`, `OutputFailed`, `StaleHandle`, and `WrongContext` stop the timer, and later calls
report no events. Renderer teardown updates the protocol context after its Context is gone.

### 12.1 Buffers and loop

One `Uint8Array` of 64 × 32 bytes for records (with `Uint32Array`/`Uint16Array` views over it,
offsets from the generated `ot_input_event` layout) and one 16 KiB payload `Uint8Array`, allocated
once. `push(data)`:

```
offset = 0
while offset < data.length:
    feed(data.subarray(offset), now, records, payload, drain)   -- portable FFI: pass views as `buffer`
    translate drain.count records into StdinEvent objects (copying raw/text out of payload)
    offset += drain.consumed
arm or clear the timer from drain.deadline_ns
```

`now_ns` is the renderer `Clock`'s milliseconds in nanoseconds, held monotonic (a clock that steps
back keeps the last time). `flushTimeout(now)` is `feed(empty, now)`. `updateProtocolContext` sets the
expectations and then feeds zero bytes, so a unit that can no longer wait resolves at once, as the
legacy parser did. Its callers need not drain: when that feed resolves anything, a zero-delay timer
delivers it through `onTimeoutFlush`, as a legacy timeout would. The timer uses the renderer's `Clock` and calls `onTimeoutFlush` (the renderer's
`drainStdinParser`) after a flush. A firing timer is the host's statement that the deadline passed:
it feeds at `max(now, deadline_ns)`, so a clock sample that disagrees slightly with the timer cannot
leave a unit stuck.

`OTUI_NATIVE_INPUT_SHADOW` runs the other parser on the same input and logs one
`[stdin-shadow] legacy=… native=…` line per event that differs (`StdinShadowComparator`). Events pair
in order, so the two parsers' separate timers cannot misalign them. After a difference, the next event
on each side tells an extra event (one line with `none` on the other side) from a changed one, and
pairing resumes. A side that stops producing events is bounded at 256 queued events.

### 12.2 Event translation

| Native  | `StdinEvent`                                                                                                                                                                                                                                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KEY`   | `{ type: "key", raw, key: ParsedKey }` (§12.3)                                                                                                                                                                                                                                                                                                                              |
| `MOUSE` | `{ type: "mouse", raw, encoding: raw[2] === "<" ? "sgr" : "x10", event: RawMouseEvent }` with `type` from action (`down`/`up`/`move`/`drag`/`scroll`), `button` (Core's numbers: no button is 0 for SGR and -1 for X10; scroll is 0 for X10 and for SGR right, else the direction; extra buttons 8+ pass through), `x`, `y`, `modifiers`, `scroll: { direction, delta: 1 }` |
| `PASTE` | accumulate text chunks from `START` to `END`; emit one `{ type: "paste", bytes }` at `END`                                                                                                                                                                                                                                                                                  |
| `FOCUS` | `{ type: "response", protocol: "csi", sequence: raw }` (the existing `focusHandler` matches the raw string; no behavior change)                                                                                                                                                                                                                                             |
| `REPLY` | `{ type: "response", protocol, sequence: latin1(raw) }`; `protocol` is `"cpr"` when `CURSOR_POSITION`, `"unknown"` when `FRAGMENT` or SS3, else the native protocol name                                                                                                                                                                                                    |

### 12.3 `ParsedKey` from a native key

| `ParsedKey` field                                        | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                   | Functional code → the Kitty name table already in `parse.keypress-kitty.ts` (`up`, `f1`, `kp0`, `mediaplay`, `leftshift`, …; 57427 → `clear`). `27` → `escape`, `13` → `return`, `9` → `tab`, `127` → `backspace`. Legacy raw `"\n"` → `linefeed` (Core distinguishes it). `32` → `space`. Text-only (`code 0`) → the text. Otherwise the character; a raw (non-Kitty) ASCII uppercase letter sets `shift = true` and, without Alt, names the lowercase key (Core's legacy heuristic: Alt+`A` stays `A`). |
| `ctrl`, `shift`, `super`, `hyper`, `capsLock`, `numLock` | modifier bits                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `meta`                                                   | `alt \|\| meta` bits (Core's `meta` is the Alt path)                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `option`                                                 | `alt` bit from a Kitty key, a modifier parameter, or an `ESC ESC` key sequence; not from `ESC` + character (Core's rule)                                                                                                                                                                                                                                                                                                                                                                                  |
| `sequence`                                               | `text` when nonempty, else `raw`                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `raw`                                                    | `raw` (UTF-8 decoded); a lone eight-bit Alt byte is spelled `ESC` + ASCII, as Core did                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `number`                                                 | `name` is one ASCII digit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `eventType`                                              | `release` for action 3, else `press`; `repeated = action === 2`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `source`                                                 | `KITTY` flag ? `"kitty"` : `"raw"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `baseCode`                                               | `base_code` when nonzero                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `code`                                                   | Compatibility only: derived from `raw` as Core did (`[A`, `OP`, `[15~`, `[57364u`). Consumers (`EmbeddedTerminal.physicalKey`, issue 067) should move to the numeric key code.                                                                                                                                                                                                                                                                                                                            |

`matchesKeyBinding` and `KeyHandler` need no change. Issue 050's fix stays in
`keybinding.internal.ts` (fall back to `baseCode` only for non-ASCII typed characters).

### 12.4 Renderer changes

- `CliRendererConfig.experimental_nativeInput` (default `OTUI_NATIVE_INPUT_PARSER`, false) selects
  the parser. The legacy context fields map to the expectation bits in the adapter (§11.3), so the
  renderer's `updateProtocolContext` calls stay as they are.
- `abortSplitStartupCursorSeed` calls `abortPendingStartupCursorCpr` only on a legacy parser: for
  native, a stale CPR is a `response` that `processCapabilitySequence` consumes only while a seed is
  pending.
- `suspend`/`finishResume`: a native parser gets `suspend()` and, after the resume drain of
  `stdin.read()`, `resume()` (§11.5); a legacy parser keeps its `pausePendingTimeout`/`reset` dance.
- `disableMouse` and `resize` call `resetMouseState` only on a legacy parser: native mouse decoding
  is stateless.
- `enableKittyKeyboard`/`disableKittyKeyboard`: set the expectation bit; native also derives it.

---

## 13. Test plan

Layers, narrowest first (`bun run test:native -Dtest-filter="input parser"` while iterating).

### 13.1 Zig unit tests (`tests/input-parser_test.zig`)

Table tests over `(bytes, expected events)`, ported from `opentui-rust/.../core_tests.rs`, which
is already Core's `parse.keypress.test.ts`, `parse.keypress-kitty*.test.ts`, `parse.mouse.test.ts`,
and `stdin-parser.test.ts` translated to typed events. Groups:

- text, controls, UTF-8, eight-bit Alt; Alt prefixes; `ESC`/`ESC ESC` timeouts (G8, G10; 044,
  046, 047)
- legacy CSI/SS3 letters, tildes, modifiers, rxvt, Linux console, keypad
- modifyOtherKeys and Kitty: modifiers, event types, text, shifted/base, the 111 functional codes
  (`kitty_protocol_functional_keys`), aliases, non-scalar → reply
- mouse: SGR and X10 tables, wheel release → reply (048), past-end `0x00` → 223 (049), URxvt
  motion+wheel, extra buttons, split reports, recovery after a timed-out `ESC`
- replies, focus, paste (split markers at every boundary, 100 KiB payload streamed, markers inside
  the payload, empty paste), fragments on `ESC` and control bytes, overlong CSI and string → discard
- deferral matrix: `(expect, head, tail, expected)` with a manual clock (§6.6)
- timeouts: 19 ms silent, 1 ms more; keep-alive byte every 15 ms through a 14-byte reply

Property checks:

- **Split invariant (G1):** every vector fed whole, byte at a time, and at every two-chunk split
  yields the same events after joining paste records.
- **Sink backpressure (G5):** feed with a sink of exactly `OT_INPUT_EVENTS_MIN` records and
  `OT_INPUT_PAYLOAD_BYTES_MIN` bytes; loop on `consumed`; the concatenated output equals the
  unconstrained output.
- **Accounting (G3):** for random byte streams fed at one time (so no Escape is recovered),
  `sum(raw_len) + sum(paste text) + 6 per paste marker + pending unit == input length` after a final
  expire, with no discarded units.
- **Reflection:** every `State` tag is reached by the vectors (observed after each byte, without a
  debug hook in the module); every functional key code in §7.6 decodes (Zig) and names (TypeScript).

### 13.2 ABI tests (`context-input-abi.zig` test blocks)

Malformed records, wrong thread, stale and foreign handles, capacity minimums, zero-byte expire,
non-monotonic clock, closed session, `expect` with unknown bits. `check:abi --all-targets` for
layout.

### 13.3 TypeScript

- `stdin-parser.test.ts` runs its matrix against both implementations (`defineStdinParserSuite`);
  expected differences use `either(legacy, native)` and cite §14.3, and tests of the hooks native
  removed run for the legacy parser only. The shared timeout is 20 ms.
- `stdin-parser-native.test.ts` asserts every §14.3 difference side by side, replays representative
  input streams (typing, editing keys, startup replies, selection drags, scrolling, X10, focus,
  pastes, Kitty, modifyOtherKeys) through both parsers in uneven reads and requires the
  `StdinShadowComparator` to report nothing, and covers the adapter itself (naming, suspension,
  closed Sessions, early timers). The repository has no committed `OTUI_STDIN_LOG` captures; new
  captures can join the replay table.
- `mock-keys.ts` and `mock-mouse.ts` drive `TestRenderer` through the real parser; the existing
  renderable test suites are the integration check. `OTUI_NATIVE_INPUT_PARSER=1 bun test` runs them
  through the native parser; `renderer.input.test.ts` asserts the native side of §14.3 where its
  expectations differ.

---

## 14. Migration

### 14.1 Phases

1. **Core module.** `input-parser.zig` with the full decoder and the Zig tests. No ABI. Mergeable
   alone.
2. **Session and ABI.** `Session.input`, `context-input-abi.zig`, header, pointer policies,
   generated bindings, ABI tests.
3. **Adapter behind a flag.** `stdin-parser-native.ts`; `CliRendererConfig.experimental_nativeInput`
   (default false) and env `OTUI_NATIVE_INPUT_PARSER`; optional `OTUI_NATIVE_INPUT_SHADOW` that runs
   both and logs one line per mismatch. Port the TS tests to run under both.
4. **Flip and delete.** Default on; delete `stdin-parser.ts`, `parse.keypress.ts`,
   `parse.keypress-kitty.ts`, `parse.mouse.ts` and their tests; keep the name tables in the adapter.
   Update `packages/web` docs (`core-concepts/keyboard.mdx`, `native/*`).

### 14.2 Fixes that land with the parser

Issues 044, 046, 047, 048, 049 are fixed by construction; their repro scripts in
`opendocs/native-hardening/issues/repro/` become vectors. Issue 050 is a separate
`keybinding.internal.ts` change. Issues 066 and 067 (embedded terminal) become simpler with the
numeric key code.

### 14.3 Intentional behavior changes

| Before (Core)                                                       | After                                                            | Why                                                                            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `ESC` inside OSC/DCS/APC waits for the timeout.                     | Ends the string as a fragment; `ESC` starts a new unit.          | No reply contains a bare `ESC`.                                                |
| SGR motion is `drag` only after a seen press.                       | `drag` whenever the wire button bits say a button is held.       | Wire bits are authoritative; the renderer tracks capture.                      |
| Kitty `CSI u` decodes only when `useKittyKeyboard`.                 | Always decodes.                                                  | A terminal sends it only when asked; the `?`-prefixed flags reply is distinct. |
| `push(emptyChunk)` emits a key with an empty name.                  | Zero bytes only expires.                                         | Nothing on the wire, nothing to report.                                        |
| Unknown sequences become a key with an empty `name`.                | Reply events.                                                    | G2.                                                                            |
| Alt+uppercase sets `shift`.                                         | Same (adapter), native reports the character as sent.            | Wire fidelity in native; Core naming in the adapter.                           |
| CPR `CSI 1;N R` with N ≥ 2 is a capability signal in TS regexes.    | Native flags `CURSOR_POSITION`; TS keeps `isCapabilityResponse`. | No regex on the hot path; detection logic unchanged.                           |
| A lone byte that cannot start UTF-8 (`0xFF`) waits for the timeout. | An eight-bit Alt key at once.                                    | Only a lead byte can continue; nothing else can change the result.             |
| Only `explicitWidthCprActive` with first field 1 waits for a CPR.   | Any `row ; col` CPR waits while replies are expected.            | One `REPLIES` expectation (§11.3).                                             |
| X10 releases report button 0; extra buttons report 0 to 2.          | X10 releases report the last pressed button; extra buttons 8+.   | X10 cannot say which button rose; extra buttons are not left clicks.           |
| Mouse reset on `useMouse` toggle or resize forgets a held button.   | No mouse state to reset; the next report's bits decide.          | Stateless decoding.                                                            |
| `CSI 25~` and other F13+ legacy forms have no name.                 | Named (`f13`, …) from the Kitty table.                           | One key table.                                                                 |
| `CSI 1 ; N R` (N ≥ 2) is always a cursor position report.           | Modified F3 unless replies are expected (§6.3).                  | xterm sends modified F3 so; hosts set `REPLIES` while they query the cursor.   |

---

## 15. Decision log

| Decision                                                          | Alternatives considered                                                                               | Reason                                                                                                                                                          |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session-owned parser, not a Context resource with its own handle. | `ot_input_parser_create/feed/destroy`.                                                                | Kitty state lives in `renderer.terminal`; one fewer handle; the pump clock is already there. A standalone object can be added later by lifting the same struct. |
| Synchronous feed into caller-owned records.                       | Internal event queue plus a drain call.                                                               | Zero internal event storage, natural backpressure via `consumed`, no overflow policy to invent.                                                                 |
| Streamed paste records.                                           | One paste event with a native buffer bounded by a `paste_bytes_max`.                                  | G4 without an allocator; the TS side already joins parts.                                                                                                       |
| Kitty functional codes as the key enum.                           | Private enum above 0x10FFFF; W3C key strings.                                                         | One table shared by the wire protocol, native, and the existing TS name map.                                                                                    |
| One `text` span per key event.                                    | One event per Kitty text codepoint (Rust port).                                                       | Core's `sequence` is the joined text; bounds `events_per_byte_max`.                                                                                             |
| 20 ms constant timeout.                                           | Option per session.                                                                                   | Core never exposed a knob; add one only with a user need.                                                                                                       |
| Deadlines on `discard`.                                           | Wait for the terminator.                                                                              | A corrupt stream must not swallow typing forever; 20 ms of silence is the signal.                                                                               |
| Replies stay host-routed.                                         | Native applies capability replies in `feed`.                                                          | Keeps output admission out of input; §11.6 for later.                                                                                                           |
| X10 release reports the last pressed button.                      | Always button 0 (Core).                                                                               | X10 cannot say which; last-pressed is the useful guess and what the Rust port does.                                                                             |
| Input feeds keep their own monotonic clock.                       | Share the pump's `last_pump_ns`.                                                                      | The host arms input timers on a different clock than its pump (§10.6); deadlines are relative to the parser's own `since_ns`.                                   |
| The adapter stops input time while suspended.                     | Reset on suspend (Core); expire everything on suspend.                                                | A unit pending at suspension completes with the bytes drained on resume (§11.5).                                                                                |
| Resume resets the parser but keeps a reply prefix (`KEEP_REPLY`). | Resolve stale units at their deadline (lets a paste or mouse prefix outlive the drain); a full reset. | After the drain nothing from before suspension can complete a paste, mouse report, or key, but an awaited reply may still arrive (§11.5).                       |

---

## 16. References

- `opendocs/stdin-refactor/references.md` (the collected reading list), `stdin-architecture.md`,
  `crossterm-comparison.md`, `codex-comparison.md`, `neovim.md` (libtermkey driver chain).
- `opendocs/native-hardening/issues/044..050-*.md` and `repro/`.
- `opentui-rust/crates/opentui/src/input/{parser.rs,event.rs,core_tests.rs}`.
- `packages/core/src/lib/{stdin-parser,parse.keypress,parse.keypress-kitty,parse.mouse}.ts` and
  tests; `packages/core/src/lib/terminal-capability-detection.ts`; `packages/core/src/renderer.ts`
  (`handleStdinEvent`, `processCapabilitySequence`, `setupTerminal`).
- `packages/native/src/{session.zig,terminal.zig,ansi.zig,context-terminal-abi.zig}`,
  `include/opentui.h` (`ot_diagnostic_drain`, `ot_session_pump`, `ot_session_control`),
  `packages/core/scripts/native-abi-pointers.ts`, `packages/native/README.md`.
- https://vt100.net/emu/dec_ansi_parser — Williams' DEC ANSI parser (grammar; not the input policy).
- https://invisible-island.net/xterm/ctlseqs/ctlseqs.html — PC-Style Function Keys, Mouse Tracking.
- https://sw.kovidgoyal.net/kitty/keyboard-protocol/ — `CSI u`, functional key codes, modifiers.
- https://github.com/neovim/libtermkey — timeout-driven input parsing reference.
- https://docs.rs/crossterm/latest/crossterm/ — `src/event/sys/unix/parse.rs`.
- https://linusakesson.net/programming/tty/ — raw mode and the line discipline.
- https://man7.org/linux/man-pages/man3/termios.3.html, https://man7.org/linux/man-pages/man5/terminfo.5.html.
- https://vtdn.dev/, https://terminalguide.namepad.de/ — compatibility matrices.
- https://github.com/contour-terminal/contour/blob/master/docs/vt-extensions/color-palette-update-notifications.md.
