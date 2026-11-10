import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { Client, utils, type ConnectConfig } from "ssh2"
import { TextRenderable } from "@opentui/core"
import { createServer } from "../../index.js"
import { parseOneKey, sha256Fingerprint } from "../../keys.js"
import type { AuthConfig, Identity } from "../../types.js"
import { createHarness, deferred, generateParseableKey as genKey, HOST_KEY, SHELL_PTY } from "../support.js"

const { conns, track, tmpDir } = createHarness()

/** OpenSSH-style SHA256 fingerprint of any parseable public/private key. */
function fingerprintOf(key: string | Buffer): string {
  const parsed = parseOneKey(key)
  if (!parsed) throw new Error("invalid test key")
  return sha256Fingerprint(parsed.getPublicSSH() as Buffer)
}

interface ConnectOpts {
  /** Answers fed to the ssh2 client's keyboard-interactive prompt round. */
  kbAnswers?: string[]
}

/** Wire the client's keyboard-interactive responder, if answers were supplied. */
function wireKeyboard(conn: Client, opts: ConnectOpts) {
  if (!opts.kbAnswers) return
  conn.on("keyboard-interactive", (_name, _instr, _lang, _prompts, finish) => finish(opts.kbAnswers!))
}

/** Connect, open a shell, and resolve with the server-side narrowed identity. */
async function captureIdentity(auth: AuthConfig, clientCfg: ConnectConfig, opts: ConnectOpts = {}): Promise<Identity> {
  const id = deferred<Identity>()
  const server = track(
    createServer({
      auth,
      startupBanner: false,
      hostKey: { pem: HOST_KEY },
    }).serve((s) => {
      s.renderer.root.add(new TextRenderable(s.renderer, { content: "auth" }))
      id.resolve(s.identity)
    }),
  )
  const { port } = await server.listen(0)

  const conn = new Client()
  conns.push(conn)
  wireKeyboard(conn, opts)
  await new Promise<void>((resolve, reject) => {
    conn
      .on("ready", () => {
        conn.shell(SHELL_PTY, (err) => {
          if (err) return reject(err)
          resolve()
        })
      })
      .on("error", reject)
      .connect({ host: "127.0.0.1", port, ...clientCfg })
  })
  return id.promise
}

/** Connect with the given auth/client config; resolve "ready" or "error". */
async function connectResult(
  auth: AuthConfig,
  clientCfg: ConnectConfig,
  opts: ConnectOpts = {},
): Promise<"ready" | "error"> {
  const server = track(
    createServer({
      auth,
      startupBanner: false,
      hostKey: { pem: HOST_KEY },
    }).serve(() => {}),
  )
  const { port } = await server.listen(0)

  const conn = new Client()
  conns.push(conn)
  wireKeyboard(conn, opts)
  return new Promise<"ready" | "error">((resolve) => {
    conn
      .on("ready", () => resolve("ready"))
      .on("error", () => resolve("error"))
      .connect({ host: "127.0.0.1", port, ...clientCfg })
  })
}

// Live SSH auth smoke tests. Policy edge-cases live in unit/authenticator.test.ts;
// this file keeps only representative ssh2 client/server handshakes.

test("publickey 'any' accepts and identifies the client key", async () => {
  const key = genKey()
  const identity = await captureIdentity({ publicKey: "any" }, { username: "alice", privateKey: key.private })
  expect(identity.method).toBe("publickey")
  expect(identity.username).toBe("alice")
  if (identity.method === "publickey") {
    expect(identity.fingerprint).toBe(fingerprintOf(key.public))
    expect(identity.publicKey.algorithm).toBe("ssh-ed25519")
    expect(Buffer.isBuffer(identity.publicKey.blob)).toBe(true)
  }
})

for (const [name, pair, algorithm] of [
  ["RSA", () => utils.generateKeyPairSync("rsa", { bits: 2048 }), "ssh-rsa"],
  ["ECDSA P-256", () => utils.generateKeyPairSync("ecdsa", { bits: 256 }), "ecdsa-sha2-nistp256"],
] as const) {
  test(`publickey authentication accepts a live ${name} client`, async () => {
    const key = pair()
    const identity = await captureIdentity({ publicKey: "any" }, { username: "alice", privateKey: key.private })
    expect(identity.method).toBe("publickey")
    if (identity.method === "publickey") {
      expect(identity.fingerprint).toBe(fingerprintOf(key.public))
      expect(identity.publicKey.algorithm).toBe(algorithm)
    }
  })
}

test("authorizedKeys allowlist (file path) is read from disk", async () => {
  const dir = tmpDir("ssh-authkeys-")
  const listed = genKey()
  const file = join(dir, "authorized_keys")
  writeFileSync(file, `# a comment\n${listed.public}\n`)

  const identity = await captureIdentity(
    { publicKey: { authorizedKeys: file } },
    { username: "dave", privateKey: listed.private },
  )
  expect(identity.method).toBe("publickey")
})

test("password accepts the correct password and rejects wrong ones", async () => {
  const auth: AuthConfig = { password: ({ password }) => password === "hunter2" }

  const identity = await captureIdentity(auth, { username: "erin", password: "hunter2" })
  expect(identity.method).toBe("password")
  expect(identity.username).toBe("erin")

  const rejected = await connectResult(auth, { username: "erin", password: "nope" })
  expect(rejected).toBe("error")
})

test("keyboard-interactive bridges prompts and accepts a correct answer", async () => {
  const auth: AuthConfig = {
    keyboardInteractive: async ({ prompt }) => {
      const [answer] = await prompt([{ prompt: "Code: ", echo: false }])
      return answer === "1234"
    },
  }

  const identity = await captureIdentity(auth, { username: "frank", tryKeyboard: true }, { kbAnswers: ["1234"] })
  expect(identity.method).toBe("keyboard-interactive")
  expect(identity.username).toBe("frank")
})

test("disconnecting during asynchronous authentication creates no session", async () => {
  const started = deferred<void>()
  const decision = deferred<boolean>()
  let sessions = 0
  const errors: unknown[] = []
  const server = track(
    createServer({
      auth: {
        password: async () => {
          started.resolve()
          return decision.promise
        },
      },
      startupBanner: false,
      hostKey: { pem: HOST_KEY },
      onError: (error) => errors.push(error),
    }).serve(() => {
      sessions++
    }),
  )
  const { port } = await server.listen(0)
  const conn = new Client()
  conns.push(conn)
  const closed = new Promise<void>((resolve) => conn.on("close", () => resolve()))
  conn.on("error", () => {}).connect({ host: "127.0.0.1", port, username: "late", password: "secret" })

  await started.promise
  conn.end()
  await closed
  decision.resolve(true)
  await new Promise((resolve) => setTimeout(resolve, 25))

  expect(sessions).toBe(0)
  expect(errors).toEqual([])
})
