import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"

import { ANSI } from "../ansi.js"
import { capture } from "../console.js"
import { clearEnvCache } from "../lib/env.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import { TextRenderable, type ScrollbackRenderContext } from "../index.js"

let renderer: TestRenderer | null = null
let previousShowConsole: string | undefined
let previousUseAlternateScreen: string | undefined
let previousOverrideStdout: string | undefined
let previousUseConsole: string | undefined

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
  ;(target as any).pendingSplitStartupCursorSeed = true
  ;(target as any).splitStartupSeedTimeoutId = setTimeout(() => {}, 10)

  return () => {
    if ((target as any).splitStartupSeedTimeoutId !== null) {
      clearTimeout((target as any).splitStartupSeedTimeoutId)
      ;(target as any).splitStartupSeedTimeoutId = null
    }

    ;(target as any).pendingSplitStartupCursorSeed = false
  }
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

afterEach(() => {
  renderer?.destroy()
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

test("CliRenderer uses its shared clock for debounced resize", async () => {
  const clock = new ManualClock()
  const result = await createTestRenderer({
    width: 40,
    height: 20,
    clock,
  })

  renderer = result.renderer
  ;(renderer as any).handleResize(70, 30)

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
  const lib = (renderer as any).lib
  const snapshotCommitSpy = spyOn(lib, "commitSplitFooterSnapshot")
  const originalCommitSplitFooterSnapshot = lib.commitSplitFooterSnapshot.bind(lib)
  let decodedOutput = ""

  lib.commitSplitFooterSnapshot = (...args: any[]) => {
    const snapshotBuffer = args[1]
    decodedOutput = new TextDecoder().decode(snapshotBuffer.getRealCharBytes(true))
    return originalCommitSplitFooterSnapshot(...args)
  }

  renderer.writeToScrollback(textScrollbackWrite("api-line-1\napi-line-2\n"))

  expect((renderer as any).externalOutputQueue.size).toBe(1)

  await result.renderOnce()

  expect(snapshotCommitSpy).toHaveBeenCalledTimes(1)
  expect(decodedOutput).toContain("api-line-1")
  expect(decodedOutput).toContain("api-line-2")

  lib.commitSplitFooterSnapshot = originalCommitSplitFooterSnapshot
  snapshotCommitSpy.mockRestore()
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
  const order: string[] = []
  const lib = (renderer as any).lib
  const originalCommitSplitFooterSnapshot = lib.commitSplitFooterSnapshot.bind(lib)

  lib.commitSplitFooterSnapshot = (...args: any[]) => {
    const snapshotBuffer = args[1]
    const content = new TextDecoder().decode(snapshotBuffer.getRealCharBytes(true)).trim()
    const startOnNewLine = args[3]
    order.push(`${startOnNewLine ? "api" : "stdout"}:${content}`)
    return originalCommitSplitFooterSnapshot(...args)
  }

  renderer.writeToScrollback(textScrollbackWrite("api-1\n"))
  ;(renderer as any).stdout.write("stdout-1\n")
  renderer.writeToScrollback(textScrollbackWrite("api-2\n"))

  await result.renderOnce()

  expect(order).toHaveLength(3)
  expect(order[0]).toContain("api:api-1")
  expect(order[1]).toContain("stdout:stdout-1")
  expect(order[2]).toContain("api:api-2")

  lib.commitSplitFooterSnapshot = originalCommitSplitFooterSnapshot
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
  ;(renderer as any)._terminalIsSetup = true
  const lib = (renderer as any).lib
  const splitCommitSpy = spyOn(lib, "commitSplitFooterSnapshot")
  const originalCommitSplitFooterSnapshot = lib.commitSplitFooterSnapshot.bind(lib)
  let committedOutput = ""

  lib.commitSplitFooterSnapshot = (...args: any[]) => {
    committedOutput = new TextDecoder().decode(args[1].getRealCharBytes(true))
    return originalCommitSplitFooterSnapshot(...args)
  }

  ;(renderer as any).stdout.write("pending output\n")

  expect((renderer as any).externalOutputQueue.size).toBe(1)

  renderer.externalOutputMode = "passthrough"

  expect(splitCommitSpy).toHaveBeenCalledTimes(1)
  expect(committedOutput).toContain("pending output")
  expect((renderer as any).externalOutputQueue.size).toBe(0)
  lib.commitSplitFooterSnapshot = originalCommitSplitFooterSnapshot
  splitCommitSpy.mockRestore()
})

test("CliRenderer drains all pending split commits before switching to passthrough", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true
  const lib = (renderer as any).lib
  const splitCommitSpy = spyOn(lib, "commitSplitFooterSnapshot")

  for (let i = 0; i < 10; i += 1) {
    ;(renderer as any).stdout.write(`pending-${i}\n`)
  }

  expect((renderer as any).externalOutputQueue.size).toBe(10)

  renderer.externalOutputMode = "passthrough"

  expect(splitCommitSpy).toHaveBeenCalledTimes(10)
  expect((renderer as any).externalOutputQueue.size).toBe(0)

  splitCommitSpy.mockRestore()
})

test("CliRenderer keeps stdout captured until a deferred passthrough switch drains", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true
  const unblockStartupSeed = blockSplitStartupCursorSeed(renderer)

  const committedOutput: string[] = []
  const lib = (renderer as any).lib
  const originalCommitSplitFooterSnapshot = lib.commitSplitFooterSnapshot.bind(lib)

  lib.commitSplitFooterSnapshot = (...args: any[]) => {
    committedOutput.push(new TextDecoder().decode(args[1].getRealCharBytes(true)))
    return originalCommitSplitFooterSnapshot(...args)
  }

  try {
    ;(renderer as any).stdout.write("older\n")
    renderer.externalOutputMode = "passthrough"

    expect((renderer as any).externalOutputMode).toBe("capture-stdout")

    ;(renderer as any).stdout.write("newer\n")

    expect((renderer as any).externalOutputQueue.size).toBe(2)

    unblockStartupSeed()
    await result.renderOnce()

    expect(committedOutput[0]).toContain("older")
    expect(committedOutput[1]).toContain("newer")
    expect((renderer as any).externalOutputQueue.size).toBe(0)
    expect(renderer.externalOutputMode).toBe("passthrough")
  } finally {
    unblockStartupSeed()
    lib.commitSplitFooterSnapshot = originalCommitSplitFooterSnapshot
  }
})

