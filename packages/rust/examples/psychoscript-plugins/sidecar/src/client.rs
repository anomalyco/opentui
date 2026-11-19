//! A sidecar client: a plugin's helper process, spoken to in JSON-RPC 2.0 over its stdin and stdout, one message per
//! line (MCP's stdio framing). Its stderr is a log the client keeps the tail of.
//!
//! A [`Conn`] is one running helper: a reader thread completes calls by id and routes `$/chunk` notifications to the
//! call's channel; when the helper's stdout ends, every call in flight fails with how it exited. A [`Sidecar`]
//! supervises a plugin's helper: it starts one at the first call and again at the call after a crash, with backoff.
//! A call's timeout, and dropping a call's future, cancel it with `$/cancel`.

use serde_json::{Value as Json, json};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::pin::Pin;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, Weak};
use std::task::{Context, Poll, Waker};
use std::time::{Duration, Instant};

pub const PROTOCOL: u64 = 0;
/// A helper that stayed up this long starts a fresh failure streak: its next restart has no backoff.
const HEALTHY: Duration = Duration::from_secs(10);
const STDERR_LINES: usize = 64;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

type Outcome = Result<Json, String>;

/// One call in flight: its outcome once known, the waker of the future awaiting it, and where its chunks go.
struct Call {
    state: Mutex<(Option<Outcome>, Option<Waker>)>,
    ready: Condvar,
    chunks: Option<Sender<Json>>,
}

impl Call {
    fn finish(&self, outcome: Outcome) {
        let mut state = lock(&self.state);
        state.0.get_or_insert(outcome);
        if let Some(waker) = state.1.take() {
            waker.wake()
        }
        self.ready.notify_all();
    }
}

#[derive(Default)]
struct Table {
    calls: HashMap<u64, Arc<Call>>,
    /// Why and when the helper's stdout ended; no call starts after it.
    dead: Option<(String, Instant)>,
    /// Answers to calls no longer in flight, such as a cancelled call's -32800.
    late: u64,
}

/// One running helper process. Dropping it kills the process.
pub struct Conn {
    pub pid: u32,
    started: Instant,
    stdin: Mutex<ChildStdin>,
    child: Arc<Mutex<Child>>,
    table: Arc<Mutex<Table>>,
    next: AtomicU64,
    pub stderr: Arc<Mutex<VecDeque<String>>>,
}

