import type { KeyEvent, PasteEvent } from "../lib/KeyHandler.js"
import { decodePasteBytes, stripAnsiSequences } from "../lib/paste.js"
import { RGBA, parseColor, type ColorInput } from "../lib/RGBA.js"
import { type RenderContext } from "../types.js"
import { EditBufferRenderable, type EditBufferOptions } from "./EditBufferRenderable.js"
import {
  type KeyBinding as BaseKeyBinding,
  mergeKeyBindings,
  buildKeyBindingsMap,
  getKeyBindingAction,
  defaultKeyAliases,
  mergeKeyAliases,
} from "../lib/keybinding.internal.js"
import { type StyledText, fg } from "../lib/styled-text.js"
import type { ExtmarksController } from "../lib/extmarks.js"

export type TextareaAction =
  | "move-left"
  | "move-right"
  | "move-up"
  | "move-down"
  | "select-left"
  | "select-right"
  | "select-up"
  | "select-down"
  | "line-home"
  | "line-end"
  | "select-line-home"
  | "select-line-end"
  | "visual-line-home"
  | "visual-line-end"
  | "select-visual-line-home"
  | "select-visual-line-end"
  | "buffer-home"
  | "buffer-end"
  | "select-buffer-home"
  | "select-buffer-end"
  | "delete-line"
  | "delete-to-line-end"
  | "delete-to-line-start"
  | "backspace"
  | "delete"
  | "newline"
  | "undo"
  | "redo"
  | "word-forward"
  | "word-backward"
  | "select-word-forward"
  | "select-word-backward"
  | "delete-word-forward"
  | "delete-word-backward"
  | "select-all"
  | "submit"

export type KeyBinding = BaseKeyBinding<TextareaAction>
export type TextareaKeyAliasMap = Record<string, string>

export const defaultTextareaKeyBindings: KeyBinding[] = [
  { name: "left", action: "move-left" },
  { name: "right", action: "move-right" },
  { name: "up", action: "move-up" },
  { name: "down", action: "move-down" },
  { name: "left", shift: true, action: "select-left" },
  { name: "right", shift: true, action: "select-right" },
  { name: "up", shift: true, action: "select-up" },
  { name: "down", shift: true, action: "select-down" },
  { name: "home", action: "buffer-home" },
  { name: "end", action: "buffer-end" },
  { name: "home", shift: true, action: "select-buffer-home" },
  { name: "end", shift: true, action: "select-buffer-end" },
  { name: "a", ctrl: true, action: "line-home" },
  { name: "e", ctrl: true, action: "line-end" },
  { name: "a", ctrl: true, shift: true, action: "select-line-home" },
  { name: "e", ctrl: true, shift: true, action: "select-line-end" },
  { name: "a", meta: true, action: "visual-line-home" },
  { name: "e", meta: true, action: "visual-line-end" },
  { name: "a", meta: true, shift: true, action: "select-visual-line-home" },
  { name: "e", meta: true, shift: true, action: "select-visual-line-end" },
  { name: "f", ctrl: true, action: "move-right" },
  { name: "b", ctrl: true, action: "move-left" },
  { name: "w", ctrl: true, action: "delete-word-backward" },
  { name: "backspace", ctrl: true, action: "delete-word-backward" },
  { name: "d", meta: true, action: "delete-word-forward" },
  { name: "delete", meta: true, action: "delete-word-forward" },
  { name: "delete", ctrl: true, action: "delete-word-forward" },
  { name: "d", ctrl: true, shift: true, action: "delete-line" },
  { name: "k", ctrl: true, action: "delete-to-line-end" },
  { name: "u", ctrl: true, action: "delete-to-line-start" },
  { name: "backspace", action: "backspace" },
  { name: "backspace", shift: true, action: "backspace" },
  { name: "d", ctrl: true, action: "delete" },
  { name: "delete", action: "delete" },
  { name: "delete", shift: true, action: "delete" },
  { name: "return", action: "newline" },
  { name: "kpenter", action: "newline" },
  { name: "linefeed", action: "newline" },
  { name: "return", meta: true, action: "submit" },
  { name: "kpenter", meta: true, action: "submit" },

  // undo/redo
  { name: "-", ctrl: true, action: "undo" },
  { name: ".", ctrl: true, action: "redo" },
  { name: "z", super: true, action: "undo" },
  { name: "z", super: true, shift: true, action: "redo" },

  { name: "f", meta: true, action: "word-forward" },
  { name: "b", meta: true, action: "word-backward" },
  { name: "right", meta: true, action: "word-forward" },
  { name: "left", meta: true, action: "word-backward" },
  { name: "right", ctrl: true, action: "word-forward" },
  { name: "left", ctrl: true, action: "word-backward" },
  { name: "f", meta: true, shift: true, action: "select-word-forward" },
  { name: "b", meta: true, shift: true, action: "select-word-backward" },
  { name: "right", meta: true, shift: true, action: "select-word-forward" },
  { name: "left", meta: true, shift: true, action: "select-word-backward" },
  { name: "backspace", meta: true, action: "delete-word-backward" },

  // super (cmd/win) + arrow keys for Kitty Keyboard mode
  { name: "left", super: true, action: "visual-line-home" },
  { name: "right", super: true, action: "visual-line-end" },
  { name: "up", super: true, action: "buffer-home" },
  { name: "down", super: true, action: "buffer-end" },
  { name: "left", super: true, shift: true, action: "select-visual-line-home" },
  { name: "right", super: true, shift: true, action: "select-visual-line-end" },
  { name: "up", super: true, shift: true, action: "select-buffer-home" },
  { name: "down", super: true, shift: true, action: "select-buffer-end" },
  { name: "a", super: true, action: "select-all" },
]

