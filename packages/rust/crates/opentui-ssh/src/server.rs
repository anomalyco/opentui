//! The listener, one russh handler per connection, and one transport task and app thread per shell session.

use crate::config::ErrorHandler;
use crate::error::panic_message;
use crate::keys::{self, LoadedKey};
use crate::{Auth, Error, ErrorReport, Identity, ServerConfig, Session};
use bytes::Bytes;
use opentui::remote::{RemoteLink, RemoteOptions, RemoteTerminal};
use russh::keys::PublicKey;
use russh::server::{Auth as Verdict, ChannelOpenHandle, Handle, Msg, Session as SshSession};
use russh::{Channel, ChannelId, ChannelOpenFailure, Disconnect, MethodSet, Pty};
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::io;
use std::net::{SocketAddr, ToSocketAddrs};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, oneshot, watch};

type Handler = dyn Fn(Session) -> opentui::Result<()> + Send + Sync;

/// The largest terminal a client may report, as in Core.
const COLUMNS_MAX: u16 = 500;
const ROWS_MAX: u16 = 200;
/// The terminal type when the client asks for none, as in Core.
const DEFAULT_TERM: &str = "xterm-256color";
const TERM_BYTES_MAX: usize = 256;
/// Environment variables a client may send per channel, and the largest each may be.
const ENV_ENTRIES_MAX: usize = 64;
const ENV_BYTES_MAX: usize = 4096;
/// Client environment the renderer takes as terminal hints, along with the terminal type.
const FORWARDED_ENV: [&str; 4] = ["COLORTERM", "OPENTUI_FORCE_TRUECOLOR", "TERM_PROGRAM", "TERM_PROGRAM_VERSION"];
/// Channels one connection may have open.
const CHANNELS_MAX: usize = 16;
/// Output per channel write.
const CHUNK_BYTES: usize = 32 * 1024;
/// Client input a channel holds for an app that has no room for it yet. Beyond this the whole connection waits:
/// russh grants each channel's window by itself, so holding the connection back is the only way to slow a client.
const BACKLOG_BYTES_MAX: usize = 1024 * 1024;
/// How long a connection may take to authenticate, as OpenSSH's `LoginGraceTime`.
const LOGIN_GRACE: Duration = Duration::from_secs(120);
/// Keepalives for clients that send nothing: one that misses three replies is gone.
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
const KEEPALIVES_MISSED_MAX: usize = 3;
/// How long a session's last messages may take; a client that stopped reading cannot take them.
const FAREWELL_TIMEOUT: Duration = Duration::from_secs(1);

