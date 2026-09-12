import { describe, expect, it } from "bun:test"
import {
  createClipboard,
  createRendererClipboardAdapter,
  type HostClipboardBackend,
  type TerminalClipboardAdapter,
} from "./clipboard.js"
import { createHostClipboardWithBackend } from "./host-clipboard.internal.js"

const createHost = (backend: HostClipboardBackend, maxWriteBytes?: number) =>
  createHostClipboardWithBackend({ maxWriteBytes }, () => backend)

const createServices = (
  options: {
    remote?: boolean
    hostStatus?: "written" | "unsupported" | "cancelled"
    maxWriteBytes?: number
    backend?: Partial<HostClipboardBackend>
    terminal?: Partial<TerminalClipboardAdapter>
  } = {},
) => {
  const events: string[] = []
  const backend: HostClipboardBackend = {
    async read() {
      events.push("host-read")
      return { status: "empty" }
    },
    async writeText(_text, _operation) {
      events.push("host-write")
      return { status: options.hostStatus ?? "written" }
    },
    async clear() {
      events.push("host-clear")
      return { status: "cleared" }
    },
    async dispose() {},
    ...options.backend,
  }
  const terminal: TerminalClipboardAdapter = {
    remote: options.remote ?? false,
    writeText() {
      events.push("terminal-write")
      return { status: "attempted", capability: "supported" }
    },
    clear() {
      events.push("terminal-clear")
      return { status: "attempted", capability: "supported" }
    },
    ...options.terminal,
  }
  const clipboard = createClipboard({
    host: createHost(backend, options.maxWriteBytes),
    terminal,
  })
  return { clipboard, events }
}

