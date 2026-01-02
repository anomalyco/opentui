import { test, expect, beforeEach, afterEach } from "bun:test"
import { TerminalRenderable, StatelessTerminalRenderable } from "./Terminal"
import { createTestRenderer, type TestRenderer } from "../testing"

let currentRenderer: TestRenderer
let renderOnce: () => Promise<void>
let captureFrame: () => string

beforeEach(async () => {
  const testRenderer = await createTestRenderer({ width: 80, height: 24 })
  currentRenderer = testRenderer.renderer
  renderOnce = testRenderer.renderOnce
  captureFrame = testRenderer.captureCharFrame
})

afterEach(async () => {
  if (currentRenderer) {
    currentRenderer.destroy()
  }
})

test("TerminalRenderable - basic construction", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal",
    cols: 80,
    rows: 24,
  })

  expect(terminal.cols).toBe(80)
  expect(terminal.rows).toBe(24)

  terminal.destroy()
})

test("TerminalRenderable - feed simple text", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal",
    cols: 80,
    rows: 24,
  })

  terminal.feed("Hello, World!")

  currentRenderer.root.add(terminal)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toContain("Hello, World!")

  terminal.destroy()
})

test("TerminalRenderable - feed ANSI colored text", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal",
    cols: 80,
    rows: 24,
  })

  // Feed red "Hello" and green "World"
  terminal.feed("\x1b[31mHello\x1b[0m \x1b[32mWorld\x1b[0m")

  currentRenderer.root.add(terminal)
  await renderOnce()

  const text = terminal.getText()
  expect(text).toContain("Hello")
  expect(text).toContain("World")

  terminal.destroy()
})

test("TerminalRenderable - getCursor returns position", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal",
    cols: 80,
    rows: 24,
  })

  terminal.feed("ABC")
  const cursor = terminal.getCursor()

  expect(cursor[0]).toBe(3) // x position after "ABC"
  expect(cursor[1]).toBe(0) // y position (first row)

  terminal.destroy()
})

test("TerminalRenderable - reset clears content", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal",
    cols: 80,
    rows: 24,
  })

  terminal.feed("Some text that should be cleared")
  terminal.reset()

  const cursor = terminal.getCursor()
  expect(cursor[0]).toBe(0)
  expect(cursor[1]).toBe(0)

  terminal.destroy()
})

test("StatelessTerminalRenderable - basic construction", async () => {
  const terminal = new StatelessTerminalRenderable(currentRenderer, {
    id: "test-stateless-terminal",
    ansi: "Hello, World!",
    cols: 80,
    rows: 24,
  })

  expect(terminal.cols).toBe(80)
  expect(terminal.rows).toBe(24)

  currentRenderer.root.add(terminal)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toContain("Hello, World!")
})

test("StatelessTerminalRenderable - ANSI colored text", async () => {
  const terminal = new StatelessTerminalRenderable(currentRenderer, {
    id: "test-stateless-terminal",
    ansi: "\x1b[31mRed\x1b[0m \x1b[32mGreen\x1b[0m",
    cols: 80,
    rows: 24,
  })

  currentRenderer.root.add(terminal)
  await renderOnce()

  const frame = captureFrame()
  expect(frame).toContain("Red")
  expect(frame).toContain("Green")
})

test("TerminalRenderable - multiple feeds", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal",
    cols: 80,
    rows: 24,
  })

  terminal.feed("Line 1\n")
  terminal.feed("Line 2\n")
  terminal.feed("Line 3")

  currentRenderer.root.add(terminal)
  await renderOnce()

  const text = terminal.getText()
  expect(text).toContain("Line 1")
  expect(text).toContain("Line 2")
  expect(text).toContain("Line 3")

  terminal.destroy()
})

test("TerminalRenderable - isReady returns correct state", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal",
    cols: 80,
    rows: 24,
  })

  terminal.feed("Hello")
  expect(terminal.isReady()).toBe(true)

  terminal.destroy()
})

// Large input tests to reproduce potential segfaults

function generateLargeAnsi(lineCount: number, lineLength: number = 80): string {
  const colors = [31, 32, 33, 34, 35, 36, 37]
  let result = ""
  for (let i = 0; i < lineCount; i++) {
    const color = colors[i % colors.length]
    const text = `Line ${i}: ${"x".repeat(lineLength - 10)}`
    result += `\x1b[${color}m${text}\x1b[0m\n`
  }
  return result
}

