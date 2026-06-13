#!/usr/bin/env bun

import {
  CliRenderer,
  CliRenderEvents,
  TextRenderable,
  FrameBufferRenderable,
  BoxRenderable,
  createCliRenderer,
  type KeyEvent,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import * as THREE from "three"
import { SpriteAnimator, TiledSprite, type SpriteDefinition, type AnimationDefinition } from "@opentui/three"
import { SpriteResourceManager, type ResourceConfig } from "@opentui/three"
import { PhysicsExplosionManager, type PhysicsExplosionHandle } from "@opentui/three"
import { RapierPhysicsWorld } from "@opentui/three"
import type { Collider, RigidBody, World } from "@dimforge/rapier2d-simd-compat"
// @ts-expect-error Rapier does not publish types for its ESM subpath.
import * as RAPIER from "@dimforge/rapier2d-simd-compat/rapier.es.js"
import { MeshLambertNodeMaterial } from "three/webgpu"
import { ThreeCliRenderer } from "@opentui/three"

// @ts-ignore
import cratePath from "./assets/concrete.png" with { type: "image/png" }

const SUBDIVISION = 4
const DENSITY = 2.2
const EXPLOSION_FORCE = 2.0
const EXPLOSION_FORCE_VARIATION = 0.2
const TORQUE_STRENGTH = 2.0

interface PhysicsBox {
  rigidBody: RigidBody
  sprite: TiledSprite
  width: number
  height: number
  id: string
}

interface PhysicsWorld {
  world: World
  ground: Collider
  boxes: PhysicsBox[]
}

interface DemoState {
  engine: ThreeCliRenderer
  scene: THREE.Scene
  camera: THREE.OrthographicCamera
  resourceManager: SpriteResourceManager
  spriteAnimator: SpriteAnimator
  physicsExplosionManager: PhysicsExplosionManager
  physicsWorld: PhysicsWorld
  activeExplosionHandles: PhysicsExplosionHandle[]
  isInitialized: boolean
  boxIdCounter: number
  lastSpawnTime: number
  boxSpawnCount: number
  maxInstancesReached: boolean
  crateResource: any
  crateDef: SpriteDefinition
  parentContainer: BoxRenderable
  instructionsText: TextRenderable
  controlsText: TextRenderable
  statsText: TextRenderable
  frameCallback: (deltaTime: number) => Promise<void>
  keyHandler: (key: KeyEvent) => void
  statsInterval: NodeJS.Timeout | null
  resizeHandler: (width: number, height: number) => void
}

interface PendingDemoState {
  isDestroyed: boolean
  engine: ThreeCliRenderer | null
  statsInterval: NodeJS.Timeout | null
}

let demoState: DemoState | null = null
let pendingDemoState: PendingDemoState | null = null
let rendererDestroyHandler: (() => void) | null = null

const spawnInterval = 800
const orthoViewHeight = 20.0

const materialFactory = () =>
  new MeshLambertNodeMaterial({
    transparent: true,
    alphaTest: 0.01,
    depthWrite: false,
  })

function unregisterRendererDestroyHandler(renderer: CliRenderer): void {
  if (!rendererDestroyHandler) return

  renderer.off(CliRenderEvents.DESTROY, rendererDestroyHandler)
  rendererDestroyHandler = null
}

function cleanupPendingDemoState(renderer: CliRenderer, state: PendingDemoState): void {
  state.isDestroyed = true

  const pendingStatsInterval = state.statsInterval
  if (pendingStatsInterval) {
    clearInterval(pendingStatsInterval)
    state.statsInterval = null
  }

  if (state.engine) {
    state.engine.destroy()
    state.engine = null
  }

  if (!renderer.isDestroyed) {
    renderer.root.remove("rapier-main")
    renderer.root.remove("rapier-container")
  }

  if (pendingDemoState === state) {
    pendingDemoState = null
  }
}

function cleanupDemoState(renderer: CliRenderer, state: DemoState): void {
  state.isInitialized = false

  renderer.removeFrameCallback(state.frameCallback)
  renderer.keyInput.off("keypress", state.keyHandler)
  renderer.off("resize", state.resizeHandler)

  const statsInterval = state.statsInterval
  if (statsInterval) {
    clearInterval(statsInterval)
    state.statsInterval = null
  }

  for (const box of state.physicsWorld.boxes) {
    box.sprite.destroy()
    state.physicsWorld.world.removeRigidBody(box.rigidBody)
  }

  state.physicsExplosionManager.disposeAll()
  state.engine.destroy()

  if (!renderer.isDestroyed) {
    renderer.root.remove("rapier-main")
    renderer.root.remove("rapier-container")
  }
}

export async function run(renderer: CliRenderer): Promise<void> {
  rendererDestroyHandler = () => {
    destroy(renderer)
  }
  renderer.on(CliRenderEvents.DESTROY, rendererDestroyHandler)

  renderer.start()
  const initialTermWidth = renderer.terminalWidth
  const initialTermHeight = renderer.terminalHeight

  const parentContainer = new BoxRenderable(renderer, {
    id: "rapier-container",
    zIndex: 15,
  })
  renderer.root.add(parentContainer)

  const framebufferRenderable = new FrameBufferRenderable(renderer, {
    id: "rapier-main",
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
  })

  const startupState: PendingDemoState = {
    isDestroyed: false,
    engine,
    statsInterval: null,
  }
  pendingDemoState = startupState

  const abortStartupIfDestroyed = (): boolean => {
    if (!startupState.isDestroyed) return false

    cleanupPendingDemoState(renderer, startupState)
    return true
  }

  try {
    await engine.init()
  } catch (error) {
    cleanupPendingDemoState(renderer, startupState)
    unregisterRendererDestroyHandler(renderer)

    if (startupState.isDestroyed) {
      return
    }

    throw error
  }

  if (abortStartupIfDestroyed()) return

  const scene = new THREE.Scene()

  const orthoViewWidth = orthoViewHeight * engine.aspectRatio
  const camera = new THREE.OrthographicCamera(
    orthoViewWidth / -2,
    orthoViewWidth / 2,
    orthoViewHeight / 2,
    orthoViewHeight / -2,
    0.1,
    1000,
  )
  camera.position.set(0, 0, 5)
  camera.lookAt(0, 0, 0)
  scene.add(camera)

  engine.setActiveCamera(camera)

  const resourceManager = new SpriteResourceManager(scene)
  const spriteAnimator = new SpriteAnimator(scene)

  const crateResourceConfig: ResourceConfig = {
    imagePath: cratePath,
    sheetNumFrames: 1,
  }

  let crateResource
  try {
    crateResource = await resourceManager.createResource(crateResourceConfig)
  } catch (error) {
    cleanupPendingDemoState(renderer, startupState)
    unregisterRendererDestroyHandler(renderer)

    if (startupState.isDestroyed) {
      return
    }

    throw error
  }

  if (abortStartupIfDestroyed()) return
  const crateIdleAnimation: AnimationDefinition = {
    resource: crateResource,
    frameDuration: 1000,
  }

  const crateDef: SpriteDefinition = {
    initialAnimation: "idle",
    animations: {
      idle: crateIdleAnimation,
    },
    scale: 1.0,
  }

  // Initialize physics
  try {
    await RAPIER.init()
  } catch (error) {
    cleanupPendingDemoState(renderer, startupState)
    unregisterRendererDestroyHandler(renderer)

    if (startupState.isDestroyed) {
      return
    }

    throw error
  }

  if (abortStartupIfDestroyed()) return

  const gravity = { x: 0.0, y: -9.81 }
  const world = new RAPIER.World(gravity)

  const groundColliderDesc = RAPIER.ColliderDesc.cuboid(15.0, 0.2)
  const ground = world.createCollider(groundColliderDesc)
  ground.setTranslation({ x: 0.0, y: -8.0 })

  const physicsWorld: PhysicsWorld = {
    world,
    ground,
    boxes: [],
  }

  const physicsExplosionManager = new PhysicsExplosionManager(scene, RapierPhysicsWorld.createFromRapierWorld(world))
  physicsExplosionManager.fillPool(crateResource, 512, { numRows: SUBDIVISION, numCols: SUBDIVISION, materialFactory })

  // Setup lighting
  const ambientLight = new THREE.AmbientLight(0x6666ff, 3.2)
  scene.add(ambientLight)

  const spotlight1 = new THREE.SpotLight(0xff9999, 6.5)
  spotlight1.position.set(-5, 0, 6)
  spotlight1.target.position.set(-2, -2.5, 0)
  spotlight1.penumbra = 0.3
  spotlight1.angle = Math.PI / 1.7
  spotlight1.distance = 25.0
  spotlight1.power = 500
  scene.add(spotlight1.target)
  scene.add(spotlight1)

  const spotlight2 = spotlight1.clone()
  spotlight2.color.set(0x99ff99)
  spotlight2.position.set(5, 0, 6)
  spotlight2.target.position.set(2, -2.5, 0)
  scene.add(spotlight2.target)
  scene.add(spotlight2)

  const groundGeometry = new THREE.BoxGeometry(30, 0.4, 0.2)
  const groundMaterial = new THREE.MeshPhongMaterial({
    color: 0x666666,
    transparent: true,
    opacity: 0.8,
  })
  const groundMesh = new THREE.Mesh(groundGeometry, groundMaterial)
  groundMesh.position.set(0, -8, -0.5)
  scene.add(groundMesh)

  // Create UI elements
  const instructionsText = new TextRenderable(renderer, {
    id: "rapier-instructions",
    content: "Rapier.js 2D Demo - Falling Crates (Instanced Sprites)",
    position: "absolute",
    left: 1,
    top: 1,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(instructionsText)

  const controlsText = new TextRenderable(renderer, {
    id: "rapier-controls",
    content: "Press: [Space] spawn crate, [E] explode crate, [R] reset, [T] toggle debug, [C] clear crates",
    position: "absolute",
    left: 1,
    top: 2,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(controlsText)

  const statsText = new TextRenderable(renderer, {
    id: "rapier-stats",
    content: "",
    position: "absolute",
    left: 1,
    top: 3,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(statsText)

  const state: DemoState = {
    engine,
    scene,
    camera,
    resourceManager,
    spriteAnimator,
    physicsExplosionManager,
    physicsWorld,
    activeExplosionHandles: [],
    isInitialized: true,
    boxIdCounter: 0,
    lastSpawnTime: 0,
    boxSpawnCount: 0,
    maxInstancesReached: false,
    crateResource,
    crateDef,
    parentContainer,
    instructionsText,
    controlsText,
    statsText,
    frameCallback: async () => {},
    keyHandler: () => {},
    statsInterval: null,
    resizeHandler: () => {},
  }

  async function createBox(
    x: number,
    y: number,
    width: number = 1.0,
    height: number = 1.0,
  ): Promise<PhysicsBox | null> {
    if (!state.isInitialized) return null

    const rigidBodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y)
      .setRotation(Math.random() * 0.5 - 0.25)

    const rigidBody = state.physicsWorld.world.createRigidBody(rigidBodyDesc)

    const colliderDesc = RAPIER.ColliderDesc.cuboid(width * 0.6, height * 0.6)
    state.physicsWorld.world.createCollider(colliderDesc, rigidBody)

    const id = `box_${state.boxIdCounter++}`

    try {
      const sprite = await state.spriteAnimator.createSprite(
        {
          ...state.crateDef,
          id: id,
        },
        materialFactory,
      )

      const spriteScale = Math.min(width, height) * 1.2
      sprite.setScale(new THREE.Vector3(spriteScale, spriteScale, spriteScale))
      sprite.setPosition(new THREE.Vector3(x, y, 0))

      const box: PhysicsBox = {
        rigidBody,
        sprite,
        width,
        height,
        id,
      }

      state.physicsWorld.boxes.push(box)
      return box
    } catch (error) {
      state.physicsWorld.world.removeRigidBody(rigidBody)
      console.warn(`Failed to create crate sprite: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  async function explodeRandomCrate(): Promise<void> {
    if (!state.isInitialized || state.physicsWorld.boxes.length === 0) return

    const randomIndex = Math.floor(Math.random() * state.physicsWorld.boxes.length)
    const boxToExplode = state.physicsWorld.boxes[randomIndex]

    state.physicsWorld.world.removeRigidBody(boxToExplode.rigidBody)
    state.physicsWorld.boxes.splice(randomIndex, 1)

    const explosionHandle = await state.physicsExplosionManager.createExplosionForSprite(boxToExplode.sprite, {
      numRows: SUBDIVISION,
      numCols: SUBDIVISION,
      explosionForce: EXPLOSION_FORCE,
      forceVariation: EXPLOSION_FORCE_VARIATION,
      torqueStrength: TORQUE_STRENGTH,
      durationMs: 10000,
      fadeOut: false,
      linearDamping: 1.2,
      angularDamping: 0.8,
      restitution: 0.3,
      friction: 0.9,
      density: DENSITY,
      materialFactory,
    })

    if (explosionHandle) {
      state.activeExplosionHandles.push(explosionHandle)
      console.log("💥 Crate exploded!")
    }
  }

  function updatePhysics(deltaTime: number): void {
    if (!state.isInitialized) return

    state.physicsWorld.world.step()

    for (const box of state.physicsWorld.boxes) {
      const position = box.rigidBody.translation()
      const rotation = box.rigidBody.rotation()

      box.sprite.setPosition(new THREE.Vector3(position.x, position.y, 0))
      box.sprite.setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), rotation))
    }

    state.physicsWorld.boxes = state.physicsWorld.boxes.filter((box) => {
      const pos = box.rigidBody.translation()
      if (pos.y < -15) {
        box.sprite.destroy()
        state.physicsWorld.world.removeRigidBody(box.rigidBody)
        return false
      }
      return true
    })
  }

  state.frameCallback = async (deltaTime: number) => {
    const currentTime = Date.now()

    if (
      state.isInitialized &&
      currentTime - state.lastSpawnTime > spawnInterval &&
      state.boxSpawnCount < 100 &&
      !state.maxInstancesReached
    ) {
      const x = (Math.random() - 0.5) * 16
      const y = 8 + Math.random() * 2
      const size = 0.8 + Math.random() * 1.2

      const newBox = await createBox(x, y, size, size)
      if (newBox) {
        state.lastSpawnTime = currentTime
        state.boxSpawnCount++
      } else {
        state.maxInstancesReached = true
      }
    }

    updatePhysics(deltaTime)
    state.spriteAnimator.update(deltaTime)
    if (state.physicsExplosionManager) {
      state.physicsExplosionManager.update(deltaTime)
    }
    await state.engine.drawScene(state.scene, framebuffer, deltaTime)
  }

  state.keyHandler = (key: KeyEvent) => {
    const keyStr = key.name

    if (keyStr === "space" && state.isInitialized) {
      ;(async () => {
        const x = (Math.random() - 0.5) * 16
        const y = 8 + Math.random() * 2
        const size = 0.8 + Math.random() * 1.2

        const newBox = await createBox(x, y, size, size)
        if (newBox) {
          console.log("Crate spawned manually!")
        } else {
          state.maxInstancesReached = true
          console.log("Cannot spawn crate - maximum instances reached!")
        }
      })()
    }

    if (keyStr === "e" && state.isInitialized) {
      explodeRandomCrate()
    }

    if (keyStr === "r" && state.isInitialized) {
      for (const box of state.physicsWorld.boxes) {
        box.sprite.destroy()
        state.physicsWorld.world.removeRigidBody(box.rigidBody)
      }
      state.physicsWorld.boxes = []
      state.boxSpawnCount = 0

      state.physicsExplosionManager.disposeAll()
      state.activeExplosionHandles.length = 0

      console.log("Physics world reset!")
    }

    if (keyStr === "c" && state.isInitialized) {
      for (const box of state.physicsWorld.boxes) {
        box.sprite.destroy()
        state.physicsWorld.world.removeRigidBody(box.rigidBody)
      }
      state.physicsWorld.boxes = []
      state.boxSpawnCount = 0

      state.physicsExplosionManager.disposeAll()
      state.activeExplosionHandles.length = 0

      console.log("All crates cleared!")
    }

    if (keyStr === "b" && state.isInitialized) {
      console.log("Spawning burst of crates!")
      ;(async () => {
        for (let i = 0; i < 10; i++) {
          const x = (Math.random() - 0.5) * 12
          const y = 8 + Math.random() * 4
          const size = 0.6 + Math.random() * 1.0

          const newBox = await createBox(x, y, size, size)
          if (!newBox) {
            state.maxInstancesReached = true
            console.log(`Burst stopped at ${i + 1} crates - maximum instances reached!`)
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      })()
    }
  }

  state.resizeHandler = (newWidth: number, newHeight: number) => {
    framebuffer.resize(newWidth, newHeight)

    const newOrthoViewWidth = orthoViewHeight * state.engine.aspectRatio
    state.camera.left = newOrthoViewWidth / -2
    state.camera.right = newOrthoViewWidth / 2
    state.camera.top = orthoViewHeight / 2
    state.camera.bottom = orthoViewHeight / -2
    state.camera.updateProjectionMatrix()
  }

  if (abortStartupIfDestroyed()) return

  state.statsInterval = setInterval(() => {
    if (state.isInitialized && !state.statsText.isDestroyed) {
      const explosionCount = state.activeExplosionHandles.filter((h) => !h.hasBeenRestored).length
      state.statsText.content = `Crates: ${state.physicsWorld.boxes.length} | Explosions: ${explosionCount} | Press [B] for burst spawn`
    }
  }, 100)
  startupState.statsInterval = state.statsInterval

  renderer.setFrameCallback(state.frameCallback)
  renderer.keyInput.on("keypress", state.keyHandler)
  renderer.on("resize", state.resizeHandler)

  startupState.engine = null
  startupState.statsInterval = null
  pendingDemoState = null
  demoState = state
  console.log("Rapier physics demo initialized!")
}

export function destroy(renderer: CliRenderer): void {
  unregisterRendererDestroyHandler(renderer)

  let didCleanup = false

  if (pendingDemoState) {
    cleanupPendingDemoState(renderer, pendingDemoState)
    didCleanup = true
  }

  if (demoState) {
    cleanupDemoState(renderer, demoState)
    demoState = null
    didCleanup = true
  }

  if (didCleanup) {
    console.log("Rapier physics demo cleaned up!")
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
