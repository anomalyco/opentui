import { afterEach, describe, expect, it } from "bun:test"
import { Renderable, TextAttributes, TextRenderable, getLinkId, parseColor, type OptimizedBuffer } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { onCleanup } from "solid-js"
import { createScrollbackWriter, useRenderer, useTerminalDimensions, writeSolidToScrollback } from "../index.js"

let testSetup: Awaited<ReturnType<typeof createTestRenderer>> | null = null
const decoder = new TextDecoder()
const splitFooter = {
  width: 40,
  height: 10,
  screenMode: "split-footer",
  footerHeight: 4,
  externalOutputMode: "capture-stdout",
  consoleMode: "disabled",
} as const

type QueuedSnapshotCommit = {
  snapshot: OptimizedBuffer
  rowColumns: number
  startOnNewLine: boolean
  trailingNewline: boolean
}

function claimSingleCommit(renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"]): QueuedSnapshotCommit {
  const commits = (renderer as any).externalOutputQueue.claim() as QueuedSnapshotCommit[]
  expect(commits).toHaveLength(1)

  const commit = commits[0]
  if (!commit) {
    throw new Error("expected a queued scrollback commit")
  }

  return commit
}

function claimCommits(renderer: Awaited<ReturnType<typeof createTestRenderer>>["renderer"]): QueuedSnapshotCommit[] {
  return (renderer as any).externalOutputQueue.claim() as QueuedSnapshotCommit[]
}

afterEach(() => {
  if (testSetup) {
    testSetup.renderer.destroy()
    testSetup = null
  }
})

