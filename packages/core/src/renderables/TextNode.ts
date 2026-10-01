import type { TextRenderable } from "./Text.js"
import { BaseRenderable, type BaseRenderableOptions } from "../Renderable.js"
import { RGBA, parseColor } from "../lib/RGBA.js"
import { isStyledText, StyledText } from "../lib/styled-text.js"
import { type TextChunk } from "../text-buffer.js"
import type { RenderContext } from "../types.js"

export interface TextNodeOptions extends BaseRenderableOptions {
  fg?: string | RGBA
  bg?: string | RGBA
  attributes?: number
  link?: { url: string }
}

const BrandedTextNodeRenderable: unique symbol = Symbol.for("@opentui/core/TextNodeRenderable")

export function isTextNodeRenderable(obj: any): obj is TextNodeRenderable {
  return !!obj?.[BrandedTextNodeRenderable]
}

function styledTextToTextNodes(styledText: StyledText): TextNodeRenderable[] {
  return styledText.chunks.map((chunk) => {
    const node = new TextNodeRenderable({
      fg: chunk.fg,
      bg: chunk.bg,
      attributes: chunk.attributes,
      link: chunk.link,
    })
    node.add(chunk.text)
    return node
  })
}

export class TextNodeRenderable extends BaseRenderable {
  [BrandedTextNodeRenderable] = true

  private _fg?: RGBA
  private _bg?: RGBA
  private _attributes: number
  private _link?: { url: string }
  private _children: (string | TextNodeRenderable)[] = []
  public parent: TextNodeRenderable | null = null

  constructor(options: TextNodeOptions) {
    super(options)

    this._fg = options.fg ? parseColor(options.fg) : undefined
    this._bg = options.bg ? parseColor(options.bg) : undefined
    this._attributes = options.attributes ?? 0
    this._link = options.link
  }

  public get children(): (string | TextNodeRenderable)[] {
    return this._children
  }

  public set children(children: (string | TextNodeRenderable)[]) {
    for (const child of this._children) {
      if (isTextNodeRenderable(child) && child.parent === this) {
        child.parent = null
      }
    }

    for (const child of children) {
      if (isTextNodeRenderable(child)) {
        if (child.parent && child.parent !== this) {
          child.parent.remove(child)
        }
        child.parent = this
      }
    }

    this._children = children
    this.requestRender()
  }

  public requestRender(): void {
    this.markDirty()
    this.parent?.requestRender()
  }

  public add(obj: TextNodeRenderable | StyledText | string, index?: number): number {
    if (typeof obj === "string") {
      if (index !== undefined) {
        this._children.splice(index, 0, obj)
        this.requestRender()
        return index
      }

      const insertIndex = this._children.length
      this._children.push(obj)
      this.requestRender()
      return insertIndex
    }

    if (isTextNodeRenderable(obj)) {
      const insertIndex = this.prepareChildInsert(obj, index)
      this._children.splice(insertIndex, 0, obj)
      obj.parent = this
      this.requestRender()
      return insertIndex
    }

    if (isStyledText(obj)) {
      const textNodes = styledTextToTextNodes(obj)
      if (index !== undefined) {
        this._children.splice(index, 0, ...textNodes)
        textNodes.forEach((node) => (node.parent = this))
        this.requestRender()
        return index
      }

      const insertIndex = this._children.length
      this._children.push(...textNodes)
      textNodes.forEach((node) => (node.parent = this))
      this.requestRender()
      return insertIndex
    }

    throw new Error("TextNodeRenderable only accepts strings, TextNodeRenderable instances, or StyledText instances")
  }

  private prepareChildInsert(child: TextNodeRenderable, index?: number): number {
    let insertIndex = index ?? this._children.length

    if (child.parent && child.parent !== this) {
      child.parent.remove(child)
    } else if (child.parent === this) {
      const currentIndex = this._children.indexOf(child)
      if (currentIndex !== -1) {
        this._children.splice(currentIndex, 1)
        if (currentIndex < insertIndex) insertIndex -= 1
      }
    }

    return Math.max(0, Math.min(insertIndex, this._children.length))
  }

  public replace(obj: TextNodeRenderable | string, index: number) {
    const existing = this._children[index]
    if (isTextNodeRenderable(existing) && existing.parent === this) {
      existing.parent = null
    }

    if (isTextNodeRenderable(obj)) {
      if (obj.parent && obj.parent !== this) {
        obj.parent.remove(obj)
      } else if (obj.parent === this) {
        const currentIndex = this._children.indexOf(obj)
        if (currentIndex !== -1 && currentIndex !== index) {
          this._children.splice(currentIndex, 1)
          if (currentIndex < index) index -= 1
        }
      }
      obj.parent = this
    }

    this._children[index] = obj
    this.requestRender()
  }

