# OpenCode plugins: survey of the ecosystem, their API surface, and their host needs

**Area:** OpenCode plugins — the community ecosystem (npm `opencode-*` packages, GitHub projects, the
[ecosystem page](https://opencode.ai/docs/ecosystem), [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode)
and the OpenDock directory), the plugin API they use, and anomalyco/opencode's own built-in plugins
(`packages/plugins`, the TUI feature-plugins, `packages/gui-plugins`).

**Date:** 19 Nov 2026. All GitHub star counts below were read from the GitHub REST API on 2026-11-19; all npm
weekly-download counts are for the week 2026-11-12 → 2026-11-18 read from `api.npmjs.org/downloads/point/last-week`.
Where a number comes from another source it is cited inline.

**Purpose:** identify the most popular and most complex plugins, record what each needs **functionally**, and —
because existing plugins do not have to run as they are — specify **how each would be rewritten as a PsychoScript
reducer** (`{ event, state }` → `{ state, slots, commands }`, no global state between events, host functions only, no
timers / no ambient I/O / no npm imports). Only blockers a rewrite *cannot avoid* are flagged: **long-running
background work, streaming, native dependencies, or very large in-memory state.**

---

## 1. The plugin API surface (what plugins actually call)

OpenCode exposes three plugin SDKs, all from the single `@opencode/plugin` package (`packages/plugin`). These are
the seams a PsychoScript host would have to re-provide as **host functions**.

### 1.1 Server / agent plugin — `@opencode/plugin` and `@opencode/plugin/effect`

Source: `packages/plugin/src/README.md`, `packages/plugin/src/effect/PLAN.md`, `packages/plugin/src/effect/*`.

- **Transform hooks** (replayable, declarative registrations that rebuild a stateful domain) across the domains
  `agent`, `command`, `integration`, `mcp`, `model`, `provider`, `reference`, `skill`, `tool`, `vcs`, `websearch`
  (plus `catalog`). Each is `ctx.<domain>.transform(editor => …)` plus a matching `ctx.<domain>.reload()`.
- **Runtime hooks** (intercept live operations): `ctx.aisdk.hook("sdk" | "language")`, `ctx.session.hook("context"
  | "retry" | "experimental.idle")`, `ctx.tool.hook("execute.before" | "execute.after")`, and an `event` domain that
  exposes a `Stream` of `SelectedEvent`s.
- **Tools plug into the agent**: `ctx.tool.transform(tools => tools.add({ name, description, input, output, execute
  }))` — synchronous or async `execute` returning `{ output, content }`.
- **Storage**: `ctx.storage` for durable JSON keyed per plugin. `worktree` and `shell` domains are also exposed.
- Two dialects: an **Effect** API and a **Promise** API over the same capabilities.

### 1.2 TUI plugin — `@opencode/plugin/tui`

Source: `packages/plugin/src/tui/context.ts`. This is the surface most relevant to the reducer model, because it is
already "data in, UI out":

- **Slots** — a fixed `SlotMap` tree of named boundaries (`app`, `home.footer`, `home.footer.status`,
  `prompt.footer`, `prompt.footer.status`, `prompt.footer.file`, `session.composer.top`, `session.panel`,
  `sidebar.content`, `sidebar.footer`). A plugin claims a place with **prepend / append / before / after / replace**
  and returns a `render(input) => JSX.Element`.
- **Keymap** — reactive `keymap.layer(factory)` returning commands with `run`, `palette: true`, `slash`,
  `bind`, `suggested`, `group`, plus `keymap.mode.push(mode)` for exclusive input modes.
- **Dialogs** — `ui.dialog.{show,set,clear,alert,confirm,prompt,select}`.
- **Toasts / attention** — `ui.toast.show(...)` and `attention.notify(...)` (desktop notification + named sounds).
- **Router / pages** — `ui.router.register(page)` / `navigate(...)` for full-screen plugin pages. `ui.panel.open/close/current` for the session panel.
- **Storage** — `storage.store(key)` (durable JSON, persisted, live-synced across TUI instances) and
  `storage.memory(key)` (ephemeral, survives hot reload, not JSON-only).
- **Read-only reactive data** — `data.on(type, handler)` / `data.listen(...)` event subscriptions plus collection
  readers over `session` (list/get/cost/status/messages/permissions/forms), `project`, `shell`, and `location`
  (`vcs`, `agent`, `command`, `integration`, `mcp.server/resource`, `model`, `provider`, `reference`, `skill`), each
  with `list` / `sync` / `invalidate`.
- **Raw access** — `client: OpenCodeClient` (full RPC), `renderer: CliRenderer` (the OpenTUI renderer), `theme`,
  `markdown.registerCodeBlockRenderer`.

### 1.3 GUI plugin — `@opencode/plugin/gui`

Source: `packages/gui-plugins/README.md`, `packages/plugin/src/gui/*`.

- Window-process and main-process entries, a `Plugin.define` manifest (`os`, `stores`, `icons`, `i18n`),
  `ctx.provide` / `ctx.use` contracts, and an IPC bridge (methods, state, events) between the two processes.

### 1.4 Host capabilities these APIs imply

| Capability | Where plugins use it |
| --- | --- |
| Filesystem read/write/watch | memory/RAG indexers (`OpenCodeRAG`, `deja-vu`, `basemind`), git-backed memory, diarization |
| Shell / process spawn / PTY | `opencode-pty`, `opencode-claude-code-plugin` (spawns `claude`), `firecrawl`/`tavily` CLIs, proxys |
| Network / fetch | every auth provider, MCP bridges, telemetry exporters, memory clouds, web search |
| Git | pr-signature, memory plugins, worktree orchestration (`mission-control`, `ensemble`) |
| LLM / session access | `session.hook`, `experimental.idle` admission, compaction, subagent dispatchers |
| MCP | `mcp.transform` (figma), bundled MCP servers (mem0, dodo, xquik, context7) |
| UI slots / dialogs / toasts / panels | every TUI plugin (sidebar, footer, dir-tree, skills UI) |
| Keybinds / commands / palette / slash | commands, snippets, slash tools, status plugins |
| Timers / background work | scheduler (launchd/systemd), `experimental.idle` loops, background agents, indexers |
| Persistent storage | memory plugins, telemetry (`SQLite`), quota/cache, durable `storage.store` |
| Clipboard / notifications | notifier, ntfy, agent-notifications, attention sounds |
| Env / secrets | auth providers (tokens), quota/cost providers, `rehydra`/`envsitter` (redaction) |

---

## 2. anomalyco/opencode built-in plugins

Source: repo clone `packages/plugins`, `packages/gui-plugins`, `packages/tui/src/plugin/builtins.ts`,
`packages/tui/src/feature-plugins/*`.

**Official opt-in packaged plugin** (`packages/plugins`):

- **Figma** (`packages/plugins/figma`) — install from Git, not npm. `index.ts` calls exactly two transform hooks:
  `ctx.mcp.transform(...)` to register Figma's remote MCP server (OAuth/DCR, loopback callback, existing credential
  storage) and `ctx.skill.transform(...)` to register a vendored Figma skill bundle. No timers, no background work.
  **Rewrite as reducer:** trivially — on `init` call host `mcp.register()` + `skill.register()` and return nothing;
  the OAuth handshake is a host function, not plugin state. No blockers.

