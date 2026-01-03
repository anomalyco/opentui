#!/usr/bin/env bun

/**
 * Benchmark for TextBufferRenderable measure cache optimization.
 *
 * This benchmark measures the performance improvement from caching measure results
 * when Yoga calls measureFunc multiple times with different widths during layout.
 *
 * Run with: bun packages/core/src/benchmark/measure-cache-benchmark.ts
 */

import { createTestRenderer } from "../testing/test-renderer"
import { TextRenderable } from "../renderables/Text"
import { BoxRenderable } from "../renderables/Box"

const ITERATIONS = 100
const CONTENT_CHANGES = 100
const GRID_ROWS = 8
const GRID_COLS = 6

async function runBenchmark() {
  console.log("=== Measure Cache Benchmark ===")
  console.log(`Grid: ${GRID_ROWS}x${GRID_COLS} = ${GRID_ROWS * GRID_COLS} text boxes`)
  console.log(`Iterations: ${ITERATIONS}, Content changes: ${CONTENT_CHANGES}\n`)

  const { renderer, renderOnce } = await createTestRenderer({
    width: 200,
    height: 100,
  })

  // Create a grid container
  const container = new BoxRenderable(renderer, {
    id: "container",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    flexWrap: "wrap",
  })
  renderer.root.add(container)

  // Create a grid of boxes, each containing text with wrapping
  const texts: TextRenderable[] = []
  for (let row = 0; row < GRID_ROWS; row++) {
    const rowBox = new BoxRenderable(renderer, {
      id: `row-${row}`,
      width: "100%",
      flexDirection: "row",
      flexWrap: "wrap",
    })
    container.add(rowBox)

    for (let col = 0; col < GRID_COLS; col++) {
      const cellBox = new BoxRenderable(renderer, {
        id: `cell-${row}-${col}`,
        width: `${Math.floor(100 / GRID_COLS)}%`,
        padding: 1,
        flexDirection: "column",
      })
      rowBox.add(cellBox)

      // Add multiple text elements per cell
      for (let t = 0; t < 3; t++) {
        const text = new TextRenderable(renderer, {
          id: `text-${row}-${col}-${t}`,
          content: generateLongText(row * GRID_COLS * 3 + col * 3 + t),
          wrapMode: "word",
          width: "100%",
        })
        cellBox.add(text)
        texts.push(text)
      }
    }
  }

  console.log(`Total text renderables: ${texts.length}\n`)

  // Warm up
  console.log("Warming up...")
  for (let i = 0; i < 10; i++) {
    await renderOnce()
  }

  // Benchmark 1: Multiple renders without content change (cache should help)
  console.log(`\nBenchmark 1: ${ITERATIONS} renders without content change`)
  console.log("  (Cache should return results immediately)")

  const startNoChange = performance.now()
  for (let i = 0; i < ITERATIONS; i++) {
    await renderOnce()
  }
  const endNoChange = performance.now()
  const timeNoChange = endNoChange - startNoChange

  console.log(`  Total time: ${timeNoChange.toFixed(2)}ms`)
  console.log(`  Average per render: ${(timeNoChange / ITERATIONS).toFixed(2)}ms`)

  // Benchmark 2: Renders with content changes (cache invalidated each time)
  console.log(`\nBenchmark 2: ${CONTENT_CHANGES} renders with content changes`)
  console.log("  (Cache invalidated on each content change)")

  const startWithChange = performance.now()
  for (let i = 0; i < CONTENT_CHANGES; i++) {
    // Change content on all texts (invalidates cache)
    for (let j = 0; j < texts.length; j++) {
      texts[j].content = generateLongText(j + i * 7)
    }
    await renderOnce()
  }
  const endWithChange = performance.now()
  const timeWithChange = endWithChange - startWithChange

  console.log(`  Total time: ${timeWithChange.toFixed(2)}ms`)
  console.log(`  Average per render: ${(timeWithChange / CONTENT_CHANGES).toFixed(2)}ms`)

  // Summary
  console.log("\n=== Summary ===")
  const avgCached = timeNoChange / ITERATIONS
  const avgUncached = timeWithChange / CONTENT_CHANGES
  console.log(`Cached renders (no content change): ${avgCached.toFixed(2)}ms avg`)
  console.log(`Uncached renders (content changes): ${avgUncached.toFixed(2)}ms avg`)

  const speedup = avgUncached / avgCached
  console.log(`\nCache speedup: ${speedup.toFixed(1)}x faster when content unchanged`)

  renderer.destroy()
}

function generateLongText(seed: number): string {
  const words = [
    "Lorem",
    "ipsum",
    "dolor",
    "sit",
    "amet",
    "consectetur",
    "adipiscing",
    "elit",
    "sed",
    "do",
    "eiusmod",
    "tempor",
    "incididunt",
    "ut",
    "labore",
    "et",
    "dolore",
    "magna",
    "aliqua",
    "Ut",
    "enim",
    "ad",
    "minim",
    "veniam",
    "quis",
    "nostrud",
    "exercitation",
    "ullamco",
    "laboris",
  ]

  let text = ""
  const length = 30 + (seed % 20) // Variable length text
  for (let i = 0; i < length; i++) {
    text += words[(i + seed) % words.length] + " "
  }
  return text.trim()
}

runBenchmark().catch(console.error)
