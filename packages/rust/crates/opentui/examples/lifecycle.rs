//! A fixture for terminal lifecycle checks: `scripts/pty-smoke.py` and `tests/lifecycle.rs` drive it under a
//! pseudo-terminal.
//!
//! Keys: p panics, e returns an error, w writes to stderr (captured with `--app`), c (with `--app`) copies to the
//! clipboard and then sets the title, m copies 17 times and then sets the title, v reads the clipboard, prints the
//! outcome, and copies, Ctrl+Z suspends, r (with `--app`) releases the terminal to read one line in cooked mode, as an
//! external editor would (the line "quit" quits), P (with `--app`) releases it to a task that enters raw mode and
//! panics, q quits. Every exit path must restore the terminal. With `--app`, the same fixture runs on the framework's
//! [`App::run`] instead of a hand-written host loop, and shows the terminal's theme mode. With `--modes`, it only prints
//! the console's input and output modes, on Windows, so a check can compare them before and after a run.

use opentui::host::{Host, HostOptions};
use opentui::input::Event;
use opentui::native::{Node, NodeKind};
use opentui::prelude::*;
use opentui::style::Color;
use opentui::{Error, Result};
use std::time::{Duration, Instant};

/// Paints the frame number and terminal size, so the driver can tell frames apart.
struct Status {
    app: App,
}

impl Component for Status {
    fn paint(&self, painter: &mut Painter<'_>) {
        let (width, height) = self.app.size();
        let frame = self.app.frame_number();
        let theme = match self.app.theme_mode() {
            Some(ThemeMode::Dark) => "dark",
            Some(ThemeMode::Light) => "light",
            None => "unknown",
        };
        let known = self.app.palette().map_or(0, |palette| palette.colors.iter().flatten().count());
        let status = format!("lifecycle frame {frame} size {width}x{height} theme {theme} palette {known}");
        painter.text(0, 0, &status, Style::new());
    }
}

fn run_app() -> Result<()> {
    let app = App::new(AppOptions { capture_stderr: true, palette_size: 16, ..AppOptions::default() })?;
    let status = Custom::new(&app, Status { app: app.clone() }).height(1);
    app.root().add(&status);
    app.on_theme_mode(|cx, _mode| cx.request_redraw());
    app.on_key(|cx, key| {
        if key.matches("q") {
            cx.quit();
        } else if key.matches("p") {
            panic!("lifecycle fixture panic");
        } else if key.matches("e") {
            cx.fail(Error::Usage("lifecycle fixture error"));
        } else if key.matches("w") {
            eprintln!("lifecycle stderr line");
        } else if key.matches("c") || key.matches("m") {
            let copies = if key.matches("m") { 0..=16 } else { 0..=0 };
            for copy in copies {
                cx.app().copy_to_clipboard(&format!("lifecycle copy {copy}"));
            }
            cx.app().set_title("lifecycle copied");
        } else if key.matches("v") {
            cx.app().read_clipboard_as(&["text/plain"], |cx, outcome| {
                println!("lifecycle clipboard {outcome:?}");
                cx.app().copy_to_clipboard("lifecycle copy 0");
            });
        } else if key.matches("r") {
            cx.app().release_terminal(|cx| {
                println!("lifecycle released");
                let mut line = String::new();
                let _ = std::io::stdin().read_line(&mut line);
                println!("lifecycle read {}", line.trim_end());
                if line.trim_end() == "quit" {
                    cx.quit();
                }
            });
        } else if key.matches("shift+p") {
            cx.app().release_terminal(|_| {
                // As an editor that crashes: it changed the terminal modes and leaves them so.
                std::mem::forget(opentui::term::Terminal::open());
                panic!("lifecycle fixture panic");
            });
        }
    });
    app.run()
}

fn run(host: &mut Host) -> Result<()> {
    let session = host.session().clone();
    let root = Node::new(&session, NodeKind::Root, 1)?;
    let text = Node::new(&session, NodeKind::Text, 2)?;
    text.insert_into(&root, 0)?;
    let mut frames = 0u32;
    let mut dirty = true;
    let mut events = Vec::new();
    loop {
        let mut suspend = false;
        for event in events.drain(..) {
            match event {
                Event::Key(_) if suspend => {}
                Event::Key(key) if key.matches("q") => return Ok(()),
                Event::Key(key) if key.matches("p") => panic!("lifecycle fixture panic"),
                Event::Key(key) if key.matches("e") => return Err(Error::Usage("lifecycle fixture error")),
                Event::Key(key) if key.matches("ctrl+z") => suspend = true,
                Event::Terminate => return Ok(()),
                Event::Resize { .. } | Event::Resumed => dirty = true,
                _ => {}
            }
        }
        if suspend {
            host.suspend(&mut events)?;
            continue;
        }
        if dirty && host.can_render()? {
            frames += 1;
            let (width, height) = host.size();
            text.set_text(format!("lifecycle frame {frames} size {width}x{height}"))?;
            host.present(session.paint(Color::TRANSPARENT, true, 0)?)?;
            dirty = false;
        }
        host.poll(dirty.then(|| Instant::now() + Duration::from_millis(2)), &mut events)?;
    }
}

#[cfg(windows)]
fn print_console_modes() {
    use windows_sys::Win32::System::Console::{GetConsoleMode, GetStdHandle, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE};
    let mode = |which| {
        let mut mode = 0;
        unsafe { GetConsoleMode(GetStdHandle(which), &mut mode) };
        mode
    };
    println!("console modes {:#x} {:#x}", mode(STD_INPUT_HANDLE), mode(STD_OUTPUT_HANDLE));
}

fn main() -> std::process::ExitCode {
    #[cfg(windows)]
    if std::env::args().any(|argument| argument == "--modes") {
        print_console_modes();
        return std::process::ExitCode::SUCCESS;
    }
    let result = if std::env::args().any(|argument| argument == "--app") {
        // Off the main thread, which a process-directed signal reaches first, as in apps that run their UI elsewhere.
        std::thread::spawn(run_app).join().unwrap_or_else(|_| std::process::exit(101))
    } else {
        Host::start(HostOptions::default()).and_then(|mut host| {
            let result = run(&mut host);
            let closed = host.shutdown();
            result.and(closed)
        })
    };
    match result {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Error: {error}");
            std::process::ExitCode::FAILURE
        }
    }
}
