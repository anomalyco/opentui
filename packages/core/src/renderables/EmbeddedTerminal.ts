import { type RenderableOptions, Renderable } from "../Renderable.js"
import type { KeyEvent, PasteEvent } from "../lib/KeyHandler.js"
import { RGBA } from "../lib/RGBA.js"
import type { RenderContext } from "../types.js"
import type { MouseEvent } from "../renderer.js"
import type { OptimizedBuffer } from "../buffer.js"
import type { ContextEmbeddedTerminalHandle, EmbeddedTerminalKey, EmbeddedTerminalMouse, RenderLib } from "../zig.js"
import { convertGlobalToLocalSelection, type Selection } from "../lib/selection.js"

export type EmbeddedTerminalDataSource = "input" | "response"

export interface EmbeddedTerminalOptions extends RenderableOptions<EmbeddedTerminalRenderable> {
  cols?: number
  rows?: number
  maxScrollback?: number
  onData?: (data: Uint8Array, source: EmbeddedTerminalDataSource) => void
  onTerminalResize?: (cols: number, rows: number) => void
  onScreenChange?: () => void
  selectable?: boolean
}

export type EmbeddedTerminalScreen = {
  text: string
  lines: string[]
  columns: number
  rows: number
  cursor: {
    x: number
    y: number
    visible: boolean
  }
}

const MOD_SHIFT = 1 << 0
const MOD_CTRL = 1 << 1
const MOD_ALT = 1 << 2
const MOD_SUPER = 1 << 3
const MOD_CAPS_LOCK = 1 << 4
const MOD_NUM_LOCK = 1 << 5

export class EmbeddedTerminalRenderable extends Renderable {
  public selectable: boolean = true
  private readonly lib: RenderLib
  private handle: ContextEmbeddedTerminalHandle | null = null
  private _onData?: (data: Uint8Array, source: EmbeddedTerminalDataSource) => void
  private _onTerminalResize?: (cols: number, rows: number) => void
  private _onScreenChange?: () => void
  private keyreleaseHandler: ((key: KeyEvent) => void) | null = null
  private selection = false
  private composedHookGeneration = 0n

  constructor(ctx: RenderContext, options: EmbeddedTerminalOptions) {
    const cols = options.cols ?? (typeof options.width === "number" ? options.width : 80)
    const rows = options.rows ?? (typeof options.height === "number" ? options.height : 24)
    super(ctx, {
      ...options,
      width: options.width ?? cols,
      height: options.height ?? rows,
      buffered: true,
    })
    this._focusable = true
    this.lib = ctx.nativeScene.driver.renderLib

    try {
      this._onData = options.onData
      this._onTerminalResize = options.onTerminalResize
      this._onScreenChange = options.onScreenChange
      this.selectable = options.selectable ?? true
      const config = { cols, rows, maxScrollback: options.maxScrollback }
      this.handle = this.lib.createContextEmbeddedTerminal(ctx.nativeScene.driver.context, config)
      this.setupMouse(options)
    } catch (error) {
      this.rollbackConstruction(error)
    }
  }

  public get onData(): ((data: Uint8Array, source: EmbeddedTerminalDataSource) => void) | undefined {
    return this._onData
  }

  public set onData(value: ((data: Uint8Array, source: EmbeddedTerminalDataSource) => void) | undefined) {
    this._onData = value
  }

  public get onTerminalResize(): ((cols: number, rows: number) => void) | undefined {
    return this._onTerminalResize
  }

  public set onTerminalResize(value: ((cols: number, rows: number) => void) | undefined) {
    this._onTerminalResize = value
  }

  public get onScreenChange(): (() => void) | undefined {
    return this._onScreenChange
  }

  public set onScreenChange(value: (() => void) | undefined) {
    this._onScreenChange = value
  }

  public screen(): EmbeddedTerminalScreen {
    const cursor = this.handle
      ? this.lib.contextEmbeddedTerminalCursor(this.handle.context, this.handle)
      : { x: 0, y: 0, visible: false, hasValue: false }
    const lines = this.frameBuffer
      ? new TextDecoder()
          .decode(this.frameBuffer.getRealCharBytes(true))
          .split("\n")
          .slice(0, this.height)
          .map((line) => line.trimEnd())
      : []
    while (lines.at(-1) === "") lines.pop()
    return {
      text: lines.join("\n"),
      lines,
      columns: this.width,
      rows: this.height,
      cursor: {
        x: cursor.x,
        y: cursor.y,
        visible: cursor.hasValue && cursor.visible,
      },
    }
  }

