import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { OptimizedBuffer } from "../buffer.js"
import type { Renderable } from "../Renderable.js"
import { RGBA, rgbToHex } from "../lib/RGBA.js"
import { renderFontToFrameBuffer } from "../lib/ascii.font.js"
import { KeyEvent } from "../lib/KeyHandler.js"
import { CliRenderEvents } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import type { CapturedFrame } from "../types.js"
import { NativePaintRecorder, resolveRenderLib } from "../zig.js"
import { BoxRenderable } from "./Box.js"
import { EmbeddedTerminalRenderable } from "./EmbeddedTerminal.js"
import { FrameBufferRenderable } from "./FrameBuffer.js"
import { LineNumberRenderable } from "./LineNumberRenderable.js"
import { ArrowRenderable, ScrollBarRenderable } from "./ScrollBar.js"
import { ScrollBoxRenderable } from "./ScrollBox.js"
import { SelectRenderable } from "./Select.js"
import { SliderRenderable } from "./Slider.js"
import { TabSelectRenderable, type TabSelectOption, type TabSelectRenderableOptions } from "./TabSelect.js"
import { TextRenderable } from "./Text.js"
import { TextareaRenderable } from "./Textarea.js"
import { TimeToFirstDrawRenderable } from "./TimeToFirstDraw.js"

const clock = new ManualClock()
let setup: TestRendererSetup
let renderer: TestRendererSetup["renderer"]

beforeAll(async () => {
  setup = await createTestRenderer({ width: 40, height: 12, clock })
  renderer = setup.renderer
})

