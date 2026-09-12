import { afterEach, beforeEach, expect, test } from "bun:test"

import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
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

async function renderTimestamp(label: string): Promise<string> {
  const now = Object.getOwnPropertyDescriptor(performance, "now")
  Object.defineProperty(performance, "now", { configurable: true, value: () => 0 })
  try {
    renderer.root.add(
      new TimeToFirstDrawRenderable(renderer, {
        width: 8,
        alignSelf: "flex-start",
        label,
        precision: 0,
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

test.each(["🫩", "क्त"])("TimeToFirstDraw centers %s with native-compatible width", async (label) => {
  expect((await renderTimestamp(label)).startsWith(`${label}: 0ms`)).toBe(true)
})
