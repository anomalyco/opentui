import { createBindingLookup, type BindingConfig, type BindingLookup, type BindingValue } from "../binding-lookup.js"
import type { Binding } from "../../types.js"

const config: BindingConfig = {
  show_dialog: "d",
  close_dialog: "escape",
}

const lookup = createBindingLookup(config, {
  commandMap: {
    show_dialog: "dialog.show",
  },
  bindingDefaults({ command, binding }) {
    const value: string = `${command}.${String(binding.key)}`
    return { group: value }
  },
})

const typedLookup: BindingLookup = lookup
const allBindings: readonly Binding[] = lookup.bindings
const showBindings: readonly Binding[] = lookup.get("dialog.show")
const hasShowBinding: boolean = lookup.has("dialog.show")
const dialogBindings: readonly Binding[] = lookup.gather("dialog", ["dialog.show", "close_dialog"])
const pickedBindings: Binding[] = lookup.pick("dialog", ["dialog.show"])
const omittedBindings: Binding[] = lookup.omit("dialog", ["close_dialog"])

const mutableConfig: Record<string, BindingValue> = {
  submit_dialog: "enter",
}

typedLookup.update(mutableConfig)
typedLookup.invalidate("dialog")
typedLookup.invalidate()

if (allBindings.length !== 2) {
  throw new Error("Expected all bindings")
}
if (showBindings.length !== 1) {
  throw new Error("Expected show binding")
}
if (!hasShowBinding) {
  throw new Error("Expected show binding to exist")
}
if (dialogBindings.length !== 2) {
  throw new Error("Expected gathered bindings")
}
if (pickedBindings.length !== 1) {
  throw new Error("Expected picked bindings")
}
if (omittedBindings.length !== 1) {
  throw new Error("Expected omitted bindings")
}
