# PsychoScript as an OpenTUI plugin engine: benchmark results

- **Machine:** Apple M5 Max (18 cores), 48 GB, macOS 26.7.1
- **Toolchain:** `rustc 1.100.0 (0ef1bc386 2026-11-09)`, from `../rust-toolchain.toml`. Homebrew's `cargo` 1.95 shadows
  rustup, so put rustup's binaries first on `PATH`.
- **psychoscript:** `psychoscript-rs-pin/packages/codemode-rust/crates/psychoscript`, as pinned by the parent
  `Cargo.toml`.
- **Build profile:** release (`[profile.release] debug = 1` from the mini-workspace).
- **Command**, run from `packages/rust/examples/psychoscript-plugins/`:

  ```sh
  export PATH=$HOME/.cargo/bin:$PATH   # or $HOME/.rustup/toolchains/1.100.0-aarch64-apple-darwin/bin
  cargo build --release -p psychoscript-plugins-bench
  ./target/release/psychoscript-plugins-bench            # full run, about 27 s
  ./target/release/psychoscript-plugins-bench --quick    # 10x fewer iterations
  ./target/release/psychoscript-plugins-bench --sections B --count   # B with the counting allocator left on
  ./target/release/psychoscript-plugins-bench --floor 5  # loops `execute("return 1")` for a profiler
  ```

I ran the full bench three times. The tables below are the third run, which was the quietest. Medians across the three
runs moved by less than about 10%. Where they moved more, the range is given in the notes. All times are wall clock.
Every reducer event recompiles the plugin: psychoscript has no API to compile a program once and reuse it.

## The setup

- **Reducer model** (`plugins/*.js`): each event runs `Runtime::execute_with(source, bindings { event, state, items })`
  once. The program returns `{ state, slots, commands }`, and the host keeps `state` (moved out of the result `Data`,
  not cloned).
- **Host global:** a single `app` object.
  - `app.now()`: sync.
  - `app.git.status()`: `HostFunction::new_async`, which resolves at once to `{ branch, dirty, ahead }`.
  - `app.items(n)`: sync. Returns n paths such as `src/module_17/file_0423.rs`. They are built once and cloned per
    call, so an event pays for the boundary crossing and not for `format!`.
- **Limits:** `Limits { timeout_ms: Some(100), max_output_bytes: None }`.
- **Plugin workloads:**
  - git-status `tick`: bumps a counter.
  - git-status `command git.refresh`: awaits the async host call.
  - palette: cycles the keys `g i t escape`, so the query goes `g`, `gi`, `git`, then empty (all 200 match and are
    sorted). That explains its min/median spread.
  - list-filter: cycles the keys `1 7 / escape` over 1,000 paths.
- **Long-lived model** (`plugins/long-lived.js`): one run per plugin on its own thread, driven by
  `Program::run_resumable_async()` on a park/unpark `block_on`. It loops `await app.nextEvent()`.
  - `app.nextEvent` is an async host function whose future pops from a `Mutex<VecDeque>` inbox. When the inbox is
    empty, it stores its `Waker`, and the sender wakes it.
  - `app.setSlot` is a sync host function that sends to an mpsc channel. The latency clock stops when that message
    arrives.
- **Memory:** a counting `#[global_allocator]` that wraps `System`. During the timing of B and E1, counting is
  switched off, because its shared atomics made 50-thread fan-out about 5x slower (see the notes).

## Tables (run 3)

### A. Per-event latency, reducer model (µs; 500 warm-up, 5000 timed events, one thread)

