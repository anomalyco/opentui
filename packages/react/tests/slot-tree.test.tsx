import { afterEach, expect, it, spyOn } from "bun:test"
import { SlotTree, type SlotClaim } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { act, useEffect, type ReactNode } from "react"
// The package entry, so the components share the app's react and their error boundaries catch.
import { createTreeSlot } from "@opentui/react"
import { createRoot, type Root } from "../src/reconciler/renderer.js"

type Slots = { footer: { user: string }; "footer.status": {}; other: {} }
// Slot inputs are objects, as in the Solid slot: a slot map with other inputs is refused.
// @ts-expect-error
createTreeSlot(new SlotTree<ReactNode, { title: string; empty: void }>())

let setup: Awaited<ReturnType<typeof createTestRenderer>> | undefined
let root: Root | undefined

afterEach(() => {
  act(() => root?.unmount())
  setup?.renderer.destroy()
  root = setup = undefined
  // @ts-expect-error test-only global
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
})

it("renders placements around the children and keeps a claim mounted while another owner reloads", async () => {
  // @ts-expect-error test-only global
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const tree = new SlotTree<ReactNode, Slots>()
  const Slot = createTreeSlot(tree)
  const mounts: string[] = []
  const Chip = (props: { label: string }) => {
    useEffect(() => {
      mounts.push(`+${props.label}`)
      return () => void mounts.push(`-${props.label}`)
    }, [])
    return <text>{props.label}</text>
  }
  const a = tree.owner("a")
  a.claim({ after: "footer.status", render: () => <Chip label="[after]" /> })
  a.claim({ append: "footer", render: (input) => <text>{`[${input.user}]`}</text> })
  const b = tree.owner("b")
  b.claim({ before: "footer.status", render: () => <Chip label="[before]" /> })

  const app = (user: string) => (
    <box flexDirection="row">
      <Slot path="footer" input={{ user }}>
        <Slot path="footer.status">
          <text>status</text>
        </Slot>
      </Slot>
    </box>
  )
  await act(async () => {
    setup = await createTestRenderer({ width: 60, height: 4 })
    root = createRoot(setup.renderer)
    root.render(app("ava"))
  })
  const frame = async () => {
    await setup!.renderOnce()
    return setup!.captureCharFrame().split("\n")[0]!.trim()
  }
  expect(await frame()).toBe("[before]status[after][ava]")

  act(() => {
    root!.render(app("kai"))
    b.reset()
    b.claim({ replace: "footer.status", render: () => <text>(mine)</text> })
  })
  expect(await frame()).toBe("(mine)[after][kai]")
  expect(mounts.filter((entry) => entry.endsWith("[after]"))).toEqual(["+[after]"])
})

it("contains a claim that renders text outside <text> in the claim's own boundary, and reports each failure once", async () => {
  // @ts-expect-error test-only global
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const errors: string[] = []
  const tree = new SlotTree<ReactNode, Slots>({
    onError: (event) => errors.push(`${event.owner} ${event.path} ${event.phase}: ${event.error.message}`),
  })
  const Slot = createTreeSlot(tree, {
    placeholder: (failure) => {
      // The failure has the tree's claim type.
      failure.claim satisfies SlotClaim<ReactNode, Slots>
      if (failure.owner === "boom") throw new Error("no placeholder")
      return <text>{`(${failure.owner})`}</text>
    },
  })
  tree.owner("bare").claim({ append: "footer", render: () => "hello" })
  tree.owner("boom").claim({
    append: "footer",
    render: () => {
      throw new Error("broken")
    },
  })
  tree.owner("escape").claim({ append: "footer", render: () => <Slot path="other" /> })
  tree.owner("ok").claim({ append: "footer", render: (input) => <text>{input.user}</text> })
  // React logs every error a boundary catches.
  using _quiet = spyOn(console, "error").mockImplementation(() => {})
  const app = (user: string) => (
    <box flexDirection="row">
      <Slot path="footer" input={{ user }} />
    </box>
  )
  await act(async () => {
    setup = await createTestRenderer({ width: 60, height: 4 })
    root = createRoot(setup.renderer)
    root.render(app("ava"))
  })
  act(() => root!.render(app("kai")))
  await setup!.renderOnce()
  expect(setup!.captureCharFrame().split("\n")[0]!.trim()).toBe("(bare)(escape)kai")
  expect(errors).toEqual([
    "bare footer render: Text must be created inside of a text node",
    "boom footer render: broken",
    "boom footer placeholder: no placeholder",
    'escape footer render: Slot "other" is mounted inside "footer" but its path does not extend it',
  ])
})
