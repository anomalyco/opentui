import { ResourceContext } from "../buffer.js"

let resourceContext: ResourceContext
beforeEach(() => {
  resourceContext = new ResourceContext({ objectCapacity: 65536, renderCellsMax: 1000000 })
})
afterEach(() => resourceContext.destroy())

import { test, expect, beforeEach, afterEach, describe, spyOn } from "bun:test"
import { createTestRenderer, type TestRenderer, type MockMouse, MockTreeSitterClient } from "../testing.js"
import { ScrollBoxRenderable, type ScrollBoxOptions } from "../renderables/ScrollBox.js"
import { BoxRenderable } from "../renderables/Box.js"
import { TextRenderable } from "../renderables/Text.js"
import { CodeRenderable } from "../renderables/Code.js"
import { MarkdownRenderable } from "../renderables/Markdown.js"
import { LinearScrollAccel, MacOSScrollAccel, type ScrollAcceleration } from "../lib/scroll-acceleration.js"
import { SyntaxStyle } from "../syntax-style.js"

// Test accelerator that returns a constant multiplier
class ConstantScrollAccel implements ScrollAcceleration {
  constructor(private multiplier: number) {}
  tick(_now?: number): number {
    return this.multiplier
  }
  reset(): void {}
}

let testRenderer: TestRenderer
let mockMouse: MockMouse
let renderOnce: () => Promise<void>
let captureCharFrame: () => string
let mockTreeSitterClient: MockTreeSitterClient
let mockTreeSitterClients: MockTreeSitterClient[]

beforeEach(async () => {
  ;({
    renderer: testRenderer,
    mockMouse,
    renderOnce,
    captureCharFrame,
  } = await createTestRenderer({ width: 80, height: 24 }))
  mockTreeSitterClients = []
  mockTreeSitterClient = createMockTreeSitterClient()
})

afterEach(async () => {
  testRenderer.destroy()
  for (const client of mockTreeSitterClients) {
    client.resolveAllHighlightOnce()
    await client.destroy()
  }
})

function createMockTreeSitterClient(): MockTreeSitterClient {
  const client = new MockTreeSitterClient()
  client.setMockResult({ highlights: [] })
  mockTreeSitterClients.push(client)
  return client
}

describe("ScrollBoxRenderable - child delegation", () => {
  test("delegates add to content wrapper", () => {
    const scrollbox = new ScrollBoxRenderable(testRenderer, { id: "scrollbox" })
    const child = new BoxRenderable(testRenderer, { id: "child" })

    scrollbox.add(child)

    const children = scrollbox.getChildren()
    expect(children.length).toBe(1)
    expect(children[0].id).toBe("child")
    expect(child.parent).toBe(scrollbox)
    expect(scrollbox.content.getChildren()).toEqual([child])
  })

  test("delegates remove to content wrapper", () => {
    const scrollbox = new ScrollBoxRenderable(testRenderer, { id: "scrollbox" })
    const child = new BoxRenderable(testRenderer, { id: "child" })

    scrollbox.add(child)
    expect(scrollbox.getChildren().length).toBe(1)

    scrollbox.remove(child)
    expect(scrollbox.getChildren().length).toBe(0)
  })

  test("delegates insertBefore to content wrapper", () => {
    const scrollbox = new ScrollBoxRenderable(testRenderer, { id: "scrollbox" })
    const child1 = new BoxRenderable(testRenderer, { id: "child1" })
    const child2 = new BoxRenderable(testRenderer, { id: "child2" })
    const child3 = new BoxRenderable(testRenderer, { id: "child3" })

    scrollbox.add(child1)
    scrollbox.add(child2)
    scrollbox.insertBefore(child3, child2)

    const children = scrollbox.getChildren()
    expect(children.length).toBe(3)
    expect(children[0].id).toBe("child1")
    expect(children[1].id).toBe("child3")
    expect(children[2].id).toBe("child2")
  })

  test("destroyRecursively detaches children without warnings", () => {
    const scrollbox = new ScrollBoxRenderable(testRenderer, { id: "scrollbox" })
    const child = new BoxRenderable(testRenderer, { id: "child" })
    scrollbox.add(child)

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
    try {
      scrollbox.destroyRecursively()
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }

    expect(child.isDestroyed).toBe(true)
    expect(child.parent).toBeNull()
  })
})

describe("ScrollBoxRenderable - scrollbar callbacks", () => {
  for (const direction of ["vertical", "horizontal"] as const) {
    test(`${direction} callbacks observe scrolling and can be replaced or cleared`, async () => {
      const initial: number[] = []
      const updated: number[] = []
      const shared: number[] = []
      const optionsKey = direction === "vertical" ? "verticalScrollbarOptions" : "horizontalScrollbarOptions"
      const scrollbox = new ScrollBoxRenderable(testRenderer, {
        width: 20,
        height: 8,
        scrollX: true,
        scrollY: true,
        contentOptions: { width: 80, height: 40 },
        scrollbarOptions: { onChange: (position) => shared.push(position) },
        [optionsKey]: { onChange: (position: number) => initial.push(position) },
      })
      testRenderer.root.add(scrollbox)
      await renderOnce()
      const bar = direction === "vertical" ? scrollbox.verticalScrollBar : scrollbox.horizontalScrollBar
      const otherBar = direction === "vertical" ? scrollbox.horizontalScrollBar : scrollbox.verticalScrollBar
      const origin = () =>
        direction === "vertical"
          ? scrollbox.viewport.y - scrollbox.content.y
          : scrollbox.viewport.x - scrollbox.content.x

      bar.scrollBy(2)
      expect(initial).toEqual([2])
      expect(shared).toEqual([])
      expect(origin()).toBe(2)
      otherBar.scrollBy(1)
      expect(shared).toEqual([1])

      scrollbox[optionsKey] = { onChange: (position) => updated.push(position) }
      bar.scrollBy(2)
      expect(initial).toEqual([2])
      expect(updated).toEqual([4])
      expect(origin()).toBe(4)

      scrollbox[optionsKey] = { showArrows: true }
      bar.scrollBy(1)
      expect(updated).toEqual([4, 5])

      scrollbox[optionsKey] = { onChange: undefined }
      bar.scrollBy(1)
      expect(updated).toEqual([4, 5])
      expect(origin()).toBe(6)

      scrollbox.scrollbarOptions = { onChange: (position) => shared.push(position) }
      scrollbox.scrollBy({ x: 1, y: 1 })
      expect(shared.toSorted()).toEqual([1, 2, 7])
      scrollbox.scrollbarOptions = undefined
      scrollbox.scrollBy({ x: 1, y: 1 })
      expect(shared.toSorted()).toEqual([1, 2, 7])
    })
  }
})

