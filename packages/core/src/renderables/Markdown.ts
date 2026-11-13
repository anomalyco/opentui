import { Renderable, type RenderableOptions, type NativeRenderableIntegration } from "../Renderable.js"
import { TextAttributes, type RenderContext, type TerminalCapabilities } from "../types.js"
import { SyntaxStyle } from "../syntax-style.js"
import type { TextChunk } from "../text-buffer.js"
import { createTextAttributes } from "../utils.js"
import type { BorderStyle } from "../lib/border.js"
import { RGBA, parseColor, type ColorInput } from "../lib/RGBA.js"
import { CodeRenderable } from "./Code.js"
import { BoxRenderable } from "./Box.js"
import { StyledText } from "../lib/styled-text.js"
import { TextRenderable } from "./Text.js"
import {
  TextTableRenderable,
  type TextTableColumnFitter,
  type TextTableColumnWidthMode,
  type TextTableContent,
} from "./TextTable.js"
import { getTreeSitterClient, type TreeSitterClient } from "../lib/tree-sitter/index.js"
import { infoStringToFiletype } from "../lib/tree-sitter/resolve-ft.js"
import { Gutter } from "../yoga.js"
import { nativeConstants as md } from "../native-abi.generated.js"
import type { NativeMarkdownBlock, NativeMarkdownOptions } from "../zig.js"
import { MarkdownDocument, type MarkdownChanges } from "./markdown-document.js"

export type MarkdownTableStyle = "grid" | "columns"

export interface MarkdownTableOptions {
  /**
   * Visual style preset for markdown tables.
   * - "grid": boxed table with visible borders (the default).
   * - "columns": borderless columns optimized for separated block output.
   */
  style?: MarkdownTableStyle
  /**
   * Strategy for sizing table columns.
   * - "content": columns fit to intrinsic content width.
   * - "full": columns expand to fill available width.
   */
  widthMode?: TextTableColumnWidthMode
  /**
   * Column fitting method when shrinking constrained tables.
   */
  columnFitter?: TextTableColumnFitter
  /**
   * Wrapping strategy for table cell content.
   */
  wrapMode?: "none" | "char" | "word"
  /**
   * Padding applied on all sides of each table cell.
   */
  cellPadding?: number
  /**
   * Horizontal padding applied on the left and right of each table cell.
   */
  cellPaddingX?: number
  /**
   * Vertical padding applied above and below each table cell.
   */
  cellPaddingY?: number
  /**
   * Enables/disables table border rendering.
   */
  borders?: boolean
  /**
   * Overrides outer border visibility. Defaults to `borders`.
   */
  outerBorder?: boolean
  /**
   * Border style for markdown tables.
   */
  borderStyle?: BorderStyle
  /**
   * Border color for markdown tables. Defaults to conceal style color.
   */
  borderColor?: ColorInput
  /**
   * Enables/disables selection support on markdown tables.
   */
  selectable?: boolean
}

export interface MarkdownOptions extends RenderableOptions<MarkdownRenderable> {
  content?: string
  syntaxStyle: SyntaxStyle
  fg?: ColorInput
  bg?: ColorInput
  /** Controls concealment for markdown syntax markers in markdown text blocks. */
  conceal?: boolean
  /** Controls concealment inside fenced code blocks rendered by CodeRenderable. */
  concealCode?: boolean
  /** Highlights fenced code blocks. Paragraphs, headings and tables never reach it. */
  treeSitterClient?: TreeSitterClient
  /**
   * Whether more content is still to come. While streaming, the last line shows as far as it is decided: a line
   * that may still become a table row, a fence's end or a heading's underline waits for its end, and an emphasis
   * or code span that has not closed yet draws as if it had. Set it to false once the content is complete; the
   * document then shows as it would from one `content` without streaming.
   */
  streaming?: boolean
  /**
   * Options for internally rendered markdown tables.
   */
  tableOptions?: MarkdownTableOptions
  /**
   * Custom block renderer, called for each top-level block and each code block at any depth when it is built or
   * changes. Return a Renderable to show instead, or undefined/null for the default rendering, which
   * `context.defaultRender()` also returns.
   */
  renderBlock?: (block: MarkdownBlock, context: RenderNodeContext) => Renderable | undefined | null
  /**
   * Rewrites the display text of every paragraph, heading and table cell, in lists and quotes too, before it is
   * shown: to show IDs as titled links, for example. Code blocks and `renderBlock` results never reach it. It runs
   * when a block is drawn or changes, and must be synchronous.
   */
  inlineHook?: MarkdownInlineHook
  /** When set, the hook runs only on blocks and cells whose source contains one of these strings. */
  inlineHookFilter?: readonly string[]
  /**
   * Delimiter extensions to parse. `"math"`: `$…$` and `\(…\)` are inline math, and `$$` or `\[` lines open a
   * display math block, a code block of the language `math`.
   */
  extensions?: readonly "math"[]
}

/** One piece of a prose block's display text, as an inline hook sees and returns it. */
export interface MarkdownInlineSpan {
  text: string
  fg?: RGBA
  bg?: RGBA
  attributes?: number
  /** A hyperlink Markdown already found (a Markdown link, an autolink or a bare URL). */
  link?: { url: string }
  /** Whether the span is a code span. Without conceal its text keeps the backticks. */
  code: boolean
  /** Inline math: its TeX without delimiters. Set only with `extensions: ["math"]`. */
  math?: string
  /** What a click on the span means to the app, such as a session ID. Never sent to the terminal. */
  target?: string
}

/** What an inline hook knows about the block or table cell. */
export interface MarkdownInlineContext {
  /** The block's or cell's Markdown source. */
  source: string
  conceal: boolean
  syntaxStyle: SyntaxStyle
  /** Whether the spans are one table cell's content; false for paragraphs and headings, in lists and quotes too. */
  tableCell: boolean
}

export type MarkdownInlineHook = (spans: MarkdownInlineSpan[], context: MarkdownInlineContext) => MarkdownInlineSpan[]

export interface RenderNodeContext {
  syntaxStyle: SyntaxStyle
  conceal: boolean
  concealCode: boolean
  treeSitterClient?: TreeSitterClient
  /** Creates the default renderable for this block, or returns the one it shows. */
  defaultRender: () => Renderable | null
}

export type MarkdownBlockKind =
  | "paragraph"
  | "heading"
  | "code"
  | "html"
  | "rule"
  | "table"
  | "row"
  | "cell"
  | "quote"
  | "list"
  | "item"

/** A block of the document, read when a renderer needs it. */
export interface MarkdownBlock {
  /** The block's id: its place in document order, counting nested blocks. */
  readonly index: number
  readonly kind: MarkdownBlockKind
  /** A heading's level, 1 to 6. */
  readonly level?: number
  /** Whether a list is numbered, and its first number. */
  readonly ordered?: boolean
  readonly start?: number
  /** A task item's box; undefined for other items. */
  readonly checked?: boolean
  /** A code block's language (the first word of its info string; `math` for display math) and info string. */
  readonly lang?: string
  readonly info?: string
  /** Whether a code block's closing delimiter arrived. */
  readonly closed?: boolean
  /** The block's Markdown source. */
  readonly raw: string
  /** A code block's code, or a paragraph's, heading's or cell's display text; empty for other blocks. */
  readonly text: string
  readonly children: readonly MarkdownBlock[]
}

