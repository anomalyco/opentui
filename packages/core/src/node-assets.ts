import { statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { defaultParserAssetPaths } from "./lib/tree-sitter/default-parsers.js"
import { getNativeAssetDescriptor, type NodeAssetTarget } from "./node-asset-target.js"
import { validateAssetKey } from "./platform/assets.js"

export type { NodeAssetTarget }

export type NodeAsset = {
  readonly key: string
  readonly source: string
}

const CORE_PREFIX = "@opentui/core/"
const PARSER_WORKER_KEY = `${CORE_PREFIX}parser.worker.js`
const TREE_SITTER_WASM_KEY = "web-tree-sitter/tree-sitter.wasm"

export function getNodeAssets(target: NodeAssetTarget): readonly NodeAsset[] {
  const native = getNativeAssetDescriptor(target)
  const coreRoot = resolveCoreRuntimeRoot()
  const parserRoot = resolve(dirname(fileURLToPath(import.meta.url)), "lib/tree-sitter")
  const nativeRoot = dirname(resolvePackageEntry(native.packageName))
  const assets: NodeAsset[] = [
    { key: native.key, source: join(nativeRoot, native.fileName) },
    { key: PARSER_WORKER_KEY, source: join(coreRoot, "parser.worker.js") },
    ...defaultParserAssetPaths.map((relativePath) => ({
      key: `${CORE_PREFIX}${relativePath}`,
      source: firstExistingFile(join(coreRoot, relativePath), join(parserRoot, relativePath)),
    })),
    { key: TREE_SITTER_WASM_KEY, source: resolvePackageEntry(TREE_SITTER_WASM_KEY) },
  ]

  const keys = new Set<string>()
  for (const asset of assets) {
    validateAssetKey(asset.key)
    if (keys.has(asset.key)) {
      throw new Error(`Duplicate OpenTUI Node asset key: ${JSON.stringify(asset.key)}`)
    }
    keys.add(asset.key)

    let isFile = false
    try {
      isFile = statSync(asset.source).isFile()
    } catch {}
    if (!isFile) {
      throw new Error(`Missing OpenTUI Node asset ${JSON.stringify(asset.key)} at ${JSON.stringify(asset.source)}`)
    }
  }

  return assets.toSorted((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
}

function resolveCoreRuntimeRoot(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const candidates = [moduleDirectory, resolve(moduleDirectory, "../dist")]
  return candidates.find((candidate) => statIsFile(join(candidate, "parser.worker.js"))) ?? moduleDirectory
}

function firstExistingFile(...paths: string[]): string {
  return paths.find(statIsFile) ?? paths[0]!
}

function resolvePackageEntry(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier))
}

function statIsFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
