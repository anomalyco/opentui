import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { BoxRenderable, NativeSession, TextRenderable } from "@opentui/core"
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

for (const close of ["connection", "shell", "local"]) {
  const shellOnly = close === "shell"
  const { Channel } = createRequire(import.meta.url)("ssh2/lib/Channel.js")
  const pause = Channel.prototype.pause
  const write = NativeSession.prototype.write
  const paused = Promise.withResolvers()
  const middleware = Promise.withResolvers()
  let driver
  let end
  let handlers = 0
  let closes = 0
  let arrivals = 0
  let clientClosed = false
  let timeout
  const errors = []
  const client = new ssh2.Client()
  client.on("close", () => {
    clientClosed = true
  })
  const server = createServer({
    startupBanner: false,
    limits: { session: { global: 1 } },
    onError: (error) => errors.push(error),
  })
    .use(async (session, next) => {
      if (++arrivals > 1) session.deny("PACKED_CAPACITY")
      end = () => session.end()
      session.write("PACKED_PAUSED")
      if (shellOnly) session.write(Buffer.alloc(3_500_000))
      session.onClose(() => {
        closes++
      })
      await middleware.promise
      return next()
    })
    .serve(() => {
      handlers++
    })
  Channel.prototype.pause = function () {
    const result = pause.call(this)
    if (this.server) paused.resolve(this)
    return result
  }
  NativeSession.prototype.write = function (bytes) {
    driver = this
    return write.call(this, bytes)
  }
  try {
    const { port } = await server.listen(0)
    const stream = await new Promise((resolve, reject) => {
      client.on("ready", () => client.shell((error, channel) => (error ? reject(error) : resolve(channel))))
      client.on("error", reject)
      client.connect({ host: "127.0.0.1", port, username: "paused" })
    })
    if (!shellOnly) stream.resume()
    stream.write(Buffer.alloc(262_144))
    const channel = await paused.promise
    const channelClosed = new Promise((resolve) => channel.once("close", resolve))
    for (
      let turn = 0;
      turn < 200 &&
      (channel.readableLength === 0 || (shellOnly && (channel.outgoing.window !== 0 || channel.writableLength === 0)));
      turn++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(channel.readableLength > 0)
    if (shellOnly) {
      assert.equal(channel.outgoing.window, 0)
      assert.ok(channel.writableLength > 0)
    }
    assert.equal(driver.usesOutput(channel), true)
    assert.equal(driver.disposed, false)
    if (close === "local") end()
    else if (shellOnly) stream.close()
    else client.destroy()
    await Promise.race([
      channelClosed,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Paused channel did not close (${close})`)), 3000)
      }),
    ])
    assert.equal(driver.disposed, true)
    if (close === "local") await driver.closed
    assert.equal(channel.listenerCount("data"), 0)
    assert.equal(channel.listenerCount("error"), 0)
    assert.equal(channel.listenerCount("drain"), 0)
    assert.equal(handlers, 0)
    if (close !== "connection") {
      assert.equal(clientClosed, false)
      const output = await new Promise((resolve, reject) => {
        client.shell((error, probe) => {
          if (error) return reject(error)
          let data = ""
          probe.on("data", (bytes) => {
            data += bytes.toString()
          })
          probe.on("close", () => resolve(data))
          probe.on("error", reject)
        })
      })
      assert.equal(output, "PACKED_CAPACITY\r\n")
      assert.equal(clientClosed, false)
    }
    await server.close()
    assert.equal(closes, 1)
    assert.deepEqual(errors, [])
  } finally {
    clearTimeout(timeout)
    middleware.resolve()
    client.destroy()
    await server.close()
    Channel.prototype.pause = pause
    NativeSession.prototype.write = write
  }
}
