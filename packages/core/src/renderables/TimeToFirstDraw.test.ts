import { afterEach, beforeEach, expect, test } from "bun:test"

import { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { resolveRenderLib } from "../zig.js"
import { TimeToFirstDrawRenderable } from "./TimeToFirstDraw.js"

let renderer: TestRenderer
let renderOnce: () => Promise<void>
let captureCharFrame: () => string

beforeEach(async () => {
  ;({ renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 10, height: 1 }))
})

afterEach(() => {
  renderer.destroy()
})

async function renderTimestamp(label: string, buffered = false): Promise<string> {
  const now = Object.getOwnPropertyDescriptor(performance, "now")
  Object.defineProperty(performance, "now", { configurable: true, value: () => 0 })
  try {
    renderer.root.add(
      new TimeToFirstDrawRenderable(renderer, {
        width: 8,
        alignSelf: "flex-end",
        label,
        precision: 0,
        buffered,
      }),
    )

    await renderOnce()
    return captureCharFrame()
  } finally {
    if (now) Object.defineProperty(performance, "now", now)
    else Reflect.deleteProperty(performance, "now")
  }
}

test.each([
  { label: "😀😀", included: "😀", excluded: "�" },
  { label: "👨‍👩‍👧‍👦X", included: "👨‍👩‍👧‍👦", excluded: "X" },
])("TimeToFirstDraw truncates $label at a complete grapheme", async ({ label, included, excluded }) => {
  renderer.root.add(new TimeToFirstDrawRenderable(renderer, { width: 2, label, precision: 0 }))

  await renderOnce()

  const frame = captureCharFrame()
  expect(frame).toContain(included)
  expect(frame).not.toContain(excluded)
})

// A buffered node draws at its own buffer's origin.
test.each([
  ["🫩", false],
  ["क्त", true],
])("TimeToFirstDraw centers %s with native-compatible width (buffered %p)", async (label, buffered) => {
  expect((await renderTimestamp(label, buffered)).startsWith(`  ${label}: 0ms`)).toBe(true)
})

// The label centers on the cells the fit keeps, measured natively: a wcwidth family is 8 cells and does not fit.
test.each([
  { method: "wcwidth", label: "ab👩‍👩‍👧‍👧", row: "  ab" },
  { method: "unicode", label: "ab👩‍👩‍👧‍👧", row: "ab👩‍👩‍👧‍👧:" },
  { method: "unicode", label: "abcdefgh", row: "abcdef" },
] as const)("TimeToFirstDraw centers $label on the kept width in $method", async ({ method, label, row }) => {
  const node = new TimeToFirstDrawRenderable(renderer, { width: 6, alignSelf: "flex-start", label, precision: 0 })
  renderer.root.add(node)
  await renderOnce()
  const buffer = OptimizedBuffer.create(10, 1, method, { owner: renderer.nativeScene })
  Object.assign(node, { _runtimeMs: 0 })
  // The label follows the opacity stack: its foreground blends with the cells under it.
  buffer.clear(RGBA.fromInts(0, 0, 0))
  buffer.pushOpacity(0.5)
  ;(node as unknown as { renderSelf(buffer: OptimizedBuffer): void }).renderSelf(buffer)
  expect(
    buffer
      .getSpanLines()[0]
      .spans.find((span) => span.text.trim())
      ?.fg.toInts(),
  ).toEqual([85, 85, 85, 255])
  expect(
    buffer
      .getSpanLines()[0]
      .spans.map((span) => span.text)
      .join("")
      .trimEnd(),
  ).toBe(row)
  buffer.destroy()
})

// One draw per frame, plus one Unicode measure for a label that is not printable ASCII.
test.each([
  ["t", 7],
  ["👋", 11],
])("TimeToFirstDraw makes at most the FFI calls of one draw per idle frame (label %s)", async (label, calls) => {
  const symbols = (resolveRenderLib() as unknown as { opentui: { symbols: Record<string, (...args: any[]) => any> } })
    .opentui.symbols
  renderer.root.add(new TimeToFirstDrawRenderable(renderer, { width: 10, label: label.repeat(4), precision: 0 }))
  await renderOnce()
  const originals = { ...symbols }
  let count = 0
  for (const [name, original] of Object.entries(originals)) {
    if (typeof original === "function") symbols[name] = (...args) => (count++, original(...args))
  }
  try {
    renderer.requestRender()
    await renderOnce()
  } finally {
    Object.assign(symbols, originals)
  }
  expect(count).toBeLessThanOrEqual(calls)
})
