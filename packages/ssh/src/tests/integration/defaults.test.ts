import { expect, spyOn, test } from "bun:test"
import { createHarness } from "../support.js"

// Defaults: a server stands up with just a handler. auth defaults to none;
// listening outside localhost with no auth warns rather than throws, since an
// intentionally exposed no-auth TUI is a legitimate use case.

const { mkServer, connect } = createHarness()

test("a server with no auth configured accepts connections (auth defaults to none)", async () => {
  const server = mkServer(() => {})
  // connect() resolves only once the handshake is ready; reaching here = connected.
  const conn = await connect(server)
  expect(conn).toBeDefined()
}, 10000)

test("listening outside localhost with no auth warns (does not throw)", async () => {
  const warnings: string[] = []
  const warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  })
  try {
    const server = mkServer(() => {})

    // Must resolve (no throw) even though it's exposed + no auth.
    const info = await server.listen(0, "0.0.0.0")
    expect(info.port).toBeGreaterThan(0)
    expect(warnings.some((w) => /no authentication configured while listening on 0\.0\.0\.0/.test(w))).toBe(true)
  } finally {
    warnSpy.mockRestore()
  }
}, 10000)

test("binding localhost with no auth does not warn", async () => {
  const warnings: string[] = []
  const warnSpy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(" "))
  })
  try {
    const server = mkServer(() => {})

    await server.listen(0, "127.0.0.1")
    expect(warnings).toEqual([])
  } finally {
    warnSpy.mockRestore()
  }
}, 10000)
