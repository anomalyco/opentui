# OpenCode plugins: survey of the ecosystem, their API surface, and their host needs

**Area:** OpenCode plugins — the community ecosystem (npm `opencode-*` packages, GitHub projects, the
[ecosystem page](https://opencode.ai/docs/ecosystem), [awesome-opencode](https://github.com/awesome-opencode/awesome-opencode)
and the OpenDock directory), the plugin API they use, and anomalyco/opencode's own built-in plugins
(`packages/plugins`, the TUI feature-plugins, `packages/gui-plugins`).

**Date:** 19 Nov 2026. All GitHub star counts below were read from the GitHub REST API on 2026-11-19; all npm
weekly-download counts are for the week 2026-11-12 → 2026-11-18 read from `api.npmjs.org/downloads/point/last-week`.
Where a number comes from another source it is cited inline.

**Purpose:** identify the most popular and most complex plugins, record what host capabilities each needs, and
assess whether each fits the PsychoScript **reducer model** (`{ event, state }` → `{ state, slots, commands }`, no
global state between events, host functions only, no timers / no ambient I/O / no npm imports).

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
  **Reducer fit:** yes — two replayable transforms + durable credential storage.

**TUI feature-plugins** (`packages/tui/src/feature-plugins`, registered in `builtins.ts`): `HomeFooter`, `PromptFooter`,
`PromptBtw`, `SidebarContext`, `SidebarLimit`, `SidebarMcp`, `SidebarTodo`, `SidebarFooter`, `Notifications`, `Plugins`
(the plugin-manager UI), `Stats`, `Merman` (mermaid), `Latex`, `Storybook` (dev-only, `OPENCODE_STORY`), `DiffViewer`.
These are slot + keymap + data-subscription renderers — the model the reducer's `{ slots, commands }` output maps onto
directly.

**Built-in GUI plugins** (`packages/gui-plugins`): per its README, "every feature of the desktop and web app that is
not the core shell is a built-in GUI plugin: the terminal, review, files, the browser, SSH, WSL, the updater and more."
The checked-in representative is **WSL** (`src/wsl/*`), a multi-process plugin (window + main, IPC contract).

---

## 3. Community plugins, ranked (stars + weekly downloads)

Ranked primarily by GitHub stars, then npm weekly downloads. Stars via GitHub API on 2026-11-19; downloads via
`api.npmjs.org` week 2026-11-12→18. "dl/wk" blank = not published under that name or not measured. "Mentions" =
official docs ecosystem page (**EC**), awesome-opencode (**AO**), OpenDock directory (**OD**), opencode.im (**IM**).

Cx = complexity (S/M/L). "Reducer?" = fits the reducer model as-is (✓), mostly (◐), or not without additions (✗).

| # | Plugin (author) | Stars | dl/wk | Mentions | What it does | API surface | Host capabilities | Cx |
|---|---|---|---|---|---|---|---|---|
| 1 | ponytail (dietrichgebert) | 194,586 | — | OD | "Lazy senior dev mode" multi-agent harness; opencode is one of several targets | CLI wrapper / harness, subagent orchestration | shell, subagents, streaming, timers | L |
| 2 | mem0 / @mem0/opencode-plugin (Mem0 Inc) | 69,238 (mem0ai/mem0) | 164 (`@mem0/opencode-plugin`) | AO, OD | Persistent cross-session memory: 9 MCP memory tools, 16 slash commands, lifecycle hooks | tool.transform, command, mcp, hooks | network/embeddings, persistent storage, hooks | L |
| 3 | context7 (Upstash) | 65,108 (upstash/context7) | — (`context7-opencode`) | OD, IM | Wires Context7 MCP + a documentation skill for library docs RAG | mcp, skill | network/fetch, MCP | M |
| 4 | openviking / @openviking/opencode-plugin (ByteDance) | 42,466 (volcengine/openviking) | 1,562 | OD, IM, AO | OpenViking repo retrieval + long-term memory (Magpie recall/capture, model switching) | tool, model, memory hooks | network, LLM, persistent storage, background recall | L |
| 5 | @plannotator/opencode (backnotprop) | 13,585 | 7,315 | EC, OD, AO, IM | Interactive plan review: browser annotation UI, strike/replace/comment on plans | session hooks, plan interception, tool | LLM/session access, local HTTP UI, filesystem | L |
| 6 | opencode-antigravity-auth (NoeFabris) | 11,073 | 5,327 | EC, AO, IM | Use Google Antigravity's free Gemini/Claude/GPT via IDE auth | provider.transform, auth | OAuth, network, token refresh, secrets | S |
| 7 | oh-my-opencode-slim (alvinunreal) | 10,292 | 8,737 | OD, IM | Slim fork of oh-my-opencode: subagents, LSP/AST tools, tmux, MCP | tool, agent, mcp | shell, subagents, LSP, tmux, background | L |
| 8 | opencode-dynamic-context-pruning (Tarquinen) | 4,508 | — (dcp) | EC, OD, AO | Prunes obsolete tool outputs from context before compaction | chat/session hooks (transform) | LLM/session access, context editing | M |
| 9 | opencode-openai-codex-auth (numman-ali) | 2,203 | 4,142 | EC | Use ChatGPT Plus/Pro subscription in opencode | provider.transform, auth | OAuth, network, token refresh | S |
| 10 | opencode-mem (tickernelz) | 1,880 | — | AO | Local vector-DB memory, auto-capture, web UI | tool, mcp | vector DB, embeddings, persistent storage, subprocess | L |
| 11 | opencode-gemini-auth (jenslys) | 1,776 | 5,681 | EC, AO | Google account auth for Gemini plan | provider.transform, auth | OAuth, network, token refresh | S |
| 12 | opencode-supermemory (supermemoryai) | 1,670 | 2,428 | EC, IM | Persistent memory via Supermemory service | tool, hooks | network/fetch, LLM | M |
| 13 | kimaki (remorses) | 1,452 | — | AO, OD | Discord bot to control opencode sessions (also a model-switch plugin) | SDK, server, webhook | network, LLM, background bot loop | L |
| 14 | caspian (TryCaspian) | 971 (caspian-sdk) | 50 (`caspian-opencode-plugin`) | AO | Inbox for agents (email/Telegram/Discord), slash commands, notifications | command, hooks, notifications | network, polling/websocket, notifications | M |
| 15 | opencode-notifier (mohak34) | 867 | — | EC | Desktop notifications + sound on permission/completion/error | event hooks | notifications, sound | S |
| 16 | agent-notifications (777genius) | 835 | — | IM, AO | Desktop + webhook notifications for session events | event hooks | network (webhook), notifications | S |
| 17 | opencode-pty (shekohex) | 613 | 4,002 | EC, IM | Background processes in a PTY with interactive input | tool | shell/PTY spawn, streaming | M |
| 18 | opencode-swarm (zaxbysauce) | 537 | — | AO, IM | Verification-gated swarm: architect, review, test, security agents | agent, command | subagents, git, persistence | L |
| 19 | opencode-scheduler (different-ai) | 520 | 3,385 | EC | Cron-syntax recurring jobs via launchd/systemd | tool, hooks | timers/background, system scheduler | M |
| 20 | micode (vtemian) | 513 | — | EC, AO | Brainstorm → plan → implement workflow, worktree isolation | agent, command, hooks | subagents, git worktree, AST tools | L |
| 21 | operator-memory (@aerovato) | — | — | AO, OD, IM | Durable Markdown memory (specs/decisions) across partitions | tool, hooks | filesystem, git, session access | M |
| 22 | opencode-goal-plugin (willytop8) | 289 | — | EC | Session-scoped `/goal` workflow that auto-continues | command, session hook | LLM/session access, loop | M |
| 23 | opencode-agent-memory (joshuadavidthomas) | 365 | — | AO | Letta-inspired persistent, self-editable memory blocks | tool, hook | persistent storage, session access | M |
| 24 | opencode-agent-skills (joshuadavidthomas) | 292 | — | AO | Dynamic skill discovery across project/user/plugin dirs | skill | filesystem (read/discover) | S |
| 25 | opencode-cursor (ephraimduncan) | 286 | 6 | AO | Cursor subscription models via OAuth + local proxy | provider.transform, auth | OAuth, network, local HTTP proxy | M |
| 26 | subtask2 (@openspoon) | 257 | 61 | EC | Extends `/commands` into granular orchestration | command, agent | session access, subagents | M |
| 27 | opencode-ensemble (hueyexe) | 264 | — | AO, IM | Parallel agent teams, peer messaging, worktrees, dashboard | agent, command, server | subagents, git worktree, live dashboard | L |
| 28 | opencode-websearch-cited (ghoulr) | 248 | 295 | EC | Native websearch with grounded citations | tool, provider | network/fetch | S |
| 29 | opencode-vibeguard (inkdust2021) | 220 | 1,554 | EC | Redact secrets/PII before LLM call, restore locally | chat/session hook (transform) | secrets, session/context editing | M |
| 30 | opencode-wakatime (angristan) | 205 | 656 | EC, AO | WakaTime activity tracking | event hooks | network/fetch, timers (heartbeat) | S |
| 31 | opencode-morph-fast-apply (JRedeker) | 170 | — | EC, AO | 10× code editing via Morph Fast Apply API, lazy markers | tool, hook | network/fetch, git/diff | M |
| 32 | opencode-snip (VincentHardouin) | 163 | 958 | AO | Prefix shell commands with `snip` to cut LLM-token use 60–90% | tool/shell hook | shell, context editing | S |
| 33 | opencode-plugin-otel (DEVtheOPS) | 156 | — | AO | OTLP/gRPC telemetry (metrics/logs/traces) to any backend | event hooks | network, streaming/export | M |
| 34 | opencode-conductor (derekbar90) | 134 | 514 | EC | Context → Spec → Plan → Implement workflow automation | agent, command | subagents, git, persistence | L |
| 35 | opencode-claude-code-plugin (khalilgharbaoui) | 134 | 20 | AO | Run Claude via the official `claude` CLI subprocess | provider, tool | process spawn, session/proxy | M |
| 36 | basemind (Goldziher) | 124 | 395 (`basemind-opencode`) | AO | MCP context layer: tree-sitter code-map, RAG, git history | mcp, tool | filesystem, embeddings, git, subprocess | L |
| 37 | opencode-firecrawl (firecrawl) | 103 | — (`opencode-firecrawl`) | EC | Web scraping/crawl/search via Firecrawl CLI | tool | subprocess, network | M |
| 38 | opencode-snippets (JosXa) | 93 | 2,816 | AO | Inline `#snippet` text expansion in the prompt | command/prompt hook, UI | prompt/composer UI, storage | S |
| 39 | opencode-morph-plugin (morphllm) | 91 | — | EC | Fast Apply editing, WarpGrep search, compaction | tool, hook | network/fetch, git | M |
| 40 | opencode-llm-proxy (KochC) | 91 | — | AO, IM | Local API gateway exposing OpenAI/Anthropic/Gemini endpoints | provider, server, tool | local HTTP server, streaming, process spawn | L |
| 41 | OpenCodeRAG (MrDoe) | 70 | — | AO | Local semantic code search: tree-sitter chunking + LanceDB | tool, chat.message | filesystem watch, embeddings, index, subprocess | L |
| 42 | opencode-zellij-namer (24601) | 66 | 35 | EC | Auto Zellij session naming from opencode context | session hook | shell (zellij control), session access | S |
| 43 | opencode-skills-tui (aihaipeng) | 54 | — | AO, IM | V2 sidebar browsing skills, SKILL.md previews | tui slots, data | UI slots, filesystem, reactive data | M |
| 44 | opencode-failover (bulutmuf) | 52 | — | AO | API-key rotation/quarantine across multiple keys | provider, tool | secrets, network, state | M |
| 45 | opencode-sentry-monitor (stolinski) | 51 | 352 | EC | Trace/debug agents with Sentry AI monitoring | event hooks | network/export, streaming | M |
| 46 | opencode-supabase (supabase-community) | 44 | 159 | EC | Login, Management API tools, bundled skills, MCP setup | tool, mcp, skill | OAuth, network, secrets | M |
| 47 | FlowDeck (DVNghiem) | 42 | — | AO | 25-agent workflow orchestration, SQLite memory, deep hooks | agent, command, hooks, mcp | subagents, SQLite, network, background | L |
| 48 | @telemetry-dev/opencode | 38 (telemetry-dev/telemetry) | — | AO | OpenTelemetry traces of agent turns/model calls/tools | event hooks | network/export, streaming | M |
| 49 | opencode-dir-tree-tui (aihaipeng) | 29 | 266 | AO, IM | V2 sidebar file tree with git status + actions | tui slots, data, keybinds | UI slots, filesystem, git | M |
| 50 | opencode-mission-control (nigel-dev) | 29 | — | AO, OD | Parallel agents in tmux worktrees, DAG plans, merge train | agent, command, server | tmux, git worktree, subagents, timers | L |
| 51 | opencode-agents-sidebar (Mark1708) | 23 | — | AO | Browse OhMyOpenAgent agents in the TUI sidebar | tui slots, data | UI slots, reactive data | S |
| 52 | opencode-usage-monitor (Mark1708) | — | — | AO | OpenAI & Z.AI quota usage in the TUI sidebar | tui slots, data, network | UI slots, network/fetch | M |
| 53 | opencode-helicone-session (H2Shami) | 15 | 92 | EC | Inject Helicone session headers for request grouping | provider/hook | network, config | S |
| 54 | opencode-tavily (tavily-ai) | 10 | 96 | EC | Web search/extraction via Tavily CLI | tool | subprocess, network | S |
| 55 | opencode-daytona (daytona) | 7 (daytona/integrations) | — | EC | Run opencode sessions in isolated Daytona sandboxes | tool, hooks | network, sandbox API, background sync | L |
| 56 | opencode-jfrog-plugin (jfrog) | 1 | — (`@jfrog/opencode-plugin`) | EC | JFrog platform integration | tool, mcp, auth | network, secrets | M |

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

## 4. The 10 most complex plugins (and why they are complex)

1. **oh-my-opencode / oh-my-opencode-slim** (70,997 ⭐ / 10,292 ⭐; 50,568 / 8,737 dl/wk). Background agents, pre-built
   LSP/AST/MCP tools, curated subagents, a Claude-Code-compat layer, tmux integration. Needs process spawn, subagent
   dispatch, long-running background agents, and streaming. **Reducer fit ✗** — this is exactly "long-lived, sequential,
   background" work the reducer explicitly does not support.

2. **ponytail** (194,586 ⭐). A huge multi-agent "senior-dev mode" harness whose opencode support is one target among
   several. Long-running orchestration loops, streaming, subagents. **✗** — background work + a live agent loop.

3. **mem0 / @mem0/opencode-plugin** (69,238 ⭐ repo). Persistent memory with 9 MCP tools, 16 slash commands and
   lifecycle hooks that auto-capture decisions, search prior context, pre-fetch error memories. **◐** — the hook
   endpoints are event-driven (fit), but the memory backend needs network/embeddings and durable storage outside the
   plugin state.

4. **context7** (65,108 ⭐ repo). Wires the Context7 MCP server plus a docs skill. **◐** — mostly declarative `mcp` +
   `skill` transforms (fit), but relies on a hosted MCP service over the network.

5. **openviking / Magpie** (42,466 ⭐). Repository retrieval + long-term memory with recall/capture and model switching,
   and automatic restart. **✗** — cross-session memory indexing, background recall, and process restart are not
   per-event pure functions.

6. **@plannotator/opencode** (13,585 ⭐; 7,315 dl/wk). Intercepts plan mode and opens a browser annotation UI; the user
   edits the plan and it is applied. **✗** — needs a long-lived local HTTP UI, plan-streaming, and a
   request/response round-trip that spans events (effectively a dialog outside the event loop).

7. **opencode-mission-control / opencode-ensemble** (29/264 ⭐). Orchestrate parallel agents in tmux-isolated git
   worktrees with DAG plans, merge trains, peer messaging, and live dashboards. **✗** — timers, process/tmux control,
   git-remote work, and long-running supervision.

8. **OpenCodeRAG** (70 ⭐). Tree-sitter AST chunking, LanceDB index, file-watch live re-indexing, Ollama/OpenAI
   embeddings, CLI + a chunk-retrieval tool. **✗** — filesystem watch, a native vector database, and background
   indexing are all outside the reducer's reach (also implies a native dependency: LanceDB/embeddings binaries).

9. **opencode-llm-proxy** (91 ⭐). Runs a local HTTP gateway serving OpenAI/Anthropic/Gemini-compatible endpoints over
   any configured opencode model, with streaming and parallel tool calls. **✗** — a long-running local server with
   streaming is the anti-reducer shape.

10. **FlowDeck** (42 ⭐). 25 specialist agents over a four-phase cycle, 24 skills, SQLite persistent memory, deep
    system hooks (context monitoring, idle summaries, shell-env injection), and ensemble `/fd-council`. **✗** —
    persistent SQLite state + multi-agent orchestration + idle/context monitoring require background work and large
    in-memory/serialized state.

Close seconds: `opencode-scheduler` (launchd/systemd timers — **needs timers/background**, ✗), `basemind` (tree-sitter
code-map + git history + embeddings, ✗), `deja-vu` (a local Go binary indexing other agents' transcripts, ✗ native
subprocess).

---

## 5. Reducer-model fit, summarized

Fits the reducer as-is (✓): declaritive transform providers — auth providers that only `provider.transform` + OAuth
are borderline (async token refresh); `figma`-style `mcp.transform` + `skill.transform`; simple notifiers and
web-search tools driven by a single event.

Mostly (◐): memory and telemetry plugins whose **hook endpoints** are event-driven but whose **backend** (embeddings,
vector DB, SQLite, remote export) lives outside plugin state.

Does not fit (✗), and what's missing:

- **Long-running background work / agents.** oh-my-opencode, swarm, ensemble, mission-control, FlowDeck, scheduler,
  kimaki, ponytail.
- **Streaming.** llm-proxy, otel/telemetry exporters, plannotator (plan stream), opencode-pty.
- **Timers / scheduling.** scheduler (launchd/systemd), wakatime heartbeats, token-refresh jobs.
- **Subscriptions / long-lived listeners.** `session.hook("experimental.idle")`, watch-based indexers.
- **Large in-memory or native state.** vector DBs (opencode-mem, OpenCodeRAG, mem0), SQLite (FlowDeck, telemetry).
- **Native / subprocess dependencies.** tree-sitter + LanceDB + embeddings, the `claude`/`firecrawl`/`tavily` CLIs,
  local Go binaries (deja-vu), local proxies (cursor, llm-proxy, antigravity bridge).

These missing pieces map one-for-one onto the gaps the protoype REPORT.md flags (long-lived runs unviable today, no
compute/memory budget, no GC, no interrupt handle).

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
