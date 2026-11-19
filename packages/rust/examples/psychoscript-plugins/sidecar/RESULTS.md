# Helper processes for PsychoScript plugins: round-trip measurements

Plugins in the reducer model (see `../README.md`) sometimes need work PsychoScript can't do: native libraries, a
language ecosystem, CPU-heavy code. This bench puts that work in **helpers**: separate processes the host talks to over
JSON-RPC, exposed to a plugin as a **top-level namespace global** named after the interface the plugin declares. Here
the interface is `bench`, so a plugin writes:

```js
const r = await bench.echo({ text: event.text })
return { state, slots: { status: r.text } }
```

## Summary (run 2; details in the tables below)

| Measurement | Rust helper | Bun helper |
|---|---:|---:|
| Cold start: spawn → `initialize` answered | 1.0 ms | 7.8 ms |
| Warm round trip, ~100 B / ~10 KB, raw client | 12 / 16 µs | 26 / 31 µs |
| Plugin event awaiting `bench.echo` (without the call: 18 µs; in-process pack: 19 µs) | 37 µs (p99 50) | 50 µs (p99 65) |
| `embed` (5 KB result); in process 224 µs | 249 µs | 259 µs |
| Bad params rejected before sending (helper never started) | 19 µs per event | 19 µs per event |
| 50 plugins, one event each awaiting their helper: 50 helpers / 1 shared (in-process pack: 0.25 ms) | 0.50 / 0.50 ms | 0.62 / 0.47 ms |
| 50 CPU-bound `embed` calls: 50 helpers / 1 sequential shared helper | 1.3 / 12.4 ms | 1.4 / 12.2 ms |
| Starting 50 helpers in parallel / 50 first calls to 1 shared helper (one start) | 14 / 2.2 ms | 46 / 9.4 ms |
| RSS: 1 helper / 50 helpers / 1 shared after 50k calls | 1.8 / 88 / 2.2 MB | 16 / 816 / 38 MB |
| Idle CPU, 50 helpers | 0 | 5–7% of one core |
| Crash during a call → the plugin's promise rejects | 0.14–0.28 ms | 0.22–0.57 ms |
| Next call after a crash (restart + call) | 1.2–1.3 ms | 8.6–8.7 ms |
| Per-call timeout 100 ms → rejection; helper usable after `$/cancel` | 100–110 ms | 100 ms |
| `stream` of 1,000 chunks | 1.0 ms | 0.56 ms |
| Unused lazy namespaces injected into a run | 15–65 ns each | |

## Setup

- Machine: Apple M5 Max (18 cores), 48 GB, macOS 26.7.1 (25G241).
- Toolchain: rustc 1.100.0 (0ef1bc386 2026-11-09), release profile (`debug = 1`); Bun 1.4.4.
- Helpers: `helpers/rust/main.rs` (binary `helper-rust`, serde_json + std); `helpers/bun/helper.ts` run as
  `bun helper.ts`; and the same file built with `bun build --compile` ("Bun (compiled)", an 89 MB binary, kept out of
  the repository in `target/`).
- Commands (from `packages/rust/examples/psychoscript-plugins`):

```sh
export PATH=$HOME/.rustup/toolchains/1.100.0-aarch64-apple-darwin/bin:$PATH   # Homebrew cargo shadows rustup
cargo build --release -p psychoscript-plugins-sidecar
bun build --compile sidecar/helpers/bun/helper.ts --outfile target/release/helper-bun   # optional third helper
./target/release/sidecar-bench               # all sections, about 70 s; --quick, --sections ABCDEFG
```

The tables below are from the second of two full runs, which was the quieter one. The variance between runs is at the end.
Other sessions were using the machine at the same time (load average 5 to 8).

## Wire protocol (as implemented)

