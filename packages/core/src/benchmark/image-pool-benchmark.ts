import { NativeImage, NativeImagePool } from "../image.js"

// No renderer, terminal output, or GPU work runs inside the timed batches.
const results = []
for (const [width, height] of [
  [256, 256],
  [1280, 720],
  [1920, 1080],
]) {
  const pixels = new Uint8Array(width * height * 4).fill(255)
  const pool = new NativeImagePool({ width, height, capacity: 1 })
  const iterations = Math.max(100, Math.floor((64 * 1024 * 1024) / pixels.byteLength))
  const samples: Record<string, number[]> = { fresh: [], pooled: [] }
  const operations = {
    fresh: () => NativeImage.fromRgba(pixels, width, height),
    pooled: () => {
      const frame = pool.publishRgba(pixels)
      if (!frame) throw new Error("benchmark leaked a frame")
      return frame
    },
  }
  try {
    for (const operation of Object.values(operations)) {
      for (let index = 0; index < 50; index++) operation().dispose()
    }
    for (let round = 0; round < 11; round++) {
      const order = round % 2 === 0 ? (["fresh", "pooled"] as const) : (["pooled", "fresh"] as const)
      for (const mode of order) {
        const operation = operations[mode]
        const start = performance.now()
        for (let index = 0; index < iterations; index++) {
          pixels[0] = index & 255
          operation().dispose()
        }
        samples[mode].push(((performance.now() - start) * 1000) / iterations)
      }
    }
    const frame = operations.pooled()
    try {
      if (frame.raw().data[0] !== pixels[0]) throw new Error("stale benchmark frame")
    } finally {
      frame.dispose()
    }
    const fresh = samples.fresh.sort((a, b) => a - b)[5]
    const pooled = samples.pooled.sort((a, b) => a - b)[5]
    results.push({ width, height, iterations, freshMedianUs: fresh, pooledMedianUs: pooled, speedup: fresh / pooled })
  } finally {
    pool.dispose()
  }
}
console.log(JSON.stringify({ runtime: process.versions, rounds: 11, results }, null, 2))
