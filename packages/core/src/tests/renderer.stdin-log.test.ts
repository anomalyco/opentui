import { afterEach, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearEnvCache } from "../lib/env.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"

const originalEnv = {
  OTUI_STDIN_LOG: process.env.OTUI_STDIN_LOG,
  OTUI_NATIVE_INPUT_SHADOW: process.env.OTUI_NATIVE_INPUT_SHADOW,
}

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  clearEnvCache()
})

test("writes the raw stdin byte stream to OTUI_STDIN_LOG", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opentui-stdin-log-"))
  const path = join(directory, "stdin.bin")
  let renderer: TestRenderer | undefined
  const chunks = [
    Buffer.from([0x1b, 0x5b, 0x32]),
    Buffer.from([0x30, 0x30, 0x7e, 0x66, 0x6f, 0x0a, 0xff]),
    Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]),
  ]

  try {
    writeFileSync(path, "stale data")
    process.env.OTUI_STDIN_LOG = path
    clearEnvCache()

    const setup = await createTestRenderer({ width: 40, height: 20 })
    renderer = setup.renderer
    for (const chunk of chunks) {
      renderer.stdin.emit("data", chunk)
    }

    expect(readFileSync(path)).toEqual(Buffer.concat(chunks))
  } finally {
    renderer?.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
})

test("OTUI_NATIVE_INPUT_SHADOW delivers one parser's events and logs each difference", async () => {
  process.env.OTUI_NATIVE_INPUT_SHADOW = "true"
  clearEnvCache()
  for (const native of [false, true]) {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    const { renderer } = await createTestRenderer({ experimental_nativeInput: native })
    const names: string[] = []
    renderer.keyInput.on("keypress", (key) => names.push(key.name))
    try {
      // Only Alt+. differs: the legacy parser names it "" (issue 046).
      renderer.stdin.emit("data", Buffer.from("a\x1b.b"))
      expect(names).toEqual(["a", native ? "." : "", "b"])
      expect(warn.mock.calls.map(([line]) => String(line).split("=")[0])).toEqual([
        `[stdin-shadow] ${native ? "native" : "legacy"}`,
      ])
    } finally {
      renderer.destroy()
      warn.mockRestore()
    }
  }
})
