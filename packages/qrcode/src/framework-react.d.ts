// Declaration-build shim: tsconfig.build maps @opentui/react here so qrcode
// can emit d.ts for its React entrypoint without importing framework sources.
import type { BaseRenderable, RenderContext } from "@opentui/core"

export type RenderableConstructor<TRenderable extends BaseRenderable = BaseRenderable> = new (
  ctx: RenderContext,
  options: any,
) => TRenderable

export interface OpenTUIComponents {
  [componentName: string]: RenderableConstructor
}

export function extend<T extends Record<string, RenderableConstructor>>(objects: T): void
