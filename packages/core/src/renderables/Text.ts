import { BaseRenderable } from "../Renderable.js"
import { stringToStyledText, StyledText } from "../lib/styled-text.js"
import { type TextChunk } from "../text-buffer.js"
import { RGBA } from "../lib/RGBA.js"
import { type RenderContext } from "../types.js"
import { RootTextNodeRenderable, TextNodeRenderable } from "./TextNode.js"
import { TextBufferRenderable, type TextBufferOptions } from "./TextBufferRenderable.js"

export interface TextOptions extends TextBufferOptions {
  content?: StyledText | string
}

export class TextRenderable extends TextBufferRenderable {
  private _text!: StyledText | string

  // TODO: The TextRenderable is currently juggling both a StyledText and a RootTextNodeRenderable.
  // We should refactor this to only use the RootTextNodeRenderable here and have a separate StyledTextRenderable with `content`.
  private _hasManualStyledText: boolean = false

  protected rootTextNode!: RootTextNodeRenderable
  private readonly composeText = () => this.updateTextFromNodes()

  protected _contentDefaultOptions = {
    content: "",
  } satisfies Partial<TextOptions>

  constructor(ctx: RenderContext, options: TextOptions) {
    super(ctx, options)

    try {
      const initialContent = options.content
      const content = initialContent ?? this._contentDefaultOptions.content
      this.content = content
      this._hasManualStyledText = initialContent !== undefined && content !== ""
      this.onLifecyclePass = this.composeText
    } catch (error) {
      this.rollbackConstruction(error)
    }
  }

  get content(): StyledText {
    if (typeof this._text === "string") this._text = stringToStyledText(this._text)
    return this._text
  }

  get chunks(): TextChunk[] {
    return this.content.chunks
  }

  get textNode(): RootTextNodeRenderable {
    return (this.rootTextNode ??= new RootTextNodeRenderable(
      this._ctx,
      {
        id: `${this.id}-root`,
        fg: this._defaultFg,
        bg: this._defaultBg,
        attributes: this._defaultAttributes,
      },
      this,
    ))
  }

  set content(value: StyledText | string) {
    if (typeof value !== "string" && this._text === value) {
      this._hasManualStyledText = true
      this._ctx.nativeScene.lifecyclePasses.refresh(this)
      return
    }
    this._ctx.nativeScene.setText(this, value)
    this._text = value
    this._hasManualStyledText = true
    this._ctx.nativeScene.lifecyclePasses.refresh(this)
    this.requestRender()
    this.refreshLocalSelection()
    this.emit("line-info-change")
  }

  private updateTextFromNodes(): void {
    if (this.rootTextNode?.isDirty && !this._hasManualStyledText) {
      const style = {
        fg: this._defaultFg,
        bg: this._defaultBg,
        attributes: this._defaultAttributes,
        link: undefined,
      }
      const prepared = this.rootTextNode.prepareWithInheritedStyle(style)
      this._ctx.nativeScene.setText(this, new StyledText(prepared.chunks))
      prepared.acknowledge()
      this._ctx.nativeScene.lifecyclePasses.refresh(this)
      this.refreshLocalSelection()
      this.emit("line-info-change")
      return
    }
    this._ctx.nativeScene.lifecyclePasses.refresh(this)
  }

  override _needsLifecyclePass(): boolean {
    if (this.onLifecyclePass !== this.composeText) return super._needsLifecyclePass()
    return !this._hasManualStyledText && !!this.rootTextNode?.isDirty
  }

  public override requestRender(): void {
    if (this.isDestroyed) return
    this._ctx.nativeScene.lifecyclePasses.refresh(this)
    super.requestRender()
  }

  public add(obj: TextNodeRenderable | StyledText | string, index?: number): number {
    return this.textNode.add(obj, index)
  }

  public remove(child: BaseRenderable): void {
    this.textNode.remove(child)
  }

  public insertBefore(obj: BaseRenderable | any, anchor?: TextNodeRenderable): number {
    this.textNode.insertBefore(obj, anchor)
    return this.textNode.children.indexOf(obj)
  }

  public getTextChildren(): BaseRenderable[] {
    return this.rootTextNode?.getChildren() ?? []
  }

  public clear(): void {
    this._ctx.nativeScene.setText(this, "")
    this._text = stringToStyledText("")
    this.rootTextNode?.clear()
    this.requestRender()
    this.refreshLocalSelection()
    this.emit("line-info-change")
  }

  protected onFgChanged(newColor: RGBA): void {
    if (this.rootTextNode) this.rootTextNode.fg = newColor
  }

  protected onBgChanged(newColor: RGBA): void {
    if (this.rootTextNode) this.rootTextNode.bg = newColor
  }

  protected onAttributesChanged(newAttributes: number): void {
    if (this.rootTextNode) this.rootTextNode.attributes = newAttributes
  }

  protected override destroyOwnedResources(): void {
    this.runCleanup((run) => {
      run(() => {
        if (this.rootTextNode) {
          for (const child of this.rootTextNode.getChildren()) {
            if (child.parent === this.rootTextNode) child.parent = null
          }
        }
        if (this.rootTextNode) this.rootTextNode.children.length = 0
      })
      run(() => super.destroyOwnedResources())
    })
  }
}