describe("ScrollBoxRenderable - facade", () => {
  // OpenCode's transcript listens to the bar's "change" and the content's "resize". A JS scroll reports "change" at
  // once; native changes (sticky follow, growth) reach the listeners in the frame that makes them, before paint.
  // Row positions read in the listener and right after a scroll are fresh. Each step records the events since the
  // last step, then `y` of row 0 relative to the viewport.
  test("events and fresh row positions", async () => {
    const events: string[] = []
    const rows: TextRenderable[] = []
    const scrollbox = new ScrollBoxRenderable(testRenderer, {
      width: 20,
      height: 10,
      stickyScroll: true,
      stickyStart: "bottom",
      verticalScrollbarOptions: { onChange: (position) => events.push(`onChange ${position}`) },
      viewportOptions: { onSizeChange: () => events.push(`viewport ${scrollbox.viewport.height}`) },
      contentOptions: { onSizeChange: () => events.push(`content ${scrollbox.content.height}`) },
    })
    const row0 = () => rows[0].y - scrollbox.viewport.y
    scrollbox.verticalScrollBar.on("change", ({ position }: { position: number }) =>
      events.push(`change ${position} row0 ${row0()}`),
    )
    scrollbox.content.on("resize", () => events.push(`resize ${scrollbox.scrollHeight} top ${scrollbox.scrollTop}`))
    const add = () => {
      rows.push(new TextRenderable(testRenderer, { content: `row ${rows.length}` }))
      scrollbox.add(rows.at(-1)!)
    }
    for (let i = 0; i < 30; i++) add()
    testRenderer.root.add(scrollbox)
    const trace: string[] = []
    const step = async (name: string, act: () => unknown, frame = true) => {
      await act()
      if (frame) await renderOnce()
      trace.push(`${name}: ${events.splice(0).join(", ")} | row0 ${row0()}`)
    }
    await step("first frame", () => {})
    await step("scrollBy", () => scrollbox.scrollBy(-3), false)
    await step("frame", () => {})
    await step("wheel", () => mockMouse.scroll(5, 5, "up"), false)
    await step("append away", add)
    await step("bottom", () => (scrollbox.scrollTop = scrollbox.scrollHeight), false)
    await step("append", add)
    await step("shrink", () => (scrollbox.height = 8))
    expect(trace).toEqual([
      "first frame: onChange 20, change 20 row0 -20, viewport 10, content 30, resize 30 top 20 | row0 -20",
      "scrollBy: onChange 17, change 17 row0 -17 | row0 -17",
      "frame:  | row0 -17",
      "wheel: onChange 16, change 16 row0 -16 | row0 -16",
      "append away: content 31, resize 31 top 16 | row0 -16",
      "bottom: onChange 21, change 21 row0 -21 | row0 -21",
      "append: onChange 22, change 22 row0 -22, content 32, resize 32 top 22 | row0 -22",
      "shrink: onChange 24, change 24 row0 -24, viewport 8 | row0 -24",
    ])
  })

  // A backfill prepends six rows above a reader at row 4 (or `change` changes the rows). Each row lists the top line of
  // the next three frames and, in parentheses, the frame's host requests: a shifted frame shows a prepended row. The
  // anchor rows are #1357's cases; there a scroll cancelled the anchor, here it moves the line the anchor holds.
  type Backfill = {
    name: string
    hold: (scrollbox: ScrollBoxRenderable, rows: TextRenderable[]) => unknown
    change?: (scrollbox: ScrollBoxRenderable, rows: TextRenderable[]) => void
    culling?: boolean
    frames: string[]
  }
  const prependRows = (scrollbox: ScrollBoxRenderable, rows: TextRenderable[]) => {
    for (let i = 0; i < 6; i++)
      scrollbox.insertBefore(new TextRenderable(testRenderer, { content: `prepended ${i}` }), rows[0])
  }
  test.each<Backfill>([
    {
      // OpenCode's afterLayout: two animation frames, then a scroll by the growth.
      name: "two animation frames",
      hold: (scrollbox) => {
        const before = scrollbox.scrollHeight
        testRenderer.requestAnimationFrame(() =>
          testRenderer.requestAnimationFrame(() => scrollbox.scrollBy(scrollbox.scrollHeight - before)),
        )
      },
      frames: ["prepended 4 (0)", "row 4 (0)", "row 4 (0)"],
    },
    {
      // OpenCode's holdAnchor: a content "resize" listener reads the computed layout and scrolls in the same frame.
      name: "content resize listener",
      hold: (scrollbox, rows) => {
        const top = rows[4].getComputedLayout().top - scrollbox.scrollTop
        scrollbox.content.on("resize", () => scrollbox.scrollTo(rows[4].getComputedLayout().top - top))
      },
      frames: ["row 4 (1)", "row 4 (0)", "row 4 (0)"],
    },
    {
      name: "afterLayout",
      hold: (scrollbox) => {
        const before = scrollbox.scrollHeight
        scrollbox.afterLayout(() => scrollbox.scrollBy(scrollbox.scrollHeight - before))
      },
      frames: ["row 4 (2)", "row 4 (0)", "row 4 (0)"],
    },
    {
      name: "anchor",
      hold: (scrollbox, rows) => scrollbox.anchor(rows[4]),
      frames: ["row 4 (0)", "row 4 (0)", "row 4 (0)"],
    },
    {
      name: "anchor with culling",
      culling: true,
      hold: (scrollbox, rows) => scrollbox.anchor(rows[4]),
      frames: ["row 4 (0)", "row 4 (0)", "row 4 (0)"],
    },
    {
      name: "anchor held through a frame without changes",
      hold: async (scrollbox, rows) => {
        scrollbox.anchor(rows[4])
        await renderOnce()
      },
      frames: ["row 4 (0)", "row 4 (0)", "row 4 (0)"],
    },
    {
      name: "anchor released",
      hold: (scrollbox, rows) => scrollbox.anchor(rows[4])(),
      frames: ["prepended 4 (0)", "prepended 4 (0)", "prepended 4 (0)"],
    },
    {
      // The documented pattern: release after the layout that places the change.
      name: "anchor released in afterLayout",
      hold: (scrollbox, rows) => scrollbox.afterLayout(scrollbox.anchor(rows[4])),
      frames: ["row 4 (2)", "row 4 (0)", "row 4 (0)"],
    },
    {
      name: "a later anchor replaces it, and the first release does nothing",
      hold: (scrollbox, rows) => {
        const release = scrollbox.anchor(rows[2])
        scrollbox.anchor(rows[4])
        release()
      },
      frames: ["row 4 (0)", "row 4 (0)", "row 4 (0)"],
    },
    {
      name: "anchored row removed",
      hold: (scrollbox, rows) => {
        scrollbox.anchor(rows[4])
        rows[4].destroy()
      },
      frames: ["prepended 4 (0)", "prepended 4 (0)", "prepended 4 (0)"],
    },
    {
      name: "anchor below the top, a row above it grows",
      hold: (scrollbox, rows) => scrollbox.anchor(rows[6]),
      change: (_, rows) => (rows[0].content = "row 0\nmore\nmore"),
      frames: ["row 4 (0)", "row 4 (0)", "row 4 (0)"],
    },
    {
      name: "a scroll moves the anchored line",
      hold: (scrollbox, rows) => {
        scrollbox.anchor(rows[4])
        scrollbox.scrollBy(1)
      },
      frames: ["row 5 (0)", "row 5 (0)", "row 5 (0)"],
    },
  ])("a backfill above the reader: $name", async ({ hold, change = prependRows, culling = false, frames }) => {
    const scrollbox = new ScrollBoxRenderable(testRenderer, { width: 20, height: 4, viewportCulling: culling })
    const rows = Array.from({ length: 10 }, (_, i) => new TextRenderable(testRenderer, { content: `row ${i}` }))
    for (const row of rows) scrollbox.add(row)
    testRenderer.root.add(scrollbox)
    await renderOnce()
    scrollbox.scrollTo(4)
    await renderOnce()
    await hold(scrollbox, rows)
    change(scrollbox, rows)
    const tops: string[] = []
    for (let i = 0; i < 3; i++) {
      await renderOnce()
      tops.push(
        `${captureCharFrame().split("\n")[0].slice(0, 15).trim()} (${testRenderer.getNativeStats().frameWork.hostRequests})`,
      )
    }
    expect(tops).toEqual(frames)
  })

  // scrollTo and scrollBy before the first layout land after it: the delta adds to the pending target. afterLayout runs in the
  // next frame once its layout is known (here, with a row added before it), and its scroll shows in that frame; one
  // asked from it runs a frame later, a hidden box keeps it, and one that destroys the box drops the rest.
  test("scroll targets and afterLayout use the next frame's layout", async () => {
    const scrollbox = new ScrollBoxRenderable(testRenderer, { width: 20, height: 4 })
    testRenderer.root.add(scrollbox)
    let count = 0
    const add = (rows: number) => {
      for (let i = 0; i < rows; i++) scrollbox.add(new TextRenderable(testRenderer, { content: `row ${count++}` }))
    }
    const trace: unknown[] = []
    add(30)
    scrollbox.scrollTo(5)
    scrollbox.scrollBy(3)
    expect(() => scrollbox.scrollTo(NaN)).toThrow(RangeError)
    await renderOnce()
    trace.push(scrollbox.scrollTop)
    add(200)
    scrollbox.afterLayout(() => {
      trace.push(`a ${scrollbox.scrollHeight}`)
      scrollbox.scrollChildIntoView(scrollbox.getChildren().at(-1)!, { align: "end" })
      scrollbox.afterLayout(() => trace.push("b"))
    })
    add(1)
    await renderOnce()
    trace.push(captureCharFrame().split("\n")[3].slice(0, 8))
    await renderOnce()
    scrollbox.visible = false
    const requested = spyOn(testRenderer, "requestRender")
    scrollbox.afterLayout(() => trace.push("hidden"))
    expect(requested).toHaveBeenCalled()
    requested.mockRestore()
    await renderOnce()
    trace.push("shown")
    scrollbox.visible = true
    await renderOnce()
    const other = new BoxRenderable(testRenderer, {})
    expect(() => scrollbox.anchor(other)).toThrow()
    scrollbox.afterLayout(() => scrollbox.destroy())
    scrollbox.afterLayout(() => trace.push("dropped"))
    await renderOnce()
    expect(trace).toEqual([8, "a 231", "row 230 ", "b", "shown", "hidden"])
  })

  // Each step records `scrollTop` and the top line after its frame (and the host requests where they matter): a sticky
  // box's deliberate position before layout lands; without sticky, a callback's scroll to the end with growth lands at
  // the new end in its frame;
  // a step unit is the bar's `scrollStep`; once the callbacks ran, the SCROLL hook is off again.
  test("afterLayout and scroll targets: sticky position, callback growth, step unit, hook release", async () => {
    const scrollbox = new ScrollBoxRenderable(testRenderer, {
      width: 20,
      height: 10,
      stickyScroll: true,
      stickyStart: "bottom",
    })
    testRenderer.root.add(scrollbox)
    let count = 0
    const add = (rows: number) => {
      for (let i = 0; i < rows; i++) scrollbox.add(new TextRenderable(testRenderer, { content: `row ${count++}` }))
    }
    const trace: unknown[] = []
    const step = async () => {
      await renderOnce()
      trace.push(`${scrollbox.scrollTop} ${captureCharFrame().split("\n")[0].slice(0, 7).trim()}`)
    }
    scrollbox.scrollTo(25)
    add(60)
    await step()
    scrollbox.stickyScroll = false
    scrollbox.afterLayout(() => {
      scrollbox.scrollTo(80)
      add(40)
    })
    await step()
    scrollbox.verticalScrollBar.scrollStep = 3
    scrollbox.scrollTo(0)
    scrollbox.scrollBy(2, "step")
    await step()
    add(1)
    await step()
    trace.push(testRenderer.getNativeStats().frameWork.hostRequests)
    expect(trace).toEqual(["25 row 25", "90 row 90", "6 row 6", "6 row 6", 0])
  })

  // afterLayout callbacks: one that throws does not stop the others, and its error reaches the renderer; one asked
  // during a frame (here from a content "resize" listener) runs in the next frame; an anchor release that native
  // rejects can be retried; destroying the box releases the queue.
  test("afterLayout callbacks and anchor releases keep their order through errors", async () => {
    const scrollbox = new ScrollBoxRenderable(testRenderer, { width: 20, height: 4, viewportCulling: false })
    const rows = Array.from({ length: 10 }, (_, i) => new TextRenderable(testRenderer, { content: `row ${i}` }))
    for (const row of rows) scrollbox.add(row)
    testRenderer.root.add(scrollbox)
    await renderOnce()
    const trace: string[] = []
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      scrollbox.afterLayout(() => {
        trace.push("first")
        throw new Error("first fails")
      })
      scrollbox.afterLayout(() => trace.push("second"))
      await renderOnce()
      trace.push("|")
      const listener = () => {
        scrollbox.content.off("resize", listener)
        scrollbox.afterLayout(() => trace.push("new"))
      }
      scrollbox.content.on("resize", listener)
      scrollbox.afterLayout(() => trace.push("old"))
      scrollbox.add(new TextRenderable(testRenderer, { content: "row 10" }))
      await renderOnce()
      trace.push("|")
      await renderOnce()
    } finally {
      errors.mockRestore()
    }
    expect(trace).toEqual(["first", "second", "|", "old", "|", "new"])
    scrollbox.scrollTo(4)
    await renderOnce()
    const release = scrollbox.anchor(rows[4])
    const request = spyOn(testRenderer.nativeScene, "scrollRequest").mockImplementation(() => {
      throw new Error("rejected")
    })
    expect(release).toThrow("rejected")
    request.mockRestore()
    release()
    scrollbox.insertBefore(new TextRenderable(testRenderer, { content: "prepended" }), rows[0])
    await renderOnce()
    expect(captureCharFrame().split("\n")[0]).toContain("row 3")
    scrollbox.afterLayout(() => {})
    scrollbox.destroy()
    expect(scrollbox["layoutCallbacks"]).toEqual([])
  })

  // Bar cells hit the ScrollBox: a click on the track jumps there, and a drag from the thumb moves it.
  test("bar presses target the ScrollBox", async () => {
    const scrollbox = new ScrollBoxRenderable(testRenderer, { width: 20, height: 10 })
    for (let i = 0; i < 100; i++) scrollbox.add(new TextRenderable(testRenderer, { content: `row ${i}` }))
    testRenderer.root.add(scrollbox)
    await renderOnce()
    const targets: unknown[] = []
    scrollbox.onMouseDown = (event) => targets.push(event.target)
    await mockMouse.click(19, 5)
    expect([targets.length, targets[0] === scrollbox, scrollbox.scrollTop]).toEqual([1, true, 45])
    await mockMouse.drag(19, 5, 19, 0)
    expect(scrollbox.scrollTop).toBe(0)
  })

  // `visible` in the options holds the bar shown or hidden from the start; nullish follows the range.
  test.each([
    [false, 30, false],
    [true, 3, true],
    [undefined, 30, true],
    [undefined, 3, false],
  ] as const)("bar visible %p with %d rows shows %p", async (visible, count, shown) => {
    const scrollbox = new ScrollBoxRenderable(testRenderer, {
      width: 20,
      height: 10,
      verticalScrollbarOptions: { visible },
    })
    for (let i = 0; i < count; i++) scrollbox.add(new TextRenderable(testRenderer, { content: `row ${i}` }))
    testRenderer.root.add(scrollbox)
    await renderOnce()
    expect(scrollbox.verticalScrollBar.visible).toBe(shown)
  })
})

