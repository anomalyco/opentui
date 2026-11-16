//! Apps on remote terminals: each test plays the transport, passing input to the app's thread and collecting its
//! output, as an SSH server does for a client.

use opentui::prelude::*;
use opentui::remote::{OUTPUT_BYTES_MAX, RemoteLink, RemoteOptions, RemoteTerminal};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const ENTER_ALT: &str = "\x1b[?1049h";
const LEAVE_ALT: &str = "\x1b[?1049l";

/// The transport's side of one remote app.
struct Client {
    link: RemoteLink,
    woken: mpsc::Receiver<()>,
    output: Vec<u8>,
    /// Where the next [`Self::wait_for`] starts looking.
    seen: usize,
    app: Option<JoinHandle<opentui::Result<()>>>,
}

/// Options without the startup color query, which waits for an answer these clients never send.
fn quiet() -> AppOptions {
    AppOptions::default().with_theme(Theme::dark())
}

/// An app that shows its size and theme mode, quits on `q`, and panics on `p`.
fn sizes(app: &App) {
    let label = |app: &App| {
        let (width, height) = app.size();
        format!("Hello remote {width}x{height} {:?}", app.theme_mode())
    };
    let text = Text::new(app, label(app));
    app.root().add(&text);
    app.on_resize(move |cx, _, _| {
        text.set_text(label(cx.app()));
    });
    app.on_key(|cx, key| {
        if key.matches("q") {
            cx.quit();
        } else if key.matches("p") {
            panic!("the app failed");
        }
    });
}

impl Client {
    fn start(options: RemoteOptions, app_options: AppOptions, build: impl FnOnce(&App) + Send + 'static) -> Self {
        let (wake, woken) = mpsc::channel();
        let (terminal, link) = RemoteTerminal::new(options, move || {
            #[expect(clippy::let_underscore_must_use, reason = "the test may stop listening first")]
            let _ = wake.send(());
        })
        .expect("create a remote terminal");
        let app = std::thread::spawn(move || {
            let app = App::remote(terminal, app_options)?;
            assert!(app.is_remote());
            build(&app);
            app.run()
        });
        Self { link, woken, output: Vec::new(), seen: 0, app: Some(app) }
    }

    fn take(&mut self) {
        loop {
            let chunk = self.link.take_output(64 * 1024);
            if chunk.is_empty() {
                return;
            }
            self.output.extend_from_slice(&chunk);
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output).into_owned()
    }

    /// Takes output until `done` holds, for at most ten seconds.
    fn take_until(&mut self, what: &str, mut done: impl FnMut(&mut Self) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            self.take();
            if done(self) {
                return;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what}; output so far: {:?}", self.text());
            #[expect(clippy::let_underscore_must_use, reason = "a timeout only starts the next check")]
            let _ = self.woken.recv_timeout(Duration::from_millis(50));
        }
    }

    /// Takes output until `needle` appears after the previous match.
    fn wait_for(&mut self, needle: &str) {
        self.take_until(needle, |client| {
            let found =
                client.output[client.seen..].windows(needle.len()).position(|window| window == needle.as_bytes());
            if let Some(index) = found {
                client.seen += index + needle.len();
            }
            found.is_some()
        });
    }

    fn send(&self, bytes: &[u8]) {
        assert_eq!(self.link.send_input(bytes), bytes.len());
    }

    /// Takes output until the app finishes with the terminal, then returns how its thread ended.
    fn finish(mut self) -> std::thread::Result<opentui::Result<()>> {
        self.take_until("the app to finish", |client| client.link.is_finished());
        self.app.take().expect("the app thread").join()
    }
}

#[test]
fn a_remote_app_restores_the_client_terminal_however_it_ends() {
    // Quitting, the transport's request to end, and a panic restore the terminal. A client that disconnected reads
    // no output, and its app ends without an error.
    for (end, restores, panics) in [
        ((|client: &Client| client.send(b"q")) as fn(&Client), true, false),
        (|client| client.link.terminate(), true, false),
        (|client| client.link.disconnect(), false, false),
        (|client| client.send(b"p"), true, true),
    ] {
        let mut client = Client::start(RemoteOptions::default(), quiet(), sizes);
        client.wait_for(ENTER_ALT);
        client.wait_for("Hello remote 80x24 None");
        end(&client);
        if restores {
            client.wait_for(LEAVE_ALT);
        }
        let ended = client.finish().map(|app| app.expect("the app"));
        assert_eq!(ended.is_err(), panics, "only the panic reaches the thread's owner");
    }
}

