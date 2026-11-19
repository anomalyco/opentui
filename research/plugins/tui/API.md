# TUI plugin API v0

The plugin API for the Rust OpenCode TUI, built on OpenTUI Rust. Plugins are PsychoScript reducers: each event runs
the plugin once with `{ event, state }`, and it returns `{ state, commands, slots, effects }`. Existing plugins get
rewritten; nothing here is compatible with the TypeScript plugin API.

The choices below rest on two sources:

- **[R]** the research in `./TOP100.md` (73 TUI plugins, the `#` column) and `./HOST-API.md` (38 functions, events,
  slots, blockers);
- **[P]** the prototype and its measurements on branch `psychoscript-plugins`
  (`packages/rust/examples/psychoscript-plugins`: `REPORT.md`, `bench/RESULTS.md`, Apple M5 Max, release builds).

## 0. The rules everything else follows

1. **Reads are calls, writes are effects.** Inside a run, a plugin calls host functions only to read. Everything
   that changes the world is returned as data in `effects`, which the host runs only after the run succeeds. The
   prototype's runs are transactional, a throw or timeout committing nothing [P]; effects extend that to side effects.
2. **No run waits on slow work.** A plugin's events run one at a time, so a run awaiting a 2 s `git push` stalls all
   of that plugin's later events, and psychoscript's timeout counts the wait: a cold `git status` timed out the
   prototype's git plugin [P]. Slow work (processes, network, sidecars) is an effect whose result comes back as an
   event.
3. **The host owns every lifetime.** Timers, watches, processes, streams and sidecars end when the plugin unloads. A
   reducer can't hold a loop, and host-owned lifetimes absorb the TUI's "background" blocker [R]. Long-lived plugins
   were measured and rejected [P]: the timeout fires while idle, the heap only grows, and snapshots don't survive a
   source change.
4. **Data in through bindings, not calls.** Host context arrives as a read-only binding, the cheapest way in: a
   1,000-item list costs 113 µs as a binding against 166 µs through a call [P]. This replaces the vague `state.read`
   (12 of 73 plugins).

## 1. Package and manifest

A plugin is a directory with `plugin.json` and one entry `.js` file. The language has no modules, so authors bundle
their own code into that file.

```json
{
  "id": "acme.git-status",
  "version": "1.2.0",
  "api": 0,
  "entry": "main.js",
  "title": "Git status",
  "events": ["session.switched", "file.changed"],
  "capabilities": {
    "fs.read": ["workspace:**"],
    "exec": ["git"],
    "net": ["api.github.com"],
    "secrets": ["github"]
  },
  "packs": { "fuzzy": "^1" },
  "sidecars": {},
  "settings": {
    "showAhead": { "type": "boolean", "default": true, "title": "Show commits ahead" },
    "refreshSec": { "type": "integer", "default": 10, "minimum": 2 }
  },
  "limits": { "computeMs": 20, "memoryMb": 16 }
}
```

- **`id`** (`[a-z0-9-]+(\.[a-z0-9-]+)+`) namespaces commands (`acme.git-status/refresh`), store, state and config.
  **`api`** is this API's major version; the host refuses majors it doesn't implement.
- **`events`** are subscriptions (§3); **`limits`** are requests the host caps (§2).
- **`settings`** is a JSON Schema subset (`type`, `default`, `enum`, `minimum`/`maximum`, `title`, `description`).
  The host renders the form, validates it, and passes the values to every run as the `settings` binding.

**Grants.** Capabilities use the research's classes: `read`, `write`, `exec`, `network`, `secret` [R]. `ui`,
`store`, `timer`, `clipboard.write` and reads under `plugin:` need no grant. On enable, and when an update asks for
more, the host shows the requests; the user grants all, some, or none. A denial doesn't fail the load: the function
throws `Failure` of kind `CapabilityDenied` and the effect completes with `ok: false`, so plugins degrade instead of
crashing.

**Per-user config** lives in `~/.config/opencode/tui.json`:

```json
{
  "plugins": {
    "acme.git-status": {
      "enabled": true,
      "grants": { "exec": ["git"] },
      "settings": { "refreshSec": 30 },
      "keys": { "refresh": "ctrl+g" }
    }
  }
}
```

