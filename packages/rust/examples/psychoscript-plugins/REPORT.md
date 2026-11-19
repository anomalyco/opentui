# Can psychoscript host plugins for OpenTUI Rust?

Pinned versions: psychoscript at 121bf797c3 (`codemode-rust` staging branch) and OpenTUI at 1cd69ea3a. The prototype
is this crate (`README.md`). The numbers are in `bench/RESULTS.md` and `examples/frame.rs`.

## Verdict

**Yes, integrable now, with no changes to either side, in the reducer model.** The prototype works with about 390
lines of glue code (`src/lib.rs`, without comments and tests) and a 45-line app:

- it loads plugins from a directory;
- it draws their status-bar and panel slots;
- it registers their commands and keys in the OpenTUI keymap;
- it feeds them key, command, resize and tick events;
- plugins call synchronous and asynchronous capabilities;
- a plugin's state survives reloads and failures;
- throws and infinite loops stay contained.

The UI thread pays 0.1–0.3 ms per frame with 3–50 plugins, against a 16.6 ms budget.

What is missing does not block a prototype, but it matters for a product. On the OpenTUI side:

- a slot registry;
- a data-driven view with a reconciler.

On the psychoscript side, two changes would each need a parity decision:

- a compute budget separate from wall time;
- a configurable memory limit.

**Long-lived plugins are not viable today.** A run has no GC, its timeout counts idle time, and a snapshot does not
survive a change to the source.

## Gaps

### Missing in psychoscript (each needs the same change in the TypeScript layer)

1. **Compile once, run many: now in psychoscript** (`Runtime::compile`, and `runtime.compile` in the TypeScript
   layer). The prototype compiles each plugin when it loads or reloads, so compile (about 12 µs per KB) is no longer
   paid per event: a 100 KB plugin's event went from 1.30 ms to 94 µs, a git-status event from 28 µs to 19 µs. A run
   still costs a fixed ~15 µs, mostly `Vm::setup` rebuilding the standard library; a built-ins realm shared across
   runs would remove most of it. Not blocking: a typical plugin event costs 17–240 µs.
2. **`Limits::timeout_ms` counts wall time from the start of the run.** That includes time spent awaiting async host
   calls, and time a long-lived run sits parked. `Vm::check_time` uses `start.elapsed()`. The README's "active time
   only" holds only across suspend and resume. In the prototype, a cold `git status` that took more than 100 ms timed
   the git plugin out like a runaway loop. Wanted: a compute (fuel or CPU) budget separate from a wall-clock deadline.
   A per-slice budget would also be needed for long-lived runs.
3. **No GC within a run, and a fixed heap cap.** A run keeps every object until it ends (`vm.rs`, `alloc`). The cap
   is a constant: 2 M objects and 4 M strings. It is not configurable and not reported. In the reducer model each
   event frees everything, and measured retention is about 1 KB per plugin. For long-lived runs it is fatal: a
   palette loop grew 46 KB per event and died after 9,614 events, at about 390 MB. Wanted: a memory limit in
   `Limits`, plus GC if long-lived runs are ever a goal.
4. **No interrupt handle.** Only dropping a `run_async` future cancels a run. A blocking `Program::run` cannot be
   stopped from another thread. The prototype relies on the timeout. Wanted: something like `Program::interrupter()`.
   This one is minor.

These are design facts, not gaps:

- Host functions must be `Send + Sync + 'static`, even for blocking single-threaded runs. That follows from the
  offload worker. OpenTUI widgets are `!Send`, so a capability can't touch them. Capabilities go through `AppProxy`,
  and UI facts reach plugins in the `event` data instead.
- A function in a result is silently dropped, as `JSON.stringify` does. A warning would help plugin authors.
- Small API friction: `ProgramOptions::bindings` takes ownership, so the host clones state every event. Suspending
  needs `.idempotent()` on the parked call.

### Missing in OpenTUI Rust