/// `by` after `at`, or a time too far off to matter when that cannot be represented.
fn later(at: Instant, by: Duration) -> Instant {
    at.checked_add(by).unwrap_or_else(|| at + Duration::from_secs(u64::from(u32::MAX)))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Waits until a flag is set, or its sender is gone. Unlike `wait_for` itself, holds no read guard afterwards.
async fn raised(flag: &mut watch::Receiver<bool>) {
    let _ = flag.wait_for(|raised| *raised).await;
}

/// Starts serving apps over SSH on `addr`, such as `"127.0.0.1:2222"` or `"0.0.0.0:2222"` (port 0 picks a free
/// port).
///
/// Every shell session gets a thread of its own, where `handler` runs with the session: it creates the app with
/// [`Session::app`] and runs it. An error the handler returns, or a panic, goes to
/// [`ServerConfig::on_error`](field@ServerConfig::on_error) and ends that session only.
///
/// Binds before returning, so a port in use or an invalid configuration fails here. The server runs on threads of
/// its own until [`Server::close`] or until the returned [`Server`] drops.
pub fn serve(
    addr: impl ToSocketAddrs,
    config: ServerConfig,
    handler: impl Fn(Session) -> opentui::Result<()> + Send + Sync + 'static,
) -> Result<Server, Error> {
    config.check()?;
    let host_keys = config.host_key.load()?;
    let listener = std::net::TcpListener::bind(addr)?;
    listener.set_nonblocking(true)?;
    let local_addr = listener.local_addr()?;
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().thread_name("opentui-ssh").build()?;
    let listener = {
        let _context = runtime.enter();
        TcpListener::from_std(listener)?
    };
    let fingerprints = host_keys.iter().map(|loaded| keys::fingerprint(loaded.key.public_key())).collect();
    if config.banner {
        print_banner(local_addr, &host_keys, &config.auth);
    }
    let ssh = Arc::new(russh::server::Config {
        methods: MethodSet::from(&config.auth.methods()[..]),
        keys: host_keys.into_iter().map(|loaded| loaded.key).collect(),
        auth_rejection_time: Duration::from_secs(1),
        // OpenSSH clients ask about "none" first; refusing it needs no delay.
        auth_rejection_time_initial: Some(Duration::ZERO),
        // Keepalives find dead clients; an idle but live session stays open.
        inactivity_timeout: None,
        keepalive_interval: Some(KEEPALIVE_INTERVAL),
        keepalive_max: KEEPALIVES_MISSED_MAX,
        nodelay: true,
        ..Default::default()
    });
    let shared = Arc::new(Shared {
        handler: Box::new(handler),
        auth: config.auth,
        idle_timeout: config.idle_timeout,
        max_timeout: config.max_timeout,
        close_timeout: config.close_timeout,
        sessions_per_connection: config.sessions_per_connection,
        max_sessions: config.max_sessions,
        on_error: config.on_error,
        close_bound: Mutex::new(Duration::ZERO),
        leave_until: Mutex::new(None),
        active: Mutex::new(Active::default()),
        idle: Condvar::new(),
        closing: watch::Sender::new(false),
        closed: watch::Sender::new(false),
    });
    if let Some(warning) = open_access_warning(&shared.auth, local_addr) {
        shared.report(warning, None, None);
    }
    let accepting = runtime.spawn(accept(listener, ssh, Arc::clone(&shared)));
    Ok(Server {
        shared,
        local_addr,
        fingerprints,
        runtime: Mutex::new(Some((runtime, accepting))),
        done: (Mutex::new(false), Condvar::new()),
    })
}

/// The warning for a server that lets anyone in on an address beyond the loopback interface.
fn open_access_warning(auth: &Auth, addr: SocketAddr) -> Option<Error> {
    (auth.is_open() && !addr.ip().is_loopback()).then_some(Error::OpenAccess(addr))
}

fn print_banner(addr: SocketAddr, keys: &[LoadedKey], auth: &Auth) {
    let host = match addr.ip() {
        ip if ip.is_unspecified() => "localhost".to_owned(),
        ip if ip.is_ipv6() => format!("[{ip}]"),
        ip => ip.to_string(),
    };
    println!("opentui-ssh  ▸  ssh://{host}:{}", addr.port());
    for loaded in keys {
        let fingerprint = keys::fingerprint(loaded.key.public_key());
        println!("host key      {fingerprint}  ({}, {})", loaded.key.algorithm().as_str(), loaded.source);
    }
    println!("auth          {}", auth.method_names().join(", "));
    let authorized = auth.authorized();
    if !authorized.is_empty() {
        let shown: Vec<String> = authorized.iter().take(3).map(keys::fingerprint).collect();
        let more = if authorized.len() > shown.len() { " …" } else { "" };
        println!("authorized    {} keys  ·  {}{more}", authorized.len(), shown.join(" "));
    }
}

/// What a server runs.
#[derive(Default)]
struct Active {
    /// Sessions, until both their thread and transport are done with them.
    sessions: usize,
    /// Transport tasks, until each has closed its channel.
    transports: usize,
}

/// What the listener, connections, sessions, and the [`Server`] share.
struct Shared {
    handler: Box<Handler>,
    auth: Auth,
    idle_timeout: Option<Duration>,
    max_timeout: Option<Duration>,
    close_timeout: Option<Duration>,
    sessions_per_connection: usize,
    max_sessions: usize,
    on_error: ErrorHandler,
    /// The longest close bound of the apps that ran: how long a server close waits for each step.
    close_bound: Mutex<Duration>,
    /// Until when a closing server's connections wait for clients whose sessions it ended to leave.
    leave_until: Mutex<Option<Instant>>,
    /// What runs now; [`Self::idle`] reports each change.
    active: Mutex<Active>,
    idle: Condvar,
    /// Set when the server starts closing: no new connections or sessions, and running apps end.
    closing: watch::Sender<bool>,
    /// Set once sessions have ended or the wait for them is over: connections close.
    closed: watch::Sender<bool>,
}

impl Shared {
    /// Reports an error, with the client's address and user name when known.
    fn report(&self, error: Error, peer: Option<SocketAddr>, user: Option<&str>) {
        let report = ErrorReport { error: &error, peer, user };
        // A panicking error handler must not take a network thread with it.
        let _ = catch_unwind(AssertUnwindSafe(|| (self.on_error)(&report)));
    }

    /// Reports a connection failure, except a client simply going away.
    fn report_connection(&self, error: russh::Error, peer: SocketAddr, user: Option<&str>) {
        let gone = match &error {
            russh::Error::Disconnect | russh::Error::HUP | russh::Error::KeepaliveTimeout => true,
            russh::Error::IO(error) => matches!(
                error.kind(),
                io::ErrorKind::UnexpectedEof
                    | io::ErrorKind::ConnectionReset
                    | io::ErrorKind::ConnectionAborted
                    | io::ErrorKind::BrokenPipe
            ),
            _ => false,
        };
        if !gone {
            self.report(Error::ssh(error), Some(peer), user);
        }
    }

    /// Takes a session slot. Returns `false` when every slot is taken.
    fn reserve(&self) -> bool {
        let mut active = lock(&self.active);
        let free = active.sessions < self.max_sessions;
        active.sessions += usize::from(free);
        free
    }

    fn release(&self) {
        self.change(|active| active.sessions = active.sessions.saturating_sub(1));
    }

    fn change(&self, change: impl FnOnce(&mut Active)) {
        change(&mut lock(&self.active));
        self.idle.notify_all();
    }

    fn note_close_bound(&self, bound: Duration) {
        let mut longest = lock(&self.close_bound);
        *longest = (*longest).max(bound);
    }

    fn is_closing(&self) -> bool {
        *self.closing.borrow()
    }
}

/// A running SSH server, from [`serve`].
///
/// Dropping it closes it as [`Self::close`] does, so the drop blocks while sessions restore their clients' terminals.
/// Keep it for as long as the server should run, for instance by calling [`Self::close_on_ctrl_c`].
#[must_use = "dropping the Server closes it"]
pub struct Server {
    shared: Arc<Shared>,
    local_addr: SocketAddr,
    fingerprints: Vec<String>,
    runtime: Mutex<Option<(tokio::runtime::Runtime, tokio::task::JoinHandle<()>)>>,
    done: (Mutex<bool>, Condvar),
}

impl std::fmt::Debug for Server {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("Server")
            .field("local_addr", &self.local_addr)
            .field("fingerprints", &self.fingerprints)
            .field("sessions", &self.sessions())
            .finish_non_exhaustive()
    }
}

