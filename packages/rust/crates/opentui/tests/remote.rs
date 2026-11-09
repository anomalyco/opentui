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
    // The client stops reading for a while; the app keeps running but its output waits.
    std::thread::sleep(Duration::from_millis(300));
    let held = client.link.take_output(usize::MAX);
    assert!(held.len() <= OUTPUT_BYTES_MAX, "the link held {} bytes", held.len());
    assert!(held.len() > OUTPUT_BYTES_MAX / 2, "the app filled the link: {} bytes", held.len());
    // The link fills again, and the client quits and reads 64 bytes every 20 ms: the frame queued behind the link
    // would take seconds. Bytes keep moving, so the close goes on until its cap of ten timeouts, then drops that
    // frame and restores the terminal behind what the link holds.
    std::thread::sleep(Duration::from_millis(300));
    client.send(b"q");
    let quit = Instant::now();
    while !client.app.as_ref().expect("the app thread").is_finished() {
        client.output.extend(client.link.take_output(64));
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(quit.elapsed() < Duration::from_secs(2), "the close took {:?}", quit.elapsed());
    client.wait_for(LEAVE_ALT);
    client.finish().expect("the app thread").expect("the app");
}

#[test]
fn a_message_before_the_app_goes_straight_to_the_client() {
    let (wake, woken) = mpsc::channel();
    let (terminal, link) = RemoteTerminal::new(RemoteOptions::default(), move || {
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
// the new colors, as Core's `getPalette` does after `clearPaletteCache`.
// Actual: the palette was read only at startup, and the notice reached no handler.
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
    // The startup query: answer only the device attributes, so the app starts with no palette.
    client.wait_for("\x1b]4;1;?\x07");
    client.send(b"\x1b[?62;22c");
    client.wait_for("waiting");
    client.send(b"\x1b[?997;2n");
    client.wait_for("\x1b]4;0;?\x07\x1b]4;1;?\x07\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07");
    client.send(b"\x1b]4;0;rgb:ffff/0000/0000\x07\x1b]4;1;rgb:00/ff/00\x1b\\\x1b]10;rgb:00/00/00\x07");
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
#[test]
fn widgets_measure_text_with_the_width_method_a_reply_switches_to() {
    use opentui::split::{Scrollback, SnapshotOptions};
    use opentui::widget::{LineNumbers, LineSign, WrapMode};
    let zwj = "👩\u{200d}💻";
    // An environment variable, the replies and keys, the text, whether the emulator clusters graphemes, the method
    // native draws with, the text's cells under it, the link snapshot, and the screen rows to check. Native draws NoZwj
    // as Unicode but the emulator splits the emoji, so only the method's row and the cursor show the app's measurement.
    // Only Ghostty's reply turns hyperlinks on; "l" updates the link before anything else reads the terminal state.
    let ghostty = &b"\x1b[?2027;2$y\x1bP>|ghostty 1.3.0\x1b\\lw"[..];
    let cases = [
        (("TERM", "xterm-256color"), &b"\x1b[?2027;0$yw"[..], zwj, false, "Wcwidth", 4, "go (https://a.b)", 0..5),
        (("TERM_PROGRAM", "vscode"), b"\x1b[?2027;2$yw", zwj, true, "Unicode", 2, "go", 0..5),
        (("TERM", "xterm-256color"), ghostty, "বাংলা", true, "UnicodeWide", 4, "go!", 0..5),
        (("OPENTUI_FORCE_NOZWJ", "1"), b"w", zwj, true, "Unicode", 2, "go (https://a.b)", 2..3),
    ];
    for (variable, input, text, clusters, method, cells, link, checked) in cases {
        let environment = vec![("TERM".into(), "xterm-256color".into()), (variable.0.into(), variable.1.into())];
        let options = RemoteOptions { width: 48, height: 5, environment };
        let mut client = Client::start(options, quiet(), move |app| {
            let editor = Textarea::new(app);
            editor.set_text("x");
            let gutter = LineNumbers::new(app, &editor).height(1).line_sign(0, LineSign::before(text, None));
            let table = Table::new(app)
                .set_columns([Column::new("").width(ColumnWidth::Cells(6)).align(Alignment::Right)])
                .show_header(false)
                .set_rows([[text]])
                .size(6, 1);
            let row = View::new(app).row().height(1).child(&table).child(&Text::new(app, "|"));
            app.root().add(&row).add(&gutter);
            // Made before the reply, as apps make their scrollback writer.
            let scrollback = Scrollback::new(app).unwrap();
            let link = Markdown::new(scrollback.app()).set_markdown("[go](https://a.b)");
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
                    ]
                    .map(|widget| {
                        let options = SnapshotOptions { width: Some(6), ..SnapshotOptions::default() };
                        let shot = scrollback.snapshot(&widget, options).unwrap().buffer.capture().unwrap().text();
                        shot.replace('\n', "/")
                    });
                    let link =
                        scrollback.snapshot(&link, SnapshotOptions::default()).unwrap().buffer.capture().unwrap();
                    let error = scrollback.app().session().context().last_error().unwrap();
                    let label = format!("m={:?} {} {error:?}", cx.app().width_method(), link.text().trim_end());
                    let label = Text::new(cx.app(), label);
                    cx.app().root().add(&label).add(&Text::new(cx.app(), shots.join(" ")));
                } else if key.matches("i") {
                    let input = Input::new(cx.app()).set_value(format!("{text}yz"));
                    cx.app().root().add(&input);
                    input.focus();
                }
            });
        });
        client.wait_for("|");
        client.send(input);
        client.wait_for("m=");
        client.send(b"i");
        client.wait_for("yz");
        let host = opentui::testing::TestApp::new(48, 5);
        let output = if clusters { client.text() } else { client.text().replace("\x1b[?2027h", "") };
        let screen = TerminalView::new(&host).size(48, 5).write(output).screen();
        // A 6-cell snapshot wraps "cd" after a 4-cell text.
        let (pad, shot) = (" ".repeat(6 - cells as usize), if cells == 4 { "ab/cd" } else { "abcd" });
        let shots = vec![format!("{text}{shot}"); 3].join(" ");
        // The label ends with the Context's last error: the snapshots leave none.
        let rows = [format!("{pad}{text}|"), format!("{text} 1 x"), format!("m={method} {link} None"), shots];
        let rows = [&rows[..], &[format!("{text}yz")]].concat();
        let expected = (&rows[checked.clone()], Some((cells + 2, 4)));
        assert_eq!((&screen.lines[checked], screen.cursor.position), expected, "{variable:?}");
        client.link.terminate();
        client.finish().expect("the app thread").expect("the app");
    }
}

