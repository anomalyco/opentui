# OpenTUI and terminal-app plugins: what they need from a host

Scope: OpenTUI packages and plugins (opentui.com/packages, the anomalyco/opentui-index
repo, and the OpenCode TUI slot/runtime plugins), plus the plugin systems of the
terminal apps an OpenTUI app would want to match — lazygit, k9s, yazi, helix, zellij,
wezterm, Neovim (by category) and tmux.

Written against the PsychoScript **reducer model** decision: each event runs a plugin
briefly with `{ event, state }`, the plugin returns `{ state, slots, commands }`, state
is plain JSON the host keeps, and the only way out is host functions (sync/async,
durable, namespaced) — no timers, no ambient I/O, no npm imports. The central question
for each plugin below is "does it fit the reducer as-is, and if not, what's missing?"

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

Host-need abbreviations in the table:

`FS` filesystem r/w, `FSW` filesystem watch, `SHELL` process spawn, `NET` network/fetch,
`GIT` git, `LLM` model/session access, `MCP` MCP tools, `SESS` session/workspace access,
`UI` slots/dialogs/toasts/panels, `KEY` keybinds, `TIMER` timers/background, `KV` persistent
storage, `CLIP` clipboard, `NOTIF` notifications, `ENV` env/secrets, `NATIVE` native/binary deps.

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

