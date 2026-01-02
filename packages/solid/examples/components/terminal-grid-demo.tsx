import { type KeyEvent } from "@opentui/core"
import { spawn, type IPty } from "bun-pty"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createSignal, onCleanup, onMount, For, createEffect } from "solid-js"

interface TerminalStream {
  readable: ReadableStream<string>
  writable: WritableStream<string>
  pty: IPty
}

const GRID_COLS = 2
const GRID_ROWS = 2
const TOTAL_TERMINALS = GRID_COLS * GRID_ROWS

async function spawnPty(cols: number, rows: number) {
  try {
    return spawn("opencode", [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: { ...process.env, TERM: "xterm-256color" },
    })
  } catch (e) {
    console.error("Failed to spawn PTY:", e)
    return null
  }
}

export default function TerminalGridDemo() {
  const renderer = useRenderer()
  const dims = useTerminalDimensions()

  const [focusedIndex, setFocusedIndex] = createSignal(0)
  const [status, setStatus] = createSignal("Initializing...")
  const [streams, setStreams] = createSignal<(TerminalStream | null)[]>([])

  const terminalCols = () => Math.floor((dims().width - 4) / GRID_COLS) - 2
  const terminalRows = () => Math.floor((dims().height - 5) / GRID_ROWS) - 2

  onMount(async () => {
    renderer.useMouse = true

    const newStreams: (TerminalStream | null)[] = []

    for (let i = 0; i < TOTAL_TERMINALS; i++) {
      const pty = await spawnPty(terminalCols(), terminalRows())

      if (pty) {
        const readable = new ReadableStream<string>({
          start(controller) {
            pty.onData((data) => controller.enqueue(data))

            pty.onExit(() => controller.close())
          },
        })

        const writable = new WritableStream<string>({
          write(chunk) {
            pty.write(chunk)
          },
        })

        newStreams.push({ readable, writable, pty })
      } else {
        newStreams.push(null)
      }
    }

    setStreams(newStreams)
    setStatus(`${TOTAL_TERMINALS} terminals ready - Tab to switch focus, Ctrl+Q to quit`)
  })

  onCleanup(() => {
    for (const stream of streams()) {
      stream?.pty.kill()
    }
  })

  createEffect(() => {
    const cols = terminalCols()
    const rows = terminalRows()
    for (const stream of streams()) {
      stream?.pty.resize(cols, rows)
    }
  })

  useKeyboard((key: KeyEvent) => {
    if (key.name === "tab") {
      if (key.shift) {
        setFocusedIndex((prev) => (prev - 1 + TOTAL_TERMINALS) % TOTAL_TERMINALS)
      } else {
        setFocusedIndex((prev) => (prev + 1) % TOTAL_TERMINALS)
      }
      return
    }

    if (key.ctrl && key.name === "q") {
      for (const stream of streams()) {
        stream?.pty.kill()
      }
      renderer.stop()
      process.exit(0)
    }

    const stream = streams()[focusedIndex()]
    if (stream && key.raw) {
      stream.pty.write(key.raw)
    }
  })

  const handleClick = (index: number) => () => setFocusedIndex(index)

  return (
    <box flexDirection="column" flexGrow={1} backgroundColor="#0d1117">
      <box height={1} paddingLeft={1}>
        <text
          content={`Terminal Grid Demo | Focus: ${focusedIndex() + 1}/${TOTAL_TERMINALS} | Tab: switch | Ctrl+Q: quit`}
          fg="#58a6ff"
        />
      </box>

      <box height={1} paddingLeft={1}>
        <text content={status()} fg="#8b949e" />
      </box>

      <box flexDirection="column" flexGrow={1} padding={1}>
        <For each={Array.from({ length: GRID_ROWS }, (_, i) => i)}>
          {(row) => (
            <box flexDirection="row" flexGrow={1}>
              <For each={Array.from({ length: GRID_COLS }, (_, i) => i)}>
                {(col) => {
                  const index = row * GRID_COLS + col
                  const stream = () => streams()[index]
                  const isFocused = () => focusedIndex() === index

                  return (
                    <box
                      flexGrow={1}
                      flexDirection="column"
                      border
                      borderStyle="single"
                      borderColor={isFocused() ? "#58a6ff" : "#30363d"}
                      title={`Terminal ${index + 1}`}
                      titleAlignment="center"
                      marginRight={col < GRID_COLS - 1 ? 1 : 0}
                      marginBottom={row < GRID_ROWS - 1 ? 1 : 0}
                      onMouseDown={handleClick(index)}
                    >
                      {stream() && (
                        <terminal
                          readable={stream()!.readable}
                          writable={stream()!.writable}
                          cols={terminalCols()}
                          rows={terminalRows()}
                          trimEnd
                          flexGrow={1}
                        />
                      )}
                    </box>
                  )
                }}
              </For>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}