/** A fenced, indented or display math code block. */
export interface MarkdownCodeBlock extends MarkdownBlock {
  readonly type: "code"
  readonly kind: "code"
  readonly lang: string
  readonly info: string
  readonly closed: boolean
}

export type MarkdownCodeBlockRenderer = (
  block: MarkdownCodeBlock,
  context: RenderNodeContext,
) => Renderable | undefined | null

export type MarkdownCodeBlockRendererMap =
  | ReadonlyMap<string, MarkdownCodeBlockRenderer>
  | Readonly<Record<string, MarkdownCodeBlockRenderer>>

type MarkdownRenderBlock = NonNullable<MarkdownOptions["renderBlock"]> & {
  codeBlockOnly?: boolean
}

export function createMarkdownCodeBlockRenderer(
  renderers: MarkdownCodeBlockRendererMap,
): MarkdownOptions["renderBlock"] {
  const rendererMap = new Map<string, MarkdownCodeBlockRenderer>()
  const maybeMap = renderers as Partial<ReadonlyMap<string, MarkdownCodeBlockRenderer>>
  if (typeof maybeMap.forEach === "function")
    maybeMap.forEach((renderer, language) => rendererMap.set(language, renderer))
  else for (const [language, renderer] of Object.entries(renderers)) rendererMap.set(language, renderer)

  const renderBlock: MarkdownRenderBlock = (block, context) => {
    if (block.kind !== "code") return undefined
    const language = infoStringToFiletype(block.lang ?? "")
    if (!language) return undefined
    return rendererMap.get(language)?.(block as MarkdownCodeBlock, context)
  }
  renderBlock.codeBlockOnly = true
  return renderBlock
}

interface ResolvedTableRenderableOptions {
  columnWidthMode: TextTableColumnWidthMode
  columnFitter: TextTableColumnFitter
  wrapMode: "none" | "char" | "word"
  cellPadding: number
  cellPaddingX: number
  cellPaddingY: number
  columnGap: number
  border: boolean
  outerBorder: boolean
  showBorders: boolean
  borderStyle: BorderStyle
  borderColor: ColorInput
  fg?: RGBA
  selectable: boolean
}

function colorsEqual(left?: RGBA, right?: RGBA): boolean {
  if (!left || !right) return left === right
  return left.equals(right)
}

function cloneTableOptions(options: MarkdownTableOptions | undefined): MarkdownTableOptions | undefined {
  if (!options) return undefined
  return {
    ...options,
    borderColor: options.borderColor ? RGBA.clone(parseColor(options.borderColor)) : undefined,
  }
}

const kindNames: readonly MarkdownBlockKind[] = [
  "paragraph",
  "heading",
  "code",
  "html",
  "rule",
  "table",
  "row",
  "cell",
  "quote",
  "list",
  "item",
]

const isProse = (kind: number) => kind === md.OT_MD_PARAGRAPH || kind === md.OT_MD_HEADING
const sameRecord = (a: NativeMarkdownBlock, b: NativeMarkdownBlock) =>
  a.kind === b.kind &&
  a.flags === b.flags &&
  a.parent === b.parent &&
  a.sourceStart === b.sourceStart &&
  a.sourceEnd === b.sourceEnd &&
  a.infoStart === b.infoStart &&
  a.infoEnd === b.infoEnd &&
  a.number === b.number
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder("utf-8", { ignoreBOM: true })
const sameChunks = (a: TextChunk[], b: TextChunk[]) =>
  a.length === b.length &&
  a.every(
    (chunk, index) =>
      chunk.text === b[index]!.text &&
      colorsEqual(chunk.fg, b[index]!.fg) &&
      colorsEqual(chunk.bg, b[index]!.bg) &&
      (chunk.attributes ?? 0) === (b[index]!.attributes ?? 0) &&
      chunk.link?.url === b[index]!.link?.url,
  )

/**
 * The click targets of a text the host writes, as display-byte ranges. They change only with the text, and native code
 * answers no byte of a text until a frame paints it, so they are always those of the text a lookup reads.
 */
type Targets = [start: number, end: number, target: string][]

/** Whether `inner` is `outer` or inside it. */
function holds(outer: Renderable, inner: Renderable): boolean {
  for (let at: Renderable | null = inner; at; at = at.parent) if (at === outer) return true
  return false
}

/** What shows block i (document order); table rows and cells have none: their table shows them. */
interface Shown {
  /** The block's record as last shown: a renderer runs again only when it changes. */
  record: NativeMarkdownBlock
  /** What the block's parent holds: the default renderable, or a renderer's result. */
  renderable?: Renderable
  /**
   * The default renderable while it shows, on its own or inside a renderer's result: it is written and styled, and
   * the block's children go in it. Without one, a renderer's result shows the block and its children.
   */
  default?: Renderable
  /** Where the block's children go: a quote's or list's box, an item's body. */
  container?: Renderable
  marker?: TextRenderable
  /** The parser output last written by the host to a paragraph or heading, so an unchanged one is not written again. */
  written?: string
  /** Whether the doc has the paragraph's or heading's node bound. */
  bound?: boolean
  /** A table cell's content as its table shows it, kept until the cell changes. */
  cell?: TextChunk[]
  targets?: Targets
  /** A list's items and whether one is loose, and the gap and marker width it shows; an item's place and gap. */
  count?: number
  loose?: boolean
  gap?: number
  width?: number
  ordinal?: number
}

/** What a call's changes touch besides each block: tables to fill, lists to lay out again, items to mark. */
interface Refresh {
  tables: Set<number>
  lists: Set<number>
  items: Set<number>
}

export class MarkdownRenderable extends Renderable {
  static override readonly nativeIntegration: NativeRenderableIntegration = {
    ...Renderable.nativeIntegration,
  }
  private static _capabilitySubscriptions = new WeakMap<
    RenderContext,
    { renderables: Set<MarkdownRenderable>; listener: (capabilities: TerminalCapabilities) => void }
  >()
  private _doc: MarkdownDocument
  private _shown: Shown[] = []
  private _syntaxStyle: SyntaxStyle
  private _fg?: RGBA
  private _bg?: RGBA
  private _conceal: boolean
  private _concealCode: boolean
  private _treeSitterClient?: TreeSitterClient
  private _tableOptions?: MarkdownTableOptions
  private _renderBlock?: MarkdownOptions["renderBlock"]
  private _streaming: boolean
  private _inlineHook?: MarkdownInlineHook
  private _inlineHookFilter?: readonly string[]
  private _extensions: readonly "math"[]
  // The style's definitions in this Context when the style lives in another (a scrollback surface's renderer).
  private _styleCopy?: { source: SyntaxStyle; copy: SyntaxStyle }
  // The engine flags the doc has, so an option change sends only a real change.
  private _flags = 0
  // The source before the call being applied, when it changed, for blocks the call takes back.
  private _before?: string
  private _beforeBytes?: Uint8Array
  // The blocks a call showed, which a restyle in the same call does not show again.
  private _shownInCall?: Set<number>
  private _styleDirty: boolean = false
  private readonly applyStyleChanges = () => this.rerenderDirtyStyles()

  protected _contentDefaultOptions = {
    content: "",
    conceal: true,
    concealCode: false,
    streaming: false,
  } satisfies Partial<MarkdownOptions>

