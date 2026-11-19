# Host API: the minimal function catalogue, events, slots, and blockers

**This is the main output.** It is the union of every host function the 100 plugins in `TOP100.md` need, grouped by
namespace, plus the events the host must deliver, the UI slots and return shapes plugins need, and the four remaining
blockers with the smallest host capability that removes each. Function names here are the canonical names used in the
"Host fns" column of `TOP100.md`.

**Capability classes** used for security: `read` (no mutation), `write` (mutates repo/state), `exec` (spawns a
process), `network` (talks off-host), `secret` (reads/writes credentials). A function may carry more than one.

**Counts** ("n/100") are the number of `TOP100.md` rows whose reducer calls (or whose rewrite needs) the function. A
merged row counts once even when it bundles several of the same job. Counts are stable to ±1; the ★-marked 20 functions
cover most plugins.

---

## 1. Host-function catalogue

### `fs` — filesystem

| Function | Signature | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|
| ★ `fs.list` | `fs.list(dir, {filter?}) → {name, path, isDir}[]` | async | 6 | read | `std::fs::read_dir`, sorted, off-thread against a bounded reply channel |
| `fs.read` | `fs.read(path) → string \| bytes` | async | 1 | read | `std::fs::read`, size-capped (e.g. 1 MB) before handing to the VM |
| ★ `fs.write` | `fs.write(path, data) → ()` | sync | 5 | write | `std::fs::write`; path is sandboxed to the project root |
| `fs.remove` | `fs.remove(path) → ()` | sync | 1 | write | `std::fs::remove_file` / remove_dir; refuse outside project |
| `fs.stat` | `fs.stat(path) → {size, mtime, isDir}` | sync | 2 | read | `std::fs::metadata` |
| ★ `fs.preview` | `fs.preview(path, {range?}) → rendered text/image` | async | 5 | read | host-owned previewer (mime → highlighters/`glow`/image protocol); result is a renderable blob |
| ★ `fs.watch` | `fs.watch(path) → subscription` | durable | 6 | read | `notify` crate watcher; each change re-emits `file-changed` events to the plugin queue |

### `git` — version control

| Function | Signature | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|
| `git.status` | `git.status(repo?) → {branch, dirty, ahead, behind, files}` | async | 3 | read | `git2` or a cached `git status --porcelain=v2` parse, off-thread |
| ★ `git.diff` | `git.diff({path?, ref?, base?}) → {hunks[]}` | async | 6 | read | `git diff -U… -- <path>` parse (or `git2`), cached/debounced by the host |
| ★ `git.history` | `git.history({path?, line?}) → commits[] \| blame` | async | 4 | read | `git log` / `git blame` parse |
| ★ `git.apply` | `git.apply(op{stage,commit,push,checkout,branch,worktree}, args) → {}` | async | 9 | write+exec | thin wrapper over `git2`/`git` CLI; returns a diff of the result |

### `shell` — processes

| Function | Signature | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|
| ★ `shell.run` | `shell.run(cmd, {cwd, env, input?}) → {code, stdout, stderr}` | async | 14 | exec | `std::process::Command` + `wait_with_output`, off-thread, with output/time caps |
| `shell.stream` | `shell.stream(cmd, args) → chunk-event stream` | durable | 2 | exec | spawn PTY/pipe, pump read events onto the queue (this is the PTY/streaming seam) |

### `net` — network

| Function | Signature | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|
| ★ `net.request` | `net.request({url, method, headers, body, timeout}) → {status, headers, body}` | async | 18 | network | `reqwest`/`ureq` client with a per-plugin token budget + size cap |
| `net.search` | `net.search(query, {provider?}) → {results, citations}` | async | 1 | network | host-held API key wrapper over a search provider (1 row, 3 plugins merged) |
| `net.listen` | `net.listen({port?, routes}) → {port}` | durable | 3 | network | spawn a small `hyper`/`axum` listener on an ephemeral port; returns the bound port |
| `net.subscribe` | `net.subscribe(url, {mode: ws\|poll}) → event stream` | durable | 4 | network | WebSocket/poll task that turns inbound messages into events |

### `session` — sessions and subagents