test("CliRenderer drains deferred passthrough output before leaving split-footer", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true
  const unblockStartupSeed = blockSplitStartupCursorSeed(renderer)

  const lib = (renderer as any).lib
  const splitCommitSpy = spyOn(lib, "commitSplitFooterSnapshot")

  try {
    ;(renderer as any).stdout.write("before-leave\n")
    renderer.externalOutputMode = "passthrough"

    expect((renderer as any).externalOutputMode).toBe("capture-stdout")

    renderer.screenMode = "main-screen"

    expect(splitCommitSpy).toHaveBeenCalledTimes(1)
    expect((renderer as any).externalOutputQueue.size).toBe(0)
    expect(renderer.externalOutputMode).toBe("passthrough")
    expect(renderer.screenMode).toBe("main-screen")
  } finally {
    unblockStartupSeed()
    splitCommitSpy.mockRestore()
  }
})

test("CliRenderer leaving split-footer aborts an in-flight startup CPR reply", async () => {
  const clock = new ManualClock()
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    clock,
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true
  ;(renderer as any).pendingSplitStartupCursorSeed = true
  ;(renderer as any).splitStartupSeedTimeoutId = clock.setTimeout(() => {}, 120)
  ;(renderer as any).capabilityTimeoutId = clock.setTimeout(() => {}, 5000)
  ;(renderer as any).updateStdinParserProtocolContext({ startupCursorCprActive: true })

  const keypresses: string[] = []
  renderer.keyInput.on("keypress", (event) => {
    keypresses.push(event.name)
  })

  try {
    renderer.stdin.emit("data", Buffer.from("\x1b["))

    ;(renderer as any).stdout.write("before-leave\n")
    renderer.externalOutputMode = "passthrough"

    expect((renderer as any).externalOutputMode).toBe("capture-stdout")

    renderer.screenMode = "main-screen"

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
  const lib = (renderer as any).lib
  const repaintSpy = spyOn(lib, "repaintSplitFooter")

  expect((renderer as any).externalOutputQueue.size).toBe(0)

  renderer.externalOutputMode = "passthrough"

  expect(repaintSpy).toHaveBeenCalledTimes(0)
  repaintSpy.mockRestore()
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
  ;(renderer as any)._terminalIsSetup = true
  ;(renderer as any).stdout.write("before-resize\n")

  const order: string[] = []
  const lib = (renderer as any).lib
  const originalCommitSplitFooterSnapshot = lib.commitSplitFooterSnapshot.bind(lib)
  const originalResizeRenderer = lib.resizeRenderer.bind(lib)

  lib.commitSplitFooterSnapshot = (...args: any[]) => {
    order.push("split-commit")
    return originalCommitSplitFooterSnapshot(...args)
  }
  lib.resizeRenderer = (...args: any[]) => {
    order.push("resize")
    return originalResizeRenderer(...args)
  }

  ;(renderer as any).processResize(60, 16)

  expect(order.indexOf("split-commit")).toBeGreaterThanOrEqual(0)
  expect(order.indexOf("resize")).toBeGreaterThanOrEqual(0)
  expect(order.indexOf("split-commit")).toBeLessThan(order.indexOf("resize"))

  lib.commitSplitFooterSnapshot = originalCommitSplitFooterSnapshot
  lib.resizeRenderer = originalResizeRenderer
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
  ;(renderer as any)._terminalIsSetup = true

  renderer.writeToScrollback(textScrollbackWrite("before-resize\n"))

  const order: string[] = []
  const lib = (renderer as any).lib
  const originalCommitSplitFooterSnapshot = lib.commitSplitFooterSnapshot.bind(lib)
  const originalResizeRenderer = lib.resizeRenderer.bind(lib)

  lib.commitSplitFooterSnapshot = (...args: any[]) => {
    order.push("split-commit")
    return originalCommitSplitFooterSnapshot(...args)
  }
  lib.resizeRenderer = (...args: any[]) => {
    order.push("resize")
    return originalResizeRenderer(...args)
  }

  ;(renderer as any).processResize(60, 16)

  expect(order.indexOf("split-commit")).toBeGreaterThanOrEqual(0)
  expect(order.indexOf("resize")).toBeGreaterThanOrEqual(0)
  expect(order.indexOf("split-commit")).toBeLessThan(order.indexOf("resize"))

  lib.commitSplitFooterSnapshot = originalCommitSplitFooterSnapshot
  lib.resizeRenderer = originalResizeRenderer
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
  ;(renderer as any)._terminalIsSetup = true
  renderer.writeToScrollback(textScrollbackWrite("before-replay\n"))

  const lib = (renderer as any).lib
  const resetSpy = spyOn(lib, "resetSplitScrollback")
  const writeOutSpy = spyOn(renderer as any, "writeOut")

  renderer.resetSplitFooterForReplay({ clearSavedLines: true })

  expect(resetSpy).toHaveBeenCalledWith((renderer as any).rendererPtr, 0, 6)
  expect(writeOutSpy).toHaveBeenCalledWith("\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H")
  expect((renderer as any).splitTailColumn).toBe(0)
  expect((renderer as any).pendingSplitFooterTransition).toBeNull()

  resetSpy.mockRestore()
  writeOutSpy.mockRestore()
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
  ;(renderer as any)._terminalIsSetup = true
  renderer.suspend()
  const writeOutSpy = spyOn(renderer as any, "writeOut")

  expect(() => renderer!.resetSplitFooterForReplay({ clearSavedLines: true })).toThrow(
    "resetSplitFooterForReplay requires an active terminal",
  )
  expect(writeOutSpy).not.toHaveBeenCalled()

  writeOutSpy.mockRestore()
})

test("CliRenderer reuses generic suspend/resume native helpers in split-footer mode", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true

  const suspendGenericSpy = spyOn((renderer as any).lib, "suspendRenderer")
  const resumeGenericSpy = spyOn((renderer as any).lib, "resumeRenderer")

  renderer.suspend()
  renderer.resume()

  expect(suspendGenericSpy).toHaveBeenCalledTimes(1)
  expect(resumeGenericSpy).toHaveBeenCalledTimes(1)

  suspendGenericSpy.mockRestore()
  resumeGenericSpy.mockRestore()
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
  ;(renderer as any)._terminalIsSetup = true

  renderer.start()
  renderer.suspend()

  const repaintSpy = spyOn((renderer as any).lib, "repaintSplitFooter")
  renderer.resume()
  renderer.pause()

  const lastCall = repaintSpy.mock.calls[repaintSpy.mock.calls.length - 1]
  expect(lastCall?.[2]).toBe(true)
  expect((renderer as any).forceFullRepaintRequested).toBe(false)

  repaintSpy.mockRestore()
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
  ;(renderer as any)._terminalIsSetup = true

  const lib = (renderer as any).lib
  const originalSetupTerminal = lib.setupTerminal.bind(lib)
  const originalResumeRenderer = lib.resumeRenderer.bind(lib)
  const setupTerminalCalls: any[][] = []
  let resumeRendererCalls = 0

  lib.setupTerminal = (...args: any[]) => {
    setupTerminalCalls.push(args)
  }
  lib.resumeRenderer = (...args: any[]) => {
    resumeRendererCalls += 1
    return originalResumeRenderer(...args)
  }

  try {
    renderer.suspend()
    const setupCallsAfterSuspend = setupTerminalCalls.length
    renderer.screenMode = "alternate-screen"

    expect(setupTerminalCalls.length).toBe(setupCallsAfterSuspend)

    renderer.resume()

    expect(setupTerminalCalls.length).toBe(setupCallsAfterSuspend + 1)
    expect(setupTerminalCalls.at(-1)?.[1]).toBe(true)
    expect(resumeRendererCalls).toBe(0)
  } finally {
    lib.setupTerminal = originalSetupTerminal
    lib.resumeRenderer = originalResumeRenderer
  }
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
  ;(renderer as any)._terminalIsSetup = true

  const lib = (renderer as any).lib
  const originalSetupTerminal = lib.setupTerminal.bind(lib)
  const originalResumeRenderer = lib.resumeRenderer.bind(lib)
  let setupTerminalCalls = 0
  let resumeRendererCalls = 0

  lib.setupTerminal = (...args: any[]) => {
    setupTerminalCalls += 1
    return originalSetupTerminal(...args)
  }
  lib.resumeRenderer = (...args: any[]) => {
    resumeRendererCalls += 1
    return originalResumeRenderer(...args)
  }

  try {
    renderer.suspend()
    renderer.screenMode = "alternate-screen"
    renderer.screenMode = "split-footer"
    renderer.resume()

    expect(setupTerminalCalls).toBe(0)
    expect(resumeRendererCalls).toBe(1)
  } finally {
    lib.setupTerminal = originalSetupTerminal
    lib.resumeRenderer = originalResumeRenderer
  }
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
  ;(renderer as any)._terminalIsSetup = true

  const splitCommitSpy = spyOn((renderer as any).lib, "commitSplitFooterSnapshot")

  renderer.suspend()
  ;(renderer as any).stdout.write("during-suspend\n")
  ;(renderer as any).processResize(60, 16)

  expect(splitCommitSpy).toHaveBeenCalledTimes(0)

  splitCommitSpy.mockRestore()
})

