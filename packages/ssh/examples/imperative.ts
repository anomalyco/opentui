/**
 * Example: serve a static imperative OpenTUI screen over SSH.
 *
 *   bun run packages/ssh/examples/imperative.ts
 *
 * Then, from another terminal:
 *
 *   ssh -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null guest@localhost
 *
 * You get a bordered box rendered by @opentui/core, wired to the SSH channel.
 * Resize your terminal — the box tracks it live. Press q or Ctrl-C to close the session.
 */
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createServer } from "../src/index.js"

const PORT = Number(process.env.PORT ?? 2222)

const server = createServer({
  hostKey: { path: "./host_key" }, // auto-generated & persisted on first run
  auth: "open",
  startupBanner: false,
}).serve((session) => {
  const { renderer, identity } = session

  renderer.setBackgroundColor("#0b1021")
  const box = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    border: true,
    borderStyle: "rounded",
    borderColor: "#8b5cf6",
    title: " @opentui/ssh ",
    titleAlignment: "center",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  })

  const sizeText = new TextRenderable(renderer, { content: "", fg: "#94a3b8" })
  const update = () => {
    sizeText.content = `${session.cols} × ${session.rows}  ·  ${session.term}`
  }

  box.add(new TextRenderable(renderer, { content: `Hello, ${identity.username}! 👋`, fg: "#e2e8f0" }))
  box.add(new TextRenderable(renderer, { content: "Served imperatively over SSH.", fg: "#67e8f9" }))
  box.add(new TextRenderable(renderer, { content: "Press q or Ctrl-C to quit.", fg: "#94a3b8" }))
  box.add(sizeText)
  renderer.root.add(box)
  update()

  session.onResize(update)
  renderer.keyInput.on("keypress", (key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) session.end()
  })
  // The renderer is destroyed for you on disconnect — no onClose needed here.
})

const { host, port, fingerprints } = await server.listen(PORT)
console.log(`@opentui/ssh  ▸  ssh://${host === "0.0.0.0" ? "localhost" : host}:${port}`)
console.log(`host keys     ${fingerprints.join(" ")}`)
console.log("waiting for connections… (Ctrl-C to stop)")

process.on("SIGINT", async () => {
  await server.close()
  process.exit(0)
})