| Function | Signature | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|
| ★ `session.start` | `session.start(prompt, {subagent?, model?, tools?}) → id` | durable | 12 | exec | call the app session store; spawn a subagent session; report completion as an event |
| ★ `session.inject` | `session.inject(id, context) → ()` | async | 13 | write | append/transform the session context (this is the memory + gate seam) |
| `session.list` | `session.list() → {id, title, cost}[ ]` | async | 5 | read | read the session directory/index |
| ★ `session.save` / `session.restore` | `session.save(id) → snapshot` · `session.restore(snapshot) → id` | durable | 6 | read+write | serialize panes/tabs/session to durable JSON and recreate them |

### `state` — current host/editor state (read-only reactive data)

| Function | Signature | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|
| ★ `state.read` | `state.read(keys?) → {branch, mode, diagnostics, theme, file, workspace}` | sync | 12 | read | a snapshot struct built from app state each dispatch; serialized from the UI thread |

### `llm` — model / provider / generation

| Function | Signature | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|
| `llm.generate` | `llm.generate(prompt, {model?, stream?}) → text \| chunk stream` | async | 2 | read | route to the provider; streamed responses arrive as `chunk` events |
| `llm.model` | `llm.model(providerId, modelId) → ()` | async | 2 | write | switch the active model / get provider credentials |
| `llm.provider` | `llm.provider(op{register,header,proxy,url}, cfg) → ()` | async | 4 | secret | register a custom provider / inject headers / route through a proxy |

### `ui` — dialogs, toasts, notifications, surfaces

| Function | Signature | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|
| ★ `ui.dialog` | `ui.dialog(kind{alert,confirm,prompt,select}, opts) → choice` | async | 4 | read | modal stack via the renderer; resolves when the user answers |
| `ui.toast` | `ui.toast(message, {kind?}) → ()` | sync | 2 | read | push a transient toast onto the renderer |
| ★ `ui.notify` | `ui.notify(title, body, {sound?}) → ()` | sync | 5 | read | desktop notification + attention sound (the merged notifier capability) |
| `ui.annotate` | `ui.annotate(plan) → ()` | sync | 1 | read | open the host-owned browser plan-annotation surface |

### `clipboard`

| Function | Signature | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|
| `clipboard.set` | `clipboard.set(text) → ()` | sync | 4 | write | `arboard`/`clipboard` crate, or OSC-52 over the PTY for remote sessions |
| `clipboard.get` | `clipboard.get() → text` | sync | 2 | read | same seam, read direction |

### `store` — durable + ephemeral plugin storage

| Function | Signature | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|
| ★ `store.get` / `store.set` | `store.get(key) → value` · `store.set(key, value) → ()` | durable | 22 | read+write | per-plugin JSON on disk (serde), live-synced across instances, bounded size |
| `store.memory` | `store.memory(key) → value` | sync | — | read+write | in-RAM map surviving hot reload (used by the built-in feature-plugins, below the 100) |

### `lsp` / `dap` — language and debug servers

| Function | Signature | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|
| `lsp.start` | `lsp.start(server, {workspace}) → handle` | durable | 2 | exec | spawn the server binary, JSON-RPC over stdio, convert notifications → events |
| ★ `lsp.query` | `lsp.query(kind{diagnostics,definition,references,symbols,complete}, args) → result` | async | 6 | read | one method covering the read-only LSP set |
| `dap.start` | `dap.start(adapter, {program}) → handle` | durable | 1 | exec | spawn the debug adapter, keep the session host-side |
| `dap.command` | `dap.command(step\|continue\|next\|variables\|breakpoints, args) → result` | async | 1 | read | drive a running debug session |

### `mcp` — model-context-protocol servers

| Function | Signature | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|
| `mcp.register` | `mcp.register(server, {command\|url, auth?}) → handle` | durable | 2 | exec+network | spawn/connect an MCP server (stdio or SSE), store the handle |
| `mcp.call` | `mcp.call(server, tool, args) → result` | async | 2 | read | JSON-RPC tool call to a registered server |

### `timer` — host-owned scheduling (the timer seam)

| Function | Signature | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|
| ★ `timer.every` | `timer.every(ms, event) → handle` | durable | 5 | read | host scheduler emits the event on a cadence; dropped on plugin unload |
| `timer.after` | `timer.after(ms, event) → handle` | durable | — | read | one-shot follow-up event (self-scheduled `{after, event}`) |

### `install` — download/install/compile (registry seam)

