import { describe, expect, test } from "bun:test"
import { createBindingLookup, type BindingValue } from "../index.js"
import type { Binding } from "../../index.js"
import { createTestKeymap } from "../../testing/index.js"

describe("createBindingLookup helper", () => {
  test("resolves flat command config into command lookups and binding arrays", () => {
    const openKey = { name: "o", ctrl: true }

    const lookup = createBindingLookup({
      " show_dialog ": "ctrl+d",
      close_dialog: ["escape", { key: "ctrl+c", preventDefault: false }],
      open_file: openKey,
    })

    expect(lookup.bindings).toEqual([
      { key: "ctrl+d", cmd: " show_dialog " },
      { key: "escape", cmd: "close_dialog" },
      { key: "ctrl+c", cmd: "close_dialog", preventDefault: false },
      { key: { name: "o", ctrl: true }, cmd: "open_file" },
    ])
    expect(lookup.get(" show_dialog ")).toEqual([{ key: "ctrl+d", cmd: " show_dialog " }])
    expect(lookup.get("show_dialog")).toEqual([])
    expect(lookup.get("missing_command")).toEqual([])
    expect(lookup.has(" show_dialog ")).toBe(true)
    expect(lookup.has("show_dialog")).toBe(false)
    expect(lookup.get("open_file")[0]?.key).not.toBe(openKey)
  })

  test("uses config command keys as the binding command identity", () => {
    const lookup = createBindingLookup({
      show_dialog: {
        key: "d",
        cmd: "ignored_command",
        preventDefault: false,
      },
    })

    expect(lookup.bindings).toEqual([{ key: "d", cmd: "show_dialog", preventDefault: false }])
    expect(lookup.get("ignored_command")).toEqual([])
    expect(lookup.has("ignored_command")).toBe(false)
  })

  test("clones key and binding objects without mutating inputs", () => {
    const key = { name: "s", ctrl: true }
    const binding = {
      key,
      cmd: "ignored_command",
      preventDefault: false,
      metadata: { source: "user" },
    }

    const lookup = createBindingLookup({
      save_file: binding,
    })
    const resolvedBinding = lookup.get("save_file")[0]

    expect(resolvedBinding).toEqual({
      key: { name: "s", ctrl: true },
      cmd: "save_file",
      preventDefault: false,
      metadata: { source: "user" },
    })
    expect(resolvedBinding).not.toBe(binding)
    expect(resolvedBinding?.key).not.toBe(key)
    expect(binding.cmd).toBe("ignored_command")
  })

  test("applies binding defaults without overriding explicit binding fields", () => {
    const key = { name: "s", ctrl: true }
    const binding = {
      key,
      desc: "Explicit description",
      group: "Explicit group",
      preventDefault: true,
    }
    const calls: string[] = []

    const lookup = createBindingLookup(
      {
        save_file: binding,
        open_file: "o",
        multi_action: ["m", { key: "shift+m", group: "Explicit multi group" }],
        disabled_action: false,
        empty_action: [],
      },
      {
        bindingDefaults({ command, binding }) {
          calls.push(`${command}:${String(binding.key)}`)
          return {
            key: "ignored-key",
            cmd: "ignored-command",
            desc: "Default description",
            group: "Default group",
            preventDefault: false,
          }
        },
      },
    )

    expect(calls).toEqual(["save_file:[object Object]", "open_file:o", "multi_action:m", "multi_action:shift+m"])
    expect(lookup.bindings).toEqual([
      {
        key: { name: "s", ctrl: true },
        cmd: "save_file",
        desc: "Explicit description",
        group: "Explicit group",
        preventDefault: true,
      },
      {
        key: "o",
        cmd: "open_file",
        desc: "Default description",
        group: "Default group",
        preventDefault: false,
      },
      {
        key: "m",
        cmd: "multi_action",
        desc: "Default description",
        group: "Default group",
        preventDefault: false,
      },
      {
        key: "shift+m",
        cmd: "multi_action",
        desc: "Default description",
        group: "Explicit multi group",
        preventDefault: false,
      },
    ])
    expect(binding).toEqual({
      key,
      desc: "Explicit description",
      group: "Explicit group",
      preventDefault: true,
    })
    expect(lookup.get("open_file")).toEqual([
      {
        key: "o",
        cmd: "open_file",
        desc: "Default description",
        group: "Default group",
        preventDefault: false,
      },
    ])
  })

  test("maps exact config command names to internal command names during normalization", () => {
    const calls: string[] = []
    const lookup = createBindingLookup(
      {
        show_dialog: "d",
        close_dialog: ["escape", { key: "ctrl+c", preventDefault: false }],
        unmapped_command: "u",
      },
      {
        commandMap: {
          show_dialog: "dialog.show",
          close_dialog: "dialog.close",
        },
        bindingDefaults({ command }) {
          calls.push(command)
          return { group: command.startsWith("dialog.") ? "Dialog" : "Other" }
        },
      },
    )

    expect(lookup.bindings).toEqual([
      { key: "d", cmd: "dialog.show", group: "Dialog" },
      { key: "escape", cmd: "dialog.close", group: "Dialog" },
      { key: "ctrl+c", cmd: "dialog.close", preventDefault: false, group: "Dialog" },
      { key: "u", cmd: "unmapped_command", group: "Other" },
    ])
    expect(calls).toEqual(["dialog.show", "dialog.close", "dialog.close", "unmapped_command"])
    expect(lookup.get("dialog.show")).toEqual([{ key: "d", cmd: "dialog.show", group: "Dialog" }])
    expect(lookup.get("show_dialog")).toEqual([])
    expect(lookup.has("dialog.show")).toBe(true)
    expect(lookup.has("show_dialog")).toBe(false)
    expect(lookup.gather("dialog", ["dialog.show", "dialog.close"])).toEqual([
      { key: "d", cmd: "dialog.show", group: "Dialog" },
      { key: "escape", cmd: "dialog.close", group: "Dialog" },
      { key: "ctrl+c", cmd: "dialog.close", preventDefault: false, group: "Dialog" },
    ])
    expect(lookup.pick("dialog", ["dialog.close"])).toEqual([
      { key: "escape", cmd: "dialog.close", group: "Dialog" },
      { key: "ctrl+c", cmd: "dialog.close", preventDefault: false, group: "Dialog" },
    ])
    expect(lookup.omit("dialog", ["dialog.close"])).toEqual([{ key: "d", cmd: "dialog.show", group: "Dialog" }])
  })

  test("uses exact command map keys and ignores inherited command map entries", () => {
    const commandMap = Object.create({ show_dialog: "dialog.show" }) as Record<string, string>
    commandMap[" show_dialog "] = "dialog.show.spaced"

    const lookup = createBindingLookup(
      {
        show_dialog: "d",
        " show_dialog ": "s",
      },
      { commandMap },
    )

    expect(lookup.bindings).toEqual([
      { key: "d", cmd: "show_dialog" },
      { key: "s", cmd: "dialog.show.spaced" },
    ])
    expect(lookup.get("show_dialog")).toEqual([{ key: "d", cmd: "show_dialog" }])
    expect(lookup.get("dialog.show")).toEqual([])
    expect(lookup.get("dialog.show.spaced")).toEqual([{ key: "s", cmd: "dialog.show.spaced" }])
  })

  test("lets duplicate mapped commands replace or disable earlier mapped commands", () => {
    const config: Record<string, BindingValue> = {}
    config.first = "1"
    config.second = ["2a", "2b"]
    config.disabled = false
    config.third = "3"

    const lookup = createBindingLookup(config, {
      commandMap: {
        first: "shared.command",
        second: "shared.command",
        disabled: "shared.command",
        third: "shared.command",
      },
    })

    expect(lookup.bindings).toEqual([{ key: "3", cmd: "shared.command" }])
    expect(lookup.get("shared.command")).toEqual([{ key: "3", cmd: "shared.command" }])
    expect(lookup.get("first")).toEqual([])
    expect(lookup.has("shared.command")).toBe(true)
    expect(lookup.has("first")).toBe(false)
  })

  test("translates commands only when creating or updating the lookup", () => {
    const commandMap: Record<string, string> = {
      open_dialog: "dialog.open",
    }
    const lookup = createBindingLookup({ open_dialog: "o" }, { commandMap })

    commandMap.open_dialog = "dialog.changed"

    expect(lookup.get("dialog.open")).toEqual([{ key: "o", cmd: "dialog.open" }])
    expect(lookup.get("dialog.changed")).toEqual([])

    lookup.update()

    expect(lookup.get("dialog.open")).toEqual([])
    expect(lookup.get("dialog.changed")).toEqual([{ key: "o", cmd: "dialog.changed" }])

    commandMap.close_dialog = "dialog.close"
    lookup.update({ close_dialog: "escape" })

    expect(lookup.get("dialog.close")).toEqual([{ key: "escape", cmd: "dialog.close" }])
    expect(lookup.get("close_dialog")).toEqual([])
  })

  test("uses exact command names and lets false, none, and empty arrays disable exact commands", () => {
    const config: Record<string, BindingValue> = {}
    config[" action "] = "a"
    config.action = false
    config.before_action = "b"
    config["action "] = "c"
    config.disabled_action = "none"
    config.literal_none_key = ["none"]
    config.empty_action = []

    const lookup = createBindingLookup(config)

    expect(lookup.bindings).toEqual([
      { key: "a", cmd: " action " },
      { key: "b", cmd: "before_action" },
      { key: "c", cmd: "action " },
      { key: "none", cmd: "literal_none_key" },
    ])
    expect(lookup.get(" action ")).toEqual([{ key: "a", cmd: " action " }])
    expect(lookup.get("action ")).toEqual([{ key: "c", cmd: "action " }])
    expect(lookup.get("action")).toEqual([])
    expect(lookup.get("disabled_action")).toEqual([])
    expect(lookup.get("empty_action")).toEqual([])
    expect(lookup.has(" action ")).toBe(true)
    expect(lookup.has("action")).toBe(false)
    expect(lookup.has("disabled_action")).toBe(false)
  })

  test("ignores inherited command properties", () => {
    const config = Object.create({ inherited_command: "i" }) as Record<string, unknown>
    config.save_file = "s"

    const lookup = createBindingLookup(config as never)

    expect(lookup.bindings).toEqual([{ key: "s", cmd: "save_file" }])
    expect(lookup.get("inherited_command")).toEqual([])
    expect(lookup.has("inherited_command")).toBe(false)
  })

  test("gathers command groups once and returns the cached group on later calls", () => {
    const lookup = createBindingLookup({
      open_dialog: "o",
      close_dialog: ["escape", "ctrl+c"],
      submit_dialog: "enter",
    })

    const first = lookup.gather("dialog", ["open_dialog", "missing_command", "close_dialog"])
    const second = lookup.gather("dialog", ["submit_dialog"])

    expect(second).toBe(first)
    expect(first).toEqual([
      { key: "o", cmd: "open_dialog" },
      { key: "escape", cmd: "close_dialog" },
      { key: "ctrl+c", cmd: "close_dialog" },
    ])
    expect(lookup.gather("submit", ["submit_dialog"])).toEqual([{ key: "enter", cmd: "submit_dialog" }])
  })

  test("picks and omits from existing gathered groups", () => {
    const lookup = createBindingLookup({
      first: "1",
      second: ["2a", { key: "2b", preventDefault: false }],
      third: "3",
      exact: "4",
    })

    lookup.gather("group", ["first", "second", "third", "exact"])

    expect(lookup.pick("group", ["third", "missing", "second", "first"])).toEqual([
      { key: "3", cmd: "third" },
      { key: "2a", cmd: "second" },
      { key: "2b", cmd: "second", preventDefault: false },
      { key: "1", cmd: "first" },
    ])
    expect(lookup.pick("group", [" third "])).toEqual([])
    expect(lookup.pick("missing", ["first"])).toEqual([])
    expect(lookup.pick("group", [])).toEqual([])

    expect(lookup.omit("group", ["second", "missing", " exact "])).toEqual([
      { key: "1", cmd: "first" },
      { key: "3", cmd: "third" },
      { key: "4", cmd: "exact" },
    ])
    expect(lookup.omit("group", ["exact"])).toEqual([
      { key: "1", cmd: "first" },
      { key: "2a", cmd: "second" },
      { key: "2b", cmd: "second", preventDefault: false },
      { key: "3", cmd: "third" },
    ])
    expect(lookup.omit("missing", ["first"])).toEqual([])

    const wholeGroup = lookup.omit("group", [])
    expect(wholeGroup).toEqual(lookup.gather("group", []))
    expect(wholeGroup).toBe(lookup.gather("group", []))
  })

  test("returns existing lookup arrays without slicing or duplicating", () => {
    const lookup = createBindingLookup({
      first: "1",
      second: ["2a", "2b"],
    })

    const first = lookup.get("first")
    const firstAgain = lookup.get("first")
    const missing = lookup.get("missing")
    const missingAgain = lookup.get("missing")
    const group = lookup.gather("group", ["first", "second"])

    expect(firstAgain).toBe(first)
    expect(missing).toEqual([])
    expect(missingAgain).toBe(missing)
    expect(lookup.gather("group", ["first"])).toBe(group)
    expect(lookup.omit("group", [])).toBe(group)
  })

  test("invalidates one gathered group or all gathered groups", () => {
    const lookup = createBindingLookup({
      open_dialog: "o",
      close_dialog: "escape",
      submit_dialog: "enter",
    })

    const dialog = lookup.gather("dialog", ["open_dialog"])
    const submit = lookup.gather("submit", ["submit_dialog"])

    lookup.invalidate("dialog")
    const nextDialog = lookup.gather("dialog", ["close_dialog"])

    expect(nextDialog).not.toBe(dialog)
    expect(nextDialog).toEqual([{ key: "escape", cmd: "close_dialog" }])
    expect(lookup.gather("submit", ["open_dialog"])).toBe(submit)

    lookup.invalidate()

    expect(lookup.gather("submit", ["open_dialog"])).toEqual([{ key: "o", cmd: "open_dialog" }])
  })

  test("updates the command lookup and clears gathered groups", () => {
    const config: Record<string, BindingValue> = {
      open_dialog: "o",
    }
    const lookup = createBindingLookup(config)
    const first = lookup.gather("dialog", ["open_dialog"])

    lookup.update({
      open_dialog: "p",
      close_dialog: "escape",
    })

    expect(lookup.get("open_dialog")).toEqual([{ key: "p", cmd: "open_dialog" }])
    expect(lookup.bindings).toEqual([
      { key: "p", cmd: "open_dialog" },
      { key: "escape", cmd: "close_dialog" },
    ])

    const second = lookup.gather("dialog", ["open_dialog", "close_dialog"])
    expect(second).not.toBe(first)
    expect(second).toEqual([
      { key: "p", cmd: "open_dialog" },
      { key: "escape", cmd: "close_dialog" },
    ])

    config.open_dialog = "r"
    lookup.update(config)

    expect(lookup.get("open_dialog")).toEqual([{ key: "r", cmd: "open_dialog" }])
  })

  test("throws for invalid commands and binding values", () => {
    expect(() => createBindingLookup({ "": "s" } as never)).toThrow("Invalid binding command: command cannot be empty")
    expect(() => createBindingLookup({ save_file: "s" }, { commandMap: { save_file: "" } })).toThrow(
      'Invalid binding command map entry for "save_file": command cannot be empty',
    )
    expect(() => createBindingLookup({ save_file: "s" }, { commandMap: { save_file: true } as never })).toThrow(
      'Invalid binding command map entry for "save_file": expected a command string',
    )
    expect(createBindingLookup({ "   ": "s" } as never).get("   ")).toEqual([{ key: "s", cmd: "   " }])
    expect(() => createBindingLookup({ save_file: true } as never)).toThrow(
      'Invalid binding value for "save_file": expected false, a key, a binding object, or an array of keys/binding objects',
    )
    expect(() => createBindingLookup({ save_file: null } as never)).toThrow(
      'Invalid binding value for "save_file": expected false, a key, a binding object, or an array of keys/binding objects',
    )
    expect(() => createBindingLookup({ save_file: ["x", true] } as never)).toThrow(
      'Invalid binding value for "save_file" at index 1: expected false, a key, a binding object, or an array of keys/binding objects',
    )
    expect(() => createBindingLookup({ save_file: ["x", false] } as never)).toThrow(
      'Invalid binding value for "save_file" at index 1: expected false, a key, a binding object, or an array of keys/binding objects',
    )
    expect(() => createBindingLookup({ save_file: { key: true } } as never)).toThrow(
      'Invalid binding value for "save_file": expected false, a key, a binding object, or an array of keys/binding objects',
    )
  })

  test("supports registering gathered bindings", async () => {
    const harness = createTestKeymap({ defaultKeys: true })
    const { keymap, host } = harness
    const calls: string[] = []

    try {
      keymap.registerLayer({
        commands: [
          {
            name: "exit_app",
            run() {
              calls.push("exit")
            },
          },
          {
            name: "paste_prompt",
            run() {
              calls.push("paste")
            },
          },
        ],
      })

      const lookup = createBindingLookup({
        exit_app: ["q", "ctrl+c"],
        paste_prompt: {
          key: "p",
          preventDefault: false,
        },
      })

      keymap.registerLayer({ bindings: lookup.gather("app", ["exit_app"]) })
      keymap.registerLayer({ bindings: lookup.gather("prompt", ["paste_prompt"]) })

      host.press("q")
      host.press("p")

      expect(calls).toEqual(["exit", "paste"])
    } finally {
      harness.cleanup()
    }
  })
})
