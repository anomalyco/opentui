import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { testRender } from "../index.js"
import { createSignal, For, Show, Index } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"

let testSetup: Awaited<ReturnType<typeof testRender>>

/**
 * Tests for the ScrollBox getParentNode fix in reconciler.ts.
 *
 * ScrollBox delegates add/remove to its internal `content` wrapper, so
 * children report `content` as their parent. The reconciler passes the
 * ScrollBox itself, causing the identity check in cleanChildren
 * (getParentNode(el) === parent) to fail — stale nodes were never removed.
 *
 * The fix makes _getParentNode walk up from `content` to return the owning
 * ScrollBox. The bug only manifests when `marker !== undefined` (multiple
 * dynamic siblings), so all tests use scrollbox with 2+ sibling expressions.
 */

// Helper: count children whose id starts with a given prefix
function countById(parent: { getChildren(): { id: string }[] }, prefix: string) {
  return parent.getChildren().filter((c) => c.id.startsWith(prefix)).length
}

function idsOf(parent: { getChildren(): { id: string }[] }, ...prefixes: string[]) {
  return parent
    .getChildren()
    .filter((c) => prefixes.some((p) => c.id.startsWith(p)))
    .map((c) => c.id)
}

describe("scrollbox cleanChildren: multi-sibling cleanup", () => {
  beforeEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  // ─── Two <For> lists in scrollbox ───

  describe("two <For> lists in scrollbox", () => {
    it("clear first list, keep second", async () => {
      const [headers, setHeaders] = createSignal(["h1", "h2"])
      const [items, setItems] = createSignal(["a", "b", "c"])

      testSetup = await testRender(
        () => (
          <scrollbox id="scroll" flexGrow={1}>
            <For each={headers()}>{(h) => <box id={`h-${h}`} />}</For>
            <For each={items()}>{(item) => <box id={`i-${item}`} />}</For>
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )

      await testSetup.renderOnce()
      const scrollbox = testSetup.renderer.root.findDescendantById("scroll")!
      expect(countById(scrollbox, "h-")).toBe(2)
      expect(countById(scrollbox, "i-")).toBe(3)

      setHeaders([])
      await testSetup.renderOnce()
      expect(countById(scrollbox, "h-")).toBe(0)
      expect(countById(scrollbox, "i-")).toBe(3)
    })

    it("clear second list, keep first", async () => {
      const [headers, setHeaders] = createSignal(["h1", "h2"])
      const [items, setItems] = createSignal(["a", "b", "c"])

      testSetup = await testRender(
        () => (
          <scrollbox id="scroll" flexGrow={1}>
            <For each={headers()}>{(h) => <box id={`h-${h}`} />}</For>
            <For each={items()}>{(item) => <box id={`i-${item}`} />}</For>
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )

      await testSetup.renderOnce()
      const scrollbox = testSetup.renderer.root.findDescendantById("scroll")!
      expect(countById(scrollbox, "h-")).toBe(2)
      expect(countById(scrollbox, "i-")).toBe(3)

      setItems([])
      await testSetup.renderOnce()
      expect(countById(scrollbox, "h-")).toBe(2)
      expect(countById(scrollbox, "i-")).toBe(0)
    })

    it("clear both lists simultaneously", async () => {
      const [headers, setHeaders] = createSignal(["h1", "h2"])
      const [items, setItems] = createSignal(["a", "b", "c"])

      testSetup = await testRender(
        () => (
          <scrollbox id="scroll" flexGrow={1}>
            <For each={headers()}>{(h) => <box id={`h-${h}`} />}</For>
            <For each={items()}>{(item) => <box id={`i-${item}`} />}</For>
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )

      await testSetup.renderOnce()
      const scrollbox = testSetup.renderer.root.findDescendantById("scroll")!

      setHeaders([])
      setItems([])
      await testSetup.renderOnce()
      expect(countById(scrollbox, "h-")).toBe(0)
      expect(countById(scrollbox, "i-")).toBe(0)
    })

    it("clear both then repopulate both", async () => {
      const [headers, setHeaders] = createSignal(["h1", "h2"])
      const [items, setItems] = createSignal(["a", "b"])

      testSetup = await testRender(
        () => (
          <scrollbox id="scroll" flexGrow={1}>
            <For each={headers()}>{(h) => <box id={`h-${h}`} />}</For>
            <For each={items()}>{(item) => <box id={`i-${item}`} />}</For>
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )

      await testSetup.renderOnce()
      const scrollbox = testSetup.renderer.root.findDescendantById("scroll")!

      setHeaders([])
      setItems([])
      await testSetup.renderOnce()
      expect(countById(scrollbox, "h-")).toBe(0)
      expect(countById(scrollbox, "i-")).toBe(0)

      setHeaders(["x1"])
      setItems(["y1", "y2", "y3"])
      await testSetup.renderOnce()
      expect(countById(scrollbox, "h-")).toBe(1)
      expect(countById(scrollbox, "i-")).toBe(3)
      expect(idsOf(scrollbox, "h-", "i-")).toEqual(["h-x1", "i-y1", "i-y2", "i-y3"])
    })
  })

  // ─── Three <For> lists in scrollbox ───

  describe("three <For> lists in scrollbox", () => {
    it("clear middle list, keep outer lists", async () => {
      const [aList, setAList] = createSignal(["a1", "a2"])
      const [bList, setBList] = createSignal(["b1", "b2", "b3"])
      const [cList, setCList] = createSignal(["c1"])

      testSetup = await testRender(
        () => (
          <scrollbox id="scroll" flexGrow={1}>
            <For each={aList()}>{(a) => <box id={`a-${a}`} />}</For>
            <For each={bList()}>{(b) => <box id={`b-${b}`} />}</For>
            <For each={cList()}>{(c) => <box id={`c-${c}`} />}</For>
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )

      await testSetup.renderOnce()
      const scrollbox = testSetup.renderer.root.findDescendantById("scroll")!

      setBList([])
      await testSetup.renderOnce()
      expect(countById(scrollbox, "a-")).toBe(2)
      expect(countById(scrollbox, "b-")).toBe(0)
      expect(countById(scrollbox, "c-")).toBe(1)
    })
  })

  // ─── Store + reconcile ───

  describe("store + reconcile with two <For> in scrollbox", () => {
    it("reconcile both to empty", async () => {
      const [state, setState] = createStore<{
        headers: { id: string }[]
        items: { id: string }[]
      }>({
        headers: [{ id: "h1" }, { id: "h2" }],
        items: [{ id: "i1" }, { id: "i2" }, { id: "i3" }],
      })

      testSetup = await testRender(
        () => (
          <scrollbox id="scroll" flexGrow={1}>
            <For each={state.headers}>{(h) => <box id={`h-${h.id}`} />}</For>
            <For each={state.items}>{(item) => <box id={`i-${item.id}`} />}</For>
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )

      await testSetup.renderOnce()
      const scrollbox = testSetup.renderer.root.findDescendantById("scroll")!
      expect(countById(scrollbox, "h-")).toBe(2)
      expect(countById(scrollbox, "i-")).toBe(3)

      setState("headers", reconcile([]))
      setState("items", reconcile([]))
      await testSetup.renderOnce()
      expect(countById(scrollbox, "h-")).toBe(0)
      expect(countById(scrollbox, "i-")).toBe(0)
    })

    it("reconcile to completely new data", async () => {
      const [state, setState] = createStore<{
        headers: { id: string }[]
        items: { id: string }[]
      }>({
        headers: [{ id: "h1" }],
        items: [{ id: "i1" }, { id: "i2" }],
      })

      testSetup = await testRender(
        () => (
          <scrollbox id="scroll" flexGrow={1}>
            <For each={state.headers}>{(h) => <box id={`h-${h.id}`} />}</For>
            <For each={state.items}>{(item) => <box id={`i-${item.id}`} />}</For>
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )

      await testSetup.renderOnce()
      const scrollbox = testSetup.renderer.root.findDescendantById("scroll")!

      setState("headers", reconcile([{ id: "h10" }, { id: "h11" }]))
      setState("items", reconcile([{ id: "i10" }]))
      await testSetup.renderOnce()

      expect(countById(scrollbox, "h-")).toBe(2)
      expect(countById(scrollbox, "i-")).toBe(1)
      expect(idsOf(scrollbox, "h-", "i-")).toEqual(["h-h10", "h-h11", "i-i10"])
    })
  })

  // ─── Continuous renderer (the exact bug conditions) ───

  describe("continuous renderer + two <For> in scrollbox", () => {
    it("clear second list with continuous renderer", async () => {
      const [headers, setHeaders] = createSignal(["h1"])
      const [items, setItems] = createSignal<string[]>([])

      testSetup = await testRender(
        () => (
          <scrollbox id="scroll" flexGrow={1}>
            <For each={headers()}>{(h) => <box id={`h-${h}`} />}</For>
            <For each={items()}>{(item) => <box id={`i-${item}`} />}</For>
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )

      testSetup.renderer.start()
      await new Promise((r) => setTimeout(r, 30))
      const scrollbox = testSetup.renderer.root.findDescendantById("scroll")!

      setItems(["a", "b", "c"])
      await new Promise((r) => setTimeout(r, 50))
      expect(countById(scrollbox, "i-")).toBe(3)
      expect(countById(scrollbox, "h-")).toBe(1)

      setItems([])
      await new Promise((r) => setTimeout(r, 50))
      expect(countById(scrollbox, "i-")).toBe(0)
      expect(countById(scrollbox, "h-")).toBe(1)

      testSetup.renderer.stop()
    })

    it("produce + reconcile clear", async () => {
      const [state, setState] = createStore<{
        tags: { id: string }[]
        rows: { id: string }[]
      }>({
        tags: [{ id: "t1" }],
        rows: [],
      })

      testSetup = await testRender(
        () => (
          <scrollbox id="scroll" flexGrow={1}>
            <For each={state.tags}>{(tag) => <box id={`tag-${tag.id}`} />}</For>
            <For each={state.rows}>{(row) => <box id={`row-${row.id}`} />}</For>
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )

      testSetup.renderer.start()
      await new Promise((r) => setTimeout(r, 30))
      const scrollbox = testSetup.renderer.root.findDescendantById("scroll")!

      for (let i = 1; i <= 4; i++) {
        setState(
          produce((s) => {
            s.rows.push({ id: `r${i}` })
          }),
        )
        await new Promise((r) => setTimeout(r, 15))
      }

      await new Promise((r) => setTimeout(r, 50))
      expect(countById(scrollbox, "row-")).toBe(4)
      expect(countById(scrollbox, "tag-")).toBe(1)

      setState("rows", reconcile([]))
      await new Promise((r) => setTimeout(r, 50))

      expect(countById(scrollbox, "row-")).toBe(0)
      expect(countById(scrollbox, "tag-")).toBe(1)

      testSetup.renderer.stop()
    })

    it("multiple clear-repopulate cycles", async () => {
      const [state, setState] = createStore<{
        sys: { id: string }[]
        data: { id: string }[]
      }>({
        sys: [{ id: "s0" }],
        data: [],
      })

      testSetup = await testRender(
        () => (
          <scrollbox id="scroll" flexGrow={1}>
            <For each={state.sys}>{(s) => <box id={`sys-${s.id}`} />}</For>
            <For each={state.data}>{(d) => <box id={`data-${d.id}`} />}</For>
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )

      testSetup.renderer.start()
      await new Promise((r) => setTimeout(r, 30))
      const scrollbox = testSetup.renderer.root.findDescendantById("scroll")!

      for (let cycle = 1; cycle <= 3; cycle++) {
        // Populate via produce
        for (let i = 1; i <= 3; i++) {
          setState(
            produce((s) => {
              s.data.push({ id: `d${cycle}-${i}` })
            }),
          )
          await new Promise((r) => setTimeout(r, 10))
        }
        await new Promise((r) => setTimeout(r, 30))
        expect(countById(scrollbox, "data-")).toBe(3)

        // Clear via reconcile
        setState("data", reconcile([]))
        await new Promise((r) => setTimeout(r, 50))
        expect(countById(scrollbox, "data-")).toBe(0)
        expect(countById(scrollbox, "sys-")).toBe(1)
      }

      testSetup.renderer.stop()
    })
  })

  // ─── <Show> creates markers too — test cleanup with <For> sibling ───

  describe("<Show> + <For> in scrollbox (Show creates marker)", () => {
    it("<For> + <Show> with <For>: clear inner list", async () => {
      const [headers, setHeaders] = createSignal(["h1", "h2"])
      const [showItems, setShowItems] = createSignal(true)
      const [items, setItems] = createSignal(["a", "b"])

      testSetup = await testRender(
        () => (
          <scrollbox id="scroll" flexGrow={1}>
            <For each={headers()}>{(h) => <box id={`h-${h}`} />}</For>
            <Show when={showItems()}>
              <For each={items()}>{(item) => <box id={`i-${item}`} />}</For>
            </Show>
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )

      await testSetup.renderOnce()
      const scrollbox = testSetup.renderer.root.findDescendantById("scroll")!
      expect(countById(scrollbox, "h-")).toBe(2)
      expect(countById(scrollbox, "i-")).toBe(2)

      setShowItems(false)
      await testSetup.renderOnce()
      expect(countById(scrollbox, "h-")).toBe(2)
      expect(countById(scrollbox, "i-")).toBe(0)

      setShowItems(true)
      await testSetup.renderOnce()
      expect(countById(scrollbox, "h-")).toBe(2)
      expect(countById(scrollbox, "i-")).toBe(2)
    })

    it("<Show> toggling between two <For> lists", async () => {
      const [mode, setMode] = createSignal<"a" | "b">("a")
      const listA = ["a1", "a2", "a3"]
      const listB = ["b1", "b2"]

      testSetup = await testRender(
        () => (
          <scrollbox id="scroll" flexGrow={1}>
            <Show when={mode() === "a"}>
              <For each={listA}>{(item) => <box id={`a-${item}`} />}</For>
            </Show>
            <Show when={mode() === "b"}>
              <For each={listB}>{(item) => <box id={`b-${item}`} />}</For>
            </Show>
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )

      await testSetup.renderOnce()
      const scrollbox = testSetup.renderer.root.findDescendantById("scroll")!
      expect(countById(scrollbox, "a-")).toBe(3)
      expect(countById(scrollbox, "b-")).toBe(0)

      setMode("b")
      await testSetup.renderOnce()
      expect(countById(scrollbox, "a-")).toBe(0)
      expect(countById(scrollbox, "b-")).toBe(2)

      setMode("a")
      await testSetup.renderOnce()
      expect(countById(scrollbox, "a-")).toBe(3)
      expect(countById(scrollbox, "b-")).toBe(0)
    })
  })

  // ─── Static children create markers for adjacent <For> ───

  describe("static children + <For> in scrollbox", () => {
    it("static before <For>: clear list keeps static", async () => {
      const [items, setItems] = createSignal(["a", "b"])

      testSetup = await testRender(
        () => (
          <scrollbox id="scroll" flexGrow={1}>
            <box id="static-header">
              <text>Header</text>
            </box>
            <For each={items()}>{(item) => <box id={`item-${item}`} />}</For>
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )

      await testSetup.renderOnce()
      const scrollbox = testSetup.renderer.root.findDescendantById("scroll")!
      expect(countById(scrollbox, "static-header")).toBe(1)
      expect(countById(scrollbox, "item-")).toBe(2)

      setItems([])
      await testSetup.renderOnce()
      expect(countById(scrollbox, "static-header")).toBe(1)
      expect(countById(scrollbox, "item-")).toBe(0)

      setItems(["x", "y", "z"])
      await testSetup.renderOnce()
      expect(countById(scrollbox, "static-header")).toBe(1)
      expect(countById(scrollbox, "item-")).toBe(3)
    })

    it("static between two <For>: clear both keeps divider", async () => {
      const [topItems, setTopItems] = createSignal(["t1", "t2"])
      const [bottomItems, setBottomItems] = createSignal(["b1", "b2"])

      testSetup = await testRender(
        () => (
          <scrollbox id="scroll" flexGrow={1}>
            <For each={topItems()}>{(item) => <box id={`top-${item}`} />}</For>
            <box id="divider">
              <text>---</text>
            </box>
            <For each={bottomItems()}>{(item) => <box id={`bot-${item}`} />}</For>
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )

      await testSetup.renderOnce()
      const scrollbox = testSetup.renderer.root.findDescendantById("scroll")!

      setTopItems([])
      await testSetup.renderOnce()
      expect(countById(scrollbox, "top-")).toBe(0)
      expect(countById(scrollbox, "divider")).toBe(1)
      expect(countById(scrollbox, "bot-")).toBe(2)

      setBottomItems([])
      await testSetup.renderOnce()
      expect(countById(scrollbox, "divider")).toBe(1)
      expect(countById(scrollbox, "bot-")).toBe(0)
    })

    it("static after <For>: clear list keeps footer", async () => {
      const [items, setItems] = createSignal(["a", "b"])

      testSetup = await testRender(
        () => (
          <scrollbox id="scroll" flexGrow={1}>
            <For each={items()}>{(item) => <box id={`item-${item}`} />}</For>
            <box id="static-footer">
              <text>Footer</text>
            </box>
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )

      await testSetup.renderOnce()
      const scrollbox = testSetup.renderer.root.findDescendantById("scroll")!

      setItems([])
      await testSetup.renderOnce()
      expect(countById(scrollbox, "item-")).toBe(0)
      expect(countById(scrollbox, "static-footer")).toBe(1)
    })
  })

  // ─── <Index> + <For> siblings (Index also creates marker) ───

  describe("<Index> + <For> siblings in scrollbox", () => {
    it("clear <Index>, keep <For>", async () => {
      const [indexItems, setIndexItems] = createSignal(["x", "y"])
      const [forItems, setForItems] = createSignal(["a", "b"])

      testSetup = await testRender(
        () => (
          <scrollbox id="scroll" flexGrow={1}>
            <Index each={indexItems()}>{(item, idx) => <box id={`idx-${idx}`} />}</Index>
            <For each={forItems()}>{(item) => <box id={`for-${item}`} />}</For>
          </scrollbox>
        ),
        { width: 40, height: 20 },
      )

      await testSetup.renderOnce()
      const scrollbox = testSetup.renderer.root.findDescendantById("scroll")!
      expect(countById(scrollbox, "idx-")).toBe(2)
      expect(countById(scrollbox, "for-")).toBe(2)

      setIndexItems([])
      await testSetup.renderOnce()
      expect(countById(scrollbox, "idx-")).toBe(0)
      expect(countById(scrollbox, "for-")).toBe(2)
    })
  })
})