// Facade state after edge writes. Each row builds a 20×10 box with 30 rows (`wide`: 3 boxes 100 cells wide, scrollX,
// height 5) after `options`, renders, runs its steps, and returns a trace.
type FacadeRow = [string, ScrollBoxOptions & { wide?: boolean }, (box: ScrollBoxRenderable) => Promise<unknown>, string]
const attempt = (write: () => void) => {
  try {
    write()
    return "ok"
  } catch (error) {
    return (error as Error).name
  }
}
const facadeRows: FacadeRow[] = [
  [
    "destroy keeps the last presented state",
    { stickyScroll: true, stickyStart: "bottom" },
    async (box) => {
      const before = box.scrollTop
      box.add(new TextRenderable(testRenderer, { content: "late" }))
      await renderOnce()
      box.destroy()
      return [before, box.scrollTop, box.scrollHeight, box.verticalScrollBar.scrollPosition]
    },
    "20,21,31,21",
  ],
  [
    "an uppercase content direction is a row",
    { contentOptions: { flexDirection: "row" } },
    async (box) => {
      box.content.flexDirection = "ROW" as "row"
      await renderOnce()
      const [a, b] = box.getChildren()
      return [box.primaryAxis, a.y === b.y]
    },
    "row,true",
  ],
  [
    "a rejected content direction keeps the accepted one",
    { contentOptions: { flexDirection: "row" } },
    async (box) => [
      attempt(() => (box.content.flexDirection = 1 as unknown as "row")),
      box.content.flexDirection,
      box.primaryAxis,
    ],
    "TypeError,row,row",
  ],
  [
    "a rejected sticky edge keeps the accepted one",
    { stickyScroll: true, stickyStart: "bottom" },
    async (box) => {
      const rejected = attempt(() => (box.stickyStart = "bogus" as "top"))
      const valid = attempt(() => (box.stickyScroll = true))
      box.add(new TextRenderable(testRenderer, { content: "late" }))
      await renderOnce()
      return [rejected, valid, box.stickyStart, box.scrollTop]
    },
    "TypeError,ok,bottom,21",
  ],
  [
    "removing every listener keeps notifications for later ones",
    {},
    async (box) => {
      let heard = 0
      box.content.on("resize", () => heard--)
      box.content.removeAllListeners()
      box.add(new TextRenderable(testRenderer, { content: "late" }))
      await renderOnce()
      const requests = testRenderer.getNativeStats().frameWork.hostRequests
      box.content.on("resize", () => heard++)
      box.add(new TextRenderable(testRenderer, { content: "later" }))
      await renderOnce()
      return [requests, heard]
    },
    "0,1",
  ],
  [
    "a width-only change reaches content resize",
    {},
    async (box) => {
      let heard = 0
      box.content.on("resize", () => heard++)
      box.width = 18
      await renderOnce()
      return [heard, box.content.width]
    },
    "1,17",
  ],
  [
    "a bar with a gap covers the gap",
    { width: 30, verticalScrollbarOptions: { paddingLeft: 2 } },
    async (box) => [box.verticalScrollBar.x, box.verticalScrollBar.width, box.viewport.width],
    "27,3,27",
  ],
  [
    "horizontal track press jumps, a thumb press does not, and a drag moves the thumb",
    { wide: true },
    async (box) => {
      const trace = []
      await mockMouse.pressDown(10, 4)
      trace.push(box.scrollLeft)
      await mockMouse.release(10, 4)
      await renderOnce()
      await mockMouse.pressDown(9, 4)
      trace.push(box.scrollLeft)
      await mockMouse.moveTo(11, 4)
      trace.push(box.scrollLeft)
      await mockMouse.release(11, 4)
      return trace
    },
    "40,40,50",
  ],
  [
    "viewport padding writes",
    {},
    async (box) => {
      const max = async () => (await renderOnce(), box.scrollHeight - box.viewport.height + box.viewport.paddingTop)
      const trace: unknown[] = []
      box.viewport.paddingTop = 2
      trace.push(await max())
      box.viewport.paddingTop = null
      trace.push(await max())
      trace.push(
        attempt(() => (box.viewport.paddingTop = 1.5)),
        await max(),
      )
      return trace
    },
    "22,20,RangeError,20",
  ],
]

test.each(facadeRows)("ScrollBox facade: %s", async (_, options, steps, expected) => {
  const { wide, ...rest } = options
  const box = new ScrollBoxRenderable(testRenderer, {
    width: 20,
    height: wide ? 5 : 10,
    ...(wide ? { scrollX: true } : {}),
    ...rest,
  })
  for (let i = 0; i < (wide ? 3 : 30); i++) {
    box.add(
      wide
        ? new BoxRenderable(testRenderer, { width: 100, height: 1, flexShrink: 0 })
        : new TextRenderable(testRenderer, { content: `row ${i}` }),
    )
  }
  testRenderer.root.add(box)
  await renderOnce()
  expect(String(await steps(box))).toBe(expected)
})

describe("ScrollBoxRenderable - culled content layout freshness", () => {
  // Each case changes the layout of 40 culled rows (each 1 tall), renders, and checks the frame. `lines` maps a
  // screen row to the row label it shows, or to null for a row without one.
  const cases: {
    name: string
    act: (scrollbox: ScrollBoxRenderable, rows: BoxRenderable[]) => Promise<void>
    lines?: [number, string | null][]
    sizeChanges?: number
  }[] = [
    {
      name: "rows revealed after several off-screen relayouts render at fresh positions",
      act: async (scrollbox, rows) => {
        scrollbox.scrollTo(scrollbox.scrollHeight)
        await renderOnce()
        for (const rowHeight of [2, 3, 2]) {
          rows[0].height = rowHeight
          await renderOnce()
        }
        scrollbox.scrollTo(0)
      },
      lines: [
        [0, "row-0 "],
        [2, "row-1 "],
        [3, "row-2 "],
        [4, "row-3 "],
      ],
    },
    {
      name: "a row that grows in the same frame as a scroll moves the rows culled against",
      act: async (scrollbox, rows) => {
        rows[0].height = 7
        scrollbox.scrollTo(20)
      },
      lines: [0, 1, 2, 3, 4, 5].map((line) => [line, `row-${14 + line} `]),
    },
    {
      name: "an off-screen row that resizes receives onSizeChange in that frame",
      act: async (_, rows) => {
        rows[30].height = 3
      },
      lines: [[0, "row-0 "]],
      sizeChanges: 1,
    },
    {
      name: "a row moved by a culled relayout renders at its new position once scrolled into view",
      act: async (scrollbox, rows) => {
        rows[10].height = 3
        await renderOnce()
        // rows[11] moved down by 2 while culled; its public position must say so.
        scrollbox.scrollTo(rows[11].y - scrollbox.content.y - 1)
      },
      lines: [
        [0, null],
        [1, "row-11 "],
        [2, "row-12 "],
      ],
    },
  ]

  for (const { name, act, lines, sizeChanges } of cases) {
    test(name, async () => {
      const scrollbox = new ScrollBoxRenderable(testRenderer, { width: 30, height: 6, viewportCulling: true })
      testRenderer.root.add(scrollbox)
      const rows: BoxRenderable[] = []
      let resized = 0
      for (let i = 0; i < 40; i++) {
        const row = new BoxRenderable(testRenderer, { height: 1, flexShrink: 0, onSizeChange: () => resized++ })
        row.add(new TextRenderable(testRenderer, { content: `row-${i}` }))
        scrollbox.add(row)
        rows.push(row)
      }
      await renderOnce()
      resized = 0
      await act(scrollbox, rows)
      await renderOnce()
      const frame = captureCharFrame().split("\n")
      for (const [line, label] of lines ?? []) {
        if (label === null) expect(frame[line]).not.toContain("row-")
        else expect(frame[line]).toContain(label)
      }
      if (sizeChanges !== undefined) expect(resized).toBe(sizeChanges)
    })
  }
})

