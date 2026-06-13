/**
 * Example: restrict access with an authorized_keys allowlist.
 *
 *   ssh-keygen -y -f ~/.ssh/id_ed25519 > ./authorized_keys
 *   bun run packages/ssh/examples/authorized-keys.ts
 *
 * Then connect with the matching private key:
 *
 *   ssh -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
 *       -i ~/.ssh/id_ed25519 guest@localhost
 *
 * Set AUTHORIZED_KEYS=/path/to/authorized_keys to use a different file.
 */
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createServer } from "../src/index.js"

const PORT = Number(process.env.PORT ?? 2222)
const AUTHORIZED_KEYS = process.env.AUTHORIZED_KEYS ?? "./authorized_keys"

const server = createServer({
  hostKey: { path: "./host_key" },
  auth: {
    publicKey: { authorizedKeys: AUTHORIZED_KEYS },
  },
}).serve((session) => {
  const { renderer, identity } = session

  renderer.setBackgroundColor("#0f172a")
  const box = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    border: true,
    borderStyle: "rounded",
    borderColor: "#22c55e",
    title: " @opentui/ssh · authorized_keys ",
    titleAlignment: "center",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  })

  box.add(new TextRenderable(renderer, { content: `Welcome, ${identity.username}!`, fg: "#e2e8f0" }))
  box.add(new TextRenderable(renderer, { content: `key: ${identity.fingerprint}`, fg: "#86efac" }))
  box.add(new TextRenderable(renderer, { content: `allowlist: ${AUTHORIZED_KEYS}`, fg: "#94a3b8" }))
  box.add(new TextRenderable(renderer, { content: "Press q or Ctrl-C to quit.", fg: "#94a3b8" }))
  renderer.root.add(box)

  renderer.keyInput.on("keypress", (key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) session.end()
  })
})

await server.listen(PORT)

process.on("SIGINT", async () => {
  await server.close()
  process.exit(0)
})
