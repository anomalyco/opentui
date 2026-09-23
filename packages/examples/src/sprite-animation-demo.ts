#!/usr/bin/env bun

import {
  CliRenderer,
  createCliRenderer,
  RGBA,
  TextRenderable,
  FrameBufferRenderable,
  BoxRenderable,
  type KeyEvent,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import * as THREE from "three"
import { SpriteAnimator, TiledSprite, type SpriteDefinition, type AnimationDefinition } from "@opentui/three"
import { SpriteResourceManager, type ResourceConfig } from "@opentui/three"
import { ExplosionManager, type ExplosionHandle, type ExplosionEffectParameters } from "@opentui/three"

// @ts-ignore
import mainCharIdlePath from "./assets/main_char_idle.png" with { type: "image/png" }
import { randFloat } from "three/src/math/MathUtils.js"
import { MeshLambertNodeMaterial } from "three/webgpu"
import { ThreeCliRenderer } from "@opentui/three"

interface SpriteAnimationDemoState {
  engine: ThreeCliRenderer
  scene: THREE.Scene
  pCamera: THREE.PerspectiveCamera
  oCamera: THREE.OrthographicCamera
  spriteResourceManager: SpriteResourceManager
  spriteAnimator: SpriteAnimator
  explosionManager: ExplosionManager
  mainChar: TiledSprite | null
  mainCharExplosionHandle: ExplosionHandle | null
  addedSprites: TiledSprite[]
  activeExplosionHandles: ExplosionHandle[]
  isPerspectiveActive: boolean
  parentContainer: BoxRenderable
  instructionsText: TextRenderable
  cameraModeText: TextRenderable
  keyHandler: ((key: KeyEvent) => void) | null
}

let demoState: SpriteAnimationDemoState | null = null

export async function run(renderer: CliRenderer): Promise<void> {
  renderer.start()
  const initialTermWidth = renderer.terminalWidth
  const initialTermHeight = renderer.terminalHeight

  const parentContainer = new BoxRenderable(renderer, {
    id: "sprite-animation-container",
    zIndex: 15,
  })
  renderer.root.add(parentContainer)

  const framebufferRenderable = new FrameBufferRenderable(renderer, {
    id: "main",
    width: initialTermWidth,
    height: initialTermHeight,
    zIndex: 10,
  })
  renderer.root.add(framebufferRenderable)
  const { frameBuffer: framebuffer } = framebufferRenderable

  const engine = new ThreeCliRenderer(renderer, {
    width: initialTermWidth,
    height: initialTermHeight,
    focalLength: 1,
    backgroundColor: RGBA.fromValues(0.1, 0.1, 0.2, 1.0),
  })
  await engine.init()

  const scene = new THREE.Scene()

  const pCamera = new THREE.PerspectiveCamera(75, engine.aspectRatio, 0.1, 1000)
  pCamera.position.set(0, 0, 3)
  pCamera.lookAt(0, 0, 0)
  scene.add(pCamera)

  const orthoViewHeight = 4.0
  const orthoViewWidth = orthoViewHeight * engine.aspectRatio
  const oCamera = new THREE.OrthographicCamera(
    orthoViewWidth / -2,
    orthoViewWidth / 2,
    orthoViewHeight / 2,
    orthoViewHeight / -2,
    0.1,
    1000,
  )
  oCamera.position.set(0, 0, 3)
  oCamera.lookAt(0, 0, 0)
  scene.add(oCamera)

  const ambientLight = new THREE.AmbientLight(0xffffff, 1.2)
  scene.add(ambientLight)

  const spotlight1 = new THREE.SpotLight(0xff9999, 6.5)
  spotlight1.position.set(-5, 0, 6)
  spotlight1.target.position.set(-2, -2.5, 0)
  spotlight1.penumbra = 0.3
  spotlight1.angle = Math.PI / 1.7
  spotlight1.distance = 25.0
  spotlight1.power = 1000
  scene.add(spotlight1.target)
  scene.add(spotlight1)

  const spotlight2 = spotlight1.clone()
  spotlight2.color.set(0x6666ff)
  spotlight2.position.set(5, 0, 6)
  spotlight2.target.position.set(2, -2.5, 0)
  scene.add(spotlight2.target)
  scene.add(spotlight2)

  let isPerspectiveActive = true
  engine.setActiveCamera(pCamera)

  const cameraModeText = new TextRenderable(renderer, {
    id: "cameraModeText",
    content: `Camera: Perspective (Press 'c' to switch)`,
    position: "absolute",
    left: 1,
    top: 3,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(cameraModeText)

  const spriteResourceManager = new SpriteResourceManager(scene)
  const spriteAnimator = new SpriteAnimator(scene)
  const explosionManager = new ExplosionManager(scene)

  const resizeHandler = (newWidth: number, newHeight: number) => {
    framebuffer.resize(newWidth, newHeight)

    pCamera.aspect = engine.aspectRatio
    pCamera.updateProjectionMatrix()

    const newOrthoViewWidth = orthoViewHeight * engine.aspectRatio
    oCamera.left = newOrthoViewWidth / -2
    oCamera.right = newOrthoViewWidth / 2
    oCamera.top = orthoViewHeight / 2
    oCamera.bottom = orthoViewHeight / -2
    oCamera.updateProjectionMatrix()
  }
  renderer.on("resize", resizeHandler)
  framebufferRenderable.once("destroyed", () => renderer.off("resize", resizeHandler))

  const NUM_SPRITES = 8

  const mainCharResourceConfig: ResourceConfig = {
    imagePath: mainCharIdlePath,
    sheetNumFrames: NUM_SPRITES,
  }

  const mainCharResource = await spriteResourceManager.createResource(mainCharResourceConfig)

  explosionManager.fillPool(mainCharResource, 5, { numRows: 50, numCols: 50 })
  explosionManager.fillPool(mainCharResource, 128, { numRows: 4, numCols: 4 })

  const mainCharIdleAnimation: AnimationDefinition = {
    resource: mainCharResource,
    frameDuration: 150,
  }

  const mainCharDef: SpriteDefinition = {
    initialAnimation: "idle",
    animations: {
      idle: mainCharIdleAnimation,
    },
    scale: 8.0,
  }

  let mainChar: TiledSprite | null = null
  let mainCharExplosionHandle: ExplosionHandle | null = null
  let addedSprites: TiledSprite[] = []
  const activeExplosionHandles: ExplosionHandle[] = []

  const materialFactory = () =>
    new MeshLambertNodeMaterial({
      transparent: true,
      alphaTest: 0.01,
      side: THREE.DoubleSide,
      depthWrite: true,
    })

  mainChar = await spriteAnimator.createSprite(mainCharDef, materialFactory)
  if (mainChar) {
    mainChar.setPosition(new THREE.Vector3(0, 0, 0.1))
  }

  if (mainChar) {
    // Small and fast
    const smallChar = await spriteAnimator.createSprite(
      {
        ...mainCharDef,
        id: "small_char",
        scale: 4.0,
      },
      materialFactory,
    )
    if (smallChar) {
      smallChar.setPosition(new THREE.Vector3(-1.5, 0, 0))
      smallChar.setFrameDuration(80)
      smallChar.goToFrame(3)
    }

    // Large and slow
    const largeChar = await spriteAnimator.createSprite(
      {
        ...mainCharDef,
        id: "large_char",
        scale: 6.0,
      },
      materialFactory,
    )
    if (largeChar) {
      largeChar.setPosition(new THREE.Vector3(1.5, 0, 0))
      largeChar.setFrameDuration(300)
      largeChar.goToFrame(6)
    }
  }

  function explodeRandomSprite(): void {
    if (addedSprites.length === 0) {
      console.log("No added sprites available to explode.")
      return
    }

    for (let i = 0; i < 4; i++) {
      const randomIndex = Math.floor(Math.random() * addedSprites.length)
      const spriteToExplode = addedSprites[randomIndex]

      addedSprites.splice(randomIndex, 1)

      const handle = explosionManager.createExplosionForSprite(spriteToExplode, {
        numRows: 4,
        numCols: 4,
        durationMs: 3000,
        strength: 2,
        fadeOut: false,
        materialFactory,
      })

      if (handle) {
        activeExplosionHandles.push(handle)
        console.log("💥 Random sprite exploded!")
      } else {
        console.log("Failed to explode sprite.")
      }
    }
  }

  const keyHandler = (key: KeyEvent) => {
    if (key.name === "u") {
      engine.toggleSuperSampling()
    }

    if (key.name === "c") {
      isPerspectiveActive = !isPerspectiveActive
      if (isPerspectiveActive) {
        engine.setActiveCamera(pCamera)
        cameraModeText.content = "Camera: Perspective (Press 'c' to switch)"
        console.log("Switched to Perspective Camera")
      } else {
        engine.setActiveCamera(oCamera)
        cameraModeText.content = "Camera: Orthographic (Press 'c' to switch)"
        console.log("Switched to Orthographic Camera")
      }
    }

    if (key.name === "e") {
      if (mainChar && mainChar.visible) {
        if (mainCharExplosionHandle && !mainCharExplosionHandle.hasBeenRestored) {
          console.log("Main character already exploded and awaiting restoration. Restore first or reset demo.")
          return
        }
        console.log("Triggering explosion for main character via ExplosionManager!")
        const explosionParams: Partial<ExplosionEffectParameters> = {
          numRows: 50,
          numCols: 50,
          durationMs: 4000,
          strength: 2,
          gravity: 9.8,
          fadeOut: false,
          materialFactory,
        }
        mainCharExplosionHandle = explosionManager.createExplosionForSprite(mainChar, explosionParams)

        if (mainCharExplosionHandle) {
          console.log("Explosion effect created by manager. Main character destroyed.")
          mainChar = null
        } else {
          console.log("Failed to create explosion for main character via manager.")
        }
      } else if (mainCharExplosionHandle && !mainCharExplosionHandle.hasBeenRestored) {
        console.log("Main character already exploded. Press R to restore.")
      } else {
        console.log("Main character not available to explode or already restored and re-exploded.")
      }
    }

    if (key.name === "r") {
      if (mainCharExplosionHandle && !mainCharExplosionHandle.hasBeenRestored) {
        console.log("Attempting to restore main character...")
        ;(async () => {
          const restoredSprite = await mainCharExplosionHandle!.restoreSprite(spriteAnimator)
          if (restoredSprite) {
            mainChar = restoredSprite
            console.log("Main character restored successfully.")
          } else {
            console.log("Failed to restore main character. Handle might be invalid or sprite creation failed.")
          }
        })()
      } else if (mainCharExplosionHandle && mainCharExplosionHandle.hasBeenRestored) {
        console.log("Main character has already been restored from this explosion event.")
      } else {
        console.log("No active explosion to restore for the main character.")
      }
    }

    if (key.name === "p") {
      if (addedSprites.length > 0) {
        console.log("Clearing existing sprites...")
        addedSprites.forEach((sprite) => sprite.destroy())
        addedSprites = []
        explosionManager.disposeAll()
        return
      }
      console.log("Starting stress test: Adding 1000 sprites...")
      const stressTestStartTime = performance.now()
      ;(async () => {
        for (let i = 0; i < 1000; i++) {
          const id = `stress_${i}`
          const stressCharDef: SpriteDefinition = {
            ...mainCharDef,
            animations: {
              idle: {
                ...mainCharDef.animations["idle"],
                frameDuration: 100 + Math.random() * 100,
              },
            },
          }

          const instance = await spriteAnimator.createSprite(stressCharDef)
          const xPos = (Math.random() - 0.5) * pCamera.position.z * engine.aspectRatio * 1.5
          const yPos = (Math.random() - 0.5) * pCamera.position.z * 1.5
          const zPos = Math.random() * -2
          instance.setPosition(new THREE.Vector3(xPos, yPos, zPos))

          const randomScaleMultiplier = randFloat(1.0, 8.0)
          instance.setScale(new THREE.Vector3(randomScaleMultiplier, randomScaleMultiplier, randomScaleMultiplier))

          const randomStartFrame = Math.floor(Math.random() * NUM_SPRITES)
          instance.goToFrame(randomStartFrame)

          addedSprites.push(instance)
        }
        const stressTestEndTime = performance.now()
        console.log(
          `Stress test finished: Added ${addedSprites.length} sprites in ${(stressTestEndTime - stressTestStartTime).toFixed(2)} ms`,
        )
      })()
    }

    if (key.name === "x") {
      explodeRandomSprite()
    }
  }

  renderer.keyInput.on("keypress", keyHandler)

  renderer.setFrameCallback(async (deltaTime: number) => {
    spriteAnimator.update(deltaTime)
    explosionManager.update(deltaTime)
    await engine.drawScene(scene, framebuffer, deltaTime)
  })

  const instructionsText = new TextRenderable(renderer, {
    id: "instructions",
    content:
      "Controls: c=camera, e=explode, r=restore, p=stress test, x=explode random, t=debug, u=supersample, `=console, ESC=back",
    position: "absolute",
    left: 1,
    top: 1,
    fg: "#AAAAAA",
    zIndex: 20,
  })
  parentContainer.add(instructionsText)

  demoState = {
    engine,
    scene,
    pCamera,
    oCamera,
    spriteResourceManager,
    spriteAnimator,
    explosionManager,
    mainChar,
    mainCharExplosionHandle,
    addedSprites,
    activeExplosionHandles,
    isPerspectiveActive,
    parentContainer,
    instructionsText,
    cameraModeText,
    keyHandler,
  }
}

export function destroy(renderer: CliRenderer): void {
  if (demoState) {
    if (demoState.keyHandler) {
      renderer.keyInput.off("keypress", demoState.keyHandler)
    }

    demoState.addedSprites.forEach((sprite) => sprite.destroy())
    demoState.explosionManager.disposeAll()
    demoState.engine.destroy()

    for (const id of ["main", "sprite-animation-container"]) {
      const child = renderer.root.getRenderable(id)
      child?.destroyRecursively()
    }
    renderer.clearFrameCallbacks()

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