- Transport: the helper's stdin and stdout. Its stderr is a log; the host keeps the last 64 lines.
- Framing: newline-delimited JSON, one JSON-RPC 2.0 message per UTF-8 line, as in MCP's stdio transport.
- Handshake: the host sends `{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocol":0,"plugin":"bench"}}`.
  The helper answers `{"jsonrpc":"2.0","id":0,"result":{"protocol":0,"methods":["echo","stream","sleep","crash","embed"]}}`.
  A different `protocol` fails the start.
- Calls: `{"jsonrpc":"2.0","id":N,"method":M,"params":P,"caller":{"plugin":"<id>"}}` gets back `result` or
  `error: {code, message, data?}`. `caller` is a top-level member naming the plugin that made the call. Helpers may
  ignore it, and both of these do. `initialize` is the host's own request and has no `caller`.
- Streaming: before its final response, a helper may send notifications
  `{"jsonrpc":"2.0","method":"$/chunk","params":{"id":N,"chunk":...}}`. The host passes them to that call's channel.
- Cancel: the host sends `{"jsonrpc":"2.0","method":"$/cancel","params":{"id":N}}`, and the helper stops and answers
  with error -32800. By then the host has already failed the call, so it drops the late answer (it counts it; see E3).
- Methods: `echo` returns its params. `stream {n}` sends n chunks, then `{count: n}`. `sleep {ms}` honours cancel.
  `crash {how: "exit"|"abort"}`. `embed {text}` returns 256 floats from FNV-1a hashes of the text, and is bit-identical
  in both helpers (B checks this).

## Host side

`src/client.rs` contains the following:

- `Conn`: one helper process. The host spawns it with piped stdio. Writes are one `write_all` per line under a mutex.
  A reader thread completes calls by id from a `Mutex<HashMap<id, Arc<Call>>>`, and a second thread drains stderr. When
  stdout reaches EOF, the reader reaps the child and fails every call in flight with `helper exited: <status>`.
- One timer thread for every call timeout. When a call's deadline passes and the call is still in flight, the timer
  fails it and sends `$/cancel`.
- `Pending`: a call in flight. It can block (`wait`) or be awaited as a waker-based future. Dropping it unanswered, for
  example when a run times out, cancels the call.
- `Sidecar`: supervises one helper. The first call starts it, and concurrent first calls wait for that one start. The
  call after a crash restarts it with backoff: none for the first restart, then 100, 200, 400 ms and so on, capped at 5 s.
  A helper that stayed up for 10 s resets the streak. A call made during the backoff fails at once instead of blocking
  the plugin's thread.

The bridge is in `src/main.rs`. `runtime(plugin, declared)` builds each plugin's globals through
`Runtime::make().globals(move |_run| ...)`. It injects only the interfaces that plugin declares, each as a lazy
`Namespace` whose `resolve` maps `[method]` to a function. Those functions are built once per plugin and carry its id
as the `caller`. A helper's function is an async `HostFunction`: it checks the params first (they must be an object,
and `echo` needs a string `text`) and rejects with a `TypeError` without contacting the helper if they don't pass. A
second argument `{ timeoutMs }` sets the call's timeout. An in-process "pack" backing serves the same namespace with a
synchronous Rust `HostFunction` whose shared state is one `Arc`. Plugins are compiled once with `Runtime::compile`, and
each event runs with `execute_with` under the prototype's 250 ms limit.

## Interpretation, against a 16.6 ms frame

- **Warm calls are cheap.** A raw round trip with ~100 B takes 12 µs to the Rust helper and 26 µs to the Bun helper;
  with 10 KB it takes 16 and 31 µs (B). From a plugin, an event that awaits `bench.echo` takes 37 µs (Rust) or 50 µs
  (Bun), against 18 µs for the same plugin without the call (C). That puts the bridge (PsychoScript promise plus host
  function) at about 25 µs on top of the raw round trip. An `embed` that costs 212–224 µs in process costs 249–259 µs
  through a helper, so IPC and 5 KB of JSON add ~35 µs.
- **The bad-params check costs nothing measurable.** A rejected-and-caught call takes 19.2 µs per event against the
  18.2 µs baseline, and the helper is never started (C, last row).
