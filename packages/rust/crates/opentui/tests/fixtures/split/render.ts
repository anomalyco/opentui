// Drives OpenTUI Core's split-footer renderer through each case below and writes the bytes every step sends to the
// terminal to `<case>/<nn>-<step>.bin` beside this script. `tests/split.rs` drives `opentui::split` through the same
// steps and compares.
//
// Run it from a directory where `@opentui/core` resolves, such as OpenCode's `packages/tui`:
//
//     bun --cwd /path/to/opencode/packages/tui /path/to/render.ts
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Writable } from "node:stream"

const core = await import(Bun.resolveSync("@opentui/core", process.cwd()))
const testing = await import(Bun.resolveSync("@opentui/core/testing", process.cwd()))
const directory = import.meta.dir

class Recording extends Writable {
  readonly isTTY = true
  readonly writes: Buffer[] = []
  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    super()
  }
  override _write(chunk: Uint8Array, _encoding: BufferEncoding, callback: () => void) {
    this.writes.push(Buffer.from(chunk))
    callback()
  }
  getColorDepth() {
    return 24
  }
  take() {
    const bytes = Buffer.concat(this.writes)
    this.writes.length = 0
    return bytes
  }
}

const FOOTER_FG = core.RGBA.fromHex("#00ff00")
const ROW_FG = core.RGBA.fromHex("#ffaa00")

type Harness = Awaited<ReturnType<typeof start>>

async function start(width: number, height: number, footerHeight: number, cursorRow: number, early?: number) {
  const stdout = new Recording(width, height)
  const setup = await testing.createTestRenderer({
    screenMode: "split-footer",
    externalOutputMode: "capture-stdout",
    width,
    height,
    footerHeight,
    consoleMode: "disabled",
    stdout,
    bufferedOutput: "stdout",
    remote: true,
    useMouse: false,
    clock: new testing.ManualClock(),
  })
  const renderer = setup.renderer
  const driver = renderer.nativeScene.driver
  if (early !== undefined) renderer.footerHeight = early
  await renderer.setupTerminal()
  await driver.idle()
  renderer.stdin.emit("data", Buffer.from(`\x1b[${cursorRow};1R`))
  await driver.idle()
  const footer = new core.TextRenderable(renderer, { content: "footer", fg: FOOTER_FG })
  renderer.root.add(footer)
  const frame = async () => {
    await setup.renderOnce()
    await driver.idle()
  }
  const write = (row: string) =>
    renderer.writeToScrollback(({ renderContext }: { renderContext: unknown }) => ({
      root: new core.TextRenderable(renderContext, { content: row, width: row.length, height: 1, fg: ROW_FG }),
    }))
  return { renderer, stdout, footer, frame, write, setupBytes: stdout.take() }
}

type Step = [name: string, run: (harness: Harness) => Promise<void>]

const cases: Record<
  string,
  { size: [number, number, number, number] | [number, number, number, number, number]; steps: Step[] }