#[test]
fn resizes_reach_the_app() {
    let options = RemoteOptions { width: 0, height: 0, ..RemoteOptions::default() };
    let mut client = Client::start(options, quiet(), sizes);
    client.wait_for("Hello remote 80x24");
    client.link.resize(100, 30);
    client.wait_for("Hello remote 100x30");
    client.send(b"q");
    client.wait_for(LEAVE_ALT);
    client.finish().expect("the app thread").expect("the app");
}

#[test]
fn the_app_picks_its_theme_from_the_client_background() {
    let mut client = Client::start(RemoteOptions::default(), AppOptions::default(), |app| {
        assert_eq!(app.theme(), Theme::light());
        sizes(app);
    });
    // Before anything else, the app asks for the default colors and follows with a device attributes query.
    client.wait_for("\x1b]11;?\x07\x1b[c");
    client.send(b"\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[?62;22c");
    client.wait_for("Hello remote 80x24 Some(Light)");
    client.send(b"q");
    client.finish().expect("the app thread").expect("the app");
}

#[test]
fn remote_apps_run_side_by_side_on_their_own_threads() {
    let mut clients: Vec<Client> = (0..3)
        .map(|index| {
            let options = RemoteOptions { width: 60 + index, height: 20, ..RemoteOptions::default() };
            Client::start(options, quiet(), sizes)
        })
        .collect();
    for (index, client) in clients.iter_mut().enumerate() {
        client.wait_for(&format!("Hello remote {}x20", 60 + index));
    }
    for client in clients {
        client.send(b"q");
        client.finish().expect("the app thread").expect("the app");
    }
}

#[test]
fn a_slow_client_holds_output_back_without_stalling_the_app() {
    // A full screen that changes every frame produces far more output than the link holds.
    let options = RemoteOptions { width: 200, height: 60, ..RemoteOptions::default() };
    let mut app_options = quiet();
    app_options.host.close_timeout = Duration::from_millis(100);
    let bound = app_options.host.close_bound();
    let mut client = Client::start(options, app_options, |app| {
        sizes(app);
        let filler = Text::new(app, "").grow(1.0);
        app.root().add(&filler);
        let mut frame = 0u64;
        app.animate(move |_cx, _| {
            frame += 1;
            filler.set_text(format!("{frame:>12}").repeat(1000));
            true
        });
    });
    client.wait_for("Hello remote");
    // A transport learns how long the app's close may take, to wait that long before it gives up on the client.
    assert_eq!(client.link.close_bound(), bound);
    // The client stops reading until the app fills the link; the app keeps running but its output waits. A loaded
    // machine fills it more slowly, so each pause that leaves room is followed by one twice as long.
    let mut pause = Duration::from_millis(300);
    loop {
        std::thread::sleep(pause);
        let held = client.link.take_output(usize::MAX).len();
        assert!(held <= OUTPUT_BYTES_MAX, "the link held {held} bytes");
        if held == OUTPUT_BYTES_MAX {
            break;
        }
        pause *= 2;
        assert!(pause < Duration::from_secs(10), "the app filled {held} bytes of the link");
    }
    // The link fills again, and the client quits and reads 64 bytes every 20 ms: the frame queued behind the link
    // would take over a minute. Bytes keep moving, so the close goes on until its cap of ten timeouts, then drops that
    // frame and restores the terminal behind what the link holds.
    std::thread::sleep(pause);
    client.send(b"q");
    let quit = Instant::now();
    while !client.app.as_ref().expect("the app thread").is_finished() {
        assert!(quit.elapsed() < bound * 3 / 2, "the close took {:?}", quit.elapsed());
        client.output.extend(client.link.take_output(64));
        std::thread::sleep(Duration::from_millis(20));
    }
    client.wait_for(LEAVE_ALT);
    client.finish().expect("the app thread").expect("the app");
}

#[test]
fn a_message_before_the_app_goes_straight_to_the_client() {
    let (wake, woken) = mpsc::channel();
    let (terminal, link) = RemoteTerminal::new(RemoteOptions::default(), move || {
        #[expect(clippy::let_underscore_must_use, reason = "the test may stop listening first")]
        let _ = wake.send(());
    })
    .expect("create a remote terminal");
    terminal.write(b"no entry\r\n", Duration::from_secs(1)).expect("write the message");
    drop(terminal);
    assert!(woken.try_recv().is_ok());
    assert_eq!(link.take_output(1024), b"no entry\r\n");
    assert!(link.is_finished());
}

