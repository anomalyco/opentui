//! Glue between an OpenTUI Rust app and PsychoScript plugins, in the reducer model.
//!
//! A plugin is one `.js` program. Each event runs it once with two read-only bindings, `event` and `state`, and it
//! returns plain data: `{ state, slots, commands }`. The host keeps `state` between events, diffs `slots` against what
//! it last drew, and registers `commands` with the app's keymap. A failed run (a throw, a timeout) changes nothing:
//! the state stays as it was and the plugin's status slot shows the error.
//!
//! Each plugin runs on a worker thread of its own, fed by a bounded channel, so a slow or runaway plugin delays only
//! its own events; replies reach the UI thread through `AppProxy::send`. The program can reach only the `app` global
//! that [`capabilities`] builds.

use opentui::keymap::{Binding, Command, Disposer, Keymap, Layer, Stroke};
use opentui::prelude::*;
use psychoscript::{HostFunction, HostValue, Json, Limits, ProgramOptions, Runtime};
use serde_json::json;
use std::cell::RefCell;
use std::path::Path;
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{SyncSender, TrySendError, sync_channel};
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Poll, Waker};
use std::time::{Duration, Instant};

/// The budget for one event. psychoscript counts it in wall time from the start of the run, so it bounds compute and
/// waits on asynchronous capabilities together: a slow `git status` can time a plugin out as a loop does. It runs on
/// the plugin's own thread, so a long budget delays only that plugin.
pub const EVENT_TIMEOUT_MS: u64 = 250;
/// Events a plugin may have queued before more are dropped.
const QUEUE: usize = 64;

/// A command a plugin registers: a name it receives back as `{ type: "command", name }`, and an optional key.
#[derive(Clone, Debug, PartialEq)]
pub struct CommandSpec {
    pub name: String,
    pub title: String,
    pub key: Option<String>,
}

/// What a plugin changed in one event. `None` leaves that part as it was.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Update {
    pub slots: Option<serde_json::Map<String, Json>>,
    pub commands: Option<Vec<CommandSpec>>,
}

/// One event's answer from a plugin, sent to the UI thread.
#[derive(Debug)]
pub struct Reply {
    pub plugin: usize,
    pub result: Result<Update, String>,
    pub logs: Vec<String>,
    pub elapsed: Duration,
}

/// The outcome of running a plugin for one event: its next state and what it changed.
pub struct Step {
    pub state: Json,
    pub result: Result<Update, String>,
    pub logs: Vec<String>,
}

/// Runs a plugin for one event. Pure apart from the capabilities the runtime's globals give.
pub fn step(runtime: &Runtime, source: &str, state: &Json, event: &Json) -> Step {
    let bindings = [("event".to_string(), event.clone()), ("state".to_string(), state.clone())];
    let outcome = runtime.execute_with(source, &ProgramOptions::new().bindings(bindings));
    let logs = outcome.log_lines();
    let result = outcome.json().map_err(|d| match d.location {
        Some((line, column)) => format!("{} ({} at {line}:{column})", d.message_lossy(), d.kind),
        None => format!("{} ({})", d.message_lossy(), d.kind),
    });
    match result.and_then(|value| parse(value, state)) {
        Ok((state, update)) => Step { state, result: Ok(update), logs },
        Err(error) => Step { state: state.clone(), result: Err(error), logs },
    }
}

/// Reads a plugin's return value: `{ state?, slots?, commands? }`. A missing `state` keeps the old one.
fn parse(value: Json, old: &Json) -> Result<(Json, Update), String> {
    let Json::Object(mut fields) = value else {
        return Err(format!("A plugin returns an object, not {value}"));
    };
    let slots = match fields.remove("slots") {
        None | Some(Json::Null) => None,
        Some(Json::Object(slots)) => Some(slots),
        Some(other) => return Err(format!("slots must be an object, not {other}")),
    };
    let commands = match fields.remove("commands") {
        None | Some(Json::Null) => None,
        Some(Json::Array(list)) => Some(list.iter().map(command).collect::<Result<_, _>>()?),
        Some(other) => return Err(format!("commands must be an array, not {other}")),
    };
    let state = fields.remove("state").unwrap_or_else(|| old.clone());
    Ok((state, Update { slots, commands }))
}

