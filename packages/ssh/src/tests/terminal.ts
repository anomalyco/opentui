import { EmbeddedTerminalRenderable, type RGBA } from "@opentui/core"
import { createTestRenderer, ManualClock } from "@opentui/core/testing"
import type { ClientChannel } from "ssh2"
import { sleep } from "./support.js"

export async function createTerminal(stream: ClientChannel, width: number, height: number) {
  const target = await createTestRenderer({ width, height, clock: new ManualClock() })
  const terminal = new EmbeddedTerminalRenderable(target.renderer, {
    cols: width,
    rows: height,
    width: "100%",
    height: "100%",
  })
  target.renderer.root.add(terminal)
  const receive = (bytes: Buffer) => terminal.write(bytes)
  stream.on("data", receive)
  return {
    async resize(cols: number, rows: number) {
      target.resize(cols, rows)
      await target.renderOnce()
    },
    async contains(text: string, fg?: RGBA) {
      let screen = ""
      for (let turn = 0; turn < 200; turn++) {
        await target.renderOnce()
        screen = target.captureCharFrame()
        if (
          screen.includes(text) &&
          (!fg ||
            target
              .captureSpans()
              .lines.some(({ spans }) => spans.some((span) => span.text.includes(text) && span.fg.equals(fg))))
        )
          return
        await sleep(25)
      }
      throw new Error(`SSH screen did not contain ${JSON.stringify(text)}:\n${screen}`)
    },
    async destroy() {
      stream.off("data", receive)
      target.renderer.destroy()
      await target.renderer.closed
    },
  }
}
