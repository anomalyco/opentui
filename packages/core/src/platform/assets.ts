import { statSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"

import { registerEnvVar } from "../lib/env.js"

type AssetFallback = string | URL | (() => string | URL)

registerEnvVar({
  name: "OTUI_ASSET_ROOT",
  description: "Absolute directory containing relocatable OpenTUI runtime assets",
  type: "string",
  default: "",
})

export function resolveAssetPath(key: string, fallback?: AssetFallback): string {
  validateAssetKey(key)

  const configuredPath = resolveAssetRootPath(key)
  if (configuredPath !== undefined) {
    return configuredPath
  }

  if (fallback === undefined) {
    throw new Error(`OpenTUI asset ${JSON.stringify(key)} has no package-relative fallback`)
  }

  const value = typeof fallback === "function" ? fallback() : fallback
  return value instanceof URL ? fileURLToPath(value) : value
}

export function resolveAssetRootPath(key: string): string | undefined {
  validateAssetKey(key)

  const root = process.env.OTUI_ASSET_ROOT
  if (!root) {
    return undefined
  }

  if (!isAbsolute(root)) {
    throw new Error(`OTUI_ASSET_ROOT must be an absolute directory, got ${JSON.stringify(root)}`)
  }

  const assetPath = join(root, key)
  let isFile = false
  try {
    isFile = statSync(assetPath).isFile()
  } catch {}
  if (!isFile) {
    throw new Error(`Missing OpenTUI asset ${JSON.stringify(key)} at ${JSON.stringify(assetPath)}`)
  }
  return assetPath
}

export function validateAssetKey(key: string): void {
  if (key.length === 0 || isAbsolute(key) || key.includes("\\") || key.split("/").includes("..")) {
    throw new Error(`Invalid OpenTUI asset key: ${JSON.stringify(key)}`)
  }
}
