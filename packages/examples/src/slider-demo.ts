import { type CliRenderer, createCliRenderer, t, fg, bold, BoxRenderable, TextRenderable } from "@opentui/core"
import { SliderRenderable, CliRenderEvents } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let horizontalSlider1: SliderRenderable | null = null
let horizontalSlider2: SliderRenderable | null = null
let horizontalSlider3: SliderRenderable | null = null
let verticalSlider1: SliderRenderable | null = null
let verticalSlider2: SliderRenderable | null = null
let verticalSlider3: SliderRenderable | null = null
let animatedVerticalSlider: SliderRenderable | null = null
let renderer: CliRenderer | null = null
let mainContainer: BoxRenderable | null = null
let instructionsBox: BoxRenderable | null = null
let keyboardHandler: ((key: any) => void) | null = null
let frameCallback: ((deltaTime: number) => Promise<void>) | null = null
let animationTime = 0

// Value display elements
let h1ValueText: TextRenderable | null = null
let h2ValueText: TextRenderable | null = null
let h3ValueText: TextRenderable | null = null
let v1ValueText: TextRenderable | null = null
let v2ValueText: TextRenderable | null = null
let v3ValueText: TextRenderable | null = null
let vAValueText: TextRenderable | null = null

function updateDisplays() {
  // Update individual slider value displays
  if (h1ValueText && horizontalSlider1) {
    h1ValueText.content = t`${bold(fg("#e0af68")("Value:"))} ${horizontalSlider1.value.toFixed(1)}`
  }
  if (h2ValueText && horizontalSlider2) {
    h2ValueText.content = t`${bold(fg("#bb9af7")("Value:"))} ${horizontalSlider2.value.toFixed(1)}`
  }
  if (h3ValueText && horizontalSlider3) {
    h3ValueText.content = t`${bold(fg("#FF6B6B")("Value:"))} ${horizontalSlider3.value.toFixed(2)}`
  }
  if (v1ValueText && verticalSlider1) {
    v1ValueText.content = t`${bold(fg("#f7768e")(verticalSlider1.value.toFixed(1)))}`
  }
  if (v2ValueText && verticalSlider2) {
    v2ValueText.content = t`${bold(fg("#ff9e64")(verticalSlider2.value.toFixed(1)))}`
  }
  if (v3ValueText && verticalSlider3) {
    v3ValueText.content = t`${bold(fg("#73daca")(verticalSlider3.value.toFixed(1)))}`
  }
  if (vAValueText && animatedVerticalSlider) {
    vAValueText.content = t`${bold(fg("#FF6B6B")(animatedVerticalSlider.value.toFixed(2)))}`
  }
}

function resetSliders() {
  if (horizontalSlider1) horizontalSlider1.value = 25
  if (horizontalSlider2) horizontalSlider2.value = 100
  if (horizontalSlider3) horizontalSlider3.value = 25
  if (verticalSlider1) verticalSlider1.value = 0
  if (verticalSlider2) verticalSlider2.value = 0
  if (verticalSlider3) verticalSlider3.value = 50
  if (animatedVerticalSlider) animatedVerticalSlider.value = 50

  updateDisplays()
}

function focusSlider(index: number) {
  // Remove focus from all sliders first
  horizontalSlider1?.blur()
  horizontalSlider2?.blur()
  horizontalSlider3?.blur()
  verticalSlider1?.blur()
  verticalSlider2?.blur()
  verticalSlider3?.blur()
  animatedVerticalSlider?.blur()

  let slider: SliderRenderable | null = null

  switch (index) {
    case 1:
      slider = horizontalSlider1
      break
    case 2:
      slider = horizontalSlider2
      break
    case 3:
      slider = horizontalSlider3
      break
    case 4:
      slider = verticalSlider1
      break
    case 5:
      slider = verticalSlider2
      break
    case 6:
      slider = verticalSlider3
      break
    case 7:
      slider = animatedVerticalSlider
      break
  }

  if (slider) {
    slider.focus()
    updateDisplays()
  }
}

