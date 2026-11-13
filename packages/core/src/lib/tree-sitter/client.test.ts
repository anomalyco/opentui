import { test, expect, beforeEach, afterEach, beforeAll, describe } from "bun:test"
import { TreeSitterClient } from "./client.js"
import { tmpdir } from "os"
import { join } from "path"
import { fileURLToPath } from "url"
import { existsSync } from "fs"
import { mkdir, readFile, writeFile, unlink } from "fs/promises"
import { getDataPaths } from "../data-paths.js"
import { clearEnvCache } from "../env.js"
import { destroySingleton } from "../singleton.js"
import { destroyTreeSitterClient, getTreeSitterClient } from "./index.js"
import { getParsers } from "./default-parsers.js"

// Windows/Node intermittently exits this test process at different points without an assertion failure.
// https://github.com/anomalyco/opentui/actions/runs/36671762488/job/109748266861
const describeClient = process.platform === "win32" && !process.versions.bun ? describe.skip : describe

describeClient("TreeSitterClient", () => {
  let client: TreeSitterClient
  let dataPath: string

  const sharedDataPath = join(tmpdir(), "tree-sitter-shared-test-data")

  beforeAll(async () => {
    await mkdir(sharedDataPath, { recursive: true })
  })

  beforeEach(async () => {
    dataPath = sharedDataPath
    client = new TreeSitterClient({
      dataPath,
    })
  })

  afterEach(async () => {
    if (client) {
      await client.destroy()
    }
  })

  test("should initialize successfully", async () => {
    await client.initialize()
    expect(client.isInitialized()).toBe(true)
  })

  test("should lazily start the worker during initialize when auto start is disabled", async () => {
    const lazyClient = new TreeSitterClient({ dataPath }, { autoStartWorker: false })

    try {
      await lazyClient.initialize()

      expect(lazyClient.isInitialized()).toBe(true)
      expect(await lazyClient.preloadParser("javascript")).toBe(true)
    } finally {
      await lazyClient.destroy()
    }
  })

  test("should initialize with a URL worker path override", async () => {
    const workerPath = existsSync(new URL("./parser.worker.js", import.meta.url))
      ? new URL("./parser.worker.js", import.meta.url)
      : new URL("./parser.worker.ts", import.meta.url)
    const urlClient = new TreeSitterClient({
      dataPath,
      workerPath,
    })

    try {
      await urlClient.initialize()

      expect(urlClient.isInitialized()).toBe(true)
      expect(await urlClient.preloadParser("javascript")).toBe(true)
    } finally {
      await urlClient.destroy()
    }
  })

  test("should wait for default parsers before resolving concurrent initialization", async () => {
    let resolveRegistrationStarted!: () => void
    let resolveRegistration!: () => void
    let registrationCompleted = false

    const registrationStarted = new Promise<void>((resolve) => {
      resolveRegistrationStarted = resolve
    })
    const registrationGate = new Promise<void>((resolve) => {
      resolveRegistration = resolve
    })

    const clientInternals = client as unknown as { registerDefaultParsers: () => Promise<void> }
    const registerDefaultParsers = clientInternals.registerDefaultParsers.bind(client)

    clientInternals.registerDefaultParsers = async () => {
      resolveRegistrationStarted()
      await registrationGate
      await registerDefaultParsers()
      registrationCompleted = true
    }

    const firstInitialize = client.initialize()
    const secondInitialize = client.initialize()

    await registrationStarted

    let secondResolved = false
    const observedSecondInitialize = secondInitialize.then(() => {
      secondResolved = true
    })

    await new Promise((resolve) => setTimeout(resolve, 25))

    expect(secondResolved).toBe(false)
    expect(client.isInitialized()).toBe(false)

    resolveRegistration()

    await Promise.all([firstInitialize, observedSecondInitialize])

    expect(registrationCompleted).toBe(true)
    expect(client.isInitialized()).toBe(true)
  })

  test("should reject initialization when destroyed during default parser registration", async () => {
    let resolveRegistrationStarted!: () => void
    let resolveRegistration!: () => void
    const registrationStarted = new Promise<void>((resolve) => {
      resolveRegistrationStarted = resolve
    })
    const registrationGate = new Promise<void>((resolve) => {
      resolveRegistration = resolve
    })
    const clientInternals = client as unknown as { registerDefaultParsers: () => Promise<void> }
    const registerDefaultParsers = clientInternals.registerDefaultParsers.bind(client)

    clientInternals.registerDefaultParsers = async () => {
      resolveRegistrationStarted()
      await registrationGate
      await registerDefaultParsers()
    }

    const initializeOutcome = client.initialize().then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    )

    try {
      await registrationStarted
      await client.destroy()
      resolveRegistration()

      const outcome = await initializeOutcome
      expect(outcome.status).toBe("rejected")
      if (outcome.status === "rejected") {
        expect(outcome.error).toBeInstanceOf(Error)
        expect((outcome.error as Error).message).toBe("Client destroyed during initialization")
      }
      expect(client.isInitialized()).toBe(false)
    } finally {
      resolveRegistration()
      await initializeOutcome
      await client.destroy()
    }
  })

  test("should preload parsers for supported filetypes", async () => {
    await client.initialize()

    const hasJavaScript = await client.preloadParser("javascript")
    expect(hasJavaScript).toBe(true)

    const hasJavaScriptReact = await client.preloadParser("javascriptreact")
    expect(hasJavaScriptReact).toBe(true)

    const hasTypeScript = await client.preloadParser("typescript")
    expect(hasTypeScript).toBe(true)

    const hasTypeScriptReact = await client.preloadParser("typescriptreact")
    expect(hasTypeScriptReact).toBe(true)
  })

  test("should return false for unsupported filetypes", async () => {
    await client.initialize()

    const hasUnsupported = await client.preloadParser("unsupported-language")
    expect(hasUnsupported).toBe(false)
  })

  test("should create buffer with supported filetype", async () => {
    await client.initialize()

    const jsCode = 'const hello = "world";'
    const creating = client.createBuffer(1, jsCode, "javascript")
    // The buffer holds what the worker parsed, even if a caller changed the pending record.
    Object.assign(client.getBuffer(1)!, { content: "changed", filetype: "plaintext", version: 7 })
    const hasParser = await creating

    expect(hasParser).toBe(true)

    const buffer = client.getBuffer(1)
    expect(buffer).toBeDefined()
    expect(buffer?.hasParser).toBe(true)
    expect(buffer?.content).toBe(jsCode)
    expect(buffer?.filetype).toBe("javascript")
  })

  test("should create buffer without parser for unsupported filetype", async () => {
    await client.initialize()

    const content = "some random content"
    const hasParser = await client.createBuffer(1, content, "unsupported")

    expect(hasParser).toBe(false)

    const buffer = client.getBuffer(1)
    expect(buffer).toBeDefined()
    expect(buffer?.hasParser).toBe(false)
  })

  test("should handle buffer removal", async () => {
    await client.initialize()

    const jsCode = 'const hello = "world";'
    await client.createBuffer(1, jsCode, "javascript")

    let bufferDisposed = false
    client.on("buffer:disposed", (bufferId) => {
      if (bufferId === 1) {
        bufferDisposed = true
      }
    })

    await client.removeBuffer(1)

    expect(bufferDisposed).toBe(true)
    expect(client.getBuffer(1)).toBeUndefined()
  })

  test("should handle multiple buffers", async () => {
    await client.initialize()

    const jsCode = 'const hello = "world";'
    const tsCode = "interface Test { value: string }"

    await client.createBuffer(1, jsCode, "javascript")
    await client.createBuffer(2, tsCode, "typescript")

    const buffers = client.getAllBuffers()
    expect(buffers).toHaveLength(2)

    const jsBuffer = client.getBuffer(1)
    const tsBuffer = client.getBuffer(2)

    expect(jsBuffer?.filetype).toBe("javascript")
    expect(tsBuffer?.filetype).toBe("typescript")
    expect(jsBuffer?.hasParser).toBe(true)
    expect(tsBuffer?.hasParser).toBe(true)
  })

  const js = (n: number) => `const a = ${n};\nfunction f() { return ${n}; }`
  const fence = Array.from({ length: 80 }, (_, i) => `export const item${i}: number = ${i} * 2;`).join("\n")
  const md = `# Heading\n\nParagraph with **bold** and \`inline\`.\n\n\`\`\`typescript\n${fence}\n\`\`\`\n`
  const mdZig = `${md}\n\`\`\`zig\npub fn main() void {}\n\`\`\`\n`
  const end = (text: string) => ({ row: text.split("\n").length - 1, column: text.length - text.lastIndexOf("\n") - 1 })
  const replace = (from: string, to: string) => [
    {
      startIndex: 0,
      oldEndIndex: from.length,
      newEndIndex: to.length,
      startPosition: { row: 0, column: 0 },
      oldEndPosition: end(from),
      newEndPosition: end(to),
    },
  ]
  // Markdown list items after a fence: an edit applied to a tree of an earlier text traps in the markdown scanner.
  const stream = ["# Streaming Summary\n\n", "```typescript\n", "export const ready = true;\n", "```\n\n"].concat(
    Array.from({ length: 132 }, (_, i) => `- Step ${i + 1}: check \`item_${i + 1}\` and **status**\n`),
  )
  const streamed = (chunks: number) => stream.slice(0, chunks).join("")
  const append = (from: string, to: string) => [
    { ...replace(from, to)[0]!, startIndex: from.length, oldEndIndex: from.length, startPosition: end(from) },
  ]
  const within3s = <T>(promise: Promise<T>) =>
    Promise.race([promise, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 3000))])
  // Each row ends with removeBuffer. The markdown rows edit or remove while the worker loads the injected typescript
  // or zig grammar, which a new worker has not loaded yet. A row returns the errors and warnings it expects; a cold row
  // starts on a client that has not initialized, and `reused` counts the parses that must reuse an old tree.
  test.each<
    [
      string,
      (c: TreeSitterClient, highlighted: (version: number, line?: number) => Promise<void>) => Promise<string[] | void>,
      { cold?: boolean; reused?: number }?,
    ]
  >([
    [
      "resetBuffer",
      async (c, highlighted) => {
        await c.createBuffer(1, js(1), "javascript", 1)
        for (let v = 2; v <= 4; v++) {
          await c.resetBuffer(1, v, js(v))
          await highlighted(v)
        }
      },
    ],
    [
      "updateBuffer during the first injection load",
      async (c, highlighted) => {
        await c.createBuffer(1, md, "markdown", 1)
        await c.updateBuffer(1, replace(md, mdZig), mdZig, 2)
        await highlighted(2)
      },
    ],
    [
      "resetBuffer during the first injection load",
      async (c, highlighted) => {
        await c.createBuffer(1, mdZig, "markdown", 1)
        await c.resetBuffer(1, 2, md)
        await highlighted(2)
      },
    ],
    [
      "updateBuffer before the first reply",
      async (c, highlighted) => {
        // The first reply is stale, so the client resets: a version 2 reply then has line 0, not only the edit's line.
        // A removed buffer of the same id, reset at a later version, must not suppress that reset.
        await c.createBuffer(1, js(1), "javascript", 1)
        await c.resetBuffer(1, 9, js(9))
        await highlighted(9)
        await c.removeBuffer(1)
        const ts = Array.from({ length: 20 }, (_, i) => `export const item${i}: number = ${i};`).join("\n")
        await c.createBuffer(1, ts, "typescript", 1)
        await c.updateBuffer(1, append(ts, `${ts}\nlet b = 2;`), `${ts}\nlet b = 2;`, 2)
        await highlighted(2, 0)
      },
    ],
    [
      "resetBuffer before the first reply, beside a buffer with no reset",
      async (c, highlighted) => {
        // The first reply is stale, but this buffer's own reset already covers it: the other buffer's lack of one
        // must not post a second reset.
        const internals = c as unknown as { sendWorkerMessage(message: { type: string }): void }
        const send = internals.sendWorkerMessage.bind(c)
        let resets = 0
        internals.sendWorkerMessage = (message) => {
          if (message.type === "RESET_BUFFER") resets++
          send(message)
        }
        await c.createBuffer(0, js(1), "javascript", 1)
        await c.createBuffer(1, js(1), "javascript", 1)
        await c.resetBuffer(1, 2, js(2))
        await highlighted(2)
        await c.removeBuffer(0)
        expect(resets).toBe(1)
      },
    ],
    [
      "updateBuffer right after resetBuffer",
      async (c, highlighted) => {
        await c.createBuffer(1, streamed(6), "markdown", 1)
        await highlighted(1)
        await c.resetBuffer(1, 2, streamed(10))
        await c.updateBuffer(1, append(streamed(10), streamed(11)), streamed(11), 3)
        await highlighted(3)
      },
    ],
    [
      "updateBuffer with no highlights right after resetBuffer",
      async (c, highlighted) => {
        // The edit's reply is empty, so only a reset at version 3 shows the number that version 2 added.
        await writeFile(join(dataPath, "number.scm"), "(number) @number\n")
        const wasm = fileURLToPath(new URL("./assets/javascript/tree-sitter-javascript.wasm", import.meta.url))
        c.addFiletypeParser({ filetype: "number", wasm, queries: { highlights: [join(dataPath, "number.scm")] } })
        const text = `let a = 1 + 2;\n${"x;\n".repeat(600)}`
        expect(await c.createBuffer(1, text.replace(" + 2", ""), "number", 1)).toBe(true)
        await c.resetBuffer(1, 2, text)
        await c.updateBuffer(1, append(text, `${text}y;\n`), `${text}y;\n`, 3)
        await highlighted(3)
      },
    ],
    [
      "updateBuffer streaming list items",
      async (c, highlighted) => {
        // Stale replies reset once per round trip, not once per reply: without the check this posts over 100.
        const internals = c as unknown as { sendWorkerMessage(message: { type: string }): void }
        const send = internals.sendWorkerMessage.bind(c)
        let resets = 0
        internals.sendWorkerMessage = (message) => {
          if (message.type === "RESET_BUFFER") resets++
          send(message)
        }
        await c.createBuffer(1, streamed(1), "markdown", 1)
        for (let n = 2; n <= stream.length; n++) {
          await c.updateBuffer(1, append(streamed(n - 1), streamed(n)), streamed(n), n)
          if (n % 7 === 0) await new Promise((resolve) => setTimeout(resolve, 5))
        }
        await highlighted(stream.length)
        // Replies arrive only during the 19 pauses and the final wait, so at most one reset per gap: 20.
        expect(resets).toBeLessThanOrEqual(20)
      },
    ],
    ["removeBuffer during the first injection load", async (c) => void (await c.createBuffer(1, md, "markdown", 1))],
    [
      "removeBuffer right after resetBuffer",
      async (c) => {
        await c.createBuffer(1, md, "markdown", 1)
        await c.resetBuffer(1, 2, mdZig)
      },
    ],
    [
      "removeBuffer during an edit's injection load",
      async (c, highlighted) => {
        await c.createBuffer(1, md, "markdown", 1)
        await highlighted(1)
        await c.updateBuffer(1, replace(md, mdZig), mdZig, 2)
      },
    ],
    [
      "removeBuffer during a queued edit's injection load",
      async (c) => {
        await c.createBuffer(1, md, "markdown", 1)
        await c.updateBuffer(1, replace(md, mdZig), mdZig, 2)
        await c.highlightOnce(md, "markdown")
      },
    ],
    [
      "removeCopy during an append's injection load",
      async (c) => {
        // A streamed fence's appends: one that does not continue the copy is refused and changes nothing.
        expect((await c.highlightAppend(1, 0, md, "markdown")).highlights?.length).toBeGreaterThan(0)
        expect(await c.highlightAppend(1, 1, "x", "markdown")).toMatchObject({ error: expect.any(String) })
        void c.highlightAppend(1, md.length, mdZig.slice(md.length), "markdown")
        await c.removeCopy(1)
      },
      { reused: 1 },
    ],
    [
      "removeCopy of an append sent before the client initialized",
      async (c) => {
        const append = c.highlightAppend(7, 0, js(1), "javascript")
        await c.removeCopy(7)
        await append
      },
      { cold: true },
    ],
    [
      "a copy beside a buffer of the same number",
      async (c, highlighted) => {
        // Copies have their own ids: removing copy 1 leaves buffer 1 to its owner.
        await c.createBuffer(1, js(1), "javascript", 1)
        await highlighted(1)
        expect((await c.highlightAppend(1, 0, js(2), "javascript")).highlights?.length).toBeGreaterThan(0)
        await c.removeCopy(1)
        await c.resetBuffer(1, 2, js(3))
        await highlighted(2)
      },
    ],
    [
      "clearCache after highlighting",
      async (c) => {
        await c.highlightOnce(mdZig, "markdown")
        await c.clearCache()
      },
    ],
    [
      "a grammar with an unsupported ABI version",
      async (c) => {
        // The zig language struct starts with its ABI version, 14, then its symbol and alias counts.
        const wasm = await readFile(new URL("./assets/zig/tree-sitter-zig.wasm", import.meta.url))
        const at = wasm.findIndex((_, i) => {
          if (i + 12 > wasm.length || wasm.readUInt32LE(i) !== 14) return false
          const symbols = wasm.readUInt32LE(i + 4)
          return symbols > 50 && symbols < 2000 && wasm.readUInt32LE(i + 8) < 500
        })
        wasm[at] = 16
        await writeFile(join(dataPath, "abi16.wasm"), wasm)
        await writeFile(join(dataPath, "abi16.scm"), "(identifier) @variable\n")
        const queries = { highlights: [join(dataPath, "abi16.scm")] }
        c.addFiletypeParser({ filetype: "abi16", wasm: join(dataPath, "abi16.wasm"), queries })
        const abi = "Error: Incompatible language version 16. Compatibility range 13 through 15."
        await expect(c.createBuffer(1, "const a = 1;", "abi16", 1)).rejects.toThrow(abi)
        await expect(c.highlightOnce("const a = 1;", "abi16")).rejects.toThrow(abi)
        await expect(c.highlightAppend(7, 0, "const a = 1;", "abi16")).rejects.toThrow(abi)
        return [abi, abi, abi]
      },
    ],
    [
      "createBuffer whose first parse returns null",
      async (c) => {
        expect(await c.createBuffer(1, "null-parse", "javascript", 1)).toBe(false)
        expect(await c.highlightAppend(7, 0, "null-parse", "javascript")).toMatchObject({
          error: "Failed to parse buffer",
        })
        return ["Failed to parse buffer"]
      },
    ],
  ])(
    "should delete every replaced tree and parser once no message reads it: %s",
    async (_name, run, options = {}) => {
      const workerPath = new URL(
        existsSync(new URL("./tree-count-worker.fixture.js", import.meta.url))
          ? "./tree-count-worker.fixture.js"
          : "./tree-count-worker.fixture.ts",
        import.meta.url,
      )
      const c = new TreeSitterClient({ dataPath, workerPath })
      const replies: { version: number; lines: number[] }[] = []
      const errors: string[] = []
      c.on("highlights:response", (id, version, highlights) => {
        if (id === 1) replies.push({ version, lines: highlights.map((highlight) => highlight.line) })
      })
      c.on("error", (error) => errors.push(error.split("\n")[0]!))
      c.on("warning", (warning) => errors.push(warning))
      const treeCount = new Promise<unknown>((resolve) =>
        c.on("worker:log", (_type, message) => {
          if (message.startsWith("tree-count ")) resolve(JSON.parse(message.slice("tree-count ".length)))
        }),
      )
      // Waits for a reply of this version, with a highlight on this line if one is given.
      const highlighted = async (version: number, line?: number) => {
        const seen = (reply: (typeof replies)[number]) =>
          reply.version === version && (line === undefined || reply.lines.includes(line))
        for (let waited = 0; !replies.some(seen); waited += 5) {
          if (waited >= 3000) throw new Error(`no highlights for version ${version}`)
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
      }
      try {
        if (!options.cold) await c.initialize()
        const expectedErrors = (await run(c, highlighted)) ?? []
        const removed = await within3s(c.removeBuffer(1))
        // Waits on the same grammar loads, so a buffer pass suspended on them has resumed before the count. It also
        // leaves the four cached parsers: markdown, markdown_inline, typescript and zig.
        await within3s(c.highlightOnce(mdZig, "markdown"))
        const trees = (await within3s(
          Promise.all([c.getPerformance(), treeCount]).then(([, count]) => count),
        )) as Record<"live" | "freedReads" | "parsers" | "reused", number>
        expect({ removed, errors, trees }).toEqual({
          removed: undefined,
          errors: expectedErrors,
          trees: { live: 0, freedReads: 0, parsers: 4, reused: options.reused ?? trees.reused },
        })
      } finally {
        await within3s(c.destroy())
      }
    },
    15000,
  )

  test("should emit error events for invalid operations", async () => {
    await client.initialize()

    let errorReceived = false
    let errorMessage = ""

    client.on("error", (error, bufferId) => {
      errorReceived = true
      errorMessage = error
    })

    await client.resetBuffer(999, 1, "test")

    expect(errorReceived).toBe(true)
    expect(errorMessage).toContain("Cannot reset buffer with no parser")
  })

  test("should handle performance metrics", async () => {
    await client.initialize()

    const performance = await client.getPerformance()
    expect(performance).toBeDefined()
    expect(typeof performance.averageParseTime).toBe("number")
    expect(typeof performance.averageQueryTime).toBe("number")
    expect(Array.isArray(performance.parseTimes)).toBe(true)
    expect(Array.isArray(performance.queryTimes)).toBe(true)
  })

  test("should clean up resources on destroy", async () => {
    await client.initialize()

    const jsCode = 'const hello = "world";'
    await client.createBuffer(1, jsCode, "javascript")

    expect(client.getAllBuffers()).toHaveLength(1)

    // Overlapping removals still waiting for the worker settle too.
    const removals = Promise.allSettled([client.removeBuffer(1), client.removeBuffer(1)])
    await client.destroy()
    const settled = await within3s(removals)
    expect(settled === "timeout" ? settled : settled.map((result) => result.status)).toEqual(["rejected", "rejected"])

    expect(client.isInitialized()).toBe(false)
    expect(client.getAllBuffers()).toHaveLength(0)
  })

  test("should perform one-shot highlighting", async () => {
    await client.initialize()

    const jsCode = 'const hello = "world";\nfunction test() { return 42; }'
    const result = await client.highlightOnce(jsCode, "javascript")

    expect(result.highlights).toBeDefined()
    expect(result.highlights!.length).toBeGreaterThan(0)

    const firstHighlight = result.highlights![0]
    expect(Array.isArray(firstHighlight)).toBe(true)
    expect(firstHighlight).toHaveLength(3)
    expect(typeof firstHighlight[0]).toBe("number")
    expect(typeof firstHighlight[1]).toBe("number")
    expect(typeof firstHighlight[2]).toBe("string")

    const groups = result.highlights!.map((hl) => hl[2])
    expect(groups.length).toBeGreaterThan(0)
    expect(groups).toContain("keyword")
  })

  test("should handle one-shot highlighting for unsupported filetype", async () => {
    await client.initialize()

    const result = await client.highlightOnce("some content", "unsupported-lang")

    expect(result.highlights).toBeUndefined()
    expect(result.warning).toContain("No parser available for filetype unsupported-lang")
  }, 5000)

  test("should reject one-shot highlighting after a correlated worker error", async () => {
    await client.initialize()

    const internals = client as unknown as {
      messageCallbacks: Map<string, unknown>
      worker?: {
        onmessage: ((event: { data: { type: "ERROR"; messageId: string; error: string } }) => void) | null
        postMessage: (message: { type?: string; messageId?: string }) => void
      }
    }
    const worker = internals.worker
    expect(worker).toBeDefined()
    if (!worker) {
      throw new Error("Expected initialized client to have a worker")
    }

    let messageId: string | undefined
    const originalPostMessage = worker.postMessage.bind(worker)
    worker.postMessage = (message) => {
      if (message.type === "ONESHOT_HIGHLIGHT") {
        messageId = message.messageId
        return
      }
      originalPostMessage(message)
    }

    const highlighting = client.highlightOnce("const value = 1", "javascript")
    expect(messageId).toBeDefined()
    expect(internals.messageCallbacks.size).toBe(1)

    worker.onmessage?.({
      data: { type: "ERROR", messageId: messageId!, error: "synthetic one-shot failure" },
    })

    await expect(highlighting).rejects.toThrow("synthetic one-shot failure")
    expect(internals.messageCallbacks.size).toBe(0)
  })

  test("should perform multiple one-shot highlights independently", async () => {
    await client.initialize()

    const jsCode = 'const hello = "world";'
    const tsCode = "interface Test { value: string }"

    const [jsResult, tsResult] = await Promise.all([
      client.highlightOnce(jsCode, "javascript"),
      client.highlightOnce(tsCode, "typescript"),
    ])

    expect(jsResult.highlights).toBeDefined()
    expect(tsResult.highlights).toBeDefined()
    expect(jsResult.highlights!.length).toBeGreaterThan(0)
    expect(tsResult.highlights!.length).toBeGreaterThan(0)

    jsResult.highlights!.forEach((hl) => {
      expect(Array.isArray(hl)).toBe(true)
      expect(hl).toHaveLength(3)
    })

    tsResult.highlights!.forEach((hl) => {
      expect(Array.isArray(hl)).toBe(true)
      expect(hl).toHaveLength(3)
    })

    expect(client.getAllBuffers()).toHaveLength(0)
  })

  test("should parse JSX only for react filetypes and evaluate #lua-match? predicates", async () => {
    await client.initialize()

    const jsx = 'const view = <Box title="x">hi</Box>'
    const rows: { filetype: string; source: string; expected: string[]; absent?: string[] }[] = [
      { filetype: "javascriptreact", source: jsx, expected: ["18:title=property", "32:Box=constructor"] },
      {
        filetype: "typescriptreact",
        source: jsx,
        expected: ["18:title=tag.attribute", "32:Box=tag"],
        absent: ["6:view=type", "6:view=constant"],
      },
      { filetype: "typescript", source: "const n = <number>value", expected: ["11:number=type.builtin"] },
      {
        filetype: "typescript",
        source: "const n = /* c */ 1",
        expected: ["6:n=variable", "10:/* c */=comment"],
        absent: ["6:n=type", "6:n=constant", "10:/* c */=comment.documentation"],
      },
      {
        filetype: "typescript",
        source: "const N_1 = /** d\n */ 1",
        expected: ["6:N_1=variable", "6:N_1=type", "6:N_1=constant", "12:/** d\n */=comment.documentation"],
      },
      { filetype: "zig", source: "const n = 1", expected: ["6:n=variable"], absent: ["6:n=type", "6:n=constant"] },
    ]

    for (const { filetype, source, expected, absent = [] } of rows) {
      const { highlights = [] } = await client.highlightOnce(source, filetype)
      const tokens = highlights.map(([start, end, group]) => `${start}:${source.slice(start, end)}=${group}`)

      expect(tokens).toContain("0:const=keyword")
      expect(expected.filter((token) => !tokens.includes(token))).toEqual([])
      expect(absent.filter((token) => tokens.includes(token))).toEqual([])
      expect(tokens.filter((token) => token.endsWith("=string.regexp"))).toEqual([])
    }
  })

  test("should handle Devanagari characters and highlight ranges after them correctly", async () => {
    await client.initialize()

    const jsCode = 'const greeting = "नमस्ते";\nconst x = 42;'
    const result = await client.highlightOnce(jsCode, "javascript")

    expect(result.highlights).toBeDefined()
    expect(result.highlights!.length).toBeGreaterThan(0)

    const keywordHighlights = result.highlights!.filter((hl) => hl[2] === "keyword")
    expect(keywordHighlights.length).toBeGreaterThanOrEqual(2)

    const constHighlights = keywordHighlights.filter((hl) => {
      const text = jsCode.substring(hl[0], hl[1])
      return text === "const"
    })

    expect(constHighlights).toHaveLength(2)

    const firstConst = constHighlights[0]
    const secondConst = constHighlights[1]

    expect(jsCode.substring(firstConst[0], firstConst[1])).toBe("const")
    expect(jsCode.substring(secondConst[0], secondConst[1])).toBe("const")

    expect(firstConst[0]).toBe(0)
    expect(firstConst[1]).toBe(5)

    expect(secondConst[0]).toBeGreaterThan(firstConst[1])
    const textBetween = jsCode.substring(firstConst[1], secondConst[0])
    expect(textBetween).toContain("नमस्ते")

    const numberHighlight = result.highlights!.find((hl) => {
      const text = jsCode.substring(hl[0], hl[1])
      return text === "42" && hl[2] === "number"
    })

    expect(numberHighlight).toBeDefined()
    if (numberHighlight) {
      const [start, end] = numberHighlight
      const actualText = jsCode.substring(start, end)
      expect(actualText).toBe("42")

      const secondLine = jsCode.split("\n")[1]
      const secondLineStart = jsCode.indexOf(secondLine)
      const expectedStart = secondLineStart + secondLine.indexOf("42")
      expect(start).toBe(expectedStart)
    }
  })

  test("should support local file paths for parser configuration", async () => {
    const testQueryPath = join(dataPath, `test-highlights-${Date.now()}.scm`)
    // Lua pattern predicate → identifiers of testCode that it captures. A pattern the worker does not translate
    // (the last rows; the first two are from nvim-treesitter's kitty and clojure queries) stays #lua-match?, which
    // web-tree-sitter ignores, so it captures everything; the query must still load.
    const all = "a9 ab A_2 _x $y aXz"
    const luaPredicates: [string, string][] = [
      ['lua-match? "^[a-z][%d]$"', "a9"],
      ['lua-match? "^[A-Z_][A-Z%d_]+$"', "A_2"],
      ['lua-match? "^a.z$"', "aXz"],
      ['not-lua-match? "^a"', "A_2 _x $y"],
      ['not-any-lua-match? "^a"', "A_2 _x $y"],
      ['any-lua-match? "b$"', "ab"],
      ['lua-match? "^-"', all],
      ['lua-match? "^-%>[^>].*"', all],
      ['lua-match? "^%u"', all],
      ['lua-match? "^(a)?$"', all],
      ['lua-match? "^[a"', all],
      ['lua-match? "[z-a]"', all],
    ]
    const simpleQuery = luaPredicates
      .map(([predicate], i) => `((identifier) @p${i} (#${predicate.replace(" ", ` @p${i} `)}))`)
      .join("\n")
    const javascriptParser = (await getParsers()).find((parser) => parser.filetype === "javascript")
    if (!javascriptParser) {
      throw new Error("Expected the default JavaScript parser")
    }
    await writeFile(testQueryPath, simpleQuery, "utf8")

    try {
      client.addFiletypeParser({
        filetype: "test-lang",
        aliases: ["test-lang-react"],
        queries: {
          highlights: [testQueryPath],
        },
        wasm: javascriptParser.wasm,
      })

      await client.initialize()

      const hasParser = await client.preloadParser("test-lang")
      expect(hasParser).toBe(true)

      const hasAliasParser = await client.preloadParser("test-lang-react")
      expect(hasAliasParser).toBe(true)

      const testCode = "a9; ab; A_2; _x; $y; aXz;"
      const result = await client.highlightOnce(testCode, "test-lang")
      const aliasResult = await client.highlightOnce(testCode, "test-lang-react")
      const captured = luaPredicates.map(([predicate], i) => {
        const names = result.highlights!.filter(([, , group]) => group === `p${i}`)
        return [predicate, names.map(([start, end]) => testCode.slice(start, end)).join(" ")]
      })

      expect(captured).toEqual(luaPredicates)
      expect(aliasResult.highlights).toEqual(result.highlights)
      expect(result.error).toBeUndefined()
      expect(aliasResult.error).toBeUndefined()
      expect(result.warning).toBeUndefined()
      expect(aliasResult.warning).toBeUndefined()
    } finally {
      try {
        await unlink(testQueryPath)
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  })

  test("should handle concurrent highlightOnce calls efficiently (no duplicate parser loading)", async () => {
    const workerLogs: string[] = []

    client.on("worker:log", (_logType, message) => {
      if (message.includes("Loading from local path:")) {
        workerLogs.push(message)
      }
    })

    await client.initialize()

    const jsCode = 'const hello = "world"; function test() { return 42; }'
    const promises = Array.from({ length: 5 }, () => client.highlightOnce(jsCode, "javascript"))

    const results = await Promise.all(promises)

    for (const result of results) {
      expect(result.highlights).toBeDefined()
      expect(result.highlights!.length).toBeGreaterThan(0)
      expect(result.error).toBeUndefined()
    }

    const firstResult = results[0]
    for (let i = 1; i < results.length; i++) {
      expect(results[i].highlights).toEqual(firstResult.highlights)
    }

    await new Promise((resolve) => setTimeout(resolve, 100))

    const languageLoadLogs = workerLogs.filter((log) => log.includes("tree-sitter-javascript.wasm"))
    const queryLoadLogs = workerLogs.filter((log) => log.includes("highlights.scm"))

    expect(languageLoadLogs.length).toBeLessThanOrEqual(1)
    expect(queryLoadLogs.length).toBeLessThanOrEqual(1)
  }, 15000)

  test("should reuse canonical parser assets for aliased filetypes", async () => {
    const workerLogs: string[] = []

    client.on("worker:log", (_logType, message) => {
      if (message.includes("Loading from local path:")) {
        workerLogs.push(message)
      }
    })

    await client.initialize()

    const jsxCode = 'const view = <div className="card">hello</div>'
    const [canonicalResult, aliasResult] = await Promise.all([
      client.highlightOnce(jsxCode, "javascript"),
      client.highlightOnce(jsxCode, "javascriptreact"),
    ])

    expect(canonicalResult.highlights).toBeDefined()
    expect(aliasResult.highlights).toBeDefined()
    expect(canonicalResult.error).toBeUndefined()
    expect(aliasResult.error).toBeUndefined()

    await new Promise((resolve) => setTimeout(resolve, 100))

    const languageLoadLogs = workerLogs.filter((log) => log.includes("tree-sitter-javascript.wasm"))
    const queryLoadLogs = workerLogs.filter(
      (log) => log.includes("assets") && log.includes("javascript") && log.includes("highlights.scm"),
    )

    expect(languageLoadLogs.length).toBeLessThanOrEqual(1)
    expect(queryLoadLogs.length).toBeLessThanOrEqual(1)
    expect(workerLogs.some((log) => log.includes("javascriptreact"))).toBe(false)
  }, 15000)
})

describeClient("TreeSitterClient Injections", () => {
  let dataPath: string

  const injectionsDataPath = join(tmpdir(), "tree-sitter-injections-test-data")

  beforeAll(async () => {
    await mkdir(injectionsDataPath, { recursive: true })
  })

  beforeEach(async () => {
    dataPath = injectionsDataPath
  })

  test("should highlight inline code in markdown using markdown_inline injection", async () => {
    const client = new TreeSitterClient({ dataPath })

    try {
      await client.initialize()

      const markdownCode = `# Hello World

The \`CodeRenderable\` component provides syntax highlighting.

You can use \`const x = 42\` in your code.`

      const result = await client.highlightOnce(markdownCode, "markdown")

      expect(result.highlights).toBeDefined()
      expect(result.highlights!.length).toBeGreaterThan(0)

      const groups = result.highlights!.map((hl) => hl[2])
      const hasInlineCodeHighlights = groups.some((g) => g.includes("markup.raw"))

      expect(hasInlineCodeHighlights).toBe(true)
    } finally {
      await client.destroy()
    }
  }, 10000)

  test("should highlight code blocks in markdown using language-specific injection", async () => {
    const client = new TreeSitterClient({ dataPath })

    try {
      await client.initialize()

      const markdownCode = `# Code Example

\`\`\`typescript
const hello: string = "world";
function test() { return 42; }
\`\`\`

Some text here.`

      const result = await client.highlightOnce(markdownCode, "markdown")

      expect(result.highlights).toBeDefined()
      expect(result.highlights!.length).toBeGreaterThan(0)

      const groups = result.highlights!.map((hl) => hl[2])
      const hasTypeScriptHighlights = groups.some((g) => g === "keyword" || g === "type" || g === "function")

      expect(hasTypeScriptHighlights).toBe(true)
    } finally {
      await client.destroy()
    }
  }, 10000)

  test("should highlight tsx code blocks in markdown using language-specific injection", async () => {
    const client = new TreeSitterClient({ dataPath })

    try {
      await client.initialize()

      const markdownCode = `# Code Example

\`\`\`tsx
const view: JSX.Element = <Box title="x">hi</Box>;
\`\`\`

Some text here.`

      const { highlights = [] } = await client.highlightOnce(markdownCode, "markdown")
      const tokens = highlights.map(([start, end, group]) => `${markdownCode.slice(start, end)}=${group}`)

      expect(tokens).toContain("const=keyword")
      expect(tokens).toContain("title=tag.attribute")
      expect(tokens).toContain("Element=type")
      expect(tokens.filter((token) => token.endsWith("=string.regexp"))).toEqual([])
    } finally {
      await client.destroy()
    }
  }, 10000)

  test("should return correct offsets for injected code in markdown code blocks", async () => {
    const client = new TreeSitterClient({ dataPath })

    try {
      await client.initialize()

      const markdownCode = `# Title\n\n\`\`\`typescript\nconst x = 42;\n\`\`\``

      const result = await client.highlightOnce(markdownCode, "markdown")

      expect(result.highlights).toBeDefined()
      expect(result.highlights!.length).toBeGreaterThan(0)

      const constHighlight = result.highlights!.find((hl) => {
        const text = markdownCode.substring(hl[0], hl[1])
        return text === "const" && hl[2] === "keyword"
      })

      expect(constHighlight).toBeDefined()
      if (constHighlight) {
        const [start, end, group] = constHighlight
        const text = markdownCode.substring(start, end)

        expect(text).toBe("const")
        expect(group).toBe("keyword")
        expect(start).toBe(23)
        expect(end).toBe(28)
      }

      const numberHighlight = result.highlights!.find((hl) => {
        const text = markdownCode.substring(hl[0], hl[1])
        return text === "42" && hl[2] === "number"
      })

      expect(numberHighlight).toBeDefined()
      if (numberHighlight) {
        const [start, end, group] = numberHighlight
        const text = markdownCode.substring(start, end)

        expect(text).toBe("42")
        expect(group).toBe("number")
        expect(start).toBe(33)
        expect(end).toBe(35)
      }
    } finally {
      await client.destroy()
    }
  }, 10000)

  test("should return highlights sorted by start offset for injected code", async () => {
    const client = new TreeSitterClient({ dataPath })

    try {
      await client.initialize()

      const markdownCode = `# Documentation

Some text with \`inline code\` here.

\`\`\`typescript
const first = 1;
const second = 2;
\`\`\`

More text with \`another inline\` code.

\`\`\`javascript
function test() {
  return 42;
}
\`\`\``

      const result = await client.highlightOnce(markdownCode, "markdown")

      expect(result.highlights).toBeDefined()
      expect(result.highlights!.length).toBeGreaterThan(0)

      for (let i = 1; i < result.highlights!.length; i++) {
        const prevStart = result.highlights![i - 1][0]
        const currStart = result.highlights![i][0]
        expect(currStart).toBeGreaterThanOrEqual(prevStart)
      }
    } finally {
      await client.destroy()
    }
  }, 10000)

  test("should handle markdown with injections and return valid highlights", async () => {
    const client = new TreeSitterClient({ dataPath })

    try {
      await client.initialize()

      const markdownCode = `# Heading

Some **bold** text with \`inline code\`.

\`\`\`typescript
const x: string = "hello";
\`\`\`

[Link text](https://example.com)`

      const result = await client.highlightOnce(markdownCode, "markdown")

      expect(result.highlights).toBeDefined()
      expect(result.highlights!.length).toBeGreaterThan(0)

      const overlaps: Array<[number, number]> = []
      for (let i = 0; i < result.highlights!.length; i++) {
        for (let j = i + 1; j < result.highlights!.length; j++) {
          const [start1, end1] = result.highlights![i]
          const [start2, end2] = result.highlights![j]

          if (start2 < end1) {
            overlaps.push([i, j])
          }
        }
      }

      expect(overlaps.length).toBeGreaterThanOrEqual(0)

      const injectionHighlights = result.highlights!.filter((hl) => hl[2].includes("injection"))
      expect(injectionHighlights).toBeDefined()

      const concealHighlights = result.highlights!.filter((hl) => hl[2] === "conceal")
      expect(concealHighlights).toBeDefined()

      const blockHighlights = result.highlights!.filter((hl) => hl[2] === "markup.raw.block")
      expect(blockHighlights).toBeDefined()
    } finally {
      await client.destroy()
    }
  }, 10000)

  test("should handle fast concurrent markdown highlighting requests with injections", async () => {
    const client = new TreeSitterClient({ dataPath })

    const errors: string[] = []
    client.on("error", (error) => {
      errors.push(error)
    })

    client.on("worker:log", (logType, message) => {
      if (logType === "error") {
        errors.push(message)
      }
    })

    try {
      await client.initialize()

      const markdownCode = `# OpenTUI Documentation

## Getting Started

OpenTUI is a modern terminal UI framework built on **tree-sitter** and WebGPU.

### Installation

\`\`\`bash
bun install opentui
\`\`\`

### Quick Example

\`\`\`typescript
import { createCliRenderer, BoxRenderable } from 'opentui';

const renderer = await createCliRenderer();
const box = new BoxRenderable(renderer, {
  border: true,
  title: "Hello World"
});
renderer.root.add(box);
\`\`\`

The \`CodeRenderable\` component provides syntax highlighting.

| Property | Type | Description |
|----------|------|-------------|
| content | string | Code to display |
| filetype | string | Language type |`

      const jsCode = `function test() {
  const hello = "world";
  return hello;
}`

      const tsCode = `interface User {
  name: string;
  age: number;
}

const user: User = { name: "Alice", age: 25 };`

      const promises = []
      for (let i = 0; i < 5; i++) {
        promises.push(client.highlightOnce(markdownCode, "markdown"))
      }

      const results = await Promise.allSettled(promises)

      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        if (result.status === "fulfilled") {
          expect(result.value.error).toBeUndefined()
          expect(result.value.highlights).toBeDefined()
        } else {
          throw new Error(`Request ${i} was rejected: ${result.reason}`)
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 500))

      const hasMemoryErrors = errors.some((err) => err.includes("Out of bounds memory access"))
      expect(hasMemoryErrors).toBe(false)
    } finally {
      await client.destroy()
    }
  }, 15000)
})

