import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Run against a fresh installed consumer, not the repository's workspace graph.
// Solid's callback-based transform does not need a glob-backed resolver.
const consumerDir = process.argv[2] ?? process.cwd()
const manifestPath = join(consumerDir, "node_modules", "@opentui", "solid", "package.json")
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, Record<string, string> | undefined>

for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
  assert.equal(
    manifest[field]?.["babel-plugin-module-resolver"],
    undefined,
    `The installed Solid package must not declare the unused module resolver in ${field}`,
  )
}
