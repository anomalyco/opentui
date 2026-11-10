import { expect, test } from "bun:test"
import { Keymap } from "../index.js"
import { registerDefaultKeys } from "../addons/index.js"
import { createTestKeymapHost } from "../testing/index.js"
import { getGraphSnapshot } from "../extras/graph.js"

test("Keymap has built-in layer analyzers and graph is external", () => {
  const host = createTestKeymapHost()
  const keymap = new Keymap(host)

  expect(typeof keymap.appendLayerAnalyzer).toBe("function")
  expect(getGraphSnapshot(keymap).layers).toEqual([])
  expect(typeof keymap.appendLayerAnalyzer).toBe("function")
})

test("Keymap runs bindings without graph extras", () => {
  const host = createTestKeymapHost()
  const keymap = new Keymap(host)
  let ran = false

  registerDefaultKeys(keymap)
  keymap.registerLayer({
    bindings: [
      {
        key: "x",
        cmd() {
          ran = true
        },
      },
    ],
  })

  host.press("x")

  expect(ran).toBe(true)
  expect(typeof (keymap as { getGraphSnapshot?: unknown }).getGraphSnapshot).toBe("undefined")
})