#[test]
fn hovering_sends_the_widget_pointer_shape_while_an_input_has_focus() {
    // A focused editor once set the text pointer on every frame, wherever the pointer was, so hover shapes never
    // reached the terminal.
    let mut client = Client::start(RemoteOptions::default(), quiet(), |app| {
        let input = Input::new(app).width(20);
        let label = Text::new(app, "Click me");
        let shown = label.clone();
        let button = View::new(app)
            .height(1)
            .mouse_pointer(MousePointer::POINTER)
            .on_hover(move |_, hovered| {
                shown.set_text(if hovered { "Hovered" } else { "Click me" });
            })
            .child(&label);
        app.root().add(&input).add(&button);
        input.focus();
    });
    client.wait_for("\x1b]22;default\x1b\\");
    client.send(b"\x1b[<35;4;2M");
    client.wait_for("Hovered");
    client.wait_for("\x1b]22;pointer\x1b\\");
    client.send(b"\x1b[<35;4;5M");
    client.wait_for("Click me");
    client.wait_for("\x1b]22;default\x1b\\");
    client.link.terminate();
    client.finish().expect("the app thread").expect("the app");
}

#[test]
fn a_terminal_that_answers_rgb_gets_24_bit_color_without_colorterm() {
    // sshd drops COLORTERM, so TERM=xterm-256color alone maps colors to the palette until the terminal answers the
    // XTGETTCAP RGB query.
    let mut client = Client::start(RemoteOptions::default(), quiet(), |app| {
        let text = Text::new(app, "navy").fg(Color::rgb(0x23, 0x34, 0x4b));
        app.root().add(&text);
        app.on_key(move |_, key| {
            if key.matches("r") {
                text.set_text("NAVY");
            }
        });
    });
    client.wait_for("\x1bP+q524742\x1b\\");
    client.wait_for("navy");
    client.send(b"\x1bP1+r524742=382F382F38\x1b\\r");
    client.wait_for("\x1b[38;2;35;52;75m");
    client.wait_for("NAVY");
    client.link.terminate();
    client.finish().expect("the app thread").expect("the app");
}

#[test]
fn a_hover_that_paints_nothing_sends_its_pointer_shape_and_keeps_the_cursor() {
    let mut client = Client::start(RemoteOptions::default(), quiet(), |app| {
        let input = Input::new(app).width(20);
        let button = View::new(app).height(1).mouse_pointer(MousePointer::POINTER).child(&Text::new(app, "Click"));
        app.root().add(&input).add(&button);
        input.focus();
    });
    client.wait_for("\x1b]22;default\x1b\\");
    client.send(b"\x1b[<35;4;2M");
    client.wait_for("\x1b]22;pointer\x1b\\");
    client.send(b"\x1b[<35;4;5M");
    client.wait_for("\x1b]22;default\x1b\\");
    let output = String::from_utf8_lossy(&client.output[..client.seen]).into_owned();
    assert!(output.rfind("\x1b[?25h") > output.rfind("\x1b[?25l"), "the cursor ends hidden: {output:?}");
    client.link.terminate();
    client.finish().expect("the app thread").expect("the app");
}

#[test]
fn a_remote_app_copies_and_reports_status_through_the_client_terminal() {
    use opentui::native::{ProgramKind, ProgramState, ProgramStatus};
    let mut client = Client::start(RemoteOptions::default(), quiet(), |app| {
        let text = Text::new(app, "ready");
        app.root().add(&text);
        app.on_key(move |cx, key| {
            if key.matches("q") {
                cx.quit();
            } else if key.matches("c") {
                // The system clipboard is the server's, so only OSC 52 takes the copy.
                assert!(cx.app().copy_to_clipboard("hi"));
                assert!(!cx.app().copy_to_clipboard(""));
                let status = ProgramStatus {
                    state: ProgramState::Blocked(Some(ProgramKind::Permission)),
                    id: "ses_1",
                    app: "opencode",
                    title: "Fix",
                    ..Default::default()
                };
                assert!(cx.app().set_program_status(status));
                let text = text.clone();
                cx.app().read_clipboard_as(&["image/png", "text/plain"], move |_, outcome| {
                    text.set_text(format!("read {outcome:?}"));
                });
            }
        });
    });
    client.wait_for("ready");
    client.send(b"c");
    client.wait_for("\x1b]52;c;aGk=\x1b\\");
    client.wait_for("\x1b]7501;state=blocked:id=ses_1:kind=permission:app=opencode:title=Rml4\x1b\\");
    // Remote apps cannot read the user's clipboard; the frame shows the outcome.
    client.wait_for("Unsupported");
    client.send(b"q");
    client.finish().expect("the app thread").expect("the app");
}

