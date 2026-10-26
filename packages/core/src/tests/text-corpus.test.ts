// Runs the shared text corpus that packages/native/src/tests/text-corpus_test.zig also runs.
// The file's "format" entry documents the row keys; TypeScript cannot read virtual-line bytes,
// so the retain, chunk_widths, and fit checks and the byte column of lines run only in Zig.
import { readFileSync } from "node:fs"
import { expect, test } from "bun:test"
import { OptimizedBuffer, ResourceContext } from "../buffer.js"
import { EditBuffer } from "../edit-buffer.js"
import { EditorView } from "../editor-view.js"
import { TextBuffer } from "../text-buffer.js"
import { TextBufferView } from "../text-buffer-view.js"
import { RGBA } from "../lib/RGBA.js"
import type { LineInfo, WidthMethod } from "../types.js"

type Row = Record<string, any> & { id: string }
type Bug = [string, string, string[]?]
const corpus = JSON.parse(
  readFileSync(new URL("../../../native/src/tests/fixtures/text-corpus.json", import.meta.url), "utf8"),
) as { keys: string[]; checks: { ts: Record<string, number> }; rows: Row[] }
const allMethods = ["wcwidth", "unicode", "no_zwj", "unicode_wide"]
// no_zwj has no public TextBuffer method, and the control display is not public.
const methods: Record<string, WidthMethod> = { wcwidth: "wcwidth", unicode: "unicode", unicode_wide: "unicode-wide" }
const neverReversed = ["retain", "chunk_widths", "fit", "measure", "resize", "widest"]
const counts: Record<string, number> = {}
const decoder = new TextDecoder()

/** Rows use only known keys, exactly one input, and known width methods; `bug` entries name a check that can be reversed. */
function validate(row: Row): void {
  const unknown = Object.keys(row).filter((key) => !corpus.keys.includes(key))
  if (unknown.length > 0) throw new Error(`${row.id}: unknown keys ${unknown}`)
  if (["text", "parts", "ops"].filter((key) => key in row).length !== 1) throw new Error(`${row.id}: needs one input`)
  const bugs: Bug[] = row.bug ?? []
  const names = [...(row.methods ?? []), ...bugs.flatMap(([, , only = []]) => only)]
  if (names.some((name) => !allMethods.includes(name))) throw new Error(`${row.id}: unknown width method`)
  if (bugs.some(([check]) => neverReversed.includes(check))) throw new Error(`${row.id}: that check cannot be reversed`)
}

