# Plan: make `opentui-rust` a Rust TUI framework built on OpenTUI

The goal is a framework crate with a retained, imperative API. The UI runs on
one thread; an optional `tokio` feature comes at the end.

## Where things stand

- This repo started as a small safe binding: 31 of the header's ~234 C
  functions. It tied owners together with lifetimes
  (`Node<'session, 'context>`). The examples used a C terminal shim
  (`examples/terminal.c`) and an ASCII-only key parser.
- OpenTUI's `main` branch has the native render tree since commit
  `c1bb64ba1` (#1479). The bindings are generated from the header at commit
  `ec4742c4c`.
- Native code already provides:
  - A retained scene with these node kinds: box, text, slider, arrow, editor,
    custom, text view, and image.
  - Yoga layout, painting, diff encoding, the output queue, and hit testing.
  - Text selection, edit buffers with undo, text buffers with highlights, and
    images (kitty, sixel, or blocks).
  - An embedded terminal, clipboard, notifications, and capability detection.
  - An input parser, since `0915c5af1` (#1592).
  - A scroll control: a box that scrolls its children, with sticky edges and
    scrollbars, since `9a52b652a` (#1798).
  - A video node that decodes with FFmpeg, since `b8032e26a` (#1800), and
    crops for image and video nodes, since `9b7d5fb7e` (#1888).
- The host must:
  - Read the terminal and feed the bytes to the native input parser, which
    reports keys, mouse, paste, and focus events, and terminal replies.
  - Pick out terminal replies and pass them back through `ot_session_control`.
  - Schedule frames and timers, route events, and decide focus and widget
    behavior.
  - In OpenTUI Core this is TypeScript: `stdin-parser.ts`,
    `parse.keypress*.ts`, `parse.mouse.ts`, `renderer.ts`, and
    `renderables/*`.

## What an app should look like

```rust
let app = App::new(AppOptions::default())?;
let status = Text::new(&app, "Ready").fg(Color::rgb(104, 211, 168));
let list = Select::new(&app).items(["Build", "Test", "Ship"]).grow(1.0);
app.root().add(&View::new(&app).border(Border::Rounded).title(" Tasks ").padding(1).child(&list));
app.root().add(&status);
list.on_select({ let status = status.clone(); move |_cx, item| status.set_text(format!("Selected {item}")) });
app.on_key(|cx, key| if key.matches("q") || key.matches("ctrl+c") { cx.quit() });
app.focus(&list);
app.run()
```

Principles:

- Native code owns layout, painting, encoding, and cell widths. Rust never
  recomputes widths.
- Widgets are handles you keep and change. Each change marks the frame as
  needing a redraw.
- Handles stay on the UI thread. Other threads reach the UI through a proxy.
- Every queue and buffer has a size limit. The terminal is restored after a
  panic, a signal, or an error.
- Tests run without a terminal, using a fake clock and text snapshots of each
  frame.

## Crate layout

```
crates/opentui-sys/   generated raw FFI + linking (build.rs, links = "opentui")
crates/opentui/
  native/     safe owners: Context, Session, Node, Buffer, TextBuffer, EditBuffer, Image, ...
  frame.rs    frame driver + paint recorder
  term/       raw mode, signals, size, poll, output (pure Rust; replaces terminal.c)
  remote.rs   RemoteTerminal and RemoteLink: a terminal at the other end of a connection
  input/      bytes -> Key / Mouse / Paste / Focus events, plus terminal-reply routing
  app.rs      App, run loop, timers, cross-thread proxy
  style.rs, layout.rs, widget/, testing.rs
crates/opentui-ssh/   serve apps over SSH with russh, one App per session thread
```

## Phases

### 0. Generate the FFI layer

- OpenTUI's `compileHeader()` returns every function signature, callback type,
  struct layout, and constant. Generate from it:
  - All structs, with `Default` filling in `struct_size` and `abi_version`.
  - All function declarations.
  - Constants with the correct signed or unsigned type.
  - Compile-time size and offset checks, which replace the C probe in
    `tests/abi.c`.
- Check the library's ABI version at runtime.
- Fail the build when the generated file is older than the header.
- Done when the tests pass with both shared and static linking.

### 1. Safe native layer

- Replace the lifetime chain with reference-counted ownership, so user code
  has no lifetime parameters. Keep handles single-threaded, and abort when
  native cleanup fails unexpectedly.
- Add an error type that names every `OT_*` status code.
- Wrap each area of the ABI:
  - Session lifecycle and output.
  - All node kinds, styles, text, selection, and hit tests.
  - A frame driver over `ot_scene_frame_step_with_geometry`. `ot_scene_paint`
    rejects paint hooks, so custom widgets need this path.
  - An encoder for paint recordings (`ot_scene_record_*`).
  - Buffers, scoped cell access, text and edit buffers, images, and the
    embedded terminal.
- Native callbacks carry no user-data pointer. Measure callbacks and edit
  events need a per-thread table keyed by handle. Edit events are queued and
  handled after the native call returns.
- Done when `tasks` and `workbench` work on this layer with the same behavior.

### 2. Terminal host and run loop

- Write the terminal layer in Rust: raw mode, non-blocking output, signals
  (window resize, INT, TERM, HUP, Ctrl-Z suspend and resume), and one `poll()`
  loop.
- Send output with `ot_session_drain_stdout`, which needs no copy. A
  `Transport` trait covers tests and custom destinations.
- Handle the full lifecycle:
  - Setup: alternate screen, mouse, Kitty keyboard.
  - Suspend and resume.
  - Close: keep pumping until the terminal is restored, then flush leftover
    input.
  - Panics and signals use `ot_session_pump_exit` as the fallback.
- Draw a frame only when something changed and no earlier frame is still being
  written. Cap the frame rate and merge bursts of resizes.
- Done when a hello app leaves the terminal usable after a panic,
  `kill -TERM`, a hangup, and Ctrl-Z.

### 3. Input

- Port Core's parsing code to Rust (about 3,300 lines of TypeScript): Kitty
  and legacy keys, SGR and X10 mouse, bracketed paste, focus events, and
  terminal replies routed to capability detection, the Kitty image protocol,
  palette, and pixel-size handling.
- Use full UTF-8, Core's 20 ms Escape timeout, and a 64 KiB limit on pending
  bytes.
- Port Core's tests as test cases. Add a random-input test for no panics and
  bounded memory.

### 4. Framework core

- `App` owns the Context, Session, terminal, root node, focus state, and
  timers.
- Each widget is a cheap `Clone` handle backed by `Rc`. A parent keeps its
  mounted children alive. A detached node is destroyed when its last handle
  drops. Native handles carry a generation, so using a destroyed widget
  returns an error, never undefined behavior.
- Setters call native code right away. Core's batching (`ot_scene_flush`) is
  not planned; see "Still to do".
- Typed layout options, colors (RGB, indexed, default), text attributes,
  styled text, and a theme.
- Events: tab order and focus; keys go to the focused widget, then its
  parents, then the app; mouse events use hit tests, drag capture, hover, and
  scroll.
- A `Widget` trait for custom widgets with paint hooks and optional
  measurement.
- Timers, animation frames, and a `Send` `AppProxy` that wakes the loop.

### 5. Widgets

Each widget gets snapshot tests and an example.

- Tier 1: `View` (box), `Text`, `ScrollBox` with a scrollbar, `Input`,
  `Textarea`, `Select`, `TabSelect`, `Slider`.
- Tier 2: `Code`/`TextView` with syntax styles, `Image`, `Canvas`, `Table`.
- Tier 3: `Markdown`, `Diff`, embedded `Terminal`, optional tree-sitter.
- Mouse text selection and copy through OSC 52 or the system clipboard.

### 6. Testing, docs, polish

- `testing::TestApp`: no terminal, byte or event input, a fake clock, and text
  and style snapshots.
- Terminal smoke tests, benchmarks against Core, full rustdoc, a guide, and a
  reworked workbench as the main demo.
- A CI script: fmt, clippy, tests with both linkages, and the generated-file
  check.

### 7. Optional `tokio` and more platforms

- A `tokio` feature that posts task results back to the UI thread. The main
  loop stays synchronous.
- Later: macOS, Windows, an inline footer mode, and SSH output.

## First milestone

Phases 0-2: the generated FFI, the reference-counted safe layer, the Rust
terminal host, and a hello app with a box, text, and a quit key.

## Status

Milestones 1 to 3 are done. `sh test.sh` passes with shared and static
linking, including 18 pseudo-terminal lifecycle scenarios.

Milestone 3 closed the gaps between the Rust widgets and Core's:

- Key bindings: `Shortcut`, `Keymap`, and an action enum per widget
  (`EditorAction`, `SelectAction`, `TabSelectAction`, `SliderAction`,
  `ScrollAction`, `TableAction`) with `bind`, `unbind`, `set_keymap`, and
  `perform`. Key events carry Kitty's base-layout key, used only for non-Latin
  characters. Core does the same since `7e8024f8c`, and since `2b27109d2` also
  uses a digit base key, for the digit row of layouts such as AZERTY.
- Mouse selection across widgets, ported from Core's renderer: one selection
  over every selectable widget it covers, within a container that widens as
  the pointer leaves it; double and triple clicks for words and lines;
  Ctrl+click to extend; `App::on_selection`; auto-scroll while dragging past a
  scroll box's edge.
- Theme: `App::new` asks the terminal for its background (OSC 10/11) and picks
  `AppOptions::light_theme` on light backgrounds; `Event::ThemeMode` and
  `App::on_theme_mode` report later changes.
- Clipboard: native's host clipboard service, polled from the event loop, for
  `App::read_clipboard`, `App::read_clipboard_as` (by MIME type),
  `App::paste_from_clipboard`, `EditorAction::Paste`, and as a second copy
  destination on local sessions.
- `LineNumbers` (Core's gutter beside a `Code` view or `Textarea`) and `Diff`
  (unified and split views, synced scrolling).
- `ScrollBox`: pluggable wheel acceleration (`LinearScroll`, `MacOsScroll`),
  sticky edges with `sticky_start`, and scrollbar arrow buttons.
- `TextTable`, a port of Core's `TextTableRenderable`: a measured node that
  sizes itself for the width it gets, with one native text buffer and view per
  cell (wrapping, wide characters, links, measurement, and selection all
  native) and grid lines drawn by native `drawGrid` through a paint recording.
  Core's column sizing (content and full widths, the proportional and balanced
  fitters), padding, gaps, inner and outer borders, and its cell, column, and
  grid selection modes are ported; its frame snapshots match. It is the
  building block for Markdown tables.
- `Markdown`: a block tree (nested lists, quotes holding blocks, setext
  headings, indented code, hard breaks, GFM tables drawn with `TextTable`,
  autolinks, bare URLs, images as alt text), with incremental updates for
  streamed text (`Markdown::append`, `Markdown::streaming`), conceal on and
  off, code-block renderers, and Core's table options. Frames of a small
  corpus match Core's top-level mode (`crates/opentui/docs/markdown.md`).
- Extmarks on `Input` and `Textarea`: styled ranges and atomic tokens that
  move with edits, as Core's `ExtmarksController` keeps them.
- Animation: `Timeline`, `Tween`, and `Easing` port Core's `Timeline` (all 16
  easings, positions, loops with delays and alternation, synced child
  timelines, `once`, pause, play, and restart) and add `seek`. Timelines run
  on `App::animate`.
- Post-processing: the `post` module ports Core's 14 color matrices, its
  filters, and its effects as `Filter`s that `Widget::filter` attaches to a
  widget's painted area or the root's whole screen. They run on the painted
  draft before it is presented: matrices through native
  `ot_buffer_color_matrix`, cell work through a frame lease, ASCII art through
  native packed cells; a filter's paint hook reports the widget's clipped
  area. `Painter::color_matrix` records one in paint order. All of Core's
  filters and effects are ported and match its output (`tests/post.rs`).

- Benchmarks against Core: `scripts/core-bench.ts` runs the `bench` example's
  scenes on Core's test renderer. Scenes dominated by native work cost about
  the same; the host-painted `Select` is about 2.8 times faster from Rust.
- More of Core's surface: per-widget mouse pointer shapes, drag-over and drop
  events, the native debug overlay, the debug console (with `log` integration
  and stderr capture), palette detection, editor cursor options, custom border
  glyphs, and `Select::fast_scroll_step`.

Since milestone 3: `TerminalView`, a port of Core's
`EmbeddedTerminalRenderable` on native's embedded terminal (key, mouse, paste,
and focus encoding, scrollback, selection with words and lines, the real
cursor), with `pty::Pty` running programs on pseudo-terminals from a
background thread, and offscreen `native::Buffer`s that paint hooks draw with
`Painter::draw_buffer`. A focused terminal sends mouse presses to a program
that tracks the mouse instead of starting a selection, which Core does not.
Five OpenTUI bugs turned up on the way; OpenTUI has fixed four of them since.

A review of milestone 3 found 16 bugs, now fixed with tests in
`tests/regressions.rs` and the `term` and `host` unit tests. The notable
changes: extmarks measure edits as the native edit buffer does, so tabs and
grapheme clusters count as the cursor counts them; selection drags go to the
widget under the pointer, as in Core, so scroll boxes they cross auto-scroll;
`StderrCapture::stop` drains the pipe; a worker thread's panic leaves stderr
captured; a dropped `App` leaves the console; and Ctrl+press without a
selection starts none, as in Core.

The input parser now follows Core's timeout policy: a partial sequence whose
next byte takes more than 20 ms is reported as a reply, so Alt+[ or
Alt+Shift+P in a legacy terminal no longer swallow the input after them. As in
Core, partial mouse reports always keep waiting, and so do Kitty keys while
Kitty flags are on and replies while the host expects them, until a byte that
cannot continue them arrives. `FrameBuffer` ports Core's
`FrameBufferRenderable` on a native surface binding.

Syntax highlighting uses tree-sitter, behind the `tree-sitter` feature, in
place of the hand-written highlighter and the custom highlighter functions,
which are gone. The `syntax` module has Core's filetype resolution
(`resolve-ft.ts`), `SyntaxTheme` (what Core's TypeScript calls a
`SyntaxStyle`), a grammar registry with Core's default grammars plus Rust, and
`syntax::register` for others. `Code::filetype`, `Diff::filetype`,
`Textarea::filetype`, and Markdown fence tags select a grammar.
Like Core's parser worker, the engine runs each grammar's highlight query and
collects captures as named ranges, parsing injections recursively;
`tree-sitter-highlight` was tried and dropped, because its events attribute
same-offset captures of nested layers to the wrong ranges and it cannot keep
the anonymous children Markdown content needs.

macOS, on Apple chips and Intel, builds from the same sources. `build.rs`
picks the target's artifact directory and `libopentui.dylib`; static links add
the frameworks OpenTUI's macOS build uses. The POSIX layer replaces Linux-only
calls: `pipe` and `fcntl` for `pipe2`, the `TIOCPTYGNAME` ioctl for
`ptsname_r`, an `F_SETFD` loop for `close_range`, `__error` for
`__errno_location`. `term::poll` uses `select` on macOS, whose `poll` rejects
`/dev/tty`, the stdin `xargs -o` gives a program. From Linux, the crate
compiles, passes clippy, and links every test binary for both macOS targets
against a stub library (`-Zbuild-std`, with `zig cc` as C compiler and
linker), but nothing has run on macOS yet. `scripts/check-macos.sh` repeats
the compile and clippy part. OpenTUI's macOS build needs Apple's SDK, so the
native library has to be built on a Mac.

Windows 10 1809 or later, x86_64, with the MSVC or GNU toolchain, runs from
the same sources. `term` and `pty` are now shared modules with a backend per
platform. The Windows `term` backend sets the console to virtual terminal
input and output, so the parser reads the same sequences as on Unix; it reads
input records, turns window size records into resizes, reports Ctrl+Break and
console close, logoff, and shutdown as signals, waits on event objects with
one `WaitForMultipleObjects`, and captures stderr with `SetStdHandle`. `pty`
runs programs on ConPTY with a reader thread and a control thread. `build.rs`
links `opentui.dll` through `opentui.lib` and copies the DLL where `cargo run`
and `cargo test` find it. `sh test.sh` passes on a Windows 11 VM under Git
Bash, with a Windows build of the native library that Zig cross-compiles from
the current revision. The new `tests/lifecycle.rs` drives the `lifecycle`
example on a pseudo-terminal on every platform, and on Windows also checks
that the console modes are restored. `scripts/check-windows.sh` compile-checks
from other systems.

Decisions made for Windows:

- Static linking is not supported: OpenTUI's Windows archive is built for
  MinGW with libc++, which neither Rust Windows toolchain links.
- Ctrl+Z does not suspend by default (`AppOptions::suspend_on_ctrl_z` is off),
  and `Host::suspend` does nothing: Windows has no job control, and Ctrl+Z
  usually means undo there.
- A program still running 5 seconds after its pseudoconsole closes is ended,
  as Windows does after a console window closes. A program still starting can
  miss the close event; without this it kept running with no console, and
  dropping its `Pty` blocked until it exited.
- `Pty::signal(SIGINT)` types Ctrl+C. Programs inherit whether they ignore
  Ctrl+C, and spawning does not change that setting for the app's process.

SSH output works like Core's `@opentui/ssh`. In `opentui`, a `RemoteTerminal`
stands in for a terminal a transport reaches: the transport's `RemoteLink`
passes the client's input and size in and takes output out, through 256 KiB
buffers each way that apply backpressure instead of dropping bytes. `Host`
drives either the local terminal or a remote one; a remote host has no raw
mode, signals, panic hook, or stderr capture, so each thread can run its own
app, and dropping it (also in a panic) restores the remote terminal.
`App::remote` asks the client for its colors over the link, as `App::new` does
locally. The new `opentui-ssh` crate serves apps with russh: `serve` binds,
and each shell session gets a thread where the handler builds the app with
`Session::app` and runs it. It has open, public-key (any key, an
`authorized_keys` list, or a check), and password authentication, host keys
that are ephemeral, loaded or generated and saved, or given, idle and maximum
timeouts, per-connection and global session limits, a startup banner, an error
sink, and `Server::close`, which ends every app so it restores its client's
terminal before connections close. `tests/server.rs` drives it with russh's
client, and one test runs OpenSSH's client on a pseudo-terminal; the `chat`
example (`sh run.sh chat`) is a chat room across sessions. `sh test.sh` also
passes on the Windows VM, where a chat server served OpenSSH clients on Linux
and shut down cleanly on Ctrl+C. A review found seven bugs, now fixed, whose
tests are in `tests/remote_regressions.rs` and `opentui-ssh/tests/regressions.rs`.

Decisions made for SSH:

- No middleware chain: the handler is a plain function on its own thread, so
  code before `App::run` is setup and code after it is teardown, and
  `Session::deny` refuses a session with a message. Keyboard-interactive
  authentication is not offered.
- The renderer gets the client's `TERM` from its pseudo-terminal request, plus
  `COLORTERM`, `TERM_PROGRAM`, and `TERM_PROGRAM_VERSION` when the client sends
  them, so a client in tmux or screen gets their handling, as Core's SSH
  package does since `c267c7ab7`.
- Ctrl+C still ends a remote app unless a handler consumes it, which ends that
  session only; Core turns `exitOnCtrlC` off for SSH.
- Keepalives every 30 seconds find dead clients; russh's inactivity timeout is
  off, since it would drop a quiet but live session. A connection has 120
  seconds to authenticate, as OpenSSH's default `LoginGraceTime`.
- Input an app has no room for waits in a backlog of up to 1 MiB per channel.
  Only beyond that does the whole connection wait: russh grants each channel's
  window by itself, so holding the connection back is the only way to slow a
  client, and doing it earlier would freeze the connection's other sessions.
- An ending session (timed out, closing, or finished) gives its app the app's
  own close bound (`HostOptions::close_bound`, eleven close timeouts, which
  `RemoteLink::close_bound` reports) to restore the client's terminal, and
  the client as long again once the app is done to take that output; after
  that its channel closes anyway, so a client that stops reading cannot hold a
  session open. `Server::close` waits by the same bound: for the sessions,
  then for each client whose session it ended to leave, which an SSH client
  does once the channel close russh sends after the output it still holds
  reaches it. `ServerConfig::close_timeout` caps the whole close instead, for
  a prompter shutdown at the risk of a slow client losing its restoration.
- A remote app never reads or writes the server's system clipboard, and gets
  console messages only from its own thread or a `ConsoleSender`.
- russh uses ring rather than its default aws-lc-rs, which needs CMake and NASM
  on Windows. `scripts/check-windows.sh` leaves `opentui-ssh` out, since ring
  compiles C even for a check.

A review of the public API found bugs and inconsistencies, now fixed, with
tests at the end of `tests/regressions.rs` and in `tests/widgets.rs`,
`tests/terminal.rs`, the `native` tests, and
`opentui-ssh/tests/regressions.rs`. The fixes:

- Wheel steps: `Code` and `Table` pass on steps they cannot take, so a
  surrounding `ScrollBox` scrolls.
- Focus: Markdown code blocks are no longer Tab stops, and `Diff` setters
  update its code views in place instead of rebuilding them, which had dropped
  focus and the selection.
- `ScrollBox`: `row`, `gap`, and the other methods that arrange children now
  act on its content view. `scroll_to` and `scroll_to_bottom` reach content
  added since the last frame.
- Other widget fixes: `View::border` keeps an earlier `border_color`, and
  `TabSelect` setters keep a height set on it.
- Inputs: `Slider` and `ScrollBox` ignore NaN, and `Slider::range` swaps
  reversed bounds.
- Overflow: timeouts too long for an `Instant`, such as `idle_timeout:
Some(Duration::MAX)`, mean never instead of panicking.
- Secrets: `HostKey`'s `Debug` redacts private keys.
- Allocation: `TextView::lines(0, u32::MAX)` no longer allocates for
  `u32::MAX` lines.

Additions:

- `App::set_theme`, `Error::other`, and `AppOptions::with_title`.
- `FromStr` for `Color`.
- `MacOsScroll::new`, and `Table::fg` and `Table::stripe_color`.
- On `TabSelect`: `description_color`, `arrow_color`, `option_count`, and
  `option`.
- `Text::inverse` and `Text::strikethrough`.
- `Length` from `usize`, `f64`, and the other integer types.
- `#[must_use]` on value types and on `opentui_ssh::Server`.
- Widget-facing native types re-exported from `widget`.
- Every widget and action enum in the prelude.

Decisions made in the API review:

- `KeyEvent::matches` takes any `IntoShortcut` and panics on an unknown name,
  as `Keymap::bind` does. A typo used to never match.
- Shared editing methods: `Input` and `Textarea` define theirs in one macro,
  and text arguments take `impl AsRef<str>`.
- Cursor: `Input::cursor` is now `cursor_offset`, as on `Textarea`, whose
  `cursor` is a (row, column) pair.
- Programmatic edits: `insert` calls change handlers, as `perform` does.
  `set_value` and `set_text` still do not.
- Mouse selection: an `on_selection` handler's `prevent_default` skips
  copy-on-select.
- Timers: `set_timeout` takes `FnOnce`, and `TestApp::advance` runs every
  timer tick it passes, as real time would.
- Renames: `TerminalView::scroll` is now `scroll_by`, as on `ScrollBox`.
- Table selection: an out-of-range `Table::select` is ignored, as
  `Select::select` ignores one.

A second round settled the design questions the review left open:

- App-level handlers: `App::on_*` return a `HandlerId`, and
  `App::remove_handler` removes one. A handler removed earlier in the same
  event does not run. `on_message` handlers take `&M` and add up like the
  others, instead of one replacing the last.
- Tables: `Table::set_columns` and `set_rows` replace the data, and `columns`
  and `rows` read it back. `Column` converts from strings.
  `TextTable::border(BorderStyle)` turns its lines on in a style, as
  `View::border` does; `grid_lines(bool)` is the old `border(bool)`.
- `Textarea::filetype` and `syntax_theme` highlight as `Code` does, on the
  frame after an edit, and never on cursor moves or idle frames. Native draws
  only the highest-priority highlight of each cell, so the textarea adds one
  merged highlight per styled piece, at priority 0, with extmarks at their
  priority plus one. Style names come from the style's value, so editors
  sharing a native `SyntaxStyle` no longer overwrite each other's extmark
  styles. A highlight costs time in proportion to the text: about 9 ms per
  keystroke for 17 KiB of Rust, half of it in tree-sitter and half in about
  2,300 native highlight calls. Incremental parsing, highlighting only the
  visible rows, and a batched native highlight call would make
  large textareas usable.
- `TerminalView`: a wheel step down at the live screen goes on to a
  surrounding `ScrollBox`. Native code gives no scroll feedback, so the
  widget passes a step on only when it is sure the
  view is at the live screen.
- Native types: `WidthMethod`, `Multiplexer`, `ImageProtocol` in
  `Capabilities`, `ClipboardSelection` for OSC 52, and `Corner`, which moved
  to `native`, replace raw codes. `App::width_method` is public. A `Context`
  still busy after its wait is leaked with a warning instead of aborting the
  process.
- SSH configuration and errors:
  - `ServerConfig` has a builder and is `#[non_exhaustive]`.
  - `Auth::empty` replaces `Auth::new`, and `Auth` has no `Default`.
  - `Error::Ssh` wraps an opaque `SshError`, so russh's type is not public.
  - `Error::Key` keeps the I/O error as its source.
  - `on_error` gets an `ErrorReport` with the client's address and user name.
  - The open-access warning goes through `on_error` as `Error::OpenAccess`.
- Typing cost: profiling found that each inserted character cost native time
  in proportion to the line count: about 1 ms at 3,360 lines with word wrap.
  Every edit laid out the whole buffer again, and rebuilt the rope's line
  markers. Cursor moves and idle frames stay at microseconds. OpenTUI now lays
  out once, at the next read or frame (`78038bdad`), keeps line facts in the
  rope's metrics (`2017c76fe`), and lays out and measures only the lines an
  edit changed (`c732e215c`, `d72e98942`), so an insert and the viewport read
  after it take about 10 µs at 3,360 lines. On the Rust side, an `on_change`
  handler copies the whole text on every edit (about 0.25 ms at 255 KiB), and
  an extmark makes every edit copy the text twice and compare the copies
  (about 1.4 ms).

Decisions made in milestone 3:

- An atomic extmark's cursor may rest at either edge, never inside. Arrow
  keys follow Core's virtual-mark rules: left from the end goes to one
  position before the start, right from there or the start goes to the end,
  and a vertical move into a mark goes to the nearer of those two. Other
  moves and edits keep the cursor at the edge it moved toward.
- Extmark edits are found by comparing the text before and after each edit,
  anchored at the cursor, instead of wrapping each buffer operation as Core
  does. Undo does not bring back marks an edit removed (Core keeps snapshots).
- `copy_to_clipboard` writes to every available destination, as Core's
  `all-available` policy: the terminal (OSC 52) and, on local sessions, the
  host clipboard. It reports success when either took the text.
- A sticky `ScrollBox` starts at the bottom unless `sticky_start` says
  otherwise; Core starts at the top without a `stickyStart`.
- Markdown blocks never shrink, so a document taller than its parent overflows
  instead of squeezing rows into each other.
- Highlighting uses each grammar crate's own queries (MIT, written for
  tree-sitter's last-pattern-wins rule) instead of Core's nvim-treesitter
  ones, which assume Neovim's priorities and Core-only directives. Some names
  differ: Markdown headings are `text.title`, not `markup.heading`;
  `SyntaxTheme::from_theme` styles both. Theme names fall back through every
  dotted prefix, where Core tries only the first part. A grammar registered
  with `Grammar::core_captures` takes Core's queries as Core does: every
  capture of a node, styles cascaded by dotted parts, and no
  `markup.raw.block` around injected code.
- Inner captures style text on top of the captures enclosing them; Core orders
  them by name length and then needs a special case for code in Markdown. A
  `none` capture clears the styles under it, as in Neovim.
- `Code` highlights on the UI thread at the start of the next frame, once for
  all changes since the last one. Core highlights on a worker. A 16 KiB Rust
  file takes about 4 ms in a release build.

Input now goes through native code's parser (`ot_session_input_feed`, added
in `0915c5af1`, #1592), a Zig port of the Rust parser, which is gone.
`input::Parser` feeds the Session's parser and turns its records into the Rust
event types, which keep their conventions: Shift applies to characters,
Shift+Tab is `BackTab`, keypad keys are the keys they stand for, text with
several characters is a key per character, and a paste is one event of at
most 4 MiB. `Parser::new` takes the Session, and `Parser::set_expectations`
replaces the `cursor_reports` and `kitty_keys` fields. `Parser::standalone`
parses on a private Context and Session, for the color queries that run before
a renderer exists. Core's vectors in `input/core_tests.rs` now check that
translation.

Decisions made for the native parser:

- The adapter follows Core's (`stdin-parser-native.ts`): 64 records and
  16 KiB of payload allocated once, a clock that holds instead of going back,
  and a quiet stop once the Session is gone. The host expects replies and
  cursor position reports during the capability window, wakes when it ends,
  and ends it at a suspension, as Core does. After a suspension it feeds the
  input that waited, then drops what is still partial except an expected
  reply. Reply routing stays in the host.
- Where native code differs from the Rust parser, native code wins:
  - `CSI R` is F3 unless the terminal negotiated the Kitty keyboard protocol;
    the Rust parser read a reply.
  - `CSI ;5R` is a reply, not Ctrl+F3.
  - BEL ends only OSC strings; in DCS and APC it is part of the string.
  - Strings longer than 4 KiB are dropped; the Rust parser kept 64 KiB.
  - Kitty text keeps at most eight characters.
  - The host no longer decides whether Kitty keys may wait for their rest: a
    Session with a renderer uses the Kitty keyboard state its terminal
    negotiated.

Still to do, in priority order:

1. Build `ScrollBox` on the native scroll control and its scrollbars, as
   Core does since `2dbd917eb` (#1805).
2. End each batch of terminal queries with DA1 and wait for its reply, as
   Core does since `7f2d08c53` (#1816), so that the native parser holds split
   replies (`OT_INPUT_EXPECT_SENTINEL`).
3. Run `sh test.sh` on a Mac, with a macOS build of the native library from
   the same revision. The macOS port compiles and links but has not run.
4. Inline mode: draw below the shell prompt instead of on the alternate screen.
5. Wrap the video node (`ot_video_*`, `OT_SCENE_VIDEO`) and image crops
   (`ot_scene_set_crop`).

Waiting on native work:

Skipped or not planned:

- Skipped for now: big ASCII-art text (Core's `ASCIIFont`, whose font data is
  GPL-3.0).
- Not planned: batching style and paint writes through `ot_scene_flush`, as
  Core does. Core batches because each call through Bun's FFI is expensive;
  from Rust each setter is a direct C call, and the benchmarks match or beat
  Core without it. Batching would also report a rejected write at whichever
  call flushes instead of the call that made it.

Milestone 2:

- Phase 3: the parser covers every key and mouse form Core supports, including
  X10 mouse, rxvt and Linux-console keys, and lost-Escape mouse reports. 1,124
  of Core's test vectors run in `input/core_tests.rs`; 88 were skipped because
  they test Core internals.
- Phase 4: `App` (event loop, dispatch, focus, hover, pointer capture, timers,
  animation, `AppProxy`, sticky errors), the `Widget` and `Container` traits,
  `Element`, `Component`/`Custom` with optional measurement through a
  per-thread table of native measure callbacks, `Theme`, and
  `testing::TestApp`.
- Phase 5 Tier 1: `View`, `Text` (with mouse selection), `Input`, `Textarea`,
  `Select`, `TabSelect`, `Slider`, `ScrollBox`. Tier 2: `Code` (line numbers,
  a built-in highlighter, tail-following), `Table`, `ImageView`; `Custom`
  covers `Canvas`. Tier 3 in part: `Markdown` and diff highlighting. Mouse
  selection copies through OSC 52.
- Phase 6 in part: README guide, rustdoc on every public item, `showcase` as
  the main demo, `hello` and `tasks` on the framework, `lifecycle --app` under
  the PTY checks, and `test.sh` covering the `tokio` feature.
- Phase 7 in part: the `tokio` feature (`App::spawn`, `TaskHandle`).
- An independent review of the framework layer found 18 bugs (borrow panics in
  handlers, focus left on hidden or detached widgets, stale selection anchors,
  scroll-offset mismatches, timer overflow, leaked task handlers, and more).
  All are fixed, each with a test in `crates/opentui/tests/regressions.rs`.

Decisions made in milestone 2:

- Widget handles are `Rc`-backed, as planned. The arena prototype was not
  built: closures that capture handles read naturally, and teardown breaks the
  cycles they create.
- Property methods take `&self` and return a clone, so one method both builds
  and changes a widget.
- Setters are infallible. A native rejection is recorded and ends `App::run`
  with the error at the end of the turn.
- Keys bubble from the focused widget to the app (not Core's global-first
  order); `App::on_key_capture` gives the global-first behavior when wanted.
- `grow(n)` also sets a zero flex basis, like CSS `flex: n`. OpenTUI's Yoga
  shrinks every item by default, so a growing widget with large content
  otherwise squeezes its siblings.
- Edit changes are detected by comparing content epochs after host-driven
  edits, so the global edit-event callback is not needed.

Milestone 1:

- Phase 0: `scripts/generate-ffi.ts` generates all 233 functions, 84 records,
  3 callback types, and 517 constants, plus compile-time layout checks and a
  `Pod` marker for padding-free records. The build rejects artifacts whose
  header hash differs.
- Phase 1: `Context`, `Session`, `Node`, drafts, the hook-capable frame
  driver, the paint recorder, and frame capture. Milestone 2 added edit
  buffers, editor views, text buffers and views, syntax styles, and images.
  Milestone 3 added offscreen buffers and the embedded terminal.
- Phase 2: `term` (raw mode, signals, wakeups) and `host` (setup, capability
  replies, resize, Ctrl-Z, output delivery, panic and signal restoration).
  `scripts/pty-smoke.py` checks every exit path under a pseudo-terminal.
- Phase 3 started: the event types, UTF-8, legacy and Kitty keys, SGR mouse,
  paste, focus, and reply splitting. Milestone 2 finished it.

## Risks and open questions

- The C ABI is experimental and needs a header and library from the same
  revision. `bun run generate:abi` regenerates the bindings with the header,
  and `check:abi` fails when they are stale.
- Publishing on crates.io would need `build.rs` to build the Zig library or
  download prebuilt files. The crates link the checkout's native build, or
  `OPENTUI_LIB_DIR`.
- Linux x86_64, macOS, and Windows x86_64. OpenTUI also builds aarch64 Linux
  and Windows, which `build.rs` does not know yet.
