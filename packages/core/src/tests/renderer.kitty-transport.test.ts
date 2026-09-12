import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { inflateSync } from "node:zlib"
import { createCliRenderer, type CliRenderer, type KittyImageTransport } from "../renderer.js"
import { NativeImage } from "../image.js"
import { ImageRenderable } from "../renderables/Image.js"
import { createTestStdin, TestWriteStream } from "../testing/test-streams.js"

type Command = { fields: Record<string, string>; payload: Buffer }

class SyntheticTerminal extends TestWriteStream {
  readonly stdin = createTestStdin()
  readonly commands: Command[] = []
  probeReplies: "both" | "query-only" | "reject" = "both"
  rejectUploads = false
  private pending = ""
  probePath = ""

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.pending += chunk.toString("latin1")
    for (;;) {
      const start = this.pending.indexOf("\x1b_G")
      if (start < 0) {
        this.pending = this.pending.endsWith("\x1b_") ? "\x1b_" : this.pending.endsWith("\x1b") ? "\x1b" : ""
        break
      }
      const end = this.pending.indexOf("\x1b\\", start)
      if (end < 0) {
        this.pending = this.pending.slice(start)
        break
      }
      const [header, data = ""] = this.pending.slice(start + 3, end).split(";")
      this.pending = this.pending.slice(end + 2)
      const fields = Object.fromEntries(header.split(",").map((field) => field.split("=")))
      const payload = Buffer.from(data, "base64")
      this.commands.push({ fields, payload })
      if (fields.a === "q") {
        if (fields.t === "f") this.probePath = payload.toString()
        this.reply(fields.i, fields.t === "f" && this.probeReplies === "reject" ? "ENOENT:not local" : "OK")
      } else if (fields.a === "t" && fields.t === "f" && payload.toString() === this.probePath) {
        if (this.probeReplies === "both") this.reply(fields.i)
      } else if (fields.a === "t" && fields.t === "f" && this.rejectUploads) {
        this.reply(fields.i, "EIO:synthetic upload failure")
      }
    }
    callback()
  }

  reply(id: string, message = "OK"): void {
    const bytes = Buffer.from(`\x1b_Gi=${id};${message}\x1b\\`)
    // Exercise the existing input parser's fragmented APC handling.
    this.stdin.emit("data", bytes.subarray(0, 5))
    this.stdin.emit("data", bytes.subarray(5))
  }

  uploads(): Command[] {
    return this.commands.filter(({ fields }) => fields.a === "t")
  }

  imageBytes(): Buffer {
    return Buffer.concat(this.commands.filter(({ fields }) => fields.a === "t" || "m" in fields).map((c) => c.payload))
  }
}

const renderers: CliRenderer[] = []
const fileTest = process.platform === "win32" ? test.skip : test
const originalTmpdir = process.env.TMPDIR
beforeEach(() => {
  // The Node suite grants filesystem access to this image fixture directory.
  if (process.env.OTUI_IMAGE_TEST_TMPDIR) process.env.TMPDIR = process.env.OTUI_IMAGE_TEST_TMPDIR
})
afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.destroy()
  if (originalTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = originalTmpdir
})

async function setup(
  mode?: KittyImageTransport,
  options: { remote?: boolean; probe?: SyntheticTerminal["probeReplies"] } = {},
) {
  const terminal = new SyntheticTerminal(10, 4)
  terminal.probeReplies = options.probe ?? "both"
  const renderer = await createCliRenderer({
    stdin: terminal.stdin,
    stdout: terminal as unknown as NodeJS.WriteStream,
    remote: options.remote ?? false,
    kittyImageTransport: mode,
    consoleMode: "disabled",
    useMouse: false,
    exitSignals: [],
  })
  renderers.push(renderer)
  await renderer.idle()
  terminal.commands.length = 0
  return { renderer, terminal }
}