fn command(value: &Json) -> Result<CommandSpec, String> {
    let text = |key| value.get(key).and_then(Json::as_str).map(str::to_string);
    let name = text("name").ok_or_else(|| format!("A command needs a name: {value}"))?;
    Ok(CommandSpec { title: text("title").unwrap_or_else(|| name.clone()), key: text("key"), name })
}

/// The `app` global: what plugins may call. `now` and `files` are synchronous; `git.status` and `sleep` give
/// promises and run off the plugin's thread.
pub fn capabilities() -> HostValue {
    let now = HostFunction::new(|_, _| HostValue::from(now_ms()));
    let files = HostFunction::new(|args, _| {
        let limit = args.first().and_then(HostValue::as_f64).map_or(usize::MAX, |n| n.max(0.0) as usize);
        HostValue::array(repo_files().iter().take(limit).map(|f| HostValue::from(f.as_str())))
    });
    let status = HostFunction::new_async(|_, _| off_thread(git_status));
    let sleep = HostFunction::new_async(|args, _| {
        let ms = args.first().and_then(HostValue::as_f64).unwrap_or(0.0).clamp(0.0, 60_000.0);
        off_thread(move || {
            std::thread::sleep(Duration::from_millis(ms as u64));
            Ok(HostValue::Undefined)
        })
    });
    HostValue::object([
        ("now", now.into()),
        ("files", files.into()),
        ("sleep", sleep.into()),
        ("git", HostValue::object([("status", status.into())])),
    ])
}

/// A runtime with the `app` global and the per-event limits.
pub fn runtime() -> Runtime {
    let app = capabilities();
    Runtime::make()
        .globals(move |_| [("app", app.clone())])
        .limits(Limits { timeout_ms: Some(EVENT_TIMEOUT_MS), max_output_bytes: Some(64 << 10) })
}

/// Milliseconds since the epoch, as `app.now()` gives them.
pub fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

/// The files of the repository around the working directory, listed once.
fn repo_files() -> &'static [String] {
    static FILES: OnceLock<Vec<String>> = OnceLock::new();
    FILES.get_or_init(|| {
        let out = std::process::Command::new("git").args(["ls-files", "--full-name", ":/"]).output();
        out.map(|o| String::from_utf8_lossy(&o.stdout).lines().map(str::to_string).collect()).unwrap_or_default()
    })
}

fn git_status() -> Result<HostValue, HostValue> {
    let out = std::process::Command::new("git")
        .args(["status", "--porcelain=v1", "--branch"])
        .output()
        .map_err(|e| HostValue::from(format!("git: {e}")))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let head = text.lines().next().unwrap_or("").trim_start_matches("## ");
    let branch = head.split("...").next().unwrap_or(head).to_string();
    let ahead = head.split("ahead ").nth(1).and_then(|s| s.split([',', ']']).next()?.parse::<f64>().ok());
    Ok(HostValue::object([
        ("branch", HostValue::from(branch)),
        ("dirty", HostValue::from(text.lines().count() > 1)),
        ("ahead", HostValue::from(ahead.unwrap_or(0.0))),
    ]))
}

