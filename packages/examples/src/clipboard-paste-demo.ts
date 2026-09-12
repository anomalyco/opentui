#!/usr/bin/env bun

import {
  BoxRenderable,
  type CliRenderer,
  type ClipboardSelection,
  type ClipboardService,
  type ClipboardWriteDestination,
  createCliRenderer,
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  decodePasteBytes,
  type KeyEvent,
  type PasteEvent,
  TextareaRenderable,
  TextRenderable,
} from "@opentui/core"

const COLORS = {
  background: "#071018",
  panel: "#101c28",
  text: "#e5edf5",
  muted: "#8ba0b5",
  accent: "#66d9ef",
  selection: "#28577a",
} as const

const READ_MAX_BYTES = 2 * 1024 * 1024
const UNICODE_PAYLOAD = "OpenTUI clipboard round-trip\nUnicode: \u4e16\u754c cafe \ud83d\ude80\nLine endings: LF\nEnd"
const LARGE_PAYLOAD = `OpenTUI large clipboard payload\n${"0123456789abcdef".repeat(1024)}`
const INHERITED_WAYLAND_ONLY =
  process.platform === "linux" &&
  Boolean(process.env.WAYLAND_SOCKET) &&
  !process.env.WAYLAND_DISPLAY &&
  !process.env.DISPLAY

type LifecycleIntent = "create" | "dispose" | "recreate"

