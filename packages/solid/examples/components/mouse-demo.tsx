import {
  BoxRenderable,
  OptimizedBuffer,
  RGBA,
  MouseEvent,
  t,
  bold,
  underline,
  fg,
  type RenderContext,
} from "@opentui/core"
import { useContext } from "solid-js"
import { RendererContext } from "../../src/elements/hooks.js"

let nextZIndex = 101
class DraggableTransparentBox extends BoxRenderable {
  private isDragging = false
  private dragOffsetX = 0
  private dragOffsetY = 0
  private alphaPercentage: number
  private screenSizeX = 199
  private screenSizeY = 52

  protected override onResize(width: number, height: number): void {
    // this.screenSizeX = width;
    // this.screenSizeY = height;
    this.screenSizeX = 199
    this.screenSizeY = 52
  }

  constructor(ctx: RenderContext, x: number, y: number, width: number, height: number, bg: RGBA, zIndex: number) {
    super(ctx, {
      width,
      height,
      zIndex,
      backgroundColor: bg,
      titleAlignment: "center",
      position: "absolute",
      left: x,
      top: y,
      border: true,
    })
    this.alphaPercentage = Math.round(bg.a * 100)
  }

  normalizeCoordinates(x: number, y: number): { x: number; y: number } {
    if (this.screenSizeX === 0) {
      return { x, y }
    }
    return {
      x: x / this.screenSizeX,
      y: y / this.screenSizeY,
    }
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer)

    const alphaText = `${this.alphaPercentage}%`
    const centerX = this.x + Math.floor(this.width / 2 - alphaText.length / 2)
    const centerY = this.y + Math.floor(this.height / 2)

    buffer.drawText(alphaText, centerX, centerY, RGBA.fromInts(255, 255, 255, 220))

    const id = RGBA.fromInts(68, 69, 69)

    const nm = this.normalizeCoordinates(this.x, this.y)
    const nms = this.normalizeCoordinates(this.x + this.width, this.y + this.height)

    const topLeft = RGBA.fromValues(nm.x, nm.y, 0)
    const bottomRight = RGBA.fromValues(nms.x, nms.y, 0)
    buffer.drawText("x", 1, 0, id, id)
    buffer.drawText("x", 1, 0, topLeft, topLeft)
    buffer.drawText("x", 2, 0, bottomRight, bottomRight)
    // buffer.drawText(`${nm.x}-${nm.y}`, 1, 1, RGBA.fromHex("#ffffff"), RGBA.fromHex("#000000"));
    // buffer.drawText(`${nms.x}-${nms.y}`, 1, 2, RGBA.fromHex("#ffffff"), RGBA.fromHex("#000000"));
  }

  protected override onMouseEvent(event: MouseEvent): void {
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
          this.x =
            Math.max(0, Math.min(event.x - this.dragOffsetX, this._ctx.width - this.width)) - (this.parent?.x ?? 0)
          this.y =
            Math.max(4, Math.min(event.y - this.dragOffsetY, this._ctx.height - this.height)) - (this.parent?.y ?? 0)

          event.stopPropagation()
        }
        break
    }
  }
}

export default function MouseDraggableScene() {
  const solidRenderer = useContext(RendererContext)
  if (!solidRenderer) {
    throw new Error("No renderer found")
  }
  const alphaBox50 = new DraggableTransparentBox(
    solidRenderer,
    15,
    5,
    25,
    8,
    RGBA.fromValues(64 / 255, 176 / 255, 255 / 255, 128 / 255),
    50,
  )

  const headerText = t`${bold(underline(fg("#00D4AA")("Interactive Alpha Transparency & Blending Demo - Drag the boxes!")))}
${fg("#A8A8B2")("Click and drag any transparent box to move it around • Watch how transparency layers blend")}`

  return (
    <box zIndex={10} marginTop={1}>
      <text>{headerText}</text>
      {alphaBox50}
    </box>
  )
}
