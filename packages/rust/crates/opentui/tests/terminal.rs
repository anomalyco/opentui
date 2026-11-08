//! The embedded terminal widget, offscreen buffers, and programs on pseudo-terminals.

use opentui::input::KeyEventKind;
use opentui::native::{Buffer, EmbeddedTerminalOptions, TerminalViewport};
use opentui::prelude::*;
use opentui::pty::Pty;
use opentui::style::Intent;
use opentui::testing::TestApp;
use opentui::widget::{TerminalData, TerminalView};
use std::cell::{Cell, RefCell};
use std::process::Command;
use std::rc::Rc;
use std::time::Duration;

fn rows(app: &TestApp) -> Vec<String> {
    let capture = app.render();
    (0..capture.height).map(|y| capture.row(y).trim_end().to_owned()).collect()
}

/// What a terminal sent to the program, in order.
type Sent = Rc<RefCell<Vec<(TerminalData, String)>>>;

/// A focused 20x4 terminal at the top-left, recording what it sends to the program.
fn terminal(app: &TestApp) -> (TerminalView, Sent) {
    let sent = Rc::new(RefCell::new(Vec::new()));
    let terminal = TerminalView::new(app).size(20, 4).on_data({
        let sent = Rc::clone(&sent);
        move |_cx, bytes, source| sent.borrow_mut().push((source, String::from_utf8_lossy(bytes).into_owned()))
    });
    app.root().add(&terminal);
    app.render();
    terminal.focus();
    app.render();
    (terminal, sent)
}

fn take_input(sent: &RefCell<Vec<(TerminalData, String)>>) -> Vec<String> {
    sent.borrow_mut().drain(..).map(|(source, text)| format!("{source:?}:{text}")).collect()
}

#[test]
fn terminals_render_output_and_keep_it_across_frames() {
    let app = TestApp::new(30, 6);
    let terminal = TerminalView::new(&app).size(20, 4);
    app.root().add(&terminal);
    terminal.write("hello \x1b[1;32mworld\x1b[0m\r\nwide: 界");
    let first = rows(&app);
    assert_eq!(first[..3], ["hello world", "wide: 界", ""]);
    assert_eq!(rows(&app), first);
    let capture = app.render();
    let theme = app.theme();
    let (plain, world) = (capture.cell(0, 0).unwrap(), capture.cell(6, 0).unwrap());
    assert_eq!((plain.fg, plain.bg), (theme.foreground, theme.background));
    assert!(world.attributes.contains(Attributes::BOLD));
    assert_ne!(world.fg, theme.foreground);
    assert_eq!(terminal.screen().text(), "hello world\nwide: 界");
    assert_eq!(terminal.screen().cursor.position, Some((8, 1)));
}

#[test]
fn terminals_follow_their_layout_size() {
    let app = TestApp::new(30, 6);
    let sizes = Rc::new(RefCell::new(Vec::new()));
    let terminal = TerminalView::new(&app).grow(1.0).on_terminal_resize({
        let sizes = Rc::clone(&sizes);
        move |_cx, cols, rows| sizes.borrow_mut().push((cols, rows))
    });
    app.root().add(&terminal);
    app.render();
    assert_eq!(terminal.terminal_size(), (30, 6));
    terminal.write("x".repeat(35));
    assert_eq!(terminal.screen().lines, ["x".repeat(30), "x".repeat(5)]);
    app.resize(12, 3);
    app.render();
    assert_eq!(terminal.terminal_size(), (12, 3));
    assert_eq!(*sizes.borrow(), [(30, 6), (12, 3)]);
    // Without a size, a terminal asks for its own.
    let app = TestApp::new(30, 10);
    let small = TerminalView::with_options(&app, EmbeddedTerminalOptions { cols: 10, rows: 3, ..Default::default() });
    app.root().add(&View::new(&app).row().child(&small)).add(&Text::new(&app, "below"));
    assert_eq!(rows(&app)[3], "below");
    assert_eq!(small.terminal_size(), (10, 3));
}

