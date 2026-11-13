import type {
  ContextMarkdownHandle,
  NativeContextHandle,
  NativeMarkdownBlock,
  NativeMarkdownLeaf,
  NativeMarkdownOptions,
  NativeMarkdownResult,
  RenderLib,
  SceneNodeHandle,
} from "../zig.js"

/** What a call changed: blocks at `removedFrom` and after are gone, then `changed` blocks were added or updated. */
export interface MarkdownChanges {
  removedFrom: number | undefined
  changed: NativeMarkdownBlock[]
}

const unchanged: MarkdownChanges = { removedFrom: undefined, changed: [] }

/**
 * A native Markdown document and what the host knows of it. The engine owns the source and the blocks; `content` is
 * the source as of the last accepted call (kept for the `startsWith` test before an append), and `blocks` is filled
 * only from the engine's change reports, so after every call both equal the engine's.
 */
export class MarkdownDocument {
  readonly blocks: NativeMarkdownBlock[] = []
  private readonly encoder = new TextEncoder()
  private readonly doc: ContextMarkdownHandle
  private _content = ""
  private _committed = 0
  private _finished = false

  constructor(
    private readonly lib: RenderLib,
    private readonly context: NativeContextHandle,
    options: NativeMarkdownOptions,
  ) {
    this.doc = lib.markdownCreate(context, options)
  }

  get content(): string {
    return this._content
  }

  /** Top-level blocks that are final, a prefix; it never decreases while content only grows. */
  get committed(): number {
    return this._committed
  }

  get finished(): boolean {
    return this._finished
  }

  /** Shows `content`: an append when it extends the open document, else a fresh parse; finished unless `streaming`. */
  write(content: string, streaming: boolean): MarkdownChanges {
    let result: NativeMarkdownResult | undefined
    if (content !== this._content || this._finished === streaming) {
      // A high surrogate at the end may pair with the appended text: UTF-8 cannot hold half a pair, so parse it whole.
      const extends_ = !this._finished && content.startsWith(this._content) && !/[\uD800-\uDBFF]$/.test(this._content)
      const bytes = this.encoder.encode(extends_ ? content.slice(this._content.length) : content)
      if (!extends_ || bytes.length > 0) {
        result = this.lib.markdownWrite(this.context, this.doc, bytes, !extends_)
        this._content = content
        this._finished = false
        this._committed = result.committed
      }
    }
    if (!streaming && !this._finished) result = this.finish()
    return result ? this.apply(result) : unchanged
  }

  setOptions(options: NativeMarkdownOptions): MarkdownChanges {
    return this.apply(this.lib.markdownSetOptions(this.context, this.doc, options))
  }

  readLeaf(index: number): NativeMarkdownLeaf {
    return this.lib.markdownReadLeaf(this.context, this.doc, index)
  }

  readSource(index: number): string {
    return this.lib.markdownReadSource(this.context, this.doc, index)
  }

  /** The engine's own copy of the source, or its bytes `start` to `end`. */
  source(start?: number, end?: number): string {
    return this.lib.markdownGetSource(this.context, this.doc, start, end)
  }

  bind(index: number, node: SceneNodeHandle): void {
    this.lib.markdownBind(this.context, this.doc, index, node)
  }

  destroy(): void {
    this.lib.markdownDestroy(this.context, this.doc)
  }

  private finish(): NativeMarkdownResult {
    const result = this.lib.markdownFinish(this.context, this.doc)
    this._finished = true
    this._committed = result.committed
    return result
  }

  private apply(result: NativeMarkdownResult): MarkdownChanges {
    this._committed = result.committed
    if (result.removedFrom !== undefined) this.blocks.length = Math.min(this.blocks.length, result.removedFrom)
    if (result.changed === 0) return { removedFrom: result.removedFrom, changed: [] }
    const changed = this.lib.markdownReadChanges(this.context, this.doc, result.changed)
    for (const block of changed) this.blocks[block.index] = block
    return { removedFrom: result.removedFrom, changed }
  }
}
