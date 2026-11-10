import { test, expect, beforeEach, afterEach, spyOn } from "bun:test"
import { NativeSession } from "../NativeSession.js"
import { CliRenderer, createCliRenderer, type CliRendererConfig } from "../renderer.js"
import { processListenerCounts } from "../testing/harness.js"
import { RecordingWriteStream, createTestStdin, createTestStdout } from "../testing/test-streams.js"

let originalStdinPaused: boolean
let pauseCalled = false
let originalPause: typeof process.stdin.pause
let renderers: CliRenderer[] = []

beforeEach(() => {
  pauseCalled = false
  originalStdinPaused = process.stdin.isPaused()
  originalPause = process.stdin.pause.bind(process.stdin)
  process.stdin.pause = () => {
    pauseCalled = true
    return originalPause()
  }
})

afterEach(async () => {
  for (const renderer of renderers.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }

  process.stdin.pause = originalPause
  if (!originalStdinPaused) {
    process.stdin.resume()
  }
})

test("second renderer sharing process.stdin is rejected", async () => {
  const first = await createCliRenderer({
    stdin: process.stdin,
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })
  renderers.push(first)

  await expect(
    createCliRenderer({
      stdin: process.stdin,
      stdout: createTestStdout(),
      bufferedOutput: "memory",
    }),
  ).rejects.toThrow("stdin is already used by another CliRenderer")
})

test("second renderer sharing stdout is rejected", async () => {
  const stdout = createTestStdout()
  const first = await createCliRenderer({
    stdin: createTestStdin(),
    stdout,
    bufferedOutput: "memory",
  })
  renderers.push(first)

  await expect(
    createCliRenderer({
      stdin: createTestStdin(),
      stdout,
      bufferedOutput: "memory",
    }),
  ).rejects.toThrow("stdout is already used by another CliRenderer")
})

test("destroy releases streams for reuse", async () => {
  const stdin = createTestStdin()
  const stdout = createTestStdout()
  const first = await createCliRenderer({
    stdin,
    stdout,
    bufferedOutput: "memory",
  })

  first.destroy()
  await first.closed

  const second = await createCliRenderer({
    stdin,
    stdout,
    bufferedOutput: "memory",
  })
  renderers.push(second)

  expect(second.stdin).toBe(stdin)
})

test("failed input setup releases streams for reuse", async () => {
  const stdin = createTestStdin()
  const stdout = createTestStdout()
  let failRawMode = true

  stdin.setRawMode = (enabled) => {
    if (enabled && failRawMode) {
      throw new Error("raw mode failed")
    }
    return stdin
  }

  await expect(
    createCliRenderer({
      stdin,
      stdout,
      bufferedOutput: "memory",
    }),
  ).rejects.toThrow("raw mode failed")

  failRawMode = false

  const renderer = await createCliRenderer({
    stdin,
    stdout,
    bufferedOutput: "memory",
  })
  renderers.push(renderer)

  expect(renderer.stdin).toBe(stdin)
})

test("renderers using separate stream objects can coexist", async () => {
  const first = await createCliRenderer({
    stdin: createTestStdin(),
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })
  renderers.push(first)

  const second = await createCliRenderer({
    stdin: createTestStdin(),
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })
  renderers.push(second)

  expect(second.isDestroyed).toBe(false)
})

test("renderer using process.stdin pauses it on destroy", async () => {
  const renderer = await createCliRenderer({
    stdin: process.stdin,
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })
  renderers.push(renderer)

  pauseCalled = false
  renderer.destroy()

  expect(pauseCalled).toBe(true)
})

test("renderer with custom stdin does not pause process.stdin on destroy", async () => {
  const renderer = await createCliRenderer({
    stdin: createTestStdin(),
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })
  renderers.push(renderer)

  pauseCalled = false
  renderer.destroy()

  expect(pauseCalled).toBe(false)
})

test("destroy discards terminal input queued during teardown", async () => {
  const stdin = createTestStdin()
  stdin.once("pause", () => {
    stdin.push("\x1b[<35;125;28M")
  })
  const renderer = await createCliRenderer({
    stdin,
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })
  renderers.push(renderer)

  renderer.destroy()

  expect(stdin.read()).toBeNull()
})

test("destroy preserves input queued after suspension", async () => {
  const stdin = createTestStdin()
  const renderer = await createCliRenderer({
    stdin,
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })
  renderers.push(renderer)
  await renderer.suspend()
  stdin.push("input after suspend")

  renderer.destroy()

  expect(stdin.read()).toEqual(Buffer.from("input after suspend"))
})

