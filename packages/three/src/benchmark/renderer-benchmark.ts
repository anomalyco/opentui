#!/usr/bin/env bun

import { createCliRenderer, RGBA, TextRenderable, BoxRenderable, FrameBufferRenderable } from "@opentui/core"
import { ThreeCliRenderer } from "../WGPURenderer.js"
import { TextureUtils } from "../TextureUtils.js"
import {
  Scene as ThreeScene,
  Mesh as ThreeMesh,
  PerspectiveCamera,
  Color,
  Vector2 as ThreeVector2,
  DirectionalLight as ThreeDirectionalLight,
  PointLight as ThreePointLight,
  MeshPhongMaterial,
  BoxGeometry,
  SpotLight as ThreeSpotLight,
  AmbientLight as ThreeAmbientLight,
} from "three"
import { MeshPhongNodeMaterial } from "three/webgpu"
import { lights } from "three/tsl"
import { Command } from "commander"
import { existsSync, writeFileSync } from "node:fs"
import path, { dirname } from "node:path"
import { mkdir } from "node:fs/promises"

type MemorySnapshot = { heapUsed: number; heapTotal: number; arrayBuffers: number }

// @ts-ignore
import cratePath from "../examples/assets/crate.png" with { type: "image/png" }
// @ts-ignore
import crateEmissivePath from "../examples/assets/crate_emissive.png" with { type: "image/png" }

// Setup command line options
const program = new Command()
program
  .name("renderer-benchmark")
  .description("3D renderer benchmark for terminal")
  .option("-d, --duration <ms>", "duration of each scenario in milliseconds", "10000")
  .option("-o, --output <path>", "path to save benchmark results as JSON")
  .option("--debug", "enable debug mode with culling stats")
  .option("--no-culling", "disable frustum culling for testing")
  .parse(process.argv)

const options = program.opts()

const SCENARIO_DURATION_MS = parseInt(options.duration)

let outputPath = options.output
if (outputPath) {
  outputPath = path.resolve(process.cwd(), outputPath)
  if (existsSync(outputPath)) {
    console.error(`Error: Output file already exists: ${outputPath}`)
    process.exit(1)
  }

  try {
    const dir = dirname(outputPath)
    if (!existsSync(dir)) {
      mkdir(dir, { recursive: true })
    }
  } catch (error: any) {
    console.error(`Error: Cannot access output directory: ${error.message}`)
    process.exit(1)
  }
}

enum BenchmarkScenario {
  SingleCube = 0,
  MultipleCubes = 1,
  TexturedCubes = 2,
  Complete = 3,
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  targetFps: 60,
  gatherStats: true,
  memorySnapshotInterval: 1000,
})

const WIDTH = renderer.terminalWidth
const HEIGHT = renderer.terminalHeight

const fbRenderable = new FrameBufferRenderable(renderer, {
  id: "main",
  width: WIDTH,
  height: HEIGHT,
  zIndex: 10,
})
renderer.root.add(fbRenderable)
const { frameBuffer: framebuffer } = fbRenderable

const engine = new ThreeCliRenderer(renderer, {
  width: WIDTH,
  height: HEIGHT,
  focalLength: 8,
  backgroundColor: RGBA.fromInts(0, 0, 0, 255),
})
await engine.init()

const sceneRoot = new ThreeScene()
sceneRoot.name = "scene_root"

const mainLightNode = new ThreeDirectionalLight(new Color(1.0, 1.0, 1.0), 0.8)
mainLightNode.position.set(-2, -3, 1)
mainLightNode.target.position.set(0, 0, 0)
mainLightNode.name = "main_light"
sceneRoot.add(mainLightNode)
sceneRoot.add(mainLightNode.target)

const ambientLight = new ThreeAmbientLight(new Color(0.3, 0.3, 0.4), 0.4)
ambientLight.name = "ambient_light"
sceneRoot.add(ambientLight)

const pointLightNode = new ThreePointLight(new Color(255 / 255, 220 / 255, 180 / 255), 2.0, 300)
pointLightNode.position.set(1.5, 0, -0.5)
pointLightNode.name = "point_light"
sceneRoot.add(pointLightNode)

