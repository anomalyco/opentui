// The Rust crate's `bench` example, written against OpenTUI Core's headless test renderer, for comparing the two
// over the same native library.
//
// Run: OPENTUI_ROOT=/path/to/opentui bun scripts/core-bench.ts
// Then: cargo run --release --example bench
const root = process.env.OPENTUI_ROOT
if (!root) throw new Error("Set OPENTUI_ROOT to an OpenTUI checkout.")
// Core loads its npm prebuilt by default. Load the library the Rust crate links, found as test.sh finds it.
const { suffix } = await import("bun:ffi")
const os = { so: "linux", dylib: "macos", dll: "windows" }[suffix]
const arch = process.arch === "arm64" ? "aarch64" : "x86_64"
const lib = process.env.OPENTUI_LIB_DIR ?? `${root}/packages/native/lib/${arch}-${os}`
const { setRenderLibPath } = await import(`${root}/packages/core/src/zig.ts`)
setRenderLibPath(`${lib}/${suffix === "dll" ? "" : "lib"}opentui.${suffix}`)
const { createTestRenderer } = await import(`${root}/packages/core/src/testing/test-renderer.ts`)
const { BoxRenderable, ScrollBoxRenderable, SelectRenderable, TextareaRenderable, TextRenderable } = await import(
  `${root}/packages/core/src/renderables/index.ts`
)

async function time(frames: number, frame: (index: number) => Promise<void> | void): Promise<number> {
  const start = performance.now()
  for (let index = 0; index < frames; index++) await frame(index)
  return (performance.now() - start) / frames
}

function report(name: string, ms: number) {
  console.log(
    `${name.padEnd(44)} ${(ms * 1000).toFixed(1).padStart(8)} µs/frame  ${(1000 / ms).toFixed(0).padStart(7)} fps`,
  )
}

{
  const { renderer, renderOnce } = await createTestRenderer({
    width: 200,
    height: 60,
  })
  const lines = Array.from({ length: 60 }, (_, line) => new TextRenderable(renderer, { content: `line ${line}` }))
  for (const line of lines) renderer.root.add(line)
  await renderOnce()
  report(
    "200x60, 60 text rows, all change",
    await time(300, async (frame) => {
      lines.forEach((line, index) => {
        line.content = `frame ${frame} line ${index} ${"·".repeat((frame + index) % 120)}`
      })
      await renderOnce()
    }),
  )
  report(
    "200x60, 60 text rows, one changes",
    await time(1000, async (frame) => {
      lines[frame % 60].content = `frame ${frame}`
      await renderOnce()
    }),
  )
  renderer.destroy()
}

{
  const { renderer, renderOnce } = await createTestRenderer({
    width: 120,
    height: 40,
  })
  const scroll = new ScrollBoxRenderable(renderer, { flexGrow: 1 })
  for (let row = 0; row < 5000; row++) {
    const box = new BoxRenderable(renderer, { flexDirection: "row", gap: 2 })
    box.add(new TextRenderable(renderer, { content: String(row).padStart(5) }))
    box.add(new TextRenderable(renderer, { content: "a row in a long list" }))
    scroll.add(box)
  }
  renderer.root.add(scroll)
  await renderOnce()
  report(
    "ScrollBox with 5000 rows (15000 nodes), scroll",
    await time(300, async (frame) => {
      scroll.scrollTop = (frame * 7) % 4900
      await renderOnce()
    }),
  )
  renderer.destroy()
}

{
  const { renderer, renderOnce, mockInput } = await createTestRenderer({
    width: 120,
    height: 40,
  })
  const list = new SelectRenderable(renderer, {
    options: Array.from({ length: 10_000 }, (_, index) => ({
      name: `Option ${index}`,
      description: `Description ${index}`,
    })),
    flexGrow: 1,
  })
  renderer.root.add(list)
  list.focus()
  await renderOnce()
  report(
    "Select with 10000 options, move selection",
    await time(1000, async () => {
      mockInput.pressArrow("down")
      await renderOnce()
    }),
  )
  renderer.destroy()
}

{
  const { renderer, renderOnce, mockInput } = await createTestRenderer({
    width: 120,
    height: 40,
  })
  const text = Array.from(
    { length: 2000 },
    (_, line) => `line ${line} of a large document with some words in it\n`,
  ).join("")
  const area = new TextareaRenderable(renderer, {
    initialValue: text,
    flexGrow: 1,
  })
  renderer.root.add(area)
  area.focus()
  await renderOnce()
  report(
    "Textarea with 2000 lines, type a character",
    await time(1000, async () => {
      mockInput.pressKey("x")
      await renderOnce()
    }),
  )
  renderer.destroy()
}
