export type PriorityRegistration<TListener, TOptions extends { priority: number }> = Readonly<
  TOptions & {
    listener: TListener
    order: number
  }
>

abstract class CopyOnWriteRegistry<TValue> {
  #items: readonly TValue[] = []

  protected getItems(): readonly TValue[] {
    return this.#items
  }

  protected setItems(items: readonly TValue[]): void {
    this.#items = items
  }

  protected removeItem(value: TValue): boolean {
    const current = this.#items
    if (current.length === 0) {
      return false
    }

    const next = current.filter((candidate) => candidate !== value)
    if (next.length === current.length) {
      return false
    }

    this.#items = next
    return true
  }

  public has(): boolean {
    return this.#items.length > 0
  }

  public clear(): void {
    this.#items = []
  }
}

export class OrderedRegistry<TValue> extends CopyOnWriteRegistry<TValue> {
  public append(value: TValue): () => void {
    this.setItems([...this.getItems(), value])

    return () => {
      this.remove(value)
    }
  }

  public prepend(value: TValue): () => void {
    this.setItems([value, ...this.getItems()])

    return () => {
      this.remove(value)
    }
  }

  public remove(value: TValue): boolean {
    return this.removeItem(value)
  }

  public values(): readonly TValue[] {
    return this.getItems()
  }
}

export class PriorityRegistry<TListener, TOptions extends { priority: number }> extends CopyOnWriteRegistry<
  PriorityRegistration<TListener, TOptions>
> {
  #order = 0

  public register(listener: TListener, options: TOptions): () => void {
    const registered = { ...options, listener, order: this.#order++ } as PriorityRegistration<TListener, TOptions>

    this.setItems(
      [...this.getItems(), registered].sort((left, right) => {
        const priorityDiff = right.priority - left.priority
        if (priorityDiff !== 0) {
          return priorityDiff
        }

        return left.order - right.order
      }),
    )

    return () => {
      this.removeItem(registered)
    }
  }

  public entries(): readonly PriorityRegistration<TListener, TOptions>[] {
    return this.getItems()
  }
}
