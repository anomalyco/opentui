import { expect, test } from "bun:test"

import { channelVersions, docsLinks, parseReleaseNotes, releaseLine, splitFrontmatter } from "./release-notes"

function parse(source: string, version = "0.5.18") {
  const { yaml, body, bodyLine } = splitFrontmatter(source)
  return parseReleaseNotes(version, Bun.YAML.parse(yaml) as Record<string, unknown>, body, bodyLine)
}

const valid = `---
date: 2026-10-12
summary: Moves layout, hit testing, and painting into the native scene.
---

Layout now runs in native code.

## Breaking changes

- \`renderer.suspend()\` returns a promise. Await it.
  See [Renderer](/docs/core-concepts/renderer#suspend-and-resume).

- Removed \`dumpBuffers()\`. Use [frame capture](/docs/core-concepts/testing).

## Added

- \`renderer.hitTest(x, y)\` returns the renderable at a cell ([Renderer](/docs/core-concepts/renderer)).

## Fixed

- Detects OSC 8 hyperlinks in more terminals.
`

test("a release notes file gives its entries with their sections and documentation links", () => {
  const notes = parse(valid)
  expect(notes.date).toBe("2026-10-12")
  expect(notes.summary).toBe("Moves layout, hit testing, and painting into the native scene.")
  expect(notes.entries.map((entry) => [entry.section, entry.docs])).toEqual([
    ["Breaking changes", ["/docs/core-concepts/renderer"]],
    ["Breaking changes", ["/docs/core-concepts/testing"]],
    ["Added", ["/docs/core-concepts/renderer"]],
    ["Fixed", []],
  ])
  expect(notes.entries[0].markdown).toBe(
    "`renderer.suspend()` returns a promise. Await it.\nSee [Renderer](/docs/core-concepts/renderer#suspend-and-resume).",
  )
})

test.each([
  ["no frontmatter", "## Added\n", "missing frontmatter"],
  ["a bad date", "---\ndate: October\nsummary: S.\n---\n", "date must be YYYY-MM-DD"],
  ["no summary", "---\ndate: 2026-10-12\n---\n", "summary"],
  ["extra frontmatter", "---\ndate: 2026-10-12\nsummary: S.\ntitle: T\n---\n", "unknown frontmatter title"],
  ["an unknown section", "---\ndate: 2026-10-12\nsummary: S.\n---\n## Misc\n", '0.5.18.md:5: unknown section "Misc"'],
  ["sections out of order", "---\ndate: 2026-10-12\nsummary: S.\n---\n## Fixed\n- a\n## Added\n- b\n", "must follow"],
  ["a deeper heading", "---\ndate: 2026-10-12\nsummary: S.\n---\n## Added\n### Core\n", "only ## section"],
  ["a bullet before a section", "---\ndate: 2026-10-12\nsummary: S.\n---\n- a\n", "under a section"],
  ["prose in a section", "---\ndate: 2026-10-12\nsummary: S.\n---\n## Added\nText.\n", "as a bullet"],
  ["an HTML tag", "---\ndate: 2026-10-12\nsummary: S.\n---\n<script>alert(1)</script>\n", "not HTML"],
  ["an HTML comment", "---\ndate: 2026-10-12\nsummary: S.\n---\n## Added\n- a <!-- b -->\n", "not HTML"],
  [
    "an image with an event handler",
    '---\ndate: 2026-10-12\nsummary: S.\n---\n## Fixed\n- a <img src=x onerror="b">\n',
    "not HTML",
  ],
  [
    "a javascript link",
    "---\ndate: 2026-10-12\nsummary: S.\n---\n## Fixed\n- [a](javascript:alert(1))\n",
    "javascript:",
  ],
  ["an http link", "---\ndate: 2026-10-12\nsummary: S.\n---\n## Fixed\n- [a](http://example.com)\n", "http:"],
  ["a relative link", "---\ndate: 2026-10-12\nsummary: S.\n---\nSee [a](../x).\n", '"../x"'],
  ["a reference definition", "---\ndate: 2026-10-12\nsummary: S.\n---\n[a]: data:text/html,x\n", "data:"],
])("rejects %s", (_, source, message) => {
  expect(() => parse(source)).toThrow(message)
})

test("accepts code that looks like HTML, autolinks, and https, fragment, and docs links", () => {
  const source = [
    "---",
    "date: 2026-10-12",
    "summary: S.",
    "---",
    "## Added",
    "- `<box>` and ``a <b>`` render. See <https://example.com/x>, [b](https://example.com), [c](#added), and",
    "  [d](/docs/core-concepts/layout#cell-rounding).",
    "",
    "  ```tsx",
    "  <text>hi</text>",
    "  ```",
  ].join("\n")
  expect(parse(source).entries).toHaveLength(1)
})

test("rejects a file name that is not a version", () => {
  expect(() => parse(valid, "next")).toThrow("file name must be a version")
})

test("docsLinks lists each linked page once, without fragments or queries", () => {
  expect(
    docsLinks("[a](/docs/x#y) [b](/docs/x?path=1) [c](/docs) [d](https://opentui.com/docs/z) [e](/docsearch)"),
  ).toEqual(["/docs/x", "/docs"])
})

test("channelVersions lists releases newest first, up to the release on the release channel", () => {
  const notes = ["0.5.18", "0.5.10"]
  const api = ["0.4.5", "0.5.10", "0.5.17"]
  expect(channelVersions({ id: "stable", release: "0.5.17" }, notes, api)).toEqual(["0.5.17", "0.5.10", "0.4.5"])
  expect(channelVersions({ id: "next", release: "0.5.17" }, notes, api)).toEqual([
    "0.5.18",
    "0.5.17",
    "0.5.10",
    "0.4.5",
  ])
  expect(releaseLine("0.5.17")).toBe("0.5")
})
