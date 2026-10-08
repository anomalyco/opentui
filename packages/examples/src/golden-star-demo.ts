#!/usr/bin/env bun

import {
  createCliRenderer,
  CliRenderer,
  FrameBufferRenderable,
  BoxRenderable,
  RGBA,
  ASCIIFontRenderable,
  type ASCIIFontName,
  type OptimizedBuffer,
  type KeyEvent,
} from "@opentui/core"
import {
  Scene as ThreeScene,
  Mesh as ThreeMesh,
  PerspectiveCamera,
  Color,
  MeshPhongMaterial,
  AmbientLight,
  DirectionalLight as ThreeDirectionalLight,
  PointLight as ThreePointLight,
  ExtrudeGeometry,
  Shape,
  BoxGeometry,
  BackSide,
  InstancedMesh,
  Matrix4,
  Vector3,
  Euler,
  Quaternion,
  ConeGeometry,
} from "three"
import { ThreeCliRenderer } from "@opentui/three"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

interface StarParticle {
  instanceIndex: number
  meshIndex: number
  localInstanceIndex: number
  position: Vector3
  velocity: Vector3
  rotation: Euler
  angularVelocity: Vector3
  lifetime: number
  maxLifetime: number
  scale: number
}

class StarParticleSystem {
  private particles: StarParticle[] = []
  private instancedMeshes: InstancedMesh[] = []
  private maxParticles: number
  private freeIndices: number[] = []
  private emitterPosition: Vector3 = new Vector3(0, 0, 0)
  private tempMatrix: Matrix4 = new Matrix4()
  private tempPosition: Vector3 = new Vector3()
  private tempQuaternion = new Quaternion()
  private tempScale: Vector3 = new Vector3()
  private gravity: number = -2.5
  private normalGravity: number = -2.5
  private hellGravity: number = -0.5
  private colors: Color[] = []
  private cyberColors: Color[] = []
  private hellColors: Color[] = []
  private materials: MeshPhongMaterial[] = []
  private isHellMode: boolean = false

  constructor(scene: ThreeScene, maxParticles: number = 100) {
    this.maxParticles = maxParticles

    const starShape = this.createMiniStarShape(0.18, 0.07, 5)
    const extrudeSettings = {
      depth: 0.05,
      bevelEnabled: true,
      bevelThickness: 0.012,
      bevelSize: 0.012,
      bevelSegments: 2,
    }
    const geometry = new ExtrudeGeometry(starShape, extrudeSettings)

    this.cyberColors = [
      new Color(0.0, 0.9, 1.0),
      new Color(0.2, 0.7, 1.0),
      new Color(0.4, 0.5, 1.0),
      new Color(0.6, 0.3, 1.0),
      new Color(0.8, 0.2, 1.0),
      new Color(1.0, 0.2, 0.9),
      new Color(1.0, 0.3, 0.7),
      new Color(1.0, 0.85, 0.2),
      new Color(1.0, 0.75, 0.3),
      new Color(0.9, 0.7, 0.25),
      new Color(0.0, 0.9, 1.0),
      new Color(0.6, 0.3, 1.0),
      new Color(1.0, 0.85, 0.2),
      new Color(0.0, 1.0, 0.85),
      new Color(0.5, 0.2, 1.0),
      new Color(1.0, 0.15, 0.85),
      new Color(0.1, 0.6, 1.0),
      new Color(0.9, 0.1, 1.0),
    ]

    this.hellColors = [
      new Color(1.0, 0.0, 0.0),
      new Color(1.0, 0.15, 0.0),
      new Color(1.0, 0.3, 0.0),
      new Color(1.0, 0.5, 0.0),
      new Color(1.0, 0.65, 0.0),
      new Color(1.0, 0.8, 0.0),
      new Color(1.0, 0.95, 0.0),
      new Color(1.0, 0.0, 0.0),
      new Color(1.0, 0.15, 0.0),
      new Color(1.0, 0.5, 0.0),
      new Color(0.8, 0.0, 0.0),
      new Color(0.9, 0.1, 0.0),
      new Color(1.0, 0.8, 0.0),
      new Color(0.6, 0.0, 0.0),
      new Color(0.5, 0.05, 0.0),
      new Color(1.0, 0.4, 0.0),
      new Color(1.0, 1.0, 0.0),
      new Color(0.7, 0.0, 0.1),
    ]

    this.colors = this.cyberColors

    const particlesPerColor = Math.ceil(maxParticles / this.colors.length)
    for (let colorIdx = 0; colorIdx < this.colors.length; colorIdx++) {
      const color = this.colors[colorIdx]
      const material = new MeshPhongMaterial({
        color: color,
        emissive: color,
        emissiveIntensity: 0.65,
        shininess: 55,
      })
      this.materials.push(material)

      const mesh = new InstancedMesh(geometry, material, particlesPerColor)
      mesh.instanceMatrix.setUsage(35048)
      mesh.renderOrder = -1
      mesh.frustumCulled = false

      const hiddenMatrix = new Matrix4().scale(new Vector3(0, 0, 0))
      for (let i = 0; i < particlesPerColor; i++) {
        mesh.setMatrixAt(i, hiddenMatrix)
      }
      mesh.instanceMatrix.needsUpdate = true

      this.instancedMeshes.push(mesh)
      scene.add(mesh)
    }

    for (let i = 0; i < maxParticles; i++) {
      this.freeIndices.push(i)
    }
  }

