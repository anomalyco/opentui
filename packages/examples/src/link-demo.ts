import {
  CliRenderer,
  createCliRenderer,
  t,
  fg,
  link,
  bold,
  italic,
  BoxRenderable,
  RGBA,
  RenderableEvents,
  TextAttributes,
  TextRenderable,
  getLinkId,
  type MouseEvent,
  type OptimizedBuffer,
  type KeyEvent,
  type RenderContext,
  type StyledText,
} from "@opentui/core"
import { spawn } from "node:child_process"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let nextZIndex = 100
let dragModeEnabled = false

class DraggableBox extends BoxRenderable {
  private isDragging = false
  private dragOffsetX = 0
  private dragOffsetY = 0

  constructor(
    ctx: RenderContext,
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
    backgroundColor: RGBA,
  ) {
    super(ctx, {
      id,
      width,
      height,
      zIndex: nextZIndex++,
      backgroundColor,
      position: "absolute",
      left: x,
      top: y,
      borderStyle: "rounded",
      borderColor: RGBA.fromHex("#ffffff"),
      padding: 1,
      flexDirection: "column",
    })
  }

  protected onMouseEvent(event: MouseEvent): void {
    if (!dragModeEnabled) return

    switch (event.type) {
      case "down":
        this.isDragging = true
        this.dragOffsetX = event.x - this.x
        this.dragOffsetY = event.y - this.y
        this.zIndex = nextZIndex++
        event.stopPropagation()
        break

      case "drag-end":
        if (this.isDragging) {
          this.isDragging = false
          event.stopPropagation()
        }
        break

      case "drag":
        if (this.isDragging) {
          const newX = event.x - this.dragOffsetX
          const newY = event.y - this.dragOffsetY

          this.x = Math.max(0, Math.min(newX, this._ctx.width - this.width))
          this.y = Math.max(0, Math.min(newY, this._ctx.height - this.height))

          event.stopPropagation()
        }
        break
    }
  }
}

function getHeaderContent(): ReturnType<typeof t> {
  const dragStatus = dragModeEnabled ? fg("#34d399")("ON") : fg("#f87171")("OFF")
  return t`${bold(fg("#38bdf8")("OpenTUI Interactive Link Demo"))}
${fg("#94a3b8")("Click the links to open them.")} ${fg("#64748b")("Press")} ${bold(fg("#fbbf24")("d"))} ${fg("#64748b")("to toggle drag mode:")} ${dragStatus}
${italic(fg("#64748b")("(Terminal must support OSC 8 hyperlinks)"))}`
}

export function run(renderer: CliRenderer): void {
  renderer.start()
  renderer.setBackgroundColor("#0f172a") // Deep slate blue background

  let hoveredLinkId = 0
  const highlightHoveredLink = (buffer: OptimizedBuffer): void => {
    if (!hoveredLinkId) return

    const attributes = buffer.buffers.attributes
    for (let index = 0; index < attributes.length; index++) {
      if (getLinkId(attributes[index]!) === hoveredLinkId) attributes[index] |= TextAttributes.UNDERLINE
    }
  }

  const updateHoveredLink = (event: MouseEvent): void => {
    const nextLinkId = renderer.getLinkIdAt(event.x, event.y)
    if (nextLinkId === hoveredLinkId) return

    if (nextLinkId === 0 || hoveredLinkId === 0) renderer.setMousePointer(nextLinkId ? "pointer" : "default")
    hoveredLinkId = nextLinkId
    renderer.requestRender()
  }

  const container = new BoxRenderable(renderer, {
    id: "main-container",
    width: "100%",
    height: "100%",
    onMouseMove: updateHoveredLink,
    onMouseOver: updateHoveredLink,
  })
  renderer.root.add(container)

  // Header
  const header = new TextRenderable(renderer, {
    id: "header",
    content: getHeaderContent(),
    position: "absolute",
    left: 2,
    top: 1,
    zIndex: 10,
    width: 80,
    height: 4,
  })
  container.add(header)

  // Toggle drag mode with 'd' key
  const keyHandler = (event: KeyEvent) => {
    if (event.name === "d") {
      dragModeEnabled = !dragModeEnabled
      header.content = getHeaderContent()
    }
  }
  renderer.addPostProcessFn(highlightHoveredLink)
  renderer.keyInput.on("keypress", keyHandler)
  container.once(RenderableEvents.DESTROYED, () => {
    renderer.removePostProcessFn(highlightHoveredLink)
    renderer.keyInput.off("keypress", keyHandler)
  })

  // Card 1: Project Info
  createCard(
    renderer,
    container,
    "project-card",
    5,
    6,
    40,
    8,
    RGBA.fromHex("#1e293be6"), // Dark slate
    t`${bold(fg("#f472b6")("♥ Project Info"))}

${fg("#e2e8f0")("Source:")} ${link("https://github.com/anomalyco/opentui")(fg("#38bdf8")("GitHub Repository"))}
${fg("#e2e8f0")("Web:")}    ${link("https://opentui.com")(fg("#34d399")("Official Website"))}
${fg("#e2e8f0")("License:")} ${link("https://github.com/anomalyco/opentui/blob/main/LICENSE")(fg("#fbbf24")("MIT"))}`,
  )

  // Card 2: Documentation
  createCard(
    renderer,
    container,
    "docs-card",
    50,
    8,
    35,
    9,
    RGBA.fromHex("#334155e6"),
    t`${bold(fg("#a78bfa")("📚 Documentation"))}

${fg("#cbd5e1")("Get started with:")}
• ${link("https://github.com/anomalyco/opentui#readme")(bold(fg("#fff")("Quick Start")))}
• ${link("https://github.com/anomalyco/opentui/tree/main/packages/examples/src")(fg("#fff")("Examples"))}
• ${link("https://github.com/anomalyco/opentui/issues")(fg("#fff")("Known Issues"))}`,
  )

  // Card 3: Socials
  createCard(
    renderer,
    container,
    "social-card",
    20,
    16,
    30,
    7,
    RGBA.fromHex("#0f766ecc"), // Teal
    t`${bold(fg("#2dd4bf")("👋 Connect"))}

${link("https://x.com/anomalyco")(fg("#60a5fa")("Twitter / X"))}
${link("https://discord.gg/Fc8UPAeV")(fg("#818cf8")("Discord Community"))}`,
  )
}

function createCard(
  renderer: CliRenderer,
  container: BoxRenderable,
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  bg: RGBA,
  content: StyledText,
) {
  const card = new DraggableBox(renderer, id, x, y, width, height, bg)

  const text = new TextRenderable(renderer, {
    id: `${id}-text`,
    content: content,
    width: width - 2, // Account for padding
    height: height - 2,
    onMouseDown(event) {
      const url = event.button === 0 ? renderer.getLinkAt(event.x, event.y) : null
      if (!url) return

      event.preventDefault()
      event.stopPropagation()
      const command =
        process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open"
      const child = spawn(command, [url], { detached: true, stdio: "ignore" })
      child.on("error", (error) => console.error("Failed to open link:", error))
      child.unref()
    },
  })

  card.add(text)
  container.add(card)
}

export function destroy(renderer: CliRenderer): void {
  for (const box of draggableBoxes) {
    box.destroyRecursively()
  }
  draggableBoxes = []
  dragModeEnabled = false
  renderer.root.getRenderable("main-container")?.destroyRecursively()
  renderer.setMousePointer("default")
  renderer.setCursorPosition(0, 0, false)
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 60,
  })

  run(renderer)
  setupCommonDemoKeys(renderer)
}
