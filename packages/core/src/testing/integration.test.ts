import { describe, test, expect } from "bun:test"
import { createMockMouse, MouseButtons } from "./mock-mouse"
import { MouseParser } from "../lib/parse.mouse"

class MockRenderer {
  public stdin: { emit: (event: string, data: Buffer) => void }
  public emittedData: Buffer[] = []

  constructor() {
    this.stdin = {
      emit: (event: string, chunk: Buffer) => {
        this.emittedData.push(chunk)
      },
    }
  }

  getEmittedData(): Buffer {
    return Buffer.concat(this.emittedData)
  }
}

// Helper function to parse all events from buffer
function parseAllEvents(emittedData: Buffer, parser: MouseParser) {
  const parsedEvents: NonNullable<ReturnType<MouseParser["parseMouseEvent"]>>[] = []
  let offset = 0
  while (offset < emittedData.length) {
    const result = parser.parseMouseEventWithConsumed(emittedData.subarray(offset))
    if (result) {
      parsedEvents.push(result.event)
      offset += result.consumed
    } else {
      break
    }
  }
  return parsedEvents
}

describe("mock-mouse + parser integration", () => {
  test("simple click is correctly parsed", async () => {
    const mockRenderer = new MockRenderer()
    const mockMouse = createMockMouse(mockRenderer as any)
    const parser = new MouseParser()

    await mockMouse.click(10, 5)
    const parsedEvents = parseAllEvents(mockRenderer.getEmittedData(), parser)

    expect(parsedEvents).toHaveLength(2)
    expect(parsedEvents[0]).toEqual({
      type: "down",
      button: 0,
      x: 10,
      y: 5,
      modifiers: { shift: false, alt: false, ctrl: false },
      scroll: undefined,
    })
    expect(parsedEvents[1]).toEqual({
      type: "up",
      button: 0,
      x: 10,
      y: 5,
      modifiers: { shift: false, alt: false, ctrl: false },
      scroll: undefined,
    })
  })

  test("double click is correctly parsed", async () => {
    const mockRenderer = new MockRenderer()
    const mockMouse = createMockMouse(mockRenderer as any)
    const parser = new MouseParser()

    await mockMouse.doubleClick(10, 5)
    const parsedEvents = parseAllEvents(mockRenderer.getEmittedData(), parser)

    expect(parsedEvents).toHaveLength(4)
    // All events should be at the same position with LEFT button
    parsedEvents.forEach((event) => {
      expect(event.x).toBe(10)
      expect(event.y).toBe(5)
      expect(event.button).toBe(0)
    })
    // Should alternate down/up
    expect(parsedEvents.map((e) => e.type)).toEqual(["down", "up", "down", "up"])
  })

  test("pressDown and release separately are correctly parsed", async () => {
    const mockRenderer = new MockRenderer()
    const mockMouse = createMockMouse(mockRenderer as any)
    const parser = new MouseParser()

    await mockMouse.pressDown(10, 5, MouseButtons.MIDDLE)
    await mockMouse.release(10, 5, MouseButtons.MIDDLE)
    const parsedEvents = parseAllEvents(mockRenderer.getEmittedData(), parser)

    expect(parsedEvents).toHaveLength(2)
    expect(parsedEvents[0]).toEqual({
      type: "down",
      button: 1, // MIDDLE button
      x: 10,
      y: 5,
      modifiers: { shift: false, alt: false, ctrl: false },
      scroll: undefined,
    })
    expect(parsedEvents[1]).toEqual({
      type: "up",
      button: 1,
      x: 10,
      y: 5,
      modifiers: { shift: false, alt: false, ctrl: false },
      scroll: undefined,
    })
  })

  test("different buttons work correctly", async () => {
    const mockRenderer = new MockRenderer()
    const mockMouse = createMockMouse(mockRenderer as any)
    const parser = new MouseParser()

    // Test RIGHT button
    await mockMouse.click(10, 5, MouseButtons.RIGHT)
    const parsedEvents = parseAllEvents(mockRenderer.getEmittedData(), parser)

    expect(parsedEvents).toHaveLength(2)
    parsedEvents.forEach((event) => {
      expect(event.button).toBe(2) // RIGHT button
      expect(event.x).toBe(10)
      expect(event.y).toBe(5)
    })
  })

  test("all scroll directions are correctly parsed", async () => {
    const mockRenderer = new MockRenderer()
    const mockMouse = createMockMouse(mockRenderer as any)
    const parser = new MouseParser()

    await mockMouse.scroll(15, 8, "up")
    await mockMouse.scroll(15, 8, "down")
    await mockMouse.scroll(15, 8, "left")
    await mockMouse.scroll(15, 8, "right")

    const parsedEvents = parseAllEvents(mockRenderer.getEmittedData(), parser)

    expect(parsedEvents).toHaveLength(4)
    const expectedDirections: ("up" | "down" | "left" | "right")[] = ["up", "down", "left", "right"]
    const expectedButtons = [0, 1, 2, 0] // Based on parser logic: button & 3, with button=3 becoming 0
    parsedEvents.forEach((event, index) => {
      expect(event.type).toBe("scroll")
      expect(event.button).toBe(expectedButtons[index])
      expect(event.x).toBe(15)
      expect(event.y).toBe(8)
      expect(event.scroll).toEqual({
        direction: expectedDirections[index],
        delta: 1,
      })
    })
  })

  test("scroll with modifiers is correctly parsed", async () => {
    const mockRenderer = new MockRenderer()
    const mockMouse = createMockMouse(mockRenderer as any)
    const parser = new MouseParser()

    await mockMouse.scroll(15, 8, "left", { modifiers: { shift: true } })
    const parsedEvents = parseAllEvents(mockRenderer.getEmittedData(), parser)

    expect(parsedEvents).toHaveLength(1)
    expect(parsedEvents[0]).toEqual({
      type: "scroll",
      button: 2, // WHEEL_LEFT (66) & 3 = 2
      x: 15,
      y: 8,
      modifiers: { shift: true, alt: false, ctrl: false },
      scroll: { direction: "left", delta: 1 },
    })
  })

  test("drag events are correctly parsed", async () => {
    const mockRenderer = new MockRenderer()
    const mockMouse = createMockMouse(mockRenderer as any)
    const parser = new MouseParser()

    await mockMouse.drag(5, 5, 15, 10)
    const parsedEvents = parseAllEvents(mockRenderer.getEmittedData(), parser)

    // Should have down, several drag events, and up
    expect(parsedEvents.length).toBeGreaterThan(3)
    expect(parsedEvents[0].type).toBe("down")
    expect(parsedEvents[0].button).toBe(0)
    expect(parsedEvents[0].x).toBe(5)
    expect(parsedEvents[0].y).toBe(5)

    // Check that intermediate events are drag events
    for (let i = 1; i < parsedEvents.length - 1; i++) {
      expect(parsedEvents[i].type).toBe("drag")
      expect(parsedEvents[i].button).toBe(0)
    }

    const lastEvent = parsedEvents[parsedEvents.length - 1]
    expect(lastEvent.type).toBe("up")
    expect(lastEvent.x).toBe(15)
    expect(lastEvent.y).toBe(10)
  })

  test("moveTo without button press generates move events", async () => {
    const mockRenderer = new MockRenderer()
    const mockMouse = createMockMouse(mockRenderer as any)
    const parser = new MouseParser()

    await mockMouse.moveTo(15, 8)
    const parsedEvents = parseAllEvents(mockRenderer.getEmittedData(), parser)

    expect(parsedEvents).toHaveLength(1)
    expect(parsedEvents[0]).toEqual({
      type: "move",
      button: 0,
      x: 15,
      y: 8,
      modifiers: { shift: false, alt: false, ctrl: false },
      scroll: undefined,
    })
  })

  test("moveTo with button press generates drag events", async () => {
    const mockRenderer = new MockRenderer()
    const mockMouse = createMockMouse(mockRenderer as any)
    const parser = new MouseParser()

    await mockMouse.pressDown(5, 5)
    await mockMouse.moveTo(15, 8)
    const parsedEvents = parseAllEvents(mockRenderer.getEmittedData(), parser)

    expect(parsedEvents).toHaveLength(2)
    expect(parsedEvents[0].type).toBe("down")
    expect(parsedEvents[1].type).toBe("drag")
    expect(parsedEvents[1].x).toBe(15)
    expect(parsedEvents[1].y).toBe(8)
  })

  test("all modifier combinations work", async () => {
    const mockRenderer = new MockRenderer()
    const mockMouse = createMockMouse(mockRenderer as any)
    const parser = new MouseParser()

    const modifierCombos = [
      { shift: true },
      { alt: true },
      { ctrl: true },
      { shift: true, alt: true },
      { shift: true, ctrl: true },
      { alt: true, ctrl: true },
      { shift: true, alt: true, ctrl: true },
    ]

    for (const modifiers of modifierCombos) {
      const testRenderer = new MockRenderer()
      const testMouse = createMockMouse(testRenderer as any)
      const testParser = new MouseParser()

      await testMouse.click(10, 5, MouseButtons.LEFT, { modifiers })
      const parsedEvents = parseAllEvents(testRenderer.getEmittedData(), testParser)

      expect(parsedEvents).toHaveLength(2)
      parsedEvents.forEach((event) => {
        expect(event.modifiers).toEqual({
          ...modifiers,
          shift: modifiers.shift || false,
          alt: modifiers.alt || false,
          ctrl: modifiers.ctrl || false,
        })
      })
    }
  })

  test("drag with different button and modifiers", async () => {
    const mockRenderer = new MockRenderer()
    const mockMouse = createMockMouse(mockRenderer as any)
    const parser = new MouseParser()

    await mockMouse.drag(5, 5, 15, 10, MouseButtons.RIGHT, { modifiers: { alt: true } })
    const parsedEvents = parseAllEvents(mockRenderer.getEmittedData(), parser)

    expect(parsedEvents.length).toBeGreaterThan(3)
    parsedEvents.forEach((event) => {
      expect(event.button).toBe(2) // RIGHT button
      expect(event.modifiers.alt).toBe(true)
    })
  })
})
