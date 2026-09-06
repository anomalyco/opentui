import {
  createCliRenderer,
  FrameBufferRenderable,
  RGBA,
  TextRenderable,
  BoxRenderable,
  OptimizedBuffer,
  t,
  bold,
  underline,
  fg,
  type MouseEvent,
  type KeyEvent,
} from "@opentui/core"
import type { CliRenderer, RenderContext } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

const GRAPHEME_LINES: string[] = [
  "東京都  北京市  서울시  大阪府  名古屋  横浜市  上海市",
  "👨‍👩‍👧‍👦  👩🏽‍💻  🏳️‍🌈  🇺🇸  🇩🇪  🇯🇵  🇮🇳  家族  絵文字  🎉🎊🎈",
  "こんにちは世界  你好世界  안녕하세요  สวัสดี  مرحبا",
  "漢字テスト  中文测试  한국어  日本語  繁體中文  简体中文",
  "🚀 Full-width: ＡＢＣＤＥＦ  Half: abcdef  ½ ⅞ ⅓",
  "混合テキスト mixed text with 漢字 and emoji 🎯",
]

const HEADER_HEIGHT = 2

let nextZIndex = 101
let draggableBoxes: DraggableBox[] = []
let scrimVisible = false
let scrim: BoxRenderable | null = null
let headerDisplay: TextRenderable | null = null

class DraggableBox extends BoxRenderable {
  private isDragging = false
  private dragOffsetX = 0
  private dragOffsetY = 0
  private alphaPercentage: number

  constructor(
    ctx: RenderContext,
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
    bg: RGBA,
    zIndex: number,
  ) {
    super(ctx, {
      id,
      width,
      height,
      zIndex,
      backgroundColor: bg,
      position: "absolute",
      left: x,
      top: y,
    })
    this.alphaPercentage = Math.round(bg.a * 100)
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer)

    const alphaText = `${this.alphaPercentage}%`
    const centerX = this.x + Math.floor(this.width / 2 - alphaText.length / 2)
    const centerY = this.y + Math.floor(this.height / 2)

    buffer.drawText(alphaText, centerX, centerY, RGBA.fromInts(255, 255, 255, 220))
  }

  protected onMouseEvent(event: MouseEvent): void {
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

class GraphemeBackground extends FrameBufferRenderable {
  constructor(ctx: RenderContext, id: string, width: number, height: number) {
    super(ctx, {
      id,
      width,
      height,
      position: "absolute",
      left: 0,
      top: HEADER_HEIGHT,
      respectAlpha: false,
    })

    this.fillGraphemes(width, height)
  }

  private fillGraphemes(width: number, height: number) {
    const fgColor = RGBA.fromInts(220, 220, 220, 255)
    const bgColor = RGBA.fromInts(10, 14, 20, 255)
    this.frameBuffer.clear(bgColor)
    for (let y = 0; y < height; y++) {
      const line = GRAPHEME_LINES[y % GRAPHEME_LINES.length]
      this.frameBuffer.drawText(line, 2, y, fgColor, bgColor)
    }
  }
}

function toggleScrim(renderer: CliRenderer) {
  scrimVisible = !scrimVisible
  if (scrim) scrim.visible = scrimVisible
  updateHeader()
  renderer.requestRender()
}

function updateHeader() {
  if (!headerDisplay) return
  const dimLabel = scrimVisible ? "D: hide scrim" : "D: show scrim"
  headerDisplay.content = t`${bold(fg("#00D4AA")("Wide Grapheme Overlay"))} ${fg("#A8A8B2")(`| ${dimLabel} | Drag boxes over CJK/emoji | Ctrl+C: quit`)}`
}

export function run(renderer: CliRenderer): void {
  renderer.start()
  renderer.setBackgroundColor("#0A0E14")

  const root = new BoxRenderable(renderer, { id: "wg-overlay-root" })
  renderer.root.add(root)

  // Header row
  headerDisplay = new TextRenderable(renderer, {
    id: "wg-header",
    height: HEADER_HEIGHT,
    position: "absolute",
    left: 2,
    top: 0,
    zIndex: 200,
    selectable: false,
  })
  updateHeader()
  root.add(headerDisplay)

  // Background filled with repeating wide grapheme lines, below the header
  const bgHeight = renderer.terminalHeight - HEADER_HEIGHT
  const background = new GraphemeBackground(renderer, "wg-background", renderer.terminalWidth, bgHeight)
  root.add(background)

  // Full-screen dimming scrim (same as opencode dialog backdrop: RGBA(0,0,0,150))
  scrim = new BoxRenderable(renderer, {
    id: "wg-scrim",
    position: "absolute",
    left: 0,
    top: HEADER_HEIGHT,
    width: renderer.terminalWidth,
    height: bgHeight,
    backgroundColor: RGBA.fromInts(0, 0, 0, 150),
    zIndex: 50,
  })
  scrim.visible = false
  root.add(scrim)

  // Draggable boxes at various alpha levels
  const box1 = new DraggableBox(
    renderer,
    "wg-box-50",
    4,
    HEADER_HEIGHT + 1,
    25,
    8,
    RGBA.fromValues(64 / 255, 176 / 255, 255 / 255, 128 / 255),
    100,
  )
  root.add(box1)
  draggableBoxes.push(box1)

  const box2 = new DraggableBox(
    renderer,
    "wg-box-75",
    20,
    HEADER_HEIGHT + 5,
    25,
    8,
    RGBA.fromValues(255 / 255, 107 / 255, 129 / 255, 192 / 255),
    100,
  )
  root.add(box2)
  draggableBoxes.push(box2)

  const box3 = new DraggableBox(
    renderer,
    "wg-box-25",
    40,
    HEADER_HEIGHT + 3,
    25,
    8,
    RGBA.fromValues(139 / 255, 69 / 255, 193 / 255, 64 / 255),
    100,
  )
  root.add(box3)
  draggableBoxes.push(box3)

  const box4 = new DraggableBox(
    renderer,
    "wg-box-opaque",
    60,
    HEADER_HEIGHT + 7,
    25,
    8,
    RGBA.fromValues(30 / 255, 30 / 255, 42 / 255, 1.0),
    100,
  )
  root.add(box4)
  draggableBoxes.push(box4)

  const keyHandler = (key: KeyEvent) => {
    if (key.name === "d") {
      key.preventDefault()
      toggleScrim(renderer)
    }
  }
  renderer.keyInput.on("keypress", keyHandler)
  root.once("destroyed", () => renderer.keyInput.off("keypress", keyHandler))

  const resizeHandler = (width: number, height: number) => {
    const h = height - HEADER_HEIGHT
    background.width = width
    background.height = h
    if (scrim) {
      scrim.width = width
      scrim.height = h
    }
    renderer.requestRender()
  }
  renderer.on("resize", resizeHandler)
  root.once("destroyed", () => renderer.off("resize", resizeHandler))
}

export function destroy(renderer: CliRenderer): void {
  renderer.clearFrameCallbacks()

  for (const box of draggableBoxes) {
    box.destroyRecursively()
  }
  draggableBoxes = []
  nextZIndex = 101
  scrimVisible = false
  scrim = null
  headerDisplay = null

  const root = renderer.root.getRenderable("wg-overlay-root")
  root?.destroyRecursively()
  renderer.setCursorPosition(0, 0, false)
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  })

  run(renderer)
  setupCommonDemoKeys(renderer)
  renderer.start()
}
