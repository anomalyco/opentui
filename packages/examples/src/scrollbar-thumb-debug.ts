import { BoxRenderable, type CliRenderer, TextRenderable, t, fg, bold } from "@opentui/core"
import { ScrollBoxRenderable } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let scrollBox: ScrollBoxRenderable | null = null
let mainContainer: BoxRenderable | null = null
let debugText: TextRenderable | null = null
let instructionsText: TextRenderable | null = null
let rendererRef: CliRenderer | null = null

const enum ADJUST {
  MoreContent,
  LessContent,
}
let contentItemCount = 8

function addContentItem(i: number) {
  if (!scrollBox || !rendererRef) return
  const box = new BoxRenderable(rendererRef, {
    id: `content-${i}`,
    width: "100%",
    height: 3,
    backgroundColor: i % 2 === 0 ? "#292e42" : "#2f3449",
    paddingLeft: 1,
  })
  const text = new TextRenderable(rendererRef, {
    content: t`${fg("#7aa2f7")(`[${i}] `)} ${fg("#c0caf5")("Line 1/3 — this is a fixed-height content item.")}
${fg("#9aa5ce")("Line 2/3 — padding above and below adds spacing.")}
${fg("#565f89")("Line 3/3 — three rows total including extra padding.")}`,
  })
  box.add(text)
  scrollBox.add(box)
}

function refreshDiagnostics() {
  if (!scrollBox || !debugText || !rendererRef) return

  const vsb = scrollBox.verticalScrollBar as any
  const slider = vsb?.slider as any
  const scrollSize = vsb?.scrollSize ?? 0
  const viewportSizeCalc = vsb?.viewportSize ?? 0
  const sliderMin = slider?._min ?? 0
  const sliderMax = slider?._max ?? 0
  const range = sliderMax - sliderMin
  const clampedViewPort = slider?._viewPortSize ?? 0
  const expectedRatio = scrollSize > 0 ? viewportSizeCalc / scrollSize : 0
  const actualContentSize = range + clampedViewPort
  const actualRatio = actualContentSize > 0 ? clampedViewPort / actualContentSize : 0
  const virtualThumbSize = typeof slider?.getVirtualThumbSize === "function" ? slider.getVirtualThumbSize() : -1
  const trackPixels = typeof slider?.height === "number" ? slider.height : -1

  const expectedThumbPct = (expectedRatio * 100).toFixed(1)
  const actualThumbPct = (actualRatio * 100).toFixed(1)
  const isClamped = clampedViewPort < viewportSizeCalc

  debugText.content = t`
${bold(fg("#7aa2f7")("=== Scrollbar Thumb Size Diagnostics ==="))}
${fg("#565f89")("─────────────────────────────────────────────")}

${fg("#c0caf5")("scrollSize    (content.height): ")}${fg("#9ece6a")(String(scrollSize).padStart(4))}
${fg("#c0caf5")("viewportSize  (viewport.h):    ")}${fg("#9ece6a")(String(viewportSizeCalc).padStart(4))}
${fg("#c0caf5")("slider.max - min  (range):     ")}${fg("#e0af68")(String(range).padStart(4))}${fg("#565f89")("   (= scrollSize - viewportSize)")}

${fg("#565f89")("─────────────────────────────────────────────")}
${fg("#c0caf5")("slider._viewPortSize:           ")}${isClamped ? fg("#f7768e") : fg("#9ece6a")(String(clampedViewPort).padStart(4))}${isClamped ? fg("#f7768e")("   ⚠ CLAMPED!") : ""}
${fg("#c0caf5")("Expected thumb ratio:           ")}${fg("#9ece6a")(expectedThumbPct + "%")}${fg("#565f89")("   (viewportSize / scrollSize)")}
${fg("#c0caf5")("Actual thumb ratio:             ")}${isClamped ? fg("#f7768e") : fg("#9ece6a")(actualThumbPct + "%")}${fg("#565f89")("   (clamped / (range+clamped))")}

${fg("#565f89")("─────────────────────────────────────────────")}
${fg("#c0caf5")("virtualThumbSize:               ")}${String(virtualThumbSize).padStart(4)}${fg("#565f89")("   (raw virtual units, track*2)")}
${fg("#c0caf5")("slider height (cells):          ")}${String(trackPixels).padStart(4)}
${fg("#c0caf5")("slider.min: ")}${String(sliderMin)}${fg("#c0caf5")("  max: ")}${String(sliderMax)}${fg("#c0caf5")("  value: ")}${String(slider?._value ?? 0)}

${fg("#565f89")("─────────────────────────────────────────────")}
${isClamped ? fg("#f7768e")(bold("BUG: viewPortSize clamped to range! Thumb shorter than expected.")) : fg("#9ece6a")("OK: No clamping — viewportSize <= range.")}
`
}

