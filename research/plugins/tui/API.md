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
   prototype's git plugin [P]. Slow work (processes, network, streams) is an effect whose result comes back as an
   event. The one exception is a call to the plugin's own helper (§6): it has a per-call timeout, and its wait counts as
   wall time, not compute time.
3. **The host owns every lifetime.** Timers, watches, processes, streams and helpers end when the plugin unloads. A
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
  "uses": ["git", "fuzzy"],
  "helpers": {},
  "settings": {
    "showAhead": { "type": "boolean", "default": true, "title": "Show commits ahead" },
    "refreshSec": { "type": "integer", "default": 10, "minimum": 2 }
  },
  "limits": { "computeMs": 20, "memoryMb": 16 }
}
```

- **`id`** (`[a-z0-9-]+(\.[a-z0-9-]+)+`) namespaces commands (`acme.git-status/refresh`), store, state and config.
  **`api`** is this API's major version; the host refuses majors it doesn't implement.
- **`events`** are subscriptions (§3); **`limits`** are requests the host caps (§2); **`helpers`** are
  native processes with declared interfaces (§6).
- **`settings`** is a JSON Schema subset (`type`, `default`, `enum`, `minimum`/`maximum`, `title`, `description`).
  The host renders the form, validates it, and passes the values to every run as the `settings` binding.

An installed plugin is trusted, as it is today; there is no permission model. `uses` (§6) only decides which
namespaces are injected into the plugin's runtime and which packs and helpers it may start, so unused ones cost
nothing.

**Per-user config** lives in `~/.config/opencode/tui.json`:

```json
{
  "plugins": {
    "acme.git-status": {
      "enabled": true,
      "settings": { "refreshSec": 30 },
      "keys": { "refresh": "ctrl+g" }
    }
  }
}
```

Installing is a user action (`opencode plugin add <spec>`): download, check the registry's `sha256`, unpack into
`<data>/plugins/<id>/<version>/`. Hence no `install.plugin` (§5).

## 2. Lifecycle

| Step     | What happens                                                                                                                                                                                                                  |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discover | Validate `plugin.json` (`id`, `api`, `entry`, `uses`, schemas). An invalid plugin is listed as broken with its diagnostic, never half-loaded.                                                                                 |
| Compile  | `Runtime::compile` once per load or reload, about 12 µs per KB: a 100 KB plugin's event takes 94 µs instead of 1.3 ms compiling per event [P]. A `ParseError` disables a new plugin; on reload the old program keeps running. |
| Init     | `{ type: "init", reason: "load" \| "reload" \| "upgrade", from? }` with the persisted state or `null`; `from` lets an upgrade migrate state.                                                                                  |
| Run      | Events FIFO, one at a time per plugin (§3, §7).                                                                                                                                                                               |
| Reload   | Compile, then `init` with `reload` or `upgrade`. State is kept; commands, slots and subscriptions are replaced by what `init` returns.                                                                                        |
| Unload   | Drop the plugin's slots, keymap layer, timers, watches, processes and helpers. No unload event: state is already persisted and nothing is left to clean up.                                                                   |

**State.** State is plain JSON, replaced whole by `state` and kept when it is left out. The host writes it, debounced,
to `<data>/plugin-state/<id>.json`. The cap is 1 MiB. Bigger data goes to `store` (§5) or a pack. This answers the
research's "large-state" blocker [R].

**Errors.** A run that throws, hits a limit or returns a malformed value commits nothing [P]; the error shows in the
plugin manager and a toast. After 5 failures in a row, or 3 limit hits in 60 s, the plugin is suspended
until re-enabled or reloaded.

**Limits per event.** Defaults are given first, then the host maximum:

| Limit       | Default / max     | Notes                                                                                                            |
| ----------- | ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| `computeMs` | 20 / 100 ms       | VM time only: excludes awaits on host functions. Runaway loops stop here.                                        |
| `wallMs`    | 1,000 / 30,000 ms | The whole run, including awaits: built-in reads (capped at 250 ms each) and helper calls (per-call timeout, §6). |
| `memoryMb`  | 16 / 64 MiB       | Live heap of the run.                                                                                            |
| Result      | 256 KiB           | JSON size of the return value.                                                                                   |
| Effects     | 64 per run        |                                                                                                                  |
| Queue       | 256 events        | Overflow policy in §3.                                                                                           |

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
| `helper`            | `helper, name, data`                                                                | a helper sends `$/event`                         | no                           | §6                     |

`init`, `command`, `ui`, `effect`, `stream`, `timer` and `helper` always arrive: they answer something the plugin
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

| Effect                                         | Fields                                                                                 | Completion                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `toast`                                        | `message, kind?: "info"\|"success"\|"warning"\|"error"`                                | —                                                          |
| `notify`                                       | `title, body, sound?`                                                                  | — (desktop notification)                                   |
| `clipboard.copy`                               | `text`                                                                                 | —                                                          |
| `open.url`                                     | `url`                                                                                  | —                                                          |
| `open.file`                                    | `path, line?`                                                                          | —                                                          |
| `command.run`                                  | `name, args?`                                                                          | built-in or another plugin's command                       |
| `prompt.edit`                                  | `op: "insert"\|"replace", text, range?`                                                | `editor.edit` for the prompt (snippets #70)                |
| `session.switch`                               | `id`                                                                                   | —                                                          |
| `store.set` / `store.delete`                   | `key, value?`                                                                          | —                                                          |
| `timer.every` / `timer.after` / `timer.cancel` | `id, ms`                                                                               | `timer` events (minimum 250 ms)                            |
| `fs.watch` / `fs.unwatch`                      | `id, paths: glob[]`                                                                    | `file.changed` events                                      |
| `fs.write` / `fs.remove`                       | `id?, path, data?`                                                                     | `effect`                                                   |
| `shell.run`                                    | `id, argv[], cwd?, env?, input?, stream?, timeoutMs?`                                  | `effect {code, stdout, stderr}`, or `stream` then `effect` |
| `process.kill`                                 | `id`                                                                                   | —                                                          |
| `net.request`                                  | `id, url, method?, headers?, body?, timeoutMs?`                                        | `effect {status, headers, body}`                           |
| `git`                                          | `id, op: "stage"\|"unstage"\|"commit"\|"checkout"\|"branch"\|"push"\|"pull", args`     | `effect`                                                   |
| `stream`                                       | `id, fn, params, timeoutMs?` (`fn` names a streaming method, such as `embedder.index`) | `stream` chunks, then `effect`                             |
| `stream.cancel`                                | `id`                                                                                   | —                                                          |

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
        plugin: {id, version, dataDir} }
```