const redLightNode = new ThreePointLight(new Color(1.0, 0.2, 0.2), 1.5, 12)
redLightNode.position.set(-1.5, 1.0, -1.0)
redLightNode.name = "red_point_light"
sceneRoot.add(redLightNode)

const blueLightNode = new ThreePointLight(new Color(0.2, 0.2, 1.0), 1.5, 12)
blueLightNode.position.set(1.5, 2.0, -1.0)
blueLightNode.name = "blue_point_light"
sceneRoot.add(blueLightNode)

const spotLightNode = new ThreeSpotLight(new Color(1.0, 0.9, 0.8), 1.2, 25, Math.PI / 3, 0.3, 1)
spotLightNode.position.set(-8, -6, -3)
spotLightNode.target.position.set(0, 0, 0)
spotLightNode.name = "bottom_left_spotlight"
sceneRoot.add(spotLightNode)
sceneRoot.add(spotLightNode.target)

const cameraNode = new PerspectiveCamera(45, engine.aspectRatio, 1.0, 150.0)
cameraNode.position.set(0, 0, -4)
cameraNode.up.set(0, 1, 0)
cameraNode.lookAt(0, 0, 0)
cameraNode.updateMatrixWorld()
cameraNode.name = "main_camera"
sceneRoot.add(cameraNode)

const cameraLight = new ThreeDirectionalLight(new Color(0.8, 0.8, 0.7), 0.7)
cameraLight.position.set(0, 0, -4)
cameraLight.target.position.set(0, 0, 1)
cameraLight.name = "camera_light"
sceneRoot.add(cameraLight)

engine.setActiveCamera(cameraNode)

const TEST_CUBE_COUNT = 300

const uiContainer = new BoxRenderable(renderer, {
  id: "ui-container",
  zIndex: 15,
})
renderer.root.add(uiContainer)

const benchmarkStatus = new TextRenderable(renderer, {
  id: "benchmark",
  content: "Initializing benchmark...",
  zIndex: 20,
})
uiContainer.add(benchmarkStatus)

const cubeCountStatus = new TextRenderable(renderer, {
  id: "cube-count",
  content: `Test cubes outside view: ${TEST_CUBE_COUNT}`,
  position: "absolute",
  left: 0,
  top: 1,
  zIndex: 20,
})
uiContainer.add(cubeCountStatus)

if (options.debug) {
  const debugStatus = new TextRenderable(renderer, {
    id: "debug",
    content: `Culling: ${options.culling !== false ? "ON" : "OFF"}`,
    position: "absolute",
    left: 0,
    top: HEIGHT - 1,
    zIndex: 20,
  })
  uiContainer.add(debugStatus)
}

type ScenarioResult = {
  name: string
  frameCount: number
  fps: number
  averageFrameTime: number
  minFrameTime: number
  maxFrameTime: number
  stdDev: number
  memorySnapshots?: MemorySnapshot[]
}

// Benchmark state
let time = 0
let currentScenario = BenchmarkScenario.SingleCube
let benchmarkStartTime = 0
let benchmarkActive = true
const results: ScenarioResult[] = []
let currentMemorySnapshots: MemorySnapshot[] = []
let cubeMeshNodes: ThreeMesh[] = []
const RADIUS = 1
const MULTIPLE_CUBES_COUNT = 8

const singleCubeGeometry = new BoxGeometry(2.0, 2.0, 2.0)
singleCubeGeometry.computeBoundingSphere()
const multiCubeGeometry = new BoxGeometry(1.0, 1.0, 1.0)
multiCubeGeometry.computeBoundingSphere()
const cullingCubeGeometry = new BoxGeometry(0.5, 0.5, 0.5)
cullingCubeGeometry.computeBoundingSphere()

const normalMapTexture = TextureUtils.createNoise(128, 2, 3, new Color(0.5, 0.5, 1), new Color(0.5, 0.5, 0.5))

const singleCubeMaterial = new MeshPhongMaterial({
  color: 0xffffff,
  shininess: 15,
  specular: new Color(0.4, 0.4, 0.4),
  normalMap: normalMapTexture,
  normalScale: new ThreeVector2(0.3, 0.3),
})

