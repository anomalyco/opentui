//! The server end to end: russh's client connects over TCP, authenticates, and drives sessions; one test runs the
//! OpenSSH client on a pseudo-terminal.

use opentui::prelude::*;
use opentui_ssh::{Auth, Identity, Server, ServerConfig, Session};
use russh::keys::{Algorithm, PrivateKey, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{ChannelMsg, client};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const ENTER_ALT: &str = "\x1b[?1049h";
const LEAVE_ALT: &str = "\x1b[?1049l";

/// Accepts the server's host key after checking it is the one the server reports.
struct Client {
    fingerprint: String,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else { return Ok(false) };
        Ok(key.fingerprint(russh::keys::HashAlg::Sha256).to_string() == self.fingerprint)
    }
}

/// A server on a free local port whose contained errors are collected.
fn start(config: ServerConfig, handler: fn(Session) -> opentui::Result<()>) -> (Server, Arc<Mutex<Vec<String>>>) {
    let errors = Arc::new(Mutex::new(Vec::new()));
    let collected = Arc::clone(&errors);
    let config = config.banner(false).on_error(move |report| collected.lock().unwrap().push(report.to_string()));
    (opentui_ssh::serve("127.0.0.1:0", config, handler).expect("start the server"), errors)
}

fn label(app: &App) -> String {
    let (width, height) = app.size();
    format!("size {width}x{height}")
}

/// What the greeter shows after `typed` other keys. Every cell changes with each key, so the frame diff sends all of it.
fn mark(typed: usize) -> String {
    char::from(b'a' + (typed % 26) as u8).to_string().repeat(4)
}

/// Shows who connected, the terminal size, and a [`mark`] per key; `q` quits, `e` fails, `p` panics. Denies `banned`.
fn greeter(session: Session) -> opentui::Result<()> {
    if session.user() == "banned" {
        return session.deny("No entry.\nGoodbye.");
    }
    let app = session.app(AppOptions::default().with_theme(Theme::dark()))?;
    let via = match session.identity() {
        Identity::PublicKey { key, .. } => key.fingerprint.clone(),
        Identity::Password { .. } => "password".into(),
        _ => "none".into(),
    };
    let about = format!("term {} pty {} lang {:?}", session.term(), session.has_pty(), session.env("LANG"));
    let size = Text::new(&app, label(&app));
    app.root().add(&Text::new(&app, format!("user {} via {via}", session.user())));
    app.root().add(&Text::new(&app, about));
    app.root().add(&size);
    let (keys, mut typed) = (Text::new(&app, ""), 0);
    app.root().add(&keys);
    app.on_resize(move |cx, _, _| {
        size.set_text(label(cx.app()));
    });
    app.on_key(move |cx, key| {
        if key.matches("q") {
            cx.quit();
        } else if key.matches("e") {
            cx.fail(opentui::Error::Usage("the session failed"));
        } else if key.matches("p") {
            panic!("the session panicked");
        } else {
            typed += 1;
            keys.set_text(mark(typed));
        }
    });
    app.run()
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap()
}

async fn connect(server: &Server) -> client::Handle<Client> {
    let handler = Client { fingerprint: server.fingerprints()[0].clone() };
    client::connect(Arc::new(client::Config::default()), server.local_addr(), handler).await.expect("connect")
}

async fn connect_as(server: &Server, user: &str) -> client::Handle<Client> {
    let mut handle = connect(server).await;
    assert!(handle.authenticate_none(user).await.unwrap().success(), "open access admits {user}");
    handle
}

fn key() -> PrivateKey {
    PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()
}

async fn with_key(handle: &mut client::Handle<Client>, user: &str, key: &PrivateKey) -> bool {
    let key = PrivateKeyWithHashAlg::new(Arc::new(key.clone()), None);
    handle.authenticate_publickey(user, key).await.unwrap().success()
}

/// One shell channel and what has arrived on it.
struct Shell {
    channel: russh::Channel<client::Msg>,
    output: Vec<u8>,
    /// Where the next [`Self::wait_for`] starts looking.
    seen: usize,
    replies: Vec<bool>,
    exit: Option<u32>,
    closed: bool,
    /// Whether the server closed the channel itself, rather than the connection going away.
    close_message: bool,
}