  constructor(ctx: RenderContext, options: MarkdownOptions) {
    super(ctx, {
      ...options,
      flexDirection: "column",
      flexShrink: options.flexShrink ?? 0,
    })

    try {
      this._syntaxStyle = options.syntaxStyle
      this._fg = options.fg ? RGBA.clone(parseColor(options.fg)) : undefined
      this._bg = options.bg ? RGBA.clone(parseColor(options.bg)) : undefined
      this._conceal = options.conceal ?? this._contentDefaultOptions.conceal
      this._concealCode = options.concealCode ?? this._contentDefaultOptions.concealCode
      this._treeSitterClient = options.treeSitterClient
      this._tableOptions = cloneTableOptions(options.tableOptions)
      this._renderBlock = options.renderBlock
      this._streaming = options.streaming ?? this._contentDefaultOptions.streaming
      this._inlineHook = options.inlineHook
      this._inlineHookFilter = options.inlineHookFilter
      this._extensions = options.extensions ?? []
      this.setGap(Gutter.Row, 1)
      const { renderLib, context } = ctx.nativeScene.driver
      this._doc = new MarkdownDocument(renderLib, context, this.engineOptions())
      this._flags = this.engineFlags()
      this.apply(this._doc.write(options.content ?? this._contentDefaultOptions.content, this._streaming))
      this.onLifecyclePass = this.applyStyleChanges

      let subscription = MarkdownRenderable._capabilitySubscriptions.get(ctx)
      if (!subscription) {
        const renderables = new Set<MarkdownRenderable>()
        subscription = {
          renderables,
          listener: () => {
            for (const renderable of renderables) renderable.changeOptions()
          },
        }
        ctx.on("capabilities", subscription.listener)
        MarkdownRenderable._capabilitySubscriptions.set(ctx, subscription)
      }
      subscription.renderables.add(this)
    } catch (error) {
      try {
        this.destroyRecursively()
      } catch {
        // Preserve the construction failure.
      }
      throw error
    }
  }

  get content(): string {
    return this._doc.content
  }

  set content(value: string) {
    if (this.isDestroyed || value === this._doc.content) return
    this.assertMutable()
    this.change(() => this._doc.write(value, this._streaming))
  }

  get syntaxStyle(): SyntaxStyle {
    return this._syntaxStyle
  }

  set syntaxStyle(value: SyntaxStyle) {
    if (this._syntaxStyle !== value) {
      this._syntaxStyle = value
      // The doc's bound text repaints with the new style; host-written leaves come back listed, and are written again
      // even when the parser's output is unchanged, since a hook reads the style.
      for (const shown of this._shown) shown.written = undefined
      this.change(() => this._doc.setOptions(this.engineOptions()))
      this.markStyleDirty()
    }
  }

  get treeSitterClient(): TreeSitterClient | undefined {
    return this._treeSitterClient
  }

  set treeSitterClient(value: TreeSitterClient | undefined) {
    if (this._treeSitterClient === value) return
    this._treeSitterClient = value ?? undefined
    for (const shown of this._shown) {
      if (shown.default instanceof CodeRenderable) shown.default.treeSitterClient = value ?? getTreeSitterClient()
    }
  }

  get fg(): RGBA | undefined {
    return this._fg ? RGBA.clone(this._fg) : undefined
  }

  set fg(value: ColorInput | undefined) {
    const next = value ? RGBA.clone(parseColor(value)) : undefined
    if (!colorsEqual(this._fg, next)) {
      this._fg = next
      this.markStyleDirty()
    }
  }

  get bg(): RGBA | undefined {
    return this._bg ? RGBA.clone(this._bg) : undefined
  }

  set bg(value: ColorInput | undefined) {
    const next = value ? RGBA.clone(parseColor(value)) : undefined
    if (!colorsEqual(this._bg, next)) {
      this._bg = next
      this.markStyleDirty()
    }
  }

  get conceal(): boolean {
    return this._conceal
  }

  set conceal(value: boolean) {
    if (this._conceal !== value) {
      this._conceal = value
      this.changeOptions()
      // The hook sees conceal, so it runs again where the parser's output did not change.
      this.rerunInlineHook(() => true)
      this.markStyleDirty()
    }
  }

  get concealCode(): boolean {
    return this._concealCode
  }

  set concealCode(value: boolean) {
    if (this._concealCode !== value) {
      this._concealCode = value
      this.markStyleDirty()
    }
  }

  get streaming(): boolean {
    return this._streaming
  }

  set streaming(value: boolean) {
    if (this.isDestroyed || this._streaming === value) return
    this.assertMutable()
    this._streaming = value
    const shown = new Set<number>()
    this._shownInCall = shown
    try {
      this.change(() => this._doc.write(this._doc.content, value))
    } finally {
      this._shownInCall = undefined
    }
    // Code blocks follow the stream's end, and renderers see it, once each.
    this.restyle(shown)
  }

  get tableOptions(): MarkdownTableOptions | undefined {
    return cloneTableOptions(this._tableOptions)
  }

  set tableOptions(value: MarkdownTableOptions | undefined) {
    this._tableOptions = cloneTableOptions(value)
    this.restyle()
    this.requestRender()
  }

  get renderBlock(): MarkdownOptions["renderBlock"] | undefined {
    return this._renderBlock
  }

  set renderBlock(value: MarkdownOptions["renderBlock"] | undefined) {
    if (this.isDestroyed || this._renderBlock === value) return
    this.assertMutable()
    this._renderBlock = value
    this.rebuild()
  }

  get inlineHook(): MarkdownInlineHook | undefined {
    return this._inlineHook
  }

  set inlineHook(value: MarkdownInlineHook | undefined) {
    if (this._inlineHook === value) return
    const swap = this._inlineHook && value
    this._inlineHook = value
    // Another hook marks the same leaves; turning one on or off parses again.
    if (swap) this.rerunInlineHook(() => true)
    else this.changeOptions(true)
  }

  get inlineHookFilter(): readonly string[] | undefined {
    return this._inlineHookFilter
  }

  set inlineHookFilter(value: readonly string[] | undefined) {
    if (this._inlineHookFilter === value) return
    this._inlineHookFilter = value
    this.changeOptions(true)
  }

  get extensions(): readonly "math"[] {
    return this._extensions
  }

  set extensions(value: readonly "math"[] | null | undefined) {
    if (this._extensions === value) return
    this._extensions = value ?? []
    this.changeOptions()
  }

  /** Each block the document holds, in document order (the index is the block's id), with what shows it. */
  get blocks(): readonly { kind: MarkdownBlockKind; renderable: Renderable | undefined }[] {
    return this._shown.map((shown) => ({ kind: kindNames[shown.record.kind]!, renderable: shown.renderable }))
  }

  /**
   * How many top-level blocks are final: their rows equal those a render of the finished document draws, except
   * that a link definition arriving after a committed block used its label makes that label a link. It counts from
   * the first block and never goes down while the content only grows.
   */
  get committedBlockCount(): number {
    return this._doc.committed
  }

