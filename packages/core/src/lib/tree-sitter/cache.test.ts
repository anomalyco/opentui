import { test, expect, beforeEach, beforeAll, afterAll, describe } from "bun:test"
import { TreeSitterClient, addDefaultParsers } from "./client.js"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { FiletypeParserOptions } from "./types.js"

describe("TreeSitterClient Caching", () => {
  let dataPath: string
  let testServer: Server | undefined
  const TEST_PORT = 55231
  const TEST_HOST = "127.0.0.1"
  const BASE_URL = `http://${TEST_HOST}:${TEST_PORT}`
  const DATA_ROOT = join(tmpdir(), "tree-sitter-cache-test")

  beforeAll(async () => {
    const assetsDir = resolve(dirname(fileURLToPath(import.meta.url)), "assets")

    testServer = createServer((req, res) => {
      const url = new URL(req.url ?? "/", BASE_URL)
      const filePath = join(assetsDir, url.pathname)
      res.end(readFileSync(filePath))
    })

    await new Promise<void>((resolve, reject) => {
      testServer!.once("error", reject)
      testServer!.listen(TEST_PORT, TEST_HOST, () => {
        testServer!.off("error", reject)
        resolve()
      })
    })

    await mkdir(DATA_ROOT, { recursive: true })
  })

  afterAll(async () => {
    if (testServer) {
      await new Promise<void>((resolve, reject) => {
        testServer!.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
      testServer = undefined
    }
  })

  beforeEach(async () => {
    dataPath = join(DATA_ROOT, Math.random().toString(36).slice(2))
    await mkdir(dataPath, { recursive: true })
  })

  test("should create storage directories on initialization", async () => {
    const client = new TreeSitterClient({ dataPath })
    await client.initialize()

    const languagesDir = join(dataPath, "tree-sitter", "languages")
    const queriesDir = join(dataPath, "tree-sitter", "queries")

    const languagesStat = await stat(languagesDir)
    const queriesStat = await stat(queriesDir)

    expect(languagesStat.isDirectory()).toBe(true)
    expect(queriesStat.isDirectory()).toBe(true)

    await client.destroy()
  })

  test("should cache downloaded language files", async () => {
    const client = new TreeSitterClient({ dataPath })
    await client.initialize()

    // Add URL-based parser for this test
    client.addFiletypeParser({
      filetype: "javascript",
      queries: {
        highlights: [`${BASE_URL}/javascript/highlights.scm`],
      },
      wasm: `${BASE_URL}/javascript/tree-sitter-javascript.wasm`,
    })

    const hasParser = await client.preloadParser("javascript")
    expect(hasParser).toBe(true)

    const languagesDir = join(dataPath, "tree-sitter", "languages")
    const cachedFiles = await readdir(languagesDir)

    expect(cachedFiles).toContain("tree-sitter-javascript.wasm")

    await client.destroy()
  })

  test("should cache downloaded highlight queries", async () => {
    const client = new TreeSitterClient({ dataPath })
    await client.initialize()

    // Add URL-based parser for this test
    client.addFiletypeParser({
      filetype: "javascript",
      queries: {
        highlights: [`${BASE_URL}/javascript/highlights.scm`],
      },
      wasm: `${BASE_URL}/javascript/tree-sitter-javascript.wasm`,
    })

    const hasParser = await client.preloadParser("javascript")
    expect(hasParser).toBe(true)

    const queriesDir = join(dataPath, "tree-sitter", "queries")
    const cachedQueries = await readdir(queriesDir)

    const scmFiles = cachedQueries.filter((file) => file.endsWith(".scm"))
    expect(scmFiles.length).toBeGreaterThan(0)

    await client.destroy()
  })

  // TODO: This is flaky, there must be a more reliable way to test this
  test.skip("should reuse cached files across client instances", async () => {
    const jsParser: FiletypeParserOptions = {
      filetype: "javascript",
      queries: {
        highlights: [`${BASE_URL}/javascript/highlights.scm`],
      },
      wasm: `${BASE_URL}/javascript/tree-sitter-javascript.wasm`,
    }

    let client1 = new TreeSitterClient({ dataPath })
    await client1.initialize()
    client1.addFiletypeParser(jsParser)

    console.log("=== First client (should download) ===")
    const start1 = Date.now()
    const hasParser1 = await client1.preloadParser("javascript")
    const duration1 = Date.now() - start1
    expect(hasParser1).toBe(true)

    await client1.destroy()

    let client2 = new TreeSitterClient({ dataPath })
    await client2.initialize()
    client2.addFiletypeParser(jsParser)

    console.log("=== Second client (should use cache) ===")
    const start2 = Date.now()
    const hasParser2 = await client2.preloadParser("javascript")
    const duration2 = Date.now() - start2
    expect(hasParser2).toBe(true)

    console.log(`First client: ${duration1}ms, Second client: ${duration2}ms`)

    expect(duration2).toBeLessThanOrEqual(duration1)
    expect(duration2).toBeLessThan(100) // Should be very fast with cache

    await client2.destroy()
  })

  test("should handle multiple parsers with independent caching", async () => {
    const client = new TreeSitterClient({ dataPath })
    await client.initialize()

    // Add URL-based parsers for this test
    client.addFiletypeParser({
      filetype: "javascript",
      queries: {
        highlights: [`${BASE_URL}/javascript/highlights.scm`],
      },
      wasm: `${BASE_URL}/javascript/tree-sitter-javascript.wasm`,
    })
    client.addFiletypeParser({
      filetype: "typescript",
      queries: {
        highlights: [`${BASE_URL}/typescript/highlights.scm`],
      },
      wasm: `${BASE_URL}/typescript/tree-sitter-typescript.wasm`,
    })

    const hasJS = await client.preloadParser("javascript")
    const hasTS = await client.preloadParser("typescript")

    expect(hasJS).toBe(true)
    expect(hasTS).toBe(true)

    const languagesDir = join(dataPath, "tree-sitter", "languages")
    const cachedFiles = await readdir(languagesDir)

    expect(cachedFiles).toContain("tree-sitter-javascript.wasm")
    expect(cachedFiles).toContain("tree-sitter-typescript.wasm")

    const queriesDir = join(dataPath, "tree-sitter", "queries")
    const cachedQueries = await readdir(queriesDir)
    const scmFiles = cachedQueries.filter((file) => file.endsWith(".scm"))

    expect(scmFiles.length).toBe(2)

    await client.destroy()
  })

  test("should store files in dataPath subdirectories", async () => {
    const client = new TreeSitterClient({ dataPath })
    await client.initialize()

    // Add URL-based parser for this test
    client.addFiletypeParser({
      filetype: "javascript",
      queries: {
        highlights: [`${BASE_URL}/javascript/highlights.scm`],
      },
      wasm: `${BASE_URL}/javascript/tree-sitter-javascript.wasm`,
    })

    const hasParser = await client.preloadParser("javascript")
    expect(hasParser).toBe(true)

    const languagesDir = join(dataPath, "tree-sitter", "languages")
    const queriesDir = join(dataPath, "tree-sitter", "queries")

    const languagesStat = await stat(languagesDir)
    const queriesStat = await stat(queriesDir)

    expect(languagesStat.isDirectory()).toBe(true)
    expect(queriesStat.isDirectory()).toBe(true)

    const cachedFiles = await readdir(languagesDir)
    expect(cachedFiles).toContain("tree-sitter-javascript.wasm")

    await client.destroy()
  })

  test("should reject when tree-sitter cache directories cannot be created", async () => {
    const blockedDataPath = join(DATA_ROOT, "blocked-" + Math.random().toString(36).slice(2))
    await mkdir(blockedDataPath, { recursive: true })
    await writeFile(join(blockedDataPath, "tree-sitter"), "blocked")

    const client = new TreeSitterClient({ dataPath: blockedDataPath })

    await expect(client.initialize()).rejects.toThrow()

    await client.destroy()
  })

  test("should handle data path changes", async () => {
    const initialDataPath = join(DATA_ROOT, "initial-" + Math.random().toString(36).slice(2))
    const newDataPath = join(DATA_ROOT, "new-" + Math.random().toString(36).slice(2))

    await mkdir(initialDataPath, { recursive: true })
    await mkdir(newDataPath, { recursive: true })

    const client = new TreeSitterClient({ dataPath: initialDataPath })
    await client.initialize()

    // Add URL-based parsers for this test
    client.addFiletypeParser({
      filetype: "javascript",
      queries: {
        highlights: [`${BASE_URL}/javascript/highlights.scm`],
      },
      wasm: `${BASE_URL}/javascript/tree-sitter-javascript.wasm`,
    })

    const hasParser1 = await client.preloadParser("javascript")
    expect(hasParser1).toBe(true)

    const initialLanguagesDir = join(initialDataPath, "tree-sitter", "languages")
    const initialFiles = await readdir(initialLanguagesDir)
    expect(initialFiles).toContain("tree-sitter-javascript.wasm")

    await client.setDataPath(newDataPath)

    // Add typescript parser for the new data path
    client.addFiletypeParser({
      filetype: "typescript",
      queries: {
        highlights: [`${BASE_URL}/typescript/highlights.scm`],
      },
      wasm: `${BASE_URL}/typescript/tree-sitter-typescript.wasm`,
    })

    const hasParser2 = await client.preloadParser("typescript")
    expect(hasParser2).toBe(true)

    const newLanguagesDir = join(newDataPath, "tree-sitter", "languages")
    const newFiles = await readdir(newLanguagesDir)
    expect(newFiles).toContain("tree-sitter-typescript.wasm")

    await client.destroy()
  })
})
