import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Writable } from "node:stream"

import { ANSI } from "../ansi.js"
import { capture } from "../console.js"
import { clearEnvCache } from "../lib/env.js"
import {
  createTestRenderer as createRenderer,
  type TestRenderer,
  type TestRendererOptions,
} from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { TextRenderable, type ScrollbackRenderContext } from "../index.js"
import { NativeSession } from "../NativeSession.js"
import { NativeError, NativeStatus } from "../zig.js"

let renderer: TestRenderer | null = null
let previousShowConsole: string | undefined
let previousUseAlternateScreen: string | undefined
let previousOverrideStdout: string | undefined
let previousUseConsole: string | undefined

async function createTestRenderer(options: TestRendererOptions & { startupPending?: boolean; startupCPR?: string }) {
  const writes: string[] = []
  const stdout =
    options.stdout ??
    (new Writable({
      write(chunk, _encoding, callback) {
        writes.push(Buffer.from(chunk).toString())
        if (options.startupCPR && writes.at(-1)!.includes("\x1b[6n")) {
          setImmediate(() => {
            renderer!.stdin.emit("data", Buffer.from(options.startupCPR!))
            callback()
          })
          return
        }
        callback()
      },
    }) as NodeJS.WriteStream)
  const result = await createRenderer({
    clock: new ManualClock(),
    ...options,
    stdout,
    bufferedOutput: options.bufferedOutput ?? "stdout",
    remote: true,
  })
  renderer = result.renderer
  await renderer.setupTerminal()
  await renderer.nativeScene.driver.idle()
  if (!options.startupPending && renderer.screenMode === "split-footer") {
    renderer.stdin.emit("data", Buffer.from("\x1b[1;1R"))
  }
  await renderer.nativeScene.driver.idle()
  writes.length = 0
  return {
    ...result,
    writes,
    output: () => writes.join(""),
    renderOnce: async () => {
      await result.renderOnce()
      await result.renderer.nativeScene?.driver.idle()
    },
  }
}

function textScrollbackWrite(data: string) {
  return (ctx: ScrollbackRenderContext) => {
    const lines = data.replace(/\r/g, "").split("\n")
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop()
    }

    const normalizedLines = lines.length > 0 ? lines : [""]
    const width = Math.max(
      1,
      Math.min(
        ctx.width,
        normalizedLines.reduce((max, line) => Math.max(max, line.length), 1),
      ),
    )
    const height = Math.max(1, normalizedLines.length)
    const root = new TextRenderable(ctx.renderContext, {
      id: "scrollback-test-text",
      position: "absolute",
      left: 0,
      top: 0,
      width,
      height,
      content: normalizedLines.map((line) => line.slice(0, width)).join("\n"),
    })

    return {
      root,
      width,
      height,
    }
  }
}

function requireSnapshotRoot(root: TextRenderable | null): TextRenderable {
  if (root === null) {
    throw new Error("expected scrollback snapshot root")
  }

  return root
}

function blockSplitStartupCursorSeed(target: TestRenderer): () => void {
  expect((target as any).pendingSplitStartupCursorSeed).toBe(true)
  return () => target.stdin.emit("data", Buffer.from("\x1b[1;1R"))
}

beforeEach(() => {
  previousShowConsole = process.env.SHOW_CONSOLE
  previousUseAlternateScreen = process.env.OTUI_USE_ALTERNATE_SCREEN
  previousOverrideStdout = process.env.OTUI_OVERRIDE_STDOUT
  previousUseConsole = process.env.OTUI_USE_CONSOLE
  delete process.env.SHOW_CONSOLE
  delete process.env.OTUI_USE_ALTERNATE_SCREEN
  delete process.env.OTUI_OVERRIDE_STDOUT
  delete process.env.OTUI_USE_CONSOLE
  clearEnvCache()
})

afterEach(async () => {
  renderer?.destroy()
  await renderer?.closed
  renderer = null
  capture.claimOutput()

  if (previousShowConsole === undefined) {
    delete process.env.SHOW_CONSOLE
  } else {
    process.env.SHOW_CONSOLE = previousShowConsole
  }

  if (previousUseAlternateScreen === undefined) {
    delete process.env.OTUI_USE_ALTERNATE_SCREEN
  } else {
    process.env.OTUI_USE_ALTERNATE_SCREEN = previousUseAlternateScreen
  }

  if (previousOverrideStdout === undefined) {
    delete process.env.OTUI_OVERRIDE_STDOUT
  } else {
    process.env.OTUI_OVERRIDE_STDOUT = previousOverrideStdout
  }

  if (previousUseConsole === undefined) {
    delete process.env.OTUI_USE_CONSOLE
  } else {
    process.env.OTUI_USE_CONSOLE = previousUseConsole
  }

  clearEnvCache()
})

test("CliRenderer initializes its clock before SHOW_CONSOLE triggers a render", async () => {
  process.env.SHOW_CONSOLE = "true"
  clearEnvCache()

  const result = await createTestRenderer({
    clock: new ManualClock(),
  })

  renderer = result.renderer

  expect(renderer).toBeDefined()
})

test("CliRenderer destroy from a published output write delivers terminal mode exits", async () => {
  const writes: string[] = []
  let armed = false
  const stdout = new Writable({
    write(chunk, _encoding, callback) {
      writes.push(Buffer.from(chunk).toString())
      if (armed) {
        armed = false
        renderer!.destroy()
      }
      callback()
    },
  }) as NodeJS.WriteStream
  const result = await createTestRenderer({
    width: 4,
    height: 2,
    screenMode: "alternate-screen",
    stdout,
    bufferedOutput: "stdout",
    kittyKeyboard: true,
    clock: new ManualClock(),
    consoleMode: "disabled",
  })
  renderer = result.renderer
  await renderer.setupTerminal()
  renderer.stdin.emit("data", Buffer.from("\x1b[?5u"))
  await renderer.nativeScene!.driver.idle()
  expect(writes.join("")).toContain("\x1b[?1049h")
  expect(writes.join("")).toMatch(/\x1b\[>[0-9]+u/)
  writes.length = 0
  armed = true
  await result.renderOnce()
  await renderer.closed
  expect(renderer.isDestroyed).toBe(true)
  const output = writes.join("")
  expect(output).toContain("\x1b[?1049l")
  expect(output).toContain("\x1b[<u")
  expect(output).toContain("\x1b[?2026l")
  expect(output.indexOf("\x1b[?1049l")).toBeGreaterThan(output.indexOf("\x1b[?2026l"))
})

test("CliRenderer uses its shared clock for debounced resize", async () => {
  const clock = new ManualClock()
  const result = await createTestRenderer({
    width: 40,
    height: 20,
    clock,
  })

  renderer = result.renderer
  renderer.requestResize(70, 30)

  expect(renderer.width).toBe(40)
  expect(renderer.height).toBe(20)

  clock.advance(99)

  expect(renderer.width).toBe(40)
  expect(renderer.height).toBe(20)

  clock.advance(1)

  expect(renderer.width).toBe(70)
  expect(renderer.height).toBe(30)
})

test("CliRenderer applies explicit screen and output modes", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  expect(renderer.screenMode).toBe("split-footer")
  expect(renderer.footerHeight).toBe(6)
  expect(renderer.externalOutputMode).toBe("capture-stdout")
  expect(renderer.consoleMode).toBe("disabled")
})

