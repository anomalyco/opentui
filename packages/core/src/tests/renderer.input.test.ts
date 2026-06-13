import { test, expect, beforeEach, afterEach, describe } from "bun:test"
import { decodePasteBytes } from "../lib/paste.js"
import { nonAlphanumericKeys, type KeyEventType, type ParsedKey } from "../lib/parse.keypress.js"
import { type KeyEvent } from "../lib/KeyHandler.js"
import { Buffer } from "node:buffer"
import { Renderable, type RenderableOptions } from "../Renderable.js"
import { createTestRenderer, type TestRenderer, type TestRendererOptions } from "../testing/test-renderer.js"
import { createTerminalCapabilities } from "../testing/terminal-capabilities.js"
import { ManualClock } from "../testing/manual-clock.js"
import type { RenderContext } from "../types.js"
import type { RenderLib } from "../zig.js"

let currentRenderer: TestRenderer
let kittyRenderer: TestRenderer
let mockProcessCapabilityResponse: any
let mockGetTerminalCapabilities: RenderLib["getTerminalCapabilities"]
let currentClock: ManualClock
let kittyClock: ManualClock

beforeEach(async () => {
  currentClock = new ManualClock()
  kittyClock = new ManualClock()
  ;({ renderer: currentRenderer } = await createTestRenderer({ clock: currentClock }))
  ;({ renderer: kittyRenderer } = await createTestRenderer({ kittyKeyboard: true, clock: kittyClock }))

  // Mock native capability functions to avoid interfering with the test terminal
  // @ts-expect-error - mocking for test
  mockProcessCapabilityResponse = currentRenderer.lib.processCapabilityResponse
  // @ts-expect-error - mocking for test
  mockGetTerminalCapabilities = currentRenderer.lib.getTerminalCapabilities

  // @ts-expect-error - mocking for test
  currentRenderer.lib.processCapabilityResponse = () => {}
  // @ts-expect-error - mocking for test
  currentRenderer.lib.getTerminalCapabilities = () => createTerminalCapabilities()

  // @ts-expect-error - mocking for test
  kittyRenderer.lib.processCapabilityResponse = () => {}
  // @ts-expect-error - mocking for test
  kittyRenderer.lib.getTerminalCapabilities = () => createTerminalCapabilities()
})

afterEach(() => {
  // Restore mocks
  // @ts-expect-error - restore mock
  currentRenderer.lib.processCapabilityResponse = mockProcessCapabilityResponse
  // @ts-expect-error - restore mock
  currentRenderer.lib.getTerminalCapabilities = mockGetTerminalCapabilities
  // @ts-expect-error - restore mock
  kittyRenderer.lib.processCapabilityResponse = mockProcessCapabilityResponse
  // @ts-expect-error - restore mock
  kittyRenderer.lib.getTerminalCapabilities = mockGetTerminalCapabilities

  currentRenderer.destroy()
  kittyRenderer.destroy()
})

async function triggerInput(sequence: string): Promise<KeyEvent> {
  return new Promise((resolve) => {
    const onKeypress = (parsedKey: KeyEvent) => {
      currentRenderer.keyInput.removeListener("keypress", onKeypress)
      resolve(parsedKey)
    }

    currentRenderer.keyInput.once("keypress", onKeypress)

    currentRenderer.stdin.emit("data", Buffer.from(sequence))
    advanceCurrentClock()
  })
}

async function triggerKittyInput(sequence: string): Promise<KeyEvent> {
  return new Promise((resolve) => {
    const onKeypress = (parsedKey: KeyEvent) => {
      kittyRenderer.keyInput.removeListener("keypress", onKeypress)
      kittyRenderer.keyInput.removeListener("keyrelease", onKeypress)
      resolve(parsedKey)
    }

    kittyRenderer.keyInput.on("keypress", onKeypress)
    kittyRenderer.keyInput.on("keyrelease", onKeypress)

    kittyRenderer.stdin.emit("data", Buffer.from(sequence))
    advanceKittyClock()
  })
}

function advanceCurrentClock(ms: number = 20): void {
  currentClock.advance(ms)
}

function advanceKittyClock(ms: number = 20): void {
  kittyClock.advance(ms)
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
}

class MouseTarget extends Renderable {
  constructor(context: RenderContext, options: RenderableOptions) {
    super(context, options)
  }
}

function advanceClock(clock: ManualClock, ms: number = 20): void {
  clock.advance(ms)
}

async function createRoutingRenderer(options: Partial<TestRendererOptions> = {}): Promise<{
  renderer: TestRenderer
  renderOnce: () => Promise<void>
  resize: (width: number, height: number) => void
  clock: ManualClock
}> {
  const clock = new ManualClock()
  const { renderer, renderOnce, resize } = await createTestRenderer({
    width: 40,
    height: 20,
    useMouse: true,
    clock,
    ...options,
  })

  return { renderer, renderOnce, resize, clock }
}

async function createThemeQueryRenderer(): Promise<{
  renderer: TestRenderer
  queryThemeColorsCalls: { count: number }
  clock: ManualClock
}> {
  const clock = new ManualClock()
  const stdout = {
    isTTY: true,
    columns: 80,
    rows: 24,
    write: () => true,
    getColorDepth: () => 24,
  } as any

  const { renderer } = await createTestRenderer({
    clock,
    stdout,
    useThread: false,
  })

  // @ts-expect-error - mocking for test
  renderer.lib.processCapabilityResponse = () => {}
  // @ts-expect-error - mocking for test
  renderer.lib.getTerminalCapabilities = () => createTerminalCapabilities()

  const queryThemeColorsCalls = { count: 0 }
  // @ts-expect-error - mocking for test
  renderer.lib.queryThemeColors = () => {
    queryThemeColorsCalls.count += 1
  }

  return { renderer, queryThemeColorsCalls, clock }
}

test("basic letters via keyInput events", async () => {
  const result = await triggerInput("a")
  expect(result).toMatchObject({
    name: "a",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "a",
    eventType: "press",
  })

  const resultShift = await triggerInput("A")
  expect(resultShift).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: false,
    shift: true,
    option: false,
    number: false,
    sequence: "A",
    raw: "A",
  })
})

test("numbers via keyInput events", async () => {
  const result = await triggerInput("1")
  expect(result).toMatchObject({
    eventType: "press",
    name: "1",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: true,
    sequence: "1",
    raw: "1",
  })
})

test("special keys via keyInput events", async () => {
  const resultReturn = await triggerInput("\r")
  expect(resultReturn).toMatchObject({
    eventType: "press",
    name: "return",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\r",
    raw: "\r",
  })

  const resultEnter = await triggerInput("\n")
  expect(resultEnter).toMatchObject({
    eventType: "press",
    name: "linefeed",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\n",
    raw: "\n",
  })

  const resultTab = await triggerInput("\t")
  expect(resultTab).toMatchObject({
    eventType: "press",
    name: "tab",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\t",
    raw: "\t",
  })

  const resultBackspace = await triggerInput("\b")
  expect(resultBackspace).toMatchObject({
    eventType: "press",
    name: "backspace",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\b",
    raw: "\b",
  })

  const resultEscape = await triggerInput("\x1b")
  expect(resultEscape).toMatchObject({
    name: "escape",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b",
    raw: "\x1b",
    eventType: "press",
  })

  const resultSpace = await triggerInput(" ")
  expect(resultSpace).toMatchObject({
    eventType: "press",
    name: "space",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: " ",
    raw: " ",
  })
})

test("ctrl+letter combinations via keyInput events", async () => {
  const resultCtrlA = await triggerInput("\x01")
  expect(resultCtrlA).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x01",
    raw: "\x01",
  })

  const resultCtrlZ = await triggerInput("\x1a")
  expect(resultCtrlZ).toMatchObject({
    eventType: "press",
    name: "z",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1a",
    raw: "\x1a",
  })
})

test("meta+character combinations via keyInput events", async () => {
  const resultMetaA = await triggerInput("\x1ba")
  expect(resultMetaA).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: true,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1ba",
    raw: "\x1ba",
  })

  const resultMetaShiftA = await triggerInput("\x1bA")
  expect(resultMetaShiftA).toMatchObject({
    eventType: "press",
    name: "A",
    ctrl: false,
    meta: true,
    shift: true,
    option: false,
    number: false,
    sequence: "\x1bA",
    raw: "\x1bA",
  })
})

