import {
  ASCIIFontRenderable,
  BoxRenderable,
  CodeRenderable,
  DiffRenderable,
  InputRenderable,
  LineNumberRenderable,
  MarkdownRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  TabSelectRenderable,
  TextareaRenderable,
  TextAttributes,
  TextNodeRenderable,
  TextRenderable,
  type RenderContext,
  type TextNodeOptions,
} from "@opentui/core"
import type { RenderableConstructor } from "../types/elements"
export * from "./hooks"
export * from "./extras"
export * from "./slot"

class SpanRenderable extends TextNodeRenderable {
  constructor(
    private readonly _ctx: RenderContext | null,
    options: TextNodeOptions,
  ) {
    super(options)
  }
}

export const textNodeKeys = ["span", "b", "strong", "i", "em", "u", "a"] as const
export type TextNodeKey = (typeof textNodeKeys)[number]

class TextModifierRenderable extends SpanRenderable {
  constructor(options: any, modifier?: TextNodeKey) {
    super(null, options)

    // Set appropriate attributes based on modifier type
    if (modifier === "b" || modifier === "strong") {
      this.attributes = (this.attributes || 0) | TextAttributes.BOLD
    } else if (modifier === "i" || modifier === "em") {
      this.attributes = (this.attributes || 0) | TextAttributes.ITALIC
    } else if (modifier === "u") {
      this.attributes = (this.attributes || 0) | TextAttributes.UNDERLINE
    }
  }
}

export class BoldSpanRenderable extends TextModifierRenderable {
  constructor(options: any) {
    super(options, "b")
  }
}

export class ItalicSpanRenderable extends TextModifierRenderable {
  constructor(options: any) {
    super(options, "i")
  }
}

export class UnderlineSpanRenderable extends TextModifierRenderable {
  constructor(options: any) {
    super(options, "u")
  }
}

export class LineBreakRenderable extends SpanRenderable {
  constructor(_ctx: RenderContext | null, options: TextNodeOptions) {
    super(null, options)
    this.add()
  }

  public override add(): number {
    return super.add("\n")
  }
}

export interface LinkOptions extends TextNodeOptions {
  href: string
}

export class LinkRenderable extends SpanRenderable {
  constructor(_ctx: RenderContext | null, options: LinkOptions) {
    const linkOptions: TextNodeOptions = {
      ...options,
      link: { url: options.href },
    }
    super(null, linkOptions)
  }
}

export const baseComponents = {
  box: BoxRenderable,
  text: TextRenderable,
  input: InputRenderable,
  select: SelectRenderable,
  textarea: TextareaRenderable,
  ascii_font: ASCIIFontRenderable,
  tab_select: TabSelectRenderable,
  scrollbox: ScrollBoxRenderable,
  code: CodeRenderable,
  diff: DiffRenderable,
  line_number: LineNumberRenderable,
  markdown: MarkdownRenderable,

  span: SpanRenderable,
  strong: BoldSpanRenderable,
  b: BoldSpanRenderable,
  em: ItalicSpanRenderable,
  i: ItalicSpanRenderable,
  u: UnderlineSpanRenderable,
  br: LineBreakRenderable,
  a: LinkRenderable,
}

type ComponentCatalogue = Record<string, RenderableConstructor>

export const componentCatalogue: ComponentCatalogue = { ...baseComponents }

/**
 * Extend the component catalogue with new renderable components
 *
 * @example
 * ```tsx
 * // Extend with an object of components
 * extend({
 *   consoleButton: ConsoleButtonRenderable,
 *   customBox: CustomBoxRenderable
 * })
 * ```
 */
export function extend<T extends ComponentCatalogue>(objects: T): void {
  Object.assign(componentCatalogue, objects)
}

export function getComponentCatalogue(): ComponentCatalogue {
  return componentCatalogue
}

export type { ExtendedComponentProps, ExtendedIntrinsicElements, RenderableConstructor } from "../types/elements"