1. **No slot registry.** TypeScript Core has `createSlotRegistry` with:
   - ordering (`order`, then registration, then `id`);
   - the `append`, `replace` and `single_winner` modes;
   - `setup` and `dispose`;
   - a plugin-error buffer.

   Rust has none of this, so the prototype hard-codes two slots. A Rust `SlotRegistry` with the same model would serve
   Rust-native plugins too. It is the natural seam.
2. **No data-driven view or reconciler.** Rust widgets are retained objects with imperative setters. A plugin returns
   data, so the host needs a view vocabulary (text and spans, a list, a box) and a keyed diff into widgets. The
   prototype diffs per slot and supports text and line lists only. This is the largest piece of real work.
3. **No executor without the `tokio` feature.** Not a problem: threads plus `AppProxy` worked well. Async
   capabilities use a 25-line thread future.

Everything else fit without friction:

- `AppProxy::send`, with a bounded queue of 4,096 entries;
- `keymap`: a `Layer` per plugin, its `Disposer` on reload, and `commands(query)` for a future palette;
- timers, `on_resize`, and the console for plugin `console.log`;
- `TestApp::wait_until` for the end-to-end test.

### Just glue (done in the prototype)

- A worker thread per plugin, each with its own `Runtime`, fed by a bounded queue. Ticks are dropped while a plugin
  is busy. Replies go through `AppProxy::send`.
- Transactional state: a run that throws, times out or returns a malformed value commits nothing, and its status slot
  shows the error.
- A slot diff against what was last drawn. Commands become one keymap layer per plugin, which reaches its worker
  through a `Weak` host handle so that dropping a worker can join its thread.
- Reload swaps the source, keeps the state, and sends `{ type: "init", reload: true }`.

Glue not done yet:

- per-plugin capability sets: easy, a `Runtime` per plugin already exists;
- a manifest, and file watching;
- adding or removing plugins on reload;
- persisting state, which is plain JSON;
- follow-up events a plugin schedules for itself: the language has no timers, so the host would accept something
  like `{ after: ms, event }`;
- routing text input to one plugin;
- bounds on synchronous capabilities: a blocking host function is not covered by the timeout.

## Plugin model: reducer

|  | Reducer: a short run per event, `{ event, state }` → `{ state, slots, commands }` | Long-lived: `while (true) await app.nextEvent()` |
|---|---|---|
| State | Plain JSON the host owns. It can be inspected, persisted, and kept across failures | Closures and the stack inside a VM |
| Failure | Transactional. A bad event changes nothing | A throw or timeout kills the plugin and loses its state |
| Hot reload | Swap the source, keep the state | Lost: snapshots resume only with the source that saved them |
| Limits | The timeout and object cap apply per event | The timeout fires while idle (measured), and the heap only grows |
| Latency per event | 17–236 µs (compiled once per load) | 7–106 µs |
| Memory between events | About 1 KB plus the state | About 152 KB of heap per parked plugin, growing |
| Writing it | A switch on `event.type`. Explicit and testable as a pure function | Natural for sequential flows, but needs `setSlot`-style effects |

Use the reducer. It is the only shape that works with today's limits, snapshots, and reload. It matches the "programs
over data" rule in psychoscript's `AGENTS.md` and the conformance plugin reducer. It is also roughly as fast where it
matters: plugins run off the UI thread, and the UI thread's cost does not depend on the model. Example
(`plugins/git.js`):

```js
const refresh = async () => {
  const s = await app.git.status()
  return s.branch + (s.dirty ? " *" : "")
}
if (event.type === "init")
  return {
    state: { ticks: 0 },
    slots: { status: await refresh() },
    commands: [{ name: "git.refresh", title: "Refresh git status", key: "g" }],
  }
if (event.type === "command" && event.name === "git.refresh") return { slots: { status: await refresh() } }
if (event.type === "tick") return { state: { ticks: state.ticks + 1 } }
return {}
```

## Performance (Apple M5 Max, release builds, 60 fps budget 16.6 ms)