test("CliRenderer consoleMode disabled restores the original console", async () => {
  process.env.OTUI_USE_CONSOLE = "true"
  clearEnvCache()

  const originalConsole = global.console

  const result = await createTestRenderer({
    consoleMode: "console-overlay",
  })

  renderer = result.renderer

  expect(global.console).not.toBe(originalConsole)

  renderer.consoleMode = "disabled"

  expect(global.console).toBe(originalConsole)
})

test("OTUI_USE_CONSOLE=false leaves the global console unchanged", async () => {
  process.env.OTUI_USE_CONSOLE = "false"
  clearEnvCache()

  const originalConsole = global.console

  const result = await createTestRenderer({
    consoleMode: "console-overlay",
  })

  renderer = result.renderer

  expect(global.console).toBe(originalConsole)
})

test("CliRenderer clamps split footer height to terminal height at startup", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 5,
    screenMode: "split-footer",
    footerHeight: 12,
    externalOutputMode: "capture-stdout",
  })

  renderer = result.renderer

  expect(renderer.footerHeight).toBe(12)
  expect(renderer.height).toBe(5)
  expect((renderer as any)._splitHeight).toBe(5)
  expect((renderer as any).renderOffset).toBe(0)
})

test("CliRenderer rejects captured output outside split-footer mode", async () => {
  await expect(
    createTestRenderer({
      screenMode: "main-screen",
      externalOutputMode: "capture-stdout",
    }),
  ).rejects.toThrow('externalOutputMode "capture-stdout" requires screenMode "split-footer"')
})

test("CliRenderer writeToScrollback throws when screen mode is not split-footer", async () => {
  const result = await createTestRenderer({
    screenMode: "main-screen",
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  expect(() => renderer!.writeToScrollback(textScrollbackWrite("ignored\n"))).toThrow(
    'writeToScrollback requires screenMode "split-footer" and externalOutputMode "capture-stdout"',
  )
})

test("CliRenderer writeToScrollback throws when external output mode is passthrough", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  expect(() => renderer!.writeToScrollback(textScrollbackWrite("ignored\n"))).toThrow(
    'writeToScrollback requires screenMode "split-footer" and externalOutputMode "capture-stdout"',
  )
})

test("CliRenderer writeToScrollback enqueues snapshot commits to native", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  renderer.writeToScrollback(textScrollbackWrite("api-line-1\napi-line-2\n"))

  expect((renderer as any).externalOutputQueue.size).toBe(1)

  await result.renderOnce()

  expect((renderer as any).externalOutputQueue.size).toBe(0)
  expect(result.output()).toContain("api-line-1")
  expect(result.output()).toContain("api-line-2")
})

test("CliRenderer writeToScrollback passes width and widthMethod to the scrollback writer", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  let receivedContext: ScrollbackRenderContext | null = null

  renderer.writeToScrollback((ctx) => {
    receivedContext = ctx

    const root = new TextRenderable(ctx.renderContext, {
      id: "scrollback-context-test",
      position: "absolute",
      left: 0,
      top: 0,
      width: 3,
      height: 1,
      content: "ctx",
    })

    return {
      root,
      width: 3,
      height: 1,
    }
  })

  expect(receivedContext).not.toBeNull()

  if (receivedContext === null) {
    throw new Error("expected writeToScrollback to provide context")
  }

  const writeContext = receivedContext as ScrollbackRenderContext
  expect(writeContext.width).toBe(result.renderer.width)
  expect(writeContext.widthMethod).toBe(result.renderer.widthMethod)
})

test("CliRenderer writeToScrollback runs snapshot teardown after enqueueing", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  let teardownCalls = 0
  let snapshotRoot: TextRenderable | null = null

  renderer.writeToScrollback((ctx) => {
    const root = new TextRenderable(ctx.renderContext, {
      id: "scrollback-teardown-success",
      position: "absolute",
      left: 0,
      top: 0,
      width: 4,
      height: 1,
      content: "done",
    })
    snapshotRoot = root

    return {
      root,
      width: 4,
      height: 1,
      teardown: () => {
        teardownCalls += 1
      },
    }
  })

  expect(teardownCalls).toBe(1)
  expect(requireSnapshotRoot(snapshotRoot).isDestroyed).toBe(true)
  expect((renderer as any).externalOutputQueue.size).toBe(1)
})

test("CliRenderer writeToScrollback runs snapshot teardown when snapshot validation fails", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  let teardownCalls = 0
  let snapshotRoot: TextRenderable | null = null

  expect(() => {
    renderer!.writeToScrollback((ctx) => {
      const root = new TextRenderable(ctx.renderContext, {
        id: "scrollback-teardown-failure",
        position: "absolute",
        left: 0,
        top: 0,
        width: 4,
        height: 1,
        content: "fail",
      })
      snapshotRoot = root

      return {
        root,
        width: Number.NaN,
        height: 1,
        teardown: () => {
          teardownCalls += 1
        },
      }
    })
  }).toThrow("writeToScrollback produced a non-finite width")

  expect(teardownCalls).toBe(1)
  expect(requireSnapshotRoot(snapshotRoot).isDestroyed).toBe(true)
})

test("CliRenderer preserves append order when writeToScrollback and stdout capture are interleaved", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  renderer.writeToScrollback(textScrollbackWrite("api-1\n"))
  ;(renderer as any).stdout.write("stdout-1\n")
  renderer.writeToScrollback(textScrollbackWrite("api-2\n"))

  await result.renderOnce()

  const output = result.output()
  expect(output).toContain("api-1")
  expect(output.indexOf("stdout-1")).toBeGreaterThan(output.indexOf("api-1"))
  expect(output.indexOf("api-2")).toBeGreaterThan(output.indexOf("stdout-1"))
  expect(result.externalOutput.take().map(({ startOnNewLine }) => startOnNewLine)).toEqual([true, false, true])
})

test("CliRenderer writeToScrollback bypasses global console capture singleton", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  capture.claimOutput()

  renderer.writeToScrollback(textScrollbackWrite("api-only\n"))
  await result.renderOnce()

  expect(capture.size).toBe(0)
  expect(capture.claimOutput()).toBe("")
})

