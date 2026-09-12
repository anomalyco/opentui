import { readdir, readFile } from "node:fs/promises"
import { basename, dirname, join, relative, sep } from "node:path"
import {
  DOC_LEARNING_SEQUENCES,
  DOC_MANIFEST,
  DOC_SECTIONS,
  type ComponentMetadata,
  type DocAvailability,
  type DocLearningSequence,
  type DocPageType,
  type DocSectionId,
} from "./docs-manifest"

export type { DocPageType, DocSectionId } from "./docs-manifest"

export interface SkillMetadata {
  include: boolean
  entry: boolean
  intents: string[]
}

export interface DocPage {
  sourceId: string
  slug: string
  url: "/docs" | `/docs/${string}`
  sourcePath: string
  canonicalSection: string
  conceptualGroup?: string
  section: DocSectionId
  group?: string
  title: string
  navTitle: string
  description?: string
  navOrder: number
  pageType: DocPageType
  status: string
  component?: ComponentMetadata
  primaryNav: boolean
  packages: string[]
  availability: DocAvailability
  runtimes: string[]
  searchSymbols: string[]
  related: string[]
  draft: boolean
  skill: SkillMetadata
}

export interface DocSection {
  id: DocSectionId
  title: string
  order: number
  pages: DocPage[]
}

export interface DocsIndex {
  allPages: DocPage[]
  pages: DocPage[]
  pagesBySourceId: Record<string, DocPage>
  pagesBySlug: Record<string, DocPage>
  pagesByUrl: Record<string, DocPage>
  sections: DocSection[]
  learningSequences: DocLearningSequence[]
  skillPages: DocPage[]
  skillEntryPages: DocPage[]
  intentIndex: Record<string, DocPage[]>
}

interface RawSkillMetadata {
  include?: unknown
  entry?: unknown
  intents?: unknown
}

interface RawDocMetadata {
  title?: unknown
  description?: unknown
  draft?: unknown
  skill?: unknown
}

const WORKING_DIRECTORY = process.cwd()
const REPO_ROOT =
  basename(WORKING_DIRECTORY) === "web" && basename(dirname(WORKING_DIRECTORY)) === "packages"
    ? join(WORKING_DIRECTORY, "../..")
    : WORKING_DIRECTORY
const DOCS_ROOT = join(REPO_ROOT, "packages/web/src/content/docs")

export const DOC_SECTION_CONFIG = Object.fromEntries(
  DOC_SECTIONS.map((section) => [section.id, { title: section.title, order: section.order }]),
) as Record<DocSectionId, { title: string; order: number }>

let docsIndexPromise: Promise<DocsIndex> | undefined

export async function buildDocsIndex(): Promise<DocsIndex> {
  if (import.meta.env.DEV) return loadDocsIndex()

  docsIndexPromise ??= loadDocsIndex()
  return docsIndexPromise
}

export function getDocBySlug(index: DocsIndex, slug: string): DocPage | undefined {
  return index.pagesBySlug[slug]
}

export function getDocByUrl(index: DocsIndex, url: string): DocPage | undefined {
  return index.pagesByUrl[normalizeDocUrl(url)]
}

export function getDocsForIntent(index: DocsIndex, intent: string): DocPage[] {
  return index.intentIndex[normalizeIntent(intent)] ?? []
}

export function getPrevNextDocSequences(
  index: DocsIndex,
  slug: string,
): Array<{ prev?: DocPage; next?: DocPage; sequence: DocLearningSequence }> {
  return index.learningSequences.flatMap((sequence) => {
    const pageIndex = sequence.pages.indexOf(slug)
    if (pageIndex === -1) return []

    return [
      {
        prev: pageIndex > 0 ? index.pagesBySlug[sequence.pages[pageIndex - 1]] : undefined,
        next: pageIndex < sequence.pages.length - 1 ? index.pagesBySlug[sequence.pages[pageIndex + 1]] : undefined,
        sequence,
      },
    ]
  })
}

