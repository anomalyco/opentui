import { type CliRenderer, type KeyEvent } from "@opentui/core"

export function setupCommonDemoKeys(renderer: CliRenderer) {
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.name === "`" || key.name === '"') {
      renderer.console.toggle()
    } else if (key.name === ".") {
      renderer.toggleDebugOverlay()
    } else if (key.name === "g" && key.ctrl) {
      console.log("dumping hit grid")
      renderer.dumpHitGrid()
    } else if (key.name === "l" && key.shift) {
      renderer.start()
    } else if (key.name === "s" && key.shift) {
      renderer.stop()
    } else if (key.name === "a" && key.shift) {
      renderer.auto()
    }
  })
}
