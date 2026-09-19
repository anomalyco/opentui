import { BoxRenderable, type CliRenderer, createCliRenderer, TextRenderable, t, fg, bold } from "@opentui/core"
import { ScrollBoxRenderable, CliRenderEvents, type KeyEvent } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let scrollBox: ScrollBoxRenderable | null = null
let renderer: CliRenderer | null = null
let mainContainer: BoxRenderable | null = null
let instructionsBox: BoxRenderable | null = null
let itemCount = 0
let animationInterval: ReturnType<typeof setInterval> | null = null

// Track items with their creation time for animation
interface AnimatedItem {
  box: BoxRenderable
  text: TextRenderable
  createdAt: number
  originalContent: string
  normalBgColor: string
  isAtTop: boolean
}

const animatedItems = new Map<string, AnimatedItem>()

// Clear all items from the scroll box
function clearAllItems() {
  if (!scrollBox) return

  // Stop any running animations
  if (animationInterval) {
    clearInterval(animationInterval)
    animationInterval = null
  }

  // Clear animated items tracking
  animatedItems.clear()

  // Remove all children from scroll box
  const children = scrollBox.getChildren()
  for (const child of children) {
    scrollBox.remove(child)
    child.destroyRecursively()
  }

  // Reset item count
  itemCount = 0
}