impl Server {
    /// The address the server listens on, with the port it picked when asked for port 0.
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// The SHA-256 fingerprints of the host keys, as `ssh-keygen -l` and SSH clients show them.
    pub fn fingerprints(&self) -> &[String] {
        &self.fingerprints
    }

    /// Sessions running now.
    pub fn sessions(&self) -> usize {
        lock(&self.shared.active).sessions
    }

    /// Stops accepting connections, asks every session's app to end so it restores its client's terminal, waits for
    /// the sessions to finish and their clients to leave, then closes every connection. A client leaves once the
    /// channel close reaches it, which SSH sends only after the output still queued for the channel, so a slow
    /// client gets its terminal back. Each wait is bounded by the apps' close bound, or all of them by
    /// [`ServerConfig::close_timeout`](crate::ServerConfig::close_timeout). Returns once the server has stopped; later
    /// calls wait for that too. It blocks the calling thread, so from async code prefer
    /// `tokio::task::spawn_blocking`.
    pub fn close(&self) {
        if tokio::runtime::Handle::try_current().is_ok() {
            // Blocking on the server's runtime from inside another runtime panics; a thread of its own may block.
            std::thread::scope(|scope| {
                let _ = scope.spawn(|| self.close_now()).join();
            });
        } else {
            self.close_now();
        }
    }

    fn close_now(&self) {
        let Some((runtime, accepting)) = lock(&self.runtime).take() else {
            self.wait();
            return;
        };
        self.shared.closing.send_replace(true);
        let started = Instant::now();
        let bound = *lock(&self.shared.close_bound);
        // Each session has its app's close bound to restore the terminal and as long again for the client to take
        // that output, as its transport allows; then the client has as long once more to leave. An operator's close
        // timeout caps the whole close instead.
        let cap = self.shared.close_timeout.map(|timeout| later(started, timeout));
        let sessions_until =
            cap.unwrap_or_else(|| later(started, bound.saturating_mul(2).saturating_add(FAREWELL_TIMEOUT * 2)));
        let mut active = lock(&self.shared.active);
        while active.sessions > 0 || active.transports > 0 {
            let left = sessions_until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            active = self.shared.idle.wait_timeout(active, left).unwrap_or_else(PoisonError::into_inner).0;
        }
        drop(active);
        let leave_until = cap.unwrap_or_else(|| later(Instant::now(), bound));
        *lock(&self.shared.leave_until) = Some(leave_until);
        self.shared.closed.send_replace(true);
        // Let clients leave, and disconnect the rest.
        let joined = later(leave_until, FAREWELL_TIMEOUT).into();
        let _ = runtime.block_on(async { tokio::time::timeout_at(joined, accepting).await });
        runtime.shutdown_timeout(Duration::from_secs(1));
        let (closed, changed) = &self.done;
        *lock(closed) = true;
        changed.notify_all();
    }

