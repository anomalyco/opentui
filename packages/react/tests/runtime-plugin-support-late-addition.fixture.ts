import { plugin as registerPlugin } from "bun"
import { ensureRuntimePluginSupport } from "../scripts/runtime-plugin-support-configure.js"

registerPlugin.clearAll()

try {
  await import("../scripts/runtime-plugin-support.js")
  ensureRuntimePluginSupport({
    additional: {
      "runtime-plugin-support-extra": { marker: "ok" },
    },
  })
} catch (error) {
  console.log(error instanceof Error ? error.message : String(error))
} finally {
  registerPlugin.clearAll()
}
