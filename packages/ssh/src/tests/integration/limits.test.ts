import { expect, test } from "bun:test"
import type { Client, ClientChannel } from "ssh2"
import { createServer } from "../../index.js"
import { createHarness, HOST_KEY, SHELL_PTY, sleep, waitFor } from "../support.js"

const { track, connect, connectOn, openShellOn } = createHarness()
// ssh2's rejected shell callback hangs under Bun 1.3.14 on Windows and then crashes
// Bun during teardown. The same admission paths are covered deterministically in connection.test.ts.
const liveLimitTest = process.platform === "win32" ? test.skip : test

function requestShell(client: Client): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    client.shell(SHELL_PTY, (error, stream) => (error ? reject(error) : resolve(stream)))
  })
}

async function requestShellEventually(client: Client): Promise<ClientChannel> {
  const deadline = Date.now() + 3_000
  while (true) {
    try {
      return await requestShell(client)
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await sleep(25)
    }
  }
}

liveLimitTest("per-connection limit rejects excess shells without running the application", async () => {
  let middlewareCalls = 0
  let handlerCalls = 0
  const errors: unknown[] = []
  const server = track(
    createServer({
      auth: "open",
      startupBanner: false,
      hostKey: { pem: HOST_KEY },
      limits: { session: { perConnection: 1, global: 10 } },
      onError: (error) => errors.push(error),
    })
      .use((_session, next) => {
        middlewareCalls++
        return next()
      })
      .serve(() => {
        handlerCalls++
      }),
  )
  const client = await connect(server)

  const first = await requestShell(client)
  await waitFor(() => handlerCalls === 1)
  await expect(requestShell(client)).rejects.toThrow()

  expect(middlewareCalls).toBe(1)
  expect(handlerCalls).toBe(1)
  expect(errors).toEqual([])
  first.close()
})

liveLimitTest("the default permits one shell per connection", async () => {
  let handlerCalls = 0
  const server = track(
    createServer({ auth: "open", startupBanner: false, hostKey: { pem: HOST_KEY } }).serve(() => {
      handlerCalls++
    }),
  )
  const client = await connect(server)

  const first = await requestShell(client)
  await waitFor(() => handlerCalls === 1)
  await expect(requestShell(client)).rejects.toThrow()

  expect(handlerCalls).toBe(1)
  first.close()
})

liveLimitTest("global limit rejects excess shells across connections", async () => {
  let handlerCalls = 0
  const server = track(
    createServer({
      auth: "open",
      startupBanner: false,
      hostKey: { pem: HOST_KEY },
      limits: { session: { perConnection: 2, global: 2 } },
    }).serve(() => {
      handlerCalls++
    }),
  )
  const { port } = await server.listen(0)

  const first = await openShellOn(port)
  const second = await openShellOn(port)
  await waitFor(() => handlerCalls === 2)
  const thirdClient = await connectOn(port)
  await expect(requestShell(thirdClient)).rejects.toThrow()

  expect(handlerCalls).toBe(2)
  first.stream.close()
  second.stream.close()
})

liveLimitTest("closing a shell releases per-connection and global capacity", async () => {
  let handlerCalls = 0
  let closeCalls = 0
  const server = track(
    createServer({
      auth: "open",
      startupBanner: false,
      hostKey: { pem: HOST_KEY },
      limits: { session: { perConnection: 1, global: 1 } },
    }).serve((session) => {
      handlerCalls++
      session.onClose(() => closeCalls++)
    }),
  )
  const client = await connect(server)
  const first = await requestShell(client)
  await waitFor(() => handlerCalls === 1)
  await expect(requestShell(client)).rejects.toThrow()

  first.close()
  await waitFor(() => closeCalls === 1)
  const second = await requestShellEventually(client)
  await waitFor(() => handlerCalls === 2)

  expect(handlerCalls).toBe(2)
  second.close()
})

liveLimitTest("closing a shell releases global capacity for another connection", async () => {
  let handlerCalls = 0
  let closeCalls = 0
  const server = track(
    createServer({
      auth: "open",
      startupBanner: false,
      hostKey: { pem: HOST_KEY },
      limits: { session: { perConnection: 2, global: 1 } },
    }).serve((session) => {
      handlerCalls++
      session.onClose(() => closeCalls++)
    }),
  )
  const { port } = await server.listen(0)
  const first = await openShellOn(port)
  await waitFor(() => handlerCalls === 1)
  const secondClient = await connectOn(port)
  await expect(requestShell(secondClient)).rejects.toThrow()

  first.stream.close()
  await waitFor(() => closeCalls === 1)
  const second = await requestShellEventually(secondClient)
  await waitFor(() => handlerCalls === 2)

  expect(handlerCalls).toBe(2)
  second.close()
})

liveLimitTest("middleware denial releases capacity", async () => {
  let middlewareCalls = 0
  const server = track(
    createServer({
      auth: "open",
      startupBanner: false,
      hostKey: { pem: HOST_KEY },
      limits: { session: { perConnection: 1, global: 1 } },
    })
      .use((session) => {
        middlewareCalls++
        return session.deny("denied")
      })
      .serve(() => {}),
  )
  const client = await connect(server)

  const first = await requestShell(client)
  first.resume()
  await waitFor(() => middlewareCalls === 1)
  const second = await requestShellEventually(client)
  second.resume()
  await waitFor(() => middlewareCalls === 2)

  expect(middlewareCalls).toBe(2)
})

liveLimitTest("session.end releases capacity", async () => {
  let handlerCalls = 0
  const server = track(
    createServer({
      auth: "open",
      startupBanner: false,
      hostKey: { pem: HOST_KEY },
      limits: { session: { perConnection: 1, global: 1 } },
    }).serve((session) => {
      handlerCalls++
      session.end()
    }),
  )
  const client = await connect(server)

  const first = await requestShell(client)
  first.resume()
  await waitFor(() => handlerCalls === 1)
  const second = await requestShellEventually(client)
  second.resume()
  await waitFor(() => handlerCalls === 2)

  expect(handlerCalls).toBe(2)
})

liveLimitTest("server shutdown clears capacity before relisten", async () => {
  let handlerCalls = 0
  const server = track(
    createServer({
      auth: "open",
      startupBanner: false,
      hostKey: { pem: HOST_KEY },
      limits: { session: { perConnection: 1, global: 1 } },
    }).serve(() => {
      handlerCalls++
    }),
  )

  await openShellOn((await server.listen(0)).port)
  await waitFor(() => handlerCalls === 1)
  await server.close()
  await openShellOn((await server.listen(0)).port)
  await waitFor(() => handlerCalls === 2)

  expect(handlerCalls).toBe(2)
})

liveLimitTest("concurrent shell requests never exceed configured capacity", async () => {
  let live = 0
  let peak = 0
  const server = track(
    createServer({
      auth: "open",
      startupBanner: false,
      hostKey: { pem: HOST_KEY },
      limits: { session: { perConnection: 3, global: 3 } },
    }).serve((session) => {
      live++
      peak = Math.max(peak, live)
      session.onClose(() => live--)
    }),
  )
  const client = await connect(server)

  const results = await Promise.allSettled(Array.from({ length: 12 }, () => requestShell(client)))
  const accepted = results.filter(
    (result): result is PromiseFulfilledResult<ClientChannel> => result.status === "fulfilled",
  )
  const rejected = results.filter((result) => result.status === "rejected")
  await waitFor(() => live === 3)

  expect(accepted).toHaveLength(3)
  expect(rejected).toHaveLength(9)
  expect(peak).toBe(3)
  for (const result of accepted) result.value.close()
})
