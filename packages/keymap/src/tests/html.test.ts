import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createDefaultHtmlKeymap, createHtmlKeymap, createHtmlKeymapEvent, normalizeHtmlKeyName } from "../html.js"
import { createDiagnosticHarness } from "./diagnostic-harness.js"

const diagnostics = createDiagnosticHarness()

function getKeymap(root: HTMLElement) {
  return diagnostics.trackKeymap(createDefaultHtmlKeymap(root))
}

function createBareHtmlKeymap(root: HTMLElement) {
  return diagnostics.trackKeymap(createHtmlKeymap(root))
}

type Listener = (event: unknown) => void

class FakeMutationObserver {
  private static readonly instances = new Set<FakeMutationObserver>()

  constructor(private readonly callback: () => void) {}

  public observe(_target: EventTarget, _options?: unknown): void {
    FakeMutationObserver.instances.add(this)
  }

  public disconnect(): void {
    FakeMutationObserver.instances.delete(this)
  }

  public static flush(): void {
    for (const observer of [...FakeMutationObserver.instances]) {
      observer.callback()
    }
  }

  public static reset(): void {
    FakeMutationObserver.instances.clear()
  }
}

class FakeDocument {
  public activeElement: FakeElement | null = null
}

class FakeKeyboardEvent {
  public defaultPrevented = false
  public propagationStopped = false

  constructor(
    public readonly key: string,
    public readonly ctrlKey = false,
    public readonly shiftKey = false,
    public readonly altKey = false,
    public readonly metaKey = false,
  ) {}

  public preventDefault(): void {
    this.defaultPrevented = true
  }

  public stopPropagation(): void {
    this.propagationStopped = true
  }
}

class FakeElement {
  public parentElement: FakeElement | null = null
  public isConnected = true
  private readonly listeners = new Map<string, Set<Listener>>()
  private readonly children = new Set<FakeElement>()

  constructor(
    public readonly id: string,
    public readonly ownerDocument: FakeDocument,
  ) {}

  public append(child: FakeElement): FakeElement {
    child.parentElement = this
    child.isConnected = this.isConnected
    this.children.add(child)
    return child
  }

  public remove(child: FakeElement): void {
    if (!this.children.delete(child)) {
      return
    }

    child.parentElement = null
    child.disconnectSubtree()
    FakeMutationObserver.flush()
  }

  public contains(target: FakeElement | null): boolean {
    let current = target
    while (current) {
      if (current === this) {
        return true
      }

      current = current.parentElement
    }

    return false
  }

  public addEventListener(name: string, listener: Listener): void {
    let listeners = this.listeners.get(name)
    if (!listeners) {
      listeners = new Set()
      this.listeners.set(name, listeners)
    }

    listeners.add(listener)
  }

  public removeEventListener(name: string, listener: Listener): void {
    this.listeners.get(name)?.delete(listener)
  }

  public emit(name: string, event: unknown): void {
    const listeners = this.listeners.get(name)
    if (!listeners) {
      return
    }

    for (const listener of [...listeners]) {
      listener(event)
    }
  }

  private disconnectSubtree(): void {
    this.isConnected = false
    for (const child of this.children) {
      child.disconnectSubtree()
    }
  }
}

