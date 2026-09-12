import { readFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import { z } from "astro/zod"
import { packageId } from "./package-schema"

const FACTS_FILE_SIZE_MAX = 1024 * 1024
export const PACKAGE_COUNT_MAX = 256
const boundedString = z.string().min(1).max(128)

export const remotePackageFactSchema = z
  .strictObject({
    id: packageId,
    version: boundedString.optional(),
    license: boundedString.optional(),
    stars: z.number().int().safe().nonnegative().optional(),
  })
  .refine((fact) => fact.version !== undefined || fact.license !== undefined || fact.stars !== undefined, {
    message: "must contain at least one fact",
  })

export const remotePackageFactsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  packages: z
    .array(remotePackageFactSchema)
    .max(PACKAGE_COUNT_MAX)
    .refine((packages) => new Set(packages.map((fact) => fact.id)).size === packages.length, {
      message: "package IDs must not contain duplicates",
    }),
})

export type RemotePackageFact = z.infer<typeof remotePackageFactSchema>
export type RemotePackageFacts = z.infer<typeof remotePackageFactsSchema>

export async function loadRemotePackageFacts(directory?: string, required = false): Promise<RemotePackageFact[]> {
  const indexDirectory = directory ?? process.env.OPENTUI_INDEX_DIR ?? import.meta.env.OPENTUI_INDEX_DIR
  if (!indexDirectory) return []

  const path = resolve(indexDirectory, "facts.json")
  let fileSize: number
  try {
    fileSize = (await stat(path)).size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (!required) return []
      throw new Error(`${path} is required`)
    }
    throw error
  }
  if (fileSize > FACTS_FILE_SIZE_MAX) {
    throw new Error(`${path} is ${fileSize} bytes; maximum is ${FACTS_FILE_SIZE_MAX}`)
  }

  let input: unknown
  try {
    input = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const result = remotePackageFactsSchema.safeParse(input)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const field = issue.path.length ? `${issue.path.join(".")}: ` : ""
      return `${field}${issue.message}`
    })
    throw new Error(`${path}: ${issues.join("; ")}`)
  }
  return result.data.packages
}
