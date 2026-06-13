import { Readable } from "node:stream"
import { createTestRenderer } from "../testing.js"

const code = parseInt(process.argv[2] ?? "0", 10)
const mode = process.argv[3] ?? "idle"

const stdin = new Readable({ read() {} }) as NodeJS.ReadStream & {
  setRawMode: (enabled: boolean) => NodeJS.ReadStream
}
stdin.setRawMode = (enabled) => {
  if (!enabled) {
    console.log("raw mode disabled")
  }
  return stdin
}

const { renderer } = await createTestRenderer({ width: 20, height: 10, stdin })
const lib = (renderer as any).lib
const originalSuspendRenderer = lib.suspendRenderer.bind(lib)
lib.suspendRenderer = (rendererPtr: unknown) => {
  console.log("renderer suspended")
  originalSuspendRenderer(rendererPtr)
}

process.on("exit", () => {
  renderer.destroy()
})

if (mode === "during-render") {
  renderer.setFrameCallback(async () => {
    process.exit(code)
  })
  renderer.start()
} else {
  process.exit(code)
}
