# Headless apps

`App::headless` creates an app without a terminal that runs in real time.
`App::run` runs its event loop: timers fire on the real clock, `AppProxy`
tasks and `App::spawn` completions run, and frames are painted at up to
`AppOptions::max_fps` whenever a widget changed. Nothing is written to a
terminal. Instead:

- each presented frame's cells go to `App::on_headless_frame` handlers, and
  `App::last_frame` returns the latest;
- clipboard copies, notifications, and title changes go to
  `App::on_headless_write` handlers as `HeadlessWrite::{Clipboard,
Notification, Title}`.

OpenCode's drive endpoint (`OPENCODE_DRIVE`, step H.4) is the user this note
plans for. It runs the real TUI headless and answers the simulation
protocol's UI requests (`packages/protocol/src/simulation.ts`), as Core's
test renderer does for the TypeScript TUI
(`packages/simulation/src/frontend/renderer.ts`, `actions.ts`).

## How it differs from `TestApp`

`testing::TestApp` is for tests. Its clock is manual, and nothing runs until
the test calls `advance`, `wait_until`, or `render`. A headless app needs no
driver to keep it alive. It is the same `App` with a real clock and its own
loop, so animations, the leader timeout, toasts, and network tasks behave as
on a terminal.

|                           | `TestApp`                    | `App::headless`                                     |
| ------------------------- | ---------------------------- | --------------------------------------------------- |
| Clock                     | Manual (`advance`)           | Real                                                |
| Loop                      | The test drives each step    | `App::run`, woken by timers, frames, and the proxy  |
| Frames                    | `render()` paints on demand  | Painted when dirty; also `App::capture()` on demand |
| Native frame verification | On (`OT_SCENE_DEBUG_VERIFY`) | Off                                                 |
| Clipboard, notify, title  | Return `false`, dropped      | To `on_headless_write` while running                |
| Input                     | Methods on `TestApp`         | `App::dispatch`, `App::resize` from proxy tasks     |

The two share the native setup (`App::headless_session`: a Session with a
renderer attached as a remote `xterm-256color` truecolor terminal) and the
present path (`App::present_headless`). The existing `TestApp` behavior is
unchanged.

## Terminal writes

The handlers get only what a running app sends, as on a terminal:

- before `run` and after it returns, `copy_to_clipboard` and `notify` return
  `false` and nothing is handed over;
- when the loop starts, `AppOptions::title` (or the last `set_title` before
  the start) goes out as `Title`; each later `set_title` goes out at once;
- `copy_to_clipboard` with empty text returns `false`, as on a terminal;
- clipboard reads (`read_clipboard*`, `paste_from_clipboard`) report
  `ClipboardOutcome::Unsupported`, as in tests: there is no host clipboard
  and no terminal to paste from.

Program status reports and the mouse pointer shape are not handed over.

## Driving a headless app from another thread

`App` is not `Send`. A driver on another thread (H.4's websocket server on
tokio) posts closures with `AppProxy::post` and sends the answer back on a
channel. Each request is one closure, so a request sees a consistent UI.

```rust
let app = App::headless(HeadlessOptions { width: cols, height: rows, app: options })?;
let tui = opencode_tui::mount_with(&app, deps, args);
let server = drive::start(app.proxy(), manifest.endpoints.ui)?; // a tokio thread
let result = app.run();
```

```rust
// On the server thread, for one request:
let (sender, receiver) = tokio::sync::oneshot::channel();
proxy.post(move |cx| {
    let response = answer(cx.app(), request);
    let _ = sender.send(response);
})?;
receiver.await
```

The TS harness renders once after every action (`actions.ts` `execute`, then
`renderOnce`) and returns `ui.state`. The Rust endpoint calls `App::capture()`
after the action instead, which paints and presents a frame and runs due
timers first.

| Request                | Rust                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ui.type`              | Feed the text's bytes to an `input::Parser` built on `app.session()` (as `TestApp::feed` does) and `dispatch` each event, so keys go through the same parser as Core's mock input |
| `ui.press`             | Map the key name and modifiers to bytes, or to a `KeyEvent` with `KeyEvent::new`, then `dispatch`                                                                                 |
| `ui.enter`, `ui.arrow` | `dispatch(Event::Key(...))` for Enter or the arrow                                                                                                                                |
| `ui.mouse`             | Reject positions outside `app.size()`, as TS does; then `dispatch(Event::Mouse(MouseEvent { kind, x, y, modifiers }))` with `Moved`, `Down`, `Up`, or `Scroll*`                   |
| `ui.resize`            | `app.resize(cols, rows)`                                                                                                                                                          |
| `ui.matches`           | `app.last_frame()` text `contains`, as TS reads its current buffer without rendering                                                                                              |
| `ui.capture`           | `app.capture()`, then group each row's cells into spans of equal `fg`, `bg`, and `attributes` for `CapturedFrame`                                                                 |

`ui.state`, `ui.focus`, `ui.click`, and `ui.snapshot` name renderable
numbers; the plan leaves them out (plan 7.3). Scenarios use `ui.mouse` with
coordinates.

The driver ends the app with `AppProxy::quit`. `App::run` returns after the
current turn, tears down handlers and widgets, and closes the proxy, so later
posts fail with `ProxyError::Closed`.

## Not covered

- **Images.** `Capture` has no image pixels. `CapturedFrame.images` stays
  empty until opentui-rust can read image cells back.
- **`ui.recording.finish`.** TS records the renderer's output bytes. A
  headless app writes no bytes; a recording would need the session's output
  stream.
- **Signals.** The headless loop does not install signal handlers. A killed
  process ends without teardown, as Core's test renderer does.
- **Cursor.** `CapturedFrame.cursor` is `[0, 0]` in TS; the Rust endpoint
  sends the same.
