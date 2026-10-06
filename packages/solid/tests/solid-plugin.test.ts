import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runtimeModuleIdForSpecifier } from "@opentui/core/runtime-plugin"
import { createSolidTransformPlugin, resetSolidTransformPluginState } from "../scripts/solid-plugin.js"

type ResolveCallback = (args: { path: string; importer: string }) => unknown | Promise<unknown>
type LoadResult = { contents: string; loader: string } | void
type LoadCallback = (args: { path: string }) => LoadResult | Promise<LoadResult>
type ModuleCallback = () => unknown | Promise<unknown>

type LoadHandler = {
  filter: RegExp
  callback: LoadCallback
}

type MockBuild = {
  onResolve: (args: { filter: RegExp }, callback: ResolveCallback) => void
  onLoad: (args: { filter: RegExp }, callback: LoadCallback) => void
  module: (path: string, callback: ModuleCallback) => void
}

const createMockBuild = (): {
  build: MockBuild
  resolveFilters: RegExp[]
  loadHandlers: LoadHandler[]
  modules: Map<string, ModuleCallback>
} => {
  const resolveFilters: RegExp[] = []
  const loadHandlers: LoadHandler[] = []
  const modules = new Map<string, ModuleCallback>()

  const build: MockBuild = {
    onResolve(args) {
      resolveFilters.push(args.filter)
    },
    onLoad(args, callback) {
      loadHandlers.push({ filter: args.filter, callback })
    },
    module(path, callback) {
      modules.set(path, callback)
    },
  }

  return { build, resolveFilters, loadHandlers, modules }
}

const runLoad = async (handlers: LoadHandler[], path: string): Promise<LoadResult> => {
  for (const handler of handlers) {
    if (!handler.filter.test(path)) continue

    const result = await handler.callback({ path })

    if (result) {
      return result
    }
  }

  return undefined
}

const createTempTsxFile = (source: string): { path: string; dispose: () => void } => {
  const tempRoot = mkdtempSync(join(import.meta.dir, "solid-plugin-test-"))
  const path = join(tempRoot, "fixture.tsx")
  writeFileSync(path, source)

  return {
    path,
    dispose: () => {
      rmSync(tempRoot, { recursive: true, force: true })
    },
  }
}

describe("solid transform plugin", () => {
  beforeEach(() => {
    resetSolidTransformPluginState()
  })

  afterEach(() => {
    resetSolidTransformPluginState()
  })

  it("does not register runtime module resolvers by default", () => {
    const { build, resolveFilters, modules } = createMockBuild()
    createSolidTransformPlugin().setup(build as any)

    expect(resolveFilters).toHaveLength(0)
    expect(modules.size).toBe(0)
  })

  it("uses @opentui/solid as the default JSX runtime module", async () => {
    const tempFile = createTempTsxFile(
      ['import { value } from "fixture-sync"', "const node = <text>{value}</text>", "export { node }"].join("\n"),
    )

    try {
      const { build, loadHandlers } = createMockBuild()
      createSolidTransformPlugin().setup(build as any)

      const transformed = await runLoad(loadHandlers, tempFile.path)

      expect(transformed).toBeDefined()

      if (!transformed) {
        throw new Error("Expected transformed output")
      }

      expect(transformed.loader).toBe("js")
      expect(transformed.contents).toContain("@opentui/solid")
      expect(transformed.contents).toContain("fixture-sync")
      expect(transformed.contents).not.toContain("react/jsx-runtime")
    } finally {
      tempFile.dispose()
    }
  })

  it("applies custom module resolver rewrites when configured", async () => {
    const runtimeSolidModule = runtimeModuleIdForSpecifier("@opentui/solid")
    const runtimeCoreModule = runtimeModuleIdForSpecifier("@opentui/core")
    const runtimeFixtureModule = runtimeModuleIdForSpecifier("fixture-sync")

    const tempFile = createTempTsxFile(
      [
        'import { engine } from "@opentui/core"',
        'import { value } from "fixture-sync"',
        "const node = <text>{engine ? value : value}</text>",
        "export { node }",
      ].join("\n"),
    )

    try {
      const { build, loadHandlers } = createMockBuild()

      createSolidTransformPlugin({
        moduleName: runtimeSolidModule,
        resolvePath(specifier) {
          if (specifier === "@opentui/core") {
            return runtimeCoreModule
          }

          if (specifier === "fixture-sync") {
            return runtimeFixtureModule
          }

          return null
        },
      }).setup(build as any)

      const transformed = await runLoad(loadHandlers, tempFile.path)

      expect(transformed).toBeDefined()

      if (!transformed) {
        throw new Error("Expected transformed output")
      }

      expect(transformed.contents).toContain(runtimeSolidModule)
      expect(transformed.contents).toContain(runtimeCoreModule)
      expect(transformed.contents).toContain(runtimeFixtureModule)
      expect(transformed.contents).not.toContain('from "@opentui/core"')
      expect(transformed.contents).not.toContain('from "fixture-sync"')
    } finally {
      tempFile.dispose()
    }
  })

  it("transforms queried TSX paths", async () => {
    const tempFile = createTempTsxFile("const node = <text>ok</text>\nexport { node }")

    try {
      const { build, loadHandlers } = createMockBuild()
      createSolidTransformPlugin().setup(build as any)

      const transformed = await runLoad(loadHandlers, `${tempFile.path}?reload=1`)

      expect(transformed).toBeDefined()

      if (!transformed) {
        throw new Error("Expected transformed output")
      }

      expect(transformed.loader).toBe("js")
      expect(transformed.contents).toContain("@opentui/solid")
    } finally {
      tempFile.dispose()
    }
  })

  it("transforms runtime-resolved modules end-to-end in a subprocess", () => {
    const fixturePath = join(import.meta.dir, "solid-plugin.fixture.ts")
    const result = Bun.spawnSync([process.execPath, fixturePath], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })

    const stdout = result.stdout.toString().trim()

    expect(result.exitCode).toBe(0)
    expect(stdout).toContain("sync=sync-value;async=async-value;jsx=true")
  })

  it("ignores host project babel config when transforming plugins", async () => {
    const hostile = mkdtempSync(join(import.meta.dir, "solid-plugin-hostile-config-"))
    const tsxPath = join(hostile, "fixture.tsx")
    writeFileSync(tsxPath, "const node = <text>ok</text>\nexport { node }")
    writeFileSync(
      join(hostile, "babel.config.json"),
      JSON.stringify({ plugins: ["nonexistent-plugin-should-never-load"] }),
    )
    writeFileSync(join(hostile, ".babelrc.json"), JSON.stringify({ plugins: ["another-nonexistent-plugin"] }))

    const prev = process.cwd()
    try {
      process.chdir(hostile)

      const { build, loadHandlers } = createMockBuild()
      createSolidTransformPlugin().setup(build as any)

      const transformed = await runLoad(loadHandlers, tsxPath)

      expect(transformed).toBeDefined()
      if (!transformed) throw new Error("Expected transformed output")
      expect(transformed.loader).toBe("js")
      expect(transformed.contents).toContain("@opentui/solid")
    } finally {
      process.chdir(prev)
      rmSync(hostile, { recursive: true, force: true })
    }
  })
})
