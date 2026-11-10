# OpenTUI for Rust

A terminal UI framework for Rust built on
[OpenTUI](https://github.com/anomalyco/opentui)'s native renderer.

OpenTUI's native library keeps a retained scene of nodes, lays it out with
Yoga, paints cells, and encodes terminal output. This workspace drives it from
Rust, without JavaScript:

- `crates/opentui-sys` declares the whole C ABI (`opentui.h`), generated from
  the header.
- `crates/opentui` is the framework: widgets, an event loop, focus, mouse and
  keyboard input, timers, and tests that run without a terminal. Its lower
  layers wrap the ABI safely and run the terminal.
- `crates/opentui-ssh` serves apps over SSH, one app per session, as Core's
  `@opentui/ssh` does.

```rust
use opentui::prelude::*;

fn main() -> opentui::Result<()> {
    let app = App::new(AppOptions::default())?;
    let status = Text::new(&app, "Pick a task").fg(app.theme().muted);
    let list = Select::new(&app).options(["Build", "Test", "Ship"]).grow(1.0);
    app.root()
        .add(&View::new(&app).border(BorderStyle::Rounded).title(" Tasks ").padding(1).grow(1.0).child(&list))
        .add(&status);
    list.on_select(move |_cx, _index, option| {
        status.set_text(format!("Selected {}", option.name));
    });
    app.on_key(|cx, key| {
        if key.matches("q") {
            cx.quit();
        }
    });
    list.focus();
    app.run()
}
```

## Build

The crates link the native library of this checkout,
`packages/native/lib/<artifact directory>`. They do not build it. Build it
first, then run Cargo:

```sh
bun install
bun run build   # at the repository root, or `bun run build:native` in packages/core
cargo test --manifest-path packages/rust/Cargo.toml
```

To link other artifacts, such as an npm platform package or a native archive
of a release, set `OPENTUI_LIB_DIR` to their directory. It wins over the
checkout's build. Give an absolute path: Cargo reads a relative one from
`crates/opentui-sys`. A Cargo `git` dependency on this repository has no native
build, so it needs `OPENTUI_LIB_DIR`. An npm platform package ships only the
shared library, so on Linux and macOS it needs the default features off (see
below).

These platforms are supported:

| Platform                       | Rust target                                             | Artifact directory   |
| ------------------------------ | ------------------------------------------------------- | -------------------- |
| Linux x86_64 with glibc        | `x86_64-unknown-linux-gnu`                              | `x86_64-linux`       |
| Linux arm64 with glibc         | `aarch64-unknown-linux-gnu`                             | `aarch64-linux`      |
| Linux x86_64 with musl         | `x86_64-unknown-linux-musl`                             | `x86_64-linux-musl`  |
| Linux arm64 with musl          | `aarch64-unknown-linux-musl`                            | `aarch64-linux-musl` |
| macOS 13 or later, Apple chips | `aarch64-apple-darwin`                                  | `aarch64-macos`      |
| macOS 13 or later, Intel chips | `x86_64-apple-darwin`                                   | `x86_64-macos`       |
| Windows 10 1809 or later       | `x86_64-pc-windows-msvc`, `x86_64-pc-windows-gnu`       | `x86_64-windows`     |
| Windows 10 1809 or later, Arm  | `aarch64-pc-windows-msvc`, `aarch64-pc-windows-gnullvm` | `aarch64-windows`    |

The build picks the directory for the target it builds.
Rust's musl targets build static executables (`crt-static`), which cannot load
`libopentui.so`, so the build refuses the shared library there: keep the
default `static` feature, or turn the default features off and build with
`RUSTFLAGS='-C target-feature=-crt-static'`.
OpenTUI's macOS build needs the macOS SDK, which comes with the Xcode Command
Line Tools (`xcode-select --install`). On a Mac, `bun run build` in
`packages/native` builds the Mac's own architecture; add the other one with
`zig build -Doptimize=ReleaseFast -Dlibrary-target=x86_64-macos.13.0` (or
`aarch64-macos.13.0`). The Windows build needs no SDK, so Zig makes it on any
system: `zig build -Doptimize=ReleaseFast -Dlibrary-target=x86_64-windows-gnu`.
`VideoView` needs a library built with FFmpeg: the native build links it from
`packages/native/.cache/ffmpeg/prefix/<target>`, which `bun run build` makes for
the host, and warns and leaves video out without it.

`crates/opentui-sys/src/generated.rs` is generated from
`packages/native/include/opentui.h`: `bun run generate:abi` in `packages/core`
writes it, and `bun run check:abi` fails when it is stale. Do not edit it. The
bindings are valid only for the exact header they were generated from, and the
build fails if the artifacts' header differs.

By default the crate links `libopentui.a` on Linux and macOS, so an
executable needs no OpenTUI file at run time, and on Linux no libc++ either.
Windows always links `opentui.dll`, through its import library `opentui.lib`:
ship `opentui.dll` beside the `.exe`. The build copies it where `cargo run`
and `cargo test` find it.

To link `libopentui.so` or `libopentui.dylib` instead, turn the default
features off (`default-features = false`, or `--no-default-features`). Cargo
merges features across the app's graph, so every crate in it that depends on
`opentui` must turn them off. The workspace's tests and examples find the library through an rpath; other
executables need their own rpath, `LD_LIBRARY_PATH` on Linux, or
`DYLD_LIBRARY_PATH` on macOS.

On Windows, the app turns on the console's virtual terminal input and output,
so the input parser reads the same sequences as on Unix. Windows has no job
control, so Ctrl+Z reaches key handlers instead of suspending the app.
Ctrl+Break, closing the console, logoff, and shutdown end `App::run` as
signals do on Unix. `TerminalView` runs programs on a pseudoconsole (ConPTY),
and `pty::shell()` is `%COMSPEC%`.

Features:

- `static` (default): link `libopentui.a`. On Linux the archive carries its
  own libc++, so the program needs only libc. That libc++ is private to
  OpenTUI, so C++ code elsewhere in the program keeps its own runtime,
  libstdc++ or libc++, shared or static. On macOS this also links the system
  frameworks OpenTUI uses for the clipboard, audio, and video. Windows links
  `opentui.dll` with or without it: OpenTUI's Windows archive is built for
  MinGW with libc++, which neither Rust Windows toolchain links.
- `tokio`: `App::spawn` runs futures on a Tokio runtime and finishes them on
  the UI thread.
- `log`: `console::init_logger` shows the `log` crate's records in the debug
  console.
- `tree-sitter`: `Code`, `Diff`, `Textarea`, and Markdown code blocks highlight with
  tree-sitter. It bundles Core's grammars (JavaScript, TypeScript and TSX,
  Markdown, Zig) and Rust. `sh run.sh` turns it on.

