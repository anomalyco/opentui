import { spyOn, test } from "bun:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { NativeSession } from "../NativeSession.js"
import { createTestRenderer } from "../testing/test-renderer.js"
import { createTestStdin, TestWriteStream } from "../testing/test-streams.js"
import { setRendererCapabilities } from "../testing/terminal-capabilities.js"
import { CliRenderEvents, type CliRenderer } from "../renderer.js"
import { ManualClock } from "../testing/manual-clock.js"
import type { TerminalColors } from "../lib/terminal-palette.js"

async function setup(respond = true, clock?: ManualClock) {
  const stdin = createTestStdin()
  stdin.isTTY = true
  const writes: string[] = []
  const terminal = { respond, color: "#123456" }
  const stdout = new TestWriteStream(20, 5)
  stdout._write = (bytes, _encoding, callback) => {
    const text = bytes.toString()
    writes.push(text)
    for (const query of text.matchAll(/\x1b\](4;\d+|1[0-7]|19);\?\x07/g)) {
      if (terminal.respond) {
        queueMicrotask(() => stdin.emit("data", Buffer.from(`\x1b]${query[1]};${terminal.color}\x07`)))
      }
    }
    callback()
  }
  const driver = new NativeSession(stdout, {
    output: { chunkSize: 4096, spanCapacity: 8, maxBytes: 32768n, controlCapacity: 4096 },
  })
  const result = await createTestRenderer({
    stdin,
    stdout: stdout as NodeJS.WriteStream,
    bufferedOutput: "stdout",

    remote: true,
    forwardEnvKeys: [],
    useMouse: false,
    nativeSession: driver,
    clock,
  })
  await result.renderer.setupTerminal()
  await driver.idle()
  writes.length = 0
  return { ...result, driver, writes, terminal }
}

function replyPalette(renderer: CliRenderer, size: number, color = "#123456"): void {
  const indices = Array.from({ length: size }, (_, index) => `4;${index}`)
  const special = [10, 11, 12, 13, 14, 15, 16, 17, 19]
  renderer.stdin.emit(
    "data",
    Buffer.from([...indices, ...special].map((index) => `\x1b]${index};${color}\x07`).join("")),
  )
}

test("native palette publication rejects without caching or advancing the accepted epoch", async () => {
  const { renderer, driver } = await setup()
  const lib = driver.renderLib
  const publish = lib.sessionSetPaletteState.bind(lib)
  let reject = true
  const epochs: number[] = []
  const binding = spyOn(lib, "sessionSetPaletteState").mockImplementation((...args) => {
    epochs.push(args[5])
    if (reject) throw new Error("rejected palette publication")
    return publish(...args)
  })
  const changes: unknown[] = []
  renderer.on(CliRenderEvents.PALETTE, (colors) => changes.push(colors))
  setRendererCapabilities(renderer, { rgb: false, ansi256: true, multiplexer: "none" })
  try {
    await assert.rejects(renderer.getPalette({ size: 256 }), /rejected palette publication/)
    assert.equal(renderer.paletteDetectionStatus, "idle")
    assert.equal(changes.length, 0)
    reject = false
    const colors = await renderer.getPalette({ size: 256 })
    assert.equal(colors.palette.length, 256)
    assert.deepEqual(epochs, [1, 1])
    assert.equal(renderer.paletteDetectionStatus, "cached")
    assert.equal(changes.length, 1)
  } finally {
    binding.mockRestore()
    renderer.destroy()
    await driver.closed
  }
})

test("native palette admission failure releases detector subscriptions and can retry", async () => {
  const { renderer, driver } = await setup()
  const subscribers = (renderer as unknown as { oscSubscribers: Set<unknown> }).oscSubscribers
  const baseline = subscribers.size
  try {
    assert.equal(driver.write(Buffer.alloc(7 * 4096)), true)
    await assert.rejects(renderer.getPalette({ size: 16 }))
    assert.equal(renderer.paletteDetectionStatus, "idle")
    assert.equal(subscribers.size, baseline)
    await driver.idle()
    assert.equal((await renderer.getPalette()).palette[0], "#123456")
    for (const size of [0, -1, 257, 1.5, NaN, Infinity]) {
      await assert.rejects(renderer.getPalette({ size }), RangeError)
    }
  } finally {
    renderer.destroy()
    await driver.closed
  }
})