  public write(data: string | Uint8Array): void {
    if (!this.handle) return
    this.lib.contextEmbeddedTerminalWrite(this.handle.context, this.handle, data)
    try {
      this.flushResponses()
    } finally {
      this.requestRender()
    }
  }

  public invalidate(): void {
    if (!this.handle) return
    this.lib.contextEmbeddedTerminalInvalidate(this.handle.context, this.handle)
    this.requestRender()
  }

  public encodeKey(key: KeyEvent): Uint8Array {
    if (!this.handle) return new Uint8Array()
    const text = textualKey(key)
    const physical = physicalKey(key)
    const options: EmbeddedTerminalKey = {
      action: key.eventType === "release" ? "release" : key.repeated ? "repeat" : "press",
      key: physical,
      mods: modifiers(key),
      text,
      unshiftedCodepoint: unshiftedCodepoint(key, physical),
    }
    return this.lib.contextEmbeddedTerminalEncodeKey(this.handle.context, this.handle, options)
  }

  public encodePaste(bytes: Uint8Array): Uint8Array {
    if (!this.handle) return new Uint8Array()
    return this.lib.contextEmbeddedTerminalEncodePaste(this.handle.context, this.handle, bytes)
  }

  public shouldStartSelection(x: number, y: number): boolean {
    if (!this.selectable) return false
    const localX = x - this.x
    const localY = y - this.y
    return localX >= 0 && localX < this.width && localY >= 0 && localY < this.height
  }

  public onSelectionChanged(selection: Selection | null): boolean {
    if (!this.handle) return false
    const local = convertGlobalToLocalSelection(selection, Math.trunc(this.x), Math.trunc(this.y))
    if (!local?.isActive) {
      if (!this.selection) return false
      this.lib.contextEmbeddedTerminalClearSelection(this.handle.context, this.handle)
      this.selection = false
      this.requestRender()
      return false
    }

    // Only gate the start of a cell drag; returning to the anchor after dragging is a valid selection.
    if (
      !this.selection &&
      local.behavior === "cell" &&
      local.anchorX === local.focusX &&
      local.anchorY === local.focusY
    )
      return false

    const point = (x: number, y: number) => {
      if (y < 0) return { x: 0, y: 0 }
      if (y >= this.height) return { x: this.width - 1, y: this.height - 1 }
      return { x: Math.max(0, Math.min(this.width - 1, x)), y }
    }
    const start = point(local.anchorX, local.anchorY)
    const end = point(local.focusX, local.focusY)
    this.lib.contextEmbeddedTerminalSetSelection(this.handle.context, this.handle, start, end)
    this.selection = true
    this.requestRender()
    return true
  }

  public hasSelection(): boolean {
    return this.selection
  }

  public getSelectedText(): string {
    if (!this.handle || !this.selection) return ""
    return new TextDecoder().decode(this.lib.contextEmbeddedTerminalGetSelectedText(this.handle.context, this.handle))
  }

  public focus(): void {
    if (this.focused) return
    super.focus()
    if (!this.focused) return
    this.keyreleaseHandler = (key) => this.handleKeyPress(key)
    this.ctx._internalKeyInput.onInternal("keyrelease", this.keyreleaseHandler)
    try {
      this.sendFocus(true)
    } catch (error) {
      this.removeKeyreleaseHandler()
      super.blur()
      throw error
    }
  }

  public blur(): void {
    if (!this.focused) return
    try {
      this.sendFocus(false)
    } catch {
      // User callbacks must not prevent focus or native resource cleanup.
    } finally {
      this.removeKeyreleaseHandler()
      super.blur()
      this._ctx.setCursorPosition(0, 0, false)
    }
  }

  public handleKeyPress(key: KeyEvent): boolean {
    const output = this.encodeKey(key)
    this.send(output, "input")
    return output.byteLength > 0
  }

  public handlePaste(event: PasteEvent): void {
    this.send(this.encodePaste(event.bytes), "input")
  }

