# PsychoScript plugins for OpenTUI Rust (prototype)

An OpenTUI Rust app that loads `.js` plugins from a directory and runs them with the pure-Rust
[PsychoScript](../../../../../psychoscript-rs-pin/packages/codemode-rust) language crate, with no JavaScript engine.
Plugins add text to the status bar and panels, register commands with key bindings, react to key, command, resize,
and tick events, and call app capabilities, both synchronous and asynchronous. A plugin that throws or loops forever
does not freeze the UI. `REPORT.md` has the findings; `bench/RESULTS.md` has the measurements.

This crate is its own Cargo workspace, outside `packages/rust`'s, because it depends on a psychoscript checkout by
path (`../psychoscript-rs-pin/packages/codemode-rust` next to this repository) and on Rust 1.100.

```sh
bun run build:native          # in packages/core, once (needs Zig 0.17.1)
cargo run --release -- plugins
cargo test --release
cargo run --release --example frame        # UI-thread cost per frame with 0/3/10/50 plugins
cargo run --release -p psychoscript-plugins-bench
```

Keys: `g` refreshes git, `f` cycles the file filter, `t` makes `bad` throw, `l` makes it loop forever, `ctrl+r`
reloads every plugin's source and keeps its state, `` ` `` toggles the console (plugin `console.log` output and
errors), and `ctrl+q` quits.

## The plugin model (reducer)

A plugin's program is compiled once when it loads or reloads (`Runtime::compile`), and each event runs it once. The
program gets two read-only bindings, `event` and `state`, and the `app` global. It returns plain data:

```js
// plugins/git.js
const refresh = async () => {
  const s = await app.git.status() // async capability: a promise, resolved off the plugin's thread
  return s.branch + (s.dirty ? " *" : "")
}
if (event.type === "init") {
  return {
    state: { ticks: 0 },
    slots: { status: await refresh() },
    commands: [{ name: "git.refresh", title: "Refresh git status", key: "g" }],
  }
}
if (event.type === "command" && event.name === "git.refresh") return { slots: { status: await refresh() } }
if (event.type === "tick") return { state: { ticks: state.ticks + 1 } }
return {}
```

- Events: `{ type: "init", reload? }`, `{ type: "key", key }` (keys no command took), `{ type: "command", name }`,
  `{ type: "resize", width, height }`, `{ type: "tick", now }`.
- Return: `state` replaces the state; leave it out to keep it. `slots.status` is text; `slots.panel` is
  `{ title, lines }`, or `null` to hide it. `commands` replaces the plugin's keymap layer. Leave out what did not
  change.
- `app`: `now()` and `files(limit)` (synchronous), `git.status()` and `sleep(ms)` (asynchronous).
- A run that throws, times out (250 ms of wall time, host waits included), or returns something else leaves the state as it was. The plugin's status
  shows the error.

## Layout

- `src/lib.rs`: the glue. `step` runs one event; `Worker` is a plugin's thread; `Host` holds the slots, the diffing,
  and the keymap layers on the UI thread.
- `src/main.rs`: the app, plus a `TestApp` test of slots, commands, throw, loop, and reload.
- `plugins/`: `git`, `filter` (a filter over up to 1,000 repository files), `keys` (clock, size, last key), and `bad`.
- `examples/frame.rs`: frame-time impact. `bench/`: the engine benchmarks.
