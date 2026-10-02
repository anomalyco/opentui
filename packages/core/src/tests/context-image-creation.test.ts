import { expect, test } from "bun:test"
import { NativeImage } from "../image.js"
import { ResourceContext } from "../buffer.js"

test("image wrappers reject access after explicit Context teardown and dispose cleanly", () => {
  const owner = new ResourceContext({ objectCapacity: 2, renderCellsMax: 1 })
  const image = NativeImage.fromPixels(Uint8Array.of(1, 2, 3, 255), 1, 1, { owner })
  owner.destroy()
  expect(() => image.raw()).toThrow("destroyed")
  image.dispose()
  image.dispose()
})
