import type { RuntimeModuleEntry, RuntimeModuleExports } from "@opentui/core/runtime-plugin"
import * as keymap from "@opentui/keymap"
import * as keymapExtras from "@opentui/keymap/extras"
import * as keymapGraphExtra from "@opentui/keymap/extras/graph"
import * as keymapAddons from "@opentui/keymap/addons"
import * as keymapOpenTuiAddons from "@opentui/keymap/addons/opentui"
import * as keymapHtml from "@opentui/keymap/html"
import * as keymapOpenTui from "@opentui/keymap/opentui"

const loadKeymapReact = async (): Promise<RuntimeModuleExports> => {
  return (await import("@opentui/keymap/react")) as RuntimeModuleExports
}

const loadKeymapSolid = async (): Promise<RuntimeModuleExports> => {
  return (await import("@opentui/keymap/solid")) as RuntimeModuleExports
}

export const runtimeModules = {
  "@opentui/keymap": keymap,
  "@opentui/keymap/extras": keymapExtras,
  "@opentui/keymap/extras/graph": keymapGraphExtra,
  "@opentui/keymap/addons": keymapAddons,
  "@opentui/keymap/addons/opentui": keymapOpenTuiAddons,
  "@opentui/keymap/html": keymapHtml,
  "@opentui/keymap/opentui": keymapOpenTui,
  "@opentui/keymap/react": loadKeymapReact,
  "@opentui/keymap/solid": loadKeymapSolid,
} satisfies Record<string, RuntimeModuleEntry>
