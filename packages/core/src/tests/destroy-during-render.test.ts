import { test, expect, beforeEach, afterEach } from "bun:test"
import { Renderable, type RenderableOptions } from "../Renderable.js"
import { CliRenderEvents } from "../renderer.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import type { RenderContext } from "../types.js"

// A hook can destroy its own node, a relative, or a whole subtree. The frame finishes, and no hook of a destroyed
// node runs afterward, in the same frame or the next one.

const log: string[] = []
let pending: { actor: string; phase: string; destroy: () => void } | undefined

function hook(node: Renderable, phase: string): void {
  log.push(`${node.id}.${phase}`)
  if (pending?.actor !== node.id || pending.phase !== phase) return
  const { destroy } = pending
  pending = undefined
  destroy()
  log.push("destroyed")
}

class Probe extends Renderable {
  constructor(ctx: RenderContext, options: RenderableOptions<Probe>) {
    super(ctx, {
      ...options,
      renderBefore: () => hook(this, "renderBefore"),
      renderAfter: () => hook(this, "renderAfter"),
      onSizeChange: () => hook(this, "onSizeChange"),
    })
    this.onLifecyclePass = () => hook(this, "onLifecyclePass")
    this.on("resize", () => hook(this, "resize"))
  }

  protected onUpdate(): void {
    hook(this, "onUpdate")
  }

  protected renderSelf(): void {
    hook(this, "renderSelf")
  }
}

let renderer: TestRenderer
let renderOnce: () => Promise<void>

beforeEach(async () => {
  ;({ renderer, renderOnce } = await createTestRenderer({}))
  log.length = 0
})

afterEach(() => {
  renderer.destroy()
})

const phases = ["onLifecyclePass", "onUpdate", "onSizeChange", "resize", "renderBefore", "renderSelf", "renderAfter"]
// [relation, actor, target]: `p` holds `a`, `b`, and `c`; `b` holds `d`.
const relations = [
  ["self", "b", "b"],
  ["child", "p", "b"],
  ["parent", "b", "p"],
  ["earlier sibling", "c", "a"],
  ["later sibling", "a", "c"],
  ["subtree", "a", "p"],
] as const

test.each(phases.flatMap((phase) => relations.map((relation) => [phase, ...relation])))(
  "%s destroys the %s",
  async (phase, relation, actor, target) => {
    const errors: unknown[] = []
    renderer.on(CliRenderEvents.RENDER_ERROR, (event: { error: unknown }) => errors.push(event.error))
    const nodes = Object.fromEntries(
      ["p", "a", "b", "c", "d"].map((id) => [id, new Probe(renderer, { id, height: id === "p" ? 8 : 2 })]),
    )
    for (const id of ["a", "b", "c"]) nodes.p!.add(nodes[id])
    nodes.b!.add(nodes.d)
    renderer.root.add(nodes.p)
    const node = nodes[target]!
    pending = { actor, phase, destroy: () => (relation === "subtree" ? node.destroyRecursively() : node.destroy()) }

    await renderOnce()
    await renderOnce()

    const destroyed = Object.values(nodes).filter((node) => node.isDestroyed)
    const after = log.slice(log.indexOf("destroyed") + 1)
    expect({
      destroyed: destroyed.map((node) => node.id),
      freed: destroyed.every((node) => node.isFreed()),
      hooksAfterDestroy: after.filter((entry) => destroyed.some((node) => entry.startsWith(`${node.id}.`))),
      errors,
    }).toEqual({
      destroyed: relation === "subtree" ? ["p", "a", "b", "c", "d"] : [target],
      freed: true,
      hooksAfterDestroy: [],
      errors: [],
    })
  },
)