**TUI feature-plugins** (`packages/tui/src/feature-plugins`, registered in `builtins.ts`): `HomeFooter`, `PromptFooter`,
`PromptBtw`, `SidebarContext`, `SidebarLimit`, `SidebarMcp`, `SidebarTodo`, `SidebarFooter`, `Notifications`, `Plugins`
(the plugin-manager UI), `Stats`, `Merman` (mermaid), `Latex`, `Storybook` (dev-only, `OPENCODE_STORY`), `DiffViewer`.
These are slot + keymap + data-subscription renderers — the model the reducer's `{ slots, commands }` output maps onto
directly (each is archetype **K**, below).

**Built-in GUI plugins** (`packages/gui-plugins`): per its README, "every feature of the desktop and web app that is
not the core shell is a built-in GUI plugin: the terminal, review, files, the browser, SSH, WSL, the updater and more."
The checked-in representative is **WSL** (`src/wsl/*`), a multi-process plugin (window + main, IPC contract).

---

## 3. Community plugins, ranked (stars + weekly downloads)

Ranked primarily by GitHub stars, then npm weekly downloads. Stars via GitHub API on 2026-11-19; downloads via
`api.npmjs.org` week 2026-11-12→18. "dl/wk" blank = not published under that name or not measured. Mentions tagged in the
"What it does" cell: **EC** official ecosystem page · **AO** awesome-opencode · **OD** OpenDock · **IM** opencode.im.

The right column is the **reducer rewrite**: the archetype letter (defined in §5), the events → state → `{returns}`,
and the host functions, with `⚠` only on the four irreducible blockers. Cx = complexity (S/M/L).

