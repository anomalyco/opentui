import { getYogaNode } from "../lib/renderable-layout.js"
import { test, expect, spyOn } from "bun:test"
import { Readable } from "node:stream"
import { Renderable, RenderableEvents } from "../Renderable.js"
import type { OptimizedBuffer } from "../buffer.js"
import { BoxRenderable } from "../renderables/Box.js"
import { LineNumberRenderable } from "../renderables/LineNumberRenderable.js"
import { ScrollBoxRenderable } from "../renderables/ScrollBox.js"
import { TextRenderable } from "../renderables/Text.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { createTestStdout } from "../testing/test-streams.js"

class DestroyingRenderable extends Renderable {
  protected renderSelf(_buffer: OptimizedBuffer, _deltaTime: number): void {}
}

test.each([
  ["child", "returns"],
  ["child", "throws"],
  ["detached child", "returns"],
  ["detached child", "throws"],
  ["detached walk", "returns"],
  ["detached walk", "throws"],
  ["hidden child", "returns"],
  ["hidden child", "throws"],
  ["nested child", "returns"],
  ["nested child", "throws"],
  ["root", "returns"],
  ["root", "throws"],
] as const)("renderer waits for idle %s cleanup when the sibling listener %s", async (owner, behavior) => {
  const events: string[] = []
  const nodes: Renderable[] = []
  const rawModeCalls: boolean[] = []
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream
  stdin.setRawMode = (enabled) => {
    rawModeCalls.push(enabled)
    return stdin
  }
  let onDestroyState: boolean[] | undefined
  const { renderer } = await createTestRenderer({
    stdin,
    width: 20,
    height: 5,
    onDestroy() {
      events.push("onDestroy")
      onDestroyState = nodes.map((node) => getYogaNode(node).isFreed())
    },
  })
  await renderer.setupTerminal()
  const first = new TextRenderable(renderer, { content: "first" })
  const second = new TextRenderable(renderer, { content: "second" })
  nodes.push(first, second, renderer.root)
  if (owner === "hidden child") {
    const scrollbox = new ScrollBoxRenderable(renderer, { width: 20, height: 4 })
    scrollbox.wrapper.add(first)
    renderer.root.add(scrollbox)
    nodes.push(scrollbox, scrollbox.wrapper)
    expect(scrollbox.getChildren()).not.toContain(first)
  } else if (owner !== "detached child") {
    renderer.root.add(first)
  }
  renderer.root.add(second)

  let entry: Renderable = first
  if (owner === "nested child") {
    entry = new TextRenderable(renderer, { content: "outer cleanup" })
    renderer.root.insertBefore(entry, first)
    entry.on(RenderableEvents.DESTROYED, () => first.destroy())
    nodes.push(entry)
  }
  if (owner === "detached walk") {
    class CompletingBox extends BoxRenderable {
      override destroy(): void {
        super.destroy()
        events.push("box-return")
      }
    }
    entry = new CompletingBox(renderer, {})
    entry.add(first)
    entry.add(second)
    entry.on(RenderableEvents.DESTROYED, () => events.push("box"))
    nodes.push(entry)
  }

  const driver = renderer.nativeScene!.driver
  const lib = driver.renderLib
  const destroyContext = lib.destroyContext.bind(lib)
  let nativeReleaseState: boolean[] | undefined
  const nativeDestroy = spyOn(lib, "destroyContext").mockImplementation((handle) => {
    events.push("native")
    nativeReleaseState = nodes.map((node) => getYogaNode(node).isFreed())
    destroyContext(handle)
  })
  const errors = spyOn(console, "error").mockImplementation(() => {})
  const siblingError = new Error("injected sibling cleanup failure")
  let requestState: unknown
  first.on(RenderableEvents.DESTROYED, () => {
    events.push("first")
    renderer.destroy()
    events.push("request-return")
    requestState = {
      nativeCalls: nativeDestroy.mock.calls.length,
      bufferWidth: renderer.currentRenderBuffer.width,
      inputRestored: rawModeCalls.at(-1) === false,
    }
  })
  second.on(RenderableEvents.DESTROYED, () => {
    events.push("second")
    if (behavior === "throws") throw siblingError
  })
  renderer.root.on(RenderableEvents.DESTROYED, () => events.push("root"))

  try {
    let failure: unknown
    try {
      if (owner === "root") renderer.root.destroyRecursively()
      else if (owner === "detached walk") entry.destroyRecursively()
      else entry.destroy()
    } catch (error) {
      failure = error
    }
    await renderer.closed
    expect(events).toEqual(
      owner === "detached walk"
        ? ["first", "request-return", "second", "box", "box-return", "root", "onDestroy", "native"]
        : ["first", "request-return", "second", "root", "onDestroy", "native"],
    )
    expect(requestState).toEqual({ nativeCalls: 0, bufferWidth: 20, inputRestored: true })
    expect(nativeReleaseState).toEqual(nodes.map(() => true))
    expect(onDestroyState).toEqual(nodes.map(() => true))
    const callerOwnsWalk = owner === "root" || owner === "detached walk"
    expect(failure).toBe(callerOwnsWalk && behavior === "throws" ? siblingError : undefined)
    const rootErrors = errors.mock.calls.filter(([message]) => message === "Error destroying root renderable:")
    expect(rootErrors).toHaveLength(!callerOwnsWalk && behavior === "throws" ? 1 : 0)
    if (rootErrors.length > 0) expect(rootErrors[0][1]).toContain(siblingError.message)
    expect(driver.disposed).toBe(true)
    renderer.destroy()
    expect(nativeDestroy).toHaveBeenCalledTimes(1)
  } finally {
    renderer.destroy()
    await renderer.closed
    nativeDestroy.mockRestore()
    errors.mockRestore()
  }
})