test("CliRenderer recomputes queued split tail after a blocked resize", async () => {
  const result = await createTestRenderer({
    width: 10,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true
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
  ;(renderer as any)._terminalIsSetup = true

  const splitCommitSpy = spyOn((renderer as any).lib, "commitSplitFooterSnapshot")

  renderer.suspend()
  const commitCallsAfterSuspend = splitCommitSpy.mock.calls.length
  ;(renderer as any).stdout.write("during-suspend\n")
  renderer.externalOutputMode = "passthrough"

  expect(splitCommitSpy.mock.calls.length).toBe(commitCallsAfterSuspend)
  expect((renderer as any).externalOutputQueue.size).toBe(1)
  expect((renderer as any).externalOutputMode).toBe("capture-stdout")

  renderer.resume()

  expect(splitCommitSpy.mock.calls.length).toBe(commitCallsAfterSuspend + 1)
  expect((renderer as any).externalOutputQueue.size).toBe(0)
  expect(renderer.externalOutputMode).toBe("passthrough")

  splitCommitSpy.mockRestore()
})

test("CliRenderer preserves captured split output until startup cursor seed unblocks passthrough switch", async () => {
  const clock = new ManualClock()
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
    clock,
  })

  renderer = result.renderer
  const lib = (renderer as any).lib
  const originalSetupTerminal = lib.setupTerminal.bind(lib)
  lib.setupTerminal = () => {}

  const splitCommitSpy = spyOn(lib, "commitSplitFooterSnapshot")

  try {
    await renderer.setupTerminal()

    ;(renderer as any).stdout.write("during-startup\n")
    renderer.externalOutputMode = "passthrough"

    expect(splitCommitSpy).toHaveBeenCalledTimes(0)
    expect((renderer as any).externalOutputQueue.size).toBe(1)
    expect((renderer as any).externalOutputMode).toBe("capture-stdout")

    clock.advance(120)

    expect(splitCommitSpy).toHaveBeenCalledTimes(1)
    expect((renderer as any).externalOutputQueue.size).toBe(0)
    expect(renderer.externalOutputMode).toBe("passthrough")
  } finally {
    lib.setupTerminal = originalSetupTerminal
    splitCommitSpy.mockRestore()
  }
})

