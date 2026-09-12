#!/usr/bin/env bun

import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { DOC_LEARNING_SEQUENCES, DOC_MANIFEST } from "../src/lib/docs-manifest"
import { buildDocsIndex, DOC_SECTION_CONFIG, type DocPage } from "../src/lib/docs-index"

const REPO_ROOT = join(import.meta.dir, "../../..")

async function main() {
  try {
    const index = await buildDocsIndex()
    const violations: string[] = []

    for (const page of index.allPages) {
      const source = await readFile(join(REPO_ROOT, page.sourcePath), "utf8")
      const frontmatter = source.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ""
      const heading = source.match(/^#\s+(.+)$/m)?.[1].replace(/`([^`]*)`/g, "$1")

      if (heading !== page.title) {
        violations.push(`${page.sourcePath}: first heading must match title \`${page.title}\``)
      }

      if (!page.description?.trim()) {
        violations.push(`${page.sourcePath}: description must be non-empty`)
      }

      for (const obsoleteField of ["order", "navTitle"]) {
        if (new RegExp(`^${obsoleteField}:`, "m").test(frontmatter)) {
          violations.push(`${page.sourcePath}: ${obsoleteField} belongs in the documentation manifest`)
        }
      }

      for (const lineNumber of findUnescapedCodePipesInTables(source)) {
        violations.push(`${page.sourcePath}:${lineNumber}: escape pipes inside table code spans as \\|`)
      }

      if (!(page.section in DOC_SECTION_CONFIG)) {
        violations.push(`${page.sourcePath}: unknown section \`${page.section}\``)
      }

      if (page.navTitle.trim().length === 0) {
        violations.push(`${page.sourcePath}: manifest navTitle must be non-empty`)
      }

      if (page.canonicalSection.trim().length === 0) {
        violations.push(`${page.sourcePath}: manifest canonicalSection must be non-empty`)
      }

      if (page.status.trim().length === 0) {
        violations.push(`${page.sourcePath}: manifest status must be non-empty`)
      }

      if (page.pageType === "component-reference" && !page.component) {
        violations.push(`${page.sourcePath}: component references require component metadata`)
      }

      if (page.pageType === "component-reference" && !/^## Availability$/m.test(source)) {
        violations.push(`${page.sourcePath}: component references require an Availability section`)
      }

      if (page.component && !source.includes(`\`${page.component.coreRenderable}\``)) {
        violations.push(`${page.sourcePath}: Availability must name \`${page.component.coreRenderable}\``)
      }

      if (!Number.isInteger(page.navOrder) || page.navOrder <= 0) {
        violations.push(`${page.sourcePath}: manifest navOrder must be a positive integer`)
      }

      if (page.skill.entry && !page.skill.include) {
        violations.push(`${page.sourcePath}: skill.entry requires skill.include !== false`)
      }

      if (page.skill.entry && page.skill.intents.length === 0) {
        violations.push(`${page.sourcePath}: skill.entry requires at least one skill intent`)
      }

      const duplicateIntents = findDuplicates(page.skill.intents)
      for (const intent of duplicateIntents) {
        violations.push(`${page.sourcePath}: duplicate skill intent \`${intent}\``)
      }

      for (const field of ["packages", "runtimes"] as const) {
        if (page[field].length === 0) {
          violations.push(`${page.sourcePath}: manifest ${field} must not be empty`)
        }
      }

      for (const field of ["packages", "runtimes", "searchSymbols", "related"] as const) {
        for (const duplicate of findDuplicates(page[field])) {
          violations.push(`${page.sourcePath}: duplicate manifest ${field} value \`${duplicate}\``)
        }
      }

      for (const related of page.related) {
        if (!(related in DOC_MANIFEST)) {
          violations.push(`${page.sourcePath}: unknown related page \`${related}\``)
        }
        if (related === page.sourceId) {
          violations.push(`${page.sourcePath}: related pages must not include the page itself`)
        }
      }
    }

    addDuplicateKeyViolations(index.allPages, (page) => page.slug, "slug", violations)
    addDuplicateKeyViolations(index.allPages, (page) => page.url, "url", violations)
    addDuplicateKeyViolations(index.allPages, (page) => page.sourcePath, "sourcePath", violations)
    addManifestCoverageViolations(index.allPages, violations)
    addOrderCollisionViolations(index.allPages, violations)
    addOrderSequenceViolations(index.allPages, violations)
    addLearningSequenceViolations(violations)

    if (violations.length > 0) {
      console.error("Metadata validation failed:\n")
      for (const violation of violations.sort()) {
        console.error(`- ${violation}`)
      }
      process.exit(1)
    }

    console.log(`Metadata validation passed for ${index.allPages.length} docs.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

function addDuplicateKeyViolations(
  pages: DocPage[],
  getKey: (page: DocPage) => string,
  label: string,
  violations: string[],
) {
  const grouped = new Map<string, DocPage[]>()

  for (const page of pages) {
    const key = getKey(page)
    grouped.set(key, [...(grouped.get(key) ?? []), page])
  }

  for (const [key, matches] of grouped) {
    if (matches.length < 2) {
      continue
    }

    violations.push(`duplicate ${label} \`${key}\`: ${matches.map((page) => page.sourcePath).join(", ")}`)
  }
}

function addOrderCollisionViolations(pages: DocPage[], violations: string[]) {
  const grouped = new Map<string, DocPage[]>()

  for (const page of pages) {
    if (!page.primaryNav || page.draft) continue
    const key = `${page.section}:${page.navOrder}`
    grouped.set(key, [...(grouped.get(key) ?? []), page])
  }

  for (const [key, matches] of grouped) {
    if (matches.length < 2) {
      continue
    }

    const [section, order] = key.split(":")
    violations.push(
      `order collision in ${section} for order ${order}: ${matches.map((page) => page.sourcePath).join(", ")}`,
    )
  }
}

function addOrderSequenceViolations(pages: DocPage[], violations: string[]) {
  for (const section of Object.keys(DOC_SECTION_CONFIG)) {
    const orders = pages
      .filter((page) => page.section === section && page.primaryNav && !page.draft)
      .map((page) => page.navOrder)
      .toSorted((left, right) => left - right)

    for (const [index, order] of orders.entries()) {
      const expected = index + 1
      if (order !== expected) {
        violations.push(`${section}: expected contiguous orders starting at 1; expected ${expected}, found ${order}`)
        break
      }
    }
  }
}

function addManifestCoverageViolations(pages: DocPage[], violations: string[]) {
  const sourceIds = new Set(pages.map((page) => page.sourceId))

  for (const sourceId of Object.keys(DOC_MANIFEST)) {
    if (!sourceIds.has(sourceId)) {
      violations.push(`manifest entry \`${sourceId}\` has no documentation source`)
    }
  }
}

function addLearningSequenceViolations(violations: string[]) {
  const manifestSlugs = new Set(Object.entries(DOC_MANIFEST).map(([sourceId, entry]) => entry.slug ?? sourceId))

  for (const duplicate of findDuplicates(DOC_LEARNING_SEQUENCES.map((sequence) => sequence.id))) {
    violations.push(`duplicate learning sequence id \`${duplicate}\``)
  }

  for (const sequence of DOC_LEARNING_SEQUENCES) {
    for (const duplicate of findDuplicates(sequence.pages)) {
      violations.push(`learning sequence \`${sequence.id}\` contains duplicate page \`${duplicate}\``)
    }

    for (const slug of sequence.pages) {
      if (!manifestSlugs.has(slug)) {
        violations.push(`learning sequence \`${sequence.id}\` contains unknown page \`${slug}\``)
      }
    }
  }
}

function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()

  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value)
      continue
    }

    seen.add(value)
  }

  return [...duplicates]
}

