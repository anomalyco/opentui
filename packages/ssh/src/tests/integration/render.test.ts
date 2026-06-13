import { expect, test } from "bun:test"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import type { Session } from "../../types.js"
import { createHarness, waitFor } from "../support.js"

const SENTINEL = "RENDER-OK"
const ANSI = /\x1b[[\]][0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g
const { mkServer, openShellOn } = createHarness()

function stripAnsi(s: string): string {
  return s.replace(ANSI, "")
}

test("the handler renders an OpenTUI screen to the client", async () => {
  const server = mkServer((s) => {
    const box = new BoxRenderable(s.renderer, { width: "100%", height: "100%", border: true })
    box.add(new TextRenderable(s.renderer, { content: SENTINEL }))
    s.renderer.root.add(box)
  })
  const { port } = await server.listen(0)

  const received = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no frame containing sentinel")), 8000)
    openShellOn(port, "render-tester")
      .then(({ conn, stream }) => {
        let buf = ""
        stream.on("data", (d: Buffer) => {
          buf += d.toString("utf8")
          if (stripAnsi(buf).includes(SENTINEL)) {
            clearTimeout(timer)
            stream.close()
            conn.end()
            resolve(buf)
          }
        })
      })
      .catch(reject)
  })

  expect(stripAnsi(received)).toContain(SENTINEL)
})

test("session exposes identity, term, and pty dimensions", async () => {
  let captured: Session | undefined
  const server = mkServer((s) => {
    captured = s
    s.renderer.root.add(new TextRenderable(s.renderer, { content: "dims" }))
  })
  const { port } = await server.listen(0)
  const { conn } = await openShellOn(port, "render-tester", {
    term: "xterm-256color",
    cols: 100,
    rows: 30,
    width: 0,
    height: 0,
  })
  await waitFor(() => captured !== undefined)
  conn.end()

  expect(captured!.identity.method).toBe("none")
  expect(captured!.identity.username).toBe("render-tester")
  expect(captured!.term).toBe("xterm-256color")
  expect(captured!.cols).toBe(100)
  expect(captured!.rows).toBe(30)
  expect(captured!.hasPty).toBe(true)
  expect(captured!.remoteAddress.address).toBe("127.0.0.1")
  expect(captured!.remoteAddress.port).toBeGreaterThan(0)
})

test("forwards client resize to the session and renderer", async () => {
  const resizes: Array<[number, number]> = []
  let captured: Session | undefined
  const server = mkServer((s) => {
    captured = s
    s.onResize((c, r) => resizes.push([c, r]))
    s.renderer.root.add(new TextRenderable(s.renderer, { content: "resize" }))
  })
  const { port } = await server.listen(0)
  const { conn, stream } = await openShellOn(port, "render-tester")
  await waitFor(() => captured !== undefined)

  stream.setWindow(40, 120, 0, 0) // rows, cols, height, width
  await waitFor(() => resizes.length > 0)
  conn.end()

  expect(resizes.at(-1)).toEqual([120, 40])
  expect(captured!.cols).toBe(120)
  expect(captured!.rows).toBe(40)
  expect(captured!.renderer.width).toBe(120)
  expect(captured!.renderer.height).toBe(40)
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
