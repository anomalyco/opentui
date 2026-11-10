import { runtimeModules as threeRuntimeModules } from "@opentui/three/runtime-modules"
import { ensureRuntimePluginSupport } from "@opentui/solid/runtime-plugin-support/configure"

ensureRuntimePluginSupport({
  additional: threeRuntimeModules,
})
