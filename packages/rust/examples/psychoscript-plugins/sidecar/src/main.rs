//! Benchmarks helper processes behind PsychoScript plugins: A cold start, B warm round trips (raw client), C the full
//! path from a compiled plugin, D 50 plugins with a helper each, E failures, F streaming, G one shared helper (and an
//! in-process pack) for 50 plugins. Prints Markdown.
//! Usage: sidecar-bench [--quick] [--sections ABCDEFG]. Build first: `cargo build --release -p psychoscript-plugins-sidecar`.

mod client;
#[path = "../helpers/rust/embed.rs"]
mod embed;

use client::{Conn, Sidecar};
use psychoscript::{
    Compiled, Failure, HostError, HostFunction, HostResult, HostValue, Json, Limits, Namespace, ProgramOptions,
    Resolved, Runtime,
};
use serde_json::json;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering::Relaxed};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

const INIT_TIMEOUT: Duration = Duration::from_secs(5);
/// The prototype's per-event budget (`EVENT_TIMEOUT_MS` in `src/lib.rs`).
const EVENT_TIMEOUT_MS: u64 = 250;
/// What the bench's own raw-client requests carry as their caller.
const RAW: &str = "raw-client";

// ---- A counting allocator, on only while measuring the host's heap (G4). ----

struct Counting;
static LIVE: AtomicIsize = AtomicIsize::new(0);
static COUNTING: AtomicBool = AtomicBool::new(false);

fn count(delta: isize) {
    if COUNTING.load(Relaxed) {
        LIVE.fetch_add(delta, Relaxed);
    }
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            count(l.size() as isize)
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        count(-(l.size() as isize))
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, size: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, size) };
        if !q.is_null() {
            count(size as isize - l.size() as isize)
        }
        q
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// The live heap `make` leaves allocated, in bytes, and what it made.
fn heap<T>(make: impl FnOnce() -> T) -> (isize, T) {
    let before = LIVE.load(Relaxed);
    COUNTING.store(true, Relaxed);
    let made = make();
    COUNTING.store(false, Relaxed);
    (LIVE.load(Relaxed) - before, made)
}

// ---- Timing and tables. ----

#[derive(Clone, Copy)]
struct Stats {
    min: f64,
    median: f64,
    p99: f64,
    max: f64,
}

fn stats(mut v: Vec<f64>) -> Stats {
    v.sort_by(f64::total_cmp);
    let at = |q: f64| v[((v.len() as f64 * q) as usize).min(v.len() - 1)];
    Stats { min: v[0], median: at(0.5), p99: at(0.99), max: v[v.len() - 1] }
}

fn us(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1e6
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1e3
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
    // Columns of numbers align right.
    let number = |i: usize| i > 0 && rows.iter().all(|r| r[i].split(" / ").all(|x| x.parse::<f64>().is_ok()));
    let align = |i: usize| if number(i) { "---:|" } else { "---|" };
    println!("|{}", (0..head.len()).map(align).collect::<String>());
    rows.iter().for_each(|r| println!("| {} |", r.join(" | ")));
}

fn f1(x: f64) -> String {
    format!("{x:.1}")
}

fn f2(x: f64) -> String {
    format!("{x:.2}")
}

/// One column per number: median, p99, min.
fn mpm(s: &Stats, f: fn(f64) -> String) -> [String; 3] {
    [f(s.median), f(s.p99), f(s.min)]
}

fn row(head: &[&str], s: &Stats, f: fn(f64) -> String) -> Vec<String> {
    [head.iter().map(|h| h.to_string()).collect::<Vec<_>>(), mpm(s, f).into()].concat()
}

// ---- Helpers and processes. ----

struct Helper {
    name: &'static str,
    cmd: Vec<String>,
}

/// The Rust helper next to this binary, the Bun helper from source, and a `bun build --compile` of it when built
/// (`bun build --compile sidecar/helpers/bun/helper.ts --outfile target/release/helper-bun`).
fn helpers() -> Vec<Helper> {
    let exe = std::env::current_exe().expect("own path");
    let dir = exe.parent().expect("a directory");
    let rust = dir.join("helper-rust");
    assert!(rust.exists(), "build helper-rust first: cargo build --release -p psychoscript-plugins-sidecar");
    let path = |p: &std::path::Path| p.display().to_string();
    let ts = concat!(env!("CARGO_MANIFEST_DIR"), "/helpers/bun/helper.ts");
    let mut list = vec![
        Helper { name: "Rust", cmd: vec![path(&rust)] },
        Helper { name: "Bun", cmd: vec!["bun".into(), ts.into()] },
    ];
    let compiled = dir.join("helper-bun");
    if compiled.exists() {
        list.push(Helper { name: "Bun (compiled)", cmd: vec![path(&compiled)] })
    }
    list
}

fn ps(field: &str, pids: &[u32]) -> Vec<String> {
    let list = pids.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let out = std::process::Command::new("ps").args(["-o", &format!("{field}="), "-p", &list]).output().expect("ps");
    String::from_utf8_lossy(&out.stdout).lines().map(|l| l.trim().to_string()).collect()
}

fn rss_kb(pids: &[u32]) -> Vec<f64> {
    ps("rss", pids).iter().filter_map(|l| l.parse().ok()).collect()
}

