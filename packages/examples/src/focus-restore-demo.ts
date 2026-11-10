#!/usr/bin/env bun

// Interactive demo to test the focus restore fix on Windows Terminal.
//
// How to test:
//   1. Run from the example selector, or: bun src/examples/focus-restore-demo.ts
//   2. Move the mouse around - you should see the mouse position update live
//   3. Alt-tab away from the terminal, then alt-tab back
//   4. Move the mouse again - if the fix works, mouse tracking resumes immediately
//   5. Try minimizing and restoring the window too
//   6. Press Escape to return to menu, Ctrl+C to exit

import {
  type CliRenderer,
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  RGBA,
  TextAttributes,
  type MouseEvent,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let container: BoxRenderable | null = null
let mouseArea: BoxRenderable | null = null

let mouseX = 0
let mouseY = 0
let mouseEvents = 0
let focusCount = 0
let blurCount = 0
let restoreCount = 0
let lastFocusTime = ""
let lastBlurTime = ""
let lastMouseTime = ""
let focused = true
let originalRestore: any = null
let focusHandler: (() => void) | null = null
let blurHandler: (() => void) | null = null

// Log storage
const logEntries: Array<{ text: string; color: RGBA }> = []
const maxLogEntries = 20

// Renderable references for updates
let focusStatus: TextRenderable | null = null
let mouseStatus: TextRenderable | null = null
let countersStatus: TextRenderable | null = null
let timestampStatus: TextRenderable | null = null
let logBox: BoxRenderable | null = null
const logRenderables: TextRenderable[] = []

function ts(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false })
}

function addLogLine(renderer: CliRenderer, text: string, color: RGBA) {
  if (!logBox) return

  logEntries.push({ text, color })
  while (logEntries.length > maxLogEntries) {
    logEntries.shift()
  }

  // Remove old renderables
  for (const r of logRenderables) {
    logBox.remove(r)
    r.destroy()
  }
  logRenderables.length = 0

  // Rebuild from entries
  for (let i = 0; i < logEntries.length; i++) {
    const entry = logEntries[i]
    const line = new TextRenderable(renderer, {
      id: `focus-demo-log-${i}`,
      content: entry.text,
      fg: entry.color,
      height: 1,
    })
    logBox.add(line)
    logRenderables.push(line)
  }
}

function updateDisplay() {
  if (focusStatus) {
    focusStatus.content = focused
      ? "Focus: YES  (terminal modes active)"
      : "Focus: NO   (modes may be stripped by terminal)"
    focusStatus.fg = focused ? RGBA.fromInts(126, 231, 135) : RGBA.fromInts(255, 100, 100)
  }
  if (mouseStatus) {
    mouseStatus.content = `Mouse: (${mouseX}, ${mouseY}) | Events: ${mouseEvents}`
  }
  if (countersStatus) {
    countersStatus.content = `Focus-in: ${focusCount} | Focus-out: ${blurCount} | Mode restores: ${restoreCount}`
  }
  if (timestampStatus) {
    timestampStatus.content = `Last focus: ${lastFocusTime || "--"} | Last blur: ${lastBlurTime || "--"} | Last mouse: ${lastMouseTime || "--"}`
  }
}

