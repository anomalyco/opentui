import { plugin as registerBunPlugin, type BunPlugin } from "bun"
import { stripQueryAndHash, transformSolidSource, type ResolveImportPath } from "./solid-transform.js"

const solidTransformStateKey = Symbol.for("opentui.solid.transform")

type SolidTransformRuntime = {
  moduleName?: string
  resolvePath?: ResolveImportPath
}

type SolidTransformState = {
  installed: boolean
  runtime?: SolidTransformRuntime
}

type GlobalSolidTransformState = typeof globalThis & {
  [solidTransformStateKey]?: SolidTransformState
}

export interface CreateSolidTransformPluginOptions {
  moduleName?: string
  resolvePath?: ResolveImportPath
}

const getSolidTransformState = (): SolidTransformState => {
  const state = globalThis as GlobalSolidTransformState
  state[solidTransformStateKey] ??= { installed: false }
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

  if (state.installed) {
    return false
  }

  registerBunPlugin(createSolidTransformPlugin())
  state.installed = true
  return true
}

export function resetSolidTransformPluginState(): void {
  const state = getSolidTransformState()
  state.installed = false
  delete state.runtime
}

export function createSolidTransformPlugin(input: CreateSolidTransformPluginOptions = {}): BunPlugin {
  const sourceFilter = input.resolvePath
    ? /^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx?(?:[?#].*)?$/
    : /^(?!.*[/\\]node_modules[/\\]).*\.[cm]?[jt]sx(?:[?#].*)?$/

  return {
    name: "bun-plugin-solid",
    setup: (build) => {
      build.onLoad({ filter: /[/\\]node_modules[/\\]solid-js[/\\]dist[/\\]server\.js(?:[?#].*)?$/ }, async (args) => {
        const path = stripQueryAndHash(args.path).replace("server.js", "solid.js")
        const file = Bun.file(path)
        const code = await file.text()
        return { contents: code, loader: "js" }
      })

      build.onLoad(
        { filter: /[/\\]node_modules[/\\]solid-js[/\\]store[/\\]dist[/\\]server\.js(?:[?#].*)?$/ },
        async (args) => {
          const path = stripQueryAndHash(args.path).replace("server.js", "store.js")
          const file = Bun.file(path)
          const code = await file.text()
          return { contents: code, loader: "js" }
        },
      )

      build.onLoad({ filter: sourceFilter }, async (args) => {
        const path = stripQueryAndHash(args.path)

        const file = Bun.file(path)
        const code = await file.text()
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
          loader: "js",
        }
      })
    },
  }
}

const solidTransformPlugin = createSolidTransformPlugin()

export default solidTransformPlugin