| plugin / path | source bytes | min | median | mean | p99 | last status slot |
|---|---:|---:|---:|---:|---:|---|
| git-status: tick | 773 | 27.2 | 28.1 | 29.0 | 41.4 | `git: ? · 5500` |
| git-status: command git.refresh (async host call) | 773 | 28.1 | 29.1 | 29.7 | 36.6 | `main * ↑2` |
| palette: key (200 commands, top 10) | 6478 | 191.3 | 287.9 | 275.6 | 365.3 | `10 commands` |
| list-filter (a): app.items(1000) per event | 856 | 170.5 | 182.2 | 183.7 | 220.1 | `1000/1000 files` |
| list-filter (b): items in state, in and out | 856 | 171.2 | 175.1 | 176.0 | 196.2 | `1000/1000 files` |
| list-filter (c): items as a host binding | 856 | 118.2 | 126.9 | 128.5 | 161.8 | `1000/1000 files` |
| noop: return { state } | 17 | 18.6 | 19.4 | 19.6 | 24.2 | `` |

### A2. Compile + setup (`Runtime::program`) vs run (`Program::run`), µs

| plugin / path | program() median | program() p99 | run() median | run() p99 | compile share |
|---|---:|---:|---:|---:|---:|
| git-status: tick | 23.4 | 34.5 | 4.0 | 5.4 | 85% |
| git-status: command git.refresh (async host call) | 23.5 | 27.5 | 5.2 | 5.7 | 82% |
| palette: key (200 commands, top 10) | 57.0 | 90.8 | 228.5 | 289.1 | 20% |
| list-filter (a): app.items(1000) per event | 24.0 | 36.0 | 156.2 | 182.8 | 13% |
| list-filter (b): items in state, in and out | 37.3 | 50.0 | 120.0 | 139.5 | 24% |
| list-filter (c): items as a host binding | 37.6 | 51.9 | 76.5 | 100.5 | 33% |
| noop: return { state } | 15.9 | 18.6 | 2.9 | 3.6 | 85% |

### B. Fan-out: one key event to N plugins (git-status, palette, list-filter a, noop cycled), µs until all replied (250 warm-up, 1000 timed)

| # plugins | dispatch | min | median | mean | p99 |
|---|---|---:|---:|---:|---:|
| 1 | sequential, one thread | 26.5 | 27.2 | 27.5 | 38.1 |
| 1 | parallel, thread + Runtime per plugin | 29.7 | 31.0 | 31.9 | 44.6 |
| 10 | sequential, one thread | 1045.2 | 1364.4 | 1308.5 | 1618.8 |
| 10 | parallel, thread + Runtime per plugin | 283.4 | 437.4 | 413.8 | 492.5 |
| 50 | sequential, one thread | 5106.1 | 6482.4 | 6108.3 | 6754.2 |
| 50 | parallel, thread + Runtime per plugin | 625.4 | 809.6 | 775.3 | 878.4 |

`Runtime::make().globals(..).limits(..)`: 0.04 µs median; process-cold construction 2.5 µs

### C0. Per-event floor (µs)

| program | median | p99 |
|---|---:|---:|
| `return 1`, Runtime without globals, no bindings | 16.7 | 28.8 |
| noop, Runtime without globals, 3 bindings | 17.9 | 30.4 |
| noop, `app` global (3 host fns), 3 bindings | 18.1 | 30.1 |

### C. Startup and compile scaling (µs; medians of 300)

| source | bytes | first run (fresh Runtime) | program() median | run() median | warm event median |
|---|---:|---:|---:|---:|---:|
| process-cold: first `execute_with` in the process (git-status init) | 773 | 259.9 |  |  |  |
| git-status | 773 | 44.9 | 26.8 | 3.6 | 26.9 |
| palette | 6478 | 327.9 | 57.6 | 242.0 | 297.0 |
| list-filter | 856 | 174.0 | 25.5 | 149.0 | 173.1 |
| noop | 17 | 21.8 | 17.2 | 3.0 | 18.2 |
| synthetic 1 KB | 1258 | 53.0 | 33.6 | 5.2 | 36.5 |
| synthetic 10 KB | 10552 | 190.2 | 142.4 | 12.1 | 148.8 |
| synthetic 30 KB | 30982 | 433.5 | 385.8 | 28.5 | 399.3 |
| synthetic 100 KB | 102574 | 1489.6 | 1250.2 | 85.2 | 1292.7 |

