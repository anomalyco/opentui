import { plugin as registerBunPlugin } from "bun"
import { createRuntimePlugin, type CreateRuntimePluginOptions, type RuntimeModuleEntry } from "./runtime-plugin.js"

const runtimePluginSupportInstalledKey = "__opentuiCoreRuntimePluginSupportInstalled__"

interface RuntimePluginSupportInstall {
  additionalSpecifiers: ReadonlySet<string>
  core?: RuntimeModuleEntry
  preserveKey: PreserveKey
  rewriteKey: string
}

type PreserveKey = string | ((specifier: string) => boolean) | undefined

type RuntimePluginSupportState = typeof globalThis & {
  [runtimePluginSupportInstalledKey]?: RuntimePluginSupportInstall
}

function normalizeRewriteKey(rewrite: CreateRuntimePluginOptions["rewrite"] | undefined): string {
  return `${rewrite?.nodeModulesRuntimeSpecifiers ?? true}:${rewrite?.nodeModulesBareSpecifiers ?? false}`
}

function normalizePreserveKey(preserve: CreateRuntimePluginOptions["preserve"]): PreserveKey {
  if (preserve === undefined || typeof preserve === "function") {
    return preserve
  }

  const specifiers = [...new Set(preserve)].sort()
  return specifiers.length > 0 ? JSON.stringify(specifiers) : undefined
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

  if (options.preserve && normalizePreserveKey(options.preserve) !== install.preserveKey) {
    throw new Error("OpenTUI Core runtime plugin support is already installed with different preserve options.")
  }

  if (options.rewrite && normalizeRewriteKey(options.rewrite) !== install.rewriteKey) {
    throw new Error("OpenTUI Core runtime plugin support is already installed with different rewrite options.")
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
    preserveKey: normalizePreserveKey(options.preserve),
    rewriteKey: normalizeRewriteKey(options.rewrite),
  }
  return true
}

export { createRuntimePlugin, runtimeModuleIdForSpecifier } from "./runtime-plugin.js"
export type {
  CreateRuntimePluginOptions,
  RuntimeModuleEntry,
  RuntimeModuleExports,
  RuntimeModuleLoader,
  RuntimeSpecifierPreserve,
} from "./runtime-plugin.js"