export interface SubmitEvent {}

export interface TextareaOptions extends EditBufferOptions {
  initialValue?: string
  backgroundColor?: ColorInput
  textColor?: ColorInput
  focusedBackgroundColor?: ColorInput
  focusedTextColor?: ColorInput
  placeholder?: StyledText | string | null
  placeholderColor?: ColorInput
  keyBindings?: KeyBinding[]
  keyAliasMap?: TextareaKeyAliasMap
  onSubmit?: (event: SubmitEvent) => void
}

export class TextareaRenderable extends EditBufferRenderable {
  private _placeholder: StyledText | string | null
  private _placeholderColor: RGBA
  private _unfocusedBackgroundColor: RGBA
  private _unfocusedTextColor: RGBA
  private _focusedBackgroundColor: RGBA
  private _focusedTextColor: RGBA
  private _keyBindingsMap: Map<string, TextareaAction>
  private _keyAliasMap: TextareaKeyAliasMap
  private _keyBindings: KeyBinding[]
  private _actionHandlers: Map<TextareaAction, () => boolean>
  private _initialValueSet: boolean = false
  private _submitListener: ((event: SubmitEvent) => void) | undefined = undefined

  private static readonly defaults = {
    backgroundColor: "transparent",
    textColor: "#FFFFFF",
    focusedBackgroundColor: "transparent",
    focusedTextColor: "#FFFFFF",
    placeholder: null,
    placeholderColor: "#666666",
  } satisfies Partial<TextareaOptions>

  constructor(ctx: RenderContext, options: TextareaOptions) {
    const defaults = TextareaRenderable.defaults

    // Pass base colors to parent constructor (these become the unfocused colors)
    const baseOptions = {
      ...options,
      backgroundColor: options.backgroundColor || defaults.backgroundColor,
      textColor: options.textColor || defaults.textColor,
    }
    super(ctx, baseOptions)

    // Store unfocused colors separately (parent's properties get overwritten when focused)
    this._unfocusedBackgroundColor = parseColor(options.backgroundColor || defaults.backgroundColor)
    this._unfocusedTextColor = parseColor(options.textColor || defaults.textColor)
    this._focusedBackgroundColor = parseColor(
      options.focusedBackgroundColor || options.backgroundColor || defaults.focusedBackgroundColor,
    )
    this._focusedTextColor = parseColor(options.focusedTextColor || options.textColor || defaults.focusedTextColor)
    this._placeholder = options.placeholder ?? defaults.placeholder
    this._placeholderColor = parseColor(options.placeholderColor ?? defaults.placeholderColor)

    this._keyAliasMap = mergeKeyAliases(defaultKeyAliases, options.keyAliasMap || {})
    this._keyBindings = options.keyBindings || []
    const mergedBindings = mergeKeyBindings(defaultTextareaKeyBindings, this._keyBindings)
    this._keyBindingsMap = buildKeyBindingsMap(mergedBindings, this._keyAliasMap)
    this._actionHandlers = this.buildActionHandlers()
    this._submitListener = options.onSubmit

    if (options.initialValue) {
      this.setText(options.initialValue)
      this._initialValueSet = true
    }
    this.updateColors()

    this.applyPlaceholder(this._placeholder)
  }