test("native palette capability wait is cancelled before suspended terminal input disappears", async () => {
  const { renderer, driver } = await setup(false)
  try {
    setRendererCapabilities(renderer, {
      multiplexer: "tmux",
      terminal: { name: "", version: "", from_xtversion: false },
    })
    const pending = assert.rejects(renderer.getPalette(), /cancelled/)
    await renderer.suspend()
    await pending
    assert.equal(renderer.paletteDetectionStatus, "idle")
  } finally {
    renderer.destroy()
    await driver.closed
  }
})

test("native palette suspension settles all concurrently requested larger sizes", async () => {
  const clock = new ManualClock()
  const { renderer, driver, writes, terminal } = await setup(true, clock)
  terminal.respond = false
  const first = renderer.getPalette({ size: 16, timeout: 50 })
  void first.catch(() => {})
  const larger = Promise.allSettled([32, 64].map((size) => renderer.getPalette({ size, timeout: 50 })))
  try {
    await driver.idle()
    replyPalette(renderer, 1)
    await driver.idle()
    replyPalette(renderer, 16)
    assert.equal((await first).palette.length, 16)
    await driver.idle()
    replyPalette(renderer, 1)
    await driver.idle()
    assert.ok(writes.join("").includes("\x1b]4;31;?\x07"), "a larger request must be awaiting palette replies")

    await renderer.suspend()
    clock.advance(10_000)
    assert.deepEqual(
      (await larger).map((result) => result.status),
      ["rejected", "rejected"],
    )
  } finally {
    renderer.destroy()
    await driver.closed
    clock.advance(10_000)
  }
})

test("native palette observer errors do not strand a reentrant larger request", async () => {
  const clock = new ManualClock()
  const { renderer, driver, terminal } = await setup(true, clock)
  const observerError = new Error("palette observer failed")
  let published: TerminalColors | undefined
  let larger: Promise<TerminalColors> | undefined
  renderer.once(CliRenderEvents.PALETTE, (colors: TerminalColors) => {
    published = colors
    terminal.respond = false
    larger = renderer.getPalette({ size: 32, timeout: 50 })
    void larger.catch(() => {})
    throw observerError
  })
  try {
    await assert.rejects(renderer.getPalette({ size: 16, timeout: 50 }), (error) => error === observerError)
    assert.ok(published)
    assert.equal(await renderer.getPalette({ size: 16 }), published, "the observer saw an accepted palette")
    assert.ok(larger)
    await driver.idle()
    replyPalette(renderer, 1)
    await driver.idle()
    replyPalette(renderer, 32)
    clock.advance(1000)
    const colors = await larger
    assert.deepEqual(colors.palette, Array(32).fill("#123456"))
  } finally {
    renderer.destroy()
    await driver.closed
    clock.advance(10_000)
  }
})

test("native palette theme refresh does not reuse a detection from an older theme", async () => {
  const clock = new ManualClock()
  const { renderer, driver, terminal, writes } = await setup(true, clock)
  const lib = driver.renderLib
  const publish = lib.sessionSetPaletteState.bind(lib)
  const accepted: Array<{ epoch: number; first: number[] }> = []
  const binding = spyOn(lib, "sessionSetPaletteState").mockImplementation((...args) => {
    publish(...args)
    accepted.push({ epoch: args[5], first: args[2][0].toInts() })
  })
  const refreshed = Promise.withResolvers<TerminalColors>()
  const paletteChanged = (colors: TerminalColors) => {
    if (colors.palette[0] === "#eeeeee") refreshed.resolve(colors)
  }
  renderer.on(CliRenderEvents.PALETTE, paletteChanged)
  setRendererCapabilities(renderer, { rgb: false, ansi256: true, multiplexer: "none" })
  try {
    await renderer.getPalette({ size: 16 })
    renderer.clearPaletteCache()
    terminal.respond = false
    const older = renderer.getPalette({ size: 32, timeout: 50 })
    void older.catch(() => {})
    await driver.idle()
    replyPalette(renderer, 1)
    await driver.idle()
    assert.ok(writes.join("").includes("\x1b]4;31;?\x07"), "the old-theme detection must await palette replies")

    renderer.stdin.emit("data", Buffer.from("\x1b[?997;1n"))
    await driver.idle()
    renderer.stdin.emit("data", Buffer.from("\x1b]10;#eeeeee\x07\x1b]11;#eeeeee\x07"))
    assert.equal(renderer.themeMode, "light")
    terminal.color = "#eeeeee"
    terminal.respond = true
    replyPalette(renderer, 32)
    assert.equal((await older).palette[0], "#123456")

    const colors = await refreshed.promise
    assert.deepEqual(accepted, [
      { epoch: 1, first: [18, 52, 86, 255] },
      { epoch: 2, first: [238, 238, 238, 255] },
    ])
    assert.equal(await renderer.getPalette({ size: 16 }), colors)
  } finally {
    renderer.off(CliRenderEvents.PALETTE, paletteChanged)
    binding.mockRestore()
    renderer.destroy()
    await driver.closed
    clock.advance(10_000)
  }
})

