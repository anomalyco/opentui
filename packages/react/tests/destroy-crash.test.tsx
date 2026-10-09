import { describe, expect, it, spyOn } from "bun:test"
import type { BoxRenderable } from "@opentui/core"
import React, { useEffect, useRef, useState } from "react"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot } from "../src/reconciler/renderer.js"

/**
 * Regression test for: Native Yoga crash when renderer.destroy() is called
 * with pending React state updates.
 *
 * Bug report: https://gist.github.com/rauchg/b2e1e964f88773a5d08f5f682dce2224
 *
 * Issue: When calling renderer.destroy() while async operations (intervals,
 * promises, etc.) are still updating React state, Yoga crashes with:
 * "Cannot add child: Nodes with measure functions cannot have children."
 * followed by "RuntimeError: Out of bounds memory access"
 *
 * The crash happens because:
 * 1. renderer.destroy() is called (WITHOUT unmounting React first)
 * 2. This calls root.destroyRecursively() which calls yogaNode.free() on all nodes
 * 3. The interval keeps firing setLines() because React wasn't unmounted
 * 4. React tries to re-render, calling appendChild() which calls add()
 * 5. add() calls yogaNode.insertChild() on a freed (parent) yoga node
 * 6. Yoga WASM crashes with out-of-bounds memory access
 *
 * The "Cannot add child: Nodes with measure functions cannot have children"
 * error message is misleading - it's actually a use-after-free crash where
 * the freed yoga node's memory has been reused/corrupted.
 *
 * CRITICAL: The bug only occurs when React is NOT unmounted before/during destroy.
 * In the bug report, there is NO root.unmount() call - just renderer.destroy().
 */

describe("Renderer Destroy Crash with Pending React Updates", () => {
  it("should not crash when renderer is destroyed without unmounting React while interval updates state", async () => {
    // This test reproduces the EXACT scenario from the bug report:
    // - Component has an interval updating state
    // - renderer.destroy() is called WITHOUT calling root.unmount()
    // - The interval continues to fire setLines() AFTER destroy
    // - React tries to re-render on destroyed Yoga nodes -> CRASH

    const testSetup = await createTestRenderer({
      width: 40,
      height: 20,
      // CRITICAL: NO onDestroy callback - React is NOT unmounted
      // This is exactly what happens in the bug report
    })

    const root = createRoot(testSetup.renderer)

    let cleanedUp = false
    function App() {
      const [lines, setLines] = useState<string[]>([])
      const ref = useRef<BoxRenderable>(null)

      useEffect(() => {
        const box = ref.current!
        // Interval keeps firing after destroy() because React isn't unmounted
        const interval = setInterval(() => {
          setLines((prev) => [...prev, `Line ${prev.length + 1}`])
        }, 5)

        return () => {
          clearInterval(interval)
          // React runs this cleanup after renderer.destroy() destroyed the tree: the write must be a no-op.
          box.width = 5
          cleanedUp = true
        }
      }, [])

      return (
        <box ref={ref} flexDirection="column" border borderStyle="single">
          <text bold>OpenTUI Crash Repro</text>
          {lines.slice(-10).map((line, i) => (
            <text key={`line-${i}-${line}`}>{line}</text>
          ))}
        </box>
      )
    }

    root.render(<App />)

    // Let the component mount and interval start
    await testSetup.renderOnce()
    await Bun.sleep(30)
    await testSetup.renderOnce()

    // Destroy WITHOUT unmounting React - this is the bug!
    // The interval will keep firing setLines() after this
    // React will try to add new <text> elements to destroyed Yoga nodes
    testSetup.renderer.destroy()
    using errors = spyOn(console, "error")
    root.render(<App />)

    // Wait for interval to fire more updates after destroy
    // This is when the crash occurs if the bug is present
    await Bun.sleep(100)

    expect(cleanedUp).toBe(true)
    expect(errors).not.toHaveBeenCalled()
  })
})
