import { Keymap } from "@opentui/keymap"
import { registerDefaultKeys } from "@opentui/keymap/addons"
import type { ErrorEvent, HostMetadata, KeymapEvent, KeymapHost, WarningEvent } from "@opentui/keymap"

export type TestKeyModifierOptions = Partial<Pick<KeymapEvent, "ctrl" | "shift" | "meta" | "super" | "hyper">>

export type TestHostMetadataOptions = Partial<Omit<HostMetadata, "modifiers">> & {
  modifiers?: Partial<HostMetadata["modifiers"]>
}

export interface CreateTestKeymapHostOptions {
  metadata?: HostMetadata | TestHostMetadataOptions
}

export interface CreateTestKeymapOptions extends CreateTestKeymapHostOptions {
  defaultKeys?: boolean
}

export interface TestDiagnosticCapture {
  readonly warnings: readonly string[]
  readonly errors: readonly string[]
  readonly warningEvents: readonly WarningEvent[]
  readonly errorEvents: readonly ErrorEvent[]
  takeWarnings(): { warnings: string[]; warningEvents: WarningEvent[] }
  takeErrors(): { errors: string[]; errorEvents: ErrorEvent[] }
  clear(): void
  dispose(): void
}

export interface TestKeymapHarness {
  keymap: Keymap<TestKeymapTarget, TestKeymapEvent>
  host: TestKeymapHost
  root: TestKeymapTarget
  diagnostics: TestDiagnosticCapture
  cleanup(): void
}

export const DEFAULT_TEST_HOST_METADATA: HostMetadata = Object.freeze({
  platform: "unknown",
  primaryModifier: "unknown",
  modifiers: Object.freeze({
    ctrl: "unknown",
    shift: "unknown",
    meta: "unknown",
    super: "unknown",
    hyper: "unknown",
  }),
})

export class TestKeymapTarget {
  public parent: TestKeymapTarget | null = null
  public isDestroyed = false

  constructor(public readonly id: string) {}

  public append(child: TestKeymapTarget): TestKeymapTarget {
    child.parent = this
    return child
  }
}

export class TestKeymapEvent implements KeymapEvent {
  public readonly ctrl: boolean
  public readonly shift: boolean
  public readonly meta: boolean
  public readonly super: boolean
  public readonly hyper?: boolean
  public propagationStopped = false
  public defaultPrevented = false

  constructor(
    public readonly name: string,
    modifiers?: TestKeyModifierOptions,
  ) {
    this.ctrl = modifiers?.ctrl ?? false
    this.shift = modifiers?.shift ?? false
    this.meta = modifiers?.meta ?? false
    this.super = modifiers?.super ?? false
    this.hyper = modifiers?.hyper || undefined
  }

  public preventDefault(): void {
    this.defaultPrevented = true
  }

  public stopPropagation(): void {
    this.propagationStopped = true
  }
}

export class TestKeymapHost implements KeymapHost<TestKeymapTarget, TestKeymapEvent> {
  public readonly metadata: HostMetadata
  public readonly rootTarget: TestKeymapTarget
  public isDestroyed = false

  private focusedTarget: TestKeymapTarget | null = null
  private readonly keyPressListeners = new Set<(event: TestKeymapEvent) => void>()
  private readonly keyReleaseListeners = new Set<(event: TestKeymapEvent) => void>()
  private readonly focusListeners = new Set<(target: TestKeymapTarget | null) => void>()
  private readonly destroyListeners = new Set<() => void>()
  private readonly rawListeners = new Set<(sequence: string) => boolean>()
  private readonly targetDestroyListeners = new WeakMap<TestKeymapTarget, Set<() => void>>()

  constructor(options?: CreateTestKeymapHostOptions) {
    this.metadata = normalizeTestHostMetadata(options?.metadata)
    this.rootTarget = new TestKeymapTarget("root")
  }

  public createTarget(id: string): TestKeymapTarget {
    return new TestKeymapTarget(id)
  }

  public getFocusedTarget(): TestKeymapTarget | null {
    return this.focusedTarget && !this.focusedTarget.isDestroyed ? this.focusedTarget : null
  }

  public getParentTarget(target: TestKeymapTarget): TestKeymapTarget | null {
    return target.parent
  }

  public isTargetDestroyed(target: TestKeymapTarget): boolean {
    return target.isDestroyed
  }

  public onKeyPress(listener: (event: TestKeymapEvent) => void): () => void {
    this.keyPressListeners.add(listener)
    return () => {
      this.keyPressListeners.delete(listener)
    }
  }

  public onKeyRelease(listener: (event: TestKeymapEvent) => void): () => void {
    this.keyReleaseListeners.add(listener)
    return () => {
      this.keyReleaseListeners.delete(listener)
    }
  }

  public onFocusChange(listener: (target: TestKeymapTarget | null) => void): () => void {
    this.focusListeners.add(listener)
    return () => {
      this.focusListeners.delete(listener)
    }
  }

