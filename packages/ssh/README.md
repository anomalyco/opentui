# @opentui/ssh

Serve OpenTUI apps over SSH.

`@opentui/ssh` turns an incoming SSH session into a fully-wired OpenTUI
[`CliRenderer`](../core) whose input/output is the SSH channel and whose
dimensions track the client's PTY. What you render onto it is up to you — the
package is **renderer-agnostic**: it depends only on `@opentui/core`, never on
`@opentui/react` or `@opentui/solid`, so the same server works with all three.

```ts
import { createServer } from "@opentui/ssh"
import { BoxRenderable, TextRenderable } from "@opentui/core"

const server = createServer({
  hostKey: { path: "./host_key" }, // auto-generated & persisted on first run
  auth: { publicKey: "any" }, // open, but every client gets an identity
}).serve((session) => {
  const { renderer, identity } = session
  const box = new BoxRenderable(renderer, { width: "100%", height: "100%", border: true })
  box.add(new TextRenderable(renderer, { content: `Hello, ${identity.username}!` }))
  renderer.root.add(box)
  // the renderer is destroyed for you on disconnect — wire onClose only for your own cleanup
})

await server.listen(2222)
```

```
ssh -p 2222 localhost
```

## Install

```sh
bun add @opentui/ssh
# or
npm install @opentui/ssh
```

`@opentui/core` is a peer dependency. Supported runtimes are Bun ≥ 1.3.0 and
Node.js 26.3.0. CI runs the SSH integration suite with Bun on macOS, Linux,
and Windows, and installs, imports, starts, and closes the packed ESM package
with Node.js 26.3.0.

## The shape: `createServer(config).serve(handler)`

Static setup goes in the `createServer({...})` config object; cross-cutting
concerns are layered on with `.use()`; **`serve(handler)` seals the chain with
the per-session handler and returns a startable server.** The handler lives on
`serve()` — not the config — so the builder accumulates the typed `context` each
`use()` contributes and flows it into the handler, and a handler-less server is a
compile error (the builder has no `listen()` until you `serve`).

```ts
const server = createServer({
  // optional, all with sensible defaults:
  // auth, hostKey, idleTimeout, maxTimeout, limits, startupBanner, onError
})
  .use(logging()) // optional middleware (see "Middleware" below)
  .serve((session) => {
    /* mount your app on session.renderer — REQUIRED */
  })

await server.listen() // defaults to port 2222 on 127.0.0.1; pass (port, host) to change
```

`listen(port = 2222, host = "127.0.0.1")` returns `{ host, port, fingerprints }`.
Pass `0` for an ephemeral port. Pass a host like `"0.0.0.0"` or `"::"` to listen
on all interfaces, which is common in containers. Listening on a host other than
`localhost`, `127.0.0.1`, or `::1` with no auth logs a warning (it never throws — an
intentionally exposed TUI is legitimate).

### `Session`

The handler you pass to `serve()` receives a `Session` with
the live `renderer`. Middleware receive a `MiddlewareSession` **without** `renderer`
(it's the app's resource, created only once the chain authorizes the session — so
a gating middleware that declines never spins one up). Everything else is shared:

| Field           | What it is                                                                                                                                                                                                                                   |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renderer`      | A `CliRenderer` bound to this SSH channel, sized to the client PTY. **Handler-only** — present on the handler's `Session`, absent on a middleware's `MiddlewareSession` (a middleware must `next()` first). Destroyed for you on disconnect. |
| `identity`      | Who connected and how — **narrowed to your configured auth** (see below).                                                                                                                                                                    |
| `context`       | Per-session bag of the typed fields upstream middleware contributed via `next({...})`; `{}` with no middleware.                                                                                                                              |
| `term`          | The client's `TERM` (e.g. `"xterm-256color"`).                                                                                                                                                                                               |
| `cols` / `rows` | Current terminal size; updated on resize.                                                                                                                                                                                                    |
| `hasPty`        | Whether the client requested a PTY; use it for `requirePty`-style middleware.                                                                                                                                                                |
| `remoteAddress` | `{ address, port }` client socket endpoint for logging, rate limiting, and policy.                                                                                                                                                           |
| `onResize(cb)`  | Fires on client resize; the renderer is already resized for you.                                                                                                                                                                             |
| `onClose(cb)`   | Fires when the client disconnects; do your OWN per-session cleanup here (the renderer is torn down for you).                                                                                                                                 |
| `write(data)`   | Raw bytes straight to the client, bypassing the renderer's frame diffing — the escape hatch for terminal control the renderer doesn't model (OSC 52 clipboard, window title, a bell).                                                        |
| `end()`         | Force-close just this session.                                                                                                                                                                                                               |

## The three hand-offs

Because the package's job ends at producing a `CliRenderer`, you mount whatever
front-end you like onto `session.renderer`. Runnable versions of all three live
in [`examples/`](./examples).

### Imperative (`@opentui/core`)

```ts
createServer().serve((session) => {
  const box = new BoxRenderable(session.renderer, { border: true })
  session.renderer.root.add(box)
  // no teardown to wire — the renderer is destroyed for you on disconnect
})
```

### React (`@opentui/react`)

`createRoot` adopts the existing renderer as-is — see
[`examples/react.tsx`](./examples/react.tsx).

```tsx
import { createRoot } from "@opentui/react"