## Guide

### Widgets are handles

Every widget is a cheap `Clone` handle over a native node. Property methods
take `&self` and return a new handle, so one method both builds a widget and
changes it later:

```rust
let status = Text::new(&app, "Ready").fg(Color::GREEN).bold();
// Later, from an event handler:
status.set_text("Saved").fg(Color::CYAN);
```

Changes go to native code at once and schedule a frame. Frames are painted at
most `AppOptions::max_fps` times per second, and only when something changed.

A parent keeps its children alive. A detached widget is destroyed when its
last handle drops. Handlers may capture widget handles, including their own
widget's; the app breaks those reference cycles when it ends.

Setters do not return `Result`. If native code rejects a change, for example
an infinite width, the app records the error and `App::run` returns it at the
end of that turn, after restoring the terminal.

### Layout

Layout is flexbox, computed natively by Yoga. Lengths are cells; integers
convert, and `Length::percent(50.0)` gives percentages. The `Widget` trait has
the layout methods: `width`, `height`, `min_*`/`max_*`, `grow`, `row`,
`column`, `gap`, `padding*`, `margin*`, `justify`, `align_items`, `absolute`
with `position`, and `visible`.

`grow(n)` works like CSS `flex: n`: the widget fills free space, shared with
growing siblings by factor, whatever its content. A widget whose content
outgrows its space scrolls or clips instead of pushing its siblings away.
Widgets without `grow` size to their content. Scrolling widgets (`ScrollBox`,
`Select`, `Table`, `Code`) need a height or a grow factor.

