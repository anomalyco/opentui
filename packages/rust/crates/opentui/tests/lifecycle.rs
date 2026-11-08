//! The lifecycle example on a pseudo-terminal: every exit path leaves the alternate screen and restores the terminal.
//! Runs on Unix and Windows; on Unix, `scripts/pty-smoke.py` also checks signals, job control, and termios.

use opentui::pty::Pty;
use opentui::testing::TestApp;
use std::cell::{Cell, RefCell};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};
use std::rc::Rc;
use std::time::Duration;

const ENTER_ALT: &str = "\x1b[?1049h";
const LEAVE_ALT: &str = "\x1b[?1049l";

/// The lifecycle example, which `cargo test` builds along with the tests.
fn fixture() -> PathBuf {
    let test = std::env::current_exe().unwrap();
    let examples = test.parent().and_then(Path::parent).unwrap().join("examples");
    let path = examples.join(format!("lifecycle{}", std::env::consts::EXE_SUFFIX));
    assert!(path.is_file(), "{} is missing: build the examples, as `cargo test` without filters does", path.display());
    path
}

/// The fixture running on a pseudo-terminal, with its output collected.
struct Run {
    app: TestApp,
    pty: Pty,
    output: Rc<RefCell<Vec<u8>>>,
    exit: Rc<Cell<Option<ExitStatus>>>,
}

impl Run {
    fn start(command: Command) -> Self {
        let app = TestApp::new(80, 24);
        let (output, exit) = (Rc::new(RefCell::new(Vec::new())), Rc::new(Cell::new(None)));
        let pty = Pty::spawn(&app, command, 80, 24)
            .unwrap()
            .on_output({
                let output = Rc::clone(&output);
                move |_cx, bytes| output.borrow_mut().extend_from_slice(bytes)
            })
            .on_exit({
                let exit = Rc::clone(&exit);
                move |_cx, status| exit.set(Some(status))
            });
        Self { app, pty, output, exit }
    }

    fn fixture(arguments: &[&str]) -> Self {
        let mut command = Command::new(fixture());
        command.args(arguments);
        Self::start(command)
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output.borrow()).into_owned()
    }

    fn wait_for(&self, text: &str) {
        let seen = self.app.wait_until(Duration::from_secs(10), || self.text().contains(text));
        assert!(seen, "never saw {text:?} in {:?}", self.text());
    }

    fn press(&self, key: &str) {
        self.pty.write(key.as_bytes()).unwrap();
    }

    /// The exit code, once the program exits.
    fn code(&self) -> Option<i32> {
        assert!(self.app.wait_until(Duration::from_secs(10), || self.exit.get().is_some()), "{:?}", self.text());
        self.exit.get().and_then(|status| status.code())
    }

    /// What the program wrote after leaving the alternate screen, which it must have entered before.
    fn after_leaving(&self) -> String {
        let text = self.text();
        let enter = text.find(ENTER_ALT).unwrap_or_else(|| panic!("never entered the alternate screen: {text:?}"));
        let leave = text.rfind(LEAVE_ALT).unwrap_or_else(|| panic!("never left the alternate screen: {text:?}"));
        assert!(enter < leave, "entered the alternate screen again after leaving: {text:?}");
        text[leave..].to_owned()
    }
}

/// The fixture with its hand-written host loop, and on `App::run`.
const MODES: [&[&str]; 2] = [&[], &["--app"]];

#[test]
fn quitting_restores_the_terminal() {
    for arguments in MODES {
        let run = Run::fixture(arguments);
        run.wait_for("lifecycle frame 1");
        run.press("q");
        assert_eq!(run.code(), Some(0), "{arguments:?}");
        run.after_leaving();
    }
}

#[test]
fn resizes_are_drawn() {
    for arguments in MODES {
        let run = Run::fixture(arguments);
        run.wait_for("lifecycle frame 1");
        run.pty.resize(100, 30).unwrap();
        run.wait_for("size 100x30");
        run.press("q");
        assert_eq!(run.code(), Some(0), "{arguments:?}");
    }
}

#[test]
fn errors_and_panics_print_after_the_terminal_is_restored() {
    for arguments in MODES {
        for (key, code, message) in [("e", 1, "lifecycle fixture error"), ("p", 101, "lifecycle fixture panic")] {
            let run = Run::fixture(arguments);
            run.wait_for("lifecycle frame 1");
            run.press(key);
            assert_eq!(run.code(), Some(code), "{arguments:?} {key}");
            assert!(run.after_leaving().contains(message), "{arguments:?} {key}: {:?}", run.text());
        }
    }
}

#[test]
fn captured_stderr_stays_off_the_screen() {
    let run = Run::fixture(&["--app"]);
    run.wait_for("lifecycle frame 1");
    run.press("w");
    run.app.wait_until(Duration::from_millis(300), || false);
    run.press("q");
    assert_eq!(run.code(), Some(0));
    let (text, after) = (run.text(), run.after_leaving());
    let line = "lifecycle stderr line";
    assert!(!text[..text.len() - after.len()].contains(line), "{text:?}");
    assert!(after.contains(line), "{text:?}");
}

/// A released terminal is the program's to read in cooked mode, and the app draws again afterwards.
#[cfg(unix)]
#[test]
fn releasing_hands_the_terminal_over_and_takes_it_back() {
    let run = Run::fixture(&["--app"]);
    run.wait_for("lifecycle frame 1");
    run.press("r");
    run.wait_for("lifecycle released");
    let text = run.text();
    let released = text.find("lifecycle released").unwrap();
    assert!(text[..released].contains(LEAVE_ALT), "the alternate screen is still active: {text:?}");
    run.press("hello\r");
    run.wait_for("lifecycle read hello");
    let read = run.text().find("lifecycle read hello").unwrap();
    let seen = run.app.wait_until(Duration::from_secs(10), || run.text()[read..].contains(ENTER_ALT));
    assert!(seen, "the app never took the terminal back: {:?}", run.text());
    run.press("q");
    assert_eq!(run.code(), Some(0));
    run.after_leaving();
}

/// Each exit path puts the console's input and output modes back as it found them.
#[cfg(windows)]
#[test]
fn console_modes_are_restored() {
    let fixture = fixture();
    assert!(!fixture.to_string_lossy().contains(' '), "the script below does not quote {}", fixture.display());
    for arguments in MODES {
        for key in ["q", "e", "p"] {
            let script = format!("{0} --modes & {0} {1} & {0} --modes", fixture.display(), arguments.join(" "));
            let mut command = Command::new("cmd.exe");
            command.args(["/d", "/s", "/c", &script]);
            let run = Run::start(command);
            run.wait_for("lifecycle frame 1");
            run.press(key);
            run.code();
            let text = run.text();
            // Each report ends where the console's rendering resumes: a line break or an escape sequence.
            let modes: Vec<&str> = text
                .match_indices("console modes ")
                .map(|(at, _)| text[at..].split(|c: char| c.is_control()).next().unwrap_or("").trim_end())
                .collect();
            assert!(modes.len() >= 2, "{arguments:?} {key}: {text:?}");
            assert!(modes.iter().all(|line| *line == modes[0]), "{arguments:?} {key}: {modes:?}");
        }
    }
}
