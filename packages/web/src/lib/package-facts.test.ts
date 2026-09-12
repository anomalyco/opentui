import { describe, expect, test } from "bun:test"
import { variants } from "../../../core/scripts/variants"
import {
  extractEntrypoints,
  extractZigMetadata,
  loadFirstPartyPackageFacts,
  matchPlatformPackages,
  normalizePlatform,
} from "./package-facts"

describe("package facts", () => {
  test("extracts exports map entrypoints", () => {
    expect(extractEntrypoints({ ".": "./index.ts", "./testing": { import: "./testing.ts" } })).toEqual([
      ".",
      "./testing",
    ])
    expect(extractEntrypoints({ import: "./index.ts", types: "./index.d.ts" })).toEqual(["."])
    expect(extractEntrypoints(undefined)).toEqual([])
  })

  test("matches and normalizes native platforms", () => {
    const dependencies = Object.fromEntries(
      variants.map(({ platform, arch, abi }) => [`@opentui/core-${platform}-${arch}${abi ? `-${abi}` : ""}`, "0.5.3"]),
    )
    dependencies["unrelated-package"] = "1.0.0"

    expect(matchPlatformPackages("@opentui/core", dependencies, variants)).toHaveLength(8)
    expect(variants.map(normalizePlatform)).toEqual([
      { os: "macos", architecture: "x86_64" },
      { os: "macos", architecture: "aarch64" },
      { os: "linux", architecture: "x86_64", abi: "gnu" },
      { os: "linux", architecture: "aarch64", abi: "gnu" },
      { os: "linux", architecture: "x86_64", abi: "musl" },
      { os: "linux", architecture: "aarch64", abi: "musl" },
      { os: "windows", architecture: "x86_64" },
      { os: "windows", architecture: "aarch64" },
    ])
  })

  test("loads workspace facts from all eight native variants", async () => {
    const facts = await loadFirstPartyPackageFacts()
    const core = facts.find((fact) => fact.id === "opentui-core")

    expect(facts).toHaveLength(8)
    expect(core?.entrypoints).toContain("./testing")
    expect(core?.platformPackages).toHaveLength(8)
    expect(core?.platforms).toHaveLength(8)
    expect(core?.zig).toEqual({ name: "opentui", version: "0.1.11", minimumZigVersion: "0.16.0" })
  })

  test("extracts Zig package metadata", () => {
    expect(
      extractZigMetadata(`.{
        .name = .opentui,
        .version = "0.1.11",
        .minimum_zig_version = "0.16.0",
      }`),
    ).toEqual({ name: "opentui", version: "0.1.11", minimumZigVersion: "0.16.0" })
  })
})
