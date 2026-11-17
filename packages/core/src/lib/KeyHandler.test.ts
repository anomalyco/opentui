import { test, expect } from "bun:test"
import { InternalKeyHandler, KeyEvent } from "./KeyHandler.js"
import { type ParseKeypressOptions, parseKeypress } from "./parse.keypress.js"
import { decodePasteBytes } from "./paste.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { pasteBytes } from "../testing/mock-keys.js"

const { renderer, mockInput } = await createTestRenderer({})

function createKeyHandler(): InternalKeyHandler {
  return new InternalKeyHandler()
}

function dispatchInput(handler: InternalKeyHandler, data: string, options: ParseKeypressOptions = {}): boolean {
  const parsedKey = parseKeypress(data, options)
  if (!parsedKey) {
    return false
  }

  return handler.processParsedKey(parsedKey)
}

test("KeyHandler - parsed input emits keypress events", () => {
  const handler = new InternalKeyHandler()

  let receivedKey: KeyEvent | undefined
  handler.on("keypress", (key: KeyEvent) => {
    receivedKey = key
  })

  dispatchInput(handler, "a")

  expect(receivedKey).toMatchObject({
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
})

test("KeyHandler - emits keypress events", () => {
  const handler = createKeyHandler()

  let receivedKey: KeyEvent | undefined
  handler.on("keypress", (key: KeyEvent) => {
    receivedKey = key
  })

  dispatchInput(handler, "a")

  expect(receivedKey).toMatchObject({
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
})

test("KeyHandler - handles paste via processPaste", async () => {
  const handler = createKeyHandler()

  let receivedPaste: Uint8Array | undefined
  handler.on("paste", (event) => {
    receivedPaste = event.bytes
  })

  handler.processPaste(pasteBytes("pasted content"))

  expect(receivedPaste).toEqual(pasteBytes("pasted content"))
})

test("KeyHandler - processPaste handles content directly", () => {
  const handler = createKeyHandler()

  let receivedPaste: Uint8Array | undefined
  handler.on("paste", (event) => {
    receivedPaste = event.bytes
  })

  // processPaste receives the full content, no chunking
  handler.processPaste(pasteBytes("chunk1chunk2chunk3"))

  expect(receivedPaste).toEqual(pasteBytes("chunk1chunk2chunk3"))
})

test("KeyHandler - preserves raw ANSI bytes in paste", () => {
  const handler = createKeyHandler()

  let receivedPaste: Uint8Array | undefined
  handler.on("paste", (event) => {
    receivedPaste = event.bytes
  })

  handler.processPaste(pasteBytes("text with \x1b[31mred\x1b[0m color"))

  expect(receivedPaste).toEqual(pasteBytes("text with \x1b[31mred\x1b[0m color"))
})

test("KeyHandler - handles string input", () => {
  const handler = createKeyHandler()

  let receivedKey: KeyEvent | undefined
  handler.on("keypress", (key: KeyEvent) => {
    receivedKey = key
  })

  dispatchInput(handler, "c")

  expect(receivedKey).toMatchObject({
    name: "c",
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    sequence: "c",
    raw: "c",
    eventType: "press",
  })
})

test("KeyHandler - preventDefault stops propagation", () => {
  const handler = createKeyHandler()

  let globalHandlerCalled = false
  let secondHandlerCalled = false

  handler.on("keypress", (key: KeyEvent) => {
    globalHandlerCalled = true
    key.preventDefault()
  })

  handler.on("keypress", (key: KeyEvent) => {
    if (!key.defaultPrevented) {
      secondHandlerCalled = true
    }
  })

  dispatchInput(handler, "a")

  expect(globalHandlerCalled).toBe(true)
  expect(secondHandlerCalled).toBe(false)
})

test("InternalKeyHandler - onInternal handlers run after regular handlers", () => {
  const handler = createKeyHandler()

  const callOrder: string[] = []

  handler.onInternal("keypress", (key: KeyEvent) => {
    callOrder.push("internal")
  })

  handler.on("keypress", (key: KeyEvent) => {
    callOrder.push("regular")
  })

  dispatchInput(handler, "a")

  expect(callOrder).toEqual(["regular", "internal"])
})

test("InternalKeyHandler - preventDefault prevents internal handlers from running", () => {
  const handler = createKeyHandler()

  let regularHandlerCalled = false
  let internalHandlerCalled = false

  // Register regular handler that prevents default
  handler.on("keypress", (key: KeyEvent) => {
    regularHandlerCalled = true
    key.preventDefault()
  })

  // Register internal handler (should not run if prevented)
  handler.onInternal("keypress", (key: KeyEvent) => {
    internalHandlerCalled = true
  })

  dispatchInput(handler, "a")

  expect(regularHandlerCalled).toBe(true)
  expect(internalHandlerCalled).toBe(false)
})

test("InternalKeyHandler - multiple internal handlers can be registered", () => {
  const handler = createKeyHandler()

  let handler1Called = false
  let handler2Called = false
  let handler3Called = false

  const internalHandler1 = () => {
    handler1Called = true
  }
  const internalHandler2 = () => {
    handler2Called = true
  }
  const internalHandler3 = () => {
    handler3Called = true
  }

  handler.onInternal("keypress", internalHandler1)
  handler.onInternal("keypress", internalHandler2)
  handler.onInternal("keypress", internalHandler3)

  dispatchInput(handler, "a")

  expect(handler1Called).toBe(true)
  expect(handler2Called).toBe(true)
  expect(handler3Called).toBe(true)
})

test("InternalKeyHandler - offInternal removes specific handlers", () => {
  const handler = createKeyHandler()

  let handler1Called = false
  let handler2Called = false

  const internalHandler1 = () => {
    handler1Called = true
  }
  const internalHandler2 = () => {
    handler2Called = true
  }

  handler.onInternal("keypress", internalHandler1)
  handler.onInternal("keypress", internalHandler2)

  // Remove only handler1
  handler.offInternal("keypress", internalHandler1)

  dispatchInput(handler, "a")

  expect(handler1Called).toBe(false)
  expect(handler2Called).toBe(true)
})

test("InternalKeyHandler - emit returns true when there are listeners", () => {
  const handler = createKeyHandler()

  // No listeners initially
  let hasListeners = handler.emit(
    "keypress",
    new KeyEvent({
      name: "a",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      sequence: "a",
      number: false,
      raw: "a",
      eventType: "press",
      source: "raw",
    }),
  )
  expect(hasListeners).toBe(false)

  // Add regular listener
  handler.on("keypress", () => {})
  hasListeners = handler.emit(
    "keypress",
    new KeyEvent({
      name: "b",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      sequence: "b",
      number: false,
      raw: "b",
      eventType: "press",
      source: "raw",
    }),
  )
  expect(hasListeners).toBe(true)

  // Remove regular listener, add internal listener
  handler.removeAllListeners("keypress")
  handler.onInternal("keypress", () => {})
  hasListeners = handler.emit(
    "keypress",
    new KeyEvent({
      name: "c",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      sequence: "c",
      number: false,
      raw: "c",
      eventType: "press",
      source: "raw",
    }),
  )
  expect(hasListeners).toBe(true)
})

test("InternalKeyHandler - paste events work with priority system", () => {
  const handler = createKeyHandler()

  const callOrder: string[] = []

  handler.on("paste", (event) => {
    callOrder.push(`regular:${decodePasteBytes(event.bytes)}`)
  })

  handler.onInternal("paste", (event) => {
    callOrder.push(`internal:${decodePasteBytes(event.bytes)}`)
  })

  handler.processPaste(pasteBytes("hello"))

  expect(callOrder).toEqual(["regular:hello", "internal:hello"])
})

test("InternalKeyHandler - paste preventDefault prevents internal handlers", () => {
  const handler = createKeyHandler()

  let regularHandlerCalled = false
  let internalHandlerCalled = false
  let receivedText = ""

  handler.on("paste", (event) => {
    regularHandlerCalled = true
    receivedText = decodePasteBytes(event.bytes)
    event.preventDefault()
  })

  handler.onInternal("paste", (event) => {
    internalHandlerCalled = true
  })

  handler.processPaste(pasteBytes("test paste"))

  expect(regularHandlerCalled).toBe(true)
  expect(receivedText).toBe("test paste")
  expect(internalHandlerCalled).toBe(false)
})

test("KeyHandler - emits paste event even with empty content", () => {
  const handler = createKeyHandler()

  let pasteEventReceived = false
  let receivedPaste: Uint8Array = pasteBytes("not-empty")

  handler.on("paste", (event) => {
    pasteEventReceived = true
    receivedPaste = event.bytes
  })

  handler.processPaste(pasteBytes(""))

  expect(pasteEventReceived).toBe(true)
  expect(receivedPaste).toEqual(pasteBytes(""))
})

test("KeyHandler - filters out mouse events", () => {
  const handler = createKeyHandler()

  let keypressCount = 0
  handler.on("keypress", () => {
    keypressCount++
  })

  // Mouse events should not generate keypresses
  dispatchInput(handler, "\x1b[<0;10;5M")
  expect(keypressCount).toBe(0)

  dispatchInput(handler, "\x1b[<0;10;5m")
  expect(keypressCount).toBe(0)

  // Old-style mouse: \x1b[M + 3 bytes, then "c" is a separate keypress
  dispatchInput(handler, "\x1b[M ab")
  expect(keypressCount).toBe(0)

  dispatchInput(handler, "c")
  expect(keypressCount).toBe(1)

  dispatchInput(handler, "a")
  expect(keypressCount).toBe(2) // Now we have "c" and "a"
})

test("KeyHandler - KeyEvent has source field set to 'raw' by default", () => {
  if (!renderer) {
    throw new Error("Renderer not initialized")
  }

  let receivedKey: KeyEvent | undefined
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    receivedKey = key
  })

  mockInput.pressKey("a")

  expect(receivedKey).toBeDefined()
  expect(receivedKey?.source).toBe("raw")
  expect(receivedKey?.name).toBe("a")

  renderer.keyInput.removeAllListeners("keypress")
})

test("KeyHandler - KeyEvent has source field for different key types", () => {
  if (!renderer) {
    throw new Error("Renderer not initialized")
  }

  const receivedKeys: KeyEvent[] = []
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    receivedKeys.push(key)
  })

  // Test various key types
  mockInput.pressKey("a")
  mockInput.pressKey("A")
  mockInput.pressKey("\x1b[A") // Up arrow
  mockInput.pressKey("\x01") // Ctrl+A

  expect(receivedKeys).toHaveLength(4)
  expect(receivedKeys[0]?.source).toBe("raw")
  expect(receivedKeys[1]?.source).toBe("raw")
  expect(receivedKeys[2]?.source).toBe("raw")
  expect(receivedKeys[3]?.source).toBe("raw")

  renderer.keyInput.removeAllListeners("keypress")
})

