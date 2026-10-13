import {
  CliRenderEvents,
  TextRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
  type ProgramStatus,
} from "@opentui/core"

import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

const reports: Record<string, { label: string; status: ProgramStatus }> = {
  "1": { label: "idle", status: { state: "idle", app: "opentui-demo", message: "Waiting for input" } },
  "2": { label: "working 40%", status: { state: "working", app: "opentui-demo", progress: 40, message: "Building" } },
  "3": {
    label: "blocked on permission",
    status: { state: "blocked", kind: "permission", app: "opentui-demo", message: "Deploy to production?" },
  },
  "4": { label: "done", status: { state: "done", app: "opentui-demo", message: "Build finished" } },
  "5": { label: "error", status: { state: "error", app: "opentui-demo", message: "Build failed" } },
  "6": { label: "clear", status: { state: "clear" } },
}

let text: TextRenderable | null = null
let keyHandler: ((key: KeyEvent) => void) | null = null
let capabilityHandler: (() => void) | null = null
let last = "none"

function update(renderer: CliRenderer): void {
  if (!text) return
  text.content = [
    `Terminal answered the OSC 7501 query: ${renderer.capabilities?.program_status ? "yes" : "no"}`,
    `Last report: ${last}`,
    "",
    ...Object.entries(reports).map(([key, report]) => `${key}  ${report.label}`),
    "",
    "Switch to another tab or window to see how the terminal shows the status.",
    "Press Escape to return to the examples menu.",
  ].join("\n")
  renderer.requestRender()
}

export function run(renderer: CliRenderer): void {
  renderer.start()
  text = new TextRenderable(renderer, { id: "program-status-demo-text", content: "", margin: 2 })
  renderer.root.add(text)

  keyHandler = (key: KeyEvent) => {
    const report = reports[key.name]
    if (!report) return
    last = renderer.setProgramStatus(report.status) ? report.label : `${report.label} (not queued)`
    update(renderer)
  }
  capabilityHandler = () => update(renderer)
  renderer.keyInput.on("keypress", keyHandler)
  renderer.on(CliRenderEvents.CAPABILITIES, capabilityHandler)
  update(renderer)
}

export function destroy(renderer: CliRenderer): void {
  if (keyHandler) renderer.keyInput.off("keypress", keyHandler)
  if (capabilityHandler) renderer.off(CliRenderEvents.CAPABILITIES, capabilityHandler)
  // A clear without an id would also remove records that other programs left in this terminal.
  if (!renderer.isDestroyed) renderer.setProgramStatus(reports["1"]!.status)
  keyHandler = null
  capabilityHandler = null
  text?.destroy()
  text = null
  last = "none"
}

if (import.meta.main) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  setupCommonDemoKeys(renderer)
  run(renderer)
}
