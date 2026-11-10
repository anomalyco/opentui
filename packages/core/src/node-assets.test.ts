import { describe, expect, test } from "bun:test"
import { isAbsolute } from "node:path"

import { defaultParserAssetPaths } from "./lib/tree-sitter/default-parsers.js"
import { getNodeAssets } from "./node-assets.js"

describe("getNodeAssets", () => {
  test("rejects unsupported targets and invalid libc combinations", () => {
    expect(() => getNodeAssets({ platform: "freebsd" as "linux", arch: "x64" })).toThrow("Unsupported")
    expect(() => getNodeAssets({ platform: "toString" as "linux", arch: "x64" })).toThrow("Unsupported")
    expect(() => getNodeAssets({ platform: "linux", arch: "ia32" as "x64" })).toThrow("Unsupported")
    expect(() => getNodeAssets({ platform: "darwin", arch: "arm64", libc: "musl" })).toThrow(
      "libc is only supported on Linux",
    )
    expect(() => getNodeAssets({ platform: "linux", arch: "x64", libc: "uclibc" as "musl" })).toThrow(
      "Unsupported libc",
    )
  })

  test("returns a deterministic key-sorted manifest for the host", () => {
    const target = {
      platform: process.platform as "darwin" | "linux" | "win32",
      arch: process.arch as "arm64" | "x64",
      ...(process.platform === "linux" ? { libc: "glibc" as const } : {}),
    }
    const first = getNodeAssets(target)
    const second = getNodeAssets(target)
    const keys = first.map((asset) => asset.key)

    expect(first).toEqual(second)
    expect(keys).toEqual([...keys].sort())
    expect(keys).toHaveLength(3 + defaultParserAssetPaths.length)
    expect(keys).toContain("@opentui/core/parser.worker.js")
    expect(keys).toContain("@opentui/core/assets/markdown/highlights.scm")
    expect(keys).toContain("web-tree-sitter/tree-sitter.wasm")

    for (const asset of first) {
      expect(asset.key.startsWith("/")).toBe(false)
      expect(asset.key.includes("\\")).toBe(false)
      expect(asset.key.split("/")).not.toContain("..")
      expect(isAbsolute(asset.source)).toBe(true)
    }
  })
})
