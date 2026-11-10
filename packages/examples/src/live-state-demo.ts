#!/usr/bin/env bun

import {
  CliRenderer,
  createCliRenderer,
  RGBA,
  TextAttributes,
  TextRenderable,
  BoxRenderable,
  type MouseEvent,
  t,
  bold,
  red,
  green,
  blue,
  fg,
  parseColor,
  Box,
} from "@opentui/core"
import type { BoxOptions } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let mainGroup: BoxRenderable | null = null
let titleText: TextRenderable | null = null
let instructionsText: TextRenderable | null = null
let statusText: TextRenderable | null = null
let rendererStateText: TextRenderable | null = null
let renderableStateText: TextRenderable | null = null
let liveButtons: ReturnType<typeof LiveButton>[] = []
let demoRenderable: BoxRenderable | null = null
let currentRenderer: CliRenderer | null = null
let frameCounter = 0
let animationCounter = 0
let frameCallback: ((deltaTime: number) => Promise<void>) | null = null

function LiveButton(options: BoxOptions & { label: string }) {
  const base = parseColor(options.backgroundColor ?? "transparent")
  const hoverBg = RGBA.fromValues(
    Math.min(1.0, base.r * 1.4),
    Math.min(1.0, base.g * 1.4),
    Math.min(1.0, base.b * 1.4),
    base.a,
  )
  const pressBg = RGBA.fromValues(base.r * 0.6, base.g * 0.6, base.b * 0.6, base.a)

  return Box({
    ...options,
    renderAfter(buffer, deltaTime) {
      const textColor = RGBA.fromValues(1, 1, 1, 1)
      const centerY = this.y + Math.floor(this.height / 2)
      const startX = this.x + Math.floor((this.width - options.label.length) / 2)

      buffer.drawText(options.label, startX, centerY, textColor)
    },
    onMouse(event: MouseEvent) {
      switch (event.type) {
        case "down":
          this.backgroundColor = pressBg
          event.stopPropagation()
          break

        case "up":
          this.backgroundColor = base
          event.stopPropagation()
          break

        case "over":
          this.backgroundColor = hoverBg
          break

        case "out":
          this.backgroundColor = base
          break
      }
    },
  })
}

function updateStatusText(message: string): void {
  if (statusText) {
    const timestamp = new Date().toLocaleTimeString()
    statusText.content = `[${timestamp}] ${message}`
  }
}

function updateRendererState(renderer: CliRenderer): void {
  if (rendererStateText) {
    const running = renderer.isRunning
    const liveCount = renderer.liveRequestCount
    const controlState = renderer.currentControlState

    const liveIndicators = ["▘", "▝", "▗", "▖"]
    const liveIndicator = liveCount > 0 ? liveIndicators[animationCounter % liveIndicators.length] : " "
    const styledContent = t`${bold("Renderer State:")} ${running ? green(bold("RUNNING")) : red(bold("STOPPED"))} | ${bold("Live Requests:")} ${liveCount > 0 ? green(bold(liveCount.toString())) : fg("#666")(liveCount.toString())} ${liveCount > 0 ? fg("#00FFFF")(liveIndicator) : ""} | ${bold("Control State:")} ${controlState === "live" ? green(bold(controlState.toUpperCase())) : blue(bold(controlState.toUpperCase()))} | ${bold("Frame:")} ${fg("#888")(frameCounter.toString())}`

    rendererStateText.content = styledContent
  }
}

function updateRenderableState(): void {
  if (renderableStateText) {
    const exists = demoRenderable !== null
    const live = demoRenderable?.live || false
    const visible = demoRenderable?.visible ?? false

    const styledContent = t`${bold("Demo Renderable:")} ${exists ? green(bold("ADDED")) : fg("#666")(bold("NOT ADDED"))} | ${bold("Live:")} ${live ? green(bold("TRUE")) : red(bold("FALSE"))} | ${bold("Visible:")} ${visible ? blue(bold("TRUE")) : fg("#666")(bold("FALSE"))}`

    renderableStateText.content = styledContent
  }
}

function addDemoRenderable(renderer: CliRenderer): void {
  if (demoRenderable) {
    updateStatusText("Demo renderable already exists!")
    return
  }

  demoRenderable = new BoxRenderable(renderer, {
    id: "demo-renderable",
    position: "absolute",
    left: 60,
    top: 15,
    width: 30,
    height: 8,
    backgroundColor: RGBA.fromInts(100, 200, 150, 255),
    borderColor: RGBA.fromInts(150, 255, 200, 255),
    borderStyle: "double",
    title: "Demo Renderable",
    titleAlignment: "center",
    border: true,
  })

  renderer.root.getRenderable("live-demo-main-group")?.add(demoRenderable)
  updateStatusText("Added demo renderable")
}

