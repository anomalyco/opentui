import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { plugin as registerPlugin } from "bun"
import { createRuntimePlugin } from "../runtime-plugin.js"

const tempRoot = mkdtempSync(join(tmpdir(), "core-runtime-plugin-node-modules-package-type-cache-fixture-"))
const externalNodeModulesDir = join(tempRoot, "external", "node_modules")
const childPackageDir = join(externalNodeModulesDir, "runtime-plugin-package-type-cache-child")
const childPackageEntryPath = join(childPackageDir, "index.js")
const parentPackageDir = join(externalNodeModulesDir, "runtime-plugin-package-type-cache-parent")
const parentPackageEntryPath = join(parentPackageDir, "index.js")

const writeChildPackage = (mode: "commonjs" | "module"): void => {
  writeFileSync(
    join(childPackageDir, "package.json"),
    JSON.stringify({
      name: "runtime-plugin-package-type-cache-child",
      private: true,
      ...(mode === "module" ? { type: "module", exports: "./index.js" } : { main: "./index.js" }),
    }),
  )

  writeFileSync(
    childPackageEntryPath,
    mode === "module"
      ? ['import { marker } from "fixture-runtime"', "export const childMarker = marker"].join("\n")
      : 'module.exports.childMarker = "primed-as-commonjs"\n',
  )
}

mkdirSync(childPackageDir, { recursive: true })
mkdirSync(parentPackageDir, { recursive: true })

writeChildPackage("commonjs")

writeFileSync(
  join(parentPackageDir, "package.json"),
  JSON.stringify({
    name: "runtime-plugin-package-type-cache-parent",
    private: true,
    type: "module",
    exports: "./index.js",
  }),
)

writeFileSync(parentPackageEntryPath, 'export { childMarker } from "runtime-plugin-package-type-cache-child"\n')

registerPlugin.clearAll()

registerPlugin(createRuntimePlugin())

try {
  await import(`${childPackageEntryPath}?phase=commonjs`)

  registerPlugin.clearAll()
  writeChildPackage("module")

  registerPlugin(
    createRuntimePlugin({
      additional: {
        "fixture-runtime": { marker: "resolved-after-package-type-change" },
      },
    }),
  )

  const parentModule = (await import(`${parentPackageEntryPath}?phase=module`)) as { childMarker: string }
  console.log(`marker=${parentModule.childMarker}`)
} finally {
  registerPlugin.clearAll()
  rmSync(tempRoot, { recursive: true, force: true })
}