test("function keys via keyInput events", async () => {
  const resultF1 = await triggerInput("\x1bOP")
  expect(resultF1).toMatchObject({
    eventType: "press",
    name: "f1",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1bOP",
    raw: "\x1bOP",
    code: "OP",
  })

  const resultF1Alt = await triggerInput("\x1b[11~")
  expect(resultF1Alt).toMatchObject({
    eventType: "press",
    name: "f1",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[11~",
    raw: "\x1b[11~",
    code: "[11~",
  })

  const resultF12 = await triggerInput("\x1b[24~")
  expect(resultF12).toMatchObject({
    eventType: "press",
    name: "f12",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[24~",
    raw: "\x1b[24~",
    code: "[24~",
  })
})

test("arrow keys via keyInput events", async () => {
  const resultUp = await triggerInput("\x1b[A")
  expect(resultUp).toMatchObject({
    eventType: "press",
    name: "up",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[A",
    raw: "\x1b[A",
    code: "[A",
  })

  const resultDown = await triggerInput("\x1b[B")
  expect(resultDown).toMatchObject({
    eventType: "press",
    name: "down",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[B",
    raw: "\x1b[B",
    code: "[B",
  })

  const resultRight = await triggerInput("\x1b[C")
  expect(resultRight).toMatchObject({
    eventType: "press",
    name: "right",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[C",
    raw: "\x1b[C",
    code: "[C",
  })

  const resultLeft = await triggerInput("\x1b[D")
  expect(resultLeft).toMatchObject({
    eventType: "press",
    name: "left",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[D",
    raw: "\x1b[D",
    code: "[D",
  })
})

test("navigation keys via keyInput events", async () => {
  const resultHome = await triggerInput("\x1b[H")
  expect(resultHome).toMatchObject({
    eventType: "press",
    name: "home",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[H",
    raw: "\x1b[H",
    code: "[H",
  })

  const resultEnd = await triggerInput("\x1b[F")
  expect(resultEnd).toMatchObject({
    eventType: "press",
    name: "end",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[F",
    raw: "\x1b[F",
    code: "[F",
  })

  const resultPageUp = await triggerInput("\x1b[5~")
  expect(resultPageUp).toMatchObject({
    eventType: "press",
    name: "pageup",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[5~",
    raw: "\x1b[5~",
    code: "[5~",
  })

  const resultPageDown = await triggerInput("\x1b[6~")
  expect(resultPageDown).toMatchObject({
    eventType: "press",
    name: "pagedown",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[6~",
    raw: "\x1b[6~",
    code: "[6~",
  })
})

test("modifier combinations via keyInput events", async () => {
  const resultShiftUp = await triggerInput("\x1b[1;2A")
  expect(resultShiftUp).toMatchObject({
    eventType: "press",
    name: "up",
    ctrl: false,
    meta: false,
    shift: true,
    option: false,
    number: false,
    sequence: "\x1b[1;2A",
    raw: "\x1b[1;2A",
    code: "[A",
  })

  const resultMetaAltUp = await triggerInput("\x1b[1;4A")
  expect(resultMetaAltUp).toMatchObject({
    eventType: "press",
    name: "up",
    ctrl: false,
    meta: true,
    shift: true,
    option: true,
    number: false,
    sequence: "\x1b[1;4A",
    raw: "\x1b[1;4A",
    code: "[A",
  })

  const resultAllModsUp = await triggerInput("\x1b[1;8A")
  expect(resultAllModsUp).toMatchObject({
    eventType: "press",
    name: "up",
    ctrl: true,
    meta: true,
    shift: true,
    option: true,
    number: false,
    sequence: "\x1b[1;8A",
    raw: "\x1b[1;8A",
    code: "[A",
  })
})

test("delete key via keyInput events", async () => {
  const resultDelete = await triggerInput("\x1b[3~")
  expect(resultDelete).toMatchObject({
    eventType: "press",
    name: "delete",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[3~",
    raw: "\x1b[3~",
    code: "[3~",
  })
})

test("Buffer input via keyInput events", async () => {
  // Test with Buffer input by emitting buffer data directly
  const result = await new Promise<KeyEvent>((resolve) => {
    const onKeypress = (parsedKey: KeyEvent) => {
      currentRenderer.keyInput.removeListener("keypress", onKeypress)
      resolve(parsedKey)
    }

    currentRenderer.keyInput.on("keypress", onKeypress)
    currentRenderer.stdin.emit("data", Buffer.from("a"))
  })

  expect(result).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "a",
  })
})

test("special characters via keyInput events", async () => {
  const resultExclamation = await triggerInput("!")
  expect(resultExclamation).toMatchObject({
    eventType: "press",
    name: "!",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "!",
    raw: "!",
  })

  const resultAt = await triggerInput("@")
  expect(resultAt).toMatchObject({
    eventType: "press",
    name: "@",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "@",
    raw: "@",
  })
})

test("meta space and escape combinations via keyInput events", async () => {
  const resultMetaSpace = await triggerInput("\x1b ")
  expect(resultMetaSpace).toMatchObject({
    eventType: "press",
    name: "space",
    ctrl: false,
    meta: true,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b ",
    raw: "\x1b ",
  })

  const resultDoubleEscape = await triggerInput("\x1b\x1b")
  expect(resultDoubleEscape).toMatchObject({
    eventType: "press",
    name: "escape",
    ctrl: false,
    meta: true,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b\x1b",
    raw: "\x1b\x1b",
  })
})

// ===== KITTY KEYBOARD PROTOCOL INTEGRATION TESTS =====

test("Kitty keyboard basic key via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[97u")
  expect(result).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "\x1b[97u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })
})

test("Kitty keyboard shift+a via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[97:65;2u")
  expect(result).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: false,
    shift: true,
    option: false,
    number: false,
    sequence: "A",
    raw: "\x1b[97:65;2u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })
})

test("Kitty keyboard ctrl+a via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[97;5u")
  expect(result).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "\x1b[97;5u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })
})

test("Kitty keyboard Ctrl+C with alternate base layout still exits the renderer", async () => {
  const clock = new ManualClock()
  const { renderer } = await createTestRenderer({ kittyKeyboard: true, clock })

  try {
    // Simulate Ctrl+C from a non-Latin IME. Kitty reports the produced
    // character (`ㅊ`) plus the base-layout key (`c`).
    const keypress = new Promise<KeyEvent>((resolve) => {
      renderer.keyInput.once("keypress", resolve)
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[12618::99;5u"))
    clock.advance(20)

    const event = await keypress
    expect(event).toMatchObject({
      name: "ㅊ",
      ctrl: true,
      baseCode: 99,
    })

    await new Promise<void>((resolve) => process.nextTick(resolve))
    expect(renderer.isDestroyed).toBe(true)
  } finally {
    if (!renderer.isDestroyed) {
      renderer.destroy()
    }
  }
})

test("Kitty keyboard alt+a via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[97;3u")
  expect(result).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: true,
    shift: false,
    option: true,
    number: false,
    sequence: "a",
    raw: "\x1b[97;3u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })
})

test("Kitty keyboard function key via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[57364u")
  expect(result).toMatchObject({
    eventType: "press",
    name: "f1",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[57364u",
    raw: "\x1b[57364u",
    code: "[57364u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })
})

test("Kitty keyboard arrow key via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[57352u")
  expect(result).toMatchObject({
    eventType: "press",
    name: "up",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[57352u",
    raw: "\x1b[57352u",
    code: "[57352u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })
})

test("Kitty keyboard shift+space via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[32;2u")
  expect(result).toMatchObject({
    eventType: "press",
    name: "space",
    ctrl: false,
    meta: false,
    shift: true,
    option: false,
    number: false,
    sequence: " ",
    raw: "\x1b[32;2u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })
})

test("Kitty keyboard ctrl+space via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[32;5u")
  expect(result).toMatchObject({
    eventType: "press",
    name: "space",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: " ",
    raw: "\x1b[32;5u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })
})

test("Kitty keyboard event types via keyInput events", async () => {
  // Press event (explicit)
  const pressExplicit = await triggerKittyInput("\x1b[97;1:1u")
  expect(pressExplicit).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "\x1b[97;1:1u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })

  // Press event (default when no event type specified)
  const pressDefault = await triggerKittyInput("\x1b[97u")
  expect(pressDefault).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "\x1b[97u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })

  // Press event (modifier without event type)
  const pressWithModifier = await triggerKittyInput("\x1b[97;5u") // Ctrl+a
  expect(pressWithModifier).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "\x1b[97;5u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })

  // Repeat event (emitted as press with repeated=true)
  const repeat = await triggerKittyInput("\x1b[97;1:2u")
  expect(repeat).toMatchObject({
    eventType: "press",
    repeated: true,
    name: "a",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "\x1b[97;1:2u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })

  // Release event
  const release = await triggerKittyInput("\x1b[97;1:3u")
  expect(release).toMatchObject({
    eventType: "release",
    name: "a",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "\x1b[97;1:3u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })

  // Repeat event with modifier (emitted as press with repeated=true)
  const repeatWithCtrl = await triggerKittyInput("\x1b[97;5:2u")
  expect(repeatWithCtrl).toMatchObject({
    eventType: "press",
    repeated: true,
    name: "a",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "\x1b[97;5:2u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })

  // Release event with modifier
  const releaseWithShift = await triggerKittyInput("\x1b[97;2:3u")
  expect(releaseWithShift).toMatchObject({
    eventType: "release",
    name: "a",
    ctrl: false,
    meta: false,
    shift: true,
    option: false,
    number: false,
    sequence: "A",
    raw: "\x1b[97;2:3u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })
})

test("Kitty keyboard with text via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[97;1;97u")
  expect(result).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "\x1b[97;1;97u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })
})

test("Kitty keyboard ctrl+shift+a via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[97;6u")
  expect(result).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: true,
    meta: false,
    shift: true,
    option: false,
    number: false,
    sequence: "A",
    raw: "\x1b[97;6u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })
})

test("Kitty keyboard alt+shift+a via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[97;4u")
  expect(result).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: true,
    shift: true,
    option: true,
    number: false,
    sequence: "A",
    raw: "\x1b[97;4u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })
})

test("Kitty keyboard super+a via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[97;9u") // modifier 9 - 1 = 8 = super
  expect(result).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "\x1b[97;9u",
    super: true,
    hyper: false,
    capsLock: false,
    numLock: false,
  })
})

test("Kitty keyboard hyper+a via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[97;17u") // modifier 17 - 1 = 16 = hyper
  expect(result).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "\x1b[97;17u",
    super: false,
    hyper: true,
    capsLock: false,
    numLock: false,
  })
})

