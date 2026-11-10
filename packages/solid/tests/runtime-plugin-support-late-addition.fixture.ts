import { plugin as registerPlugin } from "bun"
import { runtimeModules as keymapRuntimeModules } from "@opentui/keymap/runtime-modules"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"
import { resetSolidTransformPluginState } from "../scripts/solid-plugin.js"

registerPlugin.clearAll()
resetSolidTransformPluginState()

try {
  await import("@opentui/solid/runtime-plugin-support")
  ensureRuntimePluginSupport({ additional: keymapRuntimeModules })
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error))
} finally {
  registerPlugin.clearAll()
}
