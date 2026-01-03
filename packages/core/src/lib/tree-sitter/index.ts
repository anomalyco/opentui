import { singleton } from "../singleton"
import { TreeSitterClient } from "./client"
import type { TreeSitterClientOptions } from "./types"
import { getDataPaths } from "../data-paths"

export * from "./client"
export * from "../tree-sitter-styled-text"
export * from "./types"
export * from "./resolve-ft"
export type { UpdateOptions } from "./assets/update"
export { updateAssets } from "./assets/update"

export function getTreeSitterClient(): TreeSitterClient {
  const dataPathsManager = getDataPaths()
  const defaultOptions: TreeSitterClientOptions = {
    dataPath: dataPathsManager.globalDataPath,
  }

  return singleton("tree-sitter-client", () => {
    const client = new TreeSitterClient(defaultOptions)

    const handlePathsChanged = (paths: { globalDataPath: string }) => {
      client.setDataPath(paths.globalDataPath)
    }

    dataPathsManager.on("paths:changed", handlePathsChanged)

    const originalDestroy = client.destroy.bind(client)
    client.destroy = async () => {
      dataPathsManager.off("paths:changed", handlePathsChanged)
      await originalDestroy()
    }

    return client
  })
}
