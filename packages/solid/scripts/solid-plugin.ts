import { plugin as registerBunPlugin, type BunPlugin } from "bun"
import { readFile } from "node:fs/promises"
import { stripQueryAndHash, transformSolidSource, type ResolveImportPath } from "./solid-transform.js"

const solidTransformStateKey = Symbol.for("opentui.solid.transform")

type SolidTransformRuntime = {
  moduleName?: string
  resolvePath?: ResolveImportPath
}

type SolidTransformState = {
  installed: boolean
  included: Set<string>
  runtime?: SolidTransformRuntime
}

type GlobalSolidTransformState = typeof globalThis & {
  [solidTransformStateKey]?: SolidTransformState
}

export interface CreateSolidTransformPluginOptions {
  moduleName?: string
  resolvePath?: ResolveImportPath
  /**
   * Directories whose JSX files are transformed even though their paths contain
   * node_modules, such as a host's install directory for plugin packages.
   */
  include?: string[]
}

const getSolidTransformState = (): SolidTransformState => {
  const state = globalThis as GlobalSolidTransformState
  state[solidTransformStateKey] ??= { installed: false, included: new Set() }
  return state[solidTransformStateKey]
}

const getSolidTransformRuntime = (): SolidTransformRuntime => {
  return getSolidTransformState().runtime ?? {}
}

const hasSolidTransformRuntime = (input: CreateSolidTransformPluginOptions): boolean => {
  return input.moduleName !== undefined || input.resolvePath !== undefined
}

export function ensureSolidTransformPlugin(input: CreateSolidTransformPluginOptions = {}): boolean {
  const state = getSolidTransformState()

  if (hasSolidTransformRuntime(input)) {
    state.runtime = {
      moduleName: input.moduleName,
      resolvePath: input.resolvePath,
    }
  }

  const include = (input.include ?? []).filter((directory) => !state.included.has(directory))
  include.forEach((directory) => state.included.add(directory))

  if (state.installed) {
    // Bun fixes plugin filters at registration, so directories added later get their own plugin.
    if (include.length > 0) {
      registerBunPlugin(createPlugin({}, include.map(includedSourceFilter), false))
    }
    return false
  }

  registerBunPlugin(createSolidTransformPlugin({ include }))
  state.installed = true
  return true
}

export function resetSolidTransformPluginState(): void {
  const state = getSolidTransformState()
  state.installed = false
  state.included.clear()
  delete state.runtime
}

export function createSolidTransformPlugin(input: CreateSolidTransformPluginOptions = {}): BunPlugin {
  const sourceFilter = input.resolvePath
    ? /^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx?(?:[?#].*)?$/
    : /^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx(?:[?#].*)?$/

  return createPlugin(input, [sourceFilter, ...(input.include ?? []).map(includedSourceFilter)], true)
}

// Only JSX files: plain modules in node_modules already get runtime specifier rewrites
// from the runtime plugin, and transforming every dependency would be slow.
function includedSourceFilter(directory: string): RegExp {
  const root = directory.replace(/[/\\]+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^${root}[/\\\\].*\\.[cm]?[jt]sx(?:[?#].*)?$`)
}

function createPlugin(
  input: CreateSolidTransformPluginOptions,
  sourceFilters: RegExp[],
  redirectServerBuilds: boolean,
): BunPlugin {
  return {
    name: "bun-plugin-solid",
    setup: (build) => {
      if (redirectServerBuilds) {
        build.onLoad({ filter: /[/\\]node_modules[/\\]solid-js[/\\]dist[/\\]server\.js(?:[?#].*)?$/ }, async (args) => {
          const path = stripQueryAndHash(args.path).replace("server.js", "solid.js")
          const code = await readFile(path, "utf8")
          return { contents: code, loader: "js" }
        })

        build.onLoad(
          { filter: /[/\\]node_modules[/\\]solid-js[/\\]store[/\\]dist[/\\]server\.js(?:[?#].*)?$/ },
          async (args) => {
            const path = stripQueryAndHash(args.path).replace("server.js", "store.js")
            const code = await readFile(path, "utf8")
            return { contents: code, loader: "js" }
          },
        )
      }

      sourceFilters.forEach((filter) => build.onLoad({ filter }, (args) => transform(input, args.path)))
    },
  }
}

async function transform(input: CreateSolidTransformPluginOptions, file: string) {
  const path = stripQueryAndHash(file)
  const code = await readFile(path, "utf8")
  const runtime = getSolidTransformRuntime()
  const moduleName = input.moduleName ?? runtime.moduleName ?? "@opentui/solid"
  const resolvePath = input.resolvePath ?? runtime.resolvePath
  const contents = await transformSolidSource(code, {
    filename: path,
    moduleName,
    resolvePath,
  })

  return {
    contents,
    loader: "js" as const,
  }
}

const solidTransformPlugin = createSolidTransformPlugin()

export default solidTransformPlugin