- **Fan-out to 50 plugins is ~0.5 ms.** One event to 50 plugins, each on its own thread and awaiting its helper, is
  done in 0.50 ms (Rust) or 0.62 ms (Bun) at the median. Bun's p99 is 1.1 ms (D4). That is 3–7% of a frame, and it
  runs on the plugins' threads, not the UI thread. The in-process pack does the same fan-out in 0.25 ms (G2). That is
  the floor set by 50 thread wake-ups plus 50 PsychoScript runs.
- **Cold start: the Bun helper costs ~8 ms, about half a frame.** Spawn to `initialize` takes 1.0 ms for Rust, 7.8 ms
  for Bun, and 7.2 ms for compiled Bun (A). Bun's first `echo` is also slower, 62 µs against 16 µs, before the JIT has
  warmed up. Starting 50 helpers in parallel takes 10–15 ms for Rust and 43–52 ms for Bun, which is three frames
  (D1). Starts are lazy and happen on a plugin's thread, so the UI doesn't stall, but plugins that use Bun helpers
  answer their first event late.
- **Memory is where Bun is expensive.** Each Bun helper has 16 MB RSS against 1.8 MB for the Rust helper, so 50
  helpers take 816 MB against 88 MB (D2). Compiling with `bun build --compile` saves only 0.3–1.3 MB per process. On the
  host side the helpers are cheap: 1.6–3.3 MB of RSS for 50 (pipes and two threads each). A runtime with its
  namespace is 1.0 KiB of heap, and a runtime plus its compiled plugin is 4.2 KiB (G4).
- **Idle Bun helpers are not quite idle.** 50 Rust helpers used no measurable CPU over 5 s. 50 Bun helpers used
  230–360 ms per 5 s window, about 5–7% of one core or ~1 ms/s per helper, and this held in every window, not only
  right after activity (D5). A single idle Bun helper, checked separately over 40 s, used 30 ms of CPU (~0.75 ms/s),
  with or without `--smol` and compiled or not; `top` rounds it to 0.0%. That is small for one helper, but it grows
  with the number of helpers.
- **Failures are contained and fast.** When a helper crashes during a call, the plugin's promise rejects 0.14–0.6 ms
  after the crash request was sent. The diagnostic reads `bench.sleep: helper exited: exit status: 1` or
  `signal: 6 (SIGABRT)` (E1). The next call restarts the helper and answers in 1.2–1.3 ms (Rust) or 7.7–8.7 ms (Bun)
  (E2). Repeated crashes back off as designed (E2b). A per-call timeout of 100 ms rejects at 100–110 ms. The helper
  stays usable: it is the same pid, the next echo works, and its -32800 answer to the `$/cancel` arrives afterwards.
  When the run's own 250 ms limit ends the run first, dropping the call's future cancels the call in the same way (E3).
  A helper that never answers `initialize` fails each call after the 500 ms init timeout, and the third call is
  refused at once by the backoff (E4). The 500 ms wait happens on the plugin's thread.
- **Streaming is fast.** 1000 chunks arrive in 0.56 ms from Bun and 1.0 ms from the Rust helper (2.0 ms in run 1)
  (F). The Rust helper is slower because it flushes every line, so 1000 chunks are 1000 `write` calls; Bun's
  `process.stdout.write` coalesces them. Buffering until the end of a batch would fix the Rust helper.
- **A shared helper.** One helper serving all 50 plugins answers the echo fan-out in 0.47–0.52 ms, the same as or a
  little faster than 50 helpers (G1), at one process's memory: 2.2 MB for Rust and 38 MB for Bun, whose heap had grown
  during the rounds (G4). The 50 simultaneous first calls waited for one start and launched one process: 2.2 ms wall
  for Rust and 9.4 ms for Bun (G5). The catch is that a helper answers one request after another. With CPU-bound calls
  (`embed`, ~0.25 ms each), a shared helper takes 12.2–12.4 ms for the 50, against 1.3–1.4 ms with one helper per
  plugin (G1b). That is three quarters of a frame for every plugin's answer. A shared helper needs internal concurrency
  (a worker pool) if its calls are heavy.