test("Kitty keyboard caps lock via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[97;65u") // modifier 65 - 1 = 64 = caps lock
  expect(result).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "\x1b[97;65u",
    super: false,
    hyper: false,
    capsLock: true,
    numLock: false,
  })
})

test("Kitty keyboard num lock via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[97;129u") // modifier 129 - 1 = 128 = num lock
  expect(result).toMatchObject({
    eventType: "press",
    name: "a",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "a",
    raw: "\x1b[97;129u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: true,
  })
})

test("Kitty keyboard unicode character via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[233u") // é
  expect(result).toMatchObject({
    eventType: "press",
    name: "é",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "é",
    raw: "\x1b[233u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })
})

test("Kitty keyboard emoji via keyInput events", async () => {
  const result = await triggerKittyInput("\x1b[128512u") // 😀
  expect(result).toMatchObject({
    eventType: "press",
    name: "😀",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "😀",
    raw: "\x1b[128512u",
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  })
})

test("Kitty keyboard keypad keys via keyInput events", async () => {
  const printableKeys = [
    ["\x1b[57399u", "kp0", "0"],
    ["\x1b[57400u", "kp1", "1"],
    ["\x1b[57401u", "kp2", "2"],
    ["\x1b[57402u", "kp3", "3"],
    ["\x1b[57403u", "kp4", "4"],
    ["\x1b[57404u", "kp5", "5"],
    ["\x1b[57405u", "kp6", "6"],
    ["\x1b[57406u", "kp7", "7"],
    ["\x1b[57407u", "kp8", "8"],
    ["\x1b[57408u", "kp9", "9"],
    ["\x1b[57409u", "kpdecimal", "."],
    ["\x1b[57410u", "kpdivide", "/"],
    ["\x1b[57411u", "kpmultiply", "*"],
    ["\x1b[57412u", "kpminus", "-"],
    ["\x1b[57413u", "kpplus", "+"],
    ["\x1b[57415u", "kpequal", "="],
    ["\x1b[57416u", "kpseparator", ","],
  ] as const

  for (const [sequence, name, text] of printableKeys) {
    const key = await triggerKittyInput(sequence)
    expect(key).toMatchObject({ name, sequence: text })
  }

  const kpEnter = await triggerKittyInput("\x1b[57414u")
  expect(kpEnter?.name).toBe("kpenter")
  expect(kpEnter?.sequence).toBe("\x1b[57414u")

  const kpleft = await triggerKittyInput("\x1b[57417u")
  expect(kpleft?.name).toBe("kpleft")
  expect(kpleft?.sequence).toBe("\x1b[57417u")

  const explicitText = await triggerKittyInput("\x1b[57400;1;120u")
  expect(explicitText).toMatchObject({ name: "kp1", sequence: "x" })
})

test("Kitty keyboard media keys via keyInput events", async () => {
  const play = await triggerKittyInput("\x1b[57428u")
  expect(play?.name).toBe("mediaplay")

  const volumeUp = await triggerKittyInput("\x1b[57439u")
  expect(volumeUp?.name).toBe("volumeup")
})

test("Kitty keyboard modifier keys via keyInput events", async () => {
  const leftShift = await triggerKittyInput("\x1b[57441u")
  expect(leftShift?.name).toBe("leftshift")
  expect(leftShift?.eventType).toBe("press")

  const rightCtrl = await triggerKittyInput("\x1b[57448u")
  expect(rightCtrl?.name).toBe("rightctrl")
  expect(rightCtrl?.eventType).toBe("press")
})

test("Kitty keyboard function keys with event types via keyInput events", async () => {
  // F1 press
  const f1Press = await triggerKittyInput("\x1b[57364u")
  expect(f1Press.name).toBe("f1")
  expect(f1Press.eventType).toBe("press")
  expect(f1Press.super ?? false).toBe(false)
  expect(f1Press.hyper ?? false).toBe(false)
  expect(f1Press.capsLock ?? false).toBe(false)
  expect(f1Press.numLock ?? false).toBe(false)

  // F1 repeat (emitted as press with repeated=true)
  const f1Repeat = await triggerKittyInput("\x1b[57364;1:2u")
  expect(f1Repeat.name).toBe("f1")
  expect(f1Repeat.eventType).toBe("press")
  expect((f1Repeat as any).repeated).toBe(true)
  expect(f1Repeat.super ?? false).toBe(false)
  expect(f1Repeat.hyper ?? false).toBe(false)
  expect(f1Repeat.capsLock ?? false).toBe(false)
  expect(f1Repeat.numLock ?? false).toBe(false)

  // F1 release
  const f1Release = await triggerKittyInput("\x1b[57364;1:3u")
  expect(f1Release.name).toBe("f1")
  expect(f1Release.eventType).toBe("release")
  expect(f1Release.super ?? false).toBe(false)
  expect(f1Release.hyper ?? false).toBe(false)
  expect(f1Release.capsLock ?? false).toBe(false)
  expect(f1Release.numLock ?? false).toBe(false)
})

test("Kitty keyboard arrow keys with event types via keyInput events", async () => {
  // Up arrow press
  const upPress = await triggerKittyInput("\x1b[57352u")
  expect(upPress.name).toBe("up")
  expect(upPress.eventType).toBe("press")
  expect(upPress.super ?? false).toBe(false)
  expect(upPress.hyper ?? false).toBe(false)
  expect(upPress.capsLock ?? false).toBe(false)
  expect(upPress.numLock ?? false).toBe(false)

  // Up arrow repeat with Ctrl (emitted as press with repeated=true)
  const upRepeatCtrl = await triggerKittyInput("\x1b[57352;5:2u")
  expect(upRepeatCtrl.name).toBe("up")
  expect(upRepeatCtrl.ctrl).toBe(true)
  expect(upRepeatCtrl.eventType).toBe("press")
  expect((upRepeatCtrl as any).repeated).toBe(true)
  expect(upRepeatCtrl.super).toBe(false)
  expect(upRepeatCtrl.hyper).toBe(false)
  expect(upRepeatCtrl.capsLock).toBe(false)
  expect(upRepeatCtrl.numLock).toBe(false)

  // Down arrow release
  const downRelease = await triggerKittyInput("\x1b[57353;1:3u")
  expect(downRelease.name).toBe("down")
  expect(downRelease.eventType).toBe("release")
  expect(downRelease.super).toBe(false)
  expect(downRelease.hyper).toBe(false)
  expect(downRelease.capsLock).toBe(false)
  expect(downRelease.numLock).toBe(false)
})

