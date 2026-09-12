#!/usr/bin/env bun

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { getFenceMarker, closesFence, slugifyHeading } from "../src/lib/docs-headings"
import { buildDocsIndex } from "../src/lib/docs-index"
import { parsePackageEntryFile } from "./package-entry-file"

interface HeadingInfo {
  anchor: string
  lineNumber: number
}

interface LinkInfo {
  target: string
  lineNumber: number
}

interface RepositoryPathInfo {
  path: string
  lineNumber: number
}

const REPO_ROOT = join(import.meta.dir, "../../..")
const PACKAGE_DOCS_ROOT = join(REPO_ROOT, "packages/web/src/content/packages")

async function main() {
  try {
    const index = await buildDocsIndex()
    const anchorsBySlug = new Map<string, Set<string>>()
    const incomingLinks = new Map(index.pages.map((page) => [page.slug, 0]))
    const violations: string[] = []

    for (const page of index.pages) {
      const content = await readFile(join(REPO_ROOT, page.sourcePath), "utf8")
      const headings = collectHeadings(content)
      anchorsBySlug.set(page.slug, new Set(headings.map((heading) => heading.anchor)))
    }

    const packageFiles = (await readdir(PACKAGE_DOCS_ROOT)).filter((file) => file.endsWith(".mdx"))
    for (const file of packageFiles) {
      const sourcePath = `packages/web/src/content/packages/${file}`
      const filePath = join(PACKAGE_DOCS_ROOT, file)
      const [content, packageEntry] = await Promise.all([readFile(filePath, "utf8"), parsePackageEntryFile(filePath)])
      const frontmatterDocLinks = [
        ...(packageEntry.surfaces ?? []).flatMap((surface) => (surface.docs ? [surface.docs] : [])),
        ...(packageEntry.links?.docs ? [packageEntry.links.docs] : []),
      ].map((target) => ({ target, lineNumber: 1 }))

      for (const repositoryPath of collectRepositoryPaths(content)) {
        violations.push(
          `${sourcePath}:${repositoryPath.lineNumber}: replace repository path with a stable web URL (${repositoryPath.path})`,
        )
      }

      for (const link of [...collectLinks(content), ...frontmatterDocLinks]) {
        const target = link.target.trim()
        if (!isDocUrl(target)) continue

        const { url, anchor } = normalizeDocTarget(target)
        const linkedPage = index.pagesByUrl[url]
        if (!linkedPage) {
          violations.push(`${sourcePath}:${link.lineNumber}: unresolved doc link ${target}`)
          continue
        }

        if (anchor && !(anchorsBySlug.get(linkedPage.slug) ?? new Set()).has(anchor)) {
          violations.push(`${sourcePath}:${link.lineNumber}: unresolved doc anchor ${target}`)
        }
      }
    }

    for (const page of index.pages) {
      const content = await readFile(join(REPO_ROOT, page.sourcePath), "utf8")

      for (const repositoryPath of collectRepositoryPaths(content)) {
        violations.push(
          `${page.sourcePath}:${repositoryPath.lineNumber}: replace repository path with a stable web URL (${repositoryPath.path})`,
        )
      }

      for (const link of collectLinks(content)) {
        const target = link.target.trim()

        if (isExternalLink(target)) {
          continue
        }

        if (target.startsWith("packages/web/src/content/docs/")) {
          violations.push(
            `${page.sourcePath}:${link.lineNumber}: use /docs/... URLs instead of repo file paths (${target})`,
          )
          continue
        }

        if (page.skill.include && isRelativeDocLink(target)) {
          violations.push(`${page.sourcePath}:${link.lineNumber}: use /docs/... URLs for cross-doc links (${target})`)
          continue
        }

        if (target.startsWith("#")) {
          const anchor = normalizeAnchor(target.slice(1))
          const anchors = anchorsBySlug.get(page.slug) ?? new Set<string>()
          if (!anchors.has(anchor)) {
            violations.push(`${page.sourcePath}:${link.lineNumber}: unresolved local anchor #${anchor}`)
          }
          continue
        }

        if (!isDocUrl(target)) {
          continue
        }

        const { url, anchor } = normalizeDocTarget(target)
        const linkedPage = index.pagesByUrl[url]
        if (!linkedPage) {
          violations.push(`${page.sourcePath}:${link.lineNumber}: unresolved doc link ${target}`)
          continue
        }

        if (linkedPage.slug !== page.slug) {
          incomingLinks.set(linkedPage.slug, (incomingLinks.get(linkedPage.slug) ?? 0) + 1)
        }

        if (!anchor) {
          continue
        }

        const anchors = anchorsBySlug.get(linkedPage.slug) ?? new Set<string>()
        if (!anchors.has(anchor)) {
          violations.push(`${page.sourcePath}:${link.lineNumber}: unresolved doc anchor ${target}`)
        }
      }
    }

    for (const page of index.pages) {
      if ((incomingLinks.get(page.slug) ?? 0) === 0) {
        violations.push(`${page.sourcePath}: no incoming link from another documentation page`)
      }
    }

    if (violations.length > 0) {
      console.error("Link validation failed:\n")
      for (const violation of violations.sort()) {
        console.error(`- ${violation}`)
      }
      process.exit(1)
    }

    console.log(`Link validation passed for ${index.pages.length} docs and ${packageFiles.length} package profiles.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

function collectHeadings(content: string): HeadingInfo[] {
  const headings: HeadingInfo[] = []
  const anchorCounts = new Map<string, number>()
  let fence: { marker: string; length: number } | undefined

  for (const [index, line] of content.replace(/\r\n/g, "\n").split("\n").entries()) {
    const trimmed = line.trim()
    const fenceMarker = getFenceMarker(trimmed)

    if (!fence && fenceMarker) {
      fence = fenceMarker
      continue
    }

    if (fence && closesFence(trimmed, fence)) {
      fence = undefined
      continue
    }

    if (fence) {
      continue
    }

    const match = trimmed.match(/^(#{1,6})\s+(.*)$/)
    if (!match) {
      continue
    }

    const baseAnchor = slugifyHeading(match[2])
    if (!baseAnchor) {
      continue
    }

    const duplicateIndex = anchorCounts.get(baseAnchor) ?? 0
    anchorCounts.set(baseAnchor, duplicateIndex + 1)

    headings.push({
      anchor: duplicateIndex === 0 ? baseAnchor : `${baseAnchor}-${duplicateIndex}`,
      lineNumber: index + 1,
    })
  }

  return headings
}

function collectLinks(content: string): LinkInfo[] {
  const links: LinkInfo[] = []
  let fence: { marker: string; length: number } | undefined

  for (const [index, line] of content.replace(/\r\n/g, "\n").split("\n").entries()) {
    const trimmed = line.trim()
    const fenceMarker = getFenceMarker(trimmed)

    if (!fence && fenceMarker) {
      fence = fenceMarker
      continue
    }

    if (fence && closesFence(trimmed, fence)) {
      fence = undefined
      continue
    }

    if (fence) {
      continue
    }

    const linkPattern = /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
    let match: RegExpExecArray | null
    while ((match = linkPattern.exec(line)) !== null) {
      links.push({ target: match[1], lineNumber: index + 1 })
    }
  }

  return links
}

function collectRepositoryPaths(content: string): RepositoryPathInfo[] {
  const paths: RepositoryPathInfo[] = []
  let fence: { marker: string; length: number } | undefined

  for (const [index, line] of content.replace(/\r\n/g, "\n").split("\n").entries()) {
    const trimmed = line.trim()
    const fenceMarker = getFenceMarker(trimmed)

    if (!fence && fenceMarker) {
      fence = fenceMarker
      continue
    }

    if (fence && closesFence(trimmed, fence)) {
      fence = undefined
      continue
    }

    if (fence) continue

    for (const match of line.matchAll(/`(packages\/[^`]+)`/g)) {
      paths.push({ path: match[1], lineNumber: index + 1 })
    }
  }

  return paths
}

export { slugifyHeading }

function isExternalLink(target: string): boolean {
  return /^(https?:\/\/|mailto:)/.test(target)
}

function isRelativeDocLink(target: string): boolean {
  return target.startsWith("./") || target.startsWith("../") || target.endsWith(".md") || target.endsWith(".mdx")
}

function isDocUrl(target: string): boolean {
  return target === "/docs" || target.startsWith("/docs/") || target.startsWith("/docs#") || target.startsWith("/docs?")
}

function normalizeDocTarget(target: string): { url: "/docs" | `/docs/${string}`; anchor?: string } {
  const [pathPart, anchorPart] = target.split("#", 2)
  const pathWithoutQuery = pathPart.split("?", 1)[0]
  const normalizedPath = pathWithoutQuery.endsWith("/") ? pathWithoutQuery.slice(0, -1) : pathWithoutQuery

  return {
    url: normalizedPath as "/docs" | `/docs/${string}`,
    anchor: anchorPart ? normalizeAnchor(anchorPart) : undefined,
  }
}

function normalizeAnchor(anchor: string): string {
  return decodeURIComponent(anchor).trim().toLowerCase()
}

if (import.meta.main) main()
