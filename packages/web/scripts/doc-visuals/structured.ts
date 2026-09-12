import {
  CodeRenderable,
  DiffRenderable,
  LineNumberRenderable,
  MarkdownRenderable,
  RGBA,
  SyntaxStyle,
  TextTableRenderable,
  TextareaRenderable,
  bold,
  fg,
  type TextTableContent,
} from "@opentui/core"
import { MockTreeSitterClient } from "@opentui/core/testing"
import type { DocVisualFixture } from "./shared"

const foreground = RGBA.defaultForeground()
const background = RGBA.defaultBackground()
const muted = RGBA.fromIndex(244)

const markdownTable = "| Name | Status |\n| --- | --- |\n| api | ready |\n| worker | paused |"
const patch =
  "diff --git a/app.ts b/app.ts\nindex 1111111..2222222 100644\n--- a/app.ts\n+++ b/app.ts\n@@ -1,3 +1,3 @@\n setup()\n-const a = 1\n+const a = 2\n ready(a)\n"

export const structuredVisuals: DocVisualFixture[] = [
  {
    id: "text-table-styled",
    label: "Rounded table with Service, Status, and Notes columns: api OK, worker DEGRADED",
    width: 35,
    height: 7,
    render({ renderer }) {
      const content: TextTableContent = [
        [[bold("Service")], [bold("Status")], [bold("Notes")]],
        [[fg(foreground)("api")], [fg(foreground)("OK")], [fg(foreground)("latency 28ms")]],
        [[fg(foreground)("worker")], [fg(muted)("DEGRADED")], [fg(foreground)("queue depth: 124")]],
      ]

      renderer.root.add(
        new TextTableRenderable(renderer, {
          content,
          columnWidthMode: "content",
          borderStyle: "rounded",
          borderColor: muted,
          fg: foreground,
          bg: background,
          backgroundColor: background,
          borderBackgroundColor: background,
        }),
      )
    },
  },
  {
    id: "line-number-editor",
    label: "Three lines of numbered code with a sign beside serve(port)",
    width: 24,
    height: 3,
    render({ renderer }, registerCleanup) {
      const textarea = new TextareaRenderable(renderer, {
        width: "100%",
        height: 3,
        initialValue: "const port = 3000\nserve(port)\nawait ready()",
        backgroundColor: background,
        textColor: foreground,
      })
      registerCleanup(() => {
        if (!textarea.isDestroyed) textarea.destroy()
      })

      const gutter = new LineNumberRenderable(renderer, {
        target: textarea,
        width: "100%",
        minWidth: 3,
        paddingRight: 1,
        fg: muted,
        bg: background,
      })
      registerCleanup(() => {
        if (!gutter.isDestroyed) gutter.destroyRecursively()
      })

      gutter.setLineSign(1, { before: ">", beforeColor: foreground })
      renderer.root.add(gutter)
    },
  },
  {
    id: "code-highlighted",
    label: "JavaScript function hello with bold keywords, a muted string, and an italic comment",
    width: 33,
    height: 5,
    async render({ renderer, renderOnce }, registerCleanup) {
      const client = new MockTreeSitterClient()
      registerCleanup(() => client.destroy())

      const syntaxStyle = SyntaxStyle.fromStyles({
        default: { fg: foreground },
        keyword: { fg: foreground, bold: true },
        string: { fg: RGBA.fromIndex(247) },
        comment: { fg: muted, italic: true },
      })
      registerCleanup(() => syntaxStyle.destroy())

      client.setMockResult({
        highlights: [
          [0, 8, "keyword"],
          [21, 41, "comment"],
          [44, 49, "keyword"],
          [60, 75, "string"],
          [78, 84, "keyword"],
        ],
      })

      const code = new CodeRenderable(renderer, {
        width: "100%",
        height: 5,
        content: 'function hello() {\n  // This is a comment\n  const message = "Hello, world!"\n  return message\n}',
        filetype: "javascript",
        syntaxStyle,
        treeSitterClient: client,
        fg: foreground,
        bg: background,
      })

      renderer.root.add(code)
      await renderOnce()
      client.resolveAllHighlightOnce()
      await code.highlightingDone
    },
  },
  {
    id: "markdown-table-grid",
    label: "Bordered Markdown table with Name and Status columns: api ready, worker paused",
    width: 19,
    height: 7,
    render({ renderer }, registerCleanup) {
      const client = new MockTreeSitterClient()
      registerCleanup(() => client.destroy())

      const syntaxStyle = SyntaxStyle.fromStyles({
        default: { fg: foreground },
        "markup.heading": { fg: foreground, bold: true },
      })
      registerCleanup(() => syntaxStyle.destroy())

      renderer.root.add(
        new MarkdownRenderable(renderer, {
          width: "100%",
          content: markdownTable,
          syntaxStyle,
          treeSitterClient: client,
          fg: foreground,
          bg: background,
          tableOptions: {
            style: "grid",
            widthMode: "content",
            cellPaddingX: 1,
            borderColor: muted,
          },
        }),
      )
    },
  },
  {
    id: "markdown-table-columns",
    label: "Borderless Markdown table with Name and Status columns: api ready, worker paused",
    width: 14,
    height: 3,
    render({ renderer }, registerCleanup) {
      const client = new MockTreeSitterClient()
      registerCleanup(() => client.destroy())

      const syntaxStyle = SyntaxStyle.fromStyles({
        default: { fg: foreground },
        "markup.heading": { fg: foreground, bold: true },
      })
      registerCleanup(() => syntaxStyle.destroy())

      renderer.root.add(
        new MarkdownRenderable(renderer, {
          width: "100%",
          content: markdownTable,
          syntaxStyle,
          treeSitterClient: client,
          fg: foreground,
          bg: background,
          tableOptions: { style: "columns" },
        }),
      )
    },
  },
  {
    id: "diff-unified",
    label: "Unified diff replacing const a = 1 with const a = 2",
    width: 16,
    height: 4,
    render({ renderer }, registerCleanup) {
      const client = new MockTreeSitterClient()
      registerCleanup(() => client.destroy())

      const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: foreground } })
      registerCleanup(() => syntaxStyle.destroy())

      renderer.root.add(
        new DiffRenderable(renderer, {
          width: "100%",
          height: 4,
          diff: patch,
          view: "unified",
          syntaxStyle,
          treeSitterClient: client,
          fg: foreground,
          lineNumberFg: muted,
          lineNumberBg: background,
          addedBg: background,
          removedBg: background,
          contextBg: background,
          addedLineNumberBg: background,
          removedLineNumberBg: background,
          addedSignColor: foreground,
          removedSignColor: muted,
        }),
      )
    },
  },
  {
    id: "diff-split",
    label: "Split diff replacing const a = 1 with const a = 2",
    width: 34,
    height: 3,
    render({ renderer }, registerCleanup) {
      const client = new MockTreeSitterClient()
      registerCleanup(() => client.destroy())

      const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: foreground } })
      registerCleanup(() => syntaxStyle.destroy())

      renderer.root.add(
        new DiffRenderable(renderer, {
          width: "100%",
          height: 3,
          diff: patch,
          view: "split",
          syntaxStyle,
          treeSitterClient: client,
          fg: foreground,
          lineNumberFg: muted,
          lineNumberBg: background,
          addedBg: background,
          removedBg: background,
          contextBg: background,
          addedLineNumberBg: background,
          removedLineNumberBg: background,
          addedSignColor: foreground,
          removedSignColor: muted,
        }),
      )
    },
  },
]
