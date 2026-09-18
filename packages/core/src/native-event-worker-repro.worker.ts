import { EditBuffer } from "./edit-buffer.js"
import { ResourceContext } from "./buffer.js"

const owner = new ResourceContext({ objectCapacity: 1, renderCellsMax: 1 })
try {
  const buffer = EditBuffer.create("unicode", owner)
  try {
    buffer.on("content-changed", () => {})
    buffer.setText("worker")
    await Bun.sleep(0)
  } finally {
    buffer.destroy()
  }
} finally {
  owner.destroy()
}

self.postMessage("done")