Project config (`.opencode/tui.json`) may enable already-trusted plugins and change settings, but never grant: a
cloned repository must not give itself `exec`. Project plugins (`.opencode/plugins/`) load only in a trusted
workspace. Installing is a user action (`opencode plugin add <spec>`): download, check the registry's `sha256`, unpack
into `<data>/plugins/<id>/<version>/`. Hence no `install.plugin` (§5).

## 2. Lifecycle

| Step     | What happens                                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discover | Validate `plugin.json` (`id`, `api`, `entry`, schema, capabilities). An invalid plugin is listed as broken with its diagnostic, never half-loaded.                                                                            |
| Compile  | `Runtime::compile` once per load or reload, about 12 µs per KB: a 100 KB plugin's event takes 94 µs instead of 1.3 ms compiling per event [P]. A `ParseError` disables a new plugin; on reload the old program keeps running. |
| Init     | `{ type: "init", reason: "load" \| "reload" \| "upgrade", from? }` with the persisted state or `null`; `from` lets an upgrade migrate state.                                                                                  |
| Run      | Events FIFO, one at a time per plugin (§3, §8).                                                                                                                                                                               |
| Reload   | Compile, then `init` with `reload` or `upgrade`. State is kept; commands, slots and subscriptions are replaced by what `init` returns.                                                                                        |
| Unload   | Drop the plugin's slots, keymap layer, timers, watches, processes and sidecars. No unload event: state is already persisted and nothing is left to clean up.                                                                  |

**State.** State is plain JSON, replaced whole by `state` and kept when it is left out. The host writes it, debounced,
to `<data>/plugin-state/<id>.json`. The cap is 1 MiB. Bigger data goes to `store` (§5) or a pack. This answers the
research's "large-state" blocker [R].

**Errors.** A run that throws, hits a limit or returns a malformed value commits nothing [P]; the error shows in the
plugin manager and a rate-limited toast. After 5 failures in a row, or 3 limit hits in 60 s, the plugin is suspended
until re-enabled or reloaded.

**Limits per event.** Defaults are given first, then the host maximum:

| Limit       | Default / max    | Notes                                                                                |
| ----------- | ---------------- | ------------------------------------------------------------------------------------ |
| `computeMs` | 20 / 100 ms      | VM time only: excludes awaits on host functions. Runaway loops stop here.            |
| `wallMs`    | 1,000 / 5,000 ms | The whole run, including awaits. Calls are fast reads (§5), so this is a safety net. |
| `memoryMb`  | 16 / 64 MiB      | Live heap of the run.                                                                |
| Result      | 256 KiB          | JSON size of the return value.                                                       |
| Effects     | 64 per run       |                                                                                      |
| Queue       | 256 events       | Overflow policy in §3.                                                               |

**Compute and wall time must be separate.** psychoscript has one wall-clock `timeout_ms` and a fixed 2 M-object cap
[P]. v0 needs, in both language implementations, a compute budget (fuel-based: the VM already meters fuel) and a
configurable memory limit on top of the coming GC. Until then the host maps `wallMs` to `timeout_ms` and approximates
`computeMs` as wall time minus the host time it measured in calls; rule 2 keeps that gap small.

## 3. Events

Every event carries `type`, `seq` (per plugin) and `time`. The `ctx` binding is the host snapshot taken when the event
was dispatched (§5).