test("CliRenderer flushes captured output before switching to passthrough in split-footer", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  ;(renderer as any).stdout.write("pending output\n")

  expect((renderer as any).externalOutputQueue.size).toBe(1)

  renderer.externalOutputMode = "passthrough"
  await result.renderOnce()
  expect(result.output()).toContain("pending output")
  expect(renderer.externalOutputMode).toBe("passthrough")
  expect((renderer as any).externalOutputQueue.size).toBe(0)
})

test("CliRenderer drains all pending split commits before switching to passthrough", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  for (let i = 0; i < 10; i += 1) {
    ;(renderer as any).stdout.write(`pending-${i}\n`)
  }

  expect((renderer as any).externalOutputQueue.size).toBe(10)

  renderer.externalOutputMode = "passthrough"
  await result.renderOnce()
  expect((renderer as any)._externalOutputMode).toBe("capture-stdout")
  expect((renderer as any).externalOutputQueue.size).toBe(2)
  await result.renderOnce()
  expect([...(result.output().match(/pending-\d/g) ?? [])]).toEqual(
    Array.from({ length: 10 }, (_, i) => `pending-${i}`),
  )
  expect((renderer as any).externalOutputQueue.size).toBe(0)
  expect(renderer.externalOutputMode).toBe("passthrough")
})

test("CliRenderer keeps stdout captured until a deferred passthrough switch drains", async () => {
  const result = await createTestRenderer({
    startupPending: true,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const unblockStartupSeed = blockSplitStartupCursorSeed(renderer)

  try {
    ;(renderer as any).stdout.write("older\n")
    renderer.externalOutputMode = "passthrough"

    expect((renderer as any)._externalOutputMode).toBe("capture-stdout")

    ;(renderer as any).stdout.write("newer\n")

    expect((renderer as any).externalOutputQueue.size).toBe(2)

    unblockStartupSeed()
    await result.renderOnce()

    expect(result.output()).toContain("older")
    expect(result.output().indexOf("newer")).toBeGreaterThan(result.output().indexOf("older"))
    expect((renderer as any).externalOutputQueue.size).toBe(0)
    expect(renderer.externalOutputMode).toBe("passthrough")
  } finally {
    unblockStartupSeed()
  }
})

test("CliRenderer drains deferred passthrough output before leaving split-footer", async () => {
  const result = await createTestRenderer({
    startupPending: true,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const unblockStartupSeed = blockSplitStartupCursorSeed(renderer)

  try {
    ;(renderer as any).stdout.write("before-leave\n")
    renderer.externalOutputMode = "passthrough"

    expect((renderer as any)._externalOutputMode).toBe("capture-stdout")

    renderer.screenMode = "main-screen"
    await result.renderOnce()
    expect(result.output()).toContain("before-leave")
    expect((renderer as any).externalOutputQueue.size).toBe(0)
    expect(renderer.externalOutputMode).toBe("passthrough")
    expect(renderer.screenMode).toBe("main-screen")
  } finally {
    unblockStartupSeed()
  }
})

test("CliRenderer leaving split-footer aborts an in-flight startup CPR reply", async () => {
  const clock = new ManualClock()
  const result = await createTestRenderer({
    startupPending: true,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    clock,
  })

  renderer = result.renderer

  const keypresses: string[] = []
  renderer.keyInput.on("keypress", (event) => {
    keypresses.push(event.name)
  })

  try {
    renderer.stdin.emit("data", Buffer.from("\x1b["))

    ;(renderer as any).stdout.write("before-leave\n")
    renderer.externalOutputMode = "passthrough"

    expect((renderer as any)._externalOutputMode).toBe("capture-stdout")

    renderer.screenMode = "main-screen"
    await result.renderOnce()

    expect((renderer as any).pendingSplitStartupCursorSeed).toBe(false)
    expect((renderer as any).splitStartupSeedTimeoutId).toBeNull()
    expect((renderer as any).stdinParser.protocolContext.startupCursorCprActive).toBe(false)

    renderer.stdin.emit("data", Buffer.from("24;80R"))
    clock.advance(20)

    expect(keypresses).toEqual([])
  } finally {
    if ((renderer as any).capabilityTimeoutId !== null) {
      clock.clearTimeout((renderer as any).capabilityTimeoutId)
      ;(renderer as any).capabilityTimeoutId = null
    }

    if ((renderer as any).splitStartupSeedTimeoutId !== null) {
      clock.clearTimeout((renderer as any).splitStartupSeedTimeoutId)
      ;(renderer as any).splitStartupSeedTimeoutId = null
    }
  }
})

test("CliRenderer preserves split render offset when switching to passthrough", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any).stdout.write("seed\n")
  await result.renderOnce()

  const before = (renderer as any).renderOffset
  const pinned = (renderer as any)._terminalHeight - (renderer as any)._splitHeight

  renderer.externalOutputMode = "passthrough"

  expect(before).toBeGreaterThan(0)
  expect(before).toBeLessThanOrEqual(pinned)
  expect((renderer as any).renderOffset).toBe(before)
})

test("CliRenderer does not force split repaint when switching to passthrough with no pending output", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const frames = renderer.getNativeStats().nativeFrameCount

  expect((renderer as any).externalOutputQueue.size).toBe(0)

  renderer.externalOutputMode = "passthrough"

  await renderer.nativeScene.driver.idle()
  expect(result.output()).toBe("")
  expect(renderer.getNativeStats().nativeFrameCount).toBe(frames)
})

test("CliRenderer flushes pending split output before resize applies new geometry", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any).stdout.write("before-resize\n")

  let pendingAtResize = -1
  renderer.on("resize", () => {
    pendingAtResize = (renderer as any).externalOutputQueue.size
  })

  ;(renderer as any).processResize(60, 16)
  await result.renderOnce()
  expect(pendingAtResize).toBe(0)
  expect(result.output()).toContain("before-resize")
  expect([renderer.width, renderer.height]).toEqual([60, 4])
})

test("CliRenderer flushes pending writeToScrollback output before resize applies new geometry", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  renderer.writeToScrollback(textScrollbackWrite("before-resize\n"))

  let pendingAtResize = -1
  renderer.on("resize", () => {
    pendingAtResize = (renderer as any).externalOutputQueue.size
  })

  ;(renderer as any).processResize(60, 16)
  await result.renderOnce()
  expect(pendingAtResize).toBe(0)
  expect(result.output()).toContain("before-resize")
  expect([renderer.width, renderer.height]).toEqual([60, 4])
})

