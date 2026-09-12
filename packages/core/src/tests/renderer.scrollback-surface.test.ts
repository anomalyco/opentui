import { afterEach, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import type { OptimizedBuffer } from "../buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { Renderable, type RenderableOptions } from "../Renderable.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CodeRenderable } from "../renderables/Code.js"
import { ImageRenderable } from "../renderables/Image.js"
import { MarkdownRenderable } from "../renderables/Markdown.js"
import { TextRenderable } from "../renderables/Text.js"
import { SyntaxStyle } from "../syntax-style.js"
import { createTestRenderer, MockTreeSitterClient, setRendererCapabilities, type TestRenderer } from "../testing.js"
import type { RenderContext } from "../types.js"
import { getLinkId } from "../utils.js"

type ClaimedCommit = {
  snapshot: OptimizedBuffer
  rowColumns: number
  startOnNewLine: boolean
  trailingNewline: boolean
}

const decoder = new TextDecoder()
const syntaxStyle = SyntaxStyle.fromStyles({
  default: { fg: RGBA.fromValues(1, 1, 1, 1) },
})

class CountingRenderable extends Renderable {
  public renderCount = 0

  constructor(ctx: RenderContext, options: RenderableOptions) {
    super(ctx, options)
  }

  protected renderSelf(): void {
    this.renderCount += 1
  }
}

const activeRenderers: TestRenderer[] = []
const activeTreeSitterClients: MockTreeSitterClient[] = []

afterEach(async () => {
  for (const renderer of activeRenderers.splice(0)) {
    renderer.destroy()
  }
  for (const client of activeTreeSitterClients.splice(0)) {
    client.resolveAllHighlightOnce()
    await client.destroy()
  }
})

async function createSplitFooterRenderer(options: Parameters<typeof createTestRenderer>[0] = {}) {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    ...options,
  })

  activeRenderers.push(result.renderer)
  return result
}

function claimCommits(renderer: TestRenderer): ClaimedCommit[] {
  return (renderer as any).externalOutputQueue.claim() as ClaimedCommit[]
}

function destroyClaimedCommits(commits: ClaimedCommit[]): void {
  for (const commit of commits) {
    commit.snapshot.destroy()
  }
}

function numericMarginBottom(renderable: Renderable): number {
  return typeof renderable.marginBottom === "number" ? renderable.marginBottom : 0
}

function createMockTreeSitterClient(
  options?: ConstructorParameters<typeof MockTreeSitterClient>[0],
): MockTreeSitterClient {
  const client = new MockTreeSitterClient(options)
  activeTreeSitterClients.push(client)
  return client
}

test("ScrollbackSurface.commitRows reuses the last rendered buffer", async () => {
  const { renderer } = await createSplitFooterRenderer()
  const surface = renderer.createScrollbackSurface()

  const counter = new CountingRenderable(surface.renderContext, {
    id: "surface-counter",
    width: 5,
    height: 1,
  })
  const text = new TextRenderable(surface.renderContext, {
    id: "surface-text",
    content: "hello",
    width: 5,
    height: 1,
  })

  counter.add(text)
  surface.root.add(counter)
  surface.render()

  expect(counter.renderCount).toBe(1)

  surface.commitRows(0, surface.height)

  expect(counter.renderCount).toBe(1)

  const commits = claimCommits(renderer)

  try {
    expect(commits).toHaveLength(1)
    expect(decoder.decode(commits[0]!.snapshot.getRealCharBytes(true))).toContain("hello")
  } finally {
    destroyClaimedCommits(commits)
  }
})

