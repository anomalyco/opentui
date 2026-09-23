#!/usr/bin/env bun

import {
  CliRenderer,
  createCliRenderer,
  RGBA,
  BoxRenderable,
  TextRenderable,
  FrameBufferRenderable,
  type KeyEvent,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import { TextureUtils } from "@opentui/three"
import {
  Scene as ThreeScene,
  Mesh as ThreeMesh,
  PerspectiveCamera,
  PointLight as ThreePointLight,
  SphereGeometry,
  RepeatWrapping,
  DataTexture,
} from "three"
import { MeshPhongNodeMaterial } from "three/webgpu"
import { lights } from "three/tsl"
import { color, fog, rangeFogFactor, checker, uv, mix, texture, normalMap } from "three/tsl"
import { TeapotGeometry } from "three/addons/geometries/TeapotGeometry.js"

// @ts-ignore
import normalTexPath from "./assets/Water_2_M_Normal.jpg" with { type: "image/jpeg" }
// @ts-ignore
import alphaTexPath from "./assets/roughness_map.jpg" with { type: "image/jpeg" }
import { ThreeCliRenderer } from "@opentui/three"

interface PhongDemoState {
  camera: PerspectiveCamera
  sceneRoot: ThreeScene
  engine: ThreeCliRenderer
  light1: ThreePointLight
  light2: ThreePointLight
  light3: ThreePointLight
  light4: ThreePointLight
  normalMapTexture: DataTexture | null
  alphaTexture: DataTexture | null
  parentContainer: BoxRenderable
  titleText: TextRenderable
  statusText: TextRenderable
  controlsText: TextRenderable
  cleanup: () => void
}

let demoState: PhongDemoState | null = null

export async function run(renderer: CliRenderer): Promise<void> {
  renderer.start()
  if (demoState) {
    destroy(renderer)
  }

  const WIDTH = renderer.terminalWidth
  const HEIGHT = renderer.terminalHeight

  const parentContainer = new BoxRenderable(renderer, {
    id: "phong-container",
    zIndex: 15,
  })
  renderer.root.add(parentContainer)

  const framebufferRenderable = new FrameBufferRenderable(renderer, {
    id: "phong-main",
    width: WIDTH,
    height: HEIGHT,
    zIndex: 10,
  })
  renderer.root.add(framebufferRenderable)
  const { frameBuffer: framebuffer } = framebufferRenderable

  const engine = new ThreeCliRenderer(renderer, {
    width: WIDTH,
    height: HEIGHT,
    focalLength: 8,
    backgroundColor: RGBA.fromValues(0.0, 0.0, 0.0, 1.0),
  })
  await engine.init()

  const camera = new PerspectiveCamera(50, engine.aspectRatio, 0.01, 100)
  camera.position.z = 7

  const sceneRoot = new ThreeScene()
  sceneRoot.fogNode = fog(color(0xff00ff), rangeFogFactor(12, 30))

  const sphereGeometry = new SphereGeometry(0.1, 16, 8)

  const normalMapTexture = await TextureUtils.fromFile(normalTexPath)
  const alphaTexture = await TextureUtils.fromFile(alphaTexPath)

  if (normalMapTexture) {
    normalMapTexture.wrapS = RepeatWrapping
    normalMapTexture.wrapT = RepeatWrapping
  }
  if (alphaTexture) {
    alphaTexture.wrapS = RepeatWrapping
    alphaTexture.wrapT = RepeatWrapping
  }

  const addLight = (hexColor: number, power = 1700, distance = 100) => {
    const material = new MeshPhongNodeMaterial()
    material.colorNode = color(hexColor)
    material.lights = false

    const mesh = new ThreeMesh(sphereGeometry, material)

    const light = new ThreePointLight(hexColor, 1, distance)
    light.power = power
    light.decay = 2
    light.add(mesh)

    sceneRoot.add(light)
    return light
  }

  const light1 = addLight(0x0040ff)
  const light2 = addLight(0xffffff)
  const light3 = addLight(0x80ff80)
  const light4 = addLight(0xffaa00)

  const blueLightsNode = lights([light1])
  const whiteLightsNode = lights([light2])
  const allLightsNode = lights([light1, light2, light3, light4])

  const geometryTeapot = new TeapotGeometry(0.8, 18)

  const leftMaterial = new MeshPhongNodeMaterial({ color: 0x555555 })
  leftMaterial.lightsNode = blueLightsNode
  if (alphaTexture) {
    leftMaterial.specularNode = texture(alphaTexture)
  }
  const leftObject = new ThreeMesh(geometryTeapot, leftMaterial)
  leftObject.position.x = -3
  sceneRoot.add(leftObject)

  const centerMaterial = new MeshPhongNodeMaterial({ color: 0x555555 })
  if (normalMapTexture) {
    centerMaterial.normalNode = normalMap(texture(normalMapTexture))
  }
  centerMaterial.shininess = 80
  centerMaterial.lightsNode = allLightsNode
  const centerObject = new ThreeMesh(geometryTeapot, centerMaterial)
  sceneRoot.add(centerObject)

  const rightMaterial = new MeshPhongNodeMaterial({ color: 0x555555 })
  rightMaterial.lightsNode = whiteLightsNode
  rightMaterial.specularNode = mix(color(0x0000ff), color(0xff0000), checker(uv().mul(5)))
  rightMaterial.shininess = 90
  const rightObject = new ThreeMesh(geometryTeapot, rightMaterial)
  rightObject.position.x = 3
  sceneRoot.add(rightObject)

  leftObject.rotation.y = centerObject.rotation.y = rightObject.rotation.y = Math.PI * -0.5
  leftObject.position.y = centerObject.position.y = rightObject.position.y = -1

  engine.setActiveCamera(camera)
  sceneRoot.add(camera)

  const titleText = new TextRenderable(renderer, {
    id: "phong-title",
    content: "WebGPU Phong Lights Demo",
    position: "absolute",
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(titleText)

  const statusText = new TextRenderable(renderer, {
    id: "phong-status",
    content: "Ready.",
    position: "absolute",
    top: 1,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(statusText)

  const controlsText = new TextRenderable(renderer, {
    id: "phong-controls",
    content: "WASD: Move | QE: Rotate | ZX: Zoom | R: Reset | U: Super Sample",
    position: "absolute",
    top: HEIGHT - 2,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(controlsText)

  const resizeHandler = (width: number, height: number) => {
    framebuffer.resize(width, height)
    engine.setSize(width, height)
    camera.aspect = engine.aspectRatio
    camera.updateProjectionMatrix()
    controlsText.y = height - 2
  }

  const inputHandler = (key: KeyEvent) => {
    if (key.name === "w") camera.translateY(0.5)
    if (key.name === "s") camera.translateY(-0.5)
    if (key.name === "a") camera.translateX(-0.5)
    if (key.name === "d") camera.translateX(0.5)
    if (key.name === "q") camera.rotateY(0.1)
    if (key.name === "e") camera.rotateY(-0.1)
    if (key.name === "z") camera.translateZ(1)
    if (key.name === "x") camera.translateZ(-1)
    if (key.name === "r") {
      camera.position.set(0, 0, 7)
      camera.rotation.set(0, 0, 0)
      camera.quaternion.set(0, 0, 0, 1)
      camera.up.set(0, 1, 0)
      camera.lookAt(0, 0, 0)
    }
    if (key.name === "u") {
      engine.toggleSuperSampling()
    }
  }

  const animate = async (deltaTime: number) => {
    const time = performance.now() / 1000
    const lightTime = time * 0.5

    light1.position.x = Math.sin(lightTime * 0.7) * 3
    light1.position.y = Math.cos(lightTime * 0.5) * 4
    light1.position.z = Math.cos(lightTime * 0.3) * 3

    light2.position.x = Math.cos(lightTime * 0.3) * 3
    light2.position.y = Math.sin(lightTime * 0.5) * 4
    light2.position.z = Math.sin(lightTime * 0.7) * 3

    light3.position.x = Math.sin(lightTime * 0.7) * 3
    light3.position.y = Math.cos(lightTime * 0.3) * 4
    light3.position.z = Math.sin(lightTime * 0.5) * 3

    light4.position.x = Math.sin(lightTime * 0.3) * 3
    light4.position.y = Math.cos(lightTime * 0.7) * 4
    light4.position.z = Math.sin(lightTime * 0.5) * 3

    await engine.drawScene(sceneRoot, framebuffer, deltaTime)
  }

  renderer.on("resize", resizeHandler)
  renderer.keyInput.on("keypress", inputHandler)
  renderer.setFrameCallback(animate)

  const cleanup = () => {
    renderer.off("resize", resizeHandler)
    renderer.keyInput.off("keypress", inputHandler)
    renderer.removeFrameCallback(animate)
    engine.destroy()
  }

  demoState = {
    camera,
    sceneRoot,
    engine,
    light1,
    light2,
    light3,
    light4,
    normalMapTexture,
    alphaTexture,
    parentContainer,
    titleText,
    statusText,
    controlsText,
    cleanup,
  }
}

export function destroy(renderer: CliRenderer): void {
  if (demoState) {
    demoState.cleanup()
    for (const id of ["phong-main", "phong-container"]) {
      const child = renderer.root.getRenderable(id)
      child?.destroyRecursively()
    }
    demoState = null
  }
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
  })
  await run(renderer)
  setupCommonDemoKeys(renderer)
}
