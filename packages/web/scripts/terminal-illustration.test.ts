import { readFile } from "node:fs/promises"
import { runInNewContext } from "node:vm"
import { expect, test } from "bun:test"

const source = await readFile(new URL("../src/scripts/terminal-illustration.js", import.meta.url), "utf8")

async function player({ reducedMotion = false } = {}) {
  const animationFrames = new Map<number, (now: number) => void>()
  const clicks = new Map<string, () => void>()
  const attributes = new Map<string, string>()
  const observers: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = []
  let time = 0
  let nextFrame = 0
  const screen = { innerHTML: "", style: { setProperty() {} } }
  const viewport = { style: {}, hasAttribute: () => true, getBoundingClientRect: () => ({ width: 240, height: 30 }) }
  const toggle = {
    textContent: "Play",
    dataset: {},
    addEventListener: (name: string, callback: () => void) => clicks.set(name, callback),
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  }
  const illustration = {
    querySelector(selector: string) {
      if (selector === "[data-illustration-screen]") return screen
      if (selector === "[data-illustration-viewport]") return viewport
      if (selector === "[data-illustration-toggle]") return toggle
      return null
    },
    getAttribute(name: string) {
      return name === "data-terminal-illustration"
        ? JSON.stringify({ stories: [{ src: "/test.json" }], defaults: { holdMs: 0 } })
        : "Test recording"
    },
    setAttribute() {},
  }
  const document = {
    hidden: false,
    fonts: { ready: Promise.resolve() },
    body: { appendChild() {} },
    querySelectorAll: () => [illustration],
    addEventListener() {},
    createElement(tag: string) {
      return tag === "canvas"
        ? {
            getContext: () => ({
              font: "",
              measureText: () => ({ actualBoundingBoxAscent: 100, actualBoundingBoxDescent: 25 }),
            }),
          }
        : { style: {}, getBoundingClientRect: () => ({ width: 60 }), remove() {} }
    },
  }
  class IntersectionObserver {
    constructor(
      private callback: (entries: Array<{ isIntersecting: boolean }>) => void,
      private options: { rootMargin?: string },
    ) {}
    observe() {
      if (this.options.rootMargin) this.callback([{ isIntersecting: true }])
      else observers.push(this.callback)
    }
    disconnect() {}
  }
  const window = {
    IntersectionObserver,
    matchMedia: () => ({ matches: reducedMotion }),
    addEventListener() {},
    clearTimeout() {},
    requestAnimationFrame(callback: (now: number) => void) {
      const id = ++nextFrame
      animationFrames.set(id, callback)
      return id
    },
    cancelAnimationFrame: (id: number) => animationFrames.delete(id),
  }

  runInNewContext(source, {
    document,
    window,
    IntersectionObserver,
    performance: { now: () => time },
    getComputedStyle: () => ({ color: "rgb(0, 0, 0)", fontFamily: "monospace" }),
    fetch: async () => ({
      ok: true,
      json: async () => ({
        cols: 8,
        rows: 1,
        chapters: [
          {
            durationMs: 200,
            frames: [
              { at: 0, rows: [[{ t: "Start" }]] },
              { at: 100, rows: [[{ t: "End" }]] },
            ],
          },
        ],
      }),
    }),
  })
  await new Promise(setImmediate)

  return {
    screen,
    toggle,
    attributes,
    intersect(visible: boolean) {
      for (const callback of observers) callback([{ isIntersecting: visible }])
    },
    click() {
      clicks.get("click")!()
    },
    advance() {
      time += 100
      const callbacks = [...animationFrames.values()]
      animationFrames.clear()
      for (const callback of callbacks) callback(time)
    },
  }
}

test("a single recording repaints its first frame when looping", async () => {
  const recording = await player()
  recording.intersect(true)
  recording.advance()
  expect(recording.screen.innerHTML).toContain("End")
  recording.advance()
  expect(recording.screen.innerHTML).toContain("Start")
})

test("manual reduced-motion playback pauses when it leaves the viewport", async () => {
  const recording = await player({ reducedMotion: true })
  recording.intersect(true)
  expect(recording.toggle.textContent).toBe("Play")
  expect(recording.attributes.get("aria-pressed")).toBe("false")
  expect(recording.screen.innerHTML).toContain("End")
  recording.click()
  expect(recording.attributes.get("aria-pressed")).toBe("true")
  expect(recording.screen.innerHTML).toContain("Start")
  recording.intersect(false)
  expect(recording.toggle.textContent).toBe("Play")
  expect(recording.attributes.get("aria-pressed")).toBe("false")
})