test.each([
  ["destroy", "returns", "line-number"],
  ["destroy", "gutter throws", "line-number"],
  ["destroy", "both throw", "line-number"],
  ["destroyRecursively", "returns", "line-number"],
  ["destroyRecursively", "gutter throws", "line-number"],
  ["destroyRecursively", "both throw", "line-number"],
  ["destroy", "returns", "gutter"],
  ["destroy", "gutter throws", "gutter"],
  ["destroy", "both throw", "gutter"],
  ["destroyRecursively", "returns", "gutter"],
  ["destroyRecursively", "gutter throws", "gutter"],
  ["destroyRecursively", "both throw", "gutter"],
  ["destroy", "returns", "gutter-parent"],
  ["destroy", "gutter throws", "gutter-parent"],
  ["destroy", "both throw", "gutter-parent"],
] as const)(
  "renderer waits for LineNumber %s cleanup when %s (request from %s)",
  async (method, behavior, requestFrom) => {
    const events: string[] = []
    let target: TextRenderable
    let gutter: Renderable
    let lineNumbers: LineNumberRenderable
    let onDestroyState: unknown
    const { renderer } = await createTestRenderer({
      onDestroy() {
        events.push("onDestroy")
        onDestroyState = {
          lineNumberFreed: getYogaNode(lineNumbers).isFreed(),
          gutterDestroyed: gutter.isDestroyed,
          gutterFreed: getYogaNode(gutter).isFreed(),
          targetDestroyed: target.isDestroyed,
          targetFreed: getYogaNode(target).isFreed(),
        }
      },
    })
    target = new TextRenderable(renderer, { content: "owned" })
    lineNumbers = new LineNumberRenderable(renderer, { target })
    gutter = lineNumbers.getChildren().find((child) => child !== target)!
    renderer.root.add(lineNumbers)
    const gutterError = new Error("injected gutter cleanup failure")
    const outerError = new Error("injected LineNumber cleanup failure")
    const gutterDestroy = spyOn(gutter, "destroy")
    const errors = spyOn(console, "error").mockImplementation(() => {})
    gutter.on(RenderableEvents.DESTROYED, () => {
      events.push("gutter")
      if (requestFrom === "gutter") renderer.destroy()
      if (requestFrom === "gutter-parent") lineNumbers.destroy()
      if (behavior !== "returns") throw gutterError
    })
    target.on(RenderableEvents.DESTROYED, () => events.push("target"))
    lineNumbers.on(RenderableEvents.DESTROYED, () => {
      events.push("line-number")
      if (requestFrom !== "gutter") renderer.destroy()
      if (behavior === "both throw") throw outerError
    })

    try {
      let failure: unknown
      try {
        if (requestFrom === "gutter-parent") gutter.destroy()
        else lineNumbers[method]()
      } catch (error) {
        failure = error
      }
      const recursive = method === "destroyRecursively"
      expect(events).toEqual(
        requestFrom === "gutter-parent"
          ? ["gutter", "line-number", "target", "onDestroy"]
          : recursive
            ? ["gutter", "target", "line-number", "onDestroy"]
            : ["line-number", "gutter", "target", "onDestroy"],
      )
      expect(onDestroyState).toEqual({
        lineNumberFreed: true,
        gutterDestroyed: true,
        gutterFreed: true,
        targetDestroyed: true,
        targetFreed: true,
      })
      expect(failure).toBe(
        behavior === "returns" ? undefined : behavior === "both throw" && !recursive ? outerError : gutterError,
      )
      expect(gutterDestroy).toHaveBeenCalledTimes(1)
      expect(errors).not.toHaveBeenCalled()
      expect(target.parent).toBeNull()
      expect(target.listenerCount("line-info-change")).toBe(0)
    } finally {
      renderer.destroy()
      await renderer.closed
      gutterDestroy.mockRestore()
      errors.mockRestore()
      target.destroy()
    }
  },
)

