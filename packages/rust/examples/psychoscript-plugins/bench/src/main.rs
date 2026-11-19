//! Benchmarks PsychoScript as the plugin engine of an OpenTUI Rust app. Prints one Markdown table per section:
//! A per-event latency (reducer model), B fan-out to 10/50 plugins, C startup and compile scaling, D memory,
//! E the long-lived model, F failure containment. Usage: psychoscript-plugins-bench [--quick]

use std::alloc::{GlobalAlloc, Layout, System};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicUsize, Ordering::Relaxed};
use std::sync::{Arc, Mutex, mpsc};
use std::task::{Poll, Waker};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use psychoscript::{
    Compiled, Data, HostFunction, HostValue, Interrupted, Json, Limits, ProgramOptions, RunOutcome, Runtime, Suspender,
};
use serde_json::json;

// ---- A counting allocator: current and peak live bytes, total bytes and allocations. ----

struct Counting;
static CURRENT: AtomicIsize = AtomicIsize::new(0);
static PEAK: AtomicIsize = AtomicIsize::new(0);
static TOTAL: AtomicUsize = AtomicUsize::new(0);
static ALLOCS: AtomicUsize = AtomicUsize::new(0);
/// Off while timing threaded sections, so the shared counters don't add contention; deltas are only read while on.
static COUNTING: AtomicBool = AtomicBool::new(true);

fn grow(n: usize) {
    if !COUNTING.load(Relaxed) {
        return;
    }
    let now = CURRENT.fetch_add(n as isize, Relaxed) + n as isize;
    PEAK.fetch_max(now, Relaxed);
    TOTAL.fetch_add(n, Relaxed);
    ALLOCS.fetch_add(1, Relaxed);
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            grow(l.size())
        }
        p
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(l) };
        if !p.is_null() {
            grow(l.size())
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        if COUNTING.load(Relaxed) {
            CURRENT.fetch_sub(l.size() as isize, Relaxed);
        }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, size: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, size) };
        if !q.is_null() && COUNTING.load(Relaxed) {
            CURRENT.fetch_sub(l.size() as isize, Relaxed);
            grow(size)
        }
        q
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

fn current() -> isize {
    CURRENT.load(Relaxed)
}

/// Starts a peak measurement: the peak becomes the current live bytes, which it returns.
fn reset_peak() -> isize {
    let now = current();
    PEAK.store(now, Relaxed);
    now
}

fn rss_kb() -> Option<u64> {
    let out =
        std::process::Command::new("ps").args(["-o", "rss=", "-p", &std::process::id().to_string()]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).trim().parse().ok()
}

// ---- Timing. ----

#[derive(Clone, Copy)]
struct Stats {
    min: f64,
    median: f64,
    mean: f64,
    p99: f64,
}

fn stats(mut v: Vec<f64>) -> Stats {
    v.sort_by(f64::total_cmp);
    let at = |q: f64| v[((v.len() as f64 * q) as usize).min(v.len() - 1)];
    Stats { min: v[0], median: at(0.5), mean: v.iter().sum::<f64>() / v.len() as f64, p99: at(0.99) }
}

fn us(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1e6
}

/// `warm` untimed calls, then `runs` timed ones, in µs.
fn bench(warm: usize, runs: usize, mut f: impl FnMut()) -> Stats {
    (0..warm).for_each(|_| f());
    stats(
        (0..runs)
            .map(|_| {
                let t = Instant::now();
                f();
                us(t)
            })
            .collect(),
    )
}

fn table(title: &str, head: &[&str], rows: Vec<Vec<String>>) {
    println!("\n### {title}\n");
    println!("| {} |", head.join(" | "));
    // The first column and text columns align left; numbers align right.
    let text = ["outcome", "status", "result", "how", "dispatch"];
    let align = |i: usize| if i == 0 || text.iter().any(|w| head[i].contains(w)) { "---|" } else { "---:|" };
    println!("|{}", (0..head.len()).map(align).collect::<String>());
    rows.iter().for_each(|r| println!("| {} |", r.join(" | ")));
}

fn f1(x: f64) -> String {
    format!("{x:.1}")
}

fn kib(bytes: isize) -> String {
    format!("{:.1}", bytes as f64 / 1024.0)
}

// ---- The host: one `app` global. ----

const GIT: &str = include_str!("../plugins/git-status.js");
const PALETTE: &str = include_str!("../plugins/palette.js");
const LIST: &str = include_str!("../plugins/list-filter.js");
const NOOP: &str = include_str!("../plugins/noop.js");
const LIVE: &str = include_str!("../plugins/long-lived.js");

fn path(i: usize) -> String {
    format!("src/module_{:02}/file_{i:04}.rs", i % 40)
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1e3)
}

