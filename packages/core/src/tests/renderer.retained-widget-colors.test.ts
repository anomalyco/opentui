import { afterEach, describe, test } from "bun:test"
import assert from "node:assert/strict"
import { RGBA } from "../lib/RGBA.js"
import { StyledText, stringToStyledText } from "../lib/styled-text.js"
import { CliRenderEvents } from "../renderer.js"
import { ASCIIFontRenderable } from "../renderables/ASCIIFont.js"
import { CodeRenderable } from "../renderables/Code.js"
import { DiffRenderable } from "../renderables/Diff.js"
import { LineNumberRenderable } from "../renderables/LineNumberRenderable.js"
import { MarkdownRenderable } from "../renderables/Markdown.js"
import { SelectRenderable } from "../renderables/Select.js"
import { TabSelectRenderable } from "../renderables/TabSelect.js"
import { TextRenderable } from "../renderables/Text.js"
import { TextNodeRenderable } from "../renderables/TextNode.js"
import { TextTableRenderable } from "../renderables/TextTable.js"
import { TextareaRenderable } from "../renderables/Textarea.js"
import { SyntaxStyle } from "../syntax-style.js"
import { ManualClock } from "../testing/manual-clock.js"
import { MockTreeSitterClient } from "../testing/mock-tree-sitter-client.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { Renderable } from "../Renderable.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

