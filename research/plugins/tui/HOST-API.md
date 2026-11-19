# TUI host API — functions, events, slots, return shapes

**The TUI part, in full detail.** The OpenCode TUI moves to Rust (OpenTUI + PsychoScript reducers); this is everything
the terminal client must expose to the 73 TUI-relevant plugins in `./TOP100.md` (62 TUI + 11 Both). Function names here
are the canonical names in that file's "Host fns (TUI)" column.

**Side:** `TUI` = client-only function · `Both` = the same seam serves the server too; only the TUI use is listed
here (the server use is in `../server/HOST-API.md`). **n/73** = how many of the 73 TUI-relevant plugins call it.
**Class:** `read` / `write` / `exec` / `network` / `secret`. **★** = the 15 functions that cover most TUI plugins.

## 1. TUI function catalogue

### `fs` — workspace filesystem

| Function | Signature | Side | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|---|
| ★ `fs.list` | `fs.list(dir, {filter?}) → {name, path, isDir}[]` | TUI | async | 6 | read | `std::fs::read_dir`, sorted, off-thread |
| `fs.read` | `fs.read(path) → string \| bytes` | TUI | async | 1 | read | `std::fs::read`, size-capped |
| ★ `fs.write` | `fs.write(path, data) → ()` | TUI | sync | 4 | write | `std::fs::write`, sandboxed |
| `fs.remove` | `fs.remove(path) → ()` | TUI | sync | 1 | write | `remove_file`/`remove_dir` |
| `fs.stat` | `fs.stat(path) → {size, mtime, isDir}` | TUI | sync | 2 | read | `std::fs::metadata` |
| ★ `fs.preview` | `fs.preview(path, {range?}) → rendered text/image` | TUI | async | 5 | read | host previewer (mime→highlight/`glow`/image protocol) |
| ★ `fs.watch` | `fs.watch(path) → subscription` | Both | durable | 4 | read | `notify` crate → `file-changed` events (server also uses it to re-index) |

### `git` — version control

| Function | Signature | Side | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|---|
| `git.status` | `git.status(repo?) → {branch, dirty, ahead, behind, files}` | TUI | async | 3 | read | `git2`/`git status --porcelain=v2`, cached |
| ★ `git.diff` | `git.diff({path?, ref?, base?}) → {hunks[]}` | TUI | async | 6 | read | `git diff` parse, debounced |
| `git.history` | `git.history({path?, line?}) → commits[] \| blame` | TUI | async | 2 | read | `git log`/`git blame` parse |
| ★ `git.apply` | `git.apply(op{stage,commit,push,checkout,branch}, args)` | Both | async | 5 | write+exec | `git2`/`git` CLI (server uses the `worktree` op) |

### `shell` — processes

| Function | Signature | Side | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|---|
| ★ `shell.run` | `shell.run(cmd, {cwd, env, input?}) → {code, stdout, stderr}` | Both | async | 12 | exec | `std::process::Command`, off-thread (server spawns MCP/agent CLIs) |
| `shell.stream` | `shell.stream(cmd, args) → chunk-event stream` | TUI | durable | 2 | exec | spawn PTY/pipe, pump reads onto the queue |

### `net` — network

| Function | Signature | Side | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|---|
| ★ `net.request` | `net.request({url, method, headers, body, timeout}) → resp` | Both | async | 9 | network | `reqwest`/`ureq`, token budget + size cap |
| `net.listen` | `net.listen({port?, routes}) → {port}` | Both | durable | 2 | network | small `hyper`/`axum` listener on an ephemeral port |
| `net.subscribe` | `net.subscribe(url, {mode: ws\|poll}) → event stream` | Both | durable | 1 | network | WebSocket/poll task → inbound events |

### `state` — current client/editor state

| Function | Signature | Side | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|---|
| ★ `state.read` | `state.read(keys?) → {branch, mode, diagnostics, theme, file, workspace}` | TUI | sync | 12 | read | snapshot struct from app state, serialized from the UI thread |

### `session` — sessions (client side)

