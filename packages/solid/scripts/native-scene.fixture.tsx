import assert from "node:assert/strict"
import { TextAttributes, type BoxRenderable, type TextRenderable } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import { batch, createSignal, For } from "solid-js"
import { Dynamic, insert, render, type JSX } from "@opentui/solid"
import { jsx } from "@opentui/solid/jsx-runtime"

async function withScene(
  node: () => JSX.Element,
  check: (setup: Awaited<ReturnType<typeof createTestRenderer>>) => Promise<void>,
) {
  const setup = await createTestRenderer({ width: 48, height: 8, clock: new ManualClock(), consoleMode: "disabled" })
  try {
    await render(node, setup.renderer)
    await check(setup)
  } finally {
    setup.renderer.destroy()
    await setup.renderer.closed
  }
}

export async function refSpreadScene() {
  const [content, setContent] = createSignal("before")
  const order: string[] = []
  let text!: TextRenderable
  const props = () => {
    order.push(`spread:${text.selectable}`)
    return { selectable: false, content: `${text.id} ${content()}` }
  }
  await withScene(
    () => (
      <text
        ref={(node) => {
          text = node
          order.push(`ref:${node.selectable}`)
        }}
        id="parent"
        {...props()}
      />
    ),
    async (setup) => {
      assert.deepEqual(order, ["ref:true", "spread:true"])
      await setup.renderOnce()
      assert.match(setup.captureCharFrame(), /parent before/)
      setContent("after")
      assert.deepEqual(order, ["ref:true", "spread:true", "spread:false"])
      await setup.renderOnce()
      assert.equal(setup.renderer.root.getChildren()[0], text)
      assert.match(setup.captureCharFrame(), /parent after/)
    },
  )
  assert.equal(text.isDestroyed, true)
}

export async function optionalAttributesScene() {
  const [bold, setBold] = createSignal(false)
  await withScene(
    () => <text attributes={bold() ? TextAttributes.BOLD : undefined}>text</text>,
    async (setup) => {
      for (const enabled of [false, true, false]) {
        setBold(enabled)
        await setup.renderOnce()
        assert.equal(setup.captureSpans().lines[0]!.spans[0]!.attributes, enabled ? TextAttributes.BOLD : 0)
      }
    },
  )
}

export async function optionalZIndexScene() {
  const [active, setActive] = createSignal(false)
  let panel!: BoxRenderable
  let cover!: BoxRenderable
  await withScene(
    () => (
      <>
        <box
          ref={panel}
          position="absolute"
          width={8}
          height={1}
          zIndex={active() ? 2500 : undefined}
          onMouseUp={() => setActive(false)}
        >
          <text selectable={false}>panel</text>
        </box>
        <box ref={cover} position="absolute" width={8} height={1} zIndex={1}>
          <text selectable={false}>cover</text>
        </box>
      </>
    ),
    async (setup) => {
      for (const enabled of [false, true, false]) {
        if (enabled) setActive(true)
        else await setup.mockMouse.click(0, 0)
        await setup.renderOnce()
        assert.equal(panel.zIndex, enabled ? 2500 : 0)
        assert.ok(setup.captureCharFrame().startsWith(enabled ? "panel" : "cover"))
        assert.equal(setup.renderer.hitTest(0, 0), (enabled ? panel : cover).getChildren()[0]!.num)
      }
    },
  )
}

export async function inlineScene() {
  const [content, setContent] = createSignal("before")
  const [url, setUrl] = createSignal("https://example.com/before")
  let text!: TextRenderable
  const Child = () => (
    <>
      <b>{text.id}</b> <a href={url()}>{content()}</a>
    </>
  )
  await withScene(
    () => <text ref={text} id="parent" {...{ children: <Child /> }} />,
    async (setup) => {
      assert.equal(text.selectable, true)
      for (const value of ["before", "after"]) {
        batch(() => {
          setContent(value)
          setUrl(`https://example.com/${value}`)
        })
        await setup.renderOnce()
        assert.match(setup.captureCharFrame(), new RegExp(`parent ${value}`))
        assert.equal(setup.renderer.root.getChildren()[0], text)
        assert.equal(text.textNode.gatherWithInheritedStyle().find((chunk) => chunk.text === value)?.link?.url, url())
      }
    },
  )
}

export async function runtimeScene() {
  const [content, setContent] = createSignal("before")
  let runtime!: TextRenderable
  await withScene(
    () => (
      <box>
        {
          jsx("text", {
            ref: (node: TextRenderable) => (runtime = node),
            get children() {
              return content()
            },
          }) as JSX.Element
        }
        <Dynamic component="text">
          <b>{content()}</b>
        </Dynamic>
      </box>
    ),
    async (setup) => {
      const parent = setup.renderer.root.getChildren()[0]!
      const dynamic = parent.getChildren()[1] as TextRenderable
      for (const value of ["before", "after"]) {
        setContent(value)
        await setup.renderOnce()
        assert.deepEqual(parent.getChildren(), [runtime, dynamic])
        assert.equal(setup.captureCharFrame().split(value).length - 1, 2)
        for (const node of [runtime, dynamic]) assert.equal(node.selectable, true)
      }
    },
  )
}

export async function keyedScene() {
  const [items, setItems] = createSignal(["Alpha", "Beta", "Gamma"])
  const nodes = new Map<string, TextRenderable>()
  let source!: BoxRenderable
  let target!: BoxRenderable
  await withScene(
    () => (
      <box>
        <box ref={source}>
          <For each={items()}>
            {(item) => (
              <text ref={(node) => nodes.set(item, node)} id="duplicate">
                {item}
              </text>
            )}
          </For>
        </box>
        <box ref={target} />
      </box>
    ),
    async (setup) => {
      const first = nodes.get("Alpha")!
      const second = nodes.get("Beta")!
      const third = nodes.get("Gamma")!
      setItems(["Gamma", "Alpha", "Beta"])
      assert.deepEqual(source.getChildren(), [third, first, second])
      setItems(["Gamma", "Beta"])
      assert.equal(first.parent, null)
      assert.equal(first.isDestroyed, false)
      insert(target, first)
      await new Promise<void>((resolve) => process.nextTick(resolve))
      assert.equal(first.isDestroyed, false)
      assert.deepEqual(target.getChildren(), [first])
      setItems(["Gamma"])
      assert.equal(second.isDestroyed, false)
      await new Promise<void>((resolve) => process.nextTick(resolve))
      assert.equal(second.isDestroyed, true)
      assert.deepEqual(source.getChildren(), [third])
      await setup.renderOnce()
      assert.doesNotMatch(setup.captureCharFrame(), /Beta/)
      assert.match(setup.captureCharFrame(), /Alpha/)
    },
  )
  for (const node of nodes.values()) assert.equal(node.isDestroyed, true)
}

export async function run() {
  await refSpreadScene()
  await optionalAttributesScene()
  await optionalZIndexScene()
  await inlineScene()
  await runtimeScene()
  await keyedScene()
}
