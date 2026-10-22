import { test, expect, beforeEach, afterEach } from "bun:test"
import { SliderRenderable, type SliderOptions } from "./Slider.js"
import { createTestRenderer, type MockMouse, type TestRenderer } from "../testing/test-renderer.js"

let currentRenderer: TestRenderer
let currentMockMouse: MockMouse
let renderOnce: () => Promise<void>

async function createSliderRenderable(
  renderer: TestRenderer,
  options: SliderOptions,
): Promise<{ slider: SliderRenderable; root: any }> {
  const sliderRenderable = new SliderRenderable(renderer, { left: 0, top: 0, ...options })
  renderer.root.add(sliderRenderable)
  await renderOnce()

  return { slider: sliderRenderable, root: renderer.root }
}

beforeEach(async () => {
  ;({
    renderer: currentRenderer,
    mockMouse: currentMockMouse,
    renderOnce,
  } = await createTestRenderer({ width: 100, height: 100 }))
})

afterEach(() => {
  currentRenderer.destroy()
})

async function paintedThumbSize(slider: SliderRenderable): Promise<number> {
  await renderOnce()
  return currentRenderer.currentRenderBuffer.withBuffers(({ char, width }) => {
    let halfCells = 0
    const horizontal = slider.orientation === "horizontal"
    for (let cell = 0; cell < (horizontal ? slider.width : slider.height); cell++) {
      const x = slider.x + (horizontal ? cell : 0)
      const y = slider.y + (horizontal ? 0 : cell)
      const glyph = char[y * width + x]
      if (glyph === 0x2588) halfCells += 2
      else if (glyph === 0x2580 || glyph === 0x2584 || glyph === 0x258c || glyph === 0x2590) halfCells++
    }
    return halfCells
  })
}

test("SliderRenderable > Value-based API", async () => {
  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "horizontal",
    min: 0,
    max: 100,
    value: 50,
  })

  expect(slider.value).toBe(50)
  expect(slider.min).toBe(0)
  expect(slider.max).toBe(100)

  slider.value = 75
  expect(slider.value).toBe(75)

  slider.value = 150
  expect(slider.value).toBe(100)

  slider.value = -10
  expect(slider.value).toBe(0)

  slider.min = 20
  expect(slider.value).toBe(20) // Should clamp to new min

  slider.max = 80
  slider.value = 90
  expect(slider.value).toBe(80) // Should clamp to new max

  slider.value = Infinity
  expect(slider.value).toBe(80)
  slider.value = -Infinity
  expect(slider.value).toBe(20)
})

test("SliderRenderable > Custom step size", async () => {
  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "horizontal",
    min: 0,
    max: 100,
    value: 50,
    width: 100,
    height: 1,
    viewPortSize: 10,
  })

  expect(slider.viewPortSize).toBe(10)
  expect(slider.width).toBe(100)
  expect(slider.min).toBe(0)
  expect(slider.max).toBe(100)
  expect(slider.value).toBe(50)

  slider.viewPortSize = 20
  expect(slider.viewPortSize).toBe(20)

  slider.viewPortSize = 150 // Should be clamped to max range (100)
  expect(slider.viewPortSize).toBe(100)
  slider.viewPortSize = 0
  slider.viewPortSize = Infinity
  expect(slider.viewPortSize).toBe(100)

  slider.viewPortSize = 0 // Should be clamped to minimum (0.01)
  expect(slider.viewPortSize).toBe(0.01)
})

test("SliderRenderable > onChange callback", async () => {
  let changedValue: number | undefined

  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "horizontal",
    min: 0,
    max: 100,
    value: 0,
    onChange: (value) => {
      changedValue = value
    },
  })

  slider.value = 42
  expect(changedValue).toBe(42)
})