  private createMiniStarShape(outerRadius: number, innerRadius: number, points: number = 5): Shape {
    const shape = new Shape()
    const angleStep = (Math.PI * 2) / points

    for (let i = 0; i < points * 2; i++) {
      const angle = (i * angleStep) / 2 - Math.PI / 2
      const radius = i % 2 === 0 ? outerRadius : innerRadius
      const x = Math.cos(angle) * radius
      const y = Math.sin(angle) * radius

      if (i === 0) {
        shape.moveTo(x, y)
      } else {
        shape.lineTo(x, y)
      }
    }
    shape.closePath()
    return shape
  }

  setEmitterPosition(x: number, y: number, z: number) {
    this.emitterPosition.set(x, y, z)
  }

  emit(count: number = 1) {
    for (let i = 0; i < count; i++) {
      if (this.freeIndices.length === 0) {
        const oldestParticle = this.particles.shift()
        if (oldestParticle) {
          this.freeIndices.push(oldestParticle.instanceIndex)
        } else {
          break
        }
      }

      const instanceIndex = this.freeIndices.pop()!

      const particlesPerColor = Math.ceil(this.maxParticles / this.colors.length)
      const meshIndex = Math.floor(instanceIndex / particlesPerColor)
      const localInstanceIndex = instanceIndex % particlesPerColor

      const spreadAngle = (Math.random() - 0.5) * Math.PI * 0.8
      const upwardBias = Math.random() * 0.7 + 0.4

      const baseSpeed = this.isHellMode ? Math.random() * 1.0 + 0.8 : Math.random() * 2.0 + 1.5

      const velocity = new Vector3(
        Math.sin(spreadAngle) * baseSpeed * 0.9,
        upwardBias * baseSpeed,
        Math.random() * 0.3 - 0.5,
      )

      const particle: StarParticle = {
        instanceIndex,
        meshIndex,
        localInstanceIndex,
        position: new Vector3(
          this.emitterPosition.x + (Math.random() - 0.5) * 0.1,
          this.emitterPosition.y - 0.1,
          this.emitterPosition.z - 0.2,
        ),
        velocity,
        rotation: new Euler(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2),
        angularVelocity: new Vector3(
          (Math.random() - 0.5) * 10,
          (Math.random() - 0.5) * 10,
          (Math.random() - 0.5) * 10,
        ),
        lifetime: 0,
        maxLifetime: 5.0 + Math.random() * 3.0, // 5.0-8.0 seconds (much longer lifetime)
        scale: 0.8 + Math.random() * 0.4, // Slight size variation
      }

      this.particles.push(particle)
    }
  }

  update(deltaTime: number) {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const particle = this.particles[i]
      particle.lifetime += deltaTime

      if (particle.lifetime >= particle.maxLifetime) {
        this.particles.splice(i, 1)
        this.freeIndices.push(particle.instanceIndex)
        const hiddenMatrix = new Matrix4().scale(new Vector3(0, 0, 0))
        const mesh = this.instancedMeshes[particle.meshIndex]
        if (mesh) {
          mesh.setMatrixAt(particle.localInstanceIndex, hiddenMatrix)
          mesh.instanceMatrix.needsUpdate = true
        }
        continue
      }

      particle.velocity.y += this.gravity * deltaTime
      particle.position.x += particle.velocity.x * deltaTime
      particle.position.y += particle.velocity.y * deltaTime
      particle.position.z += particle.velocity.z * deltaTime

      particle.rotation.x += particle.angularVelocity.x * deltaTime
      particle.rotation.y += particle.angularVelocity.y * deltaTime
      particle.rotation.z += particle.angularVelocity.z * deltaTime

      const lifeRatio = particle.lifetime / particle.maxLifetime
      const fadeStart = 0.7
      const alpha = lifeRatio > fadeStart ? 1.0 - (lifeRatio - fadeStart) / (1.0 - fadeStart) : 1.0
      const scale = particle.scale * alpha

      this.tempQuaternion.setFromEuler(particle.rotation)
      this.tempMatrix.compose(particle.position, this.tempQuaternion, this.tempScale.set(scale, scale, scale))

      const mesh = this.instancedMeshes[particle.meshIndex]
      if (mesh) {
        mesh.setMatrixAt(particle.localInstanceIndex, this.tempMatrix)
      }
    }

