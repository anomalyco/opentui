# TUI plugin API v0

Plugins for the Rust OpenCode TUI (OpenTUI Rust) are PsychoScript reducers. Each event runs a plugin once with
`{ event, state }`, and it returns `{ state, commands, slots, effects }`. Existing plugins get rewritten.

Sources: **[R]** `./TOP100.md` (73 plugins, `#`) and `./HOST-API.md`; **[P]** the prototype on `psychoscript-plugins`
(`packages/rust/examples/psychoscript-plugins`, with measurements in `bench/RESULTS.md` and `sidecar/RESULTS.md`).

## 0. Decisions

1. **Reads are calls, writes are effects**, run after the run commits; a failed run changes nothing [P].
2. **No run waits on slow work**: processes, network and streams are effects answered by events. A plugin's events
   run one at a time, and awaiting a cold `git status` timed out the prototype [P]. Helper calls are the exception,
   with per-call timeouts.
3. **The host owns every lifetime** (timers, watches, processes, helpers). Long-lived plugins were rejected [P].
4. **Host context is the `ctx` binding**, replacing `state.read`; bindings were the cheapest input [P].
5. **Installed plugins are trusted**, as today; there is no permission model.

## 1. Package and manifest

A plugin is a directory with `plugin.json` and one entry `.js` file; the language has no modules.

```json
{
  "id": "acme.git-status",
  "version": "1.2.0",
  "api": 0,
  "entry": "main.js",
  "events": ["session.switched", "file.changed"],
  "uses": ["git", "fuzzy"],
  "helpers": {},
  "settings": { "refreshSec": { "type": "integer", "default": 10, "minimum": 2 } },
  "limits": { "computeMs": 20, "memoryMb": 16 }
}
```

`id` namespaces commands, store, state and config; `api` is this API's major; `events` are subscriptions (§3);
`uses` lists injected namespaces and `helpers` the package's processes (§6); `settings` is a JSON Schema subset passed
as the `settings` binding. Per-user config: `~/.config/opencode/tui.json`, `{ "plugins": { "<id>": { enabled,
settings, keys } } }`. Installing is a user action (`opencode plugin add`), with a sha256 check.

## 2. Lifecycle and limits