    /// Waits until the server has closed.
    pub fn wait(&self) {
        let (closed, changed) = &self.done;
        let mut closed = lock(closed);
        while !*closed {
            closed = changed.wait(closed).unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// Waits for Ctrl+C, or SIGTERM on Unix, then closes the server as [`Self::close`] does, so every client's
    /// terminal is restored. Returns early when another thread closes the server.
    pub fn close_on_ctrl_c(&self) -> Result<(), Error> {
        let (sender, signaled) = std::sync::mpsc::channel();
        {
            let runtime = lock(&self.runtime);
            let Some((runtime, _)) = runtime.as_ref() else { return Ok(()) };
            let mut closing = self.shared.closing.subscribe();
            runtime.spawn(async move {
                let result = tokio::select! {
                    result = shutdown_signal() => result,
                    () = raised(&mut closing) => Ok(()),
                };
                let _ = sender.send(result);
            });
        }
        // A runtime shut down meanwhile drops the task, and with it the sender.
        let result = signaled.recv().unwrap_or(Ok(()));
        self.close();
        result.map_err(Error::Io)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.close();
    }
}

async fn shutdown_signal() -> io::Result<()> {
    #[cfg(unix)]
    {
        let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await
}

async fn accept(listener: TcpListener, ssh: Arc<russh::server::Config>, shared: Arc<Shared>) {
    let mut closing = shared.closing.subscribe();
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            () = raised(&mut closing) => break,
            accepted = listener.accept() => match accepted {
                Ok((socket, peer)) => {
                    connections.spawn(connection(socket, peer, Arc::clone(&ssh), Arc::clone(&shared)));
                }
                Err(error) => {
                    shared.report(Error::Io(error), None, None);
                    // Out of file descriptors, for one: pause rather than spin.
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            },
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    drop(listener);
    while connections.join_next().await.is_some() {}
}

async fn connection(socket: TcpStream, peer: SocketAddr, ssh: Arc<russh::server::Config>, shared: Arc<Shared>) {
    // Nagle's algorithm would hold a frame's last packets until the client's delayed acknowledgement.
    let _ = socket.set_nodelay(true);
    let login_deadline = tokio::time::Instant::now() + LOGIN_GRACE;
    let authenticated = Arc::new(OnceLock::new());
    let sessions = Arc::new(AtomicUsize::new(0));
    let handler = Connection {
        shared: Arc::clone(&shared),
        peer,
        identity: None,
        authenticated: Arc::clone(&authenticated),
        channels: HashMap::new(),
        sessions: Arc::clone(&sessions),
    };
    let mut closing = shared.closing.subscribe();
    let started = tokio::time::timeout_at(login_deadline, russh::server::run_stream(ssh, socket, handler));
    let running = tokio::select! {
        started = started => match started {
            Ok(Ok(running)) => running,
            Ok(Err(error)) => return shared.report_connection(error, peer, None),
            Err(_) => return,
        },
        // A connection still exchanging versions could not start a session any more.
        () = raised(&mut closing) => return,
    };
    let handle = running.handle();
    let mut closed = shared.closed.subscribe();
    let login = tokio::time::sleep_until(login_deadline);
    tokio::pin!(running, login);
    // Whether the server's close ended sessions of this connection, whose clients then still take their output.
    let mut ended: Option<bool> = None;
    let reason = loop {
        tokio::select! {
            result = &mut running => {
                if let Err(error) = result {
                    shared.report_connection(error, peer, authenticated.get().map(String::as_str));
                }
                return;
            }
            () = raised(&mut closing), if ended.is_none() => {
                ended = Some(sessions.load(Ordering::SeqCst) > 0);
            }
            () = raised(&mut closed) => break None,
            () = &mut login, if authenticated.get().is_none() => {
                if authenticated.get().is_some() {
                    continue;
                }
                break Some("authentication took too long");
            }
        }
    };
    // russh sends the channel close only after the output it still holds for the channel, and a client leaves once
    // the close reaches it, as OpenSSH's does: until then, or the close bound, the client may still be taking its
    // terminal's restoration.
    let leave_until = match ended {
        Some(true) => *lock(&shared.leave_until),
        _ => None,
    };
    let reason = match (reason, leave_until) {
        (Some(reason), _) => reason,
        (None, Some(until)) if tokio::time::timeout_at(until.into(), &mut running).await.is_ok() => return,
        (None, _) => "the server closed",
    };
    let _ = handle.disconnect(Disconnect::ByApplication, reason.into(), String::new()).await;
}

/// One SSH connection: its authentication, channels, and sessions.
struct Connection {
    shared: Arc<Shared>,
    peer: SocketAddr,
    identity: Option<Identity>,
    /// The user name, once the client has authenticated.
    authenticated: Arc<OnceLock<String>>,
    channels: HashMap<ChannelId, ChannelState>,
    /// Sessions this connection runs now.
    sessions: Arc<AtomicUsize>,
}

#[derive(Default)]
struct ChannelState {
    /// The terminal type and size from the client's pseudo-terminal request.
    pty: Option<(String, u16, u16)>,
    environment: Vec<(String, String)>,
    shell: Option<Shell>,
}

/// A session's place in the limits. Its thread and its transport each hold it; it frees the place once both are
/// done.
struct Slot {
    shared: Arc<Shared>,
    /// The connection's count of sessions.
    sessions: Arc<AtomicUsize>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.sessions.fetch_sub(1, Ordering::SeqCst);
        self.shared.release();
    }
}

/// A channel's running session, as its connection sees it.
struct Shell {
    link: RemoteLink,
    backlog: Arc<Backlog>,
    last_input: Arc<Mutex<Instant>>,
    /// Set once the transport has closed the channel. russh then forgets the channel without telling the handler,
    /// so its state is dropped when the next channel opens.
    closed: Arc<AtomicBool>,
}

/// Client input its app has no room for yet.
#[derive(Default)]
struct Backlog {
    bytes: Mutex<VecDeque<u8>>,
    /// Notified when the backlog shrinks, for a `data` handler waiting for room.
    room: Notify,
}

impl Backlog {
    /// Passes the app what it has room for and queues as much of the rest of `bytes` as fits. Returns what did not
    /// fit.
    fn offer<'a>(&self, link: &RemoteLink, mut bytes: &'a [u8]) -> &'a [u8] {
        let mut queued = lock(&self.bytes);
        loop {
            Self::pass(&mut queued, link);
            if queued.is_empty() {
                bytes = &bytes[link.send_input(bytes)..];
            }
            let fits = BACKLOG_BYTES_MAX.saturating_sub(queued.len()).min(bytes.len());
            queued.extend(&bytes[..fits]);
            bytes = &bytes[fits..];
            if fits == 0 {
                return bytes;
            }
        }
    }

    /// Passes the app what it has room for, and wakes a waiting handler when that made room.
    fn flush(&self, link: &RemoteLink) {
        if Self::pass(&mut lock(&self.bytes), link) {
            self.room.notify_one();
        }
    }

    /// Passes queued input to the app until it has no more room. Returns whether it passed any.
    fn pass(queued: &mut VecDeque<u8>, link: &RemoteLink) -> bool {
        let before = queued.len();
        while !queued.is_empty() {
            let sent = link.send_input(queued.as_slices().0);
            if sent == 0 {
                break;
            }
            queued.drain(..sent);
        }
        queued.len() < before
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        for shell in self.channels.values().filter_map(|state| state.shell.as_ref()) {
            shell.link.disconnect();
        }
    }
}

/// A client-reported dimension within `max`. Zero stays zero, which the remote terminal reads as its default.
fn dimension(value: u32, max: u16) -> u16 {
    u16::try_from(value).unwrap_or(u16::MAX).min(max)
}

impl Connection {
    fn verdict(&mut self, identity: Option<Identity>) -> Verdict {
        match identity {
            Some(identity) => {
                let _ = self.authenticated.set(identity.user().to_owned());
                self.identity = Some(identity);
                Verdict::Accept
            }
            None => Verdict::reject(),
        }
    }