#[test]
fn terminals_use_the_theme_colors_or_a_transparent_background() {
    let app = TestApp::new(20, 2);
    let terminal = TerminalView::new(&app).size(20, 2);
    app.root().add(&terminal);
    assert_eq!(app.render().cell(5, 0).unwrap().bg, app.theme().background);
    terminal.transparent_background(true);
    assert_eq!(app.render().cell(5, 0).unwrap().bg.intent(), Intent::Default);
    terminal.transparent_background(false);
    assert_eq!(app.render().cell(5, 0).unwrap().bg, app.theme().background);
    // Programs may change the default colors later, or reverse them for a visual bell.
    terminal.write("\x1b[?5h");
    assert_eq!(app.render().cell(5, 1).unwrap().bg, app.theme().foreground);
    terminal.write("\x1b[?1;5l");
    assert_eq!(app.render().cell(5, 1).unwrap().bg, app.theme().background);
    terminal.write("\x1b]11;rgb:ff/00/00\x1b\\");
    assert_eq!(app.render().cell(5, 1).unwrap().bg, Color::rgb(255, 0, 0));
    let app = TestApp::with_options(20, 2, AppOptions::default().with_theme(Theme::terminal()));
    let terminal = TerminalView::new(&app).size(20, 2);
    app.root().add(&terminal);
    assert_eq!(app.render().cell(5, 0).unwrap().bg.intent(), Intent::Default);
}

#[test]
fn wheel_steps_scroll_the_scrollback_and_typing_returns() {
    let app = TestApp::new(20, 4);
    let (terminal, sent) = terminal(&app);
    for line in 0..10 {
        terminal.write(format!("\r\nline {line}"));
    }
    assert_eq!(rows(&app), ["line 6", "line 7", "line 8", "line 9"]);
    app.scroll(1, 1, false);
    assert_eq!(rows(&app), ["line 3", "line 4", "line 5", "line 6"]);
    app.scroll(1, 1, true);
    assert_eq!(rows(&app)[3], "line 9");
    app.scroll(1, 1, false);
    app.type_text("a");
    assert_eq!(rows(&app)[3], "line 9");
    assert_eq!(take_input(&sent), ["Input:a"]);
    // A program that tracks the mouse gets the wheel instead.
    terminal.write("\x1b[?1000h\x1b[?1006h");
    app.scroll(1, 1, false);
    assert_eq!(rows(&app)[3], "line 9");
    assert_eq!(take_input(&sent), ["Input:\x1b[<64;2;2M"]);
}

#[test]
fn wheel_steps_the_view_cannot_take_reach_a_scroll_box() {
    let app = TestApp::new(20, 4);
    let terminal = TerminalView::new(&app).size(10, 4);
    let scroll = ScrollBox::new(&app).grow(1.0);
    scroll.add(&terminal).add(&Text::new(&app, "below\nmore\nmore"));
    app.root().add(&scroll);
    for line in 0..10 {
        terminal.write(format!("\r\nline {line}"));
    }
    app.render();
    let viewport = |offset, total| TerminalViewport { offset, total, visible: 4 };
    assert_eq!(terminal.viewport(), viewport(0, 11));
    // Each step either moves the view or the box, never both.
    let step = |down: bool, scrolls_box: bool| {
        scroll.scroll_to(0.0, 1.0);
        app.render();
        app.scroll(1, 1, down);
        assert_eq!(scroll.scroll_position().1 != 1.0, scrolls_box, "down: {down}");
    };
    step(true, true);
    step(false, false);
    assert_eq!(terminal.viewport(), viewport(3, 11));
    assert_eq!(terminal.screen().lines, ["line 3", "line 4", "line 5", "line 6"]);
    // Output while scrolled back keeps the view on its rows, and the viewport says how far back that is now.
    terminal.write("\r\nline 10\r\nline 11");
    assert_eq!(terminal.viewport(), viewport(5, 13));
    assert_eq!(terminal.screen().lines, ["line 3", "line 4", "line 5", "line 6"]);
    step(true, false);
    step(true, false);
    assert_eq!(terminal.screen().lines, ["line 8", "line 9", "line 10", "line 11"]);
    step(true, true);
    // At the top of the history, a step up goes on too.
    step(false, false);
    step(false, false);
    step(false, false);
    assert_eq!(terminal.viewport(), viewport(9, 13));
    step(false, true);
    // The alternate screen has no history, so the view takes no step at all.
    terminal.scroll_to_bottom();
    terminal.write("\x1b[?1049h");
    assert_eq!(terminal.viewport(), viewport(0, 4));
    step(false, true);
    step(true, true);
}