/// CPU time in seconds, summed over the processes (`ps -o time=`: `[H:]M:SS.ss`, 10 ms resolution).
fn cpu_s(pids: &[u32]) -> f64 {
    let seconds = |l: &String| l.split(':').fold(0.0, |acc, part| acc * 60.0 + part.parse::<f64>().unwrap_or(0.0));
    ps("time", pids).iter().map(seconds).sum()
}

fn me() -> u32 {
    std::process::id()
}

fn small() -> Json {
    json!({ "text": "x".repeat(88) })
}

fn bytes(j: &Json) -> usize {
    j.to_string().len()
}

// ---- The bridge: each interface a plugin declares is a top-level namespace global. ----

/// The `bench` interface: its methods, each a JSON-RPC method of the helper behind it.
const BENCH: &str = "bench";
const METHODS: [&str; 4] = ["echo", "embed", "sleep", "crash"];

/// What serves an interface: a helper process (a plugin's own, or one shared by many), or an in-process pack whose
/// shared state is one `Arc`.
#[derive(Clone)]
enum Backing {
    Helper(Arc<Sidecar>),
    Pack(Arc<Pack>),
}

/// The in-process pack: `echo` in Rust, synchronous, with a call count as its shared state.
#[derive(Default)]
struct Pack {
    calls: AtomicU64,
}

/// A cheap check before anything is sent: params are an object, and `echo` has a string `text`.
fn check(method: &str, params: &Json) -> Result<(), String> {
    let Some(fields) = params.as_object() else { return Err(format!("params must be an object, not {params}")) };
    if method == "echo" && !fields.get("text").is_some_and(Json::is_string) {
        return Err("echo needs a string `text`".into());
    }
    Ok(())
}

/// One method of an interface for one plugin. A helper's gives a promise for the JSON-RPC call, which carries the
/// plugin as its caller and `opts.timeoutMs` as its timeout; bad params, a crash, a timeout or an error answer reject
/// it. A run that ends first (its own timeout) drops the call's future, which cancels the call.
fn function(interface: &'static str, method: &'static str, backing: &Backing, plugin: &Arc<str>) -> HostFunction {
    let fail = move |kind: &str, why: String| HostError::named(kind, format!("{interface}.{method}: {why}"));
    match backing.clone() {
        Backing::Helper(sidecar) => {
            let plugin = plugin.clone();
            HostFunction::new_async(move |args, _| {
                let params = args.first().and_then(HostValue::to_json).unwrap_or(Json::Null);
                let timeout =
                    args.get(1).and_then(|o| o.get("timeoutMs")?.as_f64()).map(|t| Duration::from_millis(t as u64));
                let started = check(method, &params).map_err(|why| fail("TypeError", why)).and_then(|()| {
                    sidecar.start(method, &params, &plugin, timeout, None).map_err(|why| fail("Error", why))
                });
                async move {
                    match started?.await {
                        Ok(result) => Ok(HostValue::from_json(&result)),
                        Err(why) => Err(fail("Error", why).into()),
                    }
                }
            })
        }
        Backing::Pack(pack) => HostFunction::new(move |args, _| -> HostResult {
            let params = args.into_iter().next().unwrap_or(HostValue::Undefined);
            check(method, &params.to_json().unwrap_or(Json::Null)).map_err(|why| fail("TypeError", why))?;
            pack.calls.fetch_add(1, Relaxed);
            match method {
                "echo" => Ok(params),
                _ => Err(fail("Error", "not in the pack".into()).into()),
            }
        }),
    }
}

/// An interface as a lazy namespace for one plugin: `<interface>.<method>(params, opts?)`. Its functions are made
/// once, here, and carry the plugin's id.
fn namespace(interface: &'static str, backing: &Backing, plugin: &Arc<str>) -> HostValue {
    let functions: Arc<[(&str, HostFunction)]> = METHODS.map(|m| (m, function(interface, m, backing, plugin))).into();
    HostValue::from(Namespace::new(
        |path| Ok(if path.is_empty() { METHODS.map(Into::into).to_vec() } else { Vec::new() }),
        move |path| -> Resolved {
            let found = match path {
                [name] => functions.iter().find(|(m, _)| name == *m),
                _ => None,
            };
            match found {
                Some((_, f)) => f.clone().into(),
                None => {
                    let path = path.iter().map(|k| k.to_string()).collect::<Vec<_>>().join(".");
                    Failure::missing(format!("No function at {interface}.{path}.")).into()
                }
            }
        },
    ))
}

