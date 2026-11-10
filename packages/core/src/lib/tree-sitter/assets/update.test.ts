import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

import { updateAssets } from "./update.js"

test("custom parser generation loads its assets without overwriting an undeclared sibling output", async () => {
  const root = mkdtempSync(join(import.meta.dirname, ".update-test-"))
  const configPath = join(root, "parsers.json")
  const outputPath = join(root, "parsers.ts")
  const siblingPath = join(root, "default-parser-assets.bun.ts")
  const siblingContents = "export const applicationOwned = true\n"
  const wasmPath = join(root, "parser.wasm")

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        parsers: [
          {
            filetype: "custom",
            wasm: wasmPath,
            queries: { highlights: ["./highlights.scm"] },
          },
        ],
      }),
    )
    writeFileSync(wasmPath, "custom wasm")
    writeFileSync(join(root, "highlights.scm"), "(identifier) @variable")
    writeFileSync(siblingPath, siblingContents)

    await updateAssets({ configPath, assetsDir: join(root, "assets"), outputPath })
    const { getParsers } = await import(pathToFileURL(outputPath).href)
    const parsers = await getParsers()

    expect(readFileSync(siblingPath, "utf8")).toBe(siblingContents)
    expect(parsers).toHaveLength(1)
    expect(existsSync(parsers[0].wasm)).toBe(true)
    expect(existsSync(parsers[0].queries.highlights[0])).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
