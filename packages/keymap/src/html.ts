import { Keymap } from "@opentui/keymap"
import { registerDefaultKeys, registerEnabledFields, registerMetadataFields } from "@opentui/keymap/addons"
import type {
  EventMatchResolver,
  HostMetadata,
  HostPlatform,
  KeyStrokeInput,
  KeymapEvent,
  KeymapHost,
} from "@opentui/keymap"

export interface HtmlKeymapEvent extends KeymapEvent {
  readonly originalEvent?: KeyboardEvent
}

interface HtmlKeyboardEventLike {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  preventDefault(): void
  stopPropagation(): void
}

interface MutationObserverLike {
  observe(target: EventTarget, options?: unknown): void
  disconnect(): void
}

interface MutationObserverCtorLike {
  new (callback: () => void): MutationObserverLike
}

const HTML_KEY_NAME_ALIASES = new Map<string, string>([
  [" ", "space"],
  ["Spacebar", "space"],
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
  ["Escape", "escape"],
  ["Esc", "escape"],
  ["Enter", "return"],
  ["Backspace", "backspace"],
  ["Delete", "delete"],
  ["Tab", "tab"],
  ["Home", "home"],
  ["End", "end"],
  ["PageUp", "pageup"],
  ["PageDown", "pagedown"],
  ["Insert", "insert"],
  ["CapsLock", "capslock"],
  ["NumLock", "numlock"],
  ["ScrollLock", "scrolllock"],
  ["ContextMenu", "menu"],
  ["Meta", "super"],
  ["OS", "super"],
  ["Alt", "alt"],
  ["Control", "control"],
  ["Shift", "shift"],
])

function normalizeHostPlatform(value: string | undefined): HostPlatform {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) {
    return "unknown"
  }

  if (normalized.includes("mac") || normalized.includes("darwin")) {
    return "macos"
  }

  if (normalized.includes("win")) {
    return "windows"
  }

  if (normalized.includes("linux") || normalized.includes("x11")) {
    return "linux"
  }

  return "unknown"
}

function detectBrowserPlatform(): HostPlatform {
  const navigatorLike = globalThis.navigator as
    | (Navigator & { userAgentData?: { platform?: string }; userAgent?: string })
    | undefined
  const userAgentPlatform = navigatorLike?.userAgentData?.platform
  const platform = normalizeHostPlatform(userAgentPlatform)
  if (platform !== "unknown") {
    return platform
  }

  return normalizeHostPlatform(navigatorLike?.platform ?? navigatorLike?.userAgent)
}

function createHtmlHostMetadata(): HostMetadata {
  const platform = detectBrowserPlatform()

  return {
    platform,
    primaryModifier: platform === "macos" ? "super" : platform === "unknown" ? "unknown" : "ctrl",
    modifiers: {
      ctrl: "supported",
      shift: "supported",
      meta: "supported",
      super: "supported",
      hyper: "unsupported",
    },
  }
}

function isPrintableSymbol(name: string): boolean {
  return name.length === 1 && !/^[a-z0-9]$/i.test(name)
}

function getHtmlEventMatchInputs(event: HtmlKeymapEvent): KeyStrokeInput[] {
  const primary: KeyStrokeInput = {
    name: event.name,
    ctrl: event.ctrl,
    shift: event.shift,
    meta: event.meta,
    super: event.super ?? false,
    hyper: event.hyper || undefined,
  }

  if (!primary.shift || !isPrintableSymbol(primary.name)) {
    return [primary]
  }

  return [
    primary,
    {
      ...primary,
      shift: false,
    },
  ]
}

class HtmlWrappedKeymapEvent implements HtmlKeymapEvent {
  public propagationStopped = false

  constructor(
    public readonly name: string,
    public readonly ctrl: boolean,
    public readonly shift: boolean,
    public readonly meta: boolean,
    private readonly superKey: boolean,
    public readonly originalEvent?: KeyboardEvent,
  ) {}

  public get super(): boolean {
    return this.superKey
  }

  public preventDefault(): void {
    this.originalEvent?.preventDefault()
  }

  public stopPropagation(): void {
    this.propagationStopped = true
    this.originalEvent?.stopPropagation()
  }
}

function getMutationObserverCtor(): MutationObserverCtorLike | undefined {
  return globalThis.MutationObserver as MutationObserverCtorLike | undefined
}

export function normalizeHtmlKeyName(key: string): string {
  const aliased = HTML_KEY_NAME_ALIASES.get(key)
  if (aliased) {
    return aliased
  }

  if (/^F\d{1,2}$/i.test(key)) {
    return key.toLowerCase()
  }

  if (key.length === 1) {
    return key.toLowerCase()
  }

  return key.trim().toLowerCase().replace(/\s+/g, "")
}

export function createHtmlKeymapEvent(event?: KeyboardEvent | HtmlKeyboardEventLike): HtmlKeymapEvent {
  if (!event) {
    return new HtmlWrappedKeymapEvent("command", false, false, false, false)
  }

  const KeyboardEventCtor = globalThis.KeyboardEvent

  // Keymap uses `meta` for Alt/Option and `super` for the platform Meta key,
  // so browser `altKey` maps to `meta` and `metaKey` maps to `super`.
  return new HtmlWrappedKeymapEvent(
    normalizeHtmlKeyName(event.key),
    event.ctrlKey,
    event.shiftKey,
    event.altKey,
    event.metaKey,
    KeyboardEventCtor && event instanceof KeyboardEventCtor ? event : undefined,
  )
}