### D. Memory per reducer plugin (counting global allocator)

| plugin / path | retained between events KiB (Runtime + source + state + items) | state JSON bytes | peak heap above baseline during one event KiB | bytes allocated in one event KiB | allocations in one event | live-bytes delta after the event |
|---|---:|---:|---:|---:|---:|---:|
| git-status: tick | 1.0 | 27 | 154.4 | 248.3 | 558 | 0 |
| git-status: command git.refresh (async host call) | 1.0 | 32 | 155.5 | 251.4 | 604 | 0 |
| palette: key (200 commands, top 10) | 6.5 | 12 | 228.5 | 428.3 | 1721 | 1 |
| list-filter (a): app.items(1000) per event | 1.1 | 12 | 365.2 | 552.5 | 4645 | 1 |
| list-filter (b): items in state, in and out | 96.8 | 29022 | 423.4 | 664.8 | 5647 | 1 |
| list-filter (c): items as a host binding | 57.7 | 12 | 315.1 | 471.3 | 2639 | 1 |
| noop: return { state } | 0.0 | 4 | 151.4 | 230.6 | 354 | 0 |

50 reducer plugins (own Runtime each, mix of four): 119.5 KiB live heap retained in total; process RSS 27504 → 27552 KiB

### E. Long-lived model: event → setSlot observed, µs (500 warm-up, 5000 timed; thread per plugin, `run_resumable_async` on a park/unpark `block_on`)

| # plugins | min | median | mean | p99 | how plugin 0 ended after `stop` |
|---|---:|---:|---:|---:|---|
| 1 | 3.3 | 7.4 | 7.2 | 18.1 | Done: `{"ticks":5500}` |
| 10 | 16.0 | 29.7 | 29.9 | 48.4 | Done: `{"ticks":5500}` |
| 50 | 65.2 | 105.9 | 106.9 | 132.2 | Done: `{"ticks":5500}` |

50 long-lived plugins parked in `app.nextEvent()`: 152.3 KiB live heap each (7616.2 KiB total, thread stacks not included); process RSS 218160 → 220032 KiB

### E2. `Limits { timeout_ms: Some(200) }` on a long-lived run

| case | run ended by itself | ended after ms | outcome |
|---|---:|---:|---|
| idle 500 ms | true | 210 | Failed: TimeoutExceeded `Execution timed out after 200ms.` |
| an event every 20 ms for 500 ms | true | 205 | Failed: TimeoutExceeded `Execution timed out after 200ms.` |

### E3. `Program::suspender().suspend(None)` while parked in `await app.nextEvent()` (after 3 events)

| case | result | suspend() µs | snapshot bytes (`to_bytes`) | spawn + `Runtime::resume` µs | resumed run after `stop` |
|---|---|---:|---:|---:|---:|
| nextEvent idempotent = false | refused: `The run can't be suspended while app.nextEvent is running.` | 61.0 |  |  | Done: `{"ticks":3}` |
| nextEvent idempotent = true | suspended (Suspended); resumed, next event set status `tick 4 k` | 1697.6 | 2087 | 311.9 | Done: `{"ticks":4}` |

### E4. Stopping a runaway long-lived run by dropping its `run_resumable_async` future

| case | still running before cancel | cancel → thread done µs | outcome |
|---|---:|---:|---|
| `while (true) {}` after an event, cancelled after 5 ms | true | 222.5 | Cancelled: future dropped |
| `while (true) {}` after an event, cancelled after 100 ms | true | 149.8 | Cancelled: future dropped |

### E5. Heap growth of one long-lived run (events sent back to back)