- **Load:** validate, then `Runtime::compile` once (a 100 KB plugin's event: 94 µs instead of 1.3 ms [P]).
- **Init:** `{ type: "init", reason: "load" | "reload" | "upgrade", from? }` with the persisted state or `null`.
- **Reload** recompiles and sends `init`, keeping state; a parse error keeps the old program. **Unload** drops the
  plugin's slots, layer, timers, watches and processes.
- **State** is JSON, replaced whole, persisted (debounced, ≤ 1 MiB). A run that throws, hits a limit or returns a
  malformed value commits nothing; 5 failures in a row suspend the plugin.

| Limit per event          | Default / max             | Notes                                                                |
| ------------------------ | ------------------------- | -------------------------------------------------------------------- |
| `computeMs`              | 20 / 100 ms               | VM time only; stops runaway loops                                    |
| `wallMs`                 | 1,000 / 30,000 ms         | Includes awaits on built-in reads (250 ms cap each) and helper calls |
| `memoryMb`               | 16 / 64 MiB               | Live heap                                                            |
| Result / effects / queue | 256 KiB / 64 / 256 events |                                                                      |

psychoscript has only a wall-clock `timeout_ms` and a fixed object cap; v0 needs a compute budget and a memory limit in
both implementations. Until then `wallMs` maps to `timeout_ms`.

## 3. Events

Every event carries `type`, `seq` and `time`. `ctx` is the host snapshot at dispatch.

| Event                                           | Payload                                                                             | Coalesce                   |
| ----------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------- |
| `init`                                          | `reason, from?`                                                                     | —                          |
| `command`                                       | `name, args?, source: "key"\|"palette"\|"slash"\|"effect"`                          | no                         |
| `key`                                           | `key, modifiers` (unclaimed keys only)                                              | no                         |
| `keymap.pending`                                | `sequence, candidates[{key, command, title}]` (which-key #27)                       | latest                     |
| `ui`                                            | `slot, key, action: "select"\|"submit"\|"change"\|"click"\|"close", value?, index?` | `change`: latest           |
| `prompt.changed` / `prompt.submitted`           | `text, cursor?, sessionId`                                                          | latest / no                |
| `message.rendered`                              | `sessionId, messageId, role, text`                                                  | no                         |
| `session.switched` / `session.status`           | `id, prevId` / `id, status, agent?`                                                 | latest                     |
| `selection.changed` / `focus.changed`           | `slot, key, indices, items` / `target, prev`                                        | latest                     |
| `resize` / `theme.changed` / `settings.changed` | `width, height` / `mode, name` / `changed[]`                                        | latest                     |
| `timer`                                         | `id, now, late`                                                                     | per id                     |
| `file.changed`                                  | `watchId, paths[], kinds[]`                                                         | merge paths                |
| `effect`                                        | `id, ok, value?, error?`                                                            | no                         |
| `stream`                                        | `id, chunks[], done`                                                                | merge, flushed every 16 ms |
| `helper`                                        | `helper, name, data`                                                                | no                         |

Delivery: `init`, `command`, `ui`, `effect`, `stream`, `timer` and `helper` always arrive; others need a
subscription. FIFO per plugin, one run at a time, no order across plugins; slots order contributions by `order`,
registration, `id`. "Latest" events coalesce while a plugin is busy. At 256 queued, coalescable events drop first, then
`key`; never `command`, `effect` or `ui`. Keys are decided on the UI thread, since replies come too late to consume one
[P]: plugins claim keys only through command bindings or a focused element.

## 4. Returns

`{ state?, commands?, slots?, effects?, context? }`. Any field left out keeps its previous value, except `effects`.

**`commands`** replaces the plugin's keymap layer:

```js
{ name: "refresh", title: "Git: refresh", key: "g r", when: { focus: "sidebar" }, palette: true, slash: "git-refresh" }
```

`when` is data checked on the UI thread per key, mapped onto the keymap's `Layer::require`/`target` over `focus`,
`mode`, `busy`, `sessionId` and flags from `context`. User overrides win; plugin layers rank below built-ins.

**`slots`** maps a slot name to a view, or `null` to remove the contribution:

| Slot                                                             | Mode                                  | Shape                     |
| ---------------------------------------------------------------- | ------------------------------------- | ------------------------- |
| `statusbar.left` / `statusbar.right`                             | append                                | inline                    |
| `sidebar`                                                        | append, one titled section per plugin | view                      |
| `sidebar.footer`, `home.footer`, `prompt.footer`, `prompt.right` | append                                | inline or row             |
| `message.decoration`                                             | append                                | `{ [messageId]: inline }` |
| `panel`, `preview`                                               | single winner                         | view                      |
| `dialog`                                                         | stack, modal                          | `{ title, body, width? }` |
| `palette`                                                        | append                                | list items                |

**View format.** Plain JSON, styled with theme tokens only:

```
Node   = Inline | Box | List | Table | Input | Progress | Image | Code | Markdown | Spinner
Inline = string | Span[] | { type: "text", spans, wrap?, key? }
Span   = string | { text, fg?, bg?, bold?, italic?, underline?, dim?, link? }   // fg/bg: theme token names
Box    = { type: "row" | "column" | "box", children, key?, gap?, padding?, grow?, width?, height?, border?, title? }
List   = { type: "list", key, items: [{ key, label, detail?, icon? }], selected?, height? }
Table  = { type: "table", key, columns: [{ title, width?, align? }], rows: [{ key, cells }], selected? }
Input  = { type: "input", key, placeholder?, initial?, reset? }
Progress = { type: "progress", value: number | null, label? }
Image  = { type: "image", ref, width?, height?, alt }
Code   = { type: "code", text, lang? }     Markdown = { type: "markdown", text }     Spinner = { type: "spinner", label? }
```

Children match by `key`, else index; same key and type updates in place, keeping host-owned state (cursor, scroll,
input text); unchanged slots are skipped [P]. Interactive nodes need keys (`ui` events name them). Inputs are
uncontrolled, so a lagging reducer drops no keystrokes; spinners animate host-side. Caps: 2,000 nodes per slot.

**`effects`** run in order after the run commits:

| Effect                                         | Fields                                                                             | Completion                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------- |
| `toast`, `notify`                              | `message, kind?` · `title, body, sound?`                                           | —                                   |
| `clipboard.copy`, `open.url`, `open.file`      | `text` · `url` · `path, line?`                                                     | —                                   |
| `command.run`, `session.switch`                | `name, args?` · `id`                                                               | —                                   |
| `prompt.edit`                                  | `op: "insert"\|"replace", text, range?`                                            | —                                   |
| `store.set` / `store.delete`                   | `key, value?`                                                                      | —                                   |
| `timer.every` / `timer.after` / `timer.cancel` | `id, ms`                                                                           | `timer` events                      |
| `fs.watch` / `fs.unwatch`                      | `id, paths: glob[]`                                                                | `file.changed` events               |
| `fs.write` / `fs.remove`                       | `id?, path, data?`                                                                 | `effect`                            |
| `shell.run` / `process.kill`                   | `id, argv[], cwd?, env?, input?, stream?, timeoutMs?` · `id`                       | `effect`, or `stream` then `effect` |
| `net.request`                                  | `id, url, method?, headers?, body?, timeoutMs?`                                    | `effect`                            |
| `git`                                          | `id, op: "stage"\|"unstage"\|"commit"\|"checkout"\|"branch"\|"push"\|"pull", args` | `effect`                            |
| `stream` / `stream.cancel`                     | `id, fn, params` (`fn` is a streaming method such as `embedder.index`) · `id`      | `stream` then `effect`              |

## 5. Host functions

The bindings are `event`, `state`, `settings` and `ctx`:

```
ctx = { now, size, theme, focus, mode, busy, session: {id, title, agent, model} | null,
        workspace: {root, name}, plugin: {id, version, dataDir} }
```

Functions are interface namespaces (§6). Each takes one params object and an optional `{ timeoutMs }`, and its input
is validated against its schema.

| Function                            | Params → result                                                       | Kind  |
| ----------------------------------- | --------------------------------------------------------------------- | ----- |
| `fs.read`                           | `{path, maxBytes?, encoding?}` → `string \| Uint8Array`               | async |
| `fs.list`                           | `{dir, glob?, depth?, limit?}` → `{name, path, isDir, size, mtime}[]` | async |
| `fs.stat`                           | `{path}` → `{size, mtime, isDir} \| null`                             | sync  |
| `fs.preview`                        | `{path, range?, width?}` → `Node`                                     | async |
| `git.status`                        | `{}` → `{branch, dirty, ahead, behind, files}`                        | async |
| `git.diff`                          | `{path?, base?, ref?, staged?}` → `{files: [{path, hunks}]}`          | async |
| `git.log`                           | `{path?, line?, limit?}` → `commits[] \| blame`                       | async |
| `syntax.highlight`                  | `{text, lang}` → `Span[][]`                                           | sync  |
| `fuzzy.index` / `fuzzy.match`       | `{id, items}` → `{count}` · `{id, query, limit}` → `{index, score}[]` | sync  |
| `session.list` / `session.messages` | `{limit?}` · `{id, limit?, before?}`                                  | async |
| `clipboard.read`                    | `{}` → `string \| null`                                               | async |
| `store.get` / `store.list`          | `{key}` → `Json \| null` · `{prefix}` → `string[]`                    | sync  |
| `<helper>.<method>`                 | as the helper's interface declares                                    | async |

From the 38 research functions: `state.read` → `ctx`; all writes (`fs.write/remove`, `clipboard.set`, `ui.toast/notify`,
`store.set`, `git.apply`, `shell.*`, `net.request`, timers, `fs.watch`) → effects; `ui.dialog` → the `dialog` slot;
`editor.edit` → `prompt.edit`; `store.memory` → `state`; `session.save/restore` → `store` plus effects. Dropped:
`install.*` (a user action), `net.listen/subscribe` and `ui.annotate` (helpers), `lsp.*` and `dap.*` (server),
`editor.snippet` (plugin data).

## 6. Native code: packs and helpers

Arbitrary native code is allowed but can never take the TUI down (research needs: highlighting, fuzzy indexing, image
decoding, local-search embeddings, git porcelain binaries, a PTY backend).

- **Capability packs:** Rust in the host (`fs`, `git`, `shell`, `syntax`, `fuzzy`, `session`, `clipboard`, `store`).
- **Supervised helpers:** any executable a plugin ships (Bun or Node with npm, Python, Go, Rust); a crash is a rejected
  promise.
- **In-process native libraries are rejected:** a segfault or abort kills the host and can't be caught.

**Interfaces.** Packs and helpers register a namespace of methods, each with `input`/`output` schemas (and `chunk`) and
a kind: `sync` (packs only), `async`, or `stream` (started by the `stream` effect). Each becomes a top-level global
`Namespace` whose `keys` lists methods and whose `resolve` gives a `HostFunction` (a Rust handler, or a JSON-RPC call):
`git.diff({...})`, `embedder.embed({ text })`. Inputs are validated before sending (`InvalidInput`), results on
arrival (`HelperError`).

```json
"helpers": {
  "embedder": {
    "runtime": "bun@1.4", "command": ["src/embedder.ts"], "install": { "deps": "bun.lock" }, "visibility": "public",
    "methods": {
      "embed": { "input": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] },
                 "output": { "type": "array", "items": { "type": "number" } } },
      "index": { "kind": "stream", "input": { … }, "chunk": { … }, "output": { … } }
    }
  }
}
```

- **Declared in the manifest**, so namespaces exist before a lazy start and calls validate without the process;
  `initialize` must list the same methods.
- **Names:** pack names are reserved; helpers register as `<package>/<helper>`, inject under the short name, and a
  plugin aliases collisions (`"uses": [{ "vec": "acme.search/embedder" }]`). No shadowing of language globals or
  bindings.
- **Opt-in:** `globals(run)` injects only `uses`; an unused namespace costs 15–65 ns per run.
- **Visibility:** private to the package by default; `public` lets others use `<package>/<helper>`. Namespacing only.
- **Lazy and shared:** start on first call (concurrent first calls share one start); one instance per host. Requests
  carry `caller: { plugin }` for accounting, timeouts and fairness (16 in flight per plugin). A shared helper must
  serve overlapping requests concurrently.

**Supervision.** Lazy start; `initialize` within 10 s. A crash rejects pending calls (`HelperCrashed`); the next
call restarts with backoff 0, 100, 200 … ms (≤ 5 s), and 5 crashes in 60 s disable it. Per-call timeouts (default 2 s,
≤ 30 s; streams ≤ 1 h) send `$/cancel`. Memory and CPU limits use cgroups (Linux), job objects (Windows), or
`RLIMIT_CPU` and RSS polling (macOS). The process group is killed when its last user unloads or it idles; stderr goes
to the plugin log.

**Wire protocol.** JSON-RPC 2.0 over stdio, one message per line, at most 16 MiB a line:

```
→ {"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocol":0,"package":"acme.search","helper":"embedder"}}
← {"jsonrpc":"2.0","id":0,"result":{"protocol":0,"methods":["embed","index"]}}
→ {"jsonrpc":"2.0","id":7,"method":"embed","params":{"text":"…"},"caller":{"plugin":"acme.notes","dataDir":"…"}}
← {"jsonrpc":"2.0","id":7,"result":[…]}                       or "error":{"code","message","data"}
← {"jsonrpc":"2.0","method":"$/chunk","params":{"id":8,"chunk":{…}}}      → stream events
→ {"jsonrpc":"2.0","method":"$/cancel","params":{"id":8}}                 ← error -32800
← {"jsonrpc":"2.0","method":"$/event","params":{"name":"…","data":{…}}}   → helper events
```

**Install and pin.** Artifacts (URL plus sha256 per platform), pinned runtimes and frozen lockfiles; every hash,
including interfaces, goes into `helpers.lock` and is checked at each start.

**Cost** (`sidecar/RESULTS.md`): a warm call adds 20–30 µs; 50 plugins sharing one helper reply in ~0.5 ms; a crash
rejects within 0.6 ms; cold start and RSS are 1.0 ms / 1.8 MB (Rust) and 7.8 ms / 16 MB (Bun), hence lazy and shared.

## 7. Performance budget

Measured [P]: a compiled event costs 15–240 µs; 50 plugins on their own threads 0.69 ms (p99 0.75); the UI thread
0.32 ms per frame at 50 plugins. Plugins never run on the UI thread, which applies at most 2 ms of replies per frame.
Target ≤ 1 ms per event (warning above 4 ms). Subscriptions and coalescing cut fan-out. A worker pool of
`min(cores − 2, 8)` replaces a thread per plugin, to be measured.

## 8. What OpenTUI Rust must add

OpenTUI owns slots, views, keymap conditions, the plugin runtime and packs; the OpenCode TUI registers its domain
events, reads and effects. `opentui` takes no psychoscript dependency. Pieces (rough size): slot registry (S, ~400
lines), view nodes and keyed reconciler (L, ~1,200), element actions (S, ~200), keymap conditions (S, ~150), the new
`opentui-plugin` crate with host, queue, limits and persistence (L, ~2,000), effects and interface registry (M, ~900),
`syntax`/`fuzzy` packs (S–M, ~500), helper supervisor (M, ~900), test harness (S, ~300).

**Plan**, one green, tested PR per step:

1. `rust: add a slot registry with ordering and modes`
2. `rust: add view nodes and a keyed reconciler` (inline, row, column, box)
3. `rust: reconcile list, table, input, progress, spinner, code and markdown`
4. `rust: route view element actions to handlers`
5. `rust: keymap conditions from data and user key overrides`
6. `rust: add opentui-plugin with manifests and config`. First settle how it depends on psychoscript, and the
   toolchain: 1.100 against the workspace's 1.99.1.
7. `rust: run plugins from compiled programs on a worker pool`
8. `rust: plugin event queue with subscriptions, coalescing and overflow`
9. `rust: plugin effects and completion events`
10. `rust: plugin reads (fs, git, store, clipboard)`, plus the `shell.run` and `net.request` effects
11. `rust: syntax and fuzzy packs`
12. `rust: supervised plugin helpers over stdio JSON-RPC`
13. `rust: plugin test harness, example plugins and a docs page`

In parallel, upstream in psychoscript: a compute budget and a configurable memory limit.

## Open questions

1. psychoscript: the compute budget and memory limit; when GC lands; a shared built-ins realm.
2. A worker pool against a thread per plugin, measured before step 7.
3. Distribution: registry, signing, updates.
4. Security, not part of v0: capability grants, path roots, network allowlists, host-held secrets, helper sandboxing.
5. "Both" plugins: one package, and a store shared through the server.
6. Streaming back-pressure at LLM rates; image refs and the non-kitty fallback.
7. Full-screen surfaces and raw mouse; editor-buffer events if the TUI gains a code view.
8. Helper runtimes: shipping pinned Bun, Node and Python; npm native addons; generated typings for interfaces.
9. Several instances of a CPU-bound shared helper.
