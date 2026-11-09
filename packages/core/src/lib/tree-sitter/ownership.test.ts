import { test, expect } from "bun:test"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TreeSitterClient } from "./client.js"

test("replaced syntax trees are released after edits and resets", async () => {
  const dataPath = await mkdtemp(join(tmpdir(), "tree-ownership-"))
  const client = new TreeSitterClient({ dataPath, workerPath: new URL("./ownership.worker.ts", import.meta.url) })
  let counts: number[] = []
  client.on("worker:log", (_type, message) => {
    if (message.startsWith("ownership ")) counts = JSON.parse(message.slice("ownership ".length))
  })
  const highlighted = async (action: () => Promise<unknown>) => {
    const response = once(client, "highlights:response", { signal: AbortSignal.timeout(10000) })
    await Promise.all([action(), response])
  }
  try {
    await once(client, "worker:log", { signal: AbortSignal.timeout(10000) })
    await client.initialize()
    await highlighted(() => client.createBuffer(1, "const a = 1", "javascript", 1))
    await highlighted(() => client.resetBuffer(1, 2, "const a = 2"))
    await highlighted(() =>
      client.updateBuffer(
        1,
        [
          {
            startIndex: 10,
            oldEndIndex: 11,
            newEndIndex: 11,
            startPosition: { row: 0, column: 10 },
            oldEndPosition: { row: 0, column: 11 },
            newEndPosition: { row: 0, column: 11 },
          },
        ],
        "const a = 3",
        3,
      ),
    )
    await client.removeBuffer(1)
    await client.getPerformance()
    expect(counts).toEqual([3, 3])
  } finally {
    await client.destroy()
    await rm(dataPath, { recursive: true, force: true })
  }
}, 30000)
