import { afterAll, expect, test } from "bun:test"
import { stripVTControlCharacters } from "node:util"
import { CliRenderEvents, destroyTreeSitterClient, type CliRendererErrorEvent } from "@opentui/core"
import { createHarness, waitFor } from "../support.js"
import { createTerminal } from "../terminal.js"

const { mkServer, openShell } = createHarness()
afterAll(destroyTreeSitterClient)

test("SSH streams detached Markdown and highlighted code across resize", async () => {
  const demo = await import(new URL("../../../../examples/src/split-footer-streaming-demo.js", import.meta.url).href)
  const errors: unknown[] = []
  const server = mkServer(
    async ({ renderer }) => {
      renderer.on(CliRenderEvents.RENDER_ERROR, ({ error }: CliRendererErrorEvent) => errors.push(error))
      renderer.once(CliRenderEvents.DESTROY, () => demo.destroy(renderer))
      await demo.run(renderer)
    },
    { onError: (error) => errors.push(error) },
  )
  const { stream } = await openShell(server)
  const terminal = await createTerminal(stream, 80, 24)
  let output = ""
  stream.on("data", (bytes: Buffer) => {
    output += bytes.toString()
  })
  try {
    await terminal.contains("Split Footer Surface Streaming Demo")
    stream.write("]]]")
    await terminal.contains("markdown sample finished")
    expect(stripVTControlCharacters(output)).toContain("Split Footer Markdown Edge Cases")
    stream.write("2")
    await terminal.contains("code sample finished")
    expect(stripVTControlCharacters(output)).toContain("buildSurfaceReport")
    await terminal.resize(100, 36)
    stream.setWindow(36, 100, 0, 0)
    await terminal.contains("Renderer resized")
    await terminal.contains("code sample finished")
    await server.close()
    await waitFor(() => output.includes("\x1b[?2004l"))
    expect(errors).toEqual([])
  } finally {
    await server.close()
    await terminal.destroy()
  }
}, 30_000)