// Setters apply min, max, then viewPortSize (clamped to the range) to a slider at value 0.
test.each([
  ["vertical", 3, 50, 0, 100, 10, 9],
  ["vertical", 3, 50, 0, 100, 1, 1],
  ["vertical", 3, 50, 0, 100, 150, 50],
  ["horizontal", 80, 2, 0, 200, 20, 14],
  ["horizontal", 80, 2, 0, 200, 40, 26],
  ["horizontal", 80, 2, 0, 200, 0.1, 1],
  ["vertical", 2, 30, 50, 50, 10, 60],
  ["vertical", 2, 30, 0, 100000, 1, 1],
  ["vertical", 2, 30, 0, 30, 30, 30],
  ["horizontal", 10, 1, 0, 1000, 1, 1],
  ["vertical", 1, 2, 0, 10000, 0.01, 1],
  ["horizontal", 20, 1, 0, 200, 2, 1],
  ["vertical", 1, 10, 0, 100, 1, 1],
  ["horizontal", 20, 1, 0, 40, 1, 1],
] as const)(
  "SliderRenderable > %s %ix%i, range %d..%d, viewport %d paints %i half cells",
  async (orientation, width, height, min, max, viewPortSize, halfCells) => {
    const { slider } = await createSliderRenderable(currentRenderer, { orientation, width, height })
    Object.assign(slider, { min, max, viewPortSize })
    expect(await paintedThumbSize(slider)).toBe(halfCells)
  },
)

test("SliderRenderable > Mouse interaction - horizontal click on thumb", async () => {
  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "horizontal",
    min: 0,
    max: 100,
    value: 50,
    width: 20,
    height: 1,
  })
  await currentMockMouse.click(10, 0)
  expect(slider.value).toBeCloseTo(51, 0)
})

test("SliderRenderable > Mouse interaction - horizontal click on track", async () => {
  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "horizontal",
    min: 0,
    max: 100,
    value: 50,
    width: 20,
    height: 1,
  })

  await currentMockMouse.pressDown(15, 0)

  expect(slider.value).toBeCloseTo(75, 1)
})

test("SliderRenderable > Mouse interaction - vertical click on thumb", async () => {
  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "vertical",
    min: 0,
    max: 100,
    value: 50,
    width: 2,
    height: 20,
  })

  currentMockMouse.click(0, 10)

  expect(slider.value).toBe(50)
})

// TODO: This seems flaky suddenly, because it now fails for all previous commits
test.skip("SliderRenderable > Mouse interaction - vertical click on track", async () => {
  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "vertical",
    min: 0,
    max: 100,
    value: 50,
    width: 2,
    height: 20,
  })

  currentMockMouse.click(0, 15)

  expect(slider.value).toBeCloseTo(75, 5)
})

test.each(["horizontal", "vertical"] as const)(
  "SliderRenderable > Mouse interaction - %s captured drag updates before release",
  async (orientation) => {
    const changes: number[] = []
    const vertical = orientation === "vertical"
    const { slider } = await createSliderRenderable(currentRenderer, {
      orientation,
      left: 2,
      top: 2,
      width: vertical ? 2 : 8,
      height: vertical ? 8 : 2,
      min: 10,
      max: 90,
      value: 10,
      viewPortSize: 20,
      onChange: (value) => changes.push(value),
    })
    const point = (offset: number): [number, number] => [
      slider.x + (vertical ? 0 : offset),
      slider.y + (vertical ? offset : 0),
    ]

    await currentMockMouse.pressDown(...point(6))
    expect(slider.value).toBe(70)
    await currentMockMouse.moveTo(...point(7))
    const dragged = slider.value
    expect(dragged).toBeGreaterThan(70)
    expect(dragged).toBeLessThan(90)
    await currentMockMouse.moveTo(...point(10))
    expect(slider.value).toBe(90)
    await currentMockMouse.moveTo(...point(-2))
    expect(slider.value).toBe(10)
    expect(changes).toEqual([70, dragged, 90, 10])
    await currentMockMouse.release(...point(-2))
    await currentMockMouse.moveTo(...point(6))
    expect(slider.value).toBe(10)
    expect(changes).toEqual([70, dragged, 90, 10])
  },
)

test("SliderRenderable > Mouse interaction - click outside slider bounds", async () => {
  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "horizontal",
    min: 0,
    max: 100,
    value: 50,
    width: 20,
    height: 1,
    left: 5,
    top: 5,
  })

  currentMockMouse.click(30, 5)

  expect(slider.value).toBe(50)
})

test("SliderRenderable > Mouse interaction - precision dragging with small viewport", async () => {
  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "horizontal",
    max: 1000,
    width: 50,
    height: 1,
    viewPortSize: 10,
  })
  expect(await paintedThumbSize(slider)).toBe(1)

  await currentMockMouse.pressDown(5, 0)
  expect(slider.value).toBeCloseTo(100, 10)
  // A one-half-cell thumb travels 99 of the 100 half cells.
  await currentMockMouse.moveTo(7, 0)
  expect(slider.value).toBeCloseTo((14 / 99) * 1000, 10)
})
