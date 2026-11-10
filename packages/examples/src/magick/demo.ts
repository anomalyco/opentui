import { parseArgs } from "node:util"
import {
  BoxRenderable,
  createCliRenderer,
  ImageRenderable,
  NativeImagePool,
  TextRenderable,
  type CliRenderer,
  type KeyEvent,
  type KittyImageTransport,
} from "@opentui/core"
import { setupCommonDemoKeys } from "../lib/standalone-keys.js"
import { createArena } from "./arena.js"
import { createPixelRenderer } from "./pixel-renderer.js"

interface DemoOptions {
  width?: number
  height?: number
  standalone?: boolean
}

const sessions = new WeakMap<CliRenderer, () => Promise<void>>()
const gpuSessions = new WeakMap<
  CliRenderer,
  { width: number; height: number; ready: ReturnType<typeof createPixelRenderer> }
>()

function getSessionGpu(renderer: CliRenderer, width: number, height: number) {
  const existing = gpuSessions.get(renderer)
  if (existing) {
    if (existing.width !== width || existing.height !== height) throw new Error("The session framebuffer size is fixed")
    return existing.ready
  }
  // Recreating this pinned binding's adapter retains provider resources. Keep one per terminal session.
  const ready = createPixelRenderer(width, height)
  const release = () => {
    gpuSessions.delete(renderer)
    void destroy(renderer)
      .finally(() =>
        ready.then(
          (gpu) => gpu.dispose(),
          () => {},
        ),
      )
      .catch((error) => console.error("Magick GPU cleanup failed:", error))
  }
  gpuSessions.set(renderer, { width, height, ready })
  renderer.once("destroy", release)
  void ready.catch(() => {
    gpuSessions.delete(renderer)
    renderer.off("destroy", release)
  })
  return ready
}

