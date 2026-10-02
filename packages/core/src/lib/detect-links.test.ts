import { test, expect, describe } from "bun:test"
import { detectLinks } from "./detect-links.js"
import type { TextChunk } from "../text-buffer.js"
import type { SimpleHighlight } from "./tree-sitter/types.js"
import { RGBA } from "./RGBA.js"

function chunk(text: string): TextChunk {
  return { __isChunk: true, text, fg: RGBA.fromInts(255, 255, 255, 255), attributes: 0 }
}

describe("detectLinks", () => {
  test("should set link on markup.link.url chunks", () => {
    const destination = "custom+v1://example.test/path"
    const content = `[Click here](${destination})`
    const start = content.indexOf(destination)
    const highlights: SimpleHighlight[] = [
      [0, 1, "markup.link"],
      [1, 11, "markup.link.label"],
      [11, start, "markup.link"],
      [start, start + destination.length, "markup.link.url"],
      [start + destination.length, content.length, "markup.link"],
    ]
    const chunks = [chunk("["), chunk("Click here"), chunk("]("), chunk(destination), chunk(")")]

    const result = detectLinks(chunks, { content, highlights })

    expect(result.find((c) => c.text === destination)!.link).toEqual({ url: destination })
    expect(result.find((c) => c.text === "Click here")!.link).toEqual({ url: destination })
  })

  test("should set link on string.special.url chunks", () => {
    const content = "// see https://example.com for details"
    const highlights: SimpleHighlight[] = [
      [0, 38, "comment"],
      [7, 26, "string.special.url"],
    ]
    const chunks = [chunk("// see "), chunk("https://example.com"), chunk(" for details")]

    const result = detectLinks(chunks, { content, highlights })

    expect(result.find((c) => c.text === "https://example.com")!.link).toEqual({ url: "https://example.com" })
  })

  test("should not set link on non-URL chunks", () => {
    const content = "const x = 42"
    const highlights: SimpleHighlight[] = [
      [0, 5, "keyword"],
      [6, 7, "variable"],
      [10, 12, "number"],
    ]
    const chunks = [chunk("const"), chunk(" "), chunk("x"), chunk(" = "), chunk("42")]

    const result = detectLinks(chunks, { content, highlights })

    for (const c of result) {
      expect(c.link).toBeUndefined()
    }
  })

  test("should return chunks unchanged when no URL scopes exist", () => {
    const content = "**label** and `code`"
    const highlights: SimpleHighlight[] = [
      [0, 9, "markup.strong"],
      [0, 2, "conceal", { conceal: "" }],
      [2, 7, "markup.link.label"],
      [7, 9, "conceal", { conceal: "" }],
      [14, 20, "markup.raw"],
    ]
    const chunks = [chunk("label"), chunk(" and "), chunk("code")]

    const result = detectLinks(chunks, { content, highlights })

    expect(result).toBe(chunks)
  })

  test("should detect links when chunks have concealed text", () => {
    // Original content: [Click here](https://example.com)
    // With concealment, `[` and `]` are concealed to empty strings,
    // and `(` and `)` are concealed to empty strings.
    // This means chunk text lengths don't match original byte offsets.
    const content = "[Click here](https://example.com)"
    const highlights: SimpleHighlight[] = [
      [0, 1, "markup.link"], // [
      [1, 11, "markup.link.label"], // Click here
      [11, 13, "markup.link"], // ](
      [13, 32, "markup.link.url"], // https://example.com
      [32, 33, "markup.link"], // )
    ]
    // Simulate concealed chunks: `[` -> "", `](` -> " ", `)` -> ""
    // The URL and label chunks remain unchanged.
    const chunks = [
      chunk(""), // concealed `[`
      chunk("Click here"), // label, unchanged
      chunk(" "), // concealed `](`
      chunk("https://example.com"), // URL, unchanged
      chunk(""), // concealed `)`
    ]

    const result = detectLinks(chunks, { content, highlights })

    // The URL chunk should still get its link despite concealed offsets
    expect(result.find((c) => c.text === "https://example.com")!.link).toEqual({ url: "https://example.com" })
    // The label chunk should also get the link
    expect(result.find((c) => c.text === "Click here")!.link).toEqual({ url: "https://example.com" })
  })

  test("links formatted and source-replaced label chunks across intervening conceal captures", () => {
    const content = "[a **A&amp;B** z](https://example.com)"
    const labelEnd = content.indexOf("]")
    const entityStart = content.indexOf("&amp;")
    const urlStart = content.indexOf("https://")
    const highlights: SimpleHighlight[] = [
      [1, labelEnd, "markup.link.label"],
      [3, labelEnd - 2, "markup.strong"],
      [3, 5, "conceal", { conceal: "" }],
      [entityStart, entityStart + 5, "character.special", { conceal: "&" }],
      [labelEnd - 4, labelEnd - 2, "conceal", { conceal: "" }],
      [labelEnd, labelEnd + 1, "conceal", { conceal: " " }],
      [urlStart, content.length - 1, "markup.link.url"],
    ]
    const chunks = ["a ", "A", "&", "B", " z", " ", "(", "https://example.com"].map(chunk)
    const sourceRanges = [
      { start: 1, end: 3 },
      { start: 5, end: entityStart },
      { start: entityStart, end: entityStart + 5 },
      { start: entityStart + 5, end: entityStart + 6 },
      { start: labelEnd - 2, end: labelEnd },
      { start: labelEnd, end: labelEnd + 1 },
      { start: labelEnd + 1, end: labelEnd + 2 },
      { start: urlStart, end: content.length - 1 },
    ]

    const result = detectLinks(chunks, { content, highlights, sourceRanges })

    for (const label of result.slice(0, 5)) {
      expect(label.link).toEqual({ url: "https://example.com" })
    }
    expect(result[5].link).toBeUndefined()
    expect(result[7].link).toEqual({ url: "https://example.com" })
  })

  test("normalizes escaped named destinations while preserving literal autolink backslashes", () => {
    const destination = String.raw`custom://example.test/a\(b\)/c\\d\*e`
    const autolink = String.raw`https://example.test/a\*b`
    const content = `[label](${destination}) <${autolink}>`
    const start = content.indexOf(destination)
    const autoStart = content.indexOf(autolink)
    const highlights: SimpleHighlight[] = [
      [1, 6, "markup.link.label"],
      [start, start + destination.length, "markup.link.url"],
      [autoStart, autoStart + autolink.length, "markup.link.url"],
    ]

    const result = detectLinks([chunk("label"), chunk(destination), chunk(autolink)], {
      content,
      highlights,
      sourceRanges: [
        { start: 1, end: 6 },
        { start, end: start + destination.length },
        { start: autoStart, end: autoStart + autolink.length },
      ],
    })

    expect(result.map((item) => item.link?.url)).toEqual([
      String.raw`custom://example.test/a(b)/c\d*e`,
      String.raw`custom://example.test/a(b)/c\d*e`,
      autolink,
    ])
  })

  test("associates each named label with its destination, never an unrelated autolink or bare URL", () => {
    const content =
      "[orphan] [other] <https://auto.test> https://bare.test [a](custom+v1://target.test) [b](https://second.test)"
    const orphanStart = content.indexOf("orphan")
    const otherStart = content.indexOf("other")
    const autoStart = content.indexOf("https://auto.test")
    const bareStart = content.indexOf("https://bare.test")
    const labelStart = content.indexOf("a](")
    const targetStart = content.indexOf("custom+v1://target.test")
    const secondLabel = content.indexOf("b](")
    const secondTarget = content.indexOf("https://second.test")
    const highlights: SimpleHighlight[] = [
      [orphanStart, orphanStart + "orphan".length, "markup.link.label"],
      [otherStart, otherStart + "other".length, "markup.link.label"],
      [autoStart, autoStart + "https://auto.test".length, "markup.link.url"],
      [labelStart, labelStart + 1, "markup.link.label"],
      [targetStart, targetStart + "custom+v1://target.test".length, "markup.link.url"],
      [secondLabel, secondLabel + 1, "markup.link.label"],
      [secondTarget, secondTarget + "https://second.test".length, "markup.link.url"],
    ]
    const sourceRanges = [
      { start: orphanStart, end: orphanStart + "orphan".length },
      { start: otherStart, end: otherStart + "other".length },
      { start: autoStart, end: autoStart + "https://auto.test".length },
      { start: bareStart, end: bareStart + "https://bare.test".length },
      { start: labelStart, end: labelStart + 1 },
      { start: targetStart, end: targetStart + "custom+v1://target.test".length },
      { start: secondLabel, end: secondLabel + 1 },
      { start: secondTarget, end: secondTarget + "https://second.test".length },
    ]
    const chunks = sourceRanges.map(({ start, end }) => chunk(content.slice(start, end)))

    const result = detectLinks(chunks, { content, highlights, sourceRanges })

    expect(result.map((item) => item.link?.url)).toEqual([
      undefined,
      undefined,
      "https://auto.test",
      "https://bare.test",
      "custom+v1://target.test",
      "custom+v1://target.test",
      "https://second.test",
      "https://second.test",
    ])
  })

  test("prioritizes the outer formatted label and explicit destination over visible URL text", () => {
    const content = "[**before https://visible.test after**](custom+v1://target.test)"
    const labelStart = 1
    const labelEnd = content.indexOf("]")
    const visibleStart = content.indexOf("https://visible.test")
    const targetStart = content.indexOf("custom+v1://target.test")
    const highlights: SimpleHighlight[] = [
      [labelStart, labelEnd, "markup.link.label"],
      [labelStart + 2, labelEnd, "markup.link.label"],
      [visibleStart, visibleStart + "https://visible.test".length, "string.special.url"],
      [targetStart, targetStart + "custom+v1://target.test".length, "markup.link.url"],
    ]
    const chunks = [chunk("before "), chunk("https://visible.test"), chunk(" after"), chunk("custom+v1://target.test")]
    const sourceRanges = [
      { start: labelStart + 2, end: visibleStart },
      { start: visibleStart, end: visibleStart + "https://visible.test".length },
      { start: visibleStart + "https://visible.test".length, end: labelEnd - 2 },
      { start: targetStart, end: targetStart + "custom+v1://target.test".length },
    ]

    const result = detectLinks(chunks, { content, highlights, sourceRanges })

    expect(result.map((item) => item.link?.url)).toEqual(Array(4).fill("custom+v1://target.test"))
  })

  test("prioritizes explicit destinations when a visible URL spans the entire label", () => {
    const content = "[https://visible.test](custom://target.test)"
    const visibleStart = 1
    const visibleEnd = content.indexOf("]")
    const targetStart = content.indexOf("custom://target.test")
    const highlights: SimpleHighlight[] = [
      [visibleStart, visibleEnd, "markup.link.label"],
      [visibleStart, visibleEnd, "string.special.url"],
      [targetStart, content.length - 1, "markup.link.url"],
    ]

    const result = detectLinks([chunk("https://visible.test"), chunk("custom://target.test")], {
      content,
      highlights,
      sourceRanges: [
        { start: visibleStart, end: visibleEnd },
        { start: targetStart, end: content.length - 1 },
      ],
    })

    expect(result.map((item) => item.link?.url)).toEqual(["custom://target.test", "custom://target.test"])
  })

  test("processes dense raw markup, named links, bare URLs, and chunks", () => {
    const count = 8_000
    const parts: string[] = []
    const highlights: SimpleHighlight[] = []
    const chunks: TextChunk[] = []
    const sourceRanges: Array<{ start: number; end: number }> = []
    let offset = 0

    for (let index = 0; index < count; index++) {
      const raw = `\`https://hidden${index}.test\``
      const label = `label${index}`
      const target = `custom://target${index}.test`
      const visible = `https://visible${index}.test`
      const part = `${raw} [${label}](${target}) ${visible} `
      const labelStart = offset + raw.length + 2
      const targetStart = labelStart + label.length + 2
      const visibleStart = targetStart + target.length + 2

      parts.push(part)
      highlights.push([offset, offset + raw.length, "markup.raw"])
      highlights.push([labelStart, labelStart + label.length, "markup.link.label"])
      highlights.push([targetStart, targetStart + target.length, "markup.link.url"])
      chunks.push(chunk(label), chunk(target), chunk(visible))
      sourceRanges.push(
        { start: labelStart, end: labelStart + label.length },
        { start: targetStart, end: targetStart + target.length },
        { start: visibleStart, end: visibleStart + visible.length },
      )
      offset += part.length
    }

    const result = detectLinks(chunks, { content: parts.join(""), highlights, sourceRanges })

    expect(result).toHaveLength(count * 3)
    expect(result[0].link?.url).toBe("custom://target0.test")
    expect(result[1].link?.url).toBe("custom://target0.test")
    expect(result[2].link?.url).toBe("https://visible0.test")
    expect(result.at(-3)?.link?.url).toBe(`custom://target${count - 1}.test`)
    expect(result.at(-2)?.link?.url).toBe(`custom://target${count - 1}.test`)
    expect(result.at(-1)?.link?.url).toBe(`https://visible${count - 1}.test`)
  }, 10_000)

  test("splits only bare HTTP URLs from surrounding prose and punctuation", () => {
    const content = "ftp://ignored.test mailto:user@test See HtTpS://one.test/path, then (http://two.test/a_(b))."
    const chunks = [chunk(content)]

    const result = detectLinks(chunks, { content, highlights: [] })

    expect(result.map((item) => [item.text, item.link?.url])).toEqual([
      ["ftp://ignored.test mailto:user@test See ", undefined],
      ["HtTpS://one.test/path", "HtTpS://one.test/path"],
      [", then (", undefined],
      ["http://two.test/a_(b)", "http://two.test/a_(b)"],
      [").", undefined],
    ])
  })

  test("preserves interior URL apostrophes while excluding surrounding quotes", () => {
    const content = "Visit https://example.test/it's-valid or 'https://example.test/quoted'."

    const result = detectLinks([chunk(content)], { content, highlights: [] })

    expect(result.filter((item) => item.link).map((item) => item.link?.url)).toEqual([
      "https://example.test/it's-valid",
      "https://example.test/quoted",
    ])
  })

  test("excludes concealed formatting markers without stripping literal URL characters", () => {
    for (const marker of ["*", "**", "_", "__", "~~"]) {
      const url = "https://example.test/path_*~"
      const content = `${marker}${url}${marker},`
      const end = marker.length + url.length
      const highlights: SimpleHighlight[] = []
      for (let index = 0; index < marker.length; index++) {
        highlights.push([end + index, end + index + 1, "conceal", { conceal: "" }])
      }

      const result = detectLinks([chunk(url)], {
        content,
        highlights,
        sourceRanges: [{ start: marker.length, end }],
      })

      expect(result[0].link?.url).toBe(url)
    }
  })

  test("does not link bare URLs inside inline or block raw markup", () => {
    const content = "`https://inline.test` https://visible.test ```https://block.test```"
    const inlineStart = content.indexOf("https://inline.test")
    const blockStart = content.indexOf("https://block.test")
    const highlights: SimpleHighlight[] = [
      [inlineStart - 1, inlineStart + "https://inline.test".length + 1, "markup.raw"],
      [blockStart - 3, blockStart + "https://block.test".length + 3, "markup.raw.block"],
    ]

    const result = detectLinks([chunk(content)], { content, highlights })

    expect(result.map((item) => [item.text, item.link?.url])).toEqual([
      ["`https://inline.test` ", undefined],
      ["https://visible.test", "https://visible.test"],
      [" ```https://block.test```", undefined],
    ])
  })

  test("preserves styles and existing links when splitting URL chunks", () => {
    const content = "prefix https://new.test suffix"
    const fg = RGBA.fromInts(10, 20, 30, 255)
    const bg = RGBA.fromInts(40, 50, 60, 255)
    const styled = { ...chunk(content), fg, bg, attributes: 7 }
    const existing = { ...chunk("existing"), link: { url: "https://existing.test" } }

    const result = detectLinks([styled, existing], {
      content: `${content}existing`,
      highlights: [],
      sourceRanges: [
        { start: 0, end: content.length },
        { start: content.length, end: content.length + existing.text.length },
      ],
    })

    expect(result.map((item) => item.text)).toEqual(["prefix ", "https://new.test", " suffix", "existing"])
    expect(result[1].link).toEqual({ url: "https://new.test" })
    expect(result[3].link).toEqual({ url: "https://existing.test" })
    for (const item of result.slice(0, 3)) {
      expect(item.fg).toBe(fg)
      expect(item.bg).toBe(bg)
      expect(item.attributes).toBe(7)
    }
  })

  test("uses exact source ranges for conceal replacements and repeated visible text", () => {
    const content = "xx [xx](https://example.com) xx"
    const labelStart = content.indexOf("xx", 3)
    const urlStart = content.indexOf("https://")
    const highlights: SimpleHighlight[] = [
      [labelStart, labelStart + 2, "markup.link.label"],
      [labelStart + 2, labelStart + 3, "conceal", { conceal: "xx" }],
      [urlStart, urlStart + "https://example.com".length, "markup.link.url"],
    ]
    const chunks = [chunk("xx "), chunk("xx"), chunk("xx"), chunk("("), chunk("https://example.com"), chunk(" xx")]
    const sourceRanges = [
      { start: 0, end: 3 },
      { start: labelStart, end: labelStart + 2 },
      { start: labelStart + 2, end: labelStart + 3 },
      { start: labelStart + 3, end: labelStart + 4 },
      { start: urlStart, end: urlStart + "https://example.com".length },
      { start: content.length - 3, end: content.length },
    ]

    const result = detectLinks(chunks, { content, highlights, sourceRanges })

    expect(result[0].link).toBeUndefined()
    expect(result[1].link).toEqual({ url: "https://example.com" })
    expect(result[2].link).toBeUndefined()
    expect(result[4].link).toEqual({ url: "https://example.com" })
    expect(result[5].link).toBeUndefined()
  })

  test("does not split replacement text using unrelated source URL offsets", () => {
    const content = "https://hidden.test https://visible.test"
    const firstEnd = content.indexOf(" ")
    const chunks = [chunk("replacement"), chunk(" "), chunk("https://visible.test")]
    const sourceRanges = [
      { start: 0, end: firstEnd },
      { start: firstEnd, end: firstEnd + 1 },
      { start: firstEnd + 1, end: content.length },
    ]

    const result = detectLinks(chunks, { content, highlights: [], sourceRanges })

    expect(result.map((item) => [item.text, item.link?.url])).toEqual([
      ["replacement", undefined],
      [" ", undefined],
      ["https://visible.test", "https://visible.test"],
    ])
  })
})
