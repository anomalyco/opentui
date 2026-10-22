import { isWorkerRuntime, postWorkerMessage, Worker } from "../platform/worker.js"
import Yoga, { type Node } from "../yoga.js"

const workerCount = 4
const iterations = 50_000

if (isWorkerRuntime) {
  // Every Worker loads its own library, but they share the process default config.
  const live: Node[] = []
  for (let index = 0; index < iterations; index++) {
    live.push(Yoga.Node.createForOpenTUI())
    if (live.length > 8) live.splice((index * 7) % live.length, 1)[0]!.free()
  }
  for (const node of live) node.free()
  postWorkerMessage("done")
} else {
  const workers = Array.from({ length: workerCount }, () => new Worker(new URL(import.meta.url)))
  try {
    await Promise.all(
      workers.map(
        (worker) =>
          new Promise<void>((resolve, reject) => {
            worker.onmessage = () => resolve()
            worker.onerror = (event) => reject(event.error ?? new Error(event.message))
          }),
      ),
    )
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()))
  }

  // Claiming the shared config's callbacks walks every node of that config.
  const node = Yoga.Node.createForOpenTUI()
  node.setMeasureFunc(() => ({ width: 3, height: 1 }))
  node.calculateLayout()
  const width = node.getComputedWidth()
  node.free()
  console.log(`default config survived: ${width}`)
}