export function findUnescapedCodePipesInTables(source: string): number[] {
  const violations: number[] = []
  const tableBlock: Array<{ line: string; lineNumber: number }> = []
  let fence: { marker: string; length: number } | undefined

  const flushTableBlock = () => {
    if (!tableBlock.some(({ line }) => /^\|(?:\s*:?-{3,}:?\s*\|)+$/.test(line.trim()))) {
      tableBlock.length = 0
      return
    }

    for (const { line, lineNumber } of tableBlock) {
      if ([...line.matchAll(/`([^`]*)`/g)].some((match) => /(^|[^\\])\|/.test(match[1]))) {
        violations.push(lineNumber)
      }
    }
    tableBlock.length = 0
  }

  for (const [index, line] of source.replace(/\r\n/g, "\n").split("\n").entries()) {
    const trimmed = line.trim()
    const fenceMarker = trimmed.match(/^(`{3,}|~{3,})/)?.[1]

    if (!fence && fenceMarker) {
      flushTableBlock()
      fence = { marker: fenceMarker[0], length: fenceMarker.length }
      continue
    }
    if (fence && new RegExp(`^${fence.marker}{${fence.length},}\\s*$`).test(trimmed)) {
      fence = undefined
      continue
    }
    if (fence) continue

    if (trimmed.startsWith("|")) {
      tableBlock.push({ line, lineNumber: index + 1 })
    } else {
      flushTableBlock()
    }
  }

  flushTableBlock()
  return violations
}

if (import.meta.main) main()
