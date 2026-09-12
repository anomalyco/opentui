#!/usr/bin/env bun

import { promises as fs } from "node:fs"
import { resolve } from "node:path"
import { githubRepository, githubRepositoryIdentifier, type PackageEntry } from "../src/lib/package-schema"
import {
  PACKAGE_COUNT_MAX,
  remotePackageFactsSchema,
  type RemotePackageFact,
  type RemotePackageFacts,
} from "../src/lib/remote-package-facts"
import { parsePackageEntryFile } from "./package-entry-file"

const REQUEST_TIMEOUT_MS = 10_000
const RESPONSE_SIZE_MAX = 1024 * 1024
const GITHUB_REQUEST_MAX = 500

interface Requester {
  json(url: string): Promise<unknown>
  exists(url: string, method?: "GET" | "HEAD"): Promise<void>
}

export interface UpdatePackageFactsOptions {
  firstPartyDirectory?: string
  fetch?: typeof fetch
  githubToken?: string
}

export async function updatePackageFacts(
  communityDirectory: string,
  options: UpdatePackageFactsOptions = {},
): Promise<RemotePackageFacts> {
  const targetDirectory = resolve(communityDirectory)
  const firstPartyDirectory = resolve(
    options.firstPartyDirectory ?? resolve(import.meta.dir, "../src/content/packages"),
  )
  const directories = [...new Set([firstPartyDirectory, targetDirectory])]
  const files = (await Promise.all(directories.map(readEntryDirectory))).flat().toSorted()
  if (files.length > PACKAGE_COUNT_MAX) {
    throw new Error(`Package entry count ${files.length} exceeds maximum ${PACKAGE_COUNT_MAX}`)
  }

  const entries = await Promise.all(files.map(async (path) => ({ entry: await parsePackageEntryFile(path), path })))
  const pathsById = new Map<string, string>()
  for (const { entry, path } of entries) {
    const previous = pathsById.get(entry.id)
    if (previous) throw new Error(`Duplicate package id \`${entry.id}\`: ${previous}, ${path}`)
    pathsById.set(entry.id, path)
  }

  const request = createRequester(options.fetch ?? fetch, options.githubToken)
  const packages: RemotePackageFact[] = []
  for (const { entry } of entries) {
    const fact = await generateFact(entry, request)
    if (fact) packages.push(fact)
  }
  packages.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  const facts = remotePackageFactsSchema.parse({ schemaVersion: 1, packages })
  const contents = `${JSON.stringify(facts, null, 2)}\n`
  const outputPath = resolve(targetDirectory, "facts.json")
  const temporaryPath = `${outputPath}.${process.pid}.tmp`

  try {
    await fs.writeFile(temporaryPath, contents, "utf8")
    await fs.rename(temporaryPath, outputPath)
  } catch (error) {
    await fs.rm(temporaryPath, { force: true })
    throw error
  }

  return facts
}

async function readEntryDirectory(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mdx"))
    .map((entry) => resolve(directory, entry.name))
}

async function generateFact(entry: PackageEntry, request: Requester): Promise<RemotePackageFact | undefined> {
  const fact: RemotePackageFact = { id: entry.id }
  const sourceRepository = githubRepository(entry.source.url)
  let repositoryMetadata: unknown

  if (sourceRepository) {
    repositoryMetadata = await request.json(githubApiUrl(sourceRepository))
    fact.stars = requiredSafeInteger(repositoryMetadata, "stargazers_count", `GitHub repository ${sourceRepository}`)
  } else if (/^https?:/i.test(entry.source.url)) {
    await request.exists(entry.source.url)
  } else {
    throw new Error(`Cannot verify non-HTTP source URL: ${entry.source.url}`)
  }

  const npm = !entry.official
    ? entry.distributions.find((distribution) => distribution.type === "npm" && distribution.identifier !== undefined)
    : undefined
  const release =
    !entry.official && !npm
      ? entry.distributions.find(
          (distribution) => distribution.type === "github-release" && distribution.identifier !== undefined,
        )
      : undefined
  let npmMetadata: unknown
  let releaseMetadata: unknown
  for (const distribution of entry.distributions) {
    if (distribution.type === "npm" && distribution.identifier) {
      const url = `https://registry.npmjs.org/${encodeURIComponent(distribution.identifier)}`
      if (distribution === npm) npmMetadata = await request.json(`${url}/latest`)
      else await request.exists(url, "HEAD")
    } else if (distribution.type === "github-release" && distribution.identifier) {
      const repository = githubRepositoryIdentifier(distribution.identifier)
      if (!repository) throw new Error(`Invalid GitHub repository identifier: ${distribution.identifier}`)
      if (distribution === release) releaseMetadata = await request.json(`${githubApiUrl(repository)}/releases/latest`)
      else await request.json(githubApiUrl(repository))
    }
  }

  if (entry.official) return fact

  if (npm?.identifier) {
    const version = objectString(npmMetadata, "version")
    if (!version) throw new Error(`npm package ${npm.identifier} has no latest version`)
    fact.version = version
    fact.license = normalizeLicense(nestedValue(npmMetadata, ["license"])) ?? repositoryLicense(repositoryMetadata)
    return fact
  }

  if (release?.identifier) {
    const version = objectString(releaseMetadata, "tag_name")
    if (!version) throw new Error(`GitHub repository ${release.identifier} has no latest release tag`)
    fact.version = version
  }
  fact.license = repositoryLicense(repositoryMetadata)
  return fact.version === undefined && fact.license === undefined && fact.stars === undefined ? undefined : fact
}