| # | Plugin (author) | Stars · dl/wk | What it does — mentions | Needs functionally | Reducer rewrite (events · state · returns · host fns) | Cx |
|---|---|---|---|---|---|---|
| 1 | ponytail (dietrichgebert) | 194,586 · — | "Lazy senior dev mode" multi-agent harness; opencode one target [OD] | subagents, worktrees, model routing | `G` · `command`,`session.idle` → `subagent.spawn` · state `{plan}` · `slots.status`,`commands` · ⚠ background agent loop | L |
| 2 | mem0 / @mem0/opencode-plugin (Mem0 Inc) | 69,238 (mem0ai/mem0) · 164 | Persistent cross-session memory: 9 tools, 16 slash cmds, hooks [AO,OD] | durable memory store, retrieval, capture-on-message | `C` · `chat.message`,`session.start` → `memory.store/search` · state `{cursor}` · `slots.status`,`commands` · no runtime blocker (embeddings live in the host/service, not the plugin) | L |
| 3 | context7 (Upstash) | 65,108 (upstash/context7) · — | Wires Context7 MCP + a documentation skill [OD,IM] | MCP registration, doc retrieval | `B` · `init` → `mcp.register`,`skill.register` · state `{}` · returns — · no blocker | M |
| 4 | openviking / @openviking/opencode-plugin (ByteDance) | 42,466 (volcengine/openviking) · 1,562 | Repo retrieval + long-term memory, model switching [OD,IM,AO] | memory recall/capture, model switching | `C`+`A` · `chat.message`,`usage` → `memory.*`,`model.switch` · state `{recall}` · `slots.status` · ⚠ background recall + process restart | L |
| 5 | @plannotator/opencode (backnotprop) | 13,585 · 7,315 | Browser plan-annotation UI, strike/replace/comment [EC,OD,AO,IM] | plan interception, local review UI | `D` · `plan.created` → `ui.openAnnotator` · state `{}` · returns — · ⚠ long-lived HTTP UI + plan streaming (streaming) | L |
| 6 | opencode-antigravity-auth (NoeFabris) | 11,073 · 5,327 | Use Antigravity's free models via IDE auth [EC,AO,IM] | OAuth, durable token store | `A` · `login`,`provider.updated` → `auth.authorize/refresh` · state `{tokens}` · `slots.status`,`commands=[login]` · no blocker | S |
| 7 | oh-my-opencode-slim (alvinunreal) | 10,292 · 8,737 | Slim fork: subagents, LSP/AST tools, tmux, MCP [OD,IM] | subagents, LSP/AST, tmux | `G` · `session.idle`,`command` → `subagent.spawn`,`lsp` · state `{plan}` · `slots.status`,`commands` · ⚠ background agents + LSP processes | L |
| 8 | opencode-dynamic-context-pruning (Tarquinen) | 4,508 · — | Prunes obsolete tool outputs from context [EC,OD,AO] | context read/edit pre-compaction | `D` · `chat.message` → `context.prune` · state `{rules}` · returns — · no blocker (pure text transform) | M |
| 9 | opencode-openai-codex-auth (numman-ali) | 2,203 · 4,142 | Use ChatGPT Plus/Pro subscription [EC] | OAuth, durable token store | `A` · `login` → `auth.authorize` · state `{tokens}` · `slots.status` · no blocker | S |
| 10 | opencode-mem (tickernelz) | 1,880 · — | Local vector-DB memory, auto-capture, web UI [AO] | embeddings, vector storage, capture | `C` · `chat.message` → `memory.*` · state `{index cursor}` · `slots.status`,`commands` · ⚠ native vector DB + background indexing | L |
| 11 | opencode-gemini-auth (jenslys) | 1,776 · 5,681 | Google account auth for Gemini plan [EC,AO] | OAuth, durable token store | `A` · `login` → `auth.authorize` · state `{tokens}` · `slots.status` · no blocker | S |
| 12 | opencode-supermemory (supermemoryai) | 1,670 · 2,428 | Persistent memory via Supermemory service [EC,IM] | hosted memory service | `C` · `chat.message`,`session.start` → `memory.*` · state `{cursor}` · `slots.status`,`commands` · no runtime blocker (hosted service) | M |
| 13 | kimaki (remorses) | 1,452 · — | Discord bot to control opencode sessions [AO,OD] | webhook ingress, session start | `G`+`E` · webhook `message` → `session.start`,`notify` · state `{bot map}` · returns — · ⚠ long-running bot + inbox polling | L |
| 14 | caspian (TryCaspian) | 971 (caspian-sdk) · 50 | Agent inbox (email/Telegram/Discord), slash cmds [AO] | inbox polling, notifications | `E`+`C` · `inbox.message` → `notify`,`inbox.fetch` · state `{threads}` · `commands` · ⚠ inbox polling + streaming | M |
| 15 | opencode-notifier (mohak34) | 867 · — | Desktop notifications + sound [EC] | os notification, sound | `E` · `permission`,`complete`,`error` → `notify.desktop` · state `{}` · returns — · no blocker | S |
| 16 | agent-notifications (777genius) | 835 · — | Desktop + webhook alerts [IM,AO] | os notification, webhook | `E` · `permission`,`complete`,`error` → `notify.webhook` · state `{}` · returns — · no blocker | S |
| 17 | opencode-pty (shekohex) | 613 · 4,002 | Background processes in a PTY [EC,IM] | PTY spawn, interactive IO | `J` · `command` → `pty` · ⚠ PTY is streaming + process-lifetime (irreducible in-plugin) | M |
| 18 | opencode-swarm (zaxbysauce) | 537 · — | Verification-gated swarm (architect/review/test/security) [AO,IM] | subagents, review loop | `G` · `command` → `subagent.spawn` · state `{plan}` · `commands` · ⚠ swarm loop + verification gating | L |
| 19 | opencode-scheduler (different-ai) | 520 · 3,385 | Cron jobs via launchd/systemd [EC] | host-owned timer, session start | `L` · `job.due` (host-fired) → `session.start` · state `{jobs}` · `commands` · no blocker **iff** host owns the timer | M |
| 20 | micode (vtemian) | 513 · — | Brainstorm → plan → implement, worktree isolation [EC,AO] | subagents, git worktree, AST | `G` · `command` → `subagent.*`,`git.worktree` · state `{plan}` · `commands` · ⚠ multi-phase subagent loop | L |
| 21 | operator-memory (@aerovato) | — · — | Durable Markdown memory across partitions [AO,OD,IM] | durable markdown store, session inject | `C` · `chat.message`,`session.start` → `memory.get/set`,`git` · state `{}` · `slots.status`,`commands` · no blocker (plain storage) | M |
| 22 | opencode-goal-plugin (willytop8) | 289 · — | Session `/goal` workflow that auto-continues [EC] | session admission, auto-continue | `D` · `session.idle` → `session.start` · state `{goal}` · `commands=[goal]` · ⚠ auto-continue loop unless host-driven | M |
| 23 | opencode-agent-memory (joshuadavidthomas) | 365 · — | Letta-inspired self-editable memory blocks [AO] | persistent blocks, session access | `C` · `chat.message` → `memory.*` · state `{blocks}` · `commands` · no blocker | M |
| 24 | opencode-agent-skills (joshuadavidthomas) | 292 · — | Dynamic skill discovery across dirs [AO] | filesystem read/discover | `B` · `location.sync` → `skill.discover` (fs) · state `{}` · returns — · no blocker | S |
| 25 | opencode-cursor (ephraimduncan) | 286 · 6 | Cursor subscription via OAuth + local proxy [AO] | OAuth, local HTTP proxy | `A` · `login` → `auth.authorize` · state `{tokens}` · `slots.status` · ⚠ local proxy process | M |
| 26 | subtask2 (@openspoon) | 257 · 61 | Extends `/commands` into orchestration [EC] | subagents, command tree | `G` · `command` → `subagent.*` · state `{plan}` · `commands` · ⚠ orchestration loop (mild) | M |
| 27 | opencode-ensemble (hueyexe) | 264 · — | Parallel agent teams, worktrees, dashboard [AO,IM] | subagents, git worktree, live UI | `G` · `command` → `subagent.*`,`git.worktree` · state `{plan}` · `slots.status`,`commands` · ⚠ peer messaging + live dashboard (bg + streaming) | L |
| 28 | opencode-websearch-cited (ghoulr) | 248 · 295 | Native websearch with citations [EC] | web search | `H` · `tool.websearch` → `websearch.query` · state `{}` · returns result · no blocker (network via host) | S |
| 29 | opencode-vibeguard (inkdust2021) | 220 · 1,554 | Redact secrets/PII before LLM call [EC] | secret scan, context edit | `D` · `chat.message`,`tool` → `secrets.redact` · state `{map}` · returns — · no blocker (pure transform) | M |
| 30 | opencode-wakatime (angristan) | 205 · 656 | WakaTime activity tracking [EC,AO] | time accounting, heartbeat upload | `E` · `usage`,`session.end` → `wakatime.heartbeat` · state `{elapsed}` · returns — · ⚠ heartbeats have no per-event trigger → needs a host timer | S |
| 31 | opencode-morph-fast-apply (JRedeker) | 170 · — | 10× code edit via Morph Fast Apply [EC,AO] | remote code-edit API, diff | `H` · `tool.edit` → `fetch`,`git` · state `{}` · returns diff · no blocker (network) | M |
| 32 | opencode-snip (VincentHardouin) | 163 · 958 | Prefix shell cmds with `snip` to cut tokens [AO] | shell filter subprocess | `D` · `shell.before` → `exec snip` · state `{}` · returns — · ⚠ subprocess (native) | S |
| 33 | opencode-plugin-otel (DEVtheOPS) | 156 · — | OTLP/gRPC telemetry export [AO] | usage/tool events, export | `F` · `usage`,`tool` → `telemetry.export` (batched) · state `{counters}` · `slots.status` · no blocker | M |
| 34 | opencode-conductor (derekbar90) | 134 · 514 | Context → Spec → Plan → Implement automation [EC] | subagents, git, persistence | `G` · `command` → `subagent.*`,`git` · state `{plan}` · `commands` · ⚠ workflow loop | L |
| 35 | opencode-claude-code-plugin (khalilgharbaoui) | 134 · 20 | Run Claude via the official `claude` CLI [AO] | subprocess, session proxy | `A`+`H` · `provider.request` → `provider.proxy` · state `{accounts}` · `slots.status` · ⚠ spawns `claude` subprocess (native) | M |
| 36 | basemind (Goldziher) | 124 · 395 | MCP context layer: code-map, RAG, git history [AO] | tree-sitter, embeddings, git | `C`+`H` · `location.sync` → `code.index`,`memory.*` · state `{cursor}` · `commands` · ⚠ tree-sitter + git history, background indexing | L |
| 37 | opencode-firecrawl (firecrawl) | 103 · — | Web scrape/crawl/search via Firecrawl CLI [EC] | subprocess or API | `H` · `tool.crawl` → `exec` or `fetch` · state `{}` · returns result · ⚠ subprocess CLI (avoidable via their HTTP API) | M |
| 38 | opencode-snippets (JosXa) | 93 · 2,816 | Inline `#snippet` expansion in the prompt [AO] | composer input hook, snippet store | `K` · `prompt.input` → `composer.expand` · state `{snippets}` · `commands` · no blocker | S |
| 39 | opencode-morph-plugin (morphllm) | 91 · — | Fast Apply, WarpGrep search, compaction [EC] | remote API, git | `H` · `tool.edit`,`tool.search` → `fetch` · state `{}` · returns diff · no blocker (network) | M |
| 40 | opencode-llm-proxy (KochC) | 91 · — | Local gateway serving OpenAI/Anthropic/Gemini [AO,IM] | local HTTP server, streaming | `I` · — · ⚠ persistent server + streaming (irreducible; becomes host infra) | L |
| 41 | OpenCodeRAG (MrDoe) | 70 · — | Local semantic code search: tree-sitter + LanceDB [AO] | index, embeddings, watch | `C` · `chat.message` → `code.search` · state `{cursor}` · `commands` · ⚠ native LanceDB + tree-sitter + file-watch + embeddings | L |
| 42 | opencode-zellij-namer (24601) | 66 · 35 | Auto Zellij session naming [EC] | session context, shell control | `K` · `session.ready` → `shell.zellij` · state `{}` · returns — · no blocker | S |
| 43 | opencode-skills-tui (aihaipeng) | 54 · — | V2 sidebar browsing skills, previews [AO,IM] | fs read, slot render | `K` · `location.sync` → `fs.read` · state `{open}` · `slots.sidebar`,`commands` · no blocker | M |
| 44 | opencode-failover (bulutmuf) | 52 · — | API-key rotation/quarantine [AO] | secrets, provider state | `A`+`F` · `provider.error` → `provider.switchKey` · state `{keys}` · `slots.status` · ⚠ quarantine re-enable timer (mild) | M |
| 45 | opencode-sentry-monitor (stolinski) | 51 · 352 | Trace agents with Sentry AI Monitoring [EC] | usage/tool events, export | `F` · `usage`,`tool` → `telemetry.export` · state `{counters}` · `slots.status` · no blocker (batch) | M |
| 46 | opencode-supabase (supabase-community) | 44 · 159 | Login, Management API tools, skills, MCP [EC] | OAuth, API tools, MCP | `B`+`H` · `login`,`tool.*` → `auth.authorize`,`fetch` · state `{tokens}` · `commands` · no blocker | M |
| 47 | FlowDeck (DVNghiem) | 42 · — | 25-agent workflow, SQLite memory, deep hooks [AO] | subagents, SQLite, idle monitor | `G` · `command`,`idle` → `subagent.*`,`memory.*` · state `{plan}` · `slots.status`,`commands` · ⚠ 25 agents + SQLite + idle monitor (bg + large state) | L |
| 48 | @telemetry-dev/opencode | 38 (telemetry-dev/telemetry) · — | OpenTelemetry traces of turns/tools [AO] | event streaming, OTel export | `F` · `usage`,`tool` → `telemetry.export` · state `{counters}` · returns — · no blocker (batch) | M |
| 49 | opencode-dir-tree-tui (aihaipeng) | 29 · 266 | V2 sidebar file tree + git status [AO,IM] | fs read, git status, slot | `K` · `location.sync` → `fs.readDir`,`git.status` · state `{dirs}` · `slots.sidebar`,`commands` · no blocker | M |
| 50 | opencode-mission-control (nigel-dev) | 29 · — | Parallel agents in tmux worktrees, DAG, merge train [AO,OD] | tmux, worktrees, subagents | `G` · `command` → `subagent.*`,`git.worktree` · state `{plan}` · `slots.status`,`commands` · ⚠ tmux worktrees + merge train (bg) | L |
| 51 | opencode-agents-sidebar (Mark1708) | 23 · — | Browse OhMyOpenAgent agents in TUI [AO] | read data, slot | `K` · `location.sync` → data read · state `{}` · `slots.sidebar` · no blocker | S |
| 52 | opencode-usage-monitor (Mark1708) | — · — | OpenAI & Z.AI quota in the sidebar [AO] | network quota fetch, slot | `K` · `usage` → `fetch` · state `{quota}` · `slots.sidebar` · no blocker | M |
| 53 | opencode-helicone-session (H2Shami) | 15 · 92 | Inject Helicone headers for grouping [EC] | provider header injection | `A`+`F` · `provider.request` → `provider.header` · state `{}` · returns — · no blocker | S |
| 54 | opencode-tavily (tavily-ai) | 10 · 96 | Web search/extraction via Tavily CLI [EC] | subprocess or API | `H` · `tool.search` → `exec` or `fetch` · state `{}` · returns result · ⚠ subprocess CLI (avoidable via HTTP API) | S |
| 55 | opencode-daytona (daytona) | 7 (daytona/integrations) · — | Run sessions in isolated Daytona sandboxes [EC] | sandbox API, session sync | `H`+`G` · `command` → `sandbox.spawn` · state `{sandbox}` · `commands` · ⚠ sandbox session + git sync (bg) | L |
| 56 | opencode-jfrog-plugin (jfrog) | 1 · — | JFrog platform integration [EC] | auth, API tools, MCP | `B`+`H` · `login`,`tool.*` → `auth.authorize`,`fetch` · state `{tokens}` · `commands` · no blocker | M |