// A failed test must not leave nodes that later rows hit.
afterEach(() => {
  for (const child of renderer.root.getChildren()) child.destroyRecursively()
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
    expect([index, option]).toEqual([node.getSelectedIndex(), node.getSelectedOption()])
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

// Names and the description are cut by display width on a glyph, with "…" right after the kept text (032).
const tabPaints: {
  name: string
  options: TabSelectRenderableOptions & { options: TabSelectOption[] }
  lines: string[]
}[] = [
  {
    name: "the visible tabs, the underline, the description, and scroll arrows",
    options: { options: [...items, ...items] },
    lines: ["‹four      five      one       two     ›", "                    ▬▬▬▬▬▬▬▬▬▬", " one item"],
  },
  {
    name: "wide and surrogate-pair names cut by display width",
    options: {
      showDescription: false,
      showUnderline: false,
      options: ["設定とオプション", "abcdef😀xy", "three", "設定"].map((name) => ({ name, description: "" })),
    },
    lines: [" 設定と…   abcdef…   three     設定"],
  },
  {
    name: "a wide description cut by display width",
    options: { showUnderline: false, options: [{ name: "a", description: "あ".repeat(20) }] },
    lines: [" a", ` ${"あ".repeat(18)}…`],
  },
  {
    name: "no text in tabs without room for it",
    options: { tabWidth: 2, showDescription: false, showUnderline: false, options: [{ name: "ab", description: "" }] },
    lines: [""],
  },
  {
    name: "an ellipsis in a tab with room for one cell",
    options: { tabWidth: 3, showDescription: false, showUnderline: false, options: [{ name: "ab", description: "" }] },
    lines: [" …"],
  },
  {
    name: "an underline without a description",
    options: { showDescription: false, options: items.slice(0, 2) },
    lines: [" one       two", "▬▬▬▬▬▬▬▬▬▬"],
  },
]

test.each(tabPaints)("TabSelect paints $name", async ({ options, lines }) => {
  const tabs = new TabSelectRenderable(renderer, { width: "100%", tabWidth: 10, ...options })
  renderer.root.add(tabs)
  if (options.options.length > 5) tabs.setSelectedIndex(5)
  await setup.renderOnce()
  const frame = setup.captureCharFrame().split("\n")
  expect(frame.slice(0, lines.length).map((line) => line.trimEnd())).toEqual(lines)
})

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const hex = (color: RGBA) => rgbToHex(color).slice(1)

// A frame's visible cells, [grapheme, fg, bg] each: the foreground of a blank cell without attributes does not show.
function cells(frame: CapturedFrame, rows = frame.rows): [string, RGBA | null, RGBA][][] {
  return frame.lines
    .slice(0, rows)
    .map((line) =>
      line.spans.flatMap((span) =>
        Array.from(graphemes.segment(span.text), ({ segment }): [string, RGBA | null, RGBA] => [
          segment,
          segment.trim() || span.attributes ? span.fg : null,
          span.bg,
        ]),
      ),
    )
}

// Each row of the first `width` cells as runs of the same visible colors, `text fg/bg|…` with hex colors.
function runs(frame: CapturedFrame, rows: number, width: number): string[] {
  return cells(frame, rows).map((line) => {
    const out: { text: string; fg: RGBA | null; bg: RGBA }[] = []
    for (const [text, fg, bg] of line.slice(0, width)) {
      const last = out.at(-1)
      if (last?.bg.equals(bg) && (!fg || !last.fg || last.fg.equals(fg))) {
        last.text += text
        last.fg ??= fg
      } else out.push({ text, fg, bg })
    }
    return out.map(({ text, fg, bg }) => `${text} ${fg ? hex(fg) : ""}/${hex(bg)}`).join("|")
  })
}

// Default colors over a backdrop: the transparent background shows it, and focus fills the control opaque. Each
// row focuses one control, so the other paints unfocused.
const selectRows = [
  " ▶ one         ffff00/334455|             /102030",
  "   one item    cccccc/334455|             /102030",
]
const tabRows = [" one     ffffff/102030| two     ffff00/334455| three     ffffff/102030"]
const defaultPaints: [string, string[]][] = [
  [
    "Select",
    [
      ...selectRows,
      "   two         ffffff/1a1a1a|             /102030",
      "   two item    888888/1a1a1a|             /102030",
      ...tabRows,
      "         /102030|▬▬▬▬▬▬▬▬ ffff00/334455|           /102030",
      " two item                  cccccc/102030",
    ],
  ],
  [
    "TabSelect",
    [
      ...selectRows,
      "   two                     ffffff/102030",
      "   two item                888888/102030",
      " one     ffffff/1a1a1a| two     ffff00/334455| three   ffffff/1a1a1a|   /102030",
      "         /1a1a1a|▬▬▬▬▬▬▬▬ ffff00/334455|         /1a1a1a|   /102030",
      " two item                cccccc/1a1a1a|   /102030",
    ],
  ],
]

test.each(defaultPaints)("Select and TabSelect default colors over a backdrop, focus %s", async (focus, lines) => {
  const backdrop = new BoxRenderable(renderer, { width: 26, height: 7, backgroundColor: "#102030" })
  const select = new SelectRenderable(renderer, { width: 14, height: 4, options: items.slice(0, 3) })
  const tabs = new TabSelectRenderable(renderer, { width: 24, tabWidth: 8, options: items.slice(0, 3) })
  backdrop.add(select)
  backdrop.add(tabs)
  renderer.root.add(backdrop)
  ;(focus === "Select" ? select : tabs).focus()
  tabs.setSelectedIndex(1)
  await setup.renderOnce()
  expect(runs(setup.captureSpans(), 7, 26)).toEqual(lines)
})

// 029: the tabs paint on the first frame, also when the width gives the layout the constructor's size. The
// `tabPaints` rows cover a "100%" width.
test.each([false, true])("TabSelect with width 40 paints on the first frame, buffered %p", async (buffered) => {
  renderer.root.add(
    new TabSelectRenderable(renderer, { width: 40, tabWidth: 10, options: items.slice(0, 1), buffered }),
  )
  await setup.renderOnce()
  expect(setup.captureCharFrame().split("\n")[0].trimEnd()).toBe(" one")
})

const wide = "設定とオプション設"
const wideItems = Array.from({ length: 10 }, () => ({ name: wide, description: wide }))
const translucent = {
  backgroundColor: "#20202080",
  focusedBackgroundColor: "#30303080",
  selectedBackgroundColor: "#33445580",
}
// Recorded into the frame, a control paints what its composed `buffered: true` buffer paints: exactly with opaque
// layer colors, also under parent opacity 0.5, and within 2 per channel with translucent ones over a translucent
// background. Translations cut the left and top edges, and the last one the bottom (the font's second row).
// The "wide" rows put a wide glyph under the scroll indicator, over the transparent background; the font's "three"
// is wider than the node. The frame after a key press makes no native draw call and has no buffer unless buffered.
const recordCases: [string, typeof Select | typeof Tabs, object, number?][] = [
  ["Select", Select, { options: items, focusable: false }],
  ["Select focused", Select, { options: items, backgroundColor: "#101820", focusedBackgroundColor: "#182028" }],
  ["Select font", Select, { options: items.slice(2), font: "tiny", backgroundColor: "#101820", focusable: false }],
  ["Select wide name", Select, { options: wideItems, showScrollIndicator: true, selectedIndex: 5, focusable: false }],
  [
    "Select wide description",
    Select,
    { options: wideItems, showScrollIndicator: true, selectedIndex: 6, focusable: false },
  ],
  [
    "Select too short for an item",
    Select,
    { options: items, height: 1, showScrollIndicator: true, backgroundColor: "#101820", focusable: false },
  ],
  // "down" would move an empty Select's index to -1, which hides a missing options check.
  [
    "Select empty",
    Select,
    { options: [], backgroundColor: "#101820", keyBindings: [{ name: "down", action: "move-up" }], focusable: false },
  ],
  ["Select translucent", Select, { options: items, font: "tiny", ...translucent }, 2],
  ["TabSelect", Tabs, { options: [...items, ...items], selectedIndex: 5, focusable: false }],
  ["TabSelect focused", Tabs, { options: wideItems.slice(0, 3), backgroundColor: "#101820" }],
  ["TabSelect empty", Tabs, { options: [], backgroundColor: "#101820", focusable: false }],
  ["TabSelect translucent", Tabs, { options: [...items, ...items], showUnderline: false, ...translucent }, 2],
]

test.each(recordCases)("%s records what its buffer composes", async (_, Control, options, tolerance = 0) => {
  const errors: string[] = []
  const onError = ({ error }: { error: Error }) => errors.push(error.message)
  renderer.on(CliRenderEvents.RENDER_ERROR, onError)
  const content = Array.from({ length: 12 }, (_, i) => `${i}`.repeat(40)).join("\n")
  const symbols = (resolveRenderLib() as unknown as { opentui: { symbols: Record<string, (...args: any[]) => any> } })
    .opentui.symbols
  const originals = { ...symbols }
  let draws = 0
  for (const name of Object.keys(originals).filter((name) => name.startsWith("ot_buffer_draw"))) {
    symbols[name] = (...args) => (draws++, originals[name](...args))
  }
  for (const opacity of tolerance ? [1] : [1, 0.5]) {
    for (const [translateX, translateY] of [
      [0, 0],
      [0.5, 0.5],
      [-2.5, -1.5],
      [-1.5, 8.5],
    ]) {
      const frames = []
      for (const buffered of [true, false]) {
        const parent = new BoxRenderable(renderer, { position: "absolute", left: 1, opacity })
        Object.assign(parent, { translateX, translateY })
        parent.add(
          new TextRenderable(renderer, { position: "absolute", width: 40, content, fg: "#c0c0c0", bg: "#402010" }),
        )
        const node = new Control(renderer, { width: 21, height: 7, tabWidth: 7, ...options, buffered })
        parent.add(node)
        renderer.root.add(parent)
        if (node.focusable) node.focus()
        if ("selectedIndex" in options) node.setSelectedIndex(options.selectedIndex as number)
        await setup.renderOnce()
        node.handleKeyPress(key(Control === Select ? "down" : "right"))
        draws = 0
        await setup.renderOnce()
        expect([Reflect.get(node, "frameBuffer") === null, draws === 0]).toEqual([!buffered, !buffered])
        // An unchanged frame paints the same cells.
        const painted = setup.captureSpans()
        await setup.renderOnce()
        expect(setup.captureSpans()).toEqual(painted)
        frames.push(
          cells(painted)
            .flat()
            .map(([text, fg, bg]) => [text, ...(fg?.toInts() ?? []), ...bg.toInts()]),
        )
        parent.destroyRecursively()
        // A failed frame must not leave the previous control's cells for the next capture.
        await setup.renderOnce()
      }
      expect(errors.splice(0)).toEqual([])
      const [a, b] = frames
      const close = (v: string | number, w: string | number) => v === w || Math.abs(+v - +w) <= tolerance
      if (
        a.length !== b.length ||
        a.some((cell, i) => cell.length !== b[i].length || cell.some((v, j) => !close(v, b[i][j])))
      ) {
        expect(b).toEqual(a)
      }
    }
  }
  Object.assign(symbols, originals)
  renderer.off(CliRenderEvents.RENDER_ERROR, onError)
})

// A font cut at the top or the bottom draws the rows inside the buffer. Every call returns the laid-out size, also
// when no row is inside.
test.each([-1, 3, -2, 4])("renderFontToFrameBuffer at y %d draws the rows inside the buffer", (y) => {
  const draw = (height: number, y: number) => {
    const buffer = OptimizedBuffer.create(12, height, renderer.widthMethod, { owner: renderer.nativeScene })
    const size = renderFontToFrameBuffer(buffer, { text: "ab", y, font: "tiny" })
    const rows = buffer.getSpanLines().map((line) => line.spans.map((span) => span.text).join(""))
    buffer.destroy()
    return { size, rows }
  }
  const cut = draw(4, y)
  const whole = draw(12, 6)
  expect(cut.size).toEqual(whole.size)
  expect(cut.rows).toEqual(cut.rows.map((_, row) => whole.rows[row - y + 6]))
})

// Steps: a key, `#n` for scrollTo(n, n), `[shift+]wheel:direction`, `arrow:start|end` (click), `auto:x,y`
// (updateAutoScroll, then a 100 ms frame), `press|move|release:x,y` (left button, then a frame), or `grow:h,ch`
// (`growx:w,cw`) to set the box's height and its child's height (widths) in one frame, `wait:ms` (advance the clock,
// then a frame), or `destroy` (`destroy:change`: on the bar's next change). Each step records scrollTop,scrollLeft and
// a "!" prefix when a key is not handled; an auto step adds "-" when auto-scroll stopped. Once the box is destroyed, a
// step records its pending timers.
// Edge distances 1, 2, 3 pick the fast, medium, slow speeds.
const scrolling: [string, object, string, string][] = [
  [
    "keys",
    { scrollX: true },
    "down j up k right l left h pagedown pageup end home a",
    "2,0 4,0 2,0 0,0 0,4 0,8 0,4 0,0 5,0 1,0 91,0 0,0 !0,0",
  ],
  ["keys without scrollX", {}, "right l end", "0,0 0,0 90,0"],
  [
    "wheel",
    { scrollX: true },
    "wheel:down wheel:up wheel:right wheel:left shift+wheel:down shift+wheel:up",
    "1,0 0,0 0,1 0,0 0,1 0,0",
  ],
  ["arrows", { scrollbarOptions: { showArrows: true } }, "arrow:end arrow:end arrow:start", "5,0 10,0 5,0"],
  // A held arrow repeats after 500 ms, then every 200 ms, until it is released or the box is destroyed.
  ...[
    ["release:19,9", "5,0 10,0 12,0 12,0 12,0"],
    ["destroy", "5,0 10,0 12,0 timers 0 timers 0"],
    ["destroy:change", "5,0 10,0 12,0 12,0 timers 0"],
  ].map(([end, expected]): [string, object, string, string] => [
    `held arrow, then ${end}`,
    { scrollbarOptions: { showArrows: true } },
    `press:19,9 wait:500 wait:200 ${end} wait:200`,
    expected,
  ]),
  [
    "auto-scroll",
    { scrollX: true },
    "#10 auto:10,9 auto:10,8 auto:10,7 auto:10,0 auto:0,5 auto:19,5 auto:10,5",
    "10,10 17,10 20,10 21,10 15,10 15,3 15,10 15,10-",
  ],
  ["auto-scroll without scrollX", {}, "#10 auto:0,5", "10,0 10,0-"],
  // Content shorter than the viewport and narrower than its padded width: no step moves, and no position is negative.
  [
    "content that fits",
    { scrollX: true, contentOptions: { minHeight: 0 }, viewportOptions: { paddingRight: 3 }, child: { height: 3 } },
    "#100 down end right wheel:down shift+wheel:down",
    "0,0 0,0 0,0 0,0 0,0 0,0",
  ],
  // The thumb in column 19 owns the drag even when the first motion report is off it; a later drag from the
  // content across the bar does not scroll.
  ...["19", "18"].map((x): [string, object, string, string] => [
    `thumb drag, first report at column ${x}`,
    {},
    `press:19,0 move:${x},2 move:19,4 release:${x},4 press:5,5 move:19,5 move:19,8 release:19,8`,
    "0,0 20,0 40,0 40,0 40,0 40,0 40,0 40,0",
  ]),
  // The box and its content growing in one frame clamp against that frame's range, not a stale one (338).
  ["same-frame growth keeps the position", { child: { width: 10, height: 15 } }, "#5 grow:20,25", "5,0 5,0"],
  ["same-frame growth clamps to the new range", { child: { width: 10, height: 15 } }, "#5 grow:20,22", "5,0 2,0"],
  [
    "same-frame horizontal growth keeps the position",
    { scrollX: true, child: { width: 25, height: 5 } },
    "#5 growx:30,35",
    "0,5 0,5",
  ],
  [
    "same-frame growth keeps a sticky reader away from the edge",
    { stickyScroll: true, stickyStart: "bottom", child: { width: 10, height: 15 } },
    "#2 grow:20,25",
    "2,0 2,0",
  ],
  // Vertical viewport padding leaves the whole content reachable (321).
  ["viewport padding", { viewportOptions: { paddingTop: 2 }, child: { height: 20 } }, "end", "12,0"],
  ["viewport padding on both edges", { viewportOptions: { paddingY: 2 }, child: { height: 20 } }, "end", "14,0"],
  [
    "viewport padding on both sides",
    { scrollX: true, viewportOptions: { paddingX: 2 }, child: { width: 40, height: 5 } },
    "#100",
    "0,24",
  ],
]

test.each(scrolling)("ScrollBox %s", async (_, options, steps, expected) => {
  const { child = { width: 100, height: 100 }, ...rest } = options as { child?: object }
  const scroll = new ScrollBoxRenderable(renderer, { width: 20, height: 10, ...rest })
  const content = new BoxRenderable(renderer, child)
  scroll.add(content)
  renderer.root.add(scroll)
  await setup.renderOnce()
  const timers = clock.pendingTimerCount
  const trace: string[] = []
  for (const step of steps.split(" ")) {
    const [kind, arg] = step.split(":")
    let token = ""
    if (step.startsWith("#")) scroll.scrollTo({ x: Number(step.slice(1)), y: Number(step.slice(1)) })
    else if (kind.endsWith("wheel"))
      await setup.mockMouse.scroll(5, 5, arg as "up", { modifiers: { shift: kind !== "wheel" } })
    else if (kind === "arrow") {
      const bar = scroll.verticalScrollBar
      await setup.mockMouse.click(bar.x, arg === "end" ? bar.y + bar.height - 1 : bar.y)
    } else if (kind === "grow" || kind === "growx") {
      const [size, child] = arg.split(",").map(Number)
      if (kind === "grow") [scroll.height, content.height] = [size, child]
      else [scroll.width, content.width] = [size, child]
      await setup.renderOnce()
    } else if (kind === "auto") {
      scroll.updateAutoScroll(...(arg.split(",").map(Number) as [number, number]))
      clock.advance(100)
      await setup.renderOnce()
      if (!scroll.live) token = "-"
    } else if (kind === "wait" || kind === "destroy") {
      if (kind === "wait") clock.advance(Number(arg))
      else if (arg) scroll.verticalScrollBar.once("change", () => scroll.destroyRecursively())
      else scroll.destroyRecursively()
      await setup.renderOnce()
    } else if (kind === "press" || kind === "move" || kind === "release") {
      const [x, y] = arg.split(",").map(Number)
      await setup.mockMouse[kind === "press" ? "pressDown" : kind === "move" ? "moveTo" : "release"](x, y)
      await setup.renderOnce()
    } else if (!scroll.handleKeyPress(key(step))) token = "!"
    if (scroll.isDestroyed) {
      trace.push(`timers ${clock.pendingTimerCount - timers}`)
      continue
    }
    // One position: the bars and the content's origin agree with scrollTop and scrollLeft.
    const { viewport, wrapper } = scroll
    expect([
      wrapper.height - scroll.height,
      wrapper.width - viewport.width,
      scroll.horizontalScrollBar.scrollPosition - scroll.scrollLeft,
      scroll.verticalScrollBar.scrollPosition - scroll.scrollTop,
      scroll.content.x + scroll.scrollLeft - viewport.x - viewport.paddingLeft,
      scroll.content.y + scroll.scrollTop - viewport.y - viewport.paddingTop,
    ]).toEqual([0, 0, 0, 0, 0, 0])
    trace.push(
      token === "!" ? `!${scroll.scrollTop},${scroll.scrollLeft}` : `${scroll.scrollTop},${scroll.scrollLeft}${token}`,
    )
  }
  expect(trace.join(" ")).toBe(expected)
})

// Host requests (P1 frameWork) of the frame after each step: the update hook asks only while auto-scrolling, and the
// SCROLL request comes only while a part has a listener (`listen` adds a content "resize" and a bar "change" listener;
// it hears changes from then on). Listeners of events a part does not emit ask for nothing. The counts of the events
// follow the trace. `+n` counts the renderer's selection listeners: the box listens once while it auto-scrolls, also
// while it is detached, and a finished selection stops it; a destroyed box does not listen.
test("ScrollBox host requests per frame", async () => {
  const scroll = new ScrollBoxRenderable(renderer, { width: 20, height: 10 })
  for (let i = 0; i < 20; i++) scroll.add(new BoxRenderable(renderer, { height: 1 }))
  renderer.root.add(scroll)
  await setup.renderOnce()
  const steps: Record<string, () => unknown> = {
    idle: () => {},
    scroll: () => scroll.scrollBy(3),
    wheel: () => setup.mockMouse.scroll(5, 5, "down"),
    append: () => scroll.add(new BoxRenderable(renderer, { height: 1 })),
    auto: () => (scroll.updateAutoScroll(10, 9), clock.advance(100)),
    "start twice": () => (scroll.startAutoScroll(10, 0), scroll.startAutoScroll(10, 0)),
    stop: () => scroll.stopAutoScroll(),
    "auto+remove": () => (scroll.updateAutoScroll(10, 0), renderer.root.remove(scroll)),
    add: () => renderer.root.add(scroll),
    selection: () => renderer.emit(CliRenderEvents.SELECTION, null),
    listen: () => (scroll.content.on("resize", resized), scroll.verticalScrollBar.on("change", changed)),
    "append+listeners": () => scroll.add(new BoxRenderable(renderer, { height: 1 })),
    "idle+listeners": () => {},
    "scroll+listeners": () => scroll.scrollBy(3),
    unlisten: () => (scroll.content.off("resize", resized), scroll.verticalScrollBar.off("change", changed)),
    "append again": () => scroll.add(new BoxRenderable(renderer, { height: 1 })),
    unsupported: () => (scroll.content.on("change", changed), scroll.verticalScrollBar.on("resize", resized)),
    "append unsupported": () => scroll.add(new BoxRenderable(renderer, { height: 1 })),
    "destroy+auto": () => (scroll.updateAutoScroll(10, 0), scroll.destroyRecursively()),
    "start after destroy": () => scroll.startAutoScroll(10, 0),
  }
  let events = ""
  const resized = () => (events += "r")
  const changed = () => (events += "c")
  const trace: string[] = []
  for (const [name, step] of Object.entries(steps)) {
    await step()
    renderer.requestRender()
    await setup.renderOnce()
    const listeners = renderer.listenerCount(CliRenderEvents.SELECTION) || ""
    trace.push(`${name}:${renderer.getNativeStats().frameWork.hostRequests}${events}${listeners && `+${listeners}`}`)
    events = ""
  }
  expect(trace.join(" ")).toBe(
    "idle:0 scroll:0 wheel:0 append:0 auto:1+1 start twice:1+1 stop:0 auto+remove:0+1 add:1+1 selection:0 listen:0 " +
      "append+listeners:1r idle+listeners:0 " +
      "scroll+listeners:0c unlisten:0 append again:0 unsupported:0 append unsupported:0 destroy+auto:0 " +
      "start after destroy:0",
  )
})

// Wheel steps over an inner scroller in an outer ScrollBox (scrolled to 5, rows 5..8 show the inner node). A step
// belongs to the innermost scroller that can still move that way, which keeps its acceleration and fractional
// remainder; at its edge, or on an axis it cannot scroll, the step reaches the outer box. `x` is a horizontal-only
// ScrollBox (as in a wide formula inside a transcript); `textx` and `textareax` hold 40-cell lines without wrapping.
// The outer box also scrolls sideways. Columns: inner start, steps (`grow` adds four rows to an inner ScrollBox), the
// inner offset and the outer box's top,left after the steps, and the inner box's acceleration per step.
type InnerKind = "scrollbox" | "x" | "text" | "textarea" | "textx" | "textareax"
type ChainRow = [InnerKind, number, string, number, string, number[]?]
const chaining: ChainRow[] = [
  ...(["scrollbox", "text", "textarea"] as const).flatMap((kind): ChainRow[] => [
    [kind, 0, "down", 1, "5,0"],
    [kind, 0, "up", 0, "4,0"],
    [kind, 3, "down", 4, "5,0"],
    [kind, 3, "up", 2, "5,0"],
    [kind, 6, "down", 6, "6,0"],
    [kind, 6, "up", 5, "5,0"],
    [kind, 3, "shift+down", 3, "5,1"],
  ]),
  ["x", 0, "down", 0, "6,0"],
  ["x", 0, "shift+down", 1, "5,0"],
  ["x", 40, "shift+down", 40, "5,1"],
  ...(["textx", "textareax"] as const).flatMap((kind): ChainRow[] => [
    [kind, 0, "right", 1, "5,0"],
    [kind, 0, "shift+down", 1, "5,0"],
    [kind, 20, "right", 20, "5,1"],
  ]),
  // A reversal drops the remainder left by an accelerated step, so the step still moves the inner box.
  ["scrollbox", 3, "down,up", 4, "5,0", [2.5, 1]],
  // Half-cell steps add up in the inner box only.
  ["scrollbox", 3, "down,down,down,down", 5, "5,0", [0.5]],
  // Steps the inner box cannot take do not tick its acceleration.
  ["x", 0, "down,down,shift+down", 1, "7,0", [1, 5, 9]],
  // An edge clamp drops the remainder; after growth the next half step only adds up.
  ["scrollbox", 5, "down,grow,down", 6, "5,0", [2.5, 0.6]],
]

// A rest parameter keeps the callback's arity at zero, so rows without an acceleration do not look like a `done` test.
test.each(chaining)("wheel chaining over an inner %s at %d, %s", async (...row: ChainRow) => {
  const [kind, start, steps, inner, outer, accel] = row
  const wide = kind === "textx" || kind === "textareax"
  const lines = Array.from({ length: 10 }, (_, i) => `line ${i}` + (wide ? " " + "x".repeat(33) : "")).join("\n")
  const outerBox = new ScrollBoxRenderable(renderer, { width: 30, height: 10, scrollX: true })
  const filler = () => new BoxRenderable(renderer, { width: 40, height: 1, flexShrink: 0 })
  for (let i = 0; i < 5; i++) outerBox.add(filler())
  let tick = 0
  const scrollAcceleration = accel && { tick: () => accel[Math.min(tick++, accel.length - 1)], reset: () => {} }
  const size = { width: 20, height: 4, flexShrink: 0, ...(wide ? { wrapMode: "none" as const } : {}) }
  const node =
    kind === "scrollbox" || kind === "x"
      ? new ScrollBoxRenderable(renderer, { ...size, scrollX: kind === "x", scrollY: kind !== "x", scrollAcceleration })
      : kind === "text" || kind === "textx"
        ? new TextRenderable(renderer, { ...size, content: lines })
        : new TextareaRenderable(renderer, { ...size, initialValue: lines })
  const rows = (count: number) => {
    if (!(node instanceof ScrollBoxRenderable)) return
    for (let i = 0; i < count; i++) node.add(new BoxRenderable(renderer, { width: kind === "x" ? 60 : 10, height: 1 }))
  }
  rows(10)
  outerBox.add(node)
  for (let i = 0; i < 30; i++) outerBox.add(filler())
  renderer.root.add(outerBox)
  await setup.renderOnce()
  outerBox.scrollTop = 5
  const offset = () =>
    node instanceof ScrollBoxRenderable
      ? kind === "x"
        ? node.scrollLeft
        : node.scrollTop
      : node instanceof TextRenderable
        ? wide
          ? node.scrollX
          : node.scrollY
        : node.editorView.getViewport()[wide ? "offsetX" : "offsetY"]
  if (node instanceof ScrollBoxRenderable) node.scrollTo(kind === "x" ? { x: start, y: 0 } : start)
  else if (node instanceof TextRenderable) node[wide ? "scrollX" : "scrollY"] = start
  else if (wide) {
    // The editor keeps its cursor in view, so put it where the sideways offset can move without hiding it.
    node.setCursor(0, start + 5)
    node.editorView.setViewport(start, 0, node.width, node.height, false)
  } else node.editorView.setViewport(0, start, node.width, node.height, true)
  await setup.renderOnce()
  expect([offset(), `${outerBox.scrollTop},${outerBox.scrollLeft}`]).toEqual([start, "5,0"])
  for (const step of steps.split(",")) {
    if (step === "grow") rows(4)
    else {
      const [modifier, direction] = step.includes("+") ? step.split("+") : ["", step]
      await setup.mockMouse.scroll(2, 1, direction as "down", { modifiers: { shift: modifier === "shift" } })
    }
    await setup.renderOnce()
  }
  expect([offset(), `${outerBox.scrollTop},${outerBox.scrollLeft}`]).toEqual([inner, outer])
})

// Only a scroller inside the current one keeps it from taking a step: a listener that passes the same event to a
// sibling box (scroll sync) scrolls both.
test("wheel event passed on to a sibling ScrollBox scrolls both", async () => {
  const row = new BoxRenderable(renderer, { flexDirection: "row", width: 40, height: 4 })
  const [left, right] = [0, 1].map(() => {
    const box = new ScrollBoxRenderable(renderer, { width: 20, height: 4 })
    for (let i = 0; i < 10; i++) box.add(new BoxRenderable(renderer, { height: 1 }))
    row.add(box)
    return box
  })
  left.onMouseScroll = (event) => right.processMouseEvent(event)
  renderer.root.add(row)
  await setup.renderOnce()
  await setup.mockMouse.scroll(2, 1, "down")
  expect([left.scrollTop, right.scrollTop]).toEqual([1, 1])
})

// A subclass that overrides renderSelf paints through the JS fallback, which must match the native paint, also at
// fractional and negative translations.
const paintCases: [string, typeof BoxRenderable, object][] = [
  ["Slider x", SliderRenderable as never, { orientation: "horizontal", value: 13, viewPortSize: 17, width: 11 }],
  ["Slider y", SliderRenderable as never, { orientation: "vertical", value: 87, viewPortSize: 17, width: 2 }],
  ["Arrow", ArrowRenderable as never, { direction: "left", foregroundColor: "#ff0000", backgroundColor: "#0000ff" }],
  ["Box titles", BoxRenderable, { border: true, titleColor: "red", bottomTitle: "B", bottomTitleAlignment: "right" }],
  [
    "Box sides",
    BoxRenderable,
    { border: ["top", "left"], borderStyle: "double", title: "x", backgroundColor: "#203040" },
  ],
  ["Box focused", BoxRenderable, { border: true, shouldFill: false, backgroundColor: "#ff0000", focusable: true }],
  ["Box layout-only", BoxRenderable, {}],
  ["Box fill only", BoxRenderable, { backgroundColor: "#203040" }],
  // A focused child gives a focusable box its focused border and title color.
  ["Box focus-within", BoxRenderable, { border: true, focusable: true, title: "f", focusWithin: true }],
  // 328: a buffered box draws at its buffer's origin; only the JS control is buffered.
  ["Box buffered", BoxRenderable, { border: true, title: "b", backgroundColor: "#203040", buffered: true }],
]

test.each(paintCases)("%s JS fallback paint matches native paint", async (name, Native, options) => {
  let jsPaints = 0
  const errors: string[] = []
  const onError = ({ error }: { error: Error }) => errors.push(error.message)
  renderer.on(CliRenderEvents.RENDER_ERROR, onError)
  // Recording bytes per frame: a box that draws nothing must record nothing.
  let recorded = 0
  const end = NativePaintRecorder.prototype.end
  NativePaintRecorder.prototype.end = function (this: NativePaintRecorder) {
    recorded += this.recording?.length ?? 0
    end.call(this)
  }
  const Js = class extends Native {
    protected override renderSelf(buffer: OptimizedBuffer): void {
      jsPaints++
      super.renderSelf(buffer)
    }
  }
  for (const translateX of [0, 0.5, -1.5, -2.5]) {
    const translateY = translateX < 0 ? translateX + 1 : translateX
    const frames: CapturedFrame[] = []
    for (const Control of [Js, Native]) {
      const parent = new BoxRenderable(renderer, { position: "absolute", left: 2, top: 1 })
      Object.assign(parent, { translateX, translateY })
      const node = new Control(renderer, {
        width: 9,
        height: 4,
        ...options,
        buffered: Control === Js && "buffered" in options,
      })
      parent.add(node)
      renderer.root.add(parent)
      if ("focusWithin" in options) {
        const child = new BoxRenderable(renderer, { focusable: true, width: 1, height: 1 })
        node.add(child)
        child.focus()
      } else if (node.focusable) node.focus()
      await setup.renderOnce()
      frames.push(setup.captureSpans())
      parent.destroyRecursively()
      // A failed frame must not leave the previous control's cells for the next capture.
      await setup.renderOnce()
    }
    expect(errors.splice(0)).toEqual([])
    expect(frames[0]).toEqual(frames[1])
    if ("focusWithin" in options) {
      const corner = frames[1].lines.flatMap((line) => line.spans).find((span) => span.text.includes("f"))
      expect(corner?.fg.toInts()).toEqual([0, 170, 255, 255])
    }
  }
  renderer.off(CliRenderEvents.RENDER_ERROR, onError)
  NativePaintRecorder.prototype.end = end
  expect(jsPaints).toBe(4)
  if (name === "Box layout-only") expect(recorded).toBe(0)
})

const hostPaintCases: [string, () => Renderable][] = [
  ["TimeToFirstDraw", () => new TimeToFirstDrawRenderable(renderer, { width: 20, label: "t", precision: 0 })],
  [
    "LineNumber with a content line color",
    () =>
      new LineNumberRenderable(renderer, {
        target: new TextRenderable(renderer, { content: "a\nb\nc" }),
        width: 8,
        lineColors: new Map([[1, "#203040"]]),
      }),
  ],
]

// A host body paints at the truncated screen position, as native bodies do. Screen x -3.5 and y -0.5
// truncate toward zero, unlike floor; at -3.5 the LineNumber and its children all sit left of 0.
test.each(hostPaintCases)("%s paints at a fractional position", async (_, create) => {
  const errors: string[] = []
  const onError = ({ error }: { error: Error }) => errors.push(error.message)
  renderer.on(CliRenderEvents.RENDER_ERROR, onError)
  const parent = new BoxRenderable(renderer, { position: "absolute", left: 2, top: 1 })
  parent.add(create())
  renderer.root.add(parent)
  const capture = async (translateX: number, translateY: number) => {
    Object.assign(parent, { translateX, translateY })
    await setup.renderOnce()
    return setup.captureSpans()
  }
  for (const [x, y] of [
    [0.5, 0],
    [-1.5, 0],
    [0, 0.5],
    [0, -1.5],
    [-5.5, 0],
  ]) {
    const frame = await capture(x, y)
    expect(errors.splice(0)).toEqual([])
    expect(frame.lines[Math.trunc(1 + y)].spans.some((span) => span.text.trim() !== "")).toBe(true)
    expect(frame).toEqual(await capture(Math.trunc(2 + x) - 2, Math.trunc(1 + y) - 1))
  }
  renderer.off(CliRenderEvents.RENDER_ERROR, onError)
})

// Today's gutter frames: default colors, and opaque gutter, line and sign colors under ancestor opacity 0.6×0.7. The
// signs pad and align, line 3 hides its number, line 4 shows a custom one, and line 2 wraps.
const gutterPaints: [string, number[], object, string[]][] = [
  [
    "default colors",
    [1, 1],
    {
      lineSigns: new Map([
        [0, { before: "+" }],
        [1, { before: "--" }],
        [2, { after: "!" }],
      ]),
    },
    [
      " +  1   888888/102030|one             ffffff/102030",
      "--  2   888888/102030|two             ffffff/102030",
      "    3!  888888/102030|three four      ffffff/102030",
      "       five            ffffff/102030",
      "       six             ffffff/102030",
      "   42   888888/102030|seven           ffffff/102030",
    ],
  ],
  [
    "opaque colors",
    [0.6, 0.7],
    {
      bg: "#283848",
      fg: "#d0c0b0",
      lineColors: new Map<number, string | object>([
        [1, "#304050"],
        [2, { gutter: "#405060", content: "#203040" }],
      ]),
      lineSigns: new Map([
        [0, { before: "+", beforeColor: "#00ff00" }],
        [1, { before: "--" }],
        [2, { after: "!", afterColor: "#ff0000" }],
      ]),
    },
    [
      " +   0f8322/1a2a3a|1   66696c/1a2a3a|one             747e87/102030",
      "--  2   686b6d/1d2d3d|two         7a828b/192837|     /102030",
      "    3 6c6f71/243444|!  801e27/243444|three four  78828b/172737|     /102030",
      "        /243444|five        78828b/172737|     /102030",
      "        /1a2a3a|six             747e87/102030",
      "   42   66696c/1a2a3a|seven           747e87/102030",
    ],
  ],
]

test.each(gutterPaints)("LineNumber gutter paints %s", async (_, [outerOpacity, innerOpacity], options, lines) => {
  const backdrop = new BoxRenderable(renderer, { width: 22, height: 7, backgroundColor: "#102030" })
  const outer = new BoxRenderable(renderer, { opacity: outerOpacity })
  const inner = new BoxRenderable(renderer, { opacity: innerOpacity })
  const text = new TextRenderable(renderer, { content: "one\ntwo\nthree four five\nsix\nseven", wrapMode: "char" })
  const numbers = new LineNumberRenderable(renderer, {
    target: text,
    width: 18,
    hideLineNumbers: new Set([3]),
    lineNumbers: new Map([[4, 42]]),
    ...options,
  })
  inner.add(numbers)
  outer.add(inner)
  backdrop.add(outer)
  renderer.root.add(backdrop)
  await setup.renderOnce()
  expect(runs(setup.captureSpans(), 6, 22)).toEqual(lines)
})

// As on `main`, controls and graphemes longer than a cell holds are accepted when set and skipped when drawn.
test("box titles and arrow characters accept any text", async () => {
  const text = `x\ny\x1b\te${"\u0301".repeat(64)}`
  const errors: unknown[] = []
  renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
  const box = new BoxRenderable(renderer, { border: true, width: 12, height: 3, bottomTitle: text })
  const arrow = new ArrowRenderable(renderer, { direction: "up", height: 1, arrowChars: { up: text } })
  renderer.root.add(box)
  renderer.root.add(arrow)
  box.title = text
  arrow.arrowChars = { up: text.slice(1) }
  await setup.renderOnce()
  expect(errors).toEqual([])
})

// The nullish sweep builds each class with one option set; these sizes depend on other options.
test("a nullish width or height restores the size that the class chose", () => {
  const arrow = new ArrowRenderable(renderer, { direction: "up", width: 3 })
  const terminal = new EmbeddedTerminalRenderable(renderer, { cols: 30, rows: 5, width: 12, height: 4 })
  const tabs = new TabSelectRenderable(renderer, { options: [{ name: "a", description: "b" }], showDescription: false })
  Object.assign(terminal, { width: null, height: null })
  tabs.height = 7
  tabs.height = null
  const sizes = [arrow.getWidth(), terminal.getWidth(), terminal.getHeight(), tabs.getHeight()]
  expect(sizes.map((size) => size.value)).toEqual([3, 30, 5, 2])
  for (const node of [arrow, terminal, tabs]) node.destroyRecursively()
})

test("a nullish scrollbar visible write restores visibility that follows the scroll sizes", () => {
  const bar = new ScrollBarRenderable(renderer, { orientation: "vertical" })
  Object.assign(bar, { scrollSize: 10, viewportSize: 20, visible: true })
  Object.assign(bar, { visible: null })
  expect(bar.visible).toBe(false)
  // The range is below zero, so every write clamps to 0.
  bar.scrollPosition = 3
  expect([bar.scrollPosition, bar.slider.value]).toEqual([0, 0])
  bar.scrollSize = 30
  expect(bar.visible).toBe(true)
  bar.destroyRecursively()
})

test("refreshHooks() binds a frameBuffer field that replaces the surface", async () => {
  const frame = new FrameBufferRenderable(renderer, { width: 6, height: 1 })
  const replacement = OptimizedBuffer.create(6, 1, renderer.widthMethod, { owner: renderer.nativeScene })
  replacement.drawText("NEWBUF", 0, 0, RGBA.fromInts(255, 255, 255))
  Object.defineProperty(frame, "frameBuffer", { value: replacement, writable: true, configurable: true })
  frame.refreshHooks()
  renderer.root.add(frame)
  await setup.renderOnce()
  expect(setup.captureCharFrame().split("\n")[0].slice(0, 6)).toBe("NEWBUF")
  replacement.destroy()
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
