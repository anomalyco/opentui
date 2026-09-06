import { expect } from "bun:test"
import type { TestRendererSetup } from "../testing/test-renderer.js"

export function captureRenderSnapshot(target: TestRendererSetup) {
  return {
    text: target.captureCharFrame(),
    ...target.renderer.currentRenderBuffer.withBuffers(({ fg, bg, attributes }) => ({
      fg: fg.slice(),
      bg: bg.slice(),
      attributes: attributes.slice(),
    })),
  }
}

// Legacy-frame goldens from 561a6722824e0cb1c6805b0f7d1958199d381310.
// Preserve typed-array element widths and view bounds without per-element snapshot lines.
export function expectRenderSnapshot(value: unknown): void {
  expect(
    JSON.stringify(value, (_key, item) =>
      ArrayBuffer.isView(item)
        ? {
            type: item.constructor.name,
            bytes: Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString("base64"),
          }
        : item,
    ),
  ).toMatchSnapshot()
}