Not starred here (small/uncounted) but relevant and present in official docs or awesome lists: `opencode-shell-strategy`
(JRedeker), `opencode-md-table-formatter` (franlol), `opencode-notifier`, `opencode-type-inject` (nick-vi),
`@aerovato/operator-memory`, `agent-memory`, `agent-skills`, `codemem`, `deja-vu`, `OpenCodeRAG`, `planning-with-files`
(othmanadi, 28k ⭐ per awesome-market), `ego-lite` (citrolabs, 23k ⭐), `pixelrag` (startrail-org, 11k ⭐), `magpie`,
`@th3akii/opencode-quota`, `@plfavreau/opencode-dcp`, `rehydra`, `sonarqube`, `dodo`, `ContextStream`, `xquik`,
`superpowers` (obra), `systematic`, `open-plan-annotator` (ndom91), `octto`, `wakatime`, `opencode-ai-usage`,
`opencode-costs`, `openwikki` etc.

**Directory context:** OpenDock lists **3,283 indexed OpenCode plugins** (synced daily from npm + GitHub, ranked by
installs/stars/activity); awesome-market tracks a daily re-synced open-data catalog with a ≥10 ⭐ top-20. The official
V1 ecosystem page lists ~30 hand-curated plugins. So the tail is long; the table above is the head plus the complex/sizeable ones.

