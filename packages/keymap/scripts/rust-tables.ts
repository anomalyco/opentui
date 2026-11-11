// Writes the Rust crate's copies of the tables that Core and @opentui/keymap own. With --check, fails instead when the
// checked-in file differs.
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"
import { basenameToFiletype, defaultTextareaKeyBindings, extensionToFiletype } from "@opentui/core"
import { kittyKeyMap } from "../../core/src/lib/parse.keypress-kitty.js"
import {
  editBufferCommandDescriptions,
  editBufferCommandNames,
  keyBindingToString,
} from "../src/addons/opentui/edit-buffer-bindings.js"
import { modifierKeyNames, namedSingleStrokeKeys } from "../src/addons/universal/default-parser.js"

const outputPath = resolve(import.meta.dirname, "../../rust/crates/opentui/src/generated.rs")

const string = (value: string) => JSON.stringify(value)
const action = (name: string) =>
  "EditorAction::" + name.replace(/(?:^|-)(\w)/g, (_, letter: string) => letter.toUpperCase())
// The crate's Shortcut syntax calls Core's meta Alt and has one Enter key for return and kpenter.
const shortcut = (key: string) =>
  key
    .split("+")
    .map((part) => ({ meta: "alt", kpenter: "enter" })[part] ?? part)
    .join("+")

// Packs the entries into lines of at most 120 columns; rustfmt leaves included files alone.
function table(doc: string, declaration: string, entries: string[]): string {
  const lines: string[] = []
  for (const entry of entries) {
    const last = lines.length - 1
    if (last >= 0 && lines[last].length + entry.length + 2 <= 120) lines[last] += ` ${entry},`
    else lines.push(`    ${entry},`)
  }
  return `${doc}\n${declaration} = &[\n${lines.join("\n")}\n];\n`
}

function generateRustTables(): string {
  const bindings = defaultTextareaKeyBindings.map((binding) => [keyBindingToString(binding), action(binding.action)])
  return [
    "// @generated from Core's and @opentui/keymap's tables by packages/keymap/scripts/rust-tables.ts. Do not edit.",
    "// Regenerate with `bun scripts/rust-tables.ts` in packages/keymap.\n",
    "use crate::widget::EditorAction;\n",
    table(
      "/// The edit commands, their names, and their descriptions, as `@opentui/keymap`'s edit-buffer addon names them.",
      "pub const EDIT_COMMANDS: &[(EditorAction, &str, &str)]",
      Object.entries(editBufferCommandNames).map(
        ([name, command]) =>
          `(${action(name)}, ${string(command)}, ${string(editBufferCommandDescriptions[name as keyof typeof editBufferCommandNames])})`,
      ),
    ),
    table(
      "/// Core's default textarea bindings (`defaultTextareaKeyBindings`), in binding syntax.",
      "pub const TEXTAREA_BINDINGS: &[(&str, EditorAction)]",
      bindings.map(([key, name]) => `(${string(key)}, ${name})`),
    ),
    table(
      "/// The same bindings as shortcuts: Core's `meta` is Alt here, and Enter is both `return` and `kpenter`.\n" +
        "/// Duplicate rows bind the same action.",
      "pub(crate) const TEXTAREA_SHORTCUTS: &[(&str, EditorAction)]",
      bindings.map(([key, name]) => `(${string(shortcut(key))}, ${name})`),
    ),
    table(
      "/// `@opentui/keymap`'s named keys in binding syntax.",
      "pub(crate) const NAMED_KEYS: &[&str]",
      [...namedSingleStrokeKeys].map(string),
    ),
    table(
      "/// `@opentui/keymap`'s modifier names in binding syntax.",
      "pub(crate) const MODIFIER_KEYS: &[&str]",
      [...modifierKeyNames].map(string),
    ),
    table(
      "/// Core's names for the Kitty functional keys from 57428 (media play) on.",
      "pub(crate) const KITTY_KEY_NAMES: &[&str]",
      Object.entries(kittyKeyMap)
        .filter(([code]) => Number(code) >= 57428)
        .map(([, name]) => string(name)),
    ),
    table(
      "/// Core's filetypes by file extension.",
      "pub(crate) const FILETYPE_EXTENSIONS: &[(&str, &str)]",
      [...extensionToFiletype].map(([extension, filetype]) => `(${string(extension)}, ${string(filetype)})`),
    ),
    table(
      "/// Core's filetypes by lowercase file name.",
      "pub(crate) const FILETYPE_BASENAMES: &[(&str, &str)]",
      [...basenameToFiletype].map(([basename, filetype]) => `(${string(basename)}, ${string(filetype)})`),
    ),
  ].join("\n")
}

if (import.meta.main) {
  const generated = generateRustTables()
  if (!process.argv.includes("--check")) writeFileSync(outputPath, generated)
  else if (readFileSync(outputPath, "utf8") !== generated) {
    console.error(`${outputPath} is stale; run \`bun scripts/rust-tables.ts\` in packages/keymap`)
    process.exit(1)
  }
}
