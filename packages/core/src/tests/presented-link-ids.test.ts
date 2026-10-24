// Presented link ids follow presentation, not encoding. getLinkIdAt reads the encoded buffer,
// which already shows a frame whose output is still pending. getPresentedLinkIdAt reads the
// presented id plane, which publishes only when a frame is presented.
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { NativeSession } from "../NativeSession.js"
import { CliRenderer, CliRenderEvents } from "../renderer.js"
import { TextRenderable } from "../renderables/Text.js"
import { link, StyledText, t } from "../lib/styled-text.js"
import { RGBA } from "../lib/RGBA.js"
import { createTestRenderer, ManualClock } from "../testing.js"
import { settle, settleUntil } from "../testing/harness.js"
import { createTestStdin, RecordingWriteStream } from "../testing/test-streams.js"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function track(renderer: CliRenderer, stdout?: RecordingWriteStream): void {
  cleanups.push(async () => {
    stdout?.release()
    renderer.destroy()
    await renderer.closed.catch(() => {})
  })
}

/** Both views of one cell: the encoded buffer and the presented plane. */
function probe(renderer: CliRenderer, x: number, y: number) {
  return { encoded: renderer.getLinkIdAt(x, y), presented: renderer.getPresentedLinkIdAt(x, y) }
}