- **Unused namespaces cost almost nothing.** Injecting 30 lazy namespaces that the run doesn't touch moves the event
  floor from 17.6 µs to 18.1–19.5 µs, or 15–65 ns per namespace across the two runs (G3). An unused namespace never
  starts its helper.

## Tables (run 2)

### A. Cold start: spawn → `initialize` result (30 samples; ms), then the first `echo` (µs)

| helper | first start (untimed) ms | init median ms | init p99 ms | init min ms | first echo median µs | first echo p99 µs | first echo min µs |
|---|---:|---:|---:|---:|---:|---:|---:|
| Rust | 1.3 | 1.01 | 1.19 | 0.95 | 15.8 | 23.0 | 13.5 |
| Bun | 8.9 | 7.84 | 8.06 | 7.72 | 61.5 | 68.1 | 48.9 |
| Bun (compiled) | 8.2 | 7.19 | 7.45 | 6.89 | 61.7 | 70.1 | 55.4 |

### B. Warm round trip, raw client, sequential (µs; 500 warm-up)

| helper | call | # timed | median | p99 | min |
|---|---|---:|---:|---:|---:|
| Rust | echo 99 B | 5000 | 12.1 | 18.2 | 6.5 |
| Rust | echo 10011 B | 5000 | 16.2 | 29.5 | 15.5 |
| Rust | embed 1000-byte text (5322 B reply) | 1000 | 249.0 | 274.0 | 241.1 |
| Bun | echo 99 B | 5000 | 26.2 | 35.9 | 11.3 |
| Bun | echo 10011 B | 5000 | 30.7 | 46.5 | 17.1 |
| Bun | embed 1000-byte text (5322 B reply) | 1000 | 259.0 | 296.0 | 239.5 |
| Bun (compiled) | echo 99 B | 5000 | 26.7 | 36.1 | 11.3 |
| Bun (compiled) | echo 10011 B | 5000 | 30.5 | 47.0 | 16.8 |
| Bun (compiled) | embed 1000-byte text (5322 B reply) | 1000 | 257.8 | 307.4 | 240.8 |
| (in process) | embed, Rust function call, no IPC | 1000 | 224.2 | 247.9 | 211.4 |

### C. Full path: one event of a compiled plugin (µs; 500 warm-up, 5000 timed; ~100 B text)

| helper | path | median | p99 | min |
|---|---|---:|---:|---:|
| (none) | baseline: `return { state, slots: { status: event.text } }` | 18.2 | 30.5 | 17.6 |
| (in-process pack) | event: `await bench.echo({ text })`, sync Rust echo | 19.0 | 31.0 | 18.3 |
| Rust | event: `await bench.echo({ text })`, return slots | 37.2 | 49.7 | 32.2 |
| Rust | same payload, raw client echo (no PsychoScript) | 11.2 | 17.0 | 6.3 |
| Bun | event: `await bench.echo({ text })`, return slots | 49.6 | 64.7 | 33.9 |
| Bun | same payload, raw client echo (no PsychoScript) | 24.2 | 34.5 | 9.7 |
| Bun (compiled) | event: `await bench.echo({ text })`, return slots | 49.6 | 64.0 | 34.8 |
| Bun (compiled) | same payload, raw client echo (no PsychoScript) | 24.0 | 34.1 | 10.3 |
| (never started) | bad params `{ text: 42 }` rejected and caught: `` bench.echo: echo needs a string `text` `` | 19.2 | 31.2 | 18.5 |

### D1. 50 helpers spawned in parallel: until all answered `initialize` (ms)

| helper | three trials | median |
|---|---:|---:|
| Rust | 10.1 / 13.9 / 15.4 | 13.9 |
| Bun | 46.5 / 45.9 / 43.3 | 45.9 |
| Bun (compiled) | 52.3 / 51.7 / 51.7 | 51.7 |

