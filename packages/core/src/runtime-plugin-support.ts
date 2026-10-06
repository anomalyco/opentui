import { ensureRuntimePluginSupport } from "./runtime-plugin-support-configure.js"

export { ensureRuntimePluginSupport }
export {
  createRuntimePlugin,
  runtimeModuleIdForSpecifier,
  type CreateRuntimePluginOptions,
  type RuntimeModuleEntry,
  type RuntimeModuleExports,
  type RuntimeModuleLoader,
  type RuntimePluginRewriteOptions,
  type RuntimeSpecifierPreserve,
} from "./runtime-plugin-support-configure.js"

ensureRuntimePluginSupport()