    fn shell(&self, channel: ChannelId) -> Option<&Shell> {
        self.channels.get(&channel)?.shell.as_ref()
    }

    /// Starts a session on a channel: confirms the shell request, then runs the handler on a thread of its own and
    /// the channel's transport as a task. Returns `Ok(false)` to refuse, before confirming anything.
    fn start(&mut self, channel: ChannelId, session: &mut SshSession) -> Result<bool, Error> {
        let shared = &self.shared;
        let Some(state) = self.channels.get_mut(&channel) else { return Ok(false) };
        if state.shell.is_some()
            || shared.is_closing()
            || self.sessions.load(Ordering::SeqCst) >= shared.sessions_per_connection
            || !shared.reserve()
        {
            return Ok(false);
        }
        let (term, width, height) = state.pty.clone().unwrap_or_else(|| (String::new(), 0, 0));
        let term = if term.is_empty() { DEFAULT_TERM.to_owned() } else { term };
        let mut environment = vec![("TERM".to_owned(), term.clone())];
        environment
            .extend(state.environment.iter().filter(|(name, _)| FORWARDED_ENV.contains(&name.as_str())).cloned());
        let woken = Arc::new(Notify::new());
        let wake = {
            let woken = Arc::clone(&woken);
            move || woken.notify_one()
        };
        let (terminal, link) = match RemoteTerminal::new(RemoteOptions { width, height, environment }, wake) {
            Ok(pair) => pair,
            Err(error) => {
                shared.release();
                return Err(error.into());
            }
        };
        let denied = Arc::new(AtomicBool::new(false));
        let app_session = Session {
            identity: self.identity.clone().unwrap_or(Identity::None { user: String::new() }),
            term,
            size: terminal.size(),
            has_pty: state.pty.is_some(),
            peer: Some(self.peer),
            environment: state.environment.clone(),
            terminal: RefCell::new(Some(terminal)),
            denied: Arc::clone(&denied),
        };
        if let Err(error) = session.channel_success(channel) {
            shared.release();
            return Err(Error::ssh(error));
        }
        let (done, finished) = oneshot::channel();
        self.sessions.fetch_add(1, Ordering::SeqCst);
        let slot = Arc::new(Slot { shared: Arc::clone(shared), sessions: Arc::clone(&self.sessions) });
        let spawned = {
            let (shared, slot) = (Arc::clone(shared), Arc::clone(&slot));
            std::thread::Builder::new().name("opentui-ssh-session".into()).spawn(move || {
                let code = run_handler(&shared, app_session, &denied);
                // Before the transport learns the exit status, so only its own share of the slot remains.
                drop(slot);
                let _ = done.send(code);
            })
        };
        if let Err(error) = spawned {
            shared.report(error.into(), Some(self.peer), self.identity.as_ref().map(Identity::user));
            let _ = session.close(channel);
            return Ok(true);
        }
        let shell = Shell {
            link,
            backlog: Arc::default(),
            last_input: Arc::new(Mutex::new(Instant::now())),
            closed: Arc::default(),
        };
        shared.change(|active| active.transports += 1);
        tokio::spawn(transport(Transport {
            handle: session.handle(),
            channel,
            link: shell.link.clone(),
            backlog: Arc::clone(&shell.backlog),
            woken,
            finished,
            shared: Arc::clone(shared),
            last_input: Arc::clone(&shell.last_input),
            closed: Arc::clone(&shell.closed),
            slot,
            running: Running(Arc::clone(shared)),
        }));
        state.shell = Some(shell);
        Ok(true)
    }
}

/// Runs the handler and returns the session's exit status: 0 unless it was denied, failed, or panicked.
fn run_handler(shared: &Shared, session: Session, denied: &AtomicBool) -> u32 {
    let (peer, user) = (session.peer_addr(), session.user().to_owned());
    let error = match catch_unwind(AssertUnwindSafe(|| (shared.handler)(session))) {
        Ok(Ok(())) => return u32::from(denied.load(Ordering::SeqCst)),
        Ok(Err(error)) => Error::App(error),
        Err(payload) => Error::Panic(panic_message(&*payload)),
    };
    shared.report(error, peer, Some(&user));
    1
}

impl russh::server::Handler for Connection {
    type Error = russh::Error;