async function loadDocsIndex(): Promise<DocsIndex> {
  const sourceFiles = await listDocFiles(DOCS_ROOT)
  const allPages = await Promise.all(sourceFiles.map((filePath) => buildDocPage(filePath)))
  const pages = allPages.filter((page) => !page.draft)

  allPages.sort(comparePages)
  pages.sort(comparePages)

  const sections = DOC_SECTIONS.map((section) => ({
    id: section.id,
    title: section.title,
    order: section.order,
    pages: pages.filter((page) => page.section === section.id && page.primaryNav),
  })).filter((section) => section.pages.length > 0)

  const pagesBySourceId = Object.fromEntries(pages.map((page) => [page.sourceId, page]))
  const pagesBySlug = Object.fromEntries(pages.map((page) => [page.slug, page]))
  const pagesByUrl = Object.fromEntries(pages.map((page) => [page.url, page]))
  const skillPages = pages.filter((page) => page.skill.include)
  const skillEntryPages = pages.filter((page) => page.skill.include && page.skill.entry)
  const intentIndex = buildIntentIndex(skillPages)

  return {
    allPages,
    pages,
    pagesBySourceId,
    pagesBySlug,
    pagesByUrl,
    sections,
    learningSequences: DOC_LEARNING_SEQUENCES,
    skillPages,
    skillEntryPages,
    intentIndex,
  }
}

async function buildDocPage(filePath: string): Promise<DocPage> {
  const source = await readFile(filePath, "utf8")
  const { data } = parseFrontmatter(source, filePath)
  const raw = data as RawDocMetadata

  if (typeof raw.title !== "string") {
    throw new Error(`Missing or invalid title in ${toSourcePath(filePath)}`)
  }
  if (raw.description !== undefined && typeof raw.description !== "string") {
    throw new Error(`Invalid description in ${toSourcePath(filePath)}`)
  }
  if (raw.draft !== undefined && typeof raw.draft !== "boolean") {
    throw new Error(`Invalid draft in ${toSourcePath(filePath)}`)
  }

  const sourcePath = toSourcePath(filePath)
  const sourceId = toSourceId(filePath)
  const manifest = DOC_MANIFEST[sourceId as keyof typeof DOC_MANIFEST]
  if (!manifest) {
    throw new Error(`Missing documentation manifest entry for ${sourcePath}`)
  }

  const slug = manifest.slug ?? sourceId
  const skill = normalizeSkill(raw.skill, sourcePath)

  return {
    sourceId,
    slug,
    url: manifest.url ?? `/docs/${slug}`,
    sourcePath,
    canonicalSection: manifest.canonicalSection,
    conceptualGroup: manifest.conceptualGroup,
    section: manifest.section,
    group: manifest.group,
    title: raw.title,
    navTitle: manifest.navTitle,
    description: typeof raw.description === "string" ? raw.description : undefined,
    navOrder: manifest.navOrder,
    pageType: manifest.pageType,
    status: manifest.status,
    component: manifest.component ? { ...manifest.component } : undefined,
    primaryNav: manifest.primaryNav,
    packages: [...manifest.packages],
    availability: { ...manifest.availability },
    runtimes: [...manifest.runtimes],
    searchSymbols: [...manifest.searchSymbols],
    related: [...manifest.related],
    draft: raw.draft === true,
    skill,
  }
}

async function listDocFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const filePath = join(dir, entry.name)

      if (entry.isDirectory()) {
        return listDocFiles(filePath)
      }

      return entry.name.endsWith(".mdx") ? [filePath] : []
    }),
  )

  return files.flat()
}

function parseFrontmatter(source: string, filePath: string): { data: Record<string, unknown>; content: string } {
  const normalizedSource = source.replace(/\r\n/g, "\n")
  const match = normalizedSource.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)

  if (!match) {
    throw new Error(`Expected frontmatter in ${toSourcePath(filePath)}`)
  }

  return {
    data: parseSimpleYaml(match[1], filePath),
    content: match[2],
  }
}

