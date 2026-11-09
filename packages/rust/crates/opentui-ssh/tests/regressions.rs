//! Regression tests for bugs found in a review of the SSH server. Each test is named after the bug it guards
//! against; its comment gives the expected behavior and what happened before the fix.

use opentui::prelude::*;
use opentui_ssh::{Server, ServerConfig, Session};
use russh::keys::PublicKeyOrCertificate;
use russh::{ChannelMsg, client};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

struct Client {
    fingerprint: String,
    reading: Reading,
    /// When a paced client started to pace, and how long the output read since then takes it.
    paced: Option<(tokio::time::Instant, Duration)>,
}

/// How a client reads the connection.
#[derive(Clone, Copy)]
enum Reading {
    Normal,
    /// Stops reading at the first output, as a frozen client does.
    Stall,
    /// Takes this long for each 4 KiB from the first `Z` on, as a client on a slow link does. It keeps to the clock,
    /// so a client the scheduler held back catches up instead of falling further behind.
    Paced(Duration),
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else { return Ok(false) };
        Ok(key.fingerprint(russh::keys::HashAlg::Sha256).to_string() == self.fingerprint)
    }

    async fn data(
        &mut self,
        _channel: russh::ChannelId,
        data: &[u8],
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        match self.reading {
            Reading::Normal => {}
            Reading::Stall => std::future::pending::<()>().await,
            Reading::Paced(pause) => {
                if self.paced.is_none() && data.contains(&b'Z') {
                    self.paced = Some((tokio::time::Instant::now(), Duration::ZERO));
                }
                if let Some((since, read)) = &mut self.paced {
                    *read += pause.mul_f64(data.len() as f64 / 4096.0);
                    tokio::time::sleep_until(*since + *read).await;
                }
            }
        }
        Ok(())
    }
}

fn start(
    config: ServerConfig,
    handler: impl Fn(Session) -> opentui::Result<()> + Send + Sync + 'static,
) -> (Server, Arc<Mutex<Vec<String>>>) {
    let errors = Arc::new(Mutex::new(Vec::new()));
    let collected = Arc::clone(&errors);
    let config = config.banner(false).on_error(move |report| collected.lock().unwrap().push(report.to_string()));
    (opentui_ssh::serve("127.0.0.1:0", config, handler).expect("start the server"), errors)
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap()
}

async fn connect_as(server: &Server, user: &str) -> client::Handle<Client> {
    connect_with(server, user, client::Config::default(), Reading::Normal).await
}

async fn connect_with(server: &Server, user: &str, config: client::Config, reading: Reading) -> client::Handle<Client> {
    let handler = Client { fingerprint: server.fingerprints()[0].clone(), reading, paced: None };
    let mut handle = client::connect(Arc::new(config), server.local_addr(), handler).await.expect("connect");
    assert!(handle.authenticate_none(user).await.unwrap().success());
    handle
}

/// Reads a channel until it closes, for at most ten seconds.
async fn until_closed(channel: &mut russh::Channel<client::Msg>) {
    loop {
        match tokio::time::timeout(Duration::from_secs(10), channel.wait()).await {
            Ok(Some(ChannelMsg::Close) | None) => return,
            Ok(Some(_)) => {}
            Err(_) => panic!("the channel did not close within ten seconds"),
        }
    }
}

// Expected: a connection may run any number of sessions one after another; CHANNELS_MAX (16) only limits the
// channels open at once.
// Actual: when the server closes a session's channel, russh never calls `Handler::channel_close` for the client's
// reply (the channel is already gone on its side), so the entry stays in `Connection::channels`. After sixteen
// finished sessions every new channel is refused with "resource shortage".
#[test]
fn a_connection_refuses_new_channels_after_sixteen_finished_sessions() {
    let (server, _) = start(ServerConfig::default(), |_session| Ok(()));
    runtime().block_on(async {
        let handle = connect_as(&server, "alice").await;
        for round in 1..=20 {
            let opened = tokio::time::timeout(Duration::from_secs(10), handle.channel_open_session()).await;
            let mut channel = opened
                .expect("the channel opens within ten seconds")
                .unwrap_or_else(|error| panic!("session {round} on one connection was refused: {error}"));
            channel.request_shell(true).await.unwrap();
            until_closed(&mut channel).await;
        }
    });
}

