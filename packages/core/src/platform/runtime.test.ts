import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { resolveAssetPath } from "./assets.js"
import { resolveBundledFilePath } from "./runtime.js"

const originalAssetRoot = process.env.OTUI_ASSET_ROOT
const temporaryDirectories: string[] = []
const assetTestTmpdir = process.env.OTUI_RUNTIME_ASSET_TEST_TMPDIR ?? tmpdir()

afterEach(() => {
  if (originalAssetRoot === undefined) {
    delete process.env.OTUI_ASSET_ROOT
  } else {
    process.env.OTUI_ASSET_ROOT = originalAssetRoot
  }

  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("platform/runtime", () => {
  test("resolves configured assets from an absolute OTUI_ASSET_ROOT", () => {
    const root = mkdtempSync(join(assetTestTmpdir, "opentui-assets-"))
    const key = "@opentui/core/assets/markdown/highlights.scm"
    const source = join(root, key)
    temporaryDirectories.push(root)
    mkdirSync(resolve(source, ".."), { recursive: true })
    writeFileSync(source, "(code_span) @markup.raw")
    process.env.OTUI_ASSET_ROOT = root

    expect(resolveAssetPath(key, "/unused/fallback")).toBe(source)
  })

  test("rejects relative OTUI_ASSET_ROOT values", () => {
    process.env.OTUI_ASSET_ROOT = "relative-assets"

    expect(() => resolveAssetPath("@opentui/core/parser.worker.js", "/unused/fallback")).toThrow(
      "OTUI_ASSET_ROOT must be an absolute directory",
    )
  })

  test("treats an empty OTUI_ASSET_ROOT as unset", () => {
    process.env.OTUI_ASSET_ROOT = ""

    expect(resolveAssetPath("@opentui/core/parser.worker.js", "/package/parser.worker.js")).toBe(
      "/package/parser.worker.js",
    )
  })

  test("reports a configured asset key and resolved missing path without falling back", () => {
    const root = mkdtempSync(join(assetTestTmpdir, "opentui-assets-"))
    const key = "web-tree-sitter/tree-sitter.wasm"
    temporaryDirectories.push(root)
    process.env.OTUI_ASSET_ROOT = root

    expect(() => resolveAssetPath(key, "/existing/fallback")).toThrow(
      `Missing OpenTUI asset ${JSON.stringify(key)} at ${JSON.stringify(join(root, key))}`,
    )
  })

  test("resolves bundled file paths through the active runtime path", async () => {
    const bundledUrl = new URL("./bundled-tree-sitter.wasm", import.meta.url).href
    const fallbackUrl = new URL("./fallback-tree-sitter.wasm", import.meta.url)
    let fallbackCalled = false

    const resolved = await resolveBundledFilePath(
      "web-tree-sitter/tree-sitter.wasm",
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

  test("falls back to the source path when a bundled asset module's default is not a path string", async () => {
    const fallbackUrl = new URL("./fallback-tree-sitter.wasm", import.meta.url)

    const resolved = await resolveBundledFilePath(
      "web-tree-sitter/tree-sitter.wasm",
      async () => ({ default: undefined as unknown as string }),
      fallbackUrl,
      import.meta.url,
    )

    expect(resolved).toBe(fileURLToPath(fallbackUrl))
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
      "web-tree-sitter/tree-sitter.wasm",
      loadBundledFile,
      "./missing-bundled-tree-sitter.wasm",
      import.meta.url,
    )

    expect(resolved).toBe(fileURLToPath(bundledUrl))
  })

  test("resolves transformed asset loaders when a non-Bun bundle has no source fallback", async () => {
    const bundledUrl = new URL("./bundled-tree-sitter.wasm", import.meta.url).href
    const resolved = await resolveBundledFilePath(
      "web-tree-sitter/tree-sitter.wasm",
      async () => ({ default: bundledUrl }),
      "./missing-transformed-tree-sitter.wasm",
      import.meta.url,
      { loadBundledFileFallback: true },
    )

    expect(resolved).toBe(fileURLToPath(bundledUrl))
  })
})
