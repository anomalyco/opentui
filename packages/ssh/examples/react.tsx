/**
 * Example: serve a React (@opentui/react) app over SSH.
 *
 * `@opentui/ssh` is renderer-agnostic and hands you a wired `CliRenderer` on
 * `session.renderer`; drive it with any front-end. For React that's
 * `createRoot(renderer).render(…)`, with the renderer's I/O bound to the SSH
 * channel instead of a terminal.
 *
 *   bun run packages/ssh/examples/react.tsx
 *   ssh -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
 *       guest@localhost
 *
 * @opentui/react is not a dependency of @opentui/ssh; the package stays
 * react/solid-free. It's imported here only to demonstrate the handoff.
 */
import { createServer } from "../src/index.js"
import { createRoot, useKeyboard } from "@opentui/react"
import { useState } from "react"

const PORT = Number(process.env.PORT ?? 2222)

const PALETTE = ["#22c55e", "#06b6d4", "#a855f7", "#f59e0b", "#ef4444"]

function App({ name }: { name: string }) {
  const [i, setI] = useState(0)
  const color = PALETTE[i % PALETTE.length]

  useKeyboard((key) => {
    if (key.name === "up") setI((n) => n + 1)
    if (key.name === "down") setI((n) => (n - 1 + PALETTE.length) % PALETTE.length)
  })

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        border: true,
        borderStyle: "rounded",
        borderColor: color,
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
      }}
      title=" @opentui/ssh · react "
      titleAlignment="center"
    >
      <text content={`Hello, ${name}! 👋`} fg="#e2e8f0" />
      <text content="↑/↓ to recolor · q or Ctrl-C to quit" fg={color} />
    </box>
  )
}

const server = createServer({
  hostKey: { path: "./host_key" }, // auto-generated & persisted on first run
  auth: { publicKey: "any" }, // open, but every client has an identity
}).serve((session) => {
  // The renderer is a real CliRenderer bound to this SSH channel — createRoot
  // adopts it as-is. One root per session.
  const root = createRoot(session.renderer)
  root.render(<App name={session.identity.username} />)

  // These keys quit this session (and only this one).
  session.renderer.keyInput.on("keypress", (key) => {
    if (key.name === "q" || (key.ctrl && key.name === "c")) session.end()
  })

  // Tear the React tree down when the client disconnects.
  session.onClose(() => root.unmount())
})

await server.listen(PORT)

process.on("SIGINT", async () => {
  await server.close()
  process.exit(0)
})