// Expected: after the terminal says its color scheme changed (`?997`), an app can ask for the palette again and gets
// the new colors, as Core's `getPalette` does after `clearPaletteCache`. Default colors the terminal did not report
// get Core's fallbacks, so native code takes the palette.
// Actual: the palette was read only at startup, and the notice reached no handler. Native code rejected a palette
// without default colors, here the startup one and the refresh without OSC 10, as an invalid argument.
#[test]
fn a_color_scheme_notice_lets_the_app_read_the_new_palette() {
    let options = AppOptions { palette_size: 2, ..quiet() };
    let mut client = Client::start(RemoteOptions::default(), options, |app| {
        let text = Text::new(app, "waiting");
        app.root().add(&text);
        app.on_color_scheme(|cx| cx.app().refresh_palette());
        app.on_palette(move |cx, palette| {
            let new = palette.colors == [Some(Color::rgb(255, 0, 0)), Some(Color::rgb(0, 255, 0))]
                && palette.background == Some(Color::rgb(255, 255, 255))
                && cx.app().palette().as_ref() == Some(palette);
            text.set_text(if new { "new palette" } else { "wrong palette" });
        });
        app.on_key(|cx, key| {
            if key.matches("q") {
                cx.quit();
            }
        });
    });
    // The startup query: answer only the device attributes, so the app starts with no colors.
    client.wait_for("\x1b]4;1;?\x07");
    client.send(b"\x1b[?62;22c");
    client.wait_for("waiting");
    client.send(b"\x1b[?997;2n");
    client.wait_for("\x1b]4;0;?\x07\x1b]4;1;?\x07\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07");
    // No OSC 10 answer: the refresh ends on its wait.
    client.send(b"\x1b]4;0;rgb:ffff/0000/0000\x07\x1b]4;1;rgb:00/ff/00\x1b\\");
    client.send(b"\x1b]11;rgb:ff/ff/ff\x07\x1b]12;rgb:80/80/80\x07");
    client.wait_for("new palette");
    client.send(b"q");
    client.finish().expect("the app thread").expect("the app");
}

