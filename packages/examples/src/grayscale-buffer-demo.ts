#!/usr/bin/env bun

import {
  CliRenderer,
  createCliRenderer,
  OptimizedBuffer,
  RGBA,
  FrameBufferRenderable,
  type KeyEvent,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let framebuffer: OptimizedBuffer | null = null
let keyListener: ((key: KeyEvent) => void) | null = null
let resizeListener: ((width: number, height: number) => void) | null = null
let leftBuffer: Float32Array | null = null
let rightBuffer: Float32Array | null = null

let patternMode = 0
const PATTERN_NAMES = ["Plasma", "Ripples", "Waves", "Starburst", "Dots", "Checkers"]

function generatePlasma(x: number, y: number, w: number, h: number, t: number): number {
  const nx = x / w
  const ny = y / h
  const v1 = Math.sin(nx * 10 + t)
  const v2 = Math.sin(ny * 10 + t * 0.7)
  const v3 = Math.sin((nx + ny) * 8 + t * 1.3)
  const v4 = Math.sin(Math.sqrt((nx - 0.5) ** 2 + (ny - 0.5) ** 2) * 12 - t * 2)
  return (v1 + v2 + v3 + v4 + 4) / 8
}

function generateRipples(x: number, y: number, w: number, h: number, t: number): number {
  const cx = w / 2
  const cy = h / 2
  const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
  const wave = Math.sin(dist * 0.5 - t * 3) * 0.5 + 0.5
  const fade = 1 - Math.min(dist / Math.max(w, h), 1)
  return wave * fade
}

function generateWaves(x: number, y: number, w: number, h: number, t: number): number {
  const nx = x / w
  const ny = y / h
  const diagonal = (nx + ny) * 6 - t * 2
  const cross = Math.sin(nx * 8 + t) * Math.sin(ny * 8 + t * 0.8)
  return (Math.sin(diagonal) * 0.5 + 0.5) * 0.6 + (cross * 0.5 + 0.5) * 0.4
}

function generateStarburst(x: number, y: number, w: number, h: number, t: number): number {
  const cx = w / 2
  const cy = h / 2
  const dx = x - cx
  const dy = y - cy
  const angle = Math.atan2(dy, dx) + t * 0.5
  const numRays = 12
  const rayAngle = (angle * numRays) / (2 * Math.PI)
  const rayIntensity = Math.abs(Math.sin(rayAngle * Math.PI))
  return rayIntensity > 0.7 ? 1.0 : 0.0
}

function generateDots(x: number, y: number, w: number, h: number, t: number): number {
  const gridSize = Math.min(w, h) / 6
  const offsetX = t * 3
  const offsetY = t * 2
  const gx = ((((x + offsetX) % gridSize) + gridSize) % gridSize) - gridSize / 2
  const gy = ((((y + offsetY) % gridSize) + gridSize) % gridSize) - gridSize / 2
  const dist = Math.sqrt(gx * gx + gy * gy)
  const radius = gridSize * 0.35
  return dist < radius ? 1.0 : 0.0
}

function generateCheckers(x: number, y: number, w: number, h: number, t: number): number {
  const cx = w / 2
  const cy = h / 2
  const dx = x - cx
  const dy = y - cy
  const cos = Math.cos(t * 0.3)
  const sin = Math.sin(t * 0.3)
  const rx = dx * cos - dy * sin
  const ry = dx * sin + dy * cos
  const size = Math.min(w, h) / 8
  const checkX = Math.floor(rx / size)
  const checkY = Math.floor(ry / size)
  return (checkX + checkY) % 2 === 0 ? 1.0 : 0.0
}

function getIntensity(x: number, y: number, w: number, h: number, t: number): number {
  switch (patternMode) {
    case 0:
      return generatePlasma(x, y, w, h, t)
    case 1:
      return generateRipples(x, y, w, h, t)
    case 2:
      return generateWaves(x, y, w, h, t)
    case 3:
      return generateStarburst(x, y, w, h, t)
    case 4:
      return generateDots(x, y, w, h, t)
    case 5:
      return generateCheckers(x, y, w, h, t)
    default:
      return generatePlasma(x, y, w, h, t)
  }
}

export async function run(renderer: CliRenderer): Promise<void> {
  renderer.start()

  let WIDTH = renderer.terminalWidth
  let HEIGHT = renderer.terminalHeight
  let time = 0
  let paused = false

  const framebufferRenderable = new FrameBufferRenderable(renderer, {
    id: "grayscale-demo",
    width: WIDTH,
    height: HEIGHT,
    zIndex: 0,
  })
  renderer.root.add(framebufferRenderable)
  framebuffer = framebufferRenderable.frameBuffer

  function renderDemo(): void {
    if (!framebuffer) return

    const fb = framebuffer
    const totalWidth = fb.width
    const totalHeight = fb.height

    const headerHeight = 3
    const panelHeight = totalHeight - headerHeight
    const panelWidth = Math.floor((totalWidth - 3) / 2)

    if (panelWidth < 10 || panelHeight < 5) return

    const bgColor = RGBA.fromInts(20, 20, 30, 255)

    fb.fillRect(0, 0, totalWidth, totalHeight, bgColor)

    if (!leftBuffer || leftBuffer.length !== panelWidth * panelHeight) {
      leftBuffer = new Float32Array(panelWidth * panelHeight)
    }
    for (let y = 0; y < panelHeight; y++) {
      for (let x = 0; x < panelWidth; x++) {
        leftBuffer[y * panelWidth + x] = getIntensity(x, y, panelWidth, panelHeight, time)
      }
    }
    fb.drawGrayscaleBuffer(0, headerHeight, leftBuffer, panelWidth, panelHeight)

    const rightX = panelWidth + 3
    const ssWidth = panelWidth * 2
    const ssHeight = panelHeight * 2
    if (!rightBuffer || rightBuffer.length !== ssWidth * ssHeight) {
      rightBuffer = new Float32Array(ssWidth * ssHeight)
    }
    for (let y = 0; y < ssHeight; y++) {
      for (let x = 0; x < ssWidth; x++) {
        rightBuffer[y * ssWidth + x] = getIntensity(x, y, ssWidth, ssHeight, time)
      }
    }
    fb.drawGrayscaleBufferSupersampled(rightX, headerHeight, rightBuffer, ssWidth, ssHeight)

    const dividerX = panelWidth + 1
    for (let y = headerHeight; y < totalHeight; y++) {
      fb.setCell(dividerX, y, "|", RGBA.fromInts(60, 60, 80, 255), bgColor)
    }

    const headerBg = RGBA.fromInts(40, 40, 60, 255)
    const labelColor = RGBA.fromInts(200, 200, 220, 255)
    const highlightColor = RGBA.fromInts(100, 200, 255, 255)

    fb.fillRect(0, 0, totalWidth, headerHeight, headerBg)

    const leftLabel = "1:1 Standard"
    const leftLabelX = Math.floor(panelWidth / 2 - leftLabel.length / 2)
    for (let i = 0; i < leftLabel.length; i++) {
      fb.setCell(leftLabelX + i, 1, leftLabel[i], labelColor, headerBg)
    }

    const rightLabel = "2x Supersampled"
    const rightLabelX = rightX + Math.floor(panelWidth / 2 - rightLabel.length / 2)
    for (let i = 0; i < rightLabel.length; i++) {
      fb.setCell(rightLabelX + i, 1, rightLabel[i], highlightColor, headerBg)
    }

    const info = `[${PATTERN_NAMES[patternMode]}] SPACE:pause P:pattern`
    const infoX = Math.floor(totalWidth / 2 - info.length / 2)
    for (let i = 0; i < info.length; i++) {
      fb.setCell(infoX + i, 0, info[i], RGBA.fromInts(150, 150, 170, 255), headerBg)
    }
  }

  keyListener = (key: KeyEvent) => {
    switch (key.name) {
      case "space":
        paused = !paused
        break
      case "p":
        patternMode = (patternMode + 1) % 6
        break
    }
  }
  renderer.keyInput.on("keypress", keyListener)

  resizeListener = (width: number, height: number) => {
    WIDTH = width
    HEIGHT = height
    if (framebuffer) {
      framebuffer.resize(width, height)
    }
  }
  renderer.on("resize", resizeListener)

  renderer.setFrameCallback(async (deltaTime) => {
    if (!paused) {
      time += (deltaTime / 1000) * 0.8
    }
    renderDemo()
  })
}

export function destroy(renderer: CliRenderer): void {
  renderer.clearFrameCallbacks()

  if (resizeListener) {
    renderer.off("resize", resizeListener)
    resizeListener = null
  }

  if (keyListener) {
    renderer.keyInput.off("keypress", keyListener)
    keyListener = null
  }

  const grayscaleDemo = renderer.root.getRenderable("grayscale-demo")
  grayscaleDemo?.destroy()
  framebuffer = null
  leftBuffer = null
  rightBuffer = null
  patternMode = 0
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
  })
  await run(renderer)
  setupCommonDemoKeys(renderer)
}