fn app() -> HostValue {
    HostValue::object([
        ("now", HostFunction::new(|_, _| HostValue::Number(now_ms())).into()),
        (
            "git",
            HostValue::object([(
                "status",
                HostFunction::new_async(|_, _| async move {
                    Ok(HostValue::from_json(&json!({ "branch": "main", "dirty": true, "ahead": 2 })))
                })
                .into(),
            )]),
        ),
        (
            "items",
            // Paths made once, so an event pays for the crossing and not for `format!`.
            HostFunction::new(|args, _| {
                static ITEMS: std::sync::OnceLock<Vec<HostValue>> = std::sync::OnceLock::new();
                let items = ITEMS.get_or_init(|| (0..10_000).map(|i| HostValue::from(path(i))).collect());
                let n = args.first().and_then(HostValue::as_f64).unwrap_or(0.0) as usize;
                HostValue::array(items[..n.min(items.len())].iter().cloned())
            })
            .into(),
        ),
    ])
}

fn runtime(timeout_ms: u64) -> Runtime {
    Runtime::make()
        .globals(|_| [("app", app())])
        .limits(Limits { timeout_ms: Some(timeout_ms), max_output_bytes: None })
}

// ---- The reducer model: each event runs the source once with `event`, `state` (and `items`) bound. ----

fn data(j: Json) -> Data {
    Data::from(j)
}

fn key(k: &str) -> Data {
    data(json!({ "type": "key", "key": k }))
}

fn keys(ks: &[&str]) -> Vec<Data> {
    ks.iter().map(|k| key(k)).collect()
}

fn items_json(n: usize) -> Json {
    Json::Array((0..n).map(|i| Json::String(path(i))).collect())
}

#[derive(Clone)]
struct Plugin {
    name: &'static str,
    code: String,
    /// The code compiled once, as the host does when it loads a plugin; every event runs it. `None` when it doesn't
    /// compile (section F runs those from source).
    compiled: Option<Compiled>,
    state: Data,
    /// The `items` binding: `null` unless the host keeps the items (list-filter c).
    items: Data,
}

struct Case {
    plugin: Plugin,
    events: Vec<Data>,
}

fn options(p: &Plugin, event: &Data) -> ProgramOptions {
    ProgramOptions::new().bindings([("event", event.clone()), ("state", p.state.clone()), ("items", p.items.clone())])
}

fn take(value: &mut Data, name: &str) -> Option<Data> {
    match value {
        Data::Object(fields) => {
            fields.iter_mut().find(|(k, _)| k == name).map(|(_, v)| std::mem::replace(v, Data::Null))
        }
        _ => None,
    }
}

fn status(value: &Data) -> String {
    match value.get("slots").and_then(|s| s.get("status")) {
        Some(Data::String(s)) => s.to_string_lossy().into_owned(),
        _ => String::new(),
    }
}

/// Keeps the returned state; returns the rest of the result.
fn keep(p: &mut Plugin, outcome: psychoscript::Outcome) -> Data {
    let mut value = outcome.result.unwrap_or_else(|d| panic!("{}: {}: {}", p.name, d.kind, d.message_lossy()));
    if let Some(state) = take(&mut value, "state") {
        p.state = state
    }
    value
}

fn step(rt: &Runtime, p: &mut Plugin, event: &Data) -> Data {
    let compiled = p.compiled.as_ref().unwrap_or_else(|| panic!("{} compiles", p.name));
    let outcome = rt.execute_with(compiled, &options(p, event));
    keep(p, outcome)
}

fn init(rt: &Runtime, mut p: Plugin) -> Plugin {
    let value = step(rt, &mut p, &data(json!({ "type": "init" })));
    if matches!(p.name, n if n.starts_with("git") || n.starts_with("palette")) {
        assert!(value.get("commands").is_some(), "{} declares commands on init", p.name);
    }
    p
}

fn plugin(name: &'static str, code: &str) -> Plugin {
    let compiled = Runtime::make().compile(code).ok();
    Plugin { name, code: code.into(), compiled, state: Data::Null, items: Data::Null }
}

fn cases() -> Vec<Case> {
    let filter_keys = keys(&["1", "7", "/", "escape"]);
    let tick = |i: usize| data(json!({ "type": "tick", "now": i }));
    vec![
        Case { plugin: plugin("git-status: tick", GIT), events: (0..4).map(tick).collect() },
        Case {
            plugin: plugin("git-status: command git.refresh (async host call)", GIT),
            events: vec![data(json!({ "type": "command", "name": "git.refresh" }))],
        },
        Case {
            plugin: plugin("palette: key (200 commands, top 10)", PALETTE),
            events: keys(&["g", "i", "t", "escape"]),
        },
        Case { plugin: plugin("list-filter (a): app.items(1000) per event", LIST), events: filter_keys.clone() },
        Case {
            plugin: Plugin {
                state: data(json!({ "query": "", "items": items_json(1000) })),
                ..plugin("list-filter (b): items in state, in and out", LIST)
            },
            events: filter_keys.clone(),
        },
        Case {
            plugin: Plugin {
                items: data(items_json(1000)),
                ..plugin("list-filter (c): items as a host binding", LIST)
            },
            events: filter_keys,
        },
        Case { plugin: plugin("noop: return { state }", NOOP), events: (0..4).map(tick).collect() },
    ]
}

