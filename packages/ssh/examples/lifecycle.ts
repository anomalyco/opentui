/**
 * Example: lifecycle logging, idleTimeout, onError, graceful shutdown.
 *
 *   bun run packages/ssh/examples/lifecycle.ts
 *
 * Connect (any key is accepted and identified):
 *
 *   ssh -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
 *       guest@localhost
 *
 * Stop typing: after 10s of no input idleTimeout reaps the session and the
 * client exits. Press q or Ctrl-C to close the remote session immediately;
 * Ctrl-C in the server terminal shuts the server down gracefully.
 *
 * Lifecycle hooks:
 *   - observe connect/disconnect → `logging()` middleware
 *   - react to per-session disconnect → `session.onClose`
 *   - server-wide aggregate → a counter you keep yourself
 *   - errors with no session context → the `onError` sink
 */
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createServer, logging } from "../src/index.js"

const PORT = Number(process.env.PORT ?? 2222)

let liveSessions = 0 // server-wide aggregate counter

const server = createServer({
  hostKey: { path: "./host_key" },
  auth: { publicKey: "any" },
  idleTimeout: "10s", // reap a session after 10s with no client input
  onError: (err) => console.error("✗", err), // sink for context-free errors
})
  .use(logging())
  .serve((session) => {
    const { renderer, identity } = session
    liveSessions++
    console.log(`live sessions: ${liveSessions}`)

    renderer.setBackgroundColor("#0b1021")
    const box = new BoxRenderable(renderer, {
      width: "100%",
      height: "100%",
      border: true,
      borderStyle: "rounded",
      borderColor: "#22c55e",
      title: " @opentui/ssh · lifecycle ",
      titleAlignment: "center",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
    })
    box.add(new TextRenderable(renderer, { content: `Hello, ${identity.username}! 👋`, fg: "#e2e8f0" }))
    box.add(new TextRenderable(renderer, { content: "stop typing for 10s and I'll disconnect you", fg: "#fca5a5" }))
    box.add(new TextRenderable(renderer, { content: "Press q or Ctrl-C to quit now.", fg: "#94a3b8" }))
    renderer.root.add(box)

    renderer.keyInput.on("keypress", (key) => {
      if (key.name === "q" || (key.ctrl && key.name === "c")) session.end()
    })

    // Per-session disconnect: your own cleanup. The renderer is torn down for you.
    session.onClose(() => {
      liveSessions--
      console.log(`live sessions: ${liveSessions}`)
    })
  })

await server.listen(PORT)

process.on("SIGINT", async () => {
  console.log("\nshutting down…")
  await server.close()
  process.exit(0)
})