  public insertBefore(
    child: string | TextNodeRenderable | StyledText,
    anchorNode: TextNodeRenderable | string | unknown,
  ): this {
    if (!anchorNode || !isTextNodeRenderable(anchorNode)) {
      throw new Error("Anchor must be a TextNodeRenderable")
    }

    const anchorIndex = this._children.indexOf(anchorNode)
    if (anchorIndex === -1) {
      throw new Error("Anchor node not found in children")
    }

    if (child === anchorNode) {
      return this
    }

    if (isTextNodeRenderable(child)) {
      this.add(child, anchorIndex)
      return this
    }

    if (typeof child === "string") {
      this._children.splice(anchorIndex, 0, child)
    } else if (isStyledText(child)) {
      const textNodes = styledTextToTextNodes(child)
      this._children.splice(anchorIndex, 0, ...textNodes)
      textNodes.forEach((node) => (node.parent = this))
    } else {
      throw new Error("Child must be a string, TextNodeRenderable, or StyledText instance")
    }

    this.requestRender()
    return this
  }

  public remove(child: BaseRenderable): void {
    if (!isTextNodeRenderable(child)) {
      throw new Error("remove expects a TextNodeRenderable child object")
    }

    const childIndex = this._children.indexOf(child)
    if (childIndex === -1) {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`TextNodeRenderable with id ${child.id} is not a child of ${this.id}, skipping remove`)
      }
      return
    }

    this._children.splice(childIndex, 1)
    child.parent = null
    this.requestRender()
  }

  public clear(): void {
    for (const child of this._children) {
      if (isTextNodeRenderable(child) && child.parent === this) {
        child.parent = null
      }
    }
    this._children = []
    this.requestRender()
  }

  public mergeStyles(parentStyle: { fg?: RGBA; bg?: RGBA; attributes: number; link?: { url: string } }): {
    fg?: RGBA
    bg?: RGBA
    attributes: number
    link?: { url: string }
  } {
    return {
      fg: this._fg ?? parentStyle.fg,
      bg: this._bg ?? parentStyle.bg,
      attributes: this._attributes | parentStyle.attributes,
      link: this._link ?? parentStyle.link,
    }
  }

  public gatherWithInheritedStyle(
    parentStyle: { fg?: RGBA; bg?: RGBA; attributes: number; link?: { url: string } } = {
      fg: undefined,
      bg: undefined,
      attributes: 0,
    },
  ): TextChunk[] {
    const currentStyle = this.mergeStyles(parentStyle)

    const chunks: TextChunk[] = []

    for (const child of this._children) {
      if (typeof child === "string") {
        chunks.push({
          __isChunk: true,
          text: child,
          fg: currentStyle.fg,
          bg: currentStyle.bg,
          attributes: currentStyle.attributes,
          link: currentStyle.link,
        })
      } else {
        const childChunks = child.gatherWithInheritedStyle(currentStyle)
        chunks.push(...childChunks)
      }
    }

    this.markClean()

    return chunks
  }

  public static fromString(text: string, options: Partial<TextNodeOptions> = {}): TextNodeRenderable {
    const node = new TextNodeRenderable(options)
    node.add(text)
    return node
  }

  public static fromNodes(nodes: TextNodeRenderable[], options: Partial<TextNodeOptions> = {}): TextNodeRenderable {
    const node = new TextNodeRenderable(options)
    for (const childNode of nodes) {
      node.add(childNode)
    }
    return node
  }

  public toChunks(
    parentStyle: { fg?: RGBA; bg?: RGBA; attributes: number; link?: { url: string } } = {
      fg: undefined,
      bg: undefined,
      attributes: 0,
    },
  ): TextChunk[] {
    return this.gatherWithInheritedStyle(parentStyle)
  }

  public getChildren(): BaseRenderable[] {
    return this._children.filter((child): child is TextNodeRenderable => typeof child !== "string")
  }

  public getChildrenCount(): number {
    return this._children.length
  }

  public getRenderable(id: string): BaseRenderable | undefined {
    return this._children.find((child): child is TextNodeRenderable => typeof child !== "string" && child.id === id)
  }

  public getRenderableIndex(id: string): number {
    return this._children.findIndex((child) => isTextNodeRenderable(child) && child.id === id)
  }

  public get fg(): RGBA | undefined {
    return this._fg
  }

  public set fg(fg: RGBA | string | undefined) {
    if (!fg) {
      this._fg = undefined
      this.requestRender()
      return
    }
    this._fg = parseColor(fg)
    this.requestRender()
  }

  public set bg(bg: RGBA | string | undefined) {
    if (!bg) {
      this._bg = undefined
      this.requestRender()
      return
    }
    this._bg = parseColor(bg)
    this.requestRender()
  }

  public get bg(): RGBA | undefined {
    return this._bg
  }

  public set attributes(attributes: number) {
    this._attributes = attributes
    this.requestRender()
  }

  public get attributes(): number {
    return this._attributes
  }

  public set link(link: { url: string } | undefined) {
    this._link = link
    this.requestRender()
  }

  public get link(): { url: string } | undefined {
    return this._link
  }

  public findDescendantById(id: string): BaseRenderable | undefined {
    return undefined
  }
}

export class RootTextNodeRenderable extends TextNodeRenderable {
  textParent: TextRenderable

  constructor(
    private readonly ctx: RenderContext,
    options: TextNodeOptions,
    textParent: TextRenderable,
  ) {
    super(options)
    this.textParent = textParent
  }

  public requestRender(): void {
    this.markDirty()
    this.ctx.requestRender()
  }
}
