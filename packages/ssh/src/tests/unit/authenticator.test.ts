import { expect, test } from "bun:test"
import type { AuthAttempt } from "../../auth.js"
import { utils } from "ssh2"
import { createAuthenticator } from "../../auth.js"
import { parseOneKey, sha256Fingerprint } from "../../keys.js"
import { generateParseableKey as genKey } from "../support.js"

/**
 * The Authenticator is a pure decision module: `authenticate(attempt) → Outcome`.
 * Its plain-value interface lets the security-critical paths — above all
 * signature verification — be tested with adversarial cases a real ssh2 client
 * would never produce (a forged/missing signature).
 */

function parse(pem: string) {
  const key = parseOneKey(pem)
  if (!key) throw new Error("invalid test key")
  return key
}

/** Build a publickey attempt for `pub`, optionally signed by `priv` over `blob`. */
function pkAttempt(opts: {
  pubPem: string
  privPem?: string
  blob?: Buffer
  signature?: Buffer
  username?: string
  hashAlgo?: string
}): AuthAttempt {
  const pub = parse(opts.pubPem)
  const data = pub.getPublicSSH() as Buffer
  const blob = opts.blob ?? Buffer.from("ssh-session-id-blob")
  let signature = opts.signature
  if (signature === undefined && opts.privPem) {
    const priv = parse(opts.privPem)
    signature = priv.sign(blob, opts.hashAlgo) as Buffer
  }
  return {
    method: "publickey",
    username: opts.username ?? "alice",
    key: { algorithm: pub.type, blob: data },
    blob,
    signature,
    hashAlgo: opts.hashAlgo,
  }
}

test("none: accepted only when explicitly configured", async () => {
  const on = createAuthenticator({ none: true })
  const off = createAuthenticator({ password: () => true })

  const a = await on.authenticate({ method: "none", username: "guest" })
  expect(a.type).toBe("accept")
  if (a.type === "accept") expect(a.identity).toEqual({ method: "none", username: "guest" })

  const b = await off.authenticate({ method: "none", username: "guest" })
  expect(b.type).toBe("reject")
})

test("password: correct accepts, wrong rejects, unconfigured rejects", async () => {
  const auth = createAuthenticator({ password: ({ password }) => password === "hunter2" })

  const ok = await auth.authenticate({ method: "password", username: "erin", password: "hunter2" })
  expect(ok.type).toBe("accept")
  if (ok.type === "accept") expect(ok.identity).toEqual({ method: "password", username: "erin" })

  const bad = await auth.authenticate({ method: "password", username: "erin", password: "nope" })
  expect(bad.type).toBe("reject")

  const none = createAuthenticator({ none: true })
  const unconf = await none.authenticate({ method: "password", username: "erin", password: "x" })
  expect(unconf.type).toBe("reject")
})

test("keyboard-interactive: bridges prompt, accepts the right answer", async () => {
  const auth = createAuthenticator({
    keyboardInteractive: async ({ prompt }) => {
      const [answer] = await prompt([{ prompt: "Code: ", echo: false }])
      return answer === "1234"
    },
  })

  const ok = await auth.authenticate({
    method: "keyboard-interactive",
    username: "frank",
    prompt: async () => ["1234"],
  })
  expect(ok.type).toBe("accept")
  if (ok.type === "accept") expect(ok.identity.method).toBe("keyboard-interactive")

  const bad = await auth.authenticate({
    method: "keyboard-interactive",
    username: "frank",
    prompt: async () => ["0000"],
  })
  expect(bad.type).toBe("reject")
})

test("publickey 'any': probe is acceptProbe, valid signature accepts + identifies", async () => {
  const key = genKey()
  const auth = createAuthenticator({ publicKey: "any" })

  // Phase 1: probe carries no signature → tell the client the key is OK.
  const probe = await auth.authenticate(pkAttempt({ pubPem: key.public }))
  expect(probe.type).toBe("acceptProbe")

  // Phase 2: signed attempt → accept and surface the fingerprint.
  const signed = await auth.authenticate(pkAttempt({ pubPem: key.public, privPem: key.private }))
  expect(signed.type).toBe("accept")
  if (signed.type === "accept" && signed.identity.method === "publickey") {
    expect(signed.identity.fingerprint).toMatch(/^SHA256:/)
    expect(signed.identity.publicKey.algorithm).toBe("ssh-ed25519")
  }
})

test("publickey: a forged signature is rejected", async () => {
  const key = genKey()
  const auth = createAuthenticator({ publicKey: "any" })

  // Allowed key, but the signature is garbage — verify() must fail closed.
  const forged = await auth.authenticate(pkAttempt({ pubPem: key.public, signature: Buffer.alloc(64, 0x7) }))
  expect(forged.type).toBe("reject")
})

