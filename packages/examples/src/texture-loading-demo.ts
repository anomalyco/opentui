#!/usr/bin/env bun

import { CliRenderer, createCliRenderer, RGBA, BoxRenderable, TextRenderable, type KeyEvent } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import { TextureUtils } from "@opentui/three"
import {
  Scene as ThreeScene,
  Mesh as ThreeMesh,
  PerspectiveCamera,
  Color,
  PointLight as ThreePointLight,
  BoxGeometry,
  MeshBasicMaterial,
  Vector3,
} from "three"
import { MeshPhongNodeMaterial } from "three/webgpu"
import { lights } from "three/tsl"
import { ThreeRenderable, SuperSampleAlgorithm } from "@opentui/three"

// @ts-ignore
import cratePath from "./assets/crate.png" with { type: "image/png" }
// @ts-ignore
import crateEmissivePath from "./assets/crate_emissive.png" with { type: "image/png" }

let threeRenderable: ThreeRenderable | null = null
let keyListener: ((key: KeyEvent) => void) | null = null
let resizeListener: ((width: number, height: number) => void) | null = null
let parentContainer: BoxRenderable | null = null

export async function run(renderer: CliRenderer): Promise<void> {
  renderer.start()
  const WIDTH = renderer.terminalWidth
  const HEIGHT = renderer.terminalHeight

  parentContainer = new BoxRenderable(renderer, {
    id: "texture-loading-container",
    zIndex: 15,
  })
  renderer.root.add(parentContainer)

  const sceneRoot = new ThreeScene()

  const mainLightNode = new ThreePointLight(new Color(1.0, 1.0, 1.0), 1.0, 60)
  mainLightNode.power = 500
  mainLightNode.position.set(2, 1, 2)
  mainLightNode.name = "main_light"
  sceneRoot.add(mainLightNode)

  const lightNode = new ThreePointLight(new Color(1.0, 1.0, 1.0), 1.0, 60)
  lightNode.power = 500
  lightNode.position.set(-2, 1, 2)
  lightNode.name = "light"
  sceneRoot.add(lightNode)

  const allLightsNode = lights([mainLightNode, lightNode])

  const cubeGeometry = new BoxGeometry(1.0, 1.0, 1.0)
  const cubeMeshNode = new ThreeMesh(cubeGeometry)
  cubeMeshNode.name = "cube"

  cubeMeshNode.position.set(0, 0, 0)
  cubeMeshNode.rotation.set(0, 0, 0)
  cubeMeshNode.scale.set(1.0, 1.0, 1.0)

  sceneRoot.add(cubeMeshNode)

  const cameraNode = new PerspectiveCamera(45, 1, 1.0, 100.0)
  cameraNode.position.set(0, 0, 2)
  cameraNode.name = "main_camera"

  const rotationSpeed = new Vector3(0.4, 0.8, 0.2)
  let rotationEnabled = true

  renderer.setFrameCallback(async (deltaMs) => {
    const deltaTime = deltaMs / 1000

    if (rotationEnabled && cubeMeshNode) {
      cubeMeshNode.rotation.x += rotationSpeed.x * deltaTime
      cubeMeshNode.rotation.y += rotationSpeed.y * deltaTime
      cubeMeshNode.rotation.z += rotationSpeed.z * deltaTime
    }
  })

  threeRenderable = new ThreeRenderable(renderer, {
    id: "main",
    width: WIDTH,
    height: HEIGHT,
    zIndex: 10,
    scene: sceneRoot,
    camera: cameraNode,
    renderer: {
      focalLength: 8,
      backgroundColor: RGBA.fromValues(0.0, 0.0, 0.0, 1.0),
    },
  })
  renderer.root.add(threeRenderable)

  const titleText = new TextRenderable(renderer, {
    id: "demo-title",
    content: "Texture Loading Demo",
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(titleText)

  const statusText = new TextRenderable(renderer, {
    id: "status",
    content: "Loading texture...",
    position: "absolute",
    left: 0,
    top: 1,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(statusText)

  const controlsText = new TextRenderable(renderer, {
    id: "controls",
    content: "WASD: Move | QE: Rotate | ZX: Zoom | R: Reset | Space: Toggle rotation | Escape: Return",
    position: "absolute",
    left: 0,
    top: HEIGHT - 2,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(controlsText)

  resizeListener = (width: number, height: number) => {
    if (threeRenderable) {
      threeRenderable.width = width
      threeRenderable.height = height
    }

    controlsText.y = height - 2
  }

  renderer.on("resize", resizeListener)

  keyListener = (key: KeyEvent) => {
    const engine = threeRenderable?.renderer

    if (key.name === "p" && engine) {
      engine.saveToFile(`screenshot-${Date.now()}.png`)
    }

    // Handle camera movement
    if (key.name === "w") {
      cameraNode.translateY(0.5)
    } else if (key.name === "s") {
      cameraNode.translateY(-0.5)
    } else if (key.name === "a") {
      cameraNode.translateX(-0.5)
    } else if (key.name === "d") {
      cameraNode.translateX(0.5)
    }

    // Handle camera rotation
    if (key.name === "q") {
      cameraNode.rotateY(0.1)
    } else if (key.name === "e") {
      cameraNode.rotateY(-0.1)
    }

    // Handle zoom by changing camera position
    if (key.name === "z") {
      cameraNode.translateZ(0.1)
    } else if (key.name === "x") {
      cameraNode.translateZ(-0.1)
    }

    // Reset camera position and rotation
    if (key.name === "r") {
      cameraNode.position.set(0, 0, 2)
      cameraNode.rotation.set(0, 0, 0)
      cameraNode.quaternion.set(0, 0, 0, 1)
      cameraNode.up.set(0, 1, 0)
      cameraNode.lookAt(0, 0, 0)
    }

    // Toggle super sampling
    if (key.name === "u" && engine) {
      engine.toggleSuperSampling()
    }

    if (key.name === "i" && engine) {
      const currentAlgorithm = engine.getSuperSampleAlgorithm()
      const newAlgorithm =
        currentAlgorithm === SuperSampleAlgorithm.STANDARD
          ? SuperSampleAlgorithm.PRE_SQUEEZED
          : SuperSampleAlgorithm.STANDARD
      engine.setSuperSampleAlgorithm(newAlgorithm)
    }

    // Toggle cube rotation
    if (key.name === "space") {
      rotationEnabled = !rotationEnabled
    }
  }

  renderer.keyInput.on("keypress", keyListener)

  const imagePath = cratePath
  const textureMap = await TextureUtils.fromFile(imagePath)
  const textureEmissive = await TextureUtils.fromFile(crateEmissivePath)

  let material
  if (textureMap) {
    material = new MeshPhongNodeMaterial({
      map: textureMap,
      emissiveMap: textureEmissive ? textureEmissive : undefined,
      emissive: new Color(0.0, 0.0, 0.0),
      emissiveIntensity: 0.2,
    })
    material.lightsNode = allLightsNode
    statusText.content = "Using PhongNodeMaterial with texture."
  } else {
    material = new MeshBasicMaterial({ color: 0x00ff00 })
    statusText.content = "Texture failed. Using green BasicMaterial."
  }

  cubeMeshNode.material = material

  statusText.content = "Using PhongNodeMaterial setup"
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

  if (threeRenderable) {
    threeRenderable.destroy()
    threeRenderable = null
  }

  if (parentContainer) {
    const textureLoadingContainer = renderer.root.getRenderable("texture-loading-container")
    textureLoadingContainer?.destroyRecursively()
    parentContainer = null
  }
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
    memorySnapshotInterval: 2000,
  })

  await run(renderer)
  setupCommonDemoKeys(renderer)
}
