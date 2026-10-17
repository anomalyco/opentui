import { expect, test } from "bun:test"

import { createTestRenderer } from "../test-renderer.js"
import { replayTestSession, TestSessionRecorder } from "../test-session-recorder.js"
import { mountTestSessionRecorderDemoApp } from "./test-session-recorder-demo-app.js"

test("records and replays the minimal session recorder demo app", async () => {
  const source = await createTestRenderer({ width: 32, height: 8 })
  const sourceApp = mountTestSessionRecorderDemoApp(source.renderer)
  const recorder = new TestSessionRecorder(source, {
    metadata: { name: "minimal recorder demo" },
    recordFrames: false,
  })

  try {
    await source.renderOnce()

    recorder.start()
    await source.mockInput.typeText("abc")
    await recorder.flush()
    source.mockInput.pressBackspace()
    await recorder.flush()
    source.mockInput.pressEnter()
    await recorder.flush()
    recorder.checkpoint("submitted ab")
    recorder.stop()

    expect(sourceApp.getValue()).toBe("ab")
    expect(recorder.session.steps.map((step) => step.type)).toEqual([
      "stdin",
      "stdin",
      "stdin",
      "wait",
      "stdin",
      "wait",
      "stdin",
      "wait",
      "checkpoint",
    ])
  } finally {
    if (recorder.isRecording) {
      recorder.stop()
    }
    sourceApp.destroy()
    source.renderer.destroy()
  }

  const target = await createTestRenderer({ width: 32, height: 8 })
  const targetApp = mountTestSessionRecorderDemoApp(target.renderer)

  try {
    await target.renderOnce()
    const replay = await replayTestSession(recorder.session, target, { assertCheckpoints: true })

    expect(targetApp.getValue()).toBe("ab")
    expect(replay.checkedCheckpoints).toBe(1)
    expect(target.captureCharFrame()).toBe(recorder.session.finalFrame)
  } finally {
    targetApp.destroy()
    target.renderer.destroy()
  }
})
