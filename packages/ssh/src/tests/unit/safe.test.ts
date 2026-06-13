import { expect, test } from "bun:test"
import { createSafeInvoke } from "../../safe.js"

/**
 * A throwing user callback (or rejected promise) must not propagate back into
 * ssh2's connection/channel handlers, which would tear down the connection or
 * crash the process. Errors are routed to the sink; a sink that itself throws is
 * also contained.
 */

test("a synchronous throw does not propagate; it is routed to the sink", async () => {
  const seen: unknown[] = []
  const safe = createSafeInvoke((err) => seen.push(err))
  const boom = new Error("sync boom")

  // This is the call that runs inside ssh2's handler.
  expect(() =>
    safe(() => {
      throw boom
    }),
  ).not.toThrow()
  await Promise.resolve() // let the contained report settle
  expect(seen).toEqual([boom])
})

test("a rejected promise is contained and routed to the sink", async () => {
  const seen: unknown[] = []
  const safe = createSafeInvoke((err) => seen.push(err))
  const boom = new Error("async boom")

  await safe(async () => {
    throw boom
  })
  expect(seen).toEqual([boom])
})

test("safeInvoke resolves even when the callback rejects", async () => {
  const safe = createSafeInvoke(() => {})
  // Awaiting must not reject — middleware composition awaits this.
  await expect(
    safe(async () => {
      throw new Error("boom")
    }),
  ).resolves.toBeUndefined()
})

test("one failing callback does not starve siblings invoked after it", () => {
  const safe = createSafeInvoke(() => {})
  let reached = false

  safe(() => {
    throw new Error("boom")
  })
  safe(() => {
    reached = true
  })

  expect(reached).toBe(true)
})

test("a sink that itself throws is contained", () => {
  const safe = createSafeInvoke(() => {
    throw new Error("sink boom")
  })
  expect(() =>
    safe(() => {
      throw new Error("callback boom")
    }),
  ).not.toThrow()
})

// report() reports ssh-level errors that have no user callback.
test("report() routes an error to the sink, and a throwing sink is contained", () => {
  const seen: unknown[] = []
  const safe = createSafeInvoke((err) => {
    seen.push(err)
    throw new Error("sink boom")
  })
  const boom = new Error("ssh-level boom")

  expect(() => safe.report(boom)).not.toThrow()
  expect(seen).toEqual([boom])
})