### D2. Memory of 50 helpers (`ps -o rss=`, MB)

| helper | median per helper | min | max | total | host RSS delta (pipes, 2 threads per helper) |
|---|---:|---:|---:|---:|---:|
| Rust | 1.8 | 1.8 | 1.8 | 87.5 | 3.3 |
| Bun | 16.3 | 16.3 | 16.5 | 816.2 | 1.6 |
| Bun (compiled) | 16.0 | 14.9 | 16.1 | 789.9 | 1.6 |

### D3/D4. One `echo` to all 50 helpers at once, until all answered (µs; 1000 rounds)

| helper | dispatch | median | p99 | min |
|---|---|---:|---:|---:|
| Rust | raw client | 180.0 | 208.0 | 149.4 |
| Rust | PsychoScript event, thread per plugin | 504.8 | 577.4 | 372.5 |
| Bun | raw client | 289.1 | 369.7 | 248.6 |
| Bun | PsychoScript event, thread per plugin | 621.6 | 1119.1 | 498.2 |
| Bun (compiled) | raw client | 288.8 | 378.0 | 245.4 |
| Bun (compiled) | PsychoScript event, thread per plugin | 602.2 | 1125.7 | 462.6 |

### D5. Idle CPU over 5 s (`ps -o time=`, 10 ms resolution per process)

| helper | window | 50 helpers CPU ms | % of one core | host CPU ms (readers, timer) |
|---|---|---:|---:|---:|
| Rust | first, right after the bursts | 0 | 0.00 | 20 |
| Rust | second | 0 | 0.00 | 0 |
| Bun | first, right after the bursts | 290 | 5.80 | 10 |
| Bun | second | 280 | 5.60 | 10 |
| Bun (compiled) | first, right after the bursts | 330 | 6.60 | 10 |
| Bun (compiled) | second | 270 | 5.40 | 10 |

### E1. Crash while a plugin awaits `bench.sleep({ ms: 2000 })`: crash request sent → run ended (5 samples, ms)

| helper | how | median ms | max ms | run's diagnostic | the crash call's error |
|---|---|---:|---:|---|---|
| Rust | exit | 0.28 | 0.32 | `ExecutionFailure: Error: bench.sleep: helper exited: exit status: 1` | `helper exited: exit status: 1` |
| Rust | abort | 0.14 | 0.17 | `ExecutionFailure: Error: bench.sleep: helper exited: signal: 6 (SIGABRT)` | `helper exited: signal: 6 (SIGABRT)` |
| Bun | exit | 0.57 | 0.71 | `ExecutionFailure: Error: bench.sleep: helper exited: exit status: 1` | `helper exited: exit status: 1` |
| Bun | abort | 0.22 | 0.23 | `ExecutionFailure: Error: bench.sleep: helper exited: signal: 6 (SIGABRT)` | `helper exited: signal: 6 (SIGABRT)` |
| Bun (compiled) | exit | 0.63 | 0.68 | `ExecutionFailure: Error: bench.sleep: helper exited: exit status: 1` | `helper exited: exit status: 1` |
| Bun (compiled) | abort | 0.21 | 0.23 | `ExecutionFailure: Error: bench.sleep: helper exited: signal: 6 (SIGABRT)` | `helper exited: signal: 6 (SIGABRT)` |

### E2. The next call after the crash: restart (spawn + initialize) + echo, ms

| helper | after | median ms | max ms | restarts |
|---|---|---:|---:|---:|
| Rust | exit | 1.21 | 1.44 | 1 |
| Rust | abort | 1.33 | 1.51 | 1 |
| Bun | exit | 8.63 | 8.77 | 1 |
| Bun | abort | 8.68 | 8.71 | 1 |
| Bun (compiled) | exit | 7.94 | 8.14 | 1 |
| Bun (compiled) | abort | 7.72 | 7.86 | 1 |

### E2b. Restart backoff (Rust helper crashed 6× in a row; echo retried every 5 ms)