| What | Median | p99 | Share of 16.6 ms (median) |
|---|---:|---:|---:|
| Floor: `return 1`, compile included | 16.7 µs | | 0.1% |
| git-status event, tick or async command | 19–22 µs | 24–31 µs | 0.1% |
| Command palette provider, 200 commands, top 10 per key | 236 µs | 276 µs | 1.4% |
| List filter over 1,000 items: from a capability / in state / as a binding | 166 / 165 / 113 µs | 188 / 188 / 139 µs | 0.7–1.0% |
| 10 plugins per event, sequential / thread per plugin | 1.17 / 0.31 ms | 1.24 / 0.38 ms | 7% / 1.9% |
| 50 plugins per event, sequential / thread per plugin | 5.69 / 0.69 ms | 5.89 / 0.75 ms | 34% / 4.2% (off the UI thread) |
| Compile per plugin: 1 / 10 / 30 / 100 KB source, once per load or reload | 18 / 127 / 375 / 1,241 µs | | once |
| An event of a 1 / 10 / 30 / 100 KB plugin, compiled once / from source | 19 / 25 / 41 / 94 µs vs 37 / 150 / 405 / 1,297 µs | | up to 0.6% |
| First event in a process (cold) | 0.21–7.8 ms | | once |
| `Runtime` construction | 0.04 µs | | |
| Memory per reducer plugin between events | 1 KB plus state (97 KB with 1,000 items in state) | | 50 plugins: 120 KiB total |
| Peak heap during one event | 150–420 KiB, all freed | | |
| UI-thread cost per frame (dispatch + apply + render), 0 / 3 / 10 / 50 plugins | 0.10 / 0.11 / 0.15 / 0.32 ms | 0.12 / 0.13 / 0.18 / 0.39 ms | 0.6% / 0.7% / 0.9% / 1.9% |
| Of which plugin dispatch + apply, 3 / 50 plugins | 5 / 110 µs | 11 / 188 µs | 0.03% / 0.7% |
| End to end, key until every reply is ready, 3 / 50 plugins | 47 / 244 µs | 54 / 296 µs | under one frame |
| Runaway `while (true) {}` | stopped at the timeout (100 ms in the bench, 250 ms in the app) | | stalls only that plugin's thread; UI unaffected (test: keys handled in under 20 ms meanwhile) |

How these were measured:

- `cargo run --release -p psychoscript-plugins-bench`: 500 warm-up runs, then 5,000 timed events with `Instant`. A
  counting allocator measured memory and was switched off for timing. Medians varied under 10% across 3 runs.
- `cargo run --release --example frame -- 2000`: a 120x40 `TestApp` with the real glue and plugins. Each frame sends
  a key event to every plugin and waits, untimed, until all have replied. Then it times applying the replies and
  `render()`, which paints and presents.
- The frame numbers include the native renderer: 102 µs for this scene with no plugins.

## What to build next

1. **A Rust slot registry in `opentui`**, mirroring TypeScript Core: ordering, modes, `setup`/`dispose`, error buffer.
   The PsychoScript host then registers each plugin as a contribution, and Rust-native plugins use the same registry.
2. **A small view vocabulary with a keyed reconciler** (text and spans, list, box, with styles from theme tokens), so
   plugins can return more than strings. Keep it data only, and diff it on the UI thread.
3. **Glue hardening:**
   - per-plugin capability sets and a manifest;
   - file-watch reload, and adding or removing plugins;
   - persisted state;
   - host-scheduled follow-up events;
   - text-input capture for one plugin;
   - surfacing the keymap's `on_diagnostic`;
   - disabling a plugin after repeated failures.
4. **Propose to psychoscript, for both implementations:** a built-ins realm shared across runs (removes most of the
   15 µs that remain per event once a plugin is compiled once); a compute budget separate from the
   wall-clock timeout; and a configurable memory limit. Long-lived plugins would additionally need GC and per-slice
   budgets. Revisit only if a plugin needs a sequential flow the reducer makes awkward.