| loop | events handled | live heap growth bytes/event (first 1k) | max live heap growth KiB | seconds | outcome |
|---|---:|---:|---:|---:|---|
| tick loop (long-lived.js) | 20000 | 720 | 13289.2 | 0.1 | still running at the cap; after `stop`: Done: `{"ticks":20000}` |
| palette-style loop: map 200 → filter → sort → top 10 | 9614 | 45903 | 398235.7 | 2.4 | Failed: ExecutionFailure `Execution exceeded its memory limit.` |

### F. Failure containment (`timeout_ms: Some(100)`), µs per event

| plugin | # runs | min | median | p99 | outcome |
|---|---:|---:|---:|---:|---|
| `while (true) {}` | 5 | 100067.8 | 100099.7 | 100343.7 | TimeoutExceeded: `Execution timed out after 100ms.` |
| `throw new Error(...)` | 1000 | 17.9 | 18.3 | 30.9 | ExecutionFailure: `Error: boom on tick` |
| rejected await | 1000 | 18.2 | 18.7 | 31.0 | ExecutionFailure: `TypeError: nope` |
| syntax error `return {` | 1000 | 0.7 | 0.7 | 0.9 | ParseError: `SyntaxError: Unexpected token. Code must be plain JavaScript written as a program body. (line 1, col 9)` |
| non-JSON result (a function) | 1000 | 18.2 | 18.7 | 20.1 | Ok `{"state":{"n":1},"slots":{}}` |

### Run-to-run ranges (three full runs)

| measurement | run 1 | run 2 | run 3 |
|---|---:|---:|---:|
| A git-status tick, median µs | 28.2 | 29.5 | 28.1 |
| A palette key, median / p99 µs | 279 / 320 | 279 / 398 | 288 / 365 |
| A list-filter (c), median µs | 122.9 | 130.7 | 126.9 |
| B 50 plugins sequential, median / p99 µs | 6458 / 6776 | 6515 / 7266 | 6482 / 6754 |
| B 50 plugins parallel, median / p99 µs | 833 / 956 | 813 / 875 | 810 / 878 |
| B 50 plugins parallel, counting allocator on (separate run), median µs | 4065 | | |
| E 50 long-lived plugins, median / p99 µs | 134.5 / 194.2 | 106.5 / 131.0 | 105.9 / 132.2 |
| C process-cold first event, µs | 7479 | 241 | 260 |
| E3 `suspend()` refused (not idempotent), µs | 3451 | 72 | 61 |
| E3 `suspend()` succeeded (idempotent), µs | 1306 | 1682 | 1698 |
| E4 cancel → thread done, µs | 60 / 69 | 452 / 152 | 223 / 150 |

## Interpretation against a 60 fps frame (16.6 ms)

- **The cost of one reducer event is mostly fixed.** The floor is about 17 µs (C0), even for `return 1` with no
  globals and no bindings. A `sample` profile of that loop shows where it goes:
  - About two thirds is `Vm::setup` in `run::start`. Every run rebuilds the standard library: it interns every
    builtin name into a fresh `Strings` table and allocates every native function object.
  - About one sixth is `run::finish`, which drops the VM.
  - Compiling a small program costs next to nothing.

  For small plugins, `program()` is 82–85% of the event (A2). Real handlers cost 27 µs (git-status) to about 290 µs
  (palette fuzzy-sorting 200 items), which is 0.2–1.8% of a frame per plugin per event.