impl Shell {
    /// Opens a session channel, asks for a pseudo-terminal when `pty` is given, then for a shell.
    async fn open(handle: &client::Handle<Client>, pty: Option<(&str, u32, u32)>, env: &[(&str, &str)]) -> Self {
        let channel = handle.channel_open_session().await.expect("open a channel");
        for (name, value) in env {
            channel.set_env(true, *name, *value).await.unwrap();
        }
        if let Some((term, width, height)) = pty {
            channel.request_pty(true, term, width, height, 0, 0, &[]).await.unwrap();
        }
        channel.request_shell(true).await.unwrap();
        Self {
            channel,
            output: Vec::new(),
            seen: 0,
            replies: Vec::new(),
            exit: None,
            closed: false,
            close_message: false,
        }
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.output).into_owned()
    }

    fn handle(&mut self, message: Option<ChannelMsg>) {
        match message {
            Some(ChannelMsg::Data { data }) => self.output.extend_from_slice(&data),
            Some(ChannelMsg::Success) => self.replies.push(true),
            Some(ChannelMsg::Failure) => self.replies.push(false),
            Some(ChannelMsg::ExitStatus { exit_status }) => self.exit = Some(exit_status),
            Some(ChannelMsg::Close) => (self.closed, self.close_message) = (true, true),
            None => self.closed = true,
            Some(_) => {}
        }
    }

    /// Handles the next message.
    async fn read(&mut self) {
        let message = tokio::time::timeout(Duration::from_secs(10), self.channel.wait()).await;
        let message =
            message.unwrap_or_else(|_| panic!("nothing arrived for ten seconds; output so far: {:?}", self.text()));
        self.handle(message);
    }

    /// Whether the server accepted every request so far: `count` of them.
    async fn accepted(&mut self, count: usize) -> bool {
        while self.replies.len() < count && !self.closed {
            self.read().await;
        }
        self.replies.iter().all(|accepted| *accepted)
    }

    /// Reads until `needle` arrives after the previous match.
    async fn wait_for(&mut self, needle: &str) {
        loop {
            let rest = &self.output[self.seen..];
            if let Some(index) = rest.windows(needle.len()).position(|window| window == needle.as_bytes()) {
                self.seen += index + needle.len();
                return;
            }
            assert!(!self.closed, "the channel closed before {needle:?} arrived: {:?}", self.text());
            self.read().await;
        }
    }

    async fn send(&self, bytes: &[u8]) {
        self.channel.data_bytes(bytes.to_vec()).await.expect("send input");
    }

    /// Reads until the channel closes, then returns the exit status.
    async fn finish(&mut self) -> Option<u32> {
        while !self.closed {
            self.read().await;
        }
        self.exit
    }

    /// Asserts the client's terminal entered the alternate screen and was restored.
    fn restored(&self) {
        let text = self.text();
        let (enter, leave) = (text.find(ENTER_ALT), text.rfind(LEAVE_ALT));
        assert!(enter.is_some() && enter < leave, "the terminal was not restored: {text:?}");
    }
}

