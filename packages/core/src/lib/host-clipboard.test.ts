import { describe, expect, it } from "bun:test"
import {
  type ClipboardReadResult,
  type HostClipboardBackend,
  type HostClipboardOptions,
  type HostClipboardReadOptions,
  type HostClipboardWriteOptions,
} from "./clipboard.js"
import { createHostClipboardWithBackend, type NormalizedHostClipboardOptions } from "./host-clipboard.internal.js"

const createBackend = (overrides: Partial<HostClipboardBackend> = {}) => {
  const reads: HostClipboardReadOptions[] = []
  const writes: Array<{ text: string; options: HostClipboardWriteOptions }> = []
  const clears: HostClipboardWriteOptions[] = []
  let disposeCount = 0
  const backend: HostClipboardBackend = {
    async read(options) {
      reads.push(options)
      return { status: "empty" }
    },
    async writeText(text, options) {
      writes.push({ text, options })
      return { status: "written" }
    },
    async clear(options) {
      clears.push(options)
      return { status: "cleared" }
    },
    async dispose() {
      disposeCount++
    },
    ...overrides,
  }
  return {
    backend,
    reads,
    writes,
    clears,
    get disposeCount() {
      return disposeCount
    },
  }
}

const createHost = (backend: HostClipboardBackend, options: HostClipboardOptions = {}) =>
  createHostClipboardWithBackend(options, () => backend)

