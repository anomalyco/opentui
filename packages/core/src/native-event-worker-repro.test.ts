import { describe, expect, test } from "bun:test"
import { EditBuffer } from "./edit-buffer.js"

function waitForWorker(worker: Worker) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  return new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("worker did not complete")), 5_000)
    worker.addEventListener("message", () => resolve(), { once: true })
    worker.addEventListener(
      "error",
      (event) => {
        reject(event.error ?? new Error(event.message))
      },
      { once: true },
    )
  }).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

describe("native event worker callback repro", () => {
  test("keeps native event callback valid after a worker installs and releases its callback", async () => {
    const first = EditBuffer.create("unicode")
    first.on("content-changed", () => {})
    first.setText("main-before-worker")
    await Bun.sleep(0)

    const worker = new Worker(new URL("./native-event-worker-repro.worker.ts", import.meta.url), {
      type: "module",
    })
    await waitForWorker(worker)
    await worker.terminate()

    let delivered = 0
    const second = EditBuffer.create("unicode")
    second.on("content-changed", () => {
      delivered++
    })

    second.setText("main-after-worker")
    await Bun.sleep(0)

    second.destroy()
    first.destroy()

    expect(delivered).toBe(1)
  })
})
