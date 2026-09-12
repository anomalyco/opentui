import { beforeAll, describe, expect, test } from "bun:test"

import { buildDocsSearchIndex, searchEntriesForPage } from "./docs-search-index"
import { highlightParts, lookup, preview, score, type SearchEntry } from "./docs-search"

const rendererPage = {
  title: "Renderer",
  navTitle: "Renderer",
  url: "/docs/core-concepts/renderer" as const,
  description: "Create a CliRenderer, attach its root, and choose a render schedule",
  searchSymbols: ["CliRenderer", "createCliRenderer"],
}

const rendererSource = `
import Foo from "bar"

# Renderer

\`CliRenderer\` owns one terminal session.

## Create a renderer

\`createCliRenderer()\` runs asynchronous terminal setup.

\`\`\`typescript
const renderer = await createCliRenderer()
\`\`\`

### Nested details

The root always tracks the render width.

<ScrollbackRecording
  label="should not be indexed"
/>

## Choose a screen mode

\`screenMode\` controls which terminal area OpenTUI owns. \`split-footer\` uses a footer.
`.trim()

describe("documentation search index", () => {
  test("splits pages on headings and strips markup, imports, and components", () => {
    const entries = searchEntriesForPage(rendererPage, rendererSource)

    expect(entries.map((entry) => ({ title: entry.title, url: entry.url }))).toEqual([
      { title: "Renderer", url: "/docs/core-concepts/renderer" },
      { title: "Create a renderer", url: "/docs/core-concepts/renderer#create-a-renderer" },
      { title: "Nested details", url: "/docs/core-concepts/renderer#nested-details" },
      { title: "Choose a screen mode", url: "/docs/core-concepts/renderer#choose-a-screen-mode" },
    ])

    expect(entries[0].text).toContain("CliRenderer owns one terminal session")
    expect(entries[0].text).toContain("createCliRenderer")
    expect(entries[0].navTitle).toBe("Renderer")
    expect(entries[0].symbols).toEqual(["CliRenderer", "createCliRenderer"])
    expect(entries[1].navTitle).toBe("")
    expect(entries[1].symbols).toEqual([])
    expect(entries[1].text).toContain("const renderer = await createCliRenderer()")
    expect(entries.some((entry) => entry.text.includes("Foo from"))).toBe(false)
    expect(entries.some((entry) => entry.text.includes("should not be indexed"))).toBe(false)
  })

  test("keeps a page-level entry when the title has no body of its own", () => {
    const entries = searchEntriesForPage(
      {
        title: "Input",
        navTitle: "Input",
        url: "/docs/components/input",
        description: "One line of text",
        searchSymbols: ["InputRenderable"],
      },
      "# Input\n\n## Availability\n\n`InputRenderable` is built in.\n",
    )

    expect(entries[0]).toEqual({
      chapter: "Input",
      title: "Input",
      navTitle: "Input",
      url: "/docs/components/input",
      text: "One line of text InputRenderable",
      symbols: ["InputRenderable"],
    })
    expect(entries[1]?.url).toBe("/docs/components/input#availability")
  })

  test("indexes published documentation pages", async () => {
    const entries = await buildDocsSearchIndex()
    expect(entries.length).toBeGreaterThan(100)
    expect(entries.some((entry) => entry.url === "/docs" && entry.title === "Getting started")).toBe(true)
    expect(entries.some((entry) => entry.url.startsWith("/docs/core-concepts/renderer#"))).toBe(true)
  })
})

describe("documentation search matching", () => {
  const entries = searchEntriesForPage(rendererPage, rendererSource)

  test("matches from the start of a word and ranks headings above body text", () => {
    const [first] = lookup(entries, "create")

    expect(first?.entry.title).toBe("Create a renderer")
    expect(lookup(entries, "ender")).toEqual([])
  })

  test("treats hyphens in the text as optional", () => {
    expect(lookup(entries, "splitfooter")[0]?.entry.title).toBe("Choose a screen mode")
  })

  test("requires every term and prefers a contiguous phrase", () => {
    const matches = lookup(entries, "create renderer")

    expect(matches[0]?.entry.title).toBe("Create a renderer")
    expect(lookup(entries, "create missing")).toEqual([])
  })

  test("builds a preview around the first match and marks the hit", () => {
    const [match] = lookup(entries, "screenMode")
    if (!match) throw new Error("expected a match")

    const snippet = preview(match.entry.text, match.pattern)
    expect(snippet).toContain("screenMode")
    expect(highlightParts(snippet, match.pattern).some((part) => part.mark && part.text.startsWith("screenMode"))).toBe(
      true,
    )
  })
})

