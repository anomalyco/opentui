import { plugin as registerBunPlugin } from "bun"
import * as coreRuntime from "@opentui/core"
import {
  createRuntimePlugin,
  isCoreRuntimeModuleSpecifier,
  runtimeModuleIdForSpecifier,
  type RuntimeModuleEntry,
  type RuntimePluginRewriteOptions,
  type RuntimeSpecifierPreserve,
} from "@opentui/core/runtime-plugin"
import * as solidJsRuntime from "solid-js"
import * as solidJsStoreRuntime from "solid-js/store"
import * as solidRuntime from "@opentui/solid"
import * as solidComponentsRuntime from "@opentui/solid/components"
import * as solidJsxRuntime from "@opentui/solid/jsx-runtime"
import * as solidJsxDevRuntime from "@opentui/solid/jsx-dev-runtime"
import { ensureSolidTransformPlugin } from "./solid-plugin.js"

const runtimePluginSupportInstalledKey = Symbol.for("opentui.solid.runtime-plugin-support")

type NormalizedPreserve = ((specifier: string) => boolean) | ReadonlySet<string> | undefined

export interface SolidRuntimePluginSupportOptions {
  additional?: Record<string, RuntimeModuleEntry>
  core?: RuntimeModuleEntry
  preserve?: RuntimeSpecifierPreserve
  rewrite?: RuntimePluginRewriteOptions
}

interface RuntimePluginSupportInstall {
  specifiers: ReadonlySet<string>
  core: RuntimeModuleEntry
  preserve?: NormalizedPreserve
  rewriteKey: string
}

type RuntimePluginSupportState = typeof globalThis & {
  [runtimePluginSupportInstalledKey]?: RuntimePluginSupportInstall
}

const defaultRuntimeModules: Record<string, RuntimeModuleEntry> = {
  "@opentui/solid": solidRuntime as Record<string, unknown>,
  "@opentui/solid/components": solidComponentsRuntime as Record<string, unknown>,
  "@opentui/solid/jsx-runtime": solidJsxRuntime as Record<string, unknown>,
  "@opentui/solid/jsx-dev-runtime": solidJsxDevRuntime as Record<string, unknown>,
  "solid-js": solidJsRuntime as Record<string, unknown>,
  "solid-js/store": solidJsStoreRuntime as Record<string, unknown>,
}

function normalizeRewriteKey(rewrite: RuntimePluginRewriteOptions | undefined): string {
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

function createRuntimeModules(options?: SolidRuntimePluginSupportOptions): Record<string, RuntimeModuleEntry> {
  return {
    ...defaultRuntimeModules,
    ...(options?.additional ?? {}),
  }
}

function assertCompatibleInstall(
  install: RuntimePluginSupportInstall,
  modules: Record<string, RuntimeModuleEntry>,
  options: SolidRuntimePluginSupportOptions | undefined,
  requestedPreserve: NormalizedPreserve,
): void {
  for (const specifier of Object.keys(modules)) {
    if (!install.specifiers.has(specifier)) {
      throw new Error(
        `OpenTUI Solid runtime plugin support is already installed without ${specifier}. Call ensureRuntimePluginSupport({ additional }) from @opentui/solid/runtime-plugin-support/configure before importing @opentui/solid/runtime-plugin-support.`,
      )
    }
  }

  if (options?.core && options.core !== install.core) {
    throw new Error("OpenTUI Solid runtime plugin support is already installed with a different core runtime module.")
  }

  if (!isCompatiblePreserve(install.preserve, requestedPreserve)) {
    throw new Error("OpenTUI Solid runtime plugin support is already installed with different preserve options.")
  }

  if (options?.rewrite && normalizeRewriteKey(options.rewrite) !== install.rewriteKey) {
    throw new Error("OpenTUI Solid runtime plugin support is already installed with different rewrite options.")
  }
}

export function ensureRuntimePluginSupport(options: SolidRuntimePluginSupportOptions = {}): boolean {
  const state = globalThis as RuntimePluginSupportState
  const modules = createRuntimeModules(options)
  const core = options.core ?? (coreRuntime as Record<string, unknown>)
  const preserve = normalizePreserve(options.preserve)
  const rewriteKey = normalizeRewriteKey(options.rewrite)

  const install = state[runtimePluginSupportInstalledKey]
  if (install) {
    assertCompatibleInstall(install, modules, options, preserve)
    return false
  }

  ensureSolidTransformPlugin({
    moduleName: runtimeModuleIdForSpecifier("@opentui/solid"),
    resolvePath(specifier) {
      if (!isCoreRuntimeModuleSpecifier(specifier) && !modules[specifier]) {
        return null
      }

      return runtimeModuleIdForSpecifier(specifier)
    },
  })

  registerBunPlugin(
    createRuntimePlugin({
      core,
      additional: modules,
      preserve,
      rewrite: options.rewrite,
    }),
  )

  state[runtimePluginSupportInstalledKey] = {
    specifiers: new Set(Object.keys(modules)),
    core,
    preserve,
    rewriteKey,
  }
  return true
}

export type { RuntimeSpecifierPreserve } from "@opentui/core/runtime-plugin"
