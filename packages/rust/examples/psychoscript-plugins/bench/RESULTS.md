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
Each plugin is compiled once when it loads (`Runtime::compile`), and every reducer event runs the compiled program.
Table A's "median from source" runs the same events from the source, compiling it again for each, as the prototype
did before psychoscript had `Runtime::compile`.

## The setup

- **Reducer model** (`plugins/*.js`): each event runs `Runtime::execute_with(&compiled, bindings { event, state,
  items })` once, `compiled` being what `Runtime::compile` made of the plugin's source when it loaded. The program returns `{ state, slots, commands }`, and the host keeps `state` (moved out of the result `Data`,
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

| plugin / path | source bytes | min | median | mean | p99 | median from source | last status slot |
|---|---:|---:|---:|---:|---:|---:|---|
| git-status: tick | 773 | 17.6 | 19.2 | 19.5 | 31.3 | 27.4 | `git: ? · 5500` |
| git-status: command git.refresh (async host call) | 773 | 19.6 | 21.5 | 21.5 | 24.4 | 28.7 | `main * ↑2` |
| palette: key (200 commands, top 10) | 6478 | 148.1 | 236.3 | 221.1 | 275.6 | 272.8 | `10 commands` |
| list-filter (a): app.items(1000) per event | 856 | 156.8 | 165.9 | 167.9 | 188.3 | 173.7 | `1000/1000 files` |
| list-filter (b): items in state, in and out | 856 | 153.3 | 165.4 | 167.7 | 188.1 | 176.0 | `1000/1000 files` |
| list-filter (c): items as a host binding | 856 | 104.9 | 113.2 | 115.3 | 138.6 | 122.1 | `1000/1000 files` |
| noop: return { state } | 17 | 15.7 | 17.1 | 17.4 | 34.6 | 18.0 | `` |

### A2. Setup (`Runtime::program` from the compiled program) vs run (`Program::run`), µs

| plugin / path | program() median | program() p99 | run() median | run() p99 | setup share |
|---|---:|---:|---:|---:|---:|
| git-status: tick | 15.0 | 26.8 | 3.8 | 4.2 | 80% |
| git-status: command git.refresh (async host call) | 15.1 | 27.1 | 5.0 | 5.7 | 75% |
| palette: key (200 commands, top 10) | 16.2 | 29.5 | 220.0 | 257.2 | 7% |
| list-filter (a): app.items(1000) per event | 15.2 | 27.8 | 149.4 | 172.0 | 9% |
| list-filter (b): items in state, in and out | 28.6 | 41.4 | 112.5 | 131.5 | 20% |
| list-filter (c): items as a host binding | 28.4 | 46.2 | 67.7 | 87.0 | 30% |
| noop: return { state } | 14.4 | 26.0 | 2.7 | 3.6 | 84% |

### B. Fan-out: one key event to N plugins (git-status, palette, list-filter a, noop cycled), µs until all replied (250 warm-up, 1000 timed)

| # plugins | dispatch | min | median | mean | p99 |
|---|---|---:|---:|---:|---:|
| 1 | sequential, one thread | 18.0 | 18.5 | 18.8 | 31.0 |
| 1 | parallel, thread + Runtime per plugin | 21.4 | 23.9 | 24.9 | 36.1 |
| 10 | sequential, one thread | 872.9 | 1172.5 | 1095.0 | 1241.4 |
| 10 | parallel, thread + Runtime per plugin | 218.8 | 310.2 | 291.7 | 379.6 |
| 50 | sequential, one thread | 4407.6 | 5693.2 | 5321.4 | 5886.9 |
| 50 | parallel, thread + Runtime per plugin | 539.9 | 694.2 | 662.8 | 749.2 |

`Runtime::make().globals(..).limits(..)`: 0.04 µs median; process-cold construction 1.5 µs

### C0. Per-event floor (µs)

| program | median | p99 |
|---|---:|---:|
| `return 1`, Runtime without globals, no bindings | 16.7 | 29.0 |
| noop, Runtime without globals, 3 bindings | 17.9 | 30.4 |
| noop, `app` global (3 host fns), 3 bindings | 18.2 | 30.3 |

### C. Startup and compile scaling (µs; medians of 300)