// ---- A. Per-event latency. ----

fn section_a(warm: usize, runs: usize) {
    let rt = runtime(100);
    let mut rows = Vec::new();
    let mut split = Vec::new();
    for case in cases() {
        let mut p = init(&rt, case.plugin);
        let n = case.events.len();
        let mut i = 0;
        let mut last = Data::Null;
        let s = bench(warm, runs, || {
            last = step(&rt, &mut p, &case.events[i % n]);
            i += 1;
        });
        // The same events from the source, compiled again for each, as before `Runtime::compile`.
        let mut q = Plugin { state: p.state.clone(), ..plugin(p.name, &p.code) };
        q.items = p.items.clone();
        let mut j = 0;
        let from_source = bench(warm, runs, || {
            let outcome = rt.execute_with(&q.code, &options(&q, &case.events[j % n]));
            keep(&mut q, outcome);
            j += 1;
        });
        rows.push(vec![
            p.name.into(),
            p.code.len().to_string(),
            f1(s.min),
            f1(s.median),
            f1(s.mean),
            f1(s.p99),
            f1(from_source.median),
            format!("`{}`", status(&last)),
        ]);
        // The same events, timing `program()` (compile + globals) and `run()` apart.
        let (mut compile, mut run) = (Vec::new(), Vec::new());
        for j in 0..warm + runs {
            let opts = options(&p, &case.events[j % n]);
            let t = Instant::now();
            let program = rt.program(p.compiled.as_ref().expect("compiles"), &opts);
            let c = us(t);
            let t = Instant::now();
            let outcome = program.run().expect("not interrupted");
            let r = us(t);
            keep(&mut p, outcome);
            if j >= warm {
                compile.push(c);
                run.push(r);
            }
        }
        let (c, r) = (stats(compile), stats(run));
        split.push(vec![
            p.name.into(),
            f1(c.median),
            f1(c.p99),
            f1(r.median),
            f1(r.p99),
            format!("{:.0}%", 100.0 * c.median / (c.median + r.median)),
        ]);
    }
    table(
        &format!("A. Per-event latency, reducer model (µs; {warm} warm-up, {runs} timed events, one thread)"),
        &["plugin / path", "source bytes", "min", "median", "mean", "p99", "median from source", "last status slot"],
        rows,
    );
    table(
        "A2. Setup (`Runtime::program` from the compiled program) vs run (`Program::run`), µs",
        &["plugin / path", "program() median", "program() p99", "run() median", "run() p99", "setup share"],
        split,
    );
}

// ---- B. Fan-out. ----

fn mix(rt: &Runtime, n: usize) -> Vec<Plugin> {
    let kinds = [("git-status", GIT), ("palette", PALETTE), ("list-filter-a", LIST), ("noop", NOOP)];
    (0..n).map(|i| init(rt, plugin(kinds[i % 4].0, kinds[i % 4].1))).collect()
}

fn fanout_sequential(n: usize, events: &[Data], warm: usize, runs: usize) -> Stats {
    let rt = runtime(100);
    let mut plugins = mix(&rt, n);
    let mut i = 0;
    bench(warm, runs, || {
        let e = &events[i % events.len()];
        i += 1;
        plugins.iter_mut().for_each(|p| {
            step(&rt, p, e);
        });
    })
}

/// One worker thread per plugin, each with its own `Runtime`, fed by an mpsc channel; replies on a shared channel.
fn fanout_parallel(n: usize, events: &[Data], warm: usize, runs: usize) -> Stats {
    let (reply_tx, reply_rx) = mpsc::channel::<()>();
    let workers: Vec<(mpsc::Sender<Data>, JoinHandle<()>)> = mix(&runtime(100), n)
        .into_iter()
        .map(|mut p| {
            let (tx, rx) = mpsc::channel::<Data>();
            let reply = reply_tx.clone();
            let handle = std::thread::spawn(move || {
                let rt = runtime(100);
                for e in rx {
                    step(&rt, &mut p, &e);
                    let _ = reply.send(());
                }
            });
            (tx, handle)
        })
        .collect();
    let mut i = 0;
    let s = bench(warm, runs, || {
        let e = &events[i % events.len()];
        i += 1;
        workers.iter().for_each(|(tx, _)| tx.send(e.clone()).expect("worker alive"));
        (0..n).for_each(|_| reply_rx.recv().expect("reply"));
    });
    for (tx, handle) in workers {
        drop(tx);
        handle.join().expect("worker exits");
    }
    s
}

fn section_b(warm: usize, runs: usize) {
    let events = keys(&["1", "7", "escape"]);
    let mut rows = Vec::new();
    for n in [1, 10, 50] {
        for (mode, s) in [
            ("sequential, one thread", fanout_sequential(n, &events, warm, runs)),
            ("parallel, thread + Runtime per plugin", fanout_parallel(n, &events, warm, runs)),
        ] {
            rows.push(vec![n.to_string(), mode.into(), f1(s.min), f1(s.median), f1(s.mean), f1(s.p99)]);
        }
    }
    table(
        &format!(
            "B. Fan-out: one key event to N plugins (git-status, palette, list-filter a, noop cycled), µs until all replied ({warm} warm-up, {runs} timed)"
        ),
        &["# plugins", "dispatch", "min", "median", "mean", "p99"],
        rows,
    );
}

