import { ResourceContext } from "../buffer.js"
import { expect, test, beforeEach, afterEach } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { EditBuffer } from "../edit-buffer.js"
import { InputRenderable, InputRenderableEvents } from "../renderables/Input.js"
import { createTestRenderer } from "../testing/test-renderer.js"

let resourceContext: ResourceContext
beforeEach(() => {
  resourceContext = new ResourceContext({ objectCapacity: 4, renderCellsMax: 1 })
})
afterEach(() => resourceContext.destroy())

test("same-turn edits preserve each native event and application microtask order", async () => {
  const buffer = EditBuffer.create("unicode", resourceContext)
  const trace: string[] = []
  buffer.on("cursor-changed", () => trace.push("cursor"))
  buffer.on("content-changed", () => trace.push("content"))
  try {
    buffer.setText("a")
    queueMicrotask(() => trace.push("application"))
    buffer.insertText("b")
    expect(trace).toEqual([])
    expect(buffer.getText()).toBe("ba")
    await Promise.resolve()
    expect(trace).toEqual(["cursor", "content", "application", "cursor", "content"])
  } finally {
    buffer.destroy()
  }
})

test.each(["setText", "replaceText"] as const)(
  "%s preserves notifications for repeated and empty replacements",
  async (method) => {
    const buffer = EditBuffer.create("unicode", resourceContext)
    const trace: string[] = []
    buffer.on("cursor-changed", () => trace.push(`cursor:${buffer.getText()}`))
    buffer.on("content-changed", () => trace.push(`content:${buffer.getText()}`))
    try {
      buffer[method]("text")
      queueMicrotask(() => trace.push("application"))
      buffer[method]("text")
      buffer[method]("")
      buffer[method]("")
      expect(buffer.getText()).toBe("")
      expect(trace).toEqual([])
      await Promise.resolve()
      expect(trace).toEqual([
        "cursor:",
        "content:",
        "application",
        "cursor:",
        "content:",
        "cursor:",
        "content:",
        "cursor:",
        "content:",
      ])
    } finally {
      buffer.destroy()
    }
  },
)

test("last-line deletion preserves cursor/content/cursor multiplicity", async () => {
  const buffer = EditBuffer.create("unicode", resourceContext)
  try {
    buffer.setText("first\nlast")
    buffer.setCursor(1, 4)
    await Promise.resolve()
    const trace: string[] = []
    buffer.on("cursor-changed", () => trace.push("cursor"))
    buffer.on("content-changed", () => trace.push("content"))
    buffer.deleteLine()
    expect(trace).toEqual([])
    expect(buffer.getText()).toBe("first")
    await Promise.resolve()
    expect(trace).toEqual(["cursor", "content", "cursor"])
  } finally {
    buffer.destroy()
  }
})

test("Input.value emits INPUT synchronously before deferred native events", async () => {
  const { renderer } = await createTestRenderer({ width: 20, height: 3 })
  try {
    const input = new InputRenderable(renderer, { width: 20 })
    renderer.root.add(input)
    await Promise.resolve()
    const trace: string[] = []
    input.on(InputRenderableEvents.INPUT, (value: string) => trace.push(`input:${value}`))
    input.editBuffer.on("cursor-changed", () => trace.push("cursor"))
    input.editBuffer.on("content-changed", () => trace.push("content"))
    input.value = "first"
    queueMicrotask(() => trace.push("application"))
    input.value = "second"
    expect(trace).toEqual(["input:first", "input:second"])
    await Promise.resolve()
    expect(trace).toEqual([
      "input:first",
      "input:second",
      "cursor",
      "content",
      "cursor",
      "application",
      "cursor",
      "content",
      "cursor",
    ])
  } finally {
    renderer.destroy()
  }
})

for (const [scenario, description] of [
  ["listeners", "preserves once/off, listener receivers and in-flight listener changes"],
  ["metadata", "preserves original listener metadata for on/once and removal"],
  ["rejections", "preserves EventEmitter captureRejections for native listeners"],
  ["contexts", "isolates equal local edit slots in two same-realm Contexts"],
  ["queued", "drops queued native events after Context disposal"],
] as const) {
  test(description, () => {
    // Isolate the process-global native logger from the test runner's singleton.
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
    const runtimeArgs = "bun" in process.versions ? [] : process.execArgv.filter((arg) => !arg.startsWith("--test"))
    const child = spawnSync(
      process.execPath,
      [...runtimeArgs, fileURLToPath(new URL(`native-event-lifecycle-child.${extension}`, import.meta.url)), scenario],
      { encoding: "utf8", timeout: 30_000 },
    )
    expect({ status: child.status, signal: child.signal, stderr: child.stderr, error: child.error?.message }).toEqual({
      status: 0,
      signal: null,
      stderr: "",
      error: undefined,
    })
    expect(child.stdout.trim()).toBe("Native event lifecycle passed")
  })
}