impl Conn {
    /// Starts a helper and waits for its `initialize` result, at most `init_timeout`.
    pub fn spawn(cmd: &[String], plugin: &str, init_timeout: Duration) -> Result<Arc<Conn>, String> {
        let mut child = Command::new(&cmd[0])
            .args(&cmd[1..])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("spawn {}: {e}", cmd[0]))?;
        let (stdin, stdout, stderr) = (
            child.stdin.take().expect("piped"),
            child.stdout.take().expect("piped"),
            child.stderr.take().expect("piped"),
        );
        let conn = Arc::new(Conn {
            pid: child.id(),
            started: Instant::now(),
            stdin: Mutex::new(stdin),
            child: Arc::new(Mutex::new(child)),
            table: Default::default(),
            next: AtomicU64::new(0),
            stderr: Default::default(),
        });
        let (table, child) = (conn.table.clone(), conn.child.clone());
        std::thread::spawn(move || read(stdout, &table, &child));
        let log = conn.stderr.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut log = lock(&log);
                if log.len() == STDERR_LINES {
                    log.pop_front();
                }
                log.push_back(line);
            }
        });
        let init = json!({ "protocol": PROTOCOL, "plugin": plugin });
        match conn.start("initialize", &init, None, Some(init_timeout), None)?.wait() {
            Ok(result) if result["protocol"] == PROTOCOL => Ok(conn),
            Ok(result) => Err(format!("the helper speaks protocol {}, not {PROTOCOL}", result["protocol"])),
            Err(e) => Err(format!("initialize: {e}")),
        }
    }

    /// Sends a request; a plugin's carries `"caller": { "plugin": <id> }`, which helpers may ignore. Its result
    /// arrives through the returned [`Pending`]; its chunks, if any, through `chunks`.
    pub fn start(
        self: &Arc<Self>,
        method: &str,
        params: &Json,
        caller: Option<&str>,
        timeout: Option<Duration>,
        chunks: Option<Sender<Json>>,
    ) -> Result<Pending, String> {
        let id = self.next.fetch_add(1, Relaxed);
        let call = Arc::new(Call { state: Mutex::new((None, None)), ready: Condvar::new(), chunks });
        {
            let mut table = lock(&self.table);
            if let Some((why, _)) = &table.dead {
                return Err(why.clone());
            }
            table.calls.insert(id, call.clone());
        }
        if let Some(after) = timeout {
            timer().add(Arc::downgrade(self), id, after);
        }
        let method = serde_json::to_string(method).expect("a string");
        let params = serde_json::to_string(params).expect("JSON");
        let caller = caller.map_or(String::new(), |c| format!(",\"caller\":{{\"plugin\":{}}}", Json::from(c)));
        let line = format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":{method},\"params\":{params}{caller}}}\n");
        if let Err(e) = self.write(line.as_bytes()) {
            lock(&self.table).calls.remove(&id);
            return Err(e);
        }
        Ok(Pending { conn: self.clone(), id, call })
    }

    fn write(&self, line: &[u8]) -> Result<(), String> {
        lock(&self.stdin).write_all(line).map_err(|e| format!("helper stdin: {e}"))
    }

    /// Fails a call still in flight with `why` and tells the helper to stop it.
    fn cancel(&self, id: u64, why: String) {
        let Some(call) = lock(&self.table).calls.remove(&id) else { return };
        call.finish(Err(why));
        let _ = self
            .write(format!("{{\"jsonrpc\":\"2.0\",\"method\":\"$/cancel\",\"params\":{{\"id\":{id}}}}}\n").as_bytes());
    }

    /// Why and when the helper's stdout ended, if it did.
    pub fn dead(&self) -> Option<(String, Instant)> {
        lock(&self.table).dead.clone()
    }

    pub fn late_answers(&self) -> u64 {
        lock(&self.table).late
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        let mut child = lock(&self.child);
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// The reader thread: completes calls by id and routes chunks, until the helper's stdout ends; then fails every call
/// in flight with how the helper exited.
fn read(stdout: std::process::ChildStdout, table: &Mutex<Table>, child: &Mutex<Child>) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if let Ok(msg) = serde_json::from_str::<Json>(&line) {
            route(table, msg)
        }
    }
    let status = lock(child).wait().map_or_else(|e| e.to_string(), |s| s.to_string());
    let why = format!("helper exited: {status}");
    let calls = {
        let mut table = lock(table);
        table.dead = Some((why.clone(), Instant::now()));
        std::mem::take(&mut table.calls)
    };
    calls.into_values().for_each(|call| call.finish(Err(why.clone())));
}

fn route(table: &Mutex<Table>, mut msg: Json) {
    if msg["method"] == "$/chunk" {
        let call = msg["params"]["id"].as_u64().and_then(|id| lock(table).calls.get(&id).cloned());
        if let Some(chunks) = call.as_ref().and_then(|c| c.chunks.as_ref()) {
            let _ = chunks.send(msg["params"]["chunk"].take());
        }
        return;
    }
    let Some(id) = msg["id"].as_u64() else { return };
    let call = {
        let mut table = lock(table);
        let call = table.calls.remove(&id);
        table.late += call.is_none() as u64;
        call
    };
    let Some(call) = call else { return };
    call.finish(match msg.get_mut("error") {
        Some(error) => Err(format!("{} ({})", error["message"].as_str().unwrap_or("error"), error["code"])),
        None => Ok(msg["result"].take()),
    });
}

/// A call in flight: [`Pending::wait`] blocks for its result; as a future it resolves with it. Dropped before its
/// result, it cancels the call.
pub struct Pending {
    conn: Arc<Conn>,
    id: u64,
    call: Arc<Call>,
}

impl Pending {
    pub fn wait(self) -> Result<Json, String> {
        let mut state = lock(&self.call.state);
        loop {
            if let Some(outcome) = state.0.take() {
                return outcome;
            }
            state = self.call.ready.wait(state).unwrap_or_else(|e| e.into_inner());
        }
    }
}

impl Future for Pending {
    type Output = Result<Json, String>;
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let mut state = lock(&self.call.state);
        match state.0.take() {
            Some(outcome) => Poll::Ready(outcome),
            None => {
                state.1 = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        self.conn.cancel(self.id, "cancelled: the caller went away".into());
    }
}

/// One thread for every call's timeout: on time, a call still in flight fails and the helper gets `$/cancel`.
/// By deadline (and a sequence number for ties): the call's helper, its id, and its timeout.
type Due = BTreeMap<(Instant, u64), (Weak<Conn>, u64, Duration)>;

#[derive(Default)]
struct Timer {
    due: Mutex<Due>,
    changed: Condvar,
    seq: AtomicU64,
}

fn timer() -> &'static Timer {
    static TIMER: OnceLock<Timer> = OnceLock::new();
    let mut fresh = false;
    let timer = TIMER.get_or_init(|| {
        fresh = true;
        Timer::default()
    });
    if fresh {
        std::thread::spawn(|| TIMER.get().expect("set").run());
    }
    timer
}

