import { plugin as registerBunPlugin } from "bun"
import { createRuntimePlugin, type CreateRuntimePluginOptions, type RuntimeModuleEntry } from "./runtime-plugin.js"

const runtimePluginSupportInstalledKey = "__opentuiCoreRuntimePluginSupportInstalled__"

interface RuntimePluginSupportInstall {
  additionalSpecifiers: ReadonlySet<string>
  core?: RuntimeModuleEntry
  rewriteKey: string
  sourceTransform?: CreateRuntimePluginOptions["sourceTransform"]
}

type RuntimePluginSupportState = typeof globalThis & {
  [runtimePluginSupportInstalledKey]?: RuntimePluginSupportInstall
}

function normalizeRewriteKey(rewrite: CreateRuntimePluginOptions["rewrite"] | undefined): string {
  return `${rewrite?.nodeModulesRuntimeSpecifiers ?? true}:${rewrite?.nodeModulesBareSpecifiers ?? false}`
}

function assertCompatibleInstall(install: RuntimePluginSupportInstall, options: CreateRuntimePluginOptions): void {
  for (const specifier of Object.keys(options.additional ?? {})) {
    if (!install.additionalSpecifiers.has(specifier)) {
      throw new Error(
        `OpenTUI Core runtime plugin support is already installed without ${specifier}. Call ensureRuntimePluginSupport({ additional }) from @opentui/core/runtime-plugin-support/configure before importing @opentui/core/runtime-plugin-support.`,
      )
    }
  }

  if (options.core && options.core !== install.core) {
    throw new Error("OpenTUI Core runtime plugin support is already installed with a different core runtime module.")
  }

  if (options.rewrite && normalizeRewriteKey(options.rewrite) !== install.rewriteKey) {
    throw new Error("OpenTUI Core runtime plugin support is already installed with different rewrite options.")
  }

  if (options.sourceTransform && options.sourceTransform !== install.sourceTransform) {
    throw new Error("OpenTUI Core runtime plugin support is already installed with a different source transform.")
  }
}

export function ensureRuntimePluginSupport(options: CreateRuntimePluginOptions = {}): boolean {
  const state = globalThis as RuntimePluginSupportState
  const install = state[runtimePluginSupportInstalledKey]

  if (install) {
    assertCompatibleInstall(install, options)
    return false
  }

  registerBunPlugin(createRuntimePlugin(options))

  state[runtimePluginSupportInstalledKey] = {
    additionalSpecifiers: new Set(Object.keys(options.additional ?? {})),
    core: options.core,
    rewriteKey: normalizeRewriteKey(options.rewrite),
    sourceTransform: options.sourceTransform,
  }
  return true
}

export { createRuntimePlugin, runtimeModuleIdForSpecifier } from "./runtime-plugin.js"
export type {
  CreateRuntimePluginOptions,
  RuntimeModuleEntry,
  RuntimeModuleExports,
  RuntimeModuleLoader,
} from "./runtime-plugin.js"
