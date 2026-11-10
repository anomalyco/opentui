import { z } from "astro/zod"

export const packageId = z
  .string()
  .max(128)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be a lowercase, hyphenated package ID")
const nonemptyString = z.string().trim().min(1)
const absoluteUrl = z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
  message: "must be an HTTP(S) URL",
})
const sitePathOrUrl = z
  .string()
  .refine(
    (value) => (value.startsWith("/") && !value.startsWith("//")) || absoluteUrl.safeParse(value).success,
    "must be a site-absolute path or HTTP(S) URL",
  )
const gitUrl = z.string().refine((value) => {
  if (/^[^/@\s]+@[^/:\s]+:[^\s]+$/.test(value)) return true
  try {
    return ["git:", "http:", "https:", "ssh:"].includes(new URL(value).protocol)
  } catch {
    return false
  }
}, "must be a git URL")
const unique = <T extends z.ZodType>(schema: T) =>
  z.array(schema).refine((values) => new Set(values).size === values.length, "must not contain duplicates")
const packageCategory = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => [...value].length <= 32, "must contain at most 32 characters")

export const packageEntrySchema = z
  .strictObject({
    id: packageId,
    name: nonemptyString,
    summary: nonemptyString,
    kind: z.enum([
      "native-library",
      "library",
      "renderer",
      "component",
      "application",
      "tool",
      "integration",
      "examples",
      "documentation",
    ]),
    official: z.boolean(),
    maintainers: unique(nonemptyString.regex(/^@?[A-Za-z0-9](?:[A-Za-z0-9-]{0,37})$/, "must be a GitHub handle"))
      .min(1)
      .max(16)
      .optional(),
    source: z.strictObject({
      url: gitUrl,
      directory: nonemptyString
        .refine((value) => !value.startsWith("/") && !value.split(/[\\/]/).includes(".."), "must be a relative path")
        .optional(),
    }),
    surfaces: z
      .array(
        z.strictObject({
          name: nonemptyString,
          language: nonemptyString,
          import: nonemptyString.optional(),
          docs: sitePathOrUrl.optional(),
        }),
      )
      .max(32)
      .optional(),
    distributions: z
      .array(
        z.strictObject({
          type: z.enum(["source", "npm", "jsr", "github-release"]),
          identifier: nonemptyString.optional(),
          install: nonemptyString.optional(),
        }),
      )
      .min(1)
      .max(8),
    links: z
      .strictObject({
        homepage: absoluteUrl.optional(),
        docs: sitePathOrUrl.optional(),
        issues: absoluteUrl.optional(),
        changelog: sitePathOrUrl.optional(),
      })
      .optional(),
    categories: unique(packageCategory).min(1).max(3).optional(),
    status: z.enum(["active", "archived", "deprecated"]).default("active"),
  })
  .superRefine((entry, context) => {
    if (entry.official && !isOfficialPackageSource(entry.source.url)) {
      context.addIssue({
        code: "custom",
        path: ["source", "url"],
        message: "official packages must use the anomalyco/opentui source repository",
      })
    }
    if (!entry.official && !entry.maintainers) {
      context.addIssue({ code: "custom", path: ["maintainers"], message: "is required for community packages" })
    }
    if (entry.official && entry.maintainers) {
      context.addIssue({ code: "custom", path: ["maintainers"], message: "applies only to community packages" })
    }
  })

export type PackageEntry = z.infer<typeof packageEntrySchema>

export function isOfficialPackageSource(source: string): boolean {
  const repository = githubRepository(source)
  return repository?.toLowerCase() === "anomalyco/opentui"
}

export function githubRepository(source: string): string | undefined {
  const scpMatch = source.match(/^[^/@\s]+@github\.com:([^/\s]+\/[^/\s]+?)(?:\.git)?$/i)
  if (scpMatch) return scpMatch[1]

  try {
    const url = new URL(source)
    if (url.hostname.toLowerCase() !== "github.com") return undefined
    const parts = url.pathname
      .replace(/^\//, "")
      .replace(/\.git$/, "")
      .split("/")
    if (parts.length < 2 || !parts[0] || !parts[1]) return undefined
    return `${parts[0]}/${parts[1]}`
  } catch {
    return undefined
  }
}

export function githubRepositoryIdentifier(value: string): string | undefined {
  const repository = githubRepository(value) ?? value.replace(/\.git$/, "")
  return /^[^/\s]+\/[^/\s]+$/.test(repository) ? repository : undefined
}