| Function | Signature | Side | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|---|
| `session.list` | `session.list() → {id, title, cost}[]` | Both | async | 3 | read | read the session directory (data owned by the server) |
| ★ `session.save` / `restore` | `session.save(id) → snapshot` · `session.restore(snapshot) → id` | TUI | durable | 5 | read+write | serialize/restore panes/tabs/session to durable JSON |

### `ui` — dialogs, toasts, notifications, surfaces

| Function | Signature | Side | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|---|
| ★ `ui.dialog` | `ui.dialog(kind{alert,confirm,prompt,select}, opts) → choice` | TUI | async | 4 | read | modal stack via renderer |
| `ui.toast` | `ui.toast(message, {kind?}) → ()` | TUI | sync | 1 | read | push toast |
| `ui.notify` | `ui.notify(title, body, {sound?}) → ()` | TUI | sync | 4 | read | desktop notification + attention sound |
| `ui.annotate` | `ui.annotate(plan) → ()` | TUI | sync | 1 | read | open the plan-annotation surface |

### `clipboard`

| Function | Signature | Side | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|---|
| `clipboard.set` | `clipboard.set(text) → ()` | TUI | sync | 4 | write | `arboard`/`clipboard` or OSC-52 over the PTY |
| `clipboard.get` | `clipboard.get() → text` | TUI | sync | 2 | read | same seam, read direction |

### `store` — durable + ephemeral storage

| Function | Signature | Side | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|---|
| ★ `store.get` / `store.set` | `store.get(key) → value` · `store.set(key, value) → ()` | Both | durable | 6 | read+write | per-plugin JSON on disk, live-synced (server shares it for tokens/locks) |
| `store.memory` | `store.memory(key) → value` | Both | sync | — | read+write | in-RAM map surviving hot reload (TUI feature-plugins) |

### `lsp` / `dap` — language and debug servers

| Function | Signature | Side | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|---|
| `lsp.start` | `lsp.start(server, {workspace}) → handle` | TUI | durable | 2 | exec | spawn server, JSON-RPC over stdio, notifications → events |
| ★ `lsp.query` | `lsp.query(kind{diagnostics,definition,references,symbols,complete}, args) → result` | TUI | async | 6 | read | one read-only LSP method |
| `dap.start` | `dap.start(adapter, {program}) → handle` | TUI | durable | 1 | exec | spawn debug adapter, hold session |
| `dap.command` | `dap.command(step\|continue\|next\|variables\|breakpoints, args) → result` | TUI | async | 1 | read | drive a running debug session |

### `timer` — host-owned scheduling

| Function | Signature | Side | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|---|
| `timer.every` | `timer.every(ms, event) → handle` | Both | durable | 3 | read | host scheduler cadence (statusline refresh/autosave) |
| `timer.after` | `timer.after(ms, event) → handle` | Both | durable | 1 | read | one-shot follow-up event |

### `install` — plugin/tool registry

| Function | Signature | Side | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|---|
| ★ `install.plugin` | `install.plugin(spec) → progress-event stream` | TUI | durable | 2 | network+write | download (git/zip), install, progress as events |
| `install.tool` | `install.tool(id, {lang?}) → progress-event stream` | TUI | durable | 2 | network+exec | download/compile (mason tools, tree-sitter grammars) |

### `editor` — buffer transforms

| Function | Signature | Side | Kind | Need | Class | Rust host |
|---|---|---|---|---|---|---|
| ★ `editor.edit` | `editor.edit(mutation{retag\|wrap\|expand\|format-apply}, range) → ()` | TUI | sync | 5 | write | small text-edit vocabulary applied to the buffer |
| `editor.snippet` | `editor.snippet(lang) → snippetSet` | TUI | async | 1 | read | host parses snippet files, hands back the set |

---

## 2. TUI events the client must deliver