function generateComplexAnsi(size: number): string {
  let result = ""
  const styles = [
    "\x1b[1m", // bold
    "\x1b[2m", // dim
    "\x1b[3m", // italic
    "\x1b[4m", // underline
    "\x1b[7m", // inverse
    "\x1b[9m", // strikethrough
    "\x1b[31m", // red
    "\x1b[32m", // green
    "\x1b[33m", // yellow
    "\x1b[34m", // blue
    "\x1b[38;5;208m", // 256 color
    "\x1b[38;2;255;105;180m", // RGB color
  ]

  let currentSize = 0
  let lineNum = 0
  while (currentSize < size) {
    const style = styles[lineNum % styles.length]
    const line = `${style}Line ${lineNum}: Some text content here\x1b[0m\n`
    result += line
    currentSize += line.length
    lineNum++
  }
  return result
}

test("TerminalRenderable - large input 1000 lines", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal-large",
    cols: 120,
    rows: 50,
  })

  const largeAnsi = generateLargeAnsi(1000)
  terminal.feed(largeAnsi)

  currentRenderer.root.add(terminal)
  await renderOnce()

  const text = terminal.getText()
  expect(text).toContain("Line 0")
  expect(text).toContain("Line 999")

  terminal.destroy()
})

test("TerminalRenderable - large input 10000 lines", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal-large",
    cols: 120,
    rows: 50,
  })

  const largeAnsi = generateLargeAnsi(10000)
  terminal.feed(largeAnsi)

  currentRenderer.root.add(terminal)
  await renderOnce()

  const text = terminal.getText()
  expect(text).toContain("Line 0")
  expect(text).toContain("Line 9999")

  terminal.destroy()
})

test("TerminalRenderable - very large input 100KB", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal-100kb",
    cols: 120,
    rows: 50,
  })

  const largeAnsi = generateComplexAnsi(100 * 1024)
  terminal.feed(largeAnsi)

  currentRenderer.root.add(terminal)
  await renderOnce()

  const text = terminal.getText()
  expect(text.length).toBeGreaterThan(0)

  terminal.destroy()
})

test("TerminalRenderable - very large input 200KB", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal-200kb",
    cols: 120,
    rows: 50,
  })

  const largeAnsi = generateComplexAnsi(200 * 1024)
  terminal.feed(largeAnsi)

  currentRenderer.root.add(terminal)
  await renderOnce()

  const text = terminal.getText()
  expect(text.length).toBeGreaterThan(0)

  terminal.destroy()
})

test("StatelessTerminalRenderable - large input 1000 lines", async () => {
  const largeAnsi = generateLargeAnsi(1000)

  const terminal = new StatelessTerminalRenderable(currentRenderer, {
    id: "test-stateless-large",
    ansi: largeAnsi,
    cols: 120,
    rows: 50,
  })

  currentRenderer.root.add(terminal)
  await renderOnce()

  const frame = captureFrame()
  expect(frame.length).toBeGreaterThan(0)
})

test("StatelessTerminalRenderable - large input 200KB", async () => {
  const largeAnsi = generateComplexAnsi(200 * 1024)

  const terminal = new StatelessTerminalRenderable(currentRenderer, {
    id: "test-stateless-200kb",
    ansi: largeAnsi,
    cols: 120,
    rows: 50,
  })

  currentRenderer.root.add(terminal)
  await renderOnce()

  const frame = captureFrame()
  expect(frame.length).toBeGreaterThan(0)
})

test("TerminalRenderable - create and destroy many terminals", async () => {
  for (let i = 0; i < 20; i++) {
    const terminal = new TerminalRenderable(currentRenderer, {
      id: `test-terminal-${i}`,
      cols: 80,
      rows: 24,
    })

    terminal.feed(`Terminal ${i}: \x1b[32mSome colored text\x1b[0m\n`)

    currentRenderer.root.add(terminal)
    await renderOnce()

    terminal.destroy()
    currentRenderer.root.remove(`test-terminal-${i}`)
  }

  expect(true).toBe(true)
})

test("TerminalRenderable - concurrent terminals", async () => {
  const terminals: TerminalRenderable[] = []

  // Create multiple terminals
  for (let i = 0; i < 5; i++) {
    const terminal = new TerminalRenderable(currentRenderer, {
      id: `test-concurrent-${i}`,
      cols: 80,
      rows: 24,
    })
    terminals.push(terminal)
    currentRenderer.root.add(terminal)
  }

  // Feed data to all of them
  for (let j = 0; j < 10; j++) {
    for (let i = 0; i < terminals.length; i++) {
      terminals[i].feed(`\x1b[${31 + i}mTerminal ${i}, line ${j}\x1b[0m\n`)
    }
    await renderOnce()
  }

  // Destroy all
  for (const terminal of terminals) {
    terminal.destroy()
  }

  expect(true).toBe(true)
})

