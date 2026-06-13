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

  return "./" + path.relative(path.dirname(outputPath), languagePath)
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

  return "./" + path.relative(path.dirname(outputPath), queryPath)
}

async function generateDefaultParsersFile(parsers: GeneratedParser[], outputPath: string): Promise<void> {
  const assetPaths = parsers
    .map((parser) => {
      const safeFiletype = parser.filetype.replace(/[^a-zA-Z0-9]/g, "_")
      const lines = [
        `const ${safeFiletype}_highlights = await resolveBundledFilePath(`,
        `  () => import("${parser.highlightsPath}" as string, { with: { type: "file" } }),`,
        `  "${parser.highlightsPath}",`,
        `  import.meta.url,`,
        `)`,
        `const ${safeFiletype}_language = await resolveBundledFilePath(`,
        `  () => import("${parser.languagePath}" as string, { with: { type: "file" } }),`,
        `  "${parser.languagePath}",`,
        `  import.meta.url,`,
        `)`,
      ]

      if (parser.injectionsPath) {
        lines.push(
          `const ${safeFiletype}_injections = await resolveBundledFilePath(`,
          `  () => import("${parser.injectionsPath}" as string, { with: { type: "file" } }),`,
          `  "${parser.injectionsPath}",`,
          `  import.meta.url,`,
          `)`,
        )
      }

      return lines.join("\n")
    })
    .join("\n")

  const parserDefinitions = parsers
    .map((parser) => {
      const safeFiletype = parser.filetype.replace(/[^a-zA-Z0-9]/g, "_")
      const queriesLines = [`          highlights: [${safeFiletype}_highlights],`]

      if (parser.injectionsPath) {
        queriesLines.push(`          injections: [${safeFiletype}_injections],`)
      }

      const injectionMappingLine = parser.injectionMapping
        ? `        injectionMapping: ${JSON.stringify(parser.injectionMapping, null, 10)},`
        : ""
      const aliasesLine = parser.aliases?.length ? `        aliases: ${JSON.stringify(parser.aliases)},` : ""

      return `      {
        filetype: "${parser.filetype}",
${aliasesLine ? aliasesLine + "\n" : ""}        queries: {
${queriesLines.join("\n")}
        },
        wasm: ${safeFiletype}_language,${injectionMappingLine ? "\n" + injectionMappingLine : ""}
      }`
    })
    .join(",\n")

  const fileContent = `// This file is generated by assets/update.ts - DO NOT EDIT MANUALLY
// Run 'bun assets/update.ts' to regenerate this file
// Last generated: ${new Date().toISOString()}

import type { FiletypeParserOptions } from "./types.js"
import { resolveBundledFilePath } from "../../platform/runtime.js"

// Cached parsers to avoid re-resolving paths on every call
let _cachedParsers: Promise<FiletypeParserOptions[]> | undefined

export function getParsers(): Promise<FiletypeParserOptions[]> {
  if (!_cachedParsers) {
    _cachedParsers = loadParsers()
  }
  return _cachedParsers
}

async function loadParsers(): Promise<FiletypeParserOptions[]> {
${assetPaths}

  return [
${parserDefinitions},
  ]
}
`

  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, fileContent, "utf-8")
  console.log(`Generated ${path.basename(outputPath)} with ${parsers.length} parsers`)
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
