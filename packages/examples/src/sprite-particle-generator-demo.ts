#!/usr/bin/env bun

import {
  CliRenderer,
  createCliRenderer,
  OptimizedBuffer,
  RGBA,
  BoxRenderable,
  TextRenderable,
  FrameBufferRenderable,
  type KeyEvent,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import * as THREE from "three"
import { SpriteAnimator, type TiledSprite, type SpriteDefinition, type AnimationDefinition } from "@opentui/three"
import { SpriteResourceManager, type ResourceConfig } from "@opentui/three"
import { SpriteParticleGenerator, type ParticleEffectParameters } from "@opentui/three"
import { ThreeCliRenderer } from "@opentui/three"

// @ts-ignore
import heartPath from "./assets/heart.png" with { type: "image/png" }
// @ts-ignore
import simpleSquarePath from "./assets/forrest_background.png" with { type: "image/png" }
// @ts-ignore
import mainCharRunPath from "./assets/main_char_run_loop.png" with { type: "image/png" }

let engine: ThreeCliRenderer | null = null
let scene: THREE.Scene | null = null
let framebuffer: OptimizedBuffer | null = null
let framebufferRenderableRef: FrameBufferRenderable | null = null
let spriteAnimator: SpriteAnimator | null = null
let resourceManager: SpriteResourceManager | null = null
let generators: Record<string, SpriteParticleGenerator> = {}
let currentGenerator: SpriteParticleGenerator | null = null
let currentGeneratorKey = "3d-static"
let backgroundSprite: TiledSprite | null = null
let configs: Record<string, { name: string; params: ParticleEffectParameters }> = {}
let inputListener: ((key: KeyEvent) => void) | null = null
let resizeListener: ((width: number, height: number) => void) | null = null
let frameCallback: ((deltaTime: number) => Promise<void>) | null = null
let parentContainer: BoxRenderable | null = null
let instructionsText: TextRenderable | null = null
let particleCountText: TextRenderable | null = null
let configInfoText: TextRenderable | null = null

export async function run(renderer: CliRenderer): Promise<void> {
  renderer.start()
  const initialTermWidth = renderer.terminalWidth
  const initialTermHeight = renderer.terminalHeight

  parentContainer = new BoxRenderable(renderer, {
    id: "particle-container",
    zIndex: 15,
  })
  renderer.root.add(parentContainer)
  const framebufferRenderable = new FrameBufferRenderable(renderer, {
    id: "particle-main",
    width: initialTermWidth,
    height: initialTermHeight,
    zIndex: 10,
  })
  renderer.root.add(framebufferRenderable)
  framebufferRenderableRef = framebufferRenderable
  framebuffer = framebufferRenderable.frameBuffer

  engine = new ThreeCliRenderer(renderer, {
    width: initialTermWidth,
    height: initialTermHeight,
    focalLength: 1,
    backgroundColor: RGBA.fromValues(0.1, 0.1, 0.2, 1.0),
  })
  await engine.init()

  scene = new THREE.Scene()

  const pCamera = new THREE.PerspectiveCamera(75, engine.aspectRatio, 0.1, 1000)
  pCamera.position.set(0, 0, 3)
  pCamera.lookAt(0, 0, 0)
  scene.add(pCamera)
  engine.setActiveCamera(pCamera)

  instructionsText = new TextRenderable(renderer, {
    id: "particle-instructions",
    content:
      "'g'(burst), 'a'(auto), 's'(stop), 'x'(clear), '1'(3D Static), '2'(2D Static), '3'(3D Animated), '4'(Custom), '5'(2D Animated)",
    position: "absolute",
    left: 1,
    top: 1,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(instructionsText)

  particleCountText = new TextRenderable(renderer, {
    id: "particle-count",
    content: "Particles: 0",
    position: "absolute",
    left: 1,
    top: 2,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(particleCountText)

  configInfoText = new TextRenderable(renderer, {
    id: "particle-config-info",
    content: "Mode: 3D Static | Auto-spawning",
    position: "absolute",
    left: 1,
    top: 3,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(configInfoText)

  resourceManager = new SpriteResourceManager(scene)
  spriteAnimator = new SpriteAnimator(scene)

  const staticParticleResourceConfig: ResourceConfig = {
    imagePath: heartPath,
    sheetNumFrames: 1,
  }

  const animatedParticleResourceConfig: ResourceConfig = {
    imagePath: mainCharRunPath,
    sheetNumFrames: 10,
  }

  const staticParticleResource = await resourceManager.createResource(staticParticleResourceConfig)
  const animatedParticleResource = await resourceManager.createResource(animatedParticleResourceConfig)

  const backgroundResourceConfig: ResourceConfig = {
    imagePath: simpleSquarePath,
    sheetNumFrames: 1,
  }
  const backgroundResource = await resourceManager.createResource(backgroundResourceConfig)
  const backgroundAnimDef: AnimationDefinition = {
    resource: backgroundResource,
    animNumFrames: 1,
    animFrameOffset: 0,
    frameDuration: 1000,
    loop: false,
  }
  const backgroundSpriteDef: SpriteDefinition = {
    initialAnimation: "idle",
    animations: {
      idle: backgroundAnimDef,
    },
    scale: 5.0,
    renderOrder: 0,
  }

  backgroundSprite = await spriteAnimator.createSprite(backgroundSpriteDef)
  if (backgroundSprite) {
    backgroundSprite.setPosition(new THREE.Vector3(0, 0, 0))
  }

  const AUTO_SPAWN_RATE = 30

  configs = {
    "3d-static": {
      name: "3D Static",
      params: {
        resource: staticParticleResource,
        scale: 0.7,
        renderOrder: 1,
        maxParticles: 3000,
        lifetimeMsMin: 2000,
        lifetimeMsMax: 5000,
        origins: [
          new THREE.Vector3(-1, 0, 0),
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, -1, 0),
        ],
        spawnRadius: new THREE.Vector3(0.1, 0.1, 0),
        initialVelocityMin: new THREE.Vector3(-0.5, 2, 0),
        initialVelocityMax: new THREE.Vector3(0.5, 3.5, 0),
        angularVelocityMin: new THREE.Vector3(-Math.PI, -Math.PI, -Math.PI),
        angularVelocityMax: new THREE.Vector3(Math.PI, Math.PI, Math.PI),
        gravity: new THREE.Vector3(0, -2.0, 0),
        randomGravityFactorMinMax: new THREE.Vector2(0.8, 1.2),
        scaleOverLifeMinMax: new THREE.Vector2(1.0, 0.1),
        fadeOut: true,
      } as ParticleEffectParameters,
    },
    "2d-static": {
      name: "2D Static",
      params: {
        resource: staticParticleResource,
        scale: 0.7,
        renderOrder: 1,
        maxParticles: 3000,
        lifetimeMsMin: 2000,
        lifetimeMsMax: 5000,
        origins: [new THREE.Vector3(0, 0, 0)],
        spawnRadius: new THREE.Vector3(0.1, 0.1, 0),
        initialVelocityMin: new THREE.Vector3(-0.5, 2, 0),
        initialVelocityMax: new THREE.Vector3(0.5, 3.5, 0),
        angularVelocityMin: new THREE.Vector3(0, 0, -Math.PI),
        angularVelocityMax: new THREE.Vector3(0, 0, Math.PI),
        gravity: new THREE.Vector3(0, -2.0, 0),
        randomGravityFactorMinMax: new THREE.Vector2(0.8, 1.2),
        scaleOverLifeMinMax: new THREE.Vector2(1.0, 0.1),
        fadeOut: true,
      } as ParticleEffectParameters,
    },
    "3d-animated": {
      name: "3D Animated",
      params: {
        resource: animatedParticleResource,
        frameDuration: 80,
        scale: 1.5,
        renderOrder: 1,
        maxParticles: 3000,
        lifetimeMsMin: 2000,
        lifetimeMsMax: 5000,
        origins: [
          new THREE.Vector3(-1, 0, 0),
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, -1, 0),
        ],
        spawnRadius: new THREE.Vector3(0.1, 0.1, 0),
        initialVelocityMin: new THREE.Vector3(-0.5, 2, 0),
        initialVelocityMax: new THREE.Vector3(0.5, 3.5, 0),
        angularVelocityMin: new THREE.Vector3(-Math.PI, -Math.PI, -Math.PI),
        angularVelocityMax: new THREE.Vector3(Math.PI, Math.PI, Math.PI),
        gravity: new THREE.Vector3(0, -2.0, 0),
        randomGravityFactorMinMax: new THREE.Vector2(0.8, 1.2),
        scaleOverLifeMinMax: new THREE.Vector2(1.0, 0.1),
        fadeOut: true,
      } as ParticleEffectParameters,
    },
    custom: {
      name: "Custom Gravity",
      params: {
        resource: staticParticleResource,
        scale: 0.7,
        renderOrder: 1,
        maxParticles: 3000,
        lifetimeMsMin: 2000,
        lifetimeMsMax: 5000,
        origins: [
          new THREE.Vector3(-1, 0, 0),
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, -1, 0),
        ],
        spawnRadius: new THREE.Vector3(0.1, 0.1, 0),
        initialVelocityMin: new THREE.Vector3(-0.5, 2, 0),
        initialVelocityMax: new THREE.Vector3(0.5, 3.5, 0),
        angularVelocityMin: new THREE.Vector3(-Math.PI, -Math.PI, -Math.PI),
        angularVelocityMax: new THREE.Vector3(Math.PI, Math.PI, Math.PI),
        gravity: new THREE.Vector3(0, THREE.MathUtils.randFloat(-9.8, 9.8), THREE.MathUtils.randFloat(-2.0, 2.0)),
        randomGravityFactorMinMax: new THREE.Vector2(0.8, 1.2),
        scaleOverLifeMinMax: new THREE.Vector2(1.0, 0.1),
        fadeOut: true,
      } as ParticleEffectParameters,
    },
    "2d-animated": {
      name: "2D Animated",
      params: {
        resource: animatedParticleResource,
        frameDuration: 80,
        scale: 1.5,
        renderOrder: 1,
        maxParticles: 3000,
        lifetimeMsMin: 2000,
        lifetimeMsMax: 5000,
        origins: [new THREE.Vector3(0, 0, 0.1)],
        spawnRadius: new THREE.Vector3(0.1, 0.1, 0),
        initialVelocityMin: new THREE.Vector3(-0.5, 2, 0),
        initialVelocityMax: new THREE.Vector3(0.5, 3.5, 0),
        angularVelocityMin: new THREE.Vector3(0, 0, -Math.PI),
        angularVelocityMax: new THREE.Vector3(0, 0, Math.PI),
        gravity: new THREE.Vector3(0, -2.0, 0),
        randomGravityFactorMinMax: new THREE.Vector2(0.8, 1.2),
        scaleOverLifeMinMax: new THREE.Vector2(1.0, 0.1),
        fadeOut: true,
      } as ParticleEffectParameters,
    },
  }

  generators = {}
  for (const [key, config] of Object.entries(configs)) {
    generators[key] = new SpriteParticleGenerator(scene, config.params)
  }

  currentGeneratorKey = "3d-static"
  currentGenerator = generators[currentGeneratorKey]
  currentGenerator.setAutoSpawn(AUTO_SPAWN_RATE)

  resizeListener = (newWidth: number, newHeight: number) => {
    if (framebuffer) {
      framebuffer.resize(newWidth, newHeight)
    }
    if (engine) {
      const camera = engine.getActiveCamera()
      if (camera && "aspect" in camera) {
        ;(camera as THREE.PerspectiveCamera).aspect = newWidth / newHeight
        ;(camera as THREE.PerspectiveCamera).updateProjectionMatrix()
      }
    }
  }
  renderer.on("resize", resizeListener)

  frameCallback = async (deltaTime: number) => {
    if (spriteAnimator) {
      spriteAnimator.update(deltaTime)
    }

    for (const generator of Object.values(generators)) {
      await generator.update(deltaTime)
    }

    if (currentGenerator && particleCountText) {
      particleCountText.content = `Particles: ${currentGenerator.getActiveParticleCount()}`
    }

    if (engine && scene && framebuffer) {
      await engine.drawScene(scene, framebuffer, deltaTime)
    }
  }
  renderer.setFrameCallback(frameCallback)

  function switchToGenerator(key: string) {
    if (!generators[key] || !currentGenerator) return

    const wasAutoSpawning = currentGenerator.hasAutoSpawn()

    currentGenerator.stopAutoSpawn()
    currentGeneratorKey = key
    currentGenerator = generators[key]

    if (wasAutoSpawning) {
      currentGenerator.setAutoSpawn(AUTO_SPAWN_RATE)
    }

    const configName = configs[key as keyof typeof configs].name
    const isAutoSpawning = currentGenerator.hasAutoSpawn()
    const status = isAutoSpawning ? "Auto-spawning" : "Idle"

    if (configInfoText) {
      configInfoText.content = `Mode: ${configName} | ${status}`
    }

    console.log(`Switched to ${configName} generator${wasAutoSpawning ? " (auto-spawn continued)" : ""}`)
  }

  inputListener = (key: KeyEvent) => {
    if (key.name === "g" && currentGenerator) {
      console.log("Generating 100 particles (burst)...")
      currentGenerator.spawnParticles(100).then(() => {
        console.log("Particle burst spawn call completed.")
      })
    }

    if (key.name === "a" && currentGenerator) {
      console.log("Starting auto-spawn (30 particles/sec)...")
      currentGenerator.setAutoSpawn(AUTO_SPAWN_RATE)
      const configName = configs[currentGeneratorKey as keyof typeof configs].name
      if (configInfoText) {
        configInfoText.content = `Mode: ${configName} | Auto-spawning`
      }
    }

    if (key.name === "s" && currentGenerator) {
      console.log("Stopping auto-spawn...")
      currentGenerator.stopAutoSpawn()
      const configName = configs[currentGeneratorKey as keyof typeof configs].name
      if (configInfoText) {
        configInfoText.content = `Mode: ${configName} | Idle`
      }
    }

    if (key.name === "x" && currentGenerator) {
      console.log("Clearing all particles...")
      currentGenerator.dispose()
    }

    if (key.name === "1") {
      switchToGenerator("3d-static")
    }

    if (key.name === "2") {
      switchToGenerator("2d-static")
    }

    if (key.name === "3") {
      switchToGenerator("3d-animated")
    }

    if (key.name === "4") {
      configs.custom.params.gravity = new THREE.Vector3(
        0,
        THREE.MathUtils.randFloat(-9.8, 9.8),
        THREE.MathUtils.randFloat(-2.0, 2.0),
      )
      console.log(
        `Custom gravity: Y=${configs.custom.params.gravity.y.toFixed(1)}, Z=${configs.custom.params.gravity.z.toFixed(1)}`,
      )
      switchToGenerator("custom")
    }

    if (key.name === "5") {
      switchToGenerator("2d-animated")
    }
  }

  renderer.keyInput.on("keypress", inputListener)
}

export function destroy(renderer: CliRenderer): void {
  if (inputListener) {
    renderer.keyInput.off("keypress", inputListener)
    inputListener = null
  }

  if (resizeListener) {
    renderer.off("resize", resizeListener)
    resizeListener = null
  }

  renderer.clearFrameCallbacks()
  frameCallback = null

  for (const generator of Object.values(generators)) {
    generator.dispose()
  }
  generators = {}

  if (backgroundSprite) {
    backgroundSprite = null
  }

  if (spriteAnimator) {
    spriteAnimator = null
  }

  if (resourceManager) {
    resourceManager = null
  }

  if (framebufferRenderableRef) {
    framebufferRenderableRef.destroyRecursively()
    framebufferRenderableRef = null
  }
  framebuffer = null

  if (parentContainer) {
    const particleContainer = renderer.root.getRenderable("particle-container")
    particleContainer?.destroyRecursively()
    parentContainer = null
  }

  instructionsText = null
  particleCountText = null
  configInfoText = null

  if (engine) {
    engine.destroy()
    engine = null
  }

  if (scene) {
    scene = null
  }

  currentGenerator = null
  currentGeneratorKey = "3d-static"
  configs = {}
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
  })
  await run(renderer)
  setupCommonDemoKeys(renderer)
}
