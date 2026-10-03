import { isWorkerRuntime, postWorkerMessage, Worker } from "../platform/worker.js"
import { FFIRenderLib, resolveRenderLib } from "../zig.js"

// Ghostty logs this unknown sequence through the process-global native logger.
function writeLoggedSequence(): void {
  const lib = resolveRenderLib()
  const context = lib.createContext({ objectCapacity: 1, renderCellsMax: 20 })
  try {
    const terminal = lib.createContextEmbeddedTerminal(context, { cols: 10, rows: 2 })
    lib.contextEmbeddedTerminalWrite(context, terminal, "\x1b[999;999;999z")
    lib.destroyContextEmbeddedTerminal(context, terminal)
  } finally {
    lib.destroyContext(context)
  }
}

if (isWorkerRuntime) {
  // The main thread owns the callback, so this thread's log must not call it.
  writeLoggedSequence()
  postWorkerMessage("ready")
} else {
  resolveRenderLib()
  // Disposing an older and then the newest main-thread library must hand the callback back to the first one.
  const older = new FFIRenderLib()
  const newest = new FFIRenderLib()
  older.dispose()
  newest.dispose()

  // A Worker's library must not install its callback: it dies with the Worker.
  const worker = new Worker(new URL(import.meta.url))
  try {
    await new Promise<void>((resolve, reject) => {
      worker.onmessage = () => resolve()
      worker.onerror = (event) => reject(event.error ?? new Error(event.message))
    })
  } finally {
    await worker.terminate()
  }

  writeLoggedSequence()
  console.log("native log survived")
}
