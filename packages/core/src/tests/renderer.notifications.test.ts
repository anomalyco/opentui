import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "../testing/test-renderer.js"

describe("renderer notifications", () => {
  test("triggerNotification returns false until notification capability is detected", async () => {
    const { renderer } = await createTestRenderer({ remote: true, forwardEnvKeys: [] })
    await renderer.setupTerminal()

    expect(renderer.triggerNotification("Build finished")).toBe(false)

    renderer.destroy()
  })

  test("triggerNotification returns true after OSC99 notification support is detected", async () => {
    const { renderer } = await createTestRenderer({ remote: true, forwardEnvKeys: [] })
    await renderer.setupTerminal()

    renderer.stdin.emit("data", Buffer.from("\x1b]99;i=opentui-notifications:p=?;p=title,body:o=always\x1b\\"))

    expect(renderer.capabilities?.notifications).toBe(true)
    expect(renderer.triggerNotification("Build finished", "OpenTUI")).toBe(true)

    renderer.destroy()
  })
})
