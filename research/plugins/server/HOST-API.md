# Server host API — functions, events, return shapes

**The server part.** The OpenCode server stays in TypeScript for now; this is the model/agent-side surface the 38
server-relevant plugins in `./TOP100.md` (27 Server + 11 Both) need. The TUI keeps the full UI detail in
`../tui/HOST-API.md`; this file carries only the server half. Function names match the "Host fns (server)" column of
`./TOP100.md`.

**Side:** `Server` = server-only · `Both` = shared seam (TUI use is in the TUI file). **n/38** = how many of the 38
server-relevant plugins call it. **Class:** `read` / `write` / `exec` / `network` / `secret`.

## 1. Server function catalogue

### `llm` — model / provider / generation

| Function | Signature | Side | Kind | Need | Class | Rust host notes (server stays TS) |
|---|---|---|---|---|---|---|
| `llm.generate` | `llm.generate(prompt, {model?, stream?}) → text \| chunk stream` | Server | async | 3 | read | provider route; streamed tokens → `chunk` events |
| `llm.model` | `llm.model(providerId, modelId) → ()` | Server | async | 3 | write | switch active model / get credentials |
| `llm.provider` | `llm.provider(op{register,header,proxy,url}, cfg) → ()` | Server | async | 6 | secret | register a custom provider / inject headers / route via proxy |

### `mcp` — model-context-protocol servers

| Function | Signature | Side | Kind | Need | Class | Rust host notes |
|---|---|---|---|---|---|---|
| `mcp.register` | `mcp.register(server, {command\|url, auth?}) → handle` | Server | durable | 3 | exec+network | spawn/connect an MCP server (stdio/SSE) |
| `mcp.call` | `mcp.call(server, tool, args) → result` | Server | async | 2 | read | JSON-RPC tool call |

### `session` — server-side session lifecycle

| Function | Signature | Side | Kind | Need | Class | Rust host notes |
|---|---|---|---|---|---|---|
| `session.start` | `session.start(prompt, {subagent?, model?, tools?}) → id` | Server | durable | 15 | exec | spawn a (sub)agent session; completion arrives as an event |
| `session.inject` | `session.inject(id, context) → ()` | Server | async | 15 | write | append/transform the session context (memory, gates, redaction) |
| `session.list` | `session.list() → {id, title, cost}[]` | Both | async | 4 | read | session directory (client sidebar reads it through this) |

### `net` — server-side network

| Function | Signature | Side | Kind | Need | Class | Rust host notes |
|---|---|---|---|---|---|---|
| `net.request` | `net.request({url, method, headers, body}) → resp` | Both | async | 15 | network | auth/telemetry/OTLP/inbox (shared `reqwest` client) |
| `net.search` | `net.search(query, {provider?}) → {results, citations}` | Server | async | 2 | network | host-held search-key wrapper |
| `net.subscribe` | `net.subscribe(url, {mode: ws\|poll}) → event stream` | Both | durable | 3 | network | bot/inbox polling → inbound events |
| `net.listen` | `net.listen({port?, routes}) → {port}` | Both | durable | 2 | network | local proxy gateway process |

### `shell` — server process spawn

| Function | Signature | Side | Kind | Need | Class | Rust host notes |
|---|---|---|---|---|---|---|
| `shell.run` | `shell.run(cmd, {cwd, env, input?}) → {code, stdout, stderr}` | Both | async | 3 | exec | spawn MCP/agent CLIs (`claude`, `snip`, firecrawl) |

### `git` — server-side worktree orchestration

| Function | Signature | Side | Kind | Need | Class | Rust host notes |
|---|---|---|---|---|---|---|
| `git.apply` | `git.apply(op{worktree,branch,checkout}, args) → {}` | Both | async | 5 | write+exec | create/checkout worktrees for parallel agents |

### `store` — server-side durable state

| Function | Signature | Side | Kind | Need | Class | Rust host notes |
|---|---|---|---|---|---|---|
| `store.get` / `store.set` | `store.get(key) → value` · `store.set(key, value) → ()` | Both | durable | 15 | read+write | tokens, counters, locks (shared with the client) |

### `timer` — host-owned scheduling

| Function | Signature | Side | Kind | Need | Class | Rust host notes |
|---|---|---|---|---|---|---|
| `timer.every` | `timer.every(ms, event) → handle` | Both | durable | 3 | read | scheduler/wakatime cadence |
| `timer.after` | `timer.after(ms, event) → handle` | Both | durable | 1 | read | follow-up events the reducer schedules |

---

## 2. Server events

| Event | Payload | Fired on | Plugins |
|---|---|---|---|
| `init` | `{reload?}` | load / reload | 38 (all) |
| `chat.message` | `{role, text, id}` | a message is added to a session | ~16 |
| `session.start` / `session.idle` / `session.complete` / `session.end` / `session.error` | `{id, …}` | session lifecycle | ~14 |
| `tool.execute.before` / `tool.execute.after` | `{tool, args, output}` | a model tool runs | ~6 |
| `provider.request` / `provider.response` | `{provider, request, response}` | before/after a model call | ~6 |
| `usage` | `{tokens, cost, provider}` | usage increments | ~5 |
| `permission-request` | `{action, resource}` | an approval is requested | ~4 |
| `plan.created` (stream) | `{plan}` | plan mode enters | ~2 |
| `location.sync` | `{}` | project/workspace changes | ~3 |
| `message` (webhook/inbox) | `{source, text}` | bot/inbox inbound | ~3 |
| `job.due` | `{job}` | `timer.every` schedule fires | ~2 |
| `chunk` (stream bridge) | `{streamId, delta, done}` | partial results (LLM/streams) | ~5 |

## 3. Server return shapes (no UI)

The server reducer returns `{ state, … }` plus one of the server-side extension shapes — **not** `slots`:

- `tools` / `slash` — registered model tools or slash commands the agent can invoke.
- `inject` — context appended/transformed into the session.
- `permit` / `deny` — a gate decision the host honors for the intercepted op.
- `result` — `{ output, content }` returned as a tool result.
- `—` — nothing (side-effecting reducers like notifier/telemetry).

## 4. Blockers (server side)

The server owns the two remaining blockers: **background work** (subagent loops, bots/inbox, recall/restart — removed
by durable `session.start`/`net.subscribe`/`timer.every` that run between events) and **streaming** (LLM/MCP/plan
streams — removed by the `chunk`-event bridge). **Native deps** and **large-state** on the server (vector DBs,
tree-sitter, SQLite) are host-side resources the reducer only references via `session.inject` + `store.*`. The TUI's
blockers summary is in `../tui/HOST-API.md`.
