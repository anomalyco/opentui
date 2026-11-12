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
/// Any frame. Windows' pseudoconsole sends its screen, not each frame: with `--app`, its replies to the startup
/// queries draw frame 2 at once, and frame 1 may never show.
const DRAWN: &str = "lifecycle frame ";

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
        run.wait_for(DRAWN);
        run.press("q");
        assert_eq!(run.code(), Some(0), "{arguments:?}");
        run.after_leaving();
    }
}

#[test]
fn resizes_are_drawn() {
    for arguments in MODES {
        let run = Run::fixture(arguments);
        run.wait_for(DRAWN);
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
            run.wait_for(DRAWN);
            run.press(key);
            assert_eq!(run.code(), Some(code), "{arguments:?} {key}");
            assert!(run.after_leaving().contains(message), "{arguments:?} {key}: {:?}", run.text());
        }
    }
}

#[test]
fn captured_stderr_stays_off_the_screen() {
    let run = Run::fixture(&["--app"]);
    run.wait_for(DRAWN);
    run.press("w");
    run.app.wait_until(Duration::from_millis(300), || false);
    run.press("q");
    assert_eq!(run.code(), Some(0));
    let (text, after) = (run.text(), run.after_leaving());
    let line = "lifecycle stderr line";
    assert!(!text[..text.len() - after.len()].contains(line), "{text:?}");
    assert!(after.contains(line), "{text:?}");
}

/// A copy goes to the host clipboard first and to the terminal (OSC 52) once the host write ends, the newest copy
/// last: on X11 and Wayland the last writer owns the clipboard, and the terminal outlives the app. The fixture sets its
/// title right after copying, so the OSC 52 comes after the title unless the copy skips the host, as over SSH.
#[cfg(target_os = "linux")]
#[test]
fn a_copy_reaches_the_terminal_after_the_host_clipboard() {
    const OSC52: &str = "\x1b]52;c;";
    const FIRST: &str = "bGlmZWN5Y2xlIGNvcHkgMA=="; // "lifecycle copy 0"
    const NEWEST: &str = "bGlmZWN5Y2xlIGNvcHkgMTY="; // "lifecycle copy 16"
    // A compositor that accepts connections and never answers holds host operations until they time out.
    let socket = std::env::temp_dir().join(format!("opentui-lifecycle-{}.wayland", std::process::id()));
    let _ = std::fs::remove_file(&socket);
    let _compositor = std::os::unix::net::UnixListener::bind(&socket).unwrap();
    let wayland = ["/usr/lib", "/usr/lib64", "/usr/lib/x86_64-linux-gnu", "/usr/lib/aarch64-linux-gnu"]
        .iter()
        .any(|dir| Path::new(dir).join("libwayland-client.so.0").exists());
    let held = wayland.then_some(("WAYLAND_DISPLAY", socket.clone().into_os_string()));
    let x11 = XServer::start();
    let written = x11.as_ref().map(|server| ("DISPLAY", std::ffi::OsString::from(&server.display)));
    // Keys, the host (`None`: skip the row), over SSH, the newest text, and a line the run prints. Without a display
    // the host write fails at once; m's 17th copy cannot start while 16 wait; v copies from a read handler and no key
    // follows; a held write times out after 1 s, or is cancelled at the quit.
    let rows = [
        ("c", Some(None), false, FIRST, ""),
        ("c", Some(None), true, FIRST, ""),
        ("m", Some(None), false, NEWEST, ""),
        ("v", Some(None), false, FIRST, "lifecycle clipboard Unsupported"),
        ("c", held.clone().map(Some), false, FIRST, ""),
        ("m", held.clone().map(Some), false, NEWEST, ""),
        ("cvq", held.map(Some), false, FIRST, "lifecycle clipboard Cancelled"),
        ("c", written.map(Some), false, FIRST, ""),
    ];
    for (keys, host, ssh, newest, line) in rows {
        let Some(host) = host else {
            eprintln!("SKIP: {keys}: no libwayland-client.so.0 or X server");
            continue;
        };
        let mut command = Command::new(fixture());
        command.arg("--app");
        for name in [
            "DISPLAY",
            "WAYLAND_DISPLAY",
            "WAYLAND_SOCKET",
            "SSH_CONNECTION",
            "SSH_CLIENT",
            "SSH_TTY",
            "MOSH_CONNECTION",
        ] {
            command.env_remove(name);
        }
        command.envs(host.into_iter().chain(ssh.then(|| ("SSH_CONNECTION", "10.0.0.1 50000 10.0.0.2 22".into()))));
        let run = Run::start(command);
        run.wait_for(DRAWN);
        if keys == "v" {
            // Past the 5 s startup reply windows nothing but the clipboard wakes the app.
            run.app.wait_until(Duration::from_millis(5500), || false);
        }
        run.press(keys);
        if !keys.ends_with('q') {
            run.wait_for(&format!("{OSC52}{newest}"));
            run.press("q");
        }
        assert_eq!(run.code(), Some(0), "{keys}");
        let text = run.text();
        let last = text.rfind(OSC52).map(|at| text[at + OSC52.len()..].chars().take(30).collect::<String>());
        assert!(last.as_ref().is_some_and(|last| last.starts_with(newest)), "{keys}: the terminal ends with {last:?}");
        if keys.starts_with('c') {
            let after = text.find(OSC52) > text.find("lifecycle copied");
            assert_eq!(after, !ssh, "{keys} ssh {ssh}: OSC 52 after the title is {after}: {text:?}");
        }
        assert!(text.contains(line), "{keys}: {line:?} missing: {text:?}");
    }
    let _ = std::fs::remove_file(&socket);
}