### Events and focus

Keys go to the focused widget first, then to each ancestor, then to
`App::on_key`. A widget's own handlers run before its built-in behavior:

- `cx.prevent_default()` skips built-in behavior, such as an input inserting
  the typed character. The key still bubbles.
- `cx.stop_propagation()` stops the key from reaching ancestors and the app.
- `App::on_key_capture` handlers run before any widget, for shortcuts that
  must win over text input.

Unless a handler claims them, Tab and Shift+Tab move focus in tree order,
Ctrl+C quits, and Ctrl+Z suspends to the shell.

App-level handlers (`App::on_key`, `on_mouse`, `on_message`, and the rest)
return a `HandlerId`; `App::remove_handler` removes one, for screens that come
and go.

Widgets with built-in keys take Core's default bindings, which you can change
per widget. Each widget names what its keys can do in an action enum
(`EditorAction`, `SelectAction`, `TabSelectAction`, `SliderAction`,
`ScrollAction`, `TableAction`):

```rust
let input = Input::new(&app)
    .bind("ctrl+s", EditorAction::Submit) // add or replace a binding
    .unbind("ctrl+w");                    // the key now bubbles to the app
let list = Select::new(&app).set_keymap(Keymap::new().bind("n", SelectAction::MoveDown));
list.perform(SelectAction::Last);         // run an action without a key
```

An unbound key, or an action that does not apply (Up on a horizontal slider),
bubbles on like any other key. `Shortcut` parses and prints names such as
`ctrl+shift+a`, for help screens and configuration files.

Mouse events go to the widget under the pointer and bubble the same way. A
press captures the pointer, so drags keep reaching the widget they started on.
A left click focuses the nearest focusable widget. `on_hover` reports enter
and leave for a widget and its descendants. `on_click` reports a press and
release. For drag and drop, `on_drag_over` reports a drag from another widget
entering and leaving, and `on_drop` reports where it ends.

Dragging selects text across `Text`, `Code`, `Input`, `Textarea`, `TextTable`,
and `TerminalView` widgets, as in Core: the selection covers every selectable
widget between the press and the pointer, starting within the pressed widget's
parent and widening as the pointer leaves it, so a drag inside a dialog does
not select the text beneath it. In a `TextTable`, a drag selects within one
cell, then down one column, then across whole rows, and never the grid lines.
Double-click selects a word, triple-click a line, and Ctrl+click extends the
selection. On release, `App::on_selection` handlers get the text and, with
`AppOptions::copy_on_select`, it is copied to the clipboard through OSC 52.
`App::selected_text` joins the pieces in reading order.

Extmarks mark ranges of an `Input` or `Textarea` that move with edits, as in
Core: a styled decoration, or an atomic token such as a mention that the
cursor jumps over and Backspace removes whole:

```rust
let start = input.cursor_offset();
input.insert("@main.rs");
input.add_extmark(start..input.cursor_offset(), ExtmarkOptions::default().atomic().style(Style::new().fg(Color::CYAN)));
```

`App::copy_to_clipboard` copies through the terminal (OSC 52) and, when the
session is local, through the system clipboard too. `App::read_clipboard` and
`App::paste_from_clipboard` read text from the system clipboard of the machine
the app runs on; `App::read_clipboard_as` reads the first of several MIME
types, such as `image/png` before `text/plain`. Bind `EditorAction::Paste` to
a key to paste into an input. `App::set_program_status` sends OSC 7501
program status reports.

### Widgets