> = {
  // The footer height changes after the renderer exists and before the terminal is set up.
  early: {
    size: [40, 10, 3, 4, 6],
    steps: [
      ["footer", (h) => h.frame()],
      [
        "write",
        async (h) => {
          h.write("alpha")
          await h.frame()
        },
      ],
      [
        "close",
        async (h) => {
          h.renderer.destroy()
          await h.renderer.closed
        },
      ],
    ],
  },
  basic: {
    size: [40, 10, 3, 4],
    steps: [
      ["footer", (h) => h.frame()],
      [
        "write",
        async (h) => {
          h.write("alpha")
          h.write("beta")
          await h.frame()
        },
      ],
      [
        "grow",
        async (h) => {
          h.renderer.footerHeight = 5
          await h.frame()
        },
      ],
      [
        "write-grown",
        async (h) => {
          h.write("gamma")
          await h.frame()
        },
      ],
      [
        "shrink",
        async (h) => {
          h.renderer.footerHeight = 2
          await h.frame()
        },
      ],
      [
        "resize",
        async (h) => {
          h.renderer.resize(30, 12)
          await h.frame()
        },
      ],
      [
        "replay",
        async (h) => {
          h.renderer.resetSplitFooterForReplay({ clearSavedLines: true })
          h.write("delta")
          await h.frame()
        },
      ],
      [
        "leave",
        async (h) => {
          h.renderer.externalOutputMode = "passthrough"
          h.renderer.screenMode = "main-screen"
          h.renderer.destroy()
          await h.renderer.closed
        },
      ],
    ],
  },
  deferred: {
    size: [32, 9, 2, 6],
    steps: [
      ["footer", (h) => h.frame()],
      [
        "grow-queued",
        async (h) => {
          h.write("one")
          h.write("two")
          h.renderer.footerHeight = 4
          await h.frame()
        },
      ],
      ["after", (h) => h.frame()],
      [
        "there-and-back",
        async (h) => {
          h.renderer.footerHeight = 2
          h.renderer.footerHeight = 4
          h.write("three")
          await h.frame()
        },
      ],
      [
        "narrow",
        async (h) => {
          h.renderer.footerHeight = 3
          h.renderer.resize(24, 9)
          await h.frame()
        },
      ],
      [
        "tail",
        async (h) => {
          h.renderer.writeToScrollback(({ renderContext }: { renderContext: unknown }) => ({
            root: new core.TextRenderable(renderContext, { content: "ab", width: 2, height: 1, fg: ROW_FG }),
            trailingNewline: false,
          }))
          h.renderer.writeToScrollback(
            ({ renderContext, tailColumn }: { renderContext: unknown; tailColumn: number }) => ({
              root: new core.TextRenderable(renderContext, {
                content: `cd@${tailColumn}`,
                width: 4,
                height: 1,
                fg: ROW_FG,
              }),
              startOnNewLine: false,
            }),
          )
          await h.frame()
        },
      ],
      [
        "close",
        async (h) => {
          h.renderer.destroy()
          await h.renderer.closed
        },
      ],
    ],
  },
  surface: {
    size: [30, 10, 2, 3],
    steps: [
      ["footer", (h) => h.frame()],
      [
        "first",
        async (h) => {
          const surface = h.renderer.createScrollbackSurface({ startOnNewLine: true })
          const text = new core.TextRenderable(surface.renderContext, { content: "one\ntwo\nthree", fg: ROW_FG })
          surface.root.add(text)
          surface.render()
          surface.commitRows(0, 2, { trailingNewline: true })
          Object.assign(h, { surface, text })
          await h.frame()
        },
      ],
      [
        "rest",
        async (h) => {
          const { surface, text } = h as unknown as { surface: any; text: any }
          text.content = "one\ntwo\nthree\nfour"
          surface.render()
          surface.commitRows(2, surface.height, { trailingNewline: true })
          surface.destroy()
          await h.frame()
        },
      ],
      [
        "close",
        async (h) => {
          h.renderer.destroy()
          await h.renderer.closed
        },
      ],
    ],
  },
  many: {
    size: [20, 8, 2, 1],
    steps: [
      ["footer", (h) => h.frame()],
      [
        "write",
        async (h) => {
          for (let row = 0; row < 12; row++) h.write(`row ${row}`)
          await h.frame()
        },
      ],
      ["rest", (h) => h.frame()],
      [
        "close",
        async (h) => {
          h.write("last")
          h.renderer.destroy()
          await h.renderer.closed
        },
      ],
    ],
  },
}

for (const [name, { size, steps }] of Object.entries(cases)) {
  const output = join(directory, name)
  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  const harness = await start(...size)
  for (const [index, [step, run]] of steps.entries()) {
    await run(harness)
    writeFileSync(join(output, `${String(index).padStart(2, "0")}-${step}.bin`), harness.stdout.take())
  }
}