// Expected: widgets, including a scrollback writer's, measure text with the width method native drawing uses, also
// after a reply changes it, as Core's `widthMethod` follows the renderer.
// Actual: `App::width_method` kept the method from before the reply, a scrollback writer's app kept it until its next
// render, and `NoZwj` was reported although native draws it as `Unicode`. Under ConPTY's DECRPM 2027 "unrecognized"
// reply, a ZWJ emoji measured 2 cells and drew 4: the table cell blanked it, the gutter sign was clipped, the input
// wrote over "💻", and a snapshot lost its wrapped row.
// Expected too: a surface rendered before the reply commits no rows until it renders again, as Core's `commitRows`.
// Actual: it committed the old cells, so the footer's tail column was 4 where the terminal drew 6.
#[test]
fn widgets_measure_text_with_the_width_method_a_reply_switches_to() {
    use opentui::split::{Scrollback, SnapshotOptions};
    use opentui::widget::{LineNumbers, LineSign, WrapMode};
    let zwj = "👩\u{200d}💻";
    // An environment variable, the replies and keys, the text, the method native draws with and whether the reply
    // changed it, the text's cells under it, the link snapshot, and the screen rows to check. Native draws NoZwj as
    // Unicode but the emulator splits the emoji, so only the method's row and the cursor show the app's measurement.
    // Only Ghostty's reply turns hyperlinks on; "l" updates the link before anything else reads the terminal state.
    let ghostty = &b"\x1b[?2027;2$y\x1bP>|ghostty 1.3.0\x1b\\lw"[..];
    let cases = [
        (("TERM", "xterm-256color"), &b"\x1b[?2027;0$yw"[..], zwj, "Wcwidth", true, 4, "go (https://a.b)", 0..5),
        (("TERM_PROGRAM", "vscode"), b"\x1b[?2027;2$yw", zwj, "Unicode", true, 2, "go", 0..5),
        (("TERM", "xterm-256color"), ghostty, "বাংলা", "UnicodeWide", true, 4, "go!", 0..5),
        (("OPENTUI_FORCE_NOZWJ", "1"), b"w", zwj, "Unicode", false, 2, "go (https://a.b)", 2..3),
    ];
    for (index, (variable, input, text, method, changed, cells, link, checked)) in cases.into_iter().enumerate() {
        let environment = vec![("TERM".into(), "xterm-256color".into()), (variable.0.into(), variable.1.into())];
        let options = RemoteOptions { width: 48, height: 6, environment };
        let mut client = Client::start(options, quiet(), move |app| {
            let editor = Textarea::new(app);
            editor.set_text("x");
            // Its cursor, after the text, must move with the reply's method.
            let early = Textarea::new(app);
            early.set_text(text);
            early.set_cursor_offset(u32::MAX);
            let gutter = LineNumbers::new(app, &editor).height(1).line_sign(0, LineSign::before(text, None));
            let table = Table::new(app)
                .set_columns([Column::new("").width(ColumnWidth::Cells(6)).align(Alignment::Right)])
                .show_header(false)
                .set_rows([[text]])
                .size(6, 1);
            let row = View::new(app).row().height(1).child(&table).child(&Text::new(app, "|"));
            // Dragged over "AB" after the text in the first case; the reply must not move the selection.
            let dragged = TextTable::new(app).grid_lines(false).set_content([[format!("{text}AB")]]);
            app.root().add(&row).add(&gutter).add(&dragged);
            // Made before the reply, as apps make their scrollback writer.
            let scrollback = Scrollback::new(app).unwrap();
            let link = Markdown::new(scrollback.app()).set_markdown("[go](https://a.b)");
            let surface = scrollback.surface(true).unwrap();
            surface.root().add(&Text::new(scrollback.app(), text));
            surface.render().unwrap();
            // A Code and a TextTable made before the reply must snapshot like ones made after it, colours included.
            let early_code = Code::new(scrollback.app()).wrap(WrapMode::Char).set_code(format!("{text}abcd"));
            let styled =
                move || [[["q".fg(Color::RED), text.fg(Color::RED), "AB".fg(Color::GREEN), "CD".fg(Color::BLUE)]]];
            let table = move |app: &App| TextTable::new(app).set_content(styled());
            let early_table = table(scrollback.app());
            app.on_key(move |cx, key| {
                if key.matches("l") {
                    // Updates a paragraph without making a node, so only `hyperlinks` reads the terminal state.
                    link.append("!");
                } else if key.matches("w") {
                    // Text and Markdown prose measure through the detached Session, Code through the app. Text comes
                    // first, before anything asks the app for its width method.
                    let line = format!("{text}abcd");
                    let shots = [
                        Text::new(scrollback.app(), &line).wrap(WrapMode::Char).as_any(),
                        Markdown::new(scrollback.app()).set_markdown(&line).as_any(),
                        Code::new(scrollback.app()).wrap(WrapMode::Char).set_code(&line).as_any(),
                        early_code.clone().as_any(),
                    ]
                    .map(|widget| {
                        let options = SnapshotOptions { width: Some(6), ..SnapshotOptions::default() };
                        let shot = scrollback.snapshot(&widget, options).unwrap().buffer.capture().unwrap().text();
                        shot.replace('\n', "/")
                    });
                    // Content set again after the reply, before anything else lays the table out.
                    early_table.set_content(styled());
                    let tables = [early_table.clone(), table(scrollback.app())].map(|widget| {
                        let options = SnapshotOptions { width: Some(6), ..SnapshotOptions::default() };
                        scrollback.snapshot(&widget, options).unwrap().buffer.capture().unwrap()
                    });
                    let link =
                        scrollback.snapshot(&link, SnapshotOptions::default()).unwrap().buffer.capture().unwrap();
                    let error = scrollback.app().session().context().last_error().unwrap();
                    let stale = surface.commit_rows(0, 1, None, true).is_err();
                    surface.render().unwrap();
                    surface.commit_rows(0, 1, None, true).unwrap();
                    let (method, link, cursor) = (cx.app().width_method(), link.text(), early.cursor_offset());
                    let same = tables[0] == tables[1];
                    let label = format!("m={method:?} {stale} {} {error:?} c={cursor} t={same}", link.trim_end());
                    let label = Text::new(cx.app(), label);
                    cx.app().root().add(&label).add(&Text::new(cx.app(), shots.join(" ")));
                } else if key.matches("i") {
                    // After frames laid the table out again: the drag still selects "AB".
                    let input = Input::new(cx.app()).set_value(format!("{text}yz{}", dragged.selected_text()));
                    cx.app().root().add(&input);
                    input.focus();
                }
            });
        });
        client.wait_for("|");
        // The first case starts with Unicode, so "A" is in column 3 and "B" in 4 (one-based) of row 3.
        if index == 0 {
            client.send(b"\x1b[<0;3;3M\x1b[<32;4;3M\x1b[<0;4;3m");
        }
        client.send(input);
        client.wait_for("m=");
        client.send(b"i");
        client.wait_for("yz");
        let host = opentui::testing::TestApp::new(48, 6);
        let screen = TerminalView::new(&host).size(48, 6).write(client.text()).screen();
        // A 6-cell snapshot wraps "cd" after a 4-cell text.
        let (pad, shot) = (" ".repeat(6 - cells as usize), if cells == 4 { "ab/cd" } else { "abcd" });
        let shots = vec![format!("{text}{shot}"); 4].join(" ");
        // The label ends with the Context's last error, which the snapshots leave none of, the early cursor, and
        // whether the early table snapshots like the late one.
        let label = format!("m={method} {changed} {link} None c={cells} t=true");
        let selected = if index == 0 { "AB" } else { "" };
        let rows = [format!("{pad}{text}|"), format!("{text} 1 x"), format!("{text}AB"), label, shots];
        let rows = [&rows[..], &[format!("{text}yz{selected}")]].concat();
        // Rows from the dragged table on are one lower than the cases name.
        let checked = checked.start + usize::from(checked.start >= 2)..checked.end + 1;
        let expected = (&rows[checked.clone()], Some((cells + 2 + if index == 0 { 2 } else { 0 }, 5)));
        assert_eq!((&screen.lines[checked], screen.cursor.position), expected, "{variable:?}");
        client.link.terminate();
        client.finish().expect("the app thread").expect("the app");
    }
}

