import { afterAll, afterEach, beforeEach, expect, it, spyOn } from "bun:test"
import {
  CodeRenderable,
  destroyTreeSitterClient,
  DiffRenderable,
  InputRenderable,
  type Renderable,
  SelectRenderable,
  SyntaxStyle,
} from "@opentui/core"
import { createTestRenderer, ManualClock, MockTreeSitterClient } from "@opentui/core/testing"
import { render } from "../index.js"
import ExampleSelector from "../examples/components/ExampleSelector.js"

let setup: Awaited<ReturnType<typeof createTestRenderer>>
const descendants = (root: Renderable): Renderable[] =>
  root.getChildren().flatMap((child) => [child, ...descendants(child)])
const nodes = () => descendants(setup.renderer.root)
async function frame() {
  await new Promise<void>((resolve) => setImmediate(resolve))
  await setup.waitFor(() => !setup.renderer.getSchedulerState().isRendering)
  await setup.renderOnce()
}
async function key(value: string) {
  setup.mockInput.pressKey(value)
  await frame()
}
async function enter(name: string) {
  const menu = nodes().find((node) => node instanceof SelectRenderable)!
  menu.selectedIndex = menu.options.findIndex((option) => option.name === name)
  expect(menu.getSelectedOption()?.name).toBe(name)
  await key("RETURN")
}
async function leave() {
  const owned = nodes()
  await key("ESCAPE")
  expect(owned.every((node) => node.isDestroyed)).toBe(true)
  expect(setup.captureCharFrame()).toContain("Diff Viewer Demo")
}
beforeEach(async () => {
  setup = await createTestRenderer({
    width: 160,
    height: 55,
    kittyKeyboard: true,
    exitOnCtrlC: false,
    clock: new ManualClock(),
  })
  await render(() => <ExampleSelector />, setup.renderer)
  await frame()
})
afterEach(async () => {
  setup.renderer.destroy()
  await setup.renderer.closed
})
afterAll(destroyTreeSitterClient)