createServer().serve((session) => {
  const root = createRoot(session.renderer)
  root.render(<App name={session.identity.username} />)
  session.onClose(() => root.unmount()) // your own teardown
})
```

### Solid (`@opentui/solid`)

`render(node, renderer)` checks `instanceof CliRenderer` and **adopts** the
renderer you pass — so the app draws onto the SSH channel, not the host terminal.
See [`examples/solid.tsx`](./examples/solid.tsx).

```tsx
import { render } from "@opentui/solid"

createServer().serve(async (session) => {
  // Solid disposes its root when the renderer is destroyed — nothing to wire.
  await render(() => <App name={session.identity.username} />, session.renderer)
})
```

> `@opentui/react` / `@opentui/solid` are **not** runtime dependencies of this
> package — the framework examples use workspace dev dependencies only to
> demonstrate the hand-off. Run the Solid example with
> `bun run packages/ssh/examples/solid.tsx`; its launcher registers the required
> JSX transform before loading the app.

## Auth & type-flowing identity

`createServer` infers the identity type from your `auth` config, so
`session.identity` is narrowed to exactly the methods you enabled — you can only
read a field you actually required. `auth` is optional and defaults to `"open"`
(no auth), so the getting-started snippet just works on localhost.

```ts
// publickey-only → fingerprint is guaranteed present
createServer({ auth: { publicKey: "any" } }).serve((s) => s.identity.fingerprint) // ✅ string, no null check

// publickey + password → a union; discriminate on .method
createServer({ auth: { publicKey: "any", password: checkPw } }).serve((s) => {
  if (s.identity.method === "publickey") s.identity.fingerprint // ✅ narrowed
})
```

Supported methods (mix freely; the server advertises exactly what you configure):

| Config                                            | Behavior                                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `auth: "open"` (or omit)                          | Allow unauthenticated access. The default when `auth` is omitted; listening on `0.0.0.0`/`::` with it warns.          |
| `publicKey: "any"`                                | Accept **and identify** any key. The signature is verified (proof of possession), then `identity.fingerprint` is set. |
| `publicKey: { allow: (ctx) => boolean }`          | Your own allow/deny over `{ username, fingerprint, publicKey }`, run after the signature verifies.                    |
| `publicKey: { authorizedKeys: path \| string[] }` | Allowlist from plain public-key lines; blanks/comments allowed, OpenSSH options are not interpreted.                  |
| `publicKey: { authorizedKeys, allow }`            | Both — OR-merged: admit if on the allowlist **or** `allow` returns true.                                              |
| `password: (ctx) => boolean`                      | Password check over `{ username, password }`.                                                                         |
| `keyboardInteractive: (ctx) => boolean`           | Prompt/response flow.                                                                                                 |

> Publickey auth is verified end-to-end: `@opentui/ssh` checks the client's
> signature itself (`ssh2` does not), so `publicKey: "any"` proves possession of
> the private key rather than trusting a claimed key.

For a restricted public-key server, see [`examples/authorized-keys.ts`](./examples/authorized-keys.ts).

## Middleware (`.use()`)

`.use()` wraps your handler with cross-cutting concerns — gating, enrichment,
logging. A middleware is an onion: `(session, next) => Handoff`. Call `next()` to
continue (or `next({ ... })` to contribute typed fields to `session.context`) and
**return that hand-off** — forgetting to is a compile error. To gate, call
`session.deny(reason)`, which throws to unwind the chain (you needn't return it).

1. **Registration order === execution order.** The _first_-registered middleware
   is the _outermost_ link.
2. **`await next()` resolves when the session ends.** The handler is the innermost
   link, wrapped so it doesn't resolve until disconnect — so a `try { return await
next() } finally { ... }` runs its cleanup as teardown.
3. **Contributions are inferred.** `next({ tier: "free" })` widens
   `session.context` by `{ tier: string }` with no generic to declare; each `.use`
   accumulates, so a later link reads earlier links' fields typed and the handler
   reads the sum.

```ts
import { createServer, type Middleware } from "@opentui/ssh"

// SETUP/TEARDOWN — author a reusable middleware by typing it as `Middleware`. Before
// next() is setup; the finally (after next() resolves at disconnect) is teardown.
const logging: Middleware = async (session, next) => {
  const start = Date.now()
  try {
    return await next() // resolves at disconnect, to the accumulated context
  } finally {
    console.log(`${session.identity.username} stayed ${Date.now() - start}ms`)
  }
}

createServer({ auth: "open" })
  .use(logging)
  // GATE — deny() throws to bounce; otherwise continue with next().
  .use((s, next) => {
    if (s.identity.username === "banned") s.deny("no entry")
    return next()
  })
  // ENRICH — next({...}) contributes typed context the handler reads.
  .use((_s, next) => next({ tier: "free" as const }))
  .serve((s) => {
    s.context.tier // "free" — typed, no cast
  })