async function draw(renderer: CliRenderer, pixels: Uint8Array, width = 64, png = false): Promise<ImageRenderable> {
  const source = NativeImage.fromRgba(pixels, width, pixels.length / width / 4)
  if (png) source.ensureEncodedPng()
  const renderable = new ImageRenderable(renderer, { source, protocol: "kitty", width: 2, height: 1 })
  source.dispose()
  renderer.root.add(renderable)
  await renderable.loadPromise
  renderer.requestRender()
  await renderer.idle()
  return renderable
}

for (const mode of [undefined, "zlib"] as const) {
  for (const alpha of [false, true]) {
    test(`Kitty ${mode ?? "default"} transport roundtrips exact ${alpha ? "RGBA" : "RGB"}`, async () => {
      const { renderer, terminal } = await setup(mode)
      const pixels = new Uint8Array(64 * 64 * 4)
      const expected: number[] = []
      for (let i = 0; i < pixels.length; i += 4) {
        const pixel = [i % 256, 42, 19, alpha ? 127 : 255]
        pixels.set(pixel, i)
        expected.push(...pixel.slice(0, alpha ? 4 : 3))
      }
      await draw(renderer, pixels)
      const upload = terminal.uploads()[0]
      expect(upload.fields.f).toBe(alpha ? "32" : "24")
      if (mode === "zlib") expect(upload.fields.o).toBe("z")
      else expect(upload.fields.o).toBeUndefined()
      const bytes = terminal.imageBytes()
      expect(mode === "zlib" ? inflateSync(bytes) : bytes).toEqual(Buffer.from(expected))
      expect(renderer.kittyImageTransportStatus.effective).toBe(mode ?? "raw")
    })
  }
}

