/**
 * The smallest @opentui/ssh server: render a TUI to anyone who connects.
 *
 *   bun run packages/ssh/examples/minimal.ts
 *
 * Then, from another terminal:
 *
 *   ssh -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null localhost
 *
 * Auth defaults to none and the bind defaults to localhost. See
 * authorized-keys.ts before exposing a server publicly.
 */
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createServer } from "../src/index.js"

const server = createServer().serve((session) => {
  const { renderer } = session
  const box = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    border: true,
    borderStyle: "rounded",
    title: " @opentui/ssh ",
    titleAlignment: "center",
    justifyContent: "center",
    alignItems: "center",
  })
  box.add(new TextRenderable(renderer, { content: "Hello over SSH! 👋\nPress q or Ctrl-C to quit." }))
  renderer.root.add(box)

  renderer.keyInput.on("keypress", (key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) session.end()
  })
  // @opentui/ssh owns the renderer it created and destroys it on disconnect;
  // wire session.onClose only for your own cleanup (e.g. root.unmount()).
})

await server.listen(Number(process.env.PORT ?? 2222))

process.on("SIGINT", async () => {
  await server.close()
  process.exit(0)
})