function runRow(row: Row, method: string, failures: string[]): void {
  const context = new ResourceContext({ objectCapacity: 4096, renderCellsMax: 1 << 20 })
  const owned: { destroy(): void }[] = []
  const own = <T extends { destroy(): void }>(value: T): T => (owned.push(value), value)
  const bugs: Bug[] = (row.bug ?? []).filter(([, , only]: Bug) => !only || only.includes(method))
  const exercised = new Set<Bug>()
  const want = (key: string): any => {
    const value = row[key]
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value[method] : value
  }
  // A check named by a `bug` entry for this method must fail; every other check must pass.
  const check = (name: string, ok: boolean): void => {
    counts[name] = (counts[name] ?? 0) + 1
    const bug = bugs.find(([check]) => check === name)
    if (bug) exercised.add(bug)
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
  const layout = (info: LineInfo): number[][] =>
    info.lineSources.map((source, i) => [
      source,
      info.lineStartCols[i] - info.lineStartCols[info.lineSources.indexOf(source)],
      info.lineWidthCols[i],
    ])
  const drawRows = (target: TextBufferView, width: number, height: number): string[] => {
    const screen = own(OptimizedBuffer.create(width, Math.max(height, 1), methods[method], { owner: context }))
    screen.clear()
    screen.drawTextBuffer(target, 0, 0)
    const rows = decoder.decode(screen.getRealCharBytes(true)).split("\n")
    return rows.map((line) => line.trimEnd()).filter(Boolean)
  }
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  // The widest-line metric equals the widest unwrapped line, measure included, however the chunks fall.
  const widest = (buffer: TextBuffer): boolean => {
    const target = view(buffer, null)
    target.setWrapMode("none")
    const max = Math.max(0, ...target.lineInfo.lineWidthCols)
    return (
      target.logicalLineInfo.lineWidthColsMax === max && target.measureForDimensions(80, 1 << 20)?.widthColsMax === max
    )
  }

  try {
    if (row.ops) {
      const edit = own(EditBuffer.create(methods[method], context))
      edit.setTabWidth(row.tab ?? 4)
      for (const op of row.ops) applyOp(edit, op)
      const text = edit.getText()
      const editor = own(EditorView.create(edit, row.cols ?? 80, 1 << 10))
      editor.setWrapMode(row.wrap ?? "none")
      if (want("result") !== undefined) check("result", text === want("result"))
      if (want("line_widths"))
        check("line_widths", same(editor.getLogicalLineInfo().lineWidthCols, want("line_widths")))
      if (want("max") !== undefined) check("max", editor.getLogicalLineInfo().lineWidthColsMax === want("max"))
      const logical = editor.getLogicalLineInfo()
      check("widest", logical.lineWidthColsMax === Math.max(0, ...logical.lineWidthCols))
      check("fresh", same(layout(editor.getLineInfo()), layout(view(load([text])).lineInfo)))
      if (want("stops")) {
        edit.setCursor(0, 0)
        const seen: number[][] = []
        for (let i = 0; i < text.length + 2; i++) {
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
    check("text", buffer.getPlainText() === text.replaceAll("\r\n", "\n"))
    const unwrapped = view(buffer, null)
    unwrapped.setWrapMode("none")
    if (want("width") !== undefined && !text.includes("\n"))
      check("width", unwrapped.lineInfo.lineWidthCols[0] === want("width"))
    if (want("line_widths")) check("line_widths", same(unwrapped.lineInfo.lineWidthCols, want("line_widths")))
    if (want("max") !== undefined) check("max", unwrapped.logicalLineInfo.lineWidthColsMax === want("max"))
    check("widest", widest(buffer))

    const main = view(buffer)
    const key = layout(main.lineInfo)
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
      check("resize", same(layout(main.lineInfo), layout(view(buffer).lineInfo)))
    }
    if (parts.length > 1) check("fresh", same(key, layout(view(load([text])).lineInfo)))
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
    // At cols too, so a glyph that does not fit at the right edge is left out by every drawer.
    for (const width of row.draw_text ? [80, row.cols ?? 80] : []) {
      const target = own(OptimizedBuffer.create(width, 1, methods[method], { owner: context }))
      // The row with its trailing blanks, so a glyph drawn in other columns shows.
      const drawn = (draw: () => void): string => (target.clear(), draw(), decoder.decode(target.getRealCharBytes()))
      const white = RGBA.fromValues(1, 1, 1, 1)
      const layout = drawn(() => target.drawTextBuffer(unwrapped, 0, 0))
      check("draw_text", drawn(() => target.drawText(text, 0, 0, white)) === layout)
      const encoded = target.encodeUnicode(text)
      const place = () =>
        encoded.data.reduce((x, glyph) => (target.drawChar(glyph.char, x, 0, white, white), x + glyph.width), 0)
      check("encode", drawn(place) === layout)
      target.freeUnicode(encoded)
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
      let widestOk = true
      for (let cut = 1; cut < text.length; cut++) {
        if (text.charCodeAt(cut) >= 0xdc00 && text.charCodeAt(cut) <= 0xdfff) continue
        const pieces = load([text.slice(0, cut), text.slice(cut)])
        ok &&= same(layout(view(pieces).lineInfo), layout(view(load([text])).lineInfo))
        widestOk &&= widest(pieces)
      }
      check("split", ok)
      check("widest", widestOk)
    }
  } finally {
    for (const value of owned.reverse()) value.destroy()
    context.destroy()
    // Every entry that names this method must have reversed a check that ran.
    for (const bug of bugs) if (!exercised.has(bug)) failures.push(`${method}: bug entry ${bug[0]} never ran`)
  }
}

function applyOp(edit: EditBuffer, [name, ...args]: any[]): void {
  if (name === "repeat") {
    const limit = edit.getText().length + 1
    for (let i = 0, before = edit.getText(); i < limit; i++, before = edit.getText()) {
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
    validate(row)
    const failures: string[] = []
    for (const method of row.methods ?? allMethods) {
      if (methods[method] && row.control === undefined) runRow(row, method, failures)
      else counts.skipped = (counts.skipped ?? 0) + 1
    }
    expect(failures).toEqual([])
  })
}

// Each check kind runs as often as the file says, so a runner change cannot skip one silently.
test("text corpus: every check kind runs the expected number of times", () => {
  expect(counts).toEqual(corpus.checks.ts)
})
