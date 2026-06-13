import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

import { resolveBundledFilePath } from "./runtime.js"

describe("platform/runtime", () => {
  test("resolves bundled file paths through the active runtime path", async () => {
    const bundledUrl = new URL("./bundled-tree-sitter.wasm", import.meta.url).href
    const fallbackUrl = new URL("./fallback-tree-sitter.wasm", import.meta.url)
    let fallbackCalled = false

    const resolved = await resolveBundledFilePath(
      async () => ({ default: bundledUrl }),
      () => {
        fallbackCalled = true
        return fallbackUrl
      },
      import.meta.url,
    )

    const isBun = typeof process.versions?.bun === "string"

    expect(resolved).toBe(fileURLToPath(isBun ? bundledUrl : fallbackUrl))
    expect(fallbackCalled).toBe(!isBun)
  })

  test("resolves Bun-emitted asset modules when a non-Bun bundle has no source fallback", async () => {
    const bundledUrl = new URL("./bundled-tree-sitter.wasm", import.meta.url).href
    const bundledModuleSpecifier = `data:text/javascript,${encodeURIComponent(
      `export default ${JSON.stringify(bundledUrl)}`,
    )}`
    const loadBundledFile = async (): Promise<{ default: string }> => {
      if (typeof process.versions?.bun === "string") {
        return { default: bundledUrl }
      }

      throw new TypeError("Import attribute type=file is not supported")
    }

    Object.defineProperty(loadBundledFile, "toString", {
      value: () => `() => import(${JSON.stringify(bundledModuleSpecifier)}, { with: { type: "file" } })`,
    })

    const resolved = await resolveBundledFilePath(
      loadBundledFile,
      "./missing-bundled-tree-sitter.wasm",
      import.meta.url,
    )

    expect(resolved).toBe(fileURLToPath(bundledUrl))
  })
})
