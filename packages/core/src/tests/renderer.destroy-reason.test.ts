import { afterEach, test } from "bun:test"
import assert from "node:assert/strict"
import type { DestroyReason } from "../renderer.js"
import { createTestRenderer, type TestRendererSetup } from "../testing/test-renderer.js"
import { TestWriteStream } from "../testing/test-streams.js"

const targets: TestRendererSetup[] = []
afterEach(async () => {
  for (const { renderer } of targets.splice(0)) {
    renderer.destroy()
    await renderer.closed.catch(() => {})
  }
})

async function setup(options: Parameters<typeof createTestRenderer>[0] = {}) {
  const reasons: (DestroyReason | undefined)[] = []
  const target = await createTestRenderer({
    exitSignals: [],
    ...options,
    onDestroy: (reason) => reasons.push(reason),
  })
  targets.push(target)
  return { ...target, reasons }
}

test("destroy() reports a destroy reason", async () => {
  const { renderer, reasons } = await setup()
  renderer.destroy()
  await renderer.closed
  assert.deepEqual(reasons, [{ type: "destroy" }])
  assert.deepEqual(renderer.destroyReason, { type: "destroy" })
})

test("Ctrl+C reports a ctrl-c reason", async () => {
  const { renderer, mockInput, reasons } = await setup()
  mockInput.pressCtrlC()
  await renderer.closed
  assert.deepEqual(reasons, [{ type: "ctrl-c" }])
})

test("an exit signal reports the signal name", async () => {
  const { renderer, reasons } = await setup({ exitSignals: ["SIGUSR2"] })
  process.emit("SIGUSR2", "SIGUSR2")
  await renderer.closed
  assert.deepEqual(reasons, [{ type: "signal", signal: "SIGUSR2" }])
})

test("the process exit handler reports a process-exit reason", async () => {
  const { renderer, reasons } = await setup()
  ;(renderer as unknown as { nativeProcessExitHandler: () => void }).nativeProcessExitHandler()
  await renderer.closed.catch(() => {})
  assert.deepEqual(reasons, [{ type: "process-exit" }])
})

test("an output failure seen by the frame path reports the Session error", async () => {
  const stdout = new TestWriteStream(8, 3)
  const { renderer, renderOnce, reasons } = await setup({
    stdout: stdout as unknown as NodeJS.WriteStream,
    bufferedOutput: "stdout",
  })
  const failure = new Error("output failed")
  stdout.on("error", () => {})
  stdout.emit("error", failure)
  // The frame path observes the failed Session before `closed` rejects.
  await renderOnce()
  await renderer.closed.catch(() => {})
  assert.equal(reasons.length, 1)
  assert.equal(reasons[0]?.type, "output-closed")
  assert.equal((reasons[0] as { error?: unknown }).error, failure)
})
