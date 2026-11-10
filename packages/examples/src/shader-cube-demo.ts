#!/usr/bin/env bun

import {
  createCliRenderer,
  CliRenderer,
  TextRenderable,
  BoxRenderable,
  FrameBufferRenderable,
  RGBA,
  DistortionEffect,
  VignetteEffect,
  CloudsEffect,
  FlamesEffect,
  RainbowTextEffect,
  CRTRollingBarEffect,
  type OptimizedBuffer,
  type KeyEvent,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import { TextureUtils } from "@opentui/three"
import {
  Scene as ThreeScene,
  Mesh as ThreeMesh,
  PerspectiveCamera,
  Color,
  DirectionalLight as ThreeDirectionalLight,
  PointLight as ThreePointLight,
  MeshPhongMaterial,
  BoxGeometry,
  AmbientLight,
} from "three"
import * as Filters from "@opentui/core"
import { ThreeCliRenderer } from "@opentui/three"
import * as Matrices from "@opentui/core"

// State management for the demo
interface ShaderCubeDemoState {
  engine: ThreeCliRenderer
  sceneRoot: ThreeScene
  cameraNode: PerspectiveCamera
  mainLightNode: ThreeDirectionalLight
  pointLightNode: ThreePointLight
  ambientLightNode: AmbientLight
  lightVisualizerMesh: ThreeMesh
  cubeMeshNode: ThreeMesh
  materials: MeshPhongMaterial[]
  distortionEffectInstance: DistortionEffect
  vignetteEffectInstance: VignetteEffect
  cloudsEffectInstance: CloudsEffect
  flamesEffectInstance: FlamesEffect
  rainbowTextEffectInstance: RainbowTextEffect
  crtRollingBarEffectInstance: CRTRollingBarEffect
  pipboyVignetteEffectInstance: VignetteEffect
  pipboyBarEffectInstance: CRTRollingBarEffect
  brightnessValue: number
  gainValue: number
  colorMatrixEffectInstance: ColorMatrixEffect
  filterFunctions: { name: string; func: ((buffer: OptimizedBuffer, deltaTime: number) => void) | null }[]
  currentFilterIndex: number
  time: number
  lightColorMode: number
  rotationEnabled: boolean
  showLightVisualizers: boolean
  customLightsEnabled: boolean
  currentMaterial: number
  manualMaterialSelection: boolean
  specularMapEnabled: boolean
  normalMapEnabled: boolean
  emissiveMapEnabled: boolean
  parentContainer: BoxRenderable
  backgroundBox: BoxRenderable
  lightVizText: TextRenderable
  lightColorText: TextRenderable
  customLightsText: TextRenderable
  materialToggleText: TextRenderable
  textureEffectsText: TextRenderable
  filterStatusText: TextRenderable
  param1StatusText: TextRenderable
  param2StatusText: TextRenderable
  controlsText: TextRenderable
  keyHandler: (key: KeyEvent) => void
  resizeHandler: (width: number, height: number) => void
  frameCallbackId: boolean
}

let demoState: ShaderCubeDemoState | null = null

export async function run(renderer: CliRenderer): Promise<void> {
  renderer.start()
  const WIDTH = renderer.terminalWidth
  const HEIGHT = renderer.terminalHeight
  const CAM_DISTANCE = 3.5
  const CAMERA_PAN_STEP = 0.2
  const CAMERA_ZOOM_STEP = 0.35
  const rotationSpeed = [0.2, 0.4, 0.1]

  const lightColors = [
    { color: [255, 220, 180], name: "Warm" },
    { color: [180, 220, 255], name: "Cool" },
    { color: [255, 100, 100], name: "Red" },
    { color: [100, 255, 100], name: "Green" },
    { color: [100, 100, 255], name: "Blue" },
    { color: [255, 255, 100], name: "Yellow" },
  ]

  // Create parent container for all UI elements
  const parentContainer = new BoxRenderable(renderer, {
    id: "shader-cube-container",
    zIndex: 10,
  })
  renderer.root.add(parentContainer)

  // Initialize effect instances
  const distortionEffectInstance = new DistortionEffect()
  const vignetteEffectInstance = new VignetteEffect()
  const cloudsEffectInstance = new CloudsEffect(0.27, 0.001, 0.75, 1.0)
  const flamesEffectInstance = new FlamesEffect(0.04, 0.02, 0.9)
  const rainbowTextEffectInstance = new RainbowTextEffect(0.006, 1.0, 1.0, 10.0)
  const crtRollingBarEffectInstance = new CRTRollingBarEffect(0.8, 0.1, 0.4, 0.2)

  // Pipboy-specific instances (decoupled from other effects)
  const pipboyVignetteEffectInstance = new VignetteEffect(0.75)
  const pipboyBarEffectInstance = new CRTRollingBarEffect(2.5, 0.08, 0.75, 0.15)

  // Simple value-based brightness and gain (no class instances)
  let brightnessValue = 0.0
  let gainValue = 1.0

  // Helper function to create right-half cell masks for selective saturation
  function createRightHalfCellMask(width: number, height: number): Float32Array {
    const rightHalfWidth = Math.floor(width / 2)
    const rightHalfPixels = rightHalfWidth * height
    const cellMask = new Float32Array(rightHalfPixels * 3)
    let i = 0
    for (let y = 0; y < height; y++) {
      for (let x = Math.floor(width / 2); x < width; x++) {
        cellMask[i++] = x
        cellMask[i++] = y
        cellMask[i++] = 1
      }
    }
    return cellMask
  }

  // Full screen saturation mode toggle (null cellMask = uniform)
  let saturationFullScreen = false

  // Saturation state variables
  let saturationValue = 1.0
  let saturationCellMask: Float32Array | null = createRightHalfCellMask(WIDTH, HEIGHT)

  // Registry of all available color matrices with their display names
  const colorMatrixRegistry: { name: string; matrix: Float32Array }[] = [
    { name: "Sepia", matrix: Matrices.SEPIA_MATRIX },
    { name: "Protanopia Sim", matrix: Matrices.PROTANOPIA_SIM_MATRIX },
    { name: "Deuteranopia Sim", matrix: Matrices.DEUTERANOPIA_SIM_MATRIX },
    { name: "Tritanopia Sim", matrix: Matrices.TRITANOPIA_SIM_MATRIX },
    { name: "Achromatopsia", matrix: Matrices.ACHROMATOPSIA_MATRIX },
    { name: "Protanopia Comp", matrix: Matrices.PROTANOPIA_COMP_MATRIX },
    { name: "Deuteranopia Comp", matrix: Matrices.DEUTERANOPIA_COMP_MATRIX },
    { name: "Tritanopia Comp", matrix: Matrices.TRITANOPIA_COMP_MATRIX },
    // Creative effects
    { name: "Technicolor", matrix: Matrices.TECHNICOLOR_MATRIX },
    { name: "Solarization", matrix: Matrices.SOLARIZATION_MATRIX },
    { name: "Synthwave", matrix: Matrices.SYNTHWAVE_MATRIX },
    { name: "Greenscale", matrix: Matrices.GREENSCALE_MATRIX },
    { name: "Grayscale", matrix: Matrices.GRAYSCALE_MATRIX },
    { name: "Invert", matrix: Matrices.INVERT_MATRIX },
  ]

  // ColorMatrix effect that can cycle through all matrices
  class ColorMatrixEffect {
    private currentIndex = 0

    public get currentMatrixName(): string {
      return colorMatrixRegistry[this.currentIndex].name
    }

    public apply(buffer: OptimizedBuffer): void {
      const { matrix } = colorMatrixRegistry[this.currentIndex]
      buffer.colorMatrixUniform(matrix, 1.0)
    }

    public nextMatrix(): void {
      this.currentIndex = (this.currentIndex + 1) % colorMatrixRegistry.length
    }

    public previousMatrix(): void {
      this.currentIndex = (this.currentIndex - 1 + colorMatrixRegistry.length) % colorMatrixRegistry.length
    }
  }

  const colorMatrixEffectInstance = new ColorMatrixEffect()

  const filterFunctions: { name: string; func: ((buffer: OptimizedBuffer, deltaTime: number) => void) | null }[] = [
    { name: "None", func: null },
    { name: "Scanlines", func: (buf, _dt) => Filters.applyScanlines(buf, 0.85) },
    { name: "Vignette", func: vignetteEffectInstance.apply.bind(vignetteEffectInstance) },
    { name: "Color Matrix", func: colorMatrixEffectInstance.apply.bind(colorMatrixEffectInstance) },
    { name: "Noise", func: (buf, _dt) => Filters.applyNoise(buf, 0.05) },
    { name: "Chromatic Aberration", func: (buf, _dt) => Filters.applyChromaticAberration(buf, 2) },
    { name: "ASCII Art", func: (buf, _dt) => Filters.applyAsciiArt(buf) },
    { name: "Distortion", func: distortionEffectInstance.apply.bind(distortionEffectInstance) },
    { name: "Clouds", func: cloudsEffectInstance.apply.bind(cloudsEffectInstance) },
    { name: "Flames", func: flamesEffectInstance.apply.bind(flamesEffectInstance) },
    { name: "Rainbow Text", func: rainbowTextEffectInstance.apply.bind(rainbowTextEffectInstance) },
    { name: "CRT Rolling Bar", func: crtRollingBarEffectInstance.apply.bind(crtRollingBarEffectInstance) },
    {
      name: "Pipboy",
      func: (buf, dt) => {
        pipboyVignetteEffectInstance.apply(buf)
        buf.colorMatrixUniform(Matrices.GREENSCALE_MATRIX, 1.0)
        pipboyBarEffectInstance.apply(buf, dt)
      },
    },
    { name: "Brightness", func: (buf, _dt) => Filters.applyBrightness(buf, brightnessValue) },
    { name: "Gain", func: (buf, _dt) => Filters.applyGain(buf, gainValue) },
    {
      name: "Saturation",
      func: (buf, _dt) => Filters.applySaturation(buf, saturationCellMask ?? undefined, saturationValue),
    },
  ]

  // Box in the background to show alpha channel works
  const backgroundBox = new BoxRenderable(renderer, {
    id: "shader-cube-box",
    position: "absolute",
    left: 5,
    top: 5,
    width: WIDTH - 10,
    height: HEIGHT - 10,
    backgroundColor: "#131336",
    zIndex: 0,
    borderStyle: "single",
    borderColor: "#FFFFFF",
    title: "Shader Cube Demo",
    titleAlignment: "center",
    border: true,
  })
  parentContainer.add(backgroundBox)

  const framebufferRenderable = new FrameBufferRenderable(renderer, {
    id: "shader-cube-main",
    width: WIDTH,
    height: HEIGHT,
    zIndex: 10,
    respectAlpha: true,
  })
  renderer.root.add(framebufferRenderable)
  const { frameBuffer: framebuffer } = framebufferRenderable

  const engine = new ThreeCliRenderer(renderer, {
    width: WIDTH,
    height: HEIGHT,
    focalLength: 8,
    backgroundColor: RGBA.fromInts(0, 0, 0, 0),
    alpha: true,
  })
  await engine.init()

  const sceneRoot = new ThreeScene()

  const mainLightNode = new ThreeDirectionalLight(new Color(1, 1, 1), 0.8)
  mainLightNode.position.set(-10, -5, 1)
  mainLightNode.target.position.set(0, 0, 0)
  mainLightNode.name = "main_light"

  sceneRoot.add(mainLightNode)
  sceneRoot.add(mainLightNode.target)

  const pointLightNode = new ThreePointLight(new Color(1, 220 / 255, 180 / 255), 2.0, 4)
  pointLightNode.position.set(1.5, 0, 0)
  pointLightNode.name = "point_light"
  sceneRoot.add(pointLightNode)

  const ambientLightNode = new AmbientLight(new Color(0.25, 0.25, 0.25), 1)
  ambientLightNode.name = "ambient_light"
  sceneRoot.add(ambientLightNode)

  const lightVisualizerGeometry = new BoxGeometry(0.2, 0.2, 0.2)
  const lightVisualizerMaterial = new MeshPhongMaterial({
    color: 0x000000,
    emissive: new Color(1.0, 0.8, 0.4),
    emissiveIntensity: 1.0,
    shininess: 0,
  })
  const lightVisualizerMesh = new ThreeMesh(lightVisualizerGeometry, lightVisualizerMaterial)
  lightVisualizerMesh.name = "light_viz"
  lightVisualizerMesh.position.copy(pointLightNode.position)
  sceneRoot.add(lightVisualizerMesh)

  // Create textures
  const redTexture = TextureUtils.createCheckerboard(
    256,
    new Color(255 / 255, 40 / 255, 40 / 255),
    new Color(180 / 255, 10 / 255, 10 / 255),
  )
  const greenTexture = TextureUtils.createCheckerboard(
    256,
    new Color(40 / 255, 255 / 255, 40 / 255),
    new Color(10 / 255, 180 / 255, 10 / 255),
  )
  const blueTexture = TextureUtils.createCheckerboard(
    256,
    new Color(40 / 255, 40 / 255, 255 / 255),
    new Color(10 / 255, 10 / 255, 180 / 255),
  )
  const yellowTexture = TextureUtils.createCheckerboard(
    256,
    new Color(255 / 255, 255 / 255, 40 / 255),
    new Color(180 / 255, 180 / 255, 10 / 255),
  )
  const cyanTexture = TextureUtils.createCheckerboard(
    256,
    new Color(40 / 255, 255 / 255, 255 / 255),
    new Color(10 / 255, 180 / 255, 180 / 255),
  )
  const magentaTexture = TextureUtils.createCheckerboard(
    256,
    new Color(255 / 255, 40 / 255, 255 / 255),
    new Color(180 / 255, 10 / 255, 180 / 255),
  )
  const specularMapTexture = TextureUtils.createGradient(
    256,
    new Color(1, 1, 1),
    new Color(0.2, 0.2, 0.2),
    "horizontal",
  )
  const emissiveMapTexture = TextureUtils.createGradient(256, new Color(1, 0.6, 0), new Color(0, 0, 0), "radial")
  const normalMapTexture = TextureUtils.createNoise(
    256,
    2,
    3,
    new Color(127 / 255, 127 / 255, 255 / 255),
    new Color(127 / 255, 127 / 255, 127 / 255),
  )

  const materials: MeshPhongMaterial[] = [
    new MeshPhongMaterial({ map: redTexture, shininess: 30, specular: new Color(0.8, 0.8, 0.8) }),
    new MeshPhongMaterial({ map: greenTexture, shininess: 30, specular: new Color(0.8, 0.8, 0.8) }),
    new MeshPhongMaterial({ map: blueTexture, shininess: 30, specular: new Color(0.8, 0.8, 0.8) }),
    new MeshPhongMaterial({ map: yellowTexture, shininess: 30, specular: new Color(0.8, 0.8, 0.8) }),
    new MeshPhongMaterial({ map: cyanTexture, shininess: 30, specular: new Color(0.8, 0.8, 0.8) }),
    new MeshPhongMaterial({ map: magentaTexture, shininess: 30, specular: new Color(0.8, 0.8, 0.8) }),
    new MeshPhongMaterial({
      color: new Color(1, 1, 1),
      specular: new Color(1, 1, 1),
      shininess: 80,
    }),
  ]

  const cubeGeometry = new BoxGeometry(1.0, 1.0, 1.0)
  const cubeMeshNode = new ThreeMesh(cubeGeometry, materials[0])
  cubeMeshNode.name = "cube"

  sceneRoot.add(cubeMeshNode)

  const cameraNode = new PerspectiveCamera(45, engine.aspectRatio, 1.0, 100.0)
  cameraNode.position.set(0, 0, CAM_DISTANCE)
  cameraNode.name = "main_camera"

  sceneRoot.add(cameraNode)
  engine.setActiveCamera(cameraNode)

  // Initialize state variables
  let currentFilterIndex = 0
  let time = 0
  let lightColorMode = 0
  let rotationEnabled = true
  let showLightVisualizers = true
  let customLightsEnabled = true
  let currentMaterial = 0
  let manualMaterialSelection = false
  let specularMapEnabled = false
  let normalMapEnabled = false
  let emissiveMapEnabled = false

  // Create UI elements
  let uiLine = 0
  const lightVizText = new TextRenderable(renderer, {
    id: "shader-light-viz",
    content: "Light Visualization: ON (V to toggle)",
    position: "absolute",
    left: 0,
    top: uiLine++,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(lightVizText)

  const lightColorText = new TextRenderable(renderer, {
    id: "shader-light-color",
    content: "Point Light: Warm (C to change)",
    position: "absolute",
    left: 0,
    top: uiLine++,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(lightColorText)

  const customLightsText = new TextRenderable(renderer, {
    id: "shader-custom-lights",
    content: "Custom Lights: ON (L to toggle)",
    position: "absolute",
    left: 0,
    top: uiLine++,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(customLightsText)

  const materialToggleText = new TextRenderable(renderer, {
    id: "shader-material-toggle",
    content: "Material: Auto-cycling (M to toggle, N to change)",
    position: "absolute",
    left: 0,
    top: uiLine++,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(materialToggleText)

  const textureEffectsText = new TextRenderable(renderer, {
    id: "shader-texture-effects",
    content: "Texture Effects: P-Specular [OFF] | B-Normal [OFF] | I-Emissive [OFF]",
    position: "absolute",
    left: 0,
    top: uiLine++,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(textureEffectsText)

  const filterStatusText = new TextRenderable(renderer, {
    id: "shader-filter-status",
    content: `Filter: ${filterFunctions[currentFilterIndex].name} (J/K to cycle)`,
    position: "absolute",
    left: 0,
    top: uiLine++,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(filterStatusText)

  const param1StatusText = new TextRenderable(renderer, {
    id: "shader-param1-status",
    content: ``,
    position: "absolute",
    left: 0,
    top: uiLine++,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  param1StatusText.visible = false
  parentContainer.add(param1StatusText)

  const param2StatusText = new TextRenderable(renderer, {
    id: "shader-param2-status",
    content: ``,
    position: "absolute",
    left: 0,
    top: uiLine++,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  param2StatusText.visible = false
  parentContainer.add(param2StatusText)

  const controlsText = new TextRenderable(renderer, {
    id: "shader-controls",
    content:
      "WASD: Move | QE: Rotate | ZX: Zoom | V: Light Viz | C: Light Color | L: Lights | M/N: Material | P/B/I: Maps | R: Reset | Space: Rotation | J/K Filter | [/]{/} Params | T: Saturation Mode",
    position: "absolute",
    left: 0,
    top: HEIGHT - 2,
    fg: "#FFFFFF",
    zIndex: 20,
  })
  parentContainer.add(controlsText)

  function updateParameterUI() {
    const selectedFilter = filterFunctions[currentFilterIndex]
    let param1Text = ""
    let param1Visible = false

    switch (selectedFilter.name) {
      case "Distortion":
        param1Text = `Distortion Chance: ${distortionEffectInstance.glitchChancePerSecond.toFixed(2)} ([/])`
        param1Visible = true
        break
      case "Vignette":
        param1Text = `Vignette Strength: ${vignetteEffectInstance.strength.toFixed(2)} ([/])`
        param1Visible = true
        break
      case "Brightness":
        param1Text = `Brightness Factor: ${brightnessValue.toFixed(2)} ([/])`
        param1Visible = true
        break
      case "Gain":
        param1Text = `Gain Factor: ${gainValue.toFixed(2)} ([/])`
        param1Visible = true
        break
      case "Saturation":
        param1Text = `Saturation: ${saturationValue.toFixed(2)} (T: ${saturationFullScreen ? "Full" : "Half"}) ([/])`
        param1Visible = true
        break
      case "Color Matrix":
        param1Text = `Matrix: ${colorMatrixEffectInstance.currentMatrixName} ([/] to cycle)`
        param1Visible = true
        break
      case "Clouds":
        param1Text = `Clouds: scale=${cloudsEffectInstance.scale.toFixed(3)} ([/] to adjust)`
        param2StatusText.content = `speed=${cloudsEffectInstance.speed.toFixed(3)} ({/} to adjust)`
        param1Visible = true
        param2StatusText.visible = true
        break
      case "Flames":
        param1Text = `Flames: scale=${flamesEffectInstance.scale.toFixed(3)} ([/] to adjust)`
        param2StatusText.content = `speed=${flamesEffectInstance.speed.toFixed(3)} ({/} to adjust)`
        param1Visible = true
        param2StatusText.visible = true
        break
      case "Rainbow Text":
        param1Text = `Rainbow: speed=${rainbowTextEffectInstance.speed.toFixed(3)} ([/] to adjust)`
        param2StatusText.content = `repeats=${rainbowTextEffectInstance.repeats.toFixed(1)} ({/} to adjust)`
        param1Visible = true
        param2StatusText.visible = true
        break
      case "CRT Rolling Bar":
        param1Text = `CRT Bar: speed=${crtRollingBarEffectInstance.speed.toFixed(2)} ([/] to adjust)`
        param2StatusText.content = `intensity=${crtRollingBarEffectInstance.intensity.toFixed(2)} ({/} to adjust)`
        param1Visible = true
        param2StatusText.visible = true
        break
      case "Pipboy":
        param1Text = `Pipboy: bar speed=${pipboyBarEffectInstance.speed.toFixed(2)} ([/] to adjust)`
        param2StatusText.content = `vignette=${pipboyVignetteEffectInstance.strength.toFixed(2)} ({/} to adjust)`
        param1Visible = true
        param2StatusText.visible = true
        break
    }

    param1StatusText.content = param1Text
    param1StatusText.visible = param1Visible
    if (
      selectedFilter.name !== "Clouds" &&
      selectedFilter.name !== "Flames" &&
      selectedFilter.name !== "Rainbow Text" &&
      selectedFilter.name !== "CRT Rolling Bar" &&
      selectedFilter.name !== "Pipboy"
    ) {
      param2StatusText.content = ""
      param2StatusText.visible = false
    }
  }

  function updateTextureEffectsUI() {
    textureEffectsText.content = `Texture Effects: P-Specular [${specularMapEnabled ? "ON" : "OFF"}] | B-Normal [${normalMapEnabled ? "ON" : "OFF"}] | I-Emissive [${emissiveMapEnabled ? "ON" : "OFF"}]`
  }

  const keyHandler = (key: KeyEvent) => {
    const cubeObject = sceneRoot.getObjectByName("cube") as ThreeMesh | undefined

    if (key.name === "w") cameraNode.translateY(CAMERA_PAN_STEP)
    else if (key.name === "s") cameraNode.translateY(-CAMERA_PAN_STEP)
    else if (key.name === "a") cameraNode.translateX(-CAMERA_PAN_STEP)
    else if (key.name === "d") cameraNode.translateX(CAMERA_PAN_STEP)
    if (key.name === "q") cameraNode.rotateY(0.1)
    else if (key.name === "e") cameraNode.rotateY(-0.1)
    if (key.name === "z") cameraNode.translateZ(CAMERA_ZOOM_STEP)
    else if (key.name === "x") cameraNode.translateZ(-CAMERA_ZOOM_STEP)
    if (key.name === "r") {
      cameraNode.position.set(0, 0, CAM_DISTANCE)
      cameraNode.rotation.set(0, 0, 0)
      cameraNode.lookAt(0, 0, 0)
    }
    if (key.name === "space") rotationEnabled = !rotationEnabled

    // Toggle light visualization
    if (key.name === "v") {
      showLightVisualizers = !showLightVisualizers
      const vizObject = sceneRoot.getObjectByName("light_viz")
      if (vizObject) {
        vizObject.visible = showLightVisualizers
      }
      lightVizText.content = `Light Visualization: ${showLightVisualizers ? "ON" : "OFF"} (V to toggle)`
    }

    // Add light color cycling
    if (key.name === "c") {
      lightColorMode = (lightColorMode + 1) % lightColors.length
      const colorInfo = lightColors[lightColorMode]

      if (pointLightNode) {
        pointLightNode.color.setRGB(colorInfo.color[0] / 255, colorInfo.color[1] / 255, colorInfo.color[2] / 255)

        const vizObject = sceneRoot.getObjectByName("light_viz") as ThreeMesh | undefined
        if (vizObject && vizObject.material instanceof MeshPhongMaterial) {
          vizObject.material.emissive.setRGB(
            colorInfo.color[0] / 255,
            colorInfo.color[1] / 255,
            colorInfo.color[2] / 255,
          )
        }
      }
      lightColorText.content = `Point Light: ${colorInfo.name} (C to change)`
    }

    // Toggle custom lights
    if (key.name === "l") {
      customLightsEnabled = !customLightsEnabled
      if (mainLightNode) mainLightNode.visible = customLightsEnabled
      if (pointLightNode) pointLightNode.visible = customLightsEnabled
      customLightsText.content = `Custom Lights: ${customLightsEnabled ? "ON" : "OFF"} (L to toggle)`
    }

    // Material toggling
    if (key.name === "m") {
      manualMaterialSelection = !manualMaterialSelection
      materialToggleText.content = `Material: ${manualMaterialSelection ? "Manual" : "Auto-cycling"} (M to toggle, N to change)`
    }
    if (key.name === "n") {
      currentMaterial = (currentMaterial + 1) % materials.length
      materialToggleText.content = `Material: ${manualMaterialSelection ? "Manual" : "Auto-cycling"} (#${currentMaterial}${currentMaterial === 6 ? " - White" : ""}) (M/N)`
      if (cubeObject) {
        const newMaterialInstance = materials[currentMaterial]
        cubeObject.material = newMaterialInstance
      }
    }

    // Toggle super sampling
    if (key.name === "u") {
      engine.toggleSuperSampling()
    }

    // Cycle through region modes for current filter (if applicable)
    // NOTE: Region cycling removed - effects now apply to entire buffer
    // Previously handled by key 'h'

    // Toggle debug mode for console caller info
    if (key.name === "o") {
      renderer.console.toggle()
    }

    // Toggle texture effects
    let effectsChanged = false
    if (key.name === "p") {
      specularMapEnabled = !specularMapEnabled
      effectsChanged = true
    } else if (key.name === "b") {
      normalMapEnabled = !normalMapEnabled
      effectsChanged = true
    } else if (key.name === "i") {
      emissiveMapEnabled = !emissiveMapEnabled
      effectsChanged = true
    }

    if (effectsChanged) {
      if (cubeObject) {
        const material = cubeObject.material as MeshPhongMaterial
        material.specularMap = specularMapEnabled ? specularMapTexture : null
        material.normalMap = normalMapEnabled ? normalMapTexture : null
        material.emissiveMap = emissiveMapEnabled ? emissiveMapTexture : null
        material.emissive = new Color(0, 0, 0)
        material.emissiveIntensity = emissiveMapEnabled ? 0.7 : 0.0
        material.needsUpdate = true
      }
      updateTextureEffectsUI()
    }

    let filterChanged = false
    if (key.name === "j") {
      currentFilterIndex = (currentFilterIndex - 1 + filterFunctions.length) % filterFunctions.length
      filterChanged = true
    } else if (key.name === "k") {
      currentFilterIndex = (currentFilterIndex + 1) % filterFunctions.length
      filterChanged = true
    }

    if (filterChanged) {
      const selectedFilter = filterFunctions[currentFilterIndex]
      renderer.clearPostProcessFns()
      if (selectedFilter.func) {
        renderer.addPostProcessFn(selectedFilter.func)
      }
      filterStatusText.content = `Filter: ${selectedFilter.name} (J/K to cycle)`
      updateParameterUI()
    }

    let paramChanged = false

    if (key.name === "t" && filterFunctions[currentFilterIndex].name === "Saturation") {
      saturationFullScreen = !saturationFullScreen
      if (saturationFullScreen) {
        // null cellMask = uniform saturation (uses colorMatrixUniform, much faster)
        saturationCellMask = null
      } else {
        // cellMask = selective saturation on right half
        saturationCellMask = createRightHalfCellMask(renderer.terminalWidth, renderer.terminalHeight)
      }
      paramChanged = true
    }

    // Parameter Adjustment Keys ([ / ] and { / })
    const currentFilterName = filterFunctions[currentFilterIndex].name
    const height = renderer.terminalHeight

    if (key.name === "[") {
      switch (currentFilterName) {
        case "Distortion":
          distortionEffectInstance.glitchChancePerSecond = Math.max(
            0,
            distortionEffectInstance.glitchChancePerSecond - 0.1,
          )
          paramChanged = true
          break
        case "Vignette":
          vignetteEffectInstance.strength = Math.max(0, vignetteEffectInstance.strength - 0.05)
          paramChanged = true
          break
        case "Brightness":
          brightnessValue = Math.max(-1.0, brightnessValue - 0.05)
          paramChanged = true
          break
        case "Gain":
          gainValue = Math.max(0, gainValue - 0.05)
          paramChanged = true
          break
        case "Saturation":
          saturationValue = Math.max(0, saturationValue - 0.05)
          paramChanged = true
          break
        case "Color Matrix":
          colorMatrixEffectInstance.previousMatrix()
          paramChanged = true
          break
        case "Clouds":
          cloudsEffectInstance.scale = Math.max(0.05, cloudsEffectInstance.scale - 0.01)
          paramChanged = true
          break
        case "Flames":
          flamesEffectInstance.scale = Math.max(0.01, flamesEffectInstance.scale - 0.002)
          paramChanged = true
          break
        case "Rainbow Text":
          rainbowTextEffectInstance.speed = Math.max(0, rainbowTextEffectInstance.speed - 0.001)
          paramChanged = true
          break
        case "CRT Rolling Bar":
          crtRollingBarEffectInstance.speed = Math.max(0.1, crtRollingBarEffectInstance.speed - 0.1)
          paramChanged = true
          break
        case "Pipboy":
          pipboyBarEffectInstance.speed = Math.max(0.1, pipboyBarEffectInstance.speed - 0.1)
          paramChanged = true
          break
      }
    } else if (key.name === "]") {
      switch (currentFilterName) {
        case "Distortion":
          distortionEffectInstance.glitchChancePerSecond = Math.min(
            25,
            distortionEffectInstance.glitchChancePerSecond + 0.1,
          )
          paramChanged = true
          break
        case "Vignette":
          vignetteEffectInstance.strength = Math.min(5, vignetteEffectInstance.strength + 0.05)
          paramChanged = true
          break
        case "Brightness":
          brightnessValue = Math.min(1.0, brightnessValue + 0.05)
          paramChanged = true
          break
        case "Gain":
          gainValue = Math.min(50, gainValue + 0.05)
          paramChanged = true
          break
        case "Saturation":
          saturationValue = Math.min(10, saturationValue + 0.05)
          paramChanged = true
          break
        case "Color Matrix":
          colorMatrixEffectInstance.nextMatrix()
          paramChanged = true
          break
        case "Clouds":
          cloudsEffectInstance.scale = Math.min(1.0, cloudsEffectInstance.scale + 0.01)
          paramChanged = true
          break
        case "Flames":
          flamesEffectInstance.scale = Math.min(0.1, flamesEffectInstance.scale + 0.002)
          paramChanged = true
          break
        case "Rainbow Text":
          rainbowTextEffectInstance.speed = Math.min(0.5, rainbowTextEffectInstance.speed + 0.001)
          paramChanged = true
          break
        case "CRT Rolling Bar":
          crtRollingBarEffectInstance.speed = Math.min(5.0, crtRollingBarEffectInstance.speed + 0.1)
          paramChanged = true
          break
        case "Pipboy":
          pipboyBarEffectInstance.speed = Math.min(10.0, pipboyBarEffectInstance.speed + 0.1)
          paramChanged = true
          break
      }
    }

    // Parameter 2 Adjustment ({/})
    if (key.name === "{") {
      switch (currentFilterName) {
        case "Distortion":
          distortionEffectInstance.maxGlitchLines = Math.max(0, distortionEffectInstance.maxGlitchLines - 1)
          paramChanged = true
          break
        case "Clouds":
          cloudsEffectInstance.speed = Math.max(0.0, cloudsEffectInstance.speed - 0.001)
          paramChanged = true
          break
        case "Flames":
          flamesEffectInstance.speed = Math.max(0.005, flamesEffectInstance.speed - 0.001)
          paramChanged = true
          break
        case "Rainbow Text":
          rainbowTextEffectInstance.repeats = Math.max(1.0, rainbowTextEffectInstance.repeats - 0.5)
          paramChanged = true
          break
        case "CRT Rolling Bar":
          crtRollingBarEffectInstance.intensity = Math.max(0.0, crtRollingBarEffectInstance.intensity - 0.05)
          paramChanged = true
          break
        case "Pipboy":
          pipboyVignetteEffectInstance.strength = Math.max(0.0, pipboyVignetteEffectInstance.strength - 0.05)
          paramChanged = true
          break
      }
    } else if (key.name === "}") {
      switch (currentFilterName) {
        case "Distortion":
          distortionEffectInstance.maxGlitchLines = Math.min(height - 1, distortionEffectInstance.maxGlitchLines + 1)
          paramChanged = true
          break
        case "Clouds":
          cloudsEffectInstance.speed = Math.min(0.02, cloudsEffectInstance.speed + 0.001)
          paramChanged = true
          break
        case "Flames":
          flamesEffectInstance.speed = Math.min(0.1, flamesEffectInstance.speed + 0.001)
          paramChanged = true
          break
        case "Rainbow Text":
          rainbowTextEffectInstance.repeats = Math.min(20.0, rainbowTextEffectInstance.repeats + 0.5)
          paramChanged = true
          break
        case "CRT Rolling Bar":
          crtRollingBarEffectInstance.intensity = Math.min(1.0, crtRollingBarEffectInstance.intensity + 0.05)
          paramChanged = true
          break
        case "Pipboy":
          pipboyVignetteEffectInstance.strength = Math.min(3.0, pipboyVignetteEffectInstance.strength + 0.05)
          paramChanged = true
          break
      }
    }

    if (paramChanged) {
      updateParameterUI()
    }
  }

  const resizeHandler = (width: number, height: number) => {
    framebuffer.resize(width, height)

    if (cameraNode) {
      cameraNode.aspect = engine.aspectRatio
      cameraNode.updateProjectionMatrix()
    }

    backgroundBox.width = width - 10
    backgroundBox.height = height - 10
    controlsText.y = height - 2
  }

  renderer.keyInput.on("keypress", keyHandler)
  renderer.on("resize", resizeHandler)

  renderer.setFrameCallback(async (deltaMs) => {
    const deltaTime = deltaMs / 1000
    time += deltaTime
    const cubeObject = sceneRoot.getObjectByName("cube") as ThreeMesh | undefined

    if (rotationEnabled && cubeObject) {
      cubeObject.rotation.x += rotationSpeed[0] * deltaTime
      cubeObject.rotation.y += rotationSpeed[1] * deltaTime
      cubeObject.rotation.z += rotationSpeed[2] * deltaTime
    }

    if (pointLightNode) {
      const radius = 3
      const speed = 0.9
      pointLightNode.position.set(Math.sin(time * speed) * radius, 1.5, Math.cos(time * speed) * radius)

      const vizObject = sceneRoot.getObjectByName("light_viz")
      if (vizObject) {
        vizObject.position.copy(pointLightNode.position)
      }
    }

    if (cubeObject) {
      let materialIndex = currentMaterial
      if (!manualMaterialSelection) {
        materialIndex = Math.floor(time * 0.5) % (materials.length - 1)
      }

      if (materialIndex < materials.length && cubeObject.material !== materials[materialIndex]) {
        const newMaterialInstance = materials[materialIndex]
        cubeObject.material = newMaterialInstance

        const material = cubeObject.material as MeshPhongMaterial
        material.specularMap = specularMapEnabled ? specularMapTexture : null
        material.normalMap = normalMapEnabled ? normalMapTexture : null
        material.emissiveMap = emissiveMapEnabled ? emissiveMapTexture : null
        material.emissive = new Color(0, 0, 0)
        material.emissiveIntensity = emissiveMapEnabled ? 0.7 : 0.0
        material.needsUpdate = true
      }
    }

    framebuffer.clear(RGBA.fromValues(0, 0, 0, 0))
    await engine.drawScene(sceneRoot, framebuffer, deltaTime)
  })

  // Store state for cleanup
  demoState = {
    engine,
    sceneRoot,
    cameraNode,
    mainLightNode,
    pointLightNode,
    ambientLightNode,
    lightVisualizerMesh,
    cubeMeshNode,
    materials,
    distortionEffectInstance,
    vignetteEffectInstance,
    cloudsEffectInstance,
    flamesEffectInstance,
    rainbowTextEffectInstance,
    crtRollingBarEffectInstance,
    pipboyVignetteEffectInstance,
    pipboyBarEffectInstance,
    brightnessValue,
    gainValue,
    colorMatrixEffectInstance,
    filterFunctions,
    currentFilterIndex,
    time,
    lightColorMode,
    rotationEnabled,
    showLightVisualizers,
    customLightsEnabled,
    currentMaterial,
    manualMaterialSelection,
    specularMapEnabled,
    normalMapEnabled,
    emissiveMapEnabled,
    parentContainer,
    backgroundBox,
    lightVizText,
    lightColorText,
    customLightsText,
    materialToggleText,
    textureEffectsText,
    filterStatusText,
    param1StatusText,
    param2StatusText,
    controlsText,
    keyHandler,
    resizeHandler,
    frameCallbackId: true,
  }
}

export function destroy(renderer: CliRenderer): void {
  if (!demoState) return

  renderer.keyInput.off("keypress", demoState.keyHandler)
  renderer.off("resize", demoState.resizeHandler)

  if (demoState.frameCallbackId) {
    renderer.clearFrameCallbacks()
  }

  demoState.engine.destroy()
  renderer.clearPostProcessFns()

  for (const id of ["shader-cube-main", "shader-cube-container"]) {
    const child = renderer.root.getRenderable(id)
    child?.destroyRecursively()
  }

  demoState = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
  })

  await run(renderer)
  setupCommonDemoKeys(renderer)
}