export function run(renderer: CliRenderer): void {
  renderer.setBackgroundColor("#0D1117")

  // Reset state
  mouseX = 0
  mouseY = 0
  mouseEvents = 0
  focusCount = 0
  blurCount = 0
  restoreCount = 0
  lastFocusTime = ""
  lastBlurTime = ""
  lastMouseTime = ""
  focused = true
  logEntries.length = 0

  container = new BoxRenderable(renderer, {
    id: "focus-demo-main",
    flexDirection: "column",
    padding: 1,
  })
  renderer.root.add(container)

  // Title
  const title = new TextRenderable(renderer, {
    id: "focus-demo-title",
    content: "Focus Restore Demo - Mouse Tracking + Terminal Mode Restore",
    fg: RGBA.fromInts(72, 209, 204),
    attributes: TextAttributes.BOLD,
    height: 2,
  })
  container.add(title)

  // Instructions
  const instructions = new TextRenderable(renderer, {
    id: "focus-demo-instructions",
    content:
      "Move mouse to see tracking. Alt-tab away and back. Mouse should resume.\n" +
      "Minimize and restore. Try clicking after returning. Escape to return to menu.",
    fg: RGBA.fromInts(160, 160, 180),
    height: 3,
  })
  container.add(instructions)

  // Status box
  const statusBox = new BoxRenderable(renderer, {
    id: "focus-demo-status-box",
    border: true,
    borderColor: "#4ECDC4",
    borderStyle: "rounded",
    title: "Terminal State",
    titleAlignment: "center",
    padding: 1,
    flexDirection: "column",
    marginTop: 1,
  })
  container.add(statusBox)

  focusStatus = new TextRenderable(renderer, {
    id: "focus-demo-focus-status",
    content: "Focus: YES  (terminal modes active)",
    fg: RGBA.fromInts(126, 231, 135),
    height: 1,
  })
  statusBox.add(focusStatus)

  mouseStatus = new TextRenderable(renderer, {
    id: "focus-demo-mouse-status",
    content: "Mouse: (0, 0) | Events: 0",
    fg: RGBA.fromInts(165, 214, 255),
    height: 1,
  })
  statusBox.add(mouseStatus)

  countersStatus = new TextRenderable(renderer, {
    id: "focus-demo-counters",
    content: "Focus-in: 0 | Focus-out: 0 | Mode restores: 0",
    fg: RGBA.fromInts(210, 168, 255),
    height: 1,
  })
  statusBox.add(countersStatus)

  timestampStatus = new TextRenderable(renderer, {
    id: "focus-demo-timestamps",
    content: "Last focus: -- | Last blur: -- | Last mouse: --",
    fg: RGBA.fromInts(139, 148, 158),
    height: 1,
  })
  statusBox.add(timestampStatus)

  // Event log box
  logBox = new BoxRenderable(renderer, {
    id: "focus-demo-log-box",
    border: true,
    borderColor: "#6BCF7F",
    borderStyle: "rounded",
    title: "Event Log (latest 20)",
    titleAlignment: "center",
    padding: 1,
    flexDirection: "column",
    marginTop: 1,
    flexGrow: 1,
  })
  container.add(logBox)

  // Mouse tracking area (covers whole screen, behind everything)
  mouseArea = new BoxRenderable(renderer, {
    id: "focus-demo-mouse-area",
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    zIndex: -1,
    onMouse(event: MouseEvent) {
      mouseX = event.x
      mouseY = event.y
      mouseEvents++
      lastMouseTime = ts()
      updateDisplay()
    },
  })
  renderer.root.add(mouseArea)

  // Spy on restoreTerminalModes to count restore calls
  originalRestore = (renderer as any).lib.restoreTerminalModes
  ;(renderer as any).lib.restoreTerminalModes = (...args: any[]) => {
    restoreCount++
    return originalRestore.call((renderer as any).lib, ...args)
  }

  // Focus/blur handlers
  focusHandler = () => {
    focused = true
    focusCount++
    lastFocusTime = ts()
    addLogLine(
      renderer,
      `[${ts()}] FOCUS IN  - terminal modes restored (restore #${restoreCount})`,
      RGBA.fromInts(126, 231, 135),
    )
    updateDisplay()
  }

  blurHandler = () => {
    focused = false
    blurCount++
    lastBlurTime = ts()
    addLogLine(renderer, `[${ts()}] FOCUS OUT - terminal may strip escape codes`, RGBA.fromInts(255, 165, 0))
    updateDisplay()
  }

  renderer.on("focus", focusHandler)
  renderer.on("blur", blurHandler)

  addLogLine(renderer, `[${ts()}] Demo started. Move mouse, then alt-tab away and back.`, RGBA.fromInts(165, 214, 255))
  updateDisplay()

  renderer.requestRender()
}

export function destroy(renderer: CliRenderer): void {
  // Restore spy
  if (originalRestore) {
    ;(renderer as any).lib.restoreTerminalModes = originalRestore
    originalRestore = null
  }

  // Remove event listeners
  if (focusHandler) {
    renderer.off("focus", focusHandler)
    focusHandler = null
  }
  if (blurHandler) {
    renderer.off("blur", blurHandler)
    blurHandler = null
  }

  // Clean up renderables
  if (mouseArea) {
    renderer.root.remove(mouseArea)
    mouseArea.destroy()
    mouseArea = null
  }
  if (container) {
    renderer.root.remove(container)
    container.destroyRecursively()
    container = null
  }

  logRenderables.length = 0
  logEntries.length = 0
  focusStatus = null
  mouseStatus = null
  countersStatus = null
  timestampStatus = null
  logBox = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    enableMouseMovement: true,
  })
  run(renderer)
  setupCommonDemoKeys(renderer)
}
