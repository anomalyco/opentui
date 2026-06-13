import { readdir, readFile } from "node:fs/promises"
import { basename, dirname, join, relative, sep } from "node:path"

export type DocSectionId =
  | "getting-started"
  | "core-concepts"
  | "plugins"
  | "components"
  | "bindings"
  | "keymap"
  | "reference"

export interface SkillMetadata {
  include: boolean
  entry: boolean
  intents: string[]
}

export interface DocPage {
  id: string
  slug: string
  url: `/docs/${string}`
  sourcePath: string
  section: DocSectionId
  title: string
  navTitle: string
  description?: string
  order?: number
  skill: SkillMetadata
}

export interface DocSection {
  id: DocSectionId
  title: string
  order: number
  pages: DocPage[]
}

export interface DocsIndex {
  pages: DocPage[]
  pagesBySlug: Record<string, DocPage>
  pagesByUrl: Record<string, DocPage>
  sections: DocSection[]
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
  order?: unknown
  navTitle?: unknown
  skill?: unknown
}

const WORKING_DIRECTORY = process.cwd()
const REPO_ROOT =
  basename(WORKING_DIRECTORY) === "web" && basename(dirname(WORKING_DIRECTORY)) === "packages"
    ? join(WORKING_DIRECTORY, "../..")
    : WORKING_DIRECTORY
const DOCS_ROOT = join(REPO_ROOT, "packages/web/src/content/docs")

export const DOC_SECTION_CONFIG: Record<DocSectionId, { title: string; order: number }> = {
  "getting-started": { title: "Getting Started", order: 1 },
  "core-concepts": { title: "Core Concepts", order: 2 },
  plugins: { title: "Plugin API", order: 3 },
  components: { title: "Components", order: 4 },
  bindings: { title: "Bindings", order: 5 },
  keymap: { title: "Keymap", order: 6 },
  reference: { title: "Reference", order: 7 },
}

let docsIndexPromise: Promise<DocsIndex> | undefined

export async function buildDocsIndex(): Promise<DocsIndex> {
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

export function getPrevNextDocs(index: DocsIndex, slug: string): { prev?: DocPage; next?: DocPage } {
  const pageIndex = index.pages.findIndex((page) => page.slug === slug)
  if (pageIndex === -1) {
    return {}
  }

  return {
    prev: pageIndex > 0 ? index.pages[pageIndex - 1] : undefined,
    next: pageIndex < index.pages.length - 1 ? index.pages[pageIndex + 1] : undefined,
  }
}

async function loadDocsIndex(): Promise<DocsIndex> {
  const sourceFiles = await listDocFiles(DOCS_ROOT)
  const pages = await Promise.all(sourceFiles.map((filePath) => buildDocPage(filePath)))

  pages.sort(comparePages)

  const sections = Object.entries(DOC_SECTION_CONFIG)
    .map(([id, config]) => ({
      id: id as DocSectionId,
      title: config.title,
      order: config.order,
      pages: pages.filter((page) => page.section === id),
    }))
    .filter((section) => section.pages.length > 0)

  const pagesBySlug = Object.fromEntries(pages.map((page) => [page.slug, page]))
  const pagesByUrl = Object.fromEntries(pages.map((page) => [page.url, page]))
  const skillPages = pages.filter((page) => page.skill.include)
  const skillEntryPages = pages.filter((page) => page.skill.include && page.skill.entry)
  const intentIndex = buildIntentIndex(skillPages)

  return {
    pages,
    pagesBySlug,
    pagesByUrl,
    sections,
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

  const sourcePath = toSourcePath(filePath)
  const slug = toSlug(filePath)
  const section = toSection(slug, sourcePath)
  const skill = normalizeSkill(raw.skill, sourcePath)

  return {
    id: slug,
    slug,
    url: `/docs/${slug}`,
    sourcePath,
    section,
    title: raw.title,
    navTitle: typeof raw.navTitle === "string" ? raw.navTitle : raw.title,
    description: typeof raw.description === "string" ? raw.description : undefined,
    order: typeof raw.order === "number" ? raw.order : undefined,
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
    return splitInlineArray(value.slice(1, -1)).map((item) => String(parseSimpleYamlValue(item)))
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
  const rawIntents = skill.intents
  const intents = Array.isArray(rawIntents)
    ? rawIntents.map((value) => String(value).trim().toLowerCase()).filter((value) => value.length > 0)
    : []

  return {
    include: typeof skill.include === "boolean" ? skill.include : true,
    entry: typeof skill.entry === "boolean" ? skill.entry : false,
    intents,
  }
}

function toSlug(filePath: string): string {
  const relativePath = relative(DOCS_ROOT, filePath).split(sep).join("/")
  return relativePath.replace(/\.mdx$/, "")
}

function toSection(slug: string, sourcePath: string): DocSectionId {
  const section = slug.split("/")[0]
  if (section in DOC_SECTION_CONFIG) {
    return section as DocSectionId
  }

  throw new Error(`Unknown doc section for ${sourcePath}: ${section}`)
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

  if (left.order === undefined && right.order !== undefined) {
    return 1
  }

  if (left.order !== undefined && right.order === undefined) {
    return -1
  }

  if (left.order !== undefined && right.order !== undefined && left.order !== right.order) {
    return left.order - right.order
  }

  return left.title.localeCompare(right.title)
}

function normalizeDocUrl(url: string): `/docs/${string}` {
  const normalized = url.endsWith("/") && url !== "/docs/" ? url.slice(0, -1) : url
  return normalized as `/docs/${string}`
}

function normalizeIntent(intent: string): string {
  return intent.trim().toLowerCase()
}
