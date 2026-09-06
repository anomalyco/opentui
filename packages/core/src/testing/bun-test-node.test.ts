import { expect, test } from "bun:test"

test("matches compact frame JSON snapshots", () => {
  expect(
    JSON.stringify({
      width: 2,
      height: 1,
      char: { type: "Uint32Array", bytes: "YQAAAGIAAAA=" },
      text: "a\nb",
    }),
  ).toMatchSnapshot()
})

test("matches multiline snapshots without trimming content", () => {
  expect("\n  first line\nsecond line  ").toMatchSnapshot()
})

test("preserves ` ${template} and \\ in snapshot names and values", () => {
  expect("`;\n${notDefined}\n\\` \\\\` \\${notDefined} \\\\${notDefined}\\n\\t\\r").toMatchSnapshot()
})

test("preserves inline snapshot escaping", () => {
  expect("\\n\\t` ${notDefined}").toMatchInlineSnapshot('"\\n\\t` ${notDefined}"')
  expect("first\n\\second").toMatchInlineSnapshot(`
    "first
    \\second"
  `)
})

test.each([false, true, undefined, null, 42, "tiny"])("formats %s in snapshot names", (value) => {
  expect(String(value)).toMatchSnapshot()
})

test.each([
  [false, "tail"],
  [undefined, "tail"],
  [42, "tail"],
  ["prefix", "tail"],
])("formats each argument %s then %s", (first, second) => {
  expect(JSON.stringify([first, second])).toMatchSnapshot()
})

test.each([
  { wrapMode: "char", height: 0.5, lines: 2 },
  { wrapMode: "char", height: undefined, lines: 2 },
])("formats JSON %j in snapshot names", (value) => {
  expect(JSON.stringify(value)).toMatchSnapshot()
})