describeClient("TreeSitterClient Conceal Values", () => {
  let dataPath: string

  const concealDataPath = join(tmpdir(), "tree-sitter-conceal-test-data")

  beforeAll(async () => {
    await mkdir(concealDataPath, { recursive: true })
  })

  beforeEach(async () => {
    dataPath = concealDataPath
  })

  test("should return conceal values from normal (non-injected) queries", async () => {
    const client = new TreeSitterClient({ dataPath })

    try {
      await client.initialize()

      const markdownCode = `![Image Alt Text](https://example.com/image.png)`

      const result = await client.highlightOnce(markdownCode, "markdown")

      expect(result.highlights).toBeDefined()
      expect(result.error).toBeUndefined()

      const concealedHighlights = result.highlights!.filter((hl) => {
        const meta = (hl as any)[3]
        return meta && meta.conceal !== undefined
      })

      expect(concealedHighlights.length).toBeGreaterThan(0)

      concealedHighlights.forEach((hl) => {
        const meta = (hl as any)[3]
        expect(meta.conceal).toBeDefined()
      })
    } finally {
      await client.destroy()
    }
  }, 10000)

  test("should return conceal values from injected queries (markdown_inline)", async () => {
    const client = new TreeSitterClient({ dataPath })

    try {
      await client.initialize()

      const markdownCode = `Here is a [link](https://example.com) in text.`

      const result = await client.highlightOnce(markdownCode, "markdown")

      expect(result.highlights).toBeDefined()
      expect(result.error).toBeUndefined()

      const concealedHighlights = result.highlights!.filter((hl) => {
        const meta = (hl as any)[3]
        return meta && meta.conceal !== undefined
      })

      expect(concealedHighlights.length).toBeGreaterThan(0)

      concealedHighlights.forEach((hl) => {
        const meta = (hl as any)[3]
        expect(meta.conceal).toBeDefined()
        expect(meta.isInjection).toBeDefined()
      })

      const closingBracketHighlight = concealedHighlights.find((hl) => {
        const text = markdownCode.substring(hl[0], hl[1])
        const meta = (hl as any)[3]
        return text === "]" && meta.conceal !== ""
      })

      if (closingBracketHighlight) {
        const meta = (closingBracketHighlight as any)[3]
        expect(meta.conceal).toBeDefined()
      }
    } finally {
      await client.destroy()
    }
  }, 10000)

  test("should distinguish conceal values between normal and injected queries", async () => {
    const client = new TreeSitterClient({ dataPath })

    try {
      await client.initialize()

      const markdownCode = `Here is a [link](https://example.com) and ![image](https://example.com/img.png).`

      const result = await client.highlightOnce(markdownCode, "markdown")

      expect(result.highlights).toBeDefined()
      expect(result.error).toBeUndefined()

      const concealedHighlights = result.highlights!.filter((hl) => {
        const meta = (hl as any)[3]
        return meta && meta.conceal !== undefined
      })

      expect(concealedHighlights.length).toBeGreaterThan(0)

      const normalConceal = concealedHighlights.filter((hl) => {
        const meta = (hl as any)[3]
        return !meta.isInjection
      })

      const injectedConceal = concealedHighlights.filter((hl) => {
        const meta = (hl as any)[3]
        return meta.isInjection
      })

      expect(injectedConceal.length).toBeGreaterThan(0)

      injectedConceal.forEach((hl) => {
        const meta = (hl as any)[3]
        expect(meta.conceal).toBeDefined()
        expect(meta.isInjection).toBe(true)
      })

      concealedHighlights.forEach((hl) => {
        const meta = (hl as any)[3]
        expect(meta.conceal).toBeDefined()
        expect(typeof meta.isInjection).toBe("boolean")
      })
    } finally {
      await client.destroy()
    }
  }, 10000)

  test("should handle pattern index lookups correctly for injections", async () => {
    const client = new TreeSitterClient({ dataPath })

    try {
      await client.initialize()

      const markdownCode = `A [link](url) here.`

      const result = await client.highlightOnce(markdownCode, "markdown")

      expect(result.highlights).toBeDefined()
      expect(result.error).toBeUndefined()

      const concealedHighlights = result.highlights!.filter((hl) => {
        const meta = (hl as any)[3]
        return meta && meta.conceal !== undefined
      })

      expect(concealedHighlights.length).toBeGreaterThan(0)

      concealedHighlights.forEach((hl) => {
        const meta = (hl as any)[3]
        expect(meta.conceal).toBeDefined()
      })
    } finally {
      await client.destroy()
    }
  }, 10000)

  test("should handle multiple injected languages with different conceal patterns", async () => {
    const client = new TreeSitterClient({ dataPath })

    try {
      await client.initialize()

      const markdownCode = `# Title

Inline \`code\` and a [link](url) here.

\`\`\`typescript
const x = 42;
\`\`\`

More text with ![image](img.png) and **bold**.`

      const result = await client.highlightOnce(markdownCode, "markdown")

      expect(result.highlights).toBeDefined()
      expect(result.error).toBeUndefined()

      const concealedHighlights = result.highlights!.filter((hl) => {
        const meta = (hl as any)[3]
        return meta && meta.conceal !== undefined
      })

      expect(concealedHighlights.length).toBeGreaterThan(0)

      const byLang = new Map<string, any[]>()
      concealedHighlights.forEach((hl) => {
        const meta = (hl as any)[3]
        const lang = meta.isInjection ? meta.injectionLang || "injected" : "normal"
        if (!byLang.has(lang)) {
          byLang.set(lang, [])
        }
        byLang.get(lang)!.push(hl)
      })

      expect(byLang.size).toBeGreaterThan(0)

      byLang.forEach((highlights) => {
        expect(highlights.length).toBeGreaterThan(0)
        highlights.forEach((hl: any) => {
          const meta = hl[3]
          expect(meta.conceal).toBeDefined()
        })
      })
    } finally {
      await client.destroy()
    }
  }, 10000)

  test("should preserve non-empty conceal replacements like space character", async () => {
    const client = new TreeSitterClient({ dataPath })

    try {
      await client.initialize()

      const markdownCode = `Check [this link](https://example.com) out!`

      const result = await client.highlightOnce(markdownCode, "markdown")

      expect(result.highlights).toBeDefined()
      expect(result.error).toBeUndefined()

      const closingBracket = result.highlights!.find((hl) => {
        const text = markdownCode.substring(hl[0], hl[1])
        const meta = (hl as any)[3]
        return text === "]" && hl[2] === "conceal" && meta?.conceal !== undefined
      })

      if (closingBracket) {
        const meta = (closingBracket as any)[3]
        expect(meta).toBeDefined()
        expect(meta.conceal).toBeDefined()
        expect(meta.conceal).toBe(" ")
        expect(meta.conceal.length).toBeGreaterThan(0)
      }
    } finally {
      await client.destroy()
    }
  }, 10000)
})

