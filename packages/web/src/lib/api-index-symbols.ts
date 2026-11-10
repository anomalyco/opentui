// Reads which documentation page documents each exported symbol from the tables in reference/api-index.mdx. A
// "## `@opentui/<package>`" or "## `opentui.h`" heading names the module of the rows below it. Under a "###"
// heading, a paragraph that starts with a module name, such as "`@opentui/core/testing` works in Bun", names it
// instead, and its first /docs link is the page of rows without one. A "Package entry point" column names the row's
// module. The site uses the result to link API reference entries to guides and to list API changes on the pages that
// document them.

export interface DocumentedSymbol {
  /** Module specifier, such as @opentui/core or @opentui/core/testing, or opentui.h. */
  module: string
  /** Exported name. */
  name: string
  /** Logical documentation page URL, without a fragment. */
  page: string
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
// A module name in backticks: an npm specifier or the C ABI's header.
const MODULE = /`(@opentui\/[^`]+|opentui\.h)`/
const LEADING_MODULE = new RegExp(`^${MODULE.source}`)

export function documentedSymbols(source: string): DocumentedSymbol[] {
  const symbols: DocumentedSymbol[] = []
  let packageModule: string | undefined
  let module: string | undefined
  let sectionPage: string | undefined
  let header: string[] | undefined

  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    const heading = line.match(/^(##+)\s+(.*)$/)
    if (heading) {
      if (heading[1] === "##") packageModule = heading[2].match(MODULE)?.[1]
      module = packageModule
      sectionPage = undefined
      header = undefined
      continue
    }
    if (!line.startsWith("|")) {
      header = undefined
      const named = line.match(LEADING_MODULE)?.[1]
      if (named) module = named
      sectionPage ??= firstDocsLink(line)
      continue
    }

    const cells = splitRow(line)
    if (!header) {
      header = cells.map((cell) => cell.toLowerCase())
      continue
    }
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue

    const symbolColumn = header.indexOf("symbols")
    if (symbolColumn === -1) continue
    const entryColumn = header.indexOf("package entry point")
    const docsColumn = header.indexOf("canonical documentation")

    const rowModule = entryColumn === -1 ? module : (cells[entryColumn]?.match(MODULE)?.[1] ?? module)
    const page = firstDocsLink(docsColumn === -1 ? line : (cells[docsColumn] ?? "")) ?? sectionPage
    if (!rowModule || !page) continue

    for (const match of (cells[symbolColumn] ?? "").matchAll(/`([^`]+)`/g)) {
      const name = match[1].replace(/\(\)$/, "")
      if (IDENTIFIER.test(name)) symbols.push({ module: rowModule, name, page })
    }
  }

  return symbols
}

function splitRow(line: string): string[] {
  const cells: string[] = []
  let cell = ""
  let code = false
  for (let index = 1; index < line.length; index++) {
    const char = line[index]
    if (char === "\\" && line[index + 1] === "|") {
      cell += "|"
      index++
    } else if (char === "`") {
      code = !code
      cell += char
    } else if (char === "|" && !code) {
      cells.push(cell.trim())
      cell = ""
    } else {
      cell += char
    }
  }
  return cells
}

function firstDocsLink(text: string): string | undefined {
  const url = text.match(/\]\((\/docs(?:[/?#][^)\s]*)?)\)/)?.[1]
  return url === undefined ? undefined : url.replace(/[?#].*$/, "").replace(/\/+$/, "") || "/docs"
}