  /**
   * Runs the inline hook again on the paragraphs, headings and table cells it rewrites whose source `select`
   * accepts, for a change only the hook knows about, such as a new title for an ID it links. Nothing is parsed or
   * highlighted again. Does nothing without a hook.
   */
  public rerunInlineHook(select: (source: string) => boolean): void {
    if (!this._inlineHook) return
    const tables = new Set<number>()
    this._doc.blocks.forEach((block, index) => {
      if ((block.flags & md.OT_MD_BLOCK_HOOKED) === 0) return
      if (block.kind === md.OT_MD_TABLE_CELL) {
        if (select(this._doc.readSource(index))) tables.add(this.tableOf(index))
      } else if (isProse(block.kind) && !this.isHidden(index) && select(this._doc.readSource(index))) {
        this.writeProse(index, true)
      }
    })
    // A table's cells run again together, as a table shows them.
    for (const table of tables) {
      for (let at = table + 1, end = this.subtreeEnd(table); at < end; at++) this._shown[at]!.cell = undefined
      this.fillTable(table)
    }
    this.requestRender()
  }

  /** The `target` of the inline hook span the latest finished frame drew at screen cell (x, y), if any. */
  public targetAt(x: number, y: number): string | undefined {
    const scene = this.ctx.nativeScene
    const hit = Renderable.renderablesByNumber.get(scene.hitTest(x, y))
    if (!hit) return undefined
    const shown = this._shown.find((shown) => shown.targets && shown.default === hit)
    if (!shown?.targets) return undefined
    const byte = scene.textByteAt(hit, x, y)
    if (byte === undefined) return undefined
    return shown.targets.find(([start, end]) => start <= byte && byte < end)?.[2]
  }

  public clearCache(): void {
    this.rebuild()
  }

  public refreshStyles(): void {
    this._styleDirty = false
    this._ctx.nativeScene.lifecyclePasses.refresh(this)
    // A copy of a style from another Context takes its definitions again.
    if (this._styleCopy) {
      this._styleCopy.copy.destroy()
      this._styleCopy = undefined
      this.change(() => this._doc.setOptions(this.engineOptions()))
    }
    this.restyle()
    // Text the host writes holds resolved colors.
    this._shown.forEach((_, index) => {
      const block = this._doc.blocks[index]!
      const host = block.kind === md.OT_MD_HTML || (isProse(block.kind) && this.hostWrites(block))
      if (host && !this.isHidden(index)) this.writeProse(index, true)
    })
    this.requestRender()
  }

  private engineFlags(): number {
    let flags = 0
    if (this._conceal) flags |= md.OT_MD_CONCEAL
    // The terminal owns the capability; the doc gets it from here (N5).
    if (this.ctx.capabilities?.hyperlinks === true) flags |= md.OT_MD_HYPERLINKS
    if (this._extensions.includes("math")) flags |= md.OT_MD_MATH
    // An empty filter selects no block.
    if (this._inlineHook && this._inlineHookFilter?.length !== 0) flags |= md.OT_MD_HOOK
    return flags
  }

  private engineOptions(): NativeMarkdownOptions {
    return {
      flags: this.engineFlags(),
      syntaxStyle: this.nativeStyle(),
      hookFilter: this._inlineHook ? this._inlineHookFilter : undefined,
    }
  }

  /** The style the doc binds: the style itself, or a copy of its definitions when it lives in another Context. */
  private nativeStyle() {
    const style = this._syntaxStyle
    const scene = this.ctx.nativeScene
    if (!style) return null
    if (style._ownedBy(scene)) return style._getSceneHandle(scene)
    if (this._styleCopy?.source !== style) {
      this._styleCopy?.copy.destroy()
      this._styleCopy = { source: style, copy: SyntaxStyle.fromStyles(style.getAllStyles(), scene) }
    }
    return this._styleCopy.copy._getSceneHandle(scene)
  }

  /** Sends changed engine flags; `force` sends the hook filter too. */
  private changeOptions(force = false): void {
    if (this.isDestroyed) return
    const flags = this.engineFlags()
    if (!force && flags === this._flags) return
    this._flags = flags
    this.change(() => this._doc.setOptions(this.engineOptions()))
    this.syncLeaves()
  }

  private change(run: () => MarkdownChanges): void {
    if (this.isDestroyed) return
    const before = this._doc.content
    const changes = run()
    this._before = before === this._doc.content ? undefined : before
    try {
      this.apply(changes)
    } finally {
      this._before = this._beforeBytes = undefined
    }
    this.requestRender()
  }

  /** Whether a removed block's source (before this call) equals a new block's: the same bytes at its range. */
  private sameSource(old: NativeMarkdownBlock, block: NativeMarkdownBlock): boolean {
    if (this._before === undefined) return true
    const before = (this._beforeBytes ??= textEncoder.encode(this._before))
    const source = before.subarray(old.sourceStart, old.sourceEnd)
    return (
      source.length === block.sourceEnd - block.sourceStart &&
      textDecoder.decode(source) === this.sourceText(block.sourceStart, block.sourceEnd)
    )
  }

  /** Binds a paragraph's or heading's node, which hands it to the doc. */
  private bind(index: number, text: TextRenderable): void {
    this._doc.bind(index, this.ctx.nativeScene.textNode(text))
    const shown = this._shown[index]
    if (shown) {
      shown.bound = true
      shown.written = shown.targets = undefined
    }
  }

  /**
   * After an option change, each paragraph and heading goes to the writer the options now give it: the doc does not
   * list a leaf whose output did not change, so the host hands it over or takes it back here.
   */
  private syncLeaves(): void {
    this._shown.forEach((shown, index) => {
      const block = this._doc.blocks[index]!
      if (!isProse(block.kind) || this.isHidden(index) || !(shown.default instanceof TextRenderable)) return
      if (this.hostWrites(block)) this.writeProse(index, false)
      else if (!shown.bound || shown.written !== undefined) this.bind(index, shown.default)
    })
  }

  /** Whether the host writes a paragraph or heading: the doc writes only concealed, linked, unhooked text. */
  private hostWrites(block: NativeMarkdownBlock): boolean {
    const live = md.OT_MD_CONCEAL | md.OT_MD_HYPERLINKS
    return (this._flags & live) !== live || (block.flags & md.OT_MD_BLOCK_HOOKED) !== 0
  }

  /**
   * Shows a call's changes: builds or updates each listed block, then drops the renderables of removed blocks. A code
   * block or text that takes a removed one's place, index and kind, keeps its renderable and highlight.
   */
  private apply(changes: MarkdownChanges): void {
    const from = changes.removedFrom ?? this._shown.length
    const removed = new Map(this._shown.splice(from).map((shown, at) => [from + at, shown]))
    // Lists count their items again after a removal.
    if (removed.size > 0) for (const shown of this._shown) shown.count = undefined
    const refresh: Refresh = { tables: new Set(), lists: new Set(), items: new Set() }
    for (const block of changes.changed) this.update(block, refresh, removed)
    for (const shown of [...removed.values()].reverse()) {
      if (shown.renderable && !shown.renderable.isDestroyed) shown.renderable.destroyRecursively()
    }
    this.refresh(refresh)
  }

  private refresh(refresh: Refresh): void {
    for (const table of refresh.tables) this.fillTable(table)
    for (const list of refresh.lists) this.updateList(list)
    // Items of lists not laid out again: only their markers and gaps.
    const items = new Map<number, number[]>()
    for (const item of refresh.items) {
      const list = this._doc.blocks[item]!.parent!
      if (!refresh.lists.has(list)) items.set(list, [...(items.get(list) ?? []), item])
    }
    for (const [list, listed] of items) this.updateList(list, listed)
  }

