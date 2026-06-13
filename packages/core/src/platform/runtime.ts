import { existsSync } from "node:fs"
import { mkdir, writeFile as writeFileNode } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import stringWidthLib from "string-width"
import stripAnsiLib from "strip-ansi"

export interface WriteFileOptions {
  createPath?: boolean
  mode?: number
}

interface BunLike {
  sleep(msOrDate: number | Date): Promise<void>
  stringWidth(text: string): number
  stripANSI(text: string): string
  write(destination: string | URL, data: string | ArrayBufferView, options?: WriteFileOptions): Promise<number>
}

interface FileImportModule {
  default: string
}

type FilePathFallback = string | URL | (() => string | URL)

type GlobalWithBun = typeof globalThis & { Bun?: BunLike }

const TEXT_ENCODER = new TextEncoder()
const bun = (globalThis as GlobalWithBun).Bun

export const sleep: (msOrDate: number | Date) => Promise<void> = bun?.sleep ?? standardSleep
export const stringWidth: (text: string) => number = bun?.stringWidth ?? stringWidthLib
export const stripANSI: (text: string) => string = bun?.stripANSI ?? stripAnsiLib
export const writeFile: (
  destination: string | URL,
  data: string | ArrayBufferView,
  options?: WriteFileOptions,
) => Promise<number> = bun?.write ?? writeFilePortable

// Bun only discovers bundled file-like assets from the literal import expression at the call site.
export async function resolveBundledFilePath(
  loadBundledFile: () => Promise<FileImportModule>,
  fallbackPath: FilePathFallback,
  metaUrl: string,
): Promise<string> {
  if (!bun) {
    const path = resolveFallbackFilePath(fallbackPath, metaUrl)
    if (existsSync(path)) {
      return path
    }

    return (await loadBundledFilePath(loadBundledFile, metaUrl)) ?? path
  }

  return normalizeLoadedFilePath((await loadBundledFile()).default, metaUrl)
}

function resolveFallbackFilePath(fallbackPath: FilePathFallback, metaUrl: string): string {
  const path = typeof fallbackPath === "function" ? fallbackPath() : fallbackPath
  return fileURLToPath(path instanceof URL ? path : new URL(path, metaUrl))
}

function normalizeLoadedFilePath(loadedPath: string, baseUrl: string): string {
  if (loadedPath.startsWith("file:")) {
    return fileURLToPath(loadedPath)
  }

  if (isAbsolute(loadedPath)) {
    return loadedPath
  }

  return resolve(dirname(fileURLToPath(baseUrl)), loadedPath)
}

async function loadBundledFilePath(
  loadBundledFile: () => Promise<FileImportModule>,
  metaUrl: string,
): Promise<string | undefined> {
  const specifier = extractBundledImportSpecifier(loadBundledFile)
  if (!specifier) {
    return undefined
  }

  try {
    const moduleUrl = new URL(specifier, metaUrl)
    const loaded = (await import(moduleUrl.href)) as FileImportModule
    return normalizeLoadedFilePath(loaded.default, moduleUrl.href)
  } catch {
    return undefined
  }
}

function extractBundledImportSpecifier(loadBundledFile: () => Promise<FileImportModule>): string | undefined {
  const match = String(loadBundledFile).match(/\bimport\(\s*(["'`])([^"'`]+)\1/)
  return match?.[2]
}

function standardSleep(msOrDate: number | Date): Promise<void> {
  const ms = msOrDate instanceof Date ? msOrDate.getTime() - Date.now() : msOrDate
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function writeFilePortable(
  destination: string | URL,
  data: string | ArrayBufferView,
  options?: WriteFileOptions,
): Promise<number> {
  const destinationPath = destination instanceof URL ? fileURLToPath(destination) : destination

  if (options?.createPath) {
    await mkdir(dirname(destinationPath), { recursive: true })
  }

  const bytes =
    typeof data === "string" ? TEXT_ENCODER.encode(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)

  await writeFileNode(destinationPath, bytes, { mode: options?.mode })

  return bytes.byteLength
}