test("KeyHandler - KeyEvent source is 'kitty' when using Kitty keyboard protocol", () => {
  const handler = createKeyHandler()

  let receivedKey: KeyEvent | undefined
  handler.on("keypress", (key: KeyEvent) => {
    receivedKey = key
  })

  // Send a Kitty keyboard protocol sequence for 'a' (codepoint 97)
  dispatchInput(handler, "\x1b[97u", { useKittyKeyboard: true })

  expect(receivedKey).toBeDefined()
  expect(receivedKey?.source).toBe("kitty")
  expect(receivedKey?.name).toBe("a")
})

test("KeyHandler - KeyEvent source is 'raw' for non-Kitty sequences even with Kitty enabled", () => {
  if (!renderer) {
    throw new Error("Renderer not initialized")
  }

  const receivedKeys: KeyEvent[] = []
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    receivedKeys.push(key)
  })

  // Send regular sequences that don't match Kitty protocol
  mockInput.pressKey("a")
  mockInput.pressKey("\x1b[A") // Up arrow (standard ANSI)

  expect(receivedKeys).toHaveLength(2)
  expect(receivedKeys[0]?.source).toBe("raw")
  expect(receivedKeys[0]?.name).toBe("a")
  expect(receivedKeys[1]?.source).toBe("raw")
  expect(receivedKeys[1]?.name).toBe("up")

  renderer.keyInput.removeAllListeners("keypress")
})

