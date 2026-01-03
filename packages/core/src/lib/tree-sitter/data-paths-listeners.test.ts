import { afterEach, describe, expect, it } from "bun:test"
import { getDataPaths } from "../data-paths"
import { destroySingleton, hasSingleton } from "../singleton"
import { getTreeSitterClient } from "./index"

const treeSitterKey = "tree-sitter-client"
const dataPathsKey = "data-paths-opentui"

async function cleanupSingletons(): Promise<void> {
  if (hasSingleton(treeSitterKey)) {
    await getTreeSitterClient().destroy()
    destroySingleton(treeSitterKey)
  }

  if (hasSingleton(dataPathsKey)) {
    const manager = getDataPaths()
    manager.removeAllListeners("paths:changed")
    destroySingleton(dataPathsKey)
  }
}

afterEach(async () => {
  await cleanupSingletons()
})

describe("TreeSitter client lifecycle", () => {
  it("does not leak DataPathsManager listeners when recreating the client", async () => {
    await cleanupSingletons()

    const dataPaths = getDataPaths()
    const initialCount = dataPaths.listenerCount("paths:changed")

    for (let i = 0; i < 5; i += 1) {
      const client = getTreeSitterClient()
      await client.destroy()
      destroySingleton(treeSitterKey)
    }

    const finalCount = dataPaths.listenerCount("paths:changed")
    expect(finalCount).toBe(initialCount)
  })
})
