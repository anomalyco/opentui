import { resolve } from "node:path"

import { getCurrentNodeAssetTarget, getNativeAssetDescriptor } from "../node-asset-target.js"
import { resolveAssetPath, resolveAssetRootPath } from "./assets.js"

interface NativePackageModule {
  readonly default: string
}

const CORE_ASSET_PREFIX = "@opentui/core/"
const PARSER_WORKER_ASSET_KEY = `${CORE_ASSET_PREFIX}parser.worker.js`
const TREE_SITTER_WASM_ASSET_KEY = "web-tree-sitter/tree-sitter.wasm"

export function resolveDefaultParserAsset(relativePath: string, fallbackPath: URL): Promise<string> {
  return Promise.resolve(resolveAssetPath(`${CORE_ASSET_PREFIX}${relativePath}`, fallbackPath))
}

export function resolveDefaultTreeSitterWorkerPath(fallbackPath: URL): string {
  return resolveAssetPath(PARSER_WORKER_ASSET_KEY, fallbackPath)
}

export function resolveTreeSitterWasm(): Promise<string> {
  return Promise.resolve(
    resolveAssetPath(TREE_SITTER_WASM_ASSET_KEY, () => new URL(import.meta.resolve(TREE_SITTER_WASM_ASSET_KEY))),
  )
}

export async function resolveNativeLibraryPath(): Promise<string> {
  const asset = getNativeAssetDescriptor(getCurrentNodeAssetTarget())
  if (process.env.OPENTUI_LIB_PATH) {
    return resolve(process.env.OPENTUI_LIB_PATH)
  }

  const configuredPath = resolveAssetRootPath(asset.key)
  if (configuredPath !== undefined) {
    return configuredPath
  }

  const specifier: string = asset.packageName
  return ((await import(specifier)) as NativePackageModule).default
}
