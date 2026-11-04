import { CliRenderer, BoxRenderable, TextRenderable, createCliRenderer, type KeyEvent } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let renderer: CliRenderer | null = null
let header: BoxRenderable | null = null
let container: BoxRenderable | null = null
let infoText: TextRenderable | null = null
let boxes: BoxRenderable[] = []
let opacityValues = [1.0, 0.8, 0.5, 0.3]
let animationInterval: Timer | null = null

function createOpacityDemo(rendererInstance: CliRenderer): void {
  renderer = rendererInstance
  renderer.setBackgroundColor("#1a1a2e")

  // Info header
  header = new BoxRenderable(renderer, {
    id: "opacity-demo-header",
    width: "auto",
    height: 3,
    backgroundColor: "#16213e",
    border: true,
    borderStyle: "single",
    alignItems: "center",
    justifyContent: "center",
  })

  infoText = new TextRenderable(renderer, {
    id: "info",
    content: "OPACITY DEMO | 1-4: Toggle opacity | A: Animate | Ctrl+C: Exit",
    fg: "#e94560",
    bg: "transparent",
  })
  header.add(infoText)

  // Main container
  container = new BoxRenderable(renderer, {
    id: "opacity-demo-container",
    width: "auto",
    height: "auto",
    flexGrow: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    padding: 2,
  })

  // Create 4 overlapping boxes with different opacities
  const colors = ["#e94560", "#0f3460", "#533483", "#16a085"]
  const labels = ["Box 1", "Box 2", "Box 3", "Box 4"]

  for (let i = 0; i < 4; i++) {
    const box = new BoxRenderable(renderer, {
      id: `box-${i}`,
      width: 20,
      height: 8,
      backgroundColor: colors[i],
      border: true,
      borderStyle: "double",
      borderColor: "#ffffff",
      position: "absolute",
      left: 10 + i * 8,
      top: 5 + i * 2,
      opacity: opacityValues[i],
      alignItems: "center",
      justifyContent: "center",
      flexDirection: "column",
    })

    const label = new TextRenderable(renderer, {
      id: `label-${i}`,
      content: labels[i],
      fg: "#ffffff",
      bg: "transparent",
    })

    const opacityLabel = new TextRenderable(renderer, {
      id: `opacity-${i}`,
      content: `Opacity: ${opacityValues[i].toFixed(1)}`,
      fg: "#ffffff",
      bg: "transparent",
    })

    box.add(label)
    box.add(opacityLabel)
    boxes.push(box)
    container.add(box)
  }

  // Nested opacity demo
  const nestedContainer = new BoxRenderable(renderer, {
    id: "nested-container",
    width: 35,
    height: 10,
    backgroundColor: "#e94560",
    border: true,
    borderStyle: "single",
    position: "absolute",
    right: 5,
    top: 5,
    opacity: 0.7,
    padding: 1,
    flexDirection: "column",
  })

  const nestedLabel = new TextRenderable(renderer, {
    id: "nested-label",
    content: "Parent: 0.7 opacity",
    fg: "#ffffff",
    bg: "transparent",
  })

  const nestedChild = new BoxRenderable(renderer, {
    id: "nested-child",
    width: "auto",
    height: 5,
    backgroundColor: "#0f3460",
    border: true,
    opacity: 0.5, // Effective: 0.7 * 0.5 = 0.35
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "column",
  })

  const childLabel = new TextRenderable(renderer, {
    id: "child-label",
    content: "Child: 0.5 opacity",
    fg: "#ffffff",
    bg: "transparent",
  })

  const effectiveLabel = new TextRenderable(renderer, {
    id: "effective-label",
    content: "Effective: 0.35",
    fg: "#ffcc00",
    bg: "transparent",
  })

  nestedChild.add(childLabel)
  nestedChild.add(effectiveLabel)
  nestedContainer.add(nestedLabel)
  nestedContainer.add(nestedChild)
  container.add(nestedContainer)

  renderer.root.add(header)
  renderer.root.add(container)
}

function updateOpacityLabels(): void {
  for (let i = 0; i < boxes.length; i++) {
    const opacityLabel = boxes[i].getRenderable(`opacity-${i}`) as TextRenderable | undefined
    if (opacityLabel) {
      opacityLabel.content = `Opacity: ${boxes[i].opacity.toFixed(1)}`
    }
  }
}

function handleKeyPress(key: KeyEvent): void {
  switch (key.name) {
    case "1":
      boxes[0].opacity = boxes[0].opacity === 1.0 ? 0.3 : 1.0
      updateOpacityLabels()
      break
    case "2":
      boxes[1].opacity = boxes[1].opacity === 1.0 ? 0.3 : 1.0
      updateOpacityLabels()
      break
    case "3":
      boxes[2].opacity = boxes[2].opacity === 1.0 ? 0.3 : 1.0
      updateOpacityLabels()
      break
    case "4":
      boxes[3].opacity = boxes[3].opacity === 1.0 ? 0.3 : 1.0
      updateOpacityLabels()
      break
    case "a":
      toggleAnimation()
      break
  }
}

function toggleAnimation(): void {
  if (animationInterval) {
    clearInterval(animationInterval)
    animationInterval = null
    if (infoText) {
      infoText.content = "OPACITY DEMO | 1-4: Toggle opacity | A: Animate | Ctrl+C: Exit"
    }
  } else {
    let phase = 0
    animationInterval = setInterval(() => {
      phase += 0.05
      for (let i = 0; i < boxes.length; i++) {
        boxes[i].opacity = 0.3 + 0.7 * Math.abs(Math.sin(phase + i * 0.5))
      }
      updateOpacityLabels()
    }, 50)
    if (infoText) {
      infoText.content = "OPACITY DEMO | Animating... | A: Stop | Ctrl+C: Exit"
    }
  }
}

export function run(rendererInstance: CliRenderer): void {
  createOpacityDemo(rendererInstance)
  rendererInstance.keyInput.on("keypress", handleKeyPress)
}

export function destroy(rendererInstance: CliRenderer): void {
  if (animationInterval) {
    clearInterval(animationInterval)
    animationInterval = null
  }
  rendererInstance.keyInput.off("keypress", handleKeyPress)
  if (header) {
    header.destroyRecursively()
    header = null
  }
  if (container) {
    container.destroyRecursively()
    container = null
  }
  boxes = []
  infoText = null
  renderer = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
  })
  run(renderer)
  setupCommonDemoKeys(renderer)
}