#[test]
fn keys_encode_in_the_programs_keyboard_mode() {
    let app = TestApp::new(20, 4);
    let (terminal, sent) = terminal(&app);
    for key in ["enter", "a", "shift+a", "ctrl+c", "alt+a", "up", "f1", "f5", "backspace", "tab", "shift+tab", "space"]
    {
        app.press(key);
    }
    assert_eq!(
        take_input(&sent),
        [
            "Input:\r",
            "Input:a",
            "Input:A",
            "Input:\x03",
            "Input:\x1ba",
            "Input:\x1b[A",
            "Input:\x1bOP",
            "Input:\x1b[15~",
            "Input:\x7f",
            "Input:\t",
            "Input:\x1b[Z",
            "Input: ",
        ]
    );
    // The terminal took Tab and Ctrl+C: focus stayed and the app runs on.
    assert!(terminal.is_focused());
    assert!(!app.is_quitting());
    assert_eq!(terminal.encode_key(&KeyEvent::from(KeyCode::Char('😀'))), "😀".as_bytes());

    // Kitty keys as Core's tests have them, from a Dvorak layout (u on the f key) and a Cyrillic one.
    let cases = [
        (1, &b"\x1b[117::102;1u"[..], "u"),
        (1, b"\x1b[117::102;5u", "\x1b[117;5u"),
        (1, b"\x1b[117:85:102;6u", "\x1b[117;6u"),
        (1, b"\x1b[1092::97;5u", "\x1b[1092;5u"),
        (0, b"\x1b[117::102;5u", "\x15"),
        (5, b"\x1b[117::102;5u", "\x1b[117::102;5u"),
        (3, b"\x1b[99;5u", "\x1b[99;5u"),
        (3, b"\x1b[27u", "\x1b[27u"),
        // A lone Escape times out into the same key, and a reply is no key.
        (3, b"\x1b", "\x1b[27u"),
        (3, b"\x1b[?62c\x1b", "\x1b[27u"),
        (3, b"\x1b[97;3u", "\x1b[97;3u"),
        (3, b"\x1b[97;9u", "\x1b[97;9u"),
        // A legacy line feed is Ctrl+J to the program.
        (0, b"\n", "\n"),
        (1, b"\n", "\x1b[106;5u"),
    ];
    for (flags, typed, expected) in cases {
        terminal.write(format!("\x1b[>{flags}u"));
        app.feed(typed);
        assert_eq!(take_input(&sent), [format!("Input:{expected}")], "flags {flags}, {typed:?}");
        terminal.write("\x1b[<u");
    }
    // Releases reach the program when it asks for them, and only then.
    let release = KeyEvent { kind: KeyEventKind::Release, ..KeyEvent::from(KeyCode::Char('a')) };
    app.key(release);
    assert!(take_input(&sent).is_empty());
    terminal.write("\x1b[>3u");
    app.feed(b"\x1b[117::102;5u\x1b[117::102;5:2u\x1b[117::102;5:3u");
    assert_eq!(take_input(&sent), ["Input:\x1b[117;5u", "Input:\x1b[117;5:2u", "Input:\x1b[117;5:3u"]);
    app.key(release);
    assert_eq!(take_input(&sent), ["Input:\x1b[97;1:3u"]);
}

#[test]
fn pastes_and_focus_changes_reach_the_program() {
    let app = TestApp::new(20, 4);
    let (terminal, sent) = terminal(&app);
    app.paste("one\ntwo");
    terminal.write("\x1b[?2004h\x1b[?1004h");
    // A paste waits across reads.
    app.feed(b"\x1b[200~one\n");
    app.feed(b"two\x1b[201~");
    app.blur();
    app.render();
    terminal.focus();
    app.render();
    assert_eq!(
        take_input(&sent),
        ["Input:one\rtwo", "Input:\x1b[200~one\ntwo\x1b[201~", "Input:\x1b[O", "Input:\x1b[I"]
    );
    assert_eq!(terminal.encode_paste("x"), b"\x1b[200~x\x1b[201~");
}

#[test]
fn replies_to_queries_go_to_the_program() {
    let app = TestApp::new(20, 4);
    let (terminal, sent) = terminal(&app);
    terminal.write("ab\x1b[6n");
    // Native writes take at most 1 MiB; a query split across two writes is still answered.
    terminal.write(format!("{}\x1b[5n", " ".repeat((1 << 20) - 2)));
    assert_eq!(take_input(&sent), ["Response:\x1b[1;3R", "Response:\x1b[0n"]);
}