test("ScrollbackSurface retains loaded images for native scrollback rendering", async () => {
  const { renderer } = await createSplitFooterRenderer({ width: 8, height: 6, footerHeight: 3 })
  const surface = renderer.createScrollbackSurface({ startOnNewLine: true })
  const source = new Uint8Array(await readFile(new URL("./fixtures/images/rgba.png", import.meta.url)))
  const card = new BoxRenderable(surface.renderContext, {
    id: "surface-image-card",
    width: 8,
    height: 4,
    border: true,
  })
  const image = new ImageRenderable(surface.renderContext, {
    id: "surface-image",
    source,
    protocol: "kitty",
    width: "100%",
    height: "100%",
  })
  card.add(image)
  surface.root.add(card)

  await image.loadPromise
  expect(image.image).not.toBeNull()
  surface.render()
  expect(surface.height).toBe(4)
  surface.commitRows(0, surface.height, { rowColumns: 8, trailingNewline: false })
  surface.destroy()

  let nextTailColumn = -1
  renderer.writeToScrollback((ctx) => {
    nextTailColumn = ctx.tailColumn
    const root = new TextRenderable(ctx.renderContext, {
      id: "after-surface-image",
      position: "absolute",
      left: 0,
      top: 0,
      width: 1,
      height: 1,
      content: "X",
    })
    return { root, width: 1, height: 1, startOnNewLine: false, trailingNewline: false }
  })

  const commits = claimCommits(renderer)
  try {
    expect(commits).toHaveLength(2)
    expect(commits[0]!.snapshot.buffers.char.some((char) => (char & 0xc0000000) >>> 0 === 0x40000000)).toBe(true)
    expect(nextTailColumn).toBe(8)
  } finally {
    destroyClaimedCommits(commits)
  }
})

test("ScrollbackSurface.settle waits for code highlighting before commit", async () => {
  const { renderer } = await createSplitFooterRenderer()
  const surface = renderer.createScrollbackSurface({ startOnNewLine: true })
  const mockTreeSitterClient = createMockTreeSitterClient()
  mockTreeSitterClient.setMockResult({ highlights: [] })

  const code = new CodeRenderable(surface.renderContext, {
    id: "surface-code",
    content: "const x = 1",
    filetype: "typescript",
    syntaxStyle,
    drawUnstyledText: false,
    treeSitterClient: mockTreeSitterClient,
    width: "100%",
  })

  surface.root.add(code)

  const settlePromise = surface.settle()

  expect(code.isHighlighting).toBe(true)

  mockTreeSitterClient.resolveAllHighlightOnce()
  await settlePromise

  expect(code.isHighlighting).toBe(false)

  surface.commitRows(code.y, code.y + code.height)

  const commits = claimCommits(renderer)

  try {
    expect(commits).toHaveLength(1)
    expect(decoder.decode(commits[0]!.snapshot.getRealCharBytes(true))).toContain("const x = 1")
  } finally {
    destroyClaimedCommits(commits)
  }
})

test("ScrollbackSurface.settle renders a queued streaming highlight", async () => {
  const { renderer } = await createSplitFooterRenderer()
  const surface = renderer.createScrollbackSurface({ startOnNewLine: true })
  const mockTreeSitterClient = createMockTreeSitterClient()
  const highlightCalls: string[] = []
  const highlightOnce = mockTreeSitterClient.highlightOnce.bind(mockTreeSitterClient)
  mockTreeSitterClient.highlightOnce = async (content, filetype) => {
    highlightCalls.push(content)
    return highlightOnce(content, filetype)
  }
  const code = new CodeRenderable(surface.renderContext, {
    id: "surface-code-streaming",
    content: "initial",
    filetype: "typescript",
    syntaxStyle,
    streaming: true,
    treeSitterClient: mockTreeSitterClient,
    width: "100%",
  })

  surface.root.add(code)
  surface.render()
  code.content = "latest"

  const settlePromise = surface.settle()
  void settlePromise.catch(() => {})
  expect(highlightCalls).toEqual(["initial"])

  mockTreeSitterClient.resolveHighlightOnce()
  await new Promise<void>((resolve) => setImmediate(resolve))

  expect(highlightCalls).toEqual(["initial", "latest"])

  mockTreeSitterClient.resolveHighlightOnce()
  await settlePromise
})

