import { afterAll, beforeAll, expect, test } from "bun:test"
import { KeyEvent } from "../lib/KeyHandler.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { BoxRenderable } from "./Box.js"
import { FrameBufferRenderable } from "./FrameBuffer.js"
import { ScrollBarRenderable } from "./ScrollBar.js"
import { ScrollBoxRenderable } from "./ScrollBox.js"
import { SelectRenderable } from "./Select.js"
import { TabSelectRenderable } from "./TabSelect.js"

const clock = new ManualClock()
let setup: TestRendererSetup
let renderer: TestRendererSetup["renderer"]

beforeAll(async () => {
  setup = await createTestRenderer({ width: 40, height: 12, clock })
  renderer = setup.renderer
})

afterAll(() => {
  renderer.destroy()
})

/** `ctrl+shift+name@baseCode`; every part except the name is optional. */
function key(spec: string): KeyEvent {
  const [chord, baseCode] = spec.split("@")
  const parts = chord.split("+")
  const name = parts.pop()!
  return new KeyEvent({
    name,
    sequence: name === "space" ? " " : name,
    ctrl: parts.includes("ctrl"),
    meta: false,
    shift: parts.includes("shift"),
    option: false,
    number: false,
    raw: name,
    eventType: "press",
    source: "raw",
    baseCode: baseCode ? Number(baseCode) : undefined,
  })
}

/** `ctrl+name:action` bindings. */
function bindings(...specs: string[]) {
  return specs.map((spec) => {
    const [chord, action] = spec.split(":")
    const { name, ctrl, shift } = key(chord)
    return { name, ctrl, shift, action }
  })
}

const items = ["one", "two", "three", "four", "five"].map((name) => ({ name, description: `${name} item` }))
const Select = SelectRenderable
const Tabs = TabSelectRenderable
const custom = {
  keyBindings: bindings("j:move-down", "l:move-right", "next:select-current"),
  keyAliasMap: { next: "tab" },
}

// Steps: a key, `#n` for setSelectedIndex(n), or `prop=value`. Each step records the index, "c" for selectionChanged,
// "s" for itemSelected, and a "!" prefix when a key is not handled. Select emits on every move, also at an edge;
// TabSelect emits only when the index changes.
const navigation: [string, typeof Select | typeof Tabs, object, string, string][] = [
  ["Select keys", Select, { selectedIndex: 1 }, "down up j k a return linefeed", "2c 1c 2c 1c !1 1s 1s"],
  ["Select edges", Select, { fastScrollStep: 3 }, "up shift+down shift+up shift+down down down", "0c 3c 0c 3c 4c 4c"],
  ["Select wrap", Select, { wrapSelection: true }, "up down wrapSelection=false up", "4c 0c 0 0c"],
  ["Select index", Select, {}, "#3 #-1 #5 selectedIndex=1 fastScrollStep=2 shift+down", "3c 3 3 1 1 3c"],
  ["Select empty", Select, { options: [] }, "return #0", "0 0"],
  ["Select one item", Select, { options: items.slice(0, 1) }, "up down return", "0c 0c 0s"],
  [
    "Select bindings",
    Select,
    { keyBindings: bindings("h:move-up", "l:move-down", "k:move-down") },
    "l h k down",
    "1c 0c 1c 2c",
  ],
  [
    "Select modifiers",
    Select,
    { keyBindings: bindings("ctrl+n:move-down", "ctrl+down:move-down-fast") },
    "ctrl+n n ctrl+down",
    "1c !1 4c",
  ],
  ["Select custom", Select, custom, "ㅓ@106 tab keyBindings=x:move-down x", "1c 1s 1 2c"],
  ["Tabs keys", Tabs, {}, "left right ] [ return linefeed a", "0 1c 2c 1c 1s 1s !1"],
  ["Tabs edges", Tabs, {}, "#4 right #-1 #5", "4c 4 4 4"],
  [
    "Tabs wrap",
    Tabs,
    { wrapSelection: true, keyBindings: bindings("p:move-left") },
    "p right wrapSelection=false p",
    "4c 0c 0 0",
  ],
  [
    "Tabs bindings",
    Tabs,
    { keyBindings: bindings("[:move-right", "ctrl+left:move-right", "ctrl+right:move-left") },
    "[ ctrl+left ctrl+right right",
    "1c 2c 1c 2c",
  ],
  ["Tabs custom", Tabs, custom, "ㅣ@108 tab keyBindings=space:move-right space", "1c 1s 1 2c"],
  ["Tabs empty", Tabs, { options: [] }, "right left return #0", "0 0 0 0"],
]