// ===== MISSING UNIT TEST CASES INTEGRATION TESTS =====

test("high byte buffer handling via keyInput events", async () => {
  // Test with Buffer input by emitting buffer data directly
  const result = await new Promise<KeyEvent>((resolve) => {
    const onKeypress = (parsedKey: KeyEvent) => {
      currentRenderer.keyInput.removeListener("keypress", onKeypress)
      resolve(parsedKey)
    }

    currentRenderer.keyInput.on("keypress", onKeypress)
    // 128 + 32 = 160, should become \x1b + " "
    currentRenderer.stdin.emit("data", Buffer.from([160]))
    advanceCurrentClock()
  })

  expect(result).toMatchObject({
    eventType: "press",
    name: "space",
    ctrl: false,
    meta: true,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b ",
    raw: "\x1b ",
  })
})

test("high byte UTF-8 lead byte does not stall indefinitely", async () => {
  const result = await new Promise<KeyEvent>((resolve, reject) => {
    const timeout = setTimeout(() => {
      currentRenderer.keyInput.removeListener("keypress", onKeypress)
      reject(new Error("timed out waiting for high-byte keypress"))
    }, 300)

    const onKeypress = (parsedKey: KeyEvent) => {
      clearTimeout(timeout)
      currentRenderer.keyInput.removeListener("keypress", onKeypress)
      resolve(parsedKey)
    }

    currentRenderer.keyInput.on("keypress", onKeypress)
    // 128 + 105 = 233, should become \x1b + "i"
    currentRenderer.stdin.emit("data", Buffer.from([233]))
    advanceCurrentClock()
  })

  expect(result).toMatchObject({
    eventType: "press",
    name: "i",
    ctrl: false,
    meta: true,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1bi",
    raw: "\x1bi",
  })
})

test("empty input via keyInput events", async () => {
  const result = await triggerInput("")
  expect(result).toMatchObject({
    eventType: "press",
    name: "",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "",
    raw: "",
  })
})

test("rxvt style arrow keys with modifiers via keyInput events", async () => {
  const resultShiftUp = await triggerInput("\x1b[a")
  expect(resultShiftUp).toMatchObject({
    eventType: "press",
    name: "up",
    ctrl: false,
    meta: false,
    shift: true,
    option: false,
    number: false,
    sequence: "\x1b[a",
    raw: "\x1b[a",
    code: "[a",
  })

  const resultShiftInsert = await triggerInput("\x1b[2$")
  expect(resultShiftInsert).toMatchObject({
    eventType: "press",
    name: "insert",
    ctrl: false,
    meta: false,
    shift: true,
    option: false,
    number: false,
    sequence: "\x1b[2$",
    raw: "\x1b[2$",
    code: "[2$",
  })
})

test("ctrl modifier keys via keyInput events", async () => {
  const resultCtrlUp = await triggerInput("\x1bOa")
  expect(resultCtrlUp).toMatchObject({
    eventType: "press",
    name: "up",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1bOa",
    raw: "\x1bOa",
    code: "Oa",
  })

  const resultCtrlInsert = await triggerInput("\x1b[2^")
  expect(resultCtrlInsert).toMatchObject({
    eventType: "press",
    name: "insert",
    ctrl: true,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "\x1b[2^",
    raw: "\x1b[2^",
    code: "[2^",
  })
})

test("modifier bit calculations and meta/alt relationship via keyInput events", async () => {
  // Super modifier is bit 8, so modifier value 9 = 8 + 1 (base)
  const superOnly = await triggerInput("\x1b[1;9A")
  expect(superOnly.name).toBe("up")
  expect(superOnly.meta).toBe(false)
  expect(superOnly.ctrl).toBe(false)
  expect(superOnly.shift).toBe(false)
  expect(superOnly.option).toBe(false)
  expect((superOnly as any).super).toBe(true)
  expect((superOnly as any).hyper).toBe(false)

  // Alt/Option modifier is bit 1 (value 2), so modifier value 3 = 2 + 1
  const altOnly = await triggerInput("\x1b[1;3A")
  expect(altOnly.name).toBe("up")
  expect(altOnly.meta).toBe(true) // Alt sets meta flag (by design)
  expect(altOnly.option).toBe(true)
  expect(altOnly.ctrl).toBe(false)
  expect(altOnly.shift).toBe(false)

  // Ctrl modifier is bit 2 (value 4), so modifier value 5 = 4 + 1
  const ctrlOnly = await triggerInput("\x1b[1;5A")
  expect(ctrlOnly.name).toBe("up")
  expect(ctrlOnly.ctrl).toBe(true)
  expect(ctrlOnly.meta).toBe(false)
  expect(ctrlOnly.shift).toBe(false)
  expect(ctrlOnly.option).toBe(false)

  // Shift modifier is bit 0 (value 1), so modifier value 2 = 1 + 1
  const shiftOnly = await triggerInput("\x1b[1;2A")
  expect(shiftOnly.name).toBe("up")
  expect(shiftOnly.shift).toBe(true)
  expect(shiftOnly.ctrl).toBe(false)
  expect(shiftOnly.meta).toBe(false)
  expect(shiftOnly.option).toBe(false)

  // Combined modifiers
  // Ctrl+Super = 4 + 8 = 12, so modifier value 13 = 12 + 1
  const ctrlSuper = await triggerInput("\x1b[1;13A")
  expect(ctrlSuper.name).toBe("up")
  expect(ctrlSuper.ctrl).toBe(true)
  expect(ctrlSuper.meta).toBe(false)
  expect(ctrlSuper.shift).toBe(false)
  expect(ctrlSuper.option).toBe(false)
  expect((ctrlSuper as any).super).toBe(true)
  expect((ctrlSuper as any).hyper).toBe(false)

  // Shift+Alt = 1 + 2 = 3, so modifier value 4 = 3 + 1
  const shiftAlt = await triggerInput("\x1b[1;4A")
  expect(shiftAlt.name).toBe("up")
  expect(shiftAlt.shift).toBe(true)
  expect(shiftAlt.option).toBe(true)
  expect(shiftAlt.meta).toBe(true) // Alt sets meta flag
  expect(shiftAlt.ctrl).toBe(false)

  // All modifiers: Shift(1) + Alt(2) + Ctrl(4) + Meta(8) = 15, so modifier value 16 = 15 + 1
  const allMods = await triggerInput("\x1b[1;16A")
  expect(allMods.name).toBe("up")
  expect(allMods.shift).toBe(true)
  expect(allMods.option).toBe(true)
  expect(allMods.ctrl).toBe(true)
  expect(allMods.meta).toBe(true)
})

test("modifier combinations with function keys via keyInput events", async () => {
  // Ctrl+F1
  const ctrlF1 = await triggerInput("\x1b[11;5~")
  expect(ctrlF1.name).toBe("f1")
  expect(ctrlF1.ctrl).toBe(true)
  expect(ctrlF1.meta).toBe(false)
  expect(ctrlF1.eventType).toBe("press")

  // Super+F1
  const superF1 = await triggerInput("\x1b[11;9~")
  expect(superF1.name).toBe("f1")
  expect(superF1.meta).toBe(false)
  expect(superF1.ctrl).toBe(false)
  expect(superF1.super).toBe(true)
  expect(superF1.hyper).toBe(false)
  expect(superF1.eventType).toBe("press")

  // Shift+Ctrl+F1
  const shiftCtrlF1 = await triggerInput("\x1b[11;6~")
  expect(shiftCtrlF1.name).toBe("f1")
  expect(shiftCtrlF1.shift).toBe(true)
  expect(shiftCtrlF1.ctrl).toBe(true)
  expect(shiftCtrlF1.meta).toBe(false)
  expect(shiftCtrlF1.eventType).toBe("press")
})