function createRequester(fetch_: typeof fetch, githubToken?: string): Requester {
  if (githubToken !== undefined && (githubToken.length === 0 || /\s/.test(githubToken))) {
    throw new Error("GITHUB_TOKEN must be a nonempty token without whitespace")
  }
  const jsonRequests = new Map<string, Promise<unknown>>()
  const existenceRequests = new Map<string, Promise<void>>()
  let githubRequestCount = 0

  const checkGithubBudget = (url: string) => {
    if (new URL(url).hostname !== "api.github.com") return
    if (githubRequestCount === GITHUB_REQUEST_MAX) {
      throw new Error(`GitHub request count exceeds maximum ${GITHUB_REQUEST_MAX}`)
    }
    githubRequestCount++
  }

  return {
    json(url) {
      const existing = jsonRequests.get(url)
      if (existing) return existing
      checkGithubBudget(url)
      const result = fetchJson(fetch_, url, githubToken)
      jsonRequests.set(url, result)
      return result
    },
    exists(url, method = "GET") {
      const key = `${method} ${url}`
      const existing = existenceRequests.get(key)
      if (existing) return existing
      checkGithubBudget(url)
      const result = fetchExists(fetch_, url, method, githubToken)
      existenceRequests.set(key, result)
      return result
    },
  }
}

async function fetchJson(fetch_: typeof fetch, url: string, githubToken?: string): Promise<unknown> {
  const response = await fetchResponse(fetch_, url, "GET", githubToken)
  try {
    const contentLength = Number(response.headers.get("content-length"))
    if (Number.isFinite(contentLength) && contentLength > RESPONSE_SIZE_MAX) {
      throw new Error(`response is ${contentLength} bytes; maximum is ${RESPONSE_SIZE_MAX}`)
    }
    const body = await readResponseBody(response)
    return JSON.parse(body)
  } catch (error) {
    throw new Error(`Invalid JSON from ${url}: ${errorMessage(error)}`)
  }
}

async function fetchExists(
  fetch_: typeof fetch,
  url: string,
  method: "GET" | "HEAD",
  githubToken?: string,
): Promise<void> {
  const response = await fetchResponse(fetch_, url, method, githubToken)
  if (method === "GET") await response.body?.cancel()
}

async function fetchResponse(
  fetch_: typeof fetch,
  url: string,
  method: "GET" | "HEAD",
  githubToken?: string,
): Promise<Response> {
  const github = new URL(url).hostname === "api.github.com"
  const headers: Record<string, string> = { "User-Agent": "opentui-package-facts" }
  if (github) {
    headers.Accept = "application/vnd.github+json"
    headers["X-GitHub-Api-Version"] = "2022-11-28"
    if (githubToken) headers.Authorization = `Bearer ${githubToken}`
  }

  let response: Response
  try {
    response = await fetch_(url, { method, headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) {
    throw new Error(`Request failed for ${url}: ${redactToken(errorMessage(error), githubToken)}`)
  }
  if (response.ok) return response

  const remaining = response.headers.get("x-ratelimit-remaining")
  const retryAfter = response.headers.get("retry-after")
  const reset = response.headers.get("x-ratelimit-reset")
  const rateLimited = (response.status === 403 || response.status === 429) && (remaining === "0" || retryAfter !== null)
  const rateLimit = rateLimited
    ? `; rate limited${retryAfter ? `; retry after ${retryAfter} seconds` : reset ? `; resets at ${reset}` : ""}`
    : ""
  throw new Error(`Request failed for ${url}: HTTP ${response.status}${rateLimit}`)
}

async function readResponseBody(response: Response): Promise<string> {
  if (!response.body) return ""

  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > RESPONSE_SIZE_MAX) {
      throw new Error(`response exceeds maximum ${RESPONSE_SIZE_MAX} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString("utf8")
}

function githubApiUrl(repository: string): string {
  return `https://api.github.com/repos/${repository}`
}

function requiredSafeInteger(value: unknown, key: string, label: string): number {
  if (!value || typeof value !== "object") throw new Error(`${label} returned invalid metadata`)
  const result = Reflect.get(value, key)
  if (!Number.isSafeInteger(result) || (result as number) < 0) throw new Error(`${label} returned invalid ${key}`)
  return result as number
}

function repositoryLicense(metadata: unknown): string | undefined {
  const license = nestedString(metadata, ["license", "spdx_id"])
  return license && license !== "NOASSERTION" ? license : undefined
}

function normalizeLicense(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value
  if (value && typeof value === "object") return objectString(value, "type")
  return undefined
}

function nestedString(value: unknown, path: string[]): string | undefined {
  const nested = nestedValue(value, path)
  return typeof nested === "string" && nested.length > 0 ? nested : undefined
}

function nestedValue(value: unknown, path: string[]): unknown {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== "object") return undefined
    current = Reflect.get(current, key)
  }
  return current
}

function objectString(value: unknown, key: string): string | undefined {
  return nestedString(value, [key])
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redactToken(message: string, token?: string): string {
  return token ? message.replaceAll(token, "[REDACTED]") : message
}

async function main() {
  const arguments_ = process.argv.slice(2)
  if (arguments_.length !== 1)
    throw new Error("Usage: bun scripts/update-package-facts.ts <community-entries-directory>")
  const facts = await updatePackageFacts(arguments_[0], { githubToken: process.env.GITHUB_TOKEN })
  console.log(`Updated ${resolve(arguments_[0], "facts.json")} with ${facts.packages.length} package records.`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(errorMessage(error))
    process.exit(1)
  })
}