describe("createScrollbackWriter", () => {
  it("creates styled snapshot commits from Solid JSX", async () => {
    const setup = await createTestRenderer({
      width: 40,
      height: 10,
      screenMode: "split-footer",
      footerHeight: 4,
      externalOutputMode: "capture-stdout",
      consoleMode: "disabled",
    })
    testSetup = setup

    setup.renderer.writeToScrollback(
      createScrollbackWriter(
        () => (
          <text>
            <span style={{ fg: "red", bold: true }}>Alert</span> <a href="https://example.com/docs">Docs</a>
          </text>
        ),
        { width: 20 },
      ),
    )

    const commit = claimSingleCommit(setup.renderer)

    try {
      const committedText = decoder.decode(commit.snapshot.getRealCharBytes(true))
      const committedSpans = commit.snapshot.getSpanLines().flatMap((line) => line.spans)

      expect(committedText).toContain("Alert Docs")

      const alertSpan = committedSpans.find((span) => span.text.includes("Alert"))
      expect(alertSpan).toBeDefined()
      expect(alertSpan?.fg.equals(parseColor("red"))).toBe(true)
      expect((alertSpan?.attributes ?? 0) & TextAttributes.BOLD).toBe(TextAttributes.BOLD)

      const hasLinkAttributes = commit.snapshot.withBuffers((cells) =>
        cells.attributes.some((attributes) => getLinkId(attributes) > 0),
      )
      expect(hasLinkAttributes).toBe(true)
    } finally {
      commit.snapshot.destroy()
    }
  })

  it("uses snapshot dimensions for renderer hooks during auto-height measurement", async () => {
    const setup = await createTestRenderer({
      width: 40,
      height: 10,
      screenMode: "split-footer",
      footerHeight: 4,
      externalOutputMode: "capture-stdout",
      consoleMode: "disabled",
    })
    testSetup = setup

    setup.renderer.writeToScrollback(
      createScrollbackWriter(
        () => {
          const renderer = useRenderer()
          const terminalDimensions = useTerminalDimensions()

          return (
            <text>
              {renderer.width}x{renderer.height}
              <br />
              {terminalDimensions().width}x{terminalDimensions().height}
            </text>
          )
        },
        { width: 12 },
      ),
    )

    const commit = claimSingleCommit(setup.renderer)

    try {
      const committedText = decoder.decode(commit.snapshot.getRealCharBytes(true))
      expect(commit.snapshot.height).toBe(2)
      expect(
        committedText
          .trimEnd()
          .split("\n")
          .map((line) => line.trimEnd()),
      ).toEqual(["12x2", "12x2"])
    } finally {
      commit.snapshot.destroy()
    }
  })

  it.each([false, true])("auto-height measurement skips updates and paint hooks (nested flow: %p)", async (nested) => {
    const setup = await createTestRenderer({
      width: 40,
      height: 10,
      screenMode: "split-footer",
      footerHeight: 4,
      externalOutputMode: "capture-stdout",
      consoleMode: "disabled",
    })
    testSetup = setup

    let updates = 0
    let paints = 0
    class Probe extends TextRenderable {
      protected override onUpdate() {
        this.content = String(++updates)
      }
    }
    setup.renderer.writeToScrollback(
      createScrollbackWriter(
        () =>
          nested ? (
            <box renderBefore={() => paints++}>{new Probe(useRenderer(), { content: "0" })}</box>
          ) : (
            new Probe(useRenderer(), {
              content: "0",
              position: "absolute",
              left: 0,
              top: 0,
              width: 1,
              height: 1,
            })
          ),
        { width: 1 },
      ),
    )

    const commit = claimSingleCommit(setup.renderer)

    try {
      expect(updates).toBe(1)
      expect(paints).toBe(nested ? 1 : 0)
      expect(decoder.decode(commit.snapshot.getRealCharBytes(true)).trim()).toBe("1")
    } finally {
      commit.snapshot.destroy()
    }
  })

  it("writeSolidToScrollback wraps writer creation and keeps cleanup behavior", async () => {
    const setup = await createTestRenderer({
      width: 40,
      height: 10,
      screenMode: "split-footer",
      footerHeight: 4,
      externalOutputMode: "capture-stdout",
      consoleMode: "disabled",
    })
    testSetup = setup

    let cleanupCalls = 0

    writeSolidToScrollback(
      setup.renderer,
      () => {
        onCleanup(() => {
          cleanupCalls += 1
        })

        return <text>wrapper output</text>
      },
      {
        width: 20,
        rowColumns: 7,
        startOnNewLine: false,
        trailingNewline: false,
      },
    )

    expect(cleanupCalls).toBe(1)

    const commit = claimSingleCommit(setup.renderer)

    try {
      expect(decoder.decode(commit.snapshot.getRealCharBytes(true))).toContain("wrapper output")
      expect(commit.rowColumns).toBe(7)
      expect(commit.startOnNewLine).toBe(false)
      expect(commit.trailingNewline).toBe(false)
    } finally {
      commit.snapshot.destroy()
    }
  })

  it.each([
    ["width", { width: Number.NaN }],
    ["height", { height: Number.POSITIVE_INFINITY }],
  ] as const)("rejects a non-finite %s before rendering", async (axis, options) => {
    testSetup = await createTestRenderer(splitFooter)
    let rendered = false
    expect(() =>
      writeSolidToScrollback(
        testSetup!.renderer,
        () => {
          rendered = true
          return <text>never</text>
        },
        options,
      ),
    ).toThrow(`createScrollbackWriter requires a finite ${axis}`)
    expect(rendered).toBe(false)
    expect(claimCommits(testSetup.renderer)).toEqual([])
  })

  it("releases every renderable when the node throws", async () => {
    testSetup = await createTestRenderer(splitFooter)
    const registered = new Set(Renderable.renderablesByNumber.keys())
    let cleanups = 0
    expect(() =>
      writeSolidToScrollback(testSetup!.renderer, () => {
        onCleanup(() => cleanups++)
        return (
          <box>
            <text>partial</text>
            {(() => {
              throw new Error("node failed")
            })()}
          </box>
        )
      }),
    ).toThrow("node failed")
    expect(cleanups).toBe(1)
    expect(new Set(Renderable.renderablesByNumber.keys())).toEqual(registered)
    expect(claimCommits(testSetup.renderer)).toEqual([])
    writeSolidToScrollback(testSetup.renderer, () => <text>next</text>, { width: 4 })
    const commit = claimSingleCommit(testSetup.renderer)
    try {
      expect(decoder.decode(commit.snapshot.getRealCharBytes(true)).trim()).toBe("next")
    } finally {
      commit.snapshot.destroy()
    }
  })

  it.each([
    ["an explicit height", { height: 3 }, 3],
    // Each measurement adds a line, so auto-height gives up after its pass limit and keeps every line.
    ["auto-height that never settles", {}, 9],
  ] as const)("sizes the snapshot by %s", async (_name, options, height) => {
    testSetup = await createTestRenderer(splitFooter)
    writeSolidToScrollback(
      testSetup.renderer,
      () => {
        const renderer = useRenderer()
        return <text>{Array.from({ length: renderer.height + 1 }, (_, line) => `line ${line}`).join("\n")}</text>
      },
      { width: 10, ...options },
    )
    const commit = claimSingleCommit(testSetup.renderer)
    try {
      expect(commit.snapshot.height).toBe(height)
      const rows = decoder.decode(commit.snapshot.getRealCharBytes(true)).trimEnd().split("\n")
      expect(rows.at(-1)).toBe(`line ${height - 1}`)
    } finally {
      commit.snapshot.destroy()
    }
  })

  it("wraps a continued first line using the queued tail column", async () => {
    const setup = await createTestRenderer({
      width: 20,
      height: 10,
      screenMode: "split-footer",
      footerHeight: 4,
      externalOutputMode: "capture-stdout",
      consoleMode: "disabled",
    })
    testSetup = setup

    writeSolidToScrollback(setup.renderer, () => <text>12345678901234567</text>, {
      width: 20,
      startOnNewLine: false,
      trailingNewline: false,
    })

    writeSolidToScrollback(
      setup.renderer,
      (ctx) => {
        expect(ctx.tailColumn).toBe(17)
        return <text> located</text>
      },
      {
        width: 20,
        startOnNewLine: false,
        trailingNewline: false,
      },
    )

    const commits = claimCommits(setup.renderer)
    expect(commits).toHaveLength(2)

    for (const commit of commits) {
      expect(commit).toBeDefined()
    }

    const second = commits[1]
    if (!second) {
      throw new Error("expected second queued scrollback commit")
    }

    try {
      const text = decoder.decode(second.snapshot.getRealCharBytes(true))
      expect(second.snapshot.height).toBe(2)
      expect(text).toContain("located")
    } finally {
      for (const commit of commits) {
        commit?.snapshot.destroy()
      }
    }
  })
})
