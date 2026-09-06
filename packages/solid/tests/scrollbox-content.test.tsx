import { ResourceContext } from "@opentui/core"

let resourceContext: ResourceContext
beforeEach(() => {
  resourceContext = new ResourceContext({ objectCapacity: 65536, renderCellsMax: 1000000 })
})
afterEach(() => resourceContext.destroy())

import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { testRender } from "../index.js"
import { createSignal, createMemo, createEffect, For } from "solid-js"
import type { ScrollBoxRenderable } from "../../core/src/renderables/index.js"
import { SyntaxStyle } from "../../core/src/syntax-style.js"
import { MockTreeSitterClient } from "@opentui/core/testing"

let testSetup: Awaited<ReturnType<typeof testRender>>
let mockTreeSitterClient: MockTreeSitterClient

describe("ScrollBox Content Visibility", () => {
  beforeEach(async () => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
    mockTreeSitterClient = new MockTreeSitterClient()
    mockTreeSitterClient.setMockResult({ highlights: [] })
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  it("maintains content visibility when adding many items and scrolling", async () => {
    const [count, setCount] = createSignal(0)
    const messages = createMemo(() => Array.from({ length: count() }, (_, i) => `Message ${i + 1}`))

    let scrollRef: ScrollBoxRenderable | undefined

    testSetup = await testRender(
      () => (
        <box flexDirection="column" gap={1}>
          <box flexShrink={0}>
            <text>Header Content</text>
          </box>
          <scrollbox ref={(r) => (scrollRef = r)} focused stickyScroll={true} stickyStart="bottom" flexGrow={1}>
            <For each={messages()}>
              {(msg) => (
                <box marginTop={1} marginBottom={1}>
                  <text>{msg}</text>
                </box>
              )}
            </For>
          </scrollbox>
          <box flexShrink={0}>
            <text>Footer Content</text>
          </box>
        </box>
      ),
      {
        width: 40,
        height: 20,
      },
    )

    await testSetup.renderOnce()
    const initialFrame = testSetup.captureCharFrame()
    expect(initialFrame).toContain("Header Content")
    expect(initialFrame).toContain("Footer Content")

    setCount(100)
    await testSetup.renderOnce()

    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight)
      await testSetup.renderOnce()
    }

    const frameAfterScroll = testSetup.captureCharFrame()

    expect(frameAfterScroll).toContain("Header Content")
    expect(frameAfterScroll).toContain("Footer Content")

    const hasMessageContent = /Message \d+/.test(frameAfterScroll)
    expect(hasMessageContent).toBe(true)

    const nonWhitespaceChars = frameAfterScroll.replace(/\s/g, "").length
    expect(nonWhitespaceChars).toBeGreaterThan(20)
  })

  it("should maintain content visibility with code blocks in scrollbox", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)
    const codeBlock = `

# HELLO

world

## HELLO World

\`\`\`html
<div
  class="min-h-screen bg-gradient-to-br from-amber-50 via-orange-50 to-rose-50 relative overflow-hidden"
>
  <!-- Sakura Petals Background Animation -->
  <div class="absolute inset-0 pointer-events-none">
    <div class="sakura-petal absolute top-10 left-20 animate-pulse opacity-60">
      🌸
    </div>
    <div
      class="sakura-petal absolute top-1/2 right-20 animate-pulse opacity-45"
      style="animation-delay: 1.5s"
    >
      🌸
    </div>
    <div
      class="sakura-petal absolute bottom-40 right-1/3 animate-pulse opacity-55"
      style="animation-delay: 0.5s"
    >
      🌸
    </div>
  </div>
/div>
\`\`\`


`

    const [count, setCount] = createSignal(0)
    const messages = createMemo(() => Array.from({ length: count() }, (_, i) => codeBlock))

    let scrollRef: ScrollBoxRenderable | undefined

    testSetup = await testRender(
      () => (
        <box flexDirection="column" gap={1}>
          <box flexShrink={0}>
            <text>Some visual content</text>
          </box>
          <scrollbox ref={(r) => (scrollRef = r)} focused stickyScroll={true} stickyStart="bottom" flexGrow={1}>
            <For each={messages()}>
              {(code) => (
                <box marginTop={2} marginBottom={2}>
                  <code
                    drawUnstyledText={false}
                    syntaxStyle={syntaxStyle}
                    content={code}
                    filetype="markdown"
                    treeSitterClient={mockTreeSitterClient}
                  />
                </box>
              )}
            </For>
          </scrollbox>
          <box flexShrink={0}>
            <text>Some visual content</text>
          </box>
        </box>
      ),
      {
        width: 80,
        height: 30,
      },
    )

    await testSetup.renderOnce()
    const initialFrame = testSetup.captureCharFrame()
    expect(initialFrame).toContain("Some visual content")

    setCount(100)
    await testSetup.renderOnce()

    mockTreeSitterClient.resolveAllHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await testSetup.renderOnce()

    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight)
      await testSetup.renderOnce()
    }

    mockTreeSitterClient.resolveAllHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await testSetup.renderOnce()

    const frameAfterScroll = testSetup.captureCharFrame()

    expect(frameAfterScroll).toContain("Some visual content")

    const hasCodeContent =
      frameAfterScroll.includes("HELLO") ||
      frameAfterScroll.includes("world") ||
      frameAfterScroll.includes("<div") ||
      frameAfterScroll.includes("```") ||
      frameAfterScroll.includes("class=")

    expect(hasCodeContent).toBe(true)

    const nonWhitespaceChars = frameAfterScroll.replace(/\s/g, "").length
    expect(nonWhitespaceChars).toBeGreaterThan(50)
  })

  it("maintains visibility with many Code elements", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)
    const [count, setCount] = createSignal(0)

    let scrollRef: ScrollBoxRenderable | undefined

    testSetup = await testRender(
      () => (
        <box flexDirection="column" gap={1}>
          <box flexShrink={0}>
            <text>Header</text>
          </box>
          <scrollbox ref={(r) => (scrollRef = r)} focused stickyScroll={true} stickyStart="bottom" flexGrow={1}>
            <For each={Array.from({ length: count() }, (_, i) => i)}>
              {(i) => (
                <box marginTop={1} marginBottom={1}>
                  <code
                    drawUnstyledText={false}
                    syntaxStyle={syntaxStyle}
                    content={`Item ${i}`}
                    filetype="markdown"
                    treeSitterClient={mockTreeSitterClient}
                  />
                </box>
              )}
            </For>
          </scrollbox>
          <box flexShrink={0}>
            <text>Footer</text>
          </box>
        </box>
      ),
      {
        width: 40,
        height: 20,
      },
    )

    await testSetup.renderOnce()

    setCount(50)
    await testSetup.renderOnce()

    mockTreeSitterClient.resolveAllHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await testSetup.renderOnce()

    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight)
    }
    await testSetup.renderOnce()

    mockTreeSitterClient.resolveAllHighlightOnce()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await testSetup.renderOnce()

    const frame = testSetup.captureCharFrame()

    expect(frame).toContain("Header")
    expect(frame).toContain("Footer")

    const hasItems = /Item \d+/.test(frame)
    expect(hasItems).toBe(true)

    const nonWhitespaceChars = frame.replace(/\s/g, "").length
    expect(nonWhitespaceChars).toBeGreaterThan(18)
  })

  it("should maintain content when rapidly updating and scrolling", async () => {
    const [items, setItems] = createSignal<string[]>([])
    let scrollRef: ScrollBoxRenderable | undefined

    testSetup = await testRender(
      () => (
        <box flexDirection="column">
          <scrollbox ref={(r) => (scrollRef = r)} focused stickyScroll={true} flexGrow={1}>
            <For each={items()}>
              {(item) => (
                <box>
                  <text>{item}</text>
                </box>
              )}
            </For>
          </scrollbox>
        </box>
      ),
      {
        width: 40,
        height: 15,
      },
    )

    await testSetup.renderOnce()

    for (let i = 0; i < 50; i++) {
      setItems((prev) => [...prev, `Item ${i + 1}`])
    }
    await testSetup.renderOnce()

    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight)
      await testSetup.renderOnce()
    }

    const frame = testSetup.captureCharFrame()

    const hasItems = /Item \d+/.test(frame)
    expect(hasItems).toBe(true)

    const nonWhitespaceChars = frame.replace(/\s/g, "").length
    expect(nonWhitespaceChars).toBeGreaterThan(10)
  })

  it("does not split 'uses' in last message between widths 80-100", async () => {
    const syntaxStyle = SyntaxStyle.fromTheme([], resourceContext)
    const [items, setItems] = createSignal<string[]>([])
    let scrollRef: ScrollBoxRenderable | undefined

    const opencodeMessage =
      "We use `-c core.autocrlf=false` in multiple spots as a defensive override, even though the snapshot repo is configured once.\n\n" +
      "Why duplicate it:\n" +
      "- Repo config only exists after `Snapshot.track()` successfully initializes the snapshot git dir. Commands like `diff`/`show` can run later, but the override guarantees consistent behavior even if init was skipped, failed, or the git dir was pruned/rewritten.\n" +
      "- It protects against a user\u2019s global/system Git config that might otherwise override or interfere.\n" +
      "- It\u2019s especially important on commands that output content (`diff`, `show`, `numstat`) because newline conversion changes the text we return.\n\n" +
      "So: the per\u2011repo config is the baseline; the `-c` flags are a \u201Cdon\u2019t depend on baseline\u201D guard for commands where output consistency matters. Revert uses checkout, which is less about output formatting and already respects the repo config, so it didn\u2019t get the extra guard. If you want stricter consistency, we can add `-c core.autocrlf=false` there too."

    testSetup = await testRender(
      () => (
        <box flexDirection="row">
          <box flexGrow={1} paddingBottom={1} paddingTop={1} paddingLeft={2} paddingRight={2} gap={1}>
            <box flexShrink={0}>
              <text>Header</text>
            </box>
            <scrollbox
              ref={(r) => (scrollRef = r)}
              stickyScroll={true}
              stickyStart="bottom"
              flexGrow={1}
              viewportOptions={{ paddingRight: 1 }}
              verticalScrollbarOptions={{ paddingLeft: 1, visible: true }}
            >
              <For each={items()}>
                {(item) => (
                  <box marginTop={1} flexShrink={0} paddingLeft={3}>
                    <code
                      filetype="markdown"
                      drawUnstyledText={false}
                      streaming={true}
                      syntaxStyle={syntaxStyle}
                      content={item.trim()}
                    />
                  </box>
                )}
              </For>
            </scrollbox>
            <box flexShrink={0}>
              <text>Prompt</text>
            </box>
          </box>
        </box>
      ),
      {
        width: 100,
        height: 24,
      },
    )

    await testSetup.renderOnce()

    const filler = Array.from({ length: 12 }, (_, i) => `Message ${i + 1}`)
    setItems([...filler, opencodeMessage])
    await testSetup.renderOnce()
    await Bun.sleep(20)
    await testSetup.renderOnce()

    if (scrollRef) {
      scrollRef.scrollTo(scrollRef.scrollHeight)
      await testSetup.renderOnce()
    }

    const splitMatches: Array<{ width: number; line: string; nextLine: string; scrollTop: number }> = []
    const normalize = (line: string) => line.replace(/^\s+/, "").replace(/\s+$/, "")

    const scanForSplit = (width: number, scrollTop: number) => {
      const lines = testSetup.captureCharFrame().split("\n")
      let hasRevert = false
      for (let i = 0; i < lines.length - 1; i++) {
        const current = normalize(lines[i])
        const next = normalize(lines[i + 1])
        if (current.includes("Revert uses")) {
          hasRevert = true
        } else if (current.endsWith("Revert") && next.startsWith("uses ")) {
          hasRevert = true
        }
        const splitU = current.endsWith("Revert u") && next.startsWith("ses checkout")
        const splitUs = current.endsWith("Revert us") && next.startsWith("es checkout")
        const splitUse = current.endsWith("Revert use") && next.startsWith("s checkout")
        if (splitU || splitUs || splitUse) {
          splitMatches.push({ width, line: current, nextLine: next, scrollTop })
          return { foundSplit: true, hasRevert }
        }
      }
      return { foundSplit: false, hasRevert }
    }

    for (let width = 100; width >= 80; width -= 1) {
      testSetup.resize(width, 24)
      await testSetup.renderOnce()
      await Bun.sleep(20)
      await testSetup.renderOnce()
      if (scrollRef) {
        scrollRef.scrollTo(scrollRef.scrollHeight)
        await testSetup.renderOnce()
      }

      let foundRevert = false
      if (scrollRef) {
        const maxScroll = Math.max(0, scrollRef.scrollHeight - scrollRef.viewport.height)
        const step = Math.max(1, Math.floor(scrollRef.viewport.height / 3))

        for (let scrollTop = maxScroll; scrollTop >= 0; scrollTop -= step) {
          scrollRef.scrollTo(scrollTop)
          await testSetup.renderOnce()
          const { foundSplit, hasRevert } = scanForSplit(width, scrollTop)
          if (hasRevert) {
            foundRevert = true
          }
          if (foundSplit) {
            foundRevert = true
            break
          }
        }
      }
    }

    expect(splitMatches).toEqual([])
  })
})
