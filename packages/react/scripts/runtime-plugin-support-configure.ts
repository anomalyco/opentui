import { plugin as registerBunPlugin } from "bun"
import * as coreRuntime from "@opentui/core"
import {
  createRuntimePlugin,
  type RuntimeModuleEntry,
  type RuntimePluginRewriteOptions,
  type RuntimeSpecifierPreserve,
} from "@opentui/core/runtime-plugin"
import * as reactRuntime from "react"
import * as reactJsxRuntime from "react/jsx-runtime"
import * as reactJsxDevRuntime from "react/jsx-dev-runtime"
import * as opentuiReactRuntime from "../index.js"

const runtimePluginSupportInstalledKey = "__opentuiReactRuntimePluginSupportInstalled__"

export interface ReactRuntimePluginSupportOptions {
  additional?: Record<string, RuntimeModuleEntry>
  core?: RuntimeModuleEntry
  preserve?: RuntimeSpecifierPreserve
  rewrite?: RuntimePluginRewriteOptions
}

interface RuntimePluginSupportInstall {
  specifiers: ReadonlySet<string>
  core: RuntimeModuleEntry
  preserveKey: PreserveKey
  rewriteKey: string
}

type PreserveKey = string | ((specifier: string) => boolean) | undefined

type RuntimePluginSupportState = typeof globalThis & {
  [runtimePluginSupportInstalledKey]?: RuntimePluginSupportInstall
}

const defaultRuntimeModules: Record<string, RuntimeModuleEntry> = {
  "@opentui/react": opentuiReactRuntime as Record<string, unknown>,
  "@opentui/react/jsx-runtime": reactJsxRuntime as Record<string, unknown>,
  "@opentui/react/jsx-dev-runtime": reactJsxDevRuntime as Record<string, unknown>,
  react: reactRuntime as Record<string, unknown>,
  "react/jsx-runtime": reactJsxRuntime as Record<string, unknown>,
  "react/jsx-dev-runtime": reactJsxDevRuntime as Record<string, unknown>,
}

function normalizeRewriteKey(rewrite: RuntimePluginRewriteOptions | undefined): string {
  return `${rewrite?.nodeModulesRuntimeSpecifiers ?? true}:${rewrite?.nodeModulesBareSpecifiers ?? false}`
}

function normalizePreserveKey(preserve: RuntimeSpecifierPreserve | undefined): PreserveKey {
  if (preserve === undefined || typeof preserve === "function") {
    return preserve
  }

  const specifiers = [...new Set(preserve)].sort()
  return specifiers.length > 0 ? JSON.stringify(specifiers) : undefined
}

function createRuntimeModules(options?: ReactRuntimePluginSupportOptions): Record<string, RuntimeModuleEntry> {
  return {
    ...defaultRuntimeModules,
    ...(options?.additional ?? {}),
  }
}

function assertCompatibleInstall(
  install: RuntimePluginSupportInstall,
  modules: Record<string, RuntimeModuleEntry>,
  options?: ReactRuntimePluginSupportOptions,
): void {
  for (const specifier of Object.keys(modules)) {
    if (!install.specifiers.has(specifier)) {
      throw new Error(
        `OpenTUI React runtime plugin support is already installed without ${specifier}. Call ensureRuntimePluginSupport({ additional }) from @opentui/react/runtime-plugin-support/configure before importing @opentui/react/runtime-plugin-support.`,
      )
    }
  }

  if (options?.core && options.core !== install.core) {
    throw new Error("OpenTUI React runtime plugin support is already installed with a different core runtime module.")
  }

  if (options?.preserve && normalizePreserveKey(options.preserve) !== install.preserveKey) {
    throw new Error("OpenTUI React runtime plugin support is already installed with different preserve options.")
  }

  if (options?.rewrite && normalizeRewriteKey(options.rewrite) !== install.rewriteKey) {
    throw new Error("OpenTUI React runtime plugin support is already installed with different rewrite options.")
  }
}

export function ensureRuntimePluginSupport(options: ReactRuntimePluginSupportOptions = {}): boolean {
  const state = globalThis as RuntimePluginSupportState
  const modules = createRuntimeModules(options)
  const core = options.core ?? (coreRuntime as Record<string, unknown>)
  const rewriteKey = normalizeRewriteKey(options.rewrite)

  const install = state[runtimePluginSupportInstalledKey]
  if (install) {
    assertCompatibleInstall(install, modules, options)
    return false
  }

  registerBunPlugin(
    createRuntimePlugin({
      core,
      additional: modules,
      preserve: options.preserve,
      rewrite: options.rewrite,
    }),
  )

  state[runtimePluginSupportInstalledKey] = {
    specifiers: new Set(Object.keys(modules)),
    core,
    preserveKey: normalizePreserveKey(options.preserve),
    rewriteKey,
  }
  return true
}
