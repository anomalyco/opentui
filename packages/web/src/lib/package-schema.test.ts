import { describe, expect, test } from "bun:test"
import { githubRepositoryIdentifier, packageEntrySchema } from "./package-schema"

const communityEntry = {
  id: "community-package",
  name: "Community Package",
  summary: "A community package.",
  kind: "library" as const,
  official: false,
  maintainers: ["@maintainer"],
  source: { url: "https://github.com/example/community-package" },
  distributions: [{ type: "npm" as const, identifier: "community-package" }],
}

describe("package categories", () => {
  test("accepts and trims arbitrary category text", () => {
    const result = packageEntrySchema.parse({
      ...communityEntry,
      categories: ["  terminal UI  ", "C++ bindings", "tools/integrations"],
    })

    expect(result.categories).toEqual(["terminal UI", "C++ bindings", "tools/integrations"])
  })

  test("detects duplicates after trimming", () => {
    const result = packageEntrySchema.safeParse({
      ...communityEntry,
      categories: ["testing", " testing "],
    })

    expect(result.success).toBe(false)
  })

  test.each([{ categories: [] }, { categories: ["   "] }])("rejects empty categories: %j", ({ categories }) => {
    expect(packageEntrySchema.safeParse({ ...communityEntry, categories }).success).toBe(false)
  })

  test("rejects categories longer than 32 characters", () => {
    expect(packageEntrySchema.safeParse({ ...communityEntry, categories: ["a".repeat(33)] }).success).toBe(false)
    expect(packageEntrySchema.safeParse({ ...communityEntry, categories: ["😀".repeat(32)] }).success).toBe(true)
    expect(packageEntrySchema.safeParse({ ...communityEntry, categories: ["😀".repeat(33)] }).success).toBe(false)
  })

  test("rejects more than three categories", () => {
    expect(
      packageEntrySchema.safeParse({ ...communityEntry, categories: ["one", "two", "three", "four"] }).success,
    ).toBe(false)
  })
})

test("normalizes GitHub repository identifiers", () => {
  expect(githubRepositoryIdentifier("owner/repository")).toBe("owner/repository")
  expect(githubRepositoryIdentifier("https://github.com/owner/repository.git")).toBe("owner/repository")
  expect(githubRepositoryIdentifier("not-a-repository")).toBeUndefined()
})

test("rejects package IDs longer than 128 characters", () => {
  expect(packageEntrySchema.safeParse({ ...communityEntry, id: "a".repeat(129) }).success).toBe(false)
})
