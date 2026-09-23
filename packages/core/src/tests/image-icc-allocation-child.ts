import { readFileSync } from "node:fs"
import { resolveNativeLibraryPath } from "#opentui/runtime-assets"

import { ImageError, imageInfo } from "../image.js"
import { dlopen } from "../platform/ffi.js"
import { resolveRenderLib, setRenderLibPath } from "../zig.js"

const png = Uint8Array.from(
  Buffer.from(
    readFileSync(new URL("../../../native/src/tests/fixtures/display-p3.png.base64", import.meta.url), "utf8").trim(),
    "base64",
  ),
)

const libPath = await resolveNativeLibraryPath()
setRenderLibPath(libPath)
resolveRenderLib()
const hooks = dlopen(libPath, {
  imageTestFailIccProfileCopyAllocationOnce: { args: [], returns: "void" },
})
try {
  hooks.symbols.imageTestFailIccProfileCopyAllocationOnce()
  imageInfo(png)
  throw new Error("expected image operation to fail")
} catch (error) {
  if (!(error instanceof ImageError) || error.code !== "out-of-memory") throw error
} finally {
  hooks.close()
}