    async fn auth_none(&mut self, user: &str) -> Result<Verdict, Self::Error> {
        let identity = self.shared.auth.none(user);
        Ok(self.verdict(identity))
    }

    async fn auth_publickey_offered(&mut self, _user: &str, key: &PublicKey) -> Result<Verdict, Self::Error> {
        Ok(if self.shared.auth.offers(key) { Verdict::Accept } else { Verdict::reject() })
    }

    async fn auth_publickey(&mut self, user: &str, key: &PublicKey) -> Result<Verdict, Self::Error> {
        let report = |error| self.shared.report(error, Some(self.peer), Some(user));
        let identity = self.shared.auth.public_key_identity(user, key, report);
        Ok(self.verdict(identity))
    }

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Verdict, Self::Error> {
        let report = |error| self.shared.report(error, Some(self.peer), Some(user));
        let identity = self.shared.auth.password_identity(user, password, report);
        Ok(self.verdict(identity))
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut SshSession,
    ) -> Result<(), Self::Error> {
        self.channels.retain(|_, state| !state.shell.as_ref().is_some_and(|shell| shell.closed.load(Ordering::SeqCst)));
        if self.channels.len() >= CHANNELS_MAX {
            reply.reject(ChannelOpenFailure::ResourceShortage).await;
            return Ok(());
        }
        // The handler's callbacks see everything; a kept channel object would also queue a copy of each message.
        self.channels.insert(channel.id(), ChannelState::default());
        drop(channel);
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        term: &str,
        columns: u32,
        rows: u32,
        _pixel_width: u32,
        _pixel_height: u32,
        _modes: &[(Pty, u32)],
        session: &mut SshSession,
    ) -> Result<(), Self::Error> {
        match self.channels.get_mut(&channel) {
            Some(state) if state.shell.is_none() => {
                let term = if term.len() <= TERM_BYTES_MAX { term } else { "" };
                state.pty = Some((term.to_owned(), dimension(columns, COLUMNS_MAX), dimension(rows, ROWS_MAX)));
                session.channel_success(channel)
            }
            _ => session.channel_failure(channel),
        }
    }