class HtmlKeymapHost implements KeymapHost<HTMLElement, HtmlKeymapEvent> {
  public readonly metadata = createHtmlHostMetadata()
  public readonly rootTarget: HTMLElement
  public readonly isDestroyed = false

  private observer?: MutationObserverLike
  private readonly targetDestroyListeners = new Map<HTMLElement, Set<() => void>>()

  constructor(root: HTMLElement) {
    this.rootTarget = root
  }

  public getFocusedTarget(): HTMLElement | null {
    const active = this.rootTarget.ownerDocument.activeElement
    if (!active || typeof active !== "object") {
      return null
    }

    if (active === this.rootTarget || this.rootTarget.contains(active as HTMLElement)) {
      return active as HTMLElement
    }

    return null
  }

  public getParentTarget(target: HTMLElement): HTMLElement | null {
    return target.parentElement
  }

  public isTargetDestroyed(target: HTMLElement): boolean {
    if (target === this.rootTarget) {
      return false
    }

    return !target.isConnected || !this.rootTarget.contains(target)
  }

  public onKeyPress(listener: (event: HtmlKeymapEvent) => void): () => void {
    const onKeyDown = (event: KeyboardEvent) => {
      listener(createHtmlKeymapEvent(event))
    }

    this.rootTarget.addEventListener("keydown", onKeyDown, { capture: true })
    return () => {
      this.rootTarget.removeEventListener("keydown", onKeyDown, { capture: true })
    }
  }

  public onKeyRelease(listener: (event: HtmlKeymapEvent) => void): () => void {
    const onKeyUp = (event: KeyboardEvent) => {
      listener(createHtmlKeymapEvent(event))
    }

    this.rootTarget.addEventListener("keyup", onKeyUp, { capture: true })
    return () => {
      this.rootTarget.removeEventListener("keyup", onKeyUp, { capture: true })
    }
  }

  public onFocusChange(listener: (target: HTMLElement | null) => void): () => void {
    const notifyFocus = () => {
      queueMicrotask(() => {
        listener(this.getFocusedTarget())
      })
    }

    this.rootTarget.addEventListener("focusin", notifyFocus, { capture: true })
    this.rootTarget.addEventListener("focusout", notifyFocus, { capture: true })
    return () => {
      this.rootTarget.removeEventListener("focusin", notifyFocus, { capture: true })
      this.rootTarget.removeEventListener("focusout", notifyFocus, { capture: true })
    }
  }

  public onTargetDestroy(target: HTMLElement, listener: () => void): () => void {
    let listeners = this.targetDestroyListeners.get(target)
    if (!listeners) {
      listeners = new Set()
      this.targetDestroyListeners.set(target, listeners)
    }

    listeners.add(listener)
    this.ensureObserver()
    this.flushDisconnectedTargets()

    return () => {
      const current = this.targetDestroyListeners.get(target)
      if (!current) {
        return
      }

      current.delete(listener)
      if (current.size === 0) {
        this.targetDestroyListeners.delete(target)
      }

      if (this.targetDestroyListeners.size === 0) {
        this.disconnectObserver()
      }
    }
  }

  public createCommandEvent(): HtmlKeymapEvent {
    return createHtmlKeymapEvent()
  }

  private ensureObserver(): void {
    if (this.observer || this.targetDestroyListeners.size === 0) {
      return
    }

    const MutationObserverCtor = getMutationObserverCtor()
    if (!MutationObserverCtor) {
      return
    }

    this.observer = new MutationObserverCtor(() => {
      this.flushDisconnectedTargets()
    })
    this.observer.observe(this.rootTarget, {
      childList: true,
      subtree: true,
    })
  }

  private disconnectObserver(): void {
    if (!this.observer) {
      return
    }

    this.observer.disconnect()
    this.observer = undefined
  }

  private flushDisconnectedTargets(): void {
    for (const [target, listeners] of this.targetDestroyListeners) {
      if (!this.isTargetDestroyed(target)) {
        continue
      }

      this.targetDestroyListeners.delete(target)
      for (const current of [...listeners]) {
        current()
      }
    }

    if (this.targetDestroyListeners.size === 0) {
      this.disconnectObserver()
    }
  }
}

export function createHtmlKeymapHost(root: HTMLElement): KeymapHost<HTMLElement, HtmlKeymapEvent> {
  return new HtmlKeymapHost(root)
}

export const htmlEventMatchResolver: EventMatchResolver<HtmlKeymapEvent> = (event, ctx) => {
  return getHtmlEventMatchInputs(event).map((candidate) => ctx.resolveKey(candidate))
}

export function createHtmlKeymap(root: HTMLElement): Keymap<HTMLElement, HtmlKeymapEvent> {
  return new Keymap(createHtmlKeymapHost(root))
}

export function createDefaultHtmlKeymap(root: HTMLElement): Keymap<HTMLElement, HtmlKeymapEvent> {
  const keymap = new Keymap(createHtmlKeymapHost(root))
  registerDefaultKeys(keymap)
  registerEnabledFields(keymap)
  registerMetadataFields(keymap)
  keymap.prependEventMatchResolver(htmlEventMatchResolver)
  return keymap
}