  public onDestroy(listener: () => void): () => void {
    this.destroyListeners.add(listener)
    return () => {
      this.destroyListeners.delete(listener)
    }
  }

  public onTargetDestroy(target: TestKeymapTarget, listener: () => void): () => void {
    let listeners = this.targetDestroyListeners.get(target)
    if (!listeners) {
      listeners = new Set()
      this.targetDestroyListeners.set(target, listeners)
    }

    listeners.add(listener)
    return () => {
      listeners?.delete(listener)
      if (listeners && listeners.size === 0) {
        this.targetDestroyListeners.delete(target)
      }
    }
  }

  public onRawInput(listener: (sequence: string) => boolean): () => void {
    this.rawListeners.add(listener)
    return () => {
      this.rawListeners.delete(listener)
    }
  }

  public createCommandEvent(): TestKeymapEvent {
    return new TestKeymapEvent("synthetic")
  }

  public focus(target: TestKeymapTarget | null): void {
    this.focusedTarget = target
    for (const listener of this.focusListeners) {
      listener(target)
    }
  }

  public press(name: string, modifiers?: TestKeyModifierOptions): TestKeymapEvent {
    const event = new TestKeymapEvent(name, modifiers)
    for (const listener of this.keyPressListeners) {
      listener(event)
    }

    return event
  }

  public release(name: string, modifiers?: TestKeyModifierOptions): TestKeymapEvent {
    const event = new TestKeymapEvent(name, modifiers)
    for (const listener of this.keyReleaseListeners) {
      listener(event)
    }

    return event
  }

  public raw(sequence: string): boolean {
    let handled = false
    for (const listener of this.rawListeners) {
      handled = listener(sequence) || handled
    }

    return handled
  }

  public destroyTarget(target: TestKeymapTarget): void {
    target.isDestroyed = true
    const listeners = this.targetDestroyListeners.get(target)
    if (!listeners) {
      return
    }

    for (const listener of [...listeners]) {
      listener()
    }
  }

  public destroy(): void {
    if (this.isDestroyed) {
      return
    }

    this.isDestroyed = true
    for (const listener of [...this.destroyListeners]) {
      listener()
    }
  }
}

export function createTestHostMetadata(options?: HostMetadata | TestHostMetadataOptions): HostMetadata {
  return normalizeTestHostMetadata(options)
}

export function createTestKeymapHost(options?: CreateTestKeymapHostOptions): TestKeymapHost {
  return new TestKeymapHost(options)
}

export function createTestKeymap(options?: CreateTestKeymapOptions): TestKeymapHarness {
  const host = createTestKeymapHost(options)
  const keymap = new Keymap(host)
  const diagnostics = captureKeymapDiagnostics(keymap)

  if (options?.defaultKeys === true) {
    registerDefaultKeys(keymap)
  }

  return {
    keymap,
    host,
    root: host.rootTarget,
    diagnostics,
    cleanup() {
      host.destroy()
      diagnostics.dispose()
    },
  }
}

export function captureKeymapDiagnostics(keymap: Keymap<any, any>): TestDiagnosticCapture {
  const warnings: string[] = []
  const errors: string[] = []
  const warningEvents: WarningEvent[] = []
  const errorEvents: ErrorEvent[] = []

  const offWarning = keymap.on("warning", (event) => {
    warnings.push(event.message)
    warningEvents.push(event)
  })
  const offError = keymap.on("error", (event) => {
    errors.push(event.message)
    errorEvents.push(event)
  })

  return {
    warnings,
    errors,
    warningEvents,
    errorEvents,
    takeWarnings() {
      const snapshot = {
        warnings: [...warnings],
        warningEvents: [...warningEvents],
      }
      warnings.length = 0
      warningEvents.length = 0
      return snapshot
    },
    takeErrors() {
      const snapshot = {
        errors: [...errors],
        errorEvents: [...errorEvents],
      }
      errors.length = 0
      errorEvents.length = 0
      return snapshot
    },
    clear() {
      warnings.length = 0
      errors.length = 0
      warningEvents.length = 0
      errorEvents.length = 0
    },
    dispose() {
      offWarning()
      offError()
    },
  }
}

function normalizeTestHostMetadata(metadata?: HostMetadata | TestHostMetadataOptions): HostMetadata {
  if (isHostMetadata(metadata)) {
    return metadata
  }

  return {
    platform: metadata?.platform ?? DEFAULT_TEST_HOST_METADATA.platform,
    primaryModifier: metadata?.primaryModifier ?? DEFAULT_TEST_HOST_METADATA.primaryModifier,
    modifiers: {
      ...DEFAULT_TEST_HOST_METADATA.modifiers,
      ...metadata?.modifiers,
    },
  }
}

function isHostMetadata(value: HostMetadata | TestHostMetadataOptions | undefined): value is HostMetadata {
  return !!value && !!value.modifiers && "ctrl" in value.modifiers && "shift" in value.modifiers
}