| Event               | Payload                                                                             | Fired when                                       | Coalesce                     | Research               |
| ------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------- | ---------------------- |
| `init`              | `reason, from?`                                                                     | load, reload, upgrade                            | —                            | all 73                 |
| `command`           | `name, args?, source: "key"\|"palette"\|"slash"\|"effect"`                          | a command of this plugin runs                    | no                           | ~45                    |
| `key`               | `key, modifiers`                                                                    | a key that no command or focused element claimed | no                           | ~30                    |
| `keymap.pending`    | `sequence, candidates[{key, command, title}]`                                       | a key sequence is half-typed                     | latest                       | which-key #27          |
| `ui`                | `slot, key, action: "select"\|"submit"\|"change"\|"click"\|"close", value?, index?` | an element of this plugin's view is used         | `change`: latest per element | pickers #12, dialogs   |
| `prompt.changed`    | `text, cursor, sessionId`                                                           | the prompt text changes                          | latest                       | snippets #70, ~6       |
| `prompt.submitted`  | `text, sessionId`                                                                   | a prompt is sent                                 | no                           | mem0 #3                |
| `message.rendered`  | `sessionId, messageId, role, text`                                                  | a message is rendered in the transcript          | no (batched)                 | ~6                     |
| `session.switched`  | `id, prevId`                                                                        | the active session changes                       | latest                       | ~8                     |
| `session.status`    | `id, status: "idle"\|"busy"\|"error", agent?`                                       | the server reports progress                      | latest per id                | slim #21, ensemble #63 |
| `selection.changed` | `slot, key, indices, items`                                                         | a list cursor moves                              | latest                       | ~10                    |
| `focus.changed`     | `target, prev`                                                                      | focus moves between slots or widgets             | latest                       | ~8                     |
| `resize`            | `width, height`                                                                     | the terminal is resized                          | latest                       | ~10                    |
| `theme.changed`     | `mode, name`                                                                        | the theme changes                                | latest                       | catppuccin #40         |
| `settings.changed`  | `changed[]`                                                                         | the user edits this plugin's settings            | latest                       | —                      |
| `timer`             | `id, now, late`                                                                     | a timer the plugin set fires                     | per id                       | ~15                    |
| `file.changed`      | `watchId, paths[], kinds[]`                                                         | a watch fires                                    | merge paths                  | ~6                     |
| `effect`            | `id, ok, value?, error?`                                                            | an effect with an `id` completes                 | no                           | host completions       |
| `stream`            | `id, chunks[], done, code?`                                                         | output from a streaming effect                   | merge chunks                 | opencode-pty #54, ~6   |
| `sidecar`           | `sidecar, method, params`                                                           | a sidecar sends a notification                   | no                           | §6                     |

`init`, `command`, `ui`, `effect`, `stream`, `timer` and `sidecar` always arrive: they answer something the plugin
started. The rest need a subscription, so 50 plugins don't all run on every key. Left out: raw mouse (only element
`click`), and editor-buffer events, since the TUI has a prompt and a transcript but no code buffer (#16, #24, #26 wait
for one).

Delivery rules:

- **Per plugin:** strict FIFO, one run at a time. The `ctx` of each event is consistent with its moment.
- **Coalescing:** events of a "latest" kind replace an older queued event of the same kind (and, where given, the same
  key) while the plugin is busy. `file.changed` merges paths; `stream` merges chunks, flushed at most every 16 ms. So
  typing at 30 keys/s into a plugin that takes 40 ms per run gives it about 25 runs/s, not a growing queue. This
  extends the prototype's dropping of ticks while busy [P].
- **Overflow:** at 256 queued events, coalescable events go first. If the queue is still full, `key` events are
  dropped and the plugin is flagged as lagging. `command`, `effect` and `ui` events are never dropped.
- **Across plugins:** no ordering between plugins. Replies are applied in arrival order. What the screen shows is
  deterministic anyway: each slot orders contributions by `order`, then registration, then `id`, as TypeScript
  `createSlotRegistry` does.
- **Keys are decided synchronously on the UI thread.** Replies arrive 47–244 µs later [P], too late to consume a
  key, so plugins claim keys only through command bindings (§4) or a focused `input`/`list`; `key` events report
  unclaimed keys.

## 4. Returns

```ts
{ state?, commands?, slots?, effects?, context? }
```

Any field left out keeps its previous value, except `effects`, which runs once.

### `commands`: replaces the plugin's command layer

```js
commands: [
  {
    name: "refresh",
    title: "Git: refresh status",
    key: "g r",
    when: { focus: "sidebar", busy: false },
    palette: true,
    slash: "git-refresh",
    category: "Git",
  },
]
```

- Names are local; the host qualifies them as `<id>/<name>`. `palette` and `slash` expose the command by its title,
  as in HOST-API's return shape [R].
- **`when` is data, not code**: it is checked on the UI thread for every key. It maps onto the Rust keymap's
  `Layer::require` and `Layer::target`, over `focus`, `mode`, `busy`, `sessionId` and the plugin's own flags, which it
  sets with `context: { picking: true }` (keymap data `<id>.picking`).
- User overrides from `tui.json` win; plugin layers rank below built-ins; conflicts surface through the keymap's
  `on_diagnostic` in the plugin manager.

### `slots`: views by slot name; `null` removes the contribution

