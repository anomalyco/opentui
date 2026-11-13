import { describe, expect, it } from "bun:test"
import {
  createClipboard,
  createRendererClipboardAdapter,
  type ClipboardSelection,
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
      ["all-available", "unsupported", "unsupported", "attempted", ["host-write", "terminal-write"]],
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

  it("writes the terminal after all-available host work settles", async () => {
    let markStarted = () => {}
    let release = () => {}
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const service = createServices({
      backend: {
        async writeText() {
          markStarted()
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return { status: "written" }
        },
      },
    })
    const pending = service.clipboard.writeText("text", { destination: "all-available" })
    await started
    expect(service.events).toEqual([])
    release()
    expect(await pending).toEqual({
      host: { status: "written" },
      terminal: { status: "attempted", capability: "supported" },
    })
    expect(service.events).toEqual(["terminal-write"])
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
    expect(service.events).toEqual([])
    controller.abort()
    expect(await pending).toEqual({
      host: { status: "cancelled" },
      terminal: { status: "attempted", capability: "supported" },
    })
    expect(service.events).toEqual(["terminal-write"])
    await service.clipboard.dispose()
  })

  it("preserves terminal dispatch when all-available host work rejects", async () => {
    const service = createServices({
      backend: {
        async writeText() {
          throw new Error("host failed")
        },
      },
    })

    await expect(service.clipboard.writeText("text", { destination: "all-available" })).rejects.toThrow("host failed")
    expect(service.events).toEqual(["terminal-write"])
    await service.clipboard.dispose()
  })

  it("leaves the newest operation on a selection in the terminal when host writes settle out of order", async () => {
    type Destination = "all-available" | "best-available" | "terminal-only" | "host-only"
    type Selection = "clipboard" | "primary" | undefined
    type Step =
      | readonly ["start", Destination, Selection, string | null, boolean, readonly string[]]
      | readonly ["start-in-terminal", Destination, Selection, string | null]
      | readonly ["settle", number, string, readonly string[], string | undefined]
    const all = "all-available"
    const cases: readonly (readonly [string, readonly Step[]])[] = [
      // c3 cannot start its host write; the older ones time out (c0 rejects) in poll order. A host write that took
      // the selection or rejected sends the newest again; one that did not reuses the dispatch.
      [
        "local",
        [
          ["start", all, undefined, "c0", false, []],
          ["start", all, "primary", "p0", false, []],
          ["start", all, "clipboard", null, false, []],
          ["start", all, "clipboard", "c2", false, []],
          ["start", all, "clipboard", "c3", false, []],
          ["settle", 4, "failed", ["clipboard:c3"], "attempted"],
          ["settle", 2, "timed-out", [], "attempted"],
          ["settle", 1, "timed-out", ["primary:p0"], "attempted"],
          ["settle", 0, "rejected", ["clipboard:c3"], undefined],
          ["settle", 3, "timed-out", [], "attempted"],
        ],
      ],
      // In order, each host write takes the selection, so each settle sends the newest again.
      [
        "local",
        [
          ["start", all, undefined, "c0", false, []],
          ["start", all, "primary", "p0", false, []],
          ["start", all, "clipboard", null, false, []],
          ["start", all, "clipboard", "c3", false, []],
          ["settle", 0, "written", ["clipboard:c3"], "attempted"],
          ["settle", 1, "written", ["primary:p0"], "attempted"],
          ["settle", 2, "cleared", ["clipboard:c3"], "attempted"],
          ["settle", 3, "written", ["clipboard:c3"], "attempted"],
        ],
      ],
      // Without OSC 52 every settle reports what the terminal reports.
      [
        "unsupported",
        [
          ["start", all, "clipboard", "c0", false, []],
          ["start", all, "clipboard", "c1", false, []],
          ["settle", 1, "timed-out", ["clipboard:c1"], "not-attempted"],
          ["settle", 0, "timed-out", ["clipboard:c1"], "not-attempted"],
        ],
      ],
      // No display and a full output buffer: the newest copy reports the dispatch, not a duplicate's local-failure. A
      // copy started between two settles is sent at the next one.
      [
        "full",
        [
          ["start", all, "clipboard", "a", false, []],
          ["start", all, "clipboard", "b", false, []],
          ["settle", 0, "unsupported", ["clipboard:b"], "attempted"],
          ["settle", 1, "unsupported", [], "attempted"],
          ["start", all, "clipboard", "c", false, []],
          ["start", all, "clipboard", "d", false, []],
          ["settle", 2, "unsupported", ["clipboard:d"], "attempted"],
          ["start", all, "clipboard", "e", false, []],
          ["settle", 3, "unsupported", ["clipboard:e"], "attempted"],
          ["settle", 4, "unsupported", [], "attempted"],
        ],
      ],
      // A copy started inside a terminal write joins the burst; the older b then must not win.
      [
        "local",
        [
          ["start", all, "clipboard", "a", false, []],
          ["start", all, "clipboard", "b", false, []],
          ["start-in-terminal", all, "clipboard", "c"],
          ["settle", 0, "timed-out", ["clipboard:b"], "attempted"],
          ["settle", 2, "timed-out", ["clipboard:c"], "attempted"],
          ["settle", 1, "written", ["clipboard:c"], "attempted"],
        ],
      ],
      // SSH: a newer copy or clear that skips the host replaces an older authorized one.
      [
        "remote",
        [
          ["start", all, "clipboard", "a", true, []],
          ["start", all, "clipboard", "b", false, ["clipboard:b"]],
          ["settle", 0, "written", ["clipboard:b"], "attempted"],
        ],
      ],
      [
        "remote",
        [
          ["start", all, "clipboard", "a", true, []],
          ["start", all, "clipboard", null, false, ["clipboard:<clear>"]],
          ["settle", 0, "written", ["clipboard:<clear>"], "attempted"],
        ],
      ],
      // A newer copy with another destination wins too.
      [
        "local",
        [
          ["start", all, "clipboard", "old", false, []],
          ["start", "terminal-only", "clipboard", "new", false, ["clipboard:new"]],
          ["settle", 0, "timed-out", [], "attempted"],
        ],
      ],
      [
        "local",
        [
          ["start", all, "clipboard", "old", false, []],
          ["start", "best-available", "clipboard", "new", false, []],
          ["settle", 1, "unsupported", ["clipboard:new"], "attempted"],
          ["settle", 0, "timed-out", [], "attempted"],
        ],
      ],
      [
        "local",
        [
          ["start", all, "clipboard", "old", false, []],
          ["start", "host-only", "clipboard", "new", false, []],
          ["settle", 1, "written", [], "not-attempted"],
          ["settle", 0, "timed-out", [], "not-attempted"],
        ],
      ],
    ]
    for (const [mode, steps] of cases) {
      const capability = mode === "unsupported" ? "unsupported" : "supported"
      const hostCalls = new Map<number, string>()
      const settle = new Map<number, (status: string) => void>()
      let terminalCalls: string[] = []
      let startInTerminal: (() => void) | undefined
      let lastTerminalCall: string | undefined
      let current = 0
      const hostWrite = (text: string, selection: string): Promise<any> => {
        const index = current
        hostCalls.set(index, `${selection}:${text}`)
        return new Promise((resolve, reject) => {
          settle.set(index, (status) => {
            if (status === "rejected") reject(new Error("host failed"))
            else resolve(status === "failed" ? { status, error: new Error("busy") } : { status })
          })
        })
      }
      const terminalWrite = (entry: string): ReturnType<TerminalClipboardAdapter["writeText"]> => {
        const duplicate = mode === "full" && lastTerminalCall === entry
        lastTerminalCall = entry
        terminalCalls.push(entry)
        const start = startInTerminal
        startInTerminal = undefined
        start?.()
        if (capability === "unsupported") return { status: "not-attempted", capability }
        return { status: duplicate ? "local-failure" : "attempted", capability }
      }
      const service = createServices({
        remote: mode === "remote",
        backend: {
          writeText: (text, options) => hostWrite(text, options.selection),
          clear: (options) => hostWrite("<clear>", options.selection),
        },
        terminal: {
          writeText: (text, selection) => terminalWrite(`${selection}:${text}`),
          clear: (selection) => terminalWrite(`${selection}:<clear>`),
        },
      })
      const ops: (readonly [Selection, string | null, Promise<any>])[] = []
      const start = (destination: Destination, selection: Selection, text: string | null, allowRemoteHost = false) => {
        current = ops.length
        const options = { destination, selection, allowRemoteHost }
        const pending = text === null ? service.clipboard.clear(options) : service.clipboard.writeText(text, options)
        ops.push([selection, text, pending.catch((error: Error) => error.message)])
      }
      for (const step of steps) {
        terminalCalls = []
        if (step[0] === "start-in-terminal") {
          const [, destination, selection, text] = step
          startInTerminal = () => start(destination, selection, text)
          continue
        }
        if (step[0] === "start") {
          const [, destination, selection, text, allowRemoteHost, terminal] = step
          start(destination, selection, text, allowRemoteHost)
          expect(terminalCalls).toEqual([...terminal])
          continue
        }
        const [, index, status, terminal, terminalStatus] = step
        const [selection, text] = ops[index]!
        expect(hostCalls.get(index)).toBe(`${selection ?? "clipboard"}:${text ?? "<clear>"}`)
        settle.get(index)!(status)
        const result = await ops[index]![2]
        expect(terminalCalls).toEqual([...terminal])
        const expected = terminalStatus === "not-attempted" && capability === "supported" ? "unknown" : capability
        expect(typeof result === "string" ? result : [result.host.status, result.terminal]).toEqual(
          terminalStatus ? [status, { status: terminalStatus, capability: expected }] : "host failed",
        )
      }
      expect(hostCalls.size).toBe(steps.filter((step) => step[0] === "settle").length)
      await service.clipboard.dispose()
    }
  })

  it("keeps the newest copy or clear on a shared local selection in every two-writer settle order", async () => {
    // Host and terminal take ownership of the same selection. Observe its value, not just the dispatch log.
    for (const selection of ["clipboard", "primary"] as const) {
      for (const success of [0, 1, 2, 3]) {
        for (const schedule of ["0011", "0101", "0110", "1001", "1010", "1100"]) {
          const cells = { clipboard: "initial", primary: "initial" }
          const expected = { ...cells }
          const release: Array<() => void> = []
          const pending: Array<Promise<unknown>> = []
          const host = async (id: number, key: ClipboardSelection, value: string) => {
            await new Promise<void>((resolve) => {
              release[id] = resolve
            })
            if (!(success & (1 << id))) return false
            cells[key] = value
            return true
          }
          const terminal = (key: ClipboardSelection, value: string) => {
            cells[key] = value
            return { status: "attempted", capability: "supported" } as const
          }
          const { clipboard } = createServices({
            backend: {
              writeText: async (text, o) => ({
                status: (await host(0, o.selection, text)) ? "written" : "timed-out",
              }),
              clear: async (o) => ({
                status: (await host(1, o.selection, "")) ? "cleared" : "timed-out",
              }),
            },
            terminal: {
              writeText: (text, key) => terminal(key, text),
              clear: (key) => terminal(key, ""),
            },
          })
          for (const token of schedule) {
            const id = Number(token)
            if (release[id]) {
              release[id]!()
              await pending[id]
            } else if (id === 0) {
              expected.clipboard = "A"
              pending[id] = clipboard.writeText("A", { destination: "all-available" })
            } else {
              expected[selection] = ""
              pending[id] = clipboard.clear({ destination: "all-available", selection })
            }
          }
          await clipboard.dispose()
          expect({ schedule, success, cells }).toEqual({ schedule, success, cells: expected })
        }
      }
    }
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