it.each([false, true])(
  "keeps plugin demo registries independent across browser visits (external first %p)",
  async (externalFirst) => {
    const originalPath = process.env.OPENTUI_SOLID_EXTERNAL_PLUGIN_PATH
    delete process.env.OPENTUI_SOLID_EXTERNAL_PLUGIN_PATH
    const errors = spyOn(console, "error")
    const listeners = setup.renderer.keyInput.listeners("keypress")
    const cube = () => nodes().find((node) => node.constructor.name === "ExternalCubeRenderable")
    const waitForPlugin = async (previous?: Renderable) => {
      const deadline = Date.now() + 2_000
      while (Date.now() < deadline) {
        const current = cube()
        if (current && current !== previous) return current
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      throw new Error("External plugin did not finish loading")
    }
    try {
      for (const external of [externalFirst, !externalFirst, externalFirst]) {
        await enter(external ? "Plugin Slots External JSX Demo" : "Plugin Slots Error Demo")
        if (external) {
          const previous = await waitForPlugin()
          await key("r")
          await waitForPlugin(previous)
          expect(previous.isDestroyed).toBe(true)
        } else {
          await key("e")
          await key("d")
          expect(setup.captureCharFrame()).toContain("Forced activity render failure")
          await key("x")
          expect(setup.captureCharFrame()).toContain("Activity plugin healthy")
          expect(setup.captureCharFrame()).not.toContain("Plugin error:")
        }
        await leave()
        expect(setup.renderer.keyInput.listeners("keypress")).toEqual(listeners)
        expect(errors.mock.calls).toEqual([])
      }
    } finally {
      setup.renderer.destroy()
      await setup.renderer.closed
      errors.mockRestore()
      if (originalPath === undefined) delete process.env.OPENTUI_SOLID_EXTERNAL_PLUGIN_PATH
      else process.env.OPENTUI_SOLID_EXTERNAL_PLUGIN_PATH = originalPath
    }
  },
)

it.each(["Diff Viewer Demo", "Code Syntax Highlighting Demo", "Line Numbers Demo"])(
  "releases %s themes after pending borrowers on repeated visits",
  async (name) => {
    const client = new MockTreeSitterClient()
    const styles: SyntaxStyle[] = []
    const warnings = spyOn(console, "warn")
    try {
      for (let visit = 0; visit < 2; visit++) {
        await enter(name)
        const node = nodes().find((node) =>
          name === "Diff Viewer Demo" ? node instanceof DiffRenderable : node instanceof CodeRenderable,
        ) as DiffRenderable | CodeRenderable
        const initial = node.syntaxStyle!
        expect(styles).not.toContain(initial)
        styles.push(initial)
        if (node instanceof DiffRenderable) {
          await key("t")
          expect(node.syntaxStyle).not.toBe(initial)
          styles.push(node.syntaxStyle!)
          expect(initial.getStyleCount()).toBeGreaterThan(0)
        }
        const code = nodes().find((node) => node instanceof CodeRenderable)!
        await code.highlightingDone
        code.treeSitterClient = client
        code.content += "\n// pending highlight"
        await frame()
        expect(code.isHighlighting).toBe(true)
        const pending = code.highlightingDone
        const style = code.syntaxStyle
        const destroy = style.destroy.bind(style)
        const order: boolean[] = []
        const released = spyOn(style, "destroy").mockImplementation(() => {
          order.push(code.isDestroyed)
          destroy()
        })
        try {
          await leave()
          expect(order).toEqual([true])
          for (const style of styles) expect(() => style.getStyleCount()).toThrow("destroyed")
          client.resolveAllHighlightOnce()
          await pending
          expect(warnings.mock.calls).toEqual([])
        } finally {
          released.mockRestore()
        }
      }
    } finally {
      setup.renderer.destroy()
      await setup.renderer.closed
      await client.destroy()
      warnings.mockRestore()
      for (const style of styles) style.destroy()
    }
  },
)

it.each(["Text Style Demo", "Text Selection Demo"])("browser return clears %s timers", async (name) => {
  const clock = new ManualClock()
  const interval = spyOn(globalThis, "setInterval").mockImplementation(
    clock.setInterval.bind(clock) as typeof setInterval,
  )
  const clear = spyOn(globalThis, "clearInterval").mockImplementation((handle) => clock.clearInterval(Number(handle)))
  try {
    await enter(name)
    expect(interval).toHaveBeenCalledTimes(1)
    await leave()
    expect(clear).toHaveBeenCalledWith(interval.mock.results[0]!.value)
  } finally {
    setup.renderer.destroy()
    await setup.renderer.closed
    interval.mockRestore()
    clear.mockRestore()
  }
})

it("autocomplete keeps string offsets and the cursor aligned after a wide character", async () => {
  await enter("Autocomplete Demo")
  await setup.mockInput.typeText("\u754c @ali")
  await frame()
  expect(setup.captureCharFrame()).toContain("Alice Johnson")
  await key("RETURN")
  const input = nodes().find((node) => node instanceof InputRenderable)!
  expect(input.value).toBe("\u754c @alice ")
  expect(input.editBuffer.getTextRange(0, input.cursorOffset)).toBe(input.value)
  await key("x")
  expect(input.value).toBe("\u754c @alice x")
})

it("mouse demo dragging accounts for its parent offset and clamps at screen coordinates", async () => {
  await enter("Mouse demo")
  const box = nodes().find((node) => node.constructor.name === "DraggableTransparentBox")!
  const before = [box.x, box.y]
  await setup.mockMouse.drag(box.x + 2, box.y + 2, box.x + 7, box.y + 5, 0, { delayMs: 0 })
  await frame()
  expect([box.x, box.y]).toEqual([before[0]! + 5, before[1]! + 3])
  await setup.mockMouse.pressDown(box.x + 2, box.y + 2)
  await setup.mockMouse.moveTo(box.x + 1, box.y + 2)
  await setup.mockMouse.moveTo(1, 1)
  await setup.mockMouse.release(1, 1)
  await frame()
  expect([box.x, box.y]).toEqual([0, 4])
})
