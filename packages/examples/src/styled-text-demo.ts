import {
  CliRenderer,
  CliRenderEvents,
  createCliRenderer,
  t,
  blue,
  bold,
  underline,
  red,
  green,
  bgYellow,
  fg,
  link,
  BoxRenderable,
  type KeyEvent,
} from "@opentui/core"
import { TextRenderable } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let parentContainer: BoxRenderable | null = null
let counter = 0
let frameCallback: ((deltaTime: number) => Promise<void>) | null = null
let updateFrequency = 1 // Updates per frame (1 = every frame, 2 = every 2 frames, etc.)
let complexTemplateCounter = 0
let keyboardHandler: ((key: KeyEvent) => void) | null = null
let dashboardBox: BoxRenderable | null = null
let complexDisplay: TextRenderable | null = null

export function run(rendererInstance: CliRenderer): void {
  const startTime = Date.now()
  const renderer = rendererInstance
  renderer.start()
  renderer.setBackgroundColor("#001122")

  parentContainer = new BoxRenderable(renderer, {
    id: "styled-text-container",
    zIndex: 15,
  })
  renderer.root.add(parentContainer)

  counter = 0

  // Example 1
  const houseText = t`  
There's a ${underline(blue("house"))},
With a ${bold(blue("window"))},
And a ${blue("corvette")}
And everything is blue`

  const houseDisplay = new TextRenderable(renderer, {
    id: "house-text",
    content: houseText,
    width: 30,
    height: 6,
    position: "absolute",
    left: 2,
    top: 2,
    zIndex: 1,
  })
  parentContainer.add(houseDisplay)

  // Example 2
  const statusText = t`${bold(red("ERROR:"))} Connection failed
${bold(green("SUCCESS:"))} Data loaded
${bold(fg("#FFA500")("WARNING:"))} Low memory
${bgYellow(fg("black")(" NOTICE "))} System update available`

  const statusDisplay = new TextRenderable(renderer, {
    id: "status-text",
    content: statusText,
    width: 50,
    height: 6,
    position: "absolute",
    left: 2,
    top: 8,
    zIndex: 1,
  })
  parentContainer.add(statusDisplay)

  // Example 3 - Original dynamic text (updates every second)
  dashboardBox = new BoxRenderable(renderer, {
    id: "dashboard-box",
    width: 72,
    height: 21,
    position: "absolute",
    left: 2,
    top: 27,
    zIndex: 1,
    backgroundColor: "#001122",
    borderColor: "#00FFFF",
    borderStyle: "single",
    title: "COMPLEX REAL-TIME DASHBOARD",
    titleAlignment: "center",
    border: true,
  })
  parentContainer.add(dashboardBox)

  const initialText = t`${bold("System Stats:")} ${fg("#888")("[Initializing...]")}
${blue("Uptime:")} ${fg("#00FF00")("0.00")}s ${fg("#666")("(0m 0s)")}
${red("CPU Load:")} ${green("0.0%")}
${fg("#FF6B6B")("Memory:")} ${fg("#FFA500")("0.0%")}
${fg("#9B59B6")("Network:")} ${fg("#FFA500")("0 KB/s")}
${fg("#E74C3C")("Temp:")} ${blue("0.0°C")}
${fg("#F39C12")("Battery:")} ${green("100%")}
${underline("Connection:")} ${green(bold("ONLINE"))}
${underline("Health:")} ${green(bold("GOOD"))}
${underline("Alert:")} ${green(bold("NORMAL"))}
${fg("#3498DB")("Random ID:")} ${fg("#E67E22")("0000")}
${fg("#1ABC9C")("Wave:")} ${green("+0.00")}
${fg("#9B59B6")("Progress:")} ${fg("#00FF00")("░".repeat(20))}
${fg("#34495E")("Frame:")} ${fg("#ECF0F1")("0")} ${fg("#7F8C8D")("(Total: 0)")}
${fg("#2ECC71")("Status:")} ${bold(fg("#E74C3C")("●"))} ${green("ALL SYSTEMS GO")}

${bold(fg("#F1C40F")("Controls:"))} ${fg("#BDC3C7")("↑/↓ = Speed, ESC = Exit")}`

  complexDisplay = new TextRenderable(renderer, {
    id: "complex-template",
    content: initialText,
    left: 1,
    top: 1,
    zIndex: 1,
  })
  dashboardBox.add(complexDisplay)

  frameCallback = async (deltaTime) => {
    counter++
    complexTemplateCounter++

    if (counter % 60 === 0) {
      // Update every second
      const dynamicText = t`${bold("Frame:")} ${counter}
${blue("Time:")} ${(counter / 60).toFixed(1)}s
${underline("Dynamic:")} ${bold(fg("#FF6B6B")(Math.sin(counter * 0.1) > 0 ? "UP" : "DOWN"))}`

      const dynamicDisplay = parentContainer?.getRenderable("dynamic-text") as TextRenderable
      if (dynamicDisplay) {
        dynamicDisplay.content = dynamicText
      } else {
        const newDynamicDisplay = new TextRenderable(renderer, {
          id: "dynamic-text",
          content: dynamicText,
          width: 40,
          height: 4,
          position: "absolute",
          left: 2,
          top: 15,
          zIndex: 1,
        })
        parentContainer?.add(newDynamicDisplay)
      }
    }

    if (complexTemplateCounter % updateFrequency === 0 && complexDisplay) {
      const currentTime = Date.now()
      const elapsedMs = currentTime - startTime
      const elapsedSeconds = elapsedMs / 1000

      const cpuLoad = Math.sin(elapsedSeconds * 0.5) * 50 + 50
      const memoryUsage = Math.cos(elapsedSeconds * 0.3) * 30 + 70
      const networkSpeed = Math.abs(Math.sin(elapsedSeconds * 2)) * 1000
      const temperature = Math.sin(elapsedSeconds * 0.1) * 20 + 60
      const batteryLevel = Math.max(0, 100 - elapsedSeconds * 0.5)
      const randomValue = Math.floor(Math.random() * 9999)
      const waveValue = Math.sin(elapsedSeconds * 3) * 10
      const progressBar = "█".repeat(Math.floor(((elapsedSeconds % 10) / 10) * 20))

      const connectionStatus = Math.sin(elapsedSeconds) > 0 ? "ONLINE" : "OFFLINE"
      const systemHealth = cpuLoad < 80 ? "GOOD" : "HIGH"
      const alertLevel = temperature > 75 ? "CRITICAL" : "NORMAL"

      const complexText = t`${bold("System Stats:")} ${fg("#888")(`[Update: ${updateFrequency === 1 ? "Every Frame" : `Every ${updateFrequency} frames`}]`)}
${blue("Uptime:")} ${fg("#00FF00")(elapsedSeconds.toFixed(2))}s ${fg("#666")(`(${Math.floor(elapsedSeconds / 60)}m ${Math.floor(elapsedSeconds % 60)}s)`)}
${red("CPU Load:")} ${cpuLoad > 80 ? red(bold(`${cpuLoad.toFixed(1)}%`)) : green(`${cpuLoad.toFixed(1)}%`)} ${fg("#444")("█".repeat(Math.floor(cpuLoad / 5)))}
${fg("#FF6B6B")("Memory:")} ${memoryUsage > 85 ? red(bold(`${memoryUsage.toFixed(1)}%`)) : fg("#FFA500")(`${memoryUsage.toFixed(1)}%`)}
${fg("#9B59B6")("Network:")} ${networkSpeed > 500 ? green(bold(`${networkSpeed.toFixed(0)} KB/s`)) : fg("#FFA500")(`${networkSpeed.toFixed(0)} KB/s`)}
${fg("#E74C3C")("Temp:")} ${temperature > 75 ? red(bold(`${temperature.toFixed(1)}°C`)) : blue(`${temperature.toFixed(1)}°C`)}
${fg("#F39C12")("Battery:")} ${batteryLevel < 20 ? red(bold(`${batteryLevel.toFixed(0)}%`)) : green(`${batteryLevel.toFixed(0)}%`)}
${underline("Connection:")} ${connectionStatus === "ONLINE" ? green(bold(connectionStatus)) : red(bold(connectionStatus))}
${underline("Health:")} ${systemHealth === "GOOD" ? green(bold(systemHealth)) : red(bold(systemHealth))}
${underline("Alert:")} ${alertLevel === "NORMAL" ? green(bold(alertLevel)) : bgYellow(red(bold(alertLevel)))}
${fg("#3498DB")("Random ID:")} ${fg("#E67E22")(randomValue.toString().padStart(4, "0"))}
${fg("#1ABC9C")("Wave:")} ${waveValue >= 0 ? green(`+${waveValue.toFixed(2)}`) : red(waveValue.toFixed(2))}
${fg("#9B59B6")("Progress:")} ${fg("#00FF00")(progressBar.padEnd(20, "░"))}
${fg("#34495E")("Frame:")} ${fg("#ECF0F1")(complexTemplateCounter)} ${fg("#7F8C8D")(`(Total: ${counter})`)}
${fg("#2ECC71")("Status:")} ${bold(fg("#E74C3C")("●"))} ${alertLevel === "CRITICAL" ? red("SYSTEM ALERT") : green("ALL SYSTEMS GO")}

${bold(fg("#F1C40F")("Controls:"))} ${fg("#BDC3C7")("↑/↓ = Speed, ESC = Exit")}`

      complexDisplay.content = complexText
    }
  }

  renderer.setFrameCallback(frameCallback)

  // Add keyboard controls for update frequency
  keyboardHandler = (key: KeyEvent) => {
    if (key.name === "up" || key.name === "arrowup") {
      updateFrequency = Math.max(1, updateFrequency - 1)
    } else if (key.name === "down" || key.name === "arrowdown") {
      updateFrequency = Math.min(60, updateFrequency + 1)
    }
  }
  rendererInstance.keyInput.on("keypress", keyboardHandler)

  const instructionsText = t`${bold("Styled Text Demo")}
${fg("#888")("ESC to return, ↑/↓ to control speed")}

${underline("Features demonstrated:")}
• Template literals with ${blue("colors")}
• ${bold("Bold")}, ${underline("underlined")}, and other styles
• Background colors like ${bgYellow(fg("black")("this"))}
• Custom hex colors like ${fg("#FF6B6B")("this red")}
• Dynamic updates with ${green("controllable frequency")}
• Complex templates with ${red("many variables")}
• Hyperlinks: ${underline(blue(link("https://opentui.com")("opentui")))}`

  const instructionsDisplay = new TextRenderable(renderer, {
    id: "instructions",
    content: instructionsText,
    width: 60,
    height: 12,
    position: "absolute",
    left: 40,
    top: 2,
    zIndex: 1,
    fg: "#CCCCCC",
  })
  parentContainer.add(instructionsDisplay)

  // Examples showing number and boolean support
  const typesText = t`${bold("Type Examples:")}
Number: ${green(42)}
Boolean: ${red(true)}
Float: ${blue((3.14159).toFixed(2))}
Calculated: ${fg("#00FFFF")(Math.floor(Math.random() * 100))}`

  const typesDisplay = new TextRenderable(renderer, {
    id: "types-text",
    content: typesText,
    width: 30,
    height: 6,
    position: "absolute",
    left: 2,
    top: 20,
    zIndex: 1,
  })
  parentContainer.add(typesDisplay)

  renderer.requestRender()
}

export function destroy(rendererInstance: CliRenderer): void {
  if (frameCallback) {
    rendererInstance.removeFrameCallback(frameCallback)
    frameCallback = null
  }

  if (keyboardHandler) {
    rendererInstance.keyInput.off("keypress", keyboardHandler)
    keyboardHandler = null
  }

  if (parentContainer) {
    parentContainer.destroyRecursively()
    parentContainer = null
  }

  counter = 0
  updateFrequency = 1
  complexTemplateCounter = 0
  dashboardBox = null
  complexDisplay = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
  })
  renderer.once(CliRenderEvents.DESTROY, () => destroy(renderer))
  run(renderer)
  setupCommonDemoKeys(renderer)
}