/// Waits for the server's session count to reach `count`.
fn sessions_reach(server: &Server, count: usize) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while server.sessions() != count {
        assert!(Instant::now() < deadline, "{} sessions remain", server.sessions());
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn open_access_runs_an_app_on_the_clients_terminal() {
    let (server, errors) = start(ServerConfig::default(), greeter);
    runtime().block_on(async {
        let handle = connect_as(&server, "alice").await;
        let env = [("LANG", "C.UTF-8"), ("OPENTUI_FORCE_TRUECOLOR", "1")];
        let mut shell = Shell::open(&handle, Some(("screen-256color", 90, 30)), &env).await;
        assert!(shell.accepted(4).await);
        shell.wait_for(ENTER_ALT).await;
        shell.wait_for("user alice via none").await;
        shell.wait_for("term screen-256color pty true lang Some(\"C.UTF-8\")").await;
        shell.wait_for("size 90x30").await;
        assert!(shell.text().contains("\x1b[48;2;18;22;28m"), "{:?}", shell.text());
        shell.channel.window_change(100, 40, 0, 0).await.unwrap();
        shell.wait_for("size 100x40").await;
        shell.send(b"q").await;
        assert_eq!(shell.finish().await, Some(0));
        shell.restored();
    });
    sessions_reach(&server, 0);
    assert!(errors.lock().unwrap().is_empty(), "{:?}", errors.lock().unwrap());
}

#[test]
fn sessions_without_a_pseudo_terminal_use_the_defaults() {
    let (server, _) = start(ServerConfig::default(), greeter);
    runtime().block_on(async {
        let handle = connect_as(&server, "alice").await;
        let mut shell = Shell::open(&handle, None, &[]).await;
        assert!(shell.accepted(1).await);
        shell.wait_for("term xterm-256color pty false lang None").await;
        shell.wait_for("size 80x24").await;
        shell.send(b"q").await;
        assert_eq!(shell.finish().await, Some(0));
    });
}

#[test]
fn listed_public_keys_get_in_and_others_do_not() {
    let (listed, other) = (key(), key());
    let line = format!("{} alice@laptop", listed.public_key().to_openssh().unwrap());
    let auth = Auth::empty().authorized_keys(["# alice", line.as_str()]).unwrap();
    let (server, _) = start(ServerConfig::new().auth(auth), greeter);
    let fingerprint = listed.public_key().fingerprint(russh::keys::HashAlg::Sha256).to_string();
    runtime().block_on(async {
        let mut handle = connect(&server).await;
        assert!(!handle.authenticate_none("alice").await.unwrap().success());
        assert!(!with_key(&mut handle, "alice", &other).await);
        assert!(with_key(&mut handle, "alice", &listed).await);
        let mut shell = Shell::open(&handle, Some(("xterm", 80, 24)), &[]).await;
        shell.wait_for(&format!("user alice via {fingerprint}")).await;
        shell.send(b"q").await;
        assert_eq!(shell.finish().await, Some(0));
    });
}

#[test]
fn key_and_password_checks_decide_who_gets_in() {
    let auth = Auth::empty()
        .allow_public_key(|user, key| user == "bob" && key.algorithm == "ssh-ed25519")
        .password(|user, password| user == "carol" && password == "secret");
    let (server, _) = start(ServerConfig::new().auth(auth), greeter);
    runtime().block_on(async {
        let mut handle = connect(&server).await;
        assert!(!with_key(&mut handle, "dave", &key()).await);
        assert!(!handle.authenticate_password("carol", "wrong").await.unwrap().success());
        assert!(with_key(&mut handle, "bob", &key()).await);

        let mut handle = connect(&server).await;
        assert!(handle.authenticate_password("carol", "secret").await.unwrap().success());
        let mut shell = Shell::open(&handle, Some(("xterm", 80, 24)), &[]).await;
        shell.wait_for("user carol via password").await;
        shell.send(b"q").await;
        assert_eq!(shell.finish().await, Some(0));
    });
}

#[test]
fn auth_without_methods_is_refused() {
    let error = opentui_ssh::serve("127.0.0.1:0", ServerConfig::new().auth(Auth::empty()), greeter).unwrap_err();
    assert!(matches!(&error, opentui_ssh::Error::Config(message) if message.contains("Auth::empty")), "{error}");
}

#[test]
fn a_denied_session_shows_its_reason_without_an_app() {
    let (server, _) = start(ServerConfig::default(), greeter);
    runtime().block_on(async {
        let handle = connect_as(&server, "banned").await;
        let mut shell = Shell::open(&handle, Some(("xterm", 80, 24)), &[]).await;
        assert_eq!(shell.finish().await, Some(1));
        assert_eq!(shell.text(), "No entry.\r\nGoodbye.\r\n");
    });
}

#[test]
fn failures_and_panics_end_only_their_own_session() {
    let (server, errors) = start(ServerConfig::default(), greeter);
    runtime().block_on(async {
        let mut shells = Vec::new();
        for user in ["failing", "panicking", "bystander"] {
            let handle = connect_as(&server, user).await;
            let mut shell = Shell::open(&handle, Some(("xterm", 80, 24)), &[]).await;
            shell.wait_for(&format!("user {user}")).await;
            shells.push((handle, shell));
        }
        for (key, index) in [(b"e", 0), (b"p", 1)] {
            let shell = &mut shells[index].1;
            shell.send(key).await;
            assert_eq!(shell.finish().await, Some(1));
            shell.restored();
        }
        let bystander = &mut shells[2].1;
        bystander.channel.window_change(81, 24, 0, 0).await.unwrap();
        bystander.wait_for("size 81x24").await;
        bystander.send(b"q").await;
        assert_eq!(bystander.finish().await, Some(0));
    });
    let errors = errors.lock().unwrap();
    assert_eq!(errors.len(), 2, "{errors:?}");
    assert!(errors.iter().any(|error| error.contains("the session failed")), "{errors:?}");
    assert!(errors.iter().any(|error| error.contains("panicked: the session panicked")), "{errors:?}");
}

#[test]
fn reports_name_the_client_and_user() {
    let reports = Arc::new(Mutex::new(Vec::new()));
    let collected = Arc::clone(&reports);
    let config = ServerConfig::new().banner(false).on_error(move |report| {
        let user = report.user.map(str::to_owned);
        collected.lock().unwrap().push((report.error.to_string(), report.peer, user, report.to_string()));
    });
    let server = opentui_ssh::serve("127.0.0.1:0", config, greeter).expect("start the server");
    let client = runtime().block_on(async {
        let socket = tokio::net::TcpStream::connect(server.local_addr()).await.unwrap();
        let client = socket.local_addr().unwrap();
        let handler = Client { fingerprint: server.fingerprints()[0].clone() };
        let mut handle = client::connect_stream(Arc::new(client::Config::default()), socket, handler).await.unwrap();
        assert!(handle.authenticate_none("failing").await.unwrap().success());
        let mut shell = Shell::open(&handle, Some(("xterm", 80, 24)), &[]).await;
        shell.wait_for("user failing").await;
        shell.send(b"e").await;
        assert_eq!(shell.finish().await, Some(1));
        client
    });
    let reports = reports.lock().unwrap();
    let [(error, peer, user, shown)] = &reports[..] else { panic!("one report expected: {reports:?}") };
    assert_eq!(error, "session failed: the session failed");
    assert_eq!((*peer, user.as_deref()), (Some(client), Some("failing")));
    assert_eq!(*shown, format!("{client}, user \"failing\": {error}"));
}

#[test]
fn session_limits_refuse_extra_shells() {
    let config = ServerConfig::new().sessions_per_connection(1).max_sessions(2);
    let (server, _) = start(config, greeter);
    runtime().block_on(async {
        let first = connect_as(&server, "alice").await;
        let mut running = Shell::open(&first, Some(("xterm", 80, 24)), &[]).await;
        running.wait_for("user alice").await;
        let mut second = Shell::open(&first, Some(("xterm", 80, 24)), &[]).await;
        assert!(!second.accepted(2).await, "one session per connection");

        let other = connect_as(&server, "bob").await;
        let mut third = Shell::open(&other, Some(("xterm", 80, 24)), &[]).await;
        third.wait_for("user bob").await;
        let last = connect_as(&server, "carol").await;
        let mut refused = Shell::open(&last, Some(("xterm", 80, 24)), &[]).await;
        assert!(!refused.accepted(2).await, "two sessions at most");

        running.send(b"q").await;
        assert_eq!(running.finish().await, Some(0));
        let mut again = Shell::open(&first, Some(("xterm", 80, 24)), &[]).await;
        again.wait_for("user alice").await;
        for shell in [&mut again, &mut third] {
            shell.send(b"q").await;
            assert_eq!(shell.finish().await, Some(0));
        }
    });
}

#[test]
fn idle_sessions_end_but_typing_keeps_them_open() {
    let timeout = Duration::from_secs(2);
    let (server, _) = start(ServerConfig::new().idle_timeout(timeout), greeter);
    runtime().block_on(async {
        let handle = connect_as(&server, "alice").await;
        let mut shell = Shell::open(&handle, Some(("xterm", 80, 24)), &[]).await;
        // Each key waits for the app to show the one before. The ten pauses after the first span a whole timeout, which
        // the session outlasts only because the keys keep it open.
        let mut last_key = Instant::now();
        for typed in 1..=11 {
            tokio::time::sleep(timeout / 10).await;
            last_key = Instant::now();
            shell.send(b"x").await;
            shell.wait_for(&mark(typed)).await;
        }
        assert_eq!(shell.finish().await, Some(0));
        // The server took the last key after it was sent, so silence ends the session no sooner than a timeout later.
        let idle = last_key.elapsed();
        assert!(idle >= timeout, "ended {idle:?} after the last key");
        shell.restored();
    });
}

#[test]
fn closing_the_server_restores_every_clients_terminal() {
    let (server, _) = start(ServerConfig::default(), greeter);
    let server = Arc::new(server);
    runtime().block_on(async {
        let mut shells = Vec::new();
        for user in ["alice", "bob"] {
            let handle = connect_as(&server, user).await;
            let mut shell = Shell::open(&handle, Some(("xterm", 80, 24)), &[]).await;
            shell.wait_for(&format!("user {user}")).await;
            shells.push((handle, shell));
        }
        let closing = std::thread::spawn({
            let server = Arc::clone(&server);
            move || server.close()
        });
        for (_, shell) in &mut shells {
            assert_eq!(shell.finish().await, Some(0));
            assert!(shell.close_message, "the connection closed before the channel did");
            shell.restored();
        }
        tokio::task::spawn_blocking(move || closing.join().unwrap()).await.unwrap();
    });
    assert_eq!(server.sessions(), 0);
    assert!(std::net::TcpStream::connect(server.local_addr()).is_err(), "the server stopped listening");
}

#[test]
fn a_client_that_disconnects_ends_its_app() {
    let (server, _) = start(ServerConfig::default(), greeter);
    runtime().block_on(async {
        let handle = connect_as(&server, "alice").await;
        let mut shell = Shell::open(&handle, Some(("xterm", 80, 24)), &[]).await;
        shell.wait_for("user alice").await;
        assert_eq!(server.sessions(), 1);
        handle.disconnect(russh::Disconnect::ByApplication, "", "").await.unwrap();
    });
    sessions_reach(&server, 0);
}

#[test]
fn the_app_learns_the_clients_theme_over_ssh() {
    fn themed(session: Session) -> opentui::Result<()> {
        let app = session.app(AppOptions::default())?;
        app.root().add(&Text::new(&app, format!("theme {:?}", app.theme_mode())));
        app.on_key(|cx, key| {
            if key.matches("q") {
                cx.quit();
            }
        });
        app.run()
    }
    let (server, _) = start(ServerConfig::default(), themed);
    runtime().block_on(async {
        let handle = connect_as(&server, "alice").await;
        let mut shell = Shell::open(&handle, Some(("xterm", 80, 24)), &[]).await;
        shell.wait_for("\x1b]11;?\x07\x1b[c").await;
        shell.send(b"\x1b]11;rgb:ffff/ffff/ffff\x07\x1b[?62;22c").await;
        shell.wait_for("theme Some(Light)").await;
        shell.send(b"q").await;
        assert_eq!(shell.finish().await, Some(0));
    });
}

/// The OpenSSH client on a pseudo-terminal, authenticating with a key from `ssh-keygen`.
#[cfg(unix)]
#[test]
fn the_openssh_client_runs_an_app() {
    use opentui::pty::Pty;
    use opentui::testing::TestApp;
    use std::cell::{Cell, RefCell};
    use std::process::Command;
    use std::rc::Rc;

    if Command::new("ssh").arg("-V").output().is_err() {
        eprintln!("skipped: no ssh client");
        return;
    }
    let directory = std::env::temp_dir().join(format!("opentui-ssh-openssh-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let identity = directory.join("id_ed25519");
    let generated = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f"])
        .arg(&identity)
        .status()
        .expect("run ssh-keygen");
    assert!(generated.success());
    let public = std::fs::read_to_string(identity.with_extension("pub")).unwrap();
    let auth = Auth::empty().authorized_keys([public.trim()]).unwrap();
    let (server, errors) = start(ServerConfig::new().auth(auth), greeter);

    let app = TestApp::new(80, 24);
    let mut command = Command::new("ssh");
    command
        .args(["-F", "/dev/null", "-tt", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes"])
        .args(["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"])
        // ssh can miss a SIGWINCH until its poll wakes; keepalives wake it each 1 s and allow 30 s of server silence.
        .args(["-o", "ServerAliveInterval=1", "-o", "ServerAliveCountMax=30"])
        .arg("-i")
        .arg(&identity)
        .args(["-p", &server.local_addr().port().to_string(), "alice@127.0.0.1"])
        .env("TERM", "xterm-256color");
    let (output, exit) = (Rc::new(RefCell::new(Vec::new())), Rc::new(Cell::new(None)));
    let pty = Pty::spawn(&app, command, 100, 30)
        .unwrap()
        .on_output({
            let output = Rc::clone(&output);
            move |_cx, bytes| output.borrow_mut().extend_from_slice(bytes)
        })
        .on_exit({
            let exit = Rc::clone(&exit);
            move |_cx, status| exit.set(Some(status))
        });
    let text = || String::from_utf8_lossy(&output.borrow()).into_owned();
    let wait_for = |needle: &str| {
        let seen = app.wait_until(Duration::from_secs(15), || text().contains(needle));
        assert!(seen, "never saw {needle:?}: {:?}; errors: {:?}", text(), errors.lock().unwrap());
    };
    wait_for("user alice via SHA256:");
    wait_for("term xterm-256color pty true");
    wait_for("size 100x30");
    pty.resize(120, 40).unwrap();
    wait_for("size 120x40");
    pty.write(b"q").unwrap();
    assert!(app.wait_until(Duration::from_secs(15), || exit.get().is_some()), "ssh never exited: {:?}", text());
    assert_eq!(exit.get().and_then(|status| status.code()), Some(0), "{:?}", text());
    let text = text();
    assert!(text.find(ENTER_ALT) < text.rfind(LEAVE_ALT), "the terminal was not restored: {text:?}");
    std::fs::remove_dir_all(directory).unwrap();
}
