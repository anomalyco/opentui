import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { gzipSync } from "node:zlib"

// Publishes the skill through the skills CLI well-known discovery (schema 0.2.0): an index.json at
// <path>/.well-known/agent-skills/ that points to one archive. `npx skills add https://opentui.com<path>`
// installs it. The archive holds SKILL.md and the docs it reads, as in packages/web/src/content.

export const DISCOVERY_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json"
export const SKILL_ARCHIVE = "opentui.tar.gz"

export interface SkillFile {
  path: string
  content: Uint8Array
}

export interface SkillIndex {
  $schema: typeof DISCOVERY_SCHEMA
  skills: Array<{ name: string; type: "archive"; description: string; url: string; digest: string }>
}

/** Reads SKILL.md and every .md or .mdx file under docs/ from a skill root, in path order. */
export async function readSkillFiles(skillRoot: string): Promise<SkillFile[]> {
  const docs = (await listFiles(join(skillRoot, "docs")))
    .filter((file) => file.endsWith(".mdx") || file.endsWith(".md"))
    .map((file) => relative(skillRoot, file).split(sep).join("/"))
  const paths = ["SKILL.md", ...docs.toSorted()]
  return Promise.all(paths.map(async (path) => ({ path, content: await readFile(join(skillRoot, path)) })))
}

/** Writes the archive and index.json into <siteRoot>/<path>/.well-known/agent-skills/ for each path. */
export async function publishSkill(siteRoot: string, paths: string[], files: SkillFile[]): Promise<SkillIndex> {
  const skill = files.find((file) => file.path === "SKILL.md")
  if (!skill) throw new Error("The skill has no SKILL.md")
  const { name, description } = skillMetadata(new TextDecoder().decode(skill.content))

  const archive = gzipSync(createTar(files), { level: 9 })
  const index: SkillIndex = {
    $schema: DISCOVERY_SCHEMA,
    skills: [
      {
        name,
        type: "archive",
        description,
        url: SKILL_ARCHIVE,
        digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
      },
    ],
  }

  for (const path of paths) {
    const directory = join(siteRoot, path, ".well-known/agent-skills")
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, SKILL_ARCHIVE), archive)
    await writeFile(join(directory, "index.json"), `${JSON.stringify(index, null, 2)}\n`)
  }
  return index
}

export function skillMetadata(source: string): { name: string; description: string } {
  const frontmatter = source.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n/)
  if (!frontmatter) throw new Error("SKILL.md has no frontmatter")
  const data = Bun.YAML.parse(frontmatter[1]) as { name?: unknown; description?: unknown }
  const { name, description } = data
  // The same limits as the skills CLI.
  if (typeof name !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    throw new Error(`SKILL.md name must be a lowercase name of at most 64 characters, not ${JSON.stringify(name)}`)
  }
  if (typeof description !== "string" || !description || description.length > 1024) {
    throw new Error("SKILL.md description must be a string of 1 to 1024 characters")
  }
  return { name, description }
}

/** A ustar archive with fixed metadata, so equal files give an equal archive and digest. */
export function createTar(files: SkillFile[]): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const file of files) {
    blocks.push(tarHeader(file.path, file.content.byteLength), file.content)
    const padding = (512 - (file.content.byteLength % 512)) % 512
    if (padding) blocks.push(new Uint8Array(padding))
  }
  blocks.push(new Uint8Array(1024))

  const tar = new Uint8Array(blocks.reduce((size, block) => size + block.byteLength, 0))
  let offset = 0
  for (const block of blocks) {
    tar.set(block, offset)
    offset += block.byteLength
  }
  return tar
}

function tarHeader(path: string, size: number): Uint8Array {
  const { name, prefix } = splitTarPath(path)
  const header = new Uint8Array(512)
  const encoder = new TextEncoder()
  const field = (offset: number, length: number, value: string) => {
    const bytes = encoder.encode(value)
    if (bytes.byteLength > length) throw new Error(`Tar field too long for ${path}: ${value}`)
    header.set(bytes, offset)
  }
  const octal = (value: number, length: number) => `${value.toString(8).padStart(length - 1, "0")}\0`

  field(0, 100, name)
  field(100, 8, octal(0o644, 8))
  field(108, 8, octal(0, 8))
  field(116, 8, octal(0, 8))
  field(124, 12, octal(size, 12))
  field(136, 12, octal(0, 12))
  field(148, 8, "        ")
  field(156, 1, "0")
  field(257, 6, "ustar\0")
  field(263, 2, "00")
  field(345, 155, prefix)

  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  field(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `)
  return header
}

function splitTarPath(path: string): { name: string; prefix: string } {
  if (new TextEncoder().encode(path).byteLength <= 100) return { name: path, prefix: "" }
  for (let index = path.indexOf("/"); index !== -1; index = path.indexOf("/", index + 1)) {
    const prefix = path.slice(0, index)
    const name = path.slice(index + 1)
    if (prefix.length <= 155 && name.length <= 100) return { name, prefix }
  }
  throw new Error(`Path too long for a tar archive: ${path}`)
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? listFiles(path) : Promise.resolve(entry.isFile() ? [path] : [])
    }),
  )
  return files.flat()
}