| Widget         | What it is                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `View`         | A flexbox container with optional border, titles, and background. `app.root()` is one.                                          |
| `Text`         | Styled text that wraps. Spans carry colors, attributes, and hyperlinks.                                                         |
| `Input`        | A single-line field with Core's editing keys, undo, selection, and paste.                                                       |
| `Textarea`     | Multi-line editing with wrapping and optional syntax highlighting.                                                              |
| `Select`       | A vertical list with descriptions.                                                                                              |
| `TabSelect`    | A row of tabs.                                                                                                                  |
| `Slider`       | A value between a minimum and a maximum, with half-cell precision.                                                              |
| `ScrollBox`    | A clipped, scrollable area: scrollbars with optional arrows, sticky edges, wheel acceleration.                                  |
| `Table`        | Aligned columns with a header, selection, and scrolling.                                                                        |
| `TextTable`    | A bordered grid of styled cells that wrap, with columns fitted to the width, for reports.                                       |
| `Code`         | Read-only text with line numbers, tree-sitter highlighting, and tail-following.                                                 |
| `LineNumbers`  | A gutter beside a `Code` view or `Textarea`, with per-line signs, colors, and custom numbers.                                   |
| `Diff`         | A unified diff in one column or side by side, with line numbers, signs, and colored lines.                                      |
| `Markdown`     | Rendered or source Markdown with nested lists, tables, code, and code-block renderers; streamed text updates only what changed. |
| `TerminalView` | A shell or any program on a pseudo-terminal, emulated natively, with scrollback and selection.                                  |
| `ImageView`    | A picture, drawn with the Kitty protocol, Sixel, or half blocks.                                                                |
| `VideoView`    | An MP4 file played natively, with audio, looping, and seeking; events report the position, the end, and failures.               |
| `FrameBuffer`  | A grid of cells you draw into yourself, which native code shows every frame.                                                    |
| `Custom<T>`    | A widget you paint yourself by implementing `Component`.                                                                        |

Widgets read their default colors from the app's `Theme` when created.
`App::new` asks the terminal for its background color and picks
`Theme::dark()` or `Theme::light()` to match; `AppOptions::with_theme` sets
one theme for every terminal, and `Theme::terminal()` uses the terminal's own
colors. When the system later switches between dark and light mode,
`App::on_theme_mode` handlers hear about it; `App::set_theme` changes the
background and the colors new widgets start with, and the handler recolors or
rebuilds the existing ones. Set `AppOptions::palette_size` to
also read the terminal's palette (`App::palette`), which native code uses to
pick palette colors on terminals without true color.

### Syntax highlighting

With the `tree-sitter` feature, `Code` highlights its text as the filetype you
give it, as Core's `CodeRenderable` does. `Diff` and `Textarea` take a filetype
too, and `Markdown` uses each fence's tag:

```rust
let source = Code::new(&app).filetype("rust").line_numbers(true).grow(1.0);
source.set_code(std::fs::read_to_string("src/main.rs")?);
// Extensions, file names, and fence tags resolve too.
source.filetype(opentui::syntax::filetype_for_path("app.tsx"));
```

Highlight queries name each piece of the text (`keyword`, `string`,
`function.method`), and a `SyntaxTheme` maps names to styles in Rust (Core's
TypeScript calls it a `SyntaxStyle`; `SyntaxTheme::to_syntax_style` builds the
native table of that name). A name without a style takes the style of its longest dotted prefix
that has one. Widgets start with `SyntaxTheme::from_theme`, which matches the
app's dark or light theme. `syntax::register` adds a grammar, such as any
`tree-sitter-*` crate:

```rust
use opentui::syntax::{Grammar, register};
register(
    "python",
    Grammar::new(tree_sitter_python::LANGUAGE, tree_sitter_python::HIGHLIGHTS_QUERY),
)?;
```

Injections highlight embedded languages: code in Markdown fences, inline
Markdown, Rust in macro calls. Changes between frames cost one highlight of the
whole text, at the next frame; cursor moves, scrolling, and idle frames cost
none. A highlight costs time in proportion to the text, so highlighting large
`Textarea`s makes typing slow (about 9 ms per keystroke for 17 KiB of Rust).
Without the feature, or without a grammar for the filetype,
the text is plain.

### Your own widgets

Implement `Component` and wrap it in `Custom`. Painting uses local coordinates
and is clipped to the widget:

