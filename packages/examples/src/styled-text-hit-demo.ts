#!/usr/bin/env bun

// Styled-text hit demo: chunks carry application `metadata`, and clicks resolve it.
//
// How to test:
//   1. Run from the example selector, or: bun src/styled-text-hit-demo.ts
//   2. Click a file name, a table cell, or the overlay
//   3. The status line shows what the click resolved to; borders, padding, and covered text show nothing
//   4. Press "o" to move the overlay, Escape to return to the menu, Ctrl+C to exit
//
// Set OPENTUI_HIT_LOG to a file path to append one JSON line per click.

import { appendFileSync } from "node:fs"
import {
  type CliRenderer,
  createCliRenderer,
  BoxRenderable,
  RGBA,
  StyledText,
  TextRenderable,
  TextTableRenderable,
  type KeyEvent,
  type MouseEvent,
  type TextChunk,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

interface FileRef {
  kind: "file"
  path: string
  line: number
}

interface RowRef {
  kind: "row"
  name: string
}

let container: BoxRenderable | null = null
let keyHandler: ((key: KeyEvent) => void) | null = null

function chunk(text: string, metadata?: unknown, fg?: string): TextChunk {
  const value: TextChunk = { __isChunk: true, text }
  if (metadata !== undefined) value.metadata = metadata
  if (fg) value.fg = RGBA.fromHex(fg)
  return value
}

function describe(metadata: unknown): string {
  const value = metadata as FileRef | RowRef | undefined
  if (!value) return "nothing"
  return value.kind === "file" ? `file ${value.path}:${value.line}` : `row ${value.name}`
}

export function run(renderer: CliRenderer): void {
  renderer.setBackgroundColor("#101418")
  const logPath = process.env.OPENTUI_HIT_LOG
  const files: FileRef[] = [
    { kind: "file", path: "src/index.ts", line: 12 },
    { kind: "file", path: "src/app.ts", line: 40 },
  ]
  const rows: RowRef[] = [
    { kind: "row", name: "alpha" },
    { kind: "row", name: "beta" },
  ]

  container = new BoxRenderable(renderer, {
    id: "styled-text-hit-container",
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
  })
  renderer.root.add(container)

  const status = new TextRenderable(renderer, {
    id: "styled-text-hit-status",
    position: "absolute",
    left: 1,
    top: 0,
    content: "Click a file name or a table cell",
  })
  container.add(status)

  const report = (source: string, event: MouseEvent, hit: unknown, cell?: { row: number; column: number }) => {
    const metadata = (hit as { metadata?: unknown } | null)?.metadata
    const summary = `${source} @${event.x},${event.y}: ${describe(metadata)}${cell ? ` cell ${cell.row},${cell.column}` : ""}`
    status.content = summary
    if (logPath) {
      appendFileSync(
        logPath,
        JSON.stringify({
          source,
          x: event.x,
          y: event.y,
          hit: metadata ? describe(metadata) : null,
          cell: cell ?? null,
          renderer: describe(renderer.getTextMetadataAt(event.x, event.y)),
        }) + "\n",
      )
    }
  }

  const output = new TextRenderable(renderer, {
    id: "styled-text-hit-output",
    position: "absolute",
    left: 1,
    top: 2,
    width: 40,
    height: 2,
    content: new StyledText([
      chunk("Error in "),
      chunk(`${files[0]!.path}:${files[0]!.line}`, files[0], "#7fb4ff"),
      chunk("\nWarning in "),
      chunk(`${files[1]!.path}:${files[1]!.line}`, files[1], "#ffd27f"),
    ]),
    onMouseDown(event) {
      report(
        "text",
        event,
        this.getStyledTextHit(event.x - Math.trunc(this.screenX), event.y - Math.trunc(this.screenY)),
      )
    },
  })
  container.add(output)

  const table = new TextTableRenderable(renderer, {
    id: "styled-text-hit-table",
    position: "absolute",
    left: 1,
    top: 5,
    content: [
      [[chunk("name")], [chunk("state")]],
      ...rows.map((row) => [[chunk(row.name, row, "#9fe0a0")], [chunk("ready")]]),
    ],
    onMouseDown(event) {
      const hit = this.getStyledTextHit(event.x - Math.trunc(this.screenX), event.y - Math.trunc(this.screenY))
      report("table", event, hit, hit?.cell)
    },
  })
  container.add(table)

  // An overlay that covers the start of the second file name.
  const overlay = new BoxRenderable(renderer, {
    id: "styled-text-hit-overlay",
    position: "absolute",
    left: 13,
    top: 3,
    width: 6,
    height: 1,
    zIndex: 10,
    backgroundColor: "#402030",
    onMouseDown(event) {
      report("overlay", event, null)
    },
  })
  container.add(overlay)

  keyHandler = (key: KeyEvent) => {
    if (key.name === "o") overlay.left = overlay.left === 13 ? 30 : 13
  }
  renderer.keyInput.on("keypress", keyHandler)
}

export function destroy(renderer: CliRenderer): void {
  if (keyHandler) renderer.keyInput.off("keypress", keyHandler)
  keyHandler = null
  container?.destroyRecursively()
  container = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  run(renderer)
  setupCommonDemoKeys(renderer)
}
