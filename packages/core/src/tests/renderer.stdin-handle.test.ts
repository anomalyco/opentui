import { test, expect, afterEach } from "bun:test"
import { Readable } from "stream"
import { createCliRenderer } from "../renderer.js"
import { createTestStdout } from "../testing/test-streams.js"

// A raw-mode-capable stand-in for process.stdin. `createCliRenderer` duck-types
// `isTTY` and `setRawMode`, so this is enough to drive the real teardown path.
function makeMockStdin(): NodeJS.ReadStream {
  const s = new Readable({ read() {} }) as unknown as NodeJS.ReadStream & { isTTY: boolean }
  s.isTTY = true
  ;(s as unknown as { setRawMode: (v: boolean) => unknown }).setRawMode = () => s
  return s
}

const origStdin = Object.getOwnPropertyDescriptor(process, "stdin")!
const origPlatform = Object.getOwnPropertyDescriptor(process, "platform")!

function setStdin(s: NodeJS.ReadStream): void {
  Object.defineProperty(process, "stdin", { value: s, configurable: true })
}
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true })
}

afterEach(() => {
  Object.defineProperty(process, "stdin", origStdin)
  Object.defineProperty(process, "platform", origPlatform)
})

// The core fix: on legacy Windows conhost, an open stdin handle polled after
// destroy() wedges the console host. destroy() must CLOSE the handle we own.
test("closes the owned process.stdin handle on destroy (win32)", async () => {
  setPlatform("win32")
  const mock = makeMockStdin()
  setStdin(mock)
  const renderer = await createCliRenderer({ stdout: createTestStdout() })
  renderer.destroy()
  expect((mock as unknown as { destroyed: boolean }).destroyed).toBe(true)
})

// A caller-supplied stdin belongs to the host; never close it.
test("does not close a caller-supplied config.stdin", async () => {
  setPlatform("win32")
  setStdin(makeMockStdin())
  const supplied = makeMockStdin()
  const renderer = await createCliRenderer({ stdin: supplied, stdout: createTestStdout() })
  renderer.destroy()
  expect((supplied as unknown as { destroyed: boolean }).destroyed).toBe(false)
})

// The wedge is legacy-conhost-only; do not change stdin lifecycle elsewhere.
test("does not close stdin on non-win32", async () => {
  setPlatform("linux")
  const mock = makeMockStdin()
  setStdin(mock)
  const renderer = await createCliRenderer({ stdout: createTestStdout() })
  renderer.destroy()
  expect((mock as unknown as { destroyed: boolean }).destroyed).toBe(false)
})

// If the host was already consuming stdin, it is not ours to close.
test("does not close stdin a host was already listening to", async () => {
  setPlatform("win32")
  const mock = makeMockStdin()
  mock.on("data", () => {})
  setStdin(mock)
  const renderer = await createCliRenderer({ stdout: createTestStdout() })
  renderer.destroy()
  expect((mock as unknown as { destroyed: boolean }).destroyed).toBe(false)
})
