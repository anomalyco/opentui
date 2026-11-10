import type { RuntimeModuleEntry } from "@opentui/core/runtime-plugin"
import * as threeRuntime from "@opentui/three"

export const runtimeModules = {
  "@opentui/three": threeRuntime,
} satisfies Record<string, RuntimeModuleEntry>