describe("ScrollBoxRenderable - clipping", () => {
  test("clips nested scrollbox content to inner viewport (see issue #388)", async () => {
    const root = new BoxRenderable(testRenderer, {
      flexDirection: "column",
      gap: 0,
      width: 32,
      height: 16,
    })

    const outer = new ScrollBoxRenderable(testRenderer, {
      width: 30,
      height: 10,
      border: true,
      overflow: "hidden",
      scrollY: true,
    })

    const inner = new ScrollBoxRenderable(testRenderer, {
      width: 26,
      height: 6,
      border: true,
      overflow: "hidden",
      scrollY: true,
    })

    for (let index = 0; index < 6; index += 1) {
      inner.add(new TextRenderable(testRenderer, { content: `LEAK-${index}` }))
    }

    outer.add(inner)
    root.add(outer)
    testRenderer.root.add(root)

    await renderOnce()

    const frame = captureCharFrame()
    const innerViewportHeight = 4 // height 6 minus top/bottom border
    const visibleLines = frame.split("\n").filter((line) => line.includes("LEAK-"))

    expect(visibleLines.length).toBeLessThanOrEqual(innerViewportHeight)
  })
})

describe("ScrollBoxRenderable - padding behavior", () => {
  test("applies scrollbox padding to content while keeping scrollbar docked", async () => {
    const noPadding = new ScrollBoxRenderable(testRenderer, {
      left: 0,
      top: 0,
      width: 26,
      height: 9,
      border: true,
      scrollY: true,
    })

    const padded = new ScrollBoxRenderable(testRenderer, {
      left: 0,
      top: 11,
      width: 26,
      height: 9,
      border: true,
      scrollY: true,
      padding: 2,
    })

    for (let index = 0; index < 24; index += 1) {
      noPadding.add(new TextRenderable(testRenderer, { content: `NP-${index}` }))
      padded.add(new TextRenderable(testRenderer, { content: `PD-${index}` }))
    }

    testRenderer.root.add(noPadding)
    testRenderer.root.add(padded)

    await renderOnce()

    expect(noPadding.verticalScrollBar.visible).toBe(true)
    expect(padded.verticalScrollBar.visible).toBe(true)
    expect(noPadding.verticalScrollBar.x).toBe(noPadding.x + noPadding.width - 2)
    expect(padded.verticalScrollBar.x).toBe(padded.x + padded.width - 2)

    const frameLines = captureCharFrame().split("\n")
    const noPaddingRow = frameLines.find((line) => line.includes("NP-0"))
    const paddedRow = frameLines.find((line) => line.includes("PD-0"))

    expect(noPaddingRow).toBeDefined()
    expect(paddedRow).toBeDefined()

    const noPaddingTextX = noPaddingRow?.indexOf("NP-0") ?? -1
    const paddedTextX = paddedRow?.indexOf("PD-0") ?? -1

    expect(paddedTextX).toBeGreaterThan(noPaddingTextX)
  })

  test("padding setter updates content inset without moving scrollbar", async () => {
    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      width: 26,
      height: 9,
      border: true,
      scrollY: true,
    })

    for (let index = 0; index < 24; index += 1) {
      scrollBox.add(new TextRenderable(testRenderer, { content: `PX-${index}` }))
    }

    testRenderer.root.add(scrollBox)
    await renderOnce()

    const beforeScrollbarX = scrollBox.verticalScrollBar.x
    const beforeFrameLines = captureCharFrame().split("\n")
    const beforeRow = beforeFrameLines.find((line) => line.includes("PX-0"))
    const beforeTextX = beforeRow?.indexOf("PX-0") ?? -1

    scrollBox.padding = 2
    await renderOnce()

    const afterFrameLines = captureCharFrame().split("\n")
    const afterRow = afterFrameLines.find((line) => line.includes("PX-0"))
    const afterTextX = afterRow?.indexOf("PX-0") ?? -1

    expect(scrollBox.verticalScrollBar.x).toBe(beforeScrollbarX)
    expect(afterTextX).toBeGreaterThan(beforeTextX)
  })
})

describe("ScrollBoxRenderable - destroyRecursively", () => {
  test("selection dispatch continues when an earlier listener destroys the ScrollBox", () => {
    const scrollbox = new ScrollBoxRenderable(testRenderer, { id: "scrollbox" })
    testRenderer.root.add(scrollbox)

    let laterCalls = 0
    testRenderer.prependOnceListener("selection", () => scrollbox.destroyRecursively())
    testRenderer.on("selection", () => laterCalls++)
    testRenderer.emit("selection", null)
    expect(laterCalls).toBe(1)
  })

  test("destroys internal ScrollBox components", () => {
    const parent = new ScrollBoxRenderable(testRenderer, { id: "scroll-parent" })
    const child = new BoxRenderable(testRenderer, { id: "child" })

    parent.add(child)

    const wrapper = parent.wrapper
    const viewport = parent.viewport
    const content = parent.content
    const horizontalScrollBar = parent.horizontalScrollBar
    const verticalScrollBar = parent.verticalScrollBar

    expect(parent.isDestroyed).toBe(false)
    expect(child.isDestroyed).toBe(false)
    expect(wrapper.isDestroyed).toBe(false)
    expect(viewport.isDestroyed).toBe(false)
    expect(content.isDestroyed).toBe(false)
    expect(horizontalScrollBar.isDestroyed).toBe(false)
    expect(verticalScrollBar.isDestroyed).toBe(false)

    parent.destroyRecursively()

    expect(parent.isDestroyed).toBe(true)
    expect(child.isDestroyed).toBe(true)
    expect(wrapper.isDestroyed).toBe(true)
    expect(viewport.isDestroyed).toBe(true)
    expect(content.isDestroyed).toBe(true)
    expect(horizontalScrollBar.isDestroyed).toBe(true)
    expect(verticalScrollBar.isDestroyed).toBe(true)
  })
})