---

## 4. The 10 most complex plugins (rewritten as reducers)

For each: the functional need, then the reducer rewrite (events → state → `{returns}` → host functions), flagging only
irreducible blockers.

1. **oh-my-opencode / oh-my-opencode-slim** (70,997 ⭐ / 10,292 ⭐; 50,568 / 8,737 dl/wk). Need: run background
   subagents with LSP/AST tools, tmux visibility, Claude-Code-compat. Reducer: on `session.idle` and `command`, keep
   `state:{plan, agents}`, return `slots.status` + `commands`, calling host `subagent.spawn`, `lsp.query`, `tmux`.
   **⚠ Blockers: background agents + LSP processes are long-running work a reducer cannot own**; the subagents must be
   host-executed and report back as events.

2. **ponytail** (194,586 ⭐). Need: a multi-agent orchestration loop over several CLI agents. Reducer: on
   `session.idle`/`command`, dispatch subagents and keep `state:{plan}` → `slots.status`. **⚠ Blocker: the live
   agent-supervision loop.** Not reducible as a per-event pure run.

3. **mem0 / @mem0/opencode-plugin** (69,238 ⭐ repo). Need: persistent memory with capture-on-message and search at
   session start. Reducer: on `chat.message` call host `memory.capture`; on `session.start` call host `memory.search`
   and return `slots.status` + `commands`. Storage and embeddings live in the host/service; **no blocker** in the
   reducer itself (the memory backend is a host capability, not plugin state).