// Expected: `App::run` returns when the client disconnects (README, lib.rs docs), so a session whose client leaves
// ends and frees its place in the session limits.
// Actual: when the client leaves before or during the color query that `Session::app` makes with the default
// options, the query swallows the end of input. The app then runs forever for a client that is gone, its thread
// never returns, and `Server::sessions` stays at 1 (with `max_sessions` reached, every later client is refused).
#[test]
fn a_client_that_leaves_while_its_session_starts_keeps_the_session_running_forever() {
    let (server, _) = start(ServerConfig::default(), |session| {
        // Setup that takes a moment, such as a lookup; the client leaves meanwhile.
        std::thread::sleep(Duration::from_millis(500));
        session.app(AppOptions::default())?.run()
    });
    runtime().block_on(async {
        let handle = connect_as(&server, "alice").await;
        let channel = handle.channel_open_session().await.expect("open a channel");
        channel.request_pty(true, "xterm", 80, 24, 0, 0, &[]).await.unwrap();
        channel.request_shell(true).await.unwrap();
        let started = tokio::time::timeout(Duration::from_secs(10), async {
            while server.sessions() == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });
        started.await.expect("the session starts within ten seconds");
        handle.disconnect(russh::Disconnect::ByApplication, "", "").await.unwrap();
    });
    let deadline = Instant::now() + Duration::from_secs(8);
    while server.sessions() != 0 {
        assert!(Instant::now() < deadline, "the session of a client that left still runs after eight seconds");
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// An app that redraws a large screen every frame, so its output outruns any client that stops reading.
fn busy_app(session: &Session) -> opentui::Result<App> {
    let app = session.app(AppOptions::default().with_theme(Theme::dark()))?;
    let filler = Text::new(&app, "").grow(1.0);
    app.root().add(&filler);
    let mut frame = 0u64;
    app.animate(move |_cx, _| {
        frame += 1;
        filler.set_text(format!("{frame:>12}").repeat(1000));
        true
    });
    Ok(app)
}

// Expected: `ServerConfig::max_timeout` "ends a session after this long, however active": the transport asks the
// app to end, and the app's close bound later closes the channel anyway, so `App::run` returns soon after the
// timeout.
// Actual: the transport checks its timeouts (and `Server::close`) only between output batches, and a client that
// stops reading leaves it waiting in `Handle::data` forever. The timeout never fires, the app never hears of it,
// and the session holds its thread and its place in the limits indefinitely.
#[test]
fn a_client_that_stops_reading_outlasts_the_maximum_timeout() {
    let (returned, run_returned) = std::sync::mpsc::channel();
    let config = ServerConfig::new().max_timeout(Duration::from_secs(2));
    let (server, _) = start(config, move |session| {
        let result = busy_app(&session)?.run();
        let _ = returned.send(());
        result
    });
    let started = Instant::now();
    let ended = runtime().block_on(async {
        // A small window so the server must wait for the client after a few frames.
        let config = client::Config { window_size: 64 * 1024, ..client::Config::default() };
        let handle = connect_with(&server, "alice", config, Reading::Stall).await;
        let channel = handle.channel_open_session().await.expect("open a channel");
        channel.request_pty(false, "xterm", 200, 60, 0, 0, &[]).await.unwrap();
        channel.request_shell(false).await.unwrap();
        let ended = tokio::task::spawn_blocking(move || run_returned.recv_timeout(Duration::from_secs(8))).await;
        (ended.unwrap().is_ok(), handle, channel)
    });
    if !ended.0 {
        // Closing the server would wait out its own grace periods for this session too.
        std::mem::forget(server);
        panic!("App::run still runs {:?} after the session started, with a two-second max_timeout", started.elapsed());
    }
}

/// Reads a channel until `needle` arrives, for at most ten seconds.
async fn wait_for(channel: &mut russh::Channel<client::Msg>, needle: &str) {
    let mut output = Vec::new();
    loop {
        if output.windows(needle.len()).any(|window| window == needle.as_bytes()) {
            return;
        }
        match tokio::time::timeout(Duration::from_secs(10), channel.wait()).await {
            Ok(Some(ChannelMsg::Data { data })) => output.extend_from_slice(&data),
            Ok(Some(_)) => {}
            Ok(None) => panic!("the channel closed before {needle:?} arrived"),
            Err(_) => panic!("{needle:?} did not arrive within ten seconds"),
        }
    }
}

// Expected: with `sessions_per_connection` above one, each session is held back only by its own app: SSH flow
// control is per channel, so one app falling behind on input leaves the connection's other sessions responsive.
// Actual: the `data` handler waits for input room inside russh's session loop, which stops reading the whole
// connection. While one app is busy, input to every other session on the connection, Ctrl+C and `q` included, as
// well as window changes and channel closes, waits behind it.
#[test]
fn one_session_behind_on_input_freezes_the_other_sessions_on_its_connection() {
    let config = ServerConfig::new().sessions_per_connection(2);
    let (server, _) = start(config, |session| {
        let app = session.app(AppOptions::default().with_theme(Theme::dark()))?;
        app.root().add(&Text::new(&app, format!("term {}", session.term())));
        app.on_key(|cx, key| {
            if key.matches("w") {
                // Slow work on the UI thread, such as a long synchronous computation.
                std::thread::sleep(Duration::from_secs(20));
            } else if key.matches("q") {
                cx.quit();
            }
        });
        app.run()
    });
    let responsive = runtime().block_on(async {
        let handle = connect_as(&server, "alice").await;
        let mut busy = handle.channel_open_session().await.expect("open a channel");
        busy.request_pty(false, "busy", 80, 24, 0, 0, &[]).await.unwrap();
        busy.request_shell(false).await.unwrap();
        wait_for(&mut busy, "term busy").await;
        let mut other = handle.channel_open_session().await.expect("open a channel");
        other.request_pty(false, "other", 80, 24, 0, 0, &[]).await.unwrap();
        other.request_shell(false).await.unwrap();
        wait_for(&mut other, "term other").await;

        busy.data_bytes(b"w".to_vec()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        // A paste the busy app cannot take yet: more than its 256 KiB of input room. Sent from a task of its own, so
        // a server that holds back only this channel cannot stall the test.
        let paste = tokio::spawn(async move {
            let _ = busy.data_bytes(vec![b'x'; 512 * 1024]).await;
            busy
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        other.data_bytes(b"q".to_vec()).await.unwrap();
        let closed = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(message) = other.wait().await {
                if matches!(message, ChannelMsg::Close) {
                    return;
                }
            }
        })
        .await;
        (closed.is_ok(), handle, paste)
    });
    if !responsive.0 {
        std::mem::forget(server);
        panic!("the other session did not quit within five seconds of its `q`");
    }
}

// Expected: a timeout too long to represent, such as `Duration::MAX`, never ends a session, so it runs as without
// one: here the handler returns at once and the channel closes.
// Actual: the transport computed `last_input + idle_timeout` and `started + max_timeout`, which overflowed and
// panicked the session's transport task. The channel never closed.
#[test]
fn a_timeout_of_duration_max_panics_the_transport() {
    let config = ServerConfig::new().idle_timeout(Duration::MAX).max_timeout(Duration::MAX);
    let (server, _) = start(config, |_session| Ok(()));
    runtime().block_on(async {
        let handle = connect_as(&server, "alice").await;
        let mut channel = handle.channel_open_session().await.expect("open a channel");
        channel.request_shell(true).await.unwrap();
        until_closed(&mut channel).await;
    });
}

// Expected: "Dropping it closes it" (the `Server` docs), wherever the server is dropped, including in the async code
// of an application that uses tokio itself; at worst it should not panic in `Drop`.
// Actual: `Drop` calls `close`, which calls `Runtime::block_on` on the server's own runtime. Inside async code that
// panics with "Cannot start a runtime from within a runtime"; during another panic's unwinding it would abort the
// process. Only `close` mentions the restriction.
#[test]
fn dropping_the_server_in_async_code_panics() {
    let dropped = std::panic::catch_unwind(|| {
        runtime().block_on(async {
            let (server, _) = start(ServerConfig::default(), |_session| Ok(()));
            drop(server);
        });
    });
    assert!(dropped.is_ok(), "dropping the server in async code panicked");
}

// Expected: when a session ends, here at its maximum timeout (from the shell request: 5 s leaves a slow start time
// to paint), its app restores the client's terminal before the channel closes. The host's close may take ten close
// timeouts while its output still moves, so the session waits for that, and the client then has time to take it.
// Actual: the channel closed five seconds after the transport asked the app to end (END_GRACE), shorter than the ten
// seconds the host's close may take. A client on a slow link kept the alternate screen and mouse reporting.
#[test]
fn a_slow_client_loses_its_terminal_when_the_close_outlasts_the_session_end() {
    let config = ServerConfig::new().max_timeout(Duration::from_secs(5));
    let (server, _) = start(config, slow_closing_app);
    let restored = runtime().block_on(async {
        let (_handle, mut channel) = slow_shell(&server).await;
        until_restored(&mut channel).await
    });
    assert!(restored, "the channel closed before the client's terminal was restored");
}

/// An app whose close runs to its ten-second cap for a slow client: one frame of cells that each get their own
/// colors, more than the client reads before the cap.
fn slow_closing_app(session: Session) -> opentui::Result<()> {
    let app = session.app(AppOptions::default().with_theme(Theme::dark()))?;
    app.root().add(&Text::new(&app, "Z".repeat(80_000)).grow(1.0));
    app.root().add_filter(opentui::post::Noise::new(0.5).seed(1));
    app.run()
}

/// Opens a 400x200 shell for a client that reads about 130 KB/s once the app's frame starts: output keeps moving, so
/// a close never goes a timeout without progress, but slowly. Returns once the frame has started to arrive.
async fn slow_shell(server: &Server) -> (client::Handle<Client>, russh::Channel<client::Msg>) {
    let config = client::Config { window_size: 64 * 1024, maximum_packet_size: 4096, ..client::Config::default() };
    let handle = connect_with(server, "alice", config, Reading::Paced(Duration::from_millis(30))).await;
    let mut channel = handle.channel_open_session().await.expect("open a channel");
    channel.request_pty(false, "xterm", 400, 200, 0, 0, &[]).await.unwrap();
    channel.request_shell(false).await.unwrap();
    wait_for(&mut channel, "Z").await;
    (handle, channel)
}

/// Reads until the app leaves the alternate screen (`true`) or the channel ends (`false`). Only the end of the output
/// can hold the restoration, so it keeps a tail instead of every frame.
async fn until_restored(channel: &mut russh::Channel<client::Msg>) -> bool {
    const LEAVE_ALT: &[u8] = b"\x1b[?1049l";
    let mut tail = Vec::new();
    loop {
        match tokio::time::timeout(Duration::from_secs(30), channel.wait()).await.ok().flatten() {
            Some(ChannelMsg::Data { data }) => {
                tail.extend_from_slice(&data);
                if tail.windows(LEAVE_ALT.len()).any(|window| window == LEAVE_ALT) {
                    return true;
                }
                tail.drain(..tail.len().saturating_sub(LEAVE_ALT.len()));
            }
            Some(_) => {}
            None => return false,
        }
    }
}

/// Closes the server on a thread of its own and returns how long the close took.
fn close_in_background(server: &Arc<Server>) -> std::thread::JoinHandle<Duration> {
    let server = Arc::clone(server);
    std::thread::spawn(move || {
        let started = Instant::now();
        server.close();
        started.elapsed()
    })
}

// Expected: `Server::close` asks every app to end "so it restores its client's terminal", and by default waits as
// long as the apps' close bounds allow for that to reach the client.
// Actual: it waited five seconds for the sessions (CLOSE_GRACE), then gave each connection one second (LEAVE_GRACE)
// before disconnecting it. The app's close took ten seconds, and even after it the server's SSH library still held
// about 250 KB for the slow client, so the restoration never arrived.
#[test]
fn closing_the_server_cuts_off_a_slow_clients_restoration() {
    let (server, _) = start(ServerConfig::default(), slow_closing_app);
    let server = Arc::new(server);
    runtime().block_on(async {
        let (handle, mut channel) = slow_shell(&server).await;
        let closing = close_in_background(&server);
        let restored = until_restored(&mut channel).await;
        // The client leaves once it has its terminal back, as OpenSSH's does once the channel closes.
        drop(channel);
        let _ = handle.disconnect(russh::Disconnect::ByApplication, "", "").await;
        tokio::task::spawn_blocking(move || closing.join().unwrap()).await.unwrap();
        assert!(restored, "the server dropped the client before its terminal was restored");
    });
}

// Expected: `ServerConfig::close_timeout` caps a server close: it ends in about that time and drops a client still
// waiting for its restoration.
// Actual: before the setting, a close always waited its fixed five seconds for the sessions and then one more.
#[test]
fn a_close_timeout_ends_the_shutdown_and_drops_a_slow_client() {
    let (server, _) = start(ServerConfig::new().close_timeout(Duration::from_secs(2)), slow_closing_app);
    let server = Arc::new(server);
    runtime().block_on(async {
        let (_handle, mut channel) = slow_shell(&server).await;
        let closing = close_in_background(&server);
        // The app's close takes ten seconds, so the client goes without its restoration.
        assert!(!until_restored(&mut channel).await, "the app restored the terminal within two seconds");
        let took = tokio::task::spawn_blocking(move || closing.join().unwrap()).await.unwrap();
        assert!(took >= Duration::from_secs(2) && took < Duration::from_secs(4), "the close took {took:?}");
    });
}
