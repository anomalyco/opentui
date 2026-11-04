#!/usr/bin/env bun

import {
  CliRenderer,
  createCliRenderer,
  RGBA,
  TextAttributes,
  TextRenderable,
  FrameBufferRenderable,
  BoxRenderable,
  ASCIIFontRenderable,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

/**
 * This demo showcases framebuffers with multiple
 * overlapping framebuffers and transparency.
 */

let boxX = 10
let boxY = 10
let boxDx = 5
let boxDy = 3
let ballX = 20
let ballY = 20
let ballDx = 15
let ballDy = 10
let currentWidth = 10
let currentHeight = 5
let growingWidth = true
let growingHeight = true
let lastResizeTime = 0
const resizeInterval = 0.1
let parentContainer: BoxRenderable | null = null

export function run(renderer: CliRenderer): void {
  renderer.start()
  const backgroundColor = RGBA.fromInts(10, 10, 30)
  renderer.setBackgroundColor(backgroundColor)

  parentContainer = new BoxRenderable(renderer, {
    id: "framebuffer-container",
    zIndex: 10,
  })
  renderer.root.add(parentContainer)

  const titleText = new TextRenderable(renderer, {
    id: "framebuffer_title",
    content: "FrameBuffer Demo",
    position: "absolute",
    left: 2,
    top: 1,
    fg: RGBA.fromInts(255, 255, 100),
    attributes: TextAttributes.BOLD,
    zIndex: 1000,
  })
  parentContainer.add(titleText)

  const subtitleText = new TextRenderable(renderer, {
    id: "framebuffer_subtitle",
    content: "Showcasing framebuffers with transparency and partial drawing",
    position: "absolute",
    left: 2,
    top: 2,
    fg: RGBA.fromInts(200, 200, 200),
    zIndex: 1000,
  })
  parentContainer.add(subtitleText)

  const instructionsText = new TextRenderable(renderer, {
    id: "framebuffer_instructions",
    content: "Press Escape to return to menu",
    position: "absolute",
    left: 2,
    top: 3,
    fg: RGBA.fromInts(150, 150, 150),
    zIndex: 1000,
  })
  parentContainer.add(instructionsText)

  const patternBufferRenderable = new FrameBufferRenderable(renderer, {
    id: "pattern",
    width: renderer.terminalWidth,
    height: renderer.terminalHeight,
    position: "absolute",
    zIndex: 0,
    respectAlpha: true,
  })
  renderer.root.add(patternBufferRenderable)
  const { frameBuffer: patternBuffer } = patternBufferRenderable

  for (let y = 0; y < patternBuffer.height; y++) {
    for (let x = 0; x < patternBuffer.width; x++) {
      if ((x + y) % 5 === 0) {
        patternBuffer.drawText("·", x, y, RGBA.fromInts(50, 50, 80))
      }
    }
  }

  const nestedBox = new BoxRenderable(renderer, {
    id: "nested-box",
    width: 20,
    height: 10,
    position: "absolute",
    left: 4,
    top: 4,
    zIndex: 5,
    border: true,
    title: "Nested example",
    backgroundColor: RGBA.fromInts(120, 0, 120, 120),
  })
  parentContainer.add(nestedBox)

  const innerBoxWidth = 10
  const innerBoxHeight = 4

  const nestedInnerBox = new BoxRenderable(renderer, {
    id: "nested-inner-box",
    width: innerBoxWidth,
    height: innerBoxHeight,
    left: 3,
    top: 3,
    zIndex: 1,
    // buffered: true,
    border: true,
    title: "Inner",
    backgroundColor: RGBA.fromInts(0, 255, 0, 10),
  })
  nestedBox.add(nestedInnerBox)

  const boxObj = new BoxRenderable(renderer, {
    id: "moving-box",
    width: 20,
    height: 10,
    position: "absolute",
    left: 10,
    top: 10,
    zIndex: 1,
    overflow: "hidden",
    // NOTE: This color is rendered, it is just overlayed by the boxFrame fill color
    backgroundColor: RGBA.fromInts(255, 120, 120, 255),
  })

  boxObj.add(
    new ASCIIFontRenderable(renderer, {
      id: "moving-box-ascii",
      text: "ASCII",
      position: "relative",
      left: 2,
      top: 5,
      zIndex: 2,
    }),
  )

  const boxFrame = new FrameBufferRenderable(renderer, {
    id: "moving-box-buffer",
    width: 20,
    height: 10,
    position: "relative",
    marginTop: -2,
    zIndex: 1,
    respectAlpha: true,
  })

  boxObj.add(boxFrame)

  renderer.root.add(boxObj)
  const boxBuffer = boxFrame.frameBuffer

  const boxColor = RGBA.fromInts(80, 30, 100, 128)
  boxBuffer.fillRect(0, 0, 20, 10, boxColor)

  for (let x = 0; x < 20; x++) {
    boxBuffer.drawText("-", x, 0, RGBA.fromInts(150, 100, 200))
    boxBuffer.drawText("-", x, 9, RGBA.fromInts(150, 100, 200))
  }
  for (let y = 0; y < 10; y++) {
    boxBuffer.drawText("|", 0, y, RGBA.fromInts(150, 100, 200))
    boxBuffer.drawText("|", 19, y, RGBA.fromInts(150, 100, 200))
  }

  boxBuffer.drawText("+", 0, 0, RGBA.fromInts(200, 150, 255))
  boxBuffer.drawText("+", 19, 0, RGBA.fromInts(200, 150, 255))
  boxBuffer.drawText("+", 0, 9, RGBA.fromInts(200, 150, 255))
  boxBuffer.drawText("+", 19, 9, RGBA.fromInts(200, 150, 255))

  boxBuffer.drawText("Moving Box", 5, 2, RGBA.fromInts(255, 255, 255), RGBA.fromInts(100, 40, 120), TextAttributes.BOLD)

  const overlayBufferRenderable = new FrameBufferRenderable(renderer, {
    id: "overlay",
    width: 40,
    height: 15,
    position: "absolute",
    left: 30,
    top: 15,
    zIndex: 2,
    respectAlpha: true,
  })
  renderer.root.add(overlayBufferRenderable)
  const { frameBuffer: overlayBuffer } = overlayBufferRenderable

  for (let y = 0; y < overlayBuffer.height; y++) {
    for (let x = 0; x < overlayBuffer.width; x++) {
      if ((x + y) % 3 !== 0) {
        overlayBuffer.setCell(x, y, " ", RGBA.fromInts(255, 255, 255), RGBA.fromInts(0, 100, 150, 128))
      }
    }
  }

  overlayBuffer.drawText(
    "Transparent Overlay",
    10,
    2,
    RGBA.fromInts(255, 255, 255),
    RGBA.fromInts(0, 120, 180, 180),
    TextAttributes.BOLD,
  )
  overlayBuffer.drawText(
    "This overlay has transparent",
    5,
    5,
    RGBA.fromInts(255, 0, 255),
    RGBA.fromInts(0, 120, 180, 180),
  )
  overlayBuffer.drawText(
    "cells that let content below",
    5,
    6,
    RGBA.fromInts(255, 255, 255),
    RGBA.fromInts(0, 120, 180, 180),
  )
  overlayBuffer.drawText("show through!", 5, 7, RGBA.fromInts(255, 255, 255), RGBA.fromInts(0, 120, 180, 180))

  const ballObj = new FrameBufferRenderable(renderer, {
    id: "ball",
    width: 3,
    height: 3,
    position: "absolute",
    left: 20,
    top: 20,
    zIndex: 3,
  })
  renderer.root.add(ballObj)
  const ballBuffer = ballObj.frameBuffer

  ballBuffer.drawText(" ", 0, 0, RGBA.fromInts(255, 255, 255), RGBA.fromInts(200, 50, 50))
  ballBuffer.drawText(" ", 1, 0, RGBA.fromInts(255, 255, 255), RGBA.fromInts(200, 50, 50))
  ballBuffer.drawText(" ", 2, 0, RGBA.fromInts(255, 255, 255), RGBA.fromInts(200, 50, 50))
  ballBuffer.drawText(" ", 0, 1, RGBA.fromInts(255, 255, 255), RGBA.fromInts(200, 50, 50))
  ballBuffer.drawText("O", 1, 1, RGBA.fromInts(255, 255, 255), RGBA.fromInts(200, 50, 50))
  ballBuffer.drawText(" ", 2, 1, RGBA.fromInts(255, 255, 255), RGBA.fromInts(200, 50, 50))
  ballBuffer.drawText(" ", 0, 2, RGBA.fromInts(255, 255, 255), RGBA.fromInts(200, 50, 50))
  ballBuffer.drawText(" ", 1, 2, RGBA.fromInts(255, 255, 255), RGBA.fromInts(200, 50, 50))
  ballBuffer.drawText(" ", 2, 2, RGBA.fromInts(255, 255, 255), RGBA.fromInts(200, 50, 50))

  const resizableObj = new FrameBufferRenderable(renderer, {
    id: "resizable-box",
    width: 10,
    height: 5,
    position: "absolute",
    left: 50,
    top: 8,
    zIndex: 3,
  })
  renderer.root.add(resizableObj)
  const resizableBuffer = resizableObj.frameBuffer

  function drawResizableContent() {
    resizableBuffer.clear(RGBA.fromInts(0, 0, 0, 0))

    for (let x = 0; x < resizableBuffer.width; x++) {
      resizableBuffer.drawText("=", x, 0, RGBA.fromInts(255, 200, 100))
      resizableBuffer.drawText("=", x, resizableBuffer.height - 1, RGBA.fromInts(255, 200, 100))
    }

    for (let y = 0; y < resizableBuffer.height; y++) {
      resizableBuffer.drawText("|", 0, y, RGBA.fromInts(255, 200, 100))
      resizableBuffer.drawText("|", resizableBuffer.width - 1, y, RGBA.fromInts(255, 200, 100))
    }

    resizableBuffer.drawText("+", 0, 0, RGBA.fromInts(255, 230, 150))
    resizableBuffer.drawText("+", resizableBuffer.width - 1, 0, RGBA.fromInts(255, 230, 150))
    resizableBuffer.drawText("+", 0, resizableBuffer.height - 1, RGBA.fromInts(255, 230, 150))
    resizableBuffer.drawText("+", resizableBuffer.width - 1, resizableBuffer.height - 1, RGBA.fromInts(255, 230, 150))

    if (resizableBuffer.width >= 18 && resizableBuffer.height >= 3) {
      resizableBuffer.drawText(
        "Resizable Box",
        Math.floor((resizableBuffer.width - 13) / 2),
        2,
        RGBA.fromInts(255, 255, 100),
        undefined,
        TextAttributes.BOLD,
      )
    }
  }

  drawResizableContent()

  // Create a large source framebuffer for partial drawing demonstration
  const sourceObj = new FrameBufferRenderable(renderer, {
    id: "large-source",
    width: 40,
    height: 20,
    position: "absolute",
    zIndex: -1,
    visible: false,
  })
  renderer.root.add(sourceObj)
  const sourceBuffer = sourceObj.frameBuffer

  // Fill source buffer with a pattern we can crop from
  for (let y = 0; y < sourceBuffer.height; y++) {
    for (let x = 0; x < sourceBuffer.width; x++) {
      const char = String.fromCharCode(65 + ((x + y) % 26)) // A-Z pattern
      const hue = (x * 10 + y * 5) % 360
      const r = Math.floor(128 + 127 * Math.sin((hue * Math.PI) / 180))
      const g = Math.floor(128 + 127 * Math.sin(((hue + 120) * Math.PI) / 180))
      const b = Math.floor(128 + 127 * Math.sin(((hue + 240) * Math.PI) / 180))
      sourceBuffer.drawText(char, x, y, RGBA.fromInts(r, g, b))
    }
  }

  // Create smaller framebuffers to demonstrate partial drawing
  const cropBuffer1Renderable = new FrameBufferRenderable(renderer, {
    id: "crop-demo-1",
    width: 12,
    height: 8,
    position: "absolute",
    left: 5,
    top: 35,
    zIndex: 4,
  })
  renderer.root.add(cropBuffer1Renderable)
  const { frameBuffer: cropBuffer1 } = cropBuffer1Renderable

  const cropBuffer2Renderable = new FrameBufferRenderable(renderer, {
    id: "crop-demo-2",
    width: 15,
    height: 6,
    position: "absolute",
    left: 25,
    top: 35,
    zIndex: 4,
  })
  renderer.root.add(cropBuffer2Renderable)
  const { frameBuffer: cropBuffer2 } = cropBuffer2Renderable

  const cropBuffer3Renderable = new FrameBufferRenderable(renderer, {
    id: "crop-demo-3",
    width: 10,
    height: 10,
    position: "absolute",
    left: 45,
    top: 35,
    zIndex: 4,
  })
  renderer.root.add(cropBuffer3Renderable)
  const { frameBuffer: cropBuffer3 } = cropBuffer3Renderable

  // Label for the crop demo
  const cropDemoLabel = new TextRenderable(renderer, {
    id: "crop_demo_label",
    content: "Partial FrameBuffer Drawing Demo:",
    position: "absolute",
    left: 5,
    top: 34,
    fg: RGBA.fromInts(255, 255, 200),
    attributes: TextAttributes.BOLD,
    zIndex: 1000,
  })
  parentContainer.add(cropDemoLabel)

  // Emoji demo using encodeUnicode and drawChar
  const emojiBufferRenderable = new FrameBufferRenderable(renderer, {
    id: "emoji-demo",
    width: 20,
    height: 5,
    position: "absolute",
    left: 60,
    top: 35,
    zIndex: 4,
  })
  renderer.root.add(emojiBufferRenderable)
  const { frameBuffer: emojiBuffer } = emojiBufferRenderable

  const emojiDemoLabel = new TextRenderable(renderer, {
    id: "emoji_demo_label",
    content: "encodeUnicode Demo:",
    position: "absolute",
    left: 60,
    top: 34,
    fg: RGBA.fromInts(255, 255, 200),
    attributes: TextAttributes.BOLD,
    zIndex: 1000,
  })
  parentContainer.add(emojiDemoLabel)

  // Pre-encode the monkey emoji frames
  const monkeyFrames = ["🐵 ", "🙈 ", "🙉 ", "🙊 "]
  let currentMonkeyFrame = 0
  let lastMonkeyFrameTime = 0
  const monkeyFrameInterval = 0.3 // Change frame every 300ms

  boxX = 10
  boxY = 10
  boxDx = 5
  boxDy = 3
  ballX = 20
  ballY = 20
  ballDx = 15
  ballDy = 10
  currentWidth = 10
  currentHeight = 5
  growingWidth = true
  growingHeight = true
  lastResizeTime = 0

  renderer.setFrameCallback(async (deltaTime) => {
    const clampedDelta = Math.min(deltaTime, 100) / 1000

    boxX += boxDx * clampedDelta
    boxY += boxDy * clampedDelta

    if (boxX < 0) {
      boxX = 0
      boxDx = Math.abs(boxDx)
    } else if (boxX + boxBuffer.width > renderer.terminalWidth) {
      boxX = renderer.terminalWidth - boxBuffer.width
      boxDx = -Math.abs(boxDx)
    }

    if (boxY < 5) {
      boxY = 5
      boxDy = Math.abs(boxDy)
    } else if (boxY + boxBuffer.height > renderer.terminalHeight) {
      boxY = renderer.terminalHeight - boxBuffer.height
      boxDy = -Math.abs(boxDy)
    }

    boxObj.x = Math.round(boxX)
    boxObj.y = Math.round(boxY)

    ballX += ballDx * clampedDelta
    ballY += ballDy * clampedDelta

    if (ballX < 0) {
      ballX = 0
      ballDx = Math.abs(ballDx)
    } else if (ballX + ballBuffer.width > renderer.terminalWidth) {
      ballX = renderer.terminalWidth - ballBuffer.width
      ballDx = -Math.abs(ballDx)
    }

    if (ballY < 5) {
      ballY = 5
      ballDy = Math.abs(ballDy)
    } else if (ballY + ballBuffer.height > renderer.terminalHeight) {
      ballY = renderer.terminalHeight - ballBuffer.height
      ballDy = -Math.abs(ballDy)
    }

    ballObj.x = Math.round(ballX)
    ballObj.y = Math.round(ballY)

    const time = Date.now() / 1000

    // Update partial drawing demonstration
    const scrollOffset = Math.floor(time * 3) % 20 // Scroll through source buffer

    // Clear crop demo buffers
    cropBuffer1.clear(RGBA.fromInts(0, 0, 0, 1))
    cropBuffer2.clear(RGBA.fromInts(0, 0, 0, 1))
    cropBuffer3.clear(RGBA.fromInts(0, 0, 0, 1))

    // Demo 1: Top-left crop that scrolls horizontally
    cropBuffer1.drawFrameBuffer(0, 0, sourceBuffer, scrollOffset, 0, 12, 8)
    cropBuffer1.drawText(
      "TopLeft",
      1,
      7,
      RGBA.fromInts(255, 255, 255),
      RGBA.fromInts(0, 0, 0, 180),
      TextAttributes.BOLD,
    )

    // Demo 2: Center crop - super simple slow movement
    const centerX = 10 + Math.floor((Math.sin(time * 0.3) + 1) * 5) // 10 to 20, very slow
    const centerY = 5 + Math.floor((Math.cos(time * 0.2) + 1) * 3) // 5 to 11, very slow
    cropBuffer2.drawFrameBuffer(0, 0, sourceBuffer, centerX, centerY, 15, 6)
    cropBuffer2.drawText("Center", 1, 5, RGBA.fromInts(255, 255, 255), RGBA.fromInts(0, 0, 0, 180), TextAttributes.BOLD)

    // Demo 3: Bottom-right crop - simple back and forth
    const brX = 20 + Math.floor((Math.sin(time * 0.4) + 1) * 5) // 20 to 30, very slow
    const brY = 5 + Math.floor((Math.cos(time * 0.4) + 1) * 3) // 5 to 11, same speed for circle
    cropBuffer3.drawFrameBuffer(0, 0, sourceBuffer, brX, brY, 10, 10)
    cropBuffer3.drawText(
      "BotRight",
      1,
      9,
      RGBA.fromInts(255, 255, 255),
      RGBA.fromInts(0, 0, 0, 180),
      TextAttributes.BOLD,
    )

    if (time - lastResizeTime > resizeInterval) {
      lastResizeTime = time

      if (growingWidth) {
        currentWidth++
        if (currentWidth >= 30) growingWidth = false
      } else {
        currentWidth--
        if (currentWidth <= 10) growingWidth = true
      }

      if (growingHeight) {
        currentHeight++
        if (currentHeight >= 15) growingHeight = false
      } else {
        currentHeight--
        if (currentHeight <= 5) growingHeight = true
      }

      resizableBuffer.resize(currentWidth, currentHeight)

      drawResizableContent()

      const centerX = 50
      const centerY = 8

      resizableObj.x = Math.round(centerX - currentWidth / 2)
      resizableObj.y = Math.round(centerY - currentHeight / 2)
    }

    const hue = (time * 20) % 360
    const r = Math.floor(128 + 127 * Math.sin((hue * Math.PI) / 180))
    const g = Math.floor(128 + 127 * Math.sin(((hue + 120) * Math.PI) / 180))
    const b = Math.floor(128 + 127 * Math.sin(((hue + 240) * Math.PI) / 180))

    if (Math.floor(time * 10) % 1 === 0) {
      overlayBuffer.clear(RGBA.fromInts(0, 0, 0, 0))

      for (let y = 0; y < overlayBuffer.height; y++) {
        for (let x = 0; x < overlayBuffer.width; x++) {
          if ((x + y) % 3 !== 0) {
            overlayBuffer.setCell(x, y, " ", RGBA.fromInts(255, 255, 255), RGBA.fromInts(r, g, b, 128))
          }
        }
      }

      overlayBuffer.drawText(
        "Transparent Overlay",
        10,
        2,
        RGBA.fromInts(255, 255, 255),
        RGBA.fromInts(255, 255, 255, 180),
        TextAttributes.BOLD,
      )
      overlayBuffer.drawText(
        "This overlay has transparent",
        5,
        5,
        RGBA.fromInts(255, 255, 255),
        RGBA.fromInts(255, 255, 255, 180),
      )
      overlayBuffer.drawText(
        "cells that let content below",
        5,
        6,
        RGBA.fromInts(255, 255, 255),
        RGBA.fromInts(255, 255, 255, 180),
      )
      overlayBuffer.drawText("show through!", 5, 7, RGBA.fromInts(255, 255, 255), RGBA.fromInts(255, 255, 255, 180))
    }

    // Update monkey emoji animation
    if (time - lastMonkeyFrameTime > monkeyFrameInterval) {
      lastMonkeyFrameTime = time
      currentMonkeyFrame = (currentMonkeyFrame + 1) % monkeyFrames.length

      // Clear emoji buffer
      emojiBuffer.clear(RGBA.fromInts(0, 0, 0, 1))

      // Draw border
      for (let x = 0; x < emojiBuffer.width; x++) {
        emojiBuffer.drawText("=", x, 0, RGBA.fromInts(255, 200, 100))
        emojiBuffer.drawText("=", x, emojiBuffer.height - 1, RGBA.fromInts(255, 200, 100))
      }
      for (let y = 0; y < emojiBuffer.height; y++) {
        emojiBuffer.drawText("|", 0, y, RGBA.fromInts(255, 200, 100))
        emojiBuffer.drawText("|", emojiBuffer.width - 1, y, RGBA.fromInts(255, 200, 100))
      }
      emojiBuffer.drawText("+", 0, 0, RGBA.fromInts(255, 230, 150))
      emojiBuffer.drawText("+", emojiBuffer.width - 1, 0, RGBA.fromInts(255, 230, 150))
      emojiBuffer.drawText("+", 0, emojiBuffer.height - 1, RGBA.fromInts(255, 230, 150))
      emojiBuffer.drawText("+", emojiBuffer.width - 1, emojiBuffer.height - 1, RGBA.fromInts(255, 230, 150))

      // Draw only the current frame using encodeUnicode and drawChar
      const fg = RGBA.fromInts(255, 255, 255)
      const bg = RGBA.fromInts(0, 0, 0, 0) // Transparent background

      // Encode the current frame
      const currentFrame = monkeyFrames[currentMonkeyFrame]
      const encoded = emojiBuffer.encodeUnicode(currentFrame)

      if (encoded) {
        let x = 7 // Center the emoji
        for (const encodedChar of encoded.data) {
          emojiBuffer.drawChar(encodedChar.char, x, 2, fg, bg)
          x += encodedChar.width
        }
        emojiBuffer.freeUnicode(encoded)
      }

      // Draw frame indicator
      const frameText = `Frame ${currentMonkeyFrame + 1}/4`
      emojiBuffer.drawText(frameText, 5, 3, RGBA.fromInts(200, 200, 200))
    }
  })

  const debugInstructionsText = new TextRenderable(renderer, {
    id: "framebuffer_debug_instructions",
    content: "Press 1-4 to change corner | Escape: Back to menu",
    position: "absolute",
    left: 2,
    top: 2,
    fg: RGBA.fromInts(200, 200, 200),
    zIndex: 1000,
  })
  parentContainer.add(debugInstructionsText)
}

export function destroy(renderer: CliRenderer): void {
  renderer.clearFrameCallbacks()

  if (parentContainer) {
    parentContainer.destroyRecursively()
    parentContainer = null
  }

  for (const id of [
    "pattern",
    "moving-box",
    "overlay",
    "ball",
    "resizable-box",
    "large-source",
    "crop-demo-1",
    "crop-demo-2",
    "crop-demo-3",
    "emoji-demo",
  ]) {
    const child = renderer.root.getRenderable(id)
    child?.destroyRecursively()
  }

  boxX = 10
  boxY = 10
  boxDx = 5
  boxDy = 3
  ballX = 20
  ballY = 20
  ballDx = 15
  ballDy = 10
  currentWidth = 10
  currentHeight = 5
  growingWidth = true
  growingHeight = true
  lastResizeTime = 0
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  })
  run(renderer)
  setupCommonDemoKeys(renderer)
}
