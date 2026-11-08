//! The split footer against OpenTUI Core's split-footer renderer.
//!
//! `fixtures/split/render.ts` drives Core through each case and records the bytes every step writes. These tests
//! drive `opentui::split` through the same steps on a remote terminal and compare the bytes, then replay both byte
//! streams into an embedded terminal and compare the screens and scrollback.

use opentui::host::{Host, HostOptions};
use opentui::native::{
    Buffer, EmbeddedTerminal, EmbeddedTerminalOptions, KittyKeyboard, MouseTracking, Node, NodeKind, TerminalOptions,
    TextOptions,
};
use opentui::prelude::*;
use opentui::remote::{RemoteLink, RemoteOptions, RemoteTerminal};
use opentui::split::{Scrollback, ScrollbackSurface, SnapshotOptions, SplitFooter};
use std::path::PathBuf;
use std::time::{Duration, Instant};

const FOOTER_FG: Color = Color::rgb(0, 255, 0);
const ROW_FG: Color = Color::rgb(255, 170, 0);

struct Harness {
    host: Option<Host>,
    link: RemoteLink,
    footer: SplitFooter,
    scrollback: Scrollback,
    surface: Option<(ScrollbackSurface, Text)>,
    _nodes: (Node, Node),
}

impl Harness {
    /// Core's test terminal: remote, without environment, mouse, or the alternate screen, cleared on close.
    /// With `early`, the footer height changes after the Session exists and before the terminal is set up.
    fn start_with(width: u16, height: u16, footer_height: u16, cursor_row: u16, early: Option<u16>) -> Self {
        let remote = RemoteOptions { width, height, environment: Vec::new() };
        let (terminal, link) = RemoteTerminal::new(remote, || {}).expect("create a terminal");
        let options = HostOptions {
            terminal: TerminalOptions {
                alternate_screen: false,
                mouse: MouseTracking::Off,
                clear_on_close: true,
                kitty_keyboard: KittyKeyboard::DISAMBIGUATE | KittyKeyboard::ALTERNATE_KEYS,
                host_multiplexer: false,
            },
            split_footer: Some(footer_height),
            ..HostOptions::default()
        };
        let session = Host::new_remote_session(&terminal, &options).expect("create the session");
        if let Some(early) = early {
            let footer = SplitFooter::of(&session).expect("the session has a split footer");
            footer.set_footer_height(early).expect("change the footer height");
        }
        let mut host = Host::attach_remote(session, terminal, options).expect("start the host");
        link.send_input(format!("\x1b[{cursor_row};1R").as_bytes());
        let mut events = Vec::new();
        let until = Instant::now() + Duration::from_millis(50);
        while Instant::now() < until {
            host.poll(Some(until), &mut events).expect("read the cursor report");
        }
        let footer = SplitFooter::of(host.session()).expect("the host made a split footer");
        assert!(host.can_render().expect("read the host state"), "the cursor report did not place the footer");
        let root = Node::new(host.session(), NodeKind::Root, 1).expect("create the root");
        let text = Node::new(host.session(), NodeKind::Text, 2).expect("create the footer text");
        text.insert_into(&root, 0).expect("add the footer text");
        text.set_text_options(&TextOptions { fg: FOOTER_FG, ..TextOptions::default() }).expect("style the footer");
        text.set_text("footer").expect("set the footer text");
        let scrollback = Scrollback::for_session(host.session(), Theme::dark()).expect("create a scrollback writer");
        link.take_output(usize::MAX);
        Self { host: Some(host), link, footer, scrollback, surface: None, _nodes: (root, text) }
    }

    fn host(&mut self) -> &mut Host {
        self.host.as_mut().expect("the host runs")
    }

    fn frame(&mut self) {
        let host = self.host();
        let mut events = Vec::new();
        host.poll(Some(Instant::now()), &mut events).expect("poll");
        let draft = host.session().paint(Color::TRANSPARENT, false, 0).expect("paint the footer");
        host.present(draft).expect("present the footer");
        host.poll(Some(Instant::now()), &mut events).expect("poll");
    }

    fn write(&self, row: &str) {
        self.write_joined(row, true, true);
    }

    fn write_joined(&self, row: &str, start_on_new_line: bool, trailing_newline: bool) {
        let text = Text::new(self.scrollback.app(), row).fg(ROW_FG);
        let options = SnapshotOptions {
            width: Some(row.len() as u32),
            height: Some(1),
            start_on_new_line,
            trailing_newline,
            ..SnapshotOptions::default()
        };
        let snapshot = self.scrollback.snapshot(&text, options).expect("render a row");
        self.footer.write(snapshot).expect("queue a row");
    }

