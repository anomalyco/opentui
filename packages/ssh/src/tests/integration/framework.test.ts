import { expect, test } from "bun:test"
import { CliRenderer, CliRenderEvents } from "@opentui/core"
import type { Session } from "../../types.js"
import { createHarness, deferred, sleep, type Shell } from "../support.js"

/**
 * The package hands the handler a real `@opentui/core` `CliRenderer` whose I/O is
 * the SSH channel, and tears it down via the shared destroy event. Solid's
 * `render()` adopts the renderer only when it `instanceof CliRenderer`; otherwise
 * it spins up its own renderer on process.stdout, hijacking the host terminal.
 * `CliRenderEvents.DESTROY === "destroy"`, so React's `once(DESTROY)` and Solid's
 * `once("destroy")` register against the same emission.
 */

const { mkServer, openShell } = createHarness()

/** Stand up an open-auth server and resolve the captured session once a real ssh2 client has a live shell. */
async function connect(): Promise<Shell & { session: Session }> {
  const sessionReady = deferred<Session>()
  const server = mkServer((s) => {
    sessionReady.resolve(s)
  })
  const { conn, stream } = await openShell(server)
  const session = await sessionReady.promise
  return { session, conn, stream }
}

test("session.renderer is a real CliRenderer instance (Solid's render() adoption check)", async () => {
  const { session } = await connect()
  // If false, Solid's render() would create its own renderer on process.stdout.
  expect(session.renderer).toBeInstanceOf(CliRenderer)
  session.onClose(() => session.renderer.destroy())
})

test("DESTROY fires once on client disconnect — both adapters unmount/dispose here", async () => {
  const { session, conn } = await connect()

  // Mirror an adapter: register teardown on DESTROY.
  let cleanups = 0
  session.renderer.once(CliRenderEvents.DESTROY, () => {
    cleanups++
  })
  session.onClose(() => session.renderer.destroy())

  // Client goes away → channel close → renderer.destroy() → DESTROY → cleanup runs.
  conn.end()
  await sleep(250)
  expect(cleanups).toBe(1)
})