    for (const mesh of this.instancedMeshes) {
      mesh.instanceMatrix.needsUpdate = true
    }
  }

  setHellMode(isHellMode: boolean) {
    this.isHellMode = isHellMode
    this.colors = isHellMode ? this.hellColors : this.cyberColors
    this.gravity = isHellMode ? this.hellGravity : this.normalGravity

    for (let i = 0; i < this.materials.length && i < this.colors.length; i++) {
      const color = this.colors[i]
      this.materials[i].color.copy(color)
      this.materials[i].emissive.copy(color)
    }
  }

  dispose() {
    for (const mesh of this.instancedMeshes) {
      mesh.geometry.dispose()
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((mat) => mat.dispose())
      } else {
        mesh.material.dispose()
      }
    }
  }
}

export async function run(renderer: CliRenderer): Promise<void> {
  renderer.start()
  const WIDTH = renderer.terminalWidth
  const HEIGHT = renderer.terminalHeight
  const CAM_DISTANCE = 3

  const framebufferRenderable = new FrameBufferRenderable(renderer, {
    id: "golden-star-main",
    width: WIDTH,
    height: HEIGHT,
    zIndex: 10,
  })
  renderer.root.add(framebufferRenderable)
  const framebuffer = framebufferRenderable.frameBuffer

  const engine = new ThreeCliRenderer(renderer, {
    width: WIDTH,
    height: HEIGHT,
    focalLength: 8,
    backgroundColor: RGBA.fromInts(0, 0, 0, 0),
    alpha: true,
  })
  framebufferRenderable.once("destroyed", () => engine.destroy())
  await engine.init()

  const sceneRoot = new ThreeScene()

  // Create the room (cube with inverted normals)
  const roomSize = 10
  const roomGeometry = new BoxGeometry(roomSize, roomSize, roomSize)
  const roomMaterial = new MeshPhongMaterial({
    color: new Color(0.1, 0.05, 0.15), // Deep purple-black walls
    side: BackSide, // Render inside of the cube
    shininess: 10,
  })
  const roomMesh = new ThreeMesh(roomGeometry, roomMaterial)
  sceneRoot.add(roomMesh)

  // Create ambient light for base illumination - slightly brighter
  const ambientLightNode = new AmbientLight(new Color(0.2, 0.15, 0.25), 0.5)
  sceneRoot.add(ambientLightNode)

  // Key light - main directional light from top-front - more intense
  const keyLight = new ThreeDirectionalLight(new Color(1.0, 0.95, 0.85), 2.5)
  keyLight.position.set(3, 4, 5)
  keyLight.target.position.set(0, 0, 0)
  sceneRoot.add(keyLight)
  sceneRoot.add(keyLight.target)

  const lightningDirectionalLight = new ThreeDirectionalLight(new Color(1.0, 0.98, 0.95), 0.0)
  lightningDirectionalLight.position.set(0, 5, 8)
  lightningDirectionalLight.target.position.set(0, 0, 0)
  lightningDirectionalLight.name = "lightningDirectional"
  sceneRoot.add(lightningDirectionalLight)
  sceneRoot.add(lightningDirectionalLight.target)

  const movingLight1 = new ThreePointLight(new Color(0.0, 0.9, 1.0), 15.0, 25)
  movingLight1.position.set(0, 0, -3)
  movingLight1.name = "movingLight1"
  sceneRoot.add(movingLight1)

  const movingLight2 = new ThreePointLight(new Color(1.0, 0.2, 0.9), 15.0, 25)
  movingLight2.position.set(0, 0, -3)
  movingLight2.name = "movingLight2"
  sceneRoot.add(movingLight2)

  const movingLight3 = new ThreePointLight(new Color(0.6, 0.3, 1.0), 15.0, 25)
  movingLight3.position.set(0, 0, -3)
  movingLight3.name = "movingLight3"
  sceneRoot.add(movingLight3)

  const movingLight4 = new ThreePointLight(new Color(1.0, 0.85, 0.2), 15.0, 25)
  movingLight4.position.set(0, 0, -3)
  movingLight4.name = "movingLight4"
  sceneRoot.add(movingLight4)

  const lightningLight1 = new ThreePointLight(new Color(1.0, 0.95, 0.9), 0.0, 50)
  lightningLight1.position.set(-2, 2, 5)
  lightningLight1.name = "lightningLight1"
  sceneRoot.add(lightningLight1)

  const lightningLight2 = new ThreePointLight(new Color(1.0, 0.95, 0.9), 0.0, 50)
  lightningLight2.position.set(2, 1, 5)
  lightningLight2.name = "lightningLight2"
  sceneRoot.add(lightningLight2)

  const lightningLight3 = new ThreePointLight(new Color(1.0, 0.95, 0.9), 0.0, 50)
  lightningLight3.position.set(0, 3, 6)
  lightningLight3.name = "lightningLight3"
  sceneRoot.add(lightningLight3)

  function createStarShape(outerRadius: number, innerRadius: number, points: number = 5): Shape {
    const shape = new Shape()
    const angleStep = (Math.PI * 2) / points

    for (let i = 0; i < points * 2; i++) {
      const angle = (i * angleStep) / 2 - Math.PI / 2
      const radius = i % 2 === 0 ? outerRadius : innerRadius
      const x = Math.cos(angle) * radius
      const y = Math.sin(angle) * radius

      if (i === 0) {
        shape.moveTo(x, y)
      } else {
        shape.lineTo(x, y)
      }
    }
    shape.closePath()
    return shape
  }

  const starShape = createStarShape(1.0, 0.4, 5)
  const extrudeSettings = {
    depth: 0.3,
    bevelEnabled: true,
    bevelThickness: 0.08,
    bevelSize: 0.08,
    bevelSegments: 5,
  }

  const starGeometry = new ExtrudeGeometry(starShape, extrudeSettings)

  const goldenMaterial = new MeshPhongMaterial({
    color: new Color(1.0, 0.88, 0.2),
    specular: new Color(1.0, 1.0, 0.85),
    shininess: 200,
    emissive: new Color(0.7, 0.55, 0.15),
    emissiveIntensity: 1.2,
    flatShading: false,
  })

  const starMeshNode = new ThreeMesh(starGeometry, goldenMaterial)
  starMeshNode.name = "star"
  starMeshNode.rotation.z = Math.PI
  sceneRoot.add(starMeshNode)

  const hornGeometry = new ConeGeometry(0.15, 0.6, 8)
  const hornMaterial = new MeshPhongMaterial({
    color: new Color(0.85, 0.85, 0.85),
    emissive: new Color(0.1, 0.1, 0.1),
    shininess: 50,
  })

  const leftHorn = new ThreeMesh(hornGeometry, hornMaterial)
  leftHorn.name = "leftHorn"
  leftHorn.position.set(-0.32, -0.5, 0.4)
  leftHorn.rotation.set(Math.PI - 0.6, 0, 0.25)
  leftHorn.visible = false
  starMeshNode.add(leftHorn)

  const rightHorn = new ThreeMesh(hornGeometry, hornMaterial)
  rightHorn.name = "rightHorn"
  rightHorn.position.set(0.32, -0.5, 0.4)
  rightHorn.rotation.set(Math.PI - 0.6, 0, -0.25)
  rightHorn.visible = false
  starMeshNode.add(rightHorn)

  const cameraNode = new PerspectiveCamera(45, engine.aspectRatio, 1.0, 100.0)
  cameraNode.position.set(0, 0, CAM_DISTANCE)
  cameraNode.name = "main_camera"

  sceneRoot.add(cameraNode)
  engine.setActiveCamera(cameraNode)

  const particleSystem = new StarParticleSystem(sceneRoot, 150)

  const resizeHandler = (width: number, height: number) => {
    if (framebuffer) {
      framebuffer.resize(width, height)
    }
    if (cameraNode) {
      cameraNode.aspect = engine.aspectRatio
      cameraNode.updateProjectionMatrix()
    }
    updateGradientBand()
  }

  renderer.on("resize", resizeHandler)
  framebufferRenderable.once("destroyed", () => renderer.off("resize", resizeHandler))

  const bandPadding = 2
  const gradientBand = new FrameBufferRenderable(renderer, {
    id: "gradientBand",
    position: "absolute",
    left: 0,
    top: 0,
    width: renderer.terminalWidth,
    height: 1,
    zIndex: 50,
    respectAlpha: true,
  })

  gradientBand.visible = true

  renderer.root.add(gradientBand)

  function updateGradientBand() {
    const opentuiHeight = opentuiContainer.height
    const fiveKHeight = fiveKContainer.height

    if (opentuiHeight === 0 || fiveKHeight === 0) {
      return
    }

    const opentuiAbsY = overlayContainer.y + opentuiContainer.y
    const fiveKAbsY = overlayContainer.y + fiveKContainer.y

    const bandTop = Math.max(0, opentuiAbsY - bandPadding)
    const bandBottom = fiveKAbsY + fiveKHeight + bandPadding
    const bandHeight = Math.max(1, bandBottom - bandTop)
    const bandWidth = renderer.terminalWidth

    gradientBand.top = bandTop
    gradientBand.height = bandHeight
    gradientBand.width = bandWidth

    const bandBuffer = gradientBand.frameBuffer
    if (!bandBuffer) return

    if (bandBuffer.width !== bandWidth || bandBuffer.height !== bandHeight) {
      bandBuffer.resize(bandWidth, bandHeight)
    }

    bandBuffer.clear(RGBA.fromInts(0, 0, 0, 0))

    for (let y = 0; y < bandHeight; y++) {
      const distFromCenter = Math.abs(y - bandHeight / 2) / (bandHeight / 2)
      const alpha = (1.0 - distFromCenter * 0.7) * 0.5

      const color = RGBA.fromValues(0.04, 0.02, 0.1, alpha)
      bandBuffer.fillRect(0, y, bandWidth, 1, color)
    }
  }

  let isHellMode = false

  const keyHandler = (keyEvent: KeyEvent) => {
    if (keyEvent.name === "b") {
      gradientBand.visible = !gradientBand.visible
    } else if (keyEvent.name === "h") {
      isHellMode = !isHellMode
      particleSystem.setHellMode(isHellMode)

      // Update main star material and show/hide horns
      const leftHornNode = starMeshNode.getObjectByName("leftHorn")
      const rightHornNode = starMeshNode.getObjectByName("rightHorn")

      if (isHellMode) {
        goldenMaterial.color.setRGB(0.4, 0.0, 0.0)
        goldenMaterial.emissive.setRGB(0.2, 0.0, 0.0)
        goldenMaterial.specular.setRGB(0.5, 0.1, 0.1)
        roomMaterial.color.setRGB(0.15, 0.02, 0.0)
        ambientLightNode.color.setRGB(0.3, 0.05, 0.0)
        keyLight.color.setRGB(1.0, 0.4, 0.1)
        movingLight1.color.setRGB(1.0, 0.0, 0.0)
        movingLight2.color.setRGB(1.0, 0.3, 0.0)
        movingLight3.color.setRGB(1.0, 0.5, 0.0)
        movingLight4.color.setRGB(1.0, 0.8, 0.0)

        for (const char of opentuiChars) {
          char.color = [RGBA.fromInts(255, 40, 0, 255), RGBA.fromInts(200, 0, 0, 255)]
        }
        for (const char of fiveKChars) {
          char.color = [RGBA.fromInts(255, 100, 0, 255), RGBA.fromInts(255, 200, 0, 255)]
        }

        if (leftHornNode) leftHornNode.visible = true
        if (rightHornNode) rightHornNode.visible = true
        nextLightningTime = elapsedTime + 0.1
      } else {
        goldenMaterial.color.setRGB(1.0, 0.88, 0.2)
        goldenMaterial.emissive.setRGB(0.7, 0.55, 0.15)
        goldenMaterial.specular.setRGB(1.0, 1.0, 0.85)
        roomMaterial.color.setRGB(0.1, 0.05, 0.15)
        ambientLightNode.color.setRGB(0.2, 0.15, 0.25)
        keyLight.color.setRGB(1.0, 0.95, 0.85)
        movingLight1.color.setRGB(0.0, 0.9, 1.0)
        movingLight2.color.setRGB(1.0, 0.2, 0.9)
        movingLight3.color.setRGB(0.6, 0.3, 1.0)
        movingLight4.color.setRGB(1.0, 0.85, 0.2)

        for (const char of opentuiChars) {
          char.color = [RGBA.fromInts(255, 80, 120, 255), RGBA.fromInts(255, 60, 215, 255)]
        }
        for (const char of fiveKChars) {
          char.color = [RGBA.fromInts(50, 255, 120, 255), RGBA.fromInts(100, 255, 150, 255)]
        }

        if (leftHornNode) leftHornNode.visible = false
        if (rightHornNode) rightHornNode.visible = false
      }
    }
  }
  renderer.keyInput.on("keypress", keyHandler)
  framebufferRenderable.once("destroyed", () => renderer.keyInput.off("keypress", keyHandler))

  const overlayContainer = new BoxRenderable(renderer, {
    id: "overlay",
    position: "absolute",
    left: 0,
    top: 0,
    width: "100%",
    height: "100%",
    zIndex: 100,
    justifyContent: "center",
    alignItems: "center",
    paddingTop: 10,
  })
  renderer.root.add(overlayContainer)

  const opentuiChars: ASCIIFontRenderable[] = []
  const opentuiContainer = new BoxRenderable(renderer, {
    id: "opentuiContainer",
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "flex-end",
    zIndex: 101,
  })
  overlayContainer.add(opentuiContainer)

  const opentuiText = "opentui"
  for (let i = 0; i < opentuiText.length; i++) {
    const char = new ASCIIFontRenderable(renderer, {
      id: `opentui-char-${i}`,
      text: opentuiText[i],
      font: "block" as ASCIIFontName,
      color: [RGBA.fromInts(255, 80, 120, 255), RGBA.fromInts(255, 60, 215, 255)],
      backgroundColor: RGBA.fromInts(0, 0, 0, 0),
      zIndex: 101,
    })
    opentuiContainer.add(char)
    opentuiChars.push(char)
  }

  const fiveKChars: ASCIIFontRenderable[] = []
  const fiveKContainer = new BoxRenderable(renderer, {
    id: "fiveKContainer",
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "flex-end",
    top: 2,
    zIndex: 101,
  })
  overlayContainer.add(fiveKContainer)

  const fiveKText = "5000"
  for (let i = 0; i < fiveKText.length; i++) {
    const char = new ASCIIFontRenderable(renderer, {
      id: `fivek-char-${i}`,
      text: fiveKText[i],
      font: "huge" as ASCIIFontName,
      color: [RGBA.fromInts(50, 255, 120, 255), RGBA.fromInts(100, 255, 150, 255)],
      backgroundColor: RGBA.fromInts(0, 0, 0, 0),
      zIndex: 101,
    })
    fiveKContainer.add(char)
    fiveKChars.push(char)
  }

  opentuiContainer.onSizeChange = updateGradientBand
  fiveKContainer.onSizeChange = updateGradientBand
  overlayContainer.onSizeChange = updateGradientBand

  for (const char of opentuiChars) {
    char.onSizeChange = updateGradientBand
  }
  for (const char of fiveKChars) {
    char.onSizeChange = updateGradientBand
  }

  let elapsedTime = 0
  let initialLayoutFrames = 3
  let jumpPhase = 0
  let randomOffset = 0
  let nextRandomTime = 0
  let targetTiltX = 0
  let targetTiltZ = 0
  let currentTiltX = 0
  let currentTiltZ = 0
  let targetRotationY = 0
  let currentRotationY = 0
  let nextRotationChangeTime = 0
  let particleEmitAccumulator = 0
  const particleEmitRate = 0.03
  let headbangPhase = 0

  let waveStartTime = 0
  const waveCycleDuration = 2.5
  const waveWaitTime = 1.0
  const charJumpDuration = 0.5
  const charDelay = 0.1
  const charRandomOffsets: number[] = [...opentuiChars, ...fiveKChars].map(() => Math.random() * 0.1 - 0.05)
  let nextRandomRefresh = elapsedTime + 3.0

  interface LightningStrike {
    light: ThreePointLight
    startTime: number
    duration: number
    maxIntensity: number
    flickerPattern: number[]
  }
  let activeLightningStrikes: LightningStrike[] = []
  let nextLightningTime = 0

  renderer.setFrameCallback(async (deltaMs) => {
    const deltaTime = deltaMs / 1000
    elapsedTime += deltaTime
    particleEmitAccumulator += deltaTime

    if (initialLayoutFrames > 0) {
      updateGradientBand()
      initialLayoutFrames--
    }

    const starObject = sceneRoot.getObjectByName("star") as ThreeMesh | undefined

    if (starObject) {
      if (isHellMode) {
        headbangPhase = elapsedTime * 8.0

        const headbangIntensity = 0.6
        const headbangTilt = Math.sin(headbangPhase) * headbangIntensity

        const sideHeadbang = Math.sin(headbangPhase * 0.5) * 0.3

        const verticalBob = Math.sin(headbangPhase) * 0.08
        starObject.position.y = verticalBob

        starObject.rotation.x = headbangTilt
        starObject.rotation.y = sideHeadbang
        starObject.rotation.z = Math.PI

        const scalePulse = 1.0 + Math.abs(Math.sin(headbangPhase)) * 0.08
        starObject.scale.set(scalePulse, scalePulse, scalePulse)
      } else {
        if (elapsedTime > nextRotationChangeTime) {
          const maxAngle = Math.PI / 3
          targetRotationY = (Math.random() - 0.5) * 2 * maxAngle
          nextRotationChangeTime = elapsedTime + 0.4 + Math.random() * 0.8
        }

        const rotationLerpSpeed = 2.0 * deltaTime
        currentRotationY += (targetRotationY - currentRotationY) * rotationLerpSpeed
        starObject.rotation.y = currentRotationY

        if (elapsedTime > nextRandomTime) {
          randomOffset = (Math.random() - 0.5) * 0.2
          targetTiltX = (Math.random() - 0.5) * 0.15
          targetTiltZ = (Math.random() - 0.5) * 0.15
          nextRandomTime = elapsedTime + 0.3 + Math.random() * 0.5
        }

        const tiltLerpSpeed = 5.0 * deltaTime
        currentTiltX += (targetTiltX - currentTiltX) * tiltLerpSpeed
        currentTiltZ += (targetTiltZ - currentTiltZ) * tiltLerpSpeed

        jumpPhase = elapsedTime * 6.0
        const rawJump = Math.sin(jumpPhase)
        const easedJump = rawJump < 0 ? rawJump : Math.pow(rawJump, 0.6)
        const jump = easedJump * 0.25 + randomOffset * 0.1
        starObject.position.y = jump

        const squashAmount = 0.08
        const landingSquash = Math.max(0, -rawJump) * squashAmount
        const scaleY = 1.0 - landingSquash
        const scaleXZ = 1.0 + landingSquash * 0.5

        const pulsate = Math.sin(elapsedTime * 3) * 0.03 + 1.0 + randomOffset * 0.05
        starObject.scale.set(pulsate * scaleXZ, pulsate * scaleY, pulsate * scaleXZ)

        const jumpInfluence = Math.max(0, rawJump)
        starObject.rotation.x = currentTiltX * jumpInfluence
        starObject.rotation.z = Math.PI + currentTiltZ * jumpInfluence
      }

      particleSystem.setEmitterPosition(starObject.position.x, starObject.position.y, starObject.position.z)

      while (particleEmitAccumulator >= particleEmitRate) {
        particleSystem.emit(3)
        particleEmitAccumulator -= particleEmitRate
      }
    }

    particleSystem.update(deltaTime)

    const light1 = sceneRoot.getObjectByName("movingLight1") as ThreePointLight | undefined
    const light2 = sceneRoot.getObjectByName("movingLight2") as ThreePointLight | undefined
    const light3 = sceneRoot.getObjectByName("movingLight3") as ThreePointLight | undefined
    const light4 = sceneRoot.getObjectByName("movingLight4") as ThreePointLight | undefined

    const radius = 2.5
    const speed = 1.5

    if (light1) {
      light1.position.x = Math.cos(elapsedTime * speed) * radius
      light1.position.y = Math.sin(elapsedTime * speed) * radius
      light1.position.z = -3
    }

    if (light2) {
      light2.position.x = Math.cos(elapsedTime * speed + Math.PI / 2) * radius
      light2.position.y = Math.sin(elapsedTime * speed + Math.PI / 2) * radius
      light2.position.z = -3
    }

    if (light3) {
      light3.position.x = Math.cos(elapsedTime * speed + Math.PI) * radius
      light3.position.y = Math.sin(elapsedTime * speed + Math.PI) * radius
      light3.position.z = -3
    }

    if (light4) {
      light4.position.x = Math.cos(elapsedTime * speed + (3 * Math.PI) / 2) * radius
      light4.position.y = Math.sin(elapsedTime * speed + (3 * Math.PI) / 2) * radius
      light4.position.z = -3
    }

    if (isHellMode) {
      if (elapsedTime >= nextLightningTime) {
        const lightningLights = [
          sceneRoot.getObjectByName("lightningLight1") as ThreePointLight | undefined,
          sceneRoot.getObjectByName("lightningLight2") as ThreePointLight | undefined,
          sceneRoot.getObjectByName("lightningLight3") as ThreePointLight | undefined,
        ].filter((l) => l !== undefined) as ThreePointLight[]

        const numStrikes = Math.random() < 0.4 ? 1 : Math.random() < 0.7 ? 2 : 3
        const availableLights = [...lightningLights].sort(() => Math.random() - 0.5)

        for (let i = 0; i < Math.min(numStrikes, availableLights.length); i++) {
          const light = availableLights[i]
          const flickerPattern = [130, 25, 160, 120, 75, 35, 10, 0]
          const duration = 0.25

          activeLightningStrikes.push({
            light,
            startTime: elapsedTime,
            duration,
            maxIntensity: 100 + Math.random() * 50,
            flickerPattern,
          })
        }

        nextLightningTime = elapsedTime + 0.15 + Math.random() * 0.85
      }

      const lightningDir = sceneRoot.getObjectByName("lightningDirectional") as ThreeDirectionalLight | undefined
      if (lightningDir && activeLightningStrikes.length > 0) {
        const maxStrikeIntensity = Math.max(...activeLightningStrikes.map((s) => s.light.intensity))
        lightningDir.intensity = maxStrikeIntensity * 0.2
      } else if (lightningDir) {
        lightningDir.intensity = 0
      }

      for (let i = activeLightningStrikes.length - 1; i >= 0; i--) {
        const strike = activeLightningStrikes[i]
        const strikeAge = elapsedTime - strike.startTime

        if (strikeAge >= strike.duration) {
          strike.light.intensity = 0
          activeLightningStrikes.splice(i, 1)
        } else {
          const progress = strikeAge / strike.duration
          const patternIndex = Math.floor(progress * strike.flickerPattern.length)
          const patternValue = strike.flickerPattern[Math.min(patternIndex, strike.flickerPattern.length - 1)]
          strike.light.intensity = (patternValue / 120) * strike.maxIntensity

          const microFlicker = 1.0 + (Math.random() - 0.5) * 0.4
          strike.light.intensity *= microFlicker

          const wobble = 0.3
          strike.light.position.x += (Math.random() - 0.5) * wobble
          strike.light.position.y += (Math.random() - 0.5) * wobble
        }
      }
    } else {
      const lightningLight1Node = sceneRoot.getObjectByName("lightningLight1") as ThreePointLight | undefined
      const lightningLight2Node = sceneRoot.getObjectByName("lightningLight2") as ThreePointLight | undefined
      const lightningLight3Node = sceneRoot.getObjectByName("lightningLight3") as ThreePointLight | undefined
      const lightningDir = sceneRoot.getObjectByName("lightningDirectional") as ThreeDirectionalLight | undefined

      if (lightningLight1Node) lightningLight1Node.intensity = 0
      if (lightningLight2Node) lightningLight2Node.intensity = 0
      if (lightningLight3Node) lightningLight3Node.intensity = 0
      if (lightningDir) lightningDir.intensity = 0
      activeLightningStrikes = []
    }

    const timeSinceWaveStart = elapsedTime - waveStartTime
    const totalWaveDuration = waveCycleDuration + waveWaitTime

    if (timeSinceWaveStart >= totalWaveDuration) {
      waveStartTime = elapsedTime
      if (elapsedTime > nextRandomRefresh) {
        for (let i = 0; i < charRandomOffsets.length; i++) {
          charRandomOffsets[i] = Math.random() * 0.1 - 0.05
        }
        nextRandomRefresh = elapsedTime + 3.0
      }
    }

    const allChars = [...opentuiChars, ...fiveKChars]
    const jumpHeight = 3

    for (let i = 0; i < allChars.length; i++) {
      const char = allChars[i]
      const charStartTime = i * charDelay
      const charEndTime = charStartTime + charJumpDuration

      let jump = 0

      if (timeSinceWaveStart < waveCycleDuration) {
        if (timeSinceWaveStart >= charStartTime && timeSinceWaveStart <= charEndTime) {
          const jumpProgress = (timeSinceWaveStart - charStartTime) / charJumpDuration
          const rawJump = Math.sin(jumpProgress * Math.PI)
          const easedJump = Math.pow(rawJump, 0.6)
          jump = easedJump * jumpHeight * (1.0 + charRandomOffsets[i])
        }
      }

      char.bottom = Math.round(Math.max(0, jump))
    }

    await engine.drawScene(sceneRoot, framebuffer, deltaTime)
  })
}

export function destroy(renderer: CliRenderer): void {
  renderer.clearFrameCallbacks()
  for (const id of ["golden-star-main", "overlay", "gradientBand"]) {
    const child = renderer.root.getRenderable(id)
    child?.destroyRecursively()
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
