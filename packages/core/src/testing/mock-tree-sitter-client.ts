import { TreeSitterClient } from "../lib/tree-sitter/index.js"
import { SystemClock, type Clock, type TimerHandle } from "../lib/clock.js"
import type { SimpleHighlight } from "../lib/tree-sitter/types.js"

export class MockTreeSitterClient extends TreeSitterClient {
  private _highlightPromises: Array<{
    promise: Promise<{ highlights?: SimpleHighlight[]; warning?: string; error?: string }>
    resolve: (result: { highlights?: SimpleHighlight[]; warning?: string; error?: string }) => void
    timeout?: TimerHandle
  }> = []
  private _mockResult: { highlights?: SimpleHighlight[]; warning?: string; error?: string } = { highlights: [] }
  private _autoResolveTimeout?: number
  private readonly _clock: Clock

  constructor(options?: { autoResolveTimeout?: number; clock?: Clock }) {
    super({ dataPath: "/tmp/mock" }, { autoStartWorker: false })
    this._autoResolveTimeout = options?.autoResolveTimeout
    this._clock = options?.clock ?? new SystemClock()
  }

  override async destroy(): Promise<void> {
    this.resolveAllHighlightOnce()
    await super.destroy()
  }

  async highlightOnce(
    content: string,
    filetype: string,
  ): Promise<{ highlights?: SimpleHighlight[]; warning?: string; error?: string }> {
    const { promise, resolve } = Promise.withResolvers<{
      highlights?: SimpleHighlight[]
      warning?: string
      error?: string
    }>()

    let timeout: TimerHandle | undefined

    if (this._autoResolveTimeout !== undefined) {
      timeout = this._clock.setTimeout(() => {
        const index = this._highlightPromises.findIndex((p) => p.promise === promise)
        if (index !== -1) {
          resolve(this._mockResult)
          this._highlightPromises.splice(index, 1)
        }
      }, this._autoResolveTimeout)
    }

    this._highlightPromises.push({ promise, resolve, timeout })

    return promise
  }

  setMockResult(result: { highlights?: SimpleHighlight[]; warning?: string; error?: string }) {
    this._mockResult = result
  }

  resolveHighlightOnce(index: number = 0) {
    if (index >= 0 && index < this._highlightPromises.length) {
      const item = this._highlightPromises[index]
      if (item.timeout) {
        this._clock.clearTimeout(item.timeout)
      }
      item.resolve(this._mockResult)
      this._highlightPromises.splice(index, 1)
    }
  }

  resolveAllHighlightOnce() {
    for (const { resolve, timeout } of this._highlightPromises) {
      if (timeout) {
        this._clock.clearTimeout(timeout)
      }
      resolve(this._mockResult)
    }
    this._highlightPromises = []
  }

  isHighlighting(): boolean {
    return this._highlightPromises.length > 0
  }
}
