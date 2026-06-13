import { expect, test } from "bun:test"
import { Client } from "ssh2"
import { createServer } from "../../index.js"
import type { Middleware, Server, Session } from "../../types.js"
import { createHarness, HOST_KEY, SHELL_PTY, sleep } from "../support.js"

/**
 * The middleware onion: `.use(mw)` chains off `createServer(...)`.
 *   - `.use` order === execution order; the first `.use` is the outermost link.
 *   - `await next()` resolves when the session ends, so code after it is teardown.
 *   - `next({ key: value })` contributes a typed field, inferred and accumulated
 *     into `session.context` for downstream links and the handler. `deny()` throws
 *     to unwind the chain.
 */

const { track, conns, openShell, openShellOn } = createHarness()

async function captureShellOutput(server: Server): Promise<string> {
  const { port } = await server.listen(0)
  const chunks: Buffer[] = []
  await new Promise<void>((resolve, reject) => {
    const conn = new Client()
    conns.push(conn)
    conn
      .on("ready", () => {
        conn.shell(SHELL_PTY, (err, stream) => {
          if (err) return reject(err)
          stream.on("data", (d: Buffer) => chunks.push(Buffer.from(d)))
          stream.on("close", () => resolve())
        })
      })
      .on("error", reject)
      .connect({ host: "127.0.0.1", port, username: "guest" })
  })
  return Buffer.concat(chunks).toString("latin1")
}

test("first .use is the outermost link; teardown unwinds in reverse", async () => {
  const order: string[] = []
  const a: Middleware = async (_s, next) => {
    order.push("A:before")
    try {
      return await next()
    } finally {
      order.push("A:after")
    }
  }
  const b: Middleware = async (_s, next) => {
    order.push("B:before")
    try {
      return await next()
    } finally {
      order.push("B:after")
    }
  }
  const server = track(
    createServer({ auth: "open", startupBanner: false, hostKey: { pem: HOST_KEY } })
      .use(a)
      .use(b)
      .serve((s) => {
        order.push("handler")
      }),
  )

  const { conn } = await openShell(server)
  await sleep(200)
  expect(order).toEqual(["A:before", "B:before", "handler"]) // setup ran outer→inner

  conn.end()
  await sleep(300)
  // teardown unwinds inner→outer
  expect(order).toEqual(["A:before", "B:before", "handler", "B:after", "A:after"])
})

test("await next() resolves at disconnect — teardown runs after the client leaves", async () => {
  let afterNext = false
  const server = track(
    createServer({ auth: "open", startupBanner: false, hostKey: { pem: HOST_KEY } })
      .use(async (_s, next) => {
        const handoff = await next() // resolves only when the session closes
        afterNext = true
        return handoff // middleware must return the handoff
      })
      .serve(() => {}),
  )

  const { conn } = await openShell(server)
  await sleep(150)
  expect(afterNext).toBe(false) // still connected, so teardown has not run

  conn.end()
  await sleep(300)
  expect(afterNext).toBe(true) // disconnected → the code after next() ran
})

test("a middleware that deny()s never invokes the handler", async () => {
  let handlerRan = false
  const server = track(
    createServer({ auth: "open", startupBanner: false, hostKey: { pem: HOST_KEY } })
      .use((s, next) => (s.identity.username === "banned" ? s.deny("nope") : next()))
      .serve(() => {
        handlerRan = true
      }),
  )

  await openShell(server, "banned")
  await sleep(250)
  expect(handlerRan).toBe(false)
})

// Returning the handoff is compile-enforced; the cast simulates a JS caller who
// slips past the type, proving the runtime still closes the session rather than
// leaving the client hanging at a blank screen.
test("a middleware that neither calls next() nor denies still closes the session", async () => {
  let handlerRan = false
  const server = track(
    createServer({ auth: "open", hostKey: { pem: HOST_KEY }, startupBanner: false })
      // biome-ignore lint/suspicious/noExplicitAny: simulate a JS caller bypassing the must-return type
      .use((() => {}) as any)
      .serve(() => {
        handlerRan = true
      }),
  )

  // The session ends almost immediately, so attach the close listeners
  // synchronously inside the shell callback — resolving on the returned stream
  // after an await would race the (already-fired) exit/close events.
  const { port } = await server.listen(0)
  const conn = new Client()
  conns.push(conn)
  const result = await new Promise<"closed" | "hung">((resolve, reject) => {
    const timer = setTimeout(() => resolve("hung"), 3000)
    const done = () => {
      clearTimeout(timer)
      resolve("closed")
    }
    conn
      .on("ready", () => {
        conn.shell(SHELL_PTY, (err, stream) => {
          if (err) {
            clearTimeout(timer)
            return reject(err)
          }
          stream.on("exit", done)
          stream.on("close", done)
        })
      })
      .on("error", reject)
      .connect({ host: "127.0.0.1", port, username: "guest" })
  })
  expect(result).toBe("closed") // the framework closed it instead of hanging
  expect(handlerRan).toBe(false) // next() was never called, so the handler never ran
}, 15000)