function removeDemoRenderable(renderer: CliRenderer): void {
  if (!demoRenderable) {
    updateStatusText("No demo renderable to remove!")
    return
  }

  demoRenderable.destroyRecursively()
  demoRenderable = null
  updateStatusText("Removed demo renderable")
}

export function run(renderer: CliRenderer): void {
  currentRenderer = renderer

  mainGroup = new BoxRenderable(renderer, {
    id: "live-demo-main-group",
    zIndex: 10,
  })
  renderer.root.add(mainGroup)

  const backgroundColor = RGBA.fromInts(25, 30, 45, 255)
  renderer.setBackgroundColor(backgroundColor)

  titleText = new TextRenderable(renderer, {
    id: "live_demo_title",
    content: "Live State Management Demo",
    position: "absolute",
    left: 2,
    top: 1,
    fg: RGBA.fromInts(255, 215, 135),
    attributes: TextAttributes.BOLD,
    zIndex: 1000,
  })
  mainGroup.add(titleText)

  instructionsText = new TextRenderable(renderer, {
    id: "live_demo_instructions",
    content: "Test the live state management system • Escape: return to menu",
    position: "absolute",
    left: 2,
    top: 2,
    fg: RGBA.fromInts(176, 196, 222),
    zIndex: 1000,
  })
  mainGroup.add(instructionsText)

  statusText = new TextRenderable(renderer, {
    id: "live_demo_status",
    content: "Ready - Click buttons to test live state management",
    position: "absolute",
    left: 2,
    top: 4,
    fg: RGBA.fromInts(144, 238, 144),
    attributes: TextAttributes.ITALIC,
    zIndex: 1000,
  })
  mainGroup.add(statusText)

  rendererStateText = new TextRenderable(renderer, {
    id: "renderer_state",
    content: "",
    position: "absolute",
    left: 2,
    top: 6,
    fg: RGBA.fromInts(255, 255, 100),
    zIndex: 1000,
  })
  mainGroup.add(rendererStateText)

  renderableStateText = new TextRenderable(renderer, {
    id: "renderable_state",
    content: "",
    position: "absolute",
    left: 2,
    top: 7,
    fg: RGBA.fromInts(255, 255, 100),
    zIndex: 1000,
  })
  mainGroup.add(renderableStateText)

  // Button colors
  const rendererColor = RGBA.fromInts(100, 140, 180, 255) // Blue - darker for better contrast
  const renderableColor = RGBA.fromInts(180, 100, 140, 255) // Pink - darker for better contrast
  const liveColor = RGBA.fromInts(140, 180, 100, 255) // Green - darker for better contrast
  const visibilityColor = RGBA.fromInts(180, 140, 100, 255) // Orange - for visibility controls

  const startY = 10
  const buttonWidth = 20
  const buttonHeight = 3
  const spacing = 22

  // Renderer control buttons
  liveButtons = [
    LiveButton({
      id: "request-live-btn",
      position: "absolute",
      left: 2,
      top: startY,
      width: buttonWidth,
      height: buttonHeight,
      backgroundColor: rendererColor,
      label: "REQUEST LIVE",
      onMouseDown: () => {
        if (!currentRenderer) return
        currentRenderer.requestLive()
        updateStatusText("Manually requested live")
        updateRendererState(currentRenderer)
        updateRenderableState()
      },
    }),
    LiveButton({
      id: "drop-live-btn",
      position: "absolute",
      left: 2 + spacing,
      top: startY,
      width: buttonWidth,
      height: buttonHeight,
      backgroundColor: rendererColor,
      label: "DROP LIVE",
      onMouseDown: () => {
        if (!currentRenderer) return
        currentRenderer.dropLive()
        updateStatusText("Manually dropped live")
        updateRendererState(currentRenderer)
        updateRenderableState()
      },
    }),

    // Renderable management buttons
    LiveButton({
      id: "add-renderable-btn",
      position: "absolute",
      left: 2,
      top: startY + 5,
      width: buttonWidth,
      height: buttonHeight,
      backgroundColor: renderableColor,
      label: "ADD RENDERABLE",
      onMouseDown: () => {
        if (!currentRenderer) return
        addDemoRenderable(currentRenderer)
        updateRendererState(currentRenderer)
        updateRenderableState()
      },
    }),
    LiveButton({
      id: "remove-renderable-btn",
      position: "absolute",
      left: 2 + spacing,
      top: startY + 5,
      width: buttonWidth,
      height: buttonHeight,
      backgroundColor: renderableColor,
      label: "REMOVE RENDERABLE",
      onMouseDown: () => {
        if (!currentRenderer) return
        removeDemoRenderable(currentRenderer)
        updateRendererState(currentRenderer)
        updateRenderableState()
      },
    }),

    // Live state buttons
    LiveButton({
      id: "set-live-true-btn",
      position: "absolute",
      left: 2,
      top: startY + 10,
      width: buttonWidth,
      height: buttonHeight,
      backgroundColor: liveColor,
      label: "LIVE = TRUE",
      onMouseDown: () => {
        if (demoRenderable) {
          demoRenderable.live = true
          updateStatusText("Set demo renderable live = true")
        } else {
          updateStatusText("No demo renderable to set live!")
        }
        if (currentRenderer) {
          updateRendererState(currentRenderer)
        }
        updateRenderableState()
      },
    }),
    LiveButton({
      id: "set-live-false-btn",
      position: "absolute",
      left: 2 + spacing,
      top: startY + 10,
      width: buttonWidth,
      height: buttonHeight,
      backgroundColor: liveColor,
      label: "LIVE = FALSE",
      onMouseDown: () => {
        if (demoRenderable) {
          demoRenderable.live = false
          updateStatusText("Set demo renderable live = false")
        } else {
          updateStatusText("No demo renderable to set live!")
        }
        if (currentRenderer) {
          updateRendererState(currentRenderer)
        }
        updateRenderableState()
      },
    }),

    // Visibility state buttons
    LiveButton({
      id: "set-visible-true-btn",
      position: "absolute",
      left: 2,
      top: startY + 15,
      width: buttonWidth,
      height: buttonHeight,
      backgroundColor: visibilityColor,
      label: "VISIBLE = TRUE",
      onMouseDown: () => {
        if (demoRenderable) {
          demoRenderable.visible = true
          updateStatusText("Set demo renderable visible = true")
        } else {
          updateStatusText("No demo renderable to set visible!")
        }
        if (currentRenderer) {
          updateRendererState(currentRenderer)
        }
        updateRenderableState()
      },
    }),
    LiveButton({
      id: "set-visible-false-btn",
      position: "absolute",
      left: 2 + spacing,
      top: startY + 15,
      width: buttonWidth,
      height: buttonHeight,
      backgroundColor: visibilityColor,
      label: "VISIBLE = FALSE",
      onMouseDown: () => {
        if (demoRenderable) {
          demoRenderable.visible = false
          updateStatusText("Set demo renderable visible = false")
        } else {
          updateStatusText("No demo renderable to set visible!")
        }
        if (currentRenderer) {
          updateRendererState(currentRenderer)
        }
        updateRenderableState()
      },
    }),
  ]

  for (const button of liveButtons) {
    mainGroup.add(button)
  }

  // Add section labels
  const rendererLabel = new TextRenderable(renderer, {
    id: "renderer_label",
    content: "Renderer Control:",
    position: "absolute",
    left: 2,
    top: startY - 1,
    fg: rendererColor,
    attributes: TextAttributes.BOLD,
    zIndex: 500,
  })
  mainGroup.add(rendererLabel)

  const renderableLabel = new TextRenderable(renderer, {
    id: "renderable_label",
    content: "Renderable Management:",
    position: "absolute",
    left: 2,
    top: startY + 4,
    fg: renderableColor,
    attributes: TextAttributes.BOLD,
    zIndex: 500,
  })
  mainGroup.add(renderableLabel)

  const liveLabel = new TextRenderable(renderer, {
    id: "live_label",
    content: "Live State Control:",
    position: "absolute",
    left: 2,
    top: startY + 9,
    fg: liveColor,
    attributes: TextAttributes.BOLD,
    zIndex: 500,
  })
  mainGroup.add(liveLabel)

  const visibilityLabel = new TextRenderable(renderer, {
    id: "visibility_label",
    content: "Visibility Control:",
    position: "absolute",
    left: 2,
    top: startY + 14,
    fg: visibilityColor,
    attributes: TextAttributes.BOLD,
    zIndex: 500,
  })
  mainGroup.add(visibilityLabel)

  frameCallback = async (deltaTime) => {
    frameCounter++
    if (frameCounter % 10 === 0) {
      animationCounter++
      updateRendererState(renderer)
      updateRenderableState()
    }
  }
  renderer.setFrameCallback(frameCallback)

  updateRendererState(renderer)
  updateRenderableState()

  console.log("Live State Demo initialized! Test the automatic live state management system.")
}

export function destroy(renderer: CliRenderer): void {
  if (frameCallback) {
    renderer.removeFrameCallback(frameCallback)
    frameCallback = null
  }

  currentRenderer = null
  frameCounter = 0
  animationCounter = 0

  renderer.root.getRenderable("live-demo-main-group")?.destroyRecursively()
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  })
  run(renderer)
  setupCommonDemoKeys(renderer)
}