test("destroying process stdin owner pauses it while a custom renderer remains", async () => {
  const processRenderer = await createCliRenderer({
    stdin: process.stdin,
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })
  renderers.push(processRenderer)
  const customRenderer = await createCliRenderer({
    stdin: createTestStdin(),
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })
  renderers.push(customRenderer)

  pauseCalled = false
  processRenderer.destroy()

  expect(pauseCalled).toBe(true)
})

test("destroying final custom renderer does not pause process stdin again", async () => {
  const processRenderer = await createCliRenderer({
    stdin: process.stdin,
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })
  renderers.push(processRenderer)
  const customRenderer = await createCliRenderer({
    stdin: createTestStdin(),
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })
  renderers.push(customRenderer)

  processRenderer.destroy()
  pauseCalled = false
  customRenderer.destroy()

  expect(pauseCalled).toBe(false)
})

// The terminal can queue mouse reports until restoration disables them. They must not reach the next program, and
// neither may input that arrives after the first suspend settles be dropped.
const inputFlushCases = [
  { stdin: "process", action: "closing", flushes: 1 },
  { stdin: "process", action: "suspending", flushes: 1 },
  { stdin: "process", action: "suspending twice", flushes: 1 },
  { stdin: "process", action: "destroying during suspend", flushes: 1 },
  { stdin: "custom", action: "closing", flushes: 0 },
  { stdin: "custom", action: "suspending", flushes: 0 },
] as const

for (const { stdin, action, flushes } of inputFlushCases) {
  test(`${action} a renderer on ${stdin} stdin flushes terminal input ${flushes} times`, async () => {
    const stdout = new RecordingWriteStream()
    const renderer = await createCliRenderer({
      stdin: stdin === "process" ? process.stdin : createTestStdin(),
      stdout: stdout as unknown as NodeJS.WriteStream,
    })
    // Each flush records whether the mouse reset had reached the terminal.
    const flushed: boolean[] = []
    const lib = renderer.nativeScene.driver.renderLib
    const flush = spyOn(lib, "terminalFlushInput").mockImplementation(() => {
      flushed.push(stdout.text().includes("\x1b[?1000l"))
    })
    try {
      const suspending = action !== "closing" && renderer.suspend()
      expect(flushed).toEqual([])
      if (action === "destroying during suspend") void (suspending as Promise<void>).catch(() => {})
      else await suspending
      if (action === "suspending twice") await renderer.suspend()
      renderer.destroy()
      expect(flushed.length).toBe(action.startsWith("suspending") ? flushes : 0)
      await renderer.closed
      expect(flushed).toEqual(Array(flushes).fill(true))
    } finally {
      flush.mockRestore()
    }
  })
}

// Invalid configuration fails before the renderer takes streams, listeners, or a supplied Session.
const invalidConfigs: Array<[name: string, config: CliRendererConfig, error: string]> = [
  ["the removed work budget", { nativeSceneWorkBudget: 1 } as never, "nativeSceneWorkBudget was removed"],
  ["an unknown Kitty transport", { kittyImageTransport: "ftp" as never }, "Invalid kittyImageTransport"],
  ["a non-finite footer", { screenMode: "split-footer", footerHeight: NaN }, "footerHeight must be a finite number"],
  ["an empty footer", { screenMode: "split-footer", footerHeight: 0 }, "footerHeight must be greater than 0"],
  ["captured stdout outside split footer", { externalOutputMode: "capture-stdout" }, "requires screenMode"],
  ["a Session with memory output", { session: "own", bufferedOutput: "memory" } as never, "memory buffered output"],
  ["a Session on another stdout", { session: "other" } as never, "must use the renderer stdout"],
]

for (const [name, config, error] of invalidConfigs) {
  test(`construction with ${name} fails without taking resources`, async () => {
    const listeners = processListenerCounts()
    const stdin = createTestStdin()
    const stdout = createTestStdout()
    const { session, ...rest } = config as CliRendererConfig & { session?: "own" | "other" }
    const nativeSession = session && new NativeSession(session === "own" ? stdout : createTestStdout())
    try {
      const output = session ? {} : { bufferedOutput: "memory" as const }
      expect(() => new CliRenderer(stdin, stdout, 80, 24, { ...output, ...rest, nativeSession })).toThrow(error)
      expect(processListenerCounts()).toEqual(listeners)
      expect(nativeSession?.disposed ?? false).toBe(false)
      const renderer = await createCliRenderer({ stdin, stdout, bufferedOutput: "memory" })
      renderers.push(renderer)
    } finally {
      nativeSession?.dispose()
    }
  })
}