for (const [name, screenMode, change, dimensions, output] of [
  ["alternate-screen resize", "alternate-screen", (target: TestRenderer) => target.resize(20, 6), [20, 6], "\x1b[14t"],
  [
    "split-footer resize",
    "split-footer",
    (target: TestRenderer) => target.resize(20, 6),
    [20, 4],
    ANSI.moveCursorAndClear(2, 1) + "\x1b[14t",
  ],
  [
    "entering split-footer",
    "main-screen",
    (target: TestRenderer) => (target.screenMode = "split-footer"),
    [40, 4],
    ANSI.scrollDown(6),
  ],
  [
    "growing footerHeight",
    "split-footer",
    (target: TestRenderer) => (target.footerHeight = 6),
    [40, 6],
    ANSI.scrollUp(2),
  ],
  [
    "shrinking footerHeight",
    "split-footer",
    (target: TestRenderer) => (target.footerHeight = 3),
    [40, 3],
    `${ANSI.moveCursor(7, 1)}\x1b[2K`,
  ],
] as const) {
  test(`CliRenderer publishes ${name} geometry before stdout callbacks`, async () => {
    const writes: { output: string; dimensions: (readonly number[])[] }[] = []
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        if (renderer && !renderer.isDestroyed) {
          const current = renderer.currentRenderBuffer
          const next = renderer.nextRenderBuffer
          const driver = renderer.nativeScene.driver
          const native = driver.renderLib.sessionGetRendererState(driver.context, driver.session)
          writes.push({
            output: Buffer.from(chunk).toString(),
            dimensions: [
              [renderer.width, renderer.height],
              [current.width, current.height],
              [next.width, next.height],
              [native.width, native.height],
            ],
          })
        }
        callback()
      },
    }) as NodeJS.WriteStream
    const result = await createTestRenderer({
      width: 40,
      height: 10,
      screenMode,
      footerHeight: 4,
      stdout,
      bufferedOutput: "stdout",
      clock: new ManualClock(),
      consoleMode: "disabled",
    })
    renderer = result.renderer
    renderer.footerHeight = 4
    renderer.stdin.emit("data", Buffer.from("\x1b[4;100;400t"))
    await renderer.nativeScene.driver.idle()
    writes.length = 0

    const current = renderer.currentRenderBuffer
    const next = renderer.nextRenderBuffer
    const lib = renderer.nativeScene.driver.renderLib
    const method = name.endsWith("resize") ? "sessionResizeRenderer" : "sessionSetScreen"
    const failure = new NativeError("injected resize", NativeStatus.InvalidArgument)
    const resizeSpy = spyOn(lib, method).mockImplementation(() => {
      throw failure
    })
    try {
      expect(() => change(renderer!)).toThrow(failure)
      expect(writes).toEqual([])
      expect(renderer.screenMode).toBe(screenMode)
      expect(renderer.footerHeight).toBe(4)
      expect([renderer.width, renderer.height]).toEqual([current.width, current.height])
      expect(renderer.currentRenderBuffer).toBe(current)
      expect(renderer.nextRenderBuffer).toBe(next)
    } finally {
      resizeSpy.mockRestore()
    }

    change(renderer)
    await renderer.nativeScene.driver.idle()

    expect(writes.map((write) => write.output).join("")).toBe(output)
    for (const write of writes) {
      expect(write.dimensions).toEqual([dimensions, dimensions, dimensions, dimensions])
    }
  })
}

for (const screenMode of ["alternate-screen", "split-footer"] as const) {
  test(`CliRenderer preserves ${screenMode} geometry when native resize fails and retries`, async () => {
    const result = await createTestRenderer({
      width: 40,
      height: 10,
      screenMode,
      footerHeight: 4,
      consoleMode: "disabled",
    })
    renderer = result.renderer
    const originalHeight = renderer.height
    let resizeEvents = 0
    renderer.on("resize", () => resizeEvents++)
    const lib = renderer.nativeScene.driver.renderLib
    const original = lib.sessionResizeRenderer
    try {
      for (const status of [
        NativeStatus.InvalidArgument,
        NativeStatus.OutOfMemory,
        NativeStatus.WrongContext,
        NativeStatus.StaleHandle,
      ]) {
        const failure = new NativeError("injected resize", status)
        lib.sessionResizeRenderer = () => {
          throw failure
        }
        expect(() => renderer!.resize(60, 16)).toThrow(failure)
        expect([(renderer as any)._terminalWidth, (renderer as any)._terminalHeight]).toEqual([40, 10])
        expect([renderer.width, renderer.height]).toEqual([40, originalHeight])
        expect([renderer.currentRenderBuffer.width, renderer.currentRenderBuffer.height]).toEqual([40, originalHeight])
        expect(resizeEvents).toBe(0)
      }
    } finally {
      lib.sessionResizeRenderer = original
    }
    renderer.resize(60, 16)
    expect([(renderer as any)._terminalWidth, (renderer as any)._terminalHeight]).toEqual([60, 16])
    expect([renderer.width, renderer.height]).toEqual([60, screenMode === "split-footer" ? 4 : 16])
    expect([renderer.currentRenderBuffer.width, renderer.currentRenderBuffer.height]).toEqual([
      renderer.width,
      renderer.height,
    ])
    expect(resizeEvents).toBe(1)
  })
}

test("CliRenderer preserves footerHeight when native resize fails and retries", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    consoleMode: "disabled",
  })
  renderer = result.renderer
  const failure = new NativeError("injected footer resize", NativeStatus.InvalidArgument)
  const resizeSpy = spyOn(renderer.nativeScene.driver, "setScreen").mockImplementation(() => {
    throw failure
  })
  try {
    expect(() => {
      renderer!.footerHeight = 6
    }).toThrow(failure)
    expect(renderer.footerHeight).toBe(4)
    expect(renderer.height).toBe(4)
  } finally {
    resizeSpy.mockRestore()
  }
  renderer.footerHeight = 6
  expect(renderer.footerHeight).toBe(6)
  expect(renderer.height).toBe(6)
  expect(renderer.currentRenderBuffer.height).toBe(6)
})

test("CliRenderer rejects overflowing native resize before publishing geometry", async () => {
  const result = await createTestRenderer({ width: 2, height: 2, consoleMode: "disabled" })
  renderer = result.renderer
  expect(() => renderer!.resize(65536, 65536)).toThrow("InvalidArgument")
  expect([renderer.width, renderer.height]).toEqual([2, 2])
  expect([(renderer as any)._terminalWidth, (renderer as any)._terminalHeight]).toEqual([2, 2])
  renderer.resize(4, 1)
  expect([renderer.width, renderer.height]).toEqual([4, 1])
  expect([renderer.currentRenderBuffer.width, renderer.currentRenderBuffer.height]).toEqual([4, 1])
})

