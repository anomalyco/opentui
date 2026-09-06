import { RGBA, parseColor, type ColorInput } from "./lib/RGBA.js"
import { type RenderLib, type ContextSyntaxStyleHandle } from "./zig.js"
import { createTextAttributes } from "./utils.js"
import type { NativeResourceOwner } from "./buffer.js"

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

function cloneStyle<T extends { fg?: RGBA; bg?: RGBA }>(style: T): T {
  return {
    ...style,
    fg: style.fg ? RGBA.clone(style.fg) : undefined,
    bg: style.bg ? RGBA.clone(style.bg) : undefined,
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
      flatStyles[scope] = cloneStyle(styleDefinition)
    }
  }

  return flatStyles
}

export class SyntaxStyle {
  private lib: RenderLib
  private native: { scene: NativeResourceOwner; handle: ContextSyntaxStyleHandle }
  private _destroyed: boolean = false
  private nameCache: Map<string, number> = new Map()
  private styleDefs: Map<string, StyleDefinition> = new Map()
  private mergedCache: Map<string, MergedStyle> = new Map()

  constructor(lib: RenderLib, handle: ContextSyntaxStyleHandle, scene: NativeResourceOwner) {
    if (!scene?.driver) throw new Error("SyntaxStyle requires an explicit resource owner")
    scene.assertAlive()
    if (
      scene.driver.renderLib !== lib ||
      !handle ||
      typeof handle !== "object" ||
      handle.context !== scene.driver.context
    ) {
      throw new Error("SyntaxStyle Context owner mismatch")
    }
    this.lib = lib
    this.native = { scene, handle }
  }

  static create(owner: NativeResourceOwner): SyntaxStyle {
    if (!owner?.driver) throw new Error("SyntaxStyle requires an explicit resource owner")
    owner.assertAlive()
    const lib = owner.driver.renderLib
    const handle = lib.createContextSyntaxStyle(owner.driver.context)
    try {
      return new SyntaxStyle(lib, handle, owner)
    } catch (error) {
      lib.destroyContextSyntaxStyle(owner.driver.context, handle)
      throw error
    }
  }

  static fromTheme(theme: ThemeTokenStyle[], owner: NativeResourceOwner): SyntaxStyle {
    return SyntaxStyle.fromStyles(convertThemeToStyles(theme), owner)
  }

  static fromStyles(
    styles: Record<string, StyleDefinitionInput> | Map<string, StyleDefinitionInput>,
    owner: NativeResourceOwner,
  ): SyntaxStyle {
    const style = SyntaxStyle.create(owner)
    try {
      for (const [name, styleDef] of styles instanceof Map ? styles : Object.entries(styles)) {
        style.registerStyle(name, styleDef)
      }
      return style
    } catch (error) {
      style.destroy()
      throw error
    }
  }

  private guard(): void {
    if (this._destroyed) throw new Error("NativeSyntaxStyle is destroyed")
    this.native.scene.assertAlive()
  }

  /** @internal Attachment borrows the destination-owned style; it never allocates a copy. */
  public _getSceneHandle(scene: NativeResourceOwner): ContextSyntaxStyleHandle {
    this.guard()
    scene.assertAlive()
    if (scene.driver.renderLib !== this.lib) throw new Error("SyntaxStyle library owner mismatch")
    if (this.native.scene !== scene)
      throw new Error("SyntaxStyle owner mismatch: bind definitions in the destination owner")
    return this.native.handle
  }

  public registerStyle(name: string, style: StyleDefinitionInput): number {
    this.guard()

    const { bold, italic, underline, dim, fg: foreground, bg: background } = style
    const definition: StyleDefinition = {
      bold,
      italic,
      underline,
      dim,
      fg: foreground ? RGBA.clone(parseColor(foreground)) : undefined,
      bg: background ? RGBA.clone(parseColor(background)) : undefined,
    }
    const attributes = createTextAttributes(definition)
    const fg = definition.fg ?? null
    const bg = definition.bg ?? null
    return this.lib.getYogaHost().runMutation(() => {
      const id = this.lib.contextSyntaxStyleRegister(this.native.handle.context, this.native.handle, name, {
        fg,
        bg,
        attributes,
      })
      this.nameCache.set(name, id)
      this.styleDefs.set(name, definition)
      this.mergedCache.clear()
      return id
    })
  }

  public resolveStyleId(name: string): number | null {
    this.guard()

    // Check cache first
    const cached = this.nameCache.get(name)
    if (cached !== undefined) return cached

    const id = this.lib.contextSyntaxStyleResolveByName(this.native.handle.context, this.native.handle, name)

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

  public getStyleCount(): number {
    this.guard()
    return this.lib.contextSyntaxStyleGetStyleCount(this.native.handle.context, this.native.handle)
  }

  public clearNameCache(): void {
    this.guard()
    this.nameCache.clear()
  }

  public getStyle(name: string): StyleDefinition | undefined {
    this.guard()

    if (Object.prototype.hasOwnProperty.call(this.styleDefs, name)) {
      return undefined
    }

    const style = this.styleDefs.get(name)
    if (style) return cloneStyle(style)

    if (name.includes(".")) {
      const baseName = name.split(".")[0]
      if (Object.prototype.hasOwnProperty.call(this.styleDefs, baseName)) {
        return undefined
      }
      const base = this.styleDefs.get(baseName)
      return base ? cloneStyle(base) : undefined
    }

    return undefined
  }

  public mergeStyles(...styleNames: string[]): MergedStyle {
    this.guard()

    const cacheKey = styleNames.join(":")
    const cached = this.mergedCache.get(cacheKey)
    if (cached) return cloneStyle(cached)

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

    return cloneStyle(merged)
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
    return new Map(Array.from(this.styleDefs, ([name, style]) => [name, cloneStyle(style)]))
  }

  public getRegisteredNames(): string[] {
    this.guard()
    return Array.from(this.styleDefs.keys())
  }

  public destroy(): void {
    if (this._destroyed) return
    this.lib.getYogaHost().runMutation(() => {
      if (!this.native.scene.driver.contextDisposed)
        this.lib.destroyContextSyntaxStyle(this.native.handle.context, this.native.handle)
      this._destroyed = true
      this.nameCache.clear()
      this.styleDefs.clear()
      this.mergedCache.clear()
    })
  }
}