| # | Plugin (maintainer / link) | Stars · DLs | What it does | API surface | Host needs | Cx | Reducer fit / missing |
|---|---|---|---|---|---|---|---|
| 1 | **OpenCode** ([sst/opencode](https://github.com/sst/opencode)) | 227,846 · `@opencode-ai/plugin` 35.2M DLs/wk | AI coding agent; OpenTUI TUI with the slot/runtime plugin system | `tui(api,...)`: `command`, `route`, `ui.Dialog*`/`ui.toast`, `keybind`, `kv`, `state` (session/diff/todo/messages/lsp/mcp), `client`, `event.on`, `slots.register`, `theme`, `renderer` | LLM, MCP, SESS, FS, GIT, UI, KEY, KV, NET | L | The reference target for `{state, slots, commands}`. |
| 2 | **lazygit** ([jesseduffield](https://github.com/jesseduffield/lazygit)) | 83,961 | Git TUI; custom commands extend it | `customCommands` YAML: `key`, `context`, shell `command` (Go templates), `prompts` (input/menu/confirm/menuFromCommand), `output` (none/terminal/log/popup), `after` | SHELL, GIT, UI(prompts/popups), KEY, ENV | M | One-shot command per key is a clean reducer; needs SHELL + prompts + popup output capture. |
| 3 | **helix** ([helix-editor](https://github.com/helix-editor/helix)) | 46,936 | Modal editor; **no plugin system** | None: `config.toml`, `languages.toml`, themes only; Steel/scheme plugin PR #8675 unmerged | (n/a — LSP binaries, tree-sitter) | — | No plugins today. Matching Neovim needs full buffer/UI/LSP access. |
| 4 | **yazi** ([sxyazi/yazi](https://github.com/sxyazi/yazi)) | 43,515 | File manager; Lua plugins (BETA) | `main.lua` `entry`/`setup`, previewer `peek`/`seek`, preloader `preload`; `@sync`/`@since` annotations; `ya.sync` cross-thread state; `job.args`/`job.file`/`job.area`; `ya.emit`, `ya.dbg` | FS, SHELL, NET, UI(draw preview area), TIMER, state | L | Async-first, long-lived state, cross-thread ownership; previewers stream and re-trigger. Not a pure reducer. |
| 5 | **zellij** ([zellij-org](https://github.com/zellij-org/zellij)) | 36,141 | Multiplexer; WASM/WASI plugins | `zellij-tile`: render UI, react to `Event`s (key/mode/mouse/clipboard), send `Command`s; own UI built from plugins | UI(panes/draw), KEY, CLIP, TIMER, ENV | L | Persistent render+event loop, Rust/WASI. Outside reducer; native deps. |
| 6 | **k9s** ([derailed/k9s](https://github.com/derailed/k9s)) | 34,996 | Kubernetes TUI; YAML plugins | `plugins.yaml`: `shortCut`, `scopes` (resource views), `command`+`args`, `background`; env vars `$NAME`/`$NAMESPACE`/`$CONTEXT`/`$COL-*` | SHELL, ENV, NET(kubectl) | M | One-shot env-substituted shell call fits well; needs SHELL + `background` + scoped shortcut. |
| 7 | **wezterm** ([wez/wezterm](https://github.com/wez/wezterm)) | 29,602 | GPU terminal; Lua plugin system | `wezterm.plugin.require(url)`, plugin supplies config/event callbacks; `wezterm.action`, timer/format callbacks | FS, SHELL, NET, UI(tab/status), KEY, CLIP, TIMER | L | Lua injected into config; plugins use timers, spawn, http, persistent state. Not reducer. |
| 8 | **vim-fugitive** ([tpope](https://github.com/tpope/vim-fugitive)) | 21,830 | Git porcelain inside Vim | Vimscript commands, buffers, `autocmd`s, async jobs, `:Git` dispatch, statusline | GIT, SHELL, FS, UI(buffers/quickfix), KEY | L | Long-lived buffers + async jobs; not a pure function of an event. |
| 9 | **lazy.nvim** ([folke](https://github.com/folke/lazy.nvim)) | 21,736 | Neovim plugin manager | Lua spec DSL, lockfile, lazy-loader (module/event/cmd/ft/keys), profiler, commands | FS, SHELL(git clone), NET, TIMER, KEY | L | Background installs, deep state, native git; reducer only as a thin command layer. |
| 10 | **telescope.nvim** ([nvim-telescope](https://github.com/nvim-telescope/telescope.nvim)) | 19,866 | Fuzzy finder framework | Pickers, finders, sorters (`fzf` native), previewers, actions, extensions, async `vim.schedule` | FS, GIT, LSP, SHELL, UI(float/insert), KEY | L | Async streaming + native `fzf`; needs background + large in-memory lists. |
| 11 | **vim-airline** ([vim-airline](https://github.com/vim-airline/vim-airline)) | 17,967 | Status/tabline | `statusline`/`tabline` options, sections, per-plugin extensions, highlight groups, autocmd refresh | FS, GIT(branch), LSP, KEY | M | Derive status from state; timer/autocmd refresh. Reducer ok if host computes status. |
| 12 | **tpm** ([tmux-plugins/tpm](https://github.com/tmux-plugins/tpm)) | 15,181 | tmux plugin manager | `@plugin` opts, `run-shell`, `source-file`, `bind-key` | SHELL, FS(clone), ENV | S | Installer/orchestrator; a handful of reducer commands. |
| 13 | **nvim-treesitter** ([nvim-treesitter](https://github.com/nvim-treesitter/nvim-treesitter)) | 14,550 | Syntax/config layer for tree-sitter | Parser install/compile, queries, injections, language modules, `health` | NATIVE(parsers), SHELL(cc), FS, GIT | L | Native compiled parsers + background compile; outside reducer. |
| 14 | **nvim-lspconfig** ([neovim](https://github.com/neovim/nvim-lspconfig)) | 14,017 | LSP client configs | Per-server `configs`, `setup`, capabilities/on_attach hooks, `vim.lsp` events | SHELL(spawn servers), FS, NET, LSP | L | Long-lived LSP processes + callbacks; the host proxy is the seam. |
| 15 | **opentui-* core/solid/react/keymap/ssh/three/qrcode** ([sst/opentui](https://github.com/sst/opentui)) | 13,852★ · core 2.0M, solid 623k, react 537k, keymap 380k DLs/wk | OpenTUI rendering libs + keymap/SSH/etc | TS/Solid/React renderables, `createSlotRegistry`, keymap layer, SSH | UI, KEY, NATIVE | L | The host's own render/keymap layer — not a plugin; defines the slot seam plugins target. |
| 16 | **tmux-resurrect** ([tmux-plugins](https://github.com/tmux-plugins/tmux-resurrect)) | 13,150 | Save/restore tmux sessions | Shell scripts; `@resurrect-*` opts, `after-restore` hooks; saves pane layout/programs to file | SHELL, FS, ENV, SESS | M | Snapshot→file; a durable host fn + state export fits (one-shot save/restore). |
| 17 | **mason.nvim** ([mason-org](https://github.com/mason-org/mason.nvim)) | 10,539 | Install/manage LSP & tools | Registry packages, `MasonInstall`, download/unpack, PATH, UI window | NET, SHELL, FS, NATIVE | L | Background downloads + registry; reducer can wrap a `mason.install` fn only. |
| 18 | **fzf.vim** ([junegunn](https://github.com/junegunn/fzf.vim)) | 10,279 | `fzf` picker for Vim | Vimscript wrappers spawning `fzf`, `--expect`/sink callbacks, `termopen` | NATIVE(fzf), SHELL, FS, UI(term) | M | Spawns native binary, streams into terminal; needs shell + term capture. |
| 19 | **hunk** ([modem-dev/hunk](https://github.com/modem-dev/hunk)) | 9,849★ · `hunkdiff` 4,568 DLs/wk | OpenTUI Git/diff review app | React component API (`hunkdiff/opentui`), diff parsers, file nav, watch mode | GIT, FS, UI, KEY | L | Full app; its component export is the "renderer/slot plugin" seam. |
| 20 | **mini.nvim** ([echasnovski](https://github.com/echasnovski/mini.nvim)) | 9,671 | 45+ small Lua modules (incl. `mini.statusline`, `mini.files`, `mini.pick`) | Module spec DSL, `Mini*` APIs, autocmds, keymaps, highlights | FS, UI, KEY, GIT(starter) | L | Totality large; individual modules are pure-ish. Reducer per module could work. |
| 21 | **nvim-cmp** ([hrsh7th](https://github.com/hrsh7th/nvim-cmp)) | 9,491 | Completion engine | Event-driven sources (`EventType`), async sources, `vim.schedule`, menus | LSP, FS, SHELL, NET | L | Async multi-source merge + debounce; not event-pure. |
| 22 | **harpoon** ([ThePrimeagen](https://github.com/ThePrimeagen/harpoon)) | 9,244 | Per-project file marking/nav | `:lua require("harpoon"):list():add()`, UI list, keybind nav | FS, KV(list), UI, KEY | S | Persisted JSON list + nav; reducer fits well (state is a list). |
| 23 | **vim-gitgutter** ([airblade](https://github.com/airblade/vim-gitgutter)) | 8,517 | Git diff signs in gutter | `sign` column, async `git diff` jobs, hunk preview, autocmd updates | GIT, SHELL, FS, UI(signs) | M | Async diff + debounce timers; needs a "signs" slot primitive. |
| 24 | **lualine.nvim** ([nvim-lualine](https://github.com/nvim-lualine/lualine.nvim)) | 8,187 | Config-based statusline | Declarative `sections`, components (branch/diagnostics/diff/mode), extensions, refresh | GIT, LSP, FS, UI, KEY | M | Declarative status → maps onto a `status` slot in the reducer. |
| 25 | **which-key.nvim** ([folke](https://github.com/folke/which-key.nvim)) | 7,343 | Keybind popup helper | Keymap introspection, popup UI, sort/groups, buffer-local chains | UI(popup), KEY | M | Reads keymap + popup; host `commands` covers most of it. |
| 26 | **nvim-dap** ([mfussenegger](https://github.com/mfussenegger/nvim-dap)) | 7,313 | Debug Adapter Protocol client | Adapters, sessions, breakpoints, threads/stack watch, `dap-ui` UI | SHELL(debuggers), NET, FS, UI | L | Long-lived debug sessions + async events; outside reducer. |
| 27 | **gitsigns.nvim** ([lewis6991](https://github.com/lewis6991/gitsigns.nvim)) | 7,191 | Git signs + hunk staging/preview | Async `git` via libuv, signs, `vim.schedule`, hunk actions, `blame` | GIT, SHELL, FS, UI(signs), KEY | L | Async diff + debounce + large per-buffer state; needs background + signs slot. |
| 28 | **oil.nvim** ([stevearc](https://github.com/stevearc/oil.nvim)) | 6,988 | File explorer as editable buffer | Buffer-backed FS view, `:w` persists edits, adapters (local/ssh/trash), column UI | FS, FSW, UI, KEY | L | FS write-back + watch + adapters; needs FS host fns + external-event echo. |
| 29 | **trouble.nvim** ([folke](https://github.com/folke/trouble.nvim)) | 6,917 | Diagnostics/references/quickfix UI | Lists, providers (LSP/telescope/quickfix), actions, preview, sorting | LSP, FS, GIT, UI, KEY | M | List UI over live LSP; needs list slot + LSP host fns. |
| 30 | **lightline.vim** ([itchyny](https://github.com/itchyny/lightline.vim)) | 6,873 | Lightweight statusline | `statusline` format, components, modes, autocmd/timer refresh | GIT, LSP, FS, UI | S | Like lualine, simpler; maps to a status slot. |
| 31 | **diffview.nvim** ([sindrets](https://github.com/sindrets/diffview.nvim)) | 5,893 | Git diff/merge UI | Diff views, file panel, history, `tab` layout, hooks | GIT, SHELL, FS, UI | M | Git porcelain + layout; needs GIT + a diff-slot primitive. |
| 32 | **noice.nvim** ([folke](https://github.com/folke/noice.nvim)) | 5,832 | Replaces msg/cmdline UI | Routes/messages, popups, async notifications, `vim.notify`, cmdline | UI(popups/toasts), ENV, TIMER, NOTIF | L | Replaces core UI surfaces; long-lived router + toasts. |
| 33 | **Neogit** ([NeogitOrg](https://github.com/NeogitOrg/neogit)) | 5,678 | Magit-style git UI | Status buffer, sections/hunks, signs, mappings, refresh | GIT, SHELL, FS, UI | L | Full git porcelain — host `git` fn + UI slots would carry it. |
| 34 | **ctrlp.vim** ([ctrlpvim](https://github.com/ctrlpvim/ctrlp.vim)) | 5,640 | Vim fuzzy file finder | `g:ctrlp_*` vars, extensions, `vimgrep`, cache files | FS, SHELL, UI, KEY | M | File index cache; a `files` host fn + picker slot covers it. |
| 35 | **conform.nvim** ([stevearc](https://github.com/stevearc/conform.nvim)) | 5,404 | Formatter orchestration | `formatters_by_ft`, `format_on_save`, async jobs, LSP fallback, `diff` apply | SHELL, LSP, FS | M | Spawns formatters, reformats buffer; needs SHELL + buffer-edit access. |
| 36 | **indent-blankline.nvim** ([lukas-reineke](https://github.com/lukas-reineke/indent-blankline.nvim)) | 5,010 | Indent guides | Virtual text marks, tree-sitter scopes, scope highlights | NATIVE(tree-sitter), UI(virt-text) | M | Render-time decoration; native feature, not a plugin event. |
| 37 | **Comment.nvim** ([numToStr](https://github.com/numToStr/Comment.nvim)) | 4,664 | Smart comment toggling | `Comment.api`, commentstring/ts_context, motions, mappings | FS(config), UI(textobjects), KEY | S | Pure text edit on a motion; command reducer is fine. |
| 38 | **fzf-lua** ([ibhagwan](https://github.com/ibhagwan/fzf-lua)) | 4,495 | Lua fzf wrapper | Async `fzf` spawn, profiles, previewers, actions, `vim.loop` | NATIVE(fzf), SHELL, FS, GIT, UI | M | Same as fzf.vim but Lua; native spawn + streaming. |
| 39 | **LuaSnip** ([L3MON4D3](https://github.com/L3MON4D3/LuaSnip)) | 4,437 | Lua snippet engine | Snippet nodes, `dynamicNode`, `functionNode`, choice/restore, events | FS(read), UI(expand), KEY | L | In-memory snippet trees + dynamic re-eval; needs larger state + edit access. |
| 40 | **nvim-surround** ([kylechui](https://github.com/kylechui/nvim-surround)) | 4,327 | Add/change/delete delimiters | Dot-repeat API, motions, custom rules | UI(textobjects), KEY | S | Pure edit on selection; command reducer fits. |
| 41 | **todo-comments.nvim** ([folke](https://github.com/folke/todo-comments.nvim)) | 4,229 | Highlight + search TODOs | Highlights, `TodoQuickFix`/`TodoTelescope`/`TodoLocList`, sign | FS, UI(quickfix), KEY | S | Scan + list; host `grep`/`files` fns + list slot cover it. |
| 42 | **tmux-continuum** ([tmux-plugins](https://github.com/tmux-plugins/tmux-continuum)) | 4,114 | Continuous auto-save | `status-interval` timer hook, autostart, save/restore triggers | TIMER, SHELL, FS, ENV | S | Pure timer-driven; needs a periodic-tick host event (missing in reducer today). |
| 43 | **catppuccin/tmux** ([catppuccin](https://github.com/catppuccin/tmux)) | 3,222 | Pastel tmux theme | Statusline format strings, color opts, `@catppuccin_*` | UI(statusline), ENV | S | Declarative theme → config, no code path needed. |
| 44 | **tmux-yank** ([tmux-plugins](https://github.com/tmux-plugins/tmux-yank)) | 3,124 | Copy to system clipboard | `set-clipboard`, `copy-pipe`, OS helpers (pbcopy/xclip/wl-copy) | CLIP, SHELL, ENV | M | Cross-platform clipboard; natural CLIP host fn. |
| 45 | **gloomberb** ([gloom-sh](https://github.com/gloom-sh/gloomberb)) | 2,772★ | OpenTUI finance terminal | Full app (market data, portfolios, alerts, brokers) | NET, KV, UI, KEY, NOTIF | L | Full app; shows a TUI needing NET + persistent data + notifications. |
| 46 | **tmux-fingers** ([Morantron](https://github.com/Morantron/tmux-fingers)) | 1,489 | Vimium-style hint copy-paste | Regex hint matching, `tmux` overlay display, keyboard capture | UI(overlay), KEY, SHELL, CLIP | M | Overlay + input capture + clipboard; host needs overlay/toast + input capture. |
| 47 | **critique** ([remorses](https://github.com/remorses/critique)) | 1,290★ · `critique` 260 DLs/wk | OpenTUI diff review app | CLI app (OpenTUI); web-preview upload; watch mode | GIT, FS, NET, UI | M | Full app needing NET + GIT + upload. |
| 48 | **termcn** ([shadcn-labs](https://github.com/shadcn-labs/termcn)) | 1,236★ | shadcn-style OpenTUI React components | Registry CLI, JSON registry, component install, 38 themes | FS, NET, SHELL | L | Registry-import component model; an install/clone tool, orthogonal to reducer. |
| 49 | **ghui** ([kitlangton](https://github.com/kitlangton/ghui)) | 1,145★ | GitHub PR review TUI | OpenTUI React app (no public plugin API) | NET(GitHub API), GIT, ENV, UI, KEY | L | Needs network + GitHub auth; a "plugin" only as a full app surface. |
| 50 | **zjstatus** ([dj95](https://github.com/dj95/zjstatus)) | 1,077 | Zellij status bar plugin | `zellij-tile` render + events, click actions, config, toggles | UI(statusline), KEY, TIMER, ENV | M | Long-lived WASM render loop; reducer can't hold the render subscription. |
| 51 | **awesome-yazi** ([AnirudhG07](https://github.com/AnirudhG07/awesome-yazi)) | 815 | Curated yazi plugin list | (index) | — | S | Signal only. |
| 52 | **awesome-wezterm** ([michaelbrusegard](https://github.com/michaelbrusegard/awesome-wezterm)) | 791 | Curated WezTerm plugin list | (index) | — | S | Signal only. |
| 53 | **tmux-power** ([wfxr](https://github.com/wfxr/tmux-power)) | 709 | tmux powerline theme | Statusline format, powerline glyphs, theming | UI(statusline), ENV | S | Declarative theme. |
| 54 | **yazi-rs/plugins** ([yazi-rs](https://github.com/yazi-rs/plugins)) | 635 | Official yazi plugin monorepo (git, chmod, diff, glow, mime-ext, full-border…) | Lua previewer/preloader/entry; `ya.sync`; spawned `ps.sub`/pd pipes | SHELL, FS, GIT, NET(glow), UI(preview) | L | Async shell + shared state + streaming preview; well outside reducer. |
| 55 | **waha-tui** ([muhammedaksam](https://github.com/muhammedaksam/waha-tui)) | 415★ | OpenTUI WhatsApp client | Full app: sessions, chats, messages, real-time updates | NET, KV, UI, KEY, NOTIF | M | Full app needing NET + realtime subscription. |
| 56 | **noodle** ([wilfredinni](https://github.com/wilfredinni/noodle)) | 405★ | OpenTUI REST client | Full app: YAML collections, assertions, run/CLI | NET, FS, UI, KEY | M | Full app needing NET + FS + assertions. |
| 57 | **tfm-tui** ([clarkarch](https://github.com/clarkarch/tfm-tui)) | 362★ | Mouse-first file manager | Full app: image previews, desktop integration, kitty graphics | FS, NATIVE(kitty gfx), UI, KEY | M | File manager app needing FS + native gfx. |
| 58 | **termdraw** ([benvinegar](https://github.com/benvinegar/termdraw)) | 353★ | Diagram editor TUI | `@termdraw/opentui` render overlay, `@termdraw/pi` | FS, UI, KEY | M | Exports a renderable overlay — closest existing OpenTUI "renderer slot plugin". |
| 59 | **resurrect.wezterm** ([MLFlexer](https://github.com/MLFlexer/resurrect.wezterm)) | 315 | Save/restore WezTerm panes/tabs | Lua `wezterm.plugin.require`, serialize/restore workspace state | FS, ENV, UI, TIMER | M | Persisted state + restore → durable fns + KV, minus timers. |
| 60 | **tabline.wez** ([michaelbrusegard](https://github.com/michaelbrusegard/tabline.wez)) | 303 | WezTerm status/tab bar (lualine format) | Lua callbacks (format-window-title, status), module config | UI(statusline), TIMER, ENV | M | Statusline with periodic refresh; needs a recurring render event. |

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

## The 10 most complex plugins

Complexity = depth of host capability, async/streaming behaviour, and in-memory state
required — i.e. where the reducer (no timers, no long-running work, JSON-only state)
strains hardest.

1. **nvim-lspconfig / nvim-cmp / nvim-dap (+ dap-ui)** — the LSP/debug layer. Long-lived
   language-server and debug-adapter *processes*, an event-driven async client, and (dap)
   threads/stack/REPL state held for the whole session. A reducer can only sit beside a
   host-provided `lsp`/`dap` capability; subscribers and streaming diagnostics must live in
   the host. This is the strongest argument for "LLM/LSP/session access as a host
   function, never as plugin code."

2. **telescope.nvim / fzf-lua / fzf.vim** — fuzzy pickers. They spawn a native `fzf`
   binary, stream candidate lists asynchronously, and own large in-memory indexes over the
   project. Missing from the reducer: background subprocess + streaming results into a
   picker UI slot, and a working set that outgrows "1 KB of JSON state."

3. **lazy.nvim / mason.nvim / nvim-treesitter** — installers and compilers. Clone repos,
   download registries, compile native tree-sitter parsers as background jobs with
   progress. Missing: timed install workflows, progress reporting, native build output.
   They are the clearest "durable async host function" candidates (e.g. `host.install(tool)`).

4. **vim-fugitive / Neogit / lazygit custom commands** — git porcelain UIs. One shape: read
   git state, render a status buffer, translate keys into shell commands (often with prompt
   menus and popup output capture). lazygit's `customCommands` (Go-template placeholders +
   `menuFromCommand` + `output: popup`/`terminal`) is the closest existing sibling to the
   PsychoScript prototype's `commands` array, and the reference for a `git`+`shell`+`prompt`
   host-function set.

5. **gitsigns.nvim / vim-gitgutter** — git signs. Async `git diff` on every buffer edit,
   debounced by timers, rendered into a sign gutter. Missing: debounce timers and a
   first-class "signs/decorations" slot; the diff compute itself is naturally a host fn.

6. **oil.nvim** — a file explorer treating the filesystem as a buffer and writing edits back
   on save, with adapters (local/ssh/trash) and directory *watching*. Missing: FS r/w/watch
   as durable host functions and a way to echo external FS events back in as follow-up
   events (the "host-scheduled `{after, event}`" gap named in the prototype REPORT.md).

7. **noice.nvim** — replaces Neovim's message/cmdline/notification UI with an async router
   of popups and toasts. Its *surface* (UI slots + toasts + event subscriptions) is
   reducible, but only if the host already owns the message bus and exposes it as events;
   the router's long-lived routing state is not.

8. **conform.nvim** — formatter orchestration spawning external formatters, marshalling
   stdin/stdout and applying diffs. Each pass is a clean reducer (event → spawn → apply),
   but it needs `SHELL` with stdin/stdout and buffer-edit return; today the reducer has no
   text/buffer edit vocabulary beyond the proposed view reconciler.

9. **tmux-resurrect / resurrect.wezterm** — session snapshot/restore. Serialize live
   pane/program state to a file and re-create it later. Maps cleanly onto the reducer *if*
   the host owns session state and exposes `save`/`restore`; the complexity is in how much
   process state the host can reconstruct, not in plugin logic. `tmux-continuum` adds the
   one thing the reducer deliberately lacks: a periodic timer.

10. **yazi plugins (yazi-rs/plugins: git, diff, mime-ext…) / zellij plugins (zjstatus)** —
    async-first and long-lived models. Yazi plugins run in a sync or isolated async
    context, use cross-thread `ya.sync` state with Rust-style ownership, and previewers
    stream into a preview area. Zellij plugins are persistent WASM render+event loops that
    send commands back to the host. Both are the opposite of "short run per event, JSON
    in/JSON out" and mark the boundary the reducer should not try to cross.

### Cross-cutting observations for the reducer

- **Lazygit custom commands and k9s plugins fit the reducer almost exactly** (key/context →
  env-seeded shell command → optional popup), and are the best precedent to copy for the
  `commands` vocabulary.
- **The recurring misses are the same five**, matching the gaps the PsychoScript prototype
  `REPORT.md` already names: timers/periodic work (tmux-continuum, statusline refresh),
  long-running background jobs with progress (mason/treesitter/lazy), streaming and
  subscriptions (telescope/fzf, LSP diagnostics, noice), large in-memory state (picker
  indexes, snippet trees, git diff cache), and native/binary deps (fzf, tree-sitter
  parsers, LSP/DAP binaries, WASM).
- **Nearly every "signs/statusline/panel" plugin reduces to a host slot + a host-derived
  value** — exactly the OpenCode TUI `slots` model found in the earlier research. The host
  computing git branch / diagnostics / LSP status and feeding it into a `status` slot is
  the highest-leverage seam.