```rust
struct Meter {
    level: f32,
}

impl Component for Meter {
    fn paint(&self, painter: &mut Painter<'_>) {
        let filled = (painter.width() as f32 * self.level) as u32;
        painter.fill(0, 0, filled, 1, Color::GREEN);
    }

    fn key(&mut self, _cx: &mut Cx<'_>, key: &KeyEvent) -> bool {
        let step = if key.matches("right") { 0.1 } else if key.matches("left") { -0.1 } else { return false };
        self.level = (self.level + step).clamp(0.0, 1.0);
        true
    }
}

let meter = Custom::new(&app, Meter { level: 0.5 }).height(1).focusable(true);
meter.update(|meter| meter.level = 0.8);
```

`Custom::measured` sizes the widget with `Component::measure` during native
layout, when its width or height is not set.

To compose existing widgets instead, implement `Widget` for your own type by
returning the root widget's `element()`.

### Embedded terminals

`TerminalView` shows a program running on a pseudo-terminal, as Core's
`EmbeddedTerminalRenderable` does. Native code (Ghostty's emulator) parses the
program's output and keeps its screen and scrollback; the widget draws it,
follows its own size, and encodes keys, mouse events, pastes, and focus
changes in whatever protocol the program asked for:

```rust
let terminal = TerminalView::new(&app).grow(1.0).spawn(opentui::pty::shell())?;
terminal.on_exit(|cx, _status| cx.quit());
app.on_key_capture(|cx, key| {
    if key.matches("ctrl+q") {
        cx.quit();
        cx.stop_propagation();
    }
});
terminal.focus();
```

A focused terminal takes every key that sends something, Tab, Ctrl+C, and
Ctrl+Z included, so app-wide shortcuts belong in `App::on_key_capture`. While
the program tracks the mouse, mouse events go to it; otherwise dragging
selects text, double and triple clicks select words and lines, and the wheel
scrolls back through the output. A wheel step the view cannot take, down at
the live screen or up at the top of the history, goes on to a surrounding
`ScrollBox`. `TerminalView::viewport` says where the view sits.

`spawn` runs the command with `opentui::pty::Pty`: a new session on a new
pseudo-terminal, whose bytes move on a background thread, so the event loop
never blocks. Output and the exit status arrive through the app's proxy;
dropping the widget hangs up the program. To run a program some other way,
such as over SSH, feed its output to `TerminalView::write` and send what
`on_data` hands you to its input.

The terminal draws into an offscreen `native::Buffer`, a grid of cells that
keeps its content between frames. Apps can use them too: draw with `clear`,
`fill`, `text`, `cell`, `draw_box`, and `compose`, and show the result from a
paint hook with `Painter::draw_buffer`, or use a `FrameBuffer` widget, whose
buffer native code shows where the widget is laid out. Create one with
`Buffer::new(app.session().context(), width, height, app.width_method())`, so
it measures text as the terminal does.

### Serving apps over SSH

`opentui-ssh` runs one app per SSH session, each on a thread of its own. The
handler gets the `Session` and builds the app the way `main` would for a local
one:

```rust
use opentui::prelude::*;
use opentui_ssh::{Auth, HostKey, ServerConfig};

fn main() -> Result<(), opentui_ssh::Error> {
    let config = ServerConfig::new()
        .auth(Auth::empty().authorized_keys_file("authorized_keys")?)
        .host_key(HostKey::File("host_key".into()));
    let server = opentui_ssh::serve("0.0.0.0:2222", config, |session| {
        if session.user() == "root" {
            return session.deny("Log in as yourself.");
        }
        let app = session.app(AppOptions::default())?;
        app.root().add(&Text::new(&app, format!("Hello, {}!", session.user())));
        app.run()
    })?;
    server.close_on_ctrl_c()
}
```

The app's input, output, and window size come from the SSH channel, and it
picks its light or dark theme from the client's terminal. `App::run` returns
when the app quits, the client disconnects, an idle or maximum timeout passes,
or the server closes; except after a disconnect, the app restores the client's
terminal first. An error or panic in a handler ends only its own session and
goes to `ServerConfig::on_error`, with the client's address and user name.

- Authentication: `Auth::open()` (`ServerConfig`'s default, which warns
  through `on_error` when listening beyond the loopback interface), or
  `Auth::empty()` with `any_public_key`,
  `authorized_keys`, `allow_public_key`, and `password`. `Session::identity`
  says who got in and how; for keys, the fingerprint is what was proven.
- Host keys: `HostKey::Ephemeral` (the default, new on every start),
  `HostKey::File` (loaded, or generated and saved readable by its owner only),
  or `HostKey::Keys` for keys you supply.
- Limits: one session per connection and 100 in all by default, optional idle
  and maximum timeouts, and keepalives that find vanished clients.
- Shutdown: `Server::close` waits until every app has restored its client's
  terminal and the client has taken that output, bounded by the apps' close
  timeouts; `ServerConfig::close_timeout` caps it for a prompter shutdown.

`sh run.sh chat` starts a chat room on port 2222 where every `ssh -p 2222
localhost` gets its own app.

Underneath, `opentui::remote` works with any transport. A `RemoteTerminal`
stands in for the client's terminal, and its `RemoteLink` takes the client's
input and size in and hands output out, with bounded buffers that hold a slow
client back instead of dropping bytes. `App::remote(terminal, options)` runs an
app on it without touching the local terminal, signals, or stderr.

### Sounds

`audio::Audio` is Core's audio engine: it decodes WAV, MP3, and FLAC bytes
into sounds and mixes up to 32 voices at 48 kHz. Creating one opens no device;
`start` opens the default playback device, whose own thread mixes from then
on:

```rust
use opentui::audio::Audio;

let audio = Audio::new(app.session().context())?;
let bell = audio.load(&std::fs::read("bell.mp3")?)?;
audio.start()?;
audio.play(bell, 0.4)?;
```

`start_without_device` mixes only when `mix` asks, so tests can check what
would play without a sound.

### Time, threads, and async

- `app.set_timeout` and `app.set_interval` run callbacks on the UI thread;
  `cancel_timer` stops them.
- `app.animate(|cx, elapsed| ...)` runs before every frame until it returns
  `false`.
- `app.proxy()` returns a `Send` handle. `proxy.post(|cx| ...)` runs a closure
  on the UI thread, and `proxy.send(message)` hands a value, by reference, to
  every `app.on_message` handler for its type. Its queue is bounded.
- With the `tokio` feature, `app.spawn(future, |cx, output| ...)` runs a
  future on a runtime and calls back on the UI thread.

### Animation

A `Timeline` plays tweens, callbacks, and other timelines at positions along
it. A `Tween` moves a value between two ends with one of Core's easings and
hands each new value to a handler:

```rust
let fade = Timeline::new(&app).add(
    Duration::ZERO,
    Tween::new(0.0, 1.0).duration(Duration::from_millis(300)).ease(Easing::OutQuad).on_update(move |_cx, value| {
        card.opacity(value as f32);
    }),
);
// Later: fade.pause(), play(), restart(), or seek(Duration::from_millis(150)).
```

Tweens move `f64`, `f32`, and `Color` values, or your own types through the
`Interpolate` trait. They can repeat (`loops(3)`, `forever()`) with a
`loop_delay`, and run back and forth with `alternate(true)`. Timelines loop
with `looping(true)`, nest with `sync`, run `call` callbacks, and report
`on_complete`. Without a `duration`, a timeline ends with its last item, and
an empty one waits: `once` plays one-off tweens on it as they come.

Timelines advance through `app.animate`, so they follow the test clock and
request frames only while they play. A playing timeline keeps itself alive
until it finishes; handlers may capture timelines and widgets, and the app
breaks those cycles when it ends.

### Debugging

`app.console()` is Core's debug console: an overlay, hidden until shown, that
lists messages logged with `opentui::console::{info, warn, error, ...}` from
any thread. The `log` feature adds `console::init_logger` for the `log`
crate's macros, and `AppOptions::capture_stderr` sends `eprintln!` output to
the console while the app runs, then writes it to the real stderr afterwards.
`app.set_debug_overlay(Some(Corner::TopRight))` shows native frame statistics.
A frame too large for the Session's output queue is not drawn;
`App::on_frame_dropped` reports it once, with its size and the limit, as
Core's `frame:dropped` event does.

### Post-processing

The `post` module ports Core's post-processing: color matrices (sepia,
grayscale, color-blindness simulation and compensation, technicolor, and
more), filters (scanlines, noise, chromatic aberration, ASCII art, bloom), and
animated effects (vignette, distortion, clouds, flames, a CRT rolling bar,
rainbow text). A filter changes a widget's area after each frame is painted,
or the whole screen on `app.root()`:

```rust
use opentui::post::{CrtRollingBar, Scanlines, Vignette};

let monitor = View::new(&app).border(BorderStyle::Rounded).grow(1.0);
monitor.filter(ColorMatrix::GREENSCALE).filter(Scanlines::default()).filter(Vignette::new(0.6));
let bar = app.root().add_filter(CrtRollingBar::default()); // animated: frames run until it is removed
app.root().remove_filter(bar);
```

Color matrices run in native code, as do scanlines, noise, the vignette,
clouds, and the rolling bar; the other filters work on the painted cells.
Implement `Filter`, or use `post::from_fn`, for your own. Because filters run
on the finished frame, they also change anything drawn over the widget, such
as a dialog. To change colors at a point in paint order instead, call
`Painter::color_matrix` from a `Component`; `sh run.sh effects` dims the page
behind a dialog that way.

### Testing

`opentui::testing::TestApp` runs an app without a terminal, with a manual
clock:

```rust
let app = TestApp::new(20, 3);
let name = Input::new(&app);
app.root().add(&name);
name.focus();
app.type_text("Ada");
app.press("ctrl+a");
assert_eq!(name.value(), "Ada");
assert_eq!(app.render().row(0).trim_end(), "Ada");
```

`render()` paints and presents a frame and returns its cells, with their
colors and attributes. Input methods (`press`, `type_text`, `paste`, `feed`
for raw bytes, `click`, `drag`, `scroll`, `hover`) dispatch at once, and
`advance` moves the clock and runs due timers.