describeClient("TreeSitterClient Edge Cases", () => {
  let dataPath: string

  const edgeCaseDataPath = join(tmpdir(), "tree-sitter-edge-case-test-data")
  const reactiveDataPathRoot = join(tmpdir(), "tree-sitter-reactive-data-path-test")

  beforeAll(async () => {
    await mkdir(edgeCaseDataPath, { recursive: true })
    await mkdir(reactiveDataPathRoot, { recursive: true })
  })

  beforeEach(async () => {
    dataPath = edgeCaseDataPath
  })

  test("should handle initialization timeout", async () => {
    const client = new TreeSitterClient({
      dataPath,
      workerPath: "invalid-path",
      initTimeout: 500,
    })

    await expect(client.initialize()).rejects.toThrow(/Worker error|Worker initialization timed out/)

    await client.destroy()
  })

  test("should handle operations before initialization", async () => {
    const client = new TreeSitterClient({ dataPath })

    expect(client.isInitialized()).toBe(false)
    expect(client.getAllBuffers()).toHaveLength(0)
    expect(client.getBuffer(1)).toBeUndefined()

    await client.destroy()
  })

  test("should handle destroy() during pending initialization", async () => {
    const client = new TreeSitterClient({ dataPath, initTimeout: 50 })
    const internals = client as unknown as {
      initializeResolvers?: unknown
    }

    // Start init but don't await
    const initPromise = client.initialize()
    void initPromise.catch(() => {})

    // Immediately destroy
    await client.destroy()

    // Init promise should reject with specific error
    await expect(initPromise).rejects.toThrow("Client destroyed during initialization")
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(client.isInitialized()).toBe(false)
    expect(internals.initializeResolvers).toBeUndefined()
  })

  test("should reject initialization while worker termination is pending", async () => {
    const client = new TreeSitterClient({ dataPath })
    await client.initialize()

    const internals = client as unknown as {
      worker?: { terminate: () => void | Promise<number> }
    }
    const worker = internals.worker
    expect(worker).toBeDefined()
    if (!worker) {
      throw new Error("Expected initialized client to have a worker")
    }

    let resolveTermination!: () => void
    const terminationGate = new Promise<void>((resolve) => {
      resolveTermination = resolve
    })
    const originalTerminate = worker.terminate.bind(worker)
    worker.terminate = async () => {
      await terminationGate
      const result = originalTerminate()
      return result && typeof (result as PromiseLike<number>).then === "function" ? await result : 0
    }

    const destroyPromise = client.destroy()

    try {
      await expect(client.initialize()).rejects.toThrow("Cannot initialize while client is being destroyed")
      expect(client.isInitialized()).toBe(false)

      resolveTermination()
      await destroyPromise

      await client.initialize()
      expect(client.isInitialized()).toBe(true)
      expect(internals.worker).not.toBe(worker)
    } finally {
      resolveTermination()
      await destroyPromise
      await client.destroy()
    }
  })

  test("should retain the worker when termination fails so destroy can be retried", async () => {
    const client = new TreeSitterClient({ dataPath })
    await client.initialize()

    const internals = client as unknown as {
      worker?: { terminate: () => void | Promise<number> }
    }
    const worker = internals.worker
    expect(worker).toBeDefined()
    if (!worker) {
      throw new Error("Expected initialized client to have a worker")
    }

    const originalTerminate = worker.terminate.bind(worker)
    worker.terminate = async () => {
      throw new Error("synthetic termination failure")
    }

    await expect(client.destroy()).rejects.toThrow("synthetic termination failure")
    expect(internals.worker).toBe(worker)
    await expect(client.initialize()).rejects.toThrow("retry destroy()")

    worker.terminate = originalTerminate
    await client.destroy()
    expect(internals.worker).toBeUndefined()
  })

  test("should reject pending requests when an initialized worker errors", async () => {
    const client = new TreeSitterClient({ dataPath })
    await client.initialize()

    const internals = client as unknown as {
      messageCallbacks: Map<string, unknown>
      worker?: {
        onerror: ((event: { message: string; error?: unknown }) => void) | null
        postMessage: (message: { type?: string }) => void
      }
    }
    const worker = internals.worker
    expect(worker).toBeDefined()
    if (!worker) {
      throw new Error("Expected initialized client to have a worker")
    }

    const originalPostMessage = worker.postMessage.bind(worker)
    const blockedTypes = new Set(["GET_PERFORMANCE", "PRELOAD_PARSER", "ONESHOT_HIGHLIGHT"])
    worker.postMessage = (message) => {
      if (!blockedTypes.has(message.type ?? "")) {
        originalPostMessage(message)
      }
    }
    const observe = <T>(promise: Promise<T>) =>
      promise.then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      )
    const outcomes = [
      observe(client.getPerformance()),
      observe(client.preloadParser("javascript")),
      observe(client.highlightOnce("const value = 1", "javascript")),
    ]

    try {
      expect(internals.messageCallbacks.size).toBe(3)
      expect(worker.onerror).not.toBeNull()
      worker.onerror?.({ message: "synthetic post-init failure" })

      expect(client.isInitialized()).toBe(false)
      expect(internals.messageCallbacks.size).toBe(0)
      for (const outcome of await Promise.all(outcomes)) {
        expect(outcome.status).toBe("rejected")
        if (outcome.status === "rejected") {
          expect(outcome.error).toBeInstanceOf(Error)
          expect((outcome.error as Error).message).toContain("synthetic post-init failure")
        }
      }
    } finally {
      await client.destroy()
      await Promise.all(outcomes)
    }
  })

  test("should handle worker errors gracefully", async () => {
    const client = new TreeSitterClient({ dataPath })

    let errorReceived = false
    client.on("error", () => {
      errorReceived = true
    })

    const hasParser = await client.createBuffer(1, "test", "javascript", 1, false)
    expect(hasParser).toBe(false)
    expect(errorReceived).toBe(true)

    await client.destroy()
  })

  test("should handle data path changes with reactive getTreeSitterClient", async () => {
    const originalXdgDataHome = process.env.XDG_DATA_HOME

    process.env.XDG_DATA_HOME = reactiveDataPathRoot
    clearEnvCache()
    destroySingleton("data-paths-opentui")
    await destroyTreeSitterClient()

    const dataPathsManager = getDataPaths()
    let client: any

    try {
      client = getTreeSitterClient()
      await client.initialize()

      const initialDataPath = dataPathsManager.globalDataPath

      dataPathsManager.appName = "test-app-changed"

      await new Promise((resolve) => setTimeout(resolve, 100))

      const newDataPath = dataPathsManager.globalDataPath
      expect(newDataPath).not.toBe(initialDataPath)
      expect(newDataPath).toContain("test-app-changed")

      if (!client.isInitialized()) {
        await client.initialize()
      }

      const hasParser = await client.preloadParser("javascript")
      expect(hasParser).toBe(true)
    } finally {
      await destroyTreeSitterClient()
      destroySingleton("data-paths-opentui")

      if (originalXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME
      } else {
        process.env.XDG_DATA_HOME = originalXdgDataHome
      }
      clearEnvCache()
    }
  })

  test("should remove the reactive data path listener when the singleton client is destroyed", async () => {
    await destroyTreeSitterClient()
    destroySingleton("data-paths-opentui")

    const dataPathsManager = getDataPaths()

    expect(dataPathsManager.listenerCount("paths:changed")).toBe(0)

    getTreeSitterClient()
    expect(dataPathsManager.listenerCount("paths:changed")).toBe(1)

    await destroyTreeSitterClient()
    expect(dataPathsManager.listenerCount("paths:changed")).toBe(0)

    destroySingleton("data-paths-opentui")
  })
})
