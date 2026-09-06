import { spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { NativeStatus, resolveRenderLib } from "../zig.js"

const lib = resolveRenderLib()
const contextOptions = { objectCapacity: 2, renderCellsMax: 16 }
const sessionOptions = { chunkSize: 4, spanCapacity: 2, maxBytes: 8n }

test("renderer environment values are read before resolving their Context", () => {
  const context = lib.createContext(contextOptions)
  let destroyed = false
  try {
    const session = lib.createSession(context, sessionOptions)
    const options = {
      width: 1,
      height: 1,
      environment: {
        get TERM() {
          lib.destroyContext(context)
          destroyed = true
          return "xterm"
        },
      },
    }
    assert.throws(() => lib.sessionAttachRenderer(context, session, options), { status: NativeStatus.WrongContext })
    assert.equal(destroyed, true)
  } finally {
    if (!destroyed) lib.destroyContext(context)
  }
})

test("environment encoding rejects bounded inputs before attachment without consuming queued output", () => {
  const context = lib.createContext(contextOptions)
  const session = lib.createSession(context, sessionOptions)
  const oversized = "x".repeat(65_537)
  const includes = String.prototype.includes
  let scans = 0
  const spy = spyOn(String.prototype, "includes").mockImplementation(function (this: string, search, position) {
    if (this.length > 65_536) scans++
    return includes.call(this, search, position)
  })
  try {
    lib.sessionWrite(context, session, Buffer.from("safe"))
    for (const environment of [
      { TERM: oversized },
      { [oversized]: "1" },
      { "": "1" },
      { "a=b": "1" },
      { "a\0": "1" },
      { a: "\0" },
      { a: 1 },
      { a: "x".repeat(65_528) },
      { a: "\u00e9".repeat(32_764) },
      Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`k${i}`, ""])),
    ]) {
      assert.throws(() =>
        lib.sessionAttachRenderer(context, session, {
          width: 4,
          height: 2,
          environment: environment as Record<string, string>,
        }),
      )
      assert.throws(() => lib.sessionGetRendererState(context, session), { status: NativeStatus.RendererNotAttached })
    }
    assert.equal(scans, 0)
    lib.sessionAttachRenderer(context, session, { width: 4, height: 2, environment: { a: "x".repeat(65_527) } })
    const bytes = new Uint8Array(4)
    const ticket = lib.sessionReadOutput(context, session, bytes)
    assert.ok(ticket)
    assert.equal(Buffer.from(bytes).toString(), "safe")
    lib.sessionCompleteOutput(context, session, ticket, true)
  } finally {
    spy.mockRestore()
    lib.sessionCancel(context, session)
    lib.destroyContext(context)
  }
})

test.each(["write", "read"] as const)("native %s rejects a length beyond the supplied view", (operation) => {
  const context = lib.createContext(contextOptions)
  const session = lib.createSession(context, sessionOptions)
  try {
    const storage = Uint8Array.of(0xee, 1, 2, 0xee)
    const bytes = Object.defineProperty(storage.subarray(1, 3), "byteLength", { value: 3 })
    if (operation === "read") lib.sessionWrite(context, session, Uint8Array.of(3, 4, 5))
    assert.throws(
      () =>
        operation === "write"
          ? lib.sessionWrite(context, session, bytes)
          : lib.sessionReadOutput(context, session, bytes),
      RangeError,
    )
    assert.deepEqual(storage, Uint8Array.of(0xee, 1, 2, 0xee))
    const output = new Uint8Array(4)
    const ticket = lib.sessionReadOutput(context, session, output)
    if (operation === "read") {
      assert.ok(ticket)
      assert.equal(ticket.byteCount, 3)
      assert.deepEqual(output, Uint8Array.of(3, 4, 5, 0))
      lib.sessionCompleteOutput(context, session, ticket, true)
    } else assert.equal(ticket, null)
  } finally {
    lib.sessionCancel(context, session)
    lib.destroyContext(context)
  }
})

test("native copies use intrinsic subarray storage without late caller metadata access", () => {
  const context = lib.createContext(contextOptions)
  const session = lib.createSession(context, sessionOptions)
  try {
    const input = Uint8Array.of(0xee, 1, 2, 0xee).subarray(1, 3)
    const result = new Uint8Array(4).fill(0xee)
    const output = result.subarray(1, 3)
    let reads = 0
    Object.defineProperty(input, "byteLength", {
      get() {
        reads++
        return 2
      },
    })
    for (const bytes of [input, output]) {
      for (const field of ["buffer", "byteOffset"]) {
        Object.defineProperty(bytes, field, {
          get() {
            throw new Error("Public view storage must not be read")
          },
        })
      }
    }
    lib.sessionWrite(context, session, input)
    const ticket = lib.sessionReadOutput(context, session, output)
    assert.ok(ticket)
    assert.equal(reads, 1)
    assert.deepEqual(result, Uint8Array.of(0xee, 1, 2, 0xee))
    lib.sessionCompleteOutput(context, session, ticket, true)
    for (const value of [-1, 0.5, NaN, Infinity, 0x1_0000_0000, "1", 1n]) {
      assert.throws(() => lib.sessionGetState(context, { ...session, slot: value as never }), RangeError)
    }
    for (const value of [-1n, 1n << 64n, 1, "1"]) {
      assert.throws(() => lib.sessionGetState(context, { ...session, contextId: value as never }), RangeError)
    }
    assert.throws(() => lib.sessionCompleteOutput(context, session, ticket, 1 as never), TypeError)
  } finally {
    lib.sessionCancel(context, session)
    lib.destroyContext(context)
  }
})

test.each(["contexts", "libraries"])("native ownership rejects foreign and expired %s", (scenario) => {
  // Isolate the process-global native logger from the test runner's singleton.
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  const runtimeArgs = "bun" in process.versions ? [] : process.execArgv.filter((arg) => !arg.startsWith("--test"))
  const child = spawnSync(
    process.execPath,
    [...runtimeArgs, fileURLToPath(new URL(`native-session-child.${extension}`, import.meta.url)), scenario],
    { encoding: "utf8", timeout: 30_000 },
  )
  assert.equal(child.status, 0, child.stderr || child.error?.message)
  assert.equal(child.stdout.trim(), "Native session lifecycle passed")
})