`App::headless(HeadlessOptions)` runs an app without a terminal in real time,
for harnesses that drive it from another thread through `App::proxy`. `run()`
paints frames as on a terminal and hands each frame's cells to
`on_headless_frame` handlers, and clipboard copies, notifications, and title
changes to `on_headless_write` handlers. See `crates/opentui/docs/headless.md`.

## Layers

The framework sits on layers you can use directly:

- `native`: safe owners for the C ABI: `Context`, `Session`, `Node`, frames,
  paint recordings, offscreen buffers, edit and text buffers, images, and
  embedded terminals. Every owner keeps its dependencies alive, so drop order
  never matters. None of the types are `Send`, because native code checks the
  owning thread.
- `host`: runs one Session on the local terminal: setup, input, resizes,
  Ctrl-Z, output delivery, and restoration, from one `poll()` loop. If the
  program returns an error, panics, or receives SIGTERM, SIGHUP, or SIGINT,
  the terminal is restored before the process exits.
- `input`: turns terminal bytes into key, mouse, paste, and focus events with
  the Session's native input parser: UTF-8, legacy and Kitty keys, SGR and X10
  mouse, bracketed paste, and focus reports. Terminal replies come out
  separately. As in Core, a partial sequence whose next byte takes more than
  20 ms is ended, so a key that starts like a sequence cannot hold up later
  input; a split UTF-8 character and a bare `ESC [`, which may start a mouse
  report, wait for the next read instead. Core's 1,100 parser test vectors
  check the events made from the native parser's results.
- `term`: raw mode, terminal size, signals, and wakeups, on top of `libc`.
- `style` and `layout`: colors that keep their terminal intent (RGB, palette,
  or default), attributes, styled spans, and typed flexbox properties.

The `native` example shows a scene driven by the host alone.

## Performance