test("CliRenderer flushes pending split output on suspend even when startup cursor seeding is pending", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true
  const unblockStartupSeed = blockSplitStartupCursorSeed(renderer)

  const order: string[] = []
  const lib = (renderer as any).lib
  const originalCommitSplitFooterSnapshot = lib.commitSplitFooterSnapshot.bind(lib)
  const originalSuspendRenderer = lib.suspendRenderer.bind(lib)

  lib.commitSplitFooterSnapshot = (...args: any[]) => {
    order.push("split-commit")
    return originalCommitSplitFooterSnapshot(...args)
  }
  lib.suspendRenderer = (...args: any[]) => {
    order.push("suspend")
    return originalSuspendRenderer(...args)
  }

  try {
    ;(renderer as any).stdout.write("before-suspend\n")
    renderer.suspend()

    expect(order.indexOf("split-commit")).toBeGreaterThanOrEqual(0)
    expect(order.indexOf("suspend")).toBeGreaterThanOrEqual(0)
    expect(order.indexOf("split-commit")).toBeLessThan(order.indexOf("suspend"))
    expect((renderer as any).externalOutputQueue.size).toBe(0)
  } finally {
    unblockStartupSeed()
    lib.commitSplitFooterSnapshot = originalCommitSplitFooterSnapshot
    lib.suspendRenderer = originalSuspendRenderer
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
  ;(renderer as any)._terminalIsSetup = true

  renderer.writeToScrollback(textScrollbackWrite("before-suspend\n"))

  const order: string[] = []
  const lib = (renderer as any).lib
  const originalCommitSplitFooterSnapshot = lib.commitSplitFooterSnapshot.bind(lib)
  const originalSuspendRenderer = lib.suspendRenderer.bind(lib)

  lib.commitSplitFooterSnapshot = (...args: any[]) => {
    order.push("split-commit")
    return originalCommitSplitFooterSnapshot(...args)
  }
  lib.suspendRenderer = (...args: any[]) => {
    order.push("suspend")
    return originalSuspendRenderer(...args)
  }

  renderer.suspend()

  expect(order.indexOf("split-commit")).toBeGreaterThanOrEqual(0)
  expect(order.indexOf("suspend")).toBeGreaterThanOrEqual(0)
  expect(order.indexOf("split-commit")).toBeLessThan(order.indexOf("suspend"))

  lib.commitSplitFooterSnapshot = originalCommitSplitFooterSnapshot
  lib.suspendRenderer = originalSuspendRenderer
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
  ;(renderer as any)._terminalIsSetup = true
  const clearCalls: number[] = []
  const lib = (renderer as any).lib
  const originalSetRenderOffset = lib.setRenderOffset.bind(lib)

  lib.setRenderOffset = (...args: any[]) => {
    if (args[1] === 0) {
      clearCalls.push(args[1])
    }
    return originalSetRenderOffset(...args)
  }

  renderer.screenMode = "main-screen"

  expect(clearCalls.length).toBeGreaterThanOrEqual(1)

  lib.setRenderOffset = originalSetRenderOffset
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
  ;(renderer as any)._terminalIsSetup = true
  ;(renderer as any).stdout.write("before-destroy\n")

  const order: string[] = []
  const lib = (renderer as any).lib
  const originalCommitSplitFooterSnapshot = lib.commitSplitFooterSnapshot.bind(lib)
  const originalSetRenderOffset = lib.setRenderOffset.bind(lib)
  const originalDestroyRenderer = lib.destroyRenderer.bind(lib)

  lib.commitSplitFooterSnapshot = (...args: any[]) => {
    order.push("split-commit")
    return originalCommitSplitFooterSnapshot(...args)
  }
  lib.setRenderOffset = (...args: any[]) => {
    if (args[1] === 0) {
      order.push("clear")
    }
    return originalSetRenderOffset(...args)
  }
  lib.destroyRenderer = (...args: any[]) => {
    order.push("destroy")
    return originalDestroyRenderer(...args)
  }

  renderer.destroy()

  expect(order).toEqual(["split-commit", "clear", "destroy"])

  lib.commitSplitFooterSnapshot = originalCommitSplitFooterSnapshot
  lib.setRenderOffset = originalSetRenderOffset
  lib.destroyRenderer = originalDestroyRenderer
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
  ;(renderer as any)._terminalIsSetup = true
  renderer.writeToScrollback(textScrollbackWrite("before-destroy\n"))

  const order: string[] = []
  const lib = (renderer as any).lib
  const originalCommitSplitFooterSnapshot = lib.commitSplitFooterSnapshot.bind(lib)
  const originalSetRenderOffset = lib.setRenderOffset.bind(lib)
  const originalDestroyRenderer = lib.destroyRenderer.bind(lib)

  lib.commitSplitFooterSnapshot = (...args: any[]) => {
    order.push("split-commit")
    return originalCommitSplitFooterSnapshot(...args)
  }
  lib.setRenderOffset = (...args: any[]) => {
    if (args[1] === 0) {
      order.push("clear")
    }
    return originalSetRenderOffset(...args)
  }
  lib.destroyRenderer = (...args: any[]) => {
    order.push("destroy")
    return originalDestroyRenderer(...args)
  }

  renderer.destroy()

  expect(order).toEqual(["split-commit", "clear", "destroy"])

  lib.commitSplitFooterSnapshot = originalCommitSplitFooterSnapshot
  lib.setRenderOffset = originalSetRenderOffset
  lib.destroyRenderer = originalDestroyRenderer
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
  ;(renderer as any)._terminalIsSetup = true
  ;(renderer as any).stdout.write("before-destroy\n")

  const order: string[] = []
  const lib = (renderer as any).lib
  const originalCommitSplitFooterSnapshot = lib.commitSplitFooterSnapshot.bind(lib)
  const originalSetRenderOffset = lib.setRenderOffset.bind(lib)
  const originalDestroyRenderer = lib.destroyRenderer.bind(lib)

  lib.commitSplitFooterSnapshot = (...args: any[]) => {
    order.push("split-commit")
    return originalCommitSplitFooterSnapshot(...args)
  }
  lib.setRenderOffset = (...args: any[]) => {
    if (args[1] === 0) {
      order.push("clear")
    }
    return originalSetRenderOffset(...args)
  }
  lib.destroyRenderer = (...args: any[]) => {
    order.push("destroy")
    return originalDestroyRenderer(...args)
  }

  renderer.destroy()

  expect(order).toEqual(["split-commit", "destroy"])

  lib.commitSplitFooterSnapshot = originalCommitSplitFooterSnapshot
  lib.setRenderOffset = originalSetRenderOffset
  lib.destroyRenderer = originalDestroyRenderer
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

test("CliRenderer split-footer renderNative does not call TypeScript flush path", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const flushSpy = spyOn(renderer as any, "flushStdoutCache")

  ;(renderer as any).stdout.write("pending output\n")
  await result.renderOnce()

  expect(flushSpy).toHaveBeenCalledTimes(0)
  flushSpy.mockRestore()
})

test("CliRenderer split-footer renderNative repaints footer frame with no pending commits", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const splitCommitSpy = spyOn((renderer as any).lib, "repaintSplitFooter")

  await result.renderOnce()

  expect(splitCommitSpy).toHaveBeenCalledTimes(1)
  expect(splitCommitSpy.mock.calls[0]?.[2]).toBe(false)

  splitCommitSpy.mockRestore()
})