{
  describe(`native retained widget colors`, () => {
    async function setup() {
      const target = await createTestRenderer({ width: 40, height: 12, clock: new ManualClock() })
      const style = SyntaxStyle.create(target.renderer.nativeScene)
      const client = new MockTreeSitterClient()
      const errors: unknown[] = []
      target.renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }) => errors.push(error))
      cleanups.push(async () => {
        target.renderer.destroy()
        await target.renderer.closed
        style.destroy()
        await client.destroy()
      })
      return {
        ...target,
        style,
        client,
        async frame() {
          await target.renderOnce()
          assert.deepEqual(errors, [])
          return target.captureSpans()
        },
      }
    }

    test.each([SelectRenderable, TabSelectRenderable])("%p snapshots all menu color inputs on redraw", async (Kind) => {
      const target = await setup()
      const color = RGBA.fromHex("#123456")
      const properties = [
        "backgroundColor",
        "textColor",
        "focusedBackgroundColor",
        "focusedTextColor",
        "selectedBackgroundColor",
        "selectedTextColor",
        "selectedDescriptionColor",
        ...(Kind === SelectRenderable ? ["descriptionColor"] : []),
      ]
      const menu = new Kind(target.renderer, {
        width: 30,
        height: 6,
        options: [
          { name: "First", description: "alpha" },
          { name: "Second", description: "beta" },
        ],
        ...Object.fromEntries(properties.map((property) => [property, color])),
      })
      target.renderer.root.add(menu)
      menu.requestRender()
      for (const focused of [false, true]) {
        if (focused) menu.focus()
        const before = await target.frame()
        color.buffer[0] += 20
        menu.requestRender()
        assert.deepEqual(await target.frame(), before)
        for (const property of properties) Reflect.set(menu, property, color)
        assert.notDeepEqual(await target.frame(), before)
      }
    })

    test.each([false, true])(
      "Textarea snapshots colors across focus and placeholder replacement (focused=%s)",
      async (focused) => {
        const target = await setup()
        const color = RGBA.fromHex("#123456")
        const editor = new TextareaRenderable(target.renderer, {
          width: 12,
          height: 2,
          placeholder: "hint",
          placeholderColor: color,
          textColor: color,
          backgroundColor: color,
          focusedTextColor: color,
          focusedBackgroundColor: color,
        })
        target.renderer.root.add(editor)
        if (focused) editor.focus()
        const before = await target.frame()
        color.buffer.fill(255)
        editor.backgroundColor.buffer.fill(0)
        editor.textColor.buffer.fill(0)
        editor.placeholderColor.buffer.fill(0)
        editor.focus()
        editor.blur()
        if (focused) editor.focus()
        editor.placeholder = "other"
        editor.placeholder = "hint"
        assert.deepEqual(await target.frame(), before)
        editor.placeholderColor = color
        assert.notDeepEqual(await target.frame(), before)
      },
    )

    test("Textarea styled placeholders retain colors on unrelated replacement", async () => {
      const target = await setup()
      const color = RGBA.fromHex("#123456")
      const placeholder = new StyledText([{ __isChunk: true, text: "hint", fg: color }])
      const editor = new TextareaRenderable(target.renderer, { width: 12, height: 2, placeholder })
      target.renderer.root.add(editor)
      const before = await target.frame()
      color.buffer.fill(255)
      ;(editor.placeholder as StyledText).chunks[0].fg!.buffer.fill(0)
      editor.placeholderColor = "#ff0000"
      assert.deepEqual(await target.frame(), before)
      editor.placeholder = placeholder
      assert.notDeepEqual(await target.frame(), before)
    })

    test("ASCIIFont snapshots color arrays and detached getter elements", async () => {
      const target = await setup()
      const color = RGBA.fromHex("#123456")
      const colors = [color, RGBA.fromHex("#abcdef")]
      const font = new ASCIIFontRenderable(target.renderer, {
        text: "AB",
        color: colors,
        backgroundColor: color,
        selectionBg: color,
        selectionFg: color,
      })
      target.renderer.root.add(font)
      const before = await target.frame()
      color.buffer.fill(255)
      colors[1] = color
      const exposed = font.color as RGBA[]
      exposed[0].buffer.fill(0)
      exposed.push(color)
      ;(font.backgroundColor as RGBA).buffer.fill(0)
      font.text = "AB"
      assert.deepEqual(await target.frame(), before)
      font.color = colors
      assert.notDeepEqual(await target.frame(), before)
    })

    test("inline TextNode snapshots colors before later recomposition", async () => {
      const target = await setup()
      const color = RGBA.fromHex("#123456")
      const text = new TextRenderable(target.renderer, {})
      const span = TextNodeRenderable.fromString("inline", { fg: color, bg: color })
      text.add(span)
      target.renderer.root.add(text)
      const before = await target.frame()
      color.buffer.fill(255)
      span.fg!.buffer.fill(0)
      span.bg!.buffer.fill(0)
      span.toChunks()[0].fg!.buffer.fill(0)
      span.replace("inline", 0)
      assert.deepEqual(await target.frame(), before)
      span.fg = color
      span.bg = color
      assert.notDeepEqual(await target.frame(), before)
    })

    test("TextTable snapshots border and default colors before content rebuild", async () => {
      const target = await setup()
      const color = RGBA.fromHex("#123456")
      const table = new TextTableRenderable(target.renderer, {
        content: [[stringToStyledText("A").chunks, stringToStyledText("B").chunks]],
        borderColor: color,
        borderBackgroundColor: color,
        backgroundColor: color,
        fg: color,
        bg: color,
      })
      target.renderer.root.add(table)
      const before = await target.frame()
      assert.match(target.captureCharFrame(), /A/)
      color.buffer.fill(255)
      table.borderColor.buffer.fill(0)
      table.content = [[stringToStyledText("A").chunks, stringToStyledText("B").chunks]]
      assert.deepEqual(await target.frame(), before)
      table.borderColor = color
      assert.notDeepEqual(await target.frame(), before)
    })

    test("Markdown snapshots colors before block replacement", async () => {
      const target = await setup()
      const color = RGBA.fromHex("#123456")
      const markdown = new MarkdownRenderable(target.renderer, {
        content: "plain",
        fg: color,
        bg: color,
        syntaxStyle: target.style,
        treeSitterClient: target.client,
        tableOptions: { borderColor: color },
      })
      target.renderer.root.add(markdown)
      const frame = async () => {
        await target.frame()
        target.client.resolveAllHighlightOnce()
        await Promise.all(
          markdown
            .getChildren()
            .filter((child) => child instanceof CodeRenderable)
            .map((code) => code.highlightingDone),
        )
        return target.frame()
      }
      const before = await frame()
      assert.match(target.captureCharFrame(), /plain/)
      color.buffer.fill(255)
      markdown.fg!.buffer.fill(0)
      markdown.bg!.buffer.fill(0)
      markdown.content = "other"
      markdown.content = "plain"
      assert.deepEqual(await frame(), before)
      markdown.fg = color
      markdown.bg = color
      assert.notDeepEqual(await frame(), before)
    })

    test("Markdown snapshots table-option border colors", async () => {
      const target = await setup()
      const color = RGBA.fromHex("#123456")
      const tableOptions = { borderColor: color, style: "grid" as const }
      const content = "| A | B |\n| --- | --- |\n| one | two |"
      const markdown = new MarkdownRenderable(target.renderer, {
        content,
        tableOptions,
        syntaxStyle: target.style,
        treeSitterClient: target.client,
      })
      target.renderer.root.add(markdown)
      await target.frame()
      const before = await target.frame()
      color.buffer.fill(255)
      ;(markdown.tableOptions!.borderColor as RGBA).buffer.fill(0)
      markdown.content = "other"
      markdown.content = content
      await target.frame()
      assert.deepEqual(await target.frame(), before)
      markdown.tableOptions = tableOptions
      assert.notDeepEqual(await target.frame(), before)
    })

    test("Diff snapshots constructor and setter colors across view rebuilds", async () => {
      const target = await setup()
      const color = RGBA.fromHex("#123456")
      const properties = [
        "fg",
        "selectionBg",
        "selectionFg",
        "lineNumberFg",
        "lineNumberBg",
        "addedBg",
        "removedBg",
        "contextBg",
        "addedContentBg",
        "removedContentBg",
        "contextContentBg",
        "addedSignColor",
        "removedSignColor",
        "addedLineNumberBg",
        "removedLineNumberBg",
      ] as const
      const diff = new DiffRenderable(target.renderer, {
        diff: "--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n-old\n+new\n context",
        width: 40,
        height: 8,
        syntaxStyle: target.style,
        treeSitterClient: target.client,
        ...Object.fromEntries(properties.map((property) => [property, color])),
      })
      target.renderer.root.add(diff)
      const before = await target.frame()
      color.buffer.fill(255)
      for (const property of properties) {
        diff[property]!.buffer.fill(0)
        assert.deepEqual(diff[property]!.toInts(), [18, 52, 86, 255])
      }
      diff.view = "split"
      diff.view = "unified"
      assert.deepEqual(await target.frame(), before)
      for (const property of properties) Reflect.set(diff, property, color)
      const after = await target.frame()
      assert.notDeepEqual(after, before)
      color.buffer.fill(0)
      diff.view = "split"
      diff.view = "unified"
      assert.deepEqual(await target.frame(), after)
    })

    test("LineNumber snapshots line colors and signs including getter maps", async () => {
      const target = await setup()
      const color = RGBA.fromHex("#123456")
      const sign = { before: ">", beforeColor: color, after: "!", afterColor: color }
      const code = new CodeRenderable(target.renderer, {
        content: "one\ntwo",
        syntaxStyle: target.style,
        treeSitterClient: target.client,
      })
      const lines = new LineNumberRenderable(target.renderer, {
        target: code,
        fg: color,
        bg: color,
        lineColors: new Map([[0, { gutter: color, content: color }]]),
        lineSigns: new Map([[0, sign]]),
      })
      target.renderer.root.add(lines)
      const before = await target.frame()
      color.buffer.fill(255)
      lines.fg.buffer.fill(0)
      lines.bg.buffer.fill(0)
      lines.getLineColors().gutter.get(0)!.buffer.fill(0)
      lines.getLineColors().content.clear()
      ;(lines.getLineSigns().get(0)!.beforeColor as RGBA).buffer.fill(0)
      sign.afterColor = RGBA.fromHex("#ff0000")
      lines.lineNumberOffset = 1
      lines.lineNumberOffset = 0
      assert.deepEqual(await target.frame(), before)
      lines.setLineColor(0, color)
      lines.setLineSign(0, sign)
      assert.notDeepEqual(await target.frame(), before)
    })

    test.each(["throwing getter", "detached buffer"] as const)(
      "LineNumber preserves accepted signs when bulk capture rejects a %s",
      async (failure) => {
        const target = await setup()
        const code = new CodeRenderable(target.renderer, {
          content: "hello\nworld",
          syntaxStyle: target.style,
          treeSitterClient: target.client,
        })
        const lines = new LineNumberRenderable(target.renderer, {
          target: code,
          lineSigns: new Map([[0, { before: ">", beforeColor: "#123456" }]]),
        })
        target.renderer.root.add(lines)
        const before = await target.frame()
        const accepted = lines.getLineSigns()
        assert.match(target.captureCharFrame(), />.*1.*hello/)

        const color = RGBA.fromHex("#abcdef")
        if (failure === "throwing getter") {
          Object.defineProperty(color, "buffer", {
            get() {
              throw new Error("rejected sign color")
            },
          })
        } else {
          const buffer = color.buffer.buffer
          assert.ok(buffer instanceof ArrayBuffer)
          structuredClone(buffer, { transfer: [buffer] })
        }
        assert.throws(() =>
          lines.setLineSigns(
            new Map([
              [0, { before: "#", beforeColor: "#ff0000" }],
              [1, { before: "!", beforeColor: color }],
            ]),
          ),
        )
        const retained = lines.getLineSigns()
        lines.lineNumberOffset = 1
        lines.lineNumberOffset = 0
        const after = await target.frame()
        assert.deepEqual({ signs: retained, frame: after }, { signs: accepted, frame: before })

        lines.setLineSigns(new Map([[0, { before: "+" }]]))
        assert.notDeepEqual(await target.frame(), before)
        assert.match(target.captureCharFrame(), /\+.*1.*hello/)
      },
    )

    test.each(["Diff", "Select", "TabSelect", "Markdown", "ASCIIFont"] as const)(
      "%s cleans up rejected constructor color capture",
      async (kind) => {
        const target = await setup()
        const color = RGBA.fromHex("#123456")
        Object.defineProperty(color, "buffer", {
          get() {
            throw new Error("rejected color capture")
          },
        })
        const before = new Set(Renderable.renderablesByNumber.keys())
        const create = {
          Diff: () => new DiffRenderable(target.renderer, { fg: color, syntaxStyle: target.style }),
          Select: () => new SelectRenderable(target.renderer, { textColor: color }),
          TabSelect: () => new TabSelectRenderable(target.renderer, { textColor: color }),
          Markdown: () => new MarkdownRenderable(target.renderer, { fg: color, syntaxStyle: target.style }),
          ASCIIFont: () => new ASCIIFontRenderable(target.renderer, { color }),
        }
        assert.throws(create[kind], /rejected color capture/)
        assert.deepEqual(new Set(Renderable.renderablesByNumber.keys()), before)
        await target.frame()
      },
    )
  })
}
