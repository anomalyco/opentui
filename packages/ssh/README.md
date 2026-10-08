# @opentui/ssh

Serve OpenTUI apps over SSH.

`@opentui/ssh` gives each incoming SSH shell its own OpenTUI
[`CliRenderer`](../core). The renderer reads input from the SSH channel, writes
output to it, and tracks the size of the client's PTY. You choose what to render.
The package depends only on `@opentui/core`, not on `@opentui/react` or
`@opentui/solid`, so the same server works with all three.

```ts
import { createServer } from "@opentui/ssh"
import { BoxRenderable, TextRenderable } from "@opentui/core"

const server = createServer({
  hostKey: { path: "./host_key" }, // auto-generated & persisted on first run
  auth: { publicKey: "any" }, // accepts any verified key, so every client gets an identity
}).serve((session) => {
  const { renderer, identity } = session
  const box = new BoxRenderable(renderer, { width: "100%", height: "100%", border: true })
  box.add(new TextRenderable(renderer, { content: `Hello, ${identity.username}!` }))
  renderer.root.add(box)
  // the server destroys the renderer when the session closes. Use onClose only for your own cleanup.
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

`@opentui/core` is a peer dependency. Supported runtimes are Bun ≥ 1.3.14 and
Node.js ≥ 26.4.0. CI runs the SSH integration suite with Bun on macOS, Linux,
and Windows. CI also installs the packed ESM packages and runs a real renderer
session with Node.js and Bun. Start Node applications that create renderers
with `node --experimental-ffi server.mjs`.

Use Bun ≥ 1.4.0 on native Windows arm64.

## The shape: `createServer(config).serve(handler)`

Static setup goes in the `createServer({...})` config object. Add cross-cutting
concerns with `.use()`. **`serve(handler)` seals the chain with the per-session
handler and returns a startable server.** The handler goes on `serve()`, not in
the config. This lets the builder collect the typed `context` that each `use()`
adds and pass it to the handler. A server without a handler is a compile error,
because the builder has no `listen()` until you call `serve()`.

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
on all interfaces, which is common in containers. With no auth, listening on a
host other than `localhost`, `127.0.0.1`, or `::1` logs a warning. It does not
throw, because an intentionally exposed TUI is valid.

### `Session`

The handler you pass to `serve()` receives a `Session` with the live `renderer`.
Middleware receives a `MiddlewareSession` **without** `renderer`. The server
creates the renderer only after the chain authorizes the session, so a gating
middleware that declines never creates one. Everything else is shared:

| Field           | What it is                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `renderer`      | A `CliRenderer` bound to this SSH channel, sized to the client PTY. **Handler-only.** A middleware's `MiddlewareSession` does not have it. The server destroys it when the session closes. |
| `identity`      | Who connected and how, **narrowed to your configured auth** (see below).                                                                                                                   |
| `context`       | Per-session object with the typed fields that upstream middleware added with `next({...})`. It is `{}` with no middleware.                                                                 |
| `term`          | The client's `TERM` (for example `"xterm-256color"`).                                                                                                                                      |
| `cols` / `rows` | Current terminal size. See [Native transport](#native-transport) for resize timing.                                                                                                        |
| `hasPty`        | Whether the client requested a PTY. Use it for `requirePty`-style middleware.                                                                                                              |
| `remoteAddress` | `{ address, port? }` client socket endpoint for logging, rate limiting, and policy.                                                                                                        |
| `onResize(cb)`  | Runs after the renderer accepts a new client size.                                                                                                                                         |
| `onClose(cb)`   | Runs once when the session closes for any reason. Do your own per-session cleanup here. The server destroys the renderer for you.                                                          |
| `write(data)`   | Sends raw bytes to the client without the renderer's frame diffing. Use it for terminal control that the renderer does not model (OSC 52 clipboard, window title, a bell).                 |
| `end()`         | Closes only this session.                                                                                                                                                                  |

### Native transport

Every shell uses Core's native scene and bounded Session output. Core, React, and
Solid applications use the same renderer attached to the SSH session.

```ts
createServer({}).serve((session) => {
  session.renderer.root.add(
    new TextRenderable(session.renderer, {
      content: "Native SSH",
    }),
  )
})
```

Each shell gets one Core native Session before middleware runs. Middleware
output, terminal setup, frames, raw writes, and restoration share its ordered
output budget. Core's Session driver writes to the SSH channel itself. It counts
bytes as delivered when each write callback runs, not on `drain`. SSH adds no
second output queue or wrapper stream. Core's production limits allow 8 MiB of retained output and
reserve one 64 KiB chunk of it for terminal control and restoration. One raw
write can therefore be at most 8,323,072 bytes (127 × 64 KiB) when nothing else
is queued. Queued and unacknowledged bytes count against the limit.

`session.write()` is synchronous and returns `void`. If the output is temporarily
full, it throws `OutputPressureError` with code `"OUTPUT_PRESSURE"`, and the call
accepts no bytes. A single write larger than the Session limit throws `RangeError`
before string encoding. SSH does not queue, drop, or replay rejected writes.
Writes after the session closes do nothing. `deny(reason)` always closes the
session and throws `DenyError`, even when it cannot write the reason. The write
error goes to `onError`. Denial never creates a renderer.

Before the renderer attaches, `cols` and `rows` track the requested PTY size.
After it attaches, Core combines window changes while output is pending. The
session dimensions and `onResize` report only the size Core accepts, and the
renderer is already resized.

`end()` and `onClose` mark the logical close, not completed terminal restoration.
Before the renderer attaches, SSH waits for the Session to close before it closes
the channel. After the renderer attaches, SSH waits for `renderer.closed`. Core
allows one second for that output after the close starts. If output fails or the
time expires, the error goes to `onError`, Core cancels pending output without
restoration, and `renderer.closed` rejects. `server.close()` closes every live
session this way. Connection loss and peer shell close cancel the Session at once,
including during middleware. Cleanup does not wait for the ssh2 channel `close`
event, which unread input can delay.

## The three hand-offs

The package gives you a `CliRenderer`. You mount any front-end on
`session.renderer`. Runnable versions of all three are in
[`examples/`](./examples).

### Imperative (`@opentui/core`)

```ts
createServer().serve((session) => {
  const box = new BoxRenderable(session.renderer, { border: true })
  session.renderer.root.add(box)
  // no teardown to wire: the server destroys the renderer when the session closes
})
```

### React (`@opentui/react`)

`createRoot` adopts the existing renderer as it is. See
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
renderer you pass. The app draws onto the SSH channel, not the host terminal.
See [`examples/solid.tsx`](./examples/solid.tsx).

```tsx
import { render } from "@opentui/solid"