// ---- C. Startup and compile scaling. ----

fn synthetic(bytes: usize) -> String {
    let mut s = String::from("// Synthetic large plugin: many handlers defined at top level.\nconst handlers = {}\n");
    let mut i = 0;
    while s.len() < bytes {
        s += &format!(
            "handlers.h{i} = function (e, st) {{\n  const n = (st?.n ?? 0) + {i}\n  if (e.type === \"key\" && e.key === \"k{i}\") {{\n    return {{ status: \"handler {i}: \" + n, lines: [\"a{i}\", \"b{i}\"].map((x) => x.toUpperCase()) }}\n  }}\n  return null\n}}\n"
        );
        i += 1;
    }
    s + "const h = handlers.h0(event, state)\nreturn { state, slots: { status: h ? h.status : \"idle\" } }\n"
}

fn section_c(cold_runtime: f64, cold_first: f64, runs: usize) {
    let make = bench(100, runs, || drop(runtime(100)));
    let event = key("k0");
    let mut rows = vec![vec![
        "process-cold: first `execute_with` in the process (git-status init)".into(),
        GIT.len().to_string(),
        f1(cold_first),
        "".into(),
        "".into(),
        "".into(),
        "".into(),
        "".into(),
    ]];
    let sources: Vec<(String, String)> =
        [("git-status", GIT), ("palette", PALETTE), ("list-filter", LIST), ("noop", NOOP)]
            .into_iter()
            .map(|(n, c)| (n.to_string(), c.to_string()))
            .chain([1, 10, 30, 100].map(|k| (format!("synthetic {k} KB"), synthetic(k * 1024))))
            .collect();
    for (name, code) in &sources {
        let p = Plugin { state: data(json!({ "query": "", "n": 1 })), ..plugin("c", code) };
        let opts = options(&p, &event);
        let rt = runtime(1000);
        let t = Instant::now();
        let first = rt.execute_with(code, &opts);
        let first = (us(t), first.result.is_ok());
        assert!(first.1, "{name} runs");
        let compile = bench(20, runs, || drop(rt.program(code, &opts)));
        let compiled = rt.compile(code).expect("compiles");
        let compiling = bench(20, runs, || drop(rt.compile(code)));
        let from_compiled = bench(20, runs, || drop(rt.execute_with(&compiled, &opts)));
        let (mut run, mut total) = (Vec::new(), Vec::new());
        for _ in 0..runs {
            let t = Instant::now();
            let program = rt.program(code, &opts);
            let t2 = Instant::now();
            let _ = program.run();
            run.push(us(t2));
            total.push(us(t));
        }
        let (run, total) = (stats(run), stats(total));
        rows.push(vec![
            name.clone(),
            code.len().to_string(),
            f1(first.0),
            f1(compile.median),
            f1(run.median),
            f1(total.median),
            f1(compiling.median),
            f1(from_compiled.median),
        ]);
    }
    println!(
        "\n`Runtime::make().globals(..).limits(..)`: {:.2} µs median; process-cold construction {:.1} µs",
        make.median, cold_runtime
    );
    // Where the per-event floor goes: no globals and no bindings, then bindings, then the `app` global too.
    let bare = Runtime::make();
    let noop = Plugin { state: data(json!({ "n": 1 })), ..plugin("noop", NOOP) };
    let opts = options(&noop, &event);
    let full = runtime(100);
    let floor = [
        ("`return 1`, Runtime without globals, no bindings", bench(200, runs * 10, || drop(bare.execute("return 1")))),
        ("noop, Runtime without globals, 3 bindings", bench(200, runs * 10, || drop(bare.execute_with(NOOP, &opts)))),
        ("noop, `app` global (3 host fns), 3 bindings", bench(200, runs * 10, || drop(full.execute_with(NOOP, &opts)))),
    ];
    table(
        "C0. Per-event floor (µs)",
        &["program", "median", "p99"],
        floor.into_iter().map(|(n, s)| vec![n.into(), f1(s.median), f1(s.p99)]).collect(),
    );
    table(
        &format!("C. Startup and compile scaling (µs; medians of {runs})"),
        &[
            "source",
            "bytes",
            "first run (fresh Runtime)",
            "program() median",
            "run() median",
            "warm event median",
            "compile() median",
            "warm event from compiled",
        ],
        rows,
    );
}

// ---- D. Memory. ----

