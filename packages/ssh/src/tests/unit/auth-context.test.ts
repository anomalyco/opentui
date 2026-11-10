import { expect, test } from "bun:test"
import type { AuthContext } from "ssh2"
import { attemptFromAuthContext } from "../../auth.js"

// `attemptFromAuthContext` adapts ssh2's live `AuthContext` into a plain `AuthAttempt`,
// making the security-critical wiring (which key/signature/blob the verifier
// later checks) a pure, unit-testable mapping.

// `attemptFromAuthContext` reads only `method`, `username`, and the per-method payload —
// never `accept()`/`reject()` — so a partial cast stands in for the live context.
function ctx(partial: object): AuthContext {
  return partial as unknown as AuthContext
}

test("none: maps to a none attempt carrying the username", () => {
  const attempt = attemptFromAuthContext(ctx({ method: "none", username: "guest" }))
  expect(attempt).toEqual({ method: "none", username: "guest" })
})

test("password: carries the username and the client-supplied password", () => {
  const attempt = attemptFromAuthContext(ctx({ method: "password", username: "erin", password: "hunter2" }))
  expect(attempt).toEqual({ method: "password", username: "erin", password: "hunter2" })
})

// The verifier checks `signature` over `blob` using `key`/`hashAlgo`; if the
// mapping dropped or swapped any of them, verification would silently break.
test("publickey signed pass: key/signature/blob/hashAlgo pass through verbatim", () => {
  const key = { algo: "ssh-ed25519", data: Buffer.from("public-key-blob") }
  const signature = Buffer.from("signature-bytes")
  const blob = Buffer.from("session-id-blob")
  const attempt = attemptFromAuthContext(
    ctx({ method: "publickey", username: "alice", key, signature, blob, hashAlgo: "ssh-ed25519" }),
  )
  expect(attempt).toEqual({
    method: "publickey",
    username: "alice",
    key: { algorithm: "ssh-ed25519", blob: Buffer.from("public-key-blob") },
    signature: Buffer.from("signature-bytes"),
    blob: Buffer.from("session-id-blob"),
    hashAlgo: "ssh-ed25519",
  })
})

test("keyboard-interactive: bridges ctx.prompt's callback into a promise", async () => {
  const asked: unknown[] = []
  const attempt = attemptFromAuthContext(
    ctx({
      method: "keyboard-interactive",
      username: "frank",
      prompt: (questions: unknown, cb: (answers?: string[]) => void) => {
        asked.push(questions)
        cb(["1234"])
      },
    }),
  )
  if (attempt?.method !== "keyboard-interactive") throw new Error("expected a keyboard-interactive attempt")

  const answers = await attempt.prompt([{ prompt: "Code: ", echo: false }])
  expect(answers).toEqual(["1234"])
  // questions reach ssh2's prompt unchanged
  expect(asked).toEqual([[{ prompt: "Code: ", echo: false }]])
})

test("keyboard-interactive: a missing (undefined) answer set resolves to []", async () => {
  const attempt = attemptFromAuthContext(
    ctx({
      method: "keyboard-interactive",
      username: "frank",
      // ssh2 calls back with no answers (e.g. the client aborted the prompt).
      prompt: (_questions: unknown, cb: (answers?: string[]) => void) => cb(undefined),
    }),
  )
  if (attempt?.method !== "keyboard-interactive") throw new Error("expected a keyboard-interactive attempt")

  expect(await attempt.prompt([])).toEqual([])
})

// Two-phase publickey: the first-pass probe asks "is this key OK?" and carries no
// signature, so the mapping must leave signature/blob/hashAlgo absent — the
// Authenticator then answers PK_OK instead of minting an identity.
test("publickey probe: signature/blob/hashAlgo are absent", () => {
  const attempt = attemptFromAuthContext(
    ctx({ method: "publickey", username: "alice", key: { algo: "ssh-ed25519", data: Buffer.from("pk") } }),
  )
  if (attempt?.method !== "publickey") throw new Error("expected a publickey attempt")
  expect(attempt.signature).toBeUndefined()
  expect(attempt.blob).toBeUndefined()
  expect(attempt.hashAlgo).toBeUndefined()
})

// An unmodelled method (e.g. hostbased) must map to null so the connection handler
// rejects it, rather than slip past as something the Authenticator might accept.
test("an unmodelled method maps to null", () => {
  expect(attemptFromAuthContext(ctx({ method: "hostbased", username: "mallory" }))).toBeNull()
})