createServer().serve(async (session) => {
  // Solid disposes its root when the renderer is destroyed, so there is nothing to wire.
  await render(() => <App name={session.identity.username} />, session.renderer)
})
```

> `@opentui/react` and `@opentui/solid` are **not** runtime dependencies of this
> package. The framework examples use workspace dev dependencies only to show
> the hand-off. Run the Solid example with
> `bun run packages/ssh/examples/solid.tsx`. Its launcher registers the required
> JSX transform before it loads the app.

## Auth & type-flowing identity

`createServer` infers the identity type from your `auth` config.
`session.identity` covers only the methods you enabled, so you can read only the
fields you required. `auth` is optional and defaults to `"open"` (no auth), so
the getting-started snippet works on localhost.

```ts
// publickey-only → fingerprint is guaranteed present
createServer({ auth: { publicKey: "any" } }).serve((s) => s.identity.fingerprint) // ✅ string, no null check

// publickey + password → a union; discriminate on .method
createServer({ auth: { publicKey: "any", password: checkPw } }).serve((s) => {
  if (s.identity.method === "publickey") s.identity.fingerprint // ✅ narrowed
})
```

Supported methods (you can combine them, and the server advertises exactly what
you configure):

| Config                                            | Behavior                                                                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `auth: "open"` (or omit)                          | Allow unauthenticated access. This is the default. Listening on a non-loopback host with it logs a warning.                        |
| `publicKey: "any"`                                | Accept **and identify** any key. The server verifies the signature (proof of possession), then sets `identity.fingerprint`.        |
| `publicKey: { allow: (ctx) => boolean }`          | Your own allow/deny over `{ username, fingerprint, publicKey }`. It runs after the signature verifies.                             |
| `publicKey: { authorizedKeys: path \| string[] }` | Allowlist from plain public-key lines. Blank lines and `#` comments are allowed. A line with OpenSSH options throws `ConfigError`. |
| `publicKey: { authorizedKeys, allow }`            | Both. Admit the key if it is on the allowlist **or** `allow` returns true.                                                         |
| `password: (ctx) => boolean`                      | Password check over `{ username, password }`.                                                                                      |
| `keyboardInteractive: (ctx) => boolean`           | Prompt/response flow.                                                                                                              |

> `@opentui/ssh` verifies public-key signatures itself, because `ssh2` does not.
> So `publicKey: "any"` proves possession of the private key instead of trusting
> a claimed key.

For a restricted public-key server, see [`examples/authorized-keys.ts`](./examples/authorized-keys.ts).

## Middleware (`.use()`)

