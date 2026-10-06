import { plugin as registerBunPlugin } from "bun"
import {
  createRuntimePlugin,
  type CreateRuntimePluginOptions,
  type RuntimeModuleEntry,
  type RuntimePluginRewriteOptions,
  type RuntimeSpecifierPreserve,
} from "./runtime-plugin.js"

const runtimePluginSupportInstalledKey = "__opentuiCoreRuntimePluginSupportInstalled__"

type NormalizedPreserve = ((specifier: string) => boolean) | ReadonlySet<string> | undefined

interface RuntimePluginSupportInstall {
  additionalSpecifiers: ReadonlySet<string>
  core?: RuntimeModuleEntry
  preserve?: NormalizedPreserve
  rewriteKey: string
}

type RuntimePluginSupportState = typeof globalThis & {
  [runtimePluginSupportInstalledKey]?: RuntimePluginSupportInstall
}

function normalizeRewriteKey(rewrite: CreateRuntimePluginOptions["rewrite"] | undefined): string {
  return `${rewrite?.nodeModulesRuntimeSpecifiers ?? true}:${rewrite?.nodeModulesBareSpecifiers ?? false}`
}

function normalizePreserve(preserve: RuntimeSpecifierPreserve | undefined): NormalizedPreserve {
  if (!preserve) {
    return undefined
  }

  if (typeof preserve === "function") {
    return preserve
  }

  return new Set(preserve)
}

function isCompatiblePreserve(installed: NormalizedPreserve, requested: NormalizedPreserve): boolean {
  if (!requested) {
    return true
  }

  if (!installed) {
    return false
  }

  if (typeof installed === "function" || typeof requested === "function") {
    return installed === requested
  }

  if (installed.size !== requested.size) {
    return false
  }

  for (const specifier of requested) {
    if (!installed.has(specifier)) {
      return false
    }
  }

  return true
}

function assertCompatibleInstall(
  install: RuntimePluginSupportInstall,
  options: CreateRuntimePluginOptions,
  requestedPreserve: NormalizedPreserve,
): void {
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

  if (!isCompatiblePreserve(install.preserve, requestedPreserve)) {
    throw new Error("OpenTUI Core runtime plugin support is already installed with different preserve options.")
  }

  if (options.rewrite && normalizeRewriteKey(options.rewrite) !== install.rewriteKey) {
    throw new Error("OpenTUI Core runtime plugin support is already installed with different rewrite options.")
  }
}

export function ensureRuntimePluginSupport(options: CreateRuntimePluginOptions = {}): boolean {
  const state = globalThis as RuntimePluginSupportState
  const preserve = normalizePreserve(options.preserve)
  const install = state[runtimePluginSupportInstalledKey]

  if (install) {
    assertCompatibleInstall(install, options, preserve)
    return false
  }

  registerBunPlugin(
    createRuntimePlugin({
      ...options,
      preserve,
    }),
  )

  state[runtimePluginSupportInstalledKey] = {
    additionalSpecifiers: new Set(Object.keys(options.additional ?? {})),
    core: options.core,
    preserve,
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
  RuntimePluginRewriteOptions,
  RuntimeSpecifierPreserve,
} from "./runtime-plugin.js"
