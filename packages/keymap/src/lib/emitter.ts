export type EmitterListener<TValue> = [TValue] extends [void] ? () => void : (value: TValue) => void

type EmitterArgs<TValue> = [TValue] extends [void] ? [] : [TValue]

type EmitterListeners<TEvents extends Record<string, unknown>> = Partial<{
  [TName in keyof TEvents]: readonly EmitterListener<TEvents[TName]>[]
}>

export class Emitter<TEvents extends Record<string, unknown>> {
  #listeners: EmitterListeners<TEvents> = Object.create(null) as EmitterListeners<TEvents>
  #onError: (name: keyof TEvents, error: unknown) => void

  constructor(onError: (name: keyof TEvents, error: unknown) => void) {
    this.#onError = onError
  }

  public hook<TName extends keyof TEvents>(name: TName, listener: EmitterListener<TEvents[TName]>): () => void {
    const current = this.#listeners[name] ?? []
    this.#listeners[name] = [...current, listener] as readonly EmitterListener<TEvents[TName]>[]

    return () => {
      this.off(name, listener)
    }
  }

  public has<TName extends keyof TEvents>(name: TName): boolean {
    return (this.#listeners[name]?.length ?? 0) > 0
  }

  public off<TName extends keyof TEvents>(name: TName, listener: EmitterListener<TEvents[TName]>): void {
    const current = this.#listeners[name]
    if (!current || current.length === 0) {
      return
    }

    const next = current.filter((candidate) => candidate !== listener) as readonly EmitterListener<TEvents[TName]>[]
    if (next.length === current.length) {
      return
    }

    if (next.length === 0) {
      delete this.#listeners[name]
      return
    }

    this.#listeners[name] = next
  }

  public clear(): void {
    this.#listeners = Object.create(null) as EmitterListeners<TEvents>
  }

  public emit<TName extends keyof TEvents>(name: TName, ...args: EmitterArgs<TEvents[TName]>): void {
    const listeners = this.#listeners[name] as readonly EmitterListener<TEvents[TName]>[] | undefined
    if (!listeners || listeners.length === 0) {
      return
    }

    for (const listener of listeners) {
      try {
        if (args.length === 0) {
          ;(listener as () => void)()
        } else {
          ;(listener as (value: TEvents[TName]) => void)(args[0] as TEvents[TName])
        }
      } catch (error) {
        this.#onError(name, error)
      }
    }
  }
}