    fn resize(&mut self, width: u16, height: u16) {
        self.link.resize(width, height);
        let mut events = Vec::new();
        self.host().poll(Some(Instant::now() + Duration::from_millis(5)), &mut events).expect("poll the resize");
    }

    fn shutdown(&mut self) {
        self.host.take().expect("the host runs").shutdown().expect("close the host");
    }
}

type Step = (&'static str, fn(&mut Harness));

fn fixtures(case: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/split").join(case)
}

/// Bytes with escapes and controls spelled out, so a mismatch reads as terminal output.
fn shown(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).replace('\x1b', "^[").replace('\r', "^M").replace('\x07', "^G")
}

/// The screen and scrollback an emulator shows after the bytes of each step, resized as each step resizes.
fn screens(steps: &[(Vec<u8>, (u16, u16))], prefill: &[u8], rows: usize) -> Vec<String> {
    let context = opentui::native::Context::new(Default::default()).expect("create a context");
    let (width, height) = steps[0].1;
    let options = EmbeddedTerminalOptions { cols: width, rows: height, ..EmbeddedTerminalOptions::default() };
    let terminal = EmbeddedTerminal::new(&context, options).expect("create an emulator");
    terminal.write(prefill).expect("prefill");
    steps
        .iter()
        .map(|(bytes, (width, height))| {
            terminal.resize(*width, *height).expect("resize the emulator");
            terminal.write(bytes).expect("write");
            terminal.scroll(-(rows as i32)).expect("scroll back");
            let buffer = Buffer::new(&context, u32::from(*width), u32::from(*height), Default::default())
                .expect("create a buffer");
            terminal.invalidate().expect("invalidate");
            terminal.compose(&buffer, 0, 0).expect("compose");
            terminal.scroll_to_bottom().expect("scroll to the bottom");
            let back = buffer.capture().expect("capture").text();
            terminal.invalidate().expect("invalidate");
            terminal.compose(&buffer, 0, 0).expect("compose");
            format!("{back}\n---\n{}", buffer.capture().expect("capture").text())
        })
        .collect()
}

fn compare(case: &str, size: (u16, u16, u16, u16), steps: &[Step]) {
    compare_with(case, size, None, steps);
}

fn compare_with(case: &str, size: (u16, u16, u16, u16), early: Option<u16>, steps: &[Step]) {
    let (width, height, footer_height, cursor_row) = size;
    let mut harness = Harness::start_with(width, height, footer_height, cursor_row, early);
    let mut ours = Vec::new();
    let mut core = Vec::new();
    for (index, (name, step)) in steps.iter().enumerate() {
        step(&mut harness);
        let bytes = harness.link.take_output(usize::MAX);
        let size = harness.footer.terminal_size();
        let path = fixtures(case).join(format!("{index:02}-{name}.bin"));
        let expected = std::fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        assert_eq!(shown(&bytes), shown(&expected), "{case}: step {name} wrote other bytes than Core");
        ours.push((bytes, size));
        core.push((expected, size));
    }
    let prefill: Vec<u8> = (1..cursor_row).flat_map(|row| format!("shell {row}\r\n").into_bytes()).collect();
    assert_eq!(screens(&ours, &prefill, 40), screens(&core, &prefill, 40), "{case}: the screens differ");
}

#[test]
fn footer_writes_grows_shrinks_resizes_replays_and_leaves_as_core() {
    compare(
        "basic",
        (40, 10, 3, 4),
        &[
            ("footer", Harness::frame),
            ("write", |h| {
                h.write("alpha");
                h.write("beta");
                h.frame();
            }),
            ("grow", |h| {
                h.footer.set_footer_height(5).expect("grow the footer");
                h.frame();
            }),
            ("write-grown", |h| {
                h.write("gamma");
                h.frame();
            }),
            ("shrink", |h| {
                h.footer.set_footer_height(2).expect("shrink the footer");
                h.frame();
            }),
            ("resize", |h| {
                h.resize(30, 12);
                h.frame();
            }),
            ("replay", |h| {
                h.footer.reset_for_replay(true).expect("reset for replay");
                h.write("delta");
                h.frame();
            }),
            ("leave", |h| {
                h.footer.leave().expect("leave the split footer");
                h.shutdown();
            }),
        ],
    );
}