const cullingCubeMaterial = new MeshPhongMaterial({ color: 0x555555, shininess: 10 })
let texturedMaterial: MeshPhongNodeMaterial | null = null
let multiCubeMaterials: MeshPhongMaterial[] = []
for (let i = 0; i < MULTIPLE_CUBES_COUNT; i++) {
  const baseColor = new Color()
  const hue = i / MULTIPLE_CUBES_COUNT
  baseColor.setHSL(hue, 0.6, 0.9)
  multiCubeMaterials.push(new MeshPhongMaterial({ color: baseColor, shininess: 30, reflectivity: 1.5 }))
}

function clearPreviousCubes() {
  for (const node of cubeMeshNodes) {
    sceneRoot.remove(node)
  }
  cubeMeshNodes = []
}

function updateTextContent(textId: string, content: string) {
  const textObj = uiContainer.getRenderable(textId) as TextRenderable
  if (textObj) {
    textObj.content = content
  }
}

async function setupScenario(scenario: BenchmarkScenario) {
  clearPreviousCubes()
  currentMemorySnapshots = []
  renderer.resetStats()

  switch (scenario) {
    case BenchmarkScenario.SingleCube:
      createSingleCubeScenario()
      break
    case BenchmarkScenario.MultipleCubes:
      createMultipleCubesScenario()
      break
    case BenchmarkScenario.TexturedCubes:
      await createTexturedCubesScenario()
      break
  }

  addOutOfViewCubes()
}

// Scenario 1: Single fast-rotating cube
function createSingleCubeScenario() {
  updateTextContent("benchmark", `Running Scenario 1/3: Single Fast Cube (${SCENARIO_DURATION_MS / 1000}s)`)

  const cubeMesh = new ThreeMesh(singleCubeGeometry, singleCubeMaterial)
  cubeMesh.name = "cube_1"

  cubeMesh.position.set(0, 0, 0)
  cubeMesh.rotation.set(0, 0, 0)
  cubeMesh.scale.set(1.0, 1.0, 1.0)

  sceneRoot.add(cubeMesh)
  cubeMeshNodes.push(cubeMesh)
}

// Scenario 2: Multiple moving and spinning cubes
function createMultipleCubesScenario() {
  updateTextContent("benchmark", `Running Scenario 2/3: Multiple Moving Cubes (${SCENARIO_DURATION_MS / 1000}s)`)

  blueLightNode.position.set(0, 0, 0)
  redLightNode.position.set(-1, 0, -1)
  cameraLight.intensity = 1.5
  pointLightNode.position.set(-1, 0, 0)
  pointLightNode.intensity = 3.5

  for (let i = 0; i < MULTIPLE_CUBES_COUNT; i++) {
    const angle = (i / MULTIPLE_CUBES_COUNT) * Math.PI * 2
    const x = Math.cos(angle) * RADIUS
    const y = Math.sin(angle) * RADIUS

    const cubeMesh = new ThreeMesh(multiCubeGeometry, multiCubeMaterials[i])
    cubeMesh.name = `cube_${i + 1}`

    cubeMesh.position.set(x, y, 0)
    cubeMesh.rotation.set(i * 0.2, i * 0.3, i * 0.1)
    cubeMesh.scale.set(0.8, 0.8, 0.8)

    sceneRoot.add(cubeMesh)
    cubeMeshNodes.push(cubeMesh)
  }
}