    async fn env_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        value: &str,
        session: &mut SshSession,
    ) -> Result<(), Self::Error> {
        let accepted = self.channels.get_mut(&channel).is_some_and(|state| {
            let fits = state.shell.is_none()
                && state.environment.len() < ENV_ENTRIES_MAX
                && name.len() + value.len() <= ENV_BYTES_MAX;
            if fits {
                state.environment.push((name.to_owned(), value.to_owned()));
            }
            fits
        });
        if accepted { session.channel_success(channel) } else { session.channel_failure(channel) }
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut SshSession) -> Result<(), Self::Error> {
        match self.start(channel, session) {
            Ok(true) => Ok(()),
            Ok(false) => session.channel_failure(channel),
            Err(error) => {
                self.shared.report(error, Some(self.peer), self.identity.as_ref().map(Identity::user));
                session.channel_failure(channel)
            }
        }
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        _data: &[u8],
        session: &mut SshSession,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        _name: &str,
        session: &mut SshSession,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)
    }

    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        columns: u32,
        rows: u32,
        _pixel_width: u32,
        _pixel_height: u32,
        _session: &mut SshSession,
    ) -> Result<(), Self::Error> {
        if let Some(state) = self.channels.get_mut(&channel) {
            let (width, height) = (dimension(columns, COLUMNS_MAX), dimension(rows, ROWS_MAX));
            if let Some(pty) = &mut state.pty {
                (pty.1, pty.2) = (width, height);
            }
            if let Some(shell) = &state.shell {
                shell.link.resize(width, height);
            }
        }
        Ok(())
    }

    async fn data(&mut self, channel: ChannelId, data: &[u8], _session: &mut SshSession) -> Result<(), Self::Error> {
        let Some(shell) = self.shell(channel) else { return Ok(()) };
        *lock(&shell.last_input) = Instant::now();
        let (link, backlog) = (shell.link.clone(), Arc::clone(&shell.backlog));
        let mut rest = data;
        loop {
            rest = backlog.offer(&link, rest);
            if rest.is_empty() {
                return Ok(());
            }
            // The app is a whole backlog behind. Waiting here stops reading the connection, which holds the client
            // back instead of dropping its input.
            backlog.room.notified().await;
        }
    }

    async fn channel_eof(&mut self, channel: ChannelId, _session: &mut SshSession) -> Result<(), Self::Error> {
        // No more input will come; the app ends as it would at the end of its own terminal's input.
        if let Some(shell) = self.shell(channel) {
            shell.link.terminate();
        }
        Ok(())
    }

    async fn channel_close(&mut self, channel: ChannelId, _session: &mut SshSession) -> Result<(), Self::Error> {
        if let Some(shell) = self.channels.remove(&channel).and_then(|state| state.shell) {
            shell.link.disconnect();
        }
        Ok(())
    }
}

/// What a channel's transport task needs.
struct Transport {
    handle: Handle,
    channel: ChannelId,
    link: RemoteLink,
    backlog: Arc<Backlog>,
    /// Notified when the link has output, room for input, or a finished app.
    woken: Arc<Notify>,
    /// The session thread's exit status, once its handler returns.
    finished: oneshot::Receiver<u32>,
    shared: Arc<Shared>,
    last_input: Arc<Mutex<Instant>>,
    closed: Arc<AtomicBool>,
    slot: Arc<Slot>,
    running: Running,
}

/// Counts a transport task as running until it ends, even if the runtime drops it.
struct Running(Arc<Shared>);

