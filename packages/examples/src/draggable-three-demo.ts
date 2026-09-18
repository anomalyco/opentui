#!/usr/bin/env bun

import {
  CliRenderer,
  createCliRenderer,
  RGBA,
  BoxRenderable,
  TextRenderable,
  type KeyEvent,
  type MouseEvent,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import {
  Scene as ThreeScene,
  Mesh as ThreeMesh,
  PerspectiveCamera,
  Color,
  DirectionalLight,
  AmbientLight,
  BoxGeometry,
  MeshPhongMaterial,
  Vector3,
} from "three"
import { ThreeRenderable } from "@opentui/three"

let nextZIndex = 200
let keyListener: ((key: KeyEvent) => void) | null = null
let resizeListener: ((width: number, height: number) => void) | null = null
let parentContainer: BoxRenderable | null = null
let draggableCube: DraggableThreeRenderable | null = null

const HEADER_HEIGHT = 4

class DraggableThreeRenderable extends ThreeRenderable {
  private isDragging = false
  private dragOffsetX = 0
  private dragOffsetY = 0
  private dragBoundsTop: number

  constructor(ctx: CliRenderer, dragBoundsTop: number, options: ConstructorParameters<typeof ThreeRenderable>[1]) {
    super(ctx, options)
    this.dragBoundsTop = dragBoundsTop
  }

  public setDragBoundsTop(top: number): void {
    this.dragBoundsTop = top
  }

  protected onMouseEvent(event: MouseEvent): void {
    switch (event.type) {
      case "down":
        this.isDragging = true
        this.dragOffsetX = event.x - this.x
        this.dragOffsetY = event.y - this.y
        this.zIndex = nextZIndex++
        event.stopPropagation()
        break
      case "drag":
        if (!this.isDragging) return
        this.updateDragPosition(event.x, event.y)
        event.stopPropagation()
        break
      case "drag-end":
        if (this.isDragging) {
          this.isDragging = false
          event.stopPropagation()
        }
        break
    }
  }

  private updateDragPosition(pointerX: number, pointerY: number): void {
    const newX = pointerX - this.dragOffsetX
    const newY = pointerY - this.dragOffsetY
    const maxX = this._ctx.width - this.width
    const maxY = this._ctx.height - this.height

    this.x = Math.max(0, Math.min(newX, maxX))
    this.y = Math.max(this.dragBoundsTop, Math.min(newY, maxY))
  }
}

function getRenderSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(24, Math.min(64, Math.floor(width * 0.55))),
    height: Math.max(12, Math.min(28, Math.floor(height * 0.55))),
  }
}

