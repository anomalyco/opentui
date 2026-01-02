import { createCliRenderer, TerminalRenderable, BoxRenderable, type CliRenderer, type KeyEvent } from "../index"
import { TextRenderable } from "../renderables/Text"
import { setupCommonDemoKeys } from "./lib/standalone-keys"

interface Button {
  label: string
  data: string
}

const BUTTONS: Button[] = [
  { label: "[1] Send 'hello'", data: "hello" },
  { label: "[2] Send Enter", data: "\r" },
  { label: "[3] Send 'help'", data: "help" },
  { label: "[4] Send Escape", data: "\x1b" },
  { label: "[5] Send Ctrl+C", data: "\x03" },
  { label: "[6] Send '/clear'", data: "/clear" },
]

const LEFT_PANEL_WIDTH = 33
const RIGHT_PANEL_BORDER = 2
const VERTICAL_OVERHEAD = 3

let renderer: CliRenderer | null = null
let pty: any = null
let terminalDisplay: TerminalRenderable | null = null
let statusDisplay: TextRenderable | null = null
let selectedButton = 0
let status = "Starting..."
let terminalCols = 80
let terminalRows = 24

async function initPty(cols: number, rows: number): Promise<any> {
  try {
    const { spawn } = await import("bun-pty")
    return spawn("opencode", [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
    })
  } catch (e) {
    console.error("Failed to import bun-pty. Make sure it's installed: bun add bun-pty")
    throw e
  }
}

function sendData(data: string): void {
  if (pty) {
    pty.write(data)
    if (data === "\r") {
      status = "Sent: Enter"
    } else if (data === "\x1b") {
      status = "Sent: Escape"
    } else if (data === "\x03") {
      status = "Sent: Ctrl+C"
    } else {
      status = `Sent: "${data}"`
    }
    updateStatus()
  }
}

function updateStatus(): void {
  if (statusDisplay) {
    statusDisplay.content = `Status: ${status} | Size: ${terminalCols}x${terminalRows}`
  }
}

function handleKey(key: KeyEvent): void {
  if (key.name === "q" || key.name === "escape") {
    if (pty) {
      pty.kill()
    }
    process.exit(0)
  }

  if (key.name === "1") sendData(BUTTONS[0].data)
  if (key.name === "2") sendData(BUTTONS[1].data)
  if (key.name === "3") sendData(BUTTONS[2].data)
  if (key.name === "4") sendData(BUTTONS[3].data)
  if (key.name === "5") sendData(BUTTONS[4].data)
  if (key.name === "6") sendData(BUTTONS[5].data)

  if (key.name === "up") {
    selectedButton = selectedButton > 0 ? selectedButton - 1 : BUTTONS.length - 1
    renderer?.requestRender()
  }
  if (key.name === "down") {
    selectedButton = selectedButton < BUTTONS.length - 1 ? selectedButton + 1 : 0
    renderer?.requestRender()
  }
  if (key.name === "return") {
    sendData(BUTTONS[selectedButton].data)
  }
}

export async function run(rendererInstance: CliRenderer): Promise<void> {
  renderer = rendererInstance
  renderer.setBackgroundColor("#0d1117")

  const width = renderer.width
  const height = renderer.height
  terminalCols = Math.max(40, width - LEFT_PANEL_WIDTH - RIGHT_PANEL_BORDER)
  terminalRows = Math.max(10, height - VERTICAL_OVERHEAD)

  const mainContainer = new BoxRenderable(renderer, {
    id: "main-container",
    flexDirection: "row",
    flexGrow: 1,
  })
  renderer.root.add(mainContainer)

  const leftPanel = new BoxRenderable(renderer, {
    id: "left-panel",
    width: 30,
    flexDirection: "column",
    padding: 1,
  })
  mainContainer.add(leftPanel)

  const commandsTitle = new TextRenderable(renderer, {
    id: "commands-title",
    content: "Commands",
    fg: "#58a6ff",
    marginBottom: 1,
  })
  leftPanel.add(commandsTitle)

  for (let i = 0; i < BUTTONS.length; i++) {
    const btn = BUTTONS[i]
    const isSelected = i === selectedButton
    const buttonText = new TextRenderable(renderer, {
      id: `button-${i}`,
      content: btn.label,
      fg: isSelected ? "#000" : "#d4d4d4",
      bg: isSelected ? "#58a6ff" : undefined,
    })
    leftPanel.add(buttonText)
  }

  const helpText = new TextRenderable(renderer, {
    id: "help-text",
    content: "Use arrow keys + Enter\nor number keys 1-6\n\nPress 'q' to quit",
    fg: "#8b949e",
    marginTop: 2,
  })
  leftPanel.add(helpText)

  statusDisplay = new TextRenderable(renderer, {
    id: "status-text",
    content: `Status: ${status}`,
    fg: "#8b949e",
    marginTop: 2,
  })
  leftPanel.add(statusDisplay)

  const rightPanel = new BoxRenderable(renderer, {
    id: "right-panel",
    flexGrow: 1,
    flexDirection: "column",
    marginLeft: 1,
  })
  mainContainer.add(rightPanel)

  const terminalTitle = new TextRenderable(renderer, {
    id: "terminal-title",
    content: "Terminal Output",
    fg: "#58a6ff",
    height: 1,
    paddingLeft: 1,
    bg: "#333",
  })
  rightPanel.add(terminalTitle)

  try {
    pty = await initPty(terminalCols, terminalRows)

    // Create streams from PTY
    const readable = new ReadableStream<string>({
      start(controller) {
        pty.onData((data: string) => controller.enqueue(data))
        pty.onExit(() => controller.close())
      },
    })

    const writable = new WritableStream<string>({
      write(chunk) {
        pty.write(chunk)
      },
    })

    terminalDisplay = new TerminalRenderable(renderer, {
      id: "terminal-display",
      cols: terminalCols,
      rows: terminalRows,
      trimEnd: true,
      flexGrow: 1,
      readable,
      writable,
    })
    rightPanel.add(terminalDisplay)

    pty.onExit(({ exitCode }: { exitCode: number }) => {
      status = `Process exited with code ${exitCode}`
      updateStatus()
    })

    status = "Running opencode"
    updateStatus()
  } catch (e) {
    status = "Failed to start PTY"
    updateStatus()
  }

  renderer.on("resize", (newWidth: number, newHeight: number) => {
    terminalCols = Math.max(40, newWidth - LEFT_PANEL_WIDTH - RIGHT_PANEL_BORDER)
    terminalRows = Math.max(10, newHeight - VERTICAL_OVERHEAD)
    pty?.resize(terminalCols, terminalRows)
    if (terminalDisplay) {
      terminalDisplay.cols = terminalCols
      terminalDisplay.rows = terminalRows
    }
    updateStatus()
  })

  rendererInstance.keyInput.on("keypress", handleKey)
}

export function destroy(rendererInstance: CliRenderer): void {
  rendererInstance.keyInput.off("keypress", handleKey)

  if (pty) {
    pty.kill()
    pty = null
  }

  if (terminalDisplay) {
    terminalDisplay.destroy()
    terminalDisplay = null
  }

  if (statusDisplay) {
    statusDisplay.destroy()
    statusDisplay = null
  }

  rendererInstance.root.remove("main-container")
  renderer = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
  })

  await run(renderer)
  setupCommonDemoKeys(renderer)
  renderer.start()
}