impl Timer {
    fn add(&self, conn: Weak<Conn>, id: u64, after: Duration) {
        let key = (Instant::now() + after, self.seq.fetch_add(1, Relaxed));
        let mut due = lock(&self.due);
        let first = due.first_key_value().is_none_or(|(k, _)| key < *k);
        due.insert(key, (conn, id, after));
        if first {
            self.changed.notify_one()
        }
    }

    fn run(&self) {
        let mut due = lock(&self.due);
        loop {
            let now = Instant::now();
            due = match due.first_key_value().map(|(k, _)| k.0) {
                Some(at) if at <= now => {
                    let (_, (conn, id, after)) = due.pop_first().expect("first");
                    drop(due);
                    if let Some(conn) = conn.upgrade() {
                        conn.cancel(id, format!("timed out after {} ms", after.as_millis()))
                    }
                    lock(&self.due)
                }
                Some(at) => self.changed.wait_timeout(due, at - now).unwrap_or_else(|e| e.into_inner()).0,
                None => self.changed.wait(due).unwrap_or_else(|e| e.into_inner()),
            }
        }
    }
}

/// A plugin's supervised helper: started at the first call, restarted at the call after it died. Restarts back off:
/// none for the first, then 100 ms, 200 ms, 400 ms, ... up to 5 s; a call inside the backoff fails at once rather than
/// blocking the plugin's thread. A helper that stayed up [`HEALTHY`] resets the streak.
pub struct Sidecar {
    cmd: Vec<String>,
    plugin: String,
    pub init_timeout: Duration,
    state: Mutex<Supervisor>,
}

#[derive(Default)]
struct Supervisor {
    conn: Option<Arc<Conn>>,
    starts: u32,
    failures: u32,
    not_before: Option<(Instant, String)>,
}

pub fn backoff(failures: u32) -> Duration {
    match failures {
        0 | 1 => Duration::ZERO,
        n => Duration::from_millis(100u64.saturating_mul(1 << (n - 2).min(16))).min(Duration::from_secs(5)),
    }
}

impl Sidecar {
    pub fn new(cmd: Vec<String>, plugin: impl Into<String>) -> Self {
        Sidecar { cmd, plugin: plugin.into(), init_timeout: Duration::from_secs(5), state: Default::default() }
    }

    /// The running helper, started or restarted if need be.
    pub fn conn(&self) -> Result<Arc<Conn>, String> {
        let mut s = lock(&self.state);
        if let Some(conn) = &s.conn {
            let Some((why, at)) = conn.dead() else { return Ok(conn.clone()) };
            if at - conn.started >= HEALTHY {
                s.failures = 0
            }
            s.failures += 1;
            s.not_before = Some((at + backoff(s.failures), why));
            s.conn = None;
        }
        if let Some((at, why)) = s.not_before.as_ref().filter(|(at, _)| *at > Instant::now()) {
            return Err(format!("helper restarting in {} ms ({why})", (*at - Instant::now()).as_millis()));
        }
        s.starts += 1;
        match Conn::spawn(&self.cmd, &self.plugin, self.init_timeout) {
            Ok(conn) => {
                s.conn = Some(conn.clone());
                Ok(conn)
            }
            Err(why) => {
                s.failures += 1;
                s.not_before = Some((Instant::now() + backoff(s.failures), why.clone()));
                Err(why)
            }
        }
    }

    /// Sends a request for the plugin `caller`, starting the helper if need be. Callers that find it starting wait
    /// for that one start.
    pub fn start(
        &self,
        method: &str,
        params: &Json,
        caller: &str,
        timeout: Option<Duration>,
        chunks: Option<Sender<Json>>,
    ) -> Result<Pending, String> {
        self.conn()?.start(method, params, Some(caller), timeout, chunks)
    }

    pub fn call(&self, method: &str, params: &Json, caller: &str, timeout: Option<Duration>) -> Result<Json, String> {
        self.start(method, params, caller, timeout, None)?.wait()
    }

    /// Processes started, the first included.
    pub fn starts(&self) -> u32 {
        lock(&self.state).starts
    }

    /// Starts after the first.
    pub fn restarts(&self) -> u32 {
        self.starts().saturating_sub(1)
    }

    pub fn pid(&self) -> Option<u32> {
        lock(&self.state).conn.as_ref().map(|c| c.pid)
    }
}