  private update(block: NativeMarkdownBlock, refresh: Refresh, removed = new Map<number, Shown>()): void {
    const index = block.index
    const shown = this._shown[index]
    let layout = true
    if (!shown) {
      // Blocks without children of their own: what shows them holds no other block's renderable.
      const old = removed.get(index)
      const leaf = block.kind !== md.OT_MD_QUOTE && block.kind !== md.OT_MD_LIST && block.kind !== md.OT_MD_ITEM
      const equal = old && sameRecord(old.record, block) && this.sameSource(old.record, block)
      if (leaf && old?.renderable && equal && !this.isHidden(index)) {
        // An equal block (an option change parsed again): what showed it, a renderer's result too, shows it again.
        this._shown.push({ ...old, record: block, written: undefined, targets: undefined })
        this.parentOf(index).add(old.renderable)
        old.renderable = undefined
        this._shown[index]!.bound = false
        if (old.default instanceof TextRenderable && isProse(block.kind) && !this.hostWrites(block)) {
          this.bind(index, old.default)
        }
        this.afterChange(index, refresh, true)
        return
      }
      const same = old?.record.kind === block.kind || (isProse(block.kind) && isProse(old?.record.kind ?? -1))
      const reuse = leaf && same && old!.default === old!.renderable ? old!.default : undefined
      this._shown.push({ record: block, default: reuse })
      if (reuse) old!.renderable = undefined
      if (!this.isHidden(index)) this.show(index, undefined)
      // The doc unbound the removed block's node.
      if (reuse instanceof TextRenderable && isProse(block.kind) && !this.hostWrites(block)) this.bind(index, reuse)
    } else {
      // A list or item grows with each delta inside it; it is laid out again only when its flags or number change.
      layout = shown.record.flags !== block.flags || shown.record.number !== block.number
      // A kind change at the same index rebuilds, except that a paragraph that becomes a setext heading keeps its text.
      const rebuild = shown.record.kind !== block.kind && !(isProse(shown.record.kind) && isProse(block.kind))
      // A block listed for its output alone (a style or capability change) does not ask its renderer again.
      const changed = rebuild || !sameRecord(shown.record, block)
      shown.record = block
      if (this.isHidden(index)) {
        // Shown with its parent.
      } else if (rebuild || (changed && this.rendersCustom(block))) this.show(index, shown.renderable)
      else if (shown.default instanceof CodeRenderable) this.setCode(index, shown.default)
    }
    this.afterChange(index, refresh, layout)
  }

  /** Builds the renderable of block `index` and puts it where `old` was, or last in its parent. */
  private show(index: number, old: Renderable | undefined): void {
    this._shownInCall?.add(index)
    const shown = this._shown[index]!
    const before = shown.default
    const { renderable, fallback } = this.resolve(index)
    shown.default = fallback
    if (renderable !== old) {
      const parent = this.parentOf(index)
      const position = old ? parent.getChildren().indexOf(old) : -1
      // The default the new result shows leaves the old result before it goes.
      if (fallback && old && old !== fallback && holds(old, fallback)) fallback.parent?.remove(fallback)
      if (old !== fallback) old?.destroyRecursively()
      shown.renderable = renderable
      if (renderable) parent.add(renderable, position === -1 ? undefined : position)
    }
    if (before === fallback) return
    if (before && !before.isDestroyed) before.destroyRecursively()
    shown.written = shown.targets = shown.gap = shown.width = shown.count = undefined
    if (!fallback) shown.container = shown.marker = undefined
    // Descendants lose what showed them with the old default, and show again in the new one; shown children of a block
    // its renderer showed alone show in a default that appears.
    if (before || (fallback && this._shown[index + 1]?.record.parent === index)) this.showDescendants(index)
  }

  private showDescendants(index: number): void {
    // Descendants listed later in the same call are not shown yet; they show when they come.
    const end = Math.min(this.subtreeEnd(index), this._shown.length)
    for (let at = index + 1; at < end; at++) {
      const shown = this._shown[at]!
      shown.renderable = shown.default = shown.container = shown.marker = shown.written = shown.targets = undefined
      shown.gap = shown.width = shown.count = shown.ordinal = undefined
    }
    const refresh: Refresh = { tables: new Set(), lists: new Set(), items: new Set() }
    for (let at = index + 1; at < end; at++) {
      if (!this.isHidden(at)) this.show(at, undefined)
      this.afterChange(at, refresh, true)
    }
    this.afterChange(index, refresh, true)
    this.refresh(refresh)
  }

  private subtreeEnd(index: number): number {
    const blocks = this._doc.blocks
    let at = index + 1
    while (at < blocks.length && blocks[at]!.parent !== undefined && blocks[at]!.parent! >= index) at++
    return at
  }

  private parentOf(index: number): Renderable {
    const parent = this._doc.blocks[index]!.parent
    return parent === undefined ? this : this._shown[parent]!.container!
  }

  /** Whether block `index` lies in a table or a renderer's result without a default, so nothing shows it on its own. */
  private isHidden(index: number): boolean {
    for (
      let parent = this._doc.blocks[index]!.parent;
      parent !== undefined;
      parent = this._doc.blocks[parent]!.parent
    ) {
      const shown = this._shown[parent]!
      if (shown.record.kind === md.OT_MD_TABLE || !shown.default) return true
    }
    return false
  }

  private rendersCustom(block: NativeMarkdownBlock): boolean {
    const renderBlock = this._renderBlock as MarkdownRenderBlock | undefined
    if (!renderBlock) return false
    if (block.kind === md.OT_MD_CODE) return true
    return !renderBlock.codeBlockOnly && block.parent === undefined
  }

  /**
   * The renderable of block `index`, a renderer's or the default one, and the default one if it shows (the one shown
   * already, when it is still right).
   */
  private resolve(index: number): { renderable: Renderable | undefined; fallback: Renderable | undefined } {
    const block = this._doc.blocks[index]!
    const shown = this._shown[index]!
    let fallback: Renderable | undefined
    const defaultRender = () => (fallback ??= this.buildDefault(index, shown.default))
    if (!this.rendersCustom(block)) return { renderable: defaultRender(), fallback }
    // A default the renderer built but did not show goes; the shown one stays until the result replaces it.
    const unused = () => fallback && fallback !== shown.default && !fallback.parent && fallback.destroyRecursively()
    let custom: Renderable | null | undefined
    try {
      custom = this._renderBlock!(this.view(index), {
        syntaxStyle: this._syntaxStyle,
        conceal: this._conceal,
        concealCode: this._concealCode,
        treeSitterClient: this._treeSitterClient,
        defaultRender: () => defaultRender() ?? null,
      })
    } catch (error) {
      unused()
      throw error
    }
    if (!custom) return { renderable: defaultRender(), fallback }
    // A result that is or holds the default (a wrapper) keeps it shown.
    if (fallback && holds(custom, fallback)) return { renderable: custom, fallback }
    unused()
    return { renderable: custom, fallback: undefined }
  }