test("regular parsing always defaults to press event type via keyInput events", async () => {
  // Test various regular key sequences to ensure they all default to "press"
  const keys = [
    "a",
    "A",
    "1",
    "!",
    "\t",
    "\r",
    "\n",
    " ",
    "\x1b",
    "\x01", // Ctrl+A
    "\x1ba", // Alt+A
    "\x1b[A", // Up arrow
    "\x1b[11~", // F1
    "\x1b[1;2A", // Shift+Up
    "\x1b[3~", // Delete
  ]

  for (const keySeq of keys) {
    const result = await triggerInput(keySeq)
    expect(result.eventType).toBe("press")
  }

  // Test with Buffer input too
  const bufResult = await new Promise<KeyEvent>((resolve) => {
    const onKeypress = (parsedKey: KeyEvent) => {
      currentRenderer.keyInput.removeListener("keypress", onKeypress)
      resolve(parsedKey)
    }

    currentRenderer.keyInput.once("keypress", onKeypress)
    currentRenderer.stdin.emit("data", Buffer.from("x"))
  })
  expect(bufResult.eventType).toBe("press")
})

test("nonAlphanumericKeys export validation", async () => {
  expect(Array.isArray(nonAlphanumericKeys)).toBe(true)
  expect(nonAlphanumericKeys.length).toBeGreaterThan(0)
  expect(nonAlphanumericKeys).toContain("up")
  expect(nonAlphanumericKeys).toContain("down")
  expect(nonAlphanumericKeys).toContain("f1")
  expect(nonAlphanumericKeys).toContain("backspace")
  expect(nonAlphanumericKeys).toContain("tab")
  expect(nonAlphanumericKeys).toContain("left")
  expect(nonAlphanumericKeys).toContain("right")
})

test("ParsedKey type structure validation", async () => {
  const key: ParsedKey = {
    name: "test",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: "test",
    raw: "test",
    number: false,
    eventType: "press",
    source: "raw",
  }

  expect(key).toHaveProperty("name")
  expect(key).toHaveProperty("ctrl")
  expect(key).toHaveProperty("meta")
  expect(key).toHaveProperty("shift")
  expect(key).toHaveProperty("option")
  expect(key).toHaveProperty("sequence")
  expect(key).toHaveProperty("raw")
  expect(key).toHaveProperty("number")

  // Test that a key with code property works
  const keyWithCode: ParsedKey = {
    name: "up",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: "\x1b[A",
    raw: "\x1b[A",
    number: false,
    code: "[A",
    eventType: "press",
    source: "raw",
  }

  expect(keyWithCode).toHaveProperty("code")
  expect(keyWithCode.code).toBe("[A")
})

test("KeyEventType type validation", async () => {
  // Test that KeyEventType only allows valid values
  const validEventTypes: KeyEventType[] = ["press", "repeat", "release"]

  for (const eventType of validEventTypes) {
    // This should compile without errors
    const mockKey: ParsedKey = {
      name: "test",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      sequence: "test",
      raw: "test",
      number: false,
      eventType: eventType,
      source: "raw",
    }
    expect(mockKey.eventType).toBe(eventType)
  }
})

// ===== CAPABILITY RESPONSE HANDLING TESTS =====

test("capability responses should not trigger keypress events", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // Send various capability responses - none should trigger keypresses
  currentRenderer.stdin.emit("data", Buffer.from("\x1b[?1016;2$y")) // DECRPM
  currentRenderer.stdin.emit("data", Buffer.from("\x1b[1;2R")) // CPR
  currentRenderer.stdin.emit("data", Buffer.from("\x1b[?62;c")) // DA1

  // Wait for stdin parser timeout
  advanceCurrentClock()

  expect(keypresses).toHaveLength(0)
})

test("capability response followed by keypress", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // Send capability response followed by 'a'
  currentRenderer.stdin.emit("data", Buffer.from("\x1b[?1016;2$ya"))

  // Wait for processing
  advanceCurrentClock()

  expect(keypresses).toHaveLength(1)
  expect(keypresses[0].name).toBe("a")
})

test("partial SGR mouse stays pending on timeout, completes when rest arrives", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // Incomplete SGR mouse sequence; stays pending (not flushed on timeout).
  currentRenderer.stdin.emit("data", Buffer.from("\x1b[<35;20"))

  // Wait past native stdin parser timeout (20ms)
  advanceCurrentClock()
  expect(keypresses).toHaveLength(0)

  // Completing the mouse sequence should not trigger keypress either
  currentRenderer.stdin.emit("data", Buffer.from(";5m"))
  advanceCurrentClock()
  expect(keypresses).toHaveLength(0)

  // Normal key input still works after
  currentRenderer.stdin.emit("data", Buffer.from("x"))
  advanceCurrentClock()

  expect(keypresses).toHaveLength(1)
  expect(keypresses[0].name).toBe("x")
})

test("partial OSC flushed on timeout should not block later text", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  currentRenderer.stdin.emit("data", Buffer.from("\x1b]52;c;"))
  advanceCurrentClock()
  expect(keypresses).toHaveLength(0)

  currentRenderer.stdin.emit("data", Buffer.from("abc"))
  advanceCurrentClock()

  expect(keypresses).toHaveLength(3)
  expect(keypresses.map((event) => event.name)).toEqual(["a", "b", "c"])
})

test("partial OSC flushed on timeout should not block later escape sequences", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  currentRenderer.stdin.emit("data", Buffer.from("\x1b]52;c;"))
  advanceCurrentClock()
  expect(keypresses).toHaveLength(0)

  currentRenderer.stdin.emit("data", Buffer.from("\x1b[A"))
  advanceCurrentClock()

  expect(keypresses).toHaveLength(1)
  expect(keypresses[0].name).toBe("up")
})

test("incomplete mouse input resets the timeout when more bytes arrive", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  currentRenderer.stdin.emit("data", Buffer.from("\x1b[<35;20;"))
  advanceCurrentClock(19)
  currentRenderer.stdin.emit("data", Buffer.from("5"))
  advanceCurrentClock(19)

  expect(keypresses).toHaveLength(0)

  currentRenderer.stdin.emit("data", Buffer.from("m"))
  advanceCurrentClock()

  expect(keypresses).toHaveLength(0)
})

test("chunked XTVersion response should not trigger keypresses", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // Send XTVersion in chunks (chunks arrive quickly, within stdin parser timeout)
  currentRenderer.stdin.emit("data", Buffer.from("\x1bP>|kit"))
  currentRenderer.stdin.emit("data", Buffer.from("ty(0.40"))
  currentRenderer.stdin.emit("data", Buffer.from(".1)\x1b\\"))

  // Wait for stdin parser to process
  advanceCurrentClock()

  expect(keypresses).toHaveLength(0)
})

test("chunked XTVersion followed by keypress", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // Send XTVersion in chunks followed by 'x'
  currentRenderer.stdin.emit("data", Buffer.from("\x1bP>|ghostty"))
  currentRenderer.stdin.emit("data", Buffer.from(" 1.1.3\x1b\\x"))

  // Wait for processing
  advanceCurrentClock()

  expect(keypresses).toHaveLength(1)
  expect(keypresses[0].name).toBe("x")
})

test("chunked Kitty graphics response should not trigger keypresses", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // Send Kitty graphics response in chunks (arriving quickly)
  currentRenderer.stdin.emit("data", Buffer.from("\x1b_Gi=1;"))
  currentRenderer.stdin.emit("data", Buffer.from("EINVAL:"))
  currentRenderer.stdin.emit("data", Buffer.from("Zero width/height not allowed\x1b\\"))

  // Wait for processing
  advanceCurrentClock()

  expect(keypresses).toHaveLength(0)
})

test("multiple DECRPM responses in sequence", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // Simulate multiple DECRPM responses arriving together
  currentRenderer.stdin.emit("data", Buffer.from("\x1b[?1016;2$y\x1b[?2027;0$y\x1b[?2031;2$y"))
  advanceCurrentClock()

  expect(keypresses).toHaveLength(0)
})

test("OSC 10/11 fallback sets initial theme mode once both colors arrive", () => {
  const themeModes: string[] = []
  currentRenderer.on("theme_mode", (mode) => {
    themeModes.push(mode)
  })

  currentRenderer.stdin.emit("data", Buffer.from("\x1b]10;#ffffff\x07"))
  advanceCurrentClock()

  expect(currentRenderer.themeMode).toBeNull()
  expect(themeModes).toEqual([])

  currentRenderer.stdin.emit("data", Buffer.from("\x1b]11;#000000\x07"))
  advanceCurrentClock()

  expect(currentRenderer.themeMode).toBe("dark")
  expect(themeModes).toEqual(["dark"])
})

