import type { BaseRenderable } from "../Renderable.js"
import type { Node } from "../yoga.js"

const nodes = new WeakMap<BaseRenderable, Node>()

export function getYogaNode(renderable: BaseRenderable): Node {
  const node = nodes.get(renderable)
  if (!node) throw new Error("Renderable has no layout backing")
  return node
}

export function setYogaNode(renderable: BaseRenderable, node: Node): void {
  nodes.set(renderable, node)
}

export function assertRenderableMutable(renderable: BaseRenderable): void {
  getYogaNode(renderable).assertMutable()
}

export function runRenderableMutation<T>(renderable: BaseRenderable, operation: () => T): T {
  return getYogaNode(renderable).runMutation(operation)
}