#[test]
fn mouse_events_reach_programs_that_track_the_mouse() {
    let app = TestApp::new(30, 6);
    let (terminal, sent) = terminal(&app);
    app.blur();
    app.render();
    terminal.write("\x1b[?1004h\x1b[?1003h\x1b[?1006h");
    app.click(2, 1);
    app.hover(4, 2);
    app.hover(4, 2);
    app.mouse(MouseEventKind::Down(MouseButton::Right), 0, 0);
    app.mouse(MouseEventKind::Drag(MouseButton::Right), 1, 0);
    assert_eq!(
        take_input(&sent),
        [
            "Input:\x1b[I",
            "Input:\x1b[<0;3;2M",
            "Input:\x1b[<0;3;2m",
            "Input:\x1b[<35;5;3M",
            "Input:\x1b[<2;1;1M",
            "Input:\x1b[<34;2;1M",
        ]
    );
    // Presses go to the program instead of starting a selection.
    terminal.write("hello");
    app.drag((0, 0), (3, 0));
    assert_eq!(app.selected_text(), None);
}

#[test]
fn a_left_press_focuses_the_terminal_without_focus_on_click() {
    // Core's `EmbeddedTerminal.forwardMouse` focuses on a left press even with the renderer's `autoFocus` off.
    let app = TestApp::with_options(30, 6, AppOptions { focus_on_click: false, ..AppOptions::default() });
    let terminal = TerminalView::new(&app).size(20, 4);
    let other = ScrollBox::new(&app).size(5, 4);
    app.root().row().child(&terminal).child(&other);
    app.render();
    app.click(22, 1);
    assert!(app.focused().is_none(), "a scroll box took focus without focus_on_click");
    app.mouse(MouseEventKind::Down(MouseButton::Right), 2, 1);
    assert!(!terminal.is_focused());
    app.click(2, 1);
    assert!(terminal.is_focused());
}

#[test]
fn terminals_take_part_in_mouse_selection() {
    let app = TestApp::new(30, 6);
    let terminal = TerminalView::new(&app).size(20, 4);
    app.root().add(&terminal);
    terminal.write("hello there\r\nwide: 界");
    let original = app.render();
    app.drag((1, 0), (3, 0));
    assert_eq!(terminal.selected_text(), "ell");
    assert_eq!(app.selected_text().as_deref(), Some("ell"));
    let selected = app.render();
    assert_ne!(selected, original);
    // A press and release in one cell selects nothing and clears the selection.
    app.click(4, 0);
    assert_eq!(app.selected_text(), None);
    assert_eq!(app.render(), original);
    // Leaving the first cell starts the selection; coming back to it keeps that cell.
    app.mouse(MouseEventKind::Down(MouseButton::Left), 1, 0);
    app.mouse(MouseEventKind::Drag(MouseButton::Left), 1, 0);
    assert_eq!(terminal.selected_text(), "");
    app.mouse(MouseEventKind::Drag(MouseButton::Left), 2, 0);
    app.mouse(MouseEventKind::Drag(MouseButton::Left), 1, 0);
    app.mouse(MouseEventKind::Up(MouseButton::Left), 1, 0);
    assert_eq!(terminal.selected_text(), "e");
    // Across rows, and past the bottom to the last cell.
    app.drag((7, 0), (2, 1));
    assert_eq!(terminal.selected_text(), "here\nwid");
    app.drag((6, 0), (0, 5));
    assert_eq!(terminal.selected_text(), "there\nwide: 界");
    // Double-clicks select words; triple-clicks select lines.
    app.advance(Duration::from_secs(1));
    app.click(8, 0);
    app.click(8, 0);
    assert_eq!(terminal.selected_text(), "there");
    app.click(8, 0);
    assert_eq!(terminal.selected_text(), "hello there");
    app.clear_selection();
    assert_eq!(terminal.selected_text(), "");
    terminal.selectable(false);
    app.drag((1, 0), (3, 0));
    assert_eq!(app.selected_text(), None);
}