- **Fan-out decides the design.** A key event that reaches 50 plugins costs 6.5 ms median (7.3 ms worst p99) when they
  run one after another on one thread: about 40% of the frame. With a thread and a `Runtime` per plugin (the
  prototype's design), it costs 0.81 ms median and under 1 ms p99. At 10 plugins it is 1.37 ms sequential vs 0.43 ms
  parallel. With a single plugin, the thread hop adds about 4 µs.
- **Compile time scales linearly, at about 12 µs/KB** (C). A 30 KB plugin pays 0.39 ms and a 100 KB plugin 1.25 ms on
  every event, because nothing caches the compiled program. Large plugins in the reducer model need a compile-once
  API, or must stay small.
- **What crossing the boundary costs** (list-filter, 1,000 paths of about 29 KB):
  - as a `items` binding (c): 123 µs
  - kept in `state`, so the items go in and come back out every event (b): 175 µs, about 50 µs more than (c)
  - from `app.items(1000)` (a): 175–185 µs

  So bindings are the cheapest way to hand large read-only data in. Returning large state every event is
  measurable but not fatal.
- **Memory in the reducer model is small, but every event churns.** Between events, a plugin retains about 1 KiB
  (Runtime + source + state), plus its state and items. That is 120 KiB in total for 50 plugins, and RSS doesn't move.
  Each event allocates 230–665 KiB in 350–5,600 allocations, with a 150–420 KiB peak, and frees all of it. The
  allocator matters: the shared counters alone made parallel fan-out 5x slower. A real allocator scales; avoid
  global-lock instrumentation in production.
- **The long-lived model is about 4x faster per event for a trivial handler**: 7.5 µs, against 28 µs for the reducer
  git-status tick. It costs 106 µs for 50 trivial plugins dispatched in parallel; B's 50-plugin mix is heavier, so the
  two aren't directly comparable. It saves the per-run `Vm::setup` and compile. But it has three problems that rule it
  out as the default:
  1. **No GC.** `Vm::alloc` pushes onto an append-only `heap: Vec<Obj>` that is capped at `MAX_OBJECTS = 2_000_000`
     (`vm.rs:22`, `vm.rs:414`).
     - A trivial tick loop grows by 720 B per event (E5).
     - A palette-style loop grows by 45 KB per event and dies after 9,614 events with
       `ExecutionFailure: Execution exceeded its memory limit.`, at about 390 MB live.
     - The E1 latency run alone pushed process RSS to about 215 MB.
     - A parked plugin holds 152 KiB live heap even when idle, plus its thread stack.
  2. **`timeout_ms` measures wall time from the start of the run**, idle time included: `Vm::check_time` compares
     `self.start.elapsed()` with the limit. A run parked in `nextEvent` with `timeout_ms: Some(200)` ends with
     `TimeoutExceeded` after about 200 ms, whether idle or busy (E2). The README says "Time counts active time only,
     across every resume", but within one run, parked time counts. So a long-lived run can't have a timeout at all.
     The only containment is dropping its future. That works: compute longer than 1 ms runs on psychoscript's worker,
     so the executor thread wakes on `unpark`, and the run stops within 0.06–0.45 ms (E4).
  3. **Suspending needs an idempotent `nextEvent`.** If `nextEvent` isn't `.idempotent()`, `suspend()` is refused
     with `The run can't be suspended while app.nextEvent is running.` When it is idempotent, the parked run
     suspends to a 2,087-byte snapshot. It resumes in about 0.3 ms (thread spawn included) and goes on correctly: the
     next event set `tick 4 k`. `Suspender::suspend` waits on a 5 ms `wait_timeout` loop, so it takes 1.3–1.7 ms, and
     a refusal can take up to 3.5 ms.
- **Failures are contained and cheap, except for timeouts.**
  - A thrown error or rejected await costs the same as a no-op (about 18 µs) and comes back as
    `ExecutionFailure: Error: boom on tick` / `TypeError: nope`.
  - A syntax error is a `ParseError` in 0.7 µs.
  - `while (true) {}` ends with `TimeoutExceeded` after 100.1 ms. That is six frames of one plugin's thread, or of
    the whole UI if dispatch is sequential.

  Use a per-plugin thread, and consider `timeout_ms` of about 16–50 ms for per-event runs.
- **Surprises:**
  - The timeout semantics for parked runs (above).
  - There is no GC within a run.
  - A function in the result is dropped silently: `slots: { status: () => 1 }` returns `Ok` with `slots: {}` and no
    diagnostic.
  - The first event in the process costs 0.24–7.5 ms (one-time lazy initialization and page-ins). The first run of
    each further source costs only 1.1–1.7x its warm time.