describe("createClipboard", () => {
  it("applies local destination policies and best-available stop/fallback", async () => {
    const cases = [
      ["terminal-only", undefined, "not-attempted", "attempted", ["terminal-write"]],
      ["host-only", undefined, "written", "not-attempted", ["host-write"]],
      ["best-available", "written", "written", "not-attempted", ["host-write"]],
      ["best-available", "cancelled", "cancelled", "not-attempted", ["host-write"]],
      ["best-available", "unsupported", "unsupported", "attempted", ["host-write", "terminal-write"]],
      ["all-available", undefined, "written", "attempted", ["host-write", "terminal-write"]],
    ] as const
    for (const [destination, hostStatus, expectedHost, expectedTerminal, events] of cases) {
      const service = createServices({ hostStatus })
      const result = await service.clipboard.writeText("text", { destination })
      expect([result.host.status, result.terminal.status]).toEqual([expectedHost, expectedTerminal])
      expect(service.events).toEqual([...events])
      await service.clipboard.dispose()
    }

    const clear = createServices()
    await clear.clipboard.clear({ destination: "all-available" })
    expect(clear.events).toEqual(["host-clear", "terminal-clear"])
    await clear.clipboard.dispose()
  })

  it("enforces remote host authorization for every policy", async () => {
    const cases = [
      ["host-only", false, "not-attempted", "not-attempted", []],
      ["host-only", true, "written", "not-attempted", ["host-write"]],
      ["best-available", true, "not-attempted", "attempted", ["terminal-write"]],
      ["all-available", false, "not-attempted", "attempted", ["terminal-write"]],
    ] as const
    for (const [destination, allowRemoteHost, expectedHost, expectedTerminal, events] of cases) {
      const service = createServices({ remote: true })
      const result = await service.clipboard.writeText("text", { destination, allowRemoteHost })
      expect([result.host.status, result.terminal.status]).toEqual([expectedHost, expectedTerminal])
      expect(service.events).toEqual([...events])
      await service.clipboard.dispose()
    }
  })

  it("rejects invalid text before either destination", async () => {
    const service = createServices({ maxWriteBytes: 4 })
    await expect(service.clipboard.writeText("bad\0text", { destination: "all-available" })).rejects.toThrow("NUL")
    expect(service.events).toEqual([])
    await service.clipboard.dispose()
  })

  it("validates before handling pre-abort and does not dispatch pre-aborted operations", async () => {
    const service = createServices({ maxWriteBytes: 4 })
    const signal = AbortSignal.abort()
    const options = { destination: "all-available", signal } as const

    await expect(service.clipboard.writeText("", options)).rejects.toThrow("non-empty")
    await expect(
      service.clipboard.writeText("text", {
        ...options,
        destination: "invalid" as never,
      }),
    ).rejects.toThrow("destination")
    await expect(service.clipboard.clear({ ...options, selection: "invalid" as never })).rejects.toThrow("selection")
    await expect(service.clipboard.read({ preferredTypes: [] as never, signal })).rejects.toThrow("at least one")

    const write = await service.clipboard.writeText("text", options)
    const clear = await service.clipboard.clear(options)
    const notAttempted = {
      host: { status: "not-attempted" },
      terminal: { status: "not-attempted", capability: "unknown" },
    } as const
    expect(write).toEqual(notAttempted)
    expect(clear).toEqual(notAttempted)
    expect(service.events).toEqual([])
    await service.clipboard.dispose()
  })

  it("preserves terminal dispatch when all-available host work is later cancelled", async () => {
    const service = createServices({
      backend: {
        async writeText(_text, options) {
          return await new Promise((resolve) => {
            options.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true })
          })
        },
      },
    })
    const controller = new AbortController()
    const pending = service.clipboard.writeText("text", { destination: "all-available", signal: controller.signal })
    expect(service.events).toEqual(["terminal-write"])
    controller.abort()
    expect(await pending).toEqual({
      host: { status: "cancelled" },
      terminal: { status: "attempted", capability: "supported" },
    })
    await service.clipboard.dispose()
  })

  it("does not start a best-available terminal fallback after cancellation", async () => {
    const service = createServices({ hostStatus: "unsupported" })
    const controller = new AbortController()
    const pending = service.clipboard.writeText("text", {
      destination: "best-available",
      signal: controller.signal,
    })

    expect(service.events).toEqual(["host-write"])
    controller.abort()

    expect((await pending).terminal).toEqual({ status: "not-attempted", capability: "unknown" })
    expect(service.events).toEqual(["host-write"])
    await service.clipboard.dispose()
  })

  it("owns host disposal, waits for active composition, and rejects later operations", async () => {
    let release: (() => void) | undefined
    let disposeCount = 0
    const service = createServices({
      backend: {
        async read(options) {
          await new Promise<void>((resolve) => {
            options.signal.addEventListener(
              "abort",
              () => {
                release = resolve
              },
              { once: true },
            )
          })
          return { status: "cancelled" }
        },
        async dispose() {
          disposeCount++
        },
      },
    })
    const clipboard = service.clipboard
    const read = clipboard.read({ preferredTypes: ["text/plain"] })
    const firstDispose = clipboard.dispose()
    expect(clipboard.dispose()).toBe(firstDispose)
    await Promise.resolve()
    expect(disposeCount).toBe(0)
    release?.()
    await read
    await firstDispose
    expect(disposeCount).toBe(1)
    await expect(clipboard.read({ preferredTypes: ["text/plain"] })).rejects.toThrow("disposed")
    await expect(clipboard.writeText("text", { destination: "host-only" })).rejects.toThrow("disposed")
    await expect(clipboard.clear({ destination: "host-only" })).rejects.toThrow("disposed")
  })
})

describe("createRendererClipboardAdapter", () => {
  it("maps selections, capabilities, results, and conservative remote state", () => {
    const calls: Array<[string, number]> = []
    const renderer = {
      capabilities: null as null | { remote: boolean; osc52_support: "supported" | "unsupported" | "unknown" },
      copyToClipboardOSC52(_text: string, target: number) {
        calls.push(["write", target])
        return true
      },
      clearClipboardOSC52(target: number) {
        calls.push(["clear", target])
        return false
      },
    }
    const adapter = createRendererClipboardAdapter(renderer)
    expect(adapter.remote).toBe(true)
    expect(adapter.writeText("text", "primary")).toEqual({ status: "attempted", capability: "unknown" })
    renderer.capabilities = { remote: false, osc52_support: "supported" }
    expect(adapter.remote).toBe(false)
    expect(adapter.clear("clipboard")).toEqual({ status: "local-failure", capability: "supported" })
    renderer.capabilities = { remote: false, osc52_support: "unsupported" }
    expect(adapter.writeText("ignored", "clipboard")).toEqual({
      status: "not-attempted",
      capability: "unsupported",
    })
    expect(calls).toEqual([
      ["write", 1],
      ["clear", 0],
    ])
  })
})