#[test]
fn painters_draw_offscreen_buffers() {
    struct Canvas(Buffer);
    impl Component for Canvas {
        fn paint(&self, painter: &mut Painter<'_>) {
            painter.draw_buffer(&self.0, 1, 0);
        }
    }
    let app = TestApp::new(12, 3);
    let buffer = Buffer::new(app.session().context(), 6, 2, app.width_method()).unwrap();
    buffer.clear(Color::BLUE).unwrap();
    buffer.text(0, 0, "abc", Style::new().fg(Color::YELLOW)).unwrap();
    let canvas = Custom::new(&app, Canvas(buffer.clone())).size(5, 2);
    app.root().add(&canvas);
    let capture = app.render();
    assert_eq!(capture.row(0), " abc        ");
    assert_eq!((capture.cell(1, 0).unwrap().fg, capture.cell(4, 1).unwrap().bg), (Color::YELLOW, Color::BLUE));
    // Clipped to the widget: its fifth column is the buffer's fourth.
    assert_eq!(capture.cell(5, 1).unwrap().bg, app.theme().background);
    // Drawing into the buffer changes the next frame without recording anything new.
    buffer.text(0, 1, "xy", Style::new()).unwrap();
    assert_eq!(app.render().row(1), " xy         ");
}

fn wait_for(app: &TestApp, terminal: &TerminalView, text: &str) {
    let found = app.wait_until(Duration::from_secs(10), || terminal.screen().text().contains(text));
    assert!(found, "never saw {text:?}; the screen shows:\n{}", terminal.screen().text());
}

#[cfg(unix)]
#[test]
fn spawned_programs_show_output_take_input_and_report_their_exit() {
    let app = TestApp::new(40, 6);
    let mut command = Command::new("sh");
    command.args(["-c", "printf 'hi %s\\n' \"$TERM\"; read line; echo \"got $line\"; exit 3"]);
    let status = Rc::new(Cell::new(None));
    let terminal = TerminalView::new(&app).grow(1.0).spawn(command).unwrap().on_exit({
        let status = Rc::clone(&status);
        move |_cx, exit| status.set(Some(exit))
    });
    app.root().add(&terminal);
    terminal.focus();
    app.render();
    wait_for(&app, &terminal, "hi xterm-256color");
    app.type_text("abc\n");
    wait_for(&app, &terminal, "got abc");
    assert!(app.wait_until(Duration::from_secs(10), || status.get().is_some()));
    assert_eq!(status.get().and_then(|status| status.code()), Some(3));
    assert_eq!(terminal.pty().and_then(|pty| pty.exit_status()).and_then(|status| status.code()), Some(3));
    assert_eq!(terminal.screen().lines, ["hi xterm-256color", "abc", "got abc"]);
    // Typing after the exit goes nowhere.
    app.type_text("x");
}

#[cfg(unix)]
#[test]
fn spawned_programs_follow_the_terminal_size() {
    let app = TestApp::new(30, 5);
    let mut command = Command::new("sh");
    command.args(["-c", "stty size; read line; stty size"]);
    let terminal = TerminalView::new(&app).spawn(command).unwrap();
    app.root().add(&terminal);
    terminal.focus();
    wait_for(&app, &terminal, "24 80");
    app.render();
    app.type_text("\n");
    wait_for(&app, &terminal, "5 30");
}

#[cfg(unix)]
#[test]
fn a_replaced_program_no_longer_reaches_the_terminal() {
    let app = TestApp::new(30, 4);
    let exits = Rc::new(Cell::new(0));
    let mut first = Command::new("sh");
    first.args(["-c", "read line; echo old; exit 5"]);
    let terminal = TerminalView::new(&app).grow(1.0).spawn(first).unwrap().on_exit({
        let exits = Rc::clone(&exits);
        move |_cx, _status| exits.set(exits.get() + 1)
    });
    // A handle keeps the first program running after the terminal replaces it.
    let old = terminal.pty().unwrap();
    app.root().add(&terminal);
    app.render();
    let mut second = Command::new("sh");
    second.args(["-c", "echo new; read line"]);
    terminal.spawn(second).unwrap();
    wait_for(&app, &terminal, "new");
    old.write(b"x\n").unwrap();
    assert!(app.wait_until(Duration::from_secs(10), || old.exit_status().is_some()));
    assert_eq!(old.exit_status().and_then(|status| status.code()), Some(5));
    assert_eq!(exits.get(), 0);
    assert_eq!(terminal.screen().lines, ["new"]);
}

#[cfg(unix)]
#[test]
fn dropping_a_terminal_hangs_up_its_program() {
    let app = TestApp::new(20, 4);
    let mut command = Command::new("sleep");
    command.arg("100");
    let terminal = TerminalView::new(&app).spawn(command).unwrap();
    let pid = terminal.pty().unwrap().pid() as libc::pid_t;
    app.root().add(&terminal);
    app.render();
    terminal.detach();
    drop(terminal);
    let gone = app.wait_until(Duration::from_secs(10), || unsafe { libc::kill(pid, 0) } != 0);
    assert!(gone, "the program outlived its terminal");
}

