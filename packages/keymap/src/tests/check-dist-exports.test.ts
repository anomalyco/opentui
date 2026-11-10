import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { expect, test } from "bun:test"

interface DistPackageJson {
  exports?: Record<string, { import?: string }>
}

function readDistPackage(): { distDir: string; packageJson: DistPackageJson } | undefined {
  const rootDir = resolve(import.meta.dir, "..", "..")
  const distDir = resolve(rootDir, "dist")
  const distPackageJsonPath = resolve(distDir, "package.json")

  if (!existsSync(distPackageJsonPath)) {
    return undefined
  }

  return {
    distDir,
    packageJson: JSON.parse(readFileSync(distPackageJsonPath, "utf8")) as DistPackageJson,
  }
}

test("dist package exports resolve when dist exists", async () => {
  const dist = readDistPackage()
  if (!dist) {
    return
  }

  const expectedExports = [
    ".",
    "./extras",
    "./extras/graph",
    "./addons",
    "./addons/opentui",
    "./testing",
    "./html",
    "./opentui",
    "./react",
    "./solid",
    "./runtime-modules",
  ] as const

  for (const exportName of expectedExports) {
    const entry = dist.packageJson.exports?.[exportName]

    expect(entry?.import).toBeDefined()

    const filePath = resolve(dist.distDir, entry!.import!)
    expect(existsSync(filePath)).toBe(true)

    await import(pathToFileURL(filePath).href)
  }
})

test("dist package exports include linked sourcemaps when dist exists", () => {
  const dist = readDistPackage()
  if (!dist) {
    return
  }

  for (const entry of Object.values(dist.packageJson.exports ?? {})) {
    expect(entry.import).toBeDefined()

    const filePath = resolve(dist.distDir, entry.import!)
    const text = readFileSync(filePath, "utf8")
    const sourceMapUrl = text.match(/\/\/# sourceMappingURL=(.+)$/m)?.[1]

    expect(sourceMapUrl).toBe(`${entry.import!.split("/").pop()}.map`)
    expect(existsSync(`${filePath}.map`)).toBe(true)
  }
})

test("dist adapter and addon entrypoints stay isolated when dist exists", () => {
  const dist = readDistPackage()
  if (!dist) {
    return
  }

  const isolatedExports = ["./html", "./opentui", "./addons", "./addons/opentui", "./testing"] as const

  for (const exportName of isolatedExports) {
    const entry = dist.packageJson.exports?.[exportName]
    expect(entry?.import).toBeDefined()

    const text = readFileSync(resolve(dist.distDir, entry!.import!), "utf8")
    expect(text).not.toContain("// src/keymap.ts")
    expect(text).not.toContain("class Keymap")
  }
})

test("dist package self-imports resolve from dist when dist exists", () => {
  const dist = readDistPackage()
  if (!dist) {
    return
  }

  const exportNames = [
    "@opentui/keymap",
    "@opentui/keymap/extras",
    "@opentui/keymap/extras/graph",
    "@opentui/keymap/addons",
    "@opentui/keymap/addons/opentui",
    "@opentui/keymap/testing",
    "@opentui/keymap/html",
    "@opentui/keymap/opentui",
    "@opentui/keymap/react",
    "@opentui/keymap/solid",
    "@opentui/keymap/runtime-modules",
  ] as const

  const result = spawnSync("bun", ["-e", `for (const spec of ${JSON.stringify(exportNames)}) await import(spec)`], {
    cwd: dist.distDir,
    encoding: "utf8",
  })

  expect(result.stderr).toBe("")
  expect(result.status).toBe(0)
})
