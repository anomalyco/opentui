import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearEnvCache } from "../lib/env.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"

const originalStdinLog = process.env.OTUI_STDIN_LOG

afterEach(() => {
  if (originalStdinLog === undefined) delete process.env.OTUI_STDIN_LOG
  else process.env.OTUI_STDIN_LOG = originalStdinLog
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
