import { writeSync } from "node:fs"
import { createTestRenderer } from "@opentui/core/testing"
import { registerNeovimDisambiguation, registerTimedLeader } from "@opentui/keymap/addons"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"

const [addon, timeout, stall] = process.argv.slice(2)
const { renderer } = await createTestRenderer({ stdin: process.stdin })
const keymap = createDefaultOpenTuiKeymap(renderer)
const leader = addon === "leader"
if (leader) registerTimedLeader(keymap, { trigger: "ctrl+x", timeoutMs: Number(timeout) })
else registerNeovimDisambiguation(keymap, { timeoutMs: Number(timeout) })

function finish(binding: string) {
  writeSync(1, binding + "\n")
  process.exit(0)
}
keymap.registerLayer({
  bindings: [
    { key: leader ? "<leader>f" : "gf", cmd: () => void writeSync(1, "chord\n") },
    { key: "f", cmd: () => void writeSync(1, "plain f\n") },
    { key: "g", cmd: () => void writeSync(1, "exact,") },
    { key: "ba", cmd: () => finish("next chord") },
    { key: "a", cmd: () => finish("plain a") },
  ],
})

// The renderer handles the first key before this listener. Let deferred resolvers start their timers too.
process.stdin.once("data", () =>
  queueMicrotask(() => {
    writeSync(1, `${Date.now()}\n`)
    Bun.sleepSync(Number(stall))
  }),
)
