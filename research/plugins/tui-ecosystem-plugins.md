# OpenTUI and terminal-app plugins: what they need from a host

Scope: OpenTUI packages and plugins (opentui.com/packages, the anomalyco/opentui-index
repo, and the OpenCode TUI slot/runtime plugins), plus the plugin systems of the
terminal apps an OpenTUI app would want to match — lazygit, k9s, yazi, helix, zellij,
wezterm, Neovim (by category) and tmux.

Framing: these plugins do **not** need to work as they are. They will be rewritten as
PsychoScript **reducer plugins** — each event runs the plugin briefly with
`{ event, state }`, it returns `{ state, slots, commands }`, state is plain JSON the
host keeps, and the only way out is host functions (sync/async, durable, namespaced).
So for each plugin the last column records: **what it needs functionally** (the
capability, not its current API), and **how a rewrite looks** (events it reacts to,
state it keeps, what it returns, which host functions it calls). Only **real blockers**
are flagged — things a rewrite cannot avoid: long-running background work, streaming,
native dependencies, or very large in-memory state. Things that merely look blocking
(async host calls, debounce timers, periodic refresh) are absorbed by the host and are
*not* blockers.

## Method and sources

- **Ranked by GitHub stars**, queried from the GitHub REST API on **2026-11-19**, with
  **npm weekly downloads** from the npm registry API on **2026-11-19** as a secondary
  signal, and prominence in official docs / awesome-lists third.
- OpenTUI package star counts and versions come from `anomalyco/opentui-index`
  `packages/facts.json` (last updated **2026-11-19**, commit `8dfbea7`), computed daily
  by the index's `update-facts.yml` workflow from GitHub repo metadata.