#[test]
fn footer_changes_wait_for_queued_rows_and_rows_join_at_the_tail_as_core() {
    compare(
        "deferred",
        (32, 9, 2, 6),
        &[
            ("footer", Harness::frame),
            ("grow-queued", |h| {
                h.write("one");
                h.write("two");
                h.footer.set_footer_height(4).expect("grow the footer");
                assert_eq!(h.footer.footer_height(), 4, "a change that waits still reads back");
                h.frame();
            }),
            ("after", Harness::frame),
            ("there-and-back", |h| {
                h.footer.set_footer_height(2).expect("shrink the footer");
                h.footer.set_footer_height(4).expect("grow the footer");
                h.write("three");
                h.frame();
            }),
            ("narrow", |h| {
                h.footer.set_footer_height(3).expect("shrink the footer");
                h.resize(24, 9);
                h.frame();
            }),
            ("tail", |h| {
                h.write_joined("ab", true, false);
                let tail = h.footer.tail_column();
                h.write_joined(&format!("cd@{tail}"), false, true);
                h.frame();
            }),
            ("close", Harness::shutdown),
        ],
    );
}

#[test]
fn a_surface_commits_rows_as_they_settle_as_core() {
    compare(
        "surface",
        (30, 10, 2, 3),
        &[
            ("footer", Harness::frame),
            ("first", |h| {
                let surface = h.scrollback.surface(true).expect("create a surface");
                let text = Text::new(h.scrollback.app(), "one\ntwo\nthree").fg(ROW_FG);
                surface.root().add(&text);
                surface.render().expect("render the surface");
                assert_eq!(surface.height(), 3);
                let rows = surface.commit_rows(0, 2, None, true).expect("commit rows").expect("two rows");
                h.footer.write(rows).expect("queue the rows");
                h.surface = Some((surface, text));
                h.frame();
            }),
            ("rest", |h| {
                let (surface, text) = h.surface.take().expect("the surface");
                text.set_text("one\ntwo\nthree\nfour");
                surface.render().expect("render the surface");
                let rows = surface.commit_rows(2, surface.height(), None, true).expect("commit rows").expect("rows");
                h.footer.write(rows).expect("queue the rows");
                h.frame();
            }),
            ("close", Harness::shutdown),
        ],
    );
}

// Expected: a footer height set before the terminal is set up sizes the renderer, as Core's `footerHeight` setter
// does before `setupTerminal`. Actual: only the requested height changed; the renderer kept the startup height.
#[test]
fn a_footer_height_set_before_setup_sizes_the_renderer_as_core() {
    compare_with(
        "early",
        (40, 10, 3, 4),
        Some(6),
        &[
            ("footer", |h| {
                assert_eq!(h.host().size(), (40, 6), "the renderer has the early footer height");
                h.frame();
            }),
            ("write", |h| {
                h.write("alpha");
                h.frame();
            }),
            ("close", Harness::shutdown),
        ],
    );
}

#[test]
fn queued_rows_go_out_eight_per_frame_and_drain_at_close_as_core() {
    compare(
        "many",
        (20, 8, 2, 1),
        &[
            ("footer", Harness::frame),
            ("write", |h| {
                for row in 0..12 {
                    h.write(&format!("row {row}"));
                }
                h.frame();
            }),
            ("rest", Harness::frame),
            ("close", |h| {
                h.write("last");
                h.shutdown();
            }),
        ],
    );
}

/// The screen an emulator of `size` shows for `output`, after `prefill`.
fn screen_of(size: (u16, u16), prefill: &[u8], output: &[u8]) -> String {
    let context = opentui::native::Context::new(Default::default()).expect("create a context");
    let options = EmbeddedTerminalOptions { cols: size.0, rows: size.1, ..EmbeddedTerminalOptions::default() };
    let terminal = EmbeddedTerminal::new(&context, options).expect("create an emulator");
    terminal.write(prefill).expect("prefill");
    terminal.write(output).expect("write");
    let buffer = Buffer::new(&context, u32::from(size.0), u32::from(size.1), Default::default()).expect("buffer");
    terminal.compose(&buffer, 0, 0).expect("compose");
    buffer.capture().expect("capture").text()
}