| Function | Signature | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|
| ★ `install.plugin` | `install.plugin(spec) → progress-event stream` | durable | 2 | network+write | download (git/zip), unpack, install to a plugin dir; progress as events |
| `install.tool` | `install.tool(id, {lang?}) → progress-event stream` | durable | 2 | network+exec | download/compile (mason tools, tree-sitter grammars) into PATH |

### `editor` — buffer transforms

| Function | Signature | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|
| ★ `editor.edit` | `editor.edit(mutation{retag\|wrap\|expand\|format-apply}, range) → ()` | sync | 5 | write | a small text-edit vocabulary applied to the buffer; the reducer computes the edit |
| `editor.snippet` | `editor.snippet(lang) → snippetSet` | async | 1 | read | host parses snippet files and hands back the set |

> Near-duplicates merged and where: `subagent.spawn` → `session.start({subagent:true})` · webhook alert →
> `net.request` · `notify.desktop` → `ui.notify` · `storage.store` → `store.*` · `websearch.query` → `net.search` ·
> `mason/treesitter/tpm/lazy` installers → `install.*` · `fzf`/`glow`/`snip`/`claude` subprocesses → `shell.run` ·
> `provider.proxy/header/register` → `llm.provider` · `secrets.redact`/`context.prune` → `session.inject` (pure gate).

---

## 2. Events the host must deliver

| Event | Payload | Delivered on | Plugins using it |
|---|---|---|---|
| `init` | `{reload?}` | load / hot-reload | 100 (all) |
| `command` | `{name, args}` | a command the reducer registered is invoked | ~60 |
| `key` | `{key, modifiers}` | a key no command claimed | ~40 |
| `tick` | `{now}` | host timer (statusline refresh, clock, resave) | ~20 |
| `resize` | `{width, height}` | terminal resized | ~12 |
| `chat.message` (user/assistant) | `{role, text, id}` | a message is added | ~14 |
| `session.start` / `session.complete` / `session.end` / `session.error` | `{id, …}` | session lifecycle | ~15 |
| `file-change` | `{path, kind}` | `fs.watch` fired | ~8 |
| `file-hover` / `file-select` | `{path}` | cursor moved in a file view | ~5 |
| `provider.request` / `provider.response` | `{provider, request, response}` | before/after a model call | ~8 |
| `tool.execute.before` / `tool.execute.after` | `{tool, args, output}` | a tool is run | ~6 |
| `usage` | `{tokens, cost, provider}` | turn/usage increments | ~6 |
| `permission-request` | `{action, resource}` | an approval is requested | ~4 |
| `picker-open` / `query-changed` | `{query, provider}` | a fuzzy picker is open / typed | ~6 |
| `buffer-open` / `text-changed` | `{uri, text, pos}` | an editor buffer changes | ~6 |
| `diagnostics` | `{uri, items[]}` | LSP pushes diagnostics | ~5 |
| `completion` | `{uri, pos, items[] (deltas)}` | completion candidates arrive | ~4 |
| `debug.*` | `{session, step, output, breakpoint}` | DAP events | ~2 |
| `install-progress` | `{id, percent, done}` | `install.*` reports progress | ~4 |
| `message` | `{text, kind}` | host message bus (noice-style routing) | ~2 |
| `inbox.message` | `{source, text}` | bot/inbox poll delivered | ~2 |
| `plan.created` / `plan.edited` | `{plan}` | plan mode enter / review applied | ~2 |
| `job.due` | `{job}` | `timer.every` schedule fires | ~2 |
| `location.sync` | `{}` | project/workspace changed | ~4 |
| `chunk` (stream bridge) | `{streamId, delta, done}` | generic partial-result bridge (LLM/ws/pty/quotes) | ~10 |

---

## 3. UI slots and return shapes

**Slots** (named boundaries a plugin renders into; the host diffs each and owns ordering/modes `append | replace |
single_winner`):

| Slot | Shape | Plugins |
|---|---|---|
| `status` | text (or styled spans) | ~30 statuslines / git-status / notifiers |
| `panel` | `{title, lines[]}` \| `null` | ~12 git/diff/debug panels |
| `sidebar.content` / `sidebar.footer` | list / text | ~8 trees, skills, agents, dir-tree |
| `home.footer` / `prompt.footer` / `home.prompt_right` | text / widgets | ~10 built-in feature-plugins |
| `preview` | text or image blob | ~5 yazi/telescope/tfm |
| `picker` | `{query, items[]}` | ~6 fuzzy finders |
| `diff` / `signs` | `{hunks[], signs[]}` | ~6 git-sign/neogit/hunk/diffview |
| `completion` | `{items[], selected}` | ~3 nvim-cmp |
| `list` | `{items[], filter}` | ~4 trouble/todo-quickfix |
| `debug` | `{threads, stack, variables}` | ~2 nvim-dap |
| toast / dialog / popup | transient (not a persistent slot) | ~10 noice/lazygit/prompts |

