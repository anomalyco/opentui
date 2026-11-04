import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// R12b: a writer thread blocked in write(2) outlives its Session and RenderLib.dispose(); the library stays
// pinned, so the write returns into mapped code and the process exits cleanly.
test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "a blocked stdout writer survives Session cancel and library dispose",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "otui-writer-"))
    const marker = join(dir, "disposed")
    let bytes = 0
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "stdout-writer-unload.fixture.ts"), marker], {
        env: { ...process.env, OTUI_STDOUT_THREAD: "1" },
        terminal: {
          cols: 80,
          rows: 24,
          data(_terminal, data) {
            bytes += data.length
          },
        },
      })
      // XOFF: the pty takes no more output until XON.
      child.terminal!.write("\x13")
      for (let wait = 0; !existsSync(marker) && wait < 500; wait++) await Bun.sleep(10)
      expect(existsSync(marker)).toBe(true)
      child.terminal!.write("\x11")
      expect(await child.exited).toBe(0)
      expect(child.signalCode).toBeNull()
      // The rest of the running copy still reached the terminal.
      expect(bytes).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)