`ctx` replaces `state.read` and the `status` broadcast [R]. It is small, about 1 KB, and costs about 1 µs as a
binding [P].

The globals are interface namespaces (§6). Every function takes one params object and an optional `{ timeoutMs }`.
Its input is validated against its schema (`InvalidInput`).
`async` functions are awaited inside the run and count toward `wallMs` but not `computeMs`. The built-in ones are
capped at 250 ms each; helper methods have their own timeouts.

| Function                      | Params → result                                                               | Kind  | From HOST-API               |
| ----------------------------- | ----------------------------------------------------------------------------- | ----- | --------------------------- |
| `fs.read`                     | `{path, maxBytes?=1MiB, encoding?: "utf8"\|"bytes"}` → `string \| Uint8Array` | async | `fs.read`                   |
| `fs.list`                     | `{dir, glob?, depth?=1, limit?=10k}` → `{name, path, isDir, size, mtime}[]`   | async | `fs.list`, `fs.stat` merged |
| `fs.stat`                     | `{path}` → `{size, mtime, isDir} \| null`                                     | sync  | `fs.stat`                   |
| `fs.preview`                  | `{path, range?, width?}` → `Node` (`code` or `image`)                         | async | `fs.preview`                |
| `git.status`                  | `{}` → `{branch, dirty, ahead, behind, files: [{path, status}]}`              | async | `git.status`                |
| `git.diff`                    | `{path?, base?, ref?, staged?}` → `{files: [{path, hunks}]}`                  | async | `git.diff`                  |
| `git.log`                     | `{path?, line?, limit?=50}` → `commits[] \| blame`                            | async | `git.history`               |
| `syntax.highlight`            | `{text, lang}` → `Span[][]`                                                   | sync  | `fs.preview` (part)         |
| `fuzzy.index` / `fuzzy.match` | `{id, items}` → `{count}` · `{id, query, limit}` → `{index, score}[]`         | sync  | picker indexes (#12)        |
| `session.list`                | `{limit?}` → `{id, title, updated, cost}[]`                                   | async | `session.list`              |
| `session.messages`            | `{id, limit?, before?}` → `{id, role, text}[]`                                | async | new (mem0-style status)     |
| `clipboard.read`              | `{}` → `string \| null`                                                       | async | `clipboard.get`             |
| `store.get` / `store.list`    | `{key}` → `Json \| null` · `{prefix}` → `string[]`                            | sync  | `store.get`                 |
| `<helper>.<method>`           | as the helper's interface declares                                            | async | new: arbitrary native code  |

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
(packs are built in; helpers install with the plugin), `net.listen`, `net.subscribe` and `ui.annotate`
(long-lived servers become helpers, §6), `lsp.start`, `lsp.query`, `dap.*` (language and debug servers are the
server's concern), `editor.snippet` (plugin data).

What is left is 15 built-in functions in 7 namespaces, the helpers' interfaces, and 23 effect types.

## 6. Native code

Today's Node and Bun plugins can do anything. The TUI plugins in the research need native work [R]:

- syntax highlighting (#15, #34);
- fuzzy indexing for pickers (the fzf family, #12);
- image decoding for previews (yazi #5, tfm-tui #57);
- embeddings for local search (opencode-mem #43);
- git porcelain binaries (lazygit #2, fugitive #10);
- a PTY or terminal backend (opencode-pty #54).

v0 allows arbitrary native code, on the condition that it can never take the TUI down. There are two paths:

| Path                   | What                                                                               | Crash-safe because                                           |
| ---------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Capability packs**   | Rust built into the host: `git`, `fs`, `shell`, `syntax`, then `fuzzy`             | It is host code we write and test                            |
| **Supervised helpers** | Any executable a plugin ships: Bun or Node with npm dependencies, Python, Go, Rust | It is a separate process: a crash becomes a rejected promise |

**In-process native libraries are rejected because they can't be made crash-safe.** A segfault, an `abort()`, a stack
overflow or a foreign panic takes the whole host down, and no Rust code can catch it. Memory corruption can damage the
host silently first. A library can spin a thread that can't be stopped. A process boundary is the only isolation that
holds against arbitrary code.

### One shape for packs and helpers: interfaces

Packs and helpers both register an **interface**: a namespace name and its methods. Each method has an `input`
schema, an `output` schema, optionally a `chunk` schema, and a kind:

- `sync` (packs only, for microsecond work such as `fuzzy.match`);
- `async`;
- `stream`.

Every interface becomes a **top-level global namespace**, whether it is a built-in pack or a helper process:
`git.diff()`, `syntax.highlight()`, `embedder.embed()`. The plugin sees one shape: functions taking one params object
and an optional `{ timeoutMs }`, returning a value or a promise, with the same error kinds. Streaming methods start
only through the `stream` effect (rule 2). The reads in §5 are exactly the packs' interfaces.

```js
const hl = syntax.highlight({ text: event.text, lang: "rust" }) // pack, sync
const v = await embedder.embed({ text: event.query }) // helper, async
return { effects: [{ type: "stream", id: "reindex", fn: "embedder.index", params: { root: ctx.workspace.root } }] }
```

**Names and collisions.** Each interface is registered under a host-unique id, and injected under a short name:

| Interface      | Registry id                                                                                 | Global name                                  |
| -------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Built-in packs | the reserved names `fs`, `git`, `shell`, `syntax`, `fuzzy`, `session`, `clipboard`, `store` | the same name                                |
| Helpers        | `<package id>/<helper name>`, unique because package ids are                                | the helper name, or an alias the plugin sets |

- A helper may not take a reserved name, a built-in global of the language (`global_names()`: `JSON`, `Math`,
  `console`, …), or a binding name (`event`, `state`, `settings`, `ctx`). The manifest fails validation otherwise.
- Names only have to be unique within one plugin's runtime, because each runtime gets only what its plugin declares.
  When two packages both export a public `embedder`, a plugin using both aliases one of them:
  `"uses": { "vec": "acme.search/embedder" }`.

**Opt-in per plugin.** The manifest's `uses` lists the namespaces the plugin uses:

```json
"uses": ["git", "syntax", "embedder", { "vec": "acme.search/embedder" }]
```

A bare name is a pack or one of the plugin's own helpers; a `<package>/<helper>` id is another package's public
helper. The plugin's `Runtime` injects exactly these through `globals(run)`; anything undeclared doesn't exist for
that plugin. This is not a permission system: it decides what is injected and what may be started, so a plugin pays
nothing for packs and helpers it doesn't use.

**Lazy and shared.** The namespace object costs nothing until it is touched:

- `keys` lists methods from the registry, so `Object.keys(embedder)` starts nothing.
- `resolve` maps each method to a `HostFunction`: sync or `new_async` for a Rust pack handler, `new_async` doing the
  JSON-RPC call for a helper. An unknown method gives `Failure::missing` with suggestions.

Injecting it into a run is an `Arc` clone. Measured: 30 unused namespaces move the event floor from 17.6 µs to
18.1–19.5 µs, 15–65 ns each.

Packs and helpers start on the **first call**, not when a plugin declaring them loads:

- a Bun helper's cold start costs 7.8 ms (Rust: 1.0 ms), and each Bun process holds 16 MB RSS (Rust: 1.8 MB) and
  uses about 1 ms/s of CPU even when idle;
- many plugins declare a helper only for rare commands (image decoding on preview, re-indexing);
- the first caller pays the cold start once, and concurrent first calls wait on the same start.

**One instance per host.** Every plugin that uses an interface shares one instance: one helper process and one pack
state, however many plugins call it.

- Each call carries the caller: the request's `caller: { plugin }` (see Wire protocol), and the plugin id captured in
  that plugin's `globals`.
- The host uses the caller for per-plugin accounting (calls and time in the plugin manager), per-call timeouts,
  and fairness: at most 16 calls in flight per plugin per helper, and a round-robin queue across plugins
  when the helper is saturated.
- A crash rejects the pending calls of every caller and restarts the one process.
- The helper stops when the last plugin using it unloads, or when it has been idle for `idleStopSec`.
- **A shared helper must serve overlapping requests concurrently** (worker threads or async inside the helper).
  Measured: 50 plugins sharing one helper answer a fan-out of echo calls in 0.47–0.52 ms, as fast as 50 separate
  helpers, in 2.2 MB (Rust) or 38 MB (Bun) instead of 88 or 816 MB. But a helper that answers one request at a
  time turns 50 CPU-bound calls of 0.25 ms into 12.2 ms, against 1.3 ms with one helper per plugin.

**Helper visibility** is a namespacing rule. A helper is private to the package that ships it by default
(`"visibility": "private"`): only that package's plugin can list it in `uses`. With `"visibility": "public"`, any
plugin may list it as `<package>/<helper>`. If the providing package is removed, a plugin that uses it fails to load
with a diagnostic naming the missing helper.

**Where a helper's interface is declared:** in the manifest, not discovered at runtime.

- Lazy start needs the namespace to exist before the process runs.
- The interface is pinned by hash in `helpers.lock` together with the helper's files.
- Calls can be validated without the process.

At `initialize`, the helper answers with its method names, and the host checks that it serves every declared method.
A mismatch fails the start with `HelperMismatch`. For authors, `opencode plugin dev` can call a helper's optional
`describe` method to generate the manifest entry; the runtime never trusts `describe`.

```json
"helpers": {
  "embedder": {
    "runtime": "bun@1.4",
    "visibility": "public",
    "command": ["src/embedder.ts"],
    "install": { "deps": "bun.lock" },
    "limits": { "memoryMb": 1024, "cpuPercent": 100 },
    "methods": {
      "embed": {
        "input": { "type": "object", "properties": { "text": { "type": "string", "maxLength": 8192 } }, "required": ["text"] },
        "output": { "type": "array", "items": { "type": "number" }, "maxItems": 1024 }
      },
      "index": { "kind": "stream", "timeoutMs": 600000,
                 "input": { "type": "object", "properties": { "root": { "type": "string" } }, "required": ["root"] },
                 "chunk": { "type": "object", "properties": { "done": { "type": "integer" } } },
                 "output": { "type": "object" } }
    }
  },
  "pty": {
    "runtime": "exec",
    "command": ["${bin}/pty-backend", "--stdio"],
    "artifacts": {
      "darwin-arm64": { "url": "https://…/pty-backend-darwin-arm64", "sha256": "…" },
      "linux-x64": { "url": "https://…/pty-backend-linux-x64", "sha256": "…" }
    },
    "methods": { "spawn": { … }, "write": { … }, "resize": { … }, "output": { "kind": "stream", … } }
  }
}
```

**Validation.** Schemas use the settings dialect (§1) plus `properties`, `required`, `items`, `maxLength`, `maxItems`
and `additionalProperties`. They are compiled once at load.

- **Input** is validated before anything is sent. A bad call rejects with `InvalidInput` and the failing path, at a
  cost of microseconds, without touching the process.
- **Results and chunks** are validated on arrival. A mismatch rejects with `HelperError` (`InvalidOutput`), so
  plugins never see data their interface doesn't promise.
- **Pack interfaces** use the same validator, so built-ins and helpers fail the same way.

**Helper runtimes:**

- `exec`, a binary: shipped in the package, or one artifact per platform;
- `bun@<range>` and `node@<range>`, a script plus a lockfile;
- `python@<range>`, a script plus `uv.lock`.

The host installs the script runtimes as pinned, sha256-checked artifacts shared across plugins, and never uses
whatever is on `PATH`.

### Supervision

| Concern          | Behaviour                                                                                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Start            | On the first call from any plugin. One process per host, shared. `initialize` must answer within 10 s.                                                                                                                                                                     |
| Crash            | Every pending call rejects with `HelperCrashed` (exit code or signal, last stderr lines), and the TUI carries on. The next call restarts the helper with backoff 0, 100, 200, … ms, capped at 5 s. After 5 crashes in 60 s it is disabled until reload (`HelperDisabled`). |
| Per-call timeout | The method's `timeoutMs`, else the helper's `callTimeoutMs` (default 2 s, max 30 s; streams up to 1 h), or `{ timeoutMs }` per call. On expiry the call rejects with `HelperTimeout` and the host sends `$/cancel`. A helper that ignores 3 cancels in a row is restarted. |
| Memory and CPU   | Linux: a cgroup v2 per helper (`memory.max`, `cpu.max`). Windows: a job object. macOS: `RLIMIT_CPU`, plus host-side RSS polling that kills the helper over its limit.                                                                                                      |
| Output           | stdout carries only the protocol. stderr goes to the plugin's log, capped. A malformed line, or one over 16 MiB, restarts the helper.                                                                                                                                      |
| Stop             | When the last plugin using it unloads, after `idleStopSec` idle (default 300), and on quit. The whole process group (job object on Windows) is killed, so grandchildren die too.                                                                                           |

The wait for a helper counts toward `wallMs`, not `computeMs`. That makes a helper method the one awaited call that
may take seconds: the plugin's own queue waits, the TUI doesn't. A helper can do anything, so rule 1's transactional
guarantee doesn't cover what it did during a call that later failed.

### Wire protocol

JSON-RPC 2.0 over stdin and stdout, one message per line. JSON escapes newlines, so no other framing is needed.
Messages are UTF-8, bytes travel as base64 strings, and a line is at most 16 MiB.

```
host → {"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocol":0,"package":"acme.search","helper":"embedder","dataDir":"…"}}
     ← {"jsonrpc":"2.0","id":0,"result":{"protocol":0,"methods":["embed","index"]}}
host → {"jsonrpc":"2.0","id":7,"method":"embed","params":{"text":"…"},"caller":{"plugin":"acme.notes","dataDir":"…"}}
     ← {"jsonrpc":"2.0","id":7,"result":[0.12, …]}         or   "error":{"code":…,"message":…,"data":…}
host → {"jsonrpc":"2.0","id":8,"method":"index","params":{"root":"…"}}
     ← {"jsonrpc":"2.0","method":"$/chunk","params":{"id":8,"chunk":{"done":120}}}   (zero or more, before the response)
host → {"jsonrpc":"2.0","method":"$/cancel","params":{"id":8}}                       (the helper answers error -32800)
     ← {"jsonrpc":"2.0","method":"$/event","params":{"name":"changed","data":{…}}}   (unsolicited)
```

- Requests may overlap, and responses come back in any order. Each request carries `caller`, an extension member
  naming the calling plugin and its data directory, so one shared process can keep each caller's data apart.
- `$/chunk`s of a `stream` effect arrive as `stream` events, merged at most every 16 ms (§3). The final result arrives
  as an `effect` event.
- `$/event` notifications arrive as `helper` events.
- A helper is a small loop in any language: the bench's Rust and Bun helpers are about 60 lines each.

### Install, verify, pin

`opencode plugin add` resolves everything up front and writes `helpers.lock` next to the package:

- each artifact's URL and sha256;
- each runtime's version and sha256;
- the hash of each script, of its dependency lockfile, and of each helper's interface.

Dependencies install with the runtime's frozen-lockfile mode (`bun install --frozen-lockfile`). The host refuses an artifact without a hash and a lockfile that doesn't match,
and it checks the files against `helpers.lock` on every start.

### Cost

Measured on this machine (`sidecar/RESULTS.md` on `psychoscript-plugins`):

| Measurement                                                                                        |       Rust helper |       Bun helper |
| -------------------------------------------------------------------------------------------------- | ----------------: | ---------------: |
| Cold start: spawn → `initialize` answered                                                          |            1.0 ms |           7.8 ms |
| Warm round trip, ~100 B / ~10 KB, raw client                                                       |        12 / 16 µs |       26 / 31 µs |
| Plugin event awaiting `bench.echo` (event without the call: 18 µs; in-process pack: 19 µs)         |    37 µs (p99 50) |   50 µs (p99 65) |
| `embed` (5 KB result), in process 224 µs                                                           |            249 µs |           259 µs |
| Bad params rejected before sending (helper never started)                                          |   19 µs per event |  19 µs per event |
| 50 plugins, one event each awaiting their helper: 50 helpers / 1 shared (in-process pack: 0.25 ms) |    0.50 / 0.50 ms |   0.62 / 0.47 ms |
| 50 CPU-bound `embed` calls: 50 helpers / 1 sequential shared helper                                |     1.3 / 12.4 ms |    1.4 / 12.2 ms |
| Starting 50 helpers in parallel / 50 first calls to 1 shared helper (one start)                    |       14 / 2.2 ms |      46 / 9.4 ms |
| RSS: 1 helper / 50 helpers / 1 shared after 50k calls                                              | 1.8 / 88 / 2.2 MB | 16 / 816 / 38 MB |
| Idle CPU, 50 helpers                                                                               |                 0 | 5–7% of one core |
| Crash during a call → the plugin's promise rejects                                                 |      0.14–0.28 ms |     0.22–0.57 ms |
| Next call after a crash (restart + call)                                                           |        1.2–1.3 ms |       8.6–8.7 ms |
| Per-call timeout 100 ms → rejection; the helper stays usable after `$/cancel`                      |        100–110 ms |           100 ms |
| `stream` of 1,000 chunks                                                                           |            1.0 ms |          0.56 ms |

Takeaways:

- A warm helper call costs 20–30 µs on top of the event, about 0.2% of a frame.
- Fan-out to 50 plugins stays under 1 ms at p99, off the UI thread. A crash costs the caller a rejected promise
  within a millisecond, and the TUI carries on.
- Cold start and memory are the real costs of a script runtime: Bun takes 8 ms to start and 16 MB per process, Rust
  1 ms and 1.8 MB. That is why helpers start lazily, on the first call, and why one shared instance serves every
  plugin.
- Sharing only works if the helper serves requests concurrently.

## 7. Performance budget

Measured [P], with plugins compiled once:

| Measurement                                                          |             Median |            p99 |
| -------------------------------------------------------------------- | -----------------: | -------------: |
| Event floor                                                          |              15 µs |                |
| git-status event                                                     |           19–22 µs |       24–31 µs |
| 1,000-item filter                                                    |         113–166 µs |     139–188 µs |
| 200-command palette                                                  |             236 µs |         276 µs |
| 50 plugins, one event each, sequential on one thread                 |            5.69 ms |                |
| 50 plugins, one event each, one thread per plugin                    |            0.69 ms |        0.75 ms |
| UI-thread cost per frame with 50 plugins (dispatch + apply + render) |            0.32 ms |        0.39 ms |
| Event awaiting a warm helper call, Rust / Bun helper (§6)            |         37 / 50 µs |     50 / 65 µs |
| 50 plugins, one event each awaiting a shared helper, Rust / Bun      |     0.50 / 0.47 ms | 0.61 / 0.59 ms |
| Memory between events                                                |       1 KB + state |                |
| Peak heap during one event                                           | 150–420 KiB, freed |                |

The budget per 16.6 ms frame:

- **Plugins never run on the UI thread**, which only dispatches and applies replies (110 µs at 50 plugins), and
  applies at most 2 ms of replies per frame, deferring the rest.
- **Target ≤ 1 ms per event**; the host warns above 4 ms and stops at `computeMs` (20 ms default).
- **Subscriptions and coalescing (§3)** cut fan-out: a key reaches only `key` subscribers.
- **A worker pool** of `min(cores − 2, 8)`, each plugin an actor on it, instead of the prototype's thread per plugin:
  50 × ~100 µs / 8 ≈ 0.6 ms, the same latency without 50 threads. To be measured (open question 2).
- **Memory:** about 50 × (1 KB + state) at rest; pool size × ~0.5 MiB at peak.

## 8. What OpenTUI Rust must add

OpenTUI owns the generic parts: slots, views, keymap conditions, the plugin runtime with its events and effects, and
the packs. The OpenCode TUI registers the domain parts through the host crate's registries: `session.*`,
`message.*` and `prompt.*` events, `session.*` reads, `prompt.edit` and `session.switch` effects.
`opentui` itself takes no dependency on psychoscript or serde.

| #   | Piece                                                                                                                                                                  | Where                                                            | Size          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------- |
| 1   | Slot registry: ordering, modes, contributions, error buffer, with TypeScript `createSlotRegistry` semantics                                                            | `opentui::slot`                                                  | S, ~400 lines |
| 2   | View nodes (a Rust enum) and a keyed reconciler onto widgets; host-owned element state                                                                                 | `opentui::view`                                                  | L, ~1,200     |
| 3   | Element actions (`select`, `submit`, `change`, `click`, `close`) as callbacks keyed by element                                                                         | `opentui::view`                                                  | S, ~200       |
| 4   | Keymap: data conditions from `when`, layer priority, user overrides, pending-sequence feed                                                                             | `opentui::keymap` (mostly exists)                                | S, ~150       |
| 5   | Plugin host crate: manifest and config; compile and reload; worker pool; queue with subscriptions and coalescing; limits; state persistence                            | `crates/opentui-plugin` (new; depends on psychoscript and serde) | L, ~2,000     |
| 6   | Effect executor, and the interface registry: namespaces built from declared interfaces, schema validation; shared by packs and helpers                                 | `opentui-plugin`                                                 | M, ~900       |
| 7   | Packs `syntax` and `fuzzy`                                                                                                                                             | `opentui-plugin::packs`                                          | S–M, ~500     |
| 8   | Helper supervisor: install, verify against `helpers.lock`, spawn lazily, NDJSON JSON-RPC, timeouts and `$/cancel`, restart with backoff, OS limits, process-group kill | `opentui-plugin::helper`                                         | M, ~900       |
| 9   | Test harness: run a plugin against `TestApp` with fake reads and recorded effects                                                                                      | `opentui-plugin::testing`                                        | S, ~300       |

**Implementation plan**, one green, tested PR per step:

1. `rust: add a slot registry with ordering and modes`, with cases ported from the TypeScript registry tests.
2. `rust: add view nodes and a keyed reconciler` (inline, row, column, box).
3. `rust: reconcile list, table, input, progress, spinner, code and markdown`, with host-owned element state.
4. `rust: route view element actions to handlers`.
5. `rust: keymap conditions from data and user key overrides`.
6. `rust: add opentui-plugin with manifests and config` (no runtime). First settle how it consumes psychoscript
   (git dependency or vendoring) and the toolchain (psychoscript needs 1.100; the workspace pins 1.99.1).
7. `rust: run plugins from compiled programs on a worker pool`: init, reload, transactional state, persistence.
8. `rust: plugin event queue with subscriptions, coalescing and overflow`.
9. `rust: plugin effects and completion events`: toast, clipboard, timers, store, `fs.watch`.
10. `rust: plugin reads (fs, git, store, clipboard)`, plus the `shell.run` and `net.request` effects.
11. `rust: syntax and fuzzy packs`.
12. `rust: supervised plugin helpers over stdio JSON-RPC`: top-level interface namespaces from `uses`, sharing, visibility, the `stream` effect and
    `helpers.lock`.
13. `rust: plugin test harness, example plugins and a docs page`.
14. In parallel, upstream in psychoscript: a compute budget and a configurable memory limit (step 7 uses
    `timeout_ms` until then, §2).

## Open questions

1. **psychoscript limits:** the shape of the compute budget (fuel or CPU time) and memory limit, in both
   implementations; when the GC lands; whether a shared built-ins realm removes the 15 µs floor.
2. **Worker pool vs thread per plugin:** measure the pool with the prototype's fan-out bench before step 7.
3. **Distribution:** registry format, signing on top of sha256 (minisign, sigstore), update policy.
4. **Security (not part of v0).** Today's plugins have no permission model, and v0 adds none. Ideas for later:
   capability classes with user grants; path roots for `fs`; network allowlists; secrets the host injects into
   requests without the plugin reading them; OS sandboxing for helpers (Seatbelt, Landlock, AppContainer).
5. **"Both" plugins:** one package for the TUI and server halves, and whether their stores are shared via the server.
6. **Streaming at LLM rates:** is a 16 ms `stream` flush right, and do transcript decorations need back-pressure?
7. **Images:** which producers make image refs, and the fallback without kitty graphics.
8. **Modal plugins:** full-screen surfaces and raw mouse (termdraw #58) are not in v0; is a `screen` slot worth it?
9. **Editor buffers:** a code view would bring back buffer events and `signs`/`diff` slots (#16, #24, #26).
10. **Helper runtimes:** does the host ship pinned Bun, Node and Python itself, and does it support `npm` packages with
    native addons, which make the lockfile platform-specific?
11. **Interface schemas:** is the JSON Schema subset enough, or do helpers want generated TypeScript typings for
    interfaces to author against?
12. **CPU-bound shared helpers:** v0 requires a shared helper to serve requests concurrently itself. Should the host
    instead be able to run several instances of one helper when a sequential helper becomes the bottleneck (12.2 ms
    against 1.3 ms for 50 `embed` calls, §6)?
