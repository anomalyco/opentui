import {
  CliRenderer,
  CliRenderEvents,
  createCliRenderer,
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  TextareaRenderable,
  BoxRenderable,
  TextRenderable,
  LineNumberRenderable,
  KeyEvent,
  MouseButton,
  PasteEvent,
  t,
  bold,
  cyan,
  fg,
  type ClipboardSelection,
  type ClipboardService,
  type HostClipboardService,
  type Selection,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

const initialContent = `Welcome to the TextareaRenderable Demo!

This is an interactive text editor powered by EditBuffer and EditorView.

\tThis is a tab
\t\t\tMultiple tabs

Emojis:
👩🏽‍💻  👨‍👩‍👧‍👦  🏳️‍🌈  🇺🇸  🇩🇪  🇯🇵  🇮🇳

NAVIGATION:
  • Arrow keys to move cursor
  • Ctrl+A/Ctrl+E for line start/end
  • Home/End for buffer start/end
  • Ctrl+F/Ctrl+B to move right/left (Emacs-style)
  • Alt+F/Alt+B for word forward/backward
  • Alt+Left/Alt+Right for word forward/backward
  • Ctrl+Left/Ctrl+Right for word forward/backward
  • Alt+A/Alt+E for visual line start/end

SELECTION:
  • Shift+Arrow keys to select
  • Ctrl+Shift+A/E to select to line start/end
  • Shift+Home/End to select to buffer start/end
  • Alt+Shift+F/B to select word forward/backward
  • Alt+Shift+Left/Right to select word forward/backward
  • Alt+Shift+A/E to select to visual line start/end

CLIPBOARD:
  • Ctrl+Y to copy selected text
  • Ctrl+V to paste from the system clipboard
  • Terminal paste shortcuts also insert text
  • Linux: selecting text updates the primary selection
  • Linux: middle-click to paste the primary selection

EDITING:
  • Type any text to insert
  • Backspace/Delete to remove text
  • Enter to create new lines
  • Ctrl+Shift+D to delete current line
  • Ctrl+D to delete character forward
  • Ctrl+K to delete to line end
  • Ctrl+U to delete to line start
  • Alt+D to delete word forward
  • Alt+Backspace or Ctrl+W to delete word backward
  • Ctrl+Delete or Alt+Delete to delete word forward

UNDO/REDO:
  • Ctrl+- to undo or Cmd+Z (Mac)
  • Ctrl+. to redo or Cmd+Shift+Z (Mac)

VIEW:
  • Shift+W to toggle wrap mode (word/char/none)
  • Shift+L to toggle line numbers
  • Shift+S to toggle selection occupancy (cell/boundary)
  • Shift+H to toggle diff highlights (colors + +/- signs)
  • Shift+D to toggle diagnostics (error/warning/info emojis)
  • Shift+C to toggle cursor style (block/line)
  • Ctrl+] to increase scroll speed
  • Ctrl+[ to decrease scroll speed

FEATURES:
  ✓ Grapheme-aware cursor movement
  ✓ Unicode (emoji 🌟 and CJK 世界, 你好世界, 中文, 한글)
  ✓ Incremental editing
  ✓ Text wrapping and viewport management
  ✓ Undo/redo support
  ✓ Word-based navigation and deletion
  ✓ Text selection with shift keys

Press ESC to return to main menu`

let renderer: CliRenderer | null = null
let parentContainer: BoxRenderable | null = null
let editor: TextareaRenderable | null = null
let editorWithLines: LineNumberRenderable | null = null
let statusText: TextRenderable | null = null
let clipboard: ClipboardService | null = null
let keyHandler: ((key: KeyEvent) => void) | null = null
let selectionHandler: ((selection: Selection) => void) | null = null
let rendererDestroyHandler: (() => void) | null = null
let destroyPromise: Promise<void> | null = null
let clipboardStatus = "Clipboard ready"
let highlightsEnabled: boolean = true
let diagnosticsEnabled: boolean = true

const IS_LINUX = process.platform === "linux"
const INHERITED_WAYLAND_ONLY =
  IS_LINUX && Boolean(process.env.WAYLAND_SOCKET) && !process.env.WAYLAND_DISPLAY && !process.env.DISPLAY
let inheritedWaylandServiceCreated = false
const MAX_QUEUED_CLIPBOARD_OPERATIONS = 16
type ClipboardOperationQueue = { tail: Promise<void>; pending: number }
const clipboardOperationQueues: Record<ClipboardSelection, ClipboardOperationQueue> = {
  clipboard: { tail: Promise.resolve(), pending: 0 },
  primary: { tail: Promise.resolve(), pending: 0 },
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ")
}

function matchesControlKey(key: KeyEvent, name: string): boolean {
  const baseCode = name.charCodeAt(0)
  const matchesName = key.name === name || key.baseCode === baseCode || key.baseCode === baseCode - 32
  return matchesName && key.ctrl && !key.shift && !key.meta && !key.super && !key.hyper
}

function queueClipboardOperation(selection: ClipboardSelection, operation: () => Promise<void>): void {
  const queue = clipboardOperationQueues[selection]
  if (queue.pending >= MAX_QUEUED_CLIPBOARD_OPERATIONS) {
    clipboardStatus = "Clipboard busy"
    return
  }

  queue.pending += 1
  const queued = queue.tail.then(operation)
  queue.tail = queued.catch((error) => {
    clipboardStatus = `Clipboard failed: ${errorMessage(error)}`
  })
  void queue.tail.then(() => {
    queue.pending -= 1
  })
}

async function writeClipboardText(text: string, selection: ClipboardSelection, successStatus: string): Promise<void> {
  const service = clipboard
  if (!service) {
    clipboardStatus = "Clipboard unavailable"
    return
  }

  clipboardStatus = selection === "primary" ? "Updating primary selection..." : "Copying selection..."
  try {
    const result = await service.writeText(text, {
      destination: selection === "primary" ? "host-only" : "best-available",
      selection,
      allowRemoteHost: selection === "primary",
    })
    if (service !== clipboard) return

    if (result.host.status === "written") {
      clipboardStatus = successStatus
    } else if (result.terminal.status === "attempted") {
      clipboardStatus = `${successStatus} (terminal request sent)`
    } else if (result.host.status === "failed") {
      clipboardStatus = `Copy failed: ${errorMessage(result.host.error)}`
    } else {
      clipboardStatus = `Copy failed: host ${result.host.status}, terminal ${result.terminal.status}`
    }
  } catch (error) {
    if (service === clipboard) clipboardStatus = `Copy failed: ${errorMessage(error)}`
  }
}

function queueClipboardWrite(text: string, selection: ClipboardSelection, successStatus: string): void {
  queueClipboardOperation(selection, () => writeClipboardText(text, selection, successStatus))
}

function pasteClipboardText(selection: ClipboardSelection): void {
  queueClipboardOperation(selection, async () => {
    const service = clipboard
    const target = editor
    if (!service || !target || target.isDestroyed) {
      clipboardStatus = "Clipboard unavailable"
      return
    }

    const source = selection === "primary" ? "primary selection" : "clipboard"
    clipboardStatus = `Reading ${source}...`
    try {
      const result = await service.read({ preferredTypes: ["text/plain"], selection })
      if (service !== clipboard || target !== editor || target.isDestroyed) return

      if (result.status !== "read") {
        const detail = result.status === "failed" ? `: ${errorMessage(result.error)}` : ""
        clipboardStatus = `Paste failed: ${result.status}${detail}`
        return
      }

      if (result.representation.bytes.length === 0) {
        clipboardStatus = `${source} is empty`
        return
      }

      target.handlePaste(new PasteEvent(result.representation.bytes, { mimeType: "text/plain", kind: "text" }))
      clipboardStatus = `Pasted from ${source}`
    } catch (error) {
      if (service === clipboard) clipboardStatus = `Paste failed: ${errorMessage(error)}`
    }
  })
}

function setupEditor(rendererInstance: CliRenderer): void {
  renderer = rendererInstance
  rendererDestroyHandler = () => {
    void destroy(rendererInstance).catch((error) => console.error("Failed to clean up editor:", error))
  }
  rendererInstance.once(CliRenderEvents.DESTROY, rendererDestroyHandler)
  renderer.setBackgroundColor("#0D1117")

  parentContainer = new BoxRenderable(renderer, {
    id: "parent-container",
    zIndex: 10,
    padding: 1,
  })
  renderer.root.add(parentContainer)

  const editorBox = new BoxRenderable(renderer, {
    id: "editor-box",
    borderStyle: "single",
    borderColor: "#6BCF7F",
    backgroundColor: "#0D1117",
    title: "Interactive Editor (TextareaRenderable)",
    titleAlignment: "left",
    border: true,
  })
  parentContainer.add(editorBox)

  // Create interactive editor
  editor = new TextareaRenderable(renderer, {
    id: "editor",
    initialValue: initialContent,
    textColor: "#F0F6FC",
    selectionBg: "#264F78",
    selectionFg: "#FFFFFF",
    wrapMode: "word",
    showCursor: true,
    cursorColor: "#4ECDC4",
    placeholder: t`${fg("#333333")("Enter")} ${cyan(bold("text"))} ${fg("#333333")("here...")}`,
    tabIndicator: "→",
    tabIndicatorColor: "#30363D",
  })

  editorWithLines = new LineNumberRenderable(renderer, {
    id: "editor-lines",
    target: editor,
    minWidth: 3,
    paddingRight: 1,
    fg: "#6b7280", // Dimmed gray for line numbers
    bg: "#161b22", // Slightly darker than editor background for distinction
    width: "100%",
    height: "100%",
    onMouseDown: (event) => {
      if (!IS_LINUX || event.button !== MouseButton.MIDDLE) return

      event.preventDefault()
      event.stopPropagation()
      editor?.focus()
      pasteClipboardText("primary")
    },
  })

  editorBox.add(editorWithLines)

  statusText = new TextRenderable(renderer, {
    id: "status",
    content: "",
    fg: "#A5D6FF",
    height: 1,
  })
  parentContainer.add(statusText)

  editor.focus()
  if (rendererInstance.isDestroyed) throw new Error("Renderer was destroyed during editor setup")

  rendererInstance.setFrameCallback(async () => {
    if (statusText && editor && !editor.isDestroyed) {
      try {
        const cursor = editor.logicalCursor
        const wrap = editor.wrapMode !== "none" ? "ON" : "OFF"
        const highlights = highlightsEnabled ? "ON" : "OFF"
        const diagnostics = diagnosticsEnabled ? "ON" : "OFF"
        const selectionOccupancy = editor.selectionOccupancy.toUpperCase()
        const cursorStyle = (editor.cursorStyle.style ?? "block").toUpperCase()
        const scrollSpeed = editor.scrollSpeed
        statusText.content = `Line ${cursor.row + 1}, Col ${cursor.col + 1} | ${clipboardStatus} | Wrap: ${wrap} | Selection: ${selectionOccupancy} | Diff: ${highlights} | Diag: ${diagnostics} | Cursor: ${cursorStyle} | Scroll: ${scrollSpeed} lines/s`
      } catch (error) {
        // Ignore errors during shutdown
      }
    }
  })

  keyHandler = (key: KeyEvent) => {
    if (editor?.focused && matchesControlKey(key, "v")) {
      key.preventDefault()
      key.stopPropagation()
      pasteClipboardText("clipboard")
      return
    }
    if (editor?.focused && matchesControlKey(key, "y")) {
      key.preventDefault()
      key.stopPropagation()
      const selectedText = rendererInstance.getSelection()?.getSelectedText() || editor.getSelectedText()
      if (selectedText) {
        queueClipboardWrite(selectedText, "clipboard", "Selection copied")
      } else {
        clipboardStatus = "Nothing selected"
      }
      return
    }

    if (key.shift && key.name === "l") {
      key.preventDefault()
      if (editorWithLines && !editorWithLines.isDestroyed) {
        editorWithLines.showLineNumbers = !editorWithLines.showLineNumbers
      }
    }
    if (key.shift && key.name === "w") {
      key.preventDefault()
      if (editor && !editor.isDestroyed) {
        const currentMode = editor.wrapMode
        const nextMode = currentMode === "word" ? "char" : currentMode === "char" ? "none" : "word"
        editor.wrapMode = nextMode
      }
    }
    if (key.shift && key.name === "s") {
      key.preventDefault()
      if (editor && !editor.isDestroyed) {
        editor.selectionOccupancy = editor.selectionOccupancy === "cell" ? "boundary" : "cell"
      }
    }
    if (key.shift && key.name === "c") {
      key.preventDefault()
      if (editor && !editor.isDestroyed) {
        const thin = editor.cursorStyle.style === "line"
        editor.cursorStyle = thin ? { style: "block", blinking: true } : { style: "line", blinking: false }
      }
    }
    if (key.shift && key.name === "h") {
      key.preventDefault()
      if (editorWithLines && !editorWithLines.isDestroyed) {
        highlightsEnabled = !highlightsEnabled
        if (highlightsEnabled) {
          // Add modern diff-style line colors and +/- signs throughout the document
          editorWithLines.setLineColor(2, "#1a4d1a") // Line 3: Added (fresh green)
          editorWithLines.setLineSign(2, { after: " +", afterColor: "#22c55e" })

          editorWithLines.setLineColor(5, "#4d1a1a") // Line 6: Removed (vibrant red)
          editorWithLines.setLineSign(5, { after: " -", afterColor: "#ef4444" })

          editorWithLines.setLineColor(8, "#1a4d1a") // Line 9: Added (fresh green)
          editorWithLines.setLineSign(8, { after: " +", afterColor: "#22c55e" })

          editorWithLines.setLineColor(11, "#4d1a1a") // Line 12: Removed (vibrant red)
          editorWithLines.setLineSign(11, { after: " -", afterColor: "#ef4444" })

          editorWithLines.setLineColor(14, "#1a4d1a") // Line 15: Added (fresh green)
          editorWithLines.setLineSign(14, { after: " +", afterColor: "#22c55e" })

          editorWithLines.setLineColor(17, "#4d1a1a") // Line 18: Removed (vibrant red)
          editorWithLines.setLineSign(17, { after: " -", afterColor: "#ef4444" })

          editorWithLines.setLineColor(20, "#1a4d1a") // Line 21: Added (fresh green)
          editorWithLines.setLineSign(20, { after: " +", afterColor: "#22c55e" })

          editorWithLines.setLineColor(23, "#4d1a1a") // Line 24: Removed (vibrant red)
          editorWithLines.setLineSign(23, { after: " -", afterColor: "#ef4444" })

          editorWithLines.setLineColor(27, "#1a4d1a") // Line 28: Added (fresh green)
          editorWithLines.setLineSign(27, { after: " +", afterColor: "#22c55e" })

          editorWithLines.setLineColor(30, "#4d1a1a") // Line 31: Removed (vibrant red)
          editorWithLines.setLineSign(30, { after: " -", afterColor: "#ef4444" })

          editorWithLines.setLineColor(34, "#1a4d1a") // Line 35: Added (fresh green)
          editorWithLines.setLineSign(34, { after: " +", afterColor: "#22c55e" })

          editorWithLines.setLineColor(38, "#4d1a1a") // Line 39: Removed (vibrant red)
          editorWithLines.setLineSign(38, { after: " -", afterColor: "#ef4444" })

          editorWithLines.setLineColor(42, "#1a4d1a") // Line 43: Added (fresh green)
          editorWithLines.setLineSign(42, { after: " +", afterColor: "#22c55e" })

          editorWithLines.setLineColor(46, "#4d1a1a") // Line 47: Removed (vibrant red)
          editorWithLines.setLineSign(46, { after: " -", afterColor: "#ef4444" })

          editorWithLines.setLineColor(50, "#1a4d1a") // Line 51: Added (fresh green)
          editorWithLines.setLineSign(50, { after: " +", afterColor: "#22c55e" })

          editorWithLines.setLineColor(54, "#4d1a1a") // Line 55: Removed (vibrant red)
          editorWithLines.setLineSign(54, { after: " -", afterColor: "#ef4444" })

          editorWithLines.setLineColor(58, "#1a4d1a") // Line 59: Added (fresh green)
          editorWithLines.setLineSign(58, { after: " +", afterColor: "#22c55e" })
        } else {
          editorWithLines.clearAllLineColors()
          // Clear only the after signs (keep diagnostics if enabled)
          const currentSigns = editorWithLines.getLineSigns()
          for (const [line, sign] of currentSigns) {
            if (sign.after) {
              if (sign.before) {
                // Keep the before sign, remove only after
                editorWithLines.setLineSign(line, { before: sign.before, beforeColor: sign.beforeColor })
              } else {
                // No before sign, remove entirely
                editorWithLines.clearLineSign(line)
              }
            }
          }
        }
      }
    }
    if (key.shift && key.name === "d") {
      key.preventDefault()
      if (editorWithLines && !editorWithLines.isDestroyed) {
        diagnosticsEnabled = !diagnosticsEnabled
        if (diagnosticsEnabled) {
          // Add diagnostic signs (errors, warnings, info) on some lines
          editorWithLines.setLineSign(0, { before: "❌", beforeColor: "#ef4444" }) // Line 1: Error
          editorWithLines.setLineSign(4, { before: "⚠️", beforeColor: "#f59e0b" }) // Line 5: Warning
          editorWithLines.setLineSign(10, { before: "💡", beforeColor: "#3b82f6" }) // Line 11: Info
          editorWithLines.setLineSign(25, { before: "❌", beforeColor: "#ef4444" }) // Line 26: Error
          editorWithLines.setLineSign(40, { before: "⚠️", beforeColor: "#f59e0b" }) // Line 41: Warning
          editorWithLines.setLineSign(52, { before: "💡", beforeColor: "#3b82f6" }) // Line 53: Info
        } else {
          // Clear only the before signs (keep diff signs if enabled)
          const currentSigns = editorWithLines.getLineSigns()
          for (const [line, sign] of currentSigns) {
            if (sign.before) {
              if (sign.after) {
                // Keep the after sign, remove only before
                editorWithLines.setLineSign(line, { after: sign.after, afterColor: sign.afterColor })
              } else {
                // No after sign, remove entirely
                editorWithLines.clearLineSign(line)
              }
            }
          }
        }
      }
    }
    if (key.ctrl && (key.name === "pageup" || key.name === "pagedown")) {
      key.preventDefault()
      if (editor && !editor.isDestroyed) {
        if (key.name === "pageup") {
          editor.editBuffer.setCursor(0, 0)
        } else {
          editor.gotoBufferEnd()
        }
      }
    }
    if (key.ctrl && key.name === "]") {
      key.preventDefault()
      if (editor && !editor.isDestroyed) {
        editor.scrollSpeed = Math.min(100, editor.scrollSpeed + 4)
      }
    }
    if (key.ctrl && key.name === "[") {
      key.preventDefault()
      if (editor && !editor.isDestroyed) {
        editor.scrollSpeed = Math.max(4, editor.scrollSpeed - 4)
      }
    }
  }
  rendererInstance.keyInput.on("keypress", keyHandler)

  if (IS_LINUX) {
    selectionHandler = (selection) => {
      const selectedText = selection.getSelectedText()
      if (selectedText) queueClipboardWrite(selectedText, "primary", "Primary selection updated")
    }
    rendererInstance.on(CliRenderEvents.SELECTION, selectionHandler)
  }
}

export async function run(rendererInstance: CliRenderer): Promise<void> {
  if (destroyPromise) await destroyPromise
  if (renderer) throw new Error("Editor demo is already running")
  if (rendererInstance.isDestroyed) throw new Error("Cannot run editor demo with a destroyed renderer")

  destroyPromise = null
  clipboardStatus = "Clipboard ready"
  let host: HostClipboardService | null = null

  if (INHERITED_WAYLAND_ONLY && inheritedWaylandServiceCreated) {
    clipboardStatus = "Host clipboard unavailable: inherited Wayland socket already used"
    setupEditor(rendererInstance)
    return
  }

  try {
    host = createHostClipboard()
    clipboard = createClipboard({
      host,
      terminal: createRendererClipboardAdapter(rendererInstance),
    })
    host = null
    if (INHERITED_WAYLAND_ONLY) inheritedWaylandServiceCreated = true
    setupEditor(rendererInstance)
  } catch (error) {
    try {
      if (clipboard) await destroy(rendererInstance)
      else if (host) await host.dispose()
    } catch (cleanupError) {
      console.error("Failed to clean up editor clipboard:", cleanupError)
    }
    throw error
  }
}

export function destroy(rendererInstance: CliRenderer): Promise<void> {
  destroyPromise ??= Promise.resolve().then(async () => {
    const service = clipboard
    const activeClipboardOperations = Object.values(clipboardOperationQueues).map((queue) => queue.tail)
    const activeKeyHandler = keyHandler
    const activeSelectionHandler = selectionHandler
    const activeRendererDestroyHandler = rendererDestroyHandler
    const container = parentContainer
    clipboard = null
    keyHandler = null
    selectionHandler = null
    rendererDestroyHandler = null
    parentContainer = null
    editorWithLines = null
    editor = null
    statusText = null
    renderer = null

    try {
      if (activeKeyHandler) rendererInstance.keyInput.off("keypress", activeKeyHandler)
      if (activeSelectionHandler) rendererInstance.off(CliRenderEvents.SELECTION, activeSelectionHandler)
      if (activeRendererDestroyHandler) rendererInstance.off(CliRenderEvents.DESTROY, activeRendererDestroyHandler)

      rendererInstance.clearFrameCallbacks()
      rendererInstance.clearSelection()
      container?.destroyRecursively()
    } finally {
      try {
        await service?.dispose()
      } finally {
        await Promise.all(activeClipboardOperations)
      }
    }
  })
  return destroyPromise
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 60,
  })
  try {
    await run(renderer)
  } catch (error) {
    renderer.destroy()
    throw error
  }
  setupCommonDemoKeys(renderer)
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (matchesControlKey(key, "c") || matchesControlKey(key, "q")) {
      key.preventDefault()
      key.stopPropagation()
      void destroy(renderer)
        .catch((error) => console.error("Failed to clean up editor:", error))
        .finally(() => renderer.destroy())
    }
  })
}
