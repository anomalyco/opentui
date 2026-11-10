#!/usr/bin/env bun

import { readFile, writeFile, mkdir } from "fs/promises"
import * as path from "path"
import { DownloadUtils } from "../download-utils.js"
import { parseArgs } from "util"
import type { FiletypeParserOptions } from "../types.js"
import { readdir } from "fs/promises"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

interface ParsersConfig {
  parsers: FiletypeParserOptions[]
}

interface GeneratedParser {
  filetype: string
  aliases?: string[]
  languagePath: string
  highlightsPath: string
  injectionsPath?: string
  injectionMapping?: any
}

export interface UpdateOptions {
  /** Path to parsers-config.json */
  configPath: string
  /** Directory where .wasm and .scm files will be downloaded */
  assetsDir: string
  /** Path where the generated TypeScript file will be written */
  outputPath: string
}

function getDefaultOptions(): UpdateOptions {
  return {
    configPath: path.resolve(__dirname, "../parsers-config"),
    assetsDir: path.resolve(__dirname),
    outputPath: path.resolve(__dirname, "../default-parsers.ts"),
  }
}

async function loadConfig(configPath: string): Promise<ParsersConfig> {
  let ext = path.extname(configPath)
  let resolvedConfigPath = configPath

  if (ext === "") {
    const files = await readdir(path.dirname(configPath))
    const file = files.find(
      (file) =>
        file.startsWith(path.basename(configPath)) &&
        (file.endsWith(".json") || file.endsWith(".ts") || file.endsWith(".js")),
    )
    if (!file) {
      throw new Error(`No config file found for ${configPath}`)
    }
    resolvedConfigPath = path.join(path.dirname(configPath), file)
    ext = path.extname(resolvedConfigPath)
  }

  if (ext === ".json") {
    const configContent = await readFile(resolvedConfigPath, "utf-8")
    return JSON.parse(configContent)
  } else if (ext === ".ts" || ext === ".js") {
    const { default: configContent } = await import(resolvedConfigPath)
    return configContent
  }
  throw new Error(`Unsupported config file extension: ${ext}`)
}

async function downloadLanguage(
  filetype: string,
  languageUrl: string,
  assetsDir: string,
  outputPath: string,
): Promise<string> {
  const languageDir = path.join(assetsDir, filetype)
  const languageFilename = path.basename(languageUrl)
  const languagePath = path.join(languageDir, languageFilename)

  const result = await DownloadUtils.downloadToPath(languageUrl, languagePath)

  if (result.error) {
    throw new Error(`Failed to download language for ${filetype}: ${result.error}`)
  }

  return "./" + path.relative(path.dirname(outputPath), languagePath).replaceAll(path.sep, "/")
}

async function downloadAndCombineQueries(
  filetype: string,
  queryUrls: string[],
  assetsDir: string,
  outputPath: string,
  queryType: "highlights" | "injections",
  configPath: string,
): Promise<string> {
  const queriesDir = path.join(assetsDir, filetype)
  const queryPath = path.join(queriesDir, `${queryType}.scm`)

  const queryContents: string[] = []

  for (let i = 0; i < queryUrls.length; i++) {
    const queryUrl = queryUrls[i]

    if (queryUrl.startsWith("./")) {
      console.log(`    Using local query ${i + 1}/${queryUrls.length}: ${queryUrl}`)

      try {
        const localPath = path.resolve(path.dirname(configPath), queryUrl)
        const content = await readFile(localPath, "utf-8")

        if (content.trim()) {
          queryContents.push(content)
          console.log(`    ✓ Loaded ${content.split("\n").length} lines from local file`)
        }
      } catch (error) {
        console.warn(`Failed to read local query from ${queryUrl}: ${error}`)
        continue
      }
    } else {
      console.log(`    Downloading query ${i + 1}/${queryUrls.length}: ${queryUrl}`)

      try {
        const response = await fetch(queryUrl)
        if (!response.ok) {
          console.warn(`Failed to download query from ${queryUrl}: ${response.statusText}`)
          continue
        }

        const content = await response.text()
        if (content.trim()) {
          queryContents.push(`; Query from: ${queryUrl}\n${content}`)
          console.log(`    ✓ Downloaded ${content.split("\n").length} lines`)
        }
      } catch (error) {
        console.warn(`Failed to download query from ${queryUrl}: ${error}`)
        continue
      }
    }
  }

  const combinedContent = queryContents.join("\n\n")
  await writeFile(queryPath, combinedContent, "utf-8")

  console.log(`  Combined ${queryContents.length} queries into ${queryPath}`)

  return "./" + path.relative(path.dirname(outputPath), queryPath).replaceAll(path.sep, "/")
}