describe("ScrollBoxRenderable - Mouse interaction", () => {
  test("scrolls with mouse wheel", async () => {
    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      width: 50,
      height: 20,
      scrollAcceleration: new MacOSScrollAccel({ A: 0 }),
    })
    for (let i = 0; i < 50; i++) scrollBox.add(new TextRenderable(testRenderer, { content: `Line ${i}` }))
    testRenderer.root.add(scrollBox)
    await renderOnce()

    await mockMouse.scroll(25, 10, "down")
    await renderOnce()
    expect(scrollBox.scrollTop).toBeGreaterThan(0)
  })

  test("single isolated scroll has same distance as linear", async () => {
    const linearBox = new ScrollBoxRenderable(testRenderer, {
      width: 50,
      height: 20,
      scrollAcceleration: new LinearScrollAccel(),
    })

    for (let i = 0; i < 100; i++) linearBox.add(new TextRenderable(testRenderer, { content: `Line ${i}` }))
    testRenderer.root.add(linearBox)
    await renderOnce()

    await mockMouse.scroll(25, 10, "down")
    await renderOnce()
    const linearDistance = linearBox.scrollTop

    testRenderer.destroy()
    ;({
      renderer: testRenderer,
      mockMouse,
      renderOnce,
      captureCharFrame,
    } = await createTestRenderer({ width: 80, height: 24 }))

    const accelBox = new ScrollBoxRenderable(testRenderer, {
      width: 50,
      height: 20,
      scrollAcceleration: new MacOSScrollAccel(),
    })

    for (let i = 0; i < 100; i++) accelBox.add(new TextRenderable(testRenderer, { content: `Line ${i}` }))
    testRenderer.root.add(accelBox)
    await renderOnce()

    await mockMouse.scroll(25, 10, "down")
    await renderOnce()

    expect(accelBox.scrollTop).toBe(linearDistance)
  })

  test("acceleration makes rapid scrolls cover more distance", async () => {
    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      width: 50,
      height: 20,
      scrollAcceleration: new MacOSScrollAccel({ A: 0.8, tau: 3, maxMultiplier: 6 }),
    })
    for (let i = 0; i < 200; i++) scrollBox.add(new TextRenderable(testRenderer, { content: `Line ${i}` }))
    testRenderer.root.add(scrollBox)
    await renderOnce()

    await mockMouse.scroll(25, 10, "down")
    await renderOnce()
    const slowScrollDistance = scrollBox.scrollTop

    scrollBox.scrollTop = 0

    for (let i = 0; i < 5; i++) {
      await mockMouse.scroll(25, 10, "down")
      await renderOnce()
    }
    const rapidScrollDistance = scrollBox.scrollTop

    expect(rapidScrollDistance).toBeGreaterThan(slowScrollDistance * 3)
  })

  test("multiplier < 1 slows down scroll distance", async () => {
    // Test with slowdown using a constant multiplier < 1
    const slowdownBox = new ScrollBoxRenderable(testRenderer, {
      width: 50,
      height: 20,
      scrollAcceleration: new ConstantScrollAccel(0.5),
    })
    for (let i = 0; i < 200; i++) slowdownBox.add(new TextRenderable(testRenderer, { content: `Line ${i}` }))
    testRenderer.root.add(slowdownBox)
    await renderOnce()

    // ConstantScrollAccel ignores timing, so no delay needed
    for (let i = 0; i < 5; i++) {
      await mockMouse.scroll(25, 10, "down")
      await renderOnce()
    }
    const slowdownDistance = slowdownBox.scrollTop

    testRenderer.destroy()
    ;({
      renderer: testRenderer,
      mockMouse,
      renderOnce,
      captureCharFrame,
    } = await createTestRenderer({
      width: 80,
      height: 24,
    }))

    // Compare with linear (no slowdown)
    const linearBox = new ScrollBoxRenderable(testRenderer, {
      width: 50,
      height: 20,
      scrollAcceleration: new LinearScrollAccel(),
    })
    for (let i = 0; i < 200; i++) linearBox.add(new TextRenderable(testRenderer, { content: `Line ${i}` }))
    testRenderer.root.add(linearBox)
    await renderOnce()

    // LinearScrollAccel ignores timing, so no delay needed
    for (let i = 0; i < 5; i++) {
      await mockMouse.scroll(25, 10, "down")
      await renderOnce()
    }
    const linearDistance = linearBox.scrollTop

    expect(slowdownDistance).toBeLessThan(linearDistance)
    expect(slowdownDistance).toBeGreaterThan(0)
  })

  test("multiplier < 1 accumulates fractional scroll amounts", async () => {
    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      width: 50,
      height: 20,
      scrollAcceleration: new ConstantScrollAccel(0.3),
    })
    for (let i = 0; i < 200; i++) scrollBox.add(new TextRenderable(testRenderer, { content: `Line ${i}` }))
    testRenderer.root.add(scrollBox)
    await renderOnce()

    // With multiplier < 1, fractional amounts accumulate
    // It should take multiple scroll events to accumulate enough to scroll 1 full unit
    let scrolled = false
    for (let i = 0; i < 5; i++) {
      await mockMouse.scroll(25, 10, "down")
      await renderOnce()
      if (scrollBox.scrollTop > 0) {
        scrolled = true
        break
      }
    }

    expect(scrolled).toBe(true)
    expect(scrollBox.scrollTop).toBeGreaterThan(0)
  })

  test("horizontal scroll with multiplier < 1 works correctly", async () => {
    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      width: 50,
      height: 20,
      scrollX: true,
      scrollAcceleration: new ConstantScrollAccel(0.4),
    })

    const wideBox = new BoxRenderable(testRenderer, { width: 300, height: 10 })
    scrollBox.add(wideBox)
    testRenderer.root.add(scrollBox)
    await renderOnce()

    await mockMouse.scroll(25, 10, "right")
    await renderOnce()

    // Should eventually scroll after multiple events due to accumulation
    let scrolled = false
    for (let i = 0; i < 5; i++) {
      await mockMouse.scroll(25, 10, "right")
      await renderOnce()
      if (scrollBox.scrollLeft > 0) {
        scrolled = true
        break
      }
    }

    expect(scrolled).toBe(true)
  })

  test("multiplier < 1 with acceleration work together", async () => {
    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      width: 50,
      height: 20,
      scrollAcceleration: new ConstantScrollAccel(0.3),
    })
    for (let i = 0; i < 200; i++) scrollBox.add(new TextRenderable(testRenderer, { content: `Line ${i}` }))
    testRenderer.root.add(scrollBox)
    await renderOnce()

    // Multiple scrolls should accumulate fractional amounts
    for (let i = 0; i < 10; i++) {
      await mockMouse.scroll(25, 10, "down")
      await renderOnce()
    }
    const scrollDistance = scrollBox.scrollTop

    // With 0.3 multiplier and 10 scrolls: 10 * 1 * 0.3 = 3 pixels total
    // Math.trunc applied each time, so we get 2 pixels actually scrolled
    expect(scrollDistance).toBeGreaterThan(0)
    expect(scrollDistance).toBeLessThan(5)
  })
})

