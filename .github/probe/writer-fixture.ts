// Child of writer-checks.py: a renderer whose frames change every cell, on a pty the parent stalls.
// usage: bun writer-fixture.ts MODE STATUS_FILE   (MODE: exit | suspend | crash-active | crash-after-destroy)
// Events go to STATUS_FILE as JSON lines; the parent acts on them.
import { dlopen, FFIType } from "bun:ffi"
import { appendFileSync, existsSync } from "node:fs"
import { BoxRenderable, TextRenderable, createCliRenderer } from "../../packages/core/src/index"

const [mode, status] = process.argv.slice(2) as [string, string]
const t0 = performance.now()
let lagMax = 0
// When the longest stall ended, in ms since start: tells a stall in setup from one in the link stall.
let lagAt = 0
let lagFrom = Infinity
// fcntl is variadic. Apple arm64 passes variadic arguments on the stack, so the flags go in the ninth
// argument (the first stack slot) as well as the third (x86_64's register).
const libc = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", {
  fcntl: { args: Array(9).fill(FFIType.i32), returns: FFIType.i32 },
})
const fcntl = (cmd: number, arg: number) => libc.symbols.fcntl(1, cmd, arg, 0, 0, 0, 0, 0, arg)
const O_NONBLOCK = process.platform === "darwin" ? 0x4 : 0o4000
const nonblock = () => (fcntl(3, 0) & O_NONBLOCK) !== 0
const log = (event: string, extra: Record<string, unknown> = {}) =>
  appendFileSync(
    status,
    JSON.stringify({ event, t: Math.round(performance.now() - t0), lagMax, lagAt, nonblock: nonblock(), ...extra }) +
      "\n",
  )

// The JS thread's longest stall after `ready`: with the writer on it stays small while the pty is stalled.
let last = performance.now()
setInterval(() => {
  const now = performance.now()
  if (now > lagFrom && now - last - 5 > lagMax) {
    lagMax = now - last - 5
    lagAt = Math.round(now - t0)
  }
  last = now
}, 5)

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  useMouse: mode === "suspend",
  targetFps: 60,
  maxFps: 60,
})
// Bun clears O_NONBLOCK on fd 1 at startup, so set it here, as another program sharing the tty would.
if (process.env.WRITER_NONBLOCK === "1") fcntl(4, fcntl(3, 0) | O_NONBLOCK)
const box = new BoxRenderable(renderer, { width: "100%", height: "100%" })
const text = new TextRenderable(renderer, { content: "", fg: "#cdd6f4" })
box.add(text)
renderer.root.add(box)
const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
let seed = 1
const page = () => {
  let out = ""
  for (let row = 0; row < renderer.height - 1; row++) {
    for (let col = 0; col < renderer.width; col++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      out += letters[seed % letters.length]
    }
    out += "\n"
  }
  return out
}
const startPaint = () =>
  setInterval(() => {
    text.content = page()
    text.fg = seed & 1 ? "#cdd6f4" : "#f38ba8"
  }, 16)
let paint = startPaint()
renderer.start()

await Bun.sleep(300)
lagFrom = performance.now()
log("ready")
await Bun.sleep(700)

if (mode === "exit") {
  log("exiting")
  process.exit(0)
} else if (mode === "suspend") {
  clearInterval(paint)
  log("suspend-start")
  const suspended = renderer.suspend()
  // setRawMode(false) has run; the Session may still be writing the suspend bytes.
  log("suspend-called")
  await suspended
  log("suspended")
  const flag = status + ".continue"
  while (!existsSync(flag)) await Bun.sleep(20)
  log("continued")
  await renderer.resume()
  // idle() waits for a stopped render loop.
  renderer.stop()
  await renderer.idle()
  log("resumed")
  renderer.destroy()
  await renderer.closed
  log("closed")
  process.exit(0)
} else if (mode === "crash-active") {
  setTimeout(() => {
    throw new Error("boom-active")
  })
  await Bun.sleep(300)
  log("survived")
  clearInterval(paint)
  renderer.destroy()
  await renderer.closed
  log("closed")
  process.exit(0)
} else if (mode === "crash-after-destroy") {
  clearInterval(paint)
  renderer.destroy()
  log("destroyed")
  setTimeout(() => {
    throw new Error("boom-after-destroy")
  })
}