// An app in split-footer mode: its root lays out in the footer, rows it writes land above, a footer height change
// reaches its resize handlers, and leaving clears the footer so the shell continues below the scrollback.
#[test]
fn an_app_lays_out_in_the_footer_and_writes_scrollback_above_it() {
    let (terminal, link) = RemoteTerminal::new(RemoteOptions { width: 40, height: 10, environment: Vec::new() }, || {})
        .expect("create a terminal");
    let app = std::thread::spawn(move || {
        let mut options = AppOptions::default().with_theme(Theme::dark());
        options.host.split_footer = Some(3);
        let app = App::remote(terminal, options)?;
        let footer = SplitFooter::of(app.session()).expect("the app has a split footer");
        let scrollback = Scrollback::new(&app)?;
        let label = |app: &App| format!("footer {}x{}", app.size().0, app.size().1);
        let text = Text::new(&app, label(&app));
        app.root().add(&text);
        app.on_resize(move |cx, _, _| {
            text.set_text(label(cx.app()));
        });
        let mut rows = 0;
        app.on_key(move |cx, key| {
            if key.matches("w") {
                let row = Text::new(scrollback.app(), format!("row {rows}"));
                rows += 1;
                let snapshot = scrollback.snapshot(&row, SnapshotOptions::default()).expect("render a row");
                footer.write(snapshot).expect("queue a row");
            } else if key.matches("g") {
                footer.set_footer_height(5).expect("grow the footer");
            } else if key.matches("q") {
                footer.leave().expect("leave the footer");
                cx.quit();
            }
        });
        app.run()
    });
    let prefill = b"shell 1\r\nshell 2\r\nshell 3\r\n";
    let mut output = Vec::new();
    let wait_for = |what: &str, output: &mut Vec<u8>| {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            output.extend(link.take_output(usize::MAX));
            let screen = screen_of((40, 10), prefill, output);
            if screen.contains(what) {
                return screen;
            }
            assert!(Instant::now() < deadline, "timed out waiting for {what:?}; screen:\n{screen}");
            std::thread::sleep(Duration::from_millis(5));
        }
    };
    link.send_input(b"\x1b[4;1R");
    wait_for("footer 40x3", &mut output);
    link.send_input(b"ww");
    let screen = wait_for("row 1", &mut output);
    assert_eq!(screen, "shell 1\nshell 2\nshell 3\nrow 0\nrow 1\n\nfooter 40x3\n\n\n");
    link.send_input(b"g");
    let screen = wait_for("footer 40x5", &mut output);
    assert_eq!(screen, "shell 2\nshell 3\nrow 0\nrow 1\n\nfooter 40x5\n\n\n\n");
    link.send_input(b"wq");
    app.join().expect("the app thread").expect("the app runs");
    output.extend(link.take_output(usize::MAX));
    let screen = screen_of((40, 10), prefill, &output);
    assert_eq!(screen, "shell 3\nrow 0\nrow 1\nrow 2\n\n\n\n\n\n");
}

// Expected: an app that changes its footer height before it runs lays out in the new height from its first frame.
// Actual: the root laid out in the new height while the renderer kept the startup one.
#[test]
fn an_app_that_grows_its_footer_before_running_starts_at_that_height() {
    let (terminal, link) = RemoteTerminal::new(RemoteOptions { width: 40, height: 10, environment: Vec::new() }, || {})
        .expect("create a terminal");
    let app = std::thread::spawn(move || {
        let mut options = AppOptions::default().with_theme(Theme::dark());
        options.host.split_footer = Some(3);
        let app = App::remote(terminal, options)?;
        let footer = SplitFooter::of(app.session()).expect("the app has a split footer");
        footer.set_footer_height(5)?;
        let text = Text::new(&app, "top");
        let bottom = Text::new(&app, "bottom");
        app.root().add(&text).add(&View::new(&app).grow(1.0)).add(&bottom);
        app.on_key(move |cx, key| {
            if key.matches("q") {
                cx.quit();
            }
        });
        app.run()
    });
    link.send_input(b"\x1b[1;1R");
    let mut output = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    let screen = loop {
        output.extend(link.take_output(usize::MAX));
        let screen = screen_of((40, 10), b"", &output);
        if screen.contains("bottom") {
            break screen;
        }
        assert!(Instant::now() < deadline, "timed out waiting for the footer; screen:\n{screen}");
        std::thread::sleep(Duration::from_millis(5));
    };
    link.send_input(b"q");
    app.join().expect("the app thread").expect("the app runs");
    assert_eq!(screen, "\ntop\n\n\n\nbottom\n\n\n\n");
}
