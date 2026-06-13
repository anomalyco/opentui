import { expect, test } from "bun:test"

import { Worker } from "./worker.js"

test("Node worker retains messages posted while its module is loading", async () => {
  const worker = new Worker(new URL("./worker-startup.fixture.js", import.meta.url))
  const received: number[] = []

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Worker startup test timed out")), 2_000)

      worker.onerror = (event) => {
        clearTimeout(timeout)
        reject(event.error ?? new Error(event.message))
      }
      worker.onmessage = (event) => {
        const message = event.data as { type: string; value?: number }
        if (message.type === "IMPORT_STARTED") {
          worker.postMessage(1)
          worker.postMessage(2)
          worker.postMessage(3)
          return
        }

        if (message.type === "RECEIVED") {
          received.push(message.value!)
          if (received.length === 3) {
            clearTimeout(timeout)
            resolve()
          }
        }
      }
    })

    expect(received).toEqual([1, 2, 3])
  } finally {
    await worker.terminate()
  }
})

test("Node worker delivers startup messages to a web-style handler during module evaluation", async () => {
  const worker = new Worker(new URL("./worker-onmessage-startup.fixture.js", import.meta.url))

  try {
    const value = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Web-style worker startup test timed out")), 2_000)

      worker.onerror = (event) => {
        clearTimeout(timeout)
        reject(event.error ?? new Error(event.message))
      }
      worker.onmessage = (event) => {
        const message = event.data as { type: string; value?: number }
        if (message.type === "WAITING_FOR_MESSAGE") {
          worker.postMessage(42)
          return
        }

        if (message.type === "RECEIVED") {
          clearTimeout(timeout)
          resolve(message.value!)
        }
      }
    })

    expect(value).toBe(42)
  } finally {
    await worker.terminate()
  }
})

test("Node worker does not restore a disposed message handler", async () => {
  const worker = new Worker(new URL("./worker-handler-cleanup.fixture.js", import.meta.url))

  try {
    const handlerCleared = await new Promise<boolean>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Worker handler cleanup test timed out")), 2_000)

      worker.onerror = (event) => {
        clearTimeout(timeout)
        reject(event.error ?? new Error(event.message))
      }
      worker.onmessage = (event) => {
        const message = event.data as { type: string; handlerCleared?: boolean }
        if (message.type === "HANDLERS_CLEANED") {
          clearTimeout(timeout)
          resolve(message.handlerCleared!)
        }
      }
    })

    expect(handlerCleared).toBe(true)
  } finally {
    await worker.terminate()
  }
})

test("Node worker restores transport listeners when termination fails", async () => {
  const worker = new Worker(new URL("./worker-startup.fixture.js", import.meta.url))
  const nativeWorker = (
    worker as unknown as {
      worker: {
        listenerCount: (event: "message" | "error") => number
        terminate: () => Promise<number>
      }
    }
  ).worker
  const originalTerminate = nativeWorker.terminate.bind(nativeWorker)
  nativeWorker.terminate = async () => {
    throw new Error("synthetic termination failure")
  }

  try {
    await expect(worker.terminate()).rejects.toThrow("synthetic termination failure")
    expect(nativeWorker.listenerCount("message")).toBe(1)
    expect(nativeWorker.listenerCount("error")).toBe(1)
  } finally {
    nativeWorker.terminate = originalTerminate
    await worker.terminate()
  }
})

test("Node worker shares concurrent termination attempts", async () => {
  const worker = new Worker(new URL("./worker-startup.fixture.js", import.meta.url))
  const nativeWorker = (
    worker as unknown as {
      worker: {
        listenerCount: (event: "message" | "error") => number
        terminate: () => Promise<number>
      }
    }
  ).worker
  const originalTerminate = nativeWorker.terminate.bind(nativeWorker)
  let terminationCount = 0
  nativeWorker.terminate = async () => {
    terminationCount++
    throw new Error("synthetic concurrent termination failure")
  }

  try {
    const first = worker.terminate()
    const second = worker.terminate()
    expect(first).toBe(second)
    await expect(first).rejects.toThrow("synthetic concurrent termination failure")
    expect(terminationCount).toBe(1)
    expect(nativeWorker.listenerCount("message")).toBe(1)
    expect(nativeWorker.listenerCount("error")).toBe(1)
  } finally {
    nativeWorker.terminate = originalTerminate
    await worker.terminate()
  }
})