test("TerminalRenderable - resize during feed", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal-resize",
    cols: 80,
    rows: 24,
  })

  currentRenderer.root.add(terminal)

  for (let i = 0; i < 10; i++) {
    terminal.feed(`Line ${i}: Some content\n`)
    terminal.cols = 80 + i * 10
    terminal.rows = 24 + i * 2
    await renderOnce()
  }

  expect(terminal.cols).toBe(170)
  expect(terminal.rows).toBe(42)

  terminal.destroy()
})

test("TerminalRenderable - reset and refeed", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal-reset",
    cols: 80,
    rows: 24,
  })

  currentRenderer.root.add(terminal)

  for (let i = 0; i < 5; i++) {
    terminal.feed(generateLargeAnsi(100))
    await renderOnce()
    terminal.reset()
    await renderOnce()
  }

  const cursor = terminal.getCursor()
  expect(cursor[0]).toBe(0)
  expect(cursor[1]).toBe(0)

  terminal.destroy()
})

test("TerminalRenderable - special escape sequences", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal-special",
    cols: 80,
    rows: 24,
  })

  // Various special sequences
  const sequences = [
    "\x1b[2J", // Clear screen
    "\x1b[H", // Home
    "\x1b[K", // Clear to end of line
    "\x1b[1K", // Clear to beginning of line
    "\x1b[2K", // Clear entire line
    "\x1b[J", // Clear to end of screen
    "\x1b[1J", // Clear to beginning of screen
    "\x1b[s", // Save cursor
    "\x1b[u", // Restore cursor
    "\x1b[?25l", // Hide cursor
    "\x1b[?25h", // Show cursor
    "\x1b[0m", // Reset attributes
    "\x1b[1;1H", // Move to 1,1
    "\x1b[10;20H", // Move to 10,20
  ]

  for (const seq of sequences) {
    terminal.feed(seq + "Some text after sequence\n")
  }

  currentRenderer.root.add(terminal)
  await renderOnce()

  expect(true).toBe(true)

  terminal.destroy()
})

test("TerminalRenderable - binary/control characters", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal-binary",
    cols: 80,
    rows: 24,
  })

  // Feed some binary/control characters
  let binaryData = ""
  for (let i = 0; i < 32; i++) {
    if (i !== 27) {
      // Skip ESC
      binaryData += String.fromCharCode(i)
    }
  }
  binaryData += "Normal text after binary\n"

  terminal.feed(binaryData)

  currentRenderer.root.add(terminal)
  await renderOnce()

  expect(true).toBe(true)

  terminal.destroy()
})

// Tests to reproduce async/microtask segfaults

test("TerminalRenderable - rapid async getText calls", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal-async",
    cols: 80,
    rows: 24,
  })

  terminal.feed(generateLargeAnsi(500))
  currentRenderer.root.add(terminal)

  // Make many rapid getText calls with microtask breaks
  const results: string[] = []
  for (let i = 0; i < 50; i++) {
    const text = terminal.getText()
    results.push(text)
    await Promise.resolve() // Force microtask break
  }

  expect(results.length).toBe(50)
  expect(results.every((r) => r.length > 0)).toBe(true)

  terminal.destroy()
})

test("TerminalRenderable - rapid async getCursor calls", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal-cursor-async",
    cols: 80,
    rows: 24,
  })

  terminal.feed(generateLargeAnsi(500))
  currentRenderer.root.add(terminal)

  // Make many rapid getCursor calls with microtask breaks
  const results: [number, number][] = []
  for (let i = 0; i < 50; i++) {
    const cursor = terminal.getCursor()
    results.push(cursor)
    await Promise.resolve() // Force microtask break
  }

  expect(results.length).toBe(50)

  terminal.destroy()
})

test("StatelessTerminalRenderable - rapid ansi updates with microtasks", async () => {
  const terminal = new StatelessTerminalRenderable(currentRenderer, {
    id: "test-stateless-async",
    ansi: "Initial",
    cols: 80,
    rows: 24,
  })

  currentRenderer.root.add(terminal)

  // Rapidly update ansi with microtask breaks
  for (let i = 0; i < 100; i++) {
    terminal.ansi = generateLargeAnsi(50)
    await renderOnce()
    await Promise.resolve() // Force microtask break
  }

  expect(true).toBe(true)
})

test("TerminalRenderable - interleaved feed/getText/render", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal-interleaved",
    cols: 80,
    rows: 24,
  })

  currentRenderer.root.add(terminal)

  for (let i = 0; i < 100; i++) {
    terminal.feed(`\x1b[${31 + (i % 7)}mLine ${i}\x1b[0m\n`)
    const text = terminal.getText()
    await renderOnce()
    const cursor = terminal.getCursor()
    await Promise.resolve()
  }

  terminal.destroy()
})

