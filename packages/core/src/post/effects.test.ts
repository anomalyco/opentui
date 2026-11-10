import { ResourceContext } from "../buffer.js"
import { beforeEach } from "bun:test"

let resourceContext: ResourceContext
beforeEach(() => {
  resourceContext = new ResourceContext({ objectCapacity: 65536, renderCellsMax: 1000000 })
})
afterEach(() => resourceContext.destroy())

import { afterEach, describe, expect, test } from "bun:test"
import { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { VignetteEffect } from "./effects.js"

describe("VignetteEffect", () => {
  let buffer: OptimizedBuffer | undefined

  afterEach(() => buffer?.destroy())

  test("keeps contiguous graphemes in one terminal style run", () => {
    buffer = OptimizedBuffer.create(24, 3, "unicode-wide", { owner: resourceContext, id: "vignette-test" })
    const foreground = RGBA.fromInts(255, 255, 255, 255)
    const background = RGBA.fromInts(80, 120, 160, 255)
    buffer.drawText(" ".repeat(buffer.width), 0, 1, foreground, background)
    buffer.drawText("പരിശോധിക്കൽ|", 2, 1, foreground, background)
    buffer.drawText("ASCII", 2, 2, foreground, background)

    new VignetteEffect(0.8).apply(buffer)

    buffer.withBuffers(({ char, fg, bg, width }) => {
      const graphemeCells = Array.from(char.slice(width, width * 2), (value, x) => ({ value, x })).filter(
        ({ value }) => value >>> 30 >= 2,
      )
      expect(graphemeCells.length).toBeGreaterThan(1)
      const first = width + graphemeCells[0].x
      for (const { x } of graphemeCells.slice(1)) {
        const cell = width + x
        expect([...fg.slice(cell * 4, cell * 4 + 4)]).toEqual([...fg.slice(first * 4, first * 4 + 4)])
        expect([...bg.slice(cell * 4, cell * 4 + 4)]).toEqual([...bg.slice(first * 4, first * 4 + 4)])
      }

      expect([...fg.slice((width * 2 + 2) * 4, (width * 2 + 3) * 4)]).not.toEqual([
        ...fg.slice((width * 2 + 6) * 4, (width * 2 + 7) * 4),
      ])
      expect([...bg.slice(width * 4, width * 4 + 4)]).not.toEqual([...bg.slice((width + 12) * 4, (width + 12) * 4 + 4)])
    })
  })
})