export async function run(renderer: CliRenderer, options: DemoOptions = {}): Promise<void> {
  if (renderer.isDestroyed) return
  if (sessions.has(renderer)) throw new Error("Magick is already running")
  // Three's initial RAF must return before the host executes its callback.
  renderer.pause()
  const { width = 640, height = 360 } = options
  let arena: ReturnType<typeof createArena> | undefined
  let pool: NativeImagePool | undefined
  let gpu: Awaited<ReturnType<typeof createPixelRenderer>> | undefined
  let root: BoxRenderable | undefined
  let hud: TextRenderable
  let view: ImageRenderable
  let initialization: Promise<void>
  let pendingFrame: Promise<void> | undefined
  let closePromise: Promise<void> | undefined
  let closing = false
  let paused = false
  let failed = false
  let needsFrame = true
  let time = 0
  let accumulator = 0
  let submitted = 0
  let dropped = 0
  const previousFps = { target: renderer.targetFps, max: renderer.maxFps }
  const previousTransport = renderer.kittyImageTransport
  const held = new Map<string, number>()
  const player = { x: -3, z: -3 }

  function updateHud() {
    if (closing || renderer.isDestroyed) return
    const transport = renderer.kittyImageTransportStatus
    const protocol = view.effectiveProtocol
    let output = `${protocol} | Kitty ${transport.requested} (inactive)`
    if (protocol === "kitty") {
      output = `kitty/${transport.requested}`
      if (transport.effective !== transport.requested) output += ` -> ${transport.effective}`
      if (transport.requested === "file" && transport.fileState !== "ready") output += ` (${transport.fileState})`
      else if (transport.fallback !== "none") output += ` (${transport.fallback})`
    }
    const state = failed ? "Render failed (C: details)" : !gpu ? "Loading WebGPU" : paused ? "Paused" : "Running"
    const content = `MAGICK | ${width}x${height} | ${output} | ${state}`
    if (hud.plainText !== content) hud.content = content
  }

  function clearHeld() {
    held.clear()
    accumulator = 0
  }

  function onKey(key: KeyEvent) {
    if (closing || key.defaultPrevented || key.ctrl || key.meta || key.option || key.shift || key.super || key.hyper)
      return
    if (key.name === "c" && !key.repeated) {
      console.log("Magick diagnostics:", {
        framebuffer: { width, height },
        protocol: view.effectiveProtocol,
        transport: renderer.kittyImageTransportStatus,
        capabilities: renderer.capabilities,
        adapter: gpu?.adapter,
        ownership: gpu?.ownership(),
        submitted,
        dropped,
        renderer: renderer.getStats(),
      })
      renderer.console.show()
      clearHeld()
      return
    }
    if (renderer.console.visible) {
      clearHeld()
      return
    }
    if (key.name === "space" && !key.repeated) {
      paused = !paused
      clearHeld()
      updateHud()
    } else if (key.name === "t" && !key.repeated) {
      const transports: KittyImageTransport[] = ["raw", "zlib", "file"]
      renderer.kittyImageTransport =
        transports[(transports.indexOf(renderer.kittyImageTransport) + 1) % transports.length]
      updateHud()
    } else if (key.name === "r" && !key.repeated) {
      time = 0
      player.x = -3
      player.z = -3
      clearHeld()
      needsFrame = true
      renderer.requestRender()
    } else if (["w", "a", "s", "d"].includes(key.name)) {
      held.set(key.name, key.source === "kitty" ? Infinity : performance.now() + 80)
    }
  }

  function onRelease(key: KeyEvent) {
    held.delete(key.name)
  }

  async function draw(deltaMs: number) {
    if (!gpu || closing || failed || renderer.isDestroyed) return
    if (renderer.console.visible) clearHeld()
    if (paused && !needsFrame) return
    try {
      const now = performance.now()
      for (const [key, expiry] of held) if (now >= expiry) held.delete(key)
      if (!paused) {
        accumulator = Math.min(accumulator + deltaMs / 1000, 5 / 60)
        while (accumulator >= 1 / 60) {
          const dx = Number(held.has("d")) - Number(held.has("a"))
          const dz = Number(held.has("s")) - Number(held.has("w"))
          const scale = 4 / 60 / Math.max(1, Math.hypot(dx, dz)) / Math.SQRT2
          player.x = Math.max(-8, Math.min(8, player.x + (dx + dz) * scale))
          player.z = Math.max(-8, Math.min(8, player.z + (dz - dx) * scale))
          time += 1 / 60
          accumulator -= 1 / 60
        }
      }
      arena!.update(time, player)
      needsFrame = false
      const image = await gpu.draw(arena!.scene, arena!.camera, (frame) =>
        pool!.publishPixels(frame.data, { stride: frame.stride, format: frame.format, alpha: "opaque" }),
      )
      if (image) {
        try {
          if (closing || renderer.isDestroyed) return
          view.source = image
          await view.loadPromise
          if (view.loadError) throw view.loadError
          submitted++
        } finally {
          image.dispose()
        }
      } else {
        dropped++
        needsFrame = true
      }
    } catch (error) {
      if (closing || renderer.isDestroyed) return
      failed = true
      clearHeld()
      renderer.pause()
      console.error("Magick rendering failed:", error)
      renderer.console.show()
      updateHud()
    }
  }

  function frameCallback(deltaMs: number) {
    pendingFrame = draw(deltaMs)
    return pendingFrame
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise
    closing = true
    clearHeld()
    renderer.removeFrameCallback(frameCallback)
    renderer.keyInput.off("keypress", onKey)
    renderer.keyInput.off("keyrelease", onRelease)
    renderer.off("blur", clearHeld)
    renderer.off("frame", updateHud)
    renderer.off("destroy", onDestroy)
    if (!renderer.isDestroyed) renderer.pause()
    closePromise = (async () => {
      await initialization.catch(() => {})
      await pendingFrame?.catch(() => {})
      try {
        root?.destroyRecursively()
      } finally {
        try {
          gpu?.setAnimationActive(false)
        } finally {
          try {
            arena?.dispose()
          } finally {
            try {
              pool?.dispose()
            } finally {
              sessions.delete(renderer)
              if (!renderer.isDestroyed) {
                renderer.targetFps = previousFps.target
                renderer.maxFps = previousFps.max
                renderer.kittyImageTransport = previousTransport
              }
            }
          }
        }
      }
    })()
    return closePromise
  }

  function onDestroy() {
    void close().catch((error) => console.error("Magick cleanup failed:", error))
  }

  sessions.set(renderer, close)
  renderer.once("destroy", onDestroy)
  initialization = (async () => {
    root = new BoxRenderable(renderer, {
      id: "magick",
      position: "absolute",
      width: "100%",
      height: "100%",
      backgroundColor: "#111925",
    })
    hud = new TextRenderable(renderer, { id: "magick-status", width: "100%", flexShrink: 0, fg: "#c7d8e2" })
    view = new ImageRenderable(renderer, {
      id: "magick-scene",
      width: "100%",
      flexGrow: 1,
      minHeight: 0,
      fit: "fit",
      protocol: "auto",
    })
    const help = new TextRenderable(renderer, {
      id: "magick-help",
      width: "100%",
      flexShrink: 0,
      fg: "#c7d8e2",
      content: `WASD move | Space pause | R reset | T transport | C diagnostics\n\` console | . stats | ${options.standalone ? "Esc/Q quit" : "Esc back"} | Ctrl+C quit`,
    })
    root.add(hud)
    root.add(view)
    root.add(help)
    renderer.root.add(root)
    updateHud()
    renderer.keyInput.on("keypress", onKey)
    renderer.keyInput.on("keyrelease", onRelease)
    renderer.on("blur", clearHeld)
    renderer.on("frame", updateHud)
    arena = createArena(width / height)
    pool = new NativeImagePool({ width, height, capacity: 2 })
    gpu = await getSessionGpu(renderer, width, height)
    if (closing || renderer.isDestroyed) return
    gpu.setAnimationActive(true)
    renderer.targetFps = 60
    renderer.maxFps = 60
    renderer.setFrameCallback(frameCallback)
    updateHud()
    renderer.start()
  })()
  try {
    await initialization
  } catch (error) {
    await close()
    throw error
  }
}

export async function destroy(renderer: CliRenderer): Promise<void> {
  await sessions.get(renderer)?.()
}

export async function runStandalone(args = process.argv.slice(2)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      width: { type: "string", default: "640" },
      height: { type: "string", default: "360" },
      transport: { type: "string", default: "raw" },
    },
  })
  const width = Number(values.width)
  const height = Number(values.height)
  if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0) || width * height > 3840 * 2160)
    throw new Error("Invalid framebuffer dimensions")
  if (!["raw", "zlib", "file"].includes(values.transport!)) throw new Error("--transport must be raw, zlib, or file")
  if (!process.stdout.isTTY) throw new Error("Run this demo in a terminal")

  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useKittyKeyboard: { events: true, allKeysAsEscapes: true },
    kittyImageTransport: values.transport as KittyImageTransport,
  })
  setupCommonDemoKeys(renderer)
  renderer.keyInput.on("keypress", (key) => {
    if (key.name === "escape" || (!key.ctrl && !key.meta && key.name === "q")) {
      key.preventDefault()
      key.stopPropagation()
      renderer.destroy()
    }
  })
  try {
    await run(renderer, { width, height, standalone: true })
  } catch (error) {
    renderer.destroy()
    throw error
  } finally {
    if (renderer.isDestroyed) await destroy(renderer)
  }
}

if (import.meta.main) await runStandalone()
