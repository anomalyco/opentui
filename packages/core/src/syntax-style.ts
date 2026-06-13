import { RGBA, parseColor, type ColorInput } from "./lib/RGBA.js"
import { resolveRenderLib, type RenderLib, type SyntaxStyleHandle } from "./zig.js"
import { createTextAttributes } from "./utils.js"

export interface StyleDefinition {
  fg?: RGBA
  bg?: RGBA
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
}

export interface StyleDefinitionInput {
  fg?: ColorInput
  bg?: ColorInput
  bold?: boolean
  italic?: boolean
  underline?: boolean
  dim?: boolean
}

export interface MergedStyle {
  fg?: RGBA
  bg?: RGBA
  attributes: number
}

export interface ThemeTokenStyle {
  scope: string[]
  style: {
    foreground?: ColorInput
    background?: ColorInput
    bold?: boolean
    italic?: boolean
    underline?: boolean
    dim?: boolean
  }
}

export function convertThemeToStyles(theme: ThemeTokenStyle[]): Record<string, StyleDefinition> {
  const flatStyles: Record<string, StyleDefinition> = {}

  for (const tokenStyle of theme) {
    const styleDefinition: StyleDefinition = {}

    if (tokenStyle.style.foreground) {
      styleDefinition.fg = parseColor(tokenStyle.style.foreground)
    }
    if (tokenStyle.style.background) {
      styleDefinition.bg = parseColor(tokenStyle.style.background)
    }

    if (tokenStyle.style.bold !== undefined) {
      styleDefinition.bold = tokenStyle.style.bold
    }
    if (tokenStyle.style.italic !== undefined) {
      styleDefinition.italic = tokenStyle.style.italic
    }
    if (tokenStyle.style.underline !== undefined) {
      styleDefinition.underline = tokenStyle.style.underline
    }
    if (tokenStyle.style.dim !== undefined) {
      styleDefinition.dim = tokenStyle.style.dim
    }

    // Apply the same style to all scopes
    for (const scope of tokenStyle.scope) {
      flatStyles[scope] = styleDefinition
    }
  }

  return flatStyles
}

export class SyntaxStyle {
  private lib: RenderLib
  private stylePtr: SyntaxStyleHandle
  private _destroyed: boolean = false
  private nameCache: Map<string, number> = new Map()
  private styleDefs: Map<string, StyleDefinition> = new Map()
  private mergedCache: Map<string, MergedStyle> = new Map()

  constructor(lib: RenderLib, ptr: SyntaxStyleHandle) {
    this.lib = lib
    this.stylePtr = ptr
  }

  static create(): SyntaxStyle {
    const lib = resolveRenderLib()
    const ptr = lib.createSyntaxStyle()
    return new SyntaxStyle(lib, ptr)
  }

  static fromTheme(theme: ThemeTokenStyle[]): SyntaxStyle {
    const style = SyntaxStyle.create()
    const flatStyles = convertThemeToStyles(theme)

    for (const [name, styleDef] of Object.entries(flatStyles)) {
      style.registerStyle(name, styleDef)
    }

    return style
  }

  static fromStyles(styles: Record<string, StyleDefinitionInput>): SyntaxStyle {
    const style = SyntaxStyle.create()

    for (const [name, styleDef] of Object.entries(styles)) {
      style.registerStyle(name, styleDef)
    }

    return style
  }

  private guard(): void {
    if (this._destroyed) throw new Error("NativeSyntaxStyle is destroyed")
  }

  public registerStyle(name: string, style: StyleDefinitionInput): number {
    this.guard()

    const attributes = createTextAttributes({
      bold: style.bold,
      italic: style.italic,
      underline: style.underline,
      dim: style.dim,
    })

    const fg = style.fg ? parseColor(style.fg) : null
    const bg = style.bg ? parseColor(style.bg) : null
    const id = this.lib.syntaxStyleRegister(this.stylePtr, name, fg, bg, attributes)

    this.nameCache.set(name, id)
    this.styleDefs.set(name, { ...style, fg: fg ?? undefined, bg: bg ?? undefined })

    return id
  }

  public resolveStyleId(name: string): number | null {
    this.guard()

    // Check cache first
    const cached = this.nameCache.get(name)
    if (cached !== undefined) return cached

    const id = this.lib.syntaxStyleResolveByName(this.stylePtr, name)

    if (id !== null) {
      this.nameCache.set(name, id)
    }

    return id
  }

  public getStyleId(name: string): number | null {
    this.guard()

    const id = this.resolveStyleId(name)
    if (id !== null) return id

    // Try base name if it's a scoped style
    if (name.includes(".")) {
      const baseName = name.split(".")[0]
      return this.resolveStyleId(baseName)
    }

    return null
  }

  public get ptr(): SyntaxStyleHandle {
    this.guard()
    return this.stylePtr
  }

  public getStyleCount(): number {
    this.guard()
    return this.lib.syntaxStyleGetStyleCount(this.stylePtr)
  }

  public clearNameCache(): void {
    this.nameCache.clear()
  }

  public getStyle(name: string): StyleDefinition | undefined {
    this.guard()

    if (Object.prototype.hasOwnProperty.call(this.styleDefs, name)) {
      return undefined
    }

    const style = this.styleDefs.get(name)
    if (style) return style

    if (name.includes(".")) {
      const baseName = name.split(".")[0]
      if (Object.prototype.hasOwnProperty.call(this.styleDefs, baseName)) {
        return undefined
      }
      return this.styleDefs.get(baseName)
    }

    return undefined
  }

  public mergeStyles(...styleNames: string[]): MergedStyle {
    this.guard()

    const cacheKey = styleNames.join(":")
    const cached = this.mergedCache.get(cacheKey)
    if (cached) return cached

    const styleDefinition: StyleDefinition = {}

    for (const name of styleNames) {
      const style = this.getStyle(name)

      if (!style) continue

      if (style.fg) styleDefinition.fg = style.fg
      if (style.bg) styleDefinition.bg = style.bg
      if (style.bold !== undefined) styleDefinition.bold = style.bold
      if (style.italic !== undefined) styleDefinition.italic = style.italic
      if (style.underline !== undefined) styleDefinition.underline = style.underline
      if (style.dim !== undefined) styleDefinition.dim = style.dim
    }

    const attributes = createTextAttributes({
      bold: styleDefinition.bold,
      italic: styleDefinition.italic,
      underline: styleDefinition.underline,
      dim: styleDefinition.dim,
    })

    const merged: MergedStyle = {
      fg: styleDefinition.fg,
      bg: styleDefinition.bg,
      attributes,
    }

    this.mergedCache.set(cacheKey, merged)

    return merged
  }

  public clearCache(): void {
    this.guard()
    this.mergedCache.clear()
  }

  public getCacheSize(): number {
    this.guard()
    return this.mergedCache.size
  }

  public getAllStyles(): Map<string, StyleDefinition> {
    this.guard()
    return new Map(this.styleDefs)
  }

  public getRegisteredNames(): string[] {
    this.guard()
    return Array.from(this.styleDefs.keys())
  }

  public destroy(): void {
    if (this._destroyed) return
    this._destroyed = true
    this.nameCache.clear()
    this.styleDefs.clear()
    this.mergedCache.clear()
    this.lib.destroySyntaxStyle(this.stylePtr)
  }
}
