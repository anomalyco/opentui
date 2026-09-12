import { promises as fs } from "node:fs"
import { basename } from "node:path"
import { packageEntrySchema, type PackageEntry } from "../src/lib/package-schema"

const FILE_SIZE_MAX = 256 * 1024

export async function parsePackageEntryFile(path: string): Promise<PackageEntry> {
  const fileSize = (await fs.stat(path)).size
  if (fileSize > FILE_SIZE_MAX) throw new Error(`${path} is ${fileSize} bytes; maximum is ${FILE_SIZE_MAX}`)

  const contents = await fs.readFile(path, "utf8")
  const match = contents.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) throw new Error(`${path}: missing YAML frontmatter`)

  let data: unknown
  try {
    data = Bun.YAML.parse(match[1])
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const result = packageEntrySchema.safeParse(data)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const field = issue.path.length ? `${issue.path.join(".")}: ` : ""
      return `${field}${issue.message}`
    })
    throw new Error(`${path}: ${issues.join("; ")}`)
  }

  const filename = basename(path, ".mdx")
  if (result.data.id !== filename) throw new Error(`${path}: frontmatter id must match filename \`${filename}\``)
  return result.data
}