fn section_d() {
    let mut rows = Vec::new();
    let mut alive = Vec::new();
    for case in cases() {
        let before = current();
        let rt = runtime(100);
        let mut p = init(&rt, case.plugin.clone());
        (0..8).for_each(|i| drop(step(&rt, &mut p, &case.events[i % case.events.len()])));
        let retained = current() - before;
        let state = p.state.to_json_string().len();
        let event = &case.events[0];
        drop(step(&rt, &mut p, event));
        let (total, allocs) = (TOTAL.load(Relaxed), ALLOCS.load(Relaxed));
        let base = reset_peak();
        drop(step(&rt, &mut p, event));
        let peak = PEAK.load(Relaxed) - base;
        let (total, allocs) = (TOTAL.load(Relaxed) - total, ALLOCS.load(Relaxed) - allocs);
        let delta = current() - base;
        rows.push(vec![
            p.name.into(),
            kib(retained),
            state.to_string(),
            kib(peak),
            kib(total as isize),
            allocs.to_string(),
            delta.to_string(),
        ]);
        alive.push((rt, p));
    }
    table(
        "D. Memory per reducer plugin (counting global allocator)",
        &[
            "plugin / path",
            "retained between events KiB (Runtime + source + state + items)",
            "state JSON bytes",
            "peak heap above baseline during one event KiB",
            "bytes allocated in one event KiB",
            "allocations in one event",
            "live-bytes delta after the event",
        ],
        rows,
    );
    drop(alive);
    let rss0 = rss_kb();
    let before = current();
    let rt = runtime(100);
    let fifty: Vec<(Runtime, Plugin)> = mix(&rt, 50).into_iter().map(|p| (runtime(100), p)).collect();
    println!(
        "\n50 reducer plugins (own Runtime each, mix of four): {} KiB live heap retained in total; process RSS {} → {} KiB",
        kib(current() - before),
        rss0.map_or("?".into(), |r| r.to_string()),
        rss_kb().map_or("?".into(), |r| r.to_string())
    );
    drop(fifty);
}

// ---- E. The long-lived model. ----

#[derive(Default)]
struct Inbox {
    queue: VecDeque<Json>,
    waker: Option<Waker>,
}

type Shared = Arc<Mutex<Inbox>>;

fn push(inbox: &Shared, event: Json) {
    let mut g = inbox.lock().expect("inbox");
    g.queue.push_back(event);
    if let Some(w) = g.waker.take() {
        w.wake()
    }
}

/// The next event, parking the run until the sender wakes it.
async fn next(inbox: Shared) -> Json {
    std::future::poll_fn(move |cx| {
        let mut g = inbox.lock().expect("inbox");
        match g.queue.pop_front() {
            Some(e) => Poll::Ready(e),
            None => {
                g.waker = Some(cx.waker().clone());
                Poll::Pending
            }
        }
    })
    .await
}

type Slot = (usize, String, String);

fn live_runtime(
    id: usize,
    inbox: Shared,
    slots: mpsc::Sender<Slot>,
    idempotent: bool,
    timeout: Option<u64>,
) -> Runtime {
    Runtime::make()
        .globals(move |_| {
            let inbox = inbox.clone();
            let slots = slots.clone();
            let next_event = HostFunction::new_async(move |_, _| {
                let inbox = inbox.clone();
                async move { Ok(HostValue::from_json(&next(inbox).await)) }
            });
            let set_slot = HostFunction::new(move |args, _| {
                let text = |i: usize| args.get(i).and_then(HostValue::as_str).unwrap_or("").to_string();
                let _ = slots.send((id, text(0), text(1)));
                HostValue::Undefined
            });
            [(
                "app",
                HostValue::object([
                    ("nextEvent", if idempotent { next_event.idempotent() } else { next_event }.into()),
                    ("setSlot", set_slot.into()),
                ]),
            )]
        })
        .limits(Limits { timeout_ms: timeout, max_output_bytes: None })
}

/// When the run ended, and how; `None` when the host cancelled it by dropping its future.
type Ended = (Instant, Option<Result<RunOutcome, Interrupted>>);

struct Live {
    inbox: Shared,
    cancel: Arc<AtomicBool>,
    thread: JoinHandle<Ended>,
}

impl Live {
    /// Drops the run's future on its thread at the next wake-up, which interrupts it.
    fn cancel(&self) {
        self.cancel.store(true, Relaxed);
        self.thread.thread().unpark();
    }
}

fn spawn_live(
    id: usize,
    slots: &mpsc::Sender<Slot>,
    idempotent: bool,
    timeout: Option<u64>,
    resume: Option<psychoscript::Snapshot>,
) -> (Live, Suspender) {
    spawn_code(LIVE, id, slots, idempotent, timeout, resume)
}

/// A long-lived plugin on its own thread, driven by `run_resumable_async`; `resume` continues a saved state.
fn spawn_code(
    code: &'static str,
    id: usize,
    slots: &mpsc::Sender<Slot>,
    idempotent: bool,
    timeout: Option<u64>,
    resume: Option<psychoscript::Snapshot>,
) -> (Live, Suspender) {
    let (inbox, cancel) = (Shared::default(), Arc::new(AtomicBool::new(false)));
    let (sus_tx, sus_rx) = mpsc::channel();
    let (inbox2, cancel2, slots) = (inbox.clone(), cancel.clone(), slots.clone());
    let thread = std::thread::spawn(move || {
        let rt = live_runtime(id, inbox2, slots, idempotent, timeout);
        let program = match &resume {
            Some(state) => rt.resume(state).expect("resumes"),
            None => rt.program(code, &ProgramOptions::new()),
        };
        let _ = sus_tx.send(program.suspender());
        let r = block_on(program.run_resumable_async(), &cancel2);
        (Instant::now(), r)
    });
    (Live { inbox, cancel, thread }, sus_rx.recv().expect("suspender"))
}