// The renderer (and its alternate screen) is created only after the chain
// authorizes the session, so a denial writes to the main screen and persists
// instead of being wiped with the alternate-screen buffer.
test("a denied session never enters the alternate screen; the reason persists", async () => {
  const server = track(
    createServer({ auth: "open", hostKey: { pem: HOST_KEY }, startupBanner: false })
      .use((s) => s.deny("DENIED"))
      .serve(() => {}),
  )

  const raw = await captureShellOutput(server)
  expect(raw).toContain("DENIED") // the rejection reached the client…
  expect(raw).not.toContain("[?1049h") // not swallowed by the alternate screen
}, 15000)

// deny() throws, so a `return next()` after it is unreachable and the framework
// must not build a renderer on the already-closed session.
test("a middleware that denies then wrongly calls next() does not run the handler or enter the alt-screen", async () => {
  let handlerRan = false
  const server = track(
    createServer({ auth: "open", hostKey: { pem: HOST_KEY }, startupBanner: false })
      .use((s, next) => {
        s.deny("DENIED") // throws — unwinds the chain…
        return next() // …unreachable. The framework must still not render.
      })
      .serve(() => {
        handlerRan = true
      }),
  )

  const raw = await captureShellOutput(server)
  expect(handlerRan).toBe(false) // the leaf refused to run on a closed session
  expect(raw).toContain("DENIED")
  expect(raw).not.toContain("[?1049h") // no renderer was built
}, 15000)

test("session.renderer is unavailable to a middleware before it calls next()", async () => {
  const errors: unknown[] = []
  let handlerRan = false
  const server = track(
    createServer({
      auth: "open",
      hostKey: { pem: HOST_KEY },
      startupBanner: false,
      onError: (err) => errors.push(err),
    })
      .use((s, next) => {
        // `renderer` lives only on the handler's Session; the cast simulates a
        // JS caller bypassing the type to prove the runtime guard still throws when
        // read before next() — contained by safeInvoke and routed to onError.
        void (s as unknown as Session).renderer
        return next()
      })
      .serve(() => {
        handlerRan = true
      }),
  )

  await openShell(server)
  await sleep(250)
  expect(handlerRan).toBe(false) // the middleware threw before reaching the handler
  expect(errors.some((e) => e instanceof Error && /renderer/i.test(e.message))).toBe(true)
}, 15000)

test("a middleware's next({...}) contribution reaches the handler's typed context", async () => {
  let seenRoles: string[] | undefined
  const server = track(
    createServer({ auth: "open", hostKey: { pem: HOST_KEY }, startupBanner: false })
      .use((_s, next) => next({ roles: ["admin", "ops"] }))
      .serve((s) => {
        seenRoles = s.context.roles // typed string[] — no cast
      }),
  )

  await openShell(server)
  await sleep(250)
  expect(seenRoles).toEqual(["admin", "ops"])
}, 15000)

test("each session gets its own context bag — contributions never bleed across clients", async () => {
  const seen = new Map<string, string>()
  const server = track(
    createServer({ auth: "open", hostKey: { pem: HOST_KEY }, startupBanner: false })
      .use((s, next) => next({ who: s.identity.username }))
      .serve((s) => {
        seen.set(s.identity.username, s.context.who)
      }),
  )
  const { port } = await server.listen(0)

  await Promise.all([openShellOn(port, "alice"), openShellOn(port, "bob")])
  await sleep(300)
  // Each handler saw its own session's contribution, not the other's.
  expect(seen.get("alice")).toBe("alice")
  expect(seen.get("bob")).toBe("bob")
}, 15000)