| crash # | backoff ms | crash → echo answered ms | calls refused meanwhile | restarts | first refusal error |
|---|---:|---:|---:|---:|---|
| 1 | 0.0 | 1.2 | 0 | 1 |  |
| 2 | 100.0 | 103.6 | 14 | 2 | `helper restarting in 99 ms (helper exited: exit status: 1)` |
| 3 | 200.0 | 202.9 | 28 | 3 | `helper restarting in 199 ms (helper exited: exit status: 1)` |
| 4 | 400.0 | 401.4 | 54 | 4 | `helper restarting in 399 ms (helper exited: exit status: 1)` |
| 5 | 800.0 | 802.6 | 109 | 5 | `helper restarting in 799 ms (helper exited: exit status: 1)` |
| 6 | 1600.0 | 1607.0 | 217 | 6 | `helper restarting in 1599 ms (helper exited: exit status: 1)` |

### E3. `sleep { ms: 5000 }` cut short: time to rejection, and the helper afterwards

| helper | case | rejected after ms | outcome | next echo | same helper pid | late answers (helper's -32800) |
|---|---|---:|---|---|---|---:|
| Rust | per-call `timeoutMs: 100` | 110.2 | `ExecutionFailure: Error: bench.sleep: timed out after 100 ms` | ok (27 µs) | true | 1 |
| Rust | no call timeout, run's 250 ms limit | 250.9 | `TimeoutExceeded: Execution timed out after 250ms.` | ok (27 µs) | true | 1 |
| Rust | raw client, timeout 100 ms | 106.8 | `timed out after 100 ms` | ok (32 µs) | true | 1 |
| Bun | per-call `timeoutMs: 100` | 100.3 | `ExecutionFailure: Error: bench.sleep: timed out after 100 ms` | ok (48 µs) | true | 1 |
| Bun | no call timeout, run's 250 ms limit | 251.2 | `TimeoutExceeded: Execution timed out after 250ms.` | ok (161 µs) | true | 1 |
| Bun | raw client, timeout 100 ms | 100.2 | `timed out after 100 ms` | ok (148 µs) | true | 1 |
| Bun (compiled) | per-call `timeoutMs: 100` | 100.3 | `ExecutionFailure: Error: bench.sleep: timed out after 100 ms` | ok (134 µs) | true | 1 |
| Bun (compiled) | no call timeout, run's 250 ms limit | 260.1 | `TimeoutExceeded: Execution timed out after 250ms.` | ok (156 µs) | true | 1 |
| Bun (compiled) | raw client, timeout 100 ms | 106.1 | `timed out after 100 ms` | ok (101 µs) | true | 1 |

### E4. A helper that never answers `initialize` (`sleep 1000`, init timeout 500 ms): three calls in a row

| call # | failed after ms | error |
|---|---:|---|
| 1 | 509.0 | `initialize: timed out after 500 ms` |
| 2 | 510.9 | `initialize: timed out after 500 ms` |
| 3 | 0.0 | `helper restarting in 99 ms (initialize: timed out after 500 ms)` |

### F. `stream { n: 1000 }` through the raw client: start → final result, all chunks received (20 runs)

| helper | median ms | p99 ms | min ms | chunks/s (median) |
|---|---:|---:|---:|---:|
| Rust | 1.00 | 1.07 | 0.87 | 998586 |
| Bun | 0.56 | 0.72 | 0.54 | 1770824 |
| Bun (compiled) | 0.56 | 0.65 | 0.53 | 1800180 |

### G1/G2. One event to all 50 plugins at once, each awaiting `bench.echo`, thread per plugin (µs until all replied; 1000 rounds)

| helper | backing | median | p99 | min |
|---|---|---:|---:|---:|
| Rust | 50 helpers, one per plugin (D4) | 504.8 | 577.4 | 372.5 |
| Rust | 1 shared helper | 501.4 | 614.8 | 393.8 |
| Bun | 50 helpers, one per plugin (D4) | 621.6 | 1119.1 | 498.2 |
| Bun | 1 shared helper | 466.5 | 594.8 | 361.0 |
| Bun (compiled) | 50 helpers, one per plugin (D4) | 602.2 | 1125.7 | 462.6 |
| Bun (compiled) | 1 shared helper | 522.6 | 656.7 | 389.2 |
| (none) | in-process pack, one `Arc`, sync Rust echo | 252.0 | 319.8 | 216.8 |

### G1b. CPU-bound calls: one event to all 50 plugins, each awaiting `bench.embed` of 1000 bytes (ms until all replied; 100 rounds)

| helper | backing | median ms | p99 ms | min ms |
|---|---|---:|---:|---:|
| Rust | 50 helpers, one per plugin | 1.27 | 1.55 | 1.15 |
| Rust | 1 shared helper | 12.41 | 14.20 | 12.24 |
| Bun | 50 helpers, one per plugin | 1.44 | 2.27 | 1.27 |
| Bun | 1 shared helper | 12.22 | 14.84 | 11.93 |
| Bun (compiled) | 50 helpers, one per plugin | 1.39 | 2.22 | 1.27 |
| Bun (compiled) | 1 shared helper | 12.26 | 14.22 | 11.91 |

### G3. Event floor `return { state }` with N lazy namespace globals it does not use (µs; 5000 timed)

| # namespaces | median | p99 | min |
|---|---:|---:|---:|
| 0 | 17.58 | 28.29 | 17.00 |
| 1 | 17.75 | 18.96 | 17.17 |
| 10 | 18.21 | 28.96 | 17.42 |
| 30 | 19.54 | 29.88 | 17.58 |

### G4. Memory: one shared helper vs one per plugin (`ps -o rss=`, MB)

| helper | 1 shared helper | 50 helpers (D2 total) |
|---|---:|---:|
| Rust | 2.2 | 87.5 |
| Bun | 38.4 | 816.2 |
| Bun (compiled) | 37.0 | 789.9 |

Host heap (counting allocator): 50 runtimes + compiled plugins sharing one `bench` backing: 208.1 KiB live (4.16 KiB each); one runtime with its `bench` namespace alone: 1.01 KiB.

### G5. Lazy start of a shared helper: first `bench.echo` event (ms; cold = one plugin, 5 samples)

| helper | cold first event median | cold max | 50 first events at once: per-event median | per-event max | wall until all replied | processes started |
|---|---:|---:|---:|---:|---:|---:|
| Rust | 1.26 | 1.76 | 1.75 | 2.13 | 2.21 | 1 |
| Bun | 8.39 | 9.16 | 8.91 | 9.07 | 9.35 | 1 |
| Bun (compiled) | 7.84 | 8.10 | 8.37 | 8.47 | 8.83 | 1 |

## Variance between runs

Run 1 against run 2, for the same binary. Medians are within ~5% of each other except where listed below.

- C, Rust event with `bench.echo`: 38.8 µs in run 1, 37.2 µs in run 2. Bun: 49.1 and 49.6 µs.
- D1, 50 Rust helpers in parallel: 10.3–17.0 ms in run 1, 10.1–15.4 ms in run 2. In earlier development runs it was
  6.4–13 ms, so process spawn under load is the noisiest number here.
- D4, Rust: 526 µs in run 1, 505 µs in run 2. Bun: 580 and 622 µs, with a p99 of 1.1–1.2 ms in both runs.
- D5, Bun idle: 260–360 ms per 5 s window for 50 helpers, across both runs and all windows.
- F, Rust helper: 1.99 ms in run 1, 1.00 ms in run 2. Earlier runs gave 1.0–1.5 ms. Bun's 0.56–0.63 ms is steady.
- G3, 30 namespaces: 18.1 µs in run 1, 19.5 µs in run 2, against a 0-namespace floor of 17.4 and 17.6 µs.
- E3 "next echo" (a single call made right after 100–250 ms of idle) ranges from 27 to 520 µs. It is one sample per
  cell, and the cores may have clocked down during the idle time. B's warm numbers are the steady state.
