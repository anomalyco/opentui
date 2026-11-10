export type RuntimeEmitterListener<TValue> = [TValue] extends [void] ? () => void : (value: TValue) => void

type RuntimeEmitterArgs<TValue> = [TValue] extends [void] ? [] : [TValue]

type RuntimeEmitterListeners<TEvents extends Record<string, unknown>> = Partial<{
  [TName in keyof TEvents]: readonly RuntimeEmitterListener<TEvents[TName]>[]
}>

export interface RuntimeEmitter<TEvents extends Record<string, unknown>> {
  hook<TName extends keyof TEvents>(name: TName, listener: RuntimeEmitterListener<TEvents[TName]>): () => void
  has<TName extends keyof TEvents>(name: TName): boolean
  emit<TName extends keyof TEvents>(name: TName, ...args: RuntimeEmitterArgs<TEvents[TName]>): void
}

export function createRuntimeEmitter<TEvents extends Record<string, unknown>>(
  onError: (name: keyof TEvents, error: unknown) => void,
): RuntimeEmitter<TEvents> {
  let listeners: RuntimeEmitterListeners<TEvents> = Object.create(null) as RuntimeEmitterListeners<TEvents>
  const off = <TName extends keyof TEvents>(name: TName, listener: RuntimeEmitterListener<TEvents[TName]>): void => {
    const current = listeners[name]
    if (!current) return
    const next = current.filter((candidate) => candidate !== listener) as readonly RuntimeEmitterListener<
      TEvents[TName]
    >[]
    if (next.length === 0) delete listeners[name]
    else if (next.length !== current.length) listeners[name] = next
  }

  return {
    hook(name, listener) {
      listeners[name] = [...(listeners[name] ?? []), listener] as readonly RuntimeEmitterListener<
        TEvents[typeof name]
      >[]
      return () => off(name, listener)
    },
    has(name) {
      return (listeners[name]?.length ?? 0) > 0
    },
    emit(name, ...args) {
      const current = listeners[name] as readonly RuntimeEmitterListener<TEvents[typeof name]>[] | undefined
      if (!current) return
      for (const listener of current) {
        try {
          if (args.length === 0) (listener as () => void)()
          else (listener as (value: TEvents[typeof name]) => void)(args[0] as TEvents[typeof name])
        } catch (error) {
          onError(name, error)
        }
      }
    },
  }
}

export type RuntimePriorityRegistration<TListener, TOptions extends { priority: number }> = Readonly<
  TOptions & { listener: TListener; order: number }
>

export interface RuntimeOrderedRegistry<TValue> {
  append(value: TValue): () => void
  prepend(value: TValue): () => void
  values(): readonly TValue[]
  has(): boolean
  clear(): void
}

export interface RuntimePriorityRegistry<TListener, TOptions extends { priority: number }> {
  register(listener: TListener, options: TOptions): () => void
  entries(): readonly RuntimePriorityRegistration<TListener, TOptions>[]
  has(): boolean
  clear(): void
}

function createItems<TValue>() {
  let items: readonly TValue[] = []
  return {
    get: () => items,
    set: (next: readonly TValue[]) => {
      items = next
    },
    remove(value: TValue) {
      items = items.filter((candidate) => candidate !== value)
    },
    has: () => items.length > 0,
    clear: () => {
      items = []
    },
  }
}

export function createRuntimeOrderedRegistry<TValue>(): RuntimeOrderedRegistry<TValue> {
  const items = createItems<TValue>()
  return {
    append(value) {
      items.set([...items.get(), value])
      return () => items.remove(value)
    },
    prepend(value) {
      items.set([value, ...items.get()])
      return () => items.remove(value)
    },
    values: items.get,
    has: items.has,
    clear: items.clear,
  }
}

export function createRuntimePriorityRegistry<
  TListener,
  TOptions extends { priority: number },
>(): RuntimePriorityRegistry<TListener, TOptions> {
  const items = createItems<RuntimePriorityRegistration<TListener, TOptions>>()
  let order = 0
  return {
    register(listener, options) {
      const registered = { ...options, listener, order: order++ } as RuntimePriorityRegistration<TListener, TOptions>
      items.set(
        [...items.get(), registered].sort((left, right) => {
          const priorityDiff = right.priority - left.priority
          return priorityDiff || left.order - right.order
        }),
      )
      return () => items.remove(registered)
    },
    entries: items.get,
    has: items.has,
    clear: items.clear,
  }
}
