import { afterEach, expect, it } from "bun:test"
import { SlotTree, type SlotClaim } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createComponent, createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
// The package entry, so the components share the app's solid-js and their error boundaries catch.
import { createTreeSlot } from "@opentui/solid"
import { _render as renderInternal } from "../src/reconciler.js"
import { RendererContext } from "../src/elements/index.js"

type Slots = { footer: { user: string }; "footer.status": {}; other: {} }
// A claim reads the slot's current input through an object: a slot map with other inputs is refused.
// @ts-expect-error
createTreeSlot(new SlotTree<JSX.Element, { title: string; empty: void }>())

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined

afterEach(() => {
  setup?.renderer.destroy()
  setup = undefined
})

async function mount(node: () => JSX.Element) {
  setup = await createTestRenderer({ width: 60, height: 4 })
  const renderer = setup.renderer
  renderInternal(() => createComponent(RendererContext.Provider, { value: renderer, children: node() }), renderer.root)
  await setup.renderOnce()
  return () => setup!.captureCharFrame().split("\n")[0]!.trim()
}

it("renders placements around the children, mounts each claim once, and checks containment", async () => {
  const tree = new SlotTree<JSX.Element, Slots>()
  const Slot = createTreeSlot(tree)
  const [user, setUser] = createSignal("ava")
  const mounts: string[] = []
  const Chip = (props: { label: string }) => {
    onMount(() => mounts.push(`+${props.label}`))
    onCleanup(() => mounts.push(`-${props.label}`))
    return <text>{props.label}</text>
  }
  const a = tree.owner("a")
  a.claim({ after: "footer.status", render: () => <Chip label="[after]" /> })
  a.claim({ append: "footer", render: (input) => <text>{`[${input.user}]`}</text> })
  tree.owner("b").claim({ before: "footer.status", render: () => <Chip label="[before]" /> })

  const frame = await mount(() => (
    <box flexDirection="row">
      <Slot
        path="footer"
        input={{
          get user() {
            return user()
          },
        }}
      >
        <Slot path="footer.status">
          <text>status</text>
        </Slot>
      </Slot>
    </box>
  ))
  expect(frame()).toBe("[before]status[after][ava]")

  setUser("kai")
  const b = tree.owner("b")
  b.reset()
  b.claim({ replace: "footer.status", render: () => <text>(mine)</text> })
  await setup!.renderOnce()
  expect(frame()).toBe("(mine)[after][kai]")
  expect(mounts).toEqual(["+[before]", "+[after]", "-[before]"])

  expect(() =>
    renderInternal(
      () => (
        <Slot path="footer" input={{ user: "x" }}>
          <Slot path="other" />
        </Slot>
      ),
      setup!.renderer.root,
    ),
  ).toThrow('Slot "other" is mounted inside "footer"')
})

it("mounts a claim once when another claim mounts its target slot, and releases it all on dispose", async () => {
  const tree = new SlotTree<JSX.Element, Slots>()
  const Slot = createTreeSlot(tree)
  const mounts: string[] = []
  const Chip = (props: { label: string }) => {
    onMount(() => mounts.push(`+${props.label}`))
    onCleanup(() => mounts.push(`-${props.label}`))
    return <text>{props.label}</text>
  }
  tree.owner("host").claim({ append: "footer", render: () => <Slot path="footer.status" /> })
  tree.owner("ext").claim({ append: "footer.status", render: () => <Chip label="ext" /> })
  const [shown, setShown] = createSignal(true)
  const frame = await mount(() => (
    <box flexDirection="row">
      <Show when={shown()}>
        <Slot path="footer" input={{ user: "ava" }} />
      </Show>
    </box>
  ))
  expect([frame(), mounts]).toEqual(["ext", ["+ext"]])
  setShown(false)
  expect([mounts, tree.resolution().placed.size]).toEqual([["+ext", "-ext"], 0])
})

it("checks a slot that a replace claim mounts against the replaced slot", async () => {
  const errors: string[] = []
  const tree = new SlotTree<JSX.Element, Slots>({
    onError: (event) => errors.push(event.error.message),
  })
  const Slot = createTreeSlot(tree)
  tree.owner("x").claim({ replace: "footer", render: () => <Slot path="other">{<text>escaped</text>}</Slot> })
  const frame = await mount(() => <Slot path="footer" input={{ user: "ava" }} />)
  expect([frame(), errors]).toEqual(["", ['Slot "other" is mounted inside "footer" but its path does not extend it']])
})

it("contains a claim that renders text outside <text> in the claim's own boundary, reported once", async () => {
  const errors: string[] = []
  const tree = new SlotTree<JSX.Element, Slots>({
    onError: (event) => errors.push(`${event.owner} ${event.path}: ${event.error.message}`),
  })
  const Slot = createTreeSlot(tree, {
    placeholder: (failure) => {
      // The failure has the tree's claim type.
      failure.claim satisfies SlotClaim<JSX.Element, Slots>
      return <text>{`(${failure.owner})`}</text>
    },
  })
  const [user, setUser] = createSignal("ava")
  tree.owner("bare").claim({ append: "footer", render: () => "👋".repeat(41) })
  tree.owner("span").claim({ append: "footer", render: () => <span>hi</span> })
  tree.owner("ok").claim({ append: "footer", render: (input) => <text>{input.user}</text> })
  const frame = await mount(() => (
    <box flexDirection="row">
      <Slot
        path="footer"
        input={{
          get user() {
            return user()
          },
        }}
      />
    </box>
  ))
  expect(frame()).toBe("(bare)(span)ava")
  setUser("kai")
  await setup!.renderOnce()
  expect(frame()).toBe("(bare)(span)kai")
  expect(errors).toEqual([
    // The quote is cut to 40 characters.
    `bare footer: A slot claim rendered bare text "${"👋".repeat(40)}…"; wrap it in <text>`,
    "span footer: A slot claim rendered a text node outside <text>; wrap it in <text>",
  ])
})
