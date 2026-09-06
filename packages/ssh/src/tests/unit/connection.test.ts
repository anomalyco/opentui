import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import { Duplex } from "node:stream"
import { expect, spyOn, test } from "bun:test"
import { NativeSession } from "@opentui/core"
import type { AuthContext, ClientInfo, Connection } from "ssh2"
import { createConnectionHandler } from "../../connection.js"
import { createSafeInvoke } from "../../safe.js"
import { deferred, waitFor } from "../support.js"

const require = createRequire(import.meta.url)

test("connections enable no-delay exactly once before authentication and session work", async () => {
  const events: string[] = []
  const noDelay: boolean[] = []
  const client = Object.assign(new EventEmitter(), {
    setNoDelay(enabled: boolean) {
      noDelay.push(enabled)
      events.push("no-delay")
      return this
    },
    end() {},
    _sock: { destroy() {} },
  }) as unknown as Connection
  const handler = createConnectionHandler({
    authenticator: {
      advertisedMethods: () => ["none"],
      authenticate: async () => ({ type: "reject", methods: ["none"] }),
      async handle() {
        events.push("authentication")
        return { type: "accept", identity: { method: "none", username: "test" } }
      },
    },
    middlewares: [],
    handler: () => {},
    safe: createSafeInvoke(() => {}),
    idleTimeoutMs: undefined,
    maxTimeoutMs: undefined,
    sessionLimits: { perConnection: 1, global: 1 },
  })
  try {
    handler.onConnection(client, { ip: "127.0.0.1", port: 1234 } as ClientInfo)
    expect(noDelay).toEqual([true])
    const authenticated = deferred<void>()
    client.emit("authentication", {
      accept: () => authenticated.resolve(),
    } as unknown as AuthContext)
    await authenticated.promise
    client.emit("ready")
    client.emit("session", () => {
      events.push("session")
      return new EventEmitter()
    })
    expect(events).toEqual(["no-delay", "authentication", "session"])
    expect(noDelay).toEqual([true])
  } finally {
    client.emit("close")
    await handler.closeAll()
  }
})

test("a no-delay transport failure preserves connection cleanup", async () => {
  const failure = new Error("custom transport failure")
  const errors: unknown[] = []
  let endCalls = 0
  let destroyCalls = 0
  const client = Object.assign(new EventEmitter(), {
    setNoDelay(this: EventEmitter) {
      this.emit("close")
      throw failure
    },
    end() {
      endCalls++
    },
    _sock: {
      destroy() {
        destroyCalls++
      },
    },
  }) as unknown as Connection
  const handler = createConnectionHandler({
    authenticator: {
      advertisedMethods: () => ["none"],
      authenticate: async () => ({ type: "reject", methods: ["none"] }),
      handle: async () => ({ type: "reject", methods: ["none"] }),
    },
    middlewares: [],
    handler: () => {},
    safe: createSafeInvoke((error) => errors.push(error)),
    idleTimeoutMs: undefined,
    maxTimeoutMs: undefined,
    sessionLimits: { perConnection: 1, global: 1 },
  })
  try {
    expect(() => handler.onConnection(client, { ip: "127.0.0.1", port: 1234 } as ClientInfo)).not.toThrow()
    expect(errors).toEqual([failure])
  } finally {
    await handler.closeAll()
  }
  expect(endCalls).toBe(0)
  expect(destroyCalls).toBe(0)
})

