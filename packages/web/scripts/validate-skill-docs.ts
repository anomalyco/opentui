#!/usr/bin/env bun

import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { buildDocsIndex, type DocsIndex } from "../src/lib/docs-index"

interface CodeLine {
  lineNumber: number
  text: string
}

interface CodeFence {
  disabledRules: Set<string>
  language: string
  lines: CodeLine[]
}

interface Violation {
  rule: string
  sourcePath: string
  lineNumber: number
  message: string
}

const REPO_ROOT = join(import.meta.dir, "../../..")
const SKILL_SOURCE_PATH = "packages/web/src/content/SKILL.md"
const SHELL_LANGUAGES = new Set(["bash", "console", "shell", "sh", "zsh"])

async function main() {
  try {
    const index = await buildDocsIndex()
    const violations: Violation[] = []

    for (const page of index.skillPages) {
      const content = await readFile(join(REPO_ROOT, page.sourcePath), "utf8")
      violations.push(...validateSkillDoc(page.sourcePath, content))
    }

    const skillContent = await readFile(join(REPO_ROOT, SKILL_SOURCE_PATH), "utf8")
    violations.push(...validateSkillIndex(index, skillContent))

    if (violations.length > 0) {
      console.error("Skill doc validation failed:\n")
      for (const violation of violations.sort(compareViolations)) {
        console.error(`- [${violation.rule}] ${violation.sourcePath}:${violation.lineNumber}: ${violation.message}`)
      }
      process.exit(1)
    }

    console.log(`Skill doc validation passed for ${index.skillPages.length} docs.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

function validateSkillIndex(index: DocsIndex, content: string): Violation[] {
  const violations: Violation[] = []
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const readingOrder = getSectionLines(lines, "## Reading order by area")
  const routing = getSectionLines(lines, "## Quick routing by intent")
  const entries = getSectionLines(lines, "## Current skill entry pages")

  if (!readingOrder || !routing || !entries) {
    return [
      {
        rule: "skill-index-sections",
        sourcePath: SKILL_SOURCE_PATH,
        lineNumber: 1,
        message: "expected Reading order by area, Quick routing by intent, and Current skill entry pages sections",
      },
    ]
  }

  const readingCounts = new Map<string, number>()
  for (const { lineNumber, text } of readingOrder) {
    for (const match of text.matchAll(/`(\/docs(?:\/[^`]+)?)`/g)) {
      const url = normalizeDocUrl(match[1])
      const page = index.pagesByUrl[url]
      if (!page) {
        violations.push({
          rule: "skill-reading-target",
          sourcePath: SKILL_SOURCE_PATH,
          lineNumber,
          message: `reading-order target ${url} does not exist`,
        })
        continue
      }

      readingCounts.set(page.slug, (readingCounts.get(page.slug) ?? 0) + 1)
      if (!page.skill.entry) {
        violations.push({
          rule: "skill-reading-entry",
          sourcePath: SKILL_SOURCE_PATH,
          lineNumber,
          message: `reading-order target ${url} is not marked skill.entry`,
        })
      }
    }
  }

  const routeCounts = new Map<string, number>()
  for (const { lineNumber, text } of routing) {
    const match = text.match(/^\|\s*(.*?)\s*\|\s*`docs\/(.+)\.mdx`\s*\|$/)
    if (!match || match[1].includes("---")) continue

    const intents = [...match[1].matchAll(/`([^`]+)`/g)].map((intent) => intent[1].trim().toLowerCase())
    const sourceId = match[2]
    const page = index.pagesBySourceId[sourceId]
    if (!page) {
      violations.push({
        rule: "skill-routing-target",
        sourcePath: SKILL_SOURCE_PATH,
        lineNumber,
        message: `routing target docs/${sourceId}.mdx does not exist`,
      })
      continue
    }
    if (!page.skill.entry) {
      violations.push({
        rule: "skill-routing-entry",
        sourcePath: SKILL_SOURCE_PATH,
        lineNumber,
        message: `routing target docs/${sourceId}.mdx is not marked skill.entry`,
      })
    }

    routeCounts.set(page.slug, (routeCounts.get(page.slug) ?? 0) + 1)
    if (!sameStringSet(intents, page.skill.intents)) {
      violations.push({
        rule: "skill-routing-intents",
        sourcePath: SKILL_SOURCE_PATH,
        lineNumber,
        message: `routing intents for docs/${sourceId}.mdx must match metadata: ${page.skill.intents.join(", ")}`,
      })
    }
  }

  const entryCounts = new Map<string, number>()
  for (const { lineNumber, text } of entries) {
    const match = text.match(/^- `docs\/(.+)\.mdx`$/)
    if (!match) continue
    const sourceId = match[1]
    const page = index.pagesBySourceId[sourceId]
    if (!page) {
      violations.push({
        rule: "skill-entry-target",
        sourcePath: SKILL_SOURCE_PATH,
        lineNumber,
        message: `entry target docs/${sourceId}.mdx does not exist`,
      })
    } else {
      entryCounts.set(page.slug, (entryCounts.get(page.slug) ?? 0) + 1)
    }
    if (page && !page.skill.entry) {
      violations.push({
        rule: "skill-entry-metadata",
        sourcePath: SKILL_SOURCE_PATH,
        lineNumber,
        message: `docs/${sourceId}.mdx is listed as an entry but is not marked skill.entry`,
      })
    }
  }

  for (const page of index.skillEntryPages) {
    const readingCount = readingCounts.get(page.slug) ?? 0
    const routeCount = routeCounts.get(page.slug) ?? 0
    const entryCount = entryCounts.get(page.slug) ?? 0
    if (readingCount !== 1) {
      violations.push({
        rule: "skill-reading-coverage",
        sourcePath: SKILL_SOURCE_PATH,
        lineNumber: readingOrder[0]?.lineNumber ?? 1,
        message: `${page.sourcePath} must appear exactly once in reading order; found ${readingCount}`,
      })
    }
    if (routeCount !== 1) {
      violations.push({
        rule: "skill-routing-coverage",
        sourcePath: SKILL_SOURCE_PATH,
        lineNumber: routing[0]?.lineNumber ?? 1,
        message: `${page.sourcePath} must appear exactly once in quick routing; found ${routeCount}`,
      })
    }
    if (entryCount !== 1) {
      violations.push({
        rule: "skill-entry-coverage",
        sourcePath: SKILL_SOURCE_PATH,
        lineNumber: entries[0]?.lineNumber ?? 1,
        message: `${page.sourcePath} must appear exactly once in the entry list; found ${entryCount}`,
      })
    }
  }

  return violations
}

function normalizeDocUrl(url: string): "/docs" | `/docs/${string}` {
  return (url.endsWith("/") ? url.slice(0, -1) : url) as "/docs" | `/docs/${string}`
}

function getSectionLines(lines: string[], heading: string): Array<{ lineNumber: number; text: string }> | undefined {
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start === -1) return undefined

  const section: Array<{ lineNumber: number; text: string }> = []
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index].startsWith("## ")) break
    section.push({ lineNumber: index + 1, text: lines[index].trim() })
  }
  return section
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const values = new Set(left)
  return values.size === left.length && right.every((value) => values.has(value))
}

function validateSkillDoc(sourcePath: string, content: string): Violation[] {
  const violations: Violation[] = []
  const pendingDisables: string[] = []

  let fence: { marker: string; length: number; data: CodeFence } | undefined

  for (const [index, line] of content.replace(/\r\n/g, "\n").split("\n").entries()) {
    const lineNumber = index + 1
    const trimmed = line.trim()
    const disableMatch = trimmed.match(/^(?:<!--|\{\/\*)\s*docs-lint-disable\s+([a-z0-9-]+)\s*(?:-->|\*\/\})$/)

    if (disableMatch) {
      pendingDisables.push(disableMatch[1])
      continue
    }

    const fenceMarker = getFenceMarker(trimmed)
    if (!fence && fenceMarker) {
      fence = {
        marker: fenceMarker.marker,
        length: fenceMarker.length,
        data: {
          disabledRules: new Set(pendingDisables.splice(0)),
          language: getFenceLanguage(trimmed),
          lines: [],
        },
      }
      continue
    }

    if (fence && closesFence(trimmed, fence)) {
      violations.push(...validateCodeFence(sourcePath, fence.data))
      fence = undefined
      continue
    }

    if (fence) {
      fence.data.lines.push({ lineNumber, text: line })
      continue
    }

    if (!trimmed) {
      continue
    }

    const disabledRules = new Set(pendingDisables.splice(0))

    if (!disabledRules.has("mdx-esm-import") && /^import\s/.test(trimmed)) {
      violations.push({
        rule: "mdx-esm-import",
        sourcePath,
        lineNumber,
        message: "top-level MDX import statements are not allowed in skill docs",
      })
    }

    if (!disabledRules.has("mdx-esm-export") && /^export\s/.test(trimmed)) {
      violations.push({
        rule: "mdx-esm-export",
        sourcePath,
        lineNumber,
        message: "top-level MDX export statements are not allowed in skill docs",
      })
    }

    if (!disabledRules.has("mdx-component-node") && isProbableMdxNode(trimmed)) {
      violations.push({
        rule: "mdx-component-node",
        sourcePath,
        lineNumber,
        message: "rendered JSX/MDX component nodes are not allowed outside fenced code blocks",
      })
    }
  }

  return violations
}

function validateCodeFence(sourcePath: string, fence: CodeFence): Violation[] {
  const violations: Violation[] = []

  for (const line of fence.lines) {
    if (!fence.disabledRules.has("process-exit-example") && line.text.includes("process.exit(")) {
      violations.push({
        rule: "process-exit-example",
        sourcePath,
        lineNumber: line.lineNumber,
        message: "prefer renderer.destroy() over process.exit() in positive examples",
      })
    }

    if (fence.disabledRules.has("non-bun-setup-command")) {
      continue
    }

    if (!SHELL_LANGUAGES.has(fence.language)) {
      continue
    }

    if (/\bnpm install\b|\byarn(?:\s|$)|\bpnpm(?:\s|$)|\bnode\s+/.test(line.text)) {
      violations.push({
        rule: "non-bun-setup-command",
        sourcePath,
        lineNumber: line.lineNumber,
        message: "use Bun-native setup commands in runnable examples",
      })
    }
  }

  return violations
}

function getFenceMarker(line: string): { marker: string; length: number } | undefined {
  const match = line.match(/^(`{3,}|~{3,})/)
  if (!match) {
    return undefined
  }

  return { marker: match[1][0], length: match[1].length }
}

function getFenceLanguage(line: string): string {
  const match = line.match(/^(`{3,}|~{3,})([^\s]*)/)
  return match?.[2]?.trim().toLowerCase() ?? ""
}

function closesFence(line: string, fence: { marker: string; length: number }): boolean {
  const pattern = new RegExp(`^${fence.marker}{${fence.length},}\\s*$`)
  return pattern.test(line)
}

function isProbableMdxNode(line: string): boolean {
  if (!line.startsWith("<") || line.startsWith("<!--")) {
    return false
  }

  return /^<\/?[A-Za-z][A-Za-z0-9:_-]*(\s|>|\/)/.test(line)
}

function compareViolations(left: Violation, right: Violation): number {
  if (left.sourcePath !== right.sourcePath) {
    return left.sourcePath.localeCompare(right.sourcePath)
  }

  if (left.lineNumber !== right.lineNumber) {
    return left.lineNumber - right.lineNumber
  }

  return left.rule.localeCompare(right.rule)
}

main()