  protected onResize(width: number, height: number): void {
    super.onResize(width, height)
    if (!this.handle || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
    const cols = Math.min(Math.floor(width), 0xffff)
    const rows = Math.min(Math.floor(height), 0xffff)
    this.lib.contextEmbeddedTerminalResize(this.handle.context, this.handle, cols, rows)
    this.lib.contextEmbeddedTerminalInvalidate(this.handle.context, this.handle)
    this.flushResponses()
    this._onTerminalResize?.(cols, rows)
  }

  protected override _invokeNativePaint(buffer: OptimizedBuffer, deltaTime: number): void {
    const generation = this._nativeSceneHookGeneration
    super._invokeNativePaint(buffer, deltaTime)
    // A replaced body can keep painting after super.renderSelf() returns.
    // Hiding can skip composition; retain pending invalidation until shown.
    if (this.visible) this.composedHookGeneration = generation
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    if (!this.handle || !this.frameBuffer || !this.visible || this.isDestroyed) return
    // A hook can dirty retained cells, even if it removes itself before this paint.
    if (
      this.renderBefore ||
      this.renderAfter ||
      this.composedHookGeneration !== this._nativeSceneHookGeneration ||
      this.renderSelf !== EmbeddedTerminalRenderable.prototype.renderSelf
    ) {
      this.lib.contextEmbeddedTerminalInvalidate(this.handle.context, this.handle)
    }
    const target = buffer._getSceneDrawTarget(this._ctx.nativeScene)
    this.lib.contextEmbeddedTerminalCompose(target.context, this.handle, target.target, target.frame, 0, 0)
    this._onScreenChange?.()
    if (!this.focused) return
    const cursor = this.lib.contextEmbeddedTerminalCursor(this.handle.context, this.handle)
    const visible = cursor.visible && cursor.hasValue
    const cursorX = cursor.wideTail && cursor.x > 0 ? cursor.x - 1 : cursor.x
    this._ctx.setCursorPosition(this._screenX + cursorX + 1, this._screenY + cursor.y + 1, visible)
    if (!visible) return
    this._ctx.setCursorStyle({
      style: cursor.style === "bar" ? "line" : cursor.style === "underline" ? "underline" : "block",
      blinking: cursor.blinking,
    })
    if (cursor.color) this._ctx.setCursorColor(RGBA.fromInts(cursor.color.r, cursor.color.g, cursor.color.b, 255))
  }

  protected destroySelf(): void {
    const handle = this.handle
    this.handle = null
    this.selection = false
    this.removeKeyreleaseHandler()
    try {
      if (handle && !this._ctx.nativeScene.driver.contextDisposed) {
        this.lib.destroyContextEmbeddedTerminal(handle.context, handle)
      }
    } finally {
      this._ctx.setCursorPosition(0, 0, false)
      super.destroySelf()
    }
  }

  protected onRemove(): void {
    if (this.focused) this.blur()
  }

  private setupMouse(options: EmbeddedTerminalOptions): void {
    const { onMouseDown, onMouseUp, onMouseMove, onMouseDrag, onMouseScroll } = options
    this.onMouseDown = (event) => {
      this.forwardMouse(event, "press")
      onMouseDown?.call(this, event)
    }
    this.onMouseUp = (event) => {
      this.forwardMouse(event, "release")
      onMouseUp?.call(this, event)
    }
    this.onMouseMove = (event) => {
      this.forwardMouse(event, "motion")
      onMouseMove?.call(this, event)
    }
    this.onMouseDrag = (event) => {
      this.forwardMouse(event, "motion")
      onMouseDrag?.call(this, event)
    }
    this.onMouseScroll = (event) => {
      this.forwardMouse(event, "press")
      onMouseScroll?.call(this, event)
    }
  }

  private forwardMouse(event: MouseEvent, action: EmbeddedTerminalMouse["action"]): void {
    if (!this.handle) return
    if (event.type === "down" && event.button === 0) this.focus()
    if (!this.handle) return
    const mouse = {
      action,
      button: event.type === "move" && !event.isDragging ? undefined : mouseButton(event),
      mods: modifiers(event.modifiers),
      x: event.x - this._screenX,
      y: event.y - this._screenY,
      anyButtonPressed: event.isDragging === true || event.type === "down",
    }
    const output = this.lib.contextEmbeddedTerminalEncodeMouse(this.handle.context, this.handle, mouse)
    if (event.type === "scroll" && output.byteLength === 0) {
      const direction = event.scroll?.direction
      if (direction !== "up" && direction !== "down") return
      const delta = direction === "up" ? -3 : 3
      this.lib.contextEmbeddedTerminalScroll(this.handle.context, this.handle, delta)
      this.requestRender()
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (output.byteLength === 0) return
    event.preventDefault()
    event.stopPropagation()
    this.send(output, "input")
  }

  private flushResponses(): void {
    if (!this.handle) return
    this.send(this.lib.contextEmbeddedTerminalDrainResponses(this.handle.context, this.handle), "response")
  }

  private sendFocus(focused: boolean): void {
    if (!this.handle) return
    this.send(this.lib.contextEmbeddedTerminalEncodeFocus(this.handle.context, this.handle, focused), "input")
  }

  private removeKeyreleaseHandler(): void {
    if (!this.keyreleaseHandler) return
    this.ctx._internalKeyInput.offInternal("keyrelease", this.keyreleaseHandler)
    this.keyreleaseHandler = null
  }

  private send(data: Uint8Array, source: EmbeddedTerminalDataSource): void {
    if (data.byteLength > 0) this._onData?.(data, source)
  }
}

function modifiers(input: {
  shift?: boolean
  ctrl?: boolean
  alt?: boolean
  meta?: boolean
  option?: boolean
  super?: boolean
  capsLock?: boolean
  numLock?: boolean
}) {
  let value = 0
  if (input.shift) value |= MOD_SHIFT
  if (input.ctrl) value |= MOD_CTRL
  if (input.alt || input.option) value |= MOD_ALT
  if (input.meta || input.super) value |= MOD_SUPER
  if (input.capsLock) value |= MOD_CAPS_LOCK
  if (input.numLock) value |= MOD_NUM_LOCK
  return value
}

function physicalKey(key: KeyEvent) {
  if (key.code && !key.code.startsWith("[")) return key.code
  const name = key.baseCode === undefined ? key.name : String.fromCodePoint(key.baseCode)
  if (/^[a-z]$/i.test(name)) return `Key${name.toUpperCase()}`
  if (/^[0-9]$/.test(name)) return `Digit${name}`
  return (
    {
      backspace: "Backspace",
      enter: "Enter",
      return: "Enter",
      space: "Space",
      tab: "Tab",
      delete: "Delete",
      end: "End",
      home: "Home",
      insert: "Insert",
      pagedown: "PageDown",
      pageup: "PageUp",
      down: "ArrowDown",
      left: "ArrowLeft",
      right: "ArrowRight",
      up: "ArrowUp",
      escape: "Escape",
    }[key.name.toLowerCase()] ?? ""
  )
}

function textualKey(key: KeyEvent) {
  if (key.sequence.length > 0 && !/[\p{Cc}]/u.test(key.sequence)) return key.sequence
  if (key.name === "space") return " "
  if (key.name.length === 0 || /[\p{Cc}]/u.test(key.name)) return
  if ([...key.name].length === 1 || /[^\x00-\x7f]/.test(key.name)) return key.name
}

function unshiftedCodepoint(key: KeyEvent, code: string | undefined) {
  // Kitty's baseCode is a physical-layout alternative, not the active layout's character.
  if (key.name === "space") return 32
  if ([...key.name].length === 1) return key.name.codePointAt(0)!
  if (code?.startsWith("Key") && code.length === 4) return code.charCodeAt(3) + 32
  if (code?.startsWith("Digit") && code.length === 6) return code.charCodeAt(5)
  return 0
}

function mouseButton(event: MouseEvent): EmbeddedTerminalMouse["button"] {
  if (event.type === "scroll") {
    if (event.scroll?.direction === "up") return "four"
    if (event.scroll?.direction === "down") return "five"
    if (event.scroll?.direction === "left") return "six"
    if (event.scroll?.direction === "right") return "seven"
    return
  }
  return ({ 0: "left", 1: "middle", 2: "right", 4: "four", 5: "five" } as const)[event.button]
}