test("detached cleanup only delays its own renderer context", async () => {
  const events: string[] = []
  let widget: TextRenderable
  let ownerFreed: boolean | undefined
  let otherFreed: boolean | undefined
  const { renderer } = await createTestRenderer({
    onDestroy() {
      events.push("owner")
      ownerFreed = getYogaNode(widget).isFreed()
    },
  })
  const { renderer: other } = await createTestRenderer({
    onDestroy() {
      events.push("other")
      otherFreed = getYogaNode(widget).isFreed()
    },
  })
  widget = new TextRenderable(renderer, { content: "detached" })
  widget.on(RenderableEvents.DESTROYED, () => {
    events.push("widget")
    other.destroy()
    events.push("other-return")
    renderer.destroy()
    events.push("owner-return")
  })
  try {
    widget.destroy()
    expect(events).toEqual(["widget", "other", "other-return", "owner-return", "owner"])
    expect(otherFreed).toBe(false)
    expect(ownerFreed).toBe(true)
  } finally {
    widget.destroy()
    renderer.destroy()
    other.destroy()
    await Promise.all([renderer.closed, other.closed])
  }
})

test("rejected recursive self admission releases the walk index and permits retry", async () => {
  let destroyed = false
  const { renderer } = await createTestRenderer({
    onDestroy: () => {
      destroyed = true
    },
  })
  const widget = new TextRenderable(renderer, { content: "owned" })
  const node = getYogaNode(widget)
  const assertMutable = node.assertMutable.bind(node)
  const failure = new Error("injected recursive self admission failure")
  let calls = 0
  const begin = spyOn(node, "assertMutable").mockImplementation(() => {
    if (++calls === 2) throw failure
    assertMutable()
  })
  try {
    expect(() => widget.destroyRecursively()).toThrow(failure)
    expect(widget.isDestroyed).toBe(false)
    expect(widget.plainText).toBe("owned")
    expect(renderer.root._deferUntilCleanupComplete(() => {})).toBe(false)
    begin.mockRestore()
    widget.destroyRecursively()
    expect(getYogaNode(widget).isFreed()).toBe(true)
    renderer.destroy()
    expect(destroyed).toBe(true)
  } finally {
    begin.mockRestore()
    widget.destroy()
    renderer.destroy()
    await renderer.closed
  }
})

test("destroying renderer during frame callback restores input synchronously and drains terminal shutdown", async () => {
  const rawModeCalls: boolean[] = []
  const stdin = new Readable({ read() {} }) as NodeJS.ReadStream & {
    setRawMode: (enabled: boolean) => NodeJS.ReadStream
  }
  stdin.setRawMode = (enabled) => {
    rawModeCalls.push(enabled)
    return stdin
  }

  let output = ""
  const stdout = createTestStdout()
  stdout._write = (chunk, _encoding, callback) => {
    output += chunk.toString()
    callback()
  }
  const { renderer } = await createTestRenderer({ stdin, stdout, bufferedOutput: "stdout" })
  await renderer.setupTerminal()
  await renderer.idle()
  output = ""
  let cleanupObserved = false

  renderer.setFrameCallback(async () => {
    renderer.destroy()
    cleanupObserved = rawModeCalls.at(-1) === false && stdin.isPaused()
  })

  renderer.start()
  await renderer.closed

  expect(cleanupObserved).toBe(true)
  expect(output).toContain("\x1b[?2004l")
  expect(output).toContain("\x1b[?1006l")
})

test("destroying renderer during post-process should not crash", async () => {
  const { renderer } = await createTestRenderer({})

  let destroyedDuringPostProcess = false

  renderer.addPostProcessFn(() => {
    destroyedDuringPostProcess = true
    renderer.destroy()
  })

  renderer.start()

  await renderer.closed

  expect(destroyedDuringPostProcess).toBe(true)

  // If we got here without a segfault, the test passes
})

test("destroying renderer during requestAnimationFrame should not crash", async () => {
  const { renderer } = await createTestRenderer({})

  let destroyedDuringAnimationFrame = false

  renderer.requestAnimationFrame(() => {
    destroyedDuringAnimationFrame = true
    renderer.destroy()
  })

  await renderer.closed

  expect(destroyedDuringAnimationFrame).toBe(true)
})

test.each(["renderBefore", "renderAfter"] as const)(
  "destroying renderer during %s releases the native scene",
  async (hook) => {
    const { renderer } = await createTestRenderer({})
    const driver = renderer.nativeScene.driver
    let calls = 0
    const Constructor = hook === "renderBefore" ? DestroyingRenderable : BoxRenderable
    const renderable = new Constructor(renderer, {
      width: 10,
      height: 1,
      [hook]() {
        calls++
        renderer.destroy()
      },
    })

    renderer.root.add(renderable)
    renderer.start()

    await renderer.closed

    expect(calls).toBe(1)
    expect(renderable.isDestroyed).toBe(true)
    expect(renderer.root.isDestroyed).toBe(true)
    expect(driver.disposed).toBe(true)
  },
)