#[cfg(unix)]
#[test]
fn ptys_deliver_all_output_before_the_exit() {
    let app = TestApp::new(20, 4);
    let received = Rc::new(Cell::new(0));
    let exited = Rc::new(Cell::new(None));
    let mut command = Command::new("sh");
    command.args(["-c", "head -c 3000000 /dev/zero | tr '\\0' x; exit 7"]);
    let pty = Pty::spawn(&app, command, 80, 24)
        .unwrap()
        .on_output({
            let received = Rc::clone(&received);
            move |_cx, bytes| received.set(received.get() + bytes.len())
        })
        .on_exit({
            let (received, exited) = (Rc::clone(&received), Rc::clone(&exited));
            move |_cx, status| exited.set(Some((status.code(), received.get())))
        });
    assert!(pty.is_running());
    assert!(app.wait_until(Duration::from_secs(30), || exited.get().is_some()));
    assert_eq!(exited.get(), Some((Some(7), 3_000_000)));
    assert!(!pty.is_running());
    assert!(pty.write(b"late").is_err());
}

#[cfg(unix)]
#[test]
fn ptys_signal_their_programs() {
    let app = TestApp::new(20, 4);
    let exited = Rc::new(Cell::new(None));
    let mut command = Command::new("sleep");
    command.arg("100");
    let pty = Pty::spawn(&app, command, 80, 24).unwrap().on_exit({
        let exited = Rc::clone(&exited);
        move |_cx, status| exited.set(Some(status))
    });
    pty.resize(100, 30).unwrap();
    assert_eq!(pty.size(), (100, 30));
    pty.signal(libc::SIGTERM).unwrap();
    assert!(app.wait_until(Duration::from_secs(10), || exited.get().is_some()));
    use std::os::unix::process::ExitStatusExt;
    assert_eq!(exited.get().and_then(|status| status.signal()), Some(libc::SIGTERM));
    pty.kill().unwrap();
    let missing = Pty::spawn(&app, Command::new("/nonexistent/program"), 80, 24);
    assert_eq!(missing.err().map(|error| error.kind()), Some(std::io::ErrorKind::NotFound));
}

/// The same checks with Windows programs on pseudoconsoles.
#[cfg(windows)]
mod windows_programs {
    use super::*;

    /// A `cmd.exe` script: `/s` keeps the quotes around it from reaching the script, and `/v:on` expands `!name!`
    /// when a command runs, after `set /p` has read it.
    fn cmd(script: &str) -> Command {
        let mut command = Command::new("cmd.exe");
        command.args(["/d", "/s", "/v:on", "/c", script]);
        command
    }

    /// A program that runs for 100 seconds unless stopped.
    fn long_running() -> Command {
        let mut command = Command::new("ping.exe");
        command.args(["-n", "100", "127.0.0.1"]);
        command
    }