test("CSI 997 does not set theme mode directly and triggers an OSC refresh query", async () => {
  const { renderer, queryThemeColorsCalls, clock } = await createThemeQueryRenderer()
  const themeModes: string[] = []
  renderer.on("theme_mode", (mode) => {
    themeModes.push(mode)
  })

  renderer.stdin.emit("data", Buffer.from("\x1b[?997;2n"))
  advanceClock(clock)

  expect(renderer.themeMode).toBeNull()
  expect(themeModes).toEqual([])
  expect(queryThemeColorsCalls.count).toBe(1)

  renderer.destroy()
})

test("CSI 997 does not query theme colors again while a refresh is already pending", async () => {
  const { renderer, queryThemeColorsCalls, clock } = await createThemeQueryRenderer()

  renderer.stdin.emit("data", Buffer.from("\x1b[?997;1n"))
  advanceClock(clock)

  expect(queryThemeColorsCalls.count).toBe(1)

  renderer.stdin.emit("data", Buffer.from("\x1b[?997;2n"))
  advanceClock(clock)

  expect(queryThemeColorsCalls.count).toBe(1)

  renderer.destroy()
})

test("conflicting CSI 997 before initial OSC replies does not override the OSC-derived mode", () => {
  const themeModes: string[] = []
  currentRenderer.on("theme_mode", (mode) => {
    themeModes.push(mode)
  })

  currentRenderer.stdin.emit("data", Buffer.from("\x1b[?997;2n"))
  advanceCurrentClock()

  currentRenderer.stdin.emit("data", Buffer.from("\x1b]10;#ffffff\x07"))
  currentRenderer.stdin.emit("data", Buffer.from("\x1b]11;#000000\x07"))
  advanceCurrentClock()

  expect(currentRenderer.themeMode).toBe("dark")
  expect(themeModes).toEqual(["dark"])
})

test("CSI 997 refreshes theme mode only after fresh OSC 10 and 11 replies arrive", async () => {
  const { renderer, queryThemeColorsCalls, clock } = await createThemeQueryRenderer()
  const themeModes: string[] = []
  renderer.on("theme_mode", (mode) => {
    themeModes.push(mode)
  })

  renderer.stdin.emit("data", Buffer.from("\x1b]10;#ffffff\x07"))
  renderer.stdin.emit("data", Buffer.from("\x1b]11;#000000\x07"))
  advanceClock(clock)

  expect(renderer.themeMode).toBe("dark")
  expect(themeModes).toEqual(["dark"])

  renderer.stdin.emit("data", Buffer.from("\x1b[?997;2n"))
  advanceClock(clock)

  expect(renderer.themeMode).toBe("dark")
  expect(themeModes).toEqual(["dark"])
  expect(queryThemeColorsCalls.count).toBe(1)

  renderer.stdin.emit("data", Buffer.from("\x1b]10;#000000\x07"))
  advanceClock(clock)

  expect(renderer.themeMode).toBe("dark")
  expect(themeModes).toEqual(["dark"])

  renderer.stdin.emit("data", Buffer.from("\x1b]11;#ffffff\x07"))
  advanceClock(clock)

  expect(renderer.themeMode).toBe("light")
  expect(themeModes).toEqual(["dark", "light"])

  renderer.destroy()
})

test("CSI 997 refresh timeout restores background override state without changing theme mode", async () => {
  const { renderer, queryThemeColorsCalls, clock } = await createThemeQueryRenderer()
  const themeModes: string[] = []
  renderer.on("theme_mode", (mode) => {
    themeModes.push(mode)
  })

  renderer.stdin.emit("data", Buffer.from("\x1b]10;#ffffff\x07"))
  renderer.stdin.emit("data", Buffer.from("\x1b]11;#000000\x07"))
  advanceClock(clock)

  renderer.stdin.emit("data", Buffer.from("\x1b[?997;2n"))
  advanceClock(clock, 249)

  expect(renderer.themeMode).toBe("dark")
  expect(themeModes).toEqual(["dark"])
  expect(queryThemeColorsCalls.count).toBe(1)

  advanceClock(clock, 1)
  await flushMicrotasks()

  expect(renderer.themeMode).toBe("dark")
  expect(themeModes).toEqual(["dark"])

  renderer.destroy()
})

test("CSI 997 refresh with the same OSC-derived mode does not emit twice", () => {
  const themeModes: string[] = []
  currentRenderer.on("theme_mode", (mode) => {
    themeModes.push(mode)
  })

  currentRenderer.stdin.emit("data", Buffer.from("\x1b]10;#ffffff\x07"))
  currentRenderer.stdin.emit("data", Buffer.from("\x1b]11;#000000\x07"))
  advanceCurrentClock()

  currentRenderer.stdin.emit("data", Buffer.from("\x1b[?997;1n"))
  advanceCurrentClock()

  currentRenderer.stdin.emit("data", Buffer.from("\x1b]10;#ffffff\x07"))
  currentRenderer.stdin.emit("data", Buffer.from("\x1b]11;#000000\x07"))
  advanceCurrentClock()

  expect(currentRenderer.themeMode).toBe("dark")
  expect(themeModes).toEqual(["dark"])
})

test("multiple CSI 997 responses while a refresh is pending do not emit early", () => {
  const themeModes: string[] = []
  currentRenderer.on("theme_mode", (mode) => {
    themeModes.push(mode)
  })

  currentRenderer.stdin.emit("data", Buffer.from("\x1b]10;#ffffff\x07"))
  currentRenderer.stdin.emit("data", Buffer.from("\x1b]11;#000000\x07"))
  advanceCurrentClock()

  currentRenderer.stdin.emit("data", Buffer.from("\x1b[?997;1n"))
  currentRenderer.stdin.emit("data", Buffer.from("\x1b[?997;2n"))
  advanceCurrentClock()

  currentRenderer.stdin.emit("data", Buffer.from("\x1b]10;#000000\x07"))
  advanceCurrentClock()

  expect(currentRenderer.themeMode).toBe("dark")
  expect(themeModes).toEqual(["dark"])

  currentRenderer.stdin.emit("data", Buffer.from("\x1b]11;#ffffff\x07"))
  advanceCurrentClock()

  expect(currentRenderer.themeMode).toBe("light")
  expect(themeModes).toEqual(["dark", "light"])
})

test("waitForThemeMode resolves when initial theme mode is set", async () => {
  const themeModePromise = currentRenderer.waitForThemeMode(500)

  currentRenderer.stdin.emit("data", Buffer.from("\x1b]10;#ffffff\x07"))
  currentRenderer.stdin.emit("data", Buffer.from("\x1b]11;#000000\x07"))
  advanceCurrentClock()

  await expect(themeModePromise).resolves.toBe("dark")
})

test("waitForThemeMode resolves immediately when theme mode is already set", async () => {
  currentRenderer.stdin.emit("data", Buffer.from("\x1b]10;#000000\x07"))
  currentRenderer.stdin.emit("data", Buffer.from("\x1b]11;#ffffff\x07"))
  advanceCurrentClock()

  await expect(currentRenderer.waitForThemeMode()).resolves.toBe("light")
})

test("waitForThemeMode ignores CSI 997 until OSC-derived mode is available", async () => {
  let resolvedThemeMode: string | null | undefined

  currentRenderer.waitForThemeMode(500).then((mode) => {
    resolvedThemeMode = mode
  })

  currentRenderer.stdin.emit("data", Buffer.from("\x1b[?997;2n"))
  advanceCurrentClock(249)
  await flushMicrotasks()

  expect(resolvedThemeMode).toBeUndefined()

  currentRenderer.stdin.emit("data", Buffer.from("\x1b]10;#000000\x07"))
  currentRenderer.stdin.emit("data", Buffer.from("\x1b]11;#ffffff\x07"))
  advanceCurrentClock(1)
  await flushMicrotasks()

  expect(resolvedThemeMode).toBe("light")
})

test("waitForThemeMode returns current theme mode after the default timeout", async () => {
  let resolvedThemeMode: string | null | undefined

  currentRenderer.waitForThemeMode().then((mode) => {
    resolvedThemeMode = mode
  })

  advanceCurrentClock(999)
  await flushMicrotasks()
  expect(resolvedThemeMode).toBeUndefined()

  advanceCurrentClock(1)
  await flushMicrotasks()
  expect(resolvedThemeMode).toBeNull()
})