async function generateDefaultParsersFile(parsers: GeneratedParser[], outputPath: string): Promise<void> {
  const descriptors = parsers.map((parser) => ({
    filetype: parser.filetype,
    ...(parser.aliases?.length ? { aliases: parser.aliases } : {}),
    queries: {
      highlights: [toPackageRelativeAssetPath(parser.highlightsPath)],
      ...(parser.injectionsPath ? { injections: [toPackageRelativeAssetPath(parser.injectionsPath)] } : {}),
    },
    wasm: toPackageRelativeAssetPath(parser.languagePath),
    ...(parser.injectionMapping ? { injectionMapping: parser.injectionMapping } : {}),
  }))
  const assetPaths = [
    ...new Set(
      parsers.flatMap((parser) =>
        [parser.highlightsPath, parser.languagePath, parser.injectionsPath]
          .filter((assetPath): assetPath is string => assetPath !== undefined)
          .map(toPackageRelativeAssetPath),
      ),
    ),
  ]
  const isDefaultOutput = path.resolve(outputPath) === getDefaultOptions().outputPath
  const bundledAssetLoaderEntries = assetPaths
    .map(
      (assetPath) =>
        `  ${JSON.stringify(assetPath)}: () => import(${JSON.stringify(`./${assetPath}`)} as string, { with: { type: "file" } }),`,
    )
    .join("\n")
  const parserImports = isDefaultOutput
    ? `import { resolveDefaultParserAsset } from "#opentui/runtime-assets"

import type { FiletypeParserOptions, InjectionMapping } from "./types.js"`
    : `import { resolveBundledFilePath } from "@opentui/core"
import type { FiletypeParserOptions, InjectionMapping } from "@opentui/core"`
  const parserAssetLoaders = isDefaultOutput
    ? ""
    : `interface FileImportModule {
  readonly default: string
}

const bundledAssetLoaders: Record<string, () => Promise<FileImportModule>> = {
${bundledAssetLoaderEntries}
}

`
  const parserAssetResolver = isDefaultOutput
    ? `function resolveParserAsset(relativePath: string): Promise<string> {
  return resolveDefaultParserAsset(relativePath, new URL(\`./\${relativePath}\`, import.meta.url))
}`
    : `function resolveParserAsset(relativePath: string): Promise<string> {
  const loadBundledFile = bundledAssetLoaders[relativePath]
  if (!loadBundledFile) {
    throw new Error(\`Unknown parser asset: \${JSON.stringify(relativePath)}\`)
  }
  return resolveBundledFilePath(
    relativePath,
    loadBundledFile,
    new URL(\`./\${relativePath}\`, import.meta.url),
    import.meta.url,
    { loadBundledFileFallback: true, useAssetRoot: false },
  )
}`

  const parserFile = `// This file is generated by assets/update.ts - DO NOT EDIT MANUALLY
// Run 'bun assets/update.ts' to regenerate this file

${parserImports}

${parserAssetLoaders}interface DefaultParserDescriptor {
  readonly filetype: string
  readonly aliases?: readonly string[]
  readonly queries: {
    readonly highlights: readonly string[]
    readonly injections?: readonly string[]
  }
  readonly wasm: string
  readonly injectionMapping?: InjectionMapping
}

const defaultParserDescriptors: readonly DefaultParserDescriptor[] = ${JSON.stringify(descriptors, null, 2)}

export const defaultParserAssetPaths: readonly string[] = [
  ...new Set(
    defaultParserDescriptors.flatMap((parser) => [
      ...parser.queries.highlights,
      parser.wasm,
      ...(parser.queries.injections ?? []),
    ]),
  ),
]

let cachedParsers: Promise<FiletypeParserOptions[]> | undefined

export function getParsers(): Promise<FiletypeParserOptions[]> {
  cachedParsers ??= Promise.all(defaultParserDescriptors.map(resolveDefaultParser))
  return cachedParsers
}

async function resolveDefaultParser(parser: DefaultParserDescriptor): Promise<FiletypeParserOptions> {
  const queries: FiletypeParserOptions["queries"] = {
    highlights: await Promise.all(parser.queries.highlights.map(resolveParserAsset)),
  }
  if (parser.queries.injections) {
    queries.injections = await Promise.all(parser.queries.injections.map(resolveParserAsset))
  }

  return {
    filetype: parser.filetype,
    ...(parser.aliases ? { aliases: [...parser.aliases] } : {}),
    queries,
    wasm: await resolveParserAsset(parser.wasm),
    ...(parser.injectionMapping ? { injectionMapping: parser.injectionMapping } : {}),
  }
}

${parserAssetResolver}
`

  const bunAssetFile = `// This file is generated by assets/update.ts - DO NOT EDIT MANUALLY
// Run 'bun assets/update.ts' to regenerate this file

import { resolveBundledFilePath } from "../../platform/runtime.js"

interface FileImportModule {
  readonly default: string
}

const bundledAssetLoaders: Record<string, () => Promise<FileImportModule>> = {
${bundledAssetLoaderEntries}
}

export function resolveBundledDefaultParserAsset(relativePath: string, fallbackPath: URL): Promise<string> {
  const loadBundledFile = bundledAssetLoaders[relativePath]
  if (!loadBundledFile) {
    throw new Error(\`Unknown OpenTUI default parser asset: \${JSON.stringify(relativePath)}\`)
  }
  return resolveBundledFilePath(
    \`@opentui/core/\${relativePath}\`,
    loadBundledFile,
    fallbackPath,
    import.meta.url,
  )
}
`

  const bunAssetOutputPath = path.join(path.dirname(outputPath), "default-parser-assets.bun.ts")
  await mkdir(path.dirname(outputPath), { recursive: true })
  const writes = [writeFile(outputPath, parserFile, "utf-8")]
  if (isDefaultOutput) {
    writes.push(writeFile(bunAssetOutputPath, bunAssetFile, "utf-8"))
  }
  await Promise.all(writes)
  console.log(`Generated ${path.basename(outputPath)} with ${parsers.length} parsers`)
}

