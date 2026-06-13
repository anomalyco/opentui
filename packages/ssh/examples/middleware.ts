/**
 * Middleware example: cross-cutting concerns via the `.use(...)` onion.
 *
 *   bun run packages/ssh/examples/middleware.ts
 *
 * Connect with any key; it is accepted and identified by fingerprint:
 *
 *   ssh -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
 *       -i ~/.ssh/id_ed25519 you@localhost
 *
 * The box prints your fingerprint and role, both decided by that
 * cryptographically-verified principal — never the username.
 *
 * Security note: under `publicKey: "any"`, the username is whatever the client
 * typed and is not bound to the key, so this example authorizes on
 * `identity.fingerprint`. Copy your printed fingerprint into `ADMINS` or
 * `BLOCKED` below to see the gate/role change. To reject unknown keys before any
 * session, use auth-time `auth.publicKey: { allow }` or `{ authorizedKeys }`;
 * the middleware here is the SESSION-layer policy that runs after a key is
 * identified.
 *
 * Three `.use(mw)` patterns cover almost everything:
 *
 *   - SETUP/TEARDOWN — run before, `await next()`, run after in a `finally`.
 *     `await next()` resolves when the session ends, so the finally is teardown.
 *   - GATE           — `session.deny(reason)` throws to bounce; else `next()`.
 *   - ENRICH         — `next({ key: value })` contributes a typed field (inferred,
 *                      no generic) the handler reads on `session.context`.
 *
 * `.use(...)` order === execution order: the first is OUTERMOST, so the
 * setup/teardown wrapper sees (and times) every session, even denied ones.
 *
 * No type annotations are needed below: under `publicKey` auth the identity
 * flows from the builder, and each contribution is inferred from `next({ ... })`.
 */
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createServer } from "../src/index.js"

const PORT = Number(process.env.PORT ?? 2222)

// Registry keyed on the verified fingerprint, not the claimed username.
// Paste a printed `SHA256:…` fingerprint into either set to see the policy apply.
const ADMINS = new Set<string>([])
const BLOCKED = new Set<string>([])

const server = createServer({
  hostKey: { path: "./host_key" },
  auth: { publicKey: "any" }, // accept & identify any key; authorize below by fingerprint
})
  // SETUP/TEARDOWN: the username is fine to LOG, just not to authorize on. The
  // `finally` runs even when a downstream gate denies, so every session is timed.
  .use(async (s, next) => {
    console.log(`▸ ${s.identity.fingerprint} connected (claimed: ${s.identity.username})`)
    try {
      return await next() // resolves when the session ends
    } finally {
      console.log(`◂ ${s.identity.fingerprint} left`)
    }
  })
  // GATE on the verified fingerprint, never the claimed username. deny() throws
  // to unwind the chain, so the handler and renderer never come up.
  .use((s, next) => {
    if (BLOCKED.has(s.identity.fingerprint)) s.deny("This key is not authorized.")
    return next()
  })
  // ENRICH: contribute a typed `roles` field the handler reads as
  // `session.context.roles` — typed `string[]`, no cast.
  .use((s, next) => next({ roles: ADMINS.has(s.identity.fingerprint) ? ["admin"] : ["user"] }))
  .serve((session) => {
    const { renderer, identity, context } = session
    const box = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      border: true,
      borderStyle: "rounded",
      borderColor: "#a855f7",
      title: " @opentui/ssh · middleware ",
      titleAlignment: "center",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
    })
    box.add(
      new TextRenderable(renderer, { content: "you made it past the gate · press q or Ctrl-C to quit", fg: "#e2e8f0" }),
    )
    box.add(new TextRenderable(renderer, { content: `key:  ${identity.fingerprint}`, fg: "#d8b4fe" }))
    box.add(new TextRenderable(renderer, { content: `role: ${context.roles.join(", ")}`, fg: "#d8b4fe" }))
    renderer.root.add(box)

    renderer.keyInput.on("keypress", (key) => {
      if (key.name === "q" || (key.ctrl && key.name === "c")) session.end()
    })
    // The renderer is torn down for you on disconnect.
  })

await server.listen(PORT)

process.on("SIGINT", async () => {
  await server.close()
  process.exit(0)
})
