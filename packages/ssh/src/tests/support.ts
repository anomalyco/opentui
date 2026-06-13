import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach } from "bun:test"
import { Client, utils } from "ssh2"
import type { ClientChannel } from "ssh2"
import { createServer } from "../index.js"
import type { Server, ServerConfig, SessionHandler } from "../types.js"

export function generateParseableKey(): { private: string; public: string } {
  for (let i = 0; i < 20; i++) {
    const pair = utils.generateKeyPairSync("ed25519") as unknown as { private: string; public: string }
    if (!(utils.parseKey(pair.private) instanceof Error) && !(utils.parseKey(pair.public) instanceof Error)) return pair
  }
  throw new Error("could not generate a parseable ed25519 key")
}

/**
 * One parseable ed25519 host key, generated once and shared across tests.
 * ssh2's keygen occasionally emits a key its own parser rejects ("Malformed
 * OpenSSH private key"); retry past it.
 */
export const HOST_KEY: string = generateParseableKey().private

/** The PTY request a shell test opens with. */
export interface ShellPtyInfo {
  term: string
  cols: number
  rows: number
  width: number
  height: number
}

export const SHELL_PTY: ShellPtyInfo = { term: "xterm-256color", cols: 80, rows: 24, width: 0, height: 0 }

/** An externally-resolvable promise — the await-a-server-side-event idiom. */
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export type Shell = { conn: Client; stream: ClientChannel }
export type ShellPty = ShellPtyInfo | false

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitFor(pred: () => boolean, timeoutMs = 8000, step = 25): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out")
    await sleep(step)
  }
}

export interface Harness {
  /** Servers stood up this test; closed in afterEach. */
  readonly servers: Server[]
  /** Clients opened this test; ended in afterEach. */
  readonly conns: Client[]
  /** Temp dirs created this test; removed in afterEach. */
  readonly dirs: string[]
  /** Track a server for teardown; returns it. */
  track(server: Server): Server
  /** Stand up a tracked open-auth server (shared host key, banner off). */
  mkServer(
    handler: SessionHandler,
    extra?: Pick<ServerConfig, "idleTimeout" | "maxTimeout" | "limits" | "onError">,
  ): Server
  /** mkdtemp under os.tmpdir(), tracked for removal. */
  tmpDir(prefix?: string): string
  /** Connect a tracked client (no shell); resolve once ready. */
  connect(server: Server, username?: string): Promise<Client>
  connectOn(port: number, username?: string): Promise<Client>
  /** Connect a tracked client and open a shell; resolve { conn, stream }. */
  openShell(server: Server, username?: string, pty?: ShellPty): Promise<Shell>
  openShellOn(port: number, username?: string, pty?: ShellPty): Promise<Shell>
}

/**
 * Per-file test harness: tracking arrays plus an afterEach that ends every
 * client, closes every server, and removes every temp dir. Call once at the top
 * of a test file and destructure the helpers you need.
 */
export function createHarness(): Harness {
  const servers: Server[] = []
  const conns: Client[] = []
  const dirs: string[] = []

  afterEach(async () => {
    for (const c of conns) {
      try {
        c.end()
      } catch {
        // best-effort
      }
    }
    conns.length = 0
    await Promise.all(servers.map((s) => s.close().catch(() => {})))
    servers.length = 0
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
    dirs.length = 0
  })

  const track = (server: Server): Server => {
    servers.push(server)
    return server
  }

  const mkServer: Harness["mkServer"] = (handler, extra) =>
    track(createServer({ auth: "open", startupBanner: false, hostKey: { pem: HOST_KEY }, ...extra }).serve(handler))

  const tmpDir = (prefix = "opentui-ssh-"): string => {
    const d = mkdtempSync(join(tmpdir(), prefix))
    dirs.push(d)
    return d
  }

  const connectOn: Harness["connectOn"] = (port, username = "guest") => {
    const conn = new Client()
    conns.push(conn)
    return new Promise<Client>((resolve, reject) => {
      conn
        .on("ready", () => resolve(conn))
        .on("error", reject)
        .connect({ host: "127.0.0.1", port, username })
    })
  }

  const connect: Harness["connect"] = async (server, username) => {
    const { port } = await server.listen(0)
    return connectOn(port, username)
  }

  const openShellOn: Harness["openShellOn"] = (port, username = "guest", pty = SHELL_PTY) => {
    const conn = new Client()
    conns.push(conn)
    return new Promise<Shell>((resolve, reject) => {
      conn
        .on("ready", () => {
          conn.shell(pty, (err, stream) => {
            if (err) return reject(err)
            resolve({ conn, stream })
          })
        })
        .on("error", reject)
        .connect({ host: "127.0.0.1", port, username })
    })
  }

  const openShell: Harness["openShell"] = async (server, username, pty) => {
    const { port } = await server.listen(0)
    return openShellOn(port, username, pty)
  }

  return { servers, conns, dirs, track, mkServer, tmpDir, connect, connectOn, openShell, openShellOn }
}
