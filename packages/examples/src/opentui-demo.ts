import {
  TextAttributes,
  rgbToHex,
  hsvToRgb,
  createCliRenderer,
  TextRenderable,
  BoxRenderable,
  parseColor,
  getBorderFromSides,
  type KeyEvent,
} from "@opentui/core"
import type { BorderCharacters, BorderSidesConfig, CliRenderer } from "@opentui/core"
import { TabControllerRenderable } from "./lib/tab-controller.js"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let globalTabController: TabControllerRenderable | null = null
let globalKeyboardHandler: ((key: KeyEvent) => void) | null = null

export function run(renderer: CliRenderer): void {
  renderer.start()
  renderer.setBackgroundColor("#000028")

  const tabController = new TabControllerRenderable("main-tab-controller", renderer, {
    position: "absolute",
    left: 0,
    top: 0,
    width: renderer.terminalWidth,
    height: renderer.terminalHeight,
    zIndex: 0,
  })
  globalTabController = tabController
  renderer.root.add(tabController)

  // Tab: Text & Attributes
  const wheelRadius = 7
  const wheelCenterX = 70
  const wheelCenterY = 15
  let activeWheelPixels = new Set<string>()

  tabController.addTab({
    title: "Text & Attributes",
    init: (tabGroup) => {
      const textTitle = new TextRenderable(renderer, {
        id: "text-title",
        content: "Text Styling & Color Gradients",
        position: "absolute",
        left: 10,
        top: 5,
        fg: "#FFFF00",
        attributes: TextAttributes.BOLD | TextAttributes.UNDERLINE,
        zIndex: 10,
      })
      tabGroup.add(textTitle)

      // Text attributes
      const attrBold = new TextRenderable(renderer, {
        id: "attr-bold",
        content: "Bold Text",
        position: "absolute",
        left: 10,
        top: 8,
        fg: "#FFFFFF",
        attributes: TextAttributes.BOLD,
        zIndex: 10,
      })
      tabGroup.add(attrBold)

      const attrItalic = new TextRenderable(renderer, {
        id: "attr-italic",
        content: "Italic Text",
        position: "absolute",
        left: 10,
        top: 9,
        fg: "#FFFFFF",
        attributes: TextAttributes.ITALIC,
        zIndex: 10,
      })
      tabGroup.add(attrItalic)

      const attrUnderline = new TextRenderable(renderer, {
        id: "attr-underline",
        content: "Underlined Text",
        position: "absolute",
        left: 10,
        top: 10,
        fg: "#FFFFFF",
        attributes: TextAttributes.UNDERLINE,
        zIndex: 10,
      })
      tabGroup.add(attrUnderline)

      const attrDim = new TextRenderable(renderer, {
        id: "attr-dim",
        content: "Dim Text",
        position: "absolute",
        left: 10,
        top: 11,
        fg: "#FFFFFF",
        attributes: TextAttributes.DIM,
        zIndex: 10,
      })
      tabGroup.add(attrDim)

      const attrCombined = new TextRenderable(renderer, {
        id: "attr-combined",
        content: "Bold + Italic + Underline",
        position: "absolute",
        left: 10,
        top: 12,
        fg: "#FF6464",
        attributes: TextAttributes.BOLD | TextAttributes.ITALIC | TextAttributes.UNDERLINE,
        zIndex: 10,
      })
      tabGroup.add(attrCombined)

      // Color gradient
      const gradientTitle = new TextRenderable(renderer, {
        id: "gradient-title",
        content: "Rainbow Gradient:",
        position: "absolute",
        left: 10,
        top: 15,
        fg: "#CCCCCC",
        zIndex: 10,
      })
      tabGroup.add(gradientTitle)

      for (let i = 0; i < 40; i++) {
        const hue = (i / 40) * 360
        const color = hsvToRgb(hue, 1, 1)
        const hexColor = rgbToHex(color)

        const gradientPixel = new TextRenderable(renderer, {
          id: `gradient-${i}`,
          content: "█",
          position: "absolute",
          left: 10 + i,
          top: 17,
          fg: hexColor,
          zIndex: 10,
        })
        tabGroup.add(gradientPixel)
      }
    },
    update: (deltaMs: number, tabGroup: BoxRenderable) => {
      // Animate the rotating color wheel
      const time = Date.now() / 1000
      const rotationSpeed = 45 // degrees per second
      const rotationAngle = (time * rotationSpeed) % 360
      const rotationRadians = rotationAngle * (Math.PI / 180)

      // Track new wheel pixels for this frame
      const newWheelPixels = new Set<string>()

      for (let y = wheelCenterY - wheelRadius; y <= wheelCenterY + wheelRadius; y++) {
        for (let x = wheelCenterX - wheelRadius * 2; x <= wheelCenterX + wheelRadius * 2; x++) {
          const dx = (x - wheelCenterX) / 2 // Adjust for terminal character aspect ratio
          const dy = y - wheelCenterY
          const distance = Math.sqrt(dx * dx + dy * dy)

          if (distance <= wheelRadius) {
            const angle = Math.atan2(dy, dx)
            const rotatedAngle = angle + rotationRadians
            const hue = ((rotatedAngle / Math.PI) * 180 + 180) % 360
            const saturation = distance / wheelRadius
            const color = hsvToRgb(hue, saturation, 1)

            const pixelId = `wheel-${x}-${y}`
            newWheelPixels.add(pixelId)

            const existingPixel = tabGroup.getRenderable(pixelId) as TextRenderable
            if (existingPixel) {
              existingPixel.setPosition({ left: x, top: y })
              existingPixel.fg = color
            } else {
              const wheelPixel = new TextRenderable(renderer, {
                id: pixelId,
                content: "█",
                position: "absolute",
                left: x,
                top: y,
                fg: color,
                zIndex: 10,
              })
              tabGroup.add(wheelPixel)
              activeWheelPixels.add(pixelId)
            }
          }
        }
      }

      // Remove any wheel pixels that are no longer part of the wheel
      for (const pixelId of activeWheelPixels) {
        if (!newWheelPixels.has(pixelId)) {
          const pixel = tabGroup.getRenderable(pixelId)
          if (pixel) tabGroup.remove(pixel)
          activeWheelPixels.delete(pixelId)
        }
      }

      activeWheelPixels = newWheelPixels
    },
    show: () => {
      activeWheelPixels.clear()
    },
    hide: () => {
      for (const pixelId of activeWheelPixels) {
        const pixel = renderer.root.getRenderable(pixelId)
        if (pixel) renderer.root.remove(pixel)
      }
      activeWheelPixels.clear()
    },
  })

  // Tab: Basics
  tabController.addTab({
    title: "Basics",
    init: (tabGroup) => {
      const title = new TextRenderable(renderer, {
        id: "opentui-title",
        content: "Basic CLI Renderer Demo",
        position: "absolute",
        left: 10,
        top: 5,
        fg: "#FFFF00",
        attributes: TextAttributes.BOLD | TextAttributes.UNDERLINE,
        zIndex: 10,
      })
      tabGroup.add(title)

      const box1 = new BoxRenderable(renderer, {
        id: "box1",
        position: "absolute",
        left: 10,
        top: 8,
        width: 20,
        height: 8,
        backgroundColor: "#333366",
        zIndex: 0,
        borderStyle: "single",
        borderColor: "#FFFFFF",
        border: true,
      })
      tabGroup.add(box1)

      const box1Title = new TextRenderable(renderer, {
        id: "box1-title",
        content: "Simple Box",
        position: "absolute",
        left: 12,
        top: 10,
        fg: "#FFFFFF",
        attributes: TextAttributes.BOLD,
        zIndex: 10,
      })
      tabGroup.add(box1Title)

      const box2 = new BoxRenderable(renderer, {
        id: "box2",
        position: "absolute",
        left: 35,
        top: 10,
        width: 25,
        height: 6,
        backgroundColor: "#663333",
        zIndex: 1,
        borderStyle: "double",
        borderColor: "#FFFF00",
        border: true,
      })
      tabGroup.add(box2)

      const box2Title = new TextRenderable(renderer, {
        id: "box2-title",
        content: "Double Border Box",
        position: "absolute",
        left: 37,
        top: 12,
        fg: "#FFFFFF",
        attributes: TextAttributes.BOLD,
        zIndex: 10,
      })
      tabGroup.add(box2Title)

      const description = new TextRenderable(renderer, {
        id: "description",
        content: "This tab demonstrates basic box and text rendering with different border styles.",
        position: "absolute",
        left: 10,
        top: 18,
        fg: "#CCCCCC",
        zIndex: 10,
      })
      tabGroup.add(description)

      const cursorInfo = new TextRenderable(renderer, {
        id: "cursor-info",
        content: "Cursor: (0,0) - Style: block",
        position: "absolute",
        left: 10,
        top: 20,
        fg: "#FFFFFF",
        attributes: TextAttributes.BOLD,
        zIndex: 10,
      })
      tabGroup.add(cursorInfo)
    },
    update: (deltaMs: number, tabGroup: BoxRenderable) => {
      // Update cursor position (make it move in a small circle)
      const cursorTime = Date.now() / 1000
      const cursorX = 15 + Math.floor(3 * Math.cos(cursorTime))
      const cursorY = 13 + Math.floor(2 * Math.sin(cursorTime))

      // Change cursor style every few seconds
      const cursorStyleIndex = Math.floor(cursorTime / 2) % 6
      let cursorStyle: "block" | "line" | "underline" = "block"
      let cursorBlinking = false

      switch (cursorStyleIndex) {
        case 0:
          cursorStyle = "block"
          cursorBlinking = false
          break
        case 1:
          cursorStyle = "block"
          cursorBlinking = true
          break
        case 2:
          cursorStyle = "line"
          cursorBlinking = false
          break
        case 3:
          cursorStyle = "line"
          cursorBlinking = true
          break
        case 4:
          cursorStyle = "underline"
          cursorBlinking = false
          break
        case 5:
          cursorStyle = "underline"
          cursorBlinking = true
          break
      }

      renderer.setCursorStyle({ style: cursorStyle, blinking: cursorBlinking })
      renderer.setCursorPosition(cursorX, cursorY)

      // Display cursor position and style info
      const cursorInfo = tabGroup.getRenderable("cursor-info") as TextRenderable
      if (cursorInfo) {
        cursorInfo.content = `Cursor: (${cursorX},${cursorY}) - Style: ${cursorStyle}${cursorBlinking ? " (blinking)" : ""}`
      }
    },
    show: () => {
      renderer.setCursorPosition(15, 13, true)
    },
    hide: () => {
      renderer.setCursorPosition(0, 0, false)
    },
  })

  // Tab: Borders
  let partialBorderPhase = 0
  tabController.addTab({
    title: "Borders",
    init: (tabGroup) => {
      const borderTitle = new TextRenderable(renderer, {
        id: "border-title",
        content: "Border Styles & Partial Borders",
        position: "absolute",
        left: 10,
        top: 5,
        fg: "#FFFF00",
        attributes: TextAttributes.BOLD | TextAttributes.UNDERLINE,
        zIndex: 10,
      })
      tabGroup.add(borderTitle)

      // Different border styles
      const singleBox = new BoxRenderable(renderer, {
        id: "single-box",
        position: "absolute",
        left: 10,
        top: 8,
        width: 15,
        height: 5,
        backgroundColor: "#222244",
        zIndex: 0,
        borderStyle: "single",
        borderColor: "#FFFFFF",
        border: true,
      })
      tabGroup.add(singleBox)
      const singleLabel = new TextRenderable(renderer, {
        id: "single-label",
        content: "Single",
        position: "absolute",
        left: 12,
        top: 10,
        fg: "#FFFFFF",
        attributes: TextAttributes.BOLD,
        zIndex: 10,
      })
      tabGroup.add(singleLabel)

      const doubleBox = new BoxRenderable(renderer, {
        id: "double-box",
        position: "absolute",
        left: 30,
        top: 8,
        width: 15,
        height: 5,
        backgroundColor: "#442222",
        zIndex: 0,
        borderStyle: "double",
        borderColor: "#FFFFFF",
        border: true,
      })
      tabGroup.add(doubleBox)
      const doubleLabel = new TextRenderable(renderer, {
        id: "double-label",
        content: "Double",
        position: "absolute",
        left: 32,
        top: 10,
        fg: "#FFFFFF",
        attributes: TextAttributes.BOLD,
        zIndex: 10,
      })
      tabGroup.add(doubleLabel)

      const roundedBox = new BoxRenderable(renderer, {
        id: "rounded-box",
        position: "absolute",
        left: 50,
        top: 8,
        width: 15,
        height: 5,
        backgroundColor: "#224422",
        zIndex: 0,
        borderStyle: "rounded",
        borderColor: "#FFFFFF",
        border: true,
      })
      tabGroup.add(roundedBox)
      const roundedLabel = new TextRenderable(renderer, {
        id: "rounded-label",
        content: "Rounded",
        position: "absolute",
        left: 52,
        top: 10,
        fg: "#FFFFFF",
        attributes: TextAttributes.BOLD,
        zIndex: 10,
      })
      tabGroup.add(roundedLabel)

      // Partial borders
      const partialTitle = new TextRenderable(renderer, {
        id: "partial-title",
        content: "Partial Borders:",
        position: "absolute",
        left: 10,
        top: 15,
        fg: "#CCCCCC",
        attributes: TextAttributes.UNDERLINE,
        zIndex: 10,
      })
      tabGroup.add(partialTitle)

      const partialLeft = new BoxRenderable(renderer, {
        id: "partial-left",
        position: "absolute",
        left: 10,
        top: 17,
        width: 12,
        height: 4,
        backgroundColor: "#222244",
        zIndex: 0,
        borderStyle: "single",
        borderColor: "#FFFFFF",
        border: ["left"],
      })
      tabGroup.add(partialLeft)
      const partialLeftLabel = new TextRenderable(renderer, {
        id: "partial-left-label",
        content: "Left Only",
        position: "absolute",
        left: 12,
        top: 18,
        fg: "#FFFFFF",
        zIndex: 10,
      })
      tabGroup.add(partialLeftLabel)

      const partialAnimated = new BoxRenderable(renderer, {
        id: "partial-animated",
        position: "absolute",
        left: 30,
        top: 17,
        width: 20,
        height: 4,
        backgroundColor: "#334455",
        zIndex: 0,
        borderStyle: "single",
        borderColor: "#FFFFFF",
        border: true,
      })
      tabGroup.add(partialAnimated)
      const partialAnimatedLabel = new TextRenderable(renderer, {
        id: "partial-animated-label",
        content: "Animated Borders",
        position: "absolute",
        left: 32,
        top: 18,
        fg: "#FFFFFF",
        zIndex: 10,
      })
      tabGroup.add(partialAnimatedLabel)

      const partialPhase = new TextRenderable(renderer, {
        id: "partial-phase",
        content: "Phase: 1/8",
        position: "absolute",
        left: 30,
        top: 22,
        fg: "#AAAAAA",
        zIndex: 10,
      })
      tabGroup.add(partialPhase)

      const customBorderTitle = new TextRenderable(renderer, {
        id: "custom-border-title",
        content: "Custom Border Characters:",
        position: "absolute",
        left: 10,
        top: 25,
        fg: "#CCCCCC",
        attributes: TextAttributes.UNDERLINE,
        zIndex: 10,
      })
      tabGroup.add(customBorderTitle)

      const asciiBorders: BorderCharacters = {
        topLeft: "+",
        topRight: "+",
        bottomLeft: "+",
        bottomRight: "+",
        horizontal: "-",
        vertical: "|",
        topT: "+",
        bottomT: "+",
        leftT: "+",
        rightT: "+",
        cross: "+",
      }

      const blockBorders: BorderCharacters = {
        topLeft: "█",
        topRight: "█",
        bottomLeft: "█",
        bottomRight: "█",
        horizontal: "█",
        vertical: "█",
        topT: "█",
        bottomT: "█",
        leftT: "█",
        rightT: "█",
        cross: "█",
      }

      const starBorders: BorderCharacters = {
        topLeft: "*",
        topRight: "*",
        bottomLeft: "*",
        bottomRight: "*",
        horizontal: "*",
        vertical: "*",
        topT: "*",
        bottomT: "*",
        leftT: "*",
        rightT: "*",
        cross: "*",
      }

      const asciiBox = new BoxRenderable(renderer, {
        id: "ascii-box",
        position: "absolute",
        left: 10,
        top: 27,
        width: 15,
        height: 5,
        backgroundColor: "#222244",
        zIndex: 0,
        borderStyle: "single",
        borderColor: "#FFFFFF",
        customBorderChars: asciiBorders,
        border: true,
      })
      tabGroup.add(asciiBox)
      const asciiLabel = new TextRenderable(renderer, {
        id: "ascii-label",
        content: "ASCII Border",
        position: "absolute",
        left: 12,
        top: 29,
        fg: "#FFFFFF",
        attributes: TextAttributes.BOLD,
        zIndex: 10,
      })
      tabGroup.add(asciiLabel)

      const blockBox = new BoxRenderable(renderer, {
        id: "block-box",
        position: "absolute",
        left: 30,
        top: 27,
        width: 15,
        height: 5,
        backgroundColor: "#442222",
        zIndex: 0,
        borderStyle: "single",
        borderColor: "#FFFFFF",
        border: true,
      })
      blockBox.customBorderChars = blockBorders
      tabGroup.add(blockBox)
      const blockLabel = new TextRenderable(renderer, {
        id: "block-label",
        content: "Block Border",
        position: "absolute",
        left: 32,
        top: 29,
        fg: "#FFFFFF",
        attributes: TextAttributes.BOLD,
        zIndex: 10,
      })
      tabGroup.add(blockLabel)

      const starBox = new BoxRenderable(renderer, {
        id: "star-box",
        position: "absolute",
        left: 50,
        top: 27,
        width: 15,
        height: 5,
        backgroundColor: "#224422",
        zIndex: 0,
        borderStyle: "single",
        borderColor: "#FFFFFF",
        customBorderChars: starBorders,
        border: true,
      })
      tabGroup.add(starBox)
      const starLabel = new TextRenderable(renderer, {
        id: "star-label",
        content: "Star Border",
        position: "absolute",
        left: 52,
        top: 29,
        fg: "#FFFFFF",
        attributes: TextAttributes.BOLD,
        zIndex: 10,
      })
      tabGroup.add(starLabel)
    },
    update: (deltaMs: number, tabGroup: BoxRenderable) => {
      // Animate partial borders
      const time = Date.now() / 1000
      const phase = Math.floor(time % 8)

      if (phase !== partialBorderPhase) {
        partialBorderPhase = phase

        const borderSides: BorderSidesConfig = {
          top: [0, 3, 5, 7].includes(phase),
          right: [1, 3, 6, 7].includes(phase),
          bottom: [2, 3, 5, 7].includes(phase),
          left: [4, 5, 6, 7].includes(phase),
        }

        const partialAnimatedBox = tabGroup.getRenderable("partial-animated") as BoxRenderable
        if (partialAnimatedBox) {
          partialAnimatedBox.border = getBorderFromSides(borderSides)
          partialAnimatedBox.borderStyle = "single"
        }

        const partialPhaseText = tabGroup.getRenderable("partial-phase") as TextRenderable
        if (partialPhaseText) {
          partialPhaseText.content = `Phase: ${phase + 1}/8`
        }
      }
    },
  })

  // Tab: Animation
  let animPosition = 5
  let animDirection = 1
  let animSpeed = 15
  tabController.addTab({
    title: "Animation",
    init: (tabGroup) => {
      const animTitle = new TextRenderable(renderer, {
        id: "anim-title",
        content: "Animation Demonstrations",
        position: "absolute",
        left: 10,
        top: 5,
        fg: "#FFFF00",
        attributes: TextAttributes.BOLD | TextAttributes.UNDERLINE,
        zIndex: 10,
      })
      tabGroup.add(animTitle)

      const movingText = new TextRenderable(renderer, {
        id: "moving-text",
        content: "Moving Text",
        position: "absolute",
        left: animPosition,
        top: 8,
        fg: "#00FF00",
        attributes: TextAttributes.BOLD | TextAttributes.UNDERLINE,
        zIndex: 10,
      })
      tabGroup.add(movingText)

      const animatedBox = new BoxRenderable(renderer, {
        id: "animated-box",
        position: "absolute",
        left: animPosition,
        top: 10,
        width: 10,
        height: 3,
        backgroundColor: "#550055",
        zIndex: 0,
        borderStyle: "rounded",
        borderColor: "#FF00FF",
        border: true,
      })
      tabGroup.add(animatedBox)

      const colorBox = new BoxRenderable(renderer, {
        id: "color-box",
        position: "absolute",
        left: 50,
        top: 12,
        width: 18,
        height: 5,
        backgroundColor: "#550055",
        zIndex: 0,
        borderStyle: "double",
        borderColor: "#FFFFFF",
        border: true,
      })
      tabGroup.add(colorBox)

      const colorBoxTitle = new TextRenderable(renderer, {
        id: "color-box-title",
        content: "Animated Color",
        position: "absolute",
        left: 52,
        top: 14,
        fg: "#FFFFFF",
        attributes: TextAttributes.BOLD,
        zIndex: 10,
      })
      tabGroup.add(colorBoxTitle)
    },
    update: (deltaMs: number, tabGroup: BoxRenderable) => {
      // Animate moving elements
      const deltaTime = Math.min(deltaMs / 1000, 0.1)
      animPosition += animSpeed * animDirection * deltaTime

      if (animPosition > 40) {
        animPosition = 40
        animDirection = -1
      } else if (animPosition < 5) {
        animPosition = 5
        animDirection = 1
      }

      const x = Math.round(animPosition)

      const movingText = tabGroup.getRenderable("moving-text") as TextRenderable
      if (movingText) {
        movingText.setPosition({ left: x, top: 8 })
      }

      const animatedBox = tabGroup.getRenderable("animated-box") as BoxRenderable
      if (animatedBox) {
        animatedBox.setPosition({ left: x, top: 10 })
      }

      // Animate color-changing box
      const time = Date.now() / 1000
      const hue = (time * 30) % 360
      const color = hsvToRgb(hue, 1, 0.7)
      const hexColor = rgbToHex(color)

      const colorBox = tabGroup.getRenderable("color-box") as BoxRenderable
      if (colorBox) {
        colorBox.backgroundColor = parseColor(hexColor)
      }
    },
  })

  // Tab: Titles
  tabController.addTab({
    title: "Titles",
    init: (tabGroup) => {
      const layoutTitle = new TextRenderable(renderer, {
        id: "layout-title",
        content: "Box Titles",
        position: "absolute",
        left: 10,
        top: 5,
        fg: "#FFFF00",
        attributes: TextAttributes.BOLD | TextAttributes.UNDERLINE,
        zIndex: 10,
      })
      tabGroup.add(layoutTitle)

      // Boxes with titles and different alignments
      const titledLeft = new BoxRenderable(renderer, {
        id: "titled-left",
        position: "absolute",
        left: 10,
        top: 8,
        width: 20,
        height: 5,
        backgroundColor: "#222244",
        zIndex: 0,
        borderStyle: "single",
        borderColor: "#FFFFFF",
        title: "Left Aligned",
        titleAlignment: "left",
        border: true,
      })
      tabGroup.add(titledLeft)

      const titledCenter = new BoxRenderable(renderer, {
        id: "titled-center",
        position: "absolute",
        left: 35,
        top: 8,
        width: 20,
        height: 5,
        backgroundColor: "#442222",
        zIndex: 0,
        borderStyle: "double",
        borderColor: "#FFFFFF",
        title: "Centered Title",
        titleAlignment: "center",
        border: true,
      })
      tabGroup.add(titledCenter)

      const titledRight = new BoxRenderable(renderer, {
        id: "titled-right",
        position: "absolute",
        left: 60,
        top: 8,
        width: 20,
        height: 5,
        backgroundColor: "#224422",
        zIndex: 0,
        borderStyle: "rounded",
        borderColor: "#FFFFFF",
        title: "Right Aligned",
        titleAlignment: "right",
        border: true,
      })
      tabGroup.add(titledRight)
    },
  })

  // Tab: Interactive
  const interactiveBorderSides = {
    top: true,
    right: true,
    bottom: true,
    left: true,
  }

  tabController.addTab({
    title: "Interactive",
    init: (tabGroup) => {
      const interactiveTitle = new TextRenderable(renderer, {
        id: "interactive-title",
        content: "Interactive Controls",
        position: "absolute",
        left: 10,
        top: 5,
        fg: "#FFFF00",
        attributes: TextAttributes.BOLD | TextAttributes.UNDERLINE,
        zIndex: 10,
      })
      tabGroup.add(interactiveTitle)

      const interactiveBorder = new BoxRenderable(renderer, {
        id: "interactive-border",
        position: "absolute",
        left: 15,
        top: 8,
        width: 40,
        height: 8,
        backgroundColor: "#333344",
        zIndex: 0,
        borderStyle: "double",
        borderColor: "#FFFFFF",
        border: true,
      })
      tabGroup.add(interactiveBorder)

      const interactiveLabel = new TextRenderable(renderer, {
        id: "interactive-label",
        content: "Press keys to toggle borders",
        position: "absolute",
        left: 22,
        top: 12,
        fg: "#FFFFFF",
        attributes: TextAttributes.BOLD,
        zIndex: 10,
      })
      tabGroup.add(interactiveLabel)

      const interactiveInstructions = new TextRenderable(renderer, {
        id: "interactive-instructions",
        content: "Keyboard Controls:",
        position: "absolute",
        left: 10,
        top: 18,
        fg: "#FFFFFF",
        attributes: TextAttributes.UNDERLINE,
        zIndex: 10,
      })
      tabGroup.add(interactiveInstructions)

      const keyT = new TextRenderable(renderer, {
        id: "key-t",
        content: "T - Toggle top border",
        position: "absolute",
        left: 10,
        top: 19,
        fg: "#CCCCCC",
        zIndex: 10,
      })
      tabGroup.add(keyT)

      const keyR = new TextRenderable(renderer, {
        id: "key-r",
        content: "R - Toggle right border",
        position: "absolute",
        left: 10,
        top: 20,
        fg: "#CCCCCC",
        zIndex: 10,
      })
      tabGroup.add(keyR)

      const keyB = new TextRenderable(renderer, {
        id: "key-b",
        content: "B - Toggle bottom border",
        position: "absolute",
        left: 10,
        top: 21,
        fg: "#CCCCCC",
        zIndex: 10,
      })
      tabGroup.add(keyB)

      const keyL = new TextRenderable(renderer, {
        id: "key-l",
        content: "L - Toggle left border",
        position: "absolute",
        left: 10,
        top: 22,
        fg: "#CCCCCC",
        zIndex: 10,
      })
      tabGroup.add(keyL)

      const borderState = new TextRenderable(renderer, {
        id: "border-state",
        content: "Active borders: All",
        position: "absolute",
        left: 10,
        top: 24,
        fg: "#AAAAAA",
        zIndex: 10,
      })
      tabGroup.add(borderState)
    },
    update: (deltaMs: number, tabGroup: BoxRenderable) => {
      // Update interactive border state
      const interactiveBorder = tabGroup.getRenderable("interactive-border") as BoxRenderable
      if (interactiveBorder) {
        interactiveBorder.border = getBorderFromSides(interactiveBorderSides)
      }

      let borderDesc = ""
      if (interactiveBorderSides.top) borderDesc += "Top "
      if (interactiveBorderSides.right) borderDesc += "Right "
      if (interactiveBorderSides.bottom) borderDesc += "Bottom "
      if (interactiveBorderSides.left) borderDesc += "Left "
      if (!borderDesc) borderDesc = "None"

      const borderState = tabGroup.getRenderable("border-state") as TextRenderable
      if (borderState) {
        borderState.content = `Active borders: ${borderDesc}`
      }
    },
  })

  tabController.focus()

  globalKeyboardHandler = (key: KeyEvent) => {
    // Interactive border controls (only active in Interactive tab)
    if (tabController.getCurrentTab().title === "Interactive") {
      if (key.name === "t" || key.name === "T") {
        interactiveBorderSides.top = !interactiveBorderSides.top
      } else if (key.name === "r" || key.name === "R") {
        interactiveBorderSides.right = !interactiveBorderSides.right
      } else if (key.name === "b" || key.name === "B") {
        interactiveBorderSides.bottom = !interactiveBorderSides.bottom
      } else if (key.name === "l" || key.name === "L") {
        interactiveBorderSides.left = !interactiveBorderSides.left
      }
    }
  }

  renderer.keyInput.on("keypress", globalKeyboardHandler)
}

export function destroy(renderer: CliRenderer): void {
  renderer.clearFrameCallbacks()

  if (globalKeyboardHandler) {
    renderer.keyInput.off("keypress", globalKeyboardHandler)
    globalKeyboardHandler = null
  }

  if (globalTabController) {
    globalTabController.destroyRecursively()
    globalTabController = null
  }

  renderer.setCursorPosition(0, 0, false)
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  })

  run(renderer)
  setupCommonDemoKeys(renderer)
}