4. **context7** (65,108 ⭐ repo). Need: register a docs MCP + a skill. Reducer: on `init` call host
   `mcp.register(context7)` + `skill.register(docs)`; return nothing. **No blocker** (purely declarative; the retrieval
   is a host-managed MCP server).

5. **openviking / Magpie** (42,466 ⭐). Need: memory recall/capture + model switching + automatic restart. Reducer: on
   `chat.message`/`usage` call host `memory.*` and `model.switch`; return `slots.status`. **⚠ Blocker: background
   recall and the automatic *restart*** (a long-running supervision action, not an event).

6. **@plannotator/opencode** (13,585 ⭐; 7,315 dl/wk). Need: intercept plan mode, show a browser annotation UI, apply
   edits. Reducer: on `plan.created`, call host `ui.openAnnotator(plan)` and return nothing; apply arrives back as a
   `plan.edited` event. **⚠ Blockers: a long-lived local HTTP UI and plan streaming** — the review surface must be
   host-provided, not reducer-held.

7. **opencode-mission-control / opencode-ensemble** (29 / 264 ⭐). Need: parallel agents in tmux-isolated worktrees,
   DAG plans, merge trains. Reducer: on `command`, keep `state:{plan,dag}`, return `slots.status` + `commands`, calling
   host `subagent.*` / `git.worktree` / `tmux`. **⚠ Blocker: supervising long-running agents/merges and the live
   dashboard (background + streaming).**

8. **OpenCodeRAG** (70 ⭐). Need: tree-sitter chunking, LanceDB index, file-watch re-indexing, embedding search. Reducer:
   on `chat.message`, call host `code.search(q)`; host owns the index. **⚠ Blockers: native LanceDB + tree-sitter, file
   watching, and background embedding/indexing** — the index is host infrastructure; the reducer is only the query
   front-end.

9. **opencode-llm-proxy** (91 ⭐). Need: a local HTTP gateway with streaming and parallel tool calls. **⚠ Blocker: a
   persistent local server with streaming — irreducible in-plugin.** The reducer can only *configure* a host-provided
   proxy; it cannot *be* the server.

10. **FlowDeck** (42 ⭐). Need: 25 specialist agents, SQLite memory, idle/context monitoring. Reducer: on `command` and
    `session.idle`, keep `state:{plan,phase}`, return `slots.status` + `commands` via host `subagent.*` / `memory.*`.
    **⚠ Blockers: multi-agent orchestration + SQLite memory (background work + large state), plus idle monitoring.**

Close seconds: `opencode-scheduler` (**needs a host-owned timer**; otherwise reducible), `basemind` (tree-sitter +
git-history native + background indexing, ⚠), `deja-vu` (a local Go binary indexing transcripts — **native
subprocess**, ⚠).