/// Runs `work` on a thread of its own and resolves with its result, without an async runtime.
fn off_thread<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> impl Future<Output = T> + Send {
    let cell = Arc::new(Mutex::new((None::<T>, None::<Waker>)));
    let filler = cell.clone();
    std::thread::spawn(move || {
        let value = work();
        let mut slot = filler.lock().unwrap_or_else(|e| e.into_inner());
        slot.0 = Some(value);
        if let Some(waker) = slot.1.take() {
            waker.wake();
        }
    });
    std::future::poll_fn(move |cx| {
        let mut slot = cell.lock().unwrap_or_else(|e| e.into_inner());
        match slot.0.take() {
            Some(value) => Poll::Ready(value),
            None => {
                slot.1 = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    })
}

enum Msg {
    Event(Json),
    /// New source: the plugin keeps its state and gets `{ type: "init", reload: true }`.
    Reload(String),
}

/// A plugin's worker thread. Dropping it closes the queue and joins the thread, which ends after its current event.
pub struct Worker {
    queue: Option<SyncSender<Msg>>,
    pending: Arc<AtomicUsize>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Worker {
    /// Starts a plugin: it runs `{ type: "init" }` with a null state first. Each reply goes to `deliver`.
    pub fn spawn(plugin: usize, source: String, deliver: impl Fn(Reply) + Send + 'static) -> Self {
        let (queue, inbox) = sync_channel::<Msg>(QUEUE);
        // The init event counts as pending until it ran.
        let pending = Arc::new(AtomicUsize::new(1));
        let count = pending.clone();
        let thread = std::thread::spawn(move || {
            let runtime = runtime();
            let (mut source, mut state) = (source, Json::Null);
            let init = std::iter::once(Msg::Event(json!({ "type": "init" })));
            for msg in init.chain(inbox) {
                let event = match msg {
                    Msg::Event(event) => event,
                    Msg::Reload(next) => {
                        source = next;
                        json!({ "type": "init", "reload": true })
                    }
                };
                let started = Instant::now();
                let step = step(&runtime, &source, &state, &event);
                state = step.state;
                deliver(Reply { plugin, result: step.result, logs: step.logs, elapsed: started.elapsed() });
                count.fetch_sub(1, Ordering::Relaxed);
            }
        });
        Worker { queue: Some(queue), pending, thread: Some(thread) }
    }

    /// Queues an event. A full queue drops it; `droppable` events (ticks) are also dropped while others wait.
    pub fn send(&self, event: Json, droppable: bool) -> bool {
        if droppable && self.pending.load(Ordering::Relaxed) > 0 {
            return false;
        }
        self.push(Msg::Event(event))
    }

    pub fn reload(&self, source: String) -> bool {
        self.push(Msg::Reload(source))
    }

    fn push(&self, msg: Msg) -> bool {
        let Some(queue) = &self.queue else { return false };
        self.pending.fetch_add(1, Ordering::Relaxed);
        match queue.try_send(msg) {
            Ok(()) => true,
            Err(TrySendError::Full(_) | TrySendError::Disconnected(_)) => {
                self.pending.fetch_sub(1, Ordering::Relaxed);
                false
            }
        }
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        drop(self.queue.take());
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Reads `*.js` files from a directory, sorted by name: `(id, source)`, the id being the file stem.
pub fn load_dir(dir: &Path) -> std::io::Result<Vec<(String, String)>> {
    let mut paths: Vec<_> = std::fs::read_dir(dir)?
        .filter_map(|entry| Some(entry.ok()?.path()))
        .filter(|path| path.extension().is_some_and(|ext| ext == "js"))
        .collect();
    paths.sort();
    paths
        .into_iter()
        .map(|path| {
            let id = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
            Ok((id, std::fs::read_to_string(&path)?))
        })
        .collect()
}

/// A loaded plugin as the UI thread sees it.
struct Plugin {
    id: String,
    worker: Worker,
    status: Text,
    panel: View,
    body: Text,
    drawn: serde_json::Map<String, Json>,
    commands: Vec<CommandSpec>,
    layer: Disposer,
    elapsed: Duration,
}

/// The plugins of one app: their slots in a status bar and a panel row, their commands in a keymap.
#[derive(Clone)]
pub struct Host(Rc<Inner>);

struct Inner {
    plugins: RefCell<Vec<Plugin>>,
    keymap: Keymap<u32>,
    timings: Text,
    /// Whether a deferred update of the timing line is queued, so a burst of replies redraws it once.
    timings_queued: std::cell::Cell<bool>,
    theme: Theme,
}

impl Host {
    /// Starts the plugins and adds the panel row, the status bar and a timing line to the app's root. Replies arrive
    /// through the app's proxy and are applied on the UI thread.
    pub fn mount(app: &App, sources: Vec<(String, String)>) -> Host {
        let theme = app.theme();
        let panels = View::new(app).row().gap(1).grow(1.0);
        let bar = View::new(app).row().gap(2).height(1);
        let timings = Text::new(app, "").fg(theme.muted);
        app.root().add(&panels).add(&bar).add(&timings);
        let plugins = sources
            .into_iter()
            .enumerate()
            .map(|(index, (id, source))| {
                let proxy = app.proxy();
                let body = Text::new(app, "");
                let panel = View::new(app).border(BorderStyle::Rounded).title(format!(" {id} ")).grow(1.0).child(&body);
                let status = Text::new(app, format!("{id}…")).fg(theme.muted);
                panels.add(&panel.visible(false));
                bar.add(&status);
                let worker = Worker::spawn(index, source, move |reply| {
                    let _ = proxy.send(reply);
                });
                Plugin {
                    id,
                    worker,
                    status,
                    panel,
                    body,
                    drawn: Default::default(),
                    commands: Vec::new(),
                    layer: Disposer::noop(),
                    elapsed: Duration::ZERO,
                }
            })
            .collect();
        let host = Host(Rc::new(Inner {
            plugins: RefCell::new(plugins),
            keymap: Keymap::new(),
            timings,
            timings_queued: Default::default(),
            theme,
        }));
        app.on_message({
            let host = host.clone();
            move |cx, reply: &Reply| {
                host.apply(reply);
                if !host.0.timings_queued.replace(true) {
                    let host = host.clone();
                    cx.app().defer(move |_| host.draw_timings());
                }
            }
        });
        host
    }

    pub fn keymap(&self) -> &Keymap<u32> {
        &self.0.keymap
    }

    /// Sends an event to every plugin. Ticks are dropped for a plugin that is still busy.
    pub fn dispatch(&self, event: Json) {
        let droppable = event["type"] == "tick";
        self.0.plugins.borrow().iter().for_each(|p| {
            p.worker.send(event.clone(), droppable);
        });
    }

    /// Passes a key to the keymap first, then, if no command took it, to every plugin as `{ type: "key", key }`.
    pub fn key(&self, key: &KeyEvent) -> bool {
        if self.0.keymap.handle_key(key).handled {
            return true;
        }
        self.dispatch(json!({ "type": "key", "key": Stroke::from_event(key).to_string() }));
        false
    }

    /// Gives each plugin new source by id; plugins keep their state.
    pub fn reload(&self, sources: &[(String, String)]) {
        for plugin in self.0.plugins.borrow().iter() {
            if let Some((_, source)) = sources.iter().find(|(id, _)| *id == plugin.id) {
                plugin.worker.reload(source.clone());
            }
        }
    }

    /// Events queued or running across all plugins; 0 once every reply was handed to the app's proxy.
    pub fn pending(&self) -> usize {
        self.0.plugins.borrow().iter().map(|p| p.worker.pending.load(Ordering::Relaxed)).sum()
    }

    /// The slots each plugin last drew, by id, for tests.
    pub fn slots(&self) -> Vec<(String, serde_json::Map<String, Json>)> {
        self.0.plugins.borrow().iter().map(|p| (p.id.clone(), p.drawn.clone())).collect()
    }

    fn apply(&self, reply: &Reply) {
        let mut plugins = self.0.plugins.borrow_mut();
        let Some(plugin) = plugins.get_mut(reply.plugin) else { return };
        plugin.elapsed = reply.elapsed;
        reply.logs.iter().for_each(|line| opentui::console::info(format!("[{}] {line}", plugin.id)));
        match &reply.result {
            Ok(update) => {
                for (slot, value) in update.slots.iter().flatten() {
                    if plugin.drawn.get(slot) != Some(value) {
                        draw(plugin, slot, value, &self.0.theme);
                        plugin.drawn.insert(slot.clone(), value.clone());
                    }
                }
                if let Some(commands) = update.commands.as_ref().filter(|c| **c != plugin.commands) {
                    plugin.layer = register(&self.0.keymap, Rc::downgrade(&self.0), reply.plugin, commands);
                    plugin.commands = commands.clone();
                }
            }
            Err(error) => {
                let text = format!("{} ⚠ {}", plugin.id, error.lines().next().unwrap_or(""));
                plugin.status.set_text(text).fg(self.0.theme.error);
                plugin.drawn.remove("status");
                opentui::console::error(format!("[{}] {error}", plugin.id));
            }
        }
    }

    fn draw_timings(&self) {
        self.0.timings_queued.set(false);
        let plugins = self.0.plugins.borrow();
        let timings: Vec<_> =
            plugins.iter().map(|p| format!("{} {:.2}ms", p.id, p.elapsed.as_secs_f64() * 1e3)).collect();
        self.0.timings.set_text(format!(" last event: {}", timings.join(" · ")));
    }
}

/// Draws one slot: `status` is text (or `{ text }`), `panel` is `{ title, lines }`; null hides the panel.
fn draw(plugin: &Plugin, slot: &str, value: &Json, theme: &Theme) {
    match slot {
        "status" => {
            let text = value.as_str().or_else(|| value["text"].as_str()).unwrap_or_default();
            plugin.status.set_text(format!("{} {text}", plugin.id)).fg(theme.foreground);
        }
        "panel" if value.is_null() => {
            plugin.panel.visible(false);
        }
        "panel" => {
            let title = value["title"].as_str().unwrap_or(&plugin.id);
            let lines: Vec<_> = value["lines"].as_array().into_iter().flatten().filter_map(Json::as_str).collect();
            plugin.panel.title(format!(" {title} ")).visible(true);
            plugin.body.set_text(lines.join("\n"));
        }
        _ => {}
    }
}

/// One keymap layer for a plugin's commands; each command queues `{ type: "command", name }` for that plugin. The
/// layer reaches the plugin through a weak handle: the keymap lives in the host, and a queue sender kept here would
/// keep the worker's channel open past the worker, so dropping the worker would wait forever.
fn register(keymap: &Keymap<u32>, host: std::rc::Weak<Inner>, plugin: usize, commands: &[CommandSpec]) -> Disposer {
    let layer = commands.iter().fold(Layer::new(), |layer, spec| {
        let (host, name) = (host.clone(), spec.name.clone());
        let run = Command::new(spec.name.clone(), move |_| {
            let event = json!({ "type": "command", "name": name });
            host.upgrade().is_some_and(|h| h.plugins.borrow().get(plugin).is_some_and(|p| p.worker.send(event, false)))
        })
        .title(spec.title.clone());
        let layer = layer.command(run);
        match &spec.key {
            Some(key) => layer.binding(Binding::new(key.as_str()).cmd(spec.name.clone())),
            None => layer,
        }
    });
    keymap.register_layer(layer)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_step_returns_state_and_changes_and_a_failed_step_keeps_the_state() {
        let rt = runtime();
        let source = r#"
            if (event.type === "boom") throw new Error("boom")
            if (event.type === "keep") return { slots: { status: "kept" } }
            if (event.type === "bad") return 42
            return { state: { n: (state?.n ?? 0) + 1 }, commands: [{ name: "x.y", key: "x" }] }
        "#;
        let s = step(&rt, source, &Json::Null, &json!({ "type": "init" }));
        assert_eq!(s.state, json!({ "n": 1 }));
        let spec = CommandSpec { name: "x.y".into(), title: "x.y".into(), key: Some("x".into()) };
        assert_eq!(s.result, Ok(Update { slots: None, commands: Some(vec![spec]) }));
        let kept = step(&rt, source, &s.state, &json!({ "type": "keep" }));
        assert_eq!(
            (kept.state, kept.result.unwrap().slots.unwrap()["status"].clone()),
            (json!({ "n": 1 }), json!("kept"))
        );
        for event in ["boom", "bad"] {
            let failed = step(&rt, source, &s.state, &json!({ "type": event }));
            assert_eq!(failed.state, json!({ "n": 1 }));
            assert!(failed.result.is_err(), "{event}");
        }
    }

    #[test]
    fn a_loop_ends_at_the_event_timeout() {
        let started = Instant::now();
        let s = step(&runtime(), "while (true) {}", &json!({ "n": 1 }), &json!({ "type": "tick" }));
        assert!(s.result.unwrap_err().contains("TimeoutExceeded"));
        assert_eq!(s.state, json!({ "n": 1 }));
        assert!(started.elapsed() < Duration::from_millis(EVENT_TIMEOUT_MS * 3));
    }

    #[test]
    fn dropping_a_worker_ends_its_thread() {
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = Worker::spawn(0, "return { state: 1 }".into(), move |reply| {
            let _ = tx.send(reply.result.is_ok());
        });
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)), Ok(true));
        drop(worker);
        assert!(rx.recv_timeout(Duration::from_secs(5)).is_err(), "the deliver closure was dropped with the thread");
    }
}
