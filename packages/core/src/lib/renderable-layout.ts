import type { BaseRenderable, Renderable } from "../Renderable.js"

function asLayoutRenderable(renderable: BaseRenderable): Renderable {
  const target = renderable as BaseRenderable & { _sceneHandle?: unknown; isFreed?: () => boolean }
  if (!target._sceneHandle && !target.isFreed?.()) throw new Error("Renderable has no layout backing")
  return renderable as Renderable
}

export function assertRenderableMutable(renderable: BaseRenderable): void {
  asLayoutRenderable(renderable).assertMutable()
}

export function runRenderableMutation<T>(renderable: BaseRenderable, operation: () => T): T {
  return asLayoutRenderable(renderable).runMutation(operation)
}