describe("documentation search ranking", () => {
  const pattern = (query: string) => {
    const [match] = lookup(
      [entry({ title: "Probe", url: "/docs/probe", text: query, navTitle: query, symbols: [query] })],
      query,
    )
    if (!match) throw new Error(`expected a pattern for ${query}`)
    return match.pattern
  }

  test("identity bands cannot be crossed by body frequency", () => {
    const react = pattern("react")
    const page = entry({
      title: "React bindings",
      navTitle: "React",
      url: "/docs/bindings/react",
      text: "React",
    })
    const heading = entry({
      title: "What React adds",
      url: "/docs/plugins/react#what-react-adds",
      text: "React ".repeat(50),
    })
    const noisy = entry({
      title: "Unrelated",
      url: "/docs/unrelated",
      text: "React ".repeat(50),
    })

    expect(score(page, react)).toBeGreaterThan(score(heading, react))
    expect(score(heading, react)).toBeGreaterThan(score(noisy, react))
  })

  test("an exact page title beats an exact heading title", () => {
    const input = pattern("input")
    const page = entry({ title: "Input", url: "/docs/components/input" })
    const heading = entry({ title: "Input", url: "/docs/core-concepts/keyboard#input" })

    expect(score(page, input)).toBeGreaterThan(score(heading, input))
  })

  test("among pages with the same nav title, the shorter page title wins", () => {
    const react = pattern("react")
    const nav = entry({ title: "React bindings", navTitle: "React", url: "/docs/bindings/react" })
    const longer = entry({ title: "React keymap integration", navTitle: "React", url: "/docs/keymap/react" })

    expect(score(nav, react)).toBeGreaterThan(score(longer, react))
  })

  test("an exact symbol beats a body mention of that symbol", () => {
    const query = pattern("createCliRenderer")
    const page = entry({
      title: "Renderer",
      url: "/docs/core-concepts/renderer",
      symbols: ["createCliRenderer"],
    })
    const other = entry({
      title: "Getting started",
      url: "/docs",
      symbols: ["createCliRenderer"],
    })
    const mention = entry({
      title: "Quick start",
      url: "/docs/bindings/react#quick-start",
      text: "createCliRenderer ".repeat(20),
    })

    expect(score(page, query)).toBeGreaterThan(score(other, query))
    expect(score(other, query)).toBeGreaterThan(score(mention, query))
  })

  test("a shorter title that still contains every term ranks above a longer one", () => {
    const create = pattern("create")
    const short = entry({ title: "Create a renderer", url: "/docs/core-concepts/renderer#create-a-renderer" })
    const long = entry({
      title: "Create a renderer with extra options",
      url: "/docs/core-concepts/renderer#create-a-renderer-with-extra-options",
    })

    expect(score(short, create)).toBeGreaterThan(score(long, create))
  })

  test("a prefix of a page title beats a one-word heading with the same prefix", () => {
    const rea = pattern("rea")
    const page = entry({ title: "React bindings", navTitle: "React", url: "/docs/bindings/react" })
    const heading = entry({ title: "React", url: "/docs/components/image#react" })
    const farther = entry({ title: "Reading", url: "/docs/core-concepts/clipboard#reading" })

    expect(score(page, rea)).toBeGreaterThan(score(heading, rea))
    expect(score(heading, rea)).toBeGreaterThan(score(farther, rea))
  })
})

describe("documentation search ranking against the published index", () => {
  let entries: SearchEntry[]

  beforeAll(async () => {
    entries = await buildDocsSearchIndex()
  })

  test("react prefers the React bindings page over sections that repeat the word", () => {
    const urls = lookup(entries, "react")
      .slice(0, 8)
      .map((match) => match.entry.url)

    expect(urls[0]).toBe("/docs/bindings/react")
    expect(urls).toContain("/docs/keymap/react")
    expect(urls).toContain("/docs/plugins/react")
    expect(urls.indexOf("/docs/keymap/react")).toBeGreaterThan(0)
    expect(urls.findIndex((url) => url.includes("#"))).toBeGreaterThan(urls.indexOf("/docs/bindings/react"))
  })

  test("topic queries prefer the canonical page over a heading of the same name", () => {
    expect(lookup(entries, "input")[0]?.entry.url).toBe("/docs/components/input")
    expect(lookup(entries, "renderer")[0]?.entry.url).toBe("/docs/core-concepts/renderer")
    expect(lookup(entries, "keymap")[0]?.entry.url).toBe("/docs/keymap/overview")
    expect(lookup(entries, "solid")[0]?.entry.url).toBe("/docs/bindings/solid")
  })

  test("symbol queries prefer the page that owns the symbol", () => {
    expect(lookup(entries, "createCliRenderer")[0]?.entry.url).toBe("/docs/core-concepts/renderer")
    expect(lookup(entries, "InputRenderable")[0]?.entry.url).toBe("/docs/components/input")
  })

  test("multi-word queries prefer the heading that names the phrase", () => {
    expect(lookup(entries, "react bindings")[0]?.entry.url).toBe("/docs/bindings/react")
    expect(lookup(entries, "react keymap")[0]?.entry.url).toBe("/docs/keymap/react")
    expect(lookup(entries, "create renderer")[0]?.entry.url).toBe("/docs/core-concepts/renderer#create-a-renderer")
  })

  test("partial queries prefer the nearest page title over a one-word heading", () => {
    expect(lookup(entries, "rea")[0]?.entry.url).toBe("/docs/bindings/react")
    expect(lookup(entries, "reac")[0]?.entry.url).toBe("/docs/bindings/react")
  })
})

function entry(partial: Partial<SearchEntry> & Pick<SearchEntry, "title" | "url">): SearchEntry {
  return {
    chapter: partial.chapter ?? partial.title,
    navTitle: partial.navTitle ?? "",
    text: partial.text ?? "",
    symbols: partial.symbols ?? [],
    ...partial,
  }
}
