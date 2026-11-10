#!/usr/bin/env bun

import {
  BoxRenderable,
  CliRenderer,
  createCliRenderer,
  FrameBufferRenderable,
  RGBA,
  TextRenderable,
  type KeyEvent,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import { Scene as ThreeScene, Mesh as ThreeMesh, PerspectiveCamera, PlaneGeometry, Vector2 } from "three"
import { MeshBasicNodeMaterial } from "three/webgpu"
import {
  uniform,
  vec2,
  vec3,
  vec4,
  float,
  screenCoordinate,
  sin,
  cos,
  atan,
  length,
  normalize,
  ceil,
  Loop,
  Fn,
  int,
} from "three/tsl"
import { ThreeCliRenderer } from "@opentui/three"

let engine: ThreeCliRenderer | null = null
let sceneRoot: ThreeScene | null = null
let timeUniform: any = null
let resolutionUniform: any = null
let cellAspectRatio: any = null
let cameraNode: PerspectiveCamera | null = null
let time = 0
let timeSpeed = 1.0
let paused = false
let keyHandler: ((key: KeyEvent) => void) | null = null
let handleResize: ((width: number, height: number) => void) | null = null
let parentContainer: BoxRenderable | null = null

export async function run(renderer: CliRenderer): Promise<void> {
  renderer.start()
  const WIDTH = renderer.terminalWidth
  const HEIGHT = renderer.terminalHeight

  parentContainer = new BoxRenderable(renderer, {
    id: "fractal-container",
    zIndex: 10,
  })
  renderer.root.add(parentContainer)

  const framebuffer = new FrameBufferRenderable(renderer, {
    id: "fractal-framebuffer",
    width: WIDTH,
    height: HEIGHT,
    zIndex: 0,
  })
  renderer.root.add(framebuffer)

  engine = new ThreeCliRenderer(renderer, {
    width: WIDTH,
    height: HEIGHT,
    focalLength: 8,
    backgroundColor: RGBA.fromValues(0.0, 0.0, 0.0, 1.0),
  })
  await engine.init()

  sceneRoot = new ThreeScene()

  timeUniform = uniform(0.0)
  resolutionUniform = uniform(new Vector2(WIDTH * 2, HEIGHT * 2))
  cellAspectRatio = uniform(2.0)

  const fractalMaterial = new MeshBasicNodeMaterial()

  const fractalColor = Fn(() => {
    const FC = screenCoordinate
    const r = resolutionUniform
    const t = timeUniform

    const z = float(0.0).toVar()
    const d = float(0.0).toVar()
    const i = float(0.0).toVar()
    const o = vec4(0.0).toVar()

    Loop({ start: int(1), end: int(90), type: "int", condition: "<" }, ({ i: loopI }) => {
      i.assign(float(loopI))

      const correctedFC = vec2(FC.x, FC.y.mul(cellAspectRatio))
      const FCrgb = vec3(correctedFC.x, correctedFC.y, float(0.0))
      const rxyx = vec3(r.x, r.y.mul(cellAspectRatio), r.x)
      const p = z.mul(normalize(FCrgb.mul(2.0).sub(rxyx))).toVar()

      p.assign(vec3(atan(p.y, p.x), p.z.div(3.0).sub(t), length(p.xy).sub(9.0)))

      Loop({ start: int(1), end: int(5), type: "int", condition: "<" }, ({ i: innerI }) => {
        const dValue = float(innerI)
        d.assign(dValue)

        const iVec = i.mul(vec3(0.2, 0.0, 0.0))
        const pyzx = vec3(p.y, p.z, p.x)
        const arg = pyzx.mul(dValue).sub(iVec)
        const distortion = sin(ceil(arg)).div(dValue)
        p.addAssign(distortion)
      })

      const cos6p = cos(p.mul(6.0))
      const cosTerm = cos6p.mul(0.2).sub(0.2)
      const distanceVec = vec4(cosTerm.x, cosTerm.y, cosTerm.z, p.z)
      const dNew = length(distanceVec).mul(0.2)
      d.assign(dNew)
      z.addAssign(dNew)

      const colorPhase = vec4(0.0, 0.5, 1.0, 0.0)
      const cosResult = cos(p.x.add(colorPhase))
      const colorContrib = cosResult.add(1.0).div(d).div(z)
      o.addAssign(colorContrib)
    })

    const oSquared = o.mul(o)
    const processed = oSquared.div(800.0)

    const x = processed
    const x2 = x.mul(x)
    const tanhApprox = x.mul(x2.add(27.0)).div(x2.mul(9.0).add(27.0))

    return vec4(tanhApprox.rgb, 1.0)
  })()

  fractalMaterial.colorNode = fractalColor

  const planeGeometry = new PlaneGeometry(10, 10)
  const planeMesh = new ThreeMesh(planeGeometry, fractalMaterial)
  planeMesh.name = "fractal_plane"
  sceneRoot.add(planeMesh)

  cameraNode = new PerspectiveCamera(45, engine.aspectRatio, 0.1, 100.0)
  cameraNode.position.set(0, 0, 5)
  cameraNode.name = "main_camera"

  engine.setActiveCamera(cameraNode)

  const titleText = new TextRenderable(renderer, {
    id: "fractal_title",
    content: "Shader by @XorDev",
    fg: "#FFFFFF",
    zIndex: 25,
  })
  parentContainer.add(titleText)

  const controlsText = new TextRenderable(renderer, {
    id: "fractal_controls",
    content: "Space: Pause/Resume | R: Reset | P: Screenshot | +/-: Speed | Escape: Back to menu",
    position: "absolute",
    top: HEIGHT - 2,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(controlsText)

  const statusText = new TextRenderable(renderer, {
    id: "fractal_status",
    content: "Speed: 1.0x",
    position: "absolute",
    top: 1,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(statusText)

  handleResize = (width: number, height: number) => {
    framebuffer.frameBuffer.resize(width, height)
    framebuffer.width = width
    framebuffer.height = height
    if (cameraNode && engine) {
      cameraNode.aspect = engine.aspectRatio
      cameraNode.updateProjectionMatrix()
    }

    if (resolutionUniform) {
      resolutionUniform.value.set(width * 2, height * 2)
    }

    controlsText.y = height - 2
  }

  renderer.on("resize", handleResize)

  time = 0
  timeSpeed = 1.0
  paused = false

  keyHandler = (key: KeyEvent) => {
    if (key.name === "p" && engine) {
      engine.saveToFile(`fractal-${Date.now()}.png`)
    }

    if (key.name === "r" && cameraNode) {
      timeSpeed = 1.0
      paused = false
      cameraNode.position.set(0, 0, 5)
      cameraNode.rotation.set(0, 0, 0)
      cameraNode.lookAt(0, 0, 0)
      statusText.content = `Speed: ${timeSpeed.toFixed(1)}x`
    }

    if (key.name === "space") {
      paused = !paused
      statusText.content = `Speed: ${timeSpeed.toFixed(1)}x`
    }

    if (key.name === "+" || key.name === "=") {
      timeSpeed = Math.min(timeSpeed + 0.1, 3.0)
      statusText.content = `Speed: ${timeSpeed.toFixed(1)}x`
    }

    if (key.name === "-" || key.name === "_") {
      timeSpeed = Math.max(timeSpeed - 0.1, 0.1)
      statusText.content = `Speed: ${timeSpeed.toFixed(1)}x`
    }
  }

  renderer.keyInput.on("keypress", keyHandler)

  renderer.setFrameCallback(async (deltaMs) => {
    const deltaTime = deltaMs / 1000

    if (!paused) {
      time += deltaTime * timeSpeed
    }

    if (timeUniform) {
      timeUniform.value = time
    }

    statusText.content = `Speed: ${timeSpeed.toFixed(1)}x`

    if (engine && sceneRoot) {
      await engine.drawScene(sceneRoot, framebuffer.frameBuffer, deltaTime)
    }
  })
}

export function destroy(renderer: CliRenderer): void {
  if (keyHandler) {
    renderer.keyInput.off("keypress", keyHandler)
    keyHandler = null
  }

  if (handleResize) {
    renderer.off("resize", handleResize)
    handleResize = null
  }

  renderer.clearFrameCallbacks()
  renderer.root.getRenderable("fractal-framebuffer")?.destroyRecursively()

  if (parentContainer) {
    const fractalContainer = renderer.root.getRenderable("fractal-container")
    fractalContainer?.destroyRecursively()
    parentContainer = null
  }

  engine?.destroy()
  engine = null
  sceneRoot = null
  timeUniform = null
  resolutionUniform = null
  cellAspectRatio = null
  cameraNode = null
  time = 0
  timeSpeed = 1.0
  paused = false
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
  })
  await run(renderer)
  setupCommonDemoKeys(renderer)
}