test("waitForThemeMode resolves with current theme mode when renderer is destroyed", async () => {
  const themeModePromise = currentRenderer.waitForThemeMode(500)

  currentRenderer.destroy()

  await expect(themeModePromise).resolves.toBeNull()
})

test("pixel resolution response should not trigger keypress", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // Mark as waiting for resolution
  // @ts-expect-error - accessing private property for testing
  currentRenderer.waitingForPixelResolution = true

  currentRenderer.stdin.emit("data", Buffer.from("\x1b[4;720;1280t"))
  advanceCurrentClock()

  expect(keypresses).toHaveLength(0)
  expect(currentRenderer.resolution).toEqual({ width: 1280, height: 720 })
})

test("chunked pixel resolution response", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // @ts-expect-error - accessing private property for testing
  currentRenderer.waitingForPixelResolution = true

  // Send pixel resolution in chunks (arriving quickly)
  currentRenderer.stdin.emit("data", Buffer.from("\x1b[4;72"))
  currentRenderer.stdin.emit("data", Buffer.from("0;1280t"))

  // Wait for processing
  advanceCurrentClock()

  expect(keypresses).toHaveLength(0)
  expect(currentRenderer.resolution).toEqual({ width: 1280, height: 720 })
})

test("kitty full capability response arriving in realistic chunks", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // Simulate how kitty might send its full response in a few chunks
  currentRenderer.stdin.emit("data", Buffer.from("\x1b[?1016;2$y\x1b[?2027;0$y"))
  advanceCurrentClock(1)

  currentRenderer.stdin.emit("data", Buffer.from("\x1b[?2031;2$y\x1b[?1004;1$y\x1b[1;2R\x1b[1;3R"))
  advanceCurrentClock(1)

  currentRenderer.stdin.emit("data", Buffer.from("\x1bP>|kitty(0."))
  advanceCurrentClock(1)

  currentRenderer.stdin.emit("data", Buffer.from("40.1)\x1b\\\x1b_Gi=1;OK\x1b\\"))
  advanceCurrentClock(1)

  currentRenderer.stdin.emit("data", Buffer.from("\x1b[?62;c"))

  // Wait for processing
  advanceCurrentClock()

  expect(keypresses).toHaveLength(0)
})

test("capability response interleaved with user input", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // User types 'h'
  currentRenderer.stdin.emit("data", Buffer.from("h"))

  // Capability response arrives
  currentRenderer.stdin.emit("data", Buffer.from("\x1b[?1016;2$y"))

  // User types 'e'
  currentRenderer.stdin.emit("data", Buffer.from("e"))

  // More capability responses
  currentRenderer.stdin.emit("data", Buffer.from("\x1bP>|kitty(0.40.1)\x1b\\"))

  // User types 'llo'
  currentRenderer.stdin.emit("data", Buffer.from("llo"))

  // Wait for processing
  advanceCurrentClock()

  // Should only have user keypresses
  expect(keypresses).toHaveLength(5)
  expect(keypresses.map((k) => k.name)).toEqual(["h", "e", "l", "l", "o"])
})

test("delayed capability responses should be processed", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // User input first
  currentRenderer.stdin.emit("data", Buffer.from("abc"))

  // Late capability response (e.g., terminal was slow to respond)
  advanceCurrentClock(50)
  currentRenderer.stdin.emit("data", Buffer.from("\x1b[?2027;2$y"))

  // Wait for processing
  advanceCurrentClock()

  // Should have user input but not capability
  expect(keypresses).toHaveLength(3)
  expect(keypresses.map((k) => k.name)).toEqual(["a", "b", "c"])
})

test("delayed explicit-width CPR stays in response path while setup probe is active", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // @ts-expect-error - accessing private helper for test coverage
  currentRenderer.updateStdinParserProtocolContext({ explicitWidthCprActive: true })

  currentRenderer.stdin.emit("data", Buffer.from("\x1b[1;2"))
  advanceCurrentClock()
  currentRenderer.stdin.emit("data", Buffer.from("R"))
  advanceCurrentClock()

  expect(keypresses).toHaveLength(0)
})

test("delayed DECRPM stays in response path while capability probing is active", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // @ts-expect-error - accessing private helper for test coverage
  currentRenderer.updateStdinParserProtocolContext({ privateCapabilityRepliesActive: true })

  currentRenderer.stdin.emit("data", Buffer.from("\x1b[?1016;2$"))
  advanceCurrentClock()
  currentRenderer.stdin.emit("data", Buffer.from("y"))
  advanceCurrentClock()

  expect(keypresses).toHaveLength(0)
})

test("delayed pixel resolution response stays in response path while query is active", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // @ts-expect-error - accessing private property for testing
  currentRenderer.waitingForPixelResolution = true
  // @ts-expect-error - accessing private helper for test coverage
  currentRenderer.updateStdinParserProtocolContext({ pixelResolutionQueryActive: true })

  currentRenderer.stdin.emit("data", Buffer.from("\x1b[4;1080;192"))
  advanceCurrentClock()
  currentRenderer.stdin.emit("data", Buffer.from("0t"))
  advanceCurrentClock()

  expect(keypresses).toHaveLength(0)
  expect(currentRenderer.resolution).toEqual({ width: 1920, height: 1080 })
})

test("vscode minimal capability response", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // VSCode often sends just one DECRPM
  currentRenderer.stdin.emit("data", Buffer.from("\x1b[?1016;2$y"))
  advanceCurrentClock()

  expect(keypresses).toHaveLength(0)
})

test("alacritty capability response sequence", async () => {
  const keypresses: KeyEvent[] = []
  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  // Simulate alacritty's response pattern
  const alacrittyResponse =
    "\x1b[?1016;0$y\x1b[?2027;0$y\x1b[?2031;0$y\x1b[?1004;2$y\x1b[?2004;2$y\x1b[?2026;2$y\x1b[1;1R\x1b[1;1R\x1b[?0u\x1b[?6c"
  currentRenderer.stdin.emit("data", Buffer.from(alacrittyResponse))
  advanceCurrentClock()

  expect(keypresses).toHaveLength(0)
})

test("focus and blur events", async () => {
  const events: string[] = []

  currentRenderer.on("focus", () => {
    events.push("focus")
  })

  currentRenderer.on("blur", () => {
    events.push("blur")
  })

  currentRenderer.stdin.emit("data", Buffer.from("\x1b[I"))
  advanceCurrentClock()

  currentRenderer.stdin.emit("data", Buffer.from("\x1b[O"))
  advanceCurrentClock()

  expect(events).toEqual(["focus", "blur"])
})

test("focus events should not trigger keypress", async () => {
  const keypresses: KeyEvent[] = []
  const focusEvents: string[] = []

  currentRenderer.keyInput.on("keypress", (event) => {
    keypresses.push(event)
  })

  currentRenderer.on("focus", () => {
    focusEvents.push("focus")
  })

  currentRenderer.on("blur", () => {
    focusEvents.push("blur")
  })

  currentRenderer.stdin.emit("data", Buffer.from("\x1b[I"))
  advanceCurrentClock()
  currentRenderer.stdin.emit("data", Buffer.from("\x1b[O"))
  advanceCurrentClock()

  expect(focusEvents).toEqual(["focus", "blur"])
  expect(keypresses).toHaveLength(0)
})

