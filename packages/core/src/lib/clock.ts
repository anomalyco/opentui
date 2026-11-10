export type TimerHandle = ReturnType<typeof globalThis.setTimeout> | number

export interface Clock {
  now(): number
  setTimeout(fn: () => void, delayMs: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
  setInterval(fn: () => void, delayMs: number): TimerHandle
  clearInterval(handle: TimerHandle): void
}

export class SystemClock implements Clock {
  public now(): number {
    if (!globalThis.performance || typeof globalThis.performance.now !== "function") {
      throw new Error("SystemClock requires globalThis.performance.now()")
    }

    return globalThis.performance.now()
  }

  public setTimeout(fn: () => void, delayMs: number): TimerHandle {
    return globalThis.setTimeout(fn, delayMs)
  }

  public clearTimeout(handle: TimerHandle): void {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>)
  }

  public setInterval(fn: () => void, delayMs: number): TimerHandle {
    return globalThis.setInterval(fn, delayMs)
  }

  public clearInterval(handle: TimerHandle): void {
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setTimeout>)
  }
}
