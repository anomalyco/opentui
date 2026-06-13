import { expect, test } from "bun:test"
import { createServer, logging, type LogEvent } from "../../index.js"
import { createHarness, HOST_KEY, sleep, waitFor } from "../support.js"

/**
 * The logging middleware is pure observability: a "connect" event at session
 * start and a "disconnect" event (with duration) at teardown. It never touches
 * errors — a throwing handler still flows to `onError`, the one error sink.
 */

const { track, openShell } = createHarness()

test("emits connect then disconnect, with the session's identity and pty", async () => {
  const events: LogEvent[] = []
  const server = track(
    createServer({ auth: "open", startupBanner: false, hostKey: { pem: HOST_KEY } })
      .use(logging({ log: (e) => events.push(e) }))
      .serve(() => {}),
  )

  const { conn } = await openShell(server, "alice")
  await sleep(150)
  expect(events.map((e) => e.type)).toEqual(["connect"])
  expect(events[0]!.identity.username).toBe("alice")
  expect(events[0]!.term).toBe("xterm-256color")
  expect(events[0]!.cols).toBe(80)
  expect(events[0]!.rows).toBe(24)
  expect(events[0]!.durationMs).toBeUndefined()

  conn.end()
  await sleep(300)
  expect(events.map((e) => e.type)).toEqual(["connect", "disconnect"])
  expect(events[1]!.durationMs).toBeGreaterThanOrEqual(0)
  expect(events[1]!.durationMs).toBeLessThan(5000)
})

test("disconnect still logs when the handler throws — error goes to onError, not the log", async () => {
  const events: LogEvent[] = []
  const errors: unknown[] = []
  const server = track(
    createServer({
      auth: "open",
      startupBanner: false,
      hostKey: { pem: HOST_KEY },
      onError: (err) => errors.push(err),
    })
      .use(logging({ log: (e) => events.push(e) }))
      .serve(() => {
        throw new Error("boom")
      }),
  )

  const { conn } = await openShell(server)
  await sleep(300)
  conn.end()
  await sleep(200)

  // logging saw the full lifecycle; the error reached onError, never the log sink.
  expect(events.map((e) => e.type)).toEqual(["connect", "disconnect"])
  expect(errors).toHaveLength(1)
  expect((errors[0] as Error).message).toBe("boom")
})

test("a failing logging sink does not block a live session", async () => {
  let handlerCalls = 0
  let sinkCalls = 0
  const server = track(
    createServer({ auth: "open", startupBanner: false, hostKey: { pem: HOST_KEY } })
      .use(
        logging({
          log: () => {
            sinkCalls++
            throw new Error("sink failed")
          },
        }),
      )
      .serve((session) => {
        handlerCalls++
        session.end()
      }),
  )

  await openShell(server)
  await waitFor(() => handlerCalls === 1 && sinkCalls === 2)

  expect(handlerCalls).toBe(1)
  expect(sinkCalls).toBe(2)
})