// Expected: a table press held while a reply changes the width method keeps the text it was made on: dragged back to
// the start, it selects up to and including that character, as a press made after the reply would.
// Actual: the first drag after the reply anchored at the press's old screen column, which then lay elsewhere.
#[test]
fn a_table_press_held_across_a_width_reply_keeps_its_text() {
    let zwj = "👩\u{200d}💻";
    // A press on "A" (one-based column) is held while the reply arrives; then the pointer goes to "q", back over the
    // press's old column, to "q", into the second cell and to "q" again. A table made after the reply, pressed on its
    // "A", takes the same path. VS Code starts with wcwidth and its reply narrows the emoji, so the old column lies in
    // "BC"; a plain xterm starts with Unicode and its reply widens it, so the old column lies inside the emoji.
    let cases = [
        (("TERM_PROGRAM", "vscode"), "m=Unicode", 6, 4, [1, 6, 1, 5, 1]),
        (("TERM", "xterm-256color"), "m=Wcwidth", 4, 6, [1, 4, 1, 7, 1]),
    ];
    // With `leave`, each press goes into its second cell first: the early one before the reply. With `tall`, "A" is
    // on the second line of its cell.
    let variants = [(false, false), (true, false), (false, true)];
    for ((variable, method, early_press, late_press, path), (leave, tall)) in
        cases.into_iter().flat_map(|case| variants.map(|variant| (case, variant)))
    {
        let environment = vec![("TERM".into(), "xterm-256color".into()), (variable.0.into(), variable.1.into())];
        let options = RemoteOptions { width: 24, height: 8, environment };
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
        let record = seen.clone();
        let mut client = Client::start(options, quiet(), move |app| {
            let first = if tall { format!("x\nq{zwj}A") } else { format!("q{zwj}A") };
            let table = move |app: &App| {
                TextTable::new(app)
                    .grid_lines(false)
                    .column_width_mode(opentui::widget::ColumnWidthMode::Content)
                    .set_content([[first.clone(), "BC".to_owned()]])
            };
            let held = table(app);
            app.root().add(&held);
            let late = std::cell::RefCell::new(None::<TextTable>);
            app.on_key(move |cx, key| {
                if key.matches("w") {
                    cx.app().root().add(&Text::new(cx.app(), format!("m={:?}", cx.app().width_method())));
                    let made = table(cx.app());
                    cx.app().root().add(&made);
                    late.replace(Some(made));
                } else if key.matches("i") {
                    record.lock().unwrap().push(held.selected_text());
                } else if key.matches("l") {
                    let text = late.borrow().as_ref().map(TextTable::selected_text).unwrap_or_default();
                    record.lock().unwrap().push(text);
                } else if key.matches("d") {
                    cx.app().root().add(&Text::new(cx.app(), "done"));
                }
            });
        });
        // The rows of "A": the held table first, then the "m=" line and the late table.
        let (early_row, late_row) = if tall { (2, 5) } else { (1, 3) };
        let excursion =
            |press: i32, row: i32| if leave { format!("\x1b[<32;{};{row}M", press + 1) } else { String::new() };
        client.wait_for("BC");
        let reply = if method == "m=Unicode" { 2 } else { 0 };
        let press = format!("\x1b[<0;{early_press};{early_row}M{}", excursion(early_press, early_row));
        client.send(format!("{press}\x1b[?2027;{reply}$yw").as_bytes());
        client.wait_for(method);
        let mut input = String::new();
        for x in path {
            input.push_str(&format!("\x1b[<32;{x};{early_row}Mi"));
        }
        // A new press after the gesture starts from its own cell: from the emoji to "A".
        input.push_str(&format!("\x1b[<0;1;{early_row}m\x1b[<0;2;{early_row}M\x1b[<32;{late_press};{early_row}Mi"));
        input.push_str(&format!("\x1b[<0;{late_press};{early_row}m"));
        input.push_str(&format!("\x1b[<0;{late_press};{late_row}M{}", excursion(late_press, late_row)));
        for x in path {
            input.push_str(&format!("\x1b[<32;{x};{late_row}Ml"));
        }
        input.push_str(&format!("\x1b[<0;1;{late_row}md"));
        client.send(input.as_bytes());
        client.wait_for("done");
        let seen = seen.lock().unwrap().clone();
        let label = format!("{variable:?} leave={leave} tall={tall}");
        let (early, rest) = seen.split_at(path.len());
        assert_eq!(early, &rest[1..], "{label}");
        assert_eq!(early[0], format!("q{zwj}A"), "{label}");
        assert_eq!(rest[0], format!("{zwj}A"), "{label}");
        client.link.terminate();
        client.finish().expect("the app thread").expect("the app");
    }
}

