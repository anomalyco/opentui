import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, spyOn, test } from "bun:test"
import { utils } from "ssh2"
import { createServer } from "../../index.js"
import { parseOneKey, sha256Fingerprint } from "../../keys.js"
import { createHarness, HOST_KEY } from "../support.js"

const { track, tmpDir } = createHarness()

test("listen reports every configured host-key fingerprint", async () => {
  const ed25519 = utils.generateKeyPairSync("ed25519").private
  const rsa = utils.generateKeyPairSync("rsa", { bits: 2048 }).private
  const expected = [ed25519, rsa].map((pem) => {
    const key = parseOneKey(pem)
    if (!key) throw new Error("generated host key did not parse")
    return sha256Fingerprint(key.getPublicSSH() as Buffer)
  })
  const server = track(
    createServer({ auth: "open", startupBanner: false, hostKey: { pem: [ed25519, rsa] } }).serve(() => {}),
  )
  const info = await server.listen(0)

  expect(info.fingerprints).toEqual(expected)
})

test("generates and persists a missing host key with 0600 permissions", async () => {
  const path = join(tmpDir(), "host_key")
  expect(existsSync(path)).toBe(false)
  const s = track(createServer({ hostKey: { path }, auth: "open", startupBanner: false }).serve(() => {}))
  await s.listen(0)
  expect(existsSync(path)).toBe(true)
  // 0600 is a Unix-only guarantee. Windows has no POSIX mode bits — it reports 0666
  // for any writable file regardless of chmod — so the perms assertion can't hold there.
  if (process.platform !== "win32") {
    expect(statSync(path).mode & 0o777).toBe(0o600)
  }
})

test("reuses the same host key (stable fingerprint) across restarts", async () => {
  const path = join(tmpDir(), "host_key")
  const a = track(createServer({ hostKey: { path }, auth: "open", startupBanner: false }).serve(() => {}))
  const infoA = await a.listen(0)
  const b = track(createServer({ hostKey: { path }, auth: "open", startupBanner: false }).serve(() => {}))
  const infoB = await b.listen(0)
  expect(infoB.fingerprints).toEqual(infoA.fingerprints)
})

test("concurrent creators converge on the persisted host key", async () => {
  const dir = tmpDir("ssh-hostkey-race-")
  const path = join(dir, "host_key")
  const barrier = join(dir, "go")
  const fixture = fileURLToPath(new URL("./hostkey-race.fixture.ts", import.meta.url))
  const children = Array.from({ length: 12 }, () =>
    Bun.spawn([process.execPath, fixture, path, barrier], { stdout: "pipe", stderr: "pipe" }),
  )
  writeFileSync(barrier, "")

  const results = await Promise.all(
    children.map(async (child) => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (exitCode !== 0) throw new Error(stderr)
      return JSON.parse(stdout) as { fingerprint: string }
    }),
  )
  const persisted = parseOneKey(readFileSync(path))
  if (!persisted) throw new Error("persisted host key did not parse")
  const persistedFingerprint = sha256Fingerprint(persisted.getPublicSSH() as Buffer)

  expect(new Set(results.map((result) => result.fingerprint))).toEqual(new Set([persistedFingerprint]))
})

test("generated host keys are validated before persisting and retried", () => {
  const path = join(tmpDir(), "host_key")
  let calls = 0
  const spy = spyOn(utils, "generateKeyPairSync").mockImplementation(() => {
    calls++
    return { private: calls === 1 ? "not a key" : HOST_KEY, public: "" } as never
  })
  try {
    track(createServer({ hostKey: { path }, auth: "open", startupBanner: false }).serve(() => {}))
    expect(calls).toBe(2)
    expect(readFileSync(path, "utf8")).toBe(HOST_KEY)
  } finally {
    spy.mockRestore()
  }
})
