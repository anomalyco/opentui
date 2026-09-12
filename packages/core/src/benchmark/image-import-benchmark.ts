#!/usr/bin/env bun

import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { NativeImage, NativeImagePool, type PixelImportOptions } from "../image.js"

const quick = process.argv.includes("--quick")
const iterations = quick ? 10 : 100
const warmup = quick ? 10 : 50
const samples = quick ? 3 : 7
const results = []

for (const [width, height] of [
  [320, 180],
  [641, 360],
  [1280, 720],
]) {
  const stride = Math.ceil((width * 4) / 256) * 256
  const pixels = new Uint8Array(stride * (height - 1) + width * 4 + 3).subarray(3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * stride + x * 4
      pixels.set([(x * 13 + y) & 255, (y * 7) & 255, (x * 3) & 255, (x + y) & 255], offset)
    }
  }

  for (const format of ["rgba8", "bgra8"] as const) {
    for (const alpha of ["straight", "opaque"] as const) {
      const options: PixelImportOptions = { stride, format, alpha }
      const rgba = new Uint8Array(width * height * 4)
      // Reuse staging storage, as a readback loop would. Neither path measures GPU work.
      const stage = () => {
        for (let y = 0; y < height; y++) {
          if (format === "rgba8" && alpha === "straight") {
            rgba.set(pixels.subarray(y * stride, y * stride + width * 4), y * width * 4)
            continue
          }
          for (let x = 0; x < width; x++) {
            const src = y * stride + x * 4
            const dst = (y * width + x) * 4
            rgba[dst] = pixels[src + (format === "bgra8" ? 2 : 0)]
            rgba[dst + 1] = pixels[src + 1]
            rgba[dst + 2] = pixels[src + (format === "bgra8" ? 0 : 2)]
            rgba[dst + 3] = alpha === "opaque" ? 255 : pixels[src + 3]
          }
        }
        return rgba
      }
      const baseline = () => NativeImage.fromRgba(stage(), width, height)
      const native = () => NativeImage.fromPixels(pixels, width, height, options)
      const stagingPool = new NativeImagePool({ width, height, capacity: 1 })
      const nativePool = new NativeImagePool({ width, height, capacity: 1 })
      const operations = [
        baseline,
        native,
        () => stagingPool.publishRgba(stage())!,
        () => nativePool.publishPixels(pixels, options)!,
      ]
      try {
        const expected = baseline()
        try {
          for (const operation of operations) {
            const actual = operation()
            try {
              assert.deepEqual(actual.raw(), expected.raw())
              assert.deepEqual(actual.info(), expected.info())
            } finally {
              actual.dispose()
            }
          }
        } finally {
          expected.dispose()
        }

        for (let i = 0; i < warmup; i++) {
          for (const operation of operations) operation().dispose()
        }
        const timings = operations.map(() => [] as number[])
        for (let sample = 0; sample < samples; sample++) {
          for (let index = 0; index < operations.length; index++) {
            const mode = (index + sample) % operations.length
            const start = performance.now()
            for (let i = 0; i < iterations; i++) operations[mode]().dispose()
            timings[mode].push((performance.now() - start) / iterations)
          }
        }
        const [baselineMs, nativeMs, stagedPoolMs, nativePoolMs] = timings.map(
          (values) => values.sort((a, b) => a - b)[Math.floor(samples / 2)],
        )
        results.push({
          width,
          height,
          stride,
          format,
          alpha,
          baselineMs,
          nativeMs,
          stagedPoolMs,
          nativePoolMs,
          speedup: baselineMs / nativeMs,
          reuseSpeedup: nativeMs / nativePoolMs,
          fusedPoolSpeedup: stagedPoolMs / nativePoolMs,
        })
      } finally {
        stagingPool.dispose()
        nativePool.dispose()
      }
    }
  }
}

const runtime = process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`
console.log(JSON.stringify({ runtime, iterations, warmup, samples, results }, null, 2))
