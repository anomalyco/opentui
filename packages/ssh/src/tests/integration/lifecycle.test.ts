import { expect, test } from "bun:test"
import { TextRenderable } from "@opentui/core"
import { Client, type ClientChannel } from "ssh2"
import type { Session } from "../../types.js"
import { createHarness, deferred, SHELL_PTY, sleep, waitFor } from "../support.js"

const { mkServer, openShell, openShellOn, conns } = createHarness()

test("idleTimeout reaps a session that sends no input", async () => {
  const server = mkServer(
    (s) => {
      s.renderer.root.add(new TextRenderable(s.renderer, { content: "idle" }))
    },
    { idleTimeout: 150 },
  )

  const { stream } = await openShell(server)
  // ssh2's client surfaces a server-reaped shell as 'exit'; it does not emit
  // channel 'close' on its own.
  const reaped = deferred<void>()
  stream.on("exit", () => reaped.resolve())

  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000))
  const result = await Promise.race([reaped.promise.then(() => "reaped" as const), timeout])
  expect(result).toBe("reaped")
})

test("without idleTimeout an idle session stays open", async () => {
  const server = mkServer((s) => {
    s.renderer.root.add(new TextRenderable(s.renderer, { content: "idle" }))
  })

  const { stream } = await openShell(server)
  let reaped = false
  stream.on("exit", () => {
    reaped = true
  })

  await sleep(400)
  expect(reaped).toBe(false)
})

test("idleTimeout reaps only the idle session; active sessions and the listener survive", async () => {
  const server = mkServer(
    (s) => {
      s.renderer.root.add(new TextRenderable(s.renderer, { content: "multi" }))
    },
    { idleTimeout: 250 },
  )
  const { port } = await server.listen(0)

  const idle = await openShellOn(port)
  const active = await openShellOn(port)
  let idleReaped = false
  let activeReaped = false
  idle.stream.on("exit", () => {
    idleReaped = true
  })
  active.stream.on("exit", () => {
    activeReaped = true
  })

  // Keep `active` busy: a keystroke every 80ms re-arms its idle timer (< 250ms).
  const keepalive = setInterval(() => active.stream.write("x"), 80)
  await sleep(700)
  clearInterval(keepalive)

  expect(idleReaped).toBe(true)
  expect(activeReaped).toBe(false)

  // Listener still up: a brand-new client can still connect and get a shell.
  const late = await openShellOn(port)
  expect(late.stream).toBeDefined()
})

test("maxTimeout reaps an active session after its absolute lifetime", async () => {
  const server = mkServer(
    (s) => {
      s.renderer.root.add(new TextRenderable(s.renderer, { content: "max" }))
    },
    { maxTimeout: 250 },
  )

  const { stream } = await openShell(server)
  let reaped = false
  stream.on("exit", () => {
    reaped = true
  })
  const keepalive = setInterval(() => stream.write("x"), 50)
  await sleep(700)
  clearInterval(keepalive)

  expect(reaped).toBe(true)
})

test("close() destroys a live session and fires onClose", async () => {
  const closed = deferred<void>()
  const server = mkServer((s) => {
    s.renderer.root.add(new TextRenderable(s.renderer, { content: "live" }))
    s.onClose(() => {
      closed.resolve()
    })
  })

  await openShell(server)
  // Let the shell finish wiring up server-side before shutting down.
  await sleep(100)
  await server.close()
  await closed.promise // resolves only if onClose fired
  expect(true).toBe(true)
})

test("two shells on one connection have independent lifecycles", async () => {
  // Each shell on a connection gets its own bridge; connection.ts captures it in a
  // `const` so one shell's teardown can't untrack/close the other. Open two on a
  // single connection, close the first, and the second must stay fully live.
  const sessions: Session[] = []
  let closeCount = 0
  const server = mkServer(
    (s) => {
      sessions.push(s)
      s.onClose(() => closeCount++)
    },
    { limits: { session: { perConnection: 2 } } },
  )
  const { port } = await server.listen(0)

  const conn = await new Promise<Client>((resolve, reject) => {
    const c = new Client()
    conns.push(c)
    c.on("ready", () => resolve(c))
      .on("error", reject)
      .connect({ host: "127.0.0.1", port, username: "guest" })
  })
  const openOne = () =>
    new Promise<ClientChannel>((resolve, reject) => {
      conn.shell(SHELL_PTY, (err, stream) => (err ? reject(err) : resolve(stream)))
    })

  const shellA = await openOne()
  const shellB = await openOne()
  await waitFor(() => sessions.length === 2)
  expect(sessions[0]).not.toBe(sessions[1]) // two distinct sessions, not a shared one

  // The survivor's client must receive a server-side write AFTER the other closes.
  const bReceived = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("survivor shell never received the write")), 4000)
    let buf = ""
    shellB.on("data", (d: Buffer) => {
      buf += d.toString("utf8")
      if (buf.includes("B-ALIVE")) {
        clearTimeout(timer)
        resolve(buf)
      }
    })
  })

  // Close the FIRST shell; only its session should tear down.
  shellA.close()
  await waitFor(() => closeCount === 1)
  await sleep(150) // give any erroneous cross-session teardown a chance to fire
  expect(closeCount).toBe(1) // the second shell is untouched

  sessions[1]!.write("B-ALIVE")
  expect(await bReceived).toContain("B-ALIVE")
}, 15000)