`.use()` wraps your handler with cross-cutting concerns: gating, enrichment, and
logging. Each middleware is one layer of an onion: `(session, next) => Handoff`.
Call `next()` to continue, or `next({ ... })` to add typed fields to
`session.context`. **Return that hand-off.** If you forget, it is a compile error.
To gate, call `session.deny(reason)`. It throws to unwind the chain, so you do
not return it.

1. **Registration order is execution order.** The _first_-registered middleware
   is the _outermost_ link.
2. **`await next()` resolves when the session ends.** The handler is the innermost
   link. The server wraps it so that it does not resolve until the session closes.
   So the `finally` block in `try { return await next() } finally { ... }` runs
   as teardown.
3. **Contributions are inferred.** `next({ tier: "free" })` widens
   `session.context` by `{ tier: string }` with no generic to declare. Each `.use`
   adds to the type, so a later link reads earlier links' typed fields and the
   handler reads all of them.

```ts
import { createServer, type Middleware } from "@opentui/ssh"

// SETUP/TEARDOWN — author a reusable middleware by typing it as `Middleware`. Before
// next() is setup; the finally (after next() resolves when the session closes) is teardown.
const logging: Middleware = async (session, next) => {
  const start = Date.now()
  try {
    return await next() // resolves when the session closes
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

Those three patterns (**setup/teardown**, **gate**, and **enrich**) cover almost
every case. Inline arrows need no annotation, because their `identity` and
`context` types come from the builder. To name and reuse one, type it as
`Middleware`, or as `MiddlewareFunction` when it must read upstream context.

A gating middleware's `deny()` runs before the handler, so the handler never runs
**and the server never creates the renderer**. If the server can write the reason,
it appears on the main screen, and the alternate screen is never entered. If the
write fails, `deny()` still closes the session and throws `DenyError`.
Middleware sees a `MiddlewareSession` without the renderer. Only the handler's
`Session` has it. See [`examples/middleware.ts`](./examples/middleware.ts).

### Built-in: `logging`

`@opentui/ssh` includes one ready-made middleware. `logging()` is a
setup/teardown link. It emits a `connect` event on entry and a `disconnect` event
(with duration) on teardown. It **only observes**. It never reports errors, so
`onError` stays the single error sink. A throwing handler is logged as a normal
disconnect _and_ still goes to `onError`.

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

The first run with a `path` generates and saves an ed25519 key. `listen()` prints
its fingerprint so clients can verify it. When you pass several PEMs, `listen()`
returns and prints every fingerprint in the same order.

## Lifecycle, errors & shutdown

By default, the server allows one shell session per SSH connection and 100
across the server. It rejects excess shell requests without closing the SSH
connection or reporting an error. Adjust both positive-integer limits when an
application needs more concurrency:

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

A shell counts from the time the server accepts it, before middleware runs. It
keeps its slot until the server closes its SSH channel. These limits bound
application renderers. They do not replace authentication, network access
controls, connection-rate limiting, or process resource limits.

There is no lifecycle event bus and no pluggable logger. The work splits by
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

- **The handler and `session.onClose`** are the per-session lifecycle. Set up on
  entry, and tear down when the session closes. Put anything reusable or
  cross-cutting in a middleware.
- **`onError(err)`** is the runtime error sink. Contained application and
  transport errors go here: a throwing handler or middleware, a throwing
  `onResize` or `onClose`, a throwing auth predicate, Session output failures,
  and connection-level and server-level `ssh2` errors. It defaults to
  `console.error`. It _reports_ errors. To react to a session, use middleware or
  `onClose`. To observe the lifecycle, use the `logging` middleware. A bind
  failure rejects `listen()` instead of going here. The logger ignores its own
  sink failures, so logging cannot affect a session.
- **`idleTimeout`** closes a session after that long with **no client input**.
  Any client input restarts the timer. Only the idle session closes. Other sessions
  and the listener continue. Durations must be between `1ms` and `24h`.
- **`maxTimeout`** closes a session after that absolute lifetime, even when the
  client keeps sending input. Durations must be between `1ms` and `24h`.
- **`listen()`** binds, prints the startup banner (URL, host-key fingerprints,
  auth methods, allowlist fingerprints) to stdout unless `startupBanner: false`,
  and returns `{ host, port, fingerprints }`.
- **`close()`** rejects new shell requests and closes every live session, which
  destroys its renderer. Then it ends every client connection and closes the
  listener.

```
@opentui/ssh  ▸  ssh://localhost:2222
host key      SHA256:nThbg6kX…0bGQ  (ssh-ed25519, generated ./host_key)
auth          publickey, password
authorized    2 keys  ·  SHA256:abc… SHA256:def…
```

## License

MIT
