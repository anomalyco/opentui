import { Readable } from "node:stream"
import { writeSync } from "node:fs"
import { CliRenderEvents, createCliRenderer } from "../renderer.js"

const code = parseInt(process.argv[2] ?? "0", 10)
const mode = process.argv[3] ?? "idle"
const terminateDuringCleanup = () => {
  writeSync(process.stdout.fd, "cleanup terminating\n")
  process.exit(code)
}

const stdin = new Readable({ read() {} }) as NodeJS.ReadStream & {
  setRawMode: (enabled: boolean) => NodeJS.ReadStream
}
stdin.setRawMode = (enabled) => {
  if (!enabled) {
    process.stdout.write("raw mode disabled\n")
  }
  return stdin
}

const renderer = await createCliRenderer({
  width: 20,
  height: 10,
  stdin,
  stdout: process.stdout,
  screenMode: "alternate-screen",
  bufferedOutput: "stdout",
  remote: true,
  onDestroy: mode === "on-destroy-exit" ? terminateDuringCleanup : undefined,
})
if (mode === "destroy-listener-exit") renderer.on(CliRenderEvents.DESTROY, terminateDuringCleanup)
if (mode === "root-destroyed-exit") renderer.root.on("destroyed", terminateDuringCleanup)
await renderer.idle()

process.on("exit", () => {
  renderer.destroy()
})

if (mode === "during-render") {
  renderer.setFrameCallback(async () => {
    process.exit(code)
  })
  renderer.start()
} else {
  if (mode === "destroy-first") renderer.destroy()
  process.exit(code)
}