- Plugin-API facts were fetched from primary sources: k9s
  [Plugins](https://k9scli.io/topics/plugins/), yazi
  [Plugins (BETA)](https://yazi-rs.github.io/docs/plugins/overview), zellij
  [Plugins](https://zellij.dev/documentation/plugins), lazygit
  [Custom Command Keybindings](https://github.com/jesseduffield/lazygit/blob/master/docs/Custom_Command_Keybindings.md),
  helix [FAQ "What about plugins?"](https://helix-editor.com/faq.html), and
  [awesome-wezterm](https://github.com/michaelbrusegard/awesome-wezterm).

Host-need abbreviations in the "Host needs" column:

`FS` filesystem r/w, `FSW` filesystem watch, `SHELL` process spawn, `NET` network/fetch,
`GIT` git, `LLM` model/session access, `MCP` MCP tools, `SESS` session/workspace access,
`UI` slots/dialogs/toasts/panels, `KEY` keybinds, `TIMER` timers/background, `KV` persistent
storage, `CLIP` clipboard, `NOTIF` notifications, `ENV` env/secrets, `NATIVE` native/binary deps.

Blocker tags in the last column:

`⛔streaming` partial/incremental results must arrive as a sequence of events
`⛔background` off-thread work that runs between events (install, debug session, daemon)
`⛔native` a specific native/binary artifact is required (fzf, tree-sitter, LSP/DAP, WASM, GPU)
`⛔large-state` a working set too big for per-event JSON plugin state
`—` none: it rewrites with async host fns + host-driven events alone.

---

## Earlier OpenTUI research (anomalyco/opencode branches)

Before this survey, the team already mapped the OpenCode TUI plugin surface and example
plugins. These are the *pre-existing* findings about existing plugins and what they need
(not the proposed approaches):

- **Built-in slot/runtime plugins exist and define the categories.**
  `packages/opencode/specs/tui-plugins.md` on branch
  `copilot/research-opencode-server-plugin-api` (commit `3a0e00d`) lists eight built-in
  TUI plugins: `internal:home-tips`, `internal:sidebar-context`, `internal:sidebar-mcp`,
  `internal:sidebar-lsp`, `internal:sidebar-todo`, `internal:sidebar-files`,
  `internal:sidebar-footer`, `internal:plugin-manager`. Sidebar order is fixed by weight
  (context 100, mcp 200, lsp 300, todo 400, files 500). These map directly onto the
  Neovim categories surveyed below (file pickers / LSP UIs / git / todos).
- **Host UI slots a plugin renders into** (same file): `app`, `home_logo`, `home_prompt`,
  `home_prompt_right`, `session_prompt`, `session_prompt_right`, `home_bottom`,
  `home_footer`, `sidebar_title`, `sidebar_content`, `sidebar_footer`. Slot modes are
  `replace`, `single_winner`, `append`; the host renders `home_logo`/`home_prompt`/
  `session_prompt` with `replace`, `home_footer`/`sidebar_title`/`sidebar_footer` with
  `single_winner`, and the rest with the default mode. Slot context exposes only `theme`.
- **What a real plugin consumes** (from `.opencode/plugins/tui-smoke.tsx` and
  `tui-config-once-toast.tsx` on branch `example-tui-plugin`, commit `df4362a`): command
  registration (with keybind + slash command), routes, the dialog stack
  (`DialogAlert`/`DialogConfirm`/`DialogPrompt`/`DialogSelect` + `ui.dialog`), toasts, a
  plugin-local keybind set, theme read/install/switch, a renderer post-process hook
  (`api.renderer.addPostProcessFn`, cleaned up via `lifecycle.onDispose`), per-slot
  rendering with session/workspace ids, and module-level once-only state (`seen`).
- **Host capabilities a plugin reaches for** (same branch): filesystem create/remove
  (`packages/plugin/src/example-workspace.ts` uses `node:fs/promises` `mkdir`/`rm` to
  back a workspace adaptor) and shell spawn (`packages/plugin/src/shell.ts` exposes a
  `BunShell` tagged-template with `cwd`, `env`, `nothrow`, stdin/stdout streams).

---

## Ranked survey

> Stars = GitHub stargazers, fetched 2026-11-19; DLs = npm weekly downloads
> (last-week), fetched 2026-11-19; ★ = from opentui-index `facts.json` (2026-11-19).
> `opentui-*` monorepo packages share the `sst/opentui` star count. Maintainers are the
> primary org/author at fetch time.

| # | Plugin (maintainer / link) | Stars · DLs | What it does | API surface | Host needs | Cx | Functional need → reducer rewrite · blocker |
|---|---|---|---|---|---|---|---|
| 1 | **OpenCode** ([sst/opencode](https://github.com/sst/opencode)) | 227,846 · `@opencode-ai/plugin` 35.2M DLs/wk | AI coding agent; OpenTUI TUI with the slot/runtime plugin system | `tui(api,...)`: `command`, `route`, `ui.Dialog*`/`ui.toast`, `keybind`, `kv`, `state`, `client`, `event.on`, `slots.register`, `theme`, `renderer` | LLM, MCP, SESS, FS, GIT, UI, KEY, KV, NET | L | It is the **reference host**; its 8 built-ins are the reducer plugins to copy. need: agent session UI + LLM/MCP + git/fs. on: session events. state: {}. → slots (sidebar lsp/files/todo, prompt), commands. host: `llm`, `mcp`, `state.*`, `git`. ⛔streaming (LLM response is streamed → host pushes chunk events). |
| 2 | **lazygit** ([jesseduffield](https://github.com/jesseduffield/lazygit)) | 83,961 | Git TUI; custom commands extend it | `customCommands` YAML: `key`, `context`, shell `command` (Go templates), `prompts` (input/menu/confirm/menuFromCommand), `output` (none/terminal/log/popup), `after` | SHELL, GIT, UI(prompts/popups), KEY, ENV | M | need: run a shell command seeded with the selection + a prompt form. on: key/context (command invoked). state: { form }. → commands (title+key per context); host: `shell(cmd, env, event.payload)`, `prompt`. ⛔— (long output is host-rendered in a popup/terminal). |
| 3 | **helix** ([helix-editor](https://github.com/helix-editor/helix)) | 46,936 | Modal editor; **no plugin system** | None: `config.toml`, `languages.toml`, themes only; Steel/scheme plugin PR #8675 unmerged | (n/a — LSP binaries, tree-sitter) | — | need: to match Neovim it needs full buffer/UI/LSP access in the *host*, then plugins ride slots. No plugin to rewrite today. ⛔native (LSP/tree-sitter) if parity sought. |
| 4 | **yazi plugins** ([sxyazi/yazi](https://github.com/sxyazi/yazi)) | 43,515 | File manager; Lua plugins (BETA) | `main.lua` `entry`/`setup`, previewer `peek`/`seek`, preloader `preload`; `@sync`/`@since`; `ya.sync`; `job.*`; `ya.emit` | FS, SHELL, NET, UI(draw preview area), TIMER, state | L | need: file metadata + preview text for a hovered file. on: file-hover/scroll (host-driven). state: { skip }. → `preview` slot (text). host: `fs.stat`, `fs.preview(file)`, `shell` (git/mime). ⛔streaming (byte-level preview/seek) if host can't pre-render the preview itself. |
| 5 | **zellij plugins** ([zellij-org](https://github.com/zellij-org/zellij)) | 36,141 | Multiplexer; WASM/WASI plugins | `zellij-tile`: render UI, react to `Event`s (key/mode/mouse/clipboard), send `Command`s | UI(panes/draw), KEY, CLIP, TIMER, ENV | L | need: render a first-class pane + turn keys into host commands. A reducer can't *be* the WASM render loop. on: key/mode/clipboard events. state: {}. → commands (host actions), a status slot. host: `send(command)`, `clipboard`. ⛔background (persistent render subscription) — the loop lives in the host, not the plugin. |
| 6 | **k9s** ([derailed/k9s](https://github.com/derailed/k9s)) | 34,996 | Kubernetes TUI; YAML plugins | `plugins.yaml`: `shortCut`, `scopes`, `command`+`args`, `background`; env `$NAME`/`$NAMESPACE`/`$CONTEXT`/`$COL-*` | SHELL, ENV, NET(kubectl) | M | need: run a kubectl/flavored shell command seeded by the selected resource + env. on: shortcut key in a resource view. state: {}. → commands (scoped), host: `shell(cmd, event.payload + env)`, async for `background`. ⛔—. |
| 7 | **wezterm plugins** ([wez/wezterm](https://github.com/wez/wezterm)) | 29,602 | GPU terminal; Lua plugin system | `wezterm.plugin.require(url)`, config/event callbacks; `wezterm.action`, timer/format callbacks | FS, SHELL, NET, UI(tab/status), KEY, CLIP, TIMER | L | need: terminal UI (status/tab), keybinds, spawn/net, session save. on: timer/format/key events. state: {}. → status/tab slots + commands. host: `shell`, `fetch`, `clipboard`, session save/restore. ⛔background only if a plugin drives live UI (usually host interval). |
| 8 | **vim-fugitive** ([tpope](https://github.com/tpope/vim-fugitive)) | 21,830 | Git porcelain inside Vim | Vimscript commands, buffers, `autocmd`s, async jobs, `:Git` dispatch, statusline | GIT, SHELL, FS, UI(buffers/quickfix), KEY | L | need: git state + run git commands + render a status/diff view. on: command (commit/add/push). state: {}. → `git` panel slot + commands. host: `git.status/diff/log`, `shell`. ⛔— (async git is host-`git.*`). |
| 9 | **lazy.nvim** ([folke](https://github.com/folke/lazy.nvim)) | 21,736 | Neovim plugin manager | Lua spec DSL, lockfile, lazy-loader (module/event/cmd/ft/keys), profiler, commands | FS, SHELL(git clone), NET, TIMER, KEY | L | need: install/update/lock a plugin set + lazy-load on events. on: command (install/update). state: { lockfile }. → commands + a plugins panel. host: `plugin.install(spec)`, `plugin.list()`, `git`. ⛔background (download/install run long; host must report progress via events). |
| 10 | **telescope.nvim** ([nvim-telescope](https://github.com/nvim-telescope/telescope.nvim)) | 19,866 | Fuzzy finder framework | Pickers, finders, sorters (`fzf`), previewers, actions, extensions, async | FS, GIT, LSP, SHELL, UI(float/insert), KEY | L | need: a fuzzy picker over files/git/lsp + preview + action. on: picker open + query-changed events. state: { query, selection }. → `picker` slot + commands. host: `files.list`, `git.refs`, `lsp.symbols`, `fs.preview`. ⛔native (fzf-quality ranking) if exact parity; else the host filters. |
| 11 | **vim-airline** ([vim-airline](https://github.com/vim-airline/vim-airline)) | 17,967 | Status/tabline | `statusline`/`tabline` options, sections, extensions, highlight groups, autocmd refresh | FS, GIT(branch), LSP, KEY | M | need: a status line built from host state. on: mode/branch/diagnostics-change. state: {}. → `status` slot (configured sections). host: `state.branch/diagnostics/mode`. ⛔—. |
| 12 | **tpm** ([tmux-plugins/tpm](https://github.com/tmux-plugins/tpm)) | 15,181 | tmux plugin manager | `@plugin` opts, `run-shell`, `source-file`, `bind-key` | SHELL, FS(clone), ENV | S | need: clone/install/source a plugin list. on: install/update commands. state: { plugins }. → commands. host: `plugin.install`, `shell`. ⛔background (clone) — host-owned install fn. |
| 13 | **nvim-treesitter** ([nvim-treesitter](https://github.com/nvim-treesitter/nvim-treesitter)) | 14,550 | Syntax/config layer for tree-sitter | Parser install/compile, queries, injections, language modules, `health` | NATIVE(parsers), SHELL(cc), FS, GIT | L | need: per-language grammar availability + query selection. on: language/extension event. state: {}. → editor highlight is host-owned; plugin only configures. host: `grammar.install(lang)` (compiles), `query.get(lang)`. ⛔native (compiled grammars) + background (compile) — both inside a durable host fn, not plugin state. |
| 14 | **nvim-lspconfig** ([neovim](https://github.com/neovim/nvim-lspconfig)) | 14,017 | LSP client configs | Per-server `configs`, `setup`, capabilities/on_attach, `vim.lsp` events | SHELL(spawn servers), FS, NET, LSP | L | need: an LSP client (spawn server, capabilities, on_attach). on: buffer-open/language events. state: { attached }. → diagnostics/definitions come *to* the plugin as host events. host: `lsp.start(server)`, `lsp.diagnostics`, `lsp.definition`. ⛔streaming (diagnostics/completion deltas as events) + it owns a long-lived server (host process). |
| 15 | **opentui-* core/solid/react/keymap/ssh/three/qrcode** ([sst/opentui](https://github.com/sst/opentui)) | 13,852★ · core 2.0M, solid 623k, react 537k, keymap 380k DLs/wk | OpenTUI rendering libs + keymap/SSH | TS/Solid/React renderables, `createSlotRegistry`, keymap layer, SSH | UI, KEY, NATIVE | L | This is the host's **render/input layer**, not a plugin. need: the slot registry + view reconciler plugins target. on: n/a. ⛔native (renderer) — host-owned. |
| 16 | **tmux-resurrect** ([tmux-plugins](https://github.com/tmux-plugins/tmux-resurrect)) | 13,150 | Save/restore tmux sessions | Shell scripts; `@resurrect-*`, `after-restore` hooks; pane layout to file | SHELL, FS, ENV, SESS | M | need: snapshot session state and re-create it later. on: save/restore commands. state: {}. → commands. host: `session.save()`, `session.restore()` (durable), `fs`. blocker — (host owns session state). |
| 17 | **mason.nvim** ([mason-org](https://github.com/mason-org/mason.nvim)) | 10,539 | Install/manage LSP & tools | Registry packages, `MasonInstall`, download/unpack, PATH, UI window | NET, SHELL, FS, NATIVE | L | need: a tool registry + download/install into PATH + a manage UI. on: install/uninstall/list commands. state: { installed }. → commands + a managed-tools panel. host: `tool.install(id)` (downloads, durable), `tool.list()`. ⛔background (download/unpack with progress → host events). |
| 18 | **fzf.vim** ([junegunn](https://github.com/junegunn/fzf.vim)) | 10,279 | `fzf` picker for Vim | Vimscript wrappers spawning `fzf`, `--expect`/sink callbacks, `termopen` | NATIVE(fzf), SHELL, FS, UI(term) | M | need: fuzzy pick + pass selection to an action. on: picker query events. state: { query }. → `picker` slot + a command. host: `files.list`, `picker.select`. ⛔native (fzf binary) if ranking parity; else host matcher. |
| 19 | **hunk** ([modem-dev/hunk](https://github.com/modem-dev/hunk)) | 9,849★ · `hunkdiff` 4,568 DLs/wk | OpenTUI Git/diff review app | React component API (`hunkdiff/opentui`), diff parsers, file nav, watch mode | GIT, FS, UI, KEY | L | need: git/jj/sapling diff parse + review UI + watch-reload. It is a full app; its component export is the renderer-slot seam. on: diff-watch/reload events. state: {.} → `diff` slot + commands. host: `git.diff`, `fs.watch` (→ reload events). ⛔— (watch is a host event). |
| 20 | **mini.nvim** ([echasnovski](https://github.com/echasnovski/mini.nvim)) | 9,671 | 45+ small Lua modules (incl. `mini.statusline`, `mini.files`, `mini.pick`) | Module spec DSL, `Mini*` APIs, autocmds, keymaps, highlights | FS, UI, KEY, GIT(starter) | L | need: one focused capability per module (status, file open, pick). Each module = one small reducer. on: module-specific events. state: small module state. → `status`/`files`/`picker` slot each. host: `state.*`, `fs`, `git`. ⛔— (each slice is pure-ish). |
| 21 | **nvim-cmp** ([hrsh7th](https://github.com/hrsh7th/nvim-cmp)) | 9,491 | Completion engine | Event-driven sources (`EventType`), async sources, `vim.schedule`, menus | LSP, FS, SHELL, NET | L | need: complete a prefix from async sources with a ranked menu. on: text-changed events. state: { items }. → `completion` menu slot. host: `lsp.complete(buf,pos)`, `source(provider)`. ⛔streaming (async source results arrive over time → host events), debounce→host. |
| 22 | **harpoon** ([ThePrimeagen](https://github.com/ThePrimeagen/harpoon)) | 9,244 | Per-project file marking/nav | `:lua require("harpoon"):list():add()`, UI list, keybind nav | FS, KV(list), UI, KEY | S | need: a per-project list of marked files + jump-to. on: add/remove/jump commands. state: { marks: [...] } (persisted). → commands (one per mark) + a list slot. host: `kv`. ⛔—. |
| 23 | **vim-gitgutter** ([airblade](https://github.com/airblade/vim-gitgutter)) | 8,517 | Git diff signs in gutter | `sign` column, async `git diff` jobs, hunk preview, autocmd updates | GIT, SHELL, FS, UI(signs) | M | need: per-line git diff info rendered as signs. on: buffer-change (debounced by host). state: {}. → `signs` slot (hunk marks). host: `git.diff(file)` (async). ⛔— (async diff and debounce are host-side). |
| 24 | **lualine.nvim** ([nvim-lualine](https://github.com/nvim-lualine/lualine.nvim)) | 8,187 | Config-based statusline | Declarative `sections`, components (branch/diagnostics/diff/mode), extensions, refresh | GIT, LSP, FS, UI, KEY | M | need: a declaratively-configured status line. on: host broadcasts a `status` event with {branch, diagnostics, mode}. state: { config }. → `status` slot. host: `state.*`. ⛔—. |
| 25 | **which-key.nvim** ([folke](https://github.com/folke/which-key.nvim)) | 7,343 | Keybind popup helper | Keymap introspection, popup UI, sort/groups, buffer-local chains | UI(popup), KEY | M | need: show the keymap for a pending prefix. on: key-prefix event. state: {}. → a `popup`/`commands` listing. host: `keymap.pending()` (host already owns commands). ⛔—. |
| 26 | **nvim-dap** ([mfussenegger](https://github.com/mfussenegger/nvim-dap)) | 7,313 | Debug Adapter Protocol client | Adapters, sessions, breakpoints, threads/stack, `dap-ui` | SHELL(debuggers), NET, FS, UI | L | need: drive a debug adapter (launch, step, inspect) + show threads/stack/watch. on: debug commands + adapter-output events. state: { breakpoints }. → `debug` panel slot + commands. host: `dap.start/step/variables()`, `dap.events` → plugin events. ⛔background (long debug session is a host-held process) + streaming (console/stdout output). |
| 27 | **gitsigns.nvim** ([lewis6991](https://github.com/lewis6991/gitsigns.nvim)) | 7,191 | Git signs + hunk staging/preview | Async `git` via libuv, signs, `vim.schedule`, hunk actions, `blame` | GIT, SHELL, FS, UI(signs), KEY | L | need: diff signs + stage/reset hunk + per-line blame. on: buffer-change (debounced) + hunk commands. state: {}. → `signs` slot + commands. host: `git.diff/blame/stage`. ⛔— (async + debounce are host-side). |
| 28 | **oil.nvim** ([stevearc](https://github.com/stevearc/oil.nvim)) | 6,988 | File explorer as editable buffer | Buffer-backed FS view, `:w` persists edits, adapters (local/ssh/trash), column UI | FS, FSW, UI, KEY | L | need: list/edit a directory and write edits back on save. on: open-dir/rename/delete commands. state: { pending edits }. → `files` slot + commands. host: `fs.list`, `fs.write`, `fs.watch` (→ change events), `fs.mv/rm`. ⛔— (watch is host-driven). |
| 29 | **trouble.nvim** ([folke](https://github.com/folke/trouble.nvim)) | 6,917 | Diagnostics/references/quickfix UI | Lists, providers (LSP/telescope/quickfix), actions, preview, sorting | LSP, FS, GIT, UI, KEY | M | need: a filterable list of diagnostics/refs with preview + jump. on: open-diagnostic list command. state: { filter }. → `list` slot + commands. host: `lsp.diagnostics`, `lsp.references`, `fs.preview`. ⛔streaming (live diagnostics deltas → host events). |
| 30 | **lightline.vim** ([itchyny](https://github.com/itchyny/lightline.vim)) | 6,873 | Lightweight statusline | `statusline` format, components, modes, autocmd/timer refresh | GIT, LSP, FS, UI | S | need: status line (like lualine, simpler). on: status event. state: { config }. → `status` slot. host: `state.*`. ⛔—. |
| 31 | **diffview.nvim** ([sindrets](https://github.com/sindrets/diffview.nvim)) | 5,893 | Git diff/merge UI | Diff views, file panel, history, `tab` layout, hooks | GIT, SHELL, FS, UI | M | need: list changed files + render diffs + cycle history. on: open/cycle commands. state: { index }. → `diff` and `files` slots + commands. host: `git.diff`, `git.history`. ⛔—. |
| 32 | **noice.nvim** ([folke](https://github.com/folke/noice.nvim)) | 5,832 | Replaces msg/cmdline UI | Routes/messages, popups, async notifications, `vim.notify`, cmdline | UI(popups/toasts), ENV, TIMER, NOTIF | L | need: route host messages to toasts/popups + a cmdline. on: message events (host pushes). state: { routes }. → `toast`/`popup` slots + commands. host: `message` bus (host-owned), `ui.toast/dialog`. ⛔— (the bus is a host event stream). |
| 33 | **Neogit** ([NeogitOrg](https://github.com/NeogitOrg/neogit)) | 5,678 | Magit-style git UI | Status buffer, sections/hunks, signs, mappings, refresh | GIT, SHELL, FS, UI | L | need: full git porcelain as a status view + key→action. on: status/diff/stage commands. state: {}. → `git` panel slot + commands. host: `git.status/diff/stage/commit` + `shell`. ⛔—. |
| 34 | **ctrlp.vim** ([ctrlpvim](https://github.com/ctrlpvim/ctrlp.vim)) | 5,640 | Vim fuzzy file finder | `g:ctrlp_*`, extensions, `vimgrep`, cache files | FS, SHELL, UI, KEY | M | need: fuzzy file open with an index cache. on: picker query events. state: { query }. → `picker` slot + command. host: `files.list` (host caches the index). ⛔— (index is host-side). |
| 35 | **conform.nvim** ([stevearc](https://github.com/stevearc/conform.nvim)) | 5,404 | Formatter orchestration | `formatters_by_ft`, `format_on_save`, async jobs, LSP fallback, `diff` apply | SHELL, LSP, FS | M | need: on save, run a formatter and apply the result. on: save event. state: { config }. → command (format) returning buffer edit. host: `shell(stdin→stdout)` (async), `editor.apply`. ⛔—. |
| 36 | **indent-blankline.nvim** ([lukas-reineke](https://github.com/lukas-reineke/indent-blankline.nvim)) | 5,010 | Indent guides | Virtual text marks, tree-sitter scopes, scope highlights | NATIVE(tree-sitter), UI(virt-text) | M | need: indent-guide decoration from syntax scopes. This is a **render feature**, not an event. on: n/a. → rendered by host from tree-sitter scopes. host: `syntax.scopes`. ⛔native (tree-sitter) — host-side. |
| 37 | **Comment.nvim** ([numToStr](https://github.com/numToStr/Comment.nvim)) | 4,664 | Smart comment toggling | `Comment.api`, commentstring/ts_context, motions, mappings | FS(config), UI(textobjects), KEY | S | need: toggle comments on a selection. on: comment command. state: {}. → command (text edit). host: `commentstring(lang)` (host knows the language). ⛔—. |
| 38 | **fzf-lua** ([ibhagwan](https://github.com/ibhagwan/fzf-lua)) | 4,495 | Lua fzf wrapper | Async `fzf` spawn, profiles, previewers, actions | NATIVE(fzf), SHELL, FS, GIT, UI | M | need: fuzzy pick + preview + action (as telescope). on: picker query events. state: { query }. → `picker` slot + command. host: `files.list`, `fs.preview`. ⛔native (fzf) if exact ranking. |
| 39 | **LuaSnip** ([L3MON4D3](https://github.com/L3MON4D3/LuaSnip)) | 4,437 | Lua snippet engine | Snippet nodes, `dynamicNode`, `functionNode`, choice/restore, events | FS(read), UI(expand), KEY | L | need: load snippets + expand them with tab stops. on: expand/next-tab commands. state: { active snippet, tabstop }. → command + editor transforms. host: `snippet.load(lang)` (host parses files), `editor.expand`. ⛔large-state only if the snippet AST is preloaded into the plugin; else host-side. |
| 40 | **nvim-surround** ([kylechui](https://github.com/kylechui/nvim-surround)) | 4,327 | Add/change/delete delimiters | Dot-repeat API, motions, custom rules | UI(textobjects), KEY | S | need: wrap/change/delete a delimiter around a text object. on: surround command + motion. state: {}. → command (text edit). host: `editor.textobject`. ⛔—. |
| 41 | **todo-comments.nvim** ([folke](https://github.com/folke/todo-comments.nvim)) | 4,229 | Highlight + search TODOs | Highlights, `TodoQuickFix`/`TodoTelescope`/`TodoLocList`, sign | FS, UI(quickfix), KEY | S | need: find TODO markers + list them + jump. on: search command. state: { query }. → `list` slot + command. host: `files.grep("TODO")` (host-side scan). ⛔—. |
| 42 | **tmux-continuum** ([tmux-plugins](https://github.com/tmux-plugins/tmux-continuum)) | 4,114 | Continuous auto-save | `status-interval` timer hook, autostart, save/restore | TIMER, SHELL, FS, ENV | S | need: periodically save session state. on: a host-emitted interval/tick event. state: {}. → command (save). host: `session.save` + `host.schedule(interval)` (host timer). ⛔— (timer is host-side). |
| 43 | **catppuccin/tmux** ([catppuccin](https://github.com/catppuccin/tmux)) | 3,222 | Pastel tmux theme | Statusline format strings, color opts, `@catppuccin_*` | UI(statusline), ENV | S | need: theme tokens for the status line. on: theme event. state: { theme }. → config (statusline), not code. host: `theme.current`. ⛔—. |
| 44 | **tmux-yank** ([tmux-plugins](https://github.com/tmux-plugins/tmux-yank)) | 3,124 | Copy to system clipboard | `set-clipboard`, `copy-pipe`, OS helpers | CLIP, SHELL, ENV | M | need: put the copy-buffer into the system clipboard. on: yank command. state: {}. → command. host: `clipboard.set(text)` (cross-platform). ⛔—. |
| 45 | **gloomberb** ([gloom-sh](https://github.com/gloom-sh/gloomberb)) | 2,772★ | OpenTUI finance terminal | Full app (market data, portfolios, alerts, brokers) | NET, KV, UI, KEY, NOTIF | L | need: market data + portfolio + alerts. Full app; its panels could be slots. on: quote/alert events. state: { watchlist }. → `market` slot + commands. host: `fetch(api)`, `kv`, `notify`. ⛔streaming (live quotes — host pushes), large-state (quotes cache host-side). |
| 46 | **tmux-fingers** ([Morantron](https://github.com/Morantron/tmux-fingers)) | 1,489 | Vimium-style hint copy-paste | Regex hint matching, `tmux` overlay display, keyboard capture | UI(overlay), KEY, SHELL, CLIP | M | need: show a hint overlay + capture a key + copy the target. on: hint command. state: { hints }. → `overlay` slot + commands. host: `render.overlay`, key capture, `clipboard.set`. ⛔—. |
| 47 | **critique** ([remorses](https://github.com/remorses/critique)) | 1,290★ · `critique` 260 DLs/wk | OpenTUI diff review app | CLI app (OpenTUI); web-preview upload; watch mode | GIT, FS, NET, UI | M | need: git diff view + upload preview. Full app; watch mode = host `fs.watch` events. on: review/reload events. state: {}. → `diff` slot + commands. host: `git.diff`, `fetch(upload)`. ⛔—. |
| 48 | **termcn** ([shadcn-labs](https://github.com/shadcn-labs/termcn)) | 1,236★ | shadcn-style OpenTUI React components | Registry CLI, JSON registry, component install, 38 themes | FS, NET, SHELL | L | need: fetch/install components from a registry into a project. Not a runtime plugin — a CLI. on: install command. state: {}. → command. host: `fetch(registry)`, `fs.write`, `shell`. ⛔background (install) if in-app. |
| 49 | **ghui** ([kitlangton](https://github.com/kitlangton/ghui)) | 1,145★ | GitHub PR review TUI | OpenTUI React app (no public plugin API) | NET(GitHub API), GIT, ENV, UI, KEY | L | need: GitHub PR/issue data + review actions. Full app; a PR could be a command/slot. on: review commands. state: {}. → `pr` slot + commands. host: `github.pr.list/review/merge` (host has the token). ⛔—. |
| 50 | **zjstatus** ([dj95](https://github.com/dj95/zjstatus)) | 1,077 | Zellij status bar plugin | `zellij-tile` render + events, click actions, config, toggles | UI(statusline), KEY, TIMER, ENV | M | need: a status bar of host state + click to toggle. Ported: on: status/tick events. state: {}. → `status` slot. host: `state.*`, interval. ⛔background only to stay a live WASM loop; as an OpenTUI slot it's —. |
| 51 | **awesome-yazi** ([AnirudhG07](https://github.com/AnirudhG07/awesome-yazi)) | 815 | Curated yazi plugin list | (index) | — | S | Ecosystem index; not a plugin. ⛔—. |
| 52 | **awesome-wezterm** ([michaelbrusegard](https://github.com/michaelbrusegard/awesome-wezterm)) | 791 | Curated WezTerm plugin list | (index) | — | S | Ecosystem index; not a plugin. ⛔—. |
| 53 | **tmux-power** ([wfxr](https://github.com/wfxr/tmux-power)) | 709 | tmux powerline theme | Statusline format, powerline glyphs, theming | UI(statusline), ENV | S | need: themed powerline status. on: status event. state: { theme }. → `status` slot (host draws glyphs). host: `theme.current`. ⛔—. |
| 54 | **yazi-rs/plugins** ([yazi-rs](https://github.com/yazi-rs/plugins)) | 635 | Official yazi plugin monorepo (git, chmod, diff, glow, mime-ext, full-border…) | Lua previewer/preloader/entry; `ya.sync`; spawns | SHELL, FS, GIT, NET(glow), UI(preview) | L | need: hover-time facts (git status, mime, image/glow preview) for a file. on: file-hover. state: {}. → `preview`/`status` slots. host: `git.status(file)`, `shell(glow)`, `fs.mime`. ⛔streaming (spawned previewers stream) if host doesn't pre-render previews. |
| 55 | **waha-tui** ([muhammedaksam](https://github.com/muhammedaksam/waha-tui)) | 415★ | OpenTUI WhatsApp client | Full app: sessions, chats, messages, real-time updates | NET, KV, UI, KEY, NOTIF | M | need: message stream + send. on: message events. state: { chat }. → `chat` slot + commands. host: `fetch(WAHA)`, `ws`-ish `subscribe` → events. ⛔streaming (realtime message deltas → host events). |
| 56 | **noodle** ([wilfredinni](https://github.com/wilfredinni/noodle)) | 405★ | OpenTUI REST client | Full app: YAML collections, assertions, run/CLI | NET, FS, UI, KEY | M | need: send HTTP + assert + show response. on: run command. state: {}. → `response` slot + command. host: `fetch(req)` (async). ⛔— (long requests are `await` host fn). |
| 57 | **tfm-tui** ([clarkarch](https://github.com/clarkarch/tfm-tui)) | 362★ | Mouse-first file manager | Full app: image previews, desktop integration, kitty graphics | FS, NATIVE(kitty gfx), UI, KEY | M | need: file list + image preview + open. on: hover/select. state: {}. → `files` + `preview` slots. host: `fs.list`, `fs.preview(image)` (host gfx). ⛔native (kitty/GPU image preview) — host-side. |
| 58 | **termdraw** ([benvinegar](https://github.com/benvinegar/termdraw)) | 353★ | Diagram editor TUI | `@termdraw/opentui` render overlay, `@termdraw/pi` | FS, UI, KEY | M | need: draw/edit a canvas and export an overlay. on: draw key/mouse events. state: { canvas } (small). → `overlay` slot + commands. host: `render.overlay`, `fs.write(export)`. ⛔— (canvas diff is small JSON). |
| 59 | **resurrect.wezterm** ([MLFlexer](https://github.com/MLFlexer/resurrect.wezterm)) | 315 | Save/restore WezTerm panes/tabs | Lua serialize/restore workspace state | FS, ENV, UI, TIMER | M | need: save/restore workspace layout. on: save/restore commands. state: {}. → commands. host: `session.save/restore`. ⛔—. |
| 60 | **tabline.wez** ([michaelbrusegard](https://github.com/michaelbrusegard/tabline.wez)) | 303 | WezTerm status/tab bar (lualine format) | Lua callbacks (format-window-title, status), module config | UI(statusline), TIMER, ENV | M | need: a lualine-format status/tab bar. on: status tick. state: { config }. → `status` slot. host: `state.*`. ⛔—. |

Remainder of the tail, all queried 2026-11-19 (retained for provenance, not full rows):
OpenTUI index — `tuiparts` 272★, `create-tui` 145★, `easiarr` 77★, `opentui-doom` 47★,
`opendocker` 46★, `opentui-spinner` 43★, `red-cli` 39★, `t-req` 23★, `surp` 6★,
`opentui-split` 5★, `opentui-responsive` 3★, `opentui-lint` 2★, `otel-tui` 1★, `opentui-tex` 0★.
Other ecosystems — `pilotty` (msmps) 162★, `smart_workspace_switcher.wezterm` (MLFlexer)
204★, `sessionizer.wezterm` (mikkasendke) 95★, `zellij-forgot` (karimould) 260★,
`wezterm-status` (yriveiro) 25★, `bar.wezterm` (adriankarlen) 251★,
`ai-helper.wezterm` (Michal1993r) 39★, `smart-splits.nvim` 1,753★, `nvim-dap-ui` 3,389★,
`lspsaga.nvim` 3,800★, `vim-clap` 2,145★, `feline.nvim` 1,047★,
`t-smart-tmux-session-manager` 349★.

Neovim categories implied by the ranked rows: **statusline** (airline / lualine / lightline /
mini.statusline), **file pickers** (telescope / fzf-lua / fzf.vim / ctrlp / vim-clap / mini.pick),
**git signs** (gitsigns / vim-gitgutter / vim-fugitive / neogit / diffview), **LSP UI**
(lspconfig / mason / trouble / noice / lspsaga), plus the transversal completion/snippets/
debug cluster (nvim-cmp / LuaSnip / nvim-dap+ui).

---

## The 10 most complex plugins, rewritten as reducers

For each: functional need → the reducer rewrite (events, state, returns, host functions)
→ and the only genuine blocker. Note how little actually blocks once the host owns async
processes, streams and timers.

1. **nvim-lspconfig / nvim-cmp / nvim-dap (+dap-ui)** — need an LSP client, a completion
   menu, and a debug session. Rewrite: the host spawns servers/adapters and converts their
   output into events; the plugin reacts to `buffer-open`, `text-changed`, `diagnostics`,
   and `debug.step`/`debug.variables` events, keeps only `{ attached, breakpoints, items }`,
   returns `completion`/`diagnostics`/`debug` slots plus commands, and calls
   `lsp.start`, `lsp.complete`, `lsp.diagnostics`, `dap.step`, `dap.variables`. Blocker:
   **streaming** (diagnostics/completion/debug-console deltas arrive over time) and
   **background** (the server/adaptor is a long-lived host-held process) — both are host
   capabilities to build, not plugin-side impossibilities, but they must exist.

2. **telescope.nvim / fzf-lua / fzf.vim** — need a fuzzy picker with preview. Rewrite: the
   host owns the candidate index and the preview; the plugin reacts to `picker-open` and
   `query-changed` events, keeps `{ query, selection }`, returns a `picker` slot + a
   command, and calls `files.list` / `git.refs` / `lsp.symbols` / `fs.preview`. Blocker:
   **native** (the `fzf` binary) only if exact ranking quality is required; otherwise the
   host's own matcher makes it a `—`.

3. **lazy.nvim / mason.nvim / nvim-treesitter** — need to install/update a plugin set,
   download tools, and compile grammars. Rewrite: commands `install`/`update` call durable
   async host fns (`plugin.install(spec)`, `tool.install(id)`, `grammar.install(lang)`),
   which report progress as events; plugin state is `{ lockfile / installed }`, returned
   into a managed-items panel. Blocker: **background** (downloads/compiles run long) and
   **native** (compiled tree-sitter grammars) — again inside the durable host fn, so the
   plugin itself is a thin reducer.

4. **vim-fugitive / Neogit / lazygit custom commands** — need a git porcelain: read state,
   render a status/diff, translate keys into shell commands with prompt menus. Rewrite: the
   plugin reacts to git-panel commands; keeps `{}` (or a form); returns a `git` panel slot
   plus commands; calls `git.status/diff/stage/commit`, `shell`, and `prompt`. lazygit's
   `customCommands` (Go-template placeholders + `menuFromCommand` + `output: popup`) is the
   closest predecessor of the reducer `commands` array. Blocker: **—**.

5. **gitsigns.nvim / vim-gitgutter** — need per-line diff signs. Rewrite: on the
   host-debounced `buffer-changed` event, call async `git.diff(file)`, return a `signs`
   slot with hunks. The old blockers (async diff + debounce) are now host-side. Blocker:
   **—**.

6. **oil.nvim** — need an editable directory listing with write-back and watch. Rewrite: on
   `open-directory` return a `files` slot from `fs.list`; rename/delete → `fs.mv/rm`; the
   host's `fs.watch` re-emits `file-changed` events; state is `{ pending edits }`. Blocker:
   **—** (watching is a host capability).

7. **noice.nvim** — need to route messages to toasts/popups and a cmdline. Rewrite: the host
   owns the message bus and pushes `message` events; the plugin maps them to `toast`/
   `popup` slot returns and a small `{ routes }` state. Blocker: **—** (the bus is events).

8. **conform.nvim** — need format-on-save via external formatters. Rewrite: on the `save`
   event, `await host.shell(formatter, { stdin })`, return an editor edit. One clean
   reducer transaction. Blocker: **—**.

9. **tmux-resurrect / resurrect.wezterm (+ tmux-continuum)** — need session snapshot and
   restore, optionally periodic. Rewrite: `save`/`restore` commands calling durable
   `session.save/restore`; the periodic case is a host `host.every(ms)` tick event, not a
   plugin timer. Blocker: **—**.

10. **yazi plugins (yazi-rs/plugins) / zellij plugins (zjstatus)** — need hover-time file
    facts/previews (yazi) and a live status bar (zellij). Rewrite: as OpenTUI plugins both
    become `preview`/`status` slots fed by host events (`file-hover`, `tick`); the spawned
    previewers and the WASM render loop stay in the host. Blocker: **streaming** (yazi's
    spawned previewers stream) and **background** (zellij's live render loop) only if the
    same live model is kept; as slots they degrade to `—`.

### What genuinely blocks a reducer (and what doesn't)

The four real blockers, applied narrowly, are host capabilities the loader must eventually
provide — not reasons a plugin can't exist:

- **streaming** — LLM completion, LSP diagnostics/references, completion menus, debug
  console, live market/quote/chat/trace feeds, and spawned previewers all deliver partial
  results over time. A pull-only reducer can't consume them unless the host exposes a
  *stream → sequence of events* bridge (`event.type === "chunk"`). Present in: OpenCode,
  telescope/fzf, nvim-cmp, nvim-lspconfig, nvim-dap, trouble, yazi, waha-tui, gloomberb.
- **background** — installs, downloads, grammar compiles, debug and LSP sessions are
  long-running and must survive between events. They belong in **durable async host
  functions** that report progress as events, which the reducer decision already allows
  ("async (promise); durable"). Present in: lazy, mason, treesitter, dap, tpm.
- **native** — the `fzf` binary, compiled tree-sitter grammars, LSP/DAP server binaries,
  GPU/kitty image preview, and WASM plugins. These are *host* resources; a plugin only
  needs the host to spawn them, so this is almost never a plugin-side block. Present in:
  telescope/fzf family, treesitter, tfm-tui, zellij (if run as-is).
- **large-state** — picker indexes, snippet forests, quote caches and blame maps are too
  big for per-event JSON plugin state, but they live *host-side* (indexes, parsers, caches)
  and the plugin only references them. Only flags where the plugin itself would have to
  hold the structure (e.g. a snippet AST preloaded into the plugin).

Everything that previously loomed as "missing" is **not** a blocker once the host exists:
async git diff/shell, debounce/periodic timers (→ host events), statusline refresh (→ tick),
persistent storage (→ `kv`), clipboard (→ `clipboard`), file watching (→ `fs.watch` events),
and cross-app integration all become host functions or host-driven events. The most
recurring, highest-leverage seams are unchanged from the prototype `REPORT.md`: a Rust slot
registry, a small data view vocabulary with a keyed reconciler, and host-scheduled follow-up
events.