  private applyPlaceholder(placeholder: StyledText | string | null): void {
    if (placeholder === null) {
      this.editorView.setPlaceholderStyledText([])
      return
    }

    if (typeof placeholder === "string") {
      const colorStyle = fg(this._placeholderColor)
      const chunks = [colorStyle(placeholder)]
      this.editorView.setPlaceholderStyledText(chunks)
    } else {
      this.editorView.setPlaceholderStyledText(placeholder.chunks)
    }
  }

  private buildActionHandlers(): Map<TextareaAction, () => boolean> {
    return new Map([
      ["move-left", () => this.moveCursorLeft()],
      ["move-right", () => this.moveCursorRight()],
      ["move-up", () => this.moveCursorUp()],
      ["move-down", () => this.moveCursorDown()],
      ["select-left", () => this.moveCursorLeft({ select: true })],
      ["select-right", () => this.moveCursorRight({ select: true })],
      ["select-up", () => this.moveCursorUp({ select: true })],
      ["select-down", () => this.moveCursorDown({ select: true })],
      ["line-home", () => this.gotoLineHome()],
      ["line-end", () => this.gotoLineEnd()],
      ["select-line-home", () => this.gotoLineHome({ select: true })],
      ["select-line-end", () => this.gotoLineEnd({ select: true })],
      ["visual-line-home", () => this.gotoVisualLineHome()],
      ["visual-line-end", () => this.gotoVisualLineEnd()],
      ["select-visual-line-home", () => this.gotoVisualLineHome({ select: true })],
      ["select-visual-line-end", () => this.gotoVisualLineEnd({ select: true })],
      ["select-buffer-home", () => this.gotoBufferHome({ select: true })],
      ["select-buffer-end", () => this.gotoBufferEnd({ select: true })],
      ["buffer-home", () => this.gotoBufferHome()],
      ["buffer-end", () => this.gotoBufferEnd()],
      ["delete-line", () => this.deleteLine()],
      ["delete-to-line-end", () => this.deleteToLineEnd()],
      ["delete-to-line-start", () => this.deleteToLineStart()],
      ["backspace", () => this.deleteCharBackward()],
      ["delete", () => this.deleteChar()],
      ["newline", () => this.newLine()],
      ["undo", () => this.undo()],
      ["redo", () => this.redo()],
      ["word-forward", () => this.moveWordForward()],
      ["word-backward", () => this.moveWordBackward()],
      ["select-word-forward", () => this.moveWordForward({ select: true })],
      ["select-word-backward", () => this.moveWordBackward({ select: true })],
      ["delete-word-forward", () => this.deleteWordForward()],
      ["delete-word-backward", () => this.deleteWordBackward()],
      ["select-all", () => this.selectAll()],
      ["submit", () => this.submit()],
    ])
  }

  public handlePaste(event: PasteEvent): void {
    this.insertText(stripAnsiSequences(decodePasteBytes(event.bytes)))
  }

  public handleKeyPress(key: KeyEvent): boolean {
    if (this.traits.suspend !== true) {
      const action = getKeyBindingAction(this._keyBindingsMap, key)

      if (action) {
        const handler = this._actionHandlers.get(action)
        if (handler) {
          return handler()
        }
      }
    }

    if (!key.ctrl && !key.meta && !key.super && !key.hyper) {
      if (key.name === "space") {
        this.insertText(" ")
        return true
      }

      if (key.sequence) {
        const firstCharCode = key.sequence.charCodeAt(0)

        if (firstCharCode < 32) {
          return false
        }

        if (firstCharCode === 127) {
          return false
        }

        this.insertText(key.sequence)
        return true
      }
    }

    return false
  }

