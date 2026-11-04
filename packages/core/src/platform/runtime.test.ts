import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, extname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

import { resolveNativeLibraryPath } from "#opentui/runtime-assets"
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

  test("loads the native library from setRenderLibPath, then OPENTUI_LIB_PATH, then the package", async () => {
    const testFile = fileURLToPath(import.meta.url)
    const workspaceRoot = resolve(
      testFile,
      testFile.includes(`${sep}.node-test${sep}`) ? "../../../../../.." : "../../../../..",
    )
    const runtimeArgs = process.versions.bun
      ? []
      : ["--permission", `--allow-fs-read=${workspaceRoot}`, "--allow-ffi", "--experimental-ffi", "--input-type=module"]
    // The child clears the variable after import: the error label must come from the import-time read.
    const child = `const zig = await import(${JSON.stringify(new URL(`../zig${extname(testFile)}`, import.meta.url).href)})
      delete process.env.OPENTUI_LIB_PATH
      if (process.env.EXPLICIT_LIB) zig.setRenderLibPath(process.env.EXPLICIT_LIB)
      try { zig.resolveRenderLib(); console.log("loaded") } catch (error) { console.log(error.message) }
      process.exit(0)`
    const packaged = await resolveNativeLibraryPath()
    const missing = resolve(testFile, "../missing-libopentui.so")
    // OTUI_ASSET_ROOT names a directory without the library, so only OPENTUI_LIB_PATH can make these rows load.
    const assetRoot = dirname(testFile)
    const rows: Array<[env: Record<string, string>, cwd: string | undefined, output: string[]]> = [
      [{}, undefined, ["loaded"]],
      [{ OPENTUI_LIB_PATH: packaged, OTUI_ASSET_ROOT: assetRoot }, undefined, ["loaded"]],
      [{ OPENTUI_LIB_PATH: basename(packaged), OTUI_ASSET_ROOT: assetRoot }, dirname(packaged), ["loaded"]],
      [{ OPENTUI_LIB_PATH: missing }, undefined, ["does not exist", JSON.stringify(missing), "OPENTUI_LIB_PATH"]],
      [{ OPENTUI_LIB_PATH: testFile }, undefined, ["Failed to initialize", "OPENTUI_LIB_PATH"]],
      [{ OPENTUI_LIB_PATH: missing, EXPLICIT_LIB: packaged }, undefined, ["loaded"]],
      [{ OPENTUI_LIB_PATH: packaged, EXPLICIT_LIB: testFile }, undefined, ["render library: ", testFile]],
      [
        { OPENTUI_LIB_PATH: packaged, OPENTUI_LIBC: "foo" },
        undefined,
        [process.platform === "linux" ? "OPENTUI_LIBC must be" : "loaded"],
      ],
    ]
    for (const [rowEnv, cwd, output] of rows) {
      const env = {
        ...process.env,
        OPENTUI_LIB_PATH: "",
        OTUI_ASSET_ROOT: "",
        OPENTUI_LIBC: "",
        EXPLICIT_LIB: "",
        ...rowEnv,
      }
      const result = spawnSync(process.execPath, [...runtimeArgs, "-e", child], { cwd, env, timeout: 10_000 })
      const stdout = result.stdout.toString().trim()
      for (const part of output) expect(stdout).toContain(part)
    }
  })
})