**Return shapes** (`{ state, slots, commands }`, plus two extensions):

- `state` — plain JSON, a full replace (omit to keep); the host persists it and keeps it across fail/reload.
- `slots` — `{ [slotId]: text | {title, lines} | list | image | null }`; `null` hides the slot.
- `commands` — `[{ name, title, key?, widget? }]`, a full replace of the plugin's keymap layer (palette + slash from `title`).
- `permit` / `deny` (D archetype) — a gate decision the host honors for the intercepted op.
- `result` (H archetype) — `{ output, content }` returned as a tool result.

---

## 4. Blockers and the smallest host capability that removes each

Only four things survive the rewrite. Each is removed by exactly one host capability; the plugin then becomes a
thin reducer.

### 4.1 Streaming — `chunk` event bridge

Partial results (LLM tokens, LSP deltas, completion menus, debug console, live quotes/chats, spawned previewers) must
arrive as a **sequence of events**, so the host exposes a *stream → `chunk` events* bridge (a durable async function
that emits `chunk` rather than returning once).

- **Smallest capability:** durable async host fns that emit progress/chunk events; slots are re-rendered per chunk.
- **Unblocks:** OpenCode, nvim-cmp, nvim-lspconfig, trouble, lspsaga, nvim-dap, yazi/glow previewers, waha-tui,
  gloomberb, opencode-llm-proxy, plannotator, opencode-pty.

### 4.2 Background work — durable async host functions + host timer

Work that must run *between* events (subagent loops, install/download/compile, debug & LSP sessions, bots/inbox
polling, background recall) cannot live in a per-event reducer. Move it into **durable async host functions** that
keep running and report progress/finish *as events*, plus the `timer.every/after` seam.

- **Smallest capability:** `session.start({subagent})`, `install.*`, `lsp.start`, `dap.start`, `net.subscribe`,
  `timer.every` — all already in the catalogue; the loader only needs to own their lifetimes.
- **Unblocks:** ponytail, oh-my-opencode-slim, opencode-swarm, opencode-ensemble, mission-control, conductor, micode,
  FlowDeck, kimaki, caspian, lazy.nvim, mason, nvim-treesitter, tpm, nvim-dap, daytona.

### 4.3 Native dependencies — host-owned spawn/embed

A specific binary/artifact (`fzf`, compiled tree-sitter grammars, LSP/DAP binaries, LanceDB/vector stores, GPU image
protocol, `glow`/`snip`/`claude` subprocesses) is a **host resource**, not plugin state — the host spawns/embeds it.

- **Smallest capability:** `shell.run`, `install.tool` (compile), `fs.preview` (host renders), or an in-process native
  crate the host links; the plugin only names it.
- **Unblocks:** telescope/fzf family, nvim-treesitter, opencode-mem, OpenCodeRAG, basemind, deja-vu,
  firecrawl/tavily/snip/claude-code-plugin, tfm-tui.

### 4.4 Large state — host-side durable store + query handle

Indexes, snippet forests, quote caches and SQLite that must persist across events exceed per-event JSON state. They
live **host-side**; the plugin holds only a reference/cursor.

- **Smallest capability:** `store.get/set` (durable) plus a query/handle returned by the index-building host fn; the
  reducer passes the handle, never the structure.
- **Unblocks:** OpenCodeRAG, opencode-mem, FlowDeck, gloomberb, picker indexes (telescope/fzf/ctrlp caches).

**(Context, from the `psychoscript-plugins` prototype `REPORT.md`.)** These four map one-for-one onto the prototype's
recorded limits: long-lived runs are "not viable today" (no GC, timeout counts idle time, snapshots don't survive a
source change); async host fns and durable plain-JSON state already work; what OpenTUI still lacks is a **slot
registry** and a **data-driven view/reconciler** — the two pieces the reducer's `slots` return ultimately needs.
