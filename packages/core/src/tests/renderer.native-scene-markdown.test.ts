import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import { Renderable } from "../Renderable.js"
import { CodeRenderable } from "../renderables/Code.js"
import { MarkdownRenderable } from "../renderables/Markdown.js"
import { SyntaxStyle } from "../syntax-style.js"
import { ManualClock } from "../testing/manual-clock.js"
import { MockTreeSitterClient } from "../testing/mock-tree-sitter-client.js"
import { createTestRenderer } from "../testing/test-renderer.js"

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(content = "") {
  const target = await createTestRenderer({ width: 32, height: 8, clock: new ManualClock() })
  const { renderer } = target
  const syntaxStyle = SyntaxStyle.fromStyles({ keyword: { fg: "#80c0ff", bold: true } }, renderer.nativeScene)
  const client = new MockTreeSitterClient()
  cleanups.push(async () => {
    renderer.destroy()
    await renderer.closed
    syntaxStyle.destroy()
    await client.destroy()
  })
  const markdown = new MarkdownRenderable(renderer, { content, syntaxStyle, treeSitterClient: client, width: "100%" })
  renderer.root.add(markdown)
  return { ...target, markdown, client }
}

test("native Markdown discards late highlights after replacement and teardown", async () => {
  const target = await setup("```ts\nconst old = 1\n```")
  const { markdown, client, renderer } = target
  await target.renderOnce()
  const old = markdown.getChildren()[0] as CodeRenderable
  const oldPending = old.highlightingDone
  markdown.clearCache()
  const current = markdown.getChildren()[0] as CodeRenderable
  assert.notEqual(current, old)
  client.resolveAllHighlightOnce()
  await oldPending
  assert.equal(old.isDestroyed, true)
  assert.equal(old.isHighlighting, false)
  await target.renderOnce()
  const pending = current.highlightingDone
  renderer.destroy()
  await renderer.closed
  client.resolveAllHighlightOnce()
  await pending
  assert.equal(current.isDestroyed, true)
  assert.equal(current.isHighlighting, false)
  assert.equal(Renderable.renderablesByNumber.has(current.num), false)
})

test("native Markdown releases partially constructed custom blocks on failure", async () => {
  const target = await setup()
  const registered = new Set(Renderable.renderablesByNumber.keys())
  const defaults: Renderable[] = []
  assert.throws(
    () =>
      new MarkdownRenderable(target.renderer, {
        content: "# First\n\n```ts\nconst n = 1\n```",
        syntaxStyle: target.markdown.syntaxStyle,
        treeSitterClient: target.client,
        renderNode(token, context) {
          const child = context.defaultRender()!
          defaults.push(child)
          if (token.type === "code") throw new Error("custom block failed")
          return child
        },
      }),
    /custom block failed/,
  )
  assert.ok(defaults.every((child) => child.isDestroyed))
  assert.deepEqual(new Set(Renderable.renderablesByNumber.keys()), registered)
  await target.renderOnce()
})

test("native Markdown releases default list owners when a destroyed style rejects a marker", async () => {
  const target = await setup()
  const syntaxStyle = SyntaxStyle.fromStyles({}, target.renderer.nativeScene)
  syntaxStyle.destroy()
  for (const internalBlockMode of ["coalesced", "top-level"] as const) {
    const registered = new Set(Renderable.renderablesByNumber.keys())
    assert.throws(
      () =>
        new MarkdownRenderable(target.renderer, {
          content: "- item",
          syntaxStyle,
          internalBlockMode,
          treeSitterClient: target.client,
          renderNode: internalBlockMode === "coalesced" ? (_token, context) => context.defaultRender() : undefined,
        }),
      /destroyed/,
    )
    assert.deepEqual(new Set(Renderable.renderablesByNumber.keys()), registered)
  }
  await target.renderOnce()
})
