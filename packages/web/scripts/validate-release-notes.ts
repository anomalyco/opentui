#!/usr/bin/env bun
// Checks the release notes in src/content/docs/releases/: the format that src/lib/release-notes.ts describes,
// and that each file names a released version (one with an api/ history file) or the next release. Links are
// checked by validate-doc-links.ts.
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"

import { compareVersions } from "../src/lib/api-history"
import { parseReleaseNotes, splitFrontmatter } from "../src/lib/release-notes"

const REPO_ROOT = join(import.meta.dir, "../../..")
const RELEASE_NOTES_ROOT = join(REPO_ROOT, "packages/web/src/content/docs/releases")

export async function validateReleaseNotes(notesRoot: string, apiRoot: string): Promise<string[]> {
  const notes = (await readdir(notesRoot).catch(() => [] as string[])).filter((file) => file.endsWith(".md"))
  const released = (await readdir(apiRoot).catch(() => [] as string[]))
    .filter((file) => /^\d+\.\d+\.\d+\.txt$/.test(file))
    .map((file) => file.slice(0, -".txt".length))
    .sort(compareVersions)
  const latest = released.at(-1)
  const violations: string[] = []

  for (const file of notes.sort()) {
    const version = file.slice(0, -".md".length)
    const sourcePath = `packages/web/src/content/docs/releases/${file}`
    try {
      const { yaml, body, bodyLine } = splitFrontmatter(await readFile(join(notesRoot, file), "utf8"))
      parseReleaseNotes(version, Bun.YAML.parse(yaml) as Record<string, unknown>, body, bodyLine)
    } catch (error) {
      violations.push(`${sourcePath}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (latest && !released.includes(version) && compareVersions(version, latest) <= 0) {
      violations.push(`${sourcePath}: ${version} is not a release; api/ has no ${version}.txt`)
    }
  }
  return violations
}

if (import.meta.main) {
  const violations = await validateReleaseNotes(RELEASE_NOTES_ROOT, join(REPO_ROOT, "api"))
  if (violations.length > 0) {
    console.error("Release notes validation failed:\n")
    for (const violation of violations) console.error(`- ${violation}`)
    process.exit(1)
  }
  console.log("Release notes validation passed.")
}
