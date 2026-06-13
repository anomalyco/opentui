import { EditBuffer } from "./edit-buffer.js"

const buffer = EditBuffer.create("unicode")
buffer.on("content-changed", () => {})
buffer.setText("worker")
await Bun.sleep(0)
buffer.destroy()

self.postMessage("done")