export function run(renderer: CliRenderer): void {
  renderer.start()
  renderer.setBackgroundColor("#0A0E14")

  const width = renderer.terminalWidth
  const height = renderer.terminalHeight
  const size = getRenderSize(width, height)

  parentContainer = new BoxRenderable(renderer, {
    id: "draggable-three-container",
    zIndex: 10,
  })
  renderer.root.add(parentContainer)

  const titleText = new TextRenderable(renderer, {
    id: "draggable-three-title",
    content: "Draggable ThreeRenderable - rotating cube (drag with mouse)",
    position: "absolute",
    left: 2,
    top: 1,
    fg: "#E2E8F0",
    zIndex: 20,
  })
  parentContainer.add(titleText)

  const instructionsText = new TextRenderable(renderer, {
    id: "draggable-three-instructions",
    content: "Space: toggle rotation | P: screenshot | Esc: return",
    position: "absolute",
    left: 2,
    top: 2,
    fg: "#94A3B8",
    zIndex: 20,
  })
  parentContainer.add(instructionsText)

  const controlsText = new TextRenderable(renderer, {
    id: "draggable-three-controls",
    content: "Drag the cube to see transparency and live rendering",
    position: "absolute",
    left: 2,
    top: height - 2,
    fg: "#CBD5F5",
    zIndex: 20,
  })
  parentContainer.add(controlsText)

  const sceneRoot = new ThreeScene()

  const ambientLight = new AmbientLight(new Color(0.35, 0.35, 0.35), 1.0)
  sceneRoot.add(ambientLight)

  const keyLight = new DirectionalLight(new Color(1.0, 0.95, 0.9), 1.2)
  keyLight.position.set(2.5, 2.0, 3.0)
  sceneRoot.add(keyLight)

  const fillLight = new DirectionalLight(new Color(0.5, 0.7, 1.0), 0.6)
  fillLight.position.set(-2.0, -1.5, 2.5)
  sceneRoot.add(fillLight)

  const cubeGeometry = new BoxGeometry(1.0, 1.0, 1.0)
  const cubeMaterial = new MeshPhongMaterial({
    color: new Color(0.25, 0.8, 1.0),
    shininess: 80,
    specular: new Color(0.9, 0.9, 1.0),
  })
  const cubeMesh = new ThreeMesh(cubeGeometry, cubeMaterial)
  cubeMesh.name = "cube"
  sceneRoot.add(cubeMesh)

  const cameraNode = new PerspectiveCamera(45, 1, 0.1, 100)
  cameraNode.position.set(0, 0, 3)
  cameraNode.name = "main_camera"

  const startX = Math.max(2, Math.floor((width - size.width) / 2))
  const startY = Math.max(HEADER_HEIGHT, Math.floor((height - size.height) / 2))

  draggableCube = new DraggableThreeRenderable(renderer, HEADER_HEIGHT, {
    id: "draggable-three",
    width: size.width,
    height: size.height,
    position: "absolute",
    left: startX,
    top: startY,
    zIndex: 50,
    scene: sceneRoot,
    camera: cameraNode,
    renderer: {
      focalLength: 8,
      alpha: true,
      backgroundColor: RGBA.fromValues(0, 0, 0, 0),
    },
  })
  renderer.root.add(draggableCube)

  const rotationSpeed = new Vector3(0.6, 0.4, 0.2)
  let rotationEnabled = true

  renderer.setFrameCallback(async (deltaMs) => {
    const deltaTime = deltaMs / 1000
    if (!rotationEnabled) return
    cubeMesh.rotation.x += rotationSpeed.x * deltaTime
    cubeMesh.rotation.y += rotationSpeed.y * deltaTime
    cubeMesh.rotation.z += rotationSpeed.z * deltaTime
  })

  resizeListener = (newWidth: number, newHeight: number) => {
    controlsText.y = newHeight - 2

    if (!draggableCube) return

    const nextSize = getRenderSize(newWidth, newHeight)
    draggableCube.width = nextSize.width
    draggableCube.height = nextSize.height
    draggableCube.setDragBoundsTop(HEADER_HEIGHT)

    const maxX = newWidth - draggableCube.width
    const maxY = newHeight - draggableCube.height
    draggableCube.x = Math.max(0, Math.min(draggableCube.x, maxX))
    draggableCube.y = Math.max(HEADER_HEIGHT, Math.min(draggableCube.y, maxY))
  }

  renderer.on("resize", resizeListener)

  keyListener = (key: KeyEvent) => {
    if (key.name === "p" && draggableCube) {
      draggableCube.renderer.saveToFile(`screenshot-${Date.now()}.png`)
    }

    if (key.name === "space") {
      rotationEnabled = !rotationEnabled
    }
  }

  renderer.keyInput.on("keypress", keyListener)
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

  if (draggableCube) {
    draggableCube.destroy()
    draggableCube = null
  }

  if (parentContainer) {
    const draggableThreeContainer = renderer.root.getRenderable("draggable-three-container")
    draggableThreeContainer?.destroyRecursively()
    parentContainer = null
  }
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
  })

  run(renderer)
  setupCommonDemoKeys(renderer)
}
