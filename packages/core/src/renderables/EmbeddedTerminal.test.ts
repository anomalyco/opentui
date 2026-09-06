import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { KeyEvent } from "../lib/KeyHandler.js"
import { parseKeypress } from "../lib/parse.keypress.js"
import { RGBA } from "../lib/RGBA.js"
import { resolveRenderLib } from "../zig.js"
import { EmbeddedTerminalRenderable } from "./EmbeddedTerminal.js"

class MissingFramebufferTerminal extends EmbeddedTerminalRenderable {
  protected createFrameBuffer(): void {
    this.frameBuffer = null
  }
}

describe("EmbeddedTerminalRenderable", () => {
  let setup: TestRendererSetup

  beforeEach(async () => {
    setup = await createTestRenderer({ width: 30, height: 8 })
  })

  afterEach(() => setup.renderer.destroy())

  test("creates native state from the statically linked runtime", () => {
    const lib = resolveRenderLib()
    const context = lib.createContext({ objectCapacity: 1, renderCellsMax: 20 })
    try {
      const handle = lib.createContextEmbeddedTerminal(context, { cols: 10, rows: 2 })
      expect(handle).toBeTruthy()
      lib.destroyContextEmbeddedTerminal(context, handle)
    } finally {
      lib.destroyContext(context)
    }
  })

  test("does not compose into the parent buffer when framebuffer allocation fails", async () => {
    const terminal = new MissingFramebufferTerminal(setup.renderer, { width: 20, height: 4 })
    setup.renderer.root.add(terminal)
    terminal.write("must not reach the parent")
    await setup.renderOnce()
    expect(setup.captureCharFrame()).not.toContain("must not reach the parent")
  })

  test("renders VT output and preserves it across clean frames", async () => {
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, { width: 20, height: 4 })
    setup.renderer.root.add(terminal)
    terminal.write("hello \x1b[1;32mworld\x1b[0m\r\nwide: 界")

    await setup.renderOnce()
    const first = setup.captureCharFrame()
    expect(first).toContain("hello world")
    expect(first).toContain("wide: 界")

    await setup.renderOnce()
    expect(setup.captureCharFrame()).toBe(first)
  })

  test("preserves mouse callbacks and their renderable context", async () => {
    let mouseDowns = 0
    let callbackThis: EmbeddedTerminalRenderable | undefined
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, {
      width: 20,
      height: 4,
      onMouseDown: function () {
        mouseDowns++
        callbackThis = this
      },
    })
    setup.renderer.root.add(terminal)
    await setup.renderOnce()

    await setup.mockMouse.pressDown(1, 1)

    expect(mouseDowns).toBe(1)
    expect(callbackThis).toBe(terminal)
  })

  test("participates in renderer selection and returns terminal text", async () => {
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, { width: 20, height: 4 })
    setup.renderer.root.add(terminal)
    terminal.write("hello\r\nwide: 界")
    await setup.renderOnce()

    setup.renderer.startSelection(terminal, terminal.x + 1, terminal.y)
    setup.renderer.updateSelection(terminal, terminal.x + 3, terminal.y, { finishDragging: true })

    expect(terminal.hasSelection()).toBe(true)
    expect(terminal.getSelectedText()).toBe("ell")
    expect(setup.renderer.getSelection()?.getSelectedText()).toBe("ell")

    setup.renderer.clearSelection()
    expect(terminal.hasSelection()).toBe(false)
    expect(terminal.getSelectedText()).toBe("")
  })

  test("waits for a drag to leave its starting cell before selecting", async () => {
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, { width: 20, height: 4 })
    setup.renderer.root.add(terminal)
    terminal.write("hello")
    await setup.renderOnce()
    const original = setup.captureSpans().lines

    await setup.mockMouse.pressDown(1, 0)
    await setup.renderOnce()
    expect(terminal.hasSelection()).toBe(false)
    expect(setup.captureSpans().lines).toEqual(original)

    await setup.mockMouse.moveTo(1, 0)
    await setup.renderOnce()
    expect(terminal.hasSelection()).toBe(false)
    expect(setup.captureSpans().lines).toEqual(original)
    await setup.mockMouse.release(1, 0)
    await setup.renderOnce()
    expect(terminal.hasSelection()).toBe(false)
    expect(terminal.getSelectedText()).toBe("")
    expect(setup.renderer.getSelection()?.getSelectedText()).toBe("")
    expect(setup.captureSpans().lines).toEqual(original)

    setup.renderer.clearSelection()
    await setup.mockMouse.pressDown(1, 0)
    await setup.mockMouse.moveTo(2, 0)
    await setup.renderOnce()
    expect(terminal.hasSelection()).toBe(true)
    expect(terminal.getSelectedText()).toBe("el")
    expect(setup.captureSpans().lines).not.toEqual(original)

    // Crossing the threshold once enables normal selection, even back at the anchor.
    await setup.mockMouse.moveTo(1, 0)
    await setup.mockMouse.release(1, 0)
    await setup.renderOnce()
    expect(terminal.getSelectedText()).toBe("e")
    expect(setup.captureSpans().lines).not.toEqual(original)

    await setup.mockMouse.pressDown(4, 0)
    await setup.renderOnce()
    expect(terminal.hasSelection()).toBe(false)
    expect(terminal.getSelectedText()).toBe("")
    expect(setup.captureSpans().lines).toEqual(original)
    await setup.mockMouse.release(4, 0)
  })

  test("starts selection on horizontal or vertical movement even when only one text cell is selected", async () => {
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, { width: 20, height: 4 })
    setup.renderer.root.add(terminal)
    terminal.write("hello")
    await setup.renderOnce()
    const original = setup.captureSpans().lines

    for (const point of [
      { x: 5, y: 0 },
      { x: 4, y: 1 },
    ]) {
      setup.renderer.clearSelection()
      await setup.mockMouse.pressDown(4, 0)
      expect(terminal.hasSelection()).toBe(false)
      await setup.mockMouse.moveTo(point.x, point.y)
      await setup.renderOnce()
      expect(terminal.hasSelection()).toBe(true)
      expect(terminal.getSelectedText()).toBe("o")
      expect(setup.captureSpans().lines).not.toEqual(original)
      await setup.mockMouse.release(point.x, point.y)
    }
  })

  test("does not delay word or line selection gestures", async () => {
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, { width: 20, height: 4 })
    setup.renderer.root.add(terminal)
    terminal.write("hello")
    await setup.renderOnce()

    for (const behavior of ["word", "line"] as const) {
      setup.renderer.startSelection(terminal, 0, 0, behavior)
      expect(terminal.hasSelection()).toBe(true)
      expect(terminal.getSelectedText()).toBe("h")
    }
  })

  test("encodes keys and bracketed paste", () => {
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, { width: 20, height: 4 })
    setup.renderer.root.add(terminal)
    terminal.write("\x1b[?2004h")

    expect(new TextDecoder().decode(terminal.encodeKey(keyEvent({ name: "enter", sequence: "\r" })))).toBe("\r")
    expect(new TextDecoder().decode(terminal.encodePaste(new TextEncoder().encode("one\ntwo")))).toBe(
      "\x1b[200~one\ntwo\x1b[201~",
    )
    expect(new TextDecoder().decode(terminal.encodeKey(keyEvent({ name: "😀", sequence: "😀" })))).toBe("😀")
    expect(new TextDecoder().decode(terminal.encodeKey(keyEvent({ name: "space", sequence: " " })))).toBe(" ")
    expect(new TextDecoder().decode(terminal.encodeKey(keyEvent({ name: "up", sequence: "\x1b[A", code: "[A" })))).toBe(
      "\x1b[A",
    )
    expect(
      new TextDecoder().decode(terminal.encodeKey(keyEvent({ name: "down", sequence: "\x1b[B", code: "[B" }))),
    ).toBe("\x1b[B")
    expect(
      new TextDecoder().decode(terminal.encodeKey(keyEvent({ name: "a", sequence: "A", shift: true, raw: "A" }))),
    ).toBe("A")

    terminal.write("\x1b[>19u")
    const longText = "x".repeat(2048)
    expect(new TextDecoder().decode(terminal.encodeKey(keyEvent({ name: longText, sequence: longText })))).toBe(
      longText,
    )
  })

  test("distinguishes user input from terminal responses", () => {
    const output: Array<{ data: string; source?: "input" | "response" }> = []
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, {
      width: 20,
      height: 4,
      onData: (data, source) => output.push({ data: new TextDecoder().decode(data), source }),
    })
    setup.renderer.root.add(terminal)

    terminal.write("\x1b[5n")
    terminal.handleKeyPress(keyEvent({ name: "enter", sequence: "\r" }))

    expect(output).toEqual([
      { data: "\x1b[0n", source: "response" },
      { data: "\r", source: "input" },
    ])
  })

  test("encodes no-button motion and suppresses unavailable pixel coordinates", () => {
    const lib = resolveRenderLib()
    const context = lib.createContext({ objectCapacity: 1, renderCellsMax: 80 })
    try {
      const handle = lib.createContextEmbeddedTerminal(context, { cols: 20, rows: 4 })
      lib.contextEmbeddedTerminalWrite(context, handle, "\x1b[?1003h\x1b[?1006h")
      const motion = lib.contextEmbeddedTerminalEncodeMouse(context, handle, {
        action: "motion",
        x: 1,
        y: 1,
      })
      expect(new TextDecoder().decode(motion)).toBe("\x1b[<35;2;2M")

      lib.contextEmbeddedTerminalWrite(context, handle, "\x1b[?1016h")
      expect(
        lib.contextEmbeddedTerminalEncodeMouse(context, handle, {
          action: "motion",
          x: 1,
          y: 1,
        }),
      ).toHaveLength(0)
    } finally {
      lib.destroyContext(context)
    }
  })

  test("encodes Meta as Super rather than Alt", () => {
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, { width: 20, height: 4 })
    setup.renderer.root.add(terminal)
    terminal.write("\x1b[>3u")

    const encoded = terminal.encodeKey(
      keyEvent({
        name: "a",
        sequence: "a",
        code: "KeyA",
        baseCode: "a".codePointAt(0),
        meta: true,
      }),
    )
    expect(new TextDecoder().decode(encoded)).toBe("\x1b[97;9u")
  })

  test("re-encodes Kitty character and escape keys for nested terminals", () => {
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, { width: 20, height: 4 })
    setup.renderer.root.add(terminal)
    terminal.write("\x1b[>3u")

    expect(
      new TextDecoder().decode(
        terminal.encodeKey(keyEvent({ name: "c", sequence: "c", raw: "\x1b[99;5u", source: "kitty", ctrl: true })),
      ),
    ).toBe("\x1b[99;5u")
    expect(
      new TextDecoder().decode(
        terminal.encodeKey(
          keyEvent({ name: "escape", sequence: "\x1b[27u", raw: "\x1b[27u", source: "kitty", code: "[27u" }),
        ),
      ),
    ).toBe("\x1b[27u")
  })

  test.each([
    ["plain Dvorak u", 1, "\x1b[117::102;1u", "u"],
    ["plain Dvorak d", 1, "\x1b[100::104;1u", "d"],
    ["Dvorak Ctrl+U", 1, "\x1b[117::102;5u", "\x1b[117;5u"],
    ["Dvorak Ctrl+D", 1, "\x1b[100::104;5u", "\x1b[100;5u"],
    ["Dvorak Ctrl+Shift+U", 1, "\x1b[117:85:102;6u", "\x1b[117;6u"],
    ["Cyrillic Ctrl+ф", 1, "\x1b[1092::97;5u", "\x1b[1092;5u"],
    ["QWERTY Ctrl+U", 1, "\x1b[117;5u", "\x1b[117;5u"],
    ["Dvorak Ctrl+U in legacy mode", 0, "\x1b[117::102;5u", "\x15"],
    ["Dvorak Ctrl+D in legacy mode", 0, "\x1b[100::104;5u", "\x04"],
    ["Dvorak Ctrl+U with its base-layout alternative", 5, "\x1b[117::102;5u", "\x1b[117::102;5u"],
    ["Dvorak Ctrl+D with its base-layout alternative", 5, "\x1b[100::104;5u", "\x1b[100::104;5u"],
  ])("preserves %s", (_label, flags, raw, expected) => {
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, { width: 20, height: 4 })
    setup.renderer.root.add(terminal)
    terminal.write(`\x1b[>${flags}u`)

    const parsed = parseKeypress(raw, { useKittyKeyboard: true })!
    expect(new TextDecoder().decode(terminal.encodeKey(new KeyEvent(parsed)))).toBe(expected)
  })

  test("forwards Dvorak press, repeat, and release with the same active-layout key", () => {
    const output: string[] = []
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, {
      width: 20,
      height: 4,
      onData: (data) => output.push(new TextDecoder().decode(data)),
    })
    setup.renderer.root.add(terminal)
    terminal.write("\x1b[>3u")
    terminal.focus()

    for (const raw of ["\x1b[117::102;5u", "\x1b[117::102;5:2u", "\x1b[117::102;5:3u"]) {
      setup.renderer.keyInput.processParsedKey(parseKeypress(raw, { useKittyKeyboard: true })!)
    }

    expect(output).toEqual(["\x1b[117;5u", "\x1b[117;5:2u", "\x1b[117;5:3u"])
  })

  test("drains the preserved response prefix after overflow", () => {
    const lib = resolveRenderLib()
    const context = lib.createContext({ objectCapacity: 1, renderCellsMax: 80 })
    try {
      const handle = lib.createContextEmbeddedTerminal(context, { cols: 20, rows: 4 })
      const query = "\x1b[5n"
      lib.contextEmbeddedTerminalWrite(context, handle, query.repeat((1024 * 1024) / query.length))
      lib.contextEmbeddedTerminalWrite(context, handle, query)
      const responses = lib.contextEmbeddedTerminalDrainResponses(context, handle)
      expect(responses.byteLength).toBe(1024 * 1024)
      expect(new TextDecoder().decode(responses)).toBe("\x1b[0n".repeat((1024 * 1024) / 4))
      expect(lib.contextEmbeddedTerminalDrainResponses(context, handle)).toHaveLength(0)
    } finally {
      lib.destroyContext(context)
    }
  })

  test("resizes and destroys native state idempotently", async () => {
    const sizes: Array<[number, number]> = []
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, {
      width: 10,
      height: 2,
      onTerminalResize: (cols, rows) => sizes.push([cols, rows]),
    })
    setup.renderer.root.add(terminal)
    terminal.write("abcdefghij")
    await setup.renderOnce()

    terminal.width = 5
    terminal.height = 3
    await setup.renderOnce()
    expect(terminal.width).toBe(5)
    expect(terminal.height).toBe(3)
    expect(sizes.some(([cols, rows]) => cols === 5 && rows === 3)).toBe(true)

    terminal.destroy()
    terminal.destroy()
    expect(terminal.isDestroyed).toBe(true)
  })

  test("rejects dimensions that cannot cross the native ABI", () => {
    expect(() => new EmbeddedTerminalRenderable(setup.renderer, { cols: 0, rows: 24 })).toThrow(
      "columns must be an integer between 1 and 65535",
    )
    expect(
      () => new EmbeddedTerminalRenderable(setup.renderer, { cols: 80, rows: 24, maxScrollback: 0x1_0000_0000 }),
    ).toThrow("Embedded terminal maxScrollback exceeds native u32 length limit")
  })

  test("cleans up focus and native state when the data callback throws", () => {
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, {
      width: 20,
      height: 4,
      onData: () => {
        throw new Error("write failed")
      },
    })
    setup.renderer.root.add(terminal)
    terminal.write("\x1b[?1004h")

    expect(() => terminal.focus()).toThrow("write failed")
    expect(terminal.focused).toBe(false)

    terminal.onData = undefined
    terminal.focus()
    terminal.onData = () => {
      throw new Error("write failed")
    }
    terminal.destroy()
    expect(terminal.isDestroyed).toBe(true)
  })

  test("restores terminal cells after render hooks change", async () => {
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, {
      width: 20,
      height: 4,
      renderAfter: (buffer) => {
        buffer.setCell(0, 0, "X", RGBA.fromInts(255, 255, 255, 255), RGBA.fromInts(0, 0, 0, 255))
      },
    })
    setup.renderer.root.add(terminal)
    terminal.write("A")
    await setup.renderOnce()
    expect(setup.captureCharFrame().startsWith("X")).toBe(true)

    terminal.renderAfter = undefined
    terminal.requestRender()
    await setup.renderOnce()
    expect(setup.captureCharFrame().startsWith("A")).toBe(true)
  })

  test("forwards Kitty key releases while focused", () => {
    const output: Uint8Array[] = []
    const terminal = new EmbeddedTerminalRenderable(setup.renderer, {
      width: 20,
      height: 4,
      onData: (data) => output.push(data),
    })
    setup.renderer.root.add(terminal)
    terminal.write("\x1b[>3u")
    terminal.focus()

    setup.renderer.keyInput.processParsedKey({
      name: "a",
      ctrl: false,
      meta: false,
      shift: false,
      option: false,
      sequence: "",
      raw: "",
      number: false,
      eventType: "release",
      source: "kitty",
      code: "KeyA",
    })

    expect(new TextDecoder().decode(output.at(-1))).toBe("\x1b[97;1:3u")
  })
})

function keyEvent(
  options: Pick<ConstructorParameters<typeof KeyEvent>[0], "name" | "sequence"> &
    Partial<ConstructorParameters<typeof KeyEvent>[0]>,
): KeyEvent {
  return new KeyEvent({
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    raw: options.sequence,
    number: false,
    eventType: "press",
    source: "raw",
    ...options,
  })
}
