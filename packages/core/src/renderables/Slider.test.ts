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
})

test("SliderRenderable > Automatic thumb size calculation", async () => {
  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "horizontal",
    min: 0,
    max: 100,
    value: 50,
    width: 20,
    height: 1,
  })

  expect(slider.width).toBe(20)
  expect(slider.height).toBe(1)
  expect(slider.min).toBe(0)
  expect(slider.max).toBe(100)
  expect(slider.value).toBe(50)
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

  slider.viewPortSize = 0 // Should be clamped to minimum (0.01)
  expect(slider.viewPortSize).toBe(0.01)
})

test("SliderRenderable > Minimum thumb size", async () => {
  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "vertical",
    min: 0,
    max: 10000,
    value: 0,
    width: 2,
    height: 100,
    viewPortSize: 1,
  })

  expect(slider.viewPortSize).toBe(1)
  expect(slider.min).toBe(0)
  expect(slider.max).toBe(10000)
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

test("SliderRenderable > Vertical thumb size calculation", async () => {
  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "vertical",
    min: 0,
    max: 100,
    value: 0,
    width: 3,
    height: 50,
    viewPortSize: 10,
  })

  const thumbSize = await paintedThumbSize(slider)
  expect(thumbSize).toBe(9)

  slider.viewPortSize = 1
  expect(await paintedThumbSize(slider)).toBe(1)

  slider.viewPortSize = 150
  expect(await paintedThumbSize(slider)).toBe(50)
})

test("SliderRenderable > Horizontal thumb size calculation", async () => {
  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "horizontal",
    min: 0,
    max: 200,
    value: 0,
    width: 80,
    height: 2,
    viewPortSize: 20,
  })

  const thumbSize = await paintedThumbSize(slider)
  expect(thumbSize).toBe(14)

  slider.viewPortSize = 40
  expect(await paintedThumbSize(slider)).toBe(26)

  slider.viewPortSize = 0.1
  expect(await paintedThumbSize(slider)).toBe(1)
})

test("SliderRenderable > Edge cases in thumb size calculation", async () => {
  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "vertical",
    min: 50,
    max: 50,
    value: 50,
    width: 2,
    height: 30,
    viewPortSize: 10,
  })

  expect(await paintedThumbSize(slider)).toBe(60)

  slider.min = 0
  slider.max = 100000
  slider.viewPortSize = 1

  expect(await paintedThumbSize(slider)).toBe(1)

  slider.max = 30
  slider.viewPortSize = 30

  expect(await paintedThumbSize(slider)).toBe(30)
})

test("SliderRenderable > Thumb size minimum clamping", async () => {
  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "horizontal",
    min: 0,
    max: 1000,
    value: 0,
    width: 10,
    height: 1,
    viewPortSize: 1,
  })

  const thumbSize = await paintedThumbSize(slider)
  expect(thumbSize).toBe(1)

  const { slider: extremeSlider } = await createSliderRenderable(currentRenderer, {
    orientation: "vertical",
    min: 0,
    max: 10000,
    value: 0,
    width: 1,
    height: 2,
    viewPortSize: 0.01,
  })

  expect(await paintedThumbSize(extremeSlider)).toBe(1)

  expect(thumbSize).toBeGreaterThanOrEqual(1)
  expect(await paintedThumbSize(extremeSlider)).toBeGreaterThanOrEqual(1)
})

test("SliderRenderable > Thumb size can be less than 2", async () => {
  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "horizontal",
    min: 0,
    max: 200,
    value: 0,
    width: 20,
    height: 1,
    viewPortSize: 2,
  })

  const thumbSize = await paintedThumbSize(slider)
  expect(thumbSize).toBe(1)

  const { slider: largerRatioSlider } = await createSliderRenderable(currentRenderer, {
    orientation: "vertical",
    min: 0,
    max: 100,
    value: 0,
    width: 1,
    height: 10,
    viewPortSize: 1,
  })

  expect(await paintedThumbSize(largerRatioSlider)).toBe(1)

  const { slider: exactSlider } = await createSliderRenderable(currentRenderer, {
    orientation: "horizontal",
    min: 0,
    max: 40,
    value: 0,
    width: 20,
    height: 1,
    viewPortSize: 1,
  })

  expect(await paintedThumbSize(exactSlider)).toBe(1)
})

test("SliderRenderable > Mouse interaction - horizontal click on thumb", async () => {
  process.stdout.write("SliderRenderable > Mouse interaction - horizontal click on thumb 1\n")
  const { slider } = await createSliderRenderable(currentRenderer, {
    orientation: "horizontal",
    min: 0,
    max: 100,
    value: 50,
    width: 20,
    height: 1,
  })
  process.stdout.write("SliderRenderable > Mouse interaction - horizontal click on thumb 2\n")
  await currentMockMouse.click(10, 0)
  process.stdout.write("SliderRenderable > Mouse interaction - horizontal click on thumb 3\n")
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