    /// Whether process `pid` ends within `timeout`; true when it is already gone.
    fn process_ends(pid: u32, timeout: Duration) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject};
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            return true;
        }
        let ended = unsafe { WaitForSingleObject(handle, timeout.as_millis() as u32) } == WAIT_OBJECT_0;
        unsafe { CloseHandle(handle) };
        ended
    }

    #[test]
    fn spawned_programs_show_output_take_input_and_report_their_exit() {
        let app = TestApp::new(40, 6);
        let status = Rc::new(Cell::new(None));
        let command = cmd("echo hi %TERM%& set /p line=& echo got !line!& exit 3");
        let terminal = TerminalView::new(&app).grow(1.0).spawn(command).unwrap().on_exit({
            let status = Rc::clone(&status);
            move |_cx, exit| status.set(Some(exit))
        });
        app.root().add(&terminal);
        terminal.focus();
        app.render();
        wait_for(&app, &terminal, "hi xterm-256color");
        app.type_text("abc\n");
        wait_for(&app, &terminal, "got abc");
        assert!(app.wait_until(Duration::from_secs(10), || status.get().is_some()));
        assert_eq!(status.get().and_then(|status| status.code()), Some(3));
        assert_eq!(terminal.pty().and_then(|pty| pty.exit_status()).and_then(|status| status.code()), Some(3));
        // Typing after the exit goes nowhere.
        app.type_text("x");
    }

    #[test]
    fn spawned_programs_follow_the_terminal_size() {
        let app = TestApp::new(30, 5);
        let terminal = TerminalView::new(&app).spawn(cmd("mode con& set /p x=& mode con")).unwrap();
        app.root().add(&terminal);
        terminal.focus();
        // `mode con` prints a line such as `    Columns:        80`.
        let columns = |cols: &str| {
            let text = terminal.screen().text();
            text.lines()
                .any(|line| line.trim_start().starts_with("Columns:") && line.split_whitespace().last() == Some(cols))
        };
        let started = app.wait_until(Duration::from_secs(10), || columns("80"));
        assert!(started, "never saw 80 columns; the screen shows:\n{}", terminal.screen().text());
        app.render();
        app.type_text("\n");
        let resized = app.wait_until(Duration::from_secs(10), || columns("30"));
        assert!(resized, "never saw 30 columns; the screen shows:\n{}", terminal.screen().text());
    }

    #[test]
    fn dropping_a_terminal_hangs_up_its_program() {
        let app = TestApp::new(20, 4);
        let terminal = TerminalView::new(&app).spawn(long_running()).unwrap();
        let pid = terminal.pty().unwrap().pid();
        app.root().add(&terminal);
        app.render();
        terminal.detach();
        drop(terminal);
        assert!(process_ends(pid, Duration::from_secs(10)), "the program outlived its terminal");
    }

    #[test]
    fn ptys_deliver_all_output_before_the_exit() {
        let app = TestApp::new(20, 4);
        let received = Rc::new(RefCell::new(Vec::new()));
        let exited = Rc::new(Cell::new(None));
        let command = cmd("(for /l %i in (1,1,3000) do @echo line %i)& echo all-output-done& exit 7");
        let pty = Pty::spawn(&app, command, 80, 24)
            .unwrap()
            .on_output({
                let received = Rc::clone(&received);
                move |_cx, bytes| received.borrow_mut().extend_from_slice(bytes)
            })
            .on_exit({
                let (received, exited) = (Rc::clone(&received), Rc::clone(&exited));
                move |_cx, status| {
                    let done = String::from_utf8_lossy(&received.borrow()).contains("all-output-done");
                    exited.set(Some((status.code(), done)));
                }
            });
        assert!(pty.is_running());
        assert!(app.wait_until(Duration::from_secs(30), || exited.get().is_some()));
        assert_eq!(exited.get(), Some((Some(7), true)));
        assert!(!pty.is_running());
        assert!(pty.write(b"late").is_err());
    }

    #[test]
    fn ptys_signal_their_programs() {
        let app = TestApp::new(20, 4);
        let exited = Rc::new(Cell::new(None));
        let pty = Pty::spawn(&app, long_running(), 80, 24).unwrap().on_exit({
            let exited = Rc::clone(&exited);
            move |_cx, status| exited.set(Some(status))
        });
        pty.resize(100, 30).unwrap();
        assert_eq!(pty.size(), (100, 30));
        assert_eq!(pty.signal(1).err().map(|error| error.kind()), Some(std::io::ErrorKind::Unsupported));
        pty.signal(15).unwrap();
        assert!(app.wait_until(Duration::from_secs(10), || exited.get().is_some()));
        assert_eq!(exited.get().and_then(|status| status.code()), Some(1));
        pty.kill().unwrap();
        let missing = Pty::spawn(&app, Command::new(r"C:\nonexistent\program.exe"), 80, 24);
        assert_eq!(missing.err().map(|error| error.kind()), Some(std::io::ErrorKind::NotFound));
    }

    #[test]
    fn ptys_interrupt_their_programs_with_ctrl_c() {
        // Programs inherit whether they ignore Ctrl+C, and a test run from a service or a non-interactive SSH
        // session starts with it ignored. Restore the normal handling the program should inherit.
        unsafe { windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 0) };
        let app = TestApp::new(20, 4);
        let exited = Rc::new(Cell::new(false));
        let pty = Pty::spawn(&app, long_running(), 80, 24).unwrap().on_exit({
            let exited = Rc::clone(&exited);
            move |_cx, _status| exited.set(true)
        });
        // Give ping time to start before Ctrl+C reaches it.
        std::thread::sleep(Duration::from_millis(500));
        pty.signal(2).unwrap();
        assert!(app.wait_until(Duration::from_secs(10), || exited.get()), "Ctrl+C did not stop the program");
    }
}