test("CliRenderer resetSplitFooterForReplay clears published scrollback and starts fresh", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  renderer.writeToScrollback(textScrollbackWrite("before-replay\n"))

  renderer.resetSplitFooterForReplay({ clearSavedLines: true })
  await result.renderOnce()
  expect(result.output()).toContain("\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H")
  expect((renderer as any).renderOffset).toBe(0)
  expect((renderer as any).splitTailColumn).toBe(0)
  expect((renderer as any).pendingSplitFooterTransition).toBeNull()
})

test("CliRenderer resetSplitFooterForReplay rejects suspended terminal ownership", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  await renderer.suspend()
  result.writes.length = 0

  expect(() => renderer!.resetSplitFooterForReplay({ clearSavedLines: true })).toThrow(
    "resetSplitFooterForReplay requires an active terminal",
  )
  await renderer.nativeScene!.driver.idle()
  expect(result.output()).toBe("")
})

test("CliRenderer uses Session suspend/resume in split-footer mode", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  const suspendSpy = spyOn(renderer.nativeScene.driver, "suspend")
  const resumeSpy = spyOn(renderer.nativeScene.driver, "resume")
  try {
    await renderer.suspend()
    await renderer.resume()
    expect(suspendSpy).toHaveBeenCalledTimes(1)
    expect(resumeSpy).toHaveBeenCalledTimes(1)
  } finally {
    suspendSpy.mockRestore()
    resumeSpy.mockRestore()
  }
})

test("CliRenderer split-footer resume forces the next footer repaint", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  renderer.root.add(new TextRenderable(renderer, { content: "footer-before-suspend" }))
  await result.renderOnce()
  await renderer.suspend()
  result.writes.length = 0
  await renderer.resume()
  await result.renderOnce()
  expect(result.output()).toContain("footer-before-suspend")
  expect((renderer as any).forceFullRepaintRequested).toBe(false)
})

test("CliRenderer applies suspended screen mode changes on resume", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "main-screen",
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  await renderer.suspend()
  result.writes.length = 0
  renderer.screenMode = "alternate-screen"
  await renderer.nativeScene!.driver.idle()
  expect(result.output()).toBe("")
  await renderer.resume()
  expect(result.output().match(/\x1b\[\?1049h/g)).toHaveLength(1)
})

test("CliRenderer resumes preserved split-footer reservation after suspended screen roundtrip", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  const offset = (renderer as any).renderOffset
  await renderer.suspend()
  result.writes.length = 0
  renderer.screenMode = "alternate-screen"
  renderer.screenMode = "split-footer"
  await renderer.resume()
  expect((renderer as any).renderOffset).toBe(offset)
  expect(result.output()).not.toContain("\x1b[?1049h")
  expect(result.output()).not.toContain(ANSI.scrollDown(6))
  expect(result.output()).toContain("\x1b[?25l")
})

test("CliRenderer does not flush captured split output during resize while suspended", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  await renderer.suspend()
  result.writes.length = 0
  ;(renderer as any).stdout.write("during-suspend\n")
  ;(renderer as any).processResize(60, 16)

  await renderer.nativeScene!.driver.idle()
  expect(result.output()).toBe("")
  expect((renderer as any).externalOutputQueue.size).toBe(1)
})

test("CliRenderer accepts a suspended split-footer width shrink without terminal output and repaints on resume", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })
  renderer = result.renderer
  renderer.root.add(new TextRenderable(renderer, { content: "resized-footer", height: 1 }))
  await result.renderOnce()
  await renderer.suspend()
  result.writes.length = 0

  renderer.resize(20, 10)
  await renderer.nativeScene!.driver.idle()

  expect(result.output()).toBe("")
  expect([renderer.terminalWidth, renderer.terminalHeight]).toEqual([20, 10])
  expect([renderer.width, renderer.height]).toEqual([20, 4])
  expect([renderer.currentRenderBuffer.width, renderer.currentRenderBuffer.height]).toEqual([20, 4])

  await renderer.resume()
  await result.renderOnce()
  expect(result.output()).toContain("resized-footer")
  expect(result.captureCharFrame()).toContain("resized-footer")
})

test("CliRenderer recomputes queued split tail after a blocked resize", async () => {
  const result = await createTestRenderer({
    startupPending: true,
    width: 10,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const unblockStartupSeed = blockSplitStartupCursorSeed(renderer)

  try {
    ;(renderer as any).stdout.write("123456789012345")
    ;(renderer as any).processResize(20, 10)

    let tailColumn = -1
    renderer.writeToScrollback((ctx) => {
      tailColumn = ctx.tailColumn
      const root = new TextRenderable(ctx.renderContext, {
        id: "tail-after-resize-probe",
        content: "x",
        width: 1,
        height: 1,
      })

      return {
        root,
        width: 1,
        height: 1,
        startOnNewLine: false,
        trailingNewline: false,
      }
    })

    expect(tailColumn).toBe(15)
  } finally {
    unblockStartupSeed()
  }
})

test("CliRenderer preserves captured split output when switching output mode while suspended", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  await renderer.suspend()
  result.writes.length = 0
  ;(renderer as any).stdout.write("during-suspend\n")
  renderer.externalOutputMode = "passthrough"

  expect(result.output()).toBe("")
  expect((renderer as any).externalOutputQueue.size).toBe(1)
  expect((renderer as any)._externalOutputMode).toBe("capture-stdout")

  await renderer.resume()
  await result.renderOnce()
  expect(result.output()).toContain("during-suspend")
  expect((renderer as any).externalOutputQueue.size).toBe(0)
  expect(renderer.externalOutputMode).toBe("passthrough")
})

test("CliRenderer preserves captured split output until startup cursor seed unblocks passthrough switch", async () => {
  const clock = new ManualClock()
  const result = await createTestRenderer({
    startupPending: true,
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    clock,
  })

  renderer = result.renderer
  ;(renderer as any).stdout.write("during-startup\n")
  renderer.externalOutputMode = "passthrough"
  expect(result.output()).toBe("")
  expect((renderer as any).externalOutputQueue.size).toBe(1)
  expect((renderer as any)._externalOutputMode).toBe("capture-stdout")
  clock.advance(120)
  await result.renderOnce()
  expect(result.output()).toContain("during-startup")
  expect((renderer as any).externalOutputQueue.size).toBe(0)
  expect(renderer.externalOutputMode).toBe("passthrough")
})

test("CliRenderer flushes pending split output on suspend even when startup cursor seeding is pending", async () => {
  const result = await createTestRenderer({
    startupPending: true,
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const unblockStartupSeed = blockSplitStartupCursorSeed(renderer)

  try {
    ;(renderer as any).stdout.write("before-suspend\n")
    await renderer.suspend()

    expect(result.output()).toContain("before-suspend")
    expect(result.output().lastIndexOf("\x1b[?25h")).toBeGreaterThan(result.output().indexOf("before-suspend"))
    expect((renderer as any).externalOutputQueue.size).toBe(0)
  } finally {
    unblockStartupSeed()
  }
})

test("CliRenderer flushes pending writeToScrollback output before suspend", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  renderer.writeToScrollback(textScrollbackWrite("before-suspend\n"))

  await renderer.suspend()
  expect(result.output()).toContain("before-suspend")
  expect(result.output().lastIndexOf("\x1b[?25h")).toBeGreaterThan(result.output().indexOf("before-suspend"))
})

test("CliRenderer clears split footer surface when leaving split-footer mode", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  renderer.root.add(new TextRenderable(renderer, { content: "visible-footer" }))
  await result.renderOnce()
  result.writes.length = 0
  renderer.screenMode = "main-screen"
  await renderer.nativeScene!.driver.idle()
  expect(result.output()).toContain(ANSI.moveCursorAndClear(7, 1))
  expect((renderer as any).renderOffset).toBe(0)
})

test("CliRenderer destroy flushes split output before clearing split footer surface", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any).stdout.write("before-destroy\n")

  renderer.destroy()
  await renderer.closed

  const output = result.output()
  expect(output).toContain("before-destroy")
  expect(output.lastIndexOf("\x1b[?25h")).toBeGreaterThan(output.indexOf("before-destroy"))
  expect(output.lastIndexOf("\x1b[J")).toBeGreaterThan(output.indexOf("before-destroy"))
})