test("CliRenderer split-footer forwards forced repaint flag to final pending commit", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const lib = (renderer as any).lib
  const originalCommitSplitFooterSnapshot = lib.commitSplitFooterSnapshot.bind(lib)
  const forceFlags: boolean[] = []

  lib.commitSplitFooterSnapshot = (...args: any[]) => {
    forceFlags.push(args[6] as boolean)
    return originalCommitSplitFooterSnapshot(...args)
  }

  ;(renderer as any).stdout.write("line-1\nline-2\n")
  ;(renderer as any).forceFullRepaintRequested = true

  await result.renderOnce()

  expect(forceFlags).toEqual([false, true])

  lib.commitSplitFooterSnapshot = originalCommitSplitFooterSnapshot
})

test("CliRenderer split-footer defers first native frame while startup cursor seed is pending", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const unblockStartupSeed = blockSplitStartupCursorSeed(renderer)

  const repaintSpy = spyOn((renderer as any).lib, "repaintSplitFooter")
  const commitSpy = spyOn((renderer as any).lib, "commitSplitFooterSnapshot")

  try {
    await result.renderOnce()

    expect(repaintSpy).toHaveBeenCalledTimes(0)
    expect(commitSpy).toHaveBeenCalledTimes(0)
  } finally {
    unblockStartupSeed()
    repaintSpy.mockRestore()
    commitSpy.mockRestore()
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
  ;(renderer as any)._terminalIsSetup = true

  const writeOutSpy = spyOn(renderer as any, "writeOut")
  const repaintSpy = spyOn((renderer as any).lib, "repaintSplitFooter")

  renderer.footerHeight = 8
  renderer.footerHeight = 3

  expect((renderer as any).renderOffset).toBe(1)
  expect(writeOutSpy).toHaveBeenCalledTimes(0)

  await result.renderOnce()

  expect(repaintSpy).toHaveBeenCalledTimes(1)
  expect(repaintSpy.mock.calls[0]?.[2]).toBe(true)

  writeOutSpy.mockRestore()
  repaintSpy.mockRestore()
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
  ;(renderer as any)._terminalIsSetup = true

  const repaintSpy = spyOn((renderer as any).lib, "repaintSplitFooter")

  renderer.footerHeight = 8
  renderer.footerHeight = 3

  await result.renderOnce()

  expect(repaintSpy).toHaveBeenCalledTimes(1)
  expect(repaintSpy.mock.calls[0]?.[1]).toBe(7)
  expect(repaintSpy.mock.calls[0]?.[2]).toBe(true)

  repaintSpy.mockRestore()
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
  ;(renderer as any)._terminalIsSetup = true

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
  ;(renderer as any)._terminalIsSetup = true

  for (let i = 0; i < 12; i += 1) {
    ;(renderer as any).stdout.write(`line-${i}\n`)
    await result.renderOnce()
  }

  expect((renderer as any).renderOffset).toBe(6)

  const writeOutSpy = spyOn(renderer as any, "writeOut")
  const repaintSpy = spyOn((renderer as any).lib, "repaintSplitFooter")

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
  expect(writeOutSpy).toHaveBeenCalledTimes(0)

  await result.renderOnce()

  expect((renderer as any).renderOffset).toBe(6)
  expect(repaintSpy).toHaveBeenCalledTimes(1)
  expect(repaintSpy.mock.calls[0]?.[1]).toBe(7)
  expect(repaintSpy.mock.calls[0]?.[2]).toBe(true)

  writeOutSpy.mockRestore()
  repaintSpy.mockRestore()
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
  ;(renderer as any)._terminalIsSetup = true

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
  ;(renderer as any)._terminalIsSetup = true

  const writeOutSpy = spyOn(renderer as any, "writeOut")

  renderer.footerHeight = 3

  expect(writeOutSpy).toHaveBeenCalledTimes(1)
  expect(writeOutSpy.mock.calls[0]?.[0]).toBe(`${ANSI.moveCursor(7, 1)}\x1b[2K`)

  writeOutSpy.mockRestore()
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
  ;(renderer as any)._terminalIsSetup = true

  const writeOutSpy = spyOn(renderer as any, "writeOut")

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

  expect(writeOutSpy).toHaveBeenCalledTimes(1)
  expect(writeOutSpy.mock.calls[0]?.[0]).toBe(ANSI.moveCursorAndClear(2, 1))
  expect((renderer as any).pendingSplitFooterTransition).toBeNull()

  writeOutSpy.mockRestore()
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
  ;(renderer as any)._terminalIsSetup = true

  const writeOutSpy = spyOn(renderer as any, "writeOut")

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

  expect(writeOutSpy).toHaveBeenCalledTimes(1)
  expect(writeOutSpy.mock.calls[0]?.[0]).toBe(ANSI.moveCursorAndClear(2, 1))

  writeOutSpy.mockRestore()
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
  ;(renderer as any)._terminalIsSetup = true

  const writeOutSpy = spyOn(renderer as any, "writeOut")

  renderer.footerHeight = 3

  result.resize(40, 12)

  expect(writeOutSpy).toHaveBeenCalledTimes(1)
  expect(writeOutSpy.mock.calls[0]?.[0]).toBe(ANSI.moveCursorAndClear(2, 1))

  writeOutSpy.mockRestore()
})

