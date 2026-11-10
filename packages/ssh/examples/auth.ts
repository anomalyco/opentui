/**
 * Example: authentication + type-flowing identity.
 *
 *   bun run packages/ssh/examples/auth.ts
 *
 * Connect with any key (accepted and identified by fingerprint):
 *
 *   ssh -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
 *       -i ~/.ssh/id_ed25519 guest@localhost
 *
 * ...or fall back to the password "swordfish":
 *
 *   ssh -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
 *       -o PreferredAuthentications=password guest@localhost
 *
 * Because `auth` mixes publickey and password, `session.identity` is a union:
 * discriminate on `.method`; `.fingerprint` is only readable in the publickey branch.
 */
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createServer } from "../src/index.js"

const PORT = Number(process.env.PORT ?? 2222)

const server = createServer({
  hostKey: { path: "./host_key" },
  auth: {
    publicKey: "any", // accept & identify any key
    password: ({ password }) => password === "swordfish", // simple fallback
  },
}).serve((session) => {
  const { renderer, identity } = session

  // identity is `publickey | password` here — narrow before touching fields.
  const how =
    identity.method === "publickey"
      ? `publickey · ${identity.fingerprint}` // ✅ fingerprint only exists on this branch
      : "password"

  renderer.setBackgroundColor("#0b1021")
  const box = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    border: true,
    borderStyle: "rounded",
    borderColor: "#8b5cf6",
    title: " @opentui/ssh · auth ",
    titleAlignment: "center",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  })
  box.add(new TextRenderable(renderer, { content: `Hello, ${identity.username}! 👋`, fg: "#e2e8f0" }))
  box.add(new TextRenderable(renderer, { content: `authenticated via ${how}`, fg: "#67e8f9" }))
  box.add(new TextRenderable(renderer, { content: "Press q or Ctrl-C to quit.", fg: "#94a3b8" }))
  renderer.root.add(box)

  renderer.keyInput.on("keypress", (key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) session.end()
  })
  // The renderer is torn down for you on disconnect.
})

// listen() prints the startup banner itself (host, fingerprints, auth methods).
await server.listen(PORT)

process.on("SIGINT", async () => {
  await server.close()
  process.exit(0)
})
