import { expect, test } from "bun:test"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createServer } from "../../index.js"
import type { Session } from "../../types.js"
import { createHarness, HOST_KEY, waitFor } from "../support.js"

const { track, mkServer, openShellOn } = createHarness()

test("SSH sessions isolate frames, order middleware/raw output, resize before notifying, and restore", async () => {
  const sessions = new Map<string, Session>()
  const errors: unknown[] = []
  const server = track(
    createServer({ startupBanner: false, hostKey: { pem: HOST_KEY }, onError: (error) => errors.push(error) })
      .use((session, next) => {
        session.write(`BEFORE_${session.identity.username}`)
        return next()
      })
      .serve((session) => {
        sessions.set(session.identity.username, session)
        const box = new BoxRenderable(session.renderer, { border: true, width: "100%", height: "100%" })
        box.add(new TextRenderable(session.renderer, { content: `FRAME_${session.identity.username}` }))
        session.renderer.root.add(box)
      }),
  )
  const { port } = await server.listen(0)
  const a = await openShellOn(port, "alpha", {
    term: "xterm-256color",
    cols: 100,
    rows: 30,
    width: 0,
    height: 0,
  })
  const b = await openShellOn(port, "beta")
  let outputA = ""
  let outputB = ""
  a.stream.on("data", (bytes: Buffer) => {
    outputA += bytes.toString()
  })
  b.stream.on("data", (bytes: Buffer) => {
    outputB += bytes.toString()
  })
  await waitFor(() => outputA.includes("FRAME_alpha") && outputB.includes("FRAME_beta"))
  const first = sessions.get("alpha")!
  const second = sessions.get("beta")!
  expect(first.identity).toEqual({ method: "none", username: "alpha" })
  expect(first.term).toBe("xterm-256color")
  expect([first.cols, first.rows]).toEqual([100, 30])
  expect(first.hasPty).toBe(true)
  expect(first.remoteAddress.address).toBe("127.0.0.1")
  expect(first.remoteAddress.port).toBeGreaterThan(0)
  expect(first.renderer).not.toBe(second.renderer)
  expect(outputA).not.toContain("beta")
  expect(outputB).not.toContain("alpha")
  first.write("AFTER_alpha")
  await waitFor(() => outputA.includes("AFTER_alpha"))
  expect(outputA.indexOf("BEFORE_alpha")).toBeLessThan(outputA.indexOf("\x1b[?1049h"))
  expect(outputA.indexOf("FRAME_alpha")).toBeLessThan(outputA.indexOf("AFTER_alpha"))
  const resizes: Array<[number, number]> = []
  first.onResize((cols, rows) => {
    expect([first.cols, first.rows, first.renderer.width, first.renderer.height]).toEqual([cols, rows, cols, rows])
    resizes.push([cols, rows])
  })
  a.stream.setWindow(40, 120, 0, 0)
  await waitFor(() => resizes.length > 0)
  expect(resizes.at(-1)).toEqual([120, 40])
  expect([second.cols, second.rows]).toEqual([80, 24])
  const closed = new Promise<void>((resolve) => a.stream.once("close", resolve))
  first.end()
  await closed
  await first.renderer.closed
  expect(outputA).toContain("\x1b[?1049l")
  expect(second.renderer.isDestroyed).toBe(false)
  await server.close()
  await second.renderer.closed
  await waitFor(() => outputB.includes("\x1b[?1049l"))
  expect(errors).toEqual([])
})

// The package creates the renderer, so it destroys it on disconnect; the handler
// wires only its own app teardown, not onClose(renderer.destroy()).
test("the renderer is destroyed on disconnect even when the handler never wires it", async () => {
  let captured: Session | undefined
  const server = mkServer((s) => {
    captured = s
    s.renderer.root.add(new TextRenderable(s.renderer, { content: "no manual teardown" }))
    // no onClose(() => s.renderer.destroy()) — the framework owns it.
  })
  const { port } = await server.listen(0)
  const { conn } = await openShellOn(port, "render-tester")
  await waitFor(() => captured !== undefined)
  expect(captured!.renderer.isDestroyed).toBe(false) // live while connected

  conn.end()
  await waitFor(() => captured!.renderer.isDestroyed)
  expect(captured!.renderer.isDestroyed).toBe(true) // …destroyed for you on disconnect
})