test("CliRenderer split-footer footerHeight changes do not queue deferred transitions while startup cursor seeding blocks the first frame", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 10,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true
  const unblockStartupSeed = blockSplitStartupCursorSeed(renderer)

  const setPendingTransitionSpy = spyOn((renderer as any).lib, "setPendingSplitFooterTransition")

  try {
    renderer.footerHeight = 3

    expect(setPendingTransitionSpy).toHaveBeenCalledTimes(0)
    expect((renderer as any).pendingSplitFooterTransition).toBeNull()
    expect((renderer as any).forceFullRepaintRequested).toBe(true)
  } finally {
    unblockStartupSeed()
    setPendingTransitionSpy.mockRestore()
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
  ;(renderer as any)._terminalIsSetup = true

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

test("CliRenderer reseeds split startup offset from non-home CPR capability response", async () => {
  const result = await createTestRenderer({
    width: 40,
    height: 20,
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  expect((renderer as any).renderOffset).toBe(1)

  const lib = (renderer as any).lib
  const originalGetCursorState = lib.getCursorState.bind(lib)
  ;(renderer as any).pendingSplitStartupCursorSeed = true
  ;(renderer as any).capabilityTimeoutId = setTimeout(() => {}, 10)
  ;(renderer as any).setPendingSplitFooterTransition({
    mode: "clear-stale-rows",
    sourceTopLine: 2,
    sourceHeight: 6,
    targetTopLine: 2,
    targetHeight: 4,
  })

  try {
    lib.getCursorState = () => ({
      ...originalGetCursorState((renderer as any).rendererPtr),
      y: 5,
    })

    const handled = (renderer as any).processCapabilitySequence("\x1b[5;1R", true)

    expect(handled).toBe(false)
    expect((renderer as any).renderOffset).toBe(5)
    expect((renderer as any).pendingSplitStartupCursorSeed).toBe(false)
    expect((renderer as any).pendingSplitFooterTransition).toBeNull()
  } finally {
    clearTimeout((renderer as any).capabilityTimeoutId)
    ;(renderer as any).capabilityTimeoutId = null
    lib.getCursorState = originalGetCursorState
  }
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
  ;(renderer as any).pendingSplitStartupCursorSeed = false
  ;(renderer as any).capabilityTimeoutId = setTimeout(() => {}, 10)

  const handled = (renderer as any).processCapabilitySequence("\x1b[7;11R", true)
  expect(handled).toBe(false)

  clearTimeout((renderer as any).capabilityTimeoutId)
  ;(renderer as any).capabilityTimeoutId = null
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
  const lib = (renderer as any).lib
  const snapshotCommitSpy = spyOn(lib, "commitSplitFooterSnapshot")
  const fullRenderSpy = spyOn(lib, "repaintSplitFooter")

  const committedPayloads: string[] = []
  const originalCommitSplitFooterSnapshot = lib.commitSplitFooterSnapshot.bind(lib)
  lib.commitSplitFooterSnapshot = (...args: any[]) => {
    committedPayloads.push(new TextDecoder().decode(args[1].getRealCharBytes(true)).trim())
    return originalCommitSplitFooterSnapshot(...args)
  }

  ;(renderer as any).stdout.write("first\n")
  await result.renderOnce()

  ;(renderer as any).stdout.write("second\n")
  await result.renderOnce()

  await result.renderOnce()

  expect(snapshotCommitSpy).toHaveBeenCalledTimes(2)
  expect(committedPayloads[0]).toContain("first")
  expect(committedPayloads[1]).toContain("second")

  expect(fullRenderSpy).toHaveBeenCalledTimes(1)
  expect(fullRenderSpy.mock.calls[0]?.[2]).toBe(false)

  lib.commitSplitFooterSnapshot = originalCommitSplitFooterSnapshot
  snapshotCommitSpy.mockRestore()
  fullRenderSpy.mockRestore()
})

test("CliRenderer split-footer routes captured output through snapshot native commit path", async () => {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    footerHeight: 6,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  renderer = result.renderer
  const lib = (renderer as any).lib
  const splitCommitSpy = spyOn(lib, "commitSplitFooterSnapshot")
  const originalCommitSplitFooterSnapshot = lib.commitSplitFooterSnapshot.bind(lib)
  const payloads: string[] = []

  lib.commitSplitFooterSnapshot = (...args: any[]) => {
    payloads.push(new TextDecoder().decode(args[1].getRealCharBytes(true)).trim())
    return originalCommitSplitFooterSnapshot(...args)
  }

  ;(renderer as any).stdout.write("line-1\nline-2\n")
  await result.renderOnce()

  expect(splitCommitSpy).toHaveBeenCalledTimes(2)
  expect(payloads[0]).toContain("line-1")
  expect(payloads[1]).toContain("line-2")
  expect((renderer as any).renderOffset).toBe(3)

  lib.commitSplitFooterSnapshot = originalCommitSplitFooterSnapshot
  splitCommitSpy.mockRestore()
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
    useThread: false,
  })

  renderer = result.renderer
  ;(renderer as any)._terminalIsSetup = true

  ;(renderer as any).stdout.write("pending output\n")
  renderer.externalOutputMode = "passthrough"
  renderer.screenMode = "alternate-screen"

  expect((renderer as any).externalOutputQueue.size).toBe(0)
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
