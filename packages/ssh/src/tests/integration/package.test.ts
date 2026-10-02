import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "bun:test"

test("built package preserves declared runtime engines", () => {
  const root = join(import.meta.dir, "../../..")
  const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { engines?: object }
  expect(readFileSync(join(root, "scripts/build.ts"), "utf8")).toContain("engines: packageJson.engines")
  const distPath = join(root, "dist/package.json")
  if (!existsSync(distPath)) return
  const dist = JSON.parse(readFileSync(distPath, "utf8")) as { engines?: object }
  expect(dist.engines).toEqual(source.engines)
})