let root: BoxRenderable | null = null
let editor: TextareaRenderable | null = null
let statusText: TextRenderable | null = null
let clipboard: ClipboardService | null = null
let selection: ClipboardSelection = "clipboard"
let payload = UNICODE_PAYLOAD
let operationStatus = "Ready"
let pasteStatus = "No PasteEvent received"
let operationVersion = 0
let lifecycleVersion = 0
let pasteGeneration = 0
let lifecycleQueue: Promise<void> = Promise.resolve()
let keyHandler: ((key: KeyEvent) => void) | null = null
let pasteHandler: ((event: PasteEvent) => void) | null = null
let destroyPromise: Promise<void> | null = null
let inheritedWaylandServiceCreated = false

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function byteCount(text: string): number {
  return new TextEncoder().encode(text).length
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function terminalResult(status: string, capability: string): string {
  return status === "attempted" ? `attempted, unconfirmed (${capability})` : `${status} (${capability})`
}

function updateStatus(): void {
  if (!statusText) return
  const payloadName = payload === UNICODE_PAYLOAD ? "exact Unicode" : "exact 16,416-byte large fixture"
  statusText.content = [
    `Service: ${clipboard ? "active" : "disposed"} | Selection: ${selection}`,
    `Payload: ${payloadName}, ${byteCount(payload)} bytes`,
    `Operation: ${operationStatus}`,
    `PasteEvent: ${pasteStatus}`,
  ].join("\n")
}

function beginOperation(status: string): number {
  operationVersion += 1
  operationStatus = status
  updateStatus()
  return operationVersion
}

function finishOperation(version: number, status: string): void {
  if (version === operationVersion) operationStatus = status
  updateStatus()
}

function requestLifecycle(renderer: CliRenderer, intent: LifecycleIntent): Promise<void> {
  if (INHERITED_WAYLAND_ONLY && intent === "recreate" && clipboard) {
    beginOperation("Recreate skipped: this inherited Wayland socket supports one active host service")
    return lifecycleQueue
  }
  if (INHERITED_WAYLAND_ONLY && intent !== "dispose" && inheritedWaylandServiceCreated && !clipboard) {
    beginOperation("Host service unavailable: the inherited Wayland socket was already consumed")
    return lifecycleQueue
  }

  const lifecycle = ++lifecycleVersion
  const operation = beginOperation(
    intent === "create"
      ? "Creating clipboard service"
      : intent === "dispose"
        ? "Disposing clipboard service"
        : "Recreating clipboard service",
  )
  const service = intent === "create" ? null : clipboard
  if (intent !== "create") {
    clipboard = null
    updateStatus()
  }

  lifecycleQueue = lifecycleQueue.then(async () => {
    if (service) {
      try {
        await service.dispose()
      } catch (error) {
        if (lifecycle === lifecycleVersion) finishOperation(operation, `Dispose failed: ${errorMessage(error)}`)
        return
      }
    }
    if (lifecycle !== lifecycleVersion) return
    if (intent === "dispose") {
      finishOperation(operation, service ? "Service disposal awaited" : "Service is already disposed")
      return
    }
    if (intent === "create" && clipboard) {
      finishOperation(operation, "Service is already active")
      return
    }

    try {
      clipboard = createClipboard({
        host: createHostClipboard({ maxReadBytes: READ_MAX_BYTES }),
        terminal: createRendererClipboardAdapter(renderer),
      })
      if (INHERITED_WAYLAND_ONLY) inheritedWaylandServiceCreated = true
      finishOperation(operation, "Created host and terminal clipboard service")
    } catch (error) {
      finishOperation(operation, `Create failed: ${errorMessage(error)}`)
    }
  })
  return lifecycleQueue
}

async function write(destination: ClipboardWriteDestination): Promise<void> {
  const service = clipboard
  const chosenPayload = payload
  const chosenSelection = selection
  const operation = beginOperation(`Writing ${byteCount(chosenPayload)} bytes to ${chosenSelection} via ${destination}`)
  if (!service) {
    finishOperation(operation, "Write skipped: service disposed (F11 recreates)")
    return
  }

  try {
    const result = await service.writeText(chosenPayload, { destination, selection: chosenSelection })
    if (service !== clipboard) return
    finishOperation(
      operation,
      `Write ${chosenSelection}: host ${result.host.status}; terminal ${terminalResult(result.terminal.status, result.terminal.capability)}`,
    )
  } catch (error) {
    if (service === clipboard) finishOperation(operation, `Write failed: ${errorMessage(error)}`)
  }
}

async function readHost(chosenSelection: ClipboardSelection): Promise<void> {
  const service = clipboard
  const expectedPayload = payload
  const operation = beginOperation(`Reading host ${chosenSelection}; prefers image/png then text/plain`)
  if (!service) {
    finishOperation(operation, "Read skipped: service disposed (F11 recreates)")
    return
  }

  try {
    const result = await service.read({ preferredTypes: ["image/png", "text/plain"], selection: chosenSelection })
    if (service !== clipboard || operation !== operationVersion) return
    if (result.status !== "read") {
      const detail = result.status === "failed" ? `: ${result.error.message}` : ""
      finishOperation(operation, `Host read ${chosenSelection}: ${result.status}${detail}`)
      return
    }

    const { mimeType, bytes } = result.representation
    const digest = await sha256(bytes)
    if (service !== clipboard) return
    const exact = mimeType === "text/plain" && new TextDecoder().decode(bytes) === expectedPayload
    finishOperation(
      operation,
      `Host read ${chosenSelection}: ${mimeType}, ${bytes.length} bytes, exact fixture ${exact ? "yes" : "no"}; SHA-256 ${digest}. No PasteEvent synthesized.`,
    )
  } catch (error) {
    if (service === clipboard) finishOperation(operation, `Read failed: ${errorMessage(error)}`)
  }
}

async function clear(chosenSelection: ClipboardSelection, destination: ClipboardWriteDestination): Promise<void> {
  const service = clipboard
  const operation = beginOperation(`Clearing ${chosenSelection} via ${destination}`)
  if (!service) {
    finishOperation(operation, "Clear skipped: service disposed (F11 recreates)")
    return
  }

  try {
    const result = await service.clear({ destination, selection: chosenSelection })
    if (service !== clipboard) return
    finishOperation(
      operation,
      `Clear ${chosenSelection}: host ${result.host.status}; terminal ${terminalResult(result.terminal.status, result.terminal.capability)}`,
    )
  } catch (error) {
    if (service === clipboard) finishOperation(operation, `Clear failed: ${errorMessage(error)}`)
  }
}

function selectPayload(nextPayload: string, name: string): void {
  pasteGeneration += 1
  payload = nextPayload
  editor?.setText("")
  pasteStatus = "No PasteEvent received for selected fixture"
  beginOperation(`Selected ${name}; paste target reset`)
}

function handleKey(renderer: CliRenderer, key: KeyEvent): void {
  if (key.name === "f7") {
    key.preventDefault()
    void readHost(key.shift ? "primary" : "clipboard")
    return
  }

  switch (key.name) {
    case "f1":
      selectPayload(UNICODE_PAYLOAD, "exact Unicode payload")
      break
    case "f2":
      void write("host-only")
      break
    case "f3":
      selection = selection === "clipboard" ? "primary" : "clipboard"
      beginOperation(`Selected ${selection}`)
      break
    case "f4":
      selectPayload(LARGE_PAYLOAD, "exact 16,416-byte large fixture")
      break
    case "f5":
      void write("terminal-only")
      break
    case "f6":
      void write("all-available")
      break
    case "f8":
      void clear("clipboard", "all-available")
      break
    case "f9":
      void clear(selection, "terminal-only")
      break
    case "f10":
      void requestLifecycle(renderer, "dispose")
      break
    case "f11":
      void requestLifecycle(renderer, "recreate")
      break
    default:
      return
  }
  key.preventDefault()
  editor?.focus()
}

export function run(renderer: CliRenderer): void {
  destroyPromise = null
  pasteGeneration += 1
  selection = "clipboard"
  payload = UNICODE_PAYLOAD
  operationStatus = "Ready"
  pasteStatus = "No PasteEvent received"
  renderer.setBackgroundColor(COLORS.background)

  root = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    padding: 1,
    flexDirection: "column",
    gap: 1,
  })

  const instructions = new TextRenderable(renderer, {
    height: 5,
    fg: COLORS.muted,
    content: [
      "CLIPBOARD AND PASTE MANUAL ACCEPTANCE",
      "F1 Unicode | F2 host write | F3 clipboard/primary | F4 16,416-byte fixture | F5 terminal write | F6 all write",
      "F7 read clipboard | Shift+F7 read primary | F8 clear clipboard/all | F9 terminal clear (selected selection)",
      INHERITED_WAYLAND_ONLY
        ? "F10 dispose (irreversible) | F11 unavailable | Menu: Escape returns | Standalone: Ctrl+C/Ctrl+Q quits"
        : "F10 dispose | F11 recreate | Menu: Escape returns | Standalone: Ctrl+C/Ctrl+Q quits",
      "Terminal attempts are unconfirmed. Paste normally into the focused textarea below.",
    ].join("\n"),
  })

  editor = new TextareaRenderable(renderer, {
    width: "100%",
    flexGrow: 1,
    placeholder: "FOCUSED PASTE TARGET: ordinary terminal paste bytes/text appear here...",
    textColor: COLORS.text,
    backgroundColor: COLORS.panel,
    cursorColor: COLORS.accent,
    selectionBg: COLORS.selection,
    wrapMode: "word",
  })

  statusText = new TextRenderable(renderer, {
    height: 7,
    fg: COLORS.text,
  })

  root.add(instructions)
  root.add(editor)
  root.add(statusText)
  renderer.root.add(root)

  keyHandler = (key) => handleKey(renderer, key)
  pasteHandler = (event) => {
    const generation = ++pasteGeneration
    const expected = payload
    const rawMatch = decodePasteBytes(event.bytes) === expected
    pasteStatus = `${event.bytes.length} bytes | raw fixture match: ${rawMatch ? "yes" : "no"} | editor match: pending`
    updateStatus()
    queueMicrotask(() => {
      if (generation !== pasteGeneration) return
      const editorMatch = editor?.plainText === normalizeNewlines(expected)
      pasteStatus = `${event.bytes.length} bytes | raw fixture match: ${rawMatch ? "yes" : "no"} | editor normalized match: ${editorMatch ? "yes" : "no"}`
      updateStatus()
    })
  }

  renderer.keyInput.on("keypress", keyHandler)
  renderer.keyInput.on("paste", pasteHandler)
  void requestLifecycle(renderer, "create")
  editor.focus()
}

export function destroy(renderer: CliRenderer): Promise<void> {
  destroyPromise ??= (async () => {
    pasteGeneration += 1
    if (keyHandler) renderer.keyInput.off("keypress", keyHandler)
    if (pasteHandler) renderer.keyInput.off("paste", pasteHandler)
    keyHandler = null
    pasteHandler = null
    renderer.clearSelection()
    await requestLifecycle(renderer, "dispose")
    root?.destroyRecursively()
    root = null
    editor = null
    statusText = null
  })()
  return destroyPromise
}

if (import.meta.main) {
  const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 })
  run(renderer)
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if ((key.name === "c" && key.ctrl) || (key.name === "q" && key.ctrl)) {
      key.preventDefault()
      key.stopPropagation()
      void destroy(renderer).finally(() => renderer.destroy())
    }
  })
}