---

## 5. Reducer rewrite archetypes

Every plugin in §3 maps onto one of these. "Events" = what the reducer reacts to, "state" = the plain JSON it keeps,
"returns" = `{ state, slots, commands }`, "host fns" = the host functions it calls.

| Archetype | Events | State | Returns | Host functions | Blockers |
|---|---|---|---|---|---|
| **A** auth / provider (OAuth) | `login`, `provider.updated` | `{tokens, recents}` | `slots.status`, `commands=[login]` | `auth.authorize`, `auth.refresh`, `storage`, `provider.register` | none, if refresh is lazy on call; only a background refresh loop would block |
| **B** declarative registration | `init`, `location.sync` | `{}` | — | `mcp.register`, `skill.register`, `provider.register` | none — the MCP/skill is host-managed |
| **C** cross-session memory/context | `chat.message`, `session.start`, `session.end` | `{cursor, keys}` | `slots.status`, `commands`, context injection | `memory.get/set/query`, `session.inject`, `git` | only when the plugin owns a vector index (native DB + background indexing); hosted/Markdown memory is clean |
| **D** intercept / gate (transform) | `chat.message`, `tool.execute.before`, `shell.before` | `{rules}` | a permission decision | `permission.decide`, `context.prune`, `secrets.redact` | none for pure text transforms; ⚠ if the check shells out or calls an external analyzer |
| **E** notification | `permission`, `session.complete`, `session.error` | `{}` | — | `notify.desktop`, `notify.webhook` | none (network via host); WakaTime additionally needs a host timer |
| **F** telemetry / usage | `usage`, `tool`, `session.message` | `{counters}` | `slots.status`, `commands=[report]` | `telemetry.export` | none (batch export); only continuous streaming export blocks |
| **G** multi-agent orchestration | `session.idle`, `command` | `{plan, phase}` | `slots.status`, `commands` | `subagent.spawn`, `git.worktree`, `session.start`, `lsp` | **⚠ long-running background supervision** — the reducer cannot own the subagent loop; host must drive it and feed events |
| **H** external service / CLI bridge | `tool.<name>` | `{}` | tool result | `websearch.query`, `fetch`, `exec` | ⚠ only the subprocess-backed bridges (firecrawl/tavily CLI, `snip`); HTTP ones reduce cleanly |
| **I** local server / proxy | — | — | — | (host-owned server) | **⚠ persistent server + streaming — irreducible in-plugin**; reducer only configures it |
| **J** PTY / interactive shell | `command` | — | — | `pty` | **⚠ streaming + process-lifetime, irreducible in-plugin** |
| **K** TUI sidebar / status / UI | `location.sync`, `session.ready`, `command` | `{openDirs,…}` | `slots.sidebar.content`, `commands`, keybinds | `fs.readDir`, `git.status`, `data` collections | none — this is the ideal reducer |
| **L** scheduler / cron | `job.due` (host-fired) | `{jobs}` | `commands` | `scheduler.register`, `session.start` | none iff the host owns the timer; ⚠ if the plugin must run its own clock |

### The only four blockers (a rewrite cannot avoid them)

1. **Long-running background work** — multi-agent orchestration (archetype **G**: oh-my-opencode, ensemble, swarm,
   mission-control, conductor, micode, FlowDeck, ponytail), bot/inbox loops (kimaki, caspian), sandbox sync (daytona),
   background recall/restart (openviking).
2. **Streaming** — llm-proxy (**I**), opencode-pty (**J**), plannotator's plan stream and agent dashboards.
3. **Native dependencies** — vector DB/tree-sitter/embeddings (opencode-mem, OpenCodeRAG, basemind, deja-vu's Go
   binary), subprocess CLIs (firecrawl, tavily, snip, claude-code-plugin, morph), local proxies (cursor, antigravity
   bridge).