```

Those three patterns — **setup/teardown**, **gate**, **enrich** — cover almost
everything. Inline arrows need no annotation (their `identity`/`context` flow from
the builder); to name and reuse one, type it as `Middleware` (or
`MiddlewareFunction` when it must read upstream context). A gating
middleware's `deny()` runs before the handler, so the handler never runs **and the
renderer is never created** — the reason lands on the main screen and persists,
exactly what a rejection wants. (The renderer is the app's resource: middleware
see a `MiddlewareSession` without it; only the handler's `Session` has it.) See
[`examples/middleware.ts`](./examples/middleware.ts).

### Built-in: `logging`

`@opentui/ssh` ships one ready-made middleware. `logging()` is a setup/teardown
link that emits a `connect` event on entry and a `disconnect` (with duration) on
teardown. It is **pure observability** — it never reports errors, so `onError`
stays the single error sink; a throwing handler is logged as a normal disconnect
_and_ still flows to `onError`.

```ts
import { createServer, logging } from "@opentui/ssh"

createServer({ auth: { publicKey: "any" } })
  .use(logging()) // one line per event to console.log…
  .use(logging({ log: (e) => metrics.record(e) })) // …or a structured sink
  .serve((s) => mountApp(s.renderer))
```

The `log` sink receives a `LogEvent` (`type`, `identity`, `remoteAddress`, `term`,
`cols`/`rows`, and `durationMs` on disconnect). Omit it for a one-line default.

## Host key

```ts
hostKey: {
  path: "./host_key"
} // load if present; else generate ed25519 & persist (0600)
hostKey: {
  pem: "..."
} // provide PEM directly
// omit entirely → ephemeral key, regenerated each start (fine for dev)
```

The first run with a `path` generates and saves an ed25519 key; `listen()` prints
its fingerprint so clients can verify it. When multiple PEMs are provided, every
fingerprint is returned and printed in the same order.

## Lifecycle, errors & shutdown

Renderer-backed shell sessions are bounded by default to one per SSH connection
and 100 across the server. Excess shell requests are rejected without closing the
SSH connection or reporting an error. Adjust both positive-integer limits when an
application intentionally needs more concurrency:

```ts
const server = createServer({
  limits: {
    session: {
      perConnection: 2,
      global: 200,
    },
  },
}).serve(handler)
```

Capacity remains reserved until the shell transport finishes teardown. These
limits bound application renderers; they do not replace authentication, network
access controls, connection-rate limiting, or process resource limits.

There is no lifecycle event bus and no pluggable logger — the work splits by
**verb**, with no overlap:

- **react** to a session → middleware + `session.onClose` (deny, enrich, tear down)
- **observe** the connection lifecycle → the `logging` middleware (connect/disconnect/duration)
- **report** an error → `onError`, the single error sink

```ts
let live = 0 // server-wide aggregate is just a counter

const server = createServer({
  auth: "open",
  idleTimeout: "10m", // reap a session after no client input ("30s", "500ms", or ms)
  maxTimeout: "1h", // absolute session lifetime, regardless of activity
  startupBanner: true, // set false to silence listen()'s summary
  onError: (err) => console.error(err), // the one error sink; this is the default
}).serve((session) => {
  live++
  session.onClose(() => {
    live-- // your own per-session bookkeeping (the renderer is torn down for you)
  })
})
```

- **the handler + `session.onClose`** are the per-session lifecycle: set up on
  entry, tear down on disconnect. Anything reusable/cross-cutting is a middleware.
- **`onError(err)`** is the runtime error sink. Contained application and transport errors land here —
  a throwing handler/middleware, a throwing `onResize`/`onClose`, a throwing auth
  predicate, connection- and server-level `ssh2` errors. Defaults to
  `console.error`. It is _reporting_, not reacting — to react to a session, use
  middleware / `onClose`; to observe lifecycle, use the `logging` middleware. (A
  bind failure rejects `listen()` rather than coming here; logging sink failures
  are isolated and ignored so observability cannot affect a session.)
- **`idleTimeout`** reaps a session after that long with **no client input**
  (re-armed on every keystroke). Per-session: only the idle session is dropped;
  active sessions and the listener are untouched. Durations must be between `1ms`
  and `24h`.
- **`maxTimeout`** reaps a session after that absolute lifetime, even when the
  client keeps sending input. Durations must be between `1ms` and `24h`.
- **`listen()`** binds, prints the startup banner (URL, host-key fingerprints,
  auth methods, allowlist fingerprints) to stdout unless `startupBanner: false`,
  and returns `{ host, port, fingerprints }`.
- **`close()`** stops accepting, destroys live renderers, and closes the listener
  — a graceful, global shutdown.

```
@opentui/ssh  ▸  ssh://localhost:2222
host key      SHA256:nThbg6kX…0bGQ  (ssh-ed25519, generated ./host_key)
auth          publickey, password
authorized    2 keys  ·  SHA256:abc… SHA256:def…
```

## License

MIT
