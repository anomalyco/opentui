import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"

// Run against a fresh installed consumer, not the repository's workspace graph.
// Solid's callback-based transform does not need a glob-backed resolver.
const result = spawnSync("npm", ["query", "#babel-plugin-module-resolver", "--omit=dev", "--json"], {
  cwd: process.argv[2] ?? process.cwd(),
  encoding: "utf8",
  timeout: 60_000,
})

if (result.error) throw result.error
assert.equal(result.status, 0, `Could not inspect consumer dependencies: ${result.stderr}`)
const dependencies = JSON.parse(result.stdout) as { name: string; version: string }[]
assert.deepEqual(
  dependencies.map(({ name, version }) => `${name}@${version}`).sort(),
  [],
  "The installed Solid consumer must not require the unused module resolver",
)
