import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "bun:test"

test("built package preserves declared runtime engines", () => {
  const root = join(import.meta.dir, "../../..")
  const source = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { engines?: object }
  const dist = JSON.parse(readFileSync(join(root, "dist/package.json"), "utf8")) as { engines?: object }
  expect(dist.engines).toEqual(source.engines)
})