describe("ScrollBoxRenderable - Content Visibility", () => {
  test("renders markdown prose in scrollbox before highlighting completes", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)
    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      width: 100,
      height: 20,
      viewportCulling: true,
    })

    testRenderer.root.add(scrollBox)

    for (let i = 0; i < 20; i++) {
      const wrapper = new BoxRenderable(testRenderer, {
        id: `text-${i}`,
        paddingLeft: 3,
        marginTop: 1,
        flexShrink: 0,
      })
      const markdown = new MarkdownRenderable(testRenderer, {
        syntaxStyle,
        streaming: true,
        internalBlockMode: "top-level",
        content: `PARAGRAPH_${i}\n\n\`\`\`ts\nconst CODE_${i} = ${i}\n\`\`\``,
        treeSitterClient: mockTreeSitterClient,
      })
      wrapper.add(markdown)
      scrollBox.add(wrapper)
    }

    await renderOnce()

    const frame = captureCharFrame()
    expect(frame).toContain("PARAGRAPH_0")
  })

  test("maintains visibility when scrolling with many Code elements", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)

    const parent = new BoxRenderable(testRenderer, {
      flexDirection: "column",
      gap: 1,
    })

    const header = new BoxRenderable(testRenderer, { flexShrink: 0 })
    header.add(new TextRenderable(testRenderer, { content: "Header Content" }))

    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
    })

    const footer = new BoxRenderable(testRenderer, { flexShrink: 0 })
    footer.add(new TextRenderable(testRenderer, { content: "Footer Content" }))

    parent.add(header)
    parent.add(scrollBox)
    parent.add(footer)
    testRenderer.root.add(parent)

    await renderOnce()
    const initialFrame = captureCharFrame()
    expect(initialFrame).toContain("Header Content")
    expect(initialFrame).toContain("Footer Content")

    const codeContent = `
# HELLO

world

## HELLO World

\`\`\`html
<div class="example">
  <p>Content</p>
</div>
\`\`\`
`

    const codes: CodeRenderable[] = []
    for (let i = 0; i < 100; i++) {
      const wrapper = new BoxRenderable(testRenderer, {
        marginTop: 2,
        marginBottom: 2,
      })
      const code = new CodeRenderable(testRenderer, {
        content: codeContent,
        filetype: "markdown",
        syntaxStyle,
        drawUnstyledText: false,
        treeSitterClient: mockTreeSitterClient,
      })
      codes.push(code)
      wrapper.add(code)
      scrollBox.add(wrapper)
    }

    await renderOnce()

    mockTreeSitterClient.resolveAllHighlightOnce()
    await Promise.all(codes.map((c) => c.highlightingDone))
    await renderOnce()

    scrollBox.scrollTo(scrollBox.scrollHeight)
    await renderOnce()

    mockTreeSitterClient.resolveAllHighlightOnce()
    await Promise.all(codes.map((c) => c.highlightingDone))
    await renderOnce()

    const frameAfterScroll = captureCharFrame()

    expect(frameAfterScroll).toContain("Header Content")
    expect(frameAfterScroll).toContain("Footer Content")

    const hasCodeContent =
      frameAfterScroll.includes("HELLO") ||
      frameAfterScroll.includes("world") ||
      frameAfterScroll.includes("<div") ||
      frameAfterScroll.includes("```")

    expect(hasCodeContent).toBe(true)

    const nonWhitespaceChars = frameAfterScroll.replace(/\s/g, "").length
    expect(nonWhitespaceChars).toBeGreaterThan(50)
  })

  test("maintains visibility when scrolling with many Code elements (setter-based, like SolidJS)", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)

    const parent = new BoxRenderable(testRenderer, {
      flexDirection: "column",
      gap: 1,
    })

    const header = new BoxRenderable(testRenderer, { flexShrink: 0 })
    header.add(new TextRenderable(testRenderer, { content: "Header Content" }))

    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
    })

    const footer = new BoxRenderable(testRenderer, { flexShrink: 0 })
    footer.add(new TextRenderable(testRenderer, { content: "Footer Content" }))

    parent.add(header)
    parent.add(scrollBox)
    parent.add(footer)
    testRenderer.root.add(parent)

    await renderOnce()
    const initialFrame = captureCharFrame()
    expect(initialFrame).toContain("Header Content")
    expect(initialFrame).toContain("Footer Content")

    const codeContent = `
# HELLO

world

## HELLO World

\`\`\`html
<div class="example">
  <p>Content</p>
</div>
\`\`\`
`

    for (let i = 0; i < 100; i++) {
      const wrapper = new BoxRenderable(testRenderer, { id: `wrapper-${i}` })
      wrapper.marginTop = 2
      wrapper.marginBottom = 2

      const code = new CodeRenderable(testRenderer, {
        id: `code-${i}`,
        syntaxStyle,
        drawUnstyledText: false,
        treeSitterClient: mockTreeSitterClient,
      })

      wrapper.add(code)
      code.content = codeContent
      code.filetype = "markdown"

      scrollBox.add(wrapper)
    }

    await testRenderer.idle()

    mockTreeSitterClient.resolveAllHighlightOnce()
    await Promise.resolve()

    await testRenderer.idle()

    scrollBox.scrollTo(scrollBox.scrollHeight)
    await testRenderer.idle()

    const frameAfterScroll = captureCharFrame()

    expect(frameAfterScroll).toContain("Header Content")
    expect(frameAfterScroll).toContain("Footer Content")

    const hasCodeContent =
      frameAfterScroll.includes("HELLO") ||
      frameAfterScroll.includes("world") ||
      frameAfterScroll.includes("<div") ||
      frameAfterScroll.includes("```")

    expect(hasCodeContent).toBe(true)

    const nonWhitespaceChars = frameAfterScroll.replace(/\s/g, "").length
    expect(nonWhitespaceChars).toBeGreaterThan(50)
  })

  test("maintains visibility with simple Code elements (constructor)", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)

    const parent = new BoxRenderable(testRenderer, {
      flexDirection: "column",
      gap: 1,
    })

    const header = new BoxRenderable(testRenderer, { flexShrink: 0 })
    header.add(new TextRenderable(testRenderer, { content: "Header" }))

    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
    })

    const footer = new BoxRenderable(testRenderer, { flexShrink: 0 })
    footer.add(new TextRenderable(testRenderer, { content: "Footer" }))

    parent.add(header)
    parent.add(scrollBox)
    parent.add(footer)
    testRenderer.root.add(parent)

    await renderOnce()

    const codes: CodeRenderable[] = []
    for (let i = 0; i < 50; i++) {
      const wrapper = new BoxRenderable(testRenderer, {
        marginTop: 1,
        marginBottom: 1,
      })
      const code = new CodeRenderable(testRenderer, {
        content: `Item ${i}`,
        filetype: "markdown",
        syntaxStyle,
        drawUnstyledText: false,
        treeSitterClient: mockTreeSitterClient,
      })
      codes.push(code)
      wrapper.add(code)
      scrollBox.add(wrapper)
    }

    await renderOnce()

    mockTreeSitterClient.resolveAllHighlightOnce()
    await Promise.all(codes.map((c) => c.highlightingDone))
    await renderOnce()

    scrollBox.scrollTo(scrollBox.scrollHeight)
    await renderOnce()

    mockTreeSitterClient.resolveAllHighlightOnce()
    await Promise.all(codes.map((c) => c.highlightingDone))
    await renderOnce()

    const frame = captureCharFrame()

    expect(frame).toContain("Header")
    expect(frame).toContain("Footer")

    const hasItems = /Item \d+/.test(frame)
    expect(hasItems).toBe(true)

    const nonWhitespaceChars = frame.replace(/\s/g, "").length
    expect(nonWhitespaceChars).toBeGreaterThan(18)
  })

  test("maintains visibility with simple Code elements (setter-based, like SolidJS)", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)

    const parent = new BoxRenderable(testRenderer, {
      flexDirection: "column",
      gap: 1,
    })

    const header = new BoxRenderable(testRenderer, { flexShrink: 0 })
    header.add(new TextRenderable(testRenderer, { content: "Header" }))

    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
    })

    const footer = new BoxRenderable(testRenderer, { flexShrink: 0 })
    footer.add(new TextRenderable(testRenderer, { content: "Footer" }))

    parent.add(header)
    parent.add(scrollBox)
    parent.add(footer)
    testRenderer.root.add(parent)

    await renderOnce()

    const codes: CodeRenderable[] = []
    for (let i = 0; i < 50; i++) {
      const wrapper = new BoxRenderable(testRenderer, { id: `wrapper-${i}` })
      wrapper.marginTop = 1
      wrapper.marginBottom = 1

      const code = new CodeRenderable(testRenderer, {
        id: `code-${i}`,
        syntaxStyle,
        drawUnstyledText: false,
        treeSitterClient: mockTreeSitterClient,
      })

      wrapper.add(code)
      code.content = `Item ${i}`
      code.filetype = "markdown"
      codes.push(code)

      scrollBox.add(wrapper)
    }

    await renderOnce()
    mockTreeSitterClient.resolveAllHighlightOnce()
    await Promise.all(codes.map((c) => c.highlightingDone))
    await renderOnce()

    scrollBox.scrollTo(scrollBox.scrollHeight)
    await renderOnce()

    const frame = captureCharFrame()

    expect(frame).toContain("Header")
    expect(frame).toContain("Footer")

    const hasItems = /Item \d+/.test(frame)
    expect(hasItems).toBe(true)

    const nonWhitespaceChars = frame.replace(/\s/g, "").length
    expect(nonWhitespaceChars).toBeGreaterThan(18)
  })

  test("maintains visibility with TextRenderable elements", async () => {
    const parent = new BoxRenderable(testRenderer, {
      flexDirection: "column",
      gap: 1,
    })

    const header = new BoxRenderable(testRenderer, { flexShrink: 0 })
    header.add(new TextRenderable(testRenderer, { content: "Header" }))

    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
    })

    const footer = new BoxRenderable(testRenderer, { flexShrink: 0 })
    footer.add(new TextRenderable(testRenderer, { content: "Footer" }))

    parent.add(header)
    parent.add(scrollBox)
    parent.add(footer)
    testRenderer.root.add(parent)

    await renderOnce()

    for (let i = 0; i < 50; i++) {
      const wrapper = new BoxRenderable(testRenderer, {
        marginTop: 1,
        marginBottom: 1,
      })
      wrapper.add(new TextRenderable(testRenderer, { content: `Item ${i}` }))
      scrollBox.add(wrapper)
    }

    await renderOnce()

    scrollBox.scrollTo(scrollBox.scrollHeight)
    await renderOnce()

    const frame = captureCharFrame()

    expect(frame).toContain("Header")
    expect(frame).toContain("Footer")

    const hasItems = /Item \d+/.test(frame)
    expect(hasItems).toBe(true)

    const nonWhitespaceChars = frame.replace(/\s/g, "").length
    expect(nonWhitespaceChars).toBeGreaterThan(20)
  })

  test("stays scrolled to bottom with growing code renderables in sticky scroll mode", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)
    // Use manual-resolving mock client for deterministic behavior
    const autoResolvingClient = createMockTreeSitterClient()

    const parent = new BoxRenderable(testRenderer, {
      flexDirection: "column",
      gap: 1,
    })

    const header = new BoxRenderable(testRenderer, { flexShrink: 0 })
    header.add(new TextRenderable(testRenderer, { content: "Header" }))

    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      flexGrow: 1,
      stickyScroll: true,
      stickyStart: "bottom",
    })

    const footer = new BoxRenderable(testRenderer, { flexShrink: 0 })
    footer.add(new TextRenderable(testRenderer, { content: "Footer" }))

    parent.add(header)
    parent.add(scrollBox)
    parent.add(footer)
    testRenderer.root.add(parent)

    const scrollPositions: number[] = []
    const maxScrollPositions: number[] = []
    const wrapper1 = new BoxRenderable(testRenderer, {
      marginTop: 1,
      marginBottom: 1,
    })
    const code1 = new CodeRenderable(testRenderer, {
      content: "console.log('hello')",
      filetype: "javascript",
      syntaxStyle,
      drawUnstyledText: false,
      treeSitterClient: autoResolvingClient,
    })
    wrapper1.add(code1)
    scrollBox.add(wrapper1)

    await renderOnce()
    autoResolvingClient.resolveAllHighlightOnce()
    await code1.highlightingDone
    await renderOnce()

    scrollPositions.push(scrollBox.scrollTop)
    maxScrollPositions.push(Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height))
    expect(scrollBox.scrollTop).toBe(maxScrollPositions[0])

    code1.content = `console.log('hello')
const foo = 'bar'
const baz = 'qux'
function test() {
  return 42
}
console.log(test())`

    await renderOnce()
    autoResolvingClient.resolveAllHighlightOnce()
    await code1.highlightingDone
    await renderOnce()

    scrollPositions.push(scrollBox.scrollTop)
    maxScrollPositions.push(Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height))
    expect(scrollBox.scrollTop).toBe(maxScrollPositions[1])

    const wrapper2 = new BoxRenderable(testRenderer, {
      marginTop: 1,
      marginBottom: 1,
    })
    const code2 = new CodeRenderable(testRenderer, {
      content: "const x = 10\nconst y = 20",
      filetype: "javascript",
      syntaxStyle,
      drawUnstyledText: false,
      treeSitterClient: autoResolvingClient,
    })
    wrapper2.add(code2)
    scrollBox.add(wrapper2)

    await renderOnce()
    autoResolvingClient.resolveAllHighlightOnce()
    await code2.highlightingDone
    await renderOnce()

    scrollPositions.push(scrollBox.scrollTop)
    maxScrollPositions.push(Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height))
    expect(scrollBox.scrollTop).toBe(maxScrollPositions[2])

    code2.content = `const x = 10
const y = 20
const z = x + y
console.log(z)
function multiply(a, b) {
  return a * b
}
const result = multiply(x, y)
console.log('Result:', result)`

    await renderOnce()
    autoResolvingClient.resolveAllHighlightOnce()
    await code2.highlightingDone
    await renderOnce()

    scrollPositions.push(scrollBox.scrollTop)
    maxScrollPositions.push(Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height))
    expect(scrollBox.scrollTop).toBe(maxScrollPositions[3])

    const wrapper3 = new BoxRenderable(testRenderer, {
      marginTop: 1,
      marginBottom: 1,
    })
    const code3 = new CodeRenderable(testRenderer, {
      content: "// Final code block\nconst final = 'done'",
      filetype: "javascript",
      syntaxStyle,
      drawUnstyledText: false,
      treeSitterClient: autoResolvingClient,
    })
    wrapper3.add(code3)
    scrollBox.add(wrapper3)

    await renderOnce()
    autoResolvingClient.resolveAllHighlightOnce()
    await code3.highlightingDone
    await renderOnce()

    scrollPositions.push(scrollBox.scrollTop)
    maxScrollPositions.push(Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height))
    expect(scrollBox.scrollTop).toBe(maxScrollPositions[4])

    code3.content = `// Final code block
const final = 'done'

class DataProcessor {
  constructor(data) {
    this.data = data
  }
  
  process() {
    return this.data.map(item => item * 2)
  }
  
  filter(predicate) {
    return this.data.filter(predicate)
  }
  
  reduce(fn, initial) {
    return this.data.reduce(fn, initial)
  }
}

const processor = new DataProcessor([1, 2, 3, 4, 5])
console.log(processor.process())
console.log(processor.filter(x => x > 2))
console.log(processor.reduce((acc, val) => acc + val, 0))`

    await renderOnce()
    autoResolvingClient.resolveAllHighlightOnce()
    await code3.highlightingDone
    await renderOnce()

    scrollPositions.push(scrollBox.scrollTop)
    maxScrollPositions.push(Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height))
    expect(scrollBox.scrollTop).toBe(maxScrollPositions[5])

    const frame = captureCharFrame()
    expect(frame).toContain("Header")
    expect(frame).toContain("Footer")

    const hasCodeContent =
      frame.includes("console") ||
      frame.includes("function") ||
      frame.includes("const") ||
      frame.includes("DataProcessor") ||
      frame.includes("processor")

    expect(hasCodeContent).toBe(true)

    const nonWhitespaceChars = frame.replace(/\s/g, "").length
    expect(nonWhitespaceChars).toBeGreaterThan(50)

    for (let i = 0; i < scrollPositions.length; i++) {
      expect(scrollPositions[i]).toBe(maxScrollPositions[i])
    }
  })

  test("sticky scroll bottom stays at bottom after scrollBy/scrollTo is called", async () => {
    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      width: 40,
      height: 10,
      stickyScroll: true,
      stickyStart: "bottom",
    })

    testRenderer.root.add(scrollBox)
    await renderOnce()

    scrollBox.add(new TextRenderable(testRenderer, { content: `Line 0` }))
    await renderOnce()

    scrollBox.scrollBy(100000)
    await renderOnce()

    scrollBox.scrollTo(scrollBox.scrollHeight)
    await renderOnce()

    for (let i = 1; i < 30; i++) {
      scrollBox.add(new TextRenderable(testRenderer, { content: `Line ${i}` }))
      await renderOnce()

      const maxScroll = Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height)

      if (i === 16) {
        expect(scrollBox.scrollTop).toBe(maxScroll)
      }
    }
  })

  test("scrolls CodeRenderable with LineNumberRenderable using mouse wheel", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)

    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      width: 40,
      height: 10,
      scrollY: true,
      scrollX: false,
    })

    // Create long code content that needs scrolling
    let code = "Line 1\n"
    for (let i = 2; i <= 30; i++) {
      code += `Line ${i}\n`
    }

    const { LineNumberRenderable } = await import("../renderables/LineNumberRenderable.js")
    const codeRenderable = new CodeRenderable(testRenderer, {
      content: code,
      filetype: "javascript",
      syntaxStyle,
      drawUnstyledText: true,
      treeSitterClient: mockTreeSitterClient,
      width: "100%",
    })

    const codeWithLines = new LineNumberRenderable(testRenderer, {
      target: codeRenderable,
      width: "100%",
    })

    scrollBox.add(codeWithLines)
    testRenderer.root.add(scrollBox)

    await renderOnce()

    mockTreeSitterClient.resolveAllHighlightOnce()
    await codeRenderable.highlightingDone
    await renderOnce()

    // Capture initial frame (should show top lines)
    const frameTop = captureCharFrame()
    expect(frameTop).toContain("Line 1")
    expect(frameTop).not.toContain("Line 30")

    // Scroll down to bottom
    for (let i = 0; i < 25; i++) {
      await mockMouse.scroll(20, 5, "down")
      await renderOnce()
    }

    // Capture after scroll (should show bottom lines)
    const frameBottom = captureCharFrame()
    expect(frameBottom).toMatchSnapshot()
    expect(frameBottom).toContain("Line 30")
    expect(frameBottom).not.toContain("Line 1")
  })

  test("sticky scroll bottom stays at bottom when gradually filled with code renderables", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)

    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      width: 40,
      height: 10,
      stickyScroll: true,
      stickyStart: "bottom",
    })

    testRenderer.root.add(scrollBox)
    await renderOnce()

    const scrollPositions: number[] = []
    const maxScrollPositions: number[] = []

    scrollPositions.push(scrollBox.scrollTop)
    maxScrollPositions.push(Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height))

    for (let i = 0; i < 10; i++) {
      const code = new CodeRenderable(testRenderer, {
        syntaxStyle,
        drawUnstyledText: false,
        treeSitterClient: mockTreeSitterClient,
      })

      let content = `// Block ${i}\n`
      for (let j = 0; j <= i; j++) {
        content += `const var${j} = ${j}\n`
      }
      code.content = content
      code.filetype = "javascript"

      scrollBox.add(code)

      await renderOnce()
      mockTreeSitterClient.resolveAllHighlightOnce()
      await code.highlightingDone
      await renderOnce()

      const maxScroll = Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height)
      scrollPositions.push(scrollBox.scrollTop)
      maxScrollPositions.push(maxScroll)
    }

    for (let i = 0; i < scrollPositions.length; i++) {
      expect(scrollPositions[i]).toBe(maxScrollPositions[i])
    }
  })

  test("clips nested scrollboxes when multiple stacked children overflow (app-style tool blocks)", async () => {
    const custom = await createTestRenderer({ width: 120, height: 40 })
    const { renderer, renderOnce, captureCharFrame } = custom

    const root = new BoxRenderable(renderer, { flexDirection: "column", width: 118, height: 38, gap: 0 })
    const header = new BoxRenderable(renderer, { height: 3, border: true })
    header.add(new TextRenderable(renderer, { content: "HEADER" }))
    root.add(header)

    const outer = new ScrollBoxRenderable(renderer, { height: 25, border: true, overflow: "hidden", scrollY: true })
    expect((outer as any)._overflow).toBe("hidden")

    const addToolBlock = (id: number) => {
      const wrapper = new BoxRenderable(renderer, { border: true, padding: 0, marginTop: 0, marginBottom: 0 })
      const inner = new ScrollBoxRenderable(renderer, {
        height: 10,
        border: true,
        overflow: "hidden",
        scrollY: true,
        contentOptions: { paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0 },
      })
      expect((inner as any)._overflow).toBe("hidden")
      for (let i = 0; i < 15; i += 1) {
        inner.add(new TextRenderable(renderer, { content: `[tool ${id}] line ${i}` }))
      }
      wrapper.add(inner)
      outer.add(wrapper)
    }

    addToolBlock(1)
    addToolBlock(2)
    addToolBlock(3)

    root.add(outer)

    const footer = new BoxRenderable(renderer, { height: 3, border: true })
    footer.add(new TextRenderable(renderer, { content: "FOOTER" }))
    root.add(footer)

    renderer.root.add(root)
    await renderer.idle()
    expect(outer.width).toBeGreaterThan(0)
    expect(outer.height).toBeGreaterThan(0)

    const frame = captureCharFrame()

    // The third tool block should be clipped entirely (outer height fits ~two blocks).
    expect(frame).not.toMatch(/\[tool 3\] line 1/)

    renderer.destroy()
  })

  test("does not overdraw above header when scrolling nested tool blocks upward", async () => {
    const custom = await createTestRenderer({ width: 120, height: 24 })
    const { renderer, renderOnce, captureCharFrame } = custom

    const root = new BoxRenderable(renderer, { flexDirection: "column", width: 118, height: 22, gap: 0 })
    const header = new BoxRenderable(renderer, { height: 3, border: true })
    header.add(new TextRenderable(renderer, { content: "HEADER" }))
    root.add(header)

    const outer = new ScrollBoxRenderable(renderer, { height: 14, border: true, overflow: "hidden", scrollY: true })
    const inner = new ScrollBoxRenderable(renderer, { height: 10, border: true, overflow: "hidden", scrollY: true })
    for (let i = 0; i < 12; i += 1) {
      inner.add(new TextRenderable(renderer, { content: `[tool] line ${i}` }))
    }
    outer.add(inner)
    root.add(outer)

    const footer = new BoxRenderable(renderer, { height: 3, border: true })
    footer.add(new TextRenderable(renderer, { content: "FOOTER" }))
    root.add(footer)

    renderer.root.add(root)
    await renderOnce()

    // Scroll up to try to draw above header
    inner.scrollTo({ x: 0, y: -100 })
    outer.scrollTo({ x: 0, y: -100 })
    await renderOnce()

    const frame = captureCharFrame()
    const headerIndex = frame.indexOf("HEADER")
    const firstToolIndex = frame.indexOf("[tool] line 0")

    expect(headerIndex).toBeGreaterThan(-1)
    expect(firstToolIndex).toBeGreaterThan(headerIndex)

    renderer.destroy()
  })

  // Sticky edges, by public state only. Steps after the first frame: `+n` adds n rows (`+n/` one per frame), `-n`
  // removes the first n rows, `#v` scrolls to v (`#max` to the current maximum), `w:n` sets the box width, and
  // `sib` resizes a sibling (a solve elsewhere), and `>t+n` calls scrollTo(t) (`h` the content size, `inf`, `-inf`)
  // and adds n rows before the frame. Each step records offset/max on the sticky axis after its frame.
  // Rows: the tests for #530, #709, #1087, the #1088 guard, the re-engage loop, #1514 (PR #1515), and the design's
  // rows A (noise range), C (re-stick while the content fits) and F (Solid's setter path).
  type StickyRow = [string, ScrollBoxOptions & { setters?: boolean }, number, string, string]
  const sticky: StickyRow[] = [
    ["#530 back at the bottom follows again", { stickyStart: "bottom" }, 20, "#5 #max +10/", "5/10 10/10 20/20"],
    ["#709 a clamp to a fitting range is not a return", { stickyStart: "bottom" }, 30, "#5 -28 +20", "5/20 0/0 0/12"],
    ["#1087 a reader scrolled up stays during growth", { stickyStart: "bottom" }, 30, "#5 +20", "5/20 5/40"],
    [
      "#1087 a reader who scrolls to the bottom follows",
      { stickyStart: "bottom" },
      30,
      "#5 #max +1 +9",
      "5/20 20/20 21/21 30/30",
    ],
    ["top sticky does not follow the bottom", { stickyStart: "top" }, 30, "#max +1", "20/20 20/21"],
    ["top sticky re-engages at the top", { stickyStart: "top" }, 30, "#max #0 +1", "20/20 0/20 0/21"],
    // #1088: the one-row tolerance is gone; a reader one row above the bottom stays there.
    ["#1088 one row above the bottom stays", { stickyStart: "bottom" }, 30, "#19 w:38 +1", "19/20 19/20 19/21"],
    // #1514: a shrink that clamps the reader onto the new maximum does not re-engage.
    ["#1514 a clamped reader stays", { stickyStart: "bottom" }, 30, "#10 -15 +10", "10/20 5/5 5/15"],
    ["#530 a scroll while the content fits keeps following", { stickyStart: "bottom" }, 2, "#0 +38/", "0/0 30/30"],
    // Row A: with a range of one row a scroll to 0 is noise and the view follows.
    ["A a scroll in a one-row range keeps following", { stickyStart: "bottom" }, 11, "#0 +9", "0/1 10/10"],
    [
      "C scrolled up, shrunk to fit, scrolled, grown",
      { stickyStart: "bottom" },
      30,
      "#5 -25 #0 +20",
      "5/20 0/0 0/0 15/15",
    ],
    ["F setter path follows its first content", { stickyStart: "bottom", setters: true }, 0, "+30", "20/20"],
    ["a solve elsewhere keeps a reader in a noise range", { stickyStart: "bottom" }, 11, "#0 sib", "0/1 0/1"],
    ["left sticky re-engages at the left", { stickyStart: "left", scrollX: true }, 10, "#max #0 +1", "80/80 0/80 0/90"],
    [
      "right sticky re-engages at the right",
      { stickyStart: "right", scrollX: true },
      10,
      "#5 #max +1",
      "5/80 80/80 90/90",
    ],
    // scrollTo applies again after the frame's layout: a position past the range lands once the content grows, and
    // one at or past the end stays at the end, even after growth beyond a viewport (D3).
    ["scrollTo past the range lands after growth", { stickyStart: undefined }, 20, ">15+10 +5", "20/20 20/25"],
    ["scrollTo below the range keeps its row", { stickyStart: undefined }, 20, ">7+10", "7/20"],
    // A scrollTo(0) while the content fits is not the end: it stays at the top after growth.
    ["scrollTo(0) while the content fits stays at the top", { stickyStart: undefined }, 5, ">0+30", "0/25"],
    ["scrollTo the content size stays at the end", { stickyStart: undefined }, 20, ">h+30", "40/40"],
    ["scrollTo Infinity stays at the end", { stickyStart: undefined }, 20, ">inf+30", "40/40"],
    ["scrollTo -Infinity lands at 0", { stickyStart: undefined }, 20, "#5 >-inf+5", "5/10 0/15"],
    ["a sticky scrollTo the end follows", { stickyStart: "bottom" }, 20, "#3 >h+30 +5", "3/10 40/40 45/45"],
    // As row A, a scroll in a one-row range keeps following: a scroll that leaves the view stuck keeps no target.
    ["a scrollTo in a one-row range keeps following", { stickyStart: "bottom" }, 11, ">0+9 +5", "10/10 15/15"],
    ["a sticky scrollTo away from the edge stays", { stickyStart: "bottom" }, 20, ">3+10 +5", "3/20 3/25"],
    [
      "a left-sticky scrollTo the end leaves the edge",
      { stickyStart: "left", scrollX: true },
      10,
      ">h+5 +1",
      "130/130 130/140",
    ],
  ]

  test.each(sticky)("sticky %s", async (_, options, rows, steps, expected) => {
    const { setters, stickyStart, ...rest } = options
    const horizontal = stickyStart === "left" || stickyStart === "right"
    const sizes = horizontal
      ? { width: 20, height: 5, scrollY: false, contentOptions: { flexDirection: "row" as const } }
      : {}
    const scrollBox = setters
      ? new ScrollBoxRenderable(testRenderer, { id: "sticky" })
      : new ScrollBoxRenderable(testRenderer, {
          width: 40,
          height: 10,
          stickyScroll: true,
          stickyStart,
          ...sizes,
          ...rest,
        })
    if (setters) {
      scrollBox.width = 40
      scrollBox.height = 10
      scrollBox.stickyScroll = true
      scrollBox.stickyStart = stickyStart
    }
    const sibling = new BoxRenderable(testRenderer, { width: 5, height: 1 })
    testRenderer.root.add(scrollBox)
    testRenderer.root.add(sibling)
    let next = 0
    const add = () =>
      scrollBox.add(
        horizontal
          ? new BoxRenderable(testRenderer, { width: 10, height: 2, flexShrink: 0 })
          : new TextRenderable(testRenderer, { content: `Line ${next++}` }),
      )
    for (let i = 0; i < rows; i++) add()
    await renderOnce()
    expect(scrollBox.primaryAxis).toBe(horizontal ? "row" : "column")
    const axis = horizontal ? "scrollLeft" : "scrollTop"
    const max = () =>
      horizontal
        ? scrollBox.scrollWidth - scrollBox.viewport.width
        : Math.max(0, scrollBox.scrollHeight - scrollBox.viewport.height)
    const trace: string[] = []
    for (const step of steps.split(" ")) {
      const count = Number(step.slice(1).replace("/", ""))
      if (step.startsWith("#")) scrollBox[axis] = step === "#max" ? max() : count
      else if (step.startsWith("-")) for (const child of scrollBox.getChildren().slice(0, count)) child.destroy()
      else if (step === "sib") sibling.height = sibling.height + 1
      else if (step.startsWith("w:")) scrollBox.width = Number(step.slice(2))
      else if (step.startsWith(">")) {
        const [target, added] = step.slice(1).split("+")
        const size = horizontal ? scrollBox.scrollWidth : scrollBox.scrollHeight
        const value =
          target === "h" ? size : target === "inf" ? Infinity : target === "-inf" ? -Infinity : Number(target)
        scrollBox.scrollTo(horizontal ? { x: value, y: 0 } : value)
        for (let i = 0; i < Number(added); i++) add()
      } else if (step.endsWith("/")) {
        for (let i = 0; i < count; i++) {
          add()
          await renderOnce()
          expect(scrollBox[axis]).toBe(max())
        }
      } else for (let i = 0; i < count; i++) add()
      await renderOnce()
      trace.push(`${scrollBox[axis]}/${max()}`)
    }
    expect(trace.join(" ")).toBe(expected)
  })

  // scrollChildIntoView: `rows` one-cell rows `child-i` (wrapped in `wrapper-i` when nested; 10x2 in a row when
  // horizontal) after a `tall` row "oversized", in a 40x10 box at offset `at`. The call scrolls now and again after the frame's layout, which here
  // also gets `prepend` rows inserted first. `node` passes the renderable instead of its id.
  type IntoView = {
    rows: number
    at?: number
    id: string
    options?: { align?: "nearest" | "start" | "end"; inset?: number }
    nested?: boolean
    horizontal?: boolean
    tall?: number
    node?: boolean
    prepend?: number
    expected: number
  }
  test.each<[string, IntoView]>([
    ["a visible row stays", { rows: 10, id: "child-2", expected: 0 }],
    ["a row below aligns its end", { rows: 30, id: "child-25", expected: 16 }],
    ["a row above aligns its start", { rows: 30, at: 20, id: "child-15", expected: 15 }],
    ["nested descendants by id", { rows: 30, nested: true, id: "nested-25", expected: 16 }],
    ["an unknown id does nothing", { rows: 20, at: 5, id: "missing", expected: 5 }],
    ["horizontal", { rows: 6, horizontal: true, at: 30, id: "child-0", expected: 0 }],
    ["an oversized row covering the viewport stays", { rows: 0, tall: 30, at: 10, id: "oversized", expected: 10 }],
    ["a row as tall as the viewport, partly shown, stays", { rows: 20, tall: 10, at: 5, id: "oversized", expected: 5 }],
    ["start with an inset", { rows: 30, id: "child-15", options: { align: "start", inset: 1 }, expected: 14 }],
    ["end with an inset", { rows: 30, id: "child-25", options: { align: "end", inset: 1 }, expected: 17 }],
    ["by node", { rows: 30, id: "child-12", node: true, options: { align: "start" }, expected: 12 }],
    ["after rows prepended in the same frame", { rows: 30, prepend: 3, id: "child-20", expected: 14 }],
    ["start after rows prepended", { rows: 30, prepend: 3, id: "child-5", options: { align: "start" }, expected: 8 }],
  ])("scrollChildIntoView: %s", async (_, row) => {
    const scrollBox = new ScrollBoxRenderable(testRenderer, {
      width: row.horizontal ? 20 : 40,
      height: 10,
      scrollX: row.horizontal,
      contentOptions: row.horizontal ? { flexDirection: "row" } : undefined,
    })
    const size = row.horizontal ? { width: 10, height: 2 } : { height: 1 }
    if (row.tall) scrollBox.add(new BoxRenderable(testRenderer, { id: "oversized", height: row.tall, flexShrink: 0 }))
    for (let i = 0; i < row.rows; i++) {
      const child = new BoxRenderable(testRenderer, { id: `child-${i}`, ...size })
      if (!row.nested) scrollBox.add(child)
      else {
        const wrapper = new BoxRenderable(testRenderer, { id: `wrapper-${i}`, height: 1 })
        wrapper.add(new BoxRenderable(testRenderer, { id: `nested-${i}`, height: 1 }))
        scrollBox.add(wrapper)
      }
    }
    testRenderer.root.add(scrollBox)
    await renderOnce()
    const axis = row.horizontal ? "scrollLeft" : "scrollTop"
    scrollBox[axis] = row.at ?? 0
    await renderOnce()
    const first = scrollBox.getChildren()[0]
    for (let i = 0; i < (row.prepend ?? 0); i++) scrollBox.insertBefore(new BoxRenderable(testRenderer, size), first)
    scrollBox.scrollChildIntoView(row.node ? scrollBox.findDescendantById(row.id)! : row.id, row.options)
    await renderOnce()
    expect(scrollBox[axis]).toBe(row.expected)
  })
})