test("publickey: a signature from the WRONG private key is rejected", async () => {
  const real = genKey()
  const attacker = genKey()
  const auth = createAuthenticator({ publicKey: "any" })

  // Claim `real`'s public key, but sign with the attacker's private key.
  const blob = Buffer.from("ssh-session-id-blob")
  const sig = parse(attacker.private).sign(blob) as Buffer
  const spoofed = await auth.authenticate(pkAttempt({ pubPem: real.public, blob, signature: sig }))
  expect(spoofed.type).toBe("reject")
})

test("fuzz: mutated public-key proofs always fail closed", async () => {
  const key = genKey()
  const valid = pkAttempt({ pubPem: key.public, privPem: key.private })
  if (valid.method !== "publickey" || !valid.signature || !valid.blob) throw new Error("invalid fuzz fixture")
  const auth = createAuthenticator({ publicKey: "any" })

  for (let seed = 1; seed <= 256; seed++) {
    const signature = Buffer.from(valid.signature)
    const blob = Buffer.from(valid.blob)
    if (seed % 2 === 0) {
      signature[seed % signature.length] ^= (seed * 17) & 0xff || 1
    } else {
      blob[seed % blob.length] ^= (seed * 29) & 0xff || 1
    }
    const outcome = await auth.authenticate({ ...valid, signature, blob })
    expect(outcome.type).toBe("reject")
  }
})

test("fuzz: malformed public keys and signatures never authenticate", async () => {
  const auth = createAuthenticator({ publicKey: "any" })

  for (let seed = 1; seed <= 256; seed++) {
    const bytes = Buffer.alloc(seed % 97)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (seed * 31 + i * 17) & 0xff
    const outcome = await auth.authenticate({
      method: "publickey",
      username: `fuzz-${seed}`,
      key: { algorithm: seed % 2 ? "ssh-ed25519" : `invalid-${seed}`, blob: bytes },
      blob: Buffer.from(`blob-${seed}`),
      signature: Buffer.from(bytes).reverse(),
      hashAlgo: seed % 3 === 0 ? `invalid-${seed}` : undefined,
    })
    expect(outcome.type).toBe("reject")
  }
})

for (const [name, key, hashAlgo] of [
  ["RSA SHA-256", () => utils.generateKeyPairSync("rsa", { bits: 2048 }), "sha256"],
  ["RSA SHA-512", () => utils.generateKeyPairSync("rsa", { bits: 2048 }), "sha512"],
  ["ECDSA P-256", () => utils.generateKeyPairSync("ecdsa", { bits: 256 }), undefined],
] as const) {
  test(`publickey verifies ${name} signatures`, async () => {
    const pair = key()
    const outcome = await createAuthenticator({ publicKey: "any" }).authenticate(
      pkAttempt({ pubPem: pair.public, privPem: pair.private, hashAlgo }),
    )
    expect(outcome.type).toBe("accept")
  })
}

// `allow` decides on the verified pass (proof of possession), so the gate is
// asserted on signed attempts.
test("publickey `allow` gates by fingerprint on the verified pass", async () => {
  const good = genKey()
  const bad = genKey()
  const goodFp = sha256Fingerprint(parse(good.public).getPublicSSH() as Buffer)
  const auth = createAuthenticator({ publicKey: { allow: ({ fingerprint }) => fingerprint === goodFp } })

  // A genuinely-signed good key is admitted; a genuinely-signed bad key is denied.
  const admitted = await auth.authenticate(pkAttempt({ pubPem: good.public, privPem: good.private }))
  expect(admitted.type).toBe("accept")
  const denied = await auth.authenticate(pkAttempt({ pubPem: bad.public, privPem: bad.private }))
  expect(denied.type).toBe("reject")
})

test("publickey authorizedKeys allowlist accepts listed, rejects strangers", async () => {
  const listed = genKey()
  const stranger = genKey()
  const set = new Set([parse(listed.public).getPublicSSH().toString("base64")])
  const auth = createAuthenticator({}, set)

  const ok = await auth.authenticate(pkAttempt({ pubPem: listed.public }))
  expect(ok.type).toBe("acceptProbe")
  const no = await auth.authenticate(pkAttempt({ pubPem: stranger.public }))
  expect(no.type).toBe("reject")
})

