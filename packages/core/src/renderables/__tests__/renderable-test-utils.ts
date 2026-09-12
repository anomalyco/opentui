import { TextareaRenderable } from "../Textarea.js"
import { type TestRenderer } from "../../testing/test-renderer.js"
import { type TextareaOptions } from "../Textarea.js"
import type { DiffRenderable } from "../Diff.js"
import type { MockTreeSitterClient } from "../../testing/mock-tree-sitter-client.js"
import type { ManualClock } from "../../testing/manual-clock.js"

export async function createTextareaRenderable(
  renderer: TestRenderer,
  renderOnce: () => Promise<void>,
  options: TextareaOptions,
): Promise<{ textarea: TextareaRenderable; root: any }> {
  const textareaRenderable = new TextareaRenderable(renderer, { left: 0, top: 0, ...options })
  renderer.root.add(textareaRenderable)
  await renderOnce()

  return { textarea: textareaRenderable, root: renderer.root }
}

// Render twice to flush Diff rebuilds, then drain each serialized highlight batch.
export async function settleDiffHighlighting(
  diff: DiffRenderable,
  client: MockTreeSitterClient,
  render: () => Promise<void>,
) {
  const MAX = 15
  for (let i = 0; i < MAX; i++) {
    await render()
    await render()
    if (!client.isHighlighting()) break
    client.resolveAllHighlightOnce()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

// Simulate the passage of time by advancing a ManualClock and rendering frames.
// Useful for testing animations, scroll momentum, and other time-dependent behavior.
export async function simulateFrames(
  clock: ManualClock,
  renderOnce: () => Promise<void>,
  ms: number,
  frameInterval: number = 50,
): Promise<void> {
  const frames = Math.ceil(ms / frameInterval)
  for (let i = 0; i < frames; i++) {
    clock.advance(frameInterval)
    await renderOnce()
  }
}
