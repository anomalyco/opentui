import { TextAttributes, createCliRenderer, TextRenderable, BoxRenderable, type KeyEvent } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import type { CliRenderer } from "@opentui/core"

let globalKeyboardHandler: ((key: KeyEvent) => void) | null = null
let animationSpeed = 4000
let animationTime = 0

export function run(renderer: CliRenderer): void {
  renderer.start()
  renderer.setBackgroundColor("#001122")

  const rootContainer = new BoxRenderable(renderer, {
    id: "root-container",
    position: "relative",
    left: 0,
    top: 0,
    zIndex: 10,
  })
  renderer.root.add(rootContainer)

  const title = new TextRenderable(renderer, {
    id: "main-title",
    content: "Relative Positioning Demo - Child positions are relative to parent",
    position: "absolute",
    left: 5,
    top: 1,
    fg: "#FFFF00",
    attributes: TextAttributes.BOLD | TextAttributes.UNDERLINE,
    zIndex: 1000,
  })
  rootContainer.add(title)

  const parentContainerA = new BoxRenderable(renderer, {
    id: "parent-container-a",
    position: "absolute",
    left: 10,
    top: 5,
    zIndex: 50,
  })
  rootContainer.add(parentContainerA)

  const parentBoxA = new BoxRenderable(renderer, {
    id: "parent-box-a",
    left: 0,
    top: 0,
    width: 40,
    height: 12,
    backgroundColor: "#220044",
    zIndex: 1,
    borderStyle: "double",
    borderColor: "#FF44FF",
    title: "Parent A (moves in circle)",
    titleAlignment: "center",
    flexDirection: "row",
    alignItems: "stretch",
    justifyContent: "space-between",
    border: true,
  })
  parentContainerA.add(parentBoxA)

  const childA1 = new BoxRenderable(renderer, {
    id: "child-a1",
    width: "auto",
    height: "auto",
    backgroundColor: "#440066",
    zIndex: 2,
    borderStyle: "single",
    borderColor: "#FF88FF",
    title: "Child 1",
    titleAlignment: "center",
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 8,
    border: true,
  })
  parentBoxA.add(childA1)

  const childA2 = new BoxRenderable(renderer, {
    id: "child-a2",
    width: "auto",
    height: "auto",
    backgroundColor: "#660044",
    zIndex: 2,
    borderStyle: "single",
    borderColor: "#FF88FF",
    title: "Child 2",
    titleAlignment: "center",
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 8,
    border: true,
  })
  parentBoxA.add(childA2)

  const childA3 = new BoxRenderable(renderer, {
    id: "child-a3",
    width: "auto",
    height: "auto",
    backgroundColor: "#440044",
    zIndex: 2,
    borderStyle: "single",
    borderColor: "#FF88FF",
    title: "Child 3",
    titleAlignment: "center",
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 8,
    border: true,
  })
  parentBoxA.add(childA3)

  const parentContainerB = new BoxRenderable(renderer, {
    id: "parent-container-b",
    position: "absolute",
    left: 50,
    top: 8,
    zIndex: 50,
  })
  rootContainer.add(parentContainerB)

  const parentBoxB = new BoxRenderable(renderer, {
    id: "parent-box-b",
    left: 0,
    top: 0,
    width: 40,
    height: 10,
    backgroundColor: "#004422",
    zIndex: 1,
    borderStyle: "rounded",
    borderColor: "#44FF44",
    title: "Parent B (moves vertically)",
    titleAlignment: "center",
    padding: 1,
    flexDirection: "column",
    justifyContent: "space-between",
    border: true,
  })
  parentContainerB.add(parentBoxB)

  const parentLabelB = new TextRenderable(renderer, {
    id: "parent-label-b",
    content: "Parent B Position: (50, 8)",
    fg: "#44FF44",
    attributes: TextAttributes.BOLD,
    zIndex: 2,
  })
  parentBoxB.add(parentLabelB)

  const childB1 = new TextRenderable(renderer, {
    id: "child-b1",
    content: "Child at (1,3) - relative to parent",
    fg: "#88FF88",
    zIndex: 2,
  })
  parentBoxB.add(childB1)

  const childB2 = new TextRenderable(renderer, {
    id: "child-b2",
    content: "Child at (1,5) - relative to parent",
    fg: "#88FF88",
    zIndex: 2,
  })
  parentBoxB.add(childB2)

  const staticContainer = new BoxRenderable(renderer, {
    id: "static-container",
    position: "absolute",
    left: 5,
    top: 20,
    zIndex: 50,
  })
  rootContainer.add(staticContainer)

  const staticBox = new BoxRenderable(renderer, {
    id: "static-box",
    left: 0,
    top: 0,
    width: 40,
    height: 8,
    backgroundColor: "#442200",
    zIndex: 1,
    borderStyle: "single",
    borderColor: "#FFFF44",
    title: "Static Parent (doesn't move)",
    titleAlignment: "center",
    padding: 1,
    flexDirection: "column",
    border: true,
    overflow: "hidden",
  })
  staticContainer.add(staticBox)

  const staticChild1 = new TextRenderable(renderer, {
    id: "static-child1",
    content: "Static child at (2,2) - never moves",
    fg: "#FFFF88",
    zIndex: 2,
  })
  staticBox.add(staticChild1)

  const staticChild2 = new TextRenderable(renderer, {
    id: "static-child2",
    content: "Static child at (2,4) - never moves",
    fg: "#FFFF88",
    zIndex: 2,
  })
  staticBox.add(staticChild2)

  const explanation1 = new TextRenderable(renderer, {
    id: "explanation1",
    content: "Key Concept: Parent A uses flex layout - children are arranged in a row",
    position: "absolute",
    left: 5,
    top: 30,
    fg: "#AAAAAA",
    attributes: TextAttributes.BOLD,
    zIndex: 1000,
  })
  rootContainer.add(explanation1)

  const explanation2 = new TextRenderable(renderer, {
    id: "explanation2",
    content: "When parent moves, children move with it while maintaining flex layout",
    position: "absolute",
    left: 5,
    top: 31,
    fg: "#AAAAAA",
    zIndex: 1000,
  })
  rootContainer.add(explanation2)

  const explanation3 = new TextRenderable(renderer, {
    id: "explanation3",
    content: "Flex children automatically fit parent width and grow/shrink as needed",
    position: "absolute",
    left: 5,
    top: 32,
    fg: "#AAAAAA",
    zIndex: 1000,
  })
  rootContainer.add(explanation3)

  const controls = new TextRenderable(renderer, {
    id: "controls",
    content: "Controls: +/- to change animation speed",
    position: "absolute",
    left: 5,
    top: 34,
    fg: "#FFFFFF",
    attributes: TextAttributes.BOLD,
    zIndex: 1000,
  })
  rootContainer.add(controls)

  const speedDisplay = new TextRenderable(renderer, {
    id: "speed-display",
    content: `Animation Speed: ${animationSpeed}ms (min: 500, max: 8000)`,
    position: "absolute",
    left: 5,
    top: 35,
    fg: "#CCCCCC",
    zIndex: 1000,
  })
  rootContainer.add(speedDisplay)

  renderer.setFrameCallback(async (deltaMs) => {
    animationTime += deltaMs

    const circleRadius = 15
    const circleSpeed = (animationTime / animationSpeed) * Math.PI * 2
    const parentAX = 20 + Math.cos(circleSpeed) * circleRadius
    const parentAY = 8 + (Math.sin(circleSpeed) * circleRadius) / 2

    parentContainerA.setPosition({
      left: Math.round(parentAX),
      top: Math.round(parentAY),
    })

    const verticalSpeed = (animationTime / (animationSpeed * 1.5)) * Math.PI * 2
    const parentBY = 8 + Math.sin(verticalSpeed) * 8

    parentContainerB.setPosition({
      left: 50,
      top: Math.round(parentBY),
    })
    parentLabelB.content = `Parent B Position: (50, ${Math.round(parentBY)})`
  })

  globalKeyboardHandler = (key: KeyEvent) => {
    if (key.name === "+" || key.name === "=") {
      animationSpeed = Math.max(500, animationSpeed - 300)
      speedDisplay.content = `Animation Speed: ${animationSpeed}ms (min: 500, max: 8000)`
    } else if (key.name === "-" || key.name === "_") {
      animationSpeed = Math.min(8000, animationSpeed + 300)
      speedDisplay.content = `Animation Speed: ${animationSpeed}ms (min: 500, max: 8000)`
    }
  }

  renderer.keyInput.on("keypress", globalKeyboardHandler)
}

export function destroy(renderer: CliRenderer): void {
  if (globalKeyboardHandler) {
    renderer.keyInput.off("keypress", globalKeyboardHandler)
    globalKeyboardHandler = null
  }

  const rootContainer = renderer.root.getRenderable("root-container")
  rootContainer?.destroyRecursively()

  renderer.clearFrameCallbacks()
  renderer.setCursorPosition(0, 0, false)
  animationTime = 0
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  })

  run(renderer)
  setupCommonDemoKeys(renderer)
}