test("CliRenderer destroy flushes writeToScrollback output before clearing split footer surface", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  renderer.writeToScrollback(textScrollbackWrite("before-destroy\n"))

  renderer.destroy()
  await renderer.closed

  const output = result.output()
  expect(output).toContain("before-destroy")
  expect(output.lastIndexOf("\x1b[?25h")).toBeGreaterThan(output.indexOf("before-destroy"))
  expect(output.lastIndexOf("\x1b[J")).toBeGreaterThan(output.indexOf("before-destroy"))
})

test("CliRenderer destroy does not clear split footer surface when clearOnShutdown is false", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    clearOnShutdown: false,
  })

  renderer = result.renderer
  ;(renderer as any).stdout.write("before-destroy\n")

  renderer.destroy()
  await renderer.closed

  const output = result.output()
  expect(output).toContain("before-destroy")
  expect(output.lastIndexOf("\x1b[?25h")).toBeGreaterThan(output.indexOf("before-destroy"))
  expect(output).not.toContain("\x1b[J")
})

test("CliRenderer split-footer passthrough ignores console capture writes", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const requestRenderSpy = spyOn(renderer, "requestRender")

  capture.write("stdout", "from console capture\n")

  expect(requestRenderSpy).toHaveBeenCalledTimes(0)
  expect((renderer as any).externalOutputQueue.size).toBe(0)
  requestRenderSpy.mockRestore()
})

test("CliRenderer split-footer captures direct console writes when console mode is disabled", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  ;(renderer as any).stdout.write("direct write\n")

  const commits = (renderer as any).externalOutputQueue.claim()
  expect(commits.length).toBe(1)
  expect(commits[0]?.startOnNewLine).toBe(false)
  expect(commits[0]?.trailingNewline).toBe(true)
  expect(commits[0]?.rowColumns).toBe(12)
  const rendered = new TextDecoder().decode(commits[0]?.snapshot.getRealCharBytes(true))
  expect(rendered).toContain("direct write")
  commits[0]?.snapshot.destroy()
  expect(capture.size).toBe(0)
})

test("CliRenderer split-footer repaints footer frame with no pending commits", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  renderer.root.add(new TextRenderable(renderer, { content: "footer-only" }))

  await result.renderOnce()

  expect(result.output()).toContain("footer-only")
  expect(result.externalOutput.take()).toEqual([])
  expect(renderer.getNativeStats().nativeFrameCount).toBe(1)
})

test("CliRenderer split-footer forces one repaint for the complete pending batch", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  renderer.root.add(new TextRenderable(renderer, { content: "forced-footer" }))
  await result.renderOnce()
  result.writes.length = 0
  const commit = spyOn(renderer.nativeScene.driver, "renderSplit")

  ;(renderer as any).stdout.write("line-1\nline-2\n")
  ;(renderer as any).forceFullRepaintRequested = true

  try {
    await result.renderOnce()
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0][1]).toHaveLength(2)
    expect(commit.mock.calls[0][3]).toBe(true)
    expect(result.output().match(/line-\d/g)).toEqual(["line-1", "line-2"])
    expect(result.output().indexOf("forced-footer")).toBeGreaterThan(result.output().indexOf("line-2"))
  } finally {
    commit.mockRestore()
  }
})

test("CliRenderer split-footer defers first native frame while startup cursor seed is pending", async () => {
  const result = await createTestRenderer({
    startupPending: true,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const unblockStartupSeed = blockSplitStartupCursorSeed(renderer)

  try {
    await result.renderOnce()
    expect(result.output()).toBe("")
    expect(renderer.getNativeStats().nativeFrameCount).toBe(0)
  } finally {
    unblockStartupSeed()
  }
})

test("CliRenderer split-footer starts in settling phase and then pins as output grows", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  expect((renderer as any).renderOffset).toBe(1)

  ;(renderer as any).stdout.write("a\n")
  await result.renderOnce()
  expect((renderer as any).renderOffset).toBe(2)

  ;(renderer as any).stdout.write("b\n")
  await result.renderOnce()
  expect((renderer as any).renderOffset).toBe(3)

  ;(renderer as any).stdout.write("c\n")
  await result.renderOnce()
  expect((renderer as any).renderOffset).toBe(4)

  for (let i = 0; i < 8; i++) {
    ;(renderer as any).stdout.write(`line-${i}\n`)
    await result.renderOnce()
  }

  expect((renderer as any).renderOffset).toBe(6)
})

test("CliRenderer split-footer footerHeight changes defer settling cleanup to the next native frame", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  renderer.root.add(new TextRenderable(renderer, { content: "settling-footer" }))
  await result.renderOnce()
  result.writes.length = 0

  renderer.footerHeight = 8
  renderer.footerHeight = 3

  expect((renderer as any).renderOffset).toBe(1)
  expect(result.output()).toBe("")

  await result.renderOnce()

  expect(result.output()).toContain("settling-footer")
  expect(renderer.getNativeStats().nativeFrameCount).toBe(2)
  expect((renderer as any).pendingSplitFooterTransition).toBeNull()
})

test("CliRenderer split-footer footerHeight changes coalesce while settling before the next frame", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  renderer.root.add(new TextRenderable(renderer, { content: "coalesced-footer" }))
  await result.renderOnce()
  result.writes.length = 0

  renderer.footerHeight = 8
  renderer.footerHeight = 3

  await result.renderOnce()

  expect(renderer.getNativeStats().nativeFrameCount).toBe(2)
  expect(result.output()).toContain("coalesced-footer")
  expect((renderer as any).pendingSplitFooterTransition).toBeNull()
  expect(renderer.height).toBe(3)
})

