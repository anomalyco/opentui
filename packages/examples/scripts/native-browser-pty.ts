import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { EmbeddedTerminalRenderable } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"

const entrypoint = process.argv[2] ?? "src/index.ts"
const command = entrypoint.endsWith(".ts") ? [process.execPath, entrypoint] : [entrypoint]
for (const name of ["Input Demo", "Split Footer Streaming Demo"]) {
  const capture = await createTestRenderer({ width: 160, height: 55, clock: new ManualClock() })
  const screen = new EmbeddedTerminalRenderable(capture.renderer, { width: 160, height: 55 })
  capture.renderer.root.add(screen)
  let output = ""
  const decoder = new TextDecoder()
  const child = Bun.spawn(command, {
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    terminal: {
      cols: 160,
      rows: 55,
      data(_terminal, bytes) {
        output += decoder.decode(bytes, { stream: true })
        screen.write(bytes)
      },
    },
  })
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000)
  async function waitFor(text: string, position?: { x: number; y: number }) {
    for (let attempt = 0; attempt < 500; attempt++) {
      assert.ok(output.length < 4_000_000, `${name}: output limit`)
      await capture.renderOnce()
      const found = position
        ? capture.renderer.currentRenderBuffer.withBuffers((cells) =>
            Array.from(text).every(
              (char, index) => cells.char[position.y * cells.width + position.x + index] === char.codePointAt(0),
            ),
          )
        : screen.screen().text.includes(text)
      if (found) return
      if (child.exitCode !== null) break
      await delay(20)
    }
    throw new Error(
      `${name}: missing ${JSON.stringify({ text, position, actualRow: screen.screen().lines.findIndex((line) => line.includes(text)) })}\n${screen.screen().text}`,
    )
  }
  try {
    await waitFor("Filter examples...")
    child.terminal!.write(name)
    await delay(100)
    child.terminal!.write("\r")
    const input = name === "Input Demo"
    if (input) {
      await waitFor("Enter your name")
      child.terminal!.write("Ada\r")
      await waitFor('Name SUBMITTED: "Ada" (Valid)')
      child.terminal!.write("\x06")
      await waitFor("Focus removed from Name input")
      child.terminal!.write(".")
    } else {
      await waitFor("Surface Streaming Demo")
      child.terminal!.write("]]]")
      await waitFor("markdown sample finished")
      // Fill the screen before checking the bottom-anchored footer.
      child.terminal!.write("r")
    }
    for (const [cols, rows] of [
      [160, 55],
      [120, 40],
    ] as const) {
      child.terminal!.resize(cols, rows)
      capture.resize(cols, rows)
      screen.width = cols
      screen.height = rows
      await waitFor(input ? "Debug Information" : "Split Footer Surface Streaming Demo", {
        x: input ? cols - 40 : 1,
        y: rows - (input ? 11 : 8),
      })
    }
    if (input) child.terminal!.write(".")
    child.terminal!.write("\x1b")
    await waitFor("Filter examples...")
    child.terminal!.write("\x03")
    assert.equal(await child.exited, 0)
    assert.ok(output.includes("?1049h") && output.includes("?1049l"))
    assert.doesNotMatch(output, /NativeError:|TypeError:|Native frame render failed|Failed to (run|destroy) example/)
    console.log(`${name}: PTY resize, menu return, and restoration passed`)
  } finally {
    clearTimeout(timeout)
    child.kill("SIGKILL")
    child.terminal?.close()
    await child.exited
    capture.renderer.destroy()
    await capture.renderer.closed
  }
}