impl Drop for Running {
    fn drop(&mut self) {
        self.0.change(|active| active.transports = active.transports.saturating_sub(1));
    }
}

/// When the idle or maximum timeout ends a session that started at `started`. A timeout too long to represent as an
/// instant never ends it.
fn timeout_at(shared: &Shared, last_input: &Mutex<Instant>, started: Instant) -> Option<Instant> {
    let idle = shared.idle_timeout.and_then(|timeout| lock(last_input).checked_add(timeout));
    let max = shared.max_timeout.and_then(|timeout| started.checked_add(timeout));
    idle.into_iter().chain(max).min()
}

/// Moves the session's input and output, ends the app on a timeout or when the server closes, and closes the
/// channel with the session's exit status once the handler returns.
async fn transport(transport: Transport) {
    let Transport { handle, channel, link, backlog, woken, mut finished, shared, last_input, closed, slot, running } =
        transport;
    let started = Instant::now();
    let mut closing = shared.closing.subscribe();
    // When the session began to end: the app was asked to, or its handler returned. The app has its close bound from
    // the request to restore the client's terminal, and the client as long again from the return to take that output.
    let mut ending: Option<Instant> = None;
    let mut connected = true;
    let mut exit = None;
    // Output taken from the app that the connection has not accepted yet.
    let mut unsent: Option<Bytes> = None;
    let code = loop {
        backlog.flush(&link);
        if connected && unsent.is_none() {
            let output = link.take_output(CHUNK_BYTES);
            unsent = (!output.is_empty()).then(|| Bytes::from(output));
        }
        if let Some(code) = exit
            && unsent.is_none()
        {
            break code;
        }
        // The app sets its bound when it starts; the server's close waits by the longest.
        shared.note_close_bound(link.close_bound());
        let deadline = match ending {
            Some(since) => since.checked_add(link.close_bound()),
            None => timeout_at(&shared, &last_input, started),
        };
        let sleep = tokio::time::sleep_until(deadline.unwrap_or_else(Instant::now).into());
        // Sending waits while the client's window is full; the other branches still run meanwhile. Dropping the send
        // unfinished sends nothing, so the same output goes again on the next turn.
        let chunk = unsent.clone();
        let send = async {
            match chunk {
                Some(chunk) => handle.data(channel, chunk).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            sent = send => {
                unsent = None;
                if sent.is_err() {
                    connected = false;
                    link.disconnect();
                }
            }
            () = woken.notified() => {}
            code = &mut finished, if exit.is_none() => {
                exit = Some(code.unwrap_or(1));
                ending = Some(Instant::now());
            }
            () = raised(&mut closing), if ending.is_none() => {
                link.terminate();
                ending = Some(Instant::now());
            }
            () = sleep, if deadline.is_some() => {
                if ending.is_some() {
                    // The app did not finish, or the client did not take its last output, in time: give up on
                    // restoring the client's terminal.
                    link.disconnect();
                    (connected, unsent) = (false, None);
                    exit.get_or_insert(1);
                } else if timeout_at(&shared, &last_input, started).is_some_and(|deadline| Instant::now() >= deadline) {
                    link.terminate();
                    ending = Some(Instant::now());
                }
                // Otherwise input arrived meanwhile, and the next turn waits for the later deadline.
            }
        }
    };
    backlog.flush(&link);
    backlog.room.notify_one();
    if connected {
        let farewell = async {
            let _ = handle.exit_status_request(channel, code).await;
            let _ = handle.eof(channel).await;
        };
        connected = tokio::time::timeout(FAREWELL_TIMEOUT, farewell).await.is_ok();
    }
    // Before the channel closes, so a client that sees it close can start another session at once.
    drop(slot);
    if connected {
        let _ = tokio::time::timeout(FAREWELL_TIMEOUT, handle.close(channel)).await;
    }
    closed.store(true, Ordering::SeqCst);
    drop(running);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_access_beyond_the_loopback_interface_warns() {
        let any: SocketAddr = "0.0.0.0:2222".parse().unwrap();
        let warning = open_access_warning(&Auth::open(), any);
        assert!(matches!(&warning, Some(Error::OpenAccess(addr)) if *addr == any));
        let shown = warning.unwrap().to_string();
        assert!(shown.starts_with("listening on 0.0.0.0:2222 without authentication."), "{shown}");
        for local in ["127.0.0.1:2222", "[::1]:2222"] {
            assert!(open_access_warning(&Auth::open(), local.parse().unwrap()).is_none(), "{local}");
        }
        assert!(open_access_warning(&Auth::empty().any_public_key(), any).is_none());
    }
}