| source | bytes | first run (fresh Runtime) | program() median | run() median | warm event median | compile() median | warm event from compiled |
|---|---:|---:|---:|---:|---:|---:|---:|
| process-cold: first `execute_with` in the process (git-status init) | 773 | 212.5 |  |  |  |  |  |
| git-status | 773 | 43.9 | 25.3 | 3.5 | 26.7 | 8.5 | 18.2 |
| palette | 6478 | 306.4 | 57.8 | 234.8 | 290.2 | 41.5 | 250.8 |
| list-filter | 856 | 176.3 | 25.4 | 145.8 | 170.5 | 8.5 | 161.1 |
| noop | 17 | 21.7 | 17.1 | 3.0 | 18.3 | 0.8 | 17.2 |
| synthetic 1 KB | 1258 | 45.8 | 33.6 | 5.2 | 36.6 | 17.6 | 19.1 |
| synthetic 10 KB | 10552 | 172.1 | 142.7 | 13.0 | 150.4 | 127.4 | 25.0 |
| synthetic 30 KB | 30982 | 456.9 | 388.1 | 29.7 | 404.6 | 374.8 | 41.0 |
| synthetic 100 KB | 102574 | 1448.5 | 1253.4 | 87.8 | 1297.0 | 1241.2 | 93.8 |

### D. Memory per reducer plugin (counting global allocator)

| plugin / path | retained between events KiB (Runtime + source + state + items) | state JSON bytes | peak heap above baseline during one event KiB | bytes allocated in one event KiB | allocations in one event | live-bytes delta after the event |
|---|---:|---:|---:|---:|---:|---:|
| git-status: tick | 1.0 | 27 | 152.2 | 201.0 | 458 | 0 |
| git-status: command git.refresh (async host call) | 1.0 | 32 | 153.2 | 204.0 | 504 | 0 |
| palette: key (200 commands, top 10) | 6.5 | 12 | 206.6 | 265.7 | 1106 | 1 |
| list-filter (a): app.items(1000) per event | 1.1 | 12 | 357.3 | 494.8 | 4553 | 1 |
| list-filter (b): items in state, in and out | 96.8 | 29022 | 415.5 | 607.0 | 5555 | 1 |
| list-filter (c): items as a host binding | 57.7 | 12 | 307.2 | 413.5 | 2547 | 1 |
| noop: return { state } | 0.0 | 4 | 150.5 | 195.0 | 332 | 0 |

50 reducer plugins (own Runtime each, mix of four): 856.1 KiB live heap retained in total; process RSS 30208 → 30240 KiB

### E. Long-lived model: event → setSlot observed, µs (500 warm-up, 5000 timed; thread per plugin, `run_resumable_async` on a park/unpark `block_on`)

| # plugins | min | median | mean | p99 | how plugin 0 ended after `stop` |
|---|---:|---:|---:|---:|---|
| 1 | 3.4 | 7.5 | 7.1 | 11.6 | Done: `{"ticks":5500}` |
| 10 | 15.3 | 28.7 | 29.2 | 49.4 | Done: `{"ticks":5500}` |
| 50 | 78.5 | 106.1 | 107.7 | 145.1 | Done: `{"ticks":5500}` |

50 long-lived plugins parked in `app.nextEvent()`: 152.3 KiB live heap each (7616.7 KiB total, thread stacks not included); process RSS 214208 → 216096 KiB

### E2. `Limits { timeout_ms: Some(200) }` on a long-lived run

| case | run ended by itself | ended after ms | outcome |
|---|---:|---:|---|
| idle 500 ms | true | 210 | Failed: TimeoutExceeded `Execution timed out after 200ms.` |
| an event every 20 ms for 500 ms | true | 203 | Failed: TimeoutExceeded `Execution timed out after 200ms.` |

### E3. `Program::suspender().suspend(None)` while parked in `await app.nextEvent()` (after 3 events)

| case | result | suspend() µs | snapshot bytes (`to_bytes`) | spawn + `Runtime::resume` µs | resumed run after `stop` |
|---|---|---:|---:|---:|---:|
| nextEvent idempotent = false | refused: `The run can't be suspended while app.nextEvent is running.` | 72.1 |  |  | Done: `{"ticks":3}` |
| nextEvent idempotent = true | suspended (Suspended); resumed, next event set status `tick 4 k` | 1727.3 | 2087 | 312.8 | Done: `{"ticks":4}` |

### E4. Stopping a runaway long-lived run by dropping its `run_resumable_async` future

| case | still running before cancel | cancel → thread done µs | outcome |
|---|---:|---:|---|
| `while (true) {}` after an event, cancelled after 5 ms | true | 333.0 | Cancelled: future dropped |
| `while (true) {}` after an event, cancelled after 100 ms | true | 121.4 | Cancelled: future dropped |

### E5. Heap growth of one long-lived run (events sent back to back)

| loop | events handled | live heap growth bytes/event (first 1k) | max live heap growth KiB | seconds | outcome |
|---|---:|---:|---:|---:|---|
| tick loop (long-lived.js) | 20000 | 718 | 13287.4 | 0.1 | still running at the cap; after `stop`: Done: `{"ticks":20000}` |
| palette-style loop: map 200 → filter → sort → top 10 | 9614 | 45904 | 398236.9 | 2.4 | Failed: ExecutionFailure `Execution exceeded its memory limit.` |

### F. Failure containment (`timeout_ms: Some(100)`), µs per event

