import { expect, spyOn, test } from "bun:test"
import { createHarness, sleep } from "../support.js"

/**
 * `onError` is the single error sink — the report path. Every contained error
 * lands here: a throwing handler, throwing user callbacks, connection/server
 * ssh2 errors. It defaults to `console.error`. (Bind failures reject `listen()`.)
 */

const { mkServer, openShell } = createHarness()

test("a throwing handler is reported to onError; the process survives", async () => {
  const seen: unknown[] = []
  const boom = new Error("handler boom")
  const server = mkServer(
    () => {
      throw boom
    },
    { onError: (err) => seen.push(err) },
  )

  await openShell(server)
  // Give the server a beat to invoke (and contain) the throwing handler.
  await sleep(200)
  expect(seen).toContain(boom)
})

test("onError defaults to console.error when not provided", async () => {
  const errorSpy = spyOn(console, "error").mockImplementation(() => {})
  const boom = new Error("default-sink boom")
  try {
    const server = mkServer(() => {
      throw boom
    })

    await openShell(server)
    await sleep(200)
    expect(errorSpy.mock.calls.some((c) => c.includes(boom))).toBe(true)
  } finally {
    errorSpy.mockRestore()
  }
})

test("a throwing onClose callback does not crash teardown; siblings still run", async () => {
  let secondRan = false
  const server = mkServer(
    (s) => {
      s.onClose(() => {
        throw new Error("onClose boom")
      })
      s.onClose(() => {
        secondRan = true
      })
    },
    { onError: () => {} },
  )

  const { conn } = await openShell(server)
  await sleep(150)
  conn.end()
  await sleep(250)
  // The throwing onClose was contained; the sibling close handler still ran.
  expect(secondRan).toBe(true)
})
