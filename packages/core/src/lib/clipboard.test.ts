import { describe, expect, it, afterEach } from "bun:test"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { TestWriteStream } from "../testing/test-streams.js"
import { ClipboardTarget } from "./clipboard.js"

describe("clipboard", () => {
  let renderer: TestRenderer | null = null

  const respondToOsc52Query = (testRenderer: TestRenderer, response: string) => {
    testRenderer.stdin.emit("data", Buffer.from(response))
  }

  afterEach(async () => {
    renderer?.destroy()
    await renderer?.closed
    renderer = null
  })

  it("preserves the native selection target ABI", () => {
    expect(ClipboardTarget.Clipboard).toBe(0)
    expect(ClipboardTarget.Primary).toBe(1)
    expect(ClipboardTarget.Select).toBe(2)
    expect(ClipboardTarget.Secondary).toBe(3)
  })

  it("encodes UTF-8 clipboard text into Session terminal output", async () => {
    const chunks: Buffer[] = []
    const stdout = new TestWriteStream(8, 3)
    stdout._write = (chunk: Uint8Array, _encoding: BufferEncoding, complete: () => void) => {
      chunks.push(Buffer.from(chunk))
      complete()
    }
    ;({ renderer } = await createTestRenderer({
      stdout: stdout as unknown as NodeJS.WriteStream,
      bufferedOutput: "stdout",
      remote: true,
    }))
    await renderer.setupTerminal()
    await renderer.nativeScene.driver.idle()
    chunks.length = 0

    expect(renderer.copyToClipboardOSC52("世界")).toBe(true)
    expect(renderer.clearClipboardOSC52()).toBe(true)
    await renderer.nativeScene.driver.idle()
    expect(Buffer.concat(chunks).toString()).toBe("\x1b]52;c;5LiW55WM\x1b\\\x1b]52;c;\x1b\\")
  })

  it("treats negative XTGETTCAP Ms replies as inconclusive", async () => {
    ;({ renderer } = await createTestRenderer({ remote: true }))
    await renderer.setupTerminal()

    expect(renderer.isOsc52Supported()).toBe(true)
    expect(renderer.copyToClipboardOSC52("test")).toBe(true)

    respondToOsc52Query(renderer, "\x1bP0+r\x1b\\")
    expect(renderer.copyToClipboardOSC52("test")).toBe(true)
    expect(renderer.clearClipboardOSC52()).toBe(true)

    respondToOsc52Query(renderer, "\x1bP0+r4d73\x1b\\")
    expect(renderer.copyToClipboardOSC52("test")).toBe(true)

    respondToOsc52Query(renderer, "\x1bP1+r4d73=2570312573\x1b\\")

    expect(renderer.copyToClipboardOSC52("test")).toBe(true)
    expect(renderer.copyToClipboardOSC52("test", ClipboardTarget.Primary)).toBe(true)
    expect(renderer.copyToClipboardOSC52("test", ClipboardTarget.Select)).toBe(true)
    expect(renderer.copyToClipboardOSC52("test", ClipboardTarget.Secondary)).toBe(true)
    expect(renderer.clearClipboardOSC52()).toBe(true)
  })
})
