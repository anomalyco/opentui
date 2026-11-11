import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "../testing/test-renderer.js"
import { RecordingWriteStream } from "../testing/test-streams.js"

describe("renderer notifications", () => {
  test("triggerNotification returns false until notification capability is detected", async () => {
    const { renderer } = await createTestRenderer({ remote: true, forwardEnvKeys: [] })
    await renderer.setupTerminal()

    expect(renderer.triggerNotification("Build finished")).toBe(false)

    renderer.destroy()
  })

  test("triggerNotification writes the detected protocol without controls or OSC 9 subcommands", async () => {
    const osc99 = (type: string, done: number, text: string) =>
      `\x1b]99;i=opentui-1:p=${type}:e=1:d=${done};${btoa(text)}\x1b\\`
    for (const [reply, message, title, expected] of [
      [
        "\x1b]99;i=opentui-notifications:p=?;p=title,body:o=always\x1b\\",
        "Build",
        "OpenTUI",
        osc99("title", 0, "OpenTUI") + osc99("body", 1, "Build"),
      ],
      // U+009C is ST and U+009B is CSI; a leading digit would select ConEmu's progress subcommand.
      ["\x1b]1337;Capabilities=No\x1b\\", "4;1;50\u009c\u009b21t", undefined, "\x1b]9; 4;1;50  21t\x1b\\"],
    ] as const) {
      const stdout = new RecordingWriteStream(8, 3)
      const { renderer } = await createTestRenderer({
        stdout: stdout as never,
        bufferedOutput: "stdout",
        remote: true,
        forwardEnvKeys: [],
      })
      await renderer.setupTerminal()
      renderer.stdin.emit("data", Buffer.from(reply))
      expect(renderer.triggerNotification(message, title)).toBe(true)
      await renderer.nativeScene.driver.idle()
      expect(stdout.text()).toContain(expected)
      renderer.destroy()
    }
  })
})