test("KeyHandler - source field persists through KeyEvent wrapper", () => {
  if (!renderer) {
    throw new Error("Renderer not initialized")
  }

  let receivedKey: KeyEvent | undefined
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    receivedKey = key
  })

  mockInput.pressKey("x")

  expect(receivedKey).toBeInstanceOf(KeyEvent)
  expect(receivedKey?.source).toBe("raw")
  expect(receivedKey?.name).toBe("x")

  // Verify it implements ParsedKey interface
  const parsedKey: typeof receivedKey = receivedKey
  expect(parsedKey?.source).toBe("raw")

  renderer.keyInput.removeAllListeners("keypress")
})

test("KeyHandler - global handler error is caught and logged", () => {
  const handler = createKeyHandler()

  let handlerCalled = false
  let errorThrown = false

  // Handler throws an error
  handler.on("keypress", (key: KeyEvent) => {
    handlerCalled = true
    errorThrown = true
    throw new Error("Test error in global handler")
  })

  // Should not throw - error is caught and logged
  expect(() => dispatchInput(handler, "a")).not.toThrow()

  expect(handlerCalled).toBe(true)
  expect(errorThrown).toBe(true)
})

test("KeyHandler - renderable handler error does not stop processing", () => {
  const handler = createKeyHandler()

  let firstInternalCalled = false
  let secondInternalCalled = false
  let errorThrown = false

  // First internal handler throws
  handler.onInternal("keypress", (key: KeyEvent) => {
    firstInternalCalled = true
    errorThrown = true
    throw new Error("Test error in internal handler")
  })

  // Second internal handler should still be called
  handler.onInternal("keypress", (key: KeyEvent) => {
    secondInternalCalled = true
  })

  // Should not throw
  expect(() => dispatchInput(handler, "a")).not.toThrow()

  expect(firstInternalCalled).toBe(true)
  expect(errorThrown).toBe(true)
  expect(secondInternalCalled).toBe(true)
})