// Color interpolation helper
function interpolateColor(color1: string, color2: string, factor: number): string {
  const c1 = parseInt(color1.slice(1), 16)
  const c2 = parseInt(color2.slice(1), 16)

  const r1 = (c1 >> 16) & 0xff
  const g1 = (c1 >> 8) & 0xff
  const b1 = c1 & 0xff

  const r2 = (c2 >> 16) & 0xff
  const g2 = (c2 >> 8) & 0xff
  const b2 = c2 & 0xff

  const r = Math.round(r1 + (r2 - r1) * factor)
  const g = Math.round(g1 + (g2 - g1) * factor)
  const b = Math.round(b1 + (b2 - b1) * factor)

  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`
}

// Animation update function
function updateAnimations() {
  const now = Date.now()

  for (const [id, item] of animatedItems) {
    const age = now - item.createdAt
    const duration = 800 // 800ms animation

    if (age >= duration) {
      // Animation complete, set to final colors
      item.box.backgroundColor = item.normalBgColor

      // Set final content with normal colors
      const itemNumber = id.split("-")[1]
      const timeString = new Date(item.createdAt).toLocaleTimeString()
      const finalContent = t`${bold(fg("#7aa2f7")(`Item #${itemNumber}`))}
${fg("#9aa5ce")("This is a dynamically added item with enhanced content.")}
${fg("#c0caf5")("Contains additional information and styling.")}
${fg("#565f89")("Added at:")} ${timeString}
${fg("#565f89")("Position:")} ${item.isAtTop ? "TOP" : "BOTTOM"}
${fg("#565f89")("Status:")} ${fg("#9ece6a")("ACTIVE")}`

      item.text.content = finalContent
      animatedItems.delete(id)
      continue
    }

    const progress = age / duration
    const easeProgress = 1 - Math.pow(1 - progress, 3) // Ease out cubic

    // Interpolate background color (bright to normal)
    const brightBg = "#4c4f69"
    item.box.backgroundColor = interpolateColor(brightBg, item.normalBgColor, easeProgress)

    // Update text with flashy purple fading to normal blue
    const itemNumber = id.split("-")[1]
    const currentTitleColor = interpolateColor("#bb9af7", "#7aa2f7", easeProgress)
    const timeString = new Date(item.createdAt).toLocaleTimeString()

    // Reconstruct content with interpolated color
    const updatedContent = t`${bold(fg(currentTitleColor)(`Item #${itemNumber}`))}
${fg("#9aa5ce")("This is a dynamically added item with enhanced content.")}
${fg("#c0caf5")("Contains additional information and styling.")}
${fg("#565f89")("Added at:")} ${timeString}
${fg("#565f89")("Position:")} ${item.isAtTop ? "TOP" : "BOTTOM"}
${fg("#565f89")("Status:")} ${fg("#9ece6a")("ACTIVE")}`

    item.text.content = updatedContent
  }

  // Stop animation loop if no items are animating
  if (animatedItems.size === 0 && animationInterval) {
    clearInterval(animationInterval)
    animationInterval = null
  }
}

function addItem(atTop: boolean = false) {
  if (!renderer || !scrollBox) return

  itemCount++

  const boxId = `item-${itemCount}`
  const normalBgColor = itemCount % 2 === 0 ? "#24283b" : "#1f2335"

  // Start with flashy colors
  const box = new BoxRenderable(renderer, {
    id: boxId,
    width: "auto",
    padding: 1,
    marginBottom: 1,
    backgroundColor: "#4c4f69", // Bright initial background
  })

  const timeString = new Date().toLocaleTimeString()

  // Store original content as string (without template literal processing)
  const originalContent = `Item #${itemCount}\nThis is a dynamically added item with enhanced content.\nContains additional information and styling.\nAdded at: ${timeString}\nPosition: ${atTop ? "TOP" : "BOTTOM"}\nStatus: ACTIVE`

  // Start with flashy purple title using template literal
  const flashyContent = t`${bold(fg("#bb9af7")(`Item #${itemCount}`))}
${fg("#9aa5ce")("This is a dynamically added item with enhanced content.")}
${fg("#c0caf5")("Contains additional information and styling.")}
${fg("#565f89")("Added at:")} ${timeString}
${fg("#565f89")("Position:")} ${atTop ? "TOP" : "BOTTOM"}
${fg("#565f89")("Status:")} ${fg("#9ece6a")("ACTIVE")}`

  const text = new TextRenderable(renderer, {
    content: flashyContent,
  })

  box.add(text)

  if (atTop) {
    scrollBox.add(box, 0) // Add at the beginning
  } else {
    scrollBox.add(box) // Add at the end
  }

  // Track for animation
  animatedItems.set(boxId, {
    box,
    text,
    createdAt: Date.now(),
    originalContent,
    normalBgColor,
    isAtTop: atTop,
  })

  // Start animation loop if not running
  if (!animationInterval) {
    animationInterval = setInterval(updateAnimations, 16) // ~60fps
  }
}

export function run(rendererInstance: CliRenderer): void {
  renderer = rendererInstance
  renderer.setBackgroundColor("#0a0a14")

  mainContainer = new BoxRenderable(renderer, {
    id: "main-container",
    flexGrow: 1,
    maxHeight: "100%",
    maxWidth: "100%",
    flexDirection: "column",
    backgroundColor: "#0f0f23",
  })

  scrollBox = new ScrollBoxRenderable(renderer, {
    id: "sticky-scroll-box",
    stickyScroll: true,
    stickyStart: "bottom",
    rootOptions: {
      backgroundColor: "#1e1e2e",
      border: true,
    },
    wrapperOptions: {
      backgroundColor: "#181825",
    },
    viewportOptions: {
      backgroundColor: "#11111b",
    },
    contentOptions: {
      backgroundColor: "#0f0f0f",
    },
    scrollbarOptions: {
      // width: 2,
      // showArrows: true,
      trackOptions: {
        foregroundColor: "#7aa2f7",
        backgroundColor: "#313244",
      },
    },
  })

  instructionsBox = new BoxRenderable(renderer, {
    id: "instructions",
    width: "100%",
    flexDirection: "column",
    backgroundColor: "#1e1e2e",
    paddingLeft: 1,
    flexShrink: 0,
  })

  const instructionsText1 = new TextRenderable(renderer, {
    content: t`${bold(fg("#7aa2f7")("Sticky Scroll Demo"))} ${fg("#565f89")("-")} ${bold(fg("#9ece6a")("S"))} ${fg("#c0caf5")("Toggle sticky scroll")} ${fg("#565f89")("|")} ${bold(fg("#bb9af7")("T"))} ${fg("#c0caf5")("Add item at top")} ${fg("#565f89")("|")} ${bold(fg("#f7768e")("B"))} ${fg("#c0caf5")("Add item at bottom")} ${fg("#565f89")("|")} ${bold(fg("#e0af68")("E"))} ${fg("#c0caf5")("Clear all items")}`,
  })

  const instructionsText2 = new TextRenderable(renderer, {
    content: t`${bold(fg("#7aa2f7")("Behavior:"))} ${fg("#c0caf5")("Scroll to top/bottom, then add items to see sticky behavior")}`,
  })

  const instructionsText3 = new TextRenderable(renderer, {
    content: t`${bold(fg("#7aa2f7")("Status:"))} ${fg("#c0caf5")("Sticky Scroll:")} ${scrollBox.stickyScroll ? fg("#9ece6a")("ENABLED") : fg("#f7768e")("DISABLED")}`,
  })

  instructionsBox.add(instructionsText1)
  instructionsBox.add(instructionsText2)
  instructionsBox.add(instructionsText3)

  mainContainer.add(scrollBox)
  mainContainer.add(instructionsBox)

  renderer.root.add(mainContainer)

  scrollBox.focus()

  // Add some initial items
  for (let i = 0; i < 10; i++) {
    addItem(false)
  }

  const keyHandler = (key: KeyEvent) => {
    if (key.name === "s" && scrollBox) {
      // Toggle sticky scroll
      const currentSticky = scrollBox.stickyScroll
      scrollBox.stickyScroll = !currentSticky
      console.log(`Sticky scroll ${!currentSticky ? "enabled" : "disabled"}`)

      // Update status display
      if (instructionsBox && instructionsBox.getChildren().length >= 3) {
        const statusText = instructionsBox.getChildren()[2] as TextRenderable
        statusText.content = t`${bold(fg("#7aa2f7")("Status:"))} ${fg("#c0caf5")("Sticky Scroll:")} ${(scrollBox as any).stickyScroll ? fg("#9ece6a")("ENABLED") : fg("#f7768e")("DISABLED")}`
      }
    } else if (key.name === "t" && scrollBox) {
      addItem(true) // Add at top
      console.log("Added item at top")
    } else if (key.name === "b" && scrollBox) {
      addItem(false) // Add at bottom
      console.log("Added item at bottom")
    } else if (key.name === "e" && scrollBox) {
      clearAllItems() // Clear all items
    }
  }
  rendererInstance.keyInput.on("keypress", keyHandler)
  mainContainer.once("destroyed", () => rendererInstance.keyInput.off("keypress", keyHandler))
}

export function destroy(rendererInstance: CliRenderer): void {
  if (mainContainer) {
    rendererInstance.root.remove(mainContainer)
    mainContainer.destroyRecursively()
    mainContainer = null
  }

  // Clean up animation
  if (animationInterval) {
    clearInterval(animationInterval)
    animationInterval = null
  }
  animatedItems.clear()

  itemCount = 0
  scrollBox = null
  instructionsBox = null
  renderer = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  })

  renderer.once(CliRenderEvents.DESTROY, () => destroy(renderer))
  run(renderer)
  setupCommonDemoKeys(renderer)
}