// Scenario 3: Textured cubes with emissive maps
async function createTexturedCubesScenario() {
  updateTextContent("benchmark", `Running Scenario 3/3: Textured Cubes (${SCENARIO_DURATION_MS / 1000}s)`)

  blueLightNode.position.set(1, 0, -2)
  redLightNode.position.set(-1, 0, -3)
  cameraLight.intensity = 3.0
  mainLightNode.intensity = 2.0
  pointLightNode.power = 1000
  redLightNode.power = 800
  blueLightNode.power = 800
  spotLightNode.intensity = 2.5

  const allLightsNode = lights([
    mainLightNode,
    pointLightNode,
    redLightNode,
    blueLightNode,
    spotLightNode,
    cameraLight,
    ambientLight,
  ])

  if (!texturedMaterial) {
    const imagePath = cratePath
    const emissivePath = crateEmissivePath
    const textureMap = await TextureUtils.fromFile(imagePath)
    const emissiveMap = await TextureUtils.fromFile(emissivePath)

    if (!textureMap || !emissiveMap) {
      console.error("Failed to load texture or emissive map. Skipping textured scenario.")
      createMultipleCubesScenario()
      updateTextContent("benchmark", `Scenario 3/3 SKIPPED (Texture Load Fail). Using Multi-Cube.`)
      return
    }

    texturedMaterial = new MeshPhongNodeMaterial({
      map: textureMap,
      emissiveMap: emissiveMap,
      emissive: new Color(0x000000),
      emissiveIntensity: 0.5,
      shininess: 30,
    })
    texturedMaterial.lightsNode = allLightsNode
  }

  // Create 8 cubes in a pattern using the textured material
  for (let i = 0; i < MULTIPLE_CUBES_COUNT; i++) {
    const angle = (i / MULTIPLE_CUBES_COUNT) * Math.PI * 2
    const x = Math.cos(angle) * RADIUS
    const y = Math.sin(angle) * RADIUS

    const cubeMesh = new ThreeMesh(multiCubeGeometry, texturedMaterial)
    cubeMesh.name = `cube_${i + 1}`

    cubeMesh.position.set(x, y, 0)
    cubeMesh.rotation.set(i * 0.2, i * 0.3, i * 0.1)
    cubeMesh.scale.set(0.8, 0.8, 0.8)

    sceneRoot.add(cubeMesh)
    cubeMeshNodes.push(cubeMesh)
  }
}

function addOutOfViewCubes() {
  const fov = 45 * (Math.PI / 180)
  const distance = 50
  const viewHeight = 2 * distance * Math.tan(fov / 2)
  const viewWidth = viewHeight * engine.aspectRatio
  const margin = 3.0
  const boundWidth = viewWidth * margin
  const boundHeight = viewHeight * margin

  for (let i = 0; i < TEST_CUBE_COUNT; i++) {
    let x, y, z
    const placement = i % 7
    const distMultiplier = 1 + Math.floor(i / 50)
    if (placement === 0) {
      x = -boundWidth * distMultiplier - Math.random() * 50
      y = (Math.random() * 2 - 1) * boundHeight * distMultiplier
      z = Math.random() * 30 - 15
    } else if (placement === 1) {
      x = boundWidth * distMultiplier + Math.random() * 50
      y = (Math.random() * 2 - 1) * boundHeight * distMultiplier
      z = Math.random() * 30 - 15
    } else if (placement === 2) {
      x = (Math.random() * 2 - 1) * boundWidth * distMultiplier
      y = boundHeight * distMultiplier + Math.random() * 50
      z = Math.random() * 30 - 15
    } else if (placement === 3) {
      x = (Math.random() * 2 - 1) * boundWidth * distMultiplier
      y = -boundHeight * distMultiplier - Math.random() * 50
      z = Math.random() * 30 - 15
    } else if (placement === 4) {
      x = (Math.random() * 2 - 1) * boundWidth
      y = (Math.random() * 2 - 1) * boundHeight
      z = -100 * distMultiplier - Math.random() * 100
    } else if (placement === 5) {
      x = (Math.random() * 2 - 1) * boundWidth
      y = (Math.random() * 2 - 1) * boundHeight
      z = 160 * distMultiplier + Math.random() * 100
    } else {
      x = (Math.random() > 0.5 ? 1 : -1) * boundWidth * distMultiplier
      y = (Math.random() > 0.5 ? 1 : -1) * boundHeight * distMultiplier
      z = (Math.random() > 0.5 ? 160 : -100) * distMultiplier
    }

    const cubeMesh = new ThreeMesh(cullingCubeGeometry, cullingCubeMaterial)
    cubeMesh.name = `culling_test_cube_${i}`
    cubeMesh.position.set(x, y, z)

    cubeMesh.rotation.set(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2)

    const scaleVal = 0.3 + Math.random() * 0.4
    cubeMesh.scale.set(scaleVal, scaleVal, scaleVal)

    sceneRoot.add(cubeMesh)
    cubeMeshNodes.push(cubeMesh)
  }
}

// Setup first scenario
await setupScenario(currentScenario)