`cargo run --release --example bench` times whole frames (event handling,
layout, painting, encoding, and output) without a terminal.
`scripts/core-bench.ts` runs the same scenes on Core's test renderer under Bun
(`bun scripts/core-bench.ts`). Both load the library built in this checkout,
so most scenes cost about the same; widgets the host paints
itself are faster from Rust. On one Linux x86_64 machine:

| Scene                                      | Rust   | Core       |
| ------------------------------------------ | ------ | ---------- |
| 200x60, 60 text rows, all change           | 418 µs | 472-502 µs |
| 200x60, 60 text rows, one changes          | 59 µs  | 57 µs      |
| ScrollBox with 5000 rows, scroll           | 437 µs | 450-456 µs |
| Select with 10000 options, move selection  | 30 µs  | 87 µs      |
| Textarea with 2000 lines, type a character | 36 µs  | 47 µs      |

## Run the examples

```sh
sh run.sh hello       # a centered card with a button and live event reports
sh run.sh showcase    # every widget: a form, a list, a live log, a file table with source, and styled text
sh run.sh effects     # Core's color matrices, filters, and animated effects on a panel or the whole screen
sh run.sh tasks       # a task list you move through and toggle
sh run.sh native      # the native layer and host, without the framework
sh run.sh workbench   # a native-layer build queue with live progress and a debug pane
sh run.sh terminal    # your shell in a terminal widget, beside a notes field
sh run.sh video       # a video player; `cargo run --example video -- file.mp4` plays your own file
sh run.sh chat        # an SSH chat server on 127.0.0.1:2222: run `ssh -p 2222 localhost` per participant
sh run.sh tasks static
cargo run --release --example bench   # headless frame timings
```

On a recent x86_64 machine, `bench` measures about 60 µs per frame to change
one line of a 200x60 screen, 40 µs to move a 10,000-option `Select`, and 0.5
ms to type into a 2,000-line `Textarea`, including layout, painting, encoding,
and delivering the output to memory.

## Test

```sh
sh test.sh           # format, clippy, tests, and lifecycle checks, with shared and static linking
sh test.sh shared
cargo test --locked --workspace --features opentui/tokio,opentui/tree-sitter
sh scripts/check-targets.sh   # clippy for the macOS, arm64 and musl Linux, and Arm Windows targets
```

On Windows, run `sh test.sh` from Git Bash; it runs one pass, which links
`opentui.dll`.
`cargo test` also works from any shell.

After a change to `opentui.h`, run `bun run generate:abi` in `packages/core`,
then `sh test.sh shared`, and fix the crates in the same change.

`scripts/check-targets.sh` keeps the code of the other targets compiling
while you work on one. It needs Zig and the targets' standard libraries, which
it adds with rustup, or `rust-src` without rustup; its header says how it uses
them. It does not link or run anything. `sh test.sh` runs on x86_64 Linux,
macOS, and x86_64 Windows; arm64 Linux, Linux with musl, and Windows on Arm
are only compile-checked.

CI runs `test.sh` on Linux, Windows and macOS for each pull request that
changes the crates, native code or the ABI generator, and `check-targets.sh` on
Linux. `rust-toolchain.toml` pins the toolchain it uses.

Widget tests in `crates/opentui/tests/` drive headless apps and compare
rendered frames. Native tests drive real Sessions into memory with a virtual
clock. `tests/lifecycle.rs` runs the `lifecycle` example on a pseudo-terminal
(ConPTY on Windows), both on a hand-written host loop and on `App::run`, and
checks that quitting, resizing, returned errors, panics, and captured stderr
each leave the alternate screen; on Windows it also checks that the console
modes are restored. On Unix, `scripts/pty-smoke.py` adds signals and Ctrl-Z,
and checks that each exit path restores the terminal settings.
`crates/opentui/tests/remote.rs` plays the transport for apps on remote
terminals, and `crates/opentui-ssh/tests/server.rs` connects to a real server
with russh's client; one of its tests runs OpenSSH's `ssh` on a
pseudo-terminal, and is skipped where `ssh` is missing.
