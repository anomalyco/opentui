import { expect, test } from "bun:test"

import { slugifyHeading } from "./validate-doc-links"
import { findUnescapedCodePipesInTables } from "./validate-doc-metadata"

test("heading slugs preserve repeated separators used by Astro", () => {
  expect(slugifyHeading("colorMatrix / colorMatrixUniform")).toBe("colormatrix--colormatrixuniform")
})

test("table pipe validation ignores fences and non-table lines", () => {
  const source = [
    "```markdown",
    "| Type | `A | B` |",
    "| --- | --- |",
    "```",
    "",
    "| Write `A | B` for a union.",
    "",
    "| Type | Meaning |",
    "| --- | --- |",
    "| `A | B` | Union |",
  ].join("\n")

  expect(findUnescapedCodePipesInTables(source)).toEqual([10])
})