describe("html keymap adapter", () => {
  let root: FakeElement
  let document: FakeDocument
  let previousMutationObserver: unknown

  beforeEach(() => {
    FakeMutationObserver.reset()
    document = new FakeDocument()
    root = new FakeElement("root", document)
    previousMutationObserver = (globalThis as { MutationObserver?: unknown }).MutationObserver
    ;(globalThis as { MutationObserver?: unknown }).MutationObserver = FakeMutationObserver
  })

  afterEach(() => {
    ;(globalThis as { MutationObserver?: unknown }).MutationObserver = previousMutationObserver
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("normalizes browser key names and modifiers", () => {
    expect(normalizeHtmlKeyName("ArrowLeft")).toBe("left")
    expect(normalizeHtmlKeyName("Enter")).toBe("return")
    expect(normalizeHtmlKeyName("A")).toBe("a")
    expect(normalizeHtmlKeyName("F12")).toBe("f12")

    const event = createHtmlKeymapEvent(
      new FakeKeyboardEvent("Enter", true, false, true, true) as unknown as KeyboardEvent,
    )
    expect(event.name).toBe("return")
    expect(event.ctrl).toBe(true)
    expect(event.meta).toBe(true)
    expect(event.super).toBe(true)
  })

  test("createHtmlKeymap returns a fresh keymap for each call", () => {
    const first = createBareHtmlKeymap(root as unknown as HTMLElement)
    const second = createBareHtmlKeymap(root as unknown as HTMLElement)

    expect(first).not.toBe(second)
  })

  test("HTML host exposes platform and modifier metadata", () => {
    const keymap = createBareHtmlKeymap(root as unknown as HTMLElement)
    const metadata = keymap.getHostMetadata()

    expect(["macos", "windows", "linux", "unknown"]).toContain(metadata.platform)
    expect(metadata.primaryModifier).toBe(
      metadata.platform === "macos" ? "super" : metadata.platform === "unknown" ? "unknown" : "ctrl",
    )
    expect(metadata.modifiers).toEqual({
      ctrl: "supported",
      shift: "supported",
      meta: "supported",
      super: "supported",
      hyper: "unsupported",
    })
  })

  test("createHtmlKeymap stays bare until addons are installed", () => {
    const keymap = createBareHtmlKeymap(root as unknown as HTMLElement)
    const { takeErrors } = diagnostics.captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "noop",
          run() {
            calls.push("noop")
          },
        },
      ],
    })

    expect(() => {
      keymap.registerLayer({
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    root.emit("keydown", new FakeKeyboardEvent("x"))
    expect(calls).toEqual([])
    expect(keymap.getActiveKeys()).toEqual([])
    expect(takeErrors().errors).toEqual(["No keymap binding parsers are registered"])

    const configuredKeymap = getKeymap(root as unknown as HTMLElement)
    configuredKeymap.registerLayer({
      commands: [
        {
          name: "configured",
          run() {
            calls.push("configured")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "configured" }],
    })

    root.emit("keydown", new FakeKeyboardEvent("x"))
    expect(calls).toEqual(["configured"])
  })

  test("createDefaultHtmlKeymap installs metadata and enabled fields", () => {
    const keymap = getKeymap(root as unknown as HTMLElement)
    const { takeWarnings } = diagnostics.captureDiagnostics(keymap)

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          desc: "Save file",
          title: "Save",
          category: "File",
          run() {},
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "save-file", desc: "Write current file", group: "File" }],
    })
    keymap.registerLayer({
      enabled: false,
      bindings: [{ key: "y", cmd: "save-file" }],
    })

    const activeKey = keymap.getActiveKeys({ includeMetadata: true }).find((candidate) => candidate.stroke.name === "x")

    expect(keymap.getActiveKeys().find((candidate) => candidate.stroke.name === "y")).toBeUndefined()
    expect(activeKey?.bindingAttrs).toEqual({ desc: "Write current file", group: "File" })
    expect(activeKey?.commandAttrs).toEqual({ desc: "Save file", title: "Save", category: "File" })
    expect(takeWarnings().warnings).toEqual([])
  })

  test("supports focus-within layers on regular HTML targets", () => {
    const keymap = getKeymap(root as unknown as HTMLElement)
    const panel = root.append(new FakeElement("panel", document))
    const child = panel.append(new FakeElement("child", document))
    const calls: string[] = []

    keymap.registerLayer({
      target: panel as unknown as HTMLElement,
      targetMode: "focus-within",
      commands: [
        {
          name: "panel-run",
          run(ctx) {
            calls.push(ctx.target?.id ?? "none")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "panel-run" }],
    })

    document.activeElement = child
    root.emit("keydown", new FakeKeyboardEvent("x"))

    expect(calls).toEqual(["panel"])
    expect(keymap.getActiveKeys().map((candidate) => candidate.stroke.name)).toEqual(["x"])
  })

  test("dispatches shifted punctuation bindings using literal characters", () => {
    const keymap = getKeymap(root as unknown as HTMLElement)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "prompt-open",
          run() {
            calls.push(":")
          },
        },
        {
          name: "toggle-help",
          run() {
            calls.push("?")
          },
        },
      ],
      bindings: [
        { key: ":", cmd: "prompt-open" },
        { key: "?", cmd: "toggle-help" },
      ],
    })

    root.emit("keydown", new FakeKeyboardEvent(":", false, true))
    root.emit("keydown", new FakeKeyboardEvent("?", false, true))

    expect(calls).toEqual([":", "?"])
  })

  test("clears pending sequences when focus changes", async () => {
    const keymap = getKeymap(root as unknown as HTMLElement)
    const first = root.append(new FakeElement("first", document))
    const second = root.append(new FakeElement("second", document))

    keymap.registerLayer({
      target: first as unknown as HTMLElement,
      targetMode: "focus-within",
      commands: [{ name: "noop", run() {} }],
      bindings: [{ key: "ga", cmd: "noop" }],
    })

    document.activeElement = first
    root.emit("keydown", new FakeKeyboardEvent("g"))
    expect(keymap.hasPendingSequence()).toBe(true)

    document.activeElement = second
    root.emit("focusin", {})
    await Bun.sleep(0)

    expect(keymap.hasPendingSequence()).toBe(false)
  })

  test("unregisters target layers when HTML targets are removed", () => {
    const keymap = getKeymap(root as unknown as HTMLElement)
    const panel = root.append(new FakeElement("panel", document))

    keymap.registerLayer({
      target: panel as unknown as HTMLElement,
      targetMode: "focus-within",
      commands: [{ name: "noop", run() {} }],
      bindings: [{ key: "x", cmd: "noop" }],
    })

    document.activeElement = panel
    expect(keymap.getActiveKeys().map((candidate) => candidate.stroke.name)).toEqual(["x"])

    root.remove(panel)
    document.activeElement = null

    expect(keymap.getActiveKeys()).toEqual([])
  })
})
