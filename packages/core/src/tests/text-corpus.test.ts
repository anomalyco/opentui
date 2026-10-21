// Runs the shared text corpus that packages/native/src/tests/text-corpus_test.zig also runs.
// The file's "format" entry documents the row keys; TypeScript cannot read virtual-line bytes,
// so the retain and chunk_widths checks and the byte column of lines run only in Zig.
import { readFileSync } from "node:fs"
import { expect, test } from "bun:test"
import { OptimizedBuffer, ResourceContext } from "../buffer.js"
import { EditBuffer } from "../edit-buffer.js"
import { TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import type { WidthMethod } from "../types.js"

type Row = Record<string, any> & { id: string }
const corpus = JSON.parse(
  readFileSync(new URL("../../../native/src/tests/fixtures/text-corpus.json", import.meta.url), "utf8"),
) as { checks: { ts: Record<string, number> }; rows: Row[] }
// no_zwj has no public TextBuffer method, and the control display is not public.
const methods: Record<string, WidthMethod> = { wcwidth: "wcwidth", unicode: "unicode", unicode_wide: "unicode-wide" }
const counts: Record<string, number> = {}
const decoder = new TextDecoder()

function runRow(row: Row, method: string, failures: string[]): void {
  const context = new ResourceContext({ objectCapacity: 4096, renderCellsMax: 1 << 20 })
  const owned: { destroy(): void }[] = []
  const own = <T extends { destroy(): void }>(value: T): T => (owned.push(value), value)
  const want = (key: string): any => {
    const value = row[key]
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value[method] : value
  }
  const check = (name: string, ok: boolean): void => {
    counts[name] = (counts[name] ?? 0) + 1
    const bug = (row.bug ?? []).find(
      ([check, , only = []]: [string, string, string[]]) =>
        check === name && (only.length === 0 || only.includes(method)),
    )
    if (ok === !bug) return
    failures.push(`${name} ${method}: ${bug ? `${bug[1]} passes` : "failed"}`)
  }
  const load = (parts: string[]): TextBuffer => {
    const buffer = own(TextBuffer.create(methods[method], context))
    buffer.setTabWidth(row.tab ?? 4)
    for (const part of parts) buffer.append(part)
    return buffer
  }
  const view = (buffer: TextBuffer, cols: number | null = row.cols ?? null): TextBufferView => {
    const created = own(TextBufferView.create(buffer))
    created.setWrapMode(row.wrap ?? "none")
    created.setWrapWidth(cols)
    created.setFirstLineOffset(row.offset ?? 0)
    return created
  }
  // [source line, source column, width] per virtual line.
  const layout = (target: TextBufferView): number[][] => {
    const info = target.lineInfo
    return info.lineSources.map((source, i) => [
      source,
      info.lineStartCols[i] - info.lineStartCols[info.lineSources.indexOf(source)],
      info.lineWidthCols[i],
    ])
  }
  const drawRows = (target: TextBufferView, width: number, height: number): string[] => {
    const screen = own(OptimizedBuffer.create(width, Math.max(height, 1), methods[method], { owner: context }))
    screen.clear()
    screen.drawTextBuffer(target, 0, 0)
    const rows = decoder.decode(screen.getRealCharBytes(true)).split("\n")
    return rows.map((line) => line.trimEnd()).filter(Boolean)
  }
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

  try {
    if (row.ops) {
      const edit = own(EditBuffer.create(methods[method], context))
      edit.setTabWidth(row.tab ?? 4)
      for (const op of row.ops) applyOp(edit, op)
      if (want("result") !== undefined) check("result", edit.getText() === want("result"))
      if (want("stops")) {
        edit.setCursor(0, 0)
        const seen: number[][] = []
        for (let i = 0; i < edit.getText().length + 2; i++) {
          const { row: line, col } = edit.getCursorPosition()
          if (seen.length > 0 && same(seen[seen.length - 1], [line, col])) break
          seen.push([line, col])
          edit.moveCursorRight()
        }
        check("stops", same(seen, want("stops")))
      }
      return
    }
    const parts: string[] = row.parts ?? [row.text]
    const buffer = load(parts)
    const text = parts.join("")
    const unwrapped = view(buffer, null)
    unwrapped.setWrapMode("none")
    if (want("width") !== undefined && !text.includes("\n"))
      check("width", unwrapped.lineInfo.lineWidthCols[0] === want("width"))
    if (want("line_widths")) check("line_widths", same(unwrapped.lineInfo.lineWidthCols, want("line_widths")))
    if (want("max") !== undefined) check("max", unwrapped.logicalLineInfo.lineWidthColsMax === want("max"))

    const main = view(buffer)
    const key = layout(main)
    if (want("lines"))
      check(
        "lines",
        same(
          key,
          want("lines").map((line: unknown[]) => line.slice(0, 3)),
        ),
      )
    if (row.wrap && row.cols !== undefined) {
      const info = main.lineInfo
      const measured = main.measureForDimensions(row.cols, 1 << 20)
      check(
        "measure",
        same(measured, { lineCount: info.lineWidthCols.length, widthColsMax: Math.max(0, ...info.lineWidthCols) }),
      )
      main.setWrapWidth(row.cols + 2)
      main.lineInfo
      main.setWrapWidth(row.cols)
      check("resize", same(layout(main), layout(view(buffer))))
    }
    if (parts.length > 1) {
      const fresh = load([text])
      const freshUnwrapped = view(fresh, null)
      freshUnwrapped.setWrapMode("none")
      check(
        "fresh",
        same(key, layout(view(fresh))) && same(unwrapped.lineInfo.lineWidthCols, freshUnwrapped.lineInfo.lineWidthCols),
      )
    }
    if (want("draw")) {
      const target = view(buffer)
      const width = row.cols ?? 80
      if (row.truncate) {
        target.setTruncate(true)
        target.setViewport(0, 0, width, want("draw").length)
      }
      check("draw", same(drawRows(target, width, target.lineInfo.lineWidthCols.length), want("draw")))
    }
    for (const [x, ...expected] of want("draw_at") ?? []) {
      const target = view(buffer, null)
      target.setViewport(x, 0, row.cols ?? 80, 1)
      check("draw_at", same(drawRows(target, row.cols ?? 80, 1), expected.filter(Boolean)))
    }
    for (const [start, end, expected] of want("select") ?? []) {
      const target = view(buffer, null)
      target.setSelection(start, end)
      check("select", target.getSelectedText() === expected)
    }
    for (const [start, end, expected] of want("range") ?? [])
      check("range", buffer.getTextRange(start, end) === expected)
    if (row.split) {
      let ok = true
      for (let cut = 1; cut < text.length; cut++) {
        if (text.charCodeAt(cut) >= 0xdc00 && text.charCodeAt(cut) <= 0xdfff) continue
        ok &&= same(layout(view(load([text.slice(0, cut), text.slice(cut)]))), layout(view(load([text]))))
      }
      check("split", ok)
    }
  } finally {
    for (const value of owned.reverse()) value.destroy()
    context.destroy()
  }
}

function applyOp(edit: EditBuffer, [name, ...args]: any[]): void {
  if (name === "repeat") {
    for (let i = 0, before = edit.getText(); i <= before.length; i++, before = edit.getText()) {
      applyOp(edit, args[0])
      if (edit.getText() === before) break
    }
  } else if (name === "set") edit.setText(args[0])
  else if (name === "cursor") edit.setCursor(args[0], args[1])
  else if (name === "insert") edit.insertText(args[0])
  else if (name === "delete") edit.deleteChar()
  else if (name === "backspace") edit.deleteCharBackward()
  else if (name === "right") edit.moveCursorRight()
  else if (name === "undo_all") while (edit.canUndo()) edit.undo()
  else throw new Error(`unknown op ${name}`)
}

for (const row of corpus.rows) {
  test(`text corpus: ${row.id}`, () => {
    const failures: string[] = []
    for (const method of row.methods ?? Object.keys(methods)) if (methods[method]) runRow(row, method, failures)
    expect(failures).toEqual([])
  })
}

// Each check kind runs as often as the file says, so a runner change cannot skip one silently.
test("text corpus: every check kind runs the expected number of times", () => {
  expect(counts).toEqual(corpus.checks.ts)
})