test("Kitty zlib uses raw on entropy expansion and leaves retained PNG unchanged", async () => {
  const { renderer, terminal } = await setup("zlib")
  const noise = new Uint8Array(64 * 64 * 4)
  let seed = 7919
  for (let i = 0; i < noise.length; i++) {
    seed ^= seed << 13
    seed ^= seed >>> 17
    seed ^= seed << 5
    noise[i] = seed & 255
  }
  const first = await draw(renderer, noise)
  expect(renderer.kittyImageTransportStatus.effective).toBe("raw")
  expect(renderer.kittyImageTransportStatus.fallback).toBe("compression")
  expect(terminal.imageBytes()).toEqual(Buffer.from(noise))
  first.destroy()
  terminal.commands.length = 0
  await draw(renderer, noise, 64, true)
  expect(renderer.kittyImageTransportStatus.effective).toBe("png")
  expect(terminal.uploads()[0].fields.f).toBe("100")
  expect(terminal.uploads()[0].fields.o).toBeUndefined()
  expect(terminal.imageBytes().subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
})

test("changing Kitty transport retransmits an unchanged image without replacing its source", async () => {
  const { renderer, terminal } = await setup("raw")
  const pixels = new Uint8Array(64 * 64 * 4).fill(127)
  const view = await draw(renderer, pixels)
  const image = view.image
  for (const mode of ["zlib", "raw"] as const) {
    terminal.commands.length = 0
    renderer.kittyImageTransport = mode
    await renderer.idle()
    expect(renderer.kittyImageTransportStatus).toMatchObject({ requested: mode, effective: mode })
    expect(view.image).toBe(image)
    if (mode === "zlib") expect(terminal.uploads()[0].fields.o).toBe("z")
    else expect(terminal.uploads()[0].fields.o).toBeUndefined()
    expect(mode === "zlib" ? inflateSync(terminal.imageBytes()) : terminal.imageBytes()).toEqual(Buffer.from(pixels))
  }
  terminal.commands.length = 0
  renderer.kittyImageTransport = "raw"
  await renderer.idle()
  expect(terminal.uploads()).toHaveLength(0)
  expect(() => (renderer.kittyImageTransport = "invalid" as KittyImageTransport)).toThrow("Invalid kittyImageTransport")
  expect(renderer.kittyImageTransport).toBe("raw")
})

fileTest("runtime file negotiation retransmits an unchanged provisional inline image when ready", async () => {
  const { renderer, terminal } = await setup("raw")
  const pixels = new Uint8Array([1, 2, 3, 4])
  await draw(renderer, pixels, 1)
  terminal.probeReplies = "query-only"
  renderer.kittyImageTransport = "file"
  await renderer.idle()
  expect(renderer.kittyImageTransportStatus.fileState).toBe("probing")
  expect(terminal.uploads().at(-1)!.fields.t).toBeUndefined()
  const probe = terminal.uploads().find(({ payload }) => payload.toString() === terminal.probePath)!
  terminal.commands.length = 0
  terminal.reply(probe.fields.i)
  await renderer.idle()
  expect(renderer.kittyImageTransportStatus.effective).toBe("file")
  expect(terminal.uploads()).toHaveLength(1)
  expect(readFileSync(terminal.uploads()[0].payload.toString())).toEqual(Buffer.from(pixels))
})

fileTest("a file transport selected while suspended consumes synchronous probe replies on resume", async () => {
  const { renderer, terminal } = await setup("raw")
  await draw(renderer, new Uint8Array([1, 2, 3, 4]), 1)
  renderer.suspend()
  renderer.kittyImageTransport = "file"
  expect(terminal.probePath).toBe("")
  renderer.resume()
  await renderer.idle()
  expect(renderer.kittyImageTransportStatus).toMatchObject({
    requested: "file",
    effective: "file",
    fileState: "ready",
  })
})

fileTest("Kitty file integration keeps bytes alive across frames and consumes only matching ACKs", async () => {
  const { renderer, terminal } = await setup("file")
  expect(renderer.kittyImageTransportStatus.fileState).toBe("ready")
  expect(renderer.kittyImageTransportStatus.pendingFiles).toBe(0)
  await draw(renderer, new Uint8Array([1, 2, 3, 255]), 1)
  const upload = terminal.uploads()[0]
  const path = upload.payload.toString()
  expect(upload.fields.t).toBe("f")
  expect(readFileSync(path)).toEqual(Buffer.from([1, 2, 3]))
  expect(statSync(path).mode & 0o777).toBe(0o600)
  renderer.kittyImageTransport = "raw"
  await renderer.idle()
  renderer.kittyImageTransport = "file"
  await renderer.idle()
  expect(renderer.kittyImageTransportStatus.fallback).toBe("busy")
  renderer.kittyImageTransport = "raw"
  await renderer.idle()
  terminal.stdin.emit("data", Buffer.from("\x1b[0n\x1b[1;1R"))
  terminal.reply("31337")
  expect(existsSync(path)).toBe(true)
  expect(renderer.kittyImageTransportStatus.pendingFiles).toBe(1)
  renderer.removeInputHandler(renderer["capabilityHandler"])
  terminal.reply(upload.fields.i)
  expect(existsSync(path)).toBe(false)
  expect(renderer.kittyImageTransportStatus.pendingFiles).toBe(0)
})

fileTest("Kitty file probes use runtime TMPDIR set before renderer creation and clean up there", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opentui-kitty-env-"))
  let renderer: CliRenderer | undefined
  try {
    process.env.TMPDIR = directory
    const fixture = await setup("file", { probe: "query-only" })
    renderer = fixture.renderer
    const path = fixture.terminal.probePath
    expect(dirname(path)).toBe(directory)
    expect(readFileSync(path)).toEqual(Buffer.from([0, 0, 0]))
    expect(renderer.kittyImageTransportStatus.pendingFiles).toBe(1)
    renderer.destroy()
    expect(readdirSync(directory)).toEqual([])
  } finally {
    renderer?.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
})

fileTest("Kitty file preserves PNG and never overwrites a pending same-ID file", async () => {
  const { renderer, terminal } = await setup("file")
  const pixels = new Uint8Array([1, 2, 3, 255])
  const previous = await draw(renderer, pixels, 1, true)
  const first = terminal.uploads()[0]
  expect(first.fields.f).toBe("100")
  expect(readFileSync(first.payload.toString()).subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  // Preserve this upload until ACK even if later frames replace the same image ID.
  previous.destroy()
  terminal.commands.length = 0
  await draw(renderer, new Uint8Array([9, 8, 7, 6]), 1)
  expect(terminal.uploads()[0].fields.t).toBeUndefined()
  expect(renderer.kittyImageTransportStatus.fallback).toBe("busy")
  expect(renderer.kittyImageTransportStatus.pendingFiles).toBe(1)
  terminal.reply(first.fields.i)
  expect(existsSync(first.payload.toString())).toBe(false)
})

for (const synchronous of [false, true]) {
  fileTest(`Kitty file errors retry raw and remove the lease with synchronous reply=${synchronous}`, async () => {
    const { renderer, terminal } = await setup("file")
    terminal.rejectUploads = synchronous
    await draw(renderer, new Uint8Array([1, 2, 3, 4]), 1)
    const upload = terminal.uploads()[0]
    if (!synchronous) {
      terminal.reply(upload.fields.i, "ENOENT:disappeared")
      await renderer.idle()
    }
    expect(renderer.kittyImageTransportStatus.fileState).toBe("unsupported")
    expect(renderer.kittyImageTransportStatus.pendingFiles).toBe(0)
    const uploads = terminal.uploads()
    expect(uploads).toHaveLength(2)
    expect(upload.fields.t).toBe("f")
    expect(uploads[1].fields.t).toBeUndefined()
    expect(uploads[1].payload).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(existsSync(upload.payload.toString())).toBe(false)
  })
}

;(process.platform === "win32" ? test : test.skip)(
  "Kitty file falls back on Windows without probing or creating leases",
  async () => {
    const { renderer, terminal } = await setup("file")
    expect(terminal.probePath).toBe("")
    expect(renderer.kittyImageTransportStatus).toMatchObject({
      fileState: "unsupported",
      pendingFiles: 0,
      pendingBytes: 0,
    })
    await draw(renderer, new Uint8Array([1, 2, 3, 4]), 1)
    expect(terminal.uploads()[0].fields.t).toBeUndefined()
    expect(terminal.imageBytes()).toEqual(Buffer.from([1, 2, 3, 4]))
  },
)

for (const reason of ["remote", "reject", "query-only"] as const) {
  test(`Kitty file falls back for ${reason}`, async () => {
    const { renderer, terminal } = await setup("file", reason === "remote" ? { remote: true } : { probe: reason })
    expect(renderer.kittyImageTransportStatus.fileState).toBe(
      reason === "query-only" && process.platform !== "win32" ? "probing" : "unsupported",
    )
    await draw(renderer, new Uint8Array([1, 2, 3, 4]), 1)
    expect(terminal.uploads()[0].fields.t).toBeUndefined()
    expect(renderer.kittyImageTransportStatus.effective).toBe("raw")
  })
}

for (const action of ["cancel", "error", "suspend", "destroy"] as const) {
  fileTest(`Kitty file ${action} unlinks pending uploads`, async () => {
    const { renderer, terminal } = await setup("file")
    await draw(renderer, new Uint8Array([1, 2, 3, 4]), 1)
    const path = terminal.uploads()[0].payload.toString()
    if (action === "error") {
      renderer.kittyImageTransport = "raw"
      await renderer.idle()
    }
    expect(existsSync(path)).toBe(true)
    if (action === "cancel") renderer.cancelKittyImageTransport()
    if (action === "error") terminal.emit("error", new Error("synthetic sink failure"))
    if (action === "suspend") renderer.suspend()
    if (action === "destroy") renderer.destroy()
    expect(existsSync(path)).toBe(false)
    if (action !== "destroy") {
      expect(renderer.kittyImageTransportStatus.pendingFiles).toBe(0)
      const state = renderer.kittyImageTransportStatus.fileState
      renderer.kittyImageTransport = "raw"
      renderer.kittyImageTransport = "file"
      if (action === "suspend") renderer.resume()
      await renderer.idle()
      expect(renderer.kittyImageTransportStatus.fileState).toBe(state)
    }
  })
}
