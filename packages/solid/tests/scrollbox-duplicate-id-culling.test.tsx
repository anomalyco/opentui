import { afterEach, expect, test } from "bun:test"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createSignal, For } from "solid-js"
import { testRender } from "../index.js"

const setups: Array<Awaited<ReturnType<typeof testRender>>> = []
afterEach(() => setups.splice(0).forEach((setup) => setup.renderer.destroy()))

test("removing a multi-file tool block does not orphan a duplicate-id child in scrollbox ordering", async () => {
  const [files, setFiles] = createSignal(Array.from({ length: 7 }, (_, index) => ({ index })))
  let scroll: ScrollBoxRenderable | undefined
  const setup = await testRender(
    () => (
      <box width={40} height={12}>
        <scrollbox ref={(value) => (scroll = value)} viewportCulling={true} flexGrow={1}>
          <box height={20} flexShrink={0}>
            <text>before</text>
          </box>
          <For each={files()}>
            {(file) => (
              <box id="tool-block-part" height={10 + file.index} flexShrink={0}>
                <text>file {file.index}</text>
              </box>
            )}
          </For>
          <For each={Array.from({ length: 30 }, (_, index) => index)}>
            {(index) => (
              <box id={`tail-${index}`} height={10} flexShrink={0}>
                <text>tail {index}</text>
              </box>
            )}
          </For>
        </scrollbox>
      </box>
    ),
    { width: 40, height: 12 },
  )
  setups.push(setup)
  await setup.renderOnce()

  scroll!.scrollTo(scroll!.scrollHeight)
  await setup.renderOnce()

  setFiles([])
  await setup.renderOnce()

  scroll!.scrollBy(-100)
  await setup.renderOnce()

  const duplicateChildren = scroll!.getChildren().filter((child) => child.id === "tool-block-part")
  const sortedChildren = scroll!.getChildrenSortedByPrimaryAxis().filter((child) => typeof child.screenY === "number")
  const sortedMonotonically = sortedChildren.every(
    (child, index) => index === 0 || child.screenY >= sortedChildren[index - 1]!.screenY,
  )

  expect({
    remainingDuplicateChildren: duplicateChildren.length,
    parentlessDuplicateChildren: duplicateChildren.filter((child) => !child.parent).length,
    sortedMonotonically,
  }).toEqual({
    remainingDuplicateChildren: 0,
    parentlessDuplicateChildren: 0,
    sortedMonotonically: true,
  })
})