renderer.setFrameCallback(async (deltaMs) => {
  const deltaTime = deltaMs / 1000

  if (benchmarkStartTime === 0) {
    benchmarkStartTime = Date.now()
    renderer.resetStats()
  }

  time += deltaTime
  const elapsedTime = Date.now() - benchmarkStartTime

  switch (currentScenario) {
    case BenchmarkScenario.SingleCube:
      if (cubeMeshNodes.length > 0) {
        const mesh = cubeMeshNodes[0]
        mesh.rotation.x += 1.5 * deltaTime
        mesh.rotation.y += 2.0 * deltaTime
        mesh.rotation.z += 0.8 * deltaTime
        if (mesh.material instanceof MeshPhongMaterial) {
          const hue = (time * 0.1) % 1
          mesh.material.color.setHSL(hue, 0.7, 0.8)
        }
      }
      break

    case BenchmarkScenario.MultipleCubes:
    case BenchmarkScenario.TexturedCubes:
      for (let i = 0; i < MULTIPLE_CUBES_COUNT; i++) {
        if (i >= cubeMeshNodes.length) continue
        const mesh = cubeMeshNodes[i]

        mesh.rotation.x += (0.5 + i * 0.1) * deltaTime
        mesh.rotation.y += (0.8 + i * 0.1) * deltaTime
        mesh.rotation.z += (0.3 + i * 0.1) * deltaTime

        const angle = time + (i / MULTIPLE_CUBES_COUNT) * Math.PI * 2
        mesh.position.x = Math.cos(angle) * RADIUS
        mesh.position.y = Math.sin(angle) * RADIUS
        mesh.position.z = Math.sin(angle * 0.5) * 2

        if (currentScenario === BenchmarkScenario.MultipleCubes && mesh.material instanceof MeshPhongMaterial) {
          const hue = (i / MULTIPLE_CUBES_COUNT + time * 0.05) % 1
          mesh.material.color.setHSL(hue, 0.6, 0.85)
        }
      }
      break
  }

  engine.drawScene(sceneRoot, framebuffer, deltaTime)

  if (benchmarkActive && elapsedTime >= SCENARIO_DURATION_MS) {
    const stats = renderer.getStats()
    let stdDev = 0
    if (stats.frameTimes.length > 0) {
      let variance = 0
      for (const ft of stats.frameTimes) {
        variance += Math.pow(ft - stats.averageFrameTime, 2)
      }
      stdDev = Math.sqrt(variance / stats.frameTimes.length)
    }
    results.push({
      name: getScenarioName(currentScenario),
      frameCount: stats.frameCount,
      fps: stats.fps,
      averageFrameTime: stats.averageFrameTime,
      minFrameTime: stats.minFrameTime,
      maxFrameTime: stats.maxFrameTime,
      stdDev: stdDev,
      memorySnapshots: [...currentMemorySnapshots],
    })
    currentScenario++
    if (currentScenario < BenchmarkScenario.Complete) {
      setupScenario(currentScenario).then(() => {
        benchmarkStartTime = Date.now()
      })
    } else {
      benchmarkActive = false
      displayBenchmarkResults()
      renderer.pause()
    }
  }
})

function getScenarioName(scenario: BenchmarkScenario): string {
  switch (scenario) {
    case BenchmarkScenario.SingleCube:
      return "Single Fast Cube"
    case BenchmarkScenario.MultipleCubes:
      return "Multiple Moving Cubes"
    case BenchmarkScenario.TexturedCubes:
      return "Textured Cubes with Emissive Maps"
    default:
      return "Unknown"
  }
}