4. **Very large in-memory state** — memory/telemetry indexes that must persist across events (opencode-mem,
   OpenCodeRAG, FlowDeck's SQLite); these must live in a host-provided durable store, not the reducer's JSON state.

Everything else — auth, notification, intercept-transforms, declarative MCP/skill registration, TUI slots/commands,
and single-shot network/tool calls — reduces onto `{ event, state } → { state, slots, commands }` with no blocker, once
the host exposes the corresponding function (e.g. `auth.authorize`, `memory.get/set`, `notify.*`, `websearch.query`,
`fs.readDir`, `git.status`). These same gaps map one-for-one onto the prototype `REPORT.md` limitations (long-lived runs
unviable today, no compute/memory budget, no GC, no interrupt handle).

---

## 6. Earlier research found in anomalyco's repos and branches

Sources are cited per finding; only findings **about existing plugins and their needs** are extracted here (not the
plugin approaches proposed in those places).

- **`anomalyco/opentui`, branch `psychoscript-plugins`, `packages/rust/examples/psychoscript-plugins/REPORT.md`.**
  The prototype's own reducers describe what a real status-bar / palette plugin needs: a `git status` capability
  (`async`), a tick event, a refresh command with a keybinding, and `slots.status` text. It records the concrete gaps:
  OpenTUI has no `SlotRegistry` and no data-driven view/reconciler; long-lived plugins are "not viable today" (no GC,
  timeout counts idle time, snapshots don't survive source changes). These are reducer-side facts, but the plugin-side
  need it demonstrates is: **async host functions and durable plain-JSON state**.
- **`anomalyco/opencode`, branch `example-tui-plugin`** (commit `df4362a7`, "ignore: example tui plugin", 2026-04-15,
  author Aiden Cline). Adds `.opencode/plugins/tui-config-once-toast.tsx` — an example TUI plugin built on the **older**
  `@opencode-ai/plugin/tui` API. It reads `api.state.config`, validates it, and calls `api.ui.toast(...)`, while
  `.opencode/tui.json` wires `keybinds` keyed by `modal` / `screen` / `home` / `dialog_close`. **Finding: the minimal
  TUI plugin needs (a) config access, (b) a toast UI primitive, and (c) keybind registration**, in addition to the
  slot model that replaced this API. This predates the current slot-based `@opencode/plugin/tui`.
- **`anomalyco/opencode`, branch `copilot/research-opencode-server-plugin-api`** (tip `3a0e00dd`). This exists but is a
  frozen snapshot of `dev` ~12,032 commits behind the current `dev`; `git diff` against its merge-base with `dev` is
  empty, so no standalone research document was committed to the branch. The name records that server-plugin-API
  research happened here; the durable design artifacts are the **V2 plugin PLAN** below. (Reported as found, not as
  findings.)
- **`anomalyco/opencode`, `packages/plugin/src/effect/PLAN.md` ("V2 Plugin System Implementation Plan").** The agreed
  target: internal and external plugins share one public API; Effect plugins import `@opencode/plugin/effect`;
  plugins register **replayable domain transforms and runtime hooks**; dynamic sources (models.dev, config, skill dirs)
  rebuild one domain without reloading the Location. This is the design every plugin in §3 compiles against, and it is
  read to extract §1's API surface.
- **`anomalyco/opencode`, `packages/codemode/README.md` (+ `interpreter-support.md`).** Documents OpenCode's existing
  confined interpreter ("Code Mode", the JS-like language behind tool-calling) with the same constraints as the
  decision: programs have **no network, filesystem, process, or app APIs; no timers; no npm; no `process`**; they reach
  the world only through host-provided tools, with execution time / tool-calls / output size limits. This shows the
  reducer's constraint set is already the norm inside OpenCode's own tool layer.
- **`anomalyco/opencode`, `cli-rs` commit subjects** (e.g. `f2b81ec135 feat(cli-rs): run Luau plugins as a fourth
  carrier`, `b54a9de65c …`, `b638c1b8dc add Confirm and Alert plugin dialogs`, `807fff6ea4 keep a JS plugin's session
  panel open across a reload`). Records that the Rust CLI hosts **JS and Luau plugin carriers** and that plugin work
  there covers dialogs (Confirm/Alert), session panels, and registration reload semantics — i.e. the reducer-facing
  TUI surface enumerated in §1.2.
- **`anomalyco/opentui`, `packages/plugins/README.md` (via opencode repo `packages/plugins/README.md`).** States the
  official-plugin convention: packages are **installed from Git URLs, not npm**, are never bundled or auto-loaded, and
  must not be added to Core's dependencies. Relevant because the reducer host's "load plugins from a directory" mirrors
  this distribution model.

(Simon Klee's `simonklee` remote and branches — checked in both `opentui` and `opencode` repos — are TUI/rendering/perf
work, e.g. `fix(tui): end the compaction summary's stream…`, `perf(tui): …`, with no dedicated plugin-needs survey found
under that authorship. The two "research" branches named in the task were checked as above.)

---

## 7. Method and sources

- **Star counts** — GitHub REST API `GET /repos/{owner}/{repo}` on 2026-11-19 (rate-limited to 60/hr; ~70 repos queried).
  Figures for multi-project repos (mem0, context7, ponytail, openviking, caspian) are the parent repo's stars, noted as such.
- **npm weekly downloads** — `GET https://api.npmjs.org/downloads/point/last-week/{pkg}` for week 2026-11-12 → 2026-11-18.
- **Plugin catalog/ranking** — OpenDock (`opendock.net`, 3,283 plugins, "synced daily"); awesome-market
  (`awesome-market/awesome-opencode-plugins`, open-data daily trend, top-20 new-arrivals with stars);
  opencode.im (featured/rising, "data as of 2026-11-15/18"); official docs at `opencode.ai/docs/ecosystem` (V1) and
  `opencode.ai/docs/plugins`; `awesome-opencode/awesome-opencode` README.
- **API surface + built-in plugins** — a `--filter=blob:none` clone of `github.com/anomalyco/opencode` (branch `dev`),
  reading `packages/plugin/src/**`, `packages/plugins`, `packages/gui-plugins`, `packages/tui/src/plugin`,
  `packages/codemode`, and the two named branches.
- **Prototype** — `anomalyco/opentui` branch `psychoscript-plugins`, `packages/rust/examples/psychoscript-plugins/REPORT.md`.

Numbers are point-in-time snapshots; both the catalog and the repos churn daily.