describe("stdin routing", () => {
  test("mouse then key in one chunk", async () => {
    const { renderer, renderOnce, clock } = await createRoutingRenderer()
    try {
      const target = new MouseTarget(renderer, {
        id: "target-mouse-then-key",
        position: "absolute",
        left: 0,
        top: 0,
        width: renderer.width,
        height: renderer.height,
      })
      renderer.root.add(target)
      await renderOnce()

      const keys: string[] = []
      let scrollCount = 0

      renderer.keyInput.on("keypress", (event) => {
        keys.push(event.name)
      })

      target.onMouseScroll = () => {
        scrollCount++
      }

      renderer.stdin.emit("data", Buffer.from("\x1b[<64;10;5Mx"))
      advanceClock(clock)

      expect(scrollCount).toBe(1)
      expect(keys).toEqual(["x"])
    } finally {
      renderer.destroy()
    }
  })

  test("key then mouse in one chunk", async () => {
    const { renderer, renderOnce, clock } = await createRoutingRenderer()
    try {
      const target = new MouseTarget(renderer, {
        id: "target-key-then-mouse",
        position: "absolute",
        left: 0,
        top: 0,
        width: renderer.width,
        height: renderer.height,
      })
      renderer.root.add(target)
      await renderOnce()

      const keys: string[] = []
      let scrollCount = 0

      renderer.keyInput.on("keypress", (event) => {
        keys.push(event.name)
      })

      target.onMouseScroll = () => {
        scrollCount++
      }

      renderer.stdin.emit("data", Buffer.from("x\x1b[<64;10;5M"))
      advanceClock(clock)

      expect(keys).toEqual(["x"])
      expect(scrollCount).toBe(1)
    } finally {
      renderer.destroy()
    }
  })

  test("focus and key mixed in one chunk", async () => {
    const { renderer, clock } = await createRoutingRenderer()
    try {
      const events: string[] = []
      const keys: string[] = []

      renderer.on("focus", () => {
        events.push("focus")
      })

      renderer.keyInput.on("keypress", (event) => {
        keys.push(event.name)
      })

      renderer.stdin.emit("data", Buffer.from("\x1b[Ix"))
      advanceClock(clock)

      expect(events).toEqual(["focus"])
      expect(keys).toEqual(["x"])
    } finally {
      renderer.destroy()
    }
  })

  test("focus and mouse mixed in one chunk", async () => {
    const { renderer, renderOnce, clock } = await createRoutingRenderer()
    try {
      const events: string[] = []
      let scrollCount = 0

      const target = new MouseTarget(renderer, {
        id: "target-focus-then-mouse",
        position: "absolute",
        left: 0,
        top: 0,
        width: renderer.width,
        height: renderer.height,
      })
      renderer.root.add(target)
      await renderOnce()

      renderer.on("focus", () => {
        events.push("focus")
      })

      target.onMouseScroll = () => {
        scrollCount++
      }

      renderer.stdin.emit("data", Buffer.from("\x1b[I\x1b[<64;10;5M"))
      advanceClock(clock)

      expect(events).toEqual(["focus"])
      expect(scrollCount).toBe(1)
    } finally {
      renderer.destroy()
    }
  })

  test("mouse state resets when mouse mode toggles", async () => {
    const { renderer, renderOnce, clock } = await createRoutingRenderer()
    try {
      const target = new MouseTarget(renderer, {
        id: "target-mouse-toggle-reset",
        position: "absolute",
        left: 0,
        top: 0,
        width: renderer.width,
        height: renderer.height,
      })
      renderer.root.add(target)
      await renderOnce()

      let moveCount = 0
      let dragCount = 0
      target.onMouseMove = () => {
        moveCount++
      }
      target.onMouseDrag = () => {
        dragCount++
      }

      renderer.stdin.emit("data", Buffer.from("\x1b[<0;1;1M"))
      advanceClock(clock)

      renderer.useMouse = false
      renderer.useMouse = true

      renderer.stdin.emit("data", Buffer.from("\x1b[<32;2;2M"))
      advanceClock(clock)

      expect(moveCount).toBe(1)
      expect(dragCount).toBe(0)
    } finally {
      renderer.destroy()
    }
  })

  test("mouse state resets on resize", async () => {
    const { renderer, renderOnce, resize, clock } = await createRoutingRenderer()
    try {
      const target = new MouseTarget(renderer, {
        id: "target-resize-reset",
        position: "absolute",
        left: 0,
        top: 0,
        width: renderer.width,
        height: renderer.height,
      })
      renderer.root.add(target)
      await renderOnce()

      let moveCount = 0
      let dragCount = 0
      target.onMouseMove = () => {
        moveCount++
      }
      target.onMouseDrag = () => {
        dragCount++
      }

      renderer.stdin.emit("data", Buffer.from("\x1b[<0;1;1M"))
      advanceClock(clock)

      resize(41, 20)
      await renderOnce()

      renderer.stdin.emit("data", Buffer.from("\x1b[<32;2;2M"))
      advanceClock(clock)

      expect(moveCount).toBe(1)
      expect(dragCount).toBe(0)
    } finally {
      renderer.destroy()
    }
  })

  test("suspend resets parser state before resume", async () => {
    const { renderer, clock } = await createRoutingRenderer()

    try {
      const events: Array<{ name: string; meta: boolean }> = []
      renderer.keyInput.on("keypress", (event) => {
        events.push({ name: event.name, meta: event.meta })
      })

      renderer.stdin.emit("data", Buffer.from("\x1b["))
      advanceClock(clock, 5)

      renderer.suspend()
      renderer.resume()

      renderer.stdin.emit("data", Buffer.from("x"))
      advanceClock(clock)

      expect(events).toEqual([{ name: "x", meta: false }])
    } finally {
      renderer.destroy()
    }
  })

  test("streams large paste bodies without dropping them and resumes afterward", async () => {
    const { renderer, clock } = await createRoutingRenderer({
      stdinParserMaxBufferBytes: 64 * 1024,
    })

    try {
      const keys: string[] = []
      const pastes: string[] = []
      renderer.keyInput.on("keypress", (event) => {
        keys.push(event.name)
      })
      renderer.keyInput.on("paste", (event) => {
        pastes.push(decodePasteBytes(event.bytes))
      })

      const largeChunk = Buffer.alloc(16 * 1024, "x")
      const expectedPaste = largeChunk.toString().repeat(5) + "z"

      expect(() => {
        renderer.stdin.emit("data", Buffer.from("\x1b[200~"))
        for (let i = 0; i < 5; i++) {
          renderer.stdin.emit("data", largeChunk)
        }
        renderer.stdin.emit("data", Buffer.from("z"))
        renderer.stdin.emit("data", Buffer.from("\x1b[20"))
        renderer.stdin.emit("data", Buffer.from("1~"))
        renderer.stdin.emit("data", Buffer.from("q"))
      }).not.toThrow()

      advanceClock(clock)

      expect(keys).toEqual(["q"])
      expect(pastes).toEqual([expectedPaste])
    } finally {
      renderer.destroy()
    }
  })

  test("emits paste event for large bracketed paste under configured limit", async () => {
    const { renderer, clock } = await createRoutingRenderer({
      stdinParserMaxBufferBytes: 512 * 1024,
    })

    try {
      const payloadSize = 256 * 1024
      let pasteCount = 0
      let pastedBytes = 0

      renderer.keyInput.on("paste", (event) => {
        pasteCount += 1
        pastedBytes += event.bytes.length
      })

      const chunk = Buffer.alloc(payloadSize, "x")
      const stream = Buffer.concat([Buffer.from("\x1b[200~"), chunk, Buffer.from("\x1b[201~")])
      renderer.stdin.emit("data", stream)
      advanceClock(clock)

      expect(pasteCount).toBe(1)
      expect(pastedBytes).toBe(payloadSize)
    } finally {
      renderer.destroy()
    }
  })

  test("emits one paste event for one bracketed paste", async () => {
    const { renderer, clock } = await createRoutingRenderer()

    try {
      const payload = "x".repeat(70_000)
      const pastes: string[] = []
      renderer.keyInput.on("paste", (event) => {
        pastes.push(decodePasteBytes(event.bytes))
      })

      renderer.stdin.emit("data", Buffer.from(`\x1b[200~${payload}\x1b[201~`))
      advanceClock(clock)

      expect(pastes).toEqual([payload])
    } finally {
      renderer.destroy()
    }
  })

  test("emits empty paste for empty bracketed paste", async () => {
    const { renderer, clock } = await createRoutingRenderer()

    try {
      const pastes: string[] = []
      renderer.keyInput.on("paste", (event) => {
        pastes.push(decodePasteBytes(event.bytes))
      })

      renderer.stdin.emit("data", Buffer.from("\x1b[200~\x1b[201~"))
      advanceClock(clock)

      expect(pastes).toEqual([""])
    } finally {
      renderer.destroy()
    }
  })

  test("preserves UTF-8 across bracketed paste chunk boundaries", async () => {
    const { renderer, clock } = await createRoutingRenderer()

    try {
      const payload = "a".repeat(4095) + "é"
      const pastes: string[] = []
      renderer.keyInput.on("paste", (event) => {
        pastes.push(decodePasteBytes(event.bytes))
      })

      renderer.stdin.emit("data", Buffer.from(`\x1b[200~${payload}\x1b[201~`))
      advanceClock(clock)

      expect(pastes.join("")).toBe(payload)
    } finally {
      renderer.destroy()
    }
  })
})