fn wait_for(rx: &mpsc::Receiver<Slot>, slot: &str, n: usize) -> Vec<Slot> {
    let mut got = Vec::new();
    while got.len() < n {
        let s = rx.recv_timeout(Duration::from_secs(5)).expect("slot in time");
        if s.1 == slot {
            got.push(s)
        }
    }
    got
}

fn ended(r: &Ended) -> String {
    match &r.1 {
        Some(Ok(RunOutcome::Done(o))) => match &o.result {
            Ok(v) => format!("Done: `{}`", v.to_json_string()),
            Err(d) => format!("Failed: {} `{}`", d.kind, d.message_lossy()),
        },
        Some(Ok(RunOutcome::Suspended(_))) => "Suspended".into(),
        Some(Err(e)) => format!("Interrupted: {e}"),
        None => "Cancelled: future dropped".into(),
    }
}

fn stop(lives: Vec<Live>) -> Vec<Ended> {
    lives
        .into_iter()
        .map(|l| {
            push(&l.inbox, json!({ "type": "stop" }));
            l.thread.join().expect("live thread")
        })
        .collect()
}

fn section_e(warm: usize, runs: usize, threaded: &dyn Fn(&dyn Fn())) {
    let (tx, rx) = mpsc::channel::<Slot>();
    // Latency: send an event to N parked plugins, until each has called setSlot.
    let rows = std::cell::RefCell::new(Vec::new());
    threaded(&|| {
        for n in [1, 10, 50] {
            let lives: Vec<Live> = (0..n).map(|i| spawn_live(i, &tx, false, None, None).0).collect();
            wait_for(&rx, "ready", n);
            let s = bench(warm, runs, || {
                lives.iter().for_each(|l| push(&l.inbox, json!({ "type": "key", "key": "j" })));
                wait_for(&rx, "status", n);
            });
            let ends = stop(lives);
            assert!(
                ends.iter().all(|e| matches!(&e.1, Some(Ok(RunOutcome::Done(o))) if o.result.is_ok())),
                "{}",
                ended(&ends[0])
            );
            rows.borrow_mut().push(vec![
                n.to_string(),
                f1(s.min),
                f1(s.median),
                f1(s.mean),
                f1(s.p99),
                ended(&ends[0]),
            ]);
        }
    });
    let rows = rows.into_inner();
    table(
        &format!(
            "E. Long-lived model: event → setSlot observed, µs ({warm} warm-up, {runs} timed; thread per plugin, `run_resumable_async` on a park/unpark `block_on`)"
        ),
        &["# plugins", "min", "median", "mean", "p99", "how plugin 0 ended after `stop`"],
        rows,
    );

    // Memory of parked plugins.
    let n = 50;
    let (rss0, before) = (rss_kb(), current());
    let lives: Vec<Live> = (0..n).map(|i| spawn_live(i, &tx, false, None, None).0).collect();
    wait_for(&rx, "ready", n);
    std::thread::sleep(Duration::from_millis(50));
    let (after, rss1) = (current(), rss_kb());
    stop(lives);
    println!(
        "\n{n} long-lived plugins parked in `app.nextEvent()`: {} KiB live heap each ({} KiB total, thread stacks not included); process RSS {} → {} KiB",
        kib((after - before) / n as isize),
        kib(after - before),
        rss0.map_or("?".into(), |r| r.to_string()),
        rss1.map_or("?".into(), |r| r.to_string())
    );

    // Does timeout_ms fire while idle, or while steadily busy?
    let mut rows = Vec::new();
    for (case, busy) in [("idle 500 ms", false), ("an event every 20 ms for 500 ms", true)] {
        let (live, _) = spawn_live(0, &tx, false, Some(200), None);
        let started = Instant::now();
        wait_for(&rx, "ready", 1);
        while started.elapsed() < Duration::from_millis(500) {
            if busy {
                push(&live.inbox, json!({ "type": "key", "key": "j" }))
            }
            std::thread::sleep(Duration::from_millis(if busy { 20 } else { 500 }));
        }
        let finished = live.thread.is_finished();
        let end = if finished { live.thread.join().expect("thread") } else { stop(vec![live]).remove(0) };
        rows.push(vec![
            case.into(),
            finished.to_string(),
            format!("{:.0}", end.0.duration_since(started).as_secs_f64() * 1e3),
            ended(&end),
        ]);
    }
    while rx.try_recv().is_ok() {}
    table(
        "E2. `Limits { timeout_ms: Some(200) }` on a long-lived run",
        &["case", "run ended by itself", "ended after ms", "outcome"],
        rows,
    );

    // Suspend while parked in nextEvent, with and without `.idempotent()`; resume the saved state.
    let mut rows = Vec::new();
    for idempotent in [false, true] {
        let (live, suspender) = spawn_live(0, &tx, idempotent, None, None);
        wait_for(&rx, "ready", 1);
        (0..3).for_each(|_| push(&live.inbox, json!({ "type": "key", "key": "j" })));
        wait_for(&rx, "status", 3);
        std::thread::sleep(Duration::from_millis(20));
        let t = Instant::now();
        let result = suspender.suspend(None);
        let took = us(t);
        let row = match result {
            Err(e) => {
                let end = stop(vec![live]).remove(0);
                vec![format!("refused: `{}`", e.message), f1(took), "".into(), "".into(), ended(&end)]
            }
            Ok(RunOutcome::Done(_)) => {
                vec!["ended before suspending".into(), f1(took), "".into(), "".into(), "".into()]
            }
            Ok(RunOutcome::Suspended(s)) => {
                let end = live.thread.join().expect("thread");
                let bytes = psychoscript::to_bytes(&s.state).len();
                let t = Instant::now();
                let (resumed, _) = spawn_live(0, &tx, idempotent, None, Some(s.state));
                let resumed_us = us(t);
                push(&resumed.inbox, json!({ "type": "key", "key": "k" }));
                let slot = wait_for(&rx, "status", 1).remove(0).2;
                let after = stop(vec![resumed]).remove(0);
                vec![
                    format!("suspended ({}); resumed, next event set status `{slot}`", ended(&end)),
                    f1(took),
                    bytes.to_string(),
                    f1(resumed_us),
                    ended(&after),
                ]
            }
        };
        rows.push([vec![format!("nextEvent idempotent = {idempotent}")], row].concat());
    }
    table(
        "E3. `Program::suspender().suspend(None)` while parked in `await app.nextEvent()` (after 3 events)",
        &[
            "case",
            "result",
            "suspend() µs",
            "snapshot bytes (`to_bytes`)",
            "spawn + `Runtime::resume` µs",
            "resumed run after `stop`",
        ],
        rows,
    );

    // A runaway long-lived plugin (no timeout possible, see E2): the host drops its future to stop it.
    const SPIN: &str = "app.setSlot(\"ready\", \"1\")\nwhile (true) {\n  const e = await app.nextEvent()\n  if (e.key === \"spin\") while (true) {}\n  app.setSlot(\"status\", \"ok\")\n}\n";
    let mut rows = Vec::new();
    for spin_ms in [5, 100] {
        let (live, _) = spawn_code(SPIN, 0, &tx, false, None, None);
        wait_for(&rx, "ready", 1);
        push(&live.inbox, json!({ "type": "key", "key": "spin" }));
        std::thread::sleep(Duration::from_millis(spin_ms));
        let spinning = !live.thread.is_finished();
        let t = Instant::now();
        live.cancel();
        let end = live.thread.join().expect("thread");
        rows.push(vec![
            format!("`while (true) {{}}` after an event, cancelled after {spin_ms} ms"),
            spinning.to_string(),
            f1(end.0.duration_since(t).as_secs_f64() * 1e6),
            ended(&end),
        ]);
    }
    table(
        "E4. Stopping a runaway long-lived run by dropping its `run_resumable_async` future",
        &["case", "still running before cancel", "cancel → thread done µs", "outcome"],
        rows,
    );

    // A run's heap is append-only (no GC): how fast does a long-lived plugin grow, and when does it end?
    const PALETTE_LOOP: &str = "app.setSlot(\"ready\", \"1\")\nconst COMMANDS = Array.from({ length: 200 }, (_, i) => \"Command number \" + i)\nlet n = 0\nwhile (true) {\n  const e = await app.nextEvent()\n  n++\n  const top = COMMANDS.map((name) => ({ name, score: (name.length + n) % 7 })).filter((m) => m.score > 2).sort((a, b) => b.score - a.score).slice(0, 10)\n  app.setSlot(\"status\", top.length + \" \" + n)\n}\n";
    let mut rows = Vec::new();
    for (name, code, cap) in [
        ("tick loop (long-lived.js)", LIVE, 20_000),
        ("palette-style loop: map 200 → filter → sort → top 10", PALETTE_LOOP, 50_000),
    ] {
        let (live, _) = spawn_code(code, 0, &tx, false, None, None);
        wait_for(&rx, "ready", 1);
        let (before, started) = (current(), Instant::now());
        let (mut events, mut at_1k, mut grown) = (0, 0, 0);
        while events < cap && !live.thread.is_finished() {
            push(&live.inbox, json!({ "type": "key", "key": "j" }));
            match rx.recv_timeout(Duration::from_secs(2)) {
                Ok(_) => events += 1,
                Err(_) => break,
            }
            grown = grown.max(current() - before);
            if events == 1000 {
                at_1k = current() - before;
            }
        }
        let finished = live.thread.is_finished();
        let end = if finished { live.thread.join().expect("thread") } else { stop(vec![live]).remove(0) };
        rows.push(vec![
            name.into(),
            events.to_string(),
            format!("{:.0}", at_1k as f64 / 1000.0),
            kib(grown),
            format!("{:.1}", started.elapsed().as_secs_f64()),
            if finished { ended(&end) } else { format!("still running at the cap; after `stop`: {}", ended(&end)) },
        ]);
    }
    while rx.try_recv().is_ok() {}
    table(
        "E5. Heap growth of one long-lived run (events sent back to back)",
        &[
            "loop",
            "events handled",
            "live heap growth bytes/event (first 1k)",
            "max live heap growth KiB",
            "seconds",
            "outcome",
        ],
        rows,
    );
}