test("KeyHandler - global handler error stops further global handlers but allows internal handlers", () => {
  const handler = createKeyHandler()

  let globalCalled = false
  let internalCalled = false

  // Global handler throws - stops further global handlers
  handler.on("keypress", (key: KeyEvent) => {
    globalCalled = true
    throw new Error("Global handler error")
  })

  // Internal handler should still be called (different priority level)
  handler.onInternal("keypress", (key: KeyEvent) => {
    internalCalled = true
  })

  // Should not throw - errors are caught
  expect(() => dispatchInput(handler, "a")).not.toThrow()

  expect(globalCalled).toBe(true)
  expect(internalCalled).toBe(true)
})

test("KeyHandler - paste handler error is caught and logged", () => {
  const handler = createKeyHandler()

  let handlerCalled = false

  // Paste handler throws
  handler.on("paste", (event) => {
    handlerCalled = true
    throw new Error("Test error in paste handler")
  })

  // Should not throw - error is caught and logged
  expect(() => handler.processPaste(pasteBytes("test"))).not.toThrow()

  expect(handlerCalled).toBe(true)
})

test("KeyHandler - processParsedKey returns true even when handler throws", () => {
  const handler = createKeyHandler()

  handler.on("keypress", (key: KeyEvent) => {
    throw new Error("Handler error")
  })

  // Should return true indicating the input was handled (even if handler errored)
  const result = dispatchInput(handler, "a")
  expect(result).toBe(true)
})

test("KeyHandler - internal handler error with preventDefault still respects prevention", () => {
  const handler = createKeyHandler()

  let globalCalled = false
  let internalCalled = false

  // Global handler prevents default
  handler.on("keypress", (key: KeyEvent) => {
    globalCalled = true
    key.preventDefault()
  })

  // Internal handler should not be called (due to preventDefault)
  handler.onInternal("keypress", (key: KeyEvent) => {
    internalCalled = true
    throw new Error("Should not reach here")
  })

  dispatchInput(handler, "a")

  expect(globalCalled).toBe(true)
  expect(internalCalled).toBe(false)
})

test("KeyHandler - error in one event type does not prevent other event types from working", () => {
  const handler = createKeyHandler()

  let keypressCalled = false
  let pasteCalled = false

  // Keypress handler throws
  handler.on("keypress", (key: KeyEvent) => {
    keypressCalled = true
    throw new Error("Keypress error")
  })

  // Paste handler should work fine
  handler.on("paste", (event) => {
    pasteCalled = true
  })

  // Both should not throw - errors are caught and logged
  expect(() => dispatchInput(handler, "a")).not.toThrow()
  expect(() => handler.processPaste(pasteBytes("test"))).not.toThrow()

  expect(keypressCalled).toBe(true)
  expect(pasteCalled).toBe(true)
})