test("publickey: function and allowlist OR-merge — either path admits", async () => {
  const inList = genKey()
  const blessedByFn = genKey()
  const stranger = genKey()

  const set = new Set([parse(inList.public).getPublicSSH().toString("base64")])
  const blessedFp = sha256Fingerprint(parse(blessedByFn.public).getPublicSSH() as Buffer)
  // `allow` admits blessedByFn; the allowlist admits inList.
  const auth = createAuthenticator({ publicKey: { allow: ({ fingerprint }) => fingerprint === blessedFp } }, set)

  // The OR-merge is decided on the verified pass, so assert on signed attempts.
  // Admitted via the allowlist even though the function would deny it.
  expect((await auth.authenticate(pkAttempt({ pubPem: inList.public, privPem: inList.private }))).type).toBe("accept")
  // Admitted via the function even though the allowlist would deny it.
  expect((await auth.authenticate(pkAttempt({ pubPem: blessedByFn.public, privPem: blessedByFn.private }))).type).toBe(
    "accept",
  )
  // Neither path admits the stranger.
  expect((await auth.authenticate(pkAttempt({ pubPem: stranger.public, privPem: stranger.private }))).type).toBe(
    "reject",
  )
})

// `allow` is user code that runs only AFTER the signature verifies; it must
// never fire on the unsigned probe, where the key is merely claimed.
test("publickey: `allow` runs only on the verified pass, never on the unsigned probe", async () => {
  const key = genKey()
  const seen: Array<{ fingerprint: string }> = []
  const auth = createAuthenticator({
    publicKey: {
      allow: ({ fingerprint }) => {
        seen.push({ fingerprint })
        return true
      },
    },
  })

  // Probe: tell the client to sign, but do not run `allow` — the key is not yet proven.
  const probe = await auth.authenticate(pkAttempt({ pubPem: key.public }))
  expect(probe.type).toBe("acceptProbe")
  expect(seen.length).toBe(0)

  // Signed pass: the signature verified, so `allow` runs on the proven key.
  const signed = await auth.authenticate(pkAttempt({ pubPem: key.public, privPem: key.private }))
  expect(signed.type).toBe("accept")
  expect(seen.length).toBe(1)
})

// A throwing predicate is a deny (never an accept), and the error is reported to
// the injected sink rather than propagated out of authenticate().
test("password: a throwing predicate fails closed and is reported", async () => {
  const errors: unknown[] = []
  const boom = new Error("auth backend down")
  const auth = createAuthenticator(
    {
      password: () => {
        throw boom
      },
    },
    undefined,
    (e) => errors.push(e),
  )
  const out = await auth.authenticate({ method: "password", username: "erin", password: "x" })
  expect(out.type).toBe("reject")
  expect(errors).toContain(boom)
})

test("publickey: a throwing authorizer fails closed and is reported", async () => {
  const key = genKey()
  const errors: unknown[] = []
  const boom = new Error("key lookup failed")
  const auth = createAuthenticator(
    {
      publicKey: {
        allow: () => {
          throw boom
        },
      },
    },
    undefined,
    (e) => errors.push(e),
  )
  const out = await auth.authenticate(pkAttempt({ pubPem: key.public, privPem: key.private }))
  expect(out.type).toBe("reject")
  expect(errors).toContain(boom)
})

test("keyboard-interactive: a throwing handler fails closed and is reported", async () => {
  const errors: unknown[] = []
  const boom = new Error("kbi backend down")
  const auth = createAuthenticator(
    {
      keyboardInteractive: () => {
        throw boom
      },
    },
    undefined,
    (e) => errors.push(e),
  )
  const out = await auth.authenticate({ method: "keyboard-interactive", username: "f", prompt: async () => [] })
  expect(out.type).toBe("reject")
  expect(errors).toContain(boom)
})

test("publickey: a rejected (async-throwing) authorizer also fails closed", async () => {
  const key = genKey()
  const errors: unknown[] = []
  const auth = createAuthenticator(
    { publicKey: { allow: async () => Promise.reject(new Error("async boom")) } },
    undefined,
    (e) => errors.push(e),
  )
  const out = await auth.authenticate(pkAttempt({ pubPem: key.public, privPem: key.private }))
  expect(out.type).toBe("reject")
  expect(errors.some((e) => e instanceof Error && /async boom/.test(e.message))).toBe(true)
})

test("advertisedMethods reflects exactly the configured methods", () => {
  expect(createAuthenticator({ none: true }).advertisedMethods()).toEqual(["none"])
  expect(createAuthenticator({ publicKey: "any", password: () => true }).advertisedMethods()).toEqual([
    "publickey",
    "password",
  ])
  // authorizedKeys alone still advertises publickey.
  expect(createAuthenticator({}, new Set(["x"])).advertisedMethods()).toEqual(["publickey"])
})