  /** The default renderable of block `index`; `current` is kept when it already shows a block of that kind. */
  private buildDefault(index: number, current: Renderable | undefined): Renderable | undefined {
    const block = this._doc.blocks[index]!
    const shown = this._shown[index]!
    const id = `${this.id}-block-${index}`
    switch (block.kind) {
      case md.OT_MD_PARAGRAPH:
      case md.OT_MD_HEADING:
      case md.OT_MD_HTML: {
        // A text taken back from a removed block may show a block in another place, such as out of a quote.
        const text =
          current instanceof TextRenderable
            ? current
            : new TextRenderable(this.ctx, { id, flexShrink: 0, wrapMode: "word" })
        this.styleText(index, text)
        if (text === current) return text
        if (isProse(block.kind) && !this.hostWrites(block)) {
          this._doc.bind(index, this.ctx.nativeScene.textNode(text))
          shown.bound = true
        }
        return text
      }
      case md.OT_MD_CODE: {
        if (current instanceof CodeRenderable) {
          this.setCode(index, current)
          return current
        }
        const code = new CodeRenderable(this.ctx, {
          id,
          syntaxStyle: this._syntaxStyle,
          treeSitterClient: this._treeSitterClient,
          width: "100%",
          flexShrink: 0,
        })
        this.setCode(index, code)
        return code
      }
      case md.OT_MD_RULE:
        if (current instanceof BoxRenderable) return current
        return new BoxRenderable(this.ctx, {
          id,
          width: "100%",
          height: 1,
          border: ["top"],
          borderColor: this.getStyle("conceal")?.fg ?? this._fg ?? "#888888",
          flexShrink: 0,
        })
      case md.OT_MD_TABLE: {
        if (current instanceof TextTableRenderable) return current
        const table = new TextTableRenderable(this.ctx, { id, width: "100%", flexShrink: 0, content: [] })
        this.applyTableRenderableOptions(table, this.resolveTableRenderableOptions())
        shown.container = undefined
        return table
      }
      case md.OT_MD_QUOTE: {
        const quote = new BoxRenderable(this.ctx, {
          id,
          width: "100%",
          // An empty quote still shows its bar.
          minHeight: 1,
          border: ["left"],
          borderColor: this.getStyle("conceal")?.fg ?? this.getStyle("default")?.fg ?? this._fg ?? "#FFFFFF",
          paddingLeft: 1,
          flexDirection: "column",
          rowGap: 1,
          flexShrink: 0,
        })
        shown.container = quote
        return quote
      }
      case md.OT_MD_LIST: {
        const list = new BoxRenderable(this.ctx, { id, width: "100%", flexDirection: "column", flexShrink: 0 })
        shown.container = list
        return list
      }
      case md.OT_MD_ITEM: {
        const row = new BoxRenderable(this.ctx, { id, width: "100%", flexDirection: "row", flexShrink: 0 })
        shown.marker = new TextRenderable(this.ctx, { id: `${id}-marker`, flexShrink: 0 })
        shown.container = new BoxRenderable(this.ctx, {
          id: `${id}-content`,
          flexDirection: "column",
          flexGrow: 1,
          flexShrink: 1,
        })
        row.add(shown.marker)
        row.add(shown.container)
        return row
      }
      default:
        return undefined
    }
  }

  private setCode(index: number, code: CodeRenderable): void {
    const block = this._doc.blocks[index]!
    // Display math without a renderer shows its TeX as plain code text.
    code.filetype =
      (block.flags & md.OT_MD_BLOCK_MATH) !== 0 ? undefined : infoStringToFiletype(this.view(index).lang ?? "")
    code.syntaxStyle = this._syntaxStyle
    code.fg = this._fg
    code.bg = this._bg
    code.conceal = this._concealCode
    // While streaming, code waits for its highlight, so it never draws unconcealed or plain first.
    code.drawUnstyledText = (block.flags & md.OT_MD_BLOCK_MATH) !== 0 || !this._streaming
    code.streaming = this._streaming
    code.content = this.leafText(index)
  }

  /** What a changed block changes besides its own renderable: text the host writes, the table or list around it. */
  private afterChange(index: number, refresh: Refresh, layout: boolean): void {
    const block = this._doc.blocks[index]!
    const shown = this._shown[index]!
    if (block.kind === md.OT_MD_TABLE) refresh.tables.add(index)
    if (block.kind === md.OT_MD_TABLE_ROW || block.kind === md.OT_MD_TABLE_CELL) refresh.tables.add(this.tableOf(index))
    if (block.kind === md.OT_MD_TABLE_CELL) shown.cell = undefined
    if (layout && block.kind === md.OT_MD_LIST) refresh.lists.add(index)
    if (layout && block.kind === md.OT_MD_ITEM) refresh.items.add(index)
    // A new block in an item can make its list loose.
    const parent = block.parent === undefined ? undefined : this._doc.blocks[block.parent]!
    if (layout && parent?.kind === md.OT_MD_ITEM) refresh.items.add(block.parent!)
    const text = isProse(block.kind) || block.kind === md.OT_MD_HTML
    if (!text || this.isHidden(index) || !(shown.default instanceof TextRenderable)) return
    if (block.kind === md.OT_MD_HTML || this.hostWrites(block)) {
      this.writeProse(index, false)
    } else if (shown.written !== undefined) {
      // The doc writes the text again: hand the node back, so it never writes over the host's text.
      this.bind(index, shown.default)
    }
  }

  /**
   * Writes a paragraph, heading or HTML block the host writes: the parser's output, through the inline hook when
   * the doc marked it, with its click targets. An unchanged output is not written again unless `force`.
   */
  private writeProse(index: number, force: boolean): void {
    const shown = this._shown[index]!
    const text = shown.default
    // Solid can set the content before the style; the style's arrival lists these leaves again.
    if (!(text instanceof TextRenderable) || !this._syntaxStyle) return
    const leaf = this._doc.readLeaf(index)
    const hooked = this._inlineHook && (this._doc.blocks[index]!.flags & md.OT_MD_BLOCK_HOOKED) !== 0
    const source = hooked ? this._doc.readSource(index) : undefined
    // The span flags too: a code span decided at the end of a line changes only its flag.
    const written = JSON.stringify([leaf.chunks, [...leaf.spans], source])
    if (!force && shown.written === written) return
    shown.written = written
    const spans = this.spans(leaf.chunks, leaf.spans)
    const output = hooked ? this.hook(spans, source!, false) : spans
    const ranges: Targets = []
    let end = 0
    const chunks = output.map(({ text, fg, bg, attributes, link, target }) => {
      const start = end
      end += textEncoder.encode(text).length
      if (target !== undefined) ranges.push([start, end, target])
      return { __isChunk: true as const, text, fg, bg, attributes, link }
    })
    text.content = new StyledText(chunks)
    shown.targets = ranges.length > 0 ? ranges : undefined
  }

  private spans(chunks: TextChunk[], flags: Uint32Array): MarkdownInlineSpan[] {
    return chunks.map(({ text, fg, bg, attributes, link }, index) => {
      const span: MarkdownInlineSpan = {
        text,
        fg,
        bg,
        attributes,
        link,
        code: (flags[index]! & md.OT_MD_SPAN_CODE) !== 0,
      }
      if (flags[index]! & md.OT_MD_SPAN_MATH) span.math = text
      return span
    })
  }

  private hook(spans: MarkdownInlineSpan[], source: string, tableCell: boolean): MarkdownInlineSpan[] {
    const context = { source, conceal: this._conceal, syntaxStyle: this._syntaxStyle, tableCell }
    return this._inlineHook!(spans, context)
  }

  private tableOf(index: number): number {
    let at = index
    while (this._doc.blocks[at]!.kind !== md.OT_MD_TABLE) at = this._doc.blocks[at]!.parent!
    return at
  }