/// Polls a future to its end on this thread, parking until it is woken (from psychoscript's bench); `None`, with the
/// future dropped, once `cancel` is set.
fn block_on<F: std::future::Future>(future: F, cancel: &AtomicBool) -> Option<F::Output> {
    struct Unpark(std::thread::Thread);
    impl std::task::Wake for Unpark {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = Waker::from(Arc::new(Unpark(std::thread::current())));
    let mut cx = std::task::Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        if cancel.load(Relaxed) {
            return None;
        }
        if let Poll::Ready(v) = future.as_mut().poll(&mut cx) {
            return Some(v);
        }
        std::thread::park();
    }
}

// ---- F. Failure containment. ----

fn section_f(runs: usize) {
    let rt = runtime(100);
    let event = data(json!({ "type": "tick", "now": 1 }));
    let p = |code: &str| Plugin { state: data(json!({ "n": 1 })), ..plugin("f", code) };
    let mut rows = Vec::new();
    for (name, code, n) in [
        ("`while (true) {}`", "while (true) {}", 5),
        ("`throw new Error(...)`", "throw new Error(\"boom on \" + event.type)", runs),
        ("rejected await", "await Promise.reject(new TypeError(\"nope\"))", runs),
        ("syntax error `return {`", "return {", runs),
        ("non-JSON result (a function)", "return { state, slots: { status: () => 1 } }", runs),
    ] {
        let p = p(code);
        let opts = options(&p, &event);
        let mut last = None;
        let s = bench(if n > 5 { 100 } else { 0 }, n, || last = Some(rt.execute_with(code, &opts)));
        let diag = match last.expect("ran").result {
            Ok(v) => format!("Ok `{}`", v.to_json_string()),
            Err(d) => format!("{}: `{}`", d.kind, d.message_lossy()),
        };
        rows.push(vec![name.into(), n.to_string(), f1(s.min), f1(s.median), f1(s.p99), diag]);
    }
    table(
        "F. Failure containment (`timeout_ms: Some(100)`), µs per event",
        &["plugin", "# runs", "min", "median", "p99", "outcome"],
        rows,
    );
}

