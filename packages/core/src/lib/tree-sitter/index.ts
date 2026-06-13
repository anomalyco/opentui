import { destroySingleton, getSingleton, singleton } from "../singleton.js"
import { TreeSitterClient } from "./client.js"
import type { TreeSitterClientOptions } from "./types.js"
import { getDataPaths } from "../data-paths.js"

export * from "./client.js"
export * from "../tree-sitter-styled-text.js"
export * from "./types.js"
export * from "./resolve-ft.js"

const TREE_SITTER_CLIENT_KEY = "tree-sitter-client"
const TREE_SITTER_CLIENT_LISTENER_STATE_KEY = "tree-sitter-client-listener-state"

interface TreeSitterClientListenerState {
  removeListener?: () => void
}

function getTreeSitterClientListenerState(): TreeSitterClientListenerState {
  return singleton(TREE_SITTER_CLIENT_LISTENER_STATE_KEY, () => ({}))
}

export function getTreeSitterClient(): TreeSitterClient {
  const existingClient = getSingleton<TreeSitterClient>(TREE_SITTER_CLIENT_KEY)
  if (existingClient) {
    return existingClient
  }

  const dataPathsManager = getDataPaths()
  const defaultOptions: TreeSitterClientOptions = {
    dataPath: dataPathsManager.globalDataPath,
  }

  return singleton(TREE_SITTER_CLIENT_KEY, () => {
    const client = new TreeSitterClient(defaultOptions)
    const listenerState = getTreeSitterClientListenerState()

    const handlePathsChanged = (paths: { globalDataPath: string }) => {
      void client.setDataPath(paths.globalDataPath).catch((error) => {
        console.warn("Failed to update tree-sitter data path:", error)
      })
    }

    const removeListener = () => {
      dataPathsManager.off("paths:changed", handlePathsChanged)
      if (listenerState.removeListener === removeListener) {
        listenerState.removeListener = undefined
      }
      if (getSingleton<TreeSitterClient>(TREE_SITTER_CLIENT_KEY) === client) {
        destroySingleton(TREE_SITTER_CLIENT_KEY)
      }
    }

    listenerState.removeListener = removeListener
    client.onDestroy(removeListener)

    dataPathsManager.on("paths:changed", handlePathsChanged)

    return client
  })
}

export async function destroyTreeSitterClient(): Promise<void> {
  const client = getSingleton<TreeSitterClient>(TREE_SITTER_CLIENT_KEY)
  if (!client) {
    const listenerState = getSingleton<TreeSitterClientListenerState>(TREE_SITTER_CLIENT_LISTENER_STATE_KEY)
    listenerState?.removeListener?.()
    if (listenerState) {
      listenerState.removeListener = undefined
    }
    return
  }

  destroySingleton(TREE_SITTER_CLIENT_KEY)
  await client.destroy()
}