  /** The blocks that are children of block `index`, in order. */
  private childrenOf(index: number): number[] {
    const children: number[] = []
    const blocks = this._doc.blocks
    for (let at = index + 1; at < blocks.length; at++) {
      const parent = blocks[at]!.parent
      if (parent === undefined || parent < index) break
      if (parent === index) children.push(at)
    }
    return children
  }

  /** Fills a table from its rows and cells: a header row in the heading style, then the body, as wide as the header. */
  private fillTable(index: number): void {
    const table = this._shown[index]?.default
    if (!(table instanceof TextTableRenderable) || !this._syntaxStyle) return
    const columns = this._doc.blocks[index]!.number
    const previous = table.content
    const content: TextTableContent = this.childrenOf(index).map((row, r) => {
      const header = (this._doc.blocks[row]!.flags & md.OT_MD_BLOCK_HEADER) !== 0
      const cells = this.childrenOf(row).map((cell, c) => {
        const shown = this._shown[cell]
        if (shown?.cell) return shown.cell
        // A cell read again with what it showed keeps that content, so the table sees it unchanged.
        const read = this.readCell(cell, header)
        const before = previous[r]?.[c]
        const chunks = before && sameChunks(before, read) ? before : read
        // A cell this call has not shown yet is kept when it is.
        if (shown) shown.cell = chunks
        return chunks
      })
      while (cells.length < columns) cells.push([{ __isChunk: true, text: " " }])
      return cells
    })
    table.content = content
  }

  /** A cell's content: the parser's output, in the heading style in a header row, through the hook. */
  private readCell(cell: number, header: boolean): TextChunk[] {
    const heading = header ? (this.getStyle("markup.heading") ?? this.getStyle("default")) : undefined
    const headingAttributes = heading ? createTextAttributes(heading) : 0
    const leaf = this._doc.readLeaf(cell)
    let spans = this.spans(leaf.chunks, leaf.spans).map((span) => {
      if (!heading) return span
      // An inline ~~strike~~ stays in a header unless the heading style sets strikethrough itself.
      const strike = heading.strikethrough === undefined ? (span.attributes ?? 0) & TextAttributes.STRIKETHROUGH : 0
      return { ...span, fg: heading.fg ?? span.fg, bg: heading.bg ?? span.bg, attributes: headingAttributes | strike }
    })
    // The hook sees a header cell's content in the header style, as Rust's does.
    if (this._inlineHook && (this._doc.blocks[cell]!.flags & md.OT_MD_BLOCK_HOOKED) !== 0) {
      spans = this.hook(spans, this._doc.readSource(cell), true)
    }
    const chunks: TextChunk[] = spans.map(({ text, fg, bg, attributes, link }) => ({
      __isChunk: true,
      text,
      fg,
      bg,
      attributes,
      link,
    }))
    return chunks.length > 0 ? chunks : [{ __isChunk: true as const, text: " " }]
  }

  /**
   * A list's gaps and its items' markers: numbers align on their right, and the list is loose when items are. With
   * `listed`, only those items changed: they are counted and marked, and the rest is written only when the gap or the
   * marker width changes.
   */
  private updateList(index: number, listed?: number[]): void {
    const list = this._shown[index]
    if (!list || !(list.default instanceof BoxRenderable) || this.isHidden(index)) return
    const block = this._doc.blocks[index]!
    const recount = listed === undefined || list.count === undefined
    let items = recount ? this.childrenOf(index) : listed
    let count = recount ? 0 : list.count!
    if (recount) list.loose = false
    for (const item of items) {
      const shown = this._shown[item]!
      if (recount || shown.ordinal === undefined) shown.ordinal = count++
      list.loose ||= this.isLoose(item)
    }
    list.count = count
    // The engine decides tightness when the list closes; until then a blank line in or after an item makes it loose.
    const tight = (block.flags & md.OT_MD_BLOCK_OPEN) !== 0 ? !list.loose : (block.flags & md.OT_MD_BLOCK_TIGHT) !== 0
    const gap = tight ? 0 : 1
    const ordered = (block.flags & md.OT_MD_BLOCK_ORDERED) !== 0
    const width = ordered ? `${block.number + Math.max(0, count - 1)}`.length + 1 : 1
    if (gap !== list.gap || width !== list.width) {
      list.gap = gap
      list.width = width
      list.default.rowGap = gap
      if (listed) items = this.childrenOf(index)
    }
    const base = this.baseStyle(index)
    const style = this.getStyle("markup.list")
    for (const item of items) {
      const shown = this._shown[item]!
      if (!shown.marker || !(shown.container instanceof BoxRenderable)) continue
      const flags = this._doc.blocks[item]!.flags
      const checked = (flags & md.OT_MD_BLOCK_CHECKED) !== 0
      const task =
        (flags & md.OT_MD_BLOCK_TASK) === 0 ? "" : this._conceal ? (checked ? " ☑" : " ☐") : checked ? " [x]" : " [ ]"
      const label = (ordered ? `${block.number + shown.ordinal!}.`.padStart(width) : "-") + task + " "
      const chunk = {
        __isChunk: true as const,
        text: label,
        fg: style?.fg ?? base.fg,
        bg: style?.bg ?? base.bg,
        attributes: style ? createTextAttributes(style) : base.attributes,
      }
      // A marker whose text and style are unchanged is not written again.
      const [shownChunk, ...rest] = shown.marker.chunks
      const same =
        rest.length === 0 &&
        shownChunk?.text === chunk.text &&
        colorsEqual(shownChunk.fg, chunk.fg) &&
        colorsEqual(shownChunk.bg, chunk.bg) &&
        shownChunk.attributes === chunk.attributes
      if (!same) shown.marker.content = new StyledText([chunk])
      if (shown.gap !== gap) shown.container.rowGap = shown.gap = gap
    }
  }

  /** Whether an item has a blank line after it or between two of its blocks. */
  private isLoose(item: number): boolean {
    if ((this._doc.blocks[item]!.flags & md.OT_MD_BLOCK_BLANK_AFTER) !== 0) return true
    const children = this.childrenOf(item)
    return children.slice(1).some((child, n) => {
      const gap = this.sourceText(this._doc.blocks[children[n]!]!.sourceEnd, this._doc.blocks[child]!.sourceStart)
      return (gap.match(/\r\n|\r|\n/g)?.length ?? 0) > 1
    })
  }

  /** The style of text in block `index` that no part of it styles: the text style, under each quote around it. */
  private baseStyle(index: number | undefined): { fg?: RGBA; bg?: RGBA; attributes: number } {
    const style = this.getStyle("default")
    const base = {
      fg: this._fg ?? style?.fg,
      bg: this._bg ?? style?.bg,
      attributes: style ? createTextAttributes(style) : 0,
    }
    const quote = this.getStyle("markup.quote")
    for (let at = index; at !== undefined; at = this._doc.blocks[at]!.parent) {
      if (this._doc.blocks[at]!.kind !== md.OT_MD_QUOTE || !quote) continue
      base.fg = quote.fg ?? base.fg
      base.bg = quote.bg ?? base.bg
      base.attributes |= createTextAttributes(quote)
    }
    return base
  }

  private styleText(index: number, text: TextRenderable): void {
    const base = this.baseStyle(this._doc.blocks[index]!.parent)
    text.fg = base.fg
    text.bg = base.bg
    text.attributes = base.attributes
  }