function toPackageRelativeAssetPath(assetPath: string): string {
  return assetPath.replace(/^\.\//, "")
}

async function main(options?: Partial<UpdateOptions>): Promise<void> {
  const opts = { ...getDefaultOptions(), ...options }

  try {
    console.log("Loading parsers configuration...")
    console.log(`  Config: ${opts.configPath}`)
    console.log(`  Assets Dir: ${opts.assetsDir}`)
    console.log(`  Output: ${opts.outputPath}`)

    const config = await loadConfig(opts.configPath)

    console.log(`Found ${config.parsers.length} parsers to process`)

    const generatedParsers: GeneratedParser[] = []

    for (const parser of config.parsers) {
      console.log(`Processing ${parser.filetype}...`)

      console.log(`  Downloading language...`)
      const languagePath = await downloadLanguage(parser.filetype, parser.wasm, opts.assetsDir, opts.outputPath)

      console.log(`  Downloading ${parser.queries.highlights.length} highlight queries...`)
      const highlightsPath = await downloadAndCombineQueries(
        parser.filetype,
        parser.queries.highlights,
        opts.assetsDir,
        opts.outputPath,
        "highlights",
        opts.configPath,
      )

      let injectionsPath: string | undefined
      if (parser.queries.injections && parser.queries.injections.length > 0) {
        console.log(`  Downloading ${parser.queries.injections.length} injection queries...`)
        injectionsPath = await downloadAndCombineQueries(
          parser.filetype,
          parser.queries.injections,
          opts.assetsDir,
          opts.outputPath,
          "injections",
          opts.configPath,
        )
      }

      generatedParsers.push({
        filetype: parser.filetype,
        aliases: parser.aliases,
        languagePath,
        highlightsPath,
        injectionsPath,
        injectionMapping: parser.injectionMapping,
      })

      console.log(`  ✓ Completed ${parser.filetype}`)
    }

    console.log("Generating output file...")
    await generateDefaultParsersFile(generatedParsers, opts.outputPath)

    console.log("✅ Update completed successfully!")
  } catch (error) {
    console.error("❌ Update failed:", error)
    process.exit(1)
  }
}

function parseCLIArgs(): Partial<UpdateOptions> | null {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        config: { type: "string" },
        assets: { type: "string" },
        output: { type: "string" },
        help: { type: "boolean" },
      },
      strict: true,
    })

    if (values.help) {
      const command = path.basename(Bun.argv[1] ?? "update-assets.js")

      console.log(`Usage: bun ${command} [options]

Options:
  --config <path>  Path to parsers-config.json
  --assets <path>  Directory where .wasm and .scm files will be downloaded
  --output <path>  Path where the generated TypeScript file will be written
  --help           Show this help message

Examples:
  # Use default paths (for OpenTUI core development)
  bun ${command}

  # Use custom paths (for application integration)
  bun ${command} --config ./my-parsers.json --assets ./src/parsers --output ./src/parsers.ts
`)
      process.exit(0)
    }

    const options: Partial<UpdateOptions> = {}
    if (values.config) options.configPath = path.resolve(values.config)
    if (values.assets) options.assetsDir = path.resolve(values.assets)
    if (values.output) options.outputPath = path.resolve(values.output)

    return Object.keys(options).length > 0 ? options : null
  } catch (error) {
    console.error(`Error parsing arguments: ${error}`)
    console.log("Run with --help for usage information")
    process.exit(1)
  }
}

export function runUpdateAssetsCli(): Promise<void> {
  const cliOptions = parseCLIArgs()
  return main(cliOptions || undefined)
}

if (import.meta.main) {
  await runUpdateAssetsCli()
}

export { main as updateAssets }