function displayBenchmarkResults(): void {
  const resultsBox = new BoxRenderable(renderer, {
    id: "results-box",
    position: "absolute",
    left: Math.floor(WIDTH / 6),
    top: Math.floor(HEIGHT / 6),
    width: Math.floor((WIDTH * 2) / 3),
    height: Math.floor((HEIGHT * 2) / 3),
    backgroundColor: RGBA.fromInts(10, 10, 40),
    zIndex: 30,
  })
  uiContainer.add(resultsBox)

  const resultsTitle = new TextRenderable(renderer, {
    id: "results-title",
    position: "absolute",
    left: Math.floor(WIDTH / 6) + 2,
    top: Math.floor(HEIGHT / 6) + 1,
    content: "📊 BENCHMARK RESULTS 📊",
    zIndex: 31,
  })
  uiContainer.add(resultsTitle)
  let y = Math.floor(HEIGHT / 6) + 3
  for (let i = 0; i < results.length; i++) {
    const result = results[i]
    const resultHeader = new TextRenderable(renderer, {
      id: `result-header-${i}`,
      position: "absolute",
      left: Math.floor(WIDTH / 6) + 2,
      top: y++,
      content: `Scenario ${i + 1}: ${result.name}`,
      zIndex: 31,
    })
    uiContainer.add(resultHeader)

    const statLines = [
      `  • Frames: ${result.frameCount} | FPS: ${result.fps}`,
      `  • Frame Time: ${result.averageFrameTime.toFixed(2)}ms (min: ${result.minFrameTime.toFixed(2)}ms, max: ${result.maxFrameTime.toFixed(2)}ms)`,
      `  • Standard Deviation: ${result.stdDev.toFixed(2)}ms`,
    ]
    for (let j = 0; j < statLines.length; j++) {
      const statText = new TextRenderable(renderer, {
        id: `result-stat-${i}-${j}`,
        position: "absolute",
        left: Math.floor(WIDTH / 6) + 2,
        top: y + j,
        content: statLines[j],
        zIndex: 31,
      })
      uiContainer.add(statText)
    }
    y += statLines.length

    if (result.memorySnapshots && result.memorySnapshots.length > 0) {
      const heapUsedValues = result.memorySnapshots.map((s) => s.heapUsed).sort((a, b) => a - b)
      const minMem = heapUsedValues[0]
      const maxMem = heapUsedValues[heapUsedValues.length - 1]
      const avgMem = heapUsedValues.reduce((sum, val) => sum + val, 0) / heapUsedValues.length
      const midIndex = Math.floor(heapUsedValues.length / 2)
      const medianMem =
        heapUsedValues.length % 2 === 0
          ? (heapUsedValues[midIndex - 1] + heapUsedValues[midIndex]) / 2
          : heapUsedValues[midIndex]

      const arrayBufferValues = result.memorySnapshots.map((s) => s.arrayBuffers).sort((a, b) => a - b)
      const minAB = arrayBufferValues[0]
      const maxAB = arrayBufferValues[arrayBufferValues.length - 1]
      const avgAB = arrayBufferValues.reduce((sum, val) => sum + val, 0) / arrayBufferValues.length
      const midABIndex = Math.floor(arrayBufferValues.length / 2)
      const medianAB =
        arrayBufferValues.length % 2 === 0
          ? (arrayBufferValues[midABIndex - 1] + arrayBufferValues[midABIndex]) / 2
          : arrayBufferValues[midABIndex]

      const memStatLines = [
        `  • Heap Used: ${(avgMem / 1024 / 1024).toFixed(2)}MB avg`,
        `    (min: ${(minMem / 1024 / 1024).toFixed(2)}MB, max: ${(maxMem / 1024 / 1024).toFixed(2)}MB, median: ${(medianMem / 1024 / 1024).toFixed(2)}MB)`,
        `  • ArrayBuffers: ${(avgAB / 1024 / 1024).toFixed(2)}MB avg`,
        `    (min: ${(minAB / 1024 / 1024).toFixed(2)}MB, max: ${(maxAB / 1024 / 1024).toFixed(2)}MB, median: ${(medianAB / 1024 / 1024).toFixed(2)}MB)`,
      ]
      for (let j = 0; j < memStatLines.length; j++) {
        const memStatText = new TextRenderable(renderer, {
          id: `result-mem-stat-${i}-${j}`,
          position: "absolute",
          left: Math.floor(WIDTH / 6) + 2,
          top: y + j,
          content: memStatLines[j],
          zIndex: 31,
        })
        uiContainer.add(memStatText)
      }
      y += memStatLines.length
    }
    y++
  }
  if (results.length > 1) {
    const comparisonTitle = new TextRenderable(renderer, {
      id: "results-comparison",
      position: "absolute",
      left: Math.floor(WIDTH / 6) + 2,
      top: y++,
      content: "Performance Comparison:",
      zIndex: 31,
    })
    uiContainer.add(comparisonTitle)

    for (let i = 1; i < results.length; i++) {
      const basePerf = results[0].averageFrameTime
      const currentPerf = results[i].averageFrameTime
      const ratio = currentPerf / basePerf
      const percent = ((ratio - 1) * 100).toFixed(1)
      const compareText = `  • ${results[i].name}: ${ratio > 1 ? "+" : ""}${percent}% frame time vs. baseline`
      const compareTextObj = new TextRenderable(renderer, {
        id: `result-compare-${i}`,
        position: "absolute",
        left: Math.floor(WIDTH / 6) + 2,
        top: y++,
        content: compareText,
        zIndex: 31,
      })
      uiContainer.add(compareTextObj)
    }
  }

  const resultsFooter = new TextRenderable(renderer, {
    id: "results-footer",
    position: "absolute",
    left: Math.floor(WIDTH / 6) + 2,
    top: Math.floor((HEIGHT * 5) / 6) - 2,
    content: "Press Ctrl+C to exit",
    zIndex: 31,
  })
  uiContainer.add(resultsFooter)

  if (outputPath) {
    try {
      const jsonResults = {
        date: new Date().toISOString(),
        scenarios: results,
        comparison:
          results.length > 1
            ? results.slice(1).map((result) => {
                const basePerf = results[0].averageFrameTime
                const currentPerf = result.averageFrameTime
                const ratio = currentPerf / basePerf
                const percent = (ratio - 1) * 100
                return { name: result.name, ratio, percentDifference: percent }
              })
            : [],
      }

      for (const result of jsonResults.scenarios) {
        const scenarioResult = result as ScenarioResult
        if (scenarioResult.memorySnapshots && scenarioResult.memorySnapshots.length > 0) {
          const heapUsedValues = scenarioResult.memorySnapshots.map((s) => s.heapUsed).sort((a, b) => a - b)
          const minMem = heapUsedValues[0]
          const maxMem = heapUsedValues[heapUsedValues.length - 1]
          const avgMem = heapUsedValues.reduce((sum, val) => sum + val, 0) / heapUsedValues.length
          const midIndex = Math.floor(heapUsedValues.length / 2)
          const medianMem =
            heapUsedValues.length % 2 === 0
              ? (heapUsedValues[midIndex - 1] + heapUsedValues[midIndex]) / 2
              : heapUsedValues[midIndex]

          const arrayBufferValues = scenarioResult.memorySnapshots.map((s) => s.arrayBuffers).sort((a, b) => a - b)
          const minAB = arrayBufferValues[0]
          const maxAB = arrayBufferValues[arrayBufferValues.length - 1]
          const avgAB = arrayBufferValues.reduce((sum, val) => sum + val, 0) / arrayBufferValues.length
          const midABIndex = Math.floor(arrayBufferValues.length / 2)
          const medianAB =
            arrayBufferValues.length % 2 === 0
              ? (arrayBufferValues[midABIndex - 1] + arrayBufferValues[midABIndex]) / 2
              : arrayBufferValues[midABIndex]

          ;(scenarioResult as any).memoryStats = {
            minHeapUsedMB: minMem / 1024 / 1024,
            maxHeapUsedMB: maxMem / 1024 / 1024,
            averageHeapUsedMB: avgMem / 1024 / 1024,
            medianHeapUsedMB: medianMem / 1024 / 1024,
            minArrayBuffersMB: minAB / 1024 / 1024,
            maxArrayBuffersMB: maxAB / 1024 / 1024,
            averageArrayBuffersMB: avgAB / 1024 / 1024,
            medianArrayBuffersMB: medianAB / 1024 / 1024,
          }
        }
        delete (scenarioResult as Partial<ScenarioResult>).memorySnapshots
      }

      writeFileSync(outputPath, JSON.stringify(jsonResults, null, 2))
    } catch (error: any) {
      console.error(`Error saving results to ${outputPath}: ${error.message}`)
    }
  }
}

renderer.on("resize", (width, height) => {
  framebuffer.resize(width, height)
  if (cameraNode) {
    cameraNode.aspect = engine.aspectRatio
    cameraNode.updateProjectionMatrix()
  }
})

renderer.on("memory:snapshot", (snapshot: MemorySnapshot) => {
  if (benchmarkActive) {
    currentMemorySnapshots.push(snapshot)
  }
})

renderer.toggleDebugOverlay()

process.stdin.on("data", (key: Buffer) => {
  const keyStr = key.toString()

  if (keyStr === "`") {
    renderer.console.toggle()
  }
})

renderer.start()