  private updateColors(): void {
    const effectiveBg = this._focused ? this._focusedBackgroundColor : this._unfocusedBackgroundColor
    const effectiveFg = this._focused ? this._focusedTextColor : this._unfocusedTextColor

    super.backgroundColor = effectiveBg
    super.textColor = effectiveFg
  }

  public focus(): void {
    super.focus()
    this.updateColors()
  }

  public blur(): void {
    super.blur()
    if (!this.isDestroyed) {
      this.updateColors()
    }
  }

  get placeholder(): StyledText | string | null {
    return this._placeholder
  }

  set placeholder(value: StyledText | string | null | undefined) {
    const normalizedValue = value ?? null
    if (this._placeholder !== normalizedValue) {
      this._placeholder = normalizedValue
      this.applyPlaceholder(normalizedValue)
      this.requestRender()
    }
  }

  get placeholderColor(): RGBA {
    return this._placeholderColor
  }

  set placeholderColor(value: ColorInput) {
    const newColor = parseColor(value ?? TextareaRenderable.defaults.placeholderColor)
    if (this._placeholderColor !== newColor) {
      this._placeholderColor = newColor
      this.applyPlaceholder(this._placeholder)
      this.requestRender()
    }
  }

  override get backgroundColor(): RGBA {
    return this._unfocusedBackgroundColor
  }

  override set backgroundColor(value: RGBA | string | undefined) {
    const newColor = parseColor(value ?? TextareaRenderable.defaults.backgroundColor)
    if (this._unfocusedBackgroundColor !== newColor) {
      this._unfocusedBackgroundColor = newColor
      this.updateColors()
    }
  }

  override get textColor(): RGBA {
    return this._unfocusedTextColor
  }

  override set textColor(value: RGBA | string | undefined) {
    const newColor = parseColor(value ?? TextareaRenderable.defaults.textColor)
    if (this._unfocusedTextColor !== newColor) {
      this._unfocusedTextColor = newColor
      this.updateColors()
    }
  }

  set focusedBackgroundColor(value: ColorInput) {
    const newColor = parseColor(value ?? TextareaRenderable.defaults.focusedBackgroundColor)
    if (this._focusedBackgroundColor !== newColor) {
      this._focusedBackgroundColor = newColor
      this.updateColors()
    }
  }

  set focusedTextColor(value: ColorInput) {
    const newColor = parseColor(value ?? TextareaRenderable.defaults.focusedTextColor)
    if (this._focusedTextColor !== newColor) {
      this._focusedTextColor = newColor
      this.updateColors()
    }
  }

  set initialValue(value: string) {
    if (!this._initialValueSet) {
      this.setText(value)
      this._initialValueSet = true
    }
  }

  public submit(): boolean {
    if (this._submitListener) {
      this._submitListener({})
    }
    return true
  }

  public set onSubmit(handler: ((event: SubmitEvent) => void) | undefined) {
    this._submitListener = handler
  }

  public get onSubmit(): ((event: SubmitEvent) => void) | undefined {
    return this._submitListener
  }

  public set keyBindings(bindings: KeyBinding[]) {
    this._keyBindings = bindings
    const mergedBindings = mergeKeyBindings(defaultTextareaKeyBindings, bindings)
    this._keyBindingsMap = buildKeyBindingsMap(mergedBindings, this._keyAliasMap)
  }

  public set keyAliasMap(aliases: TextareaKeyAliasMap) {
    this._keyAliasMap = mergeKeyAliases(defaultKeyAliases, aliases)
    const mergedBindings = mergeKeyBindings(defaultTextareaKeyBindings, this._keyBindings)
    this._keyBindingsMap = buildKeyBindingsMap(mergedBindings, this._keyAliasMap)
  }

  public get extmarks(): ExtmarksController {
    return this.editorView.extmarks
  }
}