test.each(navigation)("%s", (_, Control, options, steps, expected) => {
  const node = new Control(renderer, { width: 40, height: 10, options: items, ...options })
  let events = ""
  node.on("selectionChanged", (index: number, option: unknown) => {
    expect(option).toBe(node.getSelectedOption())
    events += "c"
  })
  node.on("itemSelected", (index: number, option: unknown) => {
    expect([index, option]).toEqual([node.getSelectedIndex(), node.getSelectedOption()])
    events += "s"
  })
  const trace = steps.split(" ").map((step) => {
    events = ""
    let handled = true
    const [prop, value] = step.split("=")
    if (value !== undefined) Reflect.set(node, prop, value.includes(":") ? bindings(value) : JSON.parse(value))
    else if (step.startsWith("#")) node.setSelectedIndex(Number(step.slice(1)))
    else handled = node.handleKeyPress(key(step))
    const index = node.getSelectedIndex()
    expect(node.getSelectedOption()).toBe(node.options[index] ?? null)
    return `${handled ? "" : "!"}${index}${events}`
  })
  expect(trace.join(" ")).toBe(expected)
  node.destroy()
})

// Steps: a key, `#n` for scrollTo(n, n), `[shift+]wheel:direction`, `arrow:start|end` (click), or `auto:x,y`
// (updateAutoScroll, then a 100 ms frame). Each step records scrollTop,scrollLeft and a "!" prefix when a key is not
// handled; an auto step adds "-" when auto-scroll stopped. Edge distances 1, 2, 3 pick the fast, medium, slow speeds.
const scrolling: [string, object, string, string][] = [
  [
    "keys",
    { scrollX: true },
    "down j up k right l left h pagedown pageup end home a",
    "2,0 4,0 2,0 0,0 0,4 0,8 0,4 0,0 5,0 0,0 90,0 0,0 !0,0",
  ],
  ["keys without scrollX", {}, "right l end", "0,0 0,0 90,0"],
  [
    "wheel",
    { scrollX: true },
    "wheel:down wheel:up wheel:right wheel:left shift+wheel:down shift+wheel:up",
    "1,0 0,0 0,1 0,0 0,1 0,0",
  ],
  ["arrows", { scrollbarOptions: { showArrows: true } }, "arrow:end arrow:end arrow:start", "5,0 10,0 5,0"],
  [
    "auto-scroll",
    { scrollX: true },
    "#10 auto:10,9 auto:10,8 auto:10,7 auto:10,0 auto:0,5 auto:19,5 auto:10,5",
    "10,10 17,10 20,10 21,10 15,10 15,3 15,10 15,10-",
  ],
  ["auto-scroll without scrollX", {}, "#10 auto:0,5", "10,0 10,0-"],
]

test.each(scrolling)("ScrollBox %s", async (_, options, steps, expected) => {
  const scroll = new ScrollBoxRenderable(renderer, { width: 20, height: 10, ...options })
  scroll.add(new BoxRenderable(renderer, { width: 100, height: 100 }))
  renderer.root.add(scroll)
  await setup.renderOnce()
  const trace: string[] = []
  for (const step of steps.split(" ")) {
    const [kind, arg] = step.split(":")
    let token = ""
    if (step.startsWith("#")) scroll.scrollTo({ x: Number(step.slice(1)), y: Number(step.slice(1)) })
    else if (kind.endsWith("wheel"))
      await setup.mockMouse.scroll(5, 5, arg as "up", { modifiers: { shift: kind !== "wheel" } })
    else if (kind === "arrow") {
      const arrow = arg === "end" ? scroll.verticalScrollBar.endArrow : scroll.verticalScrollBar.startArrow
      await setup.mockMouse.click(arrow.x, arrow.y)
    } else if (kind === "auto") {
      scroll.updateAutoScroll(...(arg.split(",").map(Number) as [number, number]))
      clock.advance(100)
      await setup.renderOnce()
      if (!scroll.live) token = "-"
    } else if (!scroll.handleKeyPress(key(step))) token = "!"
    expect([scroll.content.translateX + scroll.scrollLeft, scroll.content.translateY + scroll.scrollTop]).toEqual([
      0, 0,
    ])
    trace.push(
      token === "!" ? `!${scroll.scrollTop},${scroll.scrollLeft}` : `${scroll.scrollTop},${scroll.scrollLeft}${token}`,
    )
  }
  expect(trace.join(" ")).toBe(expected)
  scroll.destroyRecursively()
})

// The setters are covered by renderable-nullish-props.test.ts; these are the methods and the instance accessor.
test("control methods ignore calls after destroy", () => {
  const bar = new ScrollBarRenderable(renderer, { orientation: "vertical" })
  const scroll = new ScrollBoxRenderable(renderer, { width: 10, height: 5 })
  const frame = new FrameBufferRenderable(renderer, { width: 2, height: 2 })
  const buffer = frame.frameBuffer
  for (const node of [bar, scroll, frame]) node.destroyRecursively()
  bar.resetVisibilityControl()
  scroll.updateAutoScroll(0, 0)
  scroll.stopAutoScroll()
  frame.frameBuffer = buffer
  expect(frame.frameBuffer).toBeNull()
})
