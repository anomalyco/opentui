import { EventEmitter } from "node:events"
import { expect, test } from "bun:test"
import type { AuthContext, ClientInfo, Connection } from "ssh2"
import type { AuthOutcome } from "../../auth.js"
import { createConnectionHandler } from "../../connection.js"
import { createSafeInvoke } from "../../safe.js"
import { deferred, TestChannel, waitFor } from "../support.js"

type HandlerOptions = Parameters<typeof createConnectionHandler>[0]

const clientInfo = { ip: "127.0.0.1", port: 1234 } as ClientInfo
const accept = async (): Promise<AuthOutcome> => ({ type: "accept", identity: { method: "none", username: "x" } })
const reject = async (): Promise<AuthOutcome> => ({ type: "reject", methods: ["none"] })

function testHandler(options: Partial<HandlerOptions> & { handle?: HandlerOptions["authenticator"]["handle"] } = {}) {
  const { handle = reject, ...rest } = options
  return createConnectionHandler({
    authenticator: { advertisedMethods: () => ["none"], authenticate: reject, handle },
    middlewares: [],
    handler: () => {},
    safe: createSafeInvoke(() => {}),
    idleTimeoutMs: undefined,
    maxTimeoutMs: undefined,
    sessionLimits: { perConnection: 1, global: 1 },
    ...rest,
  })
}

/** ssh2 client `Connection` stand-in that counts `end()` and socket destruction. */
function testClient(setNoDelay: (this: EventEmitter, enabled: boolean) => void = () => {}) {
  const calls = { end: 0, destroy: 0 }
  const client = Object.assign(new EventEmitter(), {
    setNoDelay,
    end: () => void calls.end++,
    _sock: { destroy: () => void calls.destroy++ },
  }) as unknown as Connection
  return { client, calls }
}

/** Requests a shell on a new ssh2 session and returns how the server answered it. */
function requestShell(client: Connection, channel: unknown = new TestChannel()) {
  const result = { accepted: 0, rejected: 0 }
  const sshSession = new EventEmitter()
  client.emit("session", () => sshSession)
  sshSession.emit(
    "shell",
    () => {
      result.accepted++
      return channel
    },
    () => result.rejected++,
  )
  return result
}

test("each accepted connection disables Nagle's algorithm", async () => {
  const errors: unknown[] = []
  const noDelay: boolean[] = []
  const { client } = testClient((enabled) => noDelay.push(enabled))
  const handler = testHandler({ safe: createSafeInvoke((error) => errors.push(error)) })
  try {
    handler.onConnection(client, clientInfo)
    expect(noDelay).toEqual([true])
    expect(errors).toEqual([])
  } finally {
    await handler.closeAll()
  }
})

test("a no-delay transport failure preserves connection cleanup", async () => {
  const failure = new Error("custom transport failure")
  const errors: unknown[] = []
  const { client, calls } = testClient(function () {
    this.emit("close")
    throw failure
  })
  const handler = testHandler({ safe: createSafeInvoke((error) => errors.push(error)) })
  try {
    expect(() => handler.onConnection(client, clientInfo)).not.toThrow()
    expect(errors).toEqual([failure])
  } finally {
    await handler.closeAll()
  }
  expect(calls).toEqual({ end: 0, destroy: 0 })
})

test("an authentication decision is ignored after the connection closes", async () => {
  const started = deferred<void>()
  const decision = deferred<void>()
  let accepts = 0
  let rejects = 0
  const { client } = testClient()
  const handler = testHandler({
    sessionLimits: { perConnection: 1, global: 100 },
    async handle() {
      started.resolve()
      await decision.promise
      return { type: "accept", identity: { method: "none", username: "late" } }
    },
  })
  handler.onConnection(client, clientInfo)
  handler.setAccepting(true)
  client.emit("authentication", {
    method: "none",
    username: "late",
    accept: () => accepts++,
    reject: () => rejects++,
  } as unknown as AuthContext)
  await started.promise
  client.emit("close")
  decision.resolve()
  await Promise.resolve()
  await Promise.resolve()

  expect(accepts).toBe(0)
  expect(rejects).toBe(0)
})

test("native closeAll force-closes a client that never drains", async () => {
  const errors: unknown[] = []
  const channel = new TestChannel()
  channel.hold()
  const { client, calls } = testClient()
  const handler = testHandler({
    handle: accept,
    middlewares: [(session) => session.write("never drains")],
    safe: createSafeInvoke((error) => errors.push(error)),
    sessionLimits: { perConnection: 1, global: 100 },
  })
  handler.onConnection(client, clientInfo)
  handler.setAccepting(true)
  client.emit("ready")
  requestShell(client, channel)
  await Promise.resolve()
  await Promise.resolve()

  await handler.closeAll()
  expect(calls.destroy).toBe(1)
  expect(channel.exits).toEqual([1])
  expect(errors.some((error) => error instanceof Error && /without restoration/.test(error.message))).toBe(true)
})

test("closeAll rejects late shells while waiting for a logically closed bridge's write acknowledgement", async () => {
  const channel = new TestChannel()
  channel.hold()
  const { client, calls } = testClient()
  const handler = testHandler({
    handle: accept,
    middlewares: [(session) => session.write("pending")],
    sessionLimits: { perConnection: 2, global: 2 },
  })
  handler.onConnection(client, clientInfo)
  handler.setAccepting(true)
  client.emit("ready")
  requestShell(client, channel)
  await waitFor(() => channel.pendingWrite)

  let closed = false
  const closing = handler.closeAll().then(() => {
    closed = true
  })
  await Promise.resolve()
  expect(requestShell(client, channel)).toEqual({ accepted: 0, rejected: 1 })
  expect(closed).toBe(false)
  expect(calls.end).toBe(0)
  channel.release()
  await closing
  expect(calls.end).toBe(1)
})

test("a bridge setup failure releases reserved capacity", () => {
  const errors: unknown[] = []
  const { client } = testClient()
  const handler = testHandler({ handle: accept, safe: createSafeInvoke((error) => errors.push(error)) })
  handler.onConnection(client, clientInfo)
  handler.setAccepting(true)
  client.emit("ready")

  for (let shell = 0; shell < 2; shell++) expect(requestShell(client, {})).toEqual({ accepted: 1, rejected: 0 })
  expect(errors).toHaveLength(2)
})

test("per-connection and global limits reject before accepting a shell", async () => {
  const handler = testHandler({
    handle: accept,
    middlewares: [() => new Promise(() => {})],
    sessionLimits: { perConnection: 1, global: 2 },
  })
  handler.setAccepting(true)
  const connect = () => {
    const { client } = testClient()
    handler.onConnection(client, clientInfo)
    client.emit("ready")
    return client
  }

  const firstClient = connect()
  expect(requestShell(firstClient)).toEqual({ accepted: 1, rejected: 0 })
  expect(requestShell(firstClient)).toEqual({ accepted: 0, rejected: 1 })
  expect(requestShell(connect())).toEqual({ accepted: 1, rejected: 0 })
  expect(requestShell(connect())).toEqual({ accepted: 0, rejected: 1 })

  await handler.closeAll()
})