test("TerminalRenderable - parallel getText and feed", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal-parallel",
    cols: 80,
    rows: 24,
  })

  terminal.feed(generateLargeAnsi(100))
  currentRenderer.root.add(terminal)

  // Create multiple promises that read text
  const promises: Promise<string>[] = []
  for (let i = 0; i < 20; i++) {
    promises.push(
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(terminal.getText())
        }, i * 10)
      }),
    )
  }

  // Also feed more data while reading
  for (let i = 0; i < 10; i++) {
    terminal.feed(`\x1b[32mMore data ${i}\x1b[0m\n`)
    await Promise.resolve()
  }

  const results = await Promise.all(promises)
  expect(results.every((r) => typeof r === "string")).toBe(true)

  terminal.destroy()
})

test("TerminalRenderable - stress test create/destroy/getText cycle", async () => {
  for (let i = 0; i < 50; i++) {
    const terminal = new TerminalRenderable(currentRenderer, {
      id: `test-terminal-stress-${i}`,
      cols: 80,
      rows: 24,
    })

    terminal.feed(generateLargeAnsi(100))
    currentRenderer.root.add(terminal)
    await renderOnce()

    // Get text multiple times
    terminal.getText()
    terminal.getText()
    terminal.getText()

    await Promise.resolve()

    terminal.destroy()
    currentRenderer.root.remove(`test-terminal-stress-${i}`)

    await Promise.resolve()
  }

  expect(true).toBe(true)
})

test("StatelessTerminalRenderable - stress test rapid creation", async () => {
  const terminals: StatelessTerminalRenderable[] = []

  for (let i = 0; i < 30; i++) {
    const terminal = new StatelessTerminalRenderable(currentRenderer, {
      id: `test-stateless-stress-${i}`,
      ansi: generateLargeAnsi(100),
      cols: 80,
      rows: 24,
    })
    terminals.push(terminal)
    currentRenderer.root.add(terminal)
  }

  await renderOnce()

  // Access all terminals
  for (const terminal of terminals) {
    await Promise.resolve()
  }

  // Destroy all
  for (let i = 0; i < terminals.length; i++) {
    currentRenderer.root.remove(`test-stateless-stress-${i}`)
  }

  await Promise.resolve()
  expect(true).toBe(true)
})

test("TerminalRenderable - multiple large feeds", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal-multi-feed",
    cols: 120,
    rows: 50,
  })

  // Feed in chunks
  for (let i = 0; i < 10; i++) {
    const chunk = generateLargeAnsi(100)
    terminal.feed(chunk)
  }

  currentRenderer.root.add(terminal)
  await renderOnce()

  const text = terminal.getText()
  expect(text.length).toBeGreaterThan(0)

  terminal.destroy()
})

test("TerminalRenderable - rapid feed and render cycles", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal-rapid",
    cols: 120,
    rows: 50,
  })

  currentRenderer.root.add(terminal)

  // Rapid feed and render
  for (let i = 0; i < 50; i++) {
    terminal.feed(`\x1b[${31 + (i % 7)}mLine ${i}: Some content here\x1b[0m\n`)
    await renderOnce()
  }

  const text = terminal.getText()
  expect(text).toContain("Line 49")

  terminal.destroy()
})

test("TerminalRenderable - feed with cursor movement sequences", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal-cursor",
    cols: 80,
    rows: 24,
  })

  // Various cursor movement and control sequences
  const ansi =
    `\x1b[2J\x1b[H` + // Clear screen and home
    `\x1b[5;10HPosition 5,10` + // Move to row 5, col 10
    `\x1b[10;20HPosition 10,20` + // Move to row 10, col 20
    `\x1b[A\x1b[A\x1b[A` + // Move up 3 times
    `After moving up` +
    `\x1b[B\x1b[B` + // Move down 2 times
    `After moving down` +
    `\x1b[C\x1b[C\x1b[C` + // Move right 3 times
    `After moving right` +
    `\x1b[D\x1b[D` + // Move left 2 times
    `After moving left`

  terminal.feed(ansi)

  currentRenderer.root.add(terminal)
  await renderOnce()

  const text = terminal.getText()
  expect(text).toContain("Position")

  terminal.destroy()
})

test("TerminalRenderable - large input with scrollback", async () => {
  const terminal = new TerminalRenderable(currentRenderer, {
    id: "test-terminal-scrollback",
    cols: 80,
    rows: 24,
  })

  // Generate more lines than rows to test scrollback
  const ansi = generateLargeAnsi(1000, 70)
  terminal.feed(ansi)

  currentRenderer.root.add(terminal)
  await renderOnce()

  // Check that content exists
  const text = terminal.getText()
  expect(text.length).toBeGreaterThan(0)

  terminal.destroy()
})