test("ScrollbackSurface works with MarkdownRenderable top-level blocks", async () => {
  const { renderer } = await createSplitFooterRenderer()
  const surface = renderer.createScrollbackSurface({ startOnNewLine: true })
  const mockTreeSitterClient = createMockTreeSitterClient({ autoResolveTimeout: 0 })
  mockTreeSitterClient.setMockResult({ highlights: [] })

  const md = new MarkdownRenderable(surface.renderContext, {
    id: "surface-markdown",
    content: "# Title\n\nPara 1\n\n",
    syntaxStyle,
    streaming: true,
    internalBlockMode: "top-level",
    treeSitterClient: mockTreeSitterClient,
  })

  surface.root.add(md)
  await surface.settle()

  md.content = "# Title\n\nPara 1\n\nPara 2"
  await surface.settle()

  expect(md._stableBlockCount).toBe(1)

  const stableBlock = md._blockStates[0]!
  const nextBlock = md._blockStates[1]
  const stableEnd = nextBlock
    ? nextBlock.renderable.y
    : stableBlock.renderable.y + stableBlock.renderable.height + numericMarginBottom(stableBlock.renderable)

  surface.commitRows(stableBlock.renderable.y, stableEnd, { trailingNewline: false })

  const commits = claimCommits(renderer)

  try {
    expect(commits).toHaveLength(1)

    const rendered = decoder.decode(commits[0]!.snapshot.getRealCharBytes(true))
    expect(rendered).toContain("Title")
    expect(rendered).not.toContain("Para 1")
  } finally {
    destroyClaimedCommits(commits)
  }
})

test("ScrollbackSurface forwards hyperlink capability changes to existing Markdown tables", async () => {
  const { renderer } = await createSplitFooterRenderer()
  setRendererCapabilities(renderer, { hyperlinks: false })
  const capabilityListenerCount = renderer.listenerCount("capabilities")
  const surface = renderer.createScrollbackSurface({ startOnNewLine: true })
  const mockTreeSitterClient = createMockTreeSitterClient({ autoResolveTimeout: 0 })
  mockTreeSitterClient.setMockResult({ highlights: [] })
  const url = "https://example.com/table"
  const markdown = new MarkdownRenderable(surface.renderContext, {
    id: "surface-markdown-capability-transition",
    content: `| Link |\n|---|\n| [OpenTUI](${url}) |`,
    syntaxStyle,
    tableOptions: { widthMode: "content" },
    treeSitterClient: mockTreeSitterClient,
  })

  surface.root.add(markdown)
  await surface.settle()
  const table = markdown._blockStates[0]!.renderable
  surface.commitRows(0, surface.height)

  for (const hyperlinks of [true, false]) {
    const capabilities = setRendererCapabilities(renderer, { hyperlinks })
    renderer.emit("capabilities", capabilities)
    expect(surface.renderContext.capabilities).toBe(capabilities)
    await surface.settle()
    expect(markdown._blockStates[0]!.renderable).toBe(table)
    surface.commitRows(0, surface.height)
  }

  const commits = claimCommits(renderer)

  try {
    expect(commits).toHaveLength(3)
    const frames = commits.map((commit) => decoder.decode(commit.snapshot.getRealCharBytes(true)))
    expect(frames[0]).toContain(`OpenTUI (${url})`)
    expect(frames[1]).toContain("\u2502OpenTUI\u2502")
    expect(frames[1]).not.toContain(url)
    expect(frames[2]).toContain(`OpenTUI (${url})`)

    for (const [index, commit] of commits.entries()) {
      const lines = frames[index]!.split("\n")
      const y = lines.findIndex((line) => line.includes("OpenTUI"))
      expect(y).toBeGreaterThanOrEqual(0)
      const x = lines[y]!.indexOf("OpenTUI")

      const attributes = commit.snapshot.buffers.attributes[y * commit.snapshot.width + x]!
      expect(commit.snapshot.lib.linkGetUrl(getLinkId(attributes))).toBe(url)
    }
  } finally {
    destroyClaimedCommits(commits)
  }

  surface.destroy()
  expect(renderer.listenerCount("capabilities")).toBe(capabilityListenerCount)
})

