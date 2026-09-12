#!/usr/bin/env bun

import {
  BoxRenderable,
  type CliRenderer,
  createCliRenderer,
  EmbeddedTerminalRenderable,
  TextRenderable,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let container: BoxRenderable | null = null
let terminal: EmbeddedTerminalRenderable | null = null
let shellProcess: ReturnType<typeof Bun.spawn> | null = null

export function run(renderer: CliRenderer): void {
  if (typeof Bun === "undefined" || typeof Bun.Terminal !== "function") {
    throw new Error("The embedded shell demo requires Bun with Bun.Terminal support")
  }

  renderer.start()

  container = new BoxRenderable(renderer, {
    id: "embedded-terminal-demo",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: "#111827",
  })

  const heading = new TextRenderable(renderer, {
    content: " Embedded shell | run commands normally | Escape: menu ",
    height: 1,
    fg: "#111827",
    bg: "#67E8F9",
  })

  terminal = new EmbeddedTerminalRenderable(renderer, {
    id: "embedded-terminal",
    width: "100%",
    flexGrow: 1,
    maxScrollback: 10_000,
    onData(data) {
      shellProcess?.terminal?.write(data)
    },
    onTerminalResize(cols, rows) {
      shellProcess?.terminal?.resize(cols, rows)
    },
  })

  container.add(heading)
  container.add(terminal)
  renderer.root.add(container)

  const shell = process.env.SHELL || "/bin/sh"
  shellProcess = Bun.spawn([shell], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
    terminal: {
      cols: Math.max(1, terminal.width),
      rows: Math.max(1, terminal.height),
      data(_pty, data) {
        terminal?.write(data)
      },
    },
  })

  terminal.focus()
}

export function destroy(renderer: CliRenderer): void {
  terminal?.blur()
  shellProcess?.kill()
  shellProcess?.terminal?.close()
  shellProcess = null
  if (container) renderer.root.remove(container)
  container?.destroy()
  container = null
  terminal = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  run(renderer)
  setupCommonDemoKeys(renderer)
}
