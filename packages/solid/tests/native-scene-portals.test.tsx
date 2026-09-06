import { afterEach, beforeEach, expect, it } from "bun:test"
import { BoxRenderable, TextRenderable, type Renderable } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { batch, createContext, createSignal, onCleanup, onMount, Show, useContext } from "solid-js"
import { createScrollbackWriter, Portal, render, useRenderer } from "../index.js"

let setup: Awaited<ReturnType<typeof createTestRenderer>>
const tick = () => new Promise<void>((resolve) => process.nextTick(resolve))
beforeEach(async () => {
  setup = await createTestRenderer({
    width: 16,
    height: 8,
    footerHeight: 4,
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
    clock: new ManualClock(),
  })
})
afterEach(async () => {
  setup.renderer.destroy()
  await setup.renderer.closed
  await tick()
})

it.each(["main", "detached"])("moves Portal content within a %s scene without remounting its owner", async (mode) => {
  const surface = mode === "detached" ? setup.renderer.createScrollbackSurface() : undefined
  const root = surface?.root ?? setup.renderer.root
  const context = surface?.renderContext ?? setup.renderer
  const target = new BoxRenderable(context, { height: 1 })
  root.add(target)
  const [mount, setMount] = createSignal<Renderable | undefined>(surface?.root)
  const [label, setLabel] = createSignal("0")
  const [visible, setVisible] = createSignal(true)
  const Value = createContext("missing")
  const containers: BoxRenderable[] = []
  let text!: TextRenderable
  let cleanups = 0
  function Content() {
    const value = useContext(Value)
    expect(useRenderer()).toBe(setup.renderer)
    onCleanup(() => cleanups++)
    const props = () => {
      expect(text.ctx.nativeScene).toBe(context.nativeScene)
      return { content: `${value}${label()}` }
    }
    return (
      <>
        <text ref={text} {...props()} />
        <Portal>
          <text content="nested" />
        </Portal>
      </>
    )
  }
  await render(
    () => (
      <Value.Provider value="portal">
        <text content="footer" />
        <Show when={visible()}>
          <Portal mount={mount()} ref={(node) => containers.push(node as BoxRenderable)}>
            <Content />
          </Portal>
        </Show>
      </Value.Provider>
    ),
    setup.renderer,
  )
  const original = text
  expect(containers[0]!.parent).toBe(root)
  for (const [index, next] of [target, surface?.root].entries()) {
    batch(() => {
      setMount(next)
      setLabel(String(index + 1))
    })
    expect(containers[index]!.isDestroyed).toBe(false)
    await tick()
    expect(containers[index]!.isDestroyed).toBe(true)
    expect(text).toBe(original)
    expect(text.parent!.parent).toBe(next ?? root)
    expect(cleanups).toBe(0)
  }
  if (surface) {
    surface.render()
    surface.commitRows(0, surface.height)
    expect(setup.externalOutput.takeText()).toContain("portal2")
  }
  await setup.renderOnce()
  expect(setup.captureCharFrame()).toContain("nested")
  expect(setup.captureCharFrame().includes("portal2")).toBe(!surface)
  setVisible(false)
  expect(text.isDestroyed).toBe(false)
  await tick()
  expect([...containers, text].every((node) => node.isDestroyed && node.parent === null)).toBe(true)
  expect(cleanups).toBe(1)
  setVisible(true)
  setup.renderer.destroy()
  await setup.renderer.closed
  await tick()
  expect(text.isDestroyed).toBe(true)
  expect(cleanups).toBe(2)
  if (surface) expect(surface.isDestroyed).toBe(true)
})

it.each(["inside-mount", "portal-writer"])(
  "isolates scrollback owners and assigns refs before spreads (%s)",
  async (mode) => {
    let text!: TextRenderable
    let container: BoxRenderable | undefined
    let cleanups = 0
    const write = () =>
      setup.renderer.writeToScrollback(
        createScrollbackWriter(
          ({ renderContext }) => {
            onCleanup(() => cleanups++)
            const snapshotRenderer = useRenderer()
            const props = () => {
              expect(text.ctx).toBe(snapshotRenderer)
              expect(text.ctx.nativeScene).toBe(renderContext.nativeScene)
              expect(text.ctx.nativeScene).not.toBe(setup.renderer.nativeScene)
              return { content: "snapshot" }
            }
            const body = () => <text ref={text} {...props()} />
            return mode === "inside-mount" ? (
              body()
            ) : (
              <Portal
                ref={(node) => {
                  container = node as BoxRenderable
                }}
              >
                {body()}
              </Portal>
            )
          },
          { height: 1 },
        ),
      )
    function Content() {
      if (mode === "inside-mount") onMount(write)
      return <text content="main portal" />
    }
    await render(
      () => (
        <Portal>
          <Content />
        </Portal>
      ),
      setup.renderer,
    )
    if (mode === "portal-writer") write()
    expect(setup.externalOutput.takeText()).toContain("snapshot")
    expect(cleanups).toBe(1)
    await tick()
    expect((container ? [text, container] : [text]).every((node) => node.isDestroyed && node.parent === null)).toBe(
      true,
    )
    await setup.renderOnce()
    expect(setup.captureCharFrame().trim()).toBe("main portal")
  },
)

it.each(["sequential", "mount-first", "reveal-first"])("retargets empty but not live Portals (%s)", async (order) => {
  const left = setup.renderer.createScrollbackSurface()
  const right = setup.renderer.createScrollbackSurface()
  const [mount, setMount] = createSignal(left.root)
  const [visible, setVisible] = createSignal(true)
  const [label, setLabel] = createSignal("accepted")
  let text!: TextRenderable
  let owners = 0
  function Content() {
    owners++
    return (
      <Show when={visible()}>
        <text ref={text} content={label()} />
      </Show>
    )
  }
  await render(
    () => (
      <Portal mount={mount()}>
        <Content />
      </Portal>
    ),
    setup.renderer,
  )
  const original = text
  const container = text.parent!
  expect(() => setMount(right.root)).toThrow()
  expect(left.root.getChildren()).toEqual([container])
  expect(right.root.getChildren()).toEqual([])
  expect(text.parent).toBe(container)
  await tick()
  expect(text.isDestroyed).toBe(false)
  setMount(left.root)
  setLabel("retained")
  expect(text).toBe(original)
  expect(text.plainText).toBe("retained")
  setVisible(false)
  await tick()
  expect(original.isDestroyed).toBe(true)
  if (order === "sequential") {
    setMount(right.root)
    setVisible(true)
  } else
    batch(() => {
      if (order === "mount-first") {
        setMount(right.root)
        setVisible(true)
      } else {
        setVisible(true)
        setMount(right.root)
      }
    })
  expect(owners).toBe(1)
  expect(text).not.toBe(original)
  expect(text.ctx.nativeScene).toBe(right.renderContext.nativeScene)
  right.render()
  right.commitRows(0, right.height)
  expect(setup.externalOutput.takeText()).toContain("retained")
})