test("ScrollbackSurface commitRows respects top-level block margins from custom renderNode blocks", async () => {
  const { renderer } = await createSplitFooterRenderer()
  const surface = renderer.createScrollbackSurface({ startOnNewLine: true })
  const mockTreeSitterClient = createMockTreeSitterClient({ autoResolveTimeout: 0 })
  mockTreeSitterClient.setMockResult({ highlights: [] })

  const md = new MarkdownRenderable(surface.renderContext, {
    id: "surface-markdown-custom-scrollback",
    content: "# Title\n\nPara 1\n\n",
    syntaxStyle,
    streaming: true,
    internalBlockMode: "top-level",
    treeSitterClient: mockTreeSitterClient,
    renderNode: (node, ctx) => {
      if (node.type === "heading") {
        return new TextRenderable(surface.renderContext, {
          id: "surface-markdown-custom-heading",
          content: "CUSTOM",
          width: "100%",
        })
      }

      return ctx.defaultRender()
    },
  })

  surface.root.add(md)
  await surface.settle()

  md.content = "# Title\n\nPara 1\n\nPara 2"
  await surface.settle()

  expect(md._stableBlockCount).toBe(1)

  const stableBlock = md._blockStates[0]!
  const nextBlock = md._blockStates[1]
  const stableEnd = nextBlock
    ? nextBlock.renderable.y
    : stableBlock.renderable.y + stableBlock.renderable.height + numericMarginBottom(stableBlock.renderable)

  expect(nextBlock!.renderable.y).toBe(stableEnd)

  surface.commitRows(stableBlock.renderable.y, stableEnd, { trailingNewline: false })

  const commits = claimCommits(renderer)

  try {
    expect(commits).toHaveLength(1)

    const rendered = decoder.decode(commits[0]!.snapshot.getRealCharBytes(true))
    expect(rendered).toContain("CUSTOM")
    expect(rendered).not.toContain("Para 1")
  } finally {
    destroyClaimedCommits(commits)
  }
})

test("ScrollbackSurface captures inline first-line offset at creation", async () => {
  const { renderer, renderOnce } = await createSplitFooterRenderer({
    width: 10,
    height: 6,
    footerHeight: 3,
  })

  renderer.writeToScrollback((ctx) => {
    const root = new TextRenderable(ctx.renderContext, {
      id: "seed-tail",
      position: "absolute",
      left: 0,
      top: 0,
      width: 5,
      height: 1,
      content: "12345",
    })

    return {
      root,
      width: 5,
      height: 1,
      startOnNewLine: false,
      trailingNewline: false,
    }
  })

  await renderOnce()

  const surface = renderer.createScrollbackSurface({ startOnNewLine: false })
  const text = new TextRenderable(surface.renderContext, {
    id: "surface-inline-text",
    content: "abcdef",
    width: "100%",
    wrapMode: "char",
  })

  surface.root.add(text)
  surface.render()

  expect(text.height).toBe(2)
})

test("ScrollbackSurface.commitRows defaults to closing committed row chunks", async () => {
  const { renderer } = await createSplitFooterRenderer({
    width: 20,
    height: 6,
    footerHeight: 3,
  })

  const surface = renderer.createScrollbackSurface()
  const text = new TextRenderable(surface.renderContext, {
    id: "surface-default-newline",
    content: "closed-row",
    width: "100%",
  })

  surface.root.add(text)
  surface.render()
  surface.commitRows(0, 1)

  let tailColumn = -1
  renderer.writeToScrollback((ctx) => {
    tailColumn = ctx.tailColumn
    const root = new TextRenderable(ctx.renderContext, {
      id: "tail-column-probe",
      content: "next",
      width: 4,
      height: 1,
    })

    return {
      root,
      width: 4,
      height: 1,
    }
  })

  expect(tailColumn).toBe(0)

  destroyClaimedCommits(claimCommits(renderer))
})