/// A plugin's runtime: its globals are the namespaces of the interfaces it declares, and only those. The closure
/// captures the plugin's namespaces, made once with its id.
fn runtime(plugin: &str, declared: &[(&'static str, Backing)]) -> Runtime {
    let plugin: Arc<str> = plugin.into();
    let globals: Vec<(&str, HostValue)> =
        declared.iter().map(|(name, b)| (*name, namespace(name, b, &plugin))).collect();
    Runtime::make()
        .globals(move |_run| globals.clone())
        .limits(Limits { timeout_ms: Some(EVENT_TIMEOUT_MS), max_output_bytes: Some(64 << 10) })
}

fn bench_runtime(plugin: &str, backing: Backing) -> Runtime {
    runtime(plugin, &[(BENCH, backing)])
}

const CALL: &str = r#"const r = await bench.echo({ text: event.text })
return { state, slots: { status: r.text } }"#;
const BASELINE: &str = "return { state, slots: { status: event.text } }";
/// Bad params: rejected by the check, caught by the plugin; the helper is never contacted.
const REJECTED: &str = r#"try {
  await bench.echo({ text: 42 })
  return { state, slots: { status: "sent" } }
} catch (e) {
  return { state, slots: { status: e.message } }
}"#;

/// Runs one event of a compiled plugin: its status slot, or the run's diagnostic.
fn step(rt: &Runtime, program: &Compiled, event: &Json) -> Result<String, String> {
    let bindings = [("event".to_string(), event.clone()), ("state".to_string(), json!({ "n": 1 }))];
    let outcome = rt.execute_with(program, &ProgramOptions::new().bindings(bindings));
    match outcome.json() {
        Ok(value) => Ok(value["slots"]["status"].as_str().unwrap_or("").to_string()),
        Err(d) => Err(format!("{}: {}", d.kind.name(), d.message_lossy())),
    }
}

fn event() -> Json {
    json!({ "type": "key", "text": "x".repeat(88) })
}

/// Plugins on a thread each, as the prototype runs them: each makes its runtime and compiles its program on its
/// thread, then runs the events it is sent. Each reply is the event's result and its duration in µs.
struct Pool {
    workers: Vec<(mpsc::Sender<Json>, std::thread::JoinHandle<()>)>,
    replies: mpsc::Receiver<(Result<String, String>, f64)>,
}

impl Pool {
    fn new(n: usize, code: &'static str, make: impl Fn(usize) -> Runtime + Send + Sync + 'static) -> Pool {
        let make = Arc::new(make);
        let (reply_tx, replies) = mpsc::channel();
        let workers = (0..n)
            .map(|i| {
                let (tx, rx) = mpsc::channel::<Json>();
                let (make, reply) = (make.clone(), reply_tx.clone());
                let thread = std::thread::spawn(move || {
                    let rt = make(i);
                    let program = rt.compile(code).expect("compiles");
                    let _ = reply.send((Ok("ready".into()), 0.0));
                    for e in rx {
                        let t = Instant::now();
                        let r = step(&rt, &program, &e);
                        let _ = reply.send((r, us(t)));
                    }
                });
                (tx, thread)
            })
            .collect();
        let pool = Pool { workers, replies };
        (0..n).for_each(|_| drop(pool.replies.recv().expect("ready")));
        pool
    }

    /// One event to every plugin at once; every reply.
    fn round(&self, e: &Json) -> Vec<(Result<String, String>, f64)> {
        self.workers.iter().for_each(|(tx, _)| tx.send(e.clone()).expect("worker"));
        self.workers.iter().map(|_| self.replies.recv().expect("reply")).collect()
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        for (tx, thread) in self.workers.drain(..) {
            drop(tx);
            let _ = thread.join();
        }
    }
}

/// `rounds` timed rounds of one event to every plugin, after a tenth as many untimed, in µs until all replied.
fn rounds(pool: &Pool, rounds: usize) -> Stats {
    let e = event();
    bench(rounds / 10, rounds, || assert!(pool.round(&e).iter().all(|(r, _)| r.is_ok())))
}

// ---- A. Cold start. ----

fn section_a(hs: &[Helper], n: usize) {
    let mut rows = Vec::new();
    for h in hs {
        // One untimed start first, so the binaries and Bun's files are in the page cache.
        let first = Instant::now();
        drop(Conn::spawn(&h.cmd, BENCH, INIT_TIMEOUT).expect("starts"));
        let first = ms(first);
        let (mut init, mut echo) = (Vec::new(), Vec::new());
        for _ in 0..n {
            let t = Instant::now();
            let conn = Conn::spawn(&h.cmd, BENCH, INIT_TIMEOUT).expect("starts");
            init.push(ms(t));
            let t = Instant::now();
            conn.start("echo", &small(), Some(RAW), None, None).and_then(|p| p.wait()).expect("echo");
            echo.push(us(t));
        }
        let (init, echo) = (stats(init), stats(echo));
        rows.push([vec![h.name.into(), f1(first)], mpm(&init, f2).into(), mpm(&echo, f1).into()].concat());
    }
    table(
        &format!("A. Cold start: spawn → `initialize` result ({n} samples; ms), then the first `echo` (µs)"),
        &[
            "helper",
            "first start (untimed) ms",
            "init median ms",
            "init p99 ms",
            "init min ms",
            "first echo median µs",
            "first echo p99 µs",
            "first echo min µs",
        ],
        rows,
    );
}

// ---- B. Warm round trips, raw client. ----

fn section_b(hs: &[Helper], warm: usize, runs: usize) {
    let text = "the quick brown fox jumps over the lazy dog. ".repeat(23)[..1000].to_string();
    let local = embed::embed(&text);
    let (mut rows, mut vectors) = (Vec::new(), Vec::new());
    for h in hs {
        let sc = Sidecar::new(h.cmd.clone(), BENCH);
        for params in [small(), json!({ "text": "x".repeat(10_000) })] {
            let s = bench(warm, runs, || drop(sc.call("echo", &params, RAW, None).expect("echo")));
            assert_eq!(sc.call("echo", &params, RAW, None).expect("echo"), params);
            rows.push(row(&[h.name, &format!("echo {} B", bytes(&params)), &runs.to_string()], &s, f1));
        }
        let params = json!({ "text": text });
        let s = bench(warm / 5, runs / 5, || drop(sc.call("embed", &params, RAW, None).expect("embed")));
        let got = sc.call("embed", &params, RAW, None).expect("embed");
        // serde_json's default float parsing is within an ulp or so, not exact: compare loosely here, and exactly
        // across helpers below.
        let v: Vec<f64> = got["vector"].as_array().expect("a vector").iter().filter_map(Json::as_f64).collect();
        let close = v.len() == local.len() && v.iter().zip(&local).all(|(a, b)| (a - b).abs() < 1e-12);
        assert!(close, "{} computes the same embedding", h.name);
        vectors.push(got["vector"].clone());
        let call = format!("embed 1000-byte text ({} B reply)", bytes(&got));
        rows.push(row(&[h.name, &call, &(runs / 5).to_string()], &s, f1));
    }
    assert!(vectors.windows(2).all(|w| w[0] == w[1]), "every helper sends the same embedding");
    let s = bench(warm / 5, runs / 5, || drop(std::hint::black_box(embed::embed(std::hint::black_box(&text)))));
    rows.push(row(&["(in process)", "embed, Rust function call, no IPC", &(runs / 5).to_string()], &s, f1));
    table(
        &format!("B. Warm round trip, raw client, sequential (µs; {warm} warm-up)"),
        &["helper", "call", "# timed", "median", "p99", "min"],
        rows,
    );
}

// ---- C. The full path from a compiled plugin. ----

fn section_c(hs: &[Helper], warm: usize, runs: usize) {
    let e = event();
    let want = e["text"].as_str().expect("text").to_string();
    let mut rows = Vec::new();
    let bare = runtime("baseline", &[]);
    let baseline = bare.compile(BASELINE).expect("compiles");
    let s = bench(warm, runs, || assert!(step(&bare, &baseline, &e).is_ok()));
    rows.push(row(&["(none)", "baseline: `return { state, slots: { status: event.text } }`"], &s, f1));
    let pack = bench_runtime("plugin", Backing::Pack(Arc::default()));
    let program = pack.compile(CALL).expect("compiles");
    let s = bench(warm, runs, || assert_eq!(step(&pack, &program, &e).as_ref(), Ok(&want)));
    rows.push(row(&["(in-process pack)", "event: `await bench.echo({ text })`, sync Rust echo"], &s, f1));
    for h in hs {
        let sc = Arc::new(Sidecar::new(h.cmd.clone(), BENCH));
        let rt = bench_runtime("plugin", Backing::Helper(sc.clone()));
        let program = rt.compile(CALL).expect("compiles");
        let s = bench(warm, runs, || assert_eq!(step(&rt, &program, &e).as_ref(), Ok(&want)));
        let raw = bench(warm, runs, || drop(sc.call("echo", &small(), RAW, None).expect("echo")));
        rows.push(row(&[h.name, "event: `await bench.echo({ text })`, return slots"], &s, f1));
        rows.push(row(&[h.name, "same payload, raw client echo (no PsychoScript)"], &raw, f1));
    }
    // Bad params: the check rejects before anything is sent, so this helper is never started.
    let sc = Arc::new(Sidecar::new(hs[0].cmd.clone(), BENCH));
    let rt = bench_runtime("plugin", Backing::Helper(sc.clone()));
    let program = rt.compile(REJECTED).expect("compiles");
    let mut status = String::new();
    let s = bench(warm, runs, || status = step(&rt, &program, &e).expect("caught"));
    assert!(sc.pid().is_none() && status.contains("string `text`"), "{status}");
    rows.push(row(
        &["(never started)", &format!("bad params `{{ text: 42 }}` rejected and caught: `{status}`")],
        &s,
        f1,
    ));
    table(
        &format!("C. Full path: one event of a compiled plugin (µs; {warm} warm-up, {runs} timed; ~100 B text)"),
        &["helper", "path", "median", "p99", "min"],
        rows,
    );
}

// ---- D. 50 plugins, a helper each. ----

/// What G compares with: per helper kind, D2's total RSS of the 50 helpers (MB) and D4's fan-out.
type PerPlugin = Vec<(&'static str, f64, Stats)>;

fn section_d(hs: &[Helper], n: usize, count: usize, idle: Duration) -> PerPlugin {
    let (mut start_rows, mut mem_rows, mut fan_rows, mut idle_rows) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut out = Vec::new();
    for h in hs {
        // (1) Spawn all in parallel, three times; the last set stays.
        let host0 = rss_kb(&[me()])[0];
        let mut times = Vec::new();
        let mut sidecars = Vec::new();
        for _ in 0..3 {
            drop(std::mem::take(&mut sidecars));
            sidecars = (0..n).map(|_| Arc::new(Sidecar::new(h.cmd.clone(), BENCH))).collect::<Vec<_>>();
            let t = Instant::now();
            std::thread::scope(|s| {
                sidecars.iter().for_each(|sc| {
                    s.spawn(|| sc.conn().expect("starts"));
                })
            });
            times.push(ms(t));
        }
        let pids: Vec<u32> = sidecars.iter().map(|sc| sc.pid().expect("running")).collect();
        let t = stats(times.clone());
        start_rows.push(vec![
            h.name.into(),
            times.iter().map(|x| f1(*x)).collect::<Vec<_>>().join(" / "),
            f1(t.median),
        ]);
        // (2) Memory.
        std::thread::sleep(Duration::from_millis(200));
        let rss = rss_kb(&pids);
        assert_eq!(rss.len(), n, "every helper is alive");
        let total = rss.iter().sum::<f64>();
        let host = rss_kb(&[me()])[0] - host0;
        let r = stats(rss);
        mem_rows.push(vec![
            h.name.into(),
            f1(r.median / 1024.0),
            f1(r.min / 1024.0),
            f1(r.max / 1024.0),
            f1(total / 1024.0),
            f1(host / 1024.0),
        ]);
        // (3) One echo to every helper, all in flight, then wait for all.
        let p = small();
        let raw = bench(count / 10, count, || {
            let pending: Vec<_> =
                sidecars.iter().map(|sc| sc.start("echo", &p, RAW, None, None).expect("sent")).collect();
            pending.into_iter().for_each(|p| drop(p.wait().expect("echo")));
        });
        // (4) Through PsychoScript: a thread per plugin, each with its runtime, compiled plugin and helper.
        let backing: Vec<_> = sidecars.iter().map(|sc| Backing::Helper(sc.clone())).collect();
        let pool = Pool::new(n, CALL, move |i| bench_runtime(&format!("plugin-{i}"), backing[i].clone()));
        let via = rounds(&pool, count);
        drop(pool);
        fan_rows.push(row(&[h.name, "raw client"], &raw, f1));
        fan_rows.push(row(&[h.name, "PsychoScript event, thread per plugin"], &via, f1));
        out.push((h.name, total / 1024.0, via));
        // (5) Idle CPU: right after the bursts above, then the window after.
        for window in ["first, right after the bursts", "second"] {
            let (helpers0, host0) = (cpu_s(&pids), cpu_s(&[me()]));
            std::thread::sleep(idle);
            let (helpers1, host1) = (cpu_s(&pids), cpu_s(&[me()]));
            idle_rows.push(vec![
                h.name.into(),
                window.into(),
                format!("{:.0}", (helpers1 - helpers0) * 1e3),
                format!("{:.2}", (helpers1 - helpers0) / idle.as_secs_f64() * 100.0),
                format!("{:.0}", (host1 - host0) * 1e3),
            ]);
        }
        drop(sidecars);
    }
    table(
        &format!("D1. {n} helpers spawned in parallel: until all answered `initialize` (ms)"),
        &["helper", "three trials", "median"],
        start_rows,
    );
    table(
        &format!("D2. Memory of {n} helpers (`ps -o rss=`, MB)"),
        &["helper", "median per helper", "min", "max", "total", "host RSS delta (pipes, 2 threads per helper)"],
        mem_rows,
    );
    table(
        &format!("D3/D4. One `echo` to all {n} helpers at once, until all answered (µs; {count} rounds)"),
        &["helper", "dispatch", "median", "p99", "min"],
        fan_rows,
    );
    table(
        &format!("D5. Idle CPU over {} s (`ps -o time=`, 10 ms resolution per process)", idle.as_secs()),
        &["helper", "window", &format!("{n} helpers CPU ms"), "% of one core", "host CPU ms (readers, timer)"],
        idle_rows,
    );
    out
}

// ---- E. Failures. ----

/// Runs one event of `code` on a thread of its own; its result and when it ended.
fn spawn_event(
    sc: &Arc<Sidecar>,
    code: &'static str,
    e: Json,
) -> std::thread::JoinHandle<(Instant, Result<String, String>)> {
    let sc = sc.clone();
    std::thread::spawn(move || {
        let rt = bench_runtime("plugin", Backing::Helper(sc));
        let program = rt.compile(code).expect("compiles");
        let r = step(&rt, &program, &e);
        (Instant::now(), r)
    })
}

fn quote(r: &Result<String, String>) -> String {
    match r {
        Ok(v) => format!("Ok `{v}`"),
        Err(e) => format!("`{e}`"),
    }
}

fn section_e(hs: &[Helper], samples: usize) {
    const SLEEP: &str = r#"await bench.sleep({ ms: 2000 })
return { slots: { status: "slept" } }"#;
    let (mut crash_rows, mut restart_rows) = (Vec::new(), Vec::new());
    for h in hs {
        for how in ["exit", "abort"] {
            let (mut reject, mut restart) = (Vec::new(), Vec::new());
            let (mut diag, mut raw_err) = (String::new(), String::new());
            for _ in 0..samples {
                let sc = Arc::new(Sidecar::new(h.cmd.clone(), BENCH));
                let old = sc.conn().expect("starts").pid;
                let run = spawn_event(&sc, SLEEP, json!({ "type": "key" }));
                std::thread::sleep(Duration::from_millis(30));
                let t = Instant::now();
                let crash = sc.start("crash", &json!({ "how": how }), RAW, None, None).expect("sent");
                let (ended, outcome) = run.join().expect("run");
                reject.push(ended.duration_since(t).as_secs_f64() * 1e3);
                diag = quote(&outcome);
                raw_err = crash.wait().expect_err("the crash call fails");
                // E2: the next call restarts the helper.
                let t = Instant::now();
                sc.call("echo", &small(), RAW, None).expect("restarted");
                restart.push(ms(t));
                assert!(sc.pid() != Some(old) && sc.restarts() == 1);
            }
            let (reject, restart) = (stats(reject), stats(restart));
            crash_rows.push(vec![
                h.name.into(),
                how.into(),
                f2(reject.median),
                f2(reject.max),
                diag,
                format!("`{raw_err}`"),
            ]);
            restart_rows.push(vec![h.name.into(), how.into(), f2(restart.median), f2(restart.max), "1".into()]);
        }
    }
    table(
        &format!(
            "E1. Crash while a plugin awaits `bench.sleep({{ ms: 2000 }})`: crash request sent → run ended ({samples} samples, ms)"
        ),
        &["helper", "how", "median ms", "max ms", "run's diagnostic", "the crash call's error"],
        crash_rows,
    );
    table(
        "E2. The next call after the crash: restart (spawn + initialize) + echo, ms",
        &["helper", "after", "median ms", "max ms", "restarts"],
        restart_rows,
    );

    // E2b. Backoff: crash the same helper six times in a row; the first restart is immediate.
    let mut rows = Vec::new();
    let h = &hs[0];
    let sc = Sidecar::new(h.cmd.clone(), BENCH);
    for k in 1..=6 {
        let crash = sc.start("crash", &json!({ "how": "exit" }), RAW, None, None).expect("sent");
        let _ = crash.wait();
        let t = Instant::now();
        let (mut refused, mut first_refusal) = (0, String::new());
        loop {
            match sc.call("echo", &small(), RAW, None) {
                Ok(_) => break,
                Err(why) if why.contains("restarting") => {
                    if refused == 0 {
                        first_refusal = why
                    }
                    refused += 1;
                    std::thread::sleep(Duration::from_millis(5));
                }
                Err(why) => panic!("{why}"),
            }
        }
        rows.push(vec![
            k.to_string(),
            f1(client::backoff(k).as_secs_f64() * 1e3),
            f1(ms(t)),
            refused.to_string(),
            sc.restarts().to_string(),
            if first_refusal.is_empty() { "".into() } else { format!("`{first_refusal}`") },
        ]);
    }
    table(
        &format!("E2b. Restart backoff ({} helper crashed 6× in a row; echo retried every 5 ms)", h.name),
        &[
            "crash #",
            "backoff ms",
            "crash → echo answered ms",
            "calls refused meanwhile",
            "restarts",
            "first refusal error",
        ],
        rows,
    );

    // E3. Per-call timeout, and the run's own timeout, on a slow call.
    const TIMED: &str = r#"await bench.sleep({ ms: 5000 }, { timeoutMs: 100 })
return { slots: { status: "slept" } }"#;
    const UNTIMED: &str = r#"await bench.sleep({ ms: 5000 })
return { slots: { status: "slept" } }"#;
    let untimed = format!("no call timeout, run's {EVENT_TIMEOUT_MS} ms limit");
    let mut rows = Vec::new();
    for h in hs {
        let after = |sc: &Sidecar, conn: &Conn| {
            let t = Instant::now();
            let echo = sc.call("echo", &small(), RAW, None);
            let echo_us = us(t);
            std::thread::sleep(Duration::from_millis(50));
            [
                format!("{} ({:.0} µs)", if echo.is_ok() { "ok" } else { "failed" }, echo_us),
                (sc.pid() == Some(conn.pid) && sc.restarts() == 0).to_string(),
                conn.late_answers().to_string(),
            ]
        };
        for (case, code) in [("per-call `timeoutMs: 100`", TIMED), (untimed.as_str(), UNTIMED)] {
            let sc = Arc::new(Sidecar::new(h.cmd.clone(), BENCH));
            let conn = sc.conn().expect("starts");
            let t = Instant::now();
            let (ended, outcome) = spawn_event(&sc, code, json!({ "type": "key" })).join().expect("run");
            let took = ended.duration_since(t).as_secs_f64() * 1e3;
            rows.push([vec![h.name.into(), case.into(), f1(took), quote(&outcome)], after(&sc, &conn).into()].concat());
        }
        // The raw client, for comparison.
        let sc = Sidecar::new(h.cmd.clone(), BENCH);
        let conn = sc.conn().expect("starts");
        let t = Instant::now();
        let err =
            sc.call("sleep", &json!({ "ms": 5000 }), RAW, Some(Duration::from_millis(100))).expect_err("times out");
        let took = ms(t);
        let head = vec![h.name.into(), "raw client, timeout 100 ms".into(), f1(took), format!("`{err}`")];
        rows.push([head, after(&sc, &conn).into()].concat());
    }
    table(
        "E3. `sleep { ms: 5000 }` cut short: time to rejection, and the helper afterwards",
        &[
            "helper",
            "case",
            "rejected after ms",
            "outcome",
            "next echo",
            "same helper pid",
            "late answers (helper's -32800)",
        ],
        rows,
    );

    // E4. A helper that never answers `initialize`.
    let mut sc = Sidecar::new(vec!["sleep".into(), "1000".into()], BENCH);
    sc.init_timeout = Duration::from_millis(500);
    let mut rows = Vec::new();
    for k in 1..=3 {
        let t = Instant::now();
        let r = sc.call("echo", &small(), RAW, None);
        rows.push(vec![k.to_string(), f1(ms(t)), format!("`{}`", r.expect_err("never initializes"))]);
    }
    table(
        "E4. A helper that never answers `initialize` (`sleep 1000`, init timeout 500 ms): three calls in a row",
        &["call #", "failed after ms", "error"],
        rows,
    );
}

// ---- F. Streaming. ----

fn section_f(hs: &[Helper], runs: usize) {
    let n = 1000;
    let mut rows = Vec::new();
    for h in hs {
        let sc = Sidecar::new(h.cmd.clone(), BENCH);
        let once = || {
            let (tx, rx) = mpsc::channel();
            let t = Instant::now();
            let result =
                sc.start("stream", &json!({ "n": n }), RAW, None, Some(tx)).and_then(|p| p.wait()).expect("streams");
            let took = ms(t);
            assert_eq!((result["count"].as_u64(), rx.try_iter().count()), (Some(n), n as usize));
            took
        };
        (0..3).for_each(|_| {
            once();
        });
        let s = stats((0..runs).map(|_| once()).collect());
        rows.push(vec![h.name.into(), f2(s.median), f2(s.p99), f2(s.min), format!("{:.0}", n as f64 / s.median * 1e3)]);
    }
    table(
        &format!(
            "F. `stream {{ n: {n} }}` through the raw client: start → final result, all chunks received ({runs} runs)"
        ),
        &["helper", "median ms", "p99 ms", "min ms", "chunks/s (median)"],
        rows,
    );
}

// ---- G. One shared instance for 50 plugins. ----

fn section_g(hs: &[Helper], n: usize, count: usize, warm: usize, runs: usize, per_plugin: &PerPlugin) {
    let d = |name: &str| per_plugin.iter().find(|(h, _, _)| *h == name);
    // (1) One shared helper; (2) the in-process pack.
    let (mut fan_rows, mut mem_rows) = (Vec::new(), Vec::new());
    for h in hs {
        if let Some((_, _, via)) = d(h.name) {
            fan_rows.push(row(&[h.name, &format!("{n} helpers, one per plugin (D4)")], via, f1));
        }
        let sc = Arc::new(Sidecar::new(h.cmd.clone(), BENCH));
        let shared = sc.clone();
        let pool = Pool::new(n, CALL, move |i| bench_runtime(&format!("plugin-{i}"), Backing::Helper(shared.clone())));
        let s = rounds(&pool, count);
        drop(pool);
        assert_eq!(sc.starts(), 1);
        fan_rows.push(row(&[h.name, "1 shared helper"], &s, f1));
        let one = rss_kb(&[sc.pid().expect("running")])[0] / 1024.0;
        let fifty = d(h.name).map_or("".into(), |(_, total, _)| f1(*total));
        mem_rows.push(vec![h.name.into(), f1(one), fifty]);
    }
    let pack = Arc::new(Pack::default());
    let shared = pack.clone();
    let pool = Pool::new(n, CALL, move |i| bench_runtime(&format!("plugin-{i}"), Backing::Pack(shared.clone())));
    let s = rounds(&pool, count);
    drop(pool);
    assert!(pack.calls.load(Relaxed) as usize >= count * n);
    fan_rows.push(row(&["(none)", "in-process pack, one `Arc`, sync Rust echo"], &s, f1));
    table(
        &format!(
            "G1/G2. One event to all {n} plugins at once, each awaiting `bench.echo`, thread per plugin (µs until all replied; {count} rounds)"
        ),
        &["helper", "backing", "median", "p99", "min"],
        fan_rows,
    );

    // (1b) The same with CPU work: `embed` of a 1000-byte text (~0.25 ms in a helper). A helper answers one request
    // after another, so a shared one queues the 50.
    const EMBED: &str = r#"const r = await bench.embed({ text: event.text })
return { state, slots: { status: String(r.dim) } }"#;
    let text = json!({ "type": "key", "text": "the quick brown fox jumps over the lazy dog. ".repeat(23)[..1000] });
    let embed_rounds = (count / 10).max(20);
    let mut rows = Vec::new();
    for h in hs {
        for shared in [false, true] {
            let one = Arc::new(Sidecar::new(h.cmd.clone(), BENCH));
            let cmd = h.cmd.clone();
            let pool = Pool::new(n, EMBED, move |i| {
                let sc = if shared { one.clone() } else { Arc::new(Sidecar::new(cmd.clone(), BENCH)) };
                bench_runtime(&format!("plugin-{i}"), Backing::Helper(sc))
            });
            let s = bench(5, embed_rounds, || assert!(pool.round(&text).iter().all(|(r, _)| r.is_ok())));
            let s = Stats { min: s.min / 1e3, median: s.median / 1e3, p99: s.p99 / 1e3, max: s.max / 1e3 };
            let backing = if shared { "1 shared helper" } else { "50 helpers, one per plugin" };
            rows.push(row(&[h.name, backing], &s, f2));
        }
    }
    table(
        &format!(
            "G1b. CPU-bound calls: one event to all {n} plugins, each awaiting `bench.embed` of 1000 bytes (ms until all replied; {embed_rounds} rounds)"
        ),
        &["helper", "backing", "median ms", "p99 ms", "min ms"],
        rows,
    );

    // (3) Unused namespaces: the event floor with 0, 1, 10, 30 injected.
    let e = event();
    let mut rows = Vec::new();
    let names: Vec<&'static str> =
        std::iter::once(BENCH).chain((1..30).map(|i| &*Box::leak(format!("ns{i}").into_boxed_str()))).collect();
    let idle = Arc::new(Sidecar::new(hs[0].cmd.clone(), BENCH));
    for k in [0, 1, 10, 30] {
        let declared: Vec<_> = names[..k].iter().map(|n| (*n, Backing::Helper(idle.clone()))).collect();
        let rt = runtime("plugin", &declared);
        let program = rt.compile("return { state }").expect("compiles");
        let s = bench(warm, runs, || assert!(step(&rt, &program, &e).is_ok()));
        rows.push(row(&[&k.to_string()], &s, f2));
    }
    assert!(idle.pid().is_none(), "no unused namespace started its helper");
    table(
        &format!(
            "G3. Event floor `return {{ state }}` with N lazy namespace globals it does not use (µs; {runs} timed)"
        ),
        &["# namespaces", "median", "p99", "min"],
        rows,
    );

    // (4) Memory: helpers' RSS, and the host's heap for 50 runtimes sharing one namespace backing.
    let idle = Arc::new(Sidecar::new(hs[0].cmd.clone(), BENCH));
    let (bytes, made) = heap(|| {
        (0..n)
            .map(|i| {
                let rt = bench_runtime(&format!("plugin-{i}"), Backing::Helper(idle.clone()));
                let program = rt.compile(CALL).expect("compiles");
                (rt, program)
            })
            .collect::<Vec<_>>()
    });
    drop(made);
    let (one, _) = heap(|| bench_runtime("plugin-0", Backing::Helper(idle.clone())));
    table(
        "G4. Memory: one shared helper vs one per plugin (`ps -o rss=`, MB)",
        &["helper", "1 shared helper", &format!("{n} helpers (D2 total)")],
        mem_rows,
    );
    println!(
        "\nHost heap (counting allocator): {n} runtimes + compiled plugins sharing one `bench` backing: {:.1} KiB live ({:.2} KiB each); one runtime with its `bench` namespace alone: {:.2} KiB.",
        bytes as f64 / 1024.0,
        bytes as f64 / 1024.0 / n as f64,
        one as f64 / 1024.0
    );

    // (5) Lazy start of a shared helper: one plugin's first call, then 50 first calls at the same moment.
    let mut rows = Vec::new();
    for h in hs {
        let cold: Vec<f64> = (0..5)
            .map(|_| {
                let sc = Arc::new(Sidecar::new(h.cmd.clone(), BENCH));
                let rt = bench_runtime("plugin-0", Backing::Helper(sc.clone()));
                let program = rt.compile(CALL).expect("compiles");
                let t = Instant::now();
                assert!(step(&rt, &program, &e).is_ok());
                ms(t)
            })
            .collect();
        let cold = stats(cold);
        let sc = Arc::new(Sidecar::new(h.cmd.clone(), BENCH));
        let shared = sc.clone();
        let pool = Pool::new(n, CALL, move |i| bench_runtime(&format!("plugin-{i}"), Backing::Helper(shared.clone())));
        assert!(sc.pid().is_none(), "not started before the first call");
        let t = Instant::now();
        let replies = pool.round(&e);
        let wall = ms(t);
        assert!(replies.iter().all(|(r, _)| r.is_ok()));
        let each = stats(replies.iter().map(|(_, took)| took / 1e3).collect());
        rows.push(vec![
            h.name.into(),
            f2(cold.median),
            f2(cold.max),
            f2(each.median),
            f2(each.max),
            f2(wall),
            sc.starts().to_string(),
        ]);
    }
    table(
        "G5. Lazy start of a shared helper: first `bench.echo` event (ms; cold = one plugin, 5 samples)",
        &[
            "helper",
            "cold first event median",
            "cold max",
            &format!("{n} first events at once: per-event median"),
            "per-event max",
            "wall until all replied",
            "processes started",
        ],
        rows,
    );
}

fn main() {
    let quick = std::env::args().any(|a| a == "--quick");
    let pick = std::env::args().skip_while(|a| a != "--sections").nth(1).unwrap_or("ABCDEFG".into());
    let on = |c: char| pick.contains(c);
    let hs = helpers();
    let bun = std::process::Command::new("bun").arg("--version").output();
    let bun = bun.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_else(|e| e.to_string());
    println!("# Helper process bench (pid {}; bun {bun})", me());
    let list: Vec<_> = hs.iter().map(|h| format!("{} `{}`", h.name, h.cmd.join(" "))).collect();
    println!("\nHelpers: {}", list.join("; "));
    let (warm, runs, count) = if quick { (50, 500, 100) } else { (500, 5000, 1000) };
    if on('A') {
        section_a(&hs, if quick { 10 } else { 30 })
    }
    if on('B') {
        section_b(&hs, warm, runs)
    }
    if on('C') {
        section_c(&hs, warm, runs)
    }
    let per_plugin =
        if on('D') { section_d(&hs, 50, count, Duration::from_secs(if quick { 1 } else { 5 })) } else { Vec::new() };
    if on('E') {
        section_e(&hs, if quick { 2 } else { 5 })
    }
    if on('F') {
        section_f(&hs, if quick { 5 } else { 20 })
    }
    if on('G') {
        section_g(&hs, 50, count, warm, runs, &per_plugin)
    }
}
