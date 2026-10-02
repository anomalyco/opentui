import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { NativeSession } from "../NativeSession.js"
import { CliRenderer } from "../renderer.js"
import { TextRenderable } from "../renderables/Text.js"
import { RGBA } from "../lib/RGBA.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestStdin, TestWriteStream } from "../testing/test-streams.js"

class Output extends TestWriteStream {
  chunks: Buffer[] = []

  override _write(chunk: Uint8Array, _encoding: BufferEncoding, complete: (error?: Error) => void): void {
    this.chunks.push(Buffer.from(chunk))
    complete()
  }

  text(): string {
    return Buffer.concat(this.chunks).toString()
  }
}

const targets: { renderer: CliRenderer; stdout: Output }[] = []
afterEach(async () => {
  for (const { renderer } of targets.splice(0)) {
    renderer.destroy()
    await renderer.closed.catch(() => {})
  }
})

test("close flushes accepted snapshots without replaying cancelled footer cells", async () => {
  const stdout = new Output(24, 10)
  const driver = new NativeSession(stdout)
  const renderer = new CliRenderer(createTestStdin(), stdout as unknown as NodeJS.WriteStream, 24, 10, {
    nativeSession: driver,
    screenMode: "split-footer",
    footerHeight: 3,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    remote: true,
    clock: new ManualClock(),
  })
  targets.push({ renderer, stdout })
  renderer.root.add(new TextRenderable(renderer, { content: "footer", height: 1 }))
  await renderer.setupTerminal()
  renderer.stdin.emit("data", Buffer.from("\x1b[10;1R"))
  await renderer["loop"]()
  await driver.idle()
  assert.ok(stdout.text().includes("footer"))
  stdout.chunks.length = 0
  renderer.writeToScrollback(({ renderContext }) => ({
    root: new TextRenderable(renderContext, { content: "accepted", width: 8, height: 1 }),
  }))
  renderer.addPostProcessFn((buffer) => {
    buffer.drawText("REVOKED", 0, 0, RGBA.fromInts(255, 255, 255))
    renderer.destroy()
  })
  await renderer["loop"]()
  await renderer.closed
  assert.ok(stdout.text().includes("accepted"))
  assert.equal(stdout.text().includes("REVOKED"), false)
  assert.ok(stdout.text().includes("\x1b[?25h"))
})