function adjustContent(direction: ADJUST) {
  if (!scrollBox) return
  if (direction === ADJUST.MoreContent) {
    addContentItem(contentItemCount)
    contentItemCount++
  } else if (contentItemCount > 1) {
    const children = scrollBox.content.getChildren()
    const last = children[children.length - 1]
    if (last) {
      scrollBox.content.remove(last)
      last.destroyRecursively()
      contentItemCount--
    }
  }
  setTimeout(refreshDiagnostics, 50)
}

export function run(renderer: CliRenderer): void {
  rendererRef = renderer
  renderer.setBackgroundColor("#1a1b26")
  setupCommonDemoKeys(renderer)

  mainContainer = new BoxRenderable(renderer, {
    id: "main-container",
    flexGrow: 1,
    maxHeight: "100%",
    maxWidth: "100%",
    flexDirection: "column",
    backgroundColor: "#1a1b26",
  })

  const debugPanel = new BoxRenderable(renderer, {
    id: "debug-panel",
    width: "100%",
    paddingLeft: 1,
    paddingTop: 0,
    paddingBottom: 0,
    backgroundColor: "#1f2335",
    flexShrink: 0,
  })

  debugText = new TextRenderable(renderer, {
    content: t`Initializing...`,
  })
  debugPanel.add(debugText)

  scrollBox = new ScrollBoxRenderable(renderer, {
    id: "scroll-box",
    flexGrow: 1,
    rootOptions: {
      backgroundColor: "#24283b",
      border: true,
    },
    viewportOptions: {
      backgroundColor: "#1a1b26",
    },
    contentOptions: {
      backgroundColor: "#16161e",
    },
    scrollbarOptions: {
      showArrows: false,
      trackOptions: {
        foregroundColor: "#7aa2f7",
        backgroundColor: "#414868",
      },
    },
  })

  for (let i = 0; i < contentItemCount; i++) {
    addContentItem(i)
  }

  const instructionsPanel = new BoxRenderable(renderer, {
    id: "instructions-panel",
    width: "100%",
    height: 2,
    backgroundColor: "#2a2b3a",
    paddingLeft: 1,
    flexShrink: 0,
  })

  instructionsText = new TextRenderable(renderer, {
    content: t`${bold(fg("#7aa2f7")("Controls:"))} ${fg("#c0caf5")("↑↓ PgUp/PgDn = scroll")}  ${fg("#565f89")("|")}  ${bold(fg("#9ece6a")("R"))} ${fg("#c0caf5")("Refresh diagnostics")}  ${fg("#565f89")("|")}  ${bold(fg("#e0af68")("+/-"))} ${fg("#c0caf5")("Add/remove content")}  ${fg("#565f89")("|")}  ${bold(fg("#bb9af7")("Tab"))} ${fg("#c0caf5")("Focus scrollbox")}  ${fg("#565f89")("|")}  ${bold(fg("#f7768e")("RESIZE TERM"))} ${fg("#c0caf5")("to change ratio")}`,
  })
  instructionsPanel.add(instructionsText)

  mainContainer.add(debugPanel)
  mainContainer.add(scrollBox)
  mainContainer.add(instructionsPanel)

  renderer.root.add(mainContainer)
  scrollBox.focus()

  renderer.keyInput.on("keypress", (key) => {
    if (key.name === "r") {
      refreshDiagnostics()
    } else if (key.name === "+" || key.name === "=") {
      adjustContent(ADJUST.MoreContent)
    } else if (key.name === "-") {
      adjustContent(ADJUST.LessContent)
    } else if (key.name === "tab" && scrollBox) {
      scrollBox.focus()
    }
  })

  scrollBox.viewport.on("resize", () => {
    setTimeout(refreshDiagnostics, 50)
  })

  setTimeout(refreshDiagnostics, 100)
}

export function destroy(renderer: CliRenderer): void {
  if (mainContainer) {
    renderer.root.remove(mainContainer)
    mainContainer.destroyRecursively()
    mainContainer = null
  }
  scrollBox = null
  debugText = null
  instructionsText = null
  rendererRef = null
}
