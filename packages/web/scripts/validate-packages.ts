#!/usr/bin/env bun

import { promises as fs } from "node:fs"
import { resolve } from "node:path"
import { githubRepository, githubRepositoryIdentifier, type PackageEntry } from "../src/lib/package-schema"
import { loadRemotePackageFacts, PACKAGE_COUNT_MAX } from "../src/lib/remote-package-facts"
import { parsePackageEntryFile } from "./package-entry-file"

type EntryFile = { entry: PackageEntry; path: string }

async function main() {
  const network = process.argv.includes("--network")
  const arguments_ = process.argv.slice(2).filter((argument) => argument !== "--network")
  if (arguments_.length !== 1) fail("Usage: bun scripts/validate-packages.ts <entries-directory> [--network]")

  const localDirectory = resolve(import.meta.dir, "../src/content/packages")
  const targetDirectory = resolve(arguments_[0])
  const directories = [...new Set([localDirectory, targetDirectory])]
  const violations: string[] = []
  const files = (
    await Promise.all(
      directories.map((directory) =>
        readDirectory(directory, directory === localDirectory || targetDirectory === localDirectory),
      ),
    )
  ).flat()
  if (files.length > PACKAGE_COUNT_MAX) {
    fail(`Package entry count ${files.length} exceeds maximum ${PACKAGE_COUNT_MAX}`)
  }
  const entries = (await Promise.all(files.map((path) => parseEntry(path, violations)))).flat()
  const entriesById = new Map<string, EntryFile>()

  for (const entryFile of entries) {
    const previous = entriesById.get(entryFile.entry.id)
    if (previous) violations.push(`duplicate id \`${entryFile.entry.id}\`: ${previous.path}, ${entryFile.path}`)
    else entriesById.set(entryFile.entry.id, entryFile)
  }

  await validateFacts(targetDirectory, targetDirectory !== localDirectory, entriesById, violations)
  if (network) await validateNetwork(entries, violations)

  if (violations.length) {
    console.error("Package validation failed:\n")
    for (const violation of violations.toSorted()) console.error(`- ${violation}`)
    process.exit(1)
  }

  console.log(`Package validation passed for ${entries.length} entries${network ? " with network checks" : ""}.`)
}

async function validateFacts(
  directory: string,
  required: boolean,
  entriesById: Map<string, EntryFile>,
  violations: string[],
): Promise<void> {
  const factsPath = resolve(directory, "facts.json")
  try {
    const facts = await loadRemotePackageFacts(directory, required)
    const factsById = new Map(facts.map((fact) => [fact.id, fact]))
    for (const fact of facts) {
      const entryFile = entriesById.get(fact.id)
      if (!entryFile) {
        if (fact.version !== undefined || fact.license !== undefined) {
          violations.push(`${factsPath}: unknown package id \`${fact.id}\``)
        }
      } else if (entryFile.entry.official && (fact.version !== undefined || fact.license !== undefined)) {
        violations.push(`${factsPath}: first-party fact \`${fact.id}\` may contain only stars`)
      }
    }
    if (required) {
      for (const { entry } of entriesById.values()) {
        if (entry.official) continue
        const fact = factsById.get(entry.id)
        if (githubRepository(entry.source.url) && fact?.stars === undefined) {
          violations.push(`${factsPath}: missing stars for \`${entry.id}\``)
        }
        const hasVersionSource = entry.distributions.some(
          (distribution) =>
            (distribution.type === "npm" || distribution.type === "github-release") && distribution.identifier,
        )
        if (!entry.official && hasVersionSource && fact?.version === undefined) {
          violations.push(`${factsPath}: missing version for \`${entry.id}\``)
        }
      }
    }
  } catch (error) {
    violations.push(error instanceof Error ? error.message : String(error))
  }
}

async function readDirectory(directory: string, allowMissing: boolean): Promise<string[]> {
  let entries
  try {
    entries = await fs.readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mdx"))
    .map((entry) => resolve(directory, entry.name))
    .toSorted()
}

async function parseEntry(path: string, violations: string[]): Promise<EntryFile[]> {
  try {
    return [{ entry: await parsePackageEntryFile(path), path }]
  } catch (error) {
    violations.push(error instanceof Error ? error.message : String(error))
    return []
  }
}

async function validateNetwork(entries: EntryFile[], violations: string[]) {
  const checks = new Map<string, { label: string; url: string }>()
  for (const { entry, path } of entries) {
    const repository = githubRepository(entry.source.url)
    const repositoryUrl = repository
      ? `https://api.github.com/repos/${repository}`
      : entry.source.url.replace(/\.git$/, "")
    checks.set(repositoryUrl, { label: `${path}: source repository`, url: repositoryUrl })

    for (const distribution of entry.distributions) {
      if (distribution.type === "npm" && distribution.identifier) {
        const url = `https://registry.npmjs.org/${encodeURIComponent(distribution.identifier)}`
        checks.set(url, {
          label: `${path}: npm package \`${distribution.identifier}\``,
          url,
        })
      }
      if (distribution.type === "github-release" && distribution.identifier) {
        const repository = githubRepositoryIdentifier(distribution.identifier)
        if (!repository) {
          violations.push(`${path}: invalid GitHub repository identifier \`${distribution.identifier}\``)
          continue
        }
        const url = `https://api.github.com/repos/${repository}`
        checks.set(url, {
          label: `${path}: GitHub repository \`${distribution.identifier}\``,
          url,
        })
      }
    }
  }

  for (const { label, url } of checks.values()) {
    try {
      const github = new URL(url).hostname === "api.github.com"
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "opentui-package-validator",
          ...(github && process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
          ...(github ? { "X-GitHub-Api-Version": "2022-11-28" } : {}),
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) {
        const reset = response.headers.get("x-ratelimit-reset")
        violations.push(`${label} does not exist (${response.status}${reset ? `; rate limit resets at ${reset}` : ""})`)
      }
    } catch (error) {
      violations.push(`${label} check failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