describe("presented link ids", () => {
  test("pending output: the plane keeps the previous frame until presentation completes", async () => {
    const stdout = new RecordingWriteStream(16, 3)
    const setup = await createTestRenderer({
      width: 16,
      height: 3,
      stdout: stdout as unknown as NodeJS.WriteStream,
      bufferedOutput: "stdout",
    })
    track(setup.renderer, stdout)
    const { renderer, renderOnce } = setup
    const text = new TextRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      width: 16,
      height: 1,
      content: t`${link("https://example.com/a")("AAAA")}`,
    })
    renderer.root.add(text)
    await renderOnce()
    const frameA = { at0: probe(renderer, 0, 0), at4: probe(renderer, 4, 0) }
    expect(frameA.at0.presented).toBeGreaterThan(0)
    expect(frameA.at0.presented).toBe(frameA.at0.encoded)
    expect(frameA.at4.presented).toBe(0)

    stdout.hold()
    text.content = t`    ${link("https://example.com/b")("BBBB")}`
    const pending = renderOnce()
    await settleUntil(() => stdout.pendingWrite)
    const duringPending = { at0: probe(renderer, 0, 0), at4: probe(renderer, 4, 0) }

    stdout.release()
    await pending
    const afterPresent = { at0: probe(renderer, 0, 0), at4: probe(renderer, 4, 0) }

    // The encoded buffer already shows frame B while it is pending.
    expect(duringPending.at0.encoded).toBe(0)
    expect(duringPending.at4.encoded).toBeGreaterThan(0)
    // The presented plane still shows frame A.
    expect(duringPending.at0.presented).toBe(frameA.at0.presented)
    expect(duringPending.at4.presented).toBe(0)
    // After presentation both agree on frame B.
    expect(afterPresent.at0).toEqual({ encoded: 0, presented: 0 })
    expect(afterPresent.at4.presented).toBe(afterPresent.at4.encoded)
    expect(afterPresent.at4.presented).toBeGreaterThan(0)
  })

  test("skipped frame (real output pressure): the plane keeps the last presented frame", async () => {
    const stdout = new RecordingWriteStream(40, 4)
    const clock = new ManualClock()
    const driver = new NativeSession(stdout, {
      output: { chunkSize: 64, spanCapacity: 8, maxBytes: 512n, controlCapacity: 0 },
    })
    const renderer = new CliRenderer(createTestStdin(), stdout as unknown as NodeJS.WriteStream, 40, 4, {
      nativeSession: driver,
      clock,
      remote: true,
      screenMode: "main-screen",
      consoleMode: "disabled",
      exitSignals: [],
    })
    track(renderer, stdout)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    cleanups.push(() => errors.mockRestore())
    let frames = 0
    renderer.on(CliRenderEvents.FRAME, () => frames++)

    const text = new TextRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      width: 40,
      height: 1,
      content: t`${link("https://example.com/first")("FIRST")}`,
    })
    renderer.root.add(text)
    renderer.start()
    for (let turn = 0; turn < 8 && frames === 0; turn++) {
      clock.advance(40)
      await settle(16)
    }
    expect(frames).toBeGreaterThan(0)
    const presentedFirst = probe(renderer, 0, 0)
    expect(presentedFirst.presented).toBeGreaterThan(0)

    // Fill the queue so the next frame does not fit: native skips it before publishing bytes.
    stdout.hold()
    expect(driver.write(new Uint8Array(400).fill(0x41))).toBe(true)
    await settleUntil(() => stdout.pendingWrite)
    const framesBefore = frames
    text.content = t`${"x".repeat(10)}${link("https://example.com/second")("SECOND")}`
    for (let turn = 0; turn < 4; turn++) {
      clock.advance(40)
      await settle(16)
    }
    const duringSkip = { at0: probe(renderer, 0, 0), at10: probe(renderer, 10, 0) }
    expect(frames).toBe(framesBefore)
    // No skipped frame reaches the presented plane.
    expect(duringSkip.at0.presented).toBe(presentedFirst.presented)
    expect(duringSkip.at10.presented).toBe(0)

    stdout.release()
    for (let turn = 0; turn < 8; turn++) {
      clock.advance(40)
      await settle(16)
    }
    expect(frames).toBeGreaterThan(framesBefore)
    const afterDrain = { at0: probe(renderer, 0, 0), at10: probe(renderer, 10, 0) }
    expect(afterDrain.at0.presented).toBe(0)
    expect(afterDrain.at10.presented).toBeGreaterThan(0)
    expect(afterDrain.at10.presented).toBe(afterDrain.at10.encoded)
    renderer.stop()
  })

  test("failed frame (larger than the empty queue): the plane keeps the last presented frame", async () => {
    const stdout = new RecordingWriteStream(80, 6)
    const clock = new ManualClock()
    // 4 KiB chunks, two spans: the atomic limit is 8 KiB. The first short frame fits; a full screen
    // of per-cell colors and links (about 30 bytes per cell) cannot, so native reports Failed for it.
    const driver = new NativeSession(stdout, {
      output: { chunkSize: 4096, spanCapacity: 2, maxBytes: 8192n, controlCapacity: 0 },
    })
    const renderer = new CliRenderer(createTestStdin(), stdout as unknown as NodeJS.WriteStream, 80, 6, {
      nativeSession: driver,
      clock,
      remote: true,
      screenMode: "main-screen",
      consoleMode: "disabled",
      exitSignals: [],
    })
    track(renderer, stdout)
    const errors = spyOn(console, "error").mockImplementation(() => {})
    cleanups.push(() => errors.mockRestore())
    let frames = 0
    renderer.on(CliRenderEvents.FRAME, () => frames++)

    const small = new TextRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      width: 80,
      height: 1,
      content: t`${link("https://example.com/small")("ok")}`,
    })
    renderer.root.add(small)
    renderer.start()
    for (let turn = 0; turn < 8 && frames === 0; turn++) {
      clock.advance(40)
      await settle(16)
    }
    expect(frames).toBeGreaterThan(0)
    const presentedSmall = probe(renderer, 0, 0)
    expect(presentedSmall.presented).toBeGreaterThan(0)

    // Every cell of every row gets its own color, so the frame needs far more than 512 bytes.
    const palette = ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#ff00ff", "#00ffff"]
    const rows = Array.from(
      { length: 5 },
      (_, y) =>
        new TextRenderable(renderer, {
          position: "absolute",
          left: 0,
          top: y + 1,
          width: 80,
          height: 1,
          content: new StyledText(
            Array.from({ length: 80 }, (_, x) => ({
              __isChunk: true as const,
              text: String.fromCharCode(65 + ((x + y) % 26)),
              fg: RGBA.fromHex(palette[(x + y) % palette.length]!),
              // A distinct URL per cell forces an OSC 8 open and close around every cell.
              link: { url: `https://example.com/huge/${y}/${x}` },
            })),
          ),
        }),
    )
    for (const row of rows) renderer.root.add(row)
    for (let turn = 0; turn < 4; turn++) {
      clock.advance(40)
      await settle(16)
    }
    const duringFailure = { at0: probe(renderer, 0, 0), row1: probe(renderer, 10, 1) }
    expect(errors).toHaveBeenCalled()
    // The encoded buffer took the failed frame's cells; the presented plane must not.
    expect(duringFailure.row1.encoded).toBeGreaterThan(0)
    expect(duringFailure.row1.presented).toBe(0)
    expect(duringFailure.at0.presented).toBe(presentedSmall.presented)
    renderer.stop()
  })

  test("split-footer commits publish the plane on presentation like ordinary frames", async () => {
    const stdout = new RecordingWriteStream(24, 10)
    const setup = await createTestRenderer({
      screenMode: "split-footer",
      externalOutputMode: "capture-stdout",
      width: 24,
      height: 10,
      footerHeight: 3,
      consoleMode: "disabled",
      stdout: stdout as unknown as NodeJS.WriteStream,
      bufferedOutput: "stdout",
    })
    track(setup.renderer, stdout)
    const { renderer, renderOnce } = setup
    const text = new TextRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      width: 24,
      height: 1,
      content: t`${link("https://example.com/footer-a")("FOOTER")}`,
    })
    renderer.root.add(text)
    await renderOnce()
    // Find the presented footer row by scanning the presented plane.
    let row = -1
    for (let y = 0; y < renderer.height && row < 0; y++) if (renderer.getPresentedLinkIdAt(0, y) !== 0) row = y
    expect(row).toBeGreaterThanOrEqual(0)
    const before = probe(renderer, 0, row)

    stdout.hold()
    text.content = t`      ${link("https://example.com/footer-b")("MOVED")}`
    const pending = renderOnce()
    await settleUntil(() => stdout.pendingWrite)
    const duringPending = { at0: probe(renderer, 0, row), at6: probe(renderer, 6, row) }
    stdout.release()
    await pending
    const after = { at0: probe(renderer, 0, row), at6: probe(renderer, 6, row) }
    expect(duringPending.at0.presented).toBe(before.presented)
    expect(duringPending.at6.presented).toBe(0)
    expect(after.at0.presented).toBe(0)
    expect(after.at6.presented).toBeGreaterThan(0)
  })

  test("resize clears the plane, and destroyed renderers return 0", async () => {
    const setup = await createTestRenderer({ width: 10, height: 2 })
    const { renderer, renderOnce, resize } = setup
    renderer.root.add(
      new TextRenderable(renderer, {
        position: "absolute",
        left: 0,
        top: 0,
        width: 10,
        height: 1,
        content: t`${link("https://example.com/resize")("resize")}`,
      }),
    )
    await renderOnce()
    expect(renderer.getPresentedLinkIdAt(0, 0)).toBeGreaterThan(0)
    resize(12, 3)
    expect(renderer.getPresentedLinkIdAt(0, 0)).toBe(0)
    await renderOnce()
    expect(renderer.getPresentedLinkIdAt(0, 0)).toBeGreaterThan(0)
    for (const [x, y] of [
      [-1, 0],
      [0, -1],
      [1.5, 0],
      [2 ** 32, 0],
      [100, 100],
    ] as const) {
      expect(renderer.getPresentedLinkIdAt(x, y)).toBe(0)
    }
    renderer.destroy()
    await renderer.closed.catch(() => {})
    expect(renderer.getPresentedLinkIdAt(0, 0)).toBe(0)
  })
})