| plugin | # runs | min | median | p99 | outcome |
|---|---:|---:|---:|---:|---|
| `while (true) {}` | 5 | 100051.1 | 100061.5 | 100241.0 | TimeoutExceeded: `Execution timed out after 100ms.` |
| `throw new Error(...)` | 1000 | 16.8 | 18.2 | 32.4 | ExecutionFailure: `Error: boom on tick` |
| rejected await | 1000 | 17.4 | 18.5 | 32.8 | ExecutionFailure: `TypeError: nope` |
| syntax error `return {` | 1000 | 0.6 | 0.7 | 0.8 | ParseError: `SyntaxError: Unexpected token. Code must be plain JavaScript written as a program body. (line 1, col 9)` |
| non-JSON result (a function) | 1000 | 18.2 | 18.7 | 33.3 | Ok `{"state":{"n":1},"slots":{}}` |

### Run-to-run ranges (three full runs)

| measurement | run 1 | run 2 | run 3 |
|---|---:|---:|---:|
| A git-status tick, median µs | 20.0 | 19.2 | 19.2 |
| A palette key, median / p99 µs | 236 / 274 | 236 / 272 | 236 / 276 |
| A list-filter (c), median µs | 114.3 | 113.8 | 113.2 |
| B 50 plugins sequential, median / p99 µs | 5741 / 5989 | 5790 / 5950 | 5693 / 5887 |
| B 50 plugins parallel, median / p99 µs | 693 / 753 | 703 / 762 | 694 / 749 |
| E 50 long-lived plugins, median / p99 µs | 106.6 / 147.8 | 105.6 / 131.8 | 106.1 / 145.1 |
| C process-cold first event, µs | 7799 | 232 | 213 |
| E3 `suspend()` refused (not idempotent), µs | 2858 | 51 | 72 |
| E3 `suspend()` succeeded (idempotent), µs | 2620 | 1637 | 1727 |
| E4 cancel → thread done, µs | 326 / 78 | 249 / 132 | 333 / 121 |

## Interpretation against a 60 fps frame (16.6 ms)

- **The cost of one reducer event is mostly fixed.** The floor is about 17 µs (C0), even for `return 1` with no
  globals and no bindings. A `sample` profile of that loop shows where it goes:
  - About two thirds is `Vm::setup` in `run::start`. Every run rebuilds the standard library: it interns every
    builtin name into a fresh `Strings` table and allocates every native function object.
  - About one sixth is `run::finish`, which drops the VM.
  - Compiling a small program costs next to nothing.

  From the compiled program, `program()` is the setup alone, and still 75–84% of a small plugin's event (A2). Real
  handlers cost 19 µs (git-status) to about 236 µs (palette fuzzy-sorting 200 items), which is 0.1–1.4% of a frame
  per plugin per event; from the source they cost 27–273 µs (A).
- **Fan-out decides the design.** A key event that reaches 50 plugins costs 5.7 ms median (6.0 ms worst p99) when they
  run one after another on one thread: about 35% of the frame. With a thread and a `Runtime` per plugin (the
  prototype's design), it costs 0.69 ms median and under 0.8 ms p99. At 10 plugins it is 1.17 ms sequential vs 0.31 ms
  parallel. With a single plugin, the thread hop adds about 5 µs.
- **Compile time scales linearly, at about 12 µs/KB** (C), and is now paid once per load or reload: `compile()` takes
  0.37 ms for a 30 KB plugin and 1.24 ms for 100 KB. An event from the compiled program then costs 41 µs and 94 µs,
  against 0.40 ms and 1.30 ms from the source, so large plugins are fine in the reducer model.
- **What crossing the boundary costs** (list-filter, 1,000 paths of about 29 KB):
  - as a `items` binding (c): 113 µs
  - kept in `state`, so the items go in and come back out every event (b): 165 µs, about 50 µs more than (c)
  - from `app.items(1000)` (a): 166 µs

  So bindings are the cheapest way to hand large read-only data in. Returning large state every event is
  measurable but not fatal.
- **Memory in the reducer model is small, but every event churns.** Between events, a plugin retains about 1 KiB
  (Runtime + source + state), plus its state and items. That is 120 KiB in total for 50 plugins, and RSS doesn't move.
  Each event allocates 230–665 KiB in 350–5,600 allocations, with a 150–420 KiB peak, and frees all of it. The
  allocator matters: the shared counters alone made parallel fan-out 5x slower. A real allocator scales; avoid
  global-lock instrumentation in production.
- **The long-lived model is about 2.5x faster per event for a trivial handler**: 7.5 µs, against 19 µs for the reducer
  git-status tick. It costs 106 µs for 50 trivial plugins dispatched in parallel; B's 50-plugin mix is heavier, so the
  two aren't directly comparable. It saves the per-run `Vm::setup`. But it has three problems that rule it
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