  private getStyle(group: string) {
    // Solid can apply props before syntaxStyle.
    return this._syntaxStyle?.getStyle(group)
  }

  /**
   * Styles every renderable again for new colors, a new theme or new table options, and asks the renderers again,
   * since they read the style; nothing is parsed again.
   */
  private restyle(skip: ReadonlySet<number> = new Set()): void {
    const tables: number[] = []
    const lists: number[] = []
    this._shown.forEach((shown, index) => {
      const block = this._doc.blocks[index]!
      if (this.isHidden(index)) return
      if (this.rendersCustom(block) && !skip.has(index)) this.show(index, shown.renderable)
      const renderable = shown.default
      if (!renderable) return
      if (renderable instanceof TextRenderable) this.styleText(index, renderable)
      else if (renderable instanceof CodeRenderable) this.setCode(index, renderable)
      else if (renderable instanceof TextTableRenderable) {
        this.applyTableRenderableOptions(renderable, this.resolveTableRenderableOptions())
        for (let at = index + 1, end = this.subtreeEnd(index); at < end; at++) this._shown[at]!.cell = undefined
        tables.push(index)
      } else if (block.kind === md.OT_MD_LIST) lists.push(index)
      else if (block.kind === md.OT_MD_RULE && renderable instanceof BoxRenderable) {
        renderable.borderColor = this.getStyle("conceal")?.fg ?? this._fg ?? "#888888"
      } else if (block.kind === md.OT_MD_QUOTE && renderable instanceof BoxRenderable) {
        renderable.borderColor = this.getStyle("conceal")?.fg ?? this.getStyle("default")?.fg ?? this._fg ?? "#FFFFFF"
      }
    })
    for (const table of tables) this.fillTable(table)
    for (const list of lists) this.updateList(list)
  }

  /** Builds every block's renderable again (a new renderer), keeping the doc. */
  private rebuild(): void {
    for (const shown of this._shown) {
      for (const renderable of [shown.renderable, shown.default]) {
        if (renderable && !renderable.isDestroyed) renderable.destroyRecursively()
      }
    }
    const blocks = this._doc.blocks
    this._shown = []
    this.apply({ removedFrom: undefined, changed: blocks.slice() })
    this.requestRender()
  }

  /** A read-only view of block `index` for renderers. */
  private view(index: number): MarkdownBlock {
    const block = this._doc.blocks[index]!
    const kind = kindNames[block.kind]!
    const self = this
    const view: Record<string, unknown> = {
      index,
      kind,
      get raw() {
        return self.sourceText(block.sourceStart, block.sourceEnd)
      },
      get text() {
        return block.kind === md.OT_MD_PARAGRAPH ||
          block.kind === md.OT_MD_HEADING ||
          block.kind === md.OT_MD_CODE ||
          block.kind === md.OT_MD_TABLE_CELL
          ? self.leafText(index)
          : ""
      },
      get children() {
        return self.childrenOf(index).map((child) => self.view(child))
      },
    }
    if (block.kind === md.OT_MD_HEADING) view.level = block.number
    if (block.kind === md.OT_MD_LIST) {
      view.ordered = (block.flags & md.OT_MD_BLOCK_ORDERED) !== 0
      view.start = block.number
    }
    if (block.kind === md.OT_MD_ITEM && (block.flags & md.OT_MD_BLOCK_TASK) !== 0) {
      view.checked = (block.flags & md.OT_MD_BLOCK_CHECKED) !== 0
    }
    if (block.kind === md.OT_MD_CODE) {
      const info = this.sourceText(block.infoStart, block.infoEnd)
      view.type = "code"
      view.info = info
      view.lang = (block.flags & md.OT_MD_BLOCK_MATH) !== 0 ? "math" : (info.split(/\s/)[0] ?? "")
      view.closed = (block.flags & md.OT_MD_BLOCK_CLOSED) !== 0
    }
    return view as unknown as MarkdownBlock
  }

  private leafText(index: number): string {
    return this._doc
      .readLeaf(index)
      .chunks.map((chunk) => chunk.text)
      .join("")
  }

  private sourceText(start: number, end: number): string {
    return this._doc.source(start, end)
  }

  private resolveTableStyle(): MarkdownTableStyle {
    return this._tableOptions?.style ?? "grid"
  }

  private resolveTableRenderableOptions(): ResolvedTableRenderableOptions {
    const style = this.resolveTableStyle()
    const borders = this._tableOptions?.borders ?? style === "grid"

    return {
      columnWidthMode: this._tableOptions?.widthMode ?? (style === "columns" ? "content" : "full"),
      columnFitter: this._tableOptions?.columnFitter ?? "proportional",
      wrapMode: this._tableOptions?.wrapMode ?? "word",
      cellPadding: this._tableOptions?.cellPadding ?? 0,
      cellPaddingX: this._tableOptions?.cellPaddingX ?? this._tableOptions?.cellPadding ?? 0,
      cellPaddingY: this._tableOptions?.cellPaddingY ?? this._tableOptions?.cellPadding ?? 0,
      columnGap: style === "columns" && !borders ? 2 : 0,
      border: borders,
      outerBorder: this._tableOptions?.outerBorder ?? borders,
      showBorders: borders,
      borderStyle: this._tableOptions?.borderStyle ?? "single",
      borderColor: this._tableOptions?.borderColor ?? this.getStyle("conceal")?.fg ?? "#888888",
      fg: this._fg,
      selectable: this._tableOptions?.selectable ?? true,
    }
  }

  private applyTableRenderableOptions(
    tableRenderable: TextTableRenderable,
    options: ResolvedTableRenderableOptions,
  ): void {
    tableRenderable.columnWidthMode = options.columnWidthMode
    tableRenderable.columnFitter = options.columnFitter
    tableRenderable.wrapMode = options.wrapMode
    tableRenderable.cellPaddingX = options.cellPaddingX
    tableRenderable.cellPaddingY = options.cellPaddingY
    tableRenderable.columnGap = options.columnGap
    tableRenderable.border = options.border
    tableRenderable.outerBorder = options.outerBorder
    tableRenderable.showBorders = options.showBorders
    tableRenderable.borderStyle = options.borderStyle
    tableRenderable.borderColor = options.borderColor
    tableRenderable.fg = options.fg
    tableRenderable.selectable = options.selectable
  }

  // Style changes restyle before layout, so the new style paints in the same frame.
  private markStyleDirty(): void {
    this._styleDirty = true
    this._ctx.nativeScene.lifecyclePasses.refresh(this)
  }

  private rerenderDirtyStyles(): void {
    if (!this._styleDirty) return
    this._styleDirty = false
    this._ctx.nativeScene.lifecyclePasses.refresh(this)
    this.restyle()
  }

  override _needsLifecyclePass(): boolean {
    if (this.onLifecyclePass !== this.applyStyleChanges) return super._needsLifecyclePass()
    return this._styleDirty
  }

  protected destroySelf(): void {
    const subscription = MarkdownRenderable._capabilitySubscriptions.get(this.ctx)
    if (subscription) {
      subscription.renderables.delete(this)
      if (subscription.renderables.size === 0) {
        this.ctx.off("capabilities", subscription.listener)
        MarkdownRenderable._capabilitySubscriptions.delete(this.ctx)
      }
    }
    // Bound text keeps what the doc wrote last.
    this._doc?.destroy()
    this._styleCopy?.copy.destroy()
    super.destroySelf()
  }
}
