# Split footer

`opentui::split` keeps an app in a footer at the bottom of the main screen
and writes scrollback above it, as OpenTUI Core's `CliRenderer` does with
`screenMode: "split-footer"` and `externalOutputMode: "capture-stdout"`.
OpenCode's `mini` (`packages/tui/src/mini`) is the user this note plans for.

The API is additive. Native code (`ot_session_render_split`,
`ot_session_split_control`, `ot_session_set_screen`) does the terminal work;
the Rust side ports Core's host-side state machine from `renderer.ts`.

## Layers

1. **Native calls** (`split/native.rs`). `Session::render_split` presents a
   footer draft and up to 64 `SplitSnapshot`s in one frame, or snapshots
   alone. `Session::split_control` takes a `SplitControl` (reset, sync,
   output offset, render offset, transition, clear transition).
   `Session::set_screen`, `Session::sync_detached`, and `Draft::copy_to`
   wrap the calls the footer and the writer need.
2. **`SplitFooter`** (`split/footer.rs`). Core's split bookkeeping: footer
   geometry, the snapshot queue (8 per frame, bounded by the write limit at
   24 bytes a cell), the tail column, deferred footer transitions, the
   startup cursor seed, replay resets, resize, and leaving for the main
   screen. Each method follows the Core function it names in a comment.
3. **`Host` integration** (`host.rs`). `HostOptions::split_footer = Some(rows)`
   attaches the renderer at the footer's size, never uses the alternate
   screen, and creates the Session's `SplitFooter`. The host then presents
   through it, seeds it from setup's cursor report (frames wait up to 120 ms
   for it, as in Core), resizes through it, reports footer height changes as
   `Event::Resize` with the renderer size, drains queued snapshots without a
   footer frame before suspension and close, and applies a pending `leave`
   at close. `Host::wants_frame` asks the app loop for frames while
   snapshots wait.
4. **`Scrollback`** (`split/scrollback.rs`). A detached app in the parent's
   Context paints widgets into snapshot buffers. `snapshot` is
   `writeToScrollback`; `surface` is `createScrollbackSurface` with `root`,
   `render`, `height`, and `commit_rows`. Snapshot frames leave unpainted
   cells empty (`FrameOptions::preserve_unwritten`), so rows end where the
   content does.

## How M.1 drives it

| `mini` (TypeScript)                                                                                                                                                                                  | Rust                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createCliRenderer({ screenMode: "split-footer", footerHeight: 4, externalOutputMode: "capture-stdout", useMouse: false, exitOnCtrlC: false, clearOnShutdown: false })` (`runtime.lifecycle.ts:161`) | `options.host.split_footer = Some(4)`, `options.host.terminal.mouse = MouseTracking::Off`, `exit_on_ctrl_c: false`; `clear_on_close` is already off. `SplitFooter::of(app.session())` and `Scrollback::new(&app)` after `App::new`.                |
| `renderer.writeToScrollback(write)` with a writer returning `{ root, width, height, rowColumns, startOnNewLine, trailingNewline }` (`scrollback.writer.tsx`)                                         | Build the widgets with `scrollback.app()`, then `footer.write(scrollback.snapshot(&root, SnapshotOptions { .. })?)`. The writer's `tailColumn` is `footer.tail_column()`. No `requestRender` is needed.                                            |
| `renderer.createScrollbackSurface({ startOnNewLine })`, `surface.render()`, `surface.commitRows(start, end, { trailingNewline })`, `surface.settle()` (`scrollback.surface.ts`)                      | `scrollback.surface(start_on_new_line)?`, add content to `surface.root()`, `surface.render()?`, then `footer.write` each `surface.commit_rows(start, end, None, trailing)?`. Highlighting is synchronous in opentui-rust, so `settle` is `render`. |
| `renderer.footerHeight = h` (`footer.ts:767`)                                                                                                                                                        | `footer.set_footer_height(h)`. It waits for queued snapshots, as Core's pending mode does; the app then gets `Event::Resize` with the footer's size.                                                                                               |
| `onResize` comparing `terminalWidth`/`terminalHeight` (`runtime.lifecycle.ts:355`)                                                                                                                   | `app.on_resize`, comparing `footer.terminal_size()`.                                                                                                                                                                                               |
| `renderer.resetSplitFooterForReplay({ clearSavedLines })` (`runtime.lifecycle.ts:381`, `footer.view.tsx:546`)                                                                                        | `footer.reset_for_replay(clear_saved_lines)`. Snapshots queued before it go first; later writes follow the reset.                                                                                                                                  |
| `shutdown`: `externalOutputMode = "passthrough"`, `screenMode = "main-screen"`, `destroy()`, then `"\n"` without an exit splash (`runtime.lifecycle.ts:100`, `:344`)                                 | `footer.leave()`, then `cx.quit()`. Close writes the queued snapshots, then leaves. Print the newline after `app.run()` returns.                                                                                                                   |
| Editor and suspension through the renderer                                                                                                                                                           | `app.release_terminal` or `app.suspend`: the host writes queued snapshots, suspends, and syncs the footer on resume.                                                                                                                               |

`examples/split.rs` is a small version of this: a prompt in a four-row
footer, Enter writes the line above, Ctrl+G changes the footer height, and
Ctrl+L replays the transcript.

## Not ported

- **Captured stdout.** Core diverts `process.stdout.write` into the
  scrollback, with `\r` handling, tab stops, and a byte bound. A Rust client
  writes scrollback through `SplitFooter::write`; nothing captures stdout.
- **`EXTERNAL_OUTPUT` events.** `mini` uses them only for `monoSnapshot`;
  M.1 should paint mono snapshots monochrome itself.
- **`claimFirstLineOffset`** for surface content that continues a row at the
  tail column. Use `SnapshotOptions { start_on_new_line: false, .. }` and
  `tail_column()` for one-row continuations.
- **Mouse rows.** Core shifts mouse events by the footer's offset and drops
  those above it. `mini` turns the mouse off; the host does not translate.
- **Entering split mode later.** A host starts in split mode and can leave
  it once; Core can also switch into it at run time.

## Proof

`tests/fixtures/split/render.ts` drives Core's renderer (the `@opentui/core`
OpenCode's `packages/tui` uses) through five cases and records each step's
terminal bytes. `tests/split.rs` drives `opentui::split` through the same
steps on a remote terminal: footer frames, writes, growing and shrinking,
changes that wait for queued rows, there-and-back transitions, resizes
including a narrower terminal, tail-column joins, replay, surfaces, eight
rows per frame, draining at close, and leaving. Every step's bytes match
Core's exactly, and an embedded terminal shows the same screen and
scrollback for both. One more test runs an `App` in split mode on a remote
terminal.
