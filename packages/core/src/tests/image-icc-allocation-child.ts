import { readFileSync } from "node:fs"

import { ImageError, imageInfo } from "../image.js"
import { resolveRenderLib } from "../zig.js"

const png = Uint8Array.from(
  Buffer.from(
    readFileSync(new URL("../../../native/src/tests/fixtures/display-p3.png.base64", import.meta.url), "utf8").trim(),
    "base64",
  ),
)

resolveRenderLib().imageTestFailIccProfileCopyAllocationOnce()
try {
  imageInfo(png)
  throw new Error("expected image operation to fail")
} catch (error) {
  if (!(error instanceof ImageError) || error.code !== "out-of-memory") throw error
}