test("native palette resume restarts an interrupted automatic refresh without a new theme mode", async () => {
  const clock = new ManualClock()
  const { renderer, driver, terminal, writes } = await setup(true, clock)
  const lib = driver.renderLib
  const publish = lib.sessionSetPaletteState.bind(lib)
  const accepted: number[] = []
  const binding = spyOn(lib, "sessionSetPaletteState").mockImplementation((...args) => {
    publish(...args)
    accepted.push(args[5])
  })
  const refreshed = Promise.withResolvers<TerminalColors>()
  const paletteChanged = (colors: TerminalColors) => {
    if (colors.palette[0] === "#eeeeee") refreshed.resolve(colors)
  }
  renderer.on(CliRenderEvents.PALETTE, paletteChanged)
  setRendererCapabilities(renderer, { rgb: false, ansi256: true, multiplexer: "none" })
  try {
    await renderer.getPalette({ size: 16 })
    terminal.respond = false
    terminal.color = "#eeeeee"
    writes.length = 0
    renderer.stdin.emit("data", Buffer.from("\x1b[?997;1n"))
    await driver.idle()
    renderer.stdin.emit("data", Buffer.from("\x1b]10;#eeeeee\x07\x1b]11;#eeeeee\x07"))
    await driver.idle()
    replyPalette(renderer, 1, "#eeeeee")
    await driver.idle()
    assert.ok(writes.join("").includes("\x1b]4;15;?\x07"), "automatic refresh must await palette replies")
    assert.equal(renderer.themeMode, "light")
    const cancelled = assert.rejects(renderer.getPalette({ size: 16 }), /suspended/)
    await renderer.suspend()
    await cancelled

    terminal.respond = true
    await renderer.resume()
    await driver.idle()
    renderer.stdin.emit("data", Buffer.from("\x1b[?997;1n"))
    await driver.idle()
    assert.equal(renderer.themeMode, "light")
    const colors = await refreshed.promise
    assert.deepEqual(accepted, [1, 2])
    assert.equal(await renderer.getPalette({ size: 16 }), colors)
  } finally {
    renderer.off(CliRenderEvents.PALETTE, paletteChanged)
    binding.mockRestore()
    renderer.destroy()
    await driver.closed
    clock.advance(10_000)
  }
})

test("native resume interrupted by same-turn destruction is safe to ignore and still rejects awaiters", () => {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  const fixture = new URL(`../testing/test-renderer.${extension}`, import.meta.url).href
  const runtimeArgs = process.versions.bun ? [] : process.execArgv.filter((arg) => !arg.startsWith("--test"))
  const child = spawnSync(
    process.execPath,
    [
      ...runtimeArgs,
      ...(process.versions.bun ? [] : ["--input-type=module"]),
      "--eval",
      `
        import { createTestRenderer } from ${JSON.stringify(fixture)}
        import { setImmediate } from "node:timers/promises"
        const unhandled = []
        const observed = []
        process.on("unhandledRejection", error => unhandled.push(error.message))
        for (const awaitResume of [false, true]) {
          const { renderer } = await createTestRenderer({
            remote: true, forwardEnvKeys: [], useMouse: false,
          })
          try {
            await renderer.setupTerminal()
            await renderer.suspend()
            const resumed = renderer.resume()
            const observation = awaitResume ? resumed.catch(error => observed.push(error.message)) : null
            renderer.destroy()
            await renderer.closed
            if (observation) await observation
            await setImmediate()
            await setImmediate()
          } finally {
            renderer.destroy()
            await renderer.closed
          }
        }
        process.stdout.write(JSON.stringify({ unhandled, observed }))
      `,
    ],
    { encoding: "utf8", timeout: 10_000 },
  )
  assert.equal(child.status, 0, child.stderr || child.error?.message)
  assert.deepEqual(JSON.parse(child.stdout), {
    unhandled: [],
    observed: ["NativeSession terminal transition interrupted by close"],
  })
})