| Event | Payload | Fired on | Plugins |
|---|---|---|---|
| `init` | `{reload?}` | load / hot-reload | 73 (all) |
| `command` | `{name, args}` | a registered command/keybind is invoked | ~45 |
| `key` | `{key, modifiers}` | a key no command claimed | ~30 |
| `tick` | `{now}` | host timer | ~15 |
| `resize` | `{width, height}` | terminal resized | ~10 |
| `focus` | `{widget, panel}` | focus moves between panes/widgets | ~8 |
| `selection` | `{widget, indices, items}` | a selection/list cursor moves | ~10 |
| `prompt-input` | `{text, cursor}` | prompt/composer input changes | ~6 |
| `message` (rendered) | `{role, text, id}` | a message is rendered to the transcript | ~6 |
| `session-switched` | `{id, prevId}` | the active session changes | ~8 |
| `file-change` | `{path, kind}` | `fs.watch` fired | ~6 |
| `file-hover` / `file-select` | `{path}` | cursor in a file view | ~4 |
| `buffer-open` / `text-changed` | `{uri, text, pos}` | editor buffer changes | ~5 |
| `diagnostics` | `{uri, items[]}` | LSP deltas | ~4 |
| `completion` | `{uri, pos, items[]}` | completion candidates | ~3 |
| `debug.*` | `{session, step, output, breakpoint}` | DAP events | ~2 |
| `install-progress` | `{id, percent, done}` | `install.*` progress | ~3 |
| `picker-open` / `query-changed` | `{query, provider}` | fuzzy picker open / typed | ~4 |
| `clipboard` | `{text}` | clipboard write observed | ~3 |
| `status` (broadcast) | `{branch, mode, diagnostics, theme}` | state refresh | ~8 |
| `chunk` (stream bridge) | `{streamId, delta, done}` | partial-result bridge (LLM/pty/quotes) | ~6 |

## 3. Slots and return shapes (TUI)

**Slots** (named boundaries; host diffs each and owns ordering/modes `append | replace | single_winner`):

| Slot | Shape | Plugins |
|---|---|---|
| `status` | text or styled spans | ~22 statuslines/status bars |
| `panel` | `{title, lines[]}` \| `null` | ~10 git/diff/debug panels |
| `sidebar.content` / `sidebar.footer` | list / text | ~6 trees/skills/agents |
| `home.footer` / `prompt.footer` / `home.prompt_right` | text / widgets | ~8 built-in feature-plugins |
| `preview` | text or image blob | ~4 yazi/telescope/tfm |
| `picker` | `{query, items[]}` | ~4 fuzzy finders |
| `diff` / `signs` | `{hunks[], signs[]}` | ~5 git-sign/neogit/hunk/diffview |
| `completion` | `{items[], selected}` | ~3 nvim-cmp |
| `list` | `{items[], filter}` | ~3 trouble/todo |
| `debug` | `{threads, stack, variables}` | ~2 nvim-dap |
| toast / dialog / popup | transient | ~8 noice/lazygit/prompts |

**Return shapes** `{ state, slots, commands }`:

- `state` — plain JSON, full replace (omit to keep); host persists and keeps across fail/reload.
- `slots` — `{ [slotId]: text | {title, lines} | list | image | null }`; `null` hides.
- `commands` — `[{ name, title, key?, widget? }]`, full replace of the plugin's keymap layer (palette + slash from `title`).

(A `Both` plugin's server-side returns — tools, slash commands, injections, permissions, tool results — are in
`../server/HOST-API.md`; the TUI file only ever returns `state` + `slots` + `commands`.)

## 4. Blockers (TUI side)

Only three of the four real blockers bite the client, and each is removed by a host capability already in this
catalogue: **streaming** (→ the `chunk`-event bridge; unblocks OpenCode, nvim-cmp, trouble, lspsaga, nvim-dap, yazi,
waha-tui, gloomberb, plannotator, opencode-pty) · **native deps** (→ `shell.run`/`install.tool`/`fs.preview`; unblocks
the fzf family, nvim-treesitter, tfm-tui) · **large-state** (→ host-side `store.get/set` + a query handle; unblocks the
picker indexes and quote caches). The fourth — **background work** — is mostly a server concern; on the TUI it is
absorbed by durable async host fns and `timer.every`, so no TUI plugin is blocked by it once the host owns lifetimes.