test("ScrollbackSurface preserves inline first-line offset when the first markdown block is replaced", async () => {
  const { renderer, renderOnce } = await createSplitFooterRenderer({
    width: 10,
    height: 6,
    footerHeight: 3,
  })

  renderer.writeToScrollback((ctx) => {
    const root = new TextRenderable(ctx.renderContext, {
      id: "seed-tail-replacement",
      position: "absolute",
      left: 0,
      top: 0,
      width: 5,
      height: 1,
      content: "12345",
    })

    return {
      root,
      width: 5,
      height: 1,
      startOnNewLine: false,
      trailingNewline: false,
    }
  })

  await renderOnce()

  const surface = renderer.createScrollbackSurface({ startOnNewLine: false })
  const mockTreeSitterClient = createMockTreeSitterClient({ autoResolveTimeout: 0 })
  mockTreeSitterClient.setMockResult({ highlights: [] })

  const md = new MarkdownRenderable(surface.renderContext, {
    id: "surface-inline-markdown",
    content: "abcdef",
    syntaxStyle,
    streaming: true,
    internalBlockMode: "top-level",
    treeSitterClient: mockTreeSitterClient,
  })

  surface.root.add(md)
  await surface.settle()

  const initialRenderable = md._blockStates[0]!.renderable
  expect(initialRenderable.height).toBe(2)

  md.content = "# abcdef"
  await surface.settle()

  const replacementRenderable = md._blockStates[0]!.renderable
  expect(replacementRenderable).not.toBe(initialRenderable)
  expect(replacementRenderable.height).toBe(2)
})

test("ScrollbackSurface.commitRows rejects stale geometry after resize", async () => {
  const { renderer, resize } = await createSplitFooterRenderer({
    width: 40,
    height: 10,
    footerHeight: 4,
  })

  const surface = renderer.createScrollbackSurface()
  const text = new TextRenderable(surface.renderContext, {
    id: "surface-resize",
    content: "resize me",
    width: "100%",
  })

  surface.root.add(text)
  surface.render()

  resize(60, 16)

  expect(() => {
    surface.commitRows(0, surface.height)
  }).toThrow("ScrollbackSurface.commitRows requires render() after renderer geometry changes")

  surface.render()

  expect(() => {
    surface.commitRows(0, surface.height)
  }).not.toThrow()

  const commits = claimCommits(renderer)
  destroyClaimedCommits(commits)
})

test("CliRenderer writeToScrollback lays out tall snapshots against the resolved snapshot height", async () => {
  const { renderer } = await createSplitFooterRenderer({
    width: 20,
    height: 6,
    footerHeight: 3,
  })

  renderer.writeToScrollback((ctx) => {
    const root = new TextRenderable(ctx.renderContext, {
      id: "tall-snapshot",
      position: "absolute",
      left: 0,
      top: 0,
      width: 1,
      height: "100%",
      content: "1\n2\n3\n4\n5\n6\n7\n8",
    })

    return {
      root,
      width: 1,
      height: 8,
      trailingNewline: false,
    }
  })

  const commits = claimCommits(renderer)

  try {
    expect(commits).toHaveLength(1)
    expect(commits[0]!.snapshot.height).toBe(8)
    expect(commits[0]!.snapshot.height).toBeGreaterThan(renderer.height)

    const lines = decoder.decode(commits[0]!.snapshot.getRealCharBytes(true)).split("\n")
    expect(lines.slice(0, 8)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"])
  } finally {
    destroyClaimedCommits(commits)
  }
})