/// A private X server for a host write that succeeds: Xvfb, or Xwayland inside a Wayland session.
#[cfg(target_os = "linux")]
struct XServer {
    child: std::process::Child,
    display: String,
}

#[cfg(target_os = "linux")]
impl XServer {
    fn start() -> Option<Self> {
        let number = 300 + std::process::id() % 600;
        let display = format!(":{number}");
        let session = std::env::var_os("WAYLAND_DISPLAY").is_some();
        let child = ["Xvfb", "Xwayland"].into_iter().filter(|name| *name == "Xvfb" || session).find_map(|name| {
            let null = std::process::Stdio::null;
            Command::new(name).arg(&display).stdout(null()).stderr(null()).spawn().ok()
        })?;
        let server = Self { child, display };
        let socket = PathBuf::from(format!("/tmp/.X11-unix/X{number}"));
        for _ in 0..500 {
            if socket.exists() {
                return Some(server);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        None
    }
}

#[cfg(target_os = "linux")]
impl Drop for XServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A released terminal is the program's to read in cooked mode, and the app draws again afterwards.
#[test]
fn releasing_hands_the_terminal_over_and_takes_it_back() {
    let run = Run::fixture(&["--app"]);
    run.wait_for(DRAWN);
    // The emulator does not answer the pixel size query: a terminal that does.
    run.press("\x1b[4;480;800t");
    // As in Core, the release ends the batch it came in: the q after it never quits.
    run.press("rq");
    run.wait_for("lifecycle released 1");
    let text = run.text();
    let released = text.find("lifecycle released 1").unwrap();
    assert!(text[..released].contains(LEAVE_ALT), "the alternate screen is still active: {text:?}");
    // The program's terminal echoes what it reads.
    run.press("hello");
    run.wait_for("hello");
    // Taking it back after a resize, the app draws at the new size and asks for the pixel size, which ConPTY may not
    // pass on.
    run.pty.resize(100, 30).unwrap();
    run.press("\r");
    run.wait_for("lifecycle read hello");
    let read = run.text().find("lifecycle read hello").unwrap();
    let wanted: &[&str] =
        if cfg!(windows) { &[ENTER_ALT, "size 100x30"] } else { &[ENTER_ALT, "size 100x30", "\x1b[14t"] };
    let taken = || wanted.iter().all(|text| run.text()[read..].contains(text));
    let seen = run.app.wait_until(Duration::from_secs(10), taken);
    assert!(seen, "the app never took the terminal back: {:?}", run.text());
    // The task prints its line after the hand-over drops pending input, so keys typed once it shows reach the program.
    let released = |count| {
        let line = format!("lifecycle released {count}");
        run.app.wait_until(Duration::from_secs(10), || run.text().contains(&line))
    };
    run.press("r");
    assert!(released(2), "{:?}", run.text());
    // Keys typed after the line are read at resume and dispatched before the app waits again: the r releases once
    // more. A quit in the release comes first: the p after it never runs.
    run.press("next\rr");
    assert!(released(3), "{:?}", run.text());
    run.press("quit\rp");
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
        // With --app, P panics in a task that changed the modes while the app had released the console.
        for key in ["q", "e", "p", "P"].into_iter().filter(|key| *key != "P" || !arguments.is_empty()) {
            let script = format!("{0} --modes & {0} {1} & {0} --modes", fixture.display(), arguments.join(" "));
            let mut command = Command::new("cmd.exe");
            command.args(["/d", "/s", "/c", &script]);
            let run = Run::start(command);
            run.wait_for(DRAWN);
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
