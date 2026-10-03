import { Worker } from "../platform/worker.js"
import { FFIRenderLib, resolveRenderLib } from "../zig.js"

const lib = resolveRenderLib()
// Disposing an older and then the newest main-thread library must hand the callback back to the first one.
const older = new FFIRenderLib()
const newest = new FFIRenderLib()
older.dispose()
newest.dispose()

// A Worker's library must not install its callback: it dies with the Worker.
const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
const worker = new Worker(new URL(`native-log-worker.fixture.${extension}`, import.meta.url))
try {
  await new Promise<void>((resolve, reject) => {
    worker.onmessage = () => resolve()
    worker.onerror = (event) => reject(event.error ?? new Error(event.message))
  })
} finally {
  await worker.terminate()
}

// Ghostty logs unknown sequences through the process-global native logger.
const context = lib.createContext({ objectCapacity: 1, renderCellsMax: 20 })
try {
  const terminal = lib.createContextEmbeddedTerminal(context, { cols: 10, rows: 2 })
  lib.contextEmbeddedTerminalWrite(context, terminal, "\x1b[999;999;999z")
  lib.destroyContextEmbeddedTerminal(context, terminal)
} finally {
  lib.destroyContext(context)
}
console.log("native log survived")