| Slot                                             | Mode                                   | Shape                                 | Research                        |
| ------------------------------------------------ | -------------------------------------- | ------------------------------------- | ------------------------------- |
| `statusbar.left` / `statusbar.right`             | append                                 | inline (text or spans)                | ~22 status bars                 |
| `sidebar`                                        | append, one section per plugin, titled | view                                  | ~6 trees and skills, ~10 panels |
| `sidebar.footer`, `home.footer`, `prompt.footer` | append                                 | inline or row                         | OpenCode built-ins ~8           |
| `prompt.right`                                   | append                                 | inline (prompt adornments)            | home.prompt_right               |
| `message.decoration`                             | append per message                     | `{ [messageId]: inline }`             | mem0 and notifier markers       |
| `panel`                                          | single winner, user-switchable         | view                                  | git, diff and debug panels ~10  |
| `preview`                                        | single winner                          | view (`code`, `image`)                | yazi, telescope, tfm ~4         |
| `dialog`                                         | stack, modal, top one focused          | view, `{ title, body, width? }`       | lazygit, noice, prompts ~8      |
| `palette`                                        | append                                 | `list` items `{ key, label, detail }` | dynamic palette providers       |

Decorations exist only for rendered messages (`message.rendered`). A picker (telescope #12) is a `dialog` with an
`input` and a `list`: typing sends coalesced `ui change` events, and the plugin returns the filtered list.

### The view format

Plain JSON, kept small, with styles from theme tokens only:

```
Node   = Inline | Box | List | Table | Input | Progress | Image | Code | Markdown | Spinner
Inline = string | Span[] | { type: "text", spans: Span[], wrap?: "word" | "none" | "char", key? }
Span   = string | { text, fg?, bg?, bold?, italic?, underline?, dim?, link? }     // fg/bg: theme token names
Box    = { type: "row" | "column" | "box", children: Node[], key?, gap?, padding?, grow?, width?, height?,
           border?: "single" | "rounded" | "none", title?, align?, justify? }
List   = { type: "list", key, items: [{ key, label: Inline, detail?: Inline, icon? }], selected?, height? }
Table  = { type: "table", key, columns: [{ title, width?, align? }], rows: [{ key, cells: Inline[] }], selected? }
Input  = { type: "input", key, placeholder?, initial?, reset? }
Progress = { type: "progress", value: number | null, label? }          // null: indeterminate
Image  = { type: "image", ref, width?, height?, alt }                  // ref from fs.preview or a pack
Code   = { type: "code", text, lang?, lineNumbers? }                   // highlighted by the host's tree-sitter
Markdown = { type: "markdown", text }
Spinner  = { type: "spinner", label? }
```

- **Theme tokens only** (`accent`, `muted`, `error`, …): themes stay coherent and plugins can't imitate host chrome.
- **`spinner`, `code`, `markdown`**: the host animates and highlights them, where a plugin spinner would cost a run per
  frame; OpenTUI Rust already has `Code`, `Markdown`, `Select`, `Table` and `Input` widgets.
- **Keyed diffing.** Children match by `key`, else by index; same key and type updates in place, keeping host-owned
  state (list cursor, scroll, input text). Interactive nodes need a key, since `ui` events name them. An unchanged
  slot is skipped, as in the prototype [P]. Caps: 2,000 nodes per slot, 10,000 virtualized list items.
- **Uncontrolled inputs.** The host owns the text; the plugin gets coalesced `change` events and sets text only with
  `initial` or `reset`. A controlled input through an off-thread reducer would drop keystrokes whenever it lags.

### `effects`: run in order after the run commits

| Effect                                         | Fields                                                                             | Class       | Completion                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------- |
| `toast`                                        | `message, kind?: "info"\|"success"\|"warning"\|"error"`                            | ui          | —                                                          |
| `notify`                                       | `title, body, sound?`                                                              | ui          | — (desktop notification, rate-limited)                     |
| `clipboard.copy`                               | `text`                                                                             | ui          | —                                                          |
| `open.url`                                     | `url`                                                                              | ui          | — (needs confirmation for non-https or unknown hosts)      |
| `open.file`                                    | `path, line?`                                                                      | read        | —                                                          |
| `command.run`                                  | `name, args?`                                                                      | ui          | built-in or another plugin's command                       |
| `prompt.edit`                                  | `op: "insert"\|"replace", text, range?`                                            | write       | `editor.edit` for the prompt (snippets #70)                |
| `session.switch`                               | `id`                                                                               | ui          | —                                                          |
| `store.set` / `store.delete`                   | `key, value?`                                                                      | —           | —                                                          |
| `timer.every` / `timer.after` / `timer.cancel` | `id, ms`                                                                           | —           | `timer` events (minimum 250 ms)                            |
| `fs.watch` / `fs.unwatch`                      | `id, paths: glob[]`                                                                | read        | `file.changed` events                                      |
| `fs.write` / `fs.remove`                       | `id?, path, data?`                                                                 | write       | `effect`                                                   |
| `shell.run`                                    | `id, argv[], cwd?, env?, input?, stream?, timeoutMs?`                              | exec        | `effect {code, stdout, stderr}`, or `stream` then `effect` |
| `process.kill`                                 | `id`                                                                               | exec        | —                                                          |
| `net.request`                                  | `id, url, method?, headers?, body?, timeoutMs?`                                    | network     | `effect {status, headers, body}`                           |
| `git`                                          | `id, op: "stage"\|"unstage"\|"commit"\|"checkout"\|"branch"\|"push"\|"pull", args` | write+exec  | `effect`                                                   |
| `sidecar.call`                                 | `id, sidecar, method, params`                                                      | per sidecar | `effect`                                                   |

An example that brings these together (`main.js`):

```js
const view = (s) => [{ text: s.branch, fg: "accent" }, s.dirty ? { text: " *", fg: "warning" } : ""]
switch (event.type) {
  case "init":
    return {
      state: { branch: "…", dirty: false },
      commands: [{ name: "refresh", title: "Git: refresh", key: "g r", palette: true }],
      effects: [{ type: "timer.every", id: "poll", ms: settings.refreshSec * 1000 }],
      slots: { "statusbar.left": view({ branch: "…" }) },
    }
  case "timer":
  case "command":
  case "file.changed": {
    const s = await git.status() // fast, cached host read
    return { state: s, slots: { "statusbar.left": view(s) } }
  }
}
return {}
```

## 5. Host functions (reads inside a run)

The bindings in every run: `event`, `state`, `settings`, and `ctx`.

```
ctx = { now, size: {width, height}, theme: {mode, name}, focus, mode, busy,
        session: {id, title, agent, model} | null, workspace: {root, name},
        plugin: {id, version, dataDir: "plugin:"} }
```

`ctx` replaces `state.read` and the `status` broadcast [R]. It is small, about 1 KB, and costs about 1 µs as a
binding [P].

The globals are namespaces. A call to an ungranted function throws `CapabilityDenied`. `async` functions are awaited
inside the run, are capped by the host at 250 ms, and count toward `wallMs` but not `computeMs`.

| Function                   | Signature                                                                     | Kind       | Class          | From HOST-API               |
| -------------------------- | ----------------------------------------------------------------------------- | ---------- | -------------- | --------------------------- |
| `fs.read`                  | `(path, {maxBytes?=1MiB, encoding?: "utf8"\|"bytes"}) → string \| Uint8Array` | async      | read           | `fs.read`                   |
| `fs.list`                  | `(dir, {glob?, depth?=1, limit?=10k}) → {name, path, isDir, size, mtime}[]`   | async      | read           | `fs.list`, `fs.stat` merged |
| `fs.stat`                  | `(path) → {size, mtime, isDir} \| null`                                       | sync       | read           | `fs.stat`                   |
| `fs.preview`               | `(path, {range?, width?}) → Node` (`code` or `image`)                         | async      | read           | `fs.preview`                |
| `git.status`               | `() → {branch, dirty, ahead, behind, files: [{path, status}]}`                | async      | read           | `git.status`                |
| `git.diff`                 | `({path?, base?, ref?, staged?}) → {files: [{path, hunks}]}`                  | async      | read           | `git.diff`                  |
| `git.log`                  | `({path?, line?, limit?=50}) → commits[] \| blame`                            | async      | read           | `git.history`               |
| `session.list`             | `({limit?}) → {id, title, updated, cost}[]`                                   | async      | read           | `session.list`              |
| `session.messages`         | `(id, {limit?, before?}) → {id, role, text}[]`                                | async      | read           | new (mem0-style status)     |
| `lsp.query`                | `(kind: "diagnostics"\|"definition"\|"references"\|"symbols", args) → result` | async      | read           | `lsp.query`                 |
| `clipboard.read`           | `() → string \| null`                                                         | async      | read (granted) | `clipboard.get`             |
| `store.get` / `store.list` | `(key) → Json \| null` · `(prefix) → string[]`                                | sync       | —              | `store.get`                 |
| `pack.<name>.<fn>`         | per pack (§6)                                                                 | sync/async | per pack       | `install.tool`              |

**Kinds:** `sync`, `async`, and `durable`, the last being an effect that completes as events (`shell.run`,
`net.request`, `fs.watch`, timers): host-level tasks, not psychoscript's `DurableFunction`, since a reducer never
suspends.

How the 38 research functions map onto this API:

| Research functions                                                             | Where they went                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `state.read`                                                                   | `ctx`                                                             |
| `fs.write`, `fs.remove`, `clipboard.set`, `ui.toast`, `ui.notify`, `store.set` | effects                                                           |
| `git.apply`                                                                    | the `git` effect                                                  |
| `shell.run`, `shell.stream`                                                    | the `shell.run` effect, with `stream`                             |
| `net.request`                                                                  | an effect: network latency would hold the plugin's queue (rule 2) |
| `timer.every`, `timer.after`, `fs.watch`                                       | effects                                                           |
| `ui.dialog`                                                                    | the `dialog` slot                                                 |
| `editor.edit`                                                                  | the `prompt.edit` effect                                          |
| `session.save`, `session.restore`                                              | `store`, plus the `session.switch` and `command.run` effects      |
| `store.memory`                                                                 | `state`, which survives reloads                                   |

Dropped: `install.plugin` (a user action; lazy.nvim and tpm, #11 and #14, become host features), `install.tool`
(packs and sidecars install with the plugin), `net.listen`, `net.subscribe`, `ui.annotate` and `dap.*` (long-lived
servers are sidecars, §6), `lsp.start` (host configuration), `editor.snippet` (plugin data).

What is left is 13 read functions and 22 effect types.

## 6. Native dependencies

The research's native blockers are:

- tree-sitter (#15, #34, basemind);
- fuzzy matching (the fzf family, #12);
- LSP and DAP servers (#16, #28);
- embeddings and LanceDB (opencode-mem, OpenCodeRAG);
- a Go binary (deja-vu);
- CLIs (lazygit- and k9s-style commands).

| Option                                                            | Fits                                                                                                                                                       | Against                                                                                                                                                                                                 | Verdict                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| (a) Capability packs: Rust, in the host, declared in the manifest | tree-sitter (OpenTUI Rust already bundles grammars and `syntax::register`); fuzzy matching over host-held lists (the large-state blocker); LSP client; git | Only what we ship, and it grows the binary                                                                                                                                                              | **Yes, a few**                                |
| (b) Sidecars: processes over stdio JSON-RPC, like LSP and MCP     | Go binaries, Python/Node services (embeddings, LanceDB), DAP, local HTTP UIs (plannotator #18, llm-proxy #71), anything long-lived                         | Per-platform artifacts; startup measured in ms; process sandboxing differs per OS                                                                                                                       | **Yes**                                       |
| (c) Sandboxed WebAssembly                                         | Portable, sandboxed compute                                                                                                                                | Needs a large runtime dependency (wasmtime) or a slow interpreter. WASI has no GPU, no threads, no LanceDB. PsychoScript already handles the compute we measured: a 1,000-item filter in 113–166 µs [P] | **Not in v0**; revisit for heavy pure compute |
| (d) Native dynamic libraries                                      | Speed                                                                                                                                                      | No sandbox, ABI churn, a crash kills the TUI, supply-chain risk                                                                                                                                         | **Rejected**                                  |

**Packs in v0:**

- `syntax`: `parse`, `query` and `highlight`, wrapping `opentui::syntax`;
- `fuzzy`: `index(id, items)` once, then `match(id, query, limit)` per keystroke, so 100k file names never cross the
  boundary per event;
- `lsp`, which backs `lsp.query`;
- `git`, which backs the `git.*` reads.

A plugin declares packs as `"packs": { "fuzzy": "^1" }`. A missing or incompatible pack disables the plugin with a
diagnostic. Calls look like `pack.fuzzy.match("files", event.value, 50)`.

Embeddings and vector search are not a TUI pack. The research puts them on the server half of "Both" plugins, and
the TUI half only shows status and commands [R].

**Sidecars** are declared in the manifest:

```json
"sidecars": {
  "dejavu": {
    "protocol": "jsonrpc-stdio",
    "command": ["${bin}/deja-vu", "serve", "--stdio"],
    "artifacts": {
      "darwin-arm64": { "url": "https://…/deja-vu-darwin-arm64", "sha256": "…" },
      "linux-x64":    { "url": "…", "sha256": "…" }
    },
    "idleStopSec": 300
  }
}
```

The host downloads the platform's artifact at install, refuses one without a matching `sha256`, and stores it in
`<data>/plugins/<id>/<version>/bin/` (`${bin}`). A sidecar starts on first call, stops after `idleStopSec`, dies on
unload, and counts as an `exec` grant ("runs deja-vu"). Calls go only through the `sidecar.call` effect; its
notifications arrive as `sidecar` events. Plain CLIs need no sidecar: `shell.run` with `exec: ["lazygit"]`.

## 7. Security model

- **Gating.** Every host function and effect has a class (§5) and is checked against the user's grants on each call,
  not at load. Projects can't grant (§1).
- **Paths.** Grants are globs over virtual roots: `workspace:` (the session's workspace), `plugin:` (the plugin's data
  directory, always granted), `home:` (explicit globs only). The host checks the canonical path, so symlinks can't
  escape, and refuses writes to `.git/` (git goes through the `git` effect).
- **Exec.** `argv` only, no shell string. The basename must be in `exec`, resolved through `PATH` at grant time; the
  environment is scrubbed to `PATH`, `HOME`, `LANG` and the declared `env`; the working directory stays under
  `workspace:` or `plugin:`.
- **Network.** A host allowlist (optional port and path prefix), https unless granted otherwise, loopback and private
  ranges refused unless granted (no SSRF into local services), 10 MiB responses, timeouts.
- **Secrets** live in the OS keychain by name. A plugin never reads one; it references it in a `net.request` header,
  `{ "secret": "github", "format": "Bearer {}" }`, or a sidecar's `env`. The host substitutes it and redacts it from
  logs and results.
- **UI integrity.** Dialogs carry the plugin's name; permission prompts are host-only and drawn above plugin layers;
  `notify`, `toast` and `open.url` are rate-limited. Limits (§2) and queue caps (§3) bound CPU, memory and backlog.
- **Not covered:** sidecars run with the user's rights; OS sandboxing (Seatbelt, Landlock) is open.

## 8. Performance budget

Measured [P], with plugins compiled once:

| Measurement                                                          |             Median |        p99 |
| -------------------------------------------------------------------- | -----------------: | ---------: |
| Event floor                                                          |              15 µs |            |
| git-status event                                                     |           19–22 µs |   24–31 µs |
| 1,000-item filter                                                    |         113–166 µs | 139–188 µs |
| 200-command palette                                                  |             236 µs |     276 µs |
| 50 plugins, one event each, sequential on one thread                 |            5.69 ms |            |
| 50 plugins, one event each, one thread per plugin                    |            0.69 ms |    0.75 ms |
| UI-thread cost per frame with 50 plugins (dispatch + apply + render) |            0.32 ms |    0.39 ms |
| Memory between events                                                |       1 KB + state |            |
| Peak heap during one event                                           | 150–420 KiB, freed |            |

The budget per 16.6 ms frame:

- **Plugins never run on the UI thread**, which only dispatches and applies replies (110 µs at 50 plugins), and
  applies at most 2 ms of replies per frame, deferring the rest.
- **Target ≤ 1 ms per event**; the host warns above 4 ms and stops at `computeMs` (20 ms default).
- **Subscriptions and coalescing (§3)** cut fan-out: a key reaches only `key` subscribers.
- **A worker pool** of `min(cores − 2, 8)`, each plugin an actor on it, instead of the prototype's thread per plugin:
  50 × ~100 µs / 8 ≈ 0.6 ms, the same latency without 50 threads. To be measured (open question 2).
- **Memory:** about 50 × (1 KB + state) at rest; pool size × ~0.5 MiB at peak.

## 9. What OpenTUI Rust must add

OpenTUI owns the generic parts: slots, views, keymap conditions, the plugin runtime with its events, effects and
grants, and the packs. The OpenCode TUI registers the domain parts through the host crate's registries: `session.*`,
`message.*` and `prompt.*` events, `session.*` and `lsp.query` reads, `prompt.edit` and `session.switch` effects.
`opentui` itself takes no dependency on psychoscript or serde.

| #   | Piece                                                                                                                                               | Where                                                            | Size          |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------- |
| 1   | Slot registry: ordering, modes, contributions, error buffer, with TypeScript `createSlotRegistry` semantics                                         | `opentui::slot`                                                  | S, ~400 lines |
| 2   | View nodes (a Rust enum) and a keyed reconciler onto widgets; host-owned element state                                                              | `opentui::view`                                                  | L, ~1,200     |
| 3   | Element actions (`select`, `submit`, `change`, `click`, `close`) as callbacks keyed by element                                                      | `opentui::view`                                                  | S, ~200       |
| 4   | Keymap: data conditions from `when`, layer priority, user overrides, pending-sequence feed                                                          | `opentui::keymap` (mostly exists)                                | S, ~150       |
| 5   | Plugin host crate: manifest, config and grants; compile and reload; worker pool; queue with subscriptions and coalescing; limits; state persistence | `crates/opentui-plugin` (new; depends on psychoscript and serde) | L, ~2,000     |
| 6   | Effect executor and host-function registry, with capability checks and `effect`/`stream` completions                                                | `opentui-plugin`                                                 | M, ~800       |
| 7   | Packs `syntax` and `fuzzy`                                                                                                                          | `opentui-plugin::packs`                                          | S–M, ~500     |
| 8   | Sidecar manager: download and verify, spawn, JSON-RPC over stdio, idle stop                                                                         | `opentui-plugin::sidecar`                                        | M, ~700       |
| 9   | Test harness: run a plugin against `TestApp` with fake reads and recorded effects                                                                   | `opentui-plugin::testing`                                        | S, ~300       |

**Implementation plan**, one green, tested PR per step:

1. `rust: add a slot registry with ordering and modes`, with cases ported from the TypeScript registry tests.
2. `rust: add view nodes and a keyed reconciler` (inline, row, column, box).
3. `rust: reconcile list, table, input, progress, spinner, code and markdown`, with host-owned element state.
4. `rust: route view element actions to handlers`.
5. `rust: keymap conditions from data and user key overrides`.
6. `rust: add opentui-plugin with manifests, config and grants` (no runtime). First settle how it consumes psychoscript
   (git dependency or vendoring) and the toolchain (psychoscript needs 1.100; the workspace pins 1.99.1).
7. `rust: run plugins from compiled programs on a worker pool`: init, reload, transactional state, persistence.
8. `rust: plugin event queue with subscriptions, coalescing and overflow`.
9. `rust: plugin effects and completion events`: toast, clipboard, timers, store, `fs.watch`.
10. `rust: gated plugin reads (fs, git, store, clipboard)`, plus the exec and network effects and their sandboxes.
11. `rust: syntax and fuzzy packs`.
12. `rust: plugin sidecars over stdio JSON-RPC`.
13. `rust: plugin test harness, example plugins and a docs page`.
14. In parallel, upstream in psychoscript: a compute budget and a configurable memory limit (step 7 uses
    `timeout_ms` until then, §2).

## Open questions

1. **psychoscript limits:** the shape of the compute budget (fuel or CPU time) and memory limit, in both
   implementations; when the GC lands; whether a shared built-ins realm removes the 15 µs floor.
2. **Worker pool vs thread per plugin:** measure the pool with the prototype's fan-out bench before step 7.
3. **Distribution:** registry format, signing on top of sha256 (minisign, sigstore), update policy.
4. **Sidecar sandboxing** per OS, or sidecars as fully trusted `exec`.
5. **"Both" plugins:** one package for the TUI and server halves, and whether their stores are shared via the server.
6. **Streaming at LLM rates:** is a 16 ms `stream` flush right, and do transcript decorations need back-pressure?
7. **Images:** which producers make image refs, and the fallback without kitty graphics.
8. **Modal plugins:** full-screen surfaces and raw mouse (termdraw #58) are not in v0; is a `screen` slot worth it?
9. **Editor buffers:** a code view would bring back buffer events and `signs`/`diff` slots (#16, #24, #26).
