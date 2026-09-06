import { afterEach, expect, test } from "bun:test"
import assert from "node:assert/strict"
import { RGBA } from "../lib/RGBA.js"
import { StyledText } from "../lib/styled-text.js"
import { TextRenderable } from "../renderables/Text.js"
import { ManualClock } from "../testing/manual-clock.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { TextAttributes } from "../types.js"

const red = RGBA.fromHex("#ff0000")
const green = RGBA.fromHex("#00ff00")
const blue = RGBA.fromHex("#0000ff")
const white = RGBA.fromHex("#ffffff")
const black = RGBA.fromHex("#000000")
const transparent = RGBA.fromValues(0, 0, 0, 0)
const { BOLD, DIM, ITALIC, UNDERLINE } = TextAttributes
const setups: TestRendererSetup[] = []

afterEach(async () => {
  for (const { renderer } of setups.splice(0)) {
    renderer.destroy()
    await renderer.closed
  }
})

async function setup(width: number, height = 1) {
  const target = await createTestRenderer({
    width,
    height,
    clock: new ManualClock(),
  })
  setups.push(target)
  return target
}

function capture(target: TestRendererSetup) {
  return target
    .captureSpans()
    .lines.map(({ spans }) => spans.map(({ text, width, fg, bg, attributes }) => [text, width, fg, bg, attributes]))
}

test("legacy StyledText inherits missing colors and ORs chunk attributes with changing defaults", async () => {
  const target = await setup(4)
  const text = new TextRenderable(target.renderer, {
    selectable: false,
    fg: green,
    bg: black,
    attributes: BOLD,
    content: new StyledText([
      { __isChunk: true, text: "A", fg: red, attributes: ITALIC },
      { __isChunk: true, text: "B", bg: blue, attributes: 0 },
      { __isChunk: true, text: "C" },
      { __isChunk: true, text: "D", fg: red, bg: blue, attributes: UNDERLINE },
    ]),
  })
  target.renderer.root.add(text)
  await target.renderOnce()
  expect(capture(target)).toEqual([
    [
      ["A", 1, red, black, BOLD | ITALIC],
      ["B", 1, green, blue, BOLD],
      ["C", 1, green, black, BOLD],
      ["D", 1, red, blue, BOLD | UNDERLINE],
    ],
  ])

  const magenta = RGBA.fromHex("#ff00ff")
  const cyan = RGBA.fromHex("#00ffff")
  text.fg = magenta
  text.bg = cyan
  text.attributes = DIM
  await target.renderOnce()
  expect(capture(target)).toEqual([
    [
      ["A", 1, red, cyan, DIM | ITALIC],
      ["B", 1, magenta, blue, DIM],
      ["C", 1, magenta, cyan, DIM],
      ["D", 1, red, blue, DIM | UNDERLINE],
    ],
  ])
})

for (const fixture of [
  {
    name: "combining mark",
    parts: ["e", "\u0301X", "Y"],
    width: 3,
    expected: [
      ["e\u0301", 1, red, blue, BOLD],
      ["X", 1, green, red, ITALIC],
      ["Y", 1, blue, green, UNDERLINE],
    ],
  },
  {
    name: "ZWJ sequence",
    parts: ["\ud83d\udc69", "\u200d\ud83d\udcbb", "WXYZ"],
    width: 6,
    expected: [
      ["\ud83d\udc69\u200d\ud83d\udcbb", 2, red, blue, BOLD],
      ["WXYZ", 4, blue, green, UNDERLINE],
    ],
  },
]) {
  test(`legacy StyledText uses concatenated width-cursor style ranges across a split ${fixture.name}`, async () => {
    const target = await setup(fixture.width)
    const text = new TextRenderable(target.renderer, {
      selectable: false,
      wrapMode: "none",
      content: new StyledText(
        fixture.parts.map((part, index) => ({
          __isChunk: true,
          text: part,
          fg: [red, green, blue][index],
          bg: [blue, red, green][index],
          attributes: [BOLD, ITALIC, UNDERLINE][index],
        })),
      ),
    })
    target.renderer.root.add(text)
    await target.renderOnce()
    expect(text.plainText).toBe(fixture.parts.join(""))
    expect(text.textLength).toBe(fixture.width)
    assert.deepEqual(capture(target), [fixture.expected])
  })
}

test("legacy StyledText styles CJK and tab cells and normalizes a CRLF split across chunks", async () => {
  const target = await setup(5, 2)
  const text = new TextRenderable(target.renderer, {
    selectable: false,
    wrapMode: "none",
    content: new StyledText([
      { __isChunk: true, text: "\u4e16", fg: red, bg: blue, attributes: BOLD },
      { __isChunk: true, text: "\t", fg: green, bg: red, attributes: ITALIC },
      { __isChunk: true, text: "B\r", fg: blue, bg: green, attributes: UNDERLINE },
      { __isChunk: true, text: "\nC", fg: red, bg: blue, attributes: BOLD },
    ]),
  })
  target.renderer.root.add(text)
  await target.renderOnce()
  expect(text.chunks.map(({ text }) => text).join("")).toBe("\u4e16\tB\r\nC")
  expect(text.plainText).toBe("\u4e16\tB\nC")
  expect(text.textLength).toBe(6)
  expect(text.lineCount).toBe(2)
  expect(capture(target)).toEqual([
    [
      ["\u4e16", 2, red, blue, BOLD],
      ["  ", 2, green, red, ITALIC],
      ["B", 1, blue, green, UNDERLINE],
    ],
    [
      ["C", 1, red, blue, BOLD],
      ["    ", 4, white, transparent, 0],
    ],
  ])
})
