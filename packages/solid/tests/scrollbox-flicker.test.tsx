import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { testRender } from "../index.js"
import { createSignal, For } from "solid-js"
import type { ScrollBoxRenderable } from "../../core/src/renderables/index.js"
import { TestRecorder } from "../../core/src/testing/test-recorder.js"

let testSetup: Awaited<ReturnType<typeof testRender>>

/**
 * Sticky-scroll scrollbox flicker repro: rows must not briefly disappear when
 * a sibling resizes or a new item is appended. Caused by viewport culling
 * reading each child's stale cached `screenY` before `updateFromLayout()` ran
 * for the child this frame.
 */

describe("ScrollBox flicker reproduction", () => {
  beforeEach(async () => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  const nonWhitespaceCount = (frame: string) => frame.replace(/\s/g, "").length
  const countMessageLines = (frame: string, pattern: RegExp) =>
    frame.split("\n").filter((line) => pattern.test(line)).length

  it("confirms viewportCulling=false prevents the flicker (root-cause diagnostic)", async () => {
    // Control: with culling disabled the flicker disappears, isolating the bug to culling.
    const INITIAL_ITEMS = 30
    const [firstHeight, setFirstHeight] = createSignal(1)
    const items = Array.from({ length: INITIAL_ITEMS }, (_, i) => `Row ${i}`)

    let scrollRef: ScrollBoxRenderable | undefined

    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <scrollbox
            ref={(r) => (scrollRef = r)}
            stickyScroll={true}
            stickyStart="bottom"
            flexGrow={1}
            viewportCulling={false}
          >
            <box id="first" flexShrink={0} height={firstHeight()}>
              <text>FIRST</text>
            </box>
            <For each={items}>
              {(row) => (
                <box flexShrink={0} marginTop={1}>
                  <text>{row}</text>
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      ),
      {
        width: 40,
        height: 20,
      },
    )

    await testSetup.renderOnce()
    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight)
      await testSetup.renderOnce()
    }

    const baselineFrame = testSetup.captureCharFrame()
    const baselineRows = (baselineFrame.match(/Row \d+/g) ?? []).length
    expect(baselineRows).toBeGreaterThan(0)

    const recorder = new TestRecorder(testSetup.renderer)
    recorder.rec()
    setFirstHeight(10)
    for (let i = 0; i < 4; i++) {
      await testSetup.renderOnce()
    }
    recorder.stop()

    const frames = recorder.recordedFrames
    const rowCounts = frames.map((f) => (f.frame.match(/Row \d+/g) ?? []).length)
    const settledRows = rowCounts[rowCounts.length - 1]
    const flickerFrames = frames.filter((f, i) => {
      const rows = rowCounts[i]
      return rows < baselineRows && rows < settledRows
    })
    expect(flickerFrames).toEqual([])
  })

  it("does not briefly drop rows when a sibling above grows in height (scrollbox viewport culling flicker)", async () => {
    // Symptom: one intermediate frame has fewer rows than baseline/settled.
    const INITIAL_ITEMS = 30
    const [firstHeight, setFirstHeight] = createSignal(1)
    const items = Array.from({ length: INITIAL_ITEMS }, (_, i) => `Row ${i}`)

    let scrollRef: ScrollBoxRenderable | undefined

    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <scrollbox ref={(r) => (scrollRef = r)} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
            <box id="first" flexShrink={0} height={firstHeight()}>
              <text>FIRST</text>
            </box>
            <For each={items}>
              {(row) => (
                <box flexShrink={0} marginTop={1}>
                  <text>{row}</text>
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      ),
      {
        width: 40,
        height: 20,
      },
    )

    await testSetup.renderOnce()
    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight)
      await testSetup.renderOnce()
    }

    const baselineFrame = testSetup.captureCharFrame()
    const baselineRows = (baselineFrame.match(/Row \d+/g) ?? []).length
    expect(baselineRows).toBeGreaterThan(0)

    const recorder = new TestRecorder(testSetup.renderer)
    recorder.rec()

    setFirstHeight(10)

    for (let i = 0; i < 4; i++) {
      await testSetup.renderOnce()
    }

    recorder.stop()

    const frames = recorder.recordedFrames
    const rowCounts = frames.map((f) => (f.frame.match(/Row \d+/g) ?? []).length)

    // Flicker = any intermediate frame with fewer rows than both baseline and settled.
    const settledRows = rowCounts[rowCounts.length - 1]
    const flickerFrames = frames.filter((f, i) => {
      const rows = rowCounts[i]
      return rows < baselineRows && rows < settledRows
    })

    if (flickerFrames.length > 0) {
      console.log(`FLICKER: baseline=${baselineRows}, settled=${settledRows}, per-frame rows=`, rowCounts)
      console.log("first flicker frame:\n" + flickerFrames[0].frame)
    }

    expect(flickerFrames).toEqual([])
  })

  it("does not briefly drop rows when an earlier message grows (diff finalized in middle of scrollbox)", async () => {
    // Variant: a mid-list item grows (e.g. a diff lands in the middle of a conversation).
    const INITIAL_ITEMS = 30
    const [middleHeight, setMiddleHeight] = createSignal(1)
    const items = Array.from({ length: INITIAL_ITEMS }, (_, i) => `Row ${i}`)
    const middleIndex = Math.floor(INITIAL_ITEMS / 2)

    let scrollRef: ScrollBoxRenderable | undefined

    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <scrollbox ref={(r) => (scrollRef = r)} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
            <For each={items}>
              {(row, index) => (
                <box flexShrink={0} marginTop={1} height={index() === middleIndex ? middleHeight() : undefined}>
                  <text>{row}</text>
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      ),
      {
        width: 40,
        height: 20,
      },
    )

    await testSetup.renderOnce()
    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight)
      await testSetup.renderOnce()
    }

    const baselineFrame = testSetup.captureCharFrame()
    const baselineRows = (baselineFrame.match(/Row \d+/g) ?? []).length
    expect(baselineRows).toBeGreaterThan(0)

    const recorder = new TestRecorder(testSetup.renderer)
    recorder.rec()

    setMiddleHeight(12)

    for (let i = 0; i < 4; i++) {
      await testSetup.renderOnce()
    }

    recorder.stop()

    const frames = recorder.recordedFrames
    const rowCounts = frames.map((f) => (f.frame.match(/Row \d+/g) ?? []).length)
    const settledRows = rowCounts[rowCounts.length - 1]
    const flickerFrames = frames.filter((f, i) => {
      const rows = rowCounts[i]
      return rows < baselineRows && rows < settledRows
    })

    if (flickerFrames.length > 0) {
      console.log(`FLICKER (middle): baseline=${baselineRows}, settled=${settledRows}, per-frame rows=`, rowCounts)
      console.log("first flicker frame:\n" + flickerFrames[0].frame)
    }

    expect(flickerFrames).toEqual([])
  })

  it("does not drop visible content for a single frame when a new message is appended", async () => {
    // >= culling `minTriggerSize` (16) to force the binary-search path in getObjectsInViewport.
    const INITIAL_ITEMS = 40
    const [items, setItems] = createSignal<string[]>(Array.from({ length: INITIAL_ITEMS }, (_, i) => `Message ${i}`))

    let scrollRef: ScrollBoxRenderable | undefined

    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <scrollbox ref={(r) => (scrollRef = r)} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
            <For each={items()}>
              {(msg) => (
                <box flexShrink={0} marginTop={1}>
                  <text>{msg}</text>
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      ),
      {
        width: 40,
        height: 20,
      },
    )

    await testSetup.renderOnce()
    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight)
      await testSetup.renderOnce()
    }

    const baselineFrame = testSetup.captureCharFrame()
    const baselineVisible = countMessageLines(baselineFrame, /Message \d+/)
    expect(baselineVisible).toBeGreaterThan(0)
    const baselineNonWhite = nonWhitespaceCount(baselineFrame)

    const recorder = new TestRecorder(testSetup.renderer)
    recorder.rec()

    // Append a new message (simulates "finalize"); sticky-bottom keeps us pinned without scrollTo.
    setItems((prev) => [...prev, `Message ${prev.length}`])

    // Let several render passes run, as the real app would after a finalize.
    for (let i = 0; i < 4; i++) {
      await testSetup.renderOnce()
    }

    recorder.stop()

    // Flicker = any captured frame with <50% the non-whitespace count of baseline.
    const frames = recorder.recordedFrames
    expect(frames.length).toBeGreaterThan(0)

    const flickerThreshold = Math.floor(baselineNonWhite / 2)
    const blankFrames = frames.filter((f) => nonWhitespaceCount(f.frame) < flickerThreshold)

    if (blankFrames.length > 0) {
      const report = blankFrames
        .map(
          (f) =>
            `frame ${f.frameNumber} (t=${f.timestamp.toFixed(1)}ms) nonWhite=${nonWhitespaceCount(
              f.frame,
            )} (baseline=${baselineNonWhite})`,
        )
        .join("\n")
      console.log("FLICKER FRAMES DETECTED:\n" + report)
      console.log("first blank frame content:\n" + blankFrames[0].frame)
    }

    expect(blankFrames).toEqual([])
  })

  it("does not drop visible content when an existing item grows in height", async () => {
    // Simulates a diff/tool output finalize: one item jumps from 1 line to many,
    // shifting every later item down in a single layout pass.
    const INITIAL_ITEMS = 30
    const [content, setContent] = createSignal<string[]>(Array.from({ length: INITIAL_ITEMS }, (_, i) => `Item ${i}`))

    let scrollRef: ScrollBoxRenderable | undefined

    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <scrollbox ref={(r) => (scrollRef = r)} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
            <For each={content()}>
              {(text) => (
                <box flexShrink={0} marginTop={1}>
                  <text>{text}</text>
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      ),
      {
        width: 40,
        height: 20,
      },
    )

    await testSetup.renderOnce()
    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight)
      await testSetup.renderOnce()
    }

    const baselineFrame = testSetup.captureCharFrame()
    const baselineNonWhite = nonWhitespaceCount(baselineFrame)
    expect(baselineNonWhite).toBeGreaterThan(0)

    const recorder = new TestRecorder(testSetup.renderer)
    recorder.rec()

    // Replace a mid-list item with tall multi-line content, shifting every later item's screenY.
    setContent((prev) => {
      const next = [...prev]
      const targetIdx = Math.floor(next.length / 2)
      next[targetIdx] = Array.from({ length: 8 }, (_, i) => `Grown line ${i}`).join("\n")
      return next
    })

    for (let i = 0; i < 4; i++) {
      await testSetup.renderOnce()
    }

    recorder.stop()

    const frames = recorder.recordedFrames
    expect(frames.length).toBeGreaterThan(0)

    const flickerThreshold = Math.floor(baselineNonWhite / 2)
    const blankFrames = frames.filter((f) => nonWhitespaceCount(f.frame) < flickerThreshold)

    if (blankFrames.length > 0) {
      const report = blankFrames
        .map(
          (f) =>
            `frame ${f.frameNumber} (t=${f.timestamp.toFixed(1)}ms) nonWhite=${nonWhitespaceCount(
              f.frame,
            )} (baseline=${baselineNonWhite})`,
        )
        .join("\n")
      console.log("FLICKER FRAMES DETECTED:\n" + report)
      console.log("first blank frame content:\n" + blankFrames[0].frame)
    }

    expect(blankFrames).toEqual([])
  })

  it("does not cull visible items based on stale screenY after layout shift", async () => {
    // Minimal targeted repro: > 16 items (binary-search culling path), first item grows.
    const INITIAL_ITEMS = 30
    const [firstHeight, setFirstHeight] = createSignal(1)
    const items = Array.from({ length: INITIAL_ITEMS }, (_, i) => `Row ${i}`)

    let scrollRef: ScrollBoxRenderable | undefined

    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <scrollbox ref={(r) => (scrollRef = r)} stickyScroll={true} stickyStart="bottom" flexGrow={1}>
            <box id="first" flexShrink={0} height={firstHeight()}>
              <text>FIRST</text>
            </box>
            <For each={items}>
              {(row) => (
                <box flexShrink={0} marginTop={1}>
                  <text>{row}</text>
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      ),
      {
        width: 40,
        height: 20,
      },
    )

    await testSetup.renderOnce()
    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight)
      await testSetup.renderOnce()
    }

    const baselineFrame = testSetup.captureCharFrame()
    const baselineNonWhite = nonWhitespaceCount(baselineFrame)

    const recorder = new TestRecorder(testSetup.renderer)
    recorder.rec()

    // Grow the first item. Yoga shifts all later items; cached `_screenY` lags one frame.
    setFirstHeight(10)
    // First render is the critical N->N+1 transition; then let it settle.
    await testSetup.renderOnce()
    for (let i = 0; i < 3; i++) {
      await testSetup.renderOnce()
    }

    recorder.stop()

    const frames = recorder.recordedFrames
    expect(frames.length).toBeGreaterThan(0)

    // Every frame should contain at least one Row (we are pinned to bottom).
    const framesWithoutRows = frames.filter((f) => !/Row \d+/.test(f.frame))

    if (framesWithoutRows.length > 0) {
      const report = framesWithoutRows
        .map(
          (f) =>
            `frame ${f.frameNumber} (t=${f.timestamp.toFixed(1)}ms) nonWhite=${nonWhitespaceCount(
              f.frame,
            )} (baseline=${baselineNonWhite})`,
        )
        .join("\n")
      console.log("FRAMES WITHOUT ROWS DETECTED:\n" + report)
      console.log("first bad frame content:\n" + framesWithoutRows[0].frame)
    }

    expect(framesWithoutRows).toEqual([])

    // Additional guard: non-whitespace chars must not halve.
    const flickerThreshold = Math.floor(baselineNonWhite / 2)
    const blankFrames = frames.filter((f) => nonWhitespaceCount(f.frame) < flickerThreshold)
    if (blankFrames.length > 0) {
      console.log(
        "blank frame diag:",
        blankFrames.map((f) => ({
          frameNumber: f.frameNumber,
          nonWhite: nonWhitespaceCount(f.frame),
        })),
      )
      console.log("first blank frame content:\n" + blankFrames[0].frame)
    }
    expect(blankFrames).toEqual([])
  })
})
