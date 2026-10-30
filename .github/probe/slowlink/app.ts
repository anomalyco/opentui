// OpenCode-like streaming scene for the slow-link harness. Run from packages/core.
// Env: SL_LIB (native library), SL_LOG (JSON log path), SL_TOKEN_MS (token interval).
import { writeFileSync } from "node:fs"
import { setRenderLibPath, resolveRenderLib } from "./src/zig"

if (process.env.SL_LIB) setRenderLibPath(process.env.SL_LIB)
const lib: any = resolveRenderLib()
const now = () => performance.timeOrigin + performance.now()

const drains: { t: number; ms: number; bytes: number }[] = []
const realDrain = lib.sessionDrainStdout.bind(lib)
const gov = Number(process.env.SL_GOV ?? 0)
let outq: ((fd: number) => number) | null = null
if (gov > 0) {
  const { dlopen, FFIType, ptr } = await import("bun:ffi")
  const libc = dlopen("libc.so.6", { ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 } })
  const cell = new Int32Array(1)
  outq = (fd) => (libc.symbols.ioctl(fd, 0x5411, ptr(cell)) === 0 ? cell[0] : 0)
}
let govHolds = 0
const pace = Number(process.env.SL_PACE ?? 0)
let credit = 0
let creditAt = now()
lib.sessionDrainStdout = (...args: any[]) => {
  if (pace > 0) {
    const t = now()
    credit = Math.min(credit + ((t - creditAt) * pace) / 1000, pace * 0.05)
    creditAt = t
    if (credit <= 0) {
      govHolds++
      return 0
    }
    args[2] = Math.max(4, Math.min(65536, Math.ceil(credit)))
    const bytes = realDrain(...args)
    credit -= bytes
    drains.push({ t, ms: now() - t, bytes })
    return bytes
  }
  if (outq && outq(1) > gov) {
    govHolds++
    return 0
  }
  const t = now()
  const bytes = realDrain(...args)
  drains.push({ t, ms: now() - t, bytes })
  return bytes
}

const { createCliRenderer } = await import("./src/renderer")
const { BoxRenderable } = await import("./src/renderables/Box")
const { TextRenderable } = await import("./src/renderables/Text")
const { ScrollBoxRenderable } = await import("./src/renderables/ScrollBox")
const { StyledText } = await import("./src/lib/styled-text")
const { parseColor } = await import("./src/lib/RGBA")

const renderer = await createCliRenderer({ targetFps: 60, maxFps: 60, exitOnCtrlC: false, useMouse: false })
renderer.setBackgroundColor("#1e1e2e")
if (process.env.SL_NONBLOCK === "1") {
  const { dlopen, FFIType } = await import("bun:ffi")
  const libc = dlopen("libc.so.6", { fcntl: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 } })
  const flags = libc.symbols.fcntl(1, 3, 0)
  libc.symbols.fcntl(1, 4, flags | 0o4000)
}

const root = new BoxRenderable(renderer, { id: "root", flexDirection: "column", width: "100%", height: "100%" })
renderer.root.add(root)
const header = new TextRenderable(renderer, {
  id: "header",
  content: "session: slow link streaming",
  fg: "#89b4fa",
  height: 1,
  flexShrink: 0,
})
const scroll = new ScrollBoxRenderable(renderer, {
  id: "scroll",
  flexGrow: 1,
  flexShrink: 1,
  minHeight: 0,
  stickyScroll: true,
  stickyStart: "bottom",
})
const body = new TextRenderable(renderer, { id: "body", content: "", wrapMode: "word" })
scroll.add(body)
const prompt = new BoxRenderable(renderer, {
  id: "prompt",
  height: 3,
  flexShrink: 0,
  border: true,
  borderColor: "#585b70",
})
const promptText = new TextRenderable(renderer, { id: "promptText", content: "> ", fg: "#cdd6f4" })
prompt.add(promptText)
const status = new TextRenderable(renderer, { id: "status", content: "", fg: "#a6adc8", height: 1, flexShrink: 0 })
root.add(header)
root.add(scroll)
root.add(prompt)
root.add(status)

const words =
  "the quick brown fox jumps over lazy dog while render frames stream across slow links into terminal panes".split(" ")
const colors = ["#cdd6f4", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa", "#cba6f7", "#94e2d5"].map((c) => parseColor(c))
const chunks: any[] = []
let lines = 0
let tok = 0
let key = 0
let spin = 0
const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
const tokens: { n: number; due: number; handled: number }[] = []
const keys: { n: number; handled: number }[] = []
const frames: number[] = []
const pad = (n: number) => String(n).padStart(6, "0")
const updateStatus = () => {
  status.content = `${spinner[spin % spinner.length]} tok ${pad(tok)} key ${pad(key)}`
}

const tokenMs = Number(process.env.SL_TOKEN_MS ?? 20)
const lineTokens = Number(process.env.SL_LINE_TOKENS ?? 14)
for (let i = 0; i < lineTokens * 60; i++) {
  chunks.push({ __isChunk: true, text: words[(i * 5) % words.length] + " ", fg: colors[i % colors.length] })
  if (i % lineTokens === lineTokens - 1) chunks.push({ __isChunk: true, text: "\n" })
}
lines = 60
body.content = new StyledText(chunks.slice())
const start = now() + 1500
function produce() {
  const t = now()
  let changed = false
  while (start + (tok + 1) * tokenMs <= t) {
    tok++
    const w = words[(tok * 7) % words.length]
    chunks.push({ __isChunk: true, text: w + " ", fg: colors[tok % colors.length] })
    if (tok % lineTokens === 0) {
      chunks.push({ __isChunk: true, text: "\n" })
      lines++
      if (lines > 300) {
        const cut = chunks.findIndex((c) => c.text === "\n")
        chunks.splice(0, cut + 1)
      }
    }
    tokens.push({ n: tok, due: start + tok * tokenMs, handled: t })
    changed = true
  }
  if (changed) {
    body.content = new StyledText(chunks.slice())
    updateStatus()
  }
}
const tokenTimer = setInterval(produce, tokenMs)
const spinTimer = setInterval(() => {
  spin++
  updateStatus()
}, 80)

let lastTick = now()
const lags: number[] = []
const lagTimer = setInterval(() => {
  const t = now()
  lags.push(t - lastTick)
  lastTick = t
}, 2)

renderer.on("frame", () => frames.push(now()))
renderer.keyInput.on("keypress", (event: any) => {
  if (event.name === "q") return finish()
  if (event.name === "x") {
    key++
    keys.push({ n: key, handled: now() })
    promptText.content = "> " + "x".repeat(key % 40)
    updateStatus()
  }
})
if (process.env.SL_RUNNING === "1") renderer.start()

let finished = false
function finish() {
  if (finished) return
  finished = true
  clearInterval(tokenTimer)
  clearInterval(spinTimer)
  clearInterval(lagTimer)
  if (process.env.SL_LOG) {
    writeFileSync(
      process.env.SL_LOG,
      JSON.stringify({ govHolds, start, tokenMs, tokens, keys, frames, drains, lags, cpu: process.cpuUsage() }),
    )
  }
  renderer.destroy()
  setTimeout(() => process.exit(0), 200)
}