describe("createHostClipboard", () => {
  it("validates configuration before dispatch", () => {
    const { backend } = createBackend()
    const invalidU32 = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 0x1_0000_0000]
    for (const value of invalidU32) expect(() => createHost(backend, { timeoutMs: value })).toThrow(RangeError)
    for (const name of [
      "maxReadBytes",
      "maxWriteBytes",
      "maxImagePixels",
      "maxConversionBytes",
      "maxConcurrentOperations",
      "maxProviderTransfers",
    ] as const) {
      expect(() => createHost(backend, { [name]: -1 })).toThrow(RangeError)
    }
    for (const name of ["maxConcurrentOperations", "maxProviderTransfers"] as const) {
      expect(() => createHost(backend, { [name]: 0 })).toThrow(RangeError)
    }
    for (const waylandSeat of ["", "seat\0name"]) {
      expect(() => createHost(backend, { waylandSeat })).toThrow(TypeError)
    }
  })

  it("does not dispatch backend work when the operation timeout is zero", async () => {
    const fake = createBackend()
    const host = createHost(fake.backend, { timeoutMs: 0 })

    const results = await Promise.all([
      host.read({ preferredTypes: ["text/plain"] }),
      host.writeText("text"),
      host.clear(),
    ])
    expect(results.map(({ status }) => status)).toEqual(["timed-out", "timed-out", "timed-out"])
    expect([fake.reads.length, fake.writes.length, fake.clears.length]).toEqual([0, 0, 0])
    await host.dispose()
  })

  it("normalizes defaults, selections, MIME types, signals, and timeout values", async () => {
    const fake = createBackend()
    const host = createHost(fake.backend)

    await host.read({ preferredTypes: ["Image/PNG", "Text/Plain"] })
    await host.writeText("hello")
    await host.clear({ selection: "primary" })

    expect(fake.reads[0]?.preferredTypes).toEqual(["image/png", "text/plain"])
    expect(fake.reads[0]?.selection).toBe("clipboard")
    expect(fake.reads[0]?.maxBytes).toBe(8 * 1024 * 1024)
    expect(fake.reads[0]?.timeoutMs).toBeLessThanOrEqual(1_000)
    expect(fake.reads[0]?.timeoutMs).toBeGreaterThanOrEqual(0)
    expect(fake.reads[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(fake.writes[0]?.options.selection).toBe("clipboard")
    expect(fake.writes[0]?.options.timeoutMs).toBeLessThanOrEqual(1_000)
    expect(fake.clears[0]?.selection).toBe("primary")
    await host.dispose()
  })

  it("passes every normalized construction option to the internal backend factory", async () => {
    const fake = createBackend()
    let received: NormalizedHostClipboardOptions | undefined
    const options = {
      timeoutMs: 9,
      maxReadBytes: 10,
      maxWriteBytes: 11,
      maxImagePixels: 12,
      maxConversionBytes: 13,
      maxConcurrentOperations: 14,
      maxProviderTransfers: 15,
      waylandSeat: "seat0",
    }
    const host = createHostClipboardWithBackend(options, (normalized) => {
      received = normalized
      return fake.backend
    })

    expect(received).toEqual(options)
    await host.dispose()
  })

  it("validates and normalizes MIME preferences at native protocol boundaries", async () => {
    const fake = createBackend()
    const host = createHost(fake.backend)

    const invalidPreferences = [
      [[], TypeError],
      [["text/plain; charset=utf-8"], TypeError],
      [["text"], TypeError],
      [Array.from({ length: 65 }, (_, index) => `application/x-${index}`), RangeError],
      [[`application/${"a".repeat(244)}`], RangeError],
    ] as const
    for (const [preferredTypes, error] of invalidPreferences) {
      await expect(host.read({ preferredTypes: preferredTypes as unknown as [string, ...string[]] })).rejects.toThrow(
        error,
      )
    }
    expect(fake.reads).toHaveLength(0)
    const preferredTypes = Array.from({ length: 64 }, (_, index) => `Application/X-${index}`) as [string, ...string[]]
    preferredTypes[63] = `Application/${"A".repeat(243)}`

    await host.read({ preferredTypes })
    const normalizedTypes = preferredTypes.map((mimeType) => mimeType.toLowerCase()) as [string, ...string[]]
    expect(fake.reads).toHaveLength(1)
    expect(fake.reads[0]?.preferredTypes).toEqual(normalizedTypes)
    await host.read({ preferredTypes: ["Application/Foo*Bar"] })
    expect(fake.reads[1]?.preferredTypes).toEqual(["application/foo*bar"])
    await host.dispose()
  })

  it("validates UTF-8 text and the write limit before dispatch", async () => {
    const fake = createBackend()
    const host = createHost(fake.backend, { maxWriteBytes: 4 })

    for (const [text, error] of [
      ["", "non-empty"],
      ["a\0b", "NUL"],
      ["\ud800", "unpaired UTF-16 surrogate"],
      ["\udc00", "unpaired UTF-16 surrogate"],
      ["hello", RangeError],
      ["世界", RangeError],
      ["ééé", RangeError],
    ] as const) {
      await expect(host.writeText(text)).rejects.toThrow(error)
    }
    expect(fake.writes).toHaveLength(0)
    await host.writeText("four")
    await host.writeText("éé")
    await host.writeText("😀")
    expect(fake.writes).toHaveLength(3)
    await host.dispose()
  })

  it("does not dispatch a pre-aborted operation and composes later caller cancellation", async () => {
    let observedSignal: AbortSignal | undefined
    const fake = createBackend({
      async read(options) {
        observedSignal = options.signal
        return await new Promise<ClipboardReadResult>((resolve) => {
          options.signal.addEventListener("abort", () => resolve({ status: "cancelled" }), { once: true })
        })
      },
    })
    const host = createHost(fake.backend)
    const preAborted = AbortSignal.abort()

    expect(await host.read({ preferredTypes: ["text/plain"], signal: preAborted })).toEqual({ status: "cancelled" })
    expect(observedSignal).toBeUndefined()

    const controller = new AbortController()
    const pending = host.read({ preferredTypes: ["text/plain"], signal: controller.signal })
    controller.abort()
    expect(await pending).toEqual({ status: "cancelled" })
    await host.dispose()
  })

  it("aborts active operations, waits for cleanup, disposes once, and rejects later calls", async () => {
    let releaseCleanup: (() => void) | undefined
    let backendStarted = false
    const fake = createBackend({
      async read(options) {
        backendStarted = true
        await new Promise<void>((resolve) => {
          options.signal.addEventListener(
            "abort",
            () => {
              releaseCleanup = resolve
            },
            { once: true },
          )
        })
        return { status: "cancelled" }
      },
    })
    const host = createHost(fake.backend)
    const read = host.read({ preferredTypes: ["text/plain"] })
    expect(backendStarted).toBe(true)

    const firstDispose = host.dispose()
    const secondDispose = host.dispose()
    expect(firstDispose).toBe(secondDispose)
    await Promise.resolve()
    expect(fake.disposeCount).toBe(0)
    releaseCleanup?.()
    expect(await read).toEqual({ status: "cancelled" })
    await firstDispose
    expect(fake.disposeCount).toBe(1)
    await expect(host.read({ preferredTypes: ["text/plain"] })).rejects.toThrow("disposed")
    await expect(host.writeText("text")).rejects.toThrow("disposed")
    await expect(host.clear()).rejects.toThrow("disposed")
  })
})
