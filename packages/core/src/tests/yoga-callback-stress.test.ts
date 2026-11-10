import { describe, expect, test } from "bun:test"
import Yoga, { Align, Direction, FlexDirection } from "../yoga.js"
import type { Node as YogaNode } from "../yoga.js"

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function maybeCollectGarbage(): void {
  const bun = (globalThis as { Bun?: { gc?: (force?: boolean) => void } }).Bun
  bun?.gc?.(false)
}

describe("native Yoga callback routing stress", () => {
  test("routes many measured nodes through the shared callback under layout churn", () => {
    const nodeCount = readPositiveIntegerEnv("OTUI_YOGA_CALLBACK_STRESS_NODES", 192)
    const iterations = readPositiveIntegerEnv("OTUI_YOGA_CALLBACK_STRESS_ITERATIONS", 64)

    const root = Yoga.Node.createForOpenTUI()
    const nodes: YogaNode[] = []
    const calls = new Uint32Array(nodeCount)
    const lastWidthMode = new Uint32Array(nodeCount)
    const lastHeightMode = new Uint32Array(nodeCount)

    root.setWidth(120)
    root.setFlexDirection(FlexDirection.Column)
    root.setAlignItems(Align.FlexStart)

    for (let index = 0; index < nodeCount; index++) {
      const node = Yoga.Node.createForOpenTUI()
      const width = 1 + (index % 17)
      const height = 1 + (index % 5)

      node.setMeasureFunc((_width, widthMode, _height, heightMode) => {
        calls[index]++
        lastWidthMode[index] = widthMode
        lastHeightMode[index] = heightMode
        return { width, height }
      })

      nodes.push(node)
      root.insertChild(node, index)
    }

    try {
      for (let iteration = 0; iteration < iterations; iteration++) {
        for (const node of nodes) node.markDirty()
        root.calculateLayout(120, undefined, Direction.LTR)

        if (iteration % 16 === 0) maybeCollectGarbage()
      }

      let totalCalls = 0
      for (let index = 0; index < nodeCount; index++) {
        totalCalls += calls[index]!
        expect(calls[index]!).toBeGreaterThan(0)
        expect(lastWidthMode[index]!).toBeGreaterThan(0)
        expect(lastHeightMode[index]!).toBeGreaterThanOrEqual(0)
      }

      expect(totalCalls).toBeGreaterThanOrEqual(nodeCount * iterations)

      const first = nodes[0]!
      const last = nodes[nodeCount - 1]!
      expect(first.getComputedWidth()).toBe(1)
      expect(first.getComputedHeight()).toBe(1)
      expect(last.getComputedWidth()).toBe(1 + ((nodeCount - 1) % 17))
      expect(last.getComputedHeight()).toBe(1 + ((nodeCount - 1) % 5))
    } finally {
      root.freeRecursive()
    }
  })

  test("routes dirtied notifications per node through the shared callback", () => {
    const nodeCount = 16
    const root = Yoga.Node.createForOpenTUI()
    const nodes: YogaNode[] = []
    const dirtiedCounts = new Uint32Array(nodeCount)
    let identityMismatch = false

    root.setWidth(60)
    root.setFlexDirection(FlexDirection.Column)
    root.setAlignItems(Align.FlexStart)

    for (let index = 0; index < nodeCount; index++) {
      const node = Yoga.Node.createForOpenTUI()
      node.setMeasureFunc(() => ({ width: 1 + (index % 3), height: 1 }))
      node.setDirtiedFunc((dirtiedNode) => {
        dirtiedCounts[index]++
        if (dirtiedNode !== node) identityMismatch = true
      })
      root.insertChild(node, index)
      nodes.push(node)
    }

    try {
      // Dirtied fires on the clean -> dirty transition, so layout first.
      root.calculateLayout(60, undefined, Direction.LTR)
      for (const node of nodes) node.markDirty()

      for (let index = 0; index < nodeCount; index++) {
        expect(dirtiedCounts[index]!).toBe(1)
      }

      root.calculateLayout(60, undefined, Direction.LTR)
      nodes[0]!.unsetDirtiedFunc()
      for (const node of nodes) node.markDirty()

      expect(dirtiedCounts[0]!).toBe(1)
      for (let index = 1; index < nodeCount; index++) {
        expect(dirtiedCounts[index]!).toBe(2)
      }
      expect(identityMismatch).toBe(false)
    } finally {
      root.freeRecursive()
    }
  })
})