test("an authentication decision is ignored after the connection closes", async () => {
  const started = deferred<void>()
  const decision = deferred<void>()
  let accepts = 0
  let rejects = 0
  const client = Object.assign(new EventEmitter(), {
    setNoDelay() {},
    end() {},
    _sock: { destroy() {} },
  }) as unknown as Connection
  const handler = createConnectionHandler({
    authenticator: {
      advertisedMethods: () => ["none"],
      authenticate: async () => ({ type: "reject", methods: ["none"] }),
      async handle() {
        started.resolve()
        await decision.promise
        return { type: "accept", identity: { method: "none", username: "late" } }
      },
    },
    middlewares: [],
    handler: () => {},
    safe: createSafeInvoke(() => {}),
    idleTimeoutMs: undefined,
    maxTimeoutMs: undefined,
    sessionLimits: { perConnection: 1, global: 100 },
  })
  handler.onConnection(client, { ip: "127.0.0.1", port: 1234 } as ClientInfo)
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

test("connection loss cancels a native Session while ssh2 channel EOF is behind paused input", async () => {
  const { Channel, MAX_WINDOW, PACKET_SIZE } = require("ssh2/lib/Channel.js")
  const { ChannelManager } = require("ssh2/lib/utils.js")
  const middleware = deferred<void>()
  const errors: unknown[] = []
  let driver: NativeSession | undefined
  let closes = 0
  let handlers = 0
  let channelCloses = 0
  const write = NativeSession.prototype.write
  const capture = spyOn(NativeSession.prototype, "write").mockImplementation(function (this: NativeSession, bytes) {
    driver = this
    return write.call(this, bytes)
  })
  const client = Object.assign(new EventEmitter(), {
    setNoDelay() {},
    end() {},
    _sock: { destroy() {} },
    _protocol: { channelData() {}, channelEOF() {}, channelClose() {}, channelWindowAdjust() {} },
    _chanMgr: undefined as any,
  })
  client._chanMgr = new ChannelManager(client)
  const channel = new Channel(
    client,
    {
      type: "session",
      incoming: { id: 0, window: MAX_WINDOW, packetSize: PACKET_SIZE, state: "open" },
      outgoing: { id: 0, window: 0, packetSize: PACKET_SIZE, state: "open" },
    },
    { server: true },
  ) as Duplex
  client._chanMgr.add(channel)
  channel.on("close", () => {
    channelCloses++
  })
  const handler = createConnectionHandler({
    authenticator: {
      advertisedMethods: () => ["none"],
      authenticate: async () => ({ type: "reject", methods: ["none"] }),
      handle: async () => ({ type: "accept", identity: { method: "none", username: "paused" } }),
    },
    middlewares: [
      async (session, next) => {
        session.onClose(() => {
          closes++
        })
        session.write("held behind the SSH window")
        await middleware.promise
        return next()
      },
    ],
    handler: () => {
      handlers++
    },
    safe: createSafeInvoke((error) => errors.push(error)),
    idleTimeoutMs: undefined,
    maxTimeoutMs: undefined,
    sessionLimits: { perConnection: 1, global: 1 },
  })
  try {
    handler.onConnection(client as unknown as Connection, { ip: "127.0.0.1", port: 1234 } as ClientInfo)
    handler.setAccepting(true)
    client.emit("ready")
    const sshSession = new EventEmitter()
    client.emit("session", () => sshSession)
    sshSession.emit("shell", () => channel)
    channel.push(Buffer.alloc(65_536))
    await waitFor(() => channel.isPaused() && channel.writableLength > 0)
    channel.push(Buffer.from("unread"))
    expect(channel.readableLength).toBeGreaterThan(0)
    expect(driver?.disposed).toBe(false)

    client.emit("close")
    // ssh2 emits connection close before its ChannelManager supplies EOF.
    expect(channelCloses).toBe(0)
    expect(driver?.disposed).toBe(true)
    expect(closes).toBe(1)
    expect(channel.listenerCount("data")).toBe(0)
    client._chanMgr.cleanup(new Error("connection lost"))
    await waitFor(() => channelCloses === 1)
    await handler.closeAll()
    expect(channel.listenerCount("drain")).toBe(0)
    expect(channel.listenerCount("error")).toBe(0)
    expect(handlers).toBe(0)
    expect(closes).toBe(1)
    expect(errors).toEqual([])
    expect(driver?.error).toBeInstanceOf(Error)
  } finally {
    middleware.resolve()
    driver?.dispose()
    channel.resume()
    client._chanMgr.cleanup(new Error("test cleanup"))
    await handler.closeAll()
    capture.mockRestore()
  }
})

test("native closeAll force-closes a client that never drains", async () => {
  const errors: unknown[] = []
  const channel = Object.assign(new Duplex({ read() {}, write() {} }), {
    exit() {},
    close(this: Duplex) {
      this.destroy()
    },
  })
  const sshSession = new EventEmitter()
  let socketDestroyCalls = 0
  const client = Object.assign(new EventEmitter(), {
    setNoDelay() {},
    end() {},
    _sock: {
      destroy() {
        socketDestroyCalls++
      },
    },
  }) as unknown as Connection
  const handler = createConnectionHandler({
    authenticator: {
      advertisedMethods: () => ["none"],
      authenticate: async () => ({ type: "reject", methods: ["none"] }),
      handle: async () => ({ type: "accept", identity: { method: "none", username: "x" } }),
    },
    middlewares: [
      (session) => {
        session.write("never drains")
      },
    ],
    handler: () => {},
    safe: createSafeInvoke((error) => errors.push(error)),
    idleTimeoutMs: undefined,
    maxTimeoutMs: undefined,
    sessionLimits: { perConnection: 1, global: 100 },
  })
  handler.onConnection(client, { ip: "127.0.0.1", port: 1234 } as ClientInfo)
  handler.setAccepting(true)
  client.emit("ready")
  client.emit("session", () => sshSession)
  sshSession.emit("shell", () => channel)
  await Promise.resolve()
  await Promise.resolve()

  await handler.closeAll()
  expect(socketDestroyCalls).toBe(1)

  expect(errors.some((error) => error instanceof Error && /without restoration/.test(error.message))).toBe(true)
})

test("closeAll rejects late shells while waiting for a logically closed bridge's write acknowledgement", async () => {
  let rawCallback: (() => void) | undefined
  const channel = Object.assign(
    new Duplex({
      read() {},
      write(_data, _encoding, callback) {
        rawCallback = callback
      },
    }),
    {
      exit() {},
      close(this: Duplex) {
        this.destroy()
      },
    },
  )
  let clientEndCalls = 0
  const client = Object.assign(new EventEmitter(), {
    setNoDelay() {},
    end() {
      clientEndCalls++
    },
    _sock: { destroy() {} },
  }) as unknown as Connection
  const handler = createConnectionHandler({
    authenticator: {
      advertisedMethods: () => ["none"],
      authenticate: async () => ({ type: "reject", methods: ["none"] }),
      handle: async () => ({ type: "accept", identity: { method: "none", username: "x" } }),
    },
    middlewares: [
      (session) => {
        session.write("pending")
      },
    ],
    handler: () => {},
    safe: createSafeInvoke(() => {}),
    idleTimeoutMs: undefined,
    maxTimeoutMs: undefined,
    sessionLimits: { perConnection: 2, global: 2 },
  })
  handler.onConnection(client, { ip: "127.0.0.1", port: 1234 } as ClientInfo)
  handler.setAccepting(true)
  client.emit("ready")

  const firstSession = new EventEmitter()
  client.emit("session", () => firstSession)
  firstSession.emit(
    "shell",
    () => channel,
    () => {},
  )
  await waitFor(() => rawCallback !== undefined)

  let closed = false
  const closing = handler.closeAll().then(() => {
    closed = true
  })
  await Promise.resolve()
  let accepted = 0
  let rejected = 0
  const lateSession = new EventEmitter()
  client.emit("session", () => lateSession)
  lateSession.emit(
    "shell",
    () => {
      accepted++
      return channel
    },
    () => rejected++,
  )

  expect(accepted).toBe(0)
  expect(rejected).toBe(1)
  expect(closed).toBe(false)
  expect(clientEndCalls).toBe(0)
  rawCallback?.()
  await closing
  expect(clientEndCalls).toBe(1)
})

test("a bridge setup failure releases reserved capacity", () => {
  const errors: unknown[] = []
  const client = Object.assign(new EventEmitter(), {
    setNoDelay() {},
    end() {},
    _sock: { destroy() {} },
  }) as unknown as Connection
  const handler = createConnectionHandler({
    authenticator: {
      advertisedMethods: () => ["none"],
      authenticate: async () => ({ type: "reject", methods: ["none"] }),
      handle: async () => ({ type: "accept", identity: { method: "none", username: "x" } }),
    },
    middlewares: [],
    handler: () => {},
    safe: createSafeInvoke((error) => errors.push(error)),
    idleTimeoutMs: undefined,
    maxTimeoutMs: undefined,
    sessionLimits: { perConnection: 1, global: 1 },
  })
  handler.onConnection(client, { ip: "127.0.0.1", port: 1234 } as ClientInfo)
  handler.setAccepting(true)
  client.emit("ready")

  let accepts = 0
  let rejects = 0
  for (let i = 0; i < 2; i++) {
    const sshSession = new EventEmitter()
    client.emit("session", () => sshSession)
    sshSession.emit(
      "shell",
      () => {
        accepts++
        return {}
      },
      () => rejects++,
    )
  }

  expect(accepts).toBe(2)
  expect(rejects).toBe(0)
  expect(errors).toHaveLength(2)
})

test("per-connection and global limits reject before accepting a shell", async () => {
  const connectionHandler = createConnectionHandler({
    authenticator: {
      advertisedMethods: () => ["none"],
      authenticate: async () => ({ type: "reject", methods: ["none"] }),
      handle: async () => ({ type: "accept", identity: { method: "none", username: "x" } }),
    },
    middlewares: [() => new Promise(() => {})],
    handler: () => {},
    safe: createSafeInvoke(() => {}),
    idleTimeoutMs: undefined,
    maxTimeoutMs: undefined,
    sessionLimits: { perConnection: 1, global: 2 },
  })
  connectionHandler.setAccepting(true)

  const connect = () => {
    const client = Object.assign(new EventEmitter(), {
      setNoDelay() {},
      end() {},
      _sock: { destroy() {} },
    }) as unknown as Connection
    connectionHandler.onConnection(client, { ip: "127.0.0.1", port: 1234 } as ClientInfo)
    client.emit("ready")
    return client
  }
  const requestShell = (client: Connection) => {
    const sshSession = new EventEmitter()
    const channel = Object.assign(
      new Duplex({
        read() {},
        write(_data, _encoding, callback) {
          callback()
        },
      }),
      {
        exit() {},
        close(this: Duplex) {
          this.destroy()
        },
      },
    )
    let accepted = 0
    let rejected = 0
    client.emit("session", () => sshSession)
    sshSession.emit(
      "shell",
      () => {
        accepted++
        return channel
      },
      () => rejected++,
    )
    return { accepted, rejected }
  }

  const firstClient = connect()
  expect(requestShell(firstClient)).toEqual({ accepted: 1, rejected: 0 })
  expect(requestShell(firstClient)).toEqual({ accepted: 0, rejected: 1 })
  expect(requestShell(connect())).toEqual({ accepted: 1, rejected: 0 })
  expect(requestShell(connect())).toEqual({ accepted: 0, rejected: 1 })

  await connectionHandler.closeAll()
})
