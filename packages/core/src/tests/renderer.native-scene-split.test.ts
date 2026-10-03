import { afterEach, expect, test } from "bun:test"
import { NativeSession } from "../NativeSession.js"
import { Renderable, RenderableEvents } from "../Renderable.js"
import { BoxRenderable } from "../renderables/Box.js"
import { CodeRenderable } from "../renderables/Code.js"
import { TextRenderable } from "../renderables/Text.js"
import { SyntaxStyle } from "../syntax-style.js"
import {
  createTestRenderer,
  ManualClock,
  MockTreeSitterClient,
  type TestRenderer,
  type TestRendererOptions,
} from "../testing.js"
import { RecordingWriteStream } from "../testing/test-streams.js"

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
async function setupTerminal(options: { maxBytes?: bigint } = {}) {
  const stdout = new RecordingWriteStream(40, 10) as RecordingWriteStream & NodeJS.WriteStream
  const nativeSession =
    options.maxBytes === undefined
      ? undefined
      : new NativeSession(stdout, {
          output: { chunkSize: 4096, spanCapacity: 128, maxBytes: options.maxBytes, controlCapacity: 4096 },
        })
  const result = await setup({
    width: 40,
    stdout,
    nativeSession,
    bufferedOutput: "stdout",
    remote: true,
    clock: new ManualClock(),
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
  return { ...result, stdout, frame, drainUntil, printed }
}

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

test.each(["stdout", "writer"] as const)(
  "a %s write past the queued cell budget throws, queues nothing, and fits after a drain",
  async (kind) => {
    // 1,024 queued cells: 24 bytes per snapshot cell.
    const { renderer, stdout, externalOutput, drainUntil, printed } = await setupTerminal({ maxBytes: 24_576n })
    const write = (rows: string[]) => {
      if (kind === "stdout") stdout.write(rows.join("\n") + "\n")
      else
        renderer.writeToScrollback(({ renderContext }) => ({
          root: new TextRenderable(renderContext, { content: rows.join("\n"), width: 40, height: rows.length }),
        }))
    }
    const wide = (prefix: string, count: number) => lines(count).map((row) => `${prefix} ${row}`.padEnd(40, "."))
    write(wide("a", 20))
    expect(() => write(wide("b", 6))).toThrow("Scrollback snapshot queue capacity exceeded")
    expect(externalOutput.take().flatMap(({ rows }) => rows)).toEqual(wide("a", 20))
    await drainUntil("a line 19")
    write(wide("b", 6))
    await drainUntil("b line 5")
    expect(printed(/[ab] line \d+/g)).toEqual([
      ...lines(20).map((row) => `a ${row}`),
      ...lines(6).map((row) => `b ${row}`),
    ])
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
