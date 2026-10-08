import { afterEach, expect, spyOn, test } from "bun:test"
import { OptimizedBuffer } from "../buffer.js"
import { NativeSession } from "../NativeSession.js"
import { CliRenderEvents } from "../renderer.js"
import { Renderable, RenderableEvents } from "../Renderable.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CodeRenderable } from "../renderables/Code.js"
import { EmbeddedTerminalRenderable } from "../renderables/EmbeddedTerminal.js"
import { TextRenderable } from "../renderables/Text.js"
import { SyntaxStyle } from "../syntax-style.js"
import {
  createTestRenderer,
  ManualClock,
  MockTreeSitterClient,
  type TestRenderer,
  type TestRendererOptions,
} from "../testing.js"
import { settle } from "../testing/harness.js"
import { createTestStdout, RecordingWriteStream } from "../testing/test-streams.js"

const renderers: TestRenderer[] = []
afterEach(async () => {
  for (const renderer of renderers.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup(options: TestRendererOptions = {}) {
  const result = await createTestRenderer({
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
    width: 24,
    height: 10,
    footerHeight: 3,
    consoleMode: "disabled",
    ...options,
  })
  renderers.push(result.renderer)
  return result
}

/** A set-up split-footer terminal whose native output reaches `stdout`, so tests can read the scrollback bytes. */
async function setupTerminal(options: { columns?: number; maxBytes?: bigint } = {}) {
  const columns = options.columns ?? 40
  const stdout = new RecordingWriteStream(columns, 10) as RecordingWriteStream & NodeJS.WriteStream
  const nativeSession =
    options.maxBytes === undefined
      ? undefined
      : new NativeSession(stdout, {
          output: { chunkSize: 4096, spanCapacity: 128, maxBytes: options.maxBytes, controlCapacity: 4096 },
        })
  const clock = new ManualClock()
  const result = await setup({
    width: columns,
    stdout,
    nativeSession,
    bufferedOutput: "stdout",
    remote: true,
    clock,
  })
  const driver = result.renderer.nativeScene.driver
  await result.renderer.setupTerminal()
  await driver.idle()
  result.renderer.stdin.emit("data", Buffer.from("\x1b[1;1R"))
  await driver.idle()
  stdout.clear()
  const frame = async () => {
    await result.renderOnce()
    await driver.idle()
  }
  /** Renders frames until `text` reaches the terminal; the queue drains a bounded number of commits per frame. */
  const drainUntil = async (text: string) => {
    for (let attempt = 0; attempt < 100 && !stdout.text().includes(text); attempt++) await frame()
    expect(stdout.text()).toContain(text)
  }
  /** The terminal text that matches `pattern`, in output order. */
  const printed = (pattern: RegExp) => Array.from(stdout.text().match(pattern) ?? [])
  return { ...result, stdout, clock, frame, drainUntil, printed }
}

const decoder = new TextDecoder()
const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`)

type Terminal = Awaited<ReturnType<typeof setupTerminal>>
const writeRow = ({ renderer }: Terminal, row: string) =>
  renderer.writeToScrollback(({ renderContext }) => ({
    root: new TextRenderable(renderContext, { content: row, width: row.length, height: 1 }),
  }))

test.each([
  ["one stdout write", (terminal: Terminal, rows: string[]) => terminal.stdout.write(rows.join("\n") + "\n")],
  ["stdout writes", (terminal: Terminal, rows: string[]) => rows.forEach((row) => terminal.stdout.write(row + "\n"))],
  ["writeToScrollback calls", (terminal: Terminal, rows: string[]) => rows.forEach((row) => writeRow(terminal, row))],
] as const)("%s of 300 rows reach scrollback once and in order", async (_name, write) => {
  const terminal = await setupTerminal()
  const rows = lines(300)
  write(terminal, rows)
  expect(terminal.externalOutput.take().map(({ text }) => text)).toEqual(rows)
  await terminal.drainUntil("line 299")
  expect(terminal.printed(/line \d+/g)).toEqual(rows)
})

// About 460 KiB of 78-cell rows: more than the default Session output capacity (8 MiB / 24 bytes = 349,525 cells).
const jsonRows = Array.from({ length: 6_000 }, (_, row) => `{"row":${row},"data":"`.padEnd(76, "x") + '"},')

test.each([
  ["one 460 KiB write", (terminal: Terminal) => terminal.stdout.write(jsonRows.join("\n") + "\n")],
  [
    "64 KiB writes with a frame after each",
    async (terminal: Terminal) => {
      for (let row = 0; row < jsonRows.length; row += 800) {
        terminal.stdout.write(jsonRows.slice(row, row + 800).join("\n") + "\n")
        await terminal.frame()
      }
    },
  ],
] as const)("captured stdout of %s is queued whole and reaches the terminal in order", async (_name, write) => {
  const terminal = await setupTerminal({ columns: 80 })
  await write(terminal)
  expect(terminal.externalOutput.take()).toHaveLength(jsonRows.length)
  terminal.renderer.destroy()
  await terminal.renderer.closed
  expect(terminal.printed(/"row":\d+/g)).toEqual(jsonRows.map((_, row) => `"row":${row}`))
})

const wide = (prefix: string, count: number) => lines(count).map((row) => `${prefix} ${row}`.padEnd(40, "."))
const writeBlock = ({ renderer }: Terminal, rows: string[]) =>
  renderer.writeToScrollback(({ renderContext }) => ({
    root: new TextRenderable(renderContext, { content: rows.join("\n"), width: 40, height: rows.length }),
  }))

test.each(["frames", "destroy"] as const)(
  "commits that exceed the Session output capacity together drain in separate batches through %s",
  async (drain) => {
    // 1,024 cells per native split render: 24 bytes per snapshot cell.
    const terminal = await setupTerminal({ maxBytes: 24_576n })
    writeBlock(terminal, wide("a", 15))
    writeBlock(terminal, wide("b", 15))
    terminal.stdout.write(wide("c", 40).join("\n") + "\n")
    const rows = [...wide("a", 15), ...wide("b", 15), ...wide("c", 40)].map((row) => row.replace(/\.+$/, ""))
    if (drain === "frames") {
      await terminal.frame()
      expect(terminal.printed(/[abc] line \d+/g)).toEqual(rows.slice(0, 15))
      await terminal.drainUntil("c line 39")
    } else {
      terminal.renderer.destroy()
      await terminal.renderer.closed
    }
    expect(terminal.printed(/[abc] line \d+/g)).toEqual(rows)
  },
)

test("a snapshot larger than the Session output capacity throws at the call and queues nothing", async () => {
  const terminal = await setupTerminal({ maxBytes: 24_576n })
  expect(() => writeBlock(terminal, wide("a", 30))).toThrow("Scrollback snapshot exceeds the Session output capacity")
  expect(terminal.externalOutput.take()).toEqual([])
  writeBlock(terminal, wide("b", 1))
  await terminal.drainUntil("b line 0")
})

// Each drain ends with `last` on the terminal. A transition that changes the split footer waits for queued rows.
const drains = {
  frames: async (terminal: Terminal, last: string) => {
    await terminal.frame()
    // One frame carries at most 8 commits.
    expect(terminal.printed(/line \d+/g)).toHaveLength(8)
    await terminal.drainUntil(last)
  },
  passthrough: async (terminal: Terminal, last: string) => {
    terminal.renderer.externalOutputMode = "passthrough"
    // The switch waits for the queue, so this write is still captured behind it.
    terminal.stdout.write("still captured\n")
    await terminal.drainUntil("still captured")
    expect(terminal.renderer.externalOutputMode).toBe("passthrough")
    expect(terminal.stdout.text().indexOf("still captured")).toBeGreaterThan(terminal.stdout.text().indexOf(last))
  },
  resize: async (terminal: Terminal, last: string) => {
    let printedAtResize = ""
    terminal.renderer.once("resize", () => (printedAtResize = terminal.stdout.text()))
    terminal.renderer.resize(60, 12)
    await terminal.drainUntil(last)
    expect(printedAtResize).toContain(last)
    expect([terminal.renderer.width, terminal.renderer.height]).toEqual([60, 3])
  },
  suspend: async (terminal: Terminal, last: string) => {
    await terminal.renderer.suspend()
    expect(terminal.stdout.text().lastIndexOf("\x1b[?25h")).toBeGreaterThan(terminal.stdout.text().indexOf(last))
  },
  destroy: async (terminal: Terminal, last: string) => {
    terminal.renderer.destroy()
    await terminal.renderer.closed
    for (const restore of ["\x1b[?25h", "\x1b[J"]) {
      expect(terminal.stdout.text().lastIndexOf(restore)).toBeGreaterThan(terminal.stdout.text().indexOf(last))
    }
  },
  "alternate-screen": async (terminal: Terminal, last: string) => {
    terminal.renderer.externalOutputMode = "passthrough"
    terminal.renderer.screenMode = "alternate-screen"
    await terminal.drainUntil("\x1b[?1049h")
    expect(terminal.stdout.text().indexOf("\x1b[?1049h")).toBeGreaterThan(terminal.stdout.text().indexOf(last))
  },
}

// More rows than one frame or one flush batch carries (8).
test.each(
  (["stdout", "writer"] as const).flatMap((source) =>
    Object.keys(drains).map((drain) => [source, drain as keyof typeof drains] as const),
  ),
)("queued %s rows reach the terminal once and in order before %s", async (source, drain) => {
  const terminal = await setupTerminal()
  const rows = lines(12)
  if (source === "stdout") terminal.stdout.write(rows.join("\n") + "\n")
  else for (const row of rows) writeRow(terminal, row)
  await drains[drain](terminal, "line 11")
  expect(terminal.printed(/line \d+/g)).toEqual(rows)
})

test("cancelling the last animation frame keeps the render that captured stdout requested", async () => {
  const { renderer, stdout, clock } = await setupTerminal()
  let callbacks = 0
  const handle = renderer.requestAnimationFrame(() => callbacks++)
  stdout.write("captured\n")
  renderer.cancelAnimationFrame(handle)
  clock.advance(100)
  await settle()
  await renderer.idle()
  expect(stdout.text()).toContain("captured")
  expect(callbacks).toBe(0)
  expect(renderer.isRunning).toBe(false)
})

test.each(["frames", "suspend", "destroy"] as const)(
  "a replay reset behind queued rows clears at its boundary when %s drains the queue",
  async (drain) => {
    const terminal = await setupTerminal()
    terminal.stdout.write(lines(10).join("\n") + "\npartial")
    terminal.renderer.resetSplitFooterForReplay({ clearSavedLines: true })
    let tailColumn = -1
    terminal.renderer.writeToScrollback(({ renderContext, tailColumn: tail }) => {
      tailColumn = tail
      return { root: new TextRenderable(renderContext, { content: "after", width: 5, height: 1 }) }
    })
    // Rows queued after the request start a fresh scrollback, not the partial row before it.
    expect(tailColumn).toBe(0)
    await drains[drain](terminal, "after")
    const replay = "\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H"
    expect(terminal.printed(/line \d+|partial|after|\x1b\[r\x1b\[0m\x1b\[H\x1b\[2J\x1b\[3J\x1b\[H/g)).toEqual([
      ...lines(10),
      "partial",
      replay,
      "after",
    ])
    // Scrollback published before the clear no longer counts: the footer follows the one row after it.
    if (drain !== "destroy") expect((terminal.renderer as unknown as { renderOffset: number }).renderOffset).toBe(2)
  },
)

// A wide grapheme that does not fit the row starts the next one; native must count the rows the terminal uses.
// A row that fills the width keeps its last cell (#1580). The footer starts below the empty row after the newline.
test.each([
  ["ASCII", "abcdefghijklmnopqrs", ["abcdefghi", "jklmnopqr", "s"]],
  ["wide characters", "一二三四五六七八九", ["一二三四", "五六七八", "九"]],
  ["a wide character at the last column", "abcdefgh一", ["abcdefgh", "一"]],
  ["full-width ASCII", "012345678", ["012345678"]],
  ["full-width wide characters", "a一二三四", ["a一二三四"]],
] as const)("a captured %s line shows its terminal rows above the split footer", async (_name, line, rows) => {
  const terminal = await setupTerminal({ columns: 9 })
  terminal.renderer.root.add(new TextRenderable(terminal.renderer, { content: "F" }))
  terminal.stdout.write(line + "\n")
  await terminal.frame()
  const view = await createTestRenderer({ width: 9, height: 10 })
  renderers.push(view.renderer)
  const vt = new EmbeddedTerminalRenderable(view.renderer, { cols: 9, rows: 10 })
  view.renderer.root.add(vt)
  vt.write(terminal.stdout.bytes())
  await view.renderOnce()
  expect(vt.screen().lines).toEqual([...rows, "", "F"])
})

// Each commit is "text:rowColumns", plus "\n" when it ends its line.
test.each([
  ["wraps ASCII at the width", "abcdefghijk\n", ["abcdefghi:9", "jk:2\n"]],
  ["wraps wide characters by display cells", "一二三四五\n", ["一二三四:9", "五:2\n"]],
  ["keeps emoji and grapheme clusters", "ok👍🏽 👩‍🚀 e\u0301\n", ["ok👍🏽 👩‍🚀 e\u0301:9\n"]],
  ["expands tabs to 8-cell stops within the row", "a\tb\tc\n", ["a       b:9", "c:1\n"]],
  ["ends a line at CRLF", "one\r\ntwo\r\n", ["one:3\n", "two:3\n"]],
  ["restarts a wrapped line at CR", "0123456789%\r60%\n\n", ["60%:3\n", ":0\n"]],
])("captured stdout %s", async (_name, text, commits) => {
  const stdout = createTestStdout(9, 10)
  const { renderer } = await setup({ width: 9, stdout })
  const written: string[] = []
  renderer.on(CliRenderEvents.EXTERNAL_OUTPUT, ({ snapshot, rowColumns, trailingNewline }) => {
    expect(snapshot.width).toBe(Math.max(1, rowColumns))
    const row = decoder.decode(snapshot.getRealCharBytes(true)).trimEnd()
    written.push(`${row}:${rowColumns}${trailingNewline ? "\n" : ""}`)
  })
  stdout.write(text)
  expect(written).toEqual(commits)
})

test("the predicted tail column counts every cell of a trailing wide character", async () => {
  const stdout = createTestStdout(24, 10)
  const { renderer } = await setup({ stdout })
  stdout.write("ab二")
  let tailColumn = -1
  renderer.writeToScrollback(({ renderContext, tailColumn: tail }) => {
    tailColumn = tail
    return { root: new TextRenderable(renderContext, { content: "x", width: 1, height: 1 }) }
  })
  expect(tailColumn).toBe(4)
})

test("captured stdout that fails mid-write queues and leaks none of its rows", async () => {
  const stdout = createTestStdout(24, 10)
  const { externalOutput } = await setup({ stdout })
  const registered = new Set(Renderable.renderablesByNumber.keys())
  const create = OptimizedBuffer.create
  const created: OptimizedBuffer[] = []
  const spy = spyOn(OptimizedBuffer, "create").mockImplementation((...args) => {
    if (created.length === 2) throw new Error("allocation failed")
    created.push(create.apply(OptimizedBuffer, args))
    return created.at(-1)!
  })
  try {
    expect(() => stdout.write("a\nb\nc\n")).toThrow("allocation failed")
  } finally {
    spy.mockRestore()
  }
  expect(created.map((buffer) => (buffer as unknown as { _destroyed: boolean })._destroyed)).toEqual([true, true])
  expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
  expect(externalOutput.take()).toEqual([])
  stdout.write("d\n")
  expect(externalOutput.takeText()).toBe("d")
})

test("capture-stdout set after destruction leaves stdout uncaptured", async () => {
  const stdout = createTestStdout(24, 10)
  const { renderer } = await setup({ stdout, externalOutputMode: "passthrough" })
  const write = stdout.write
  renderer.destroy()
  await renderer.closed
  renderer.externalOutputMode = "capture-stdout"
  expect(stdout.write).toBe(write)
  expect(stdout.write("after destruction\n")).toBe(true)
})

test.each([
  ["writer", "NaN rowColumns", { rowColumns: Number.NaN }, null],
  ["surface", "NaN rowColumns", { rowColumns: Number.NaN }, null],
  [
    "writer",
    "non-boolean flags",
    { startOnNewLine: 0, trailingNewline: "yes" },
    { startOnNewLine: false, trailingNewline: true },
  ],
  ["surface", "non-boolean flags", { trailingNewline: 0 }, { startOnNewLine: true, trailingNewline: false }],
] as const)(
  "a %s commit with %s fails at the call or is coerced; frames keep presenting",
  async (source, _name, fields, flags) => {
    const { renderer, renderOnce, externalOutput } = await setup()
    const errors: unknown[] = []
    renderer.on(CliRenderEvents.RENDER_ERROR, (event) => errors.push(event))
    const commit = () => {
      if (source === "writer") {
        renderer.writeToScrollback(({ renderContext }) => ({
          root: new TextRenderable(renderContext, { content: "x", width: 1, height: 1 }),
          ...(fields as object),
        }))
        return
      }
      const surface = renderer.createScrollbackSurface()
      try {
        surface.root.add(new TextRenderable(surface.renderContext, { content: "x", width: 1, height: 1 }))
        surface.render()
        surface.commitRows(0, 1, fields as object)
      } finally {
        surface.destroy()
      }
    }
    if (flags === null) {
      expect(commit).toThrow(RangeError)
      expect(externalOutput.take()).toEqual([])
    } else {
      commit()
      expect(externalOutput.take()).toMatchObject([{ text: "x", ...flags }])
    }
    await renderOnce()
    await renderOnce()
    expect(errors).toEqual([])
  },
)

test("detached paint retries independently inside a main frame and commits retained rows", async () => {
  const { renderer, renderOnce, captureCharFrame, externalOutput } = await setup()
  const surface = renderer.createScrollbackSurface()
  let fail = true
  const box = new BoxRenderable(surface.renderContext, {
    width: 24,
    height: 2,
    renderBefore() {
      if (fail) throw new Error("detached paint failed")
    },
  })
  box.add(new TextRenderable(surface.renderContext, { content: "detached", height: 1 }))
  surface.root.add(box)
  const footer = new BoxRenderable(renderer, { width: 24, height: 1, renderBefore: () => surface.render() })
  footer.add(new TextRenderable(renderer, { content: "footer", height: 1 }))
  renderer.root.add(footer)
  expect(() => surface.render()).toThrow("detached paint failed")
  expect(() => surface.commitRows(0, 1)).toThrow("requires render()")
  fail = false
  await renderOnce()
  expect(captureCharFrame()).toContain("footer")
  expect(captureCharFrame()).not.toContain("detached")
  surface.commitRows(0, 1)
  surface.commitRows(1, 2)
  expect(externalOutput.takeText()).toContain("detached")
})

test.each(["writer", "geometry", "measurement"] as const)(
  "snapshot %s failure releases provisional nodes",
  async (kind) => {
    const { renderer, externalOutput } = await setup()
    const registered = new Set(Renderable.renderablesByNumber.keys())
    let root: BoxRenderable | undefined
    expect(() =>
      renderer.writeToScrollback(({ renderContext }) => {
        root = new BoxRenderable(renderContext, { width: 12 })
        if (kind === "writer") throw new Error("writer failed")
        if (kind === "geometry") return { root, width: NaN, height: 1 }
        let fail = true
        root.setMeasureProvider(() => {
          if (fail) throw new Error("measurement failed")
          return { width: 12, height: 3 }
        })
        expect(() => renderContext.nativeScene.measureSnapshot(root!)).toThrow("measurement failed")
        fail = false
        root.invalidateIntrinsicSize()
        expect(renderContext.nativeScene.measureSnapshot(root)).toBe(3)
        throw new Error("writer failed")
      }),
    ).toThrow(kind === "geometry" ? "width" : "writer failed")
    expect(root?.isDestroyed).toBe(true)
    expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
    renderer.writeToScrollback(({ renderContext }) => ({
      root: new TextRenderable(renderContext, { content: "next", width: 4, height: 1 }),
    }))
    expect(externalOutput.takeText()).toBe("next")
    expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
  },
)

test("detached destruction waits for active child cleanup", async () => {
  const { renderer, renderOnce } = await setup()
  const registered = new Set(Renderable.renderablesByNumber.keys())
  const surface = renderer.createScrollbackSurface()
  const driver = surface.renderContext.nativeScene.driver
  const child = new TextRenderable(surface.renderContext, { content: "child" })
  surface.root.add(child)
  child.on(RenderableEvents.DESTROYED, () => {
    surface.destroy()
    expect(driver.disposed).toBe(false)
  })
  child.destroy()
  expect(driver.disposed).toBe(true)
  expect(surface.root.isDestroyed).toBe(true)
  expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
  await renderOnce()
})

test("settlement ignores removed code and cancels mounted pending highlights on destruction", async () => {
  const { renderer } = await setup()
  const surface = renderer.createScrollbackSurface()
  const client = new MockTreeSitterClient()
  const style = SyntaxStyle.fromStyles({}, renderer.nativeScene)
  try {
    const code = new CodeRenderable(surface.renderContext, {
      content: "const pending = true",
      filetype: "typescript",
      syntaxStyle: style,
      treeSitterClient: client,
      width: "100%",
    })
    surface.root.add(code)
    surface.render()
    expect(code.isHighlighting).toBe(true)
    surface.root.remove(code)
    await surface.settle(0)
    expect(code.isDestroyed).toBe(false)
    surface.root.add(code)
    const settling = surface.settle(10_000)
    surface.destroy()
    await expect(settling).rejects.toThrow("destroyed")
    client.resolveAllHighlightOnce()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(code.isDestroyed).toBe(true)
  } finally {
    surface.destroy()
    client.resolveAllHighlightOnce()
    await client.destroy()
    style.destroy()
  }
})