fn main() {
    // Process-cold: nothing of psychoscript has run yet.
    let t = Instant::now();
    let rt = runtime(100);
    let cold_runtime = us(t);
    let t = Instant::now();
    let mut p = plugin("git-status", GIT);
    step(&rt, &mut p, &data(json!({ "type": "init" })));
    let cold_first = us(t);
    drop(rt);

    // `--floor SECONDS`: loops the smallest event for a profiler (`sample <pid>`).
    if let Some(secs) = std::env::args().skip_while(|a| a != "--floor").nth(1).and_then(|s| s.parse::<u64>().ok()) {
        println!("pid {}", std::process::id());
        let (bare, end) = (Runtime::make(), Instant::now() + Duration::from_secs(secs));
        while Instant::now() < end {
            drop(bare.execute("return 1"));
        }
        return;
    }
    let quick = std::env::args().any(|a| a == "--quick");
    let (warm, runs) = if quick { (50, 500) } else { (500, 5000) };
    println!("# PsychoScript plugin bench (pid {})", std::process::id());
    // `--sections ABCDEF` picks sections; `--count` keeps the allocator counting during B and E's timing too.
    let pick = std::env::args().skip_while(|a| a != "--sections").nth(1).unwrap_or("ABCDEF".into());
    let count = std::env::args().any(|a| a == "--count");
    let on = |c: char| pick.contains(c);
    let threaded = |f: &dyn Fn()| {
        COUNTING.store(count, Relaxed);
        f();
        COUNTING.store(true, Relaxed);
    };
    println!("\nAllocator counting during B and E1 timing: {}", if count { "on" } else { "off" });
    if on('A') {
        section_a(warm, runs)
    }
    if on('B') {
        threaded(&|| section_b(warm / 2, runs / 5))
    }
    if on('C') {
        section_c(cold_runtime, cold_first, if quick { 50 } else { 300 })
    }
    if on('D') {
        section_d()
    }
    if on('E') {
        section_e(warm, runs, &threaded)
    }
    if on('F') {
        section_f(if quick { 100 } else { 1000 })
    }
}