// Expected: an image drawn before the terminal answers the capability queries switches to Kitty graphics once
// Ghostty replies to XTVERSION and the Kitty graphics query, as Core repaints on each capability reply.
// Actual: a reply forced the next frame but did not ask for one, so an app with nothing else to draw kept its
// first-frame half blocks until some unrelated change painted again.
// Expected too: the app asks for the pixel size (`CSI 14 t`) at setup and after a resize, as Core does, and a large
// image goes out as a copy at its placement's pixel size. Actual: it never asked, so the full upload of a 1290x810
// noise image was over the output budget and the image drew half blocks for good.
#[test]
fn images_switch_to_kitty_graphics_when_the_terminal_reports_support_after_the_first_frame() {
    use opentui::native::{Image, ImageFit};
    use opentui::widget::ImageView;
    let options = RemoteOptions {
        environment: vec![("TERM".into(), "xterm-256color".into()), ("TERM_PROGRAM".into(), "ghostty".into())],
        ..RemoteOptions::default()
    };
    // Without the capability window, only the pixel size query makes the parser wait for the rest of a reply.
    let mut app_options = quiet();
    app_options.host.capability_window = Duration::ZERO;
    let mut client = Client::start(options, app_options, |app| {
        let red = [255u8, 0, 0, 255].repeat(16 * 16);
        let image = Image::from_rgba(app.session().context(), 16, 16, &red).unwrap();
        let mut seed = 1u32;
        let noise: Vec<u8> = (0..1290 * 810 * 4)
            .map(|_| {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                (seed >> 16) as u8
            })
            .collect();
        let large = Image::from_rgba(app.session().context(), 1290, 810, &noise).unwrap();
        sizes(app);
        app.root()
            .add(&ImageView::new(app).size(8, 4).image(Some(image)))
            .add(&ImageView::new(app).fit(ImageFit::Cover).size(16, 8).image(Some(large)));
    });
    client.wait_for("\x1b_Gi=31337");
    // The first frame draws half blocks: no reply has come yet.
    client.wait_for("\x1b[?2026l");
    assert!(!client.text().contains("\x1b_Ga="), "{:?}", client.text());
    client.take_until("the pixel size query", |client| client.text().contains("\x1b[14t"));
    // The setup query's window has passed, so a resize asks again. Its reply comes after the late one for 80 columns,
    // and wins as in Core: cells of 10x20 pixels make the 16x8 box 160x160, not 128x128.
    client.link.resize(100, 30);
    client.wait_for("\x1b[14t");
    client.send(b"\x1bP>|ghostty 1.2.3\x1b\\\x1b_Gi=31337;OK\x1b\\\x1b[?62;22c\x1b[4;480;800t");
    client.send(b"\x1b[4;600;1000t");
    client.wait_for("s=160,v=160,");
    let text = client.text();
    let last = text.split(",s=").skip(1).filter(|size| !size.starts_with("16,v=16,")).last();
    assert!(last.is_some_and(|size| size.starts_with("160,v=160,")), "the last copy is not 160x160: {text:?}");
    // Cells of 10x30 pixels after two more resizes. The second comes while the first's query waits, whose reply then
    // describes the width before it: the app asks again instead of sizing the image by it (137x240).
    client.link.resize(120, 30);
    client.wait_for("\x1b[14t");
    client.link.resize(140, 30);
    client.wait_for("Hello remote 140x30");
    client.send(b"\x1b[4;900;1200t");
    client.wait_for("\x1b[14t");
    // A reply cut in two still answers it, not typed as keys.
    client.send(b"\x1b[4;900;14");
    // The remote app runs the real loop, so the escape timeout has to pass on the wall clock.
    std::thread::sleep(opentui::input::ESCAPE_TIMEOUT * 3);
    client.send(b"00t");
    client.wait_for("s=160,v=240,");
    assert!(!client.text().contains("s=137,v=240,"), "{:?}", client.text());
    client.send(b"q");
    client.finish().expect("the app thread").expect("the app");
}