export function run(rendererInstance: CliRenderer): void {
  renderer = rendererInstance
  renderer.setBackgroundColor("#1a1b26")
  renderer.start()

  mainContainer = new BoxRenderable(renderer, {
    id: "slider-demo-main-container",
    flexGrow: 1,
    maxHeight: "100%",
    maxWidth: "100%",
    flexDirection: "column",
    backgroundColor: "#1a1b26",
  })
  renderer.root.add(mainContainer)

  // Create sliders container
  const slidersContainer = new BoxRenderable(renderer, {
    id: "sliders-container",
    width: "100%",
    flexGrow: 1,
    flexDirection: "column",
    backgroundColor: "#1a1b26",
    padding: 2,
  })

  // Horizontal Slider 1 - 1-height (very thin) - now H1
  const h1Container = new BoxRenderable(renderer, {
    id: "h1-container",
    width: "100%",
    flexDirection: "column",
    backgroundColor: "#24283b",
    marginBottom: 1,
    padding: 1,
  })

  const h1Label = new TextRenderable(renderer, {
    content: t`${bold(fg("#e0af68")("H1"))} ${fg("#565f89")("- 1h×100w (0-50)")}`,
  })

  h1ValueText = new TextRenderable(renderer, {
    content: t`${bold(fg("#e0af68")("Value:"))} 25.0`,
  })

  horizontalSlider1 = new SliderRenderable(renderer, {
    id: "horizontal-slider-1",
    orientation: "horizontal",
    width: "100%",
    height: 1,
    value: 25,
    min: 0,
    max: 50,
    viewPortSize: 1,
    backgroundColor: "#414868",
    foregroundColor: "#e0af68",
    onChange: updateDisplays,
  })

  h1Container.add(h1Label)
  h1Container.add(h1ValueText)
  h1Container.add(horizontalSlider1)

  // Horizontal Slider 2 - 5-height (thick) - now H2
  const h2Container = new BoxRenderable(renderer, {
    id: "h2-container",
    width: "100%",
    flexDirection: "column",
    backgroundColor: "#24283b",
    marginBottom: 1,
    padding: 1,
  })

  const h2Label = new TextRenderable(renderer, {
    content: t`${bold(fg("#bb9af7")("H2"))} ${fg("#565f89")("- 5h×100w (0-200)")}`,
  })

  h2ValueText = new TextRenderable(renderer, {
    content: t`${bold(fg("#bb9af7")("Value:"))} 100.0`,
  })

  horizontalSlider2 = new SliderRenderable(renderer, {
    id: "horizontal-slider-2",
    orientation: "horizontal",
    width: "100%",
    height: 5,
    value: 100,
    min: 0,
    max: 200,
    viewPortSize: 50,
    backgroundColor: "#414868",
    foregroundColor: "#bb9af7",
    onChange: updateDisplays,
  })

  h2Container.add(h2Label)
  h2Container.add(h2ValueText)
  h2Container.add(horizontalSlider2)

  // Horizontal Slider 3 - Animated (sub-cell rendering) - now H3
  const h3Container = new BoxRenderable(renderer, {
    id: "h3-container",
    width: "100%",
    flexDirection: "column",
    backgroundColor: "#24283b",
    marginBottom: 1,
    padding: 1,
  })

  const h3Label = new TextRenderable(renderer, {
    content: t`${bold(fg("#FF6B6B")("H3"))} ${fg("#565f89")("- 1h×80w (animated, sub-cell rendering)")}`,
  })

  h3ValueText = new TextRenderable(renderer, {
    content: t`${bold(fg("#FF6B6B")("Value:"))} 25.00`,
  })

  horizontalSlider3 = new SliderRenderable(renderer, {
    id: "horizontal-slider-3",
    orientation: "horizontal",
    height: 1,
    value: 25,
    min: 0,
    max: 50,
    viewPortSize: 0.1, // Fine step size for smooth animation
    backgroundColor: "#414868",
    foregroundColor: "#FF6B6B",
    onChange: updateDisplays,
  })

  h3Container.add(h3Label)
  h3Container.add(h3ValueText)
  h3Container.add(horizontalSlider3)

  // Vertical sliders container
  const verticalContainer = new BoxRenderable(renderer, {
    id: "vertical-container",
    width: "100%",
    height: 17,
    flexDirection: "row",
    backgroundColor: "#1a1b26",
    marginBottom: 1,
    padding: 1,
  })

  // Vertical Slider 1 - 1-width (very narrow)
  const v1Container = new BoxRenderable(renderer, {
    id: "v1-container",
    width: 8,
    height: "100%",
    flexDirection: "column",
    alignItems: "flex-end",
    backgroundColor: "#24283b",
    marginRight: 1,
    padding: 1,
  })

  const v1SliderWrapper = new BoxRenderable(renderer, {
    id: "v1-slider-wrapper",
    flexDirection: "row",
    height: "100%",
    flexGrow: 1,
  })

  const v1Label = new TextRenderable(renderer, {
    content: t`${bold(fg("#f7768e")("V1"))}
${fg("#565f89")("1w")}`,
    width: 3,
  })

  verticalSlider1 = new SliderRenderable(renderer, {
    id: "vertical-slider-1",
    orientation: "vertical",
    width: 1,
    height: "100%",
    value: 0,
    min: -10,
    max: 10,
    viewPortSize: 1,
    backgroundColor: "#414868",
    foregroundColor: "#f7768e",
    onChange: updateDisplays,
  })

  v1ValueText = new TextRenderable(renderer, {
    content: t`${bold(fg("#f7768e")("0.0"))}`,
  })

  v1SliderWrapper.add(v1Label)
  v1SliderWrapper.add(verticalSlider1)
  v1Container.add(v1SliderWrapper)
  v1Container.add(v1ValueText)

  // Vertical Slider 2 - 3-width (medium)
  const v2Container = new BoxRenderable(renderer, {
    id: "v2-container",
    width: 10,
    height: "100%",
    flexDirection: "column",
    alignItems: "flex-end",
    backgroundColor: "#24283b",
    marginRight: 1,
    padding: 1,
  })

  const v2SliderWrapper = new BoxRenderable(renderer, {
    id: "v2-slider-wrapper",
    flexDirection: "row",
    height: "100%",
    flexGrow: 1,
  })

  const v2Label = new TextRenderable(renderer, {
    content: t`${bold(fg("#ff9e64")("V2"))}
${fg("#565f89")("3w")}`,
    width: 3,
  })

  verticalSlider2 = new SliderRenderable(renderer, {
    id: "vertical-slider-2",
    orientation: "vertical",
    width: 3,
    height: "100%",
    value: 0,
    min: -50,
    max: 50,
    viewPortSize: 5,
    backgroundColor: "#414868",
    foregroundColor: "#ff9e64",
    onChange: updateDisplays,
  })

  v2ValueText = new TextRenderable(renderer, {
    content: t`${bold(fg("#ff9e64")("0.0"))}`,
  })

  v2SliderWrapper.add(v2Label)
  v2SliderWrapper.add(verticalSlider2)
  v2Container.add(v2SliderWrapper)
  v2Container.add(v2ValueText)

  // Vertical Slider 3 - 5-width (wide)
  const v3Container = new BoxRenderable(renderer, {
    id: "v3-container",
    width: 12,
    height: "100%",
    flexDirection: "column",
    alignItems: "flex-end",
    backgroundColor: "#24283b",
    marginRight: 1,
    padding: 1,
  })

  const v3SliderWrapper = new BoxRenderable(renderer, {
    id: "v3-slider-wrapper",
    flexDirection: "row",
    height: "100%",
    flexGrow: 1,
  })

  const v3Label = new TextRenderable(renderer, {
    content: t`${bold(fg("#73daca")("V3"))}
${fg("#565f89")("5w")}`,
    width: 3,
  })

  verticalSlider3 = new SliderRenderable(renderer, {
    id: "vertical-slider-3",
    orientation: "vertical",
    width: 5,
    height: "100%",
    value: 50,
    min: 0,
    max: 100,
    viewPortSize: 10,
    backgroundColor: "#414868",
    foregroundColor: "#73daca",
    onChange: updateDisplays,
  })

  v3ValueText = new TextRenderable(renderer, {
    content: t`${bold(fg("#73daca")("50.0"))}`,
  })

  v3SliderWrapper.add(v3Label)
  v3SliderWrapper.add(verticalSlider3)
  v3Container.add(v3SliderWrapper)
  v3Container.add(v3ValueText)

  // Animated Vertical Slider - demonstrates sub-cell rendering
  const animatedVContainer = new BoxRenderable(renderer, {
    id: "animated-v-container",
    width: 10,
    height: "100%",
    flexDirection: "column",
    alignItems: "flex-end",
    backgroundColor: "#24283b",
    marginRight: 1,
    padding: 1,
  })

  const animatedVSliderWrapper = new BoxRenderable(renderer, {
    id: "animated-v-slider-wrapper",
    flexDirection: "row",
    height: "100%",
    flexGrow: 1,
  })

  const animatedVLabel = new TextRenderable(renderer, {
    content: t`${bold(fg("#FF6B6B")("VA"))}
${fg("#565f89")("2w")}`,
    width: 3,
  })

  animatedVerticalSlider = new SliderRenderable(renderer, {
    id: "animated-vertical-slider",
    orientation: "vertical",
    width: 2,
    height: 10,
    value: 50,
    min: 0,
    max: 100,
    viewPortSize: 0.2, // Fine step size for smooth animation
    backgroundColor: "#414868",
    foregroundColor: "#FF6B6B",
    onChange: updateDisplays,
  })

  vAValueText = new TextRenderable(renderer, {
    content: t`${bold(fg("#FF6B6B")("50.00"))}`,
  })

  animatedVSliderWrapper.add(animatedVLabel)
  animatedVSliderWrapper.add(animatedVerticalSlider)
  animatedVContainer.add(animatedVSliderWrapper)
  animatedVContainer.add(vAValueText)

  verticalContainer.add(v1Container)
  verticalContainer.add(v2Container)
  verticalContainer.add(v3Container)
  verticalContainer.add(animatedVContainer)

  // Add some spacing
  const spacer = new BoxRenderable(renderer, {
    id: "spacer",
    width: "100%",
    flexGrow: 1,
  })

  slidersContainer.add(h1Container)
  slidersContainer.add(h2Container)
  slidersContainer.add(h3Container)
  slidersContainer.add(verticalContainer)
  slidersContainer.add(spacer)

  // Instructions box
  instructionsBox = new BoxRenderable(renderer, {
    id: "instructions",
    width: "100%",
    flexDirection: "column",
    backgroundColor: "#2a2b3a",
    paddingLeft: 1,
  })

  const instructionsText1 = new TextRenderable(renderer, {
    content: t`${bold(fg("#7aa2f7")("Slider Demo"))} ${fg("#565f89")("-")} ${bold(fg("#FFFF00")("Mouse"))} ${fg("#c0caf5")("Click & drag on sliders")} ${fg("#565f89")("|")} ${bold(fg("#FFAA00")("R"))} ${fg("#c0caf5")("Reset all")} ${fg("#565f89")("|")} ${bold(fg("#00FF00")("1-7"))} ${fg("#c0caf5")("Focus sliders")}`,
  })

  const instructionsText2 = new TextRenderable(renderer, {
    content: t`${bold(fg("#7aa2f7")("Features:"))} ${fg("#c0caf5")("Different ranges, step sizes, orientations & dimensions (1-5 height/width)")}`,
  })

  instructionsBox.add(instructionsText1)
  instructionsBox.add(instructionsText2)

  mainContainer.add(slidersContainer)
  mainContainer.add(instructionsBox)

  updateDisplays()

  keyboardHandler = (key) => {
    if (key.name === "r") {
      resetSliders()
    } else if (key.name === "1") {
      focusSlider(1)
    } else if (key.name === "2") {
      focusSlider(2)
    } else if (key.name === "3") {
      focusSlider(3)
    } else if (key.name === "4") {
      focusSlider(4)
    } else if (key.name === "5") {
      focusSlider(5)
    } else if (key.name === "6") {
      focusSlider(6)
    } else if (key.name === "7") {
      focusSlider(7)
    }
  }

  rendererInstance.keyInput.on("keypress", keyboardHandler)

  // Set up animation frame callback for animated sliders
  frameCallback = async (deltaTime: number) => {
    animationTime += deltaTime

    // Animate horizontal slider - smooth sine wave motion covering full range
    if (horizontalSlider3) {
      const hValue = 25 + Math.sin(animationTime * 0.002) * 25
      horizontalSlider3.value = Math.max(0, Math.min(50, hValue))
    }

    // Animate vertical slider - smooth cosine wave motion covering full range
    if (animatedVerticalSlider) {
      const vValue = 50 + Math.cos(animationTime * 0.0015) * 50
      animatedVerticalSlider.value = Math.max(0, Math.min(100, vValue))
    }
  }
  renderer.setFrameCallback(frameCallback)
}

export function destroy(rendererInstance: CliRenderer): void {
  if (keyboardHandler) {
    rendererInstance.keyInput.off("keypress", keyboardHandler)
    keyboardHandler = null
  }

  if (frameCallback) {
    rendererInstance.removeFrameCallback(frameCallback)
    frameCallback = null
  }

  rendererInstance.root.getRenderable("slider-demo-main-container")?.destroyRecursively()

  mainContainer = null
  horizontalSlider1 = null
  horizontalSlider2 = null
  horizontalSlider3 = null
  verticalSlider1 = null
  verticalSlider2 = null
  verticalSlider3 = null
  animatedVerticalSlider = null
  h1ValueText = null
  h2ValueText = null
  h3ValueText = null
  v1ValueText = null
  v2ValueText = null
  v3ValueText = null
  vAValueText = null
  instructionsBox = null
  // Note: slider wrappers are automatically cleaned up by destroyRecursively
  renderer = null
  frameCallback = null
  animationTime = 0
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  })

  renderer.once(CliRenderEvents.DESTROY, () => destroy(renderer))
  run(renderer)
  setupCommonDemoKeys(renderer)
}