test("CliRenderer split-footer grow then shrink back before frame keeps grown top line", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  ;(renderer as any).stdout.write("a\n")
  await result.renderOnce()
  ;(renderer as any).stdout.write("b\n")
  await result.renderOnce()

  expect((renderer as any).renderOffset).toBe(3)

  renderer.footerHeight = 8
  renderer.footerHeight = 4

  await result.renderOnce()

  expect((renderer as any).renderOffset).toBe(2)
})

test("CliRenderer split-footer pinned footerHeight shrink defers clear-stale-row cleanup to the next native frame", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  for (let i = 0; i < 12; i += 1) {
    ;(renderer as any).stdout.write(`line-${i}\n`)
    await result.renderOnce()
  }

  expect((renderer as any).renderOffset).toBe(6)

  result.writes.length = 0

  renderer.footerHeight = 3

  expect((renderer as any).renderOffset).toBe(6)
  expect((renderer as any).pendingSplitFooterTransition).toEqual({
    mode: "clear-stale-rows",
    sourceTopLine: 7,
    sourceHeight: 4,
    targetTopLine: 7,
    targetHeight: 3,
    scrollLines: 0,
  })
  expect(result.output()).toBe("")

  await result.renderOnce()

  expect((renderer as any).renderOffset).toBe(6)
  expect(result.output()).toContain("\x1b[10;1H\x1b[2K")
  expect((renderer as any).pendingSplitFooterTransition).toBeNull()
})

test("CliRenderer split-footer reuses the reserved gap when reopening the footer before new output arrives", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  for (let i = 0; i < 12; i += 1) {
    ;(renderer as any).stdout.write(`line-${i}\n`)
    await result.renderOnce()
  }

  expect((renderer as any).renderOffset).toBe(6)

  renderer.footerHeight = 8

  expect((renderer as any).pendingSplitFooterTransition).toEqual({
    mode: "viewport-scroll",
    sourceTopLine: 7,
    sourceHeight: 4,
    targetTopLine: 3,
    targetHeight: 8,
    scrollLines: 4,
  })

  await result.renderOnce()

  renderer.footerHeight = 4

  expect((renderer as any).pendingSplitFooterTransition).toEqual({
    mode: "clear-stale-rows",
    sourceTopLine: 3,
    sourceHeight: 8,
    targetTopLine: 3,
    targetHeight: 4,
    scrollLines: 0,
  })

  await result.renderOnce()

  expect((renderer as any).renderOffset).toBe(2)

  renderer.footerHeight = 7

  expect((renderer as any).pendingSplitFooterTransition).toEqual({
    mode: "clear-stale-rows",
    sourceTopLine: 3,
    sourceHeight: 4,
    targetTopLine: 3,
    targetHeight: 7,
    scrollLines: 0,
  })
})

test("CliRenderer split-footer passthrough footerHeight shrink clears stale rows without reverse scrolling", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  renderer.footerHeight = 3
  await renderer.nativeScene!.driver.idle()
  expect(result.output()).toBe(`${ANSI.moveCursor(7, 1)}\x1b[2K`)
})

test("CliRenderer split-footer resize cleanup uses the visible footer surface while a deferred footer transition is pending", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  renderer.footerHeight = 3

  expect((renderer as any).pendingSplitFooterTransition).toEqual({
    mode: "clear-stale-rows",
    sourceTopLine: 2,
    sourceHeight: 4,
    targetTopLine: 2,
    targetHeight: 3,
    scrollLines: 0,
  })

  result.resize(20, 10)
  await renderer.nativeScene!.driver.idle()
  expect(result.output()).toBe(ANSI.moveCursorAndClear(2, 1))
  expect((renderer as any).pendingSplitFooterTransition).toBeNull()
})

test("CliRenderer split-footer resize cleanup uses the visible source top line across width and height resize while a deferred footer transition is pending", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  renderer.footerHeight = 3

  expect((renderer as any).pendingSplitFooterTransition).toEqual({
    mode: "clear-stale-rows",
    sourceTopLine: 2,
    sourceHeight: 4,
    targetTopLine: 2,
    targetHeight: 3,
    scrollLines: 0,
  })

  result.resize(20, 12)
  await renderer.nativeScene!.driver.idle()
  expect(result.output()).toBe(ANSI.moveCursorAndClear(2, 1))
})

test("CliRenderer split-footer resize cleanup still clears the visible source surface when only height changes while a deferred footer transition is pending", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  renderer.footerHeight = 3

  result.resize(40, 12)
  await renderer.nativeScene!.driver.idle()
  expect(result.output()).toBe(ANSI.moveCursorAndClear(2, 1))
})

test("CliRenderer split-footer footerHeight changes do not queue deferred transitions while startup cursor seeding blocks the first frame", async () => {
  const result = await createTestRenderer({
    startupPending: true,
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const unblockStartupSeed = blockSplitStartupCursorSeed(renderer)

  try {
    renderer.footerHeight = 3

    await renderer.nativeScene!.driver.idle()
    expect(result.output()).toBe("")
    expect((renderer as any).pendingSplitFooterTransition).toBeNull()
    expect((renderer as any).forceFullRepaintRequested).toBe(true)
  } finally {
    unblockStartupSeed()
  }
})

test("CliRenderer entering split capture seeds from current terminal cursor row", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 20,
    screenMode: "main-screen",
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  renderer.footerHeight = 6
  renderer.setCursorPosition(1, 4, true)

  renderer.screenMode = "split-footer"
  renderer.externalOutputMode = "capture-stdout"

  expect((renderer as any).renderOffset).toBe(4)
})

test("CliRenderer entering split capture after a committed main-screen frame clears the old pinned footer surface", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  await result.renderOnce()

  renderer.externalOutputMode = "passthrough"
  renderer.screenMode = "main-screen"
  await result.renderOnce()

  renderer.screenMode = "split-footer"
  renderer.externalOutputMode = "capture-stdout"

  expect((renderer as any).pendingSplitFooterTransition).toEqual({
    mode: "clear-stale-rows",
    sourceTopLine: 7,
    sourceHeight: 4,
    targetTopLine: 2,
    targetHeight: 4,
    scrollLines: 0,
  })
  expect((renderer as any).forceFullRepaintRequested).toBe(true)
})

