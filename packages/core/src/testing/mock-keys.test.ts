import { describe, test, expect } from "bun:test"
import { createMockKeys, KeyCodes } from "./mock-keys.js"
import { PassThrough } from "stream"

class MockRenderer {
  public stdin: PassThrough
  public emittedData: Buffer[] = []

  constructor() {
    this.stdin = new PassThrough()

    this.stdin.on("data", (chunk: Buffer) => {
      this.emittedData.push(chunk)
    })
  }

  getEmittedData(): string {
    return Buffer.concat(this.emittedData).toString()
  }
}

describe("mock-keys", () => {
  test("pressKeys with string keys", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKeys(["h", "e", "l", "l", "o"])

    expect(mockRenderer.getEmittedData()).toBe("hello")
  })

  test("pressKeys with KeyCodes", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKeys([KeyCodes.RETURN, KeyCodes.TAB])

    expect(mockRenderer.getEmittedData()).toBe("\r\t")
  })

  test("pressKey with string", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey("a")

    expect(mockRenderer.getEmittedData()).toBe("a")
  })

  test("pressKey with KeyCode", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey(KeyCodes.ESCAPE)

    expect(mockRenderer.getEmittedData()).toBe("\x1b")
  })

  test("typeText", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.typeText("hello world")

    expect(mockRenderer.getEmittedData()).toBe("hello world")
  })

  test("convenience methods", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressEnter()
    mockKeys.pressEscape()
    mockKeys.pressTab()
    mockKeys.pressBackspace()

    expect(mockRenderer.getEmittedData()).toBe("\r\x1b\t\b")
  })

  test("pressArrow", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressArrow("up")
    mockKeys.pressArrow("down")
    mockKeys.pressArrow("left")
    mockKeys.pressArrow("right")

    expect(mockRenderer.getEmittedData()).toBe("\x1b[A\x1b[B\x1b[D\x1b[C")
  })

  test("pressCtrlC", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressCtrlC()

    expect(mockRenderer.getEmittedData()).toBe("\x03")
  })

  test("arbitrary string keys work", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey("x")
    mockKeys.pressKey("y")
    mockKeys.pressKey("z")

    expect(mockRenderer.getEmittedData()).toBe("xyz")
  })

  test("KeyCodes enum values work", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey(KeyCodes.RETURN)
    mockKeys.pressKey(KeyCodes.TAB)
    mockKeys.pressKey(KeyCodes.ESCAPE)

    expect(mockRenderer.getEmittedData()).toBe("\r\t\x1b")
  })

  test("data events are properly emitted", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    const receivedData: Buffer[] = []
    mockRenderer.stdin.on("data", (chunk: Buffer) => {
      receivedData.push(chunk)
    })

    mockKeys.pressKey("a")
    mockKeys.pressKey(KeyCodes.RETURN)

    expect(receivedData).toHaveLength(2)
    expect(receivedData[0].toString()).toBe("a")
    expect(receivedData[1].toString()).toBe("\r")
  })

  test("multiple data events accumulate correctly", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    const receivedData: string[] = []
    mockRenderer.stdin.on("data", (chunk: Buffer) => {
      receivedData.push(chunk.toString())
    })

    mockKeys.typeText("hello")
    mockKeys.pressEnter()

    expect(receivedData).toEqual(["h", "e", "l", "l", "o", "\r"])
  })

  test("stream write method emits data events correctly", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    const emittedChunks: Buffer[] = []
    mockRenderer.stdin.on("data", (chunk: Buffer) => {
      emittedChunks.push(chunk)
    })

    // Directly test the stream write method that mock-keys uses
    mockRenderer.stdin.write("test")
    mockRenderer.stdin.write(KeyCodes.RETURN)

    expect(emittedChunks).toHaveLength(2)
    expect(emittedChunks[0].toString()).toBe("test")
    expect(emittedChunks[1].toString()).toBe("\r")
  })

  test("pressKeys with delay works", async () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    const timestamps: number[] = []
    mockRenderer.stdin.on("data", () => {
      timestamps.push(Date.now())
    })

    const startTime = Date.now()
    await mockKeys.pressKeys(["a", "b"], 10) // 10ms delay between keys
    const totalElapsed = Date.now() - startTime

    expect(timestamps).toHaveLength(2)
    expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(8) // Allow some tolerance
    expect(totalElapsed).toBeGreaterThanOrEqual(16)
  })

  test("pressKey with shift modifier", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey(KeyCodes.ARROW_RIGHT, { shift: true })

    // Arrow right with shift: \x1b[1;2C
    expect(mockRenderer.getEmittedData()).toBe("\x1b[1;2C")
  })

  test("pressKey with ctrl modifier", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey(KeyCodes.ARROW_LEFT, { ctrl: true })

    // Arrow left with ctrl: \x1b[1;5D (1 base + 4 ctrl = 5)
    expect(mockRenderer.getEmittedData()).toBe("\x1b[1;5D")
  })

  test("pressKey with shift+ctrl modifiers", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey(KeyCodes.ARROW_UP, { shift: true, ctrl: true })

    // Arrow up with shift+ctrl: \x1b[1;6A (1 base + 1 shift + 4 ctrl = 6)
    expect(mockRenderer.getEmittedData()).toBe("\x1b[1;6A")
  })

  test("pressKey with meta modifier", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey(KeyCodes.ARROW_DOWN, { meta: true })

    // Arrow down with meta: \x1b[1;3B (1 base + 2 meta = 3)
    expect(mockRenderer.getEmittedData()).toBe("\x1b[1;3B")
  })

  test("pressKey with super modifier", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey(KeyCodes.ARROW_UP, { super: true })

    // Arrow up with super: \x1b[1;9A (1 base + 8 super = 9)
    expect(mockRenderer.getEmittedData()).toBe("\x1b[1;9A")
  })

  test("pressKey with hyper modifier", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey(KeyCodes.ARROW_LEFT, { hyper: true })

    // Arrow left with hyper: \x1b[1;17D (1 base + 16 hyper = 17)
    expect(mockRenderer.getEmittedData()).toBe("\x1b[1;17D")
  })

  test("pressKey with super+hyper modifiers", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey(KeyCodes.ARROW_RIGHT, { super: true, hyper: true })

    // Arrow right with super+hyper: \x1b[1;25C (1 base + 8 super + 16 hyper = 25)
    expect(mockRenderer.getEmittedData()).toBe("\x1b[1;25C")
  })

  test("pressArrow with shift modifier", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressArrow("right", { shift: true })

    expect(mockRenderer.getEmittedData()).toBe("\x1b[1;2C")
  })

  test("pressArrow without modifiers still works", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressArrow("left")

    expect(mockRenderer.getEmittedData()).toBe("\x1b[D")
  })

  test("pressKey with modifiers on HOME key", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey(KeyCodes.HOME, { shift: true })

    // HOME with shift: \x1b[1;2H
    expect(mockRenderer.getEmittedData()).toBe("\x1b[1;2H")
  })

  test("pressKey with modifiers on END key", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey(KeyCodes.END, { shift: true })

    // END with shift: \x1b[1;2F
    expect(mockRenderer.getEmittedData()).toBe("\x1b[1;2F")
  })

  test("pressKey with meta on regular character", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey("a", { meta: true })

    // Meta+a: \x1ba (escape + a)
    expect(mockRenderer.getEmittedData()).toBe("\x1ba")
  })

  test("pressKey with meta+shift on character", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey("a", { meta: true, shift: true })

    // Meta+Shift+a: \x1bA (escape + uppercase A)
    expect(mockRenderer.getEmittedData()).toBe("\x1bA")
  })

  test("pressKey with meta+ctrl on arrow", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey(KeyCodes.ARROW_RIGHT, { meta: true, ctrl: true })

    // Arrow right with meta+ctrl: \x1b[1;7C (1 base + 2 meta + 4 ctrl = 7)
    expect(mockRenderer.getEmittedData()).toBe("\x1b[1;7C")
  })

  test("pressKey with meta+shift+ctrl on arrow", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey(KeyCodes.ARROW_UP, { meta: true, shift: true, ctrl: true })

    // Arrow up with all modifiers: \x1b[1;8A (1 base + 1 shift + 2 meta + 4 ctrl = 8)
    expect(mockRenderer.getEmittedData()).toBe("\x1b[1;8A")
  })

  test("pressArrow with meta modifier", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressArrow("left", { meta: true })

    // Arrow left with meta: \x1b[1;3D
    expect(mockRenderer.getEmittedData()).toBe("\x1b[1;3D")
  })

  test("pressArrow with meta+shift modifiers", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressArrow("down", { meta: true, shift: true })

    // Arrow down with meta+shift: \x1b[1;4B (1 base + 1 shift + 2 meta = 4)
    expect(mockRenderer.getEmittedData()).toBe("\x1b[1;4B")
  })

  test("meta modifier produces escape sequences", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey("a", { meta: true })
    mockKeys.pressKey("z", { meta: true })

    expect(mockRenderer.getEmittedData()).toBe("\x1ba\x1bz")
  })

  test("pressEnter with modifiers", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressEnter({ meta: true })

    expect(mockRenderer.getEmittedData()).toBe("\x1b\r")
  })

  test("pressTab with shift modifier", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressTab({ shift: true })

    expect(mockRenderer.getEmittedData()).toBe("\x1b[Z")
  })

  test("pressTab with shift modifier parses as shift+tab", async () => {
    const { parseKeypress } = await import("../lib/parse.keypress.js")
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressTab({ shift: true })

    const result = parseKeypress(mockRenderer.getEmittedData())
    expect(result).not.toBeNull()
    expect(result?.name).toBe("tab")
    expect(result?.shift).toBe(true)
  })

  test("pressTab without modifiers still sends raw tab", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressTab()

    expect(mockRenderer.getEmittedData()).toBe("\t")
  })

  test("pressEscape with ctrl modifier", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressEscape({ ctrl: true })

    expect(mockRenderer.getEmittedData()).toBe("\x1b")
  })

  test("pressBackspace with meta modifier", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressBackspace({ meta: true })

    expect(mockRenderer.getEmittedData()).toBe("\x1b\b")
  })

  test("pressKey with ctrl on letter produces control code", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey("a", { ctrl: true })
    mockKeys.pressKey("z", { ctrl: true })

    expect(mockRenderer.getEmittedData()).toBe("\x01\x1a")
  })

  test("pressKey with ctrl on uppercase letter", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey("A", { ctrl: true })

    expect(mockRenderer.getEmittedData()).toBe("\x01")
  })

  test("pressKey with ctrl+meta combination", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey("a", { ctrl: true, meta: true })

    expect(mockRenderer.getEmittedData()).toBe("\x1b\x01")
  })

  test("ctrl modifier produces control codes", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey("a", { ctrl: true })
    mockKeys.pressKey("c", { ctrl: true })
    mockKeys.pressKey("d", { ctrl: true })

    expect(mockRenderer.getEmittedData()).toBe("\x01\x03\x04")
  })

  test("meta modifier produces escape sequences", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    mockKeys.pressKey("a", { meta: true })
    mockKeys.pressKey("z", { meta: true })

    expect(mockRenderer.getEmittedData()).toBe("\x1ba\x1bz")
  })

  test("all CTRL_* letters produce correct control codes", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    const letters = "abcdefghijklmnopqrstuvwxyz"
    for (const letter of letters) {
      mockKeys.pressKey(letter, { ctrl: true })
    }

    const expected = letters
      .split("")
      .map((c) => String.fromCharCode(c.charCodeAt(0) - 96))
      .join("")
    expect(mockRenderer.getEmittedData()).toBe(expected)
  })

  test("pressKey with ctrl modifier produces control code", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)
    mockKeys.pressKey("c", { ctrl: true })

    expect(mockRenderer.getEmittedData()).toBe("\x03")
  })

  test("pressKey with meta modifier on letters produces escape sequences", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)
    mockKeys.pressKey("x", { meta: true })

    expect(mockRenderer.getEmittedData()).toBe("\x1bx")
  })

  test("pressKey with ctrl modifier on special characters", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    // Ctrl+- should produce \u001f (ASCII 31, Unit Separator)
    mockRenderer.emittedData = []
    mockKeys.pressKey("-", { ctrl: true })
    expect(mockRenderer.getEmittedData()).toBe("\u001f")

    // Ctrl+. should produce \u001e (ASCII 30, Record Separator)
    mockRenderer.emittedData = []
    mockKeys.pressKey(".", { ctrl: true })
    expect(mockRenderer.getEmittedData()).toBe("\u001e")

    // Ctrl+, should produce \u001c (ASCII 28, File Separator)
    mockRenderer.emittedData = []
    mockKeys.pressKey(",", { ctrl: true })
    expect(mockRenderer.getEmittedData()).toBe("\u001c")

    // Ctrl+] should produce \u001d (ASCII 29, Group Separator)
    mockRenderer.emittedData = []
    mockKeys.pressKey("]", { ctrl: true })
    expect(mockRenderer.getEmittedData()).toBe("\u001d")

    // Ctrl+[ should produce \x1b (ASCII 27, Escape)
    mockRenderer.emittedData = []
    mockKeys.pressKey("[", { ctrl: true })
    expect(mockRenderer.getEmittedData()).toBe("\x1b")

    // Ctrl+/ should produce \u001f (ASCII 31, same as Ctrl+-)
    mockRenderer.emittedData = []
    mockKeys.pressKey("/", { ctrl: true })
    expect(mockRenderer.getEmittedData()).toBe("\u001f")

    // Ctrl+_ should also produce \u001f (ASCII 31)
    mockRenderer.emittedData = []
    mockKeys.pressKey("_", { ctrl: true })
    expect(mockRenderer.getEmittedData()).toBe("\u001f")
  })

  test("pressKey with ctrl modifier on all special control characters", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    // Test all standard control character mappings
    const tests = [
      { key: "[", expected: "\x1b" }, // ESC
      { key: "\\", expected: "\x1c" }, // FS
      { key: "]", expected: "\x1d" }, // GS
      { key: "^", expected: "\x1e" }, // RS
      { key: "_", expected: "\x1f" }, // US
      { key: "?", expected: "\x7f" }, // DEL
      { key: "@", expected: "\x00" }, // NUL
      { key: " ", expected: "\x00" }, // NUL (Ctrl+Space)
    ]

    for (const { key, expected } of tests) {
      mockRenderer.emittedData = []
      mockKeys.pressKey(key, { ctrl: true })
      expect(mockRenderer.getEmittedData()).toBe(expected)
    }
  })

  test("pressKey with ctrl+meta on special characters", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    // Ctrl+Meta+- should produce ESC + \u001f
    mockRenderer.emittedData = []
    mockKeys.pressKey("-", { ctrl: true, meta: true })
    expect(mockRenderer.getEmittedData()).toBe("\x1b\u001f")

    // Ctrl+Meta+] should produce ESC + \u001d
    mockRenderer.emittedData = []
    mockKeys.pressKey("]", { ctrl: true, meta: true })
    expect(mockRenderer.getEmittedData()).toBe("\x1b\u001d")
  })

  test("pressKey with ctrl on special chars does NOT use kitty keyboard", () => {
    const mockRenderer = new MockRenderer()
    // Explicitly use non-kitty mode
    const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: false })

    mockKeys.pressKey("-", { ctrl: true })

    // Should produce raw control sequence, NOT kitty CSI u sequence
    const data = mockRenderer.getEmittedData()
    expect(data).toBe("\u001f")
    expect(data).not.toContain("[") // Should not contain CSI
    expect(data).not.toContain("u") // Should not contain kitty 'u' ending
  })

  test("comprehensive test: all punctuation keys work with ctrl modifier", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    // Test multiple punctuation keys in sequence
    mockKeys.pressKey("-", { ctrl: true })
    mockKeys.pressKey(".", { ctrl: true })
    mockKeys.pressKey(",", { ctrl: true })
    mockKeys.pressKey("]", { ctrl: true })
    mockKeys.pressKey("[", { ctrl: true })

    const expected = "\u001f\u001e\u001c\u001d\x1b"
    expect(mockRenderer.getEmittedData()).toBe(expected)
  })

  test("ctrl modifier with non-mapped characters preserves original", () => {
    const mockRenderer = new MockRenderer()
    const mockKeys = createMockKeys(mockRenderer as any)

    // Characters without specific ctrl mappings should be preserved
    // (though in real terminals they might not do anything)
    mockKeys.pressKey("(", { ctrl: true })

    // Should preserve the character since it's not in the mapping
    expect(mockRenderer.getEmittedData()).toBe("(")
  })

  describe("Kitty Keyboard Protocol Mode", () => {
    test("basic character in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressKey("a")

      expect(mockRenderer.getEmittedData()).toBe("\x1b[97u")
    })

    test("backspace without modifiers in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressBackspace()

      expect(mockRenderer.getEmittedData()).toBe("\x1b[127u")
    })

    test("backspace with shift in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressBackspace({ shift: true })

      // Kitty protocol: backspace(127) with shift modifier (1+1=2)
      expect(mockRenderer.getEmittedData()).toBe("\x1b[127;2u")
    })

    test("backspace with ctrl in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressBackspace({ ctrl: true })

      // Kitty protocol: backspace(127) with ctrl modifier (4+1=5)
      expect(mockRenderer.getEmittedData()).toBe("\x1b[127;5u")
    })

    test("backspace with meta in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressBackspace({ meta: true })

      // Kitty protocol: backspace(127) with meta modifier (2+1=3)
      expect(mockRenderer.getEmittedData()).toBe("\x1b[127;3u")
    })

    test("backspace with shift+meta in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressBackspace({ shift: true, meta: true })

      // Kitty protocol: backspace(127) with shift+meta (1+2+1=4)
      expect(mockRenderer.getEmittedData()).toBe("\x1b[127;4u")
    })

    test("delete key in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressKey("DELETE")

      expect(mockRenderer.getEmittedData()).toBe("\x1b[57349u")
    })

    test("arrow keys in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressArrow("up")
      mockKeys.pressArrow("down")
      mockKeys.pressArrow("left")
      mockKeys.pressArrow("right")

      expect(mockRenderer.getEmittedData()).toBe("\x1b[57352u\x1b[57353u\x1b[57350u\x1b[57351u")
    })

    test("arrow key with shift in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressArrow("right", { shift: true })

      expect(mockRenderer.getEmittedData()).toBe("\x1b[57351;2u")
    })

    test("arrow key with ctrl in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressArrow("left", { ctrl: true })

      expect(mockRenderer.getEmittedData()).toBe("\x1b[57350;5u")
    })

    test("arrow key with meta in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressArrow("down", { meta: true })

      expect(mockRenderer.getEmittedData()).toBe("\x1b[57353;3u")
    })

    test("arrow key with shift+ctrl+meta in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressArrow("up", { shift: true, ctrl: true, meta: true })

      // shift(1) + meta(2) + ctrl(4) = 7, plus 1 = 8
      expect(mockRenderer.getEmittedData()).toBe("\x1b[57352;8u")
    })

    test("enter/return in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressEnter()

      expect(mockRenderer.getEmittedData()).toBe("\x1b[13u")
    })

    test("enter with meta in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressEnter({ meta: true })

      expect(mockRenderer.getEmittedData()).toBe("\x1b[13;3u")
    })

    test("tab in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressTab()

      expect(mockRenderer.getEmittedData()).toBe("\x1b[9u")
    })

    test("tab with shift in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressTab({ shift: true })

      expect(mockRenderer.getEmittedData()).toBe("\x1b[9;2u")
    })

    test("escape in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressEscape()

      expect(mockRenderer.getEmittedData()).toBe("\x1b[27u")
    })

    test("home key in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressKey("HOME")

      expect(mockRenderer.getEmittedData()).toBe("\x1b[57356u")
    })

    test("home with shift in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressKey("HOME", { shift: true })

      expect(mockRenderer.getEmittedData()).toBe("\x1b[57356;2u")
    })

    test("end key in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressKey("END")

      expect(mockRenderer.getEmittedData()).toBe("\x1b[57357u")
    })

    test("function keys in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressKey("F1")
      mockKeys.pressKey("F2")
      mockKeys.pressKey("F12")

      expect(mockRenderer.getEmittedData()).toBe("\x1b[57364u\x1b[57365u\x1b[57375u")
    })

    test("regular characters with shift in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressKey("a", { shift: true })

      // 'a' (97) with shift modifier
      expect(mockRenderer.getEmittedData()).toBe("\x1b[97;2u")
    })

    test("regular characters with ctrl in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressKey("c", { ctrl: true })

      // 'c' (99) with ctrl modifier (4+1=5)
      expect(mockRenderer.getEmittedData()).toBe("\x1b[99;5u")
    })

    test("regular characters with meta in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressKey("x", { meta: true })

      // 'x' (120) with meta modifier (2+1=3)
      expect(mockRenderer.getEmittedData()).toBe("\x1b[120;3u")
    })

    test("multiple keys in sequence in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressKey("h")
      mockKeys.pressKey("i")

      expect(mockRenderer.getEmittedData()).toBe("\x1b[104u\x1b[105u")
    })

    test("mixed modifier combinations in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressKey("a")
      mockKeys.pressKey("a", { shift: true })
      mockKeys.pressKey("a", { ctrl: true })
      mockKeys.pressKey("a", { meta: true })
      mockKeys.pressKey("a", { shift: true, ctrl: true })

      expect(mockRenderer.getEmittedData()).toBe(
        "\x1b[97u" + // no mods
          "\x1b[97;2u" + // shift
          "\x1b[97;5u" + // ctrl
          "\x1b[97;3u" + // meta
          "\x1b[97;6u", // shift+ctrl
      )
    })

    test("character with super modifier in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressKey("a", { super: true })

      // 'a' (97) with super modifier (8+1=9)
      expect(mockRenderer.getEmittedData()).toBe("\x1b[97;9u")
    })

    test("character with hyper modifier in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressKey("a", { hyper: true })

      // 'a' (97) with hyper modifier (16+1=17)
      expect(mockRenderer.getEmittedData()).toBe("\x1b[97;17u")
    })

    test("character with super+hyper modifiers in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressKey("a", { super: true, hyper: true })

      // 'a' (97) with super+hyper (8+16+1=25)
      expect(mockRenderer.getEmittedData()).toBe("\x1b[97;25u")
    })

    test("character with all modifiers in kitty mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressKey("a", { shift: true, ctrl: true, meta: true, super: true, hyper: true })

      // 'a' (97) with all modifiers: shift(1) + meta(2) + ctrl(4) + super(8) + hyper(16) = 31, +1 = 32
      expect(mockRenderer.getEmittedData()).toBe("\x1b[97;32u")
    })

    test("kitty mode vs regular mode comparison", () => {
      const kittyRenderer = new MockRenderer()
      const regularRenderer = new MockRenderer()
      const kittyKeys = createMockKeys(kittyRenderer as any, { kittyKeyboard: true })
      const regularKeys = createMockKeys(regularRenderer as any, { kittyKeyboard: false })

      kittyKeys.pressBackspace({ shift: true })
      regularKeys.pressBackspace({ shift: true })

      // Kitty should send the protocol sequence with modifier
      expect(kittyRenderer.getEmittedData()).toBe("\x1b[127;2u")
      // Regular should just send backspace (shift is ignored)
      expect(regularRenderer.getEmittedData()).toBe("\b")
    })

    test("special characters with ctrl in kitty mode", () => {
      const kittyRenderer = new MockRenderer()
      const regularRenderer = new MockRenderer()
      const kittyKeys = createMockKeys(kittyRenderer as any, { kittyKeyboard: true })
      const regularKeys = createMockKeys(regularRenderer as any, { kittyKeyboard: false })

      // Test Ctrl+- in both modes
      kittyKeys.pressKey("-", { ctrl: true })
      regularKeys.pressKey("-", { ctrl: true })

      // Kitty should send the protocol sequence: '-' is codepoint 45, ctrl modifier is 4+1=5
      expect(kittyRenderer.getEmittedData()).toBe("\x1b[45;5u")
      // Regular should send raw control sequence \u001f
      expect(regularRenderer.getEmittedData()).toBe("\u001f")
    })

    test("various special characters with ctrl in kitty mode", () => {
      const kittyRenderer = new MockRenderer()
      const kittyKeys = createMockKeys(kittyRenderer as any, { kittyKeyboard: true })

      // Test multiple special characters
      kittyRenderer.emittedData = []
      kittyKeys.pressKey(".", { ctrl: true })
      expect(kittyRenderer.getEmittedData()).toBe("\x1b[46;5u") // '.' is codepoint 46

      kittyRenderer.emittedData = []
      kittyKeys.pressKey(",", { ctrl: true })
      expect(kittyRenderer.getEmittedData()).toBe("\x1b[44;5u") // ',' is codepoint 44

      kittyRenderer.emittedData = []
      kittyKeys.pressKey("]", { ctrl: true })
      expect(kittyRenderer.getEmittedData()).toBe("\x1b[93;5u") // ']' is codepoint 93
    })
  })

  describe("modifyOtherKeys Mode (CSI u variant)", () => {
    test("modifyOtherKeys sequences can be parsed by parseKeypress", async () => {
      const { parseKeypress } = await import("../lib/parse.keypress.js")

      // Test that our generated sequences can be parsed correctly
      const tests = [
        { seq: "\x1b[27;5;97~", expectedName: "a", expectedCtrl: true },
        { seq: "\x1b[27;2;13~", expectedName: "return", expectedShift: true },
        { seq: "\x1b[27;5;27~", expectedName: "escape", expectedCtrl: true },
        { seq: "\x1b[27;2;9~", expectedName: "tab", expectedShift: true },
        { seq: "\x1b[27;5;32~", expectedName: "space", expectedCtrl: true },
        { seq: "\x1b[27;6;97~", expectedName: "a", expectedShift: true, expectedCtrl: true },
      ]

      for (const test of tests) {
        const result = parseKeypress(test.seq)
        expect(result).not.toBeNull()
        expect(result?.name).toBe(test.expectedName)
        if (test.expectedCtrl !== undefined) {
          expect(result?.ctrl).toBe(test.expectedCtrl)
        }
        if (test.expectedShift !== undefined) {
          expect(result?.shift).toBe(test.expectedShift)
        }
      }
    })

    test("basic character without modifiers in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressKey("a")

      // Without modifiers, should send plain character
      expect(mockRenderer.getEmittedData()).toBe("a")
    })

    test("character with ctrl in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressKey("a", { ctrl: true })

      // modifyOtherKeys format: CSI 27 ; modifier ; code ~
      // 'a' is charCode 97, ctrl is 4, modifier is 4+1=5
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;5;97~")
    })

    test("character with shift in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressKey("a", { shift: true })

      // 'a' is charCode 97, shift is 1, modifier is 1+1=2
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;2;97~")
    })

    test("character with meta in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressKey("a", { meta: true })

      // 'a' is charCode 97, meta is 2, modifier is 2+1=3
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;3;97~")
    })

    test("return/enter with ctrl in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressEnter({ ctrl: true })

      // return is charCode 13, ctrl is 4, modifier is 4+1=5
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;5;13~")
    })

    test("return with shift in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressEnter({ shift: true })

      // return is charCode 13, shift is 1, modifier is 1+1=2
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;2;13~")
    })

    test("escape with ctrl in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressEscape({ ctrl: true })

      // escape is charCode 27, ctrl is 4, modifier is 4+1=5
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;5;27~")
    })

    test("tab with ctrl in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressTab({ ctrl: true })

      // tab is charCode 9, ctrl is 4, modifier is 4+1=5
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;5;9~")
    })

    test("tab with shift in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressTab({ shift: true })

      // tab is charCode 9, shift is 1, modifier is 1+1=2
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;2;9~")
    })

    test("backspace with ctrl in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressBackspace({ ctrl: true })

      // backspace is charCode 127, ctrl is 4, modifier is 4+1=5
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;5;127~")
    })

    test("backspace with meta in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressBackspace({ meta: true })

      // backspace is charCode 127, meta is 2, modifier is 2+1=3
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;3;127~")
    })

    test("space with ctrl in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressKey(" ", { ctrl: true })

      // space is charCode 32, ctrl is 4, modifier is 4+1=5
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;5;32~")
    })

    test("special characters with ctrl in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      // Ctrl+- should use modifyOtherKeys format
      mockRenderer.emittedData = []
      mockKeys.pressKey("-", { ctrl: true })
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;5;45~") // '-' is charCode 45

      // Ctrl+. should use modifyOtherKeys format
      mockRenderer.emittedData = []
      mockKeys.pressKey(".", { ctrl: true })
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;5;46~") // '.' is charCode 46

      // Ctrl+, should use modifyOtherKeys format
      mockRenderer.emittedData = []
      mockKeys.pressKey(",", { ctrl: true })
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;5;44~") // ',' is charCode 44

      // Ctrl+] should use modifyOtherKeys format
      mockRenderer.emittedData = []
      mockKeys.pressKey("]", { ctrl: true })
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;5;93~") // ']' is charCode 93
    })

    test("multiple modifier combinations in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      // shift + ctrl: 1 + 4 = 5, + 1 = 6
      mockRenderer.emittedData = []
      mockKeys.pressKey("a", { shift: true, ctrl: true })
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;6;97~")

      // shift + meta: 1 + 2 = 3, + 1 = 4
      mockRenderer.emittedData = []
      mockKeys.pressKey("a", { shift: true, meta: true })
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;4;97~")

      // ctrl + meta: 4 + 2 = 6, + 1 = 7
      mockRenderer.emittedData = []
      mockKeys.pressKey("a", { ctrl: true, meta: true })
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;7;97~")

      // shift + ctrl + meta: 1 + 4 + 2 = 7, + 1 = 8
      mockRenderer.emittedData = []
      mockKeys.pressKey("a", { shift: true, ctrl: true, meta: true })
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;8;97~")
    })

    test("character with super modifier in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressKey("a", { super: true })

      // 'a' is charCode 97, super is 8, modifier is 8+1=9
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;9;97~")
    })

    test("character with hyper modifier in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressKey("a", { hyper: true })

      // 'a' is charCode 97, hyper is 16, modifier is 16+1=17
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;17;97~")
    })

    test("character with super+hyper modifiers in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressKey("a", { super: true, hyper: true })

      // super(8) + hyper(16) = 24, +1 = 25
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;25;97~")
    })

    test("character with all modifiers in modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressKey("a", { shift: true, ctrl: true, meta: true, super: true, hyper: true })

      // shift(1) + meta(2) + ctrl(4) + super(8) + hyper(16) = 31, +1 = 32
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;32;97~")
    })

    test("arrow keys with modifiers fall through to regular mode in modifyOtherKeys", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      // Arrow keys should still use the standard CSI sequence with modifiers
      // not the modifyOtherKeys format
      mockKeys.pressArrow("right", { shift: true })

      expect(mockRenderer.getEmittedData()).toBe("\x1b[1;2C")
    })

    test("kitty mode takes precedence over modifyOtherKeys mode", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, {
        kittyKeyboard: true,
        otherModifiersMode: true,
      })

      mockKeys.pressKey("a", { ctrl: true })

      // Should use kitty format, not modifyOtherKeys
      expect(mockRenderer.getEmittedData()).toBe("\x1b[97;5u")
    })

    test("modifyOtherKeys vs regular mode comparison", () => {
      const modifyOtherKeysRenderer = new MockRenderer()
      const regularRenderer = new MockRenderer()
      const modifyOtherKeysKeys = createMockKeys(modifyOtherKeysRenderer as any, { otherModifiersMode: true })
      const regularKeys = createMockKeys(regularRenderer as any, { otherModifiersMode: false })

      modifyOtherKeysKeys.pressKey("-", { ctrl: true })
      regularKeys.pressKey("-", { ctrl: true })

      // modifyOtherKeys should send CSI 27 format
      expect(modifyOtherKeysRenderer.getEmittedData()).toBe("\x1b[27;5;45~")
      // Regular should send raw control sequence
      expect(regularRenderer.getEmittedData()).toBe("\u001f")
    })

    test("characters without modifiers don't use modifyOtherKeys format", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      // Without modifiers, should send plain characters
      mockKeys.pressKey("a")
      mockKeys.pressKey("b")
      mockKeys.pressEnter()

      expect(mockRenderer.getEmittedData()).toBe("ab\r")
    })

    test("modifyOtherKeys with all printable characters", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      const chars = "abcdefghijklmnopqrstuvwxyz0123456789-=[]\\;',./`"

      for (const char of chars) {
        mockRenderer.emittedData = []
        mockKeys.pressKey(char, { ctrl: true })
        const charCode = char.charCodeAt(0)
        expect(mockRenderer.getEmittedData()).toBe(`\x1b[27;5;${charCode}~`)
      }
    })

    test("modifyOtherKeys mode can be parsed back correctly", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      // Test various keys with modifiers
      const tests = [
        { key: "a", mods: { ctrl: true }, expectedSeq: "\x1b[27;5;97~" },
        { key: "-", mods: { ctrl: true }, expectedSeq: "\x1b[27;5;45~" },
        { key: KeyCodes.RETURN, mods: { shift: true }, expectedSeq: "\x1b[27;2;13~" },
        { key: KeyCodes.ESCAPE, mods: { ctrl: true }, expectedSeq: "\x1b[27;5;27~" },
        { key: KeyCodes.TAB, mods: { shift: true }, expectedSeq: "\x1b[27;2;9~" },
        { key: " ", mods: { ctrl: true }, expectedSeq: "\x1b[27;5;32~" },
      ]

      for (const { key, mods, expectedSeq } of tests) {
        mockRenderer.emittedData = []
        mockKeys.pressKey(key, mods)
        expect(mockRenderer.getEmittedData()).toBe(expectedSeq)
      }
    })

    test("comprehensive three-mode comparison: regular vs modifyOtherKeys vs kitty", () => {
      const regularRenderer = new MockRenderer()
      const modifyOtherKeysRenderer = new MockRenderer()
      const kittyRenderer = new MockRenderer()

      const regularKeys = createMockKeys(regularRenderer as any, { kittyKeyboard: false, otherModifiersMode: false })
      const modifyOtherKeysKeys = createMockKeys(modifyOtherKeysRenderer as any, { otherModifiersMode: true })
      const kittyKeys = createMockKeys(kittyRenderer as any, { kittyKeyboard: true })

      // Test Ctrl+- in all three modes
      regularKeys.pressKey("-", { ctrl: true })
      modifyOtherKeysKeys.pressKey("-", { ctrl: true })
      kittyKeys.pressKey("-", { ctrl: true })

      expect(regularRenderer.getEmittedData()).toBe("\u001f") // Raw control sequence
      expect(modifyOtherKeysRenderer.getEmittedData()).toBe("\x1b[27;5;45~") // modifyOtherKeys format
      expect(kittyRenderer.getEmittedData()).toBe("\x1b[45;5u") // Kitty format

      // Test Shift+Enter in all three modes
      regularRenderer.emittedData = []
      modifyOtherKeysRenderer.emittedData = []
      kittyRenderer.emittedData = []

      regularKeys.pressEnter({ shift: true })
      modifyOtherKeysKeys.pressEnter({ shift: true })
      kittyKeys.pressEnter({ shift: true })

      expect(regularRenderer.getEmittedData()).toBe("\r") // Regular mode ignores shift on Enter
      expect(modifyOtherKeysRenderer.getEmittedData()).toBe("\x1b[27;2;13~") // modifyOtherKeys format
      expect(kittyRenderer.getEmittedData()).toBe("\x1b[13;2u") // Kitty format
    })
  })

  describe("Mode selection and precedence", () => {
    test("default mode (no options)", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any)

      mockKeys.pressKey("-", { ctrl: true })

      // Default should use raw control sequences
      expect(mockRenderer.getEmittedData()).toBe("\u001f")
    })

    test("only kittyKeyboard enabled", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { kittyKeyboard: true })

      mockKeys.pressKey("a", { ctrl: true })

      // Should use kitty format
      expect(mockRenderer.getEmittedData()).toBe("\x1b[97;5u")
    })

    test("only otherModifiersMode enabled", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, { otherModifiersMode: true })

      mockKeys.pressKey("a", { ctrl: true })

      // Should use modifyOtherKeys format
      expect(mockRenderer.getEmittedData()).toBe("\x1b[27;5;97~")
    })

    test("both kittyKeyboard and otherModifiersMode enabled (kitty wins)", () => {
      const mockRenderer = new MockRenderer()
      const mockKeys = createMockKeys(mockRenderer as any, {
        kittyKeyboard: true,
        otherModifiersMode: true,
      })

      mockKeys.pressKey("a", { ctrl: true })

      // Kitty should take precedence
      expect(mockRenderer.getEmittedData()).toBe("\x1b[97;5u")
      expect(mockRenderer.getEmittedData()).not.toContain("27;5;97~")
    })
  })
})
