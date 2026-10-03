import assert from "node:assert/strict"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { createServer, logging, ConfigError, OutputPressureError } from "@opentui/ssh"
import ssh2 from "ssh2"

assert.equal(typeof logging, "function")
assert.equal(typeof ConfigError, "function")
assert.equal(new OutputPressureError().code, "OUTPUT_PRESSURE")

let handlerCalls = 0
let renderer
const errors = []
const server = createServer({ startupBanner: false, onError: (error) => errors.push(error) })
  .use(async (session, next) => {
    if (session.identity.username === "deny") session.deny("PACKED_DENIED")
    session.write("PACKED_BEFORE")
    return next()
  })
  .serve((session) => {
    handlerCalls++
    renderer = session.renderer
    const box = new BoxRenderable(renderer, { border: true, width: "100%", height: "100%" })
    box.add(new TextRenderable(renderer, { content: "PACKED_FRAME", selectable: false }))
    renderer.root.add(box)
    session.onResize((cols, rows) => {
      assert.deepEqual([cols, rows, renderer.width, renderer.height], [96, 32, 96, 32])
      session.write("PACKED_AFTER")
      session.end()
    })
  })
const { port } = await server.listen(0)
try {
  for (const username of ["packed", "deny"]) {
    const client = new ssh2.Client()
    let timeout
    try {
      const output = await new Promise((resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("Packed SSH session timed out")), 10_000)
        let data = ""
        let resized = false
        client.on("ready", () => {
          client.shell({ term: "xterm-256color", cols: 80, rows: 24 }, (error, stream) => {
            if (error) return reject(error)
            stream.on("data", (chunk) => {
              data += chunk.toString()
              if (!resized && data.includes("PACKED_FRAME")) {
                resized = true
                stream.setWindow(32, 96, 0, 0)
              }
            })
            stream.on("error", reject)
            stream.on("close", () => resolve(data))
          })
        })
        client.on("error", reject)
        client.connect({ host: "127.0.0.1", port, username })
      })
      assert.deepEqual(errors, [], `native ${username} reported a runtime error`)
      if (username === "deny") assert.equal(output, "PACKED_DENIED\r\n")
      else {
        assert.ok(output.includes("PACKED_BEFORE"))
        assert.ok(output.includes("PACKED_FRAME"))
        assert.ok(output.includes("PACKED_AFTER"))
        assert.ok(output.indexOf("PACKED_BEFORE") < output.indexOf("\x1b[?1049h"))
        assert.ok(output.indexOf("PACKED_FRAME") < output.indexOf("PACKED_AFTER"))
        assert.ok(output.includes("\x1b[?1049l"))
        assert.ok(renderer.nativeScene)
        assert.equal(renderer.isDestroyed, true)
        await renderer.closed
      }
    } finally {
      clearTimeout(timeout)
      client.end()
    }
  }
  assert.equal(handlerCalls, 1)
  assert.deepEqual(errors, [])
} finally {
  await server.close()
}
