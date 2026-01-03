export type MouseEventType = "down" | "up" | "move" | "drag" | "drag-end" | "drop" | "over" | "out" | "scroll"

export interface ScrollInfo {
  direction: "up" | "down" | "left" | "right"
  delta: number
}

export type RawMouseEvent = {
  type: MouseEventType
  button: number
  x: number
  y: number
  modifiers: { shift: boolean; alt: boolean; ctrl: boolean }
  scroll?: ScrollInfo
}

export type MouseParseResult = {
  event: RawMouseEvent
  consumed: number
}

export class MouseParser {
  private mouseButtonsPressed = new Set<number>()

  private static readonly SCROLL_DIRECTIONS: Record<number, "up" | "down" | "left" | "right"> = {
    0: "up",
    1: "down",
    2: "left",
    3: "right",
  }

  public reset(): void {
    this.mouseButtonsPressed.clear()
  }

  /**
   * Parse a mouse event from the buffer and return the consumed byte count.
   * This allows the caller to process any remaining data in the buffer.
   */
  public parseMouseEventWithConsumed(data: Buffer): MouseParseResult | null {
    const str = data.toString()
    // Parse SGR mouse mode: \x1b[<b;x;yM or \x1b[<b;x;ym
    // Anchor to start of string to ensure we only match at the beginning
    const sgrMatch = str.match(/^(\x1b\[<(\d+);(\d+);(\d+)([Mm]))/)
    if (sgrMatch) {
      const [, fullMatch, buttonCode, x, y, pressRelease] = sgrMatch
      const rawButtonCode = parseInt(buttonCode)

      const button = rawButtonCode & 3
      const isScroll = (rawButtonCode & 64) !== 0
      const scrollDirection = !isScroll ? undefined : MouseParser.SCROLL_DIRECTIONS[button]

      const isMotion = (rawButtonCode & 32) !== 0
      const modifiers = {
        shift: (rawButtonCode & 4) !== 0,
        alt: (rawButtonCode & 8) !== 0,
        ctrl: (rawButtonCode & 16) !== 0,
      }

      let type: MouseEventType
      let scrollInfo: ScrollInfo | undefined

      if (isScroll && pressRelease === "M") {
        type = "scroll"
        scrollInfo = {
          direction: scrollDirection!,
          delta: 1,
        }
      } else if (isMotion) {
        const isDragging = this.mouseButtonsPressed.size > 0

        if (button === 3) {
          type = "move"
        } else if (isDragging) {
          type = "drag"
        } else {
          type = "move"
        }
      } else {
        type = pressRelease === "M" ? "down" : "up"

        if (type === "down" && button !== 3) {
          this.mouseButtonsPressed.add(button)
        } else if (type === "up") {
          this.mouseButtonsPressed.clear()
        }
      }

      return {
        event: {
          type,
          button: button === 3 ? 0 : button,
          x: parseInt(x) - 1,
          y: parseInt(y) - 1,
          modifiers,
          scroll: scrollInfo,
        },
        consumed: Buffer.byteLength(fullMatch),
      }
    }

    // Parse basic mouse mode: \x1b[M followed by 3 bytes
    if (str.startsWith("\x1b[M") && str.length >= 6) {
      const buttonByte = str.charCodeAt(3) - 32
      // Convert from 1-based to 0-based
      const x = str.charCodeAt(4) - 33
      const y = str.charCodeAt(5) - 33

      const button = buttonByte & 3
      const isScroll = (buttonByte & 64) !== 0
      const scrollDirection = !isScroll ? undefined : MouseParser.SCROLL_DIRECTIONS[button]

      const modifiers = {
        shift: (buttonByte & 4) !== 0,
        alt: (buttonByte & 8) !== 0,
        ctrl: (buttonByte & 16) !== 0,
      }

      let type: MouseEventType
      let actualButton: number
      let scrollInfo: ScrollInfo | undefined

      if (isScroll) {
        type = "scroll"
        actualButton = 0
        scrollInfo = {
          direction: scrollDirection!,
          delta: 1,
        }
      } else {
        type = button === 3 ? "up" : "down"
        actualButton = button === 3 ? 0 : button
      }

      return {
        event: {
          type,
          button: actualButton,
          x,
          y,
          modifiers,
          scroll: scrollInfo,
        },
        consumed: 6,
      }
    }

    return null
  }

  /**
   * Parse a mouse event from the buffer.
   * @deprecated Use parseMouseEventWithConsumed() when you need to handle remaining buffer data.
   */
  public parseMouseEvent(data: Buffer): RawMouseEvent | null {
    const result = this.parseMouseEventWithConsumed(data)
    return result ? result.event : null
  }
}