function parseSimpleYaml(source: string, filePath: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [{ indent: -1, value: root }]

  for (const [index, line] of source.split("\n").entries()) {
    if (!line.trim()) {
      continue
    }

    if (line.includes("\t")) {
      throw new Error(`Tabs are not supported in frontmatter: ${toSourcePath(filePath)}:${index + 1}`)
    }

    const match = line.match(/^(\s*)([A-Za-z][A-Za-z0-9_-]*):(?:\s*(.*))?$/)
    if (!match) {
      throw new Error(`Unsupported frontmatter line in ${toSourcePath(filePath)}:${index + 1}`)
    }

    const indent = match[1].length
    const key = match[2]
    const rawValue = match[3] ?? ""

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop()
    }

    const parent = stack[stack.length - 1].value
    if (rawValue === "") {
      const child: Record<string, unknown> = {}
      parent[key] = child
      stack.push({ indent, value: child })
      continue
    }

    parent[key] = parseSimpleYamlValue(rawValue)
  }

  return root
}

function parseSimpleYamlValue(rawValue: string): unknown {
  const value = rawValue.trim()

  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }

  if (value === "true") {
    return true
  }

  if (value === "false") {
    return false
  }

  if (/^-?\d+$/.test(value)) {
    return Number(value)
  }

  if (value.startsWith("[") && value.endsWith("]")) {
    return splitInlineArray(value.slice(1, -1)).map((item) => parseSimpleYamlValue(item))
  }

  return value
}

function splitInlineArray(value: string): string[] {
  const items: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined

  for (const char of value) {
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? undefined : (char as '"' | "'")
      current += char
      continue
    }

    if (char === "," && !quote) {
      if (current.trim()) {
        items.push(current.trim())
      }
      current = ""
      continue
    }

    current += char
  }

  if (current.trim()) {
    items.push(current.trim())
  }

  return items
}

function normalizeSkill(rawSkill: unknown, sourcePath: string): SkillMetadata {
  if (rawSkill === undefined) {
    return { include: true, entry: false, intents: [] }
  }

  if (!rawSkill || typeof rawSkill !== "object" || Array.isArray(rawSkill)) {
    throw new Error(`Invalid skill metadata in ${sourcePath}`)
  }

  const skill = rawSkill as RawSkillMetadata
  if (skill.include !== undefined && typeof skill.include !== "boolean") {
    throw new Error(`Invalid skill.include in ${sourcePath}`)
  }
  if (skill.entry !== undefined && typeof skill.entry !== "boolean") {
    throw new Error(`Invalid skill.entry in ${sourcePath}`)
  }
  if (skill.intents !== undefined && !Array.isArray(skill.intents)) {
    throw new Error(`Invalid skill.intents in ${sourcePath}`)
  }
  if (Array.isArray(skill.intents) && skill.intents.some((value) => typeof value !== "string" || !value.trim())) {
    throw new Error(`skill.intents must contain non-empty strings in ${sourcePath}`)
  }
  const rawIntents = skill.intents
  const intents = Array.isArray(rawIntents) ? rawIntents.map((value) => value.trim().toLowerCase()) : []

  return {
    include: typeof skill.include === "boolean" ? skill.include : true,
    entry: typeof skill.entry === "boolean" ? skill.entry : false,
    intents,
  }
}

function toSourceId(filePath: string): string {
  const relativePath = relative(DOCS_ROOT, filePath).split(sep).join("/")
  return relativePath.replace(/\.mdx$/, "")
}

function toSourcePath(filePath: string): string {
  return relative(REPO_ROOT, filePath).split(sep).join("/")
}

function buildIntentIndex(pages: DocPage[]): Record<string, DocPage[]> {
  const intentIndex: Record<string, DocPage[]> = {}

  for (const page of pages) {
    for (const intent of page.skill.intents) {
      intentIndex[intent] ??= []
      intentIndex[intent].push(page)
    }
  }

  return intentIndex
}

function comparePages(left: DocPage, right: DocPage): number {
  const sectionDelta = DOC_SECTION_CONFIG[left.section].order - DOC_SECTION_CONFIG[right.section].order
  if (sectionDelta !== 0) {
    return sectionDelta
  }

  if (left.navOrder !== right.navOrder) {
    return left.navOrder - right.navOrder
  }

  return left.title.localeCompare(right.title)
}

function normalizeDocUrl(url: string): "/docs" | `/docs/${string}` {
  const normalized = url.endsWith("/") && url !== "/docs/" ? url.slice(0, -1) : url
  return (normalized === "/docs/" ? "/docs" : normalized) as "/docs" | `/docs/${string}`
}

function normalizeIntent(intent: string): string {
  return intent.trim().toLowerCase()
}