// Expected: an image drawn before the terminal answers the capability queries switches to Kitty graphics once
// Ghostty replies to XTVERSION and the Kitty graphics query, as Core repaints on each capability reply.
// Actual: a reply forced the next frame but did not ask for one, so an app with nothing else to draw kept its
// first-frame half blocks until some unrelated change painted again.
#[test]
fn images_switch_to_kitty_graphics_when_the_terminal_reports_support_after_the_first_frame() {
    let options = RemoteOptions {
        environment: vec![("TERM".into(), "xterm-256color".into()), ("TERM_PROGRAM".into(), "ghostty".into())],
        ..RemoteOptions::default()
    };
    let mut client = Client::start(options, quiet(), |app| {
        let red = [255u8, 0, 0, 255].repeat(16 * 16);
        let image = opentui::native::Image::from_rgba(app.session().context(), 16, 16, &red).unwrap();
        app.root().add(&opentui::widget::ImageView::new(app).size(8, 4).image(Some(image)));
        app.on_key(|cx, key| {
            if key.matches("q") {
                cx.quit();
            }
        });
    });
    client.wait_for("\x1b_Gi=31337");
    // The first frame draws half blocks: no reply has come yet.
    client.wait_for("\x1b[?2026l");
    assert!(!client.text().contains("\x1b_Ga="), "{:?}", client.text());
    client.send(b"\x1bP>|ghostty 1.2.3\x1b\\\x1b_Gi=31337;OK\x1b\\\x1b[?62;22c");
    client.wait_for("\x1b_Ga=t");
    client.send(b"q");
    client.finish().expect("the app thread").expect("the app");
}
