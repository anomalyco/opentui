import { plugin as registerPlugin } from "bun"

registerPlugin.clearAll()

try {
  const runtimePluginSupport = await import("../runtime-plugin-support.js")
  const alreadyInstalled =
    runtimePluginSupport.ensureRuntimePluginSupport() === false &&
    runtimePluginSupport.ensureRuntimePluginSupport({ preserve: [] }) === false
  console.log(`idempotent=${alreadyInstalled}`)
} finally {
  registerPlugin.clearAll()
}