test("CliRenderer accepts startup CPR before the query write callback and setup completion", async () => {
  const result = await createTestRenderer({
    startupPending: true,
    startupCPR: "\x1b[5;1R\x1b[1;2R\x1b[1;3R",
    screenMode: "split-footer",
    footerHeight: 3,
    externalOutputMode: "capture-stdout",
  })
  renderer = result.renderer
  expect(renderer.getCursorState()).toMatchObject({ x: 1, y: 5 })
  expect(renderer.capabilities).toMatchObject({ explicit_width: true, scaled_text: true })
  renderer.root.add(new TextRenderable(renderer, { content: "FOOTER", height: 1 }))
  await result.renderOnce()
  expect(result.output()).toContain(ANSI.moveCursor(6, 1))
  expect(result.output()).toContain("FOOTER")
})

test("CliRenderer preserves input after a CPR received before managed startup queries are published", async () => {
  const heldQuery = Promise.withResolvers<() => void>()
  const stdout = new Writable({
    write: (_chunk, _encoding, callback) => heldQuery.resolve(callback),
  }) as NodeJS.WriteStream
  const session = new NativeSession(stdout)
  session.write(Buffer.from("\x1b[6n"))
  const result = await createRenderer({
    screenMode: "split-footer",
    footerHeight: 3,
    externalOutputMode: "capture-stdout",
    clock: new ManualClock(),
    stdout,
    nativeSession: session,
    bufferedOutput: "stdout",
    remote: true,
  })
  renderer = result.renderer
  const keypresses: string[] = []
  renderer.keyInput.on("keypress", (event) => keypresses.push(event.raw))
  const release = await heldQuery.promise
  const setup = renderer.setupTerminal()
  try {
    renderer.stdin.emit("data", Buffer.from("\x1b[7;1Rx"))
    expect(keypresses).toEqual(["x"])
  } finally {
    stdout._write = (_chunk, _encoding, callback) => callback()
    release()
    await setup
  }
})

test("CliRenderer reseeds split startup offset from non-home CPR capability response", async () => {
  const result = await createTestRenderer({
    startupPending: true,
    width: 40,
    height: 20,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  expect((renderer as any).renderOffset).toBe(1)

  ;(renderer as any).setPendingSplitFooterTransition({
    mode: "clear-stale-rows",
    sourceTopLine: 2,
    sourceHeight: 6,
    targetTopLine: 2,
    targetHeight: 4,
  })

  const keypresses: string[] = []
  renderer.keyInput.on("keypress", (event) => keypresses.push(event.raw))
  renderer.stdin.emit("data", Buffer.from("\x1b[0;1R"))
  expect((renderer as any).renderOffset).toBe(1)
  expect((renderer as any).pendingSplitStartupCursorSeed).toBe(true)
  expect((renderer as any).pendingSplitFooterTransition).not.toBeNull()
  renderer.stdin.emit("data", Buffer.from("\x1b[5;1R"))
  expect(keypresses).toEqual([])
  expect((renderer as any).renderOffset).toBe(5)
  expect((renderer as any).pendingSplitStartupCursorSeed).toBe(false)
  expect((renderer as any).pendingSplitFooterTransition).toBeNull()
})

test("CliRenderer does not consume standalone CPR replies during capability window", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 20,
    screenMode: "main-screen",
    externalOutputMode: "passthrough",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  const handled = (renderer as any).processCapabilitySequence("\x1b[7;11R", true)
  expect(handled).toBe(false)
})

test("CliRenderer preserves cursor seed rows when split starts with zero pinned offset", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 12,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  expect((renderer as any).renderOffset).toBe(0)

  renderer.footerHeight = 4

  expect((renderer as any).renderOffset).toBe(1)
})

test("CliRenderer split-footer commits only unpublished captured output chunks", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  ;(renderer as any).stdout.write("first\n")
  await result.renderOnce()

  ;(renderer as any).stdout.write("second\n")
  await result.renderOnce()

  await result.renderOnce()

  expect(result.output().match(/first|second/g)).toEqual(["first", "second"])
  expect(result.externalOutput.take().map(({ text }) => text)).toEqual(["first", "second"])
  expect(renderer.getNativeStats().nativeFrameCount).toBe(3)
})

test("CliRenderer split-footer routes captured output through snapshot native commit path", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  ;(renderer as any).stdout.write("line-1\nline-2\n")
  await result.renderOnce()

  expect(result.output().match(/line-\d/g)).toEqual(["line-1", "line-2"])
  expect(result.externalOutput.take().map(({ text }) => text)).toEqual(["line-1", "line-2"])
  expect((renderer as any).renderOffset).toBe(3)
})

test("CliRenderer split-footer native scrollback tracks wrapped tail state across commits", async () => {
  const result = await createTestRenderer({
    width: 4,
    height: 6,
    screenMode: "split-footer",
    footerHeight: 2,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  ;(renderer as any).stdout.write("abcd")
  await result.renderOnce()

  expect((renderer as any).renderOffset).toBe(1)

  ;(renderer as any).stdout.write("e")
  await result.renderOnce()

  expect((renderer as any).renderOffset).toBe(2)
})

test("CliRenderer flushes captured output when leaving split-footer for alternate-screen", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer

  ;(renderer as any).stdout.write("pending output\n")
  renderer.externalOutputMode = "passthrough"
  renderer.screenMode = "alternate-screen"

  await result.renderOnce()
  expect((renderer as any).externalOutputQueue.size).toBe(0)
  expect(result.output()).toContain("pending output")
  expect(result.output().indexOf("\x1b[?1049h")).toBeGreaterThan(result.output().indexOf("pending output"))
})

test("CliRenderer allows env to force main-screen mode", async () => {
  process.env.OTUI_USE_ALTERNATE_SCREEN = "false"
  clearEnvCache()

  const result = await createTestRenderer({
    screenMode: "alternate-screen",
  })

  renderer = result.renderer

  expect(renderer.screenMode).toBe("main-screen")
})

test("CliRenderer allows env to force alternate-screen mode", async () => {
  process.env.OTUI_USE_ALTERNATE_SCREEN = "true"
  clearEnvCache()

  const result = await createTestRenderer({
    screenMode: "main-screen",
  })

  renderer = result.renderer

  expect(renderer.screenMode).toBe("alternate-screen")
})

test("CliRenderer allows env to force passthrough stdout", async () => {
  process.env.OTUI_OVERRIDE_STDOUT = "false"
  clearEnvCache()

  const result = await createTestRenderer({
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
  })

  renderer = result.renderer

  expect(renderer.externalOutputMode).toBe("passthrough")
})

test("CliRenderer allows env to force captured stdout in split-footer", async () => {
  process.env.OTUI_OVERRIDE_STDOUT = "true"
  clearEnvCache()

  const result = await createTestRenderer({
    screenMode: "split-footer",
    externalOutputMode: "passthrough",
  })

  renderer = result.renderer

  expect(renderer.externalOutputMode).toBe("capture-stdout")
})
