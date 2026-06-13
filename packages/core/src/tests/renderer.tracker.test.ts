import { test, expect, beforeEach, afterEach } from "bun:test"
import { createCliRenderer } from "../renderer.js"
import { createTestStdin, createTestStdout } from "../testing/test-streams.js"

let originalStdinPaused: boolean
let pauseCalled = false
let originalPause: typeof process.stdin.pause
let destroyFns: Array<() => void> = []

beforeEach(() => {
  pauseCalled = false
  originalStdinPaused = process.stdin.isPaused()
  originalPause = process.stdin.pause.bind(process.stdin)
  process.stdin.pause = () => {
    pauseCalled = true
    return originalPause()
  }
})

afterEach(() => {
  for (const destroy of destroyFns.splice(0)) {
    destroy()
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
  destroyFns.push(() => first.destroy())

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
  destroyFns.push(() => first.destroy())

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

  const second = await createCliRenderer({
    stdin,
    stdout,
    bufferedOutput: "memory",
  })
  destroyFns.push(() => second.destroy())

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
  destroyFns.push(() => renderer.destroy())

  expect(renderer.stdin).toBe(stdin)
})

test("renderers using separate stream objects can coexist", async () => {
  const first = await createCliRenderer({
    stdin: createTestStdin(),
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })
  destroyFns.push(() => first.destroy())

  const second = await createCliRenderer({
    stdin: createTestStdin(),
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })
  destroyFns.push(() => second.destroy())

  expect(second.isDestroyed).toBe(false)
})

test("renderer using process.stdin pauses it on destroy", async () => {
  const renderer = await createCliRenderer({
    stdin: process.stdin,
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })

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

  pauseCalled = false
  renderer.destroy()

  expect(pauseCalled).toBe(false)
})

test("destroying process stdin owner pauses it while a custom renderer remains", async () => {
  const processRenderer = await createCliRenderer({
    stdin: process.stdin,
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })
  destroyFns.push(() => processRenderer.destroy())
  const customRenderer = await createCliRenderer({
    stdin: createTestStdin(),
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })
  destroyFns.push(() => customRenderer.destroy())

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
  destroyFns.push(() => processRenderer.destroy())
  const customRenderer = await createCliRenderer({
    stdin: createTestStdin(),
    stdout: createTestStdout(),
    bufferedOutput: "memory",
  })
  destroyFns.push(() => customRenderer.destroy())

  processRenderer.destroy()
  pauseCalled = false
  customRenderer.destroy()

  expect(pauseCalled).toBe(false)
})