// Expected: an image whose upload is larger than a frame, in a Contain view at HiDPI cells as in an image preview
// dialog, goes out in its first frame as one Kitty copy that fits the frame, placed over the view's cells.
// Actual: the full upload, then a copy at the view's pixel size, were each too large: two blank frames, then half blocks.
#[test]
fn an_image_larger_than_a_frame_shows_a_kitty_copy_that_fits_one() {
    use opentui::native::{Image, ImageFit, ImageProtocol, SessionOptions};
    use opentui::widget::ImageView;
    let mut app_options = quiet();
    app_options.host.session =
        SessionOptions { chunk_size: 16 * 1024, span_capacity: 16, max_bytes: 256 * 1024, control_capacity: 4096 };
    let mut client = Client::start(RemoteOptions::default(), app_options, |app| {
        let mut seed = 1u32;
        let noise: Vec<u8> = (0..600 * 480 * 4)
            .map(|index| {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                if index % 4 == 3 { 255 } else { (seed >> 16) as u8 }
            })
            .collect();
        let image = Image::from_rgba(app.session().context(), 600, 480, &noise).unwrap();
        let view = ImageView::new(app).protocol(ImageProtocol::Kitty).fit(ImageFit::Contain).size(30, 10);
        let view = view.image(Some(image));
        app.on_key(move |cx, key| {
            if key.matches("o") {
                cx.app().root().add(&view);
            } else if key.matches("q") {
                cx.quit();
            }
        });
    });
    client.wait_for("\x1b[14t");
    // Cells of 20x42 pixels: the view is 600x420, and the image fits it at 525x420, 882 KB as raw RGB in base64.
    client.send(b"\x1b[4;1008;1600to");
    client.take_until("the image", |client| client.text().contains("a=p,") || client.text().contains('\u{2580}'));
    let text = client.text();
    assert!(!text.contains('\u{2580}') && !text.contains('\u{2584}'), "half blocks");
    assert_eq!(text.matches("\x1b_Ga=t,").count(), 1);
    // The copy is placed whole over the view's cells.
    let (_, upload) = text.split_once("\x1b_Ga=t,").unwrap();
    let (upload, place) = upload.split_once("a=p,").unwrap();
    let keys: Vec<&str> = upload.split([',', ';']).take(3).collect();
    let whole = format!("c=26,r=10,x=0,y=0,w={},h={},", &keys[1][2..], &keys[2][2..]);
    assert!(upload.len() < 256 * 1024 && place.contains(&whole), "{keys:?} {place:?}");
    client.send(b"q");
    client.finish().expect("the app thread").expect("the app");
}
