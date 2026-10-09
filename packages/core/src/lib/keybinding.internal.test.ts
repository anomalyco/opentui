import { describe, expect, it } from "bun:test"
import {
  mergeKeyBindings,
  getKeyBindingKey,
  getKeyBindingAction,
  buildKeyBindingsMap,
  mergeKeyAliases,
  defaultKeyAliases,
  keyBindingToString,
  matchesKeyBinding,
  type KeyAliasMap,
} from "./keybinding.internal.js"

describe("keybinding.internal", () => {
  describe("getKeyBindingKey", () => {
    it("should generate key with meta modifier", () => {
      const metaBinding = { name: "a", meta: true, action: "test" }
      const key = getKeyBindingKey(metaBinding)
      expect(key).toBe("a:0:0:1:0")
    })

    it("should generate different keys for different modifiers", () => {
      const noMod = getKeyBindingKey({ name: "a" })
      const withMeta = getKeyBindingKey({ name: "a", meta: true })
      const withCtrl = getKeyBindingKey({ name: "a", ctrl: true })
      const withShift = getKeyBindingKey({ name: "a", shift: true })

      expect(noMod).not.toBe(withMeta)
      expect(noMod).not.toBe(withCtrl)
      expect(noMod).not.toBe(withShift)
      expect(withMeta).not.toBe(withCtrl)
    })

    it("should handle combined modifiers", () => {
      const key = getKeyBindingKey({ name: "a", ctrl: true, shift: true, meta: true })
      expect(key).toBe("a:1:1:1:0")
    })

    it("should generate key with super modifier", () => {
      const superBinding = { name: "z", super: true, action: "test" }
      const key = getKeyBindingKey(superBinding)
      expect(key).toBe("z:0:0:0:1")
    })
  })

  describe("base-layout fallback", () => {
    // Conformance vectors: lookup (typed key, base-layout codepoint, modifiers) -> matched bindings, in lookup order.
    const bindings = "ctrl+a ctrl+c ctrl+g ctrl+q ctrl+ㅎ j l meta+a".split(" ").map(parse)

    it.each([
      ["ㅊ", 99, "ctrl", ["ctrl+c"]],
      ["ㅁ", 97, "ctrl", ["ctrl+a"]],
      ["ㅎ", 103, "ctrl", ["ctrl+ㅎ", "ctrl+g"]],
      ["ㅓ", 106, "", ["j"]],
      ["ㅣ", 108, "", ["l"]],
      ["ф", 97, "meta", ["meta+a"]],
      ["𠀀", 99, "ctrl", ["ctrl+c"]],
      ["j", 99, "ctrl", []],
      ["h", 106, "", []],
      ["a", 113, "ctrl", ["ctrl+a"]],
    ] as const)("%s/%d %s matches %j", (name, baseCode, modifiers, matches) => {
      const lookup = { ...parse(`${modifiers}+${name}`), baseCode }
      const matched = bindings.filter((binding) => matchesKeyBinding(lookup, binding)).map((binding) => binding.action)
      expect(getKeyBindingAction(buildKeyBindingsMap(bindings), lookup)).toBe(matches[0])
      expect(matched.sort()).toEqual([...matches].sort())
    })

    function parse(text: string) {
      const parts = text.split("+")
      return { name: parts.at(-1)!, ctrl: parts.includes("ctrl"), meta: parts.includes("meta"), action: text }
    }
  })

  describe("mergeKeyBindings", () => {
    it("should merge defaults and custom bindings", () => {
      const defaults = [
        { name: "a", action: "action1" as const },
        { name: "b", action: "action2" as const },
      ]
      const custom = [{ name: "c", action: "action3" as const }]

      const merged = mergeKeyBindings(defaults, custom)
      expect(merged.length).toBe(3)
    })

    it("should allow custom to override defaults", () => {
      const defaults = [{ name: "a", action: "action1" as const }]
      const custom = [{ name: "a", action: "action2" as const }]

      const merged = mergeKeyBindings(defaults, custom)
      expect(merged.length).toBe(1)
      expect(merged[0]!.action).toBe("action2")
    })

    it("should override when meta matches", () => {
      const defaults = [{ name: "a", meta: true, action: "action1" as const }]
      const custom = [{ name: "a", meta: true, action: "action2" as const }]

      const merged = mergeKeyBindings(defaults, custom)
      expect(merged.length).toBe(1)
      expect(merged[0]!.action).toBe("action2")
    })
  })

  describe("buildKeyBindingsMap", () => {
    it("should build map from bindings", () => {
      const bindings = [
        { name: "a", action: "action1" as const },
        { name: "b", meta: true, action: "action2" as const },
      ]

      const map = buildKeyBindingsMap(bindings)
      expect(map.size).toBe(2)
      expect(map.get("a:0:0:0:0")).toBe("action1")
      expect(map.get("b:0:0:1:0")).toBe("action2")
    })

    it("should handle meta modifier correctly", () => {
      const bindings = [{ name: "a", meta: true, action: "action1" as const }]

      const map = buildKeyBindingsMap(bindings)
      expect(map.get("a:0:0:1:0")).toBe("action1")
    })

    it("should handle aliases and normalize key names", () => {
      const bindings = [{ name: "return", action: "submit" as const }]
      const aliases: KeyAliasMap = { enter: "return" }

      const map = buildKeyBindingsMap(bindings, aliases)

      expect(map.get("return:0:0:0:0")).toBe("submit")
      expect(map.get("enter:0:0:0:0")).toBeUndefined()
    })

    it("should create aliased mappings for aliased key names", () => {
      const bindings = [{ name: "enter", action: "submit" as const }]
      const aliases: KeyAliasMap = { enter: "return" }

      const map = buildKeyBindingsMap(bindings, aliases)

      expect(map.get("enter:0:0:0:0")).toBe("submit")
      expect(map.get("return:0:0:0:0")).toBe("submit")
    })

    it("should handle multiple aliases", () => {
      const bindings = [
        { name: "enter", action: "submit" as const },
        { name: "esc", action: "cancel" as const },
      ]
      const aliases: KeyAliasMap = { enter: "return", esc: "escape" }

      const map = buildKeyBindingsMap(bindings, aliases)

      expect(map.get("enter:0:0:0:0")).toBe("submit")
      expect(map.get("return:0:0:0:0")).toBe("submit")
      expect(map.get("esc:0:0:0:0")).toBe("cancel")
      expect(map.get("escape:0:0:0:0")).toBe("cancel")
    })

    it("should handle aliases with modifiers", () => {
      const bindings = [{ name: "enter", meta: true, action: "special-submit" as const }]
      const aliases: KeyAliasMap = { enter: "return" }

      const map = buildKeyBindingsMap(bindings, aliases)

      expect(map.get("enter:0:0:1:0")).toBe("special-submit")
      expect(map.get("return:0:0:1:0")).toBe("special-submit")
    })
  })

  describe("mergeKeyAliases", () => {
    it("should merge default and custom aliases", () => {
      const defaults: KeyAliasMap = { enter: "return" }
      const custom: KeyAliasMap = { esc: "escape" }

      const merged = mergeKeyAliases(defaults, custom)

      expect(merged.enter).toBe("return")
      expect(merged.esc).toBe("escape")
    })

    it("should allow custom aliases to override defaults", () => {
      const defaults: KeyAliasMap = { enter: "return" }
      const custom: KeyAliasMap = { enter: "custom-return" }

      const merged = mergeKeyAliases(defaults, custom)

      expect(merged.enter).toBe("custom-return")
    })

    it("should preserve defaults when no custom aliases provided", () => {
      const defaults: KeyAliasMap = { enter: "return", esc: "escape" }
      const custom: KeyAliasMap = {}

      const merged = mergeKeyAliases(defaults, custom)

      expect(merged.enter).toBe("return")
      expect(merged.esc).toBe("escape")
    })
  })

  describe("defaultKeyAliases", () => {
    it("should have enter -> return alias", () => {
      expect(defaultKeyAliases.enter).toBe("return")
    })

    it("should have esc -> escape alias", () => {
      expect(defaultKeyAliases.esc).toBe("escape")
    })

    it("should have keypad aliases to normalized key names", () => {
      const keypadAliases: KeyAliasMap = {
        kp0: "0",
        kp1: "1",
        kp2: "2",
        kp3: "3",
        kp4: "4",
        kp5: "5",
        kp6: "6",
        kp7: "7",
        kp8: "8",
        kp9: "9",
        kpdecimal: ".",
        kpdivide: "/",
        kpmultiply: "*",
        kpminus: "-",
        kpplus: "+",
        kpenter: "enter",
        kpequal: "=",
        kpseparator: ",",
        kpleft: "left",
        kpright: "right",
        kpup: "up",
        kpdown: "down",
        kppageup: "pageup",
        kppagedown: "pagedown",
        kphome: "home",
        kpend: "end",
        kpinsert: "insert",
        kpdelete: "delete",
      }

      for (const [key, value] of Object.entries(keypadAliases)) {
        expect(defaultKeyAliases[key]).toBe(value)
      }
    })
  })

  describe("alias override behavior", () => {
    it("should override 'return' binding when custom provides 'enter' binding with aliases", () => {
      const defaults = [{ name: "return", action: "newline" as const }]
      const custom = [{ name: "enter", action: "submit" as const }]
      const aliases: KeyAliasMap = { enter: "return" }

      const merged = mergeKeyBindings(defaults, custom)
      const map = buildKeyBindingsMap(merged, aliases)

      const returnAction = map.get("return:0:0:0:0")
      const enterAction = map.get("enter:0:0:0:0")

      expect(returnAction).toBe("submit")
      expect(enterAction).toBe("submit")
    })

    it("should also allow direct override using canonical name", () => {
      const defaults = [{ name: "return", action: "newline" as const }]
      const custom = [{ name: "return", action: "submit" as const }]
      const aliases: KeyAliasMap = { enter: "return" }

      const merged = mergeKeyBindings(defaults, custom)
      const map = buildKeyBindingsMap(merged, aliases)

      const returnAction = map.get("return:0:0:0:0")
      const enterAction = map.get("enter:0:0:0:0")

      expect(returnAction).toBe("submit")
      expect(enterAction).toBeUndefined()
    })

    it("should handle the Textarea scenario: defaults with 'return', custom with 'enter'", () => {
      const defaults = [
        { name: "return", action: "newline" as const },
        { name: "return", meta: true, action: "submit" as const },
      ]
      const custom = [{ name: "enter", action: "custom-submit" as const }]
      const aliases: KeyAliasMap = { enter: "return" }

      const merged = mergeKeyBindings(defaults, custom)
      const map = buildKeyBindingsMap(merged, aliases)

      const returnNoMod = map.get("return:0:0:0:0")
      const returnWithMeta = map.get("return:0:0:1:0")
      const enterNoMod = map.get("enter:0:0:0:0")

      expect(returnNoMod).toBe("custom-submit")
      expect(enterNoMod).toBe("custom-submit")
      expect(returnWithMeta).toBe("submit")
    })
  })

  describe("keyBindingToString", () => {
    it("should convert simple key binding without modifiers", () => {
      const binding = { name: "escape", action: "cancel" as const }
      expect(keyBindingToString(binding)).toBe("escape")
    })

    it("should convert key binding with ctrl modifier", () => {
      const binding = { name: "c", ctrl: true, action: "copy" as const }
      expect(keyBindingToString(binding)).toBe("ctrl+c")
    })

    it("should convert key binding with shift modifier", () => {
      const binding = { name: "up", shift: true, action: "scroll-fast" as const }
      expect(keyBindingToString(binding)).toBe("shift+up")
    })

    it("should convert key binding with multiple modifiers", () => {
      const binding = { name: "y", ctrl: true, shift: true, action: "copy" as const }
      expect(keyBindingToString(binding)).toBe("ctrl+shift+y")
    })

    it("should convert key binding with all modifiers", () => {
      const binding = { name: "a", ctrl: true, shift: true, meta: true, super: true, action: "all" as const }
      expect(keyBindingToString(binding)).toBe("ctrl+shift+meta+super+a")
    })

    it("should convert key binding with meta modifier", () => {
      const binding = { name: "s", meta: true, action: "save" as const }
      expect(keyBindingToString(binding)).toBe("meta+s")
    })

    it("should convert key binding with super modifier", () => {
      const binding = { name: "z", super: true, action: "undo" as const }
      expect(keyBindingToString(binding)).toBe("super+z")
    })

    it("should handle special keys correctly", () => {
      expect(keyBindingToString({ name: "return", action: "submit" as const })).toBe("return")
      expect(keyBindingToString({ name: "space", action: "select" as const })).toBe("space")
      expect(keyBindingToString({ name: "tab", action: "next" as const })).toBe("tab")
    })
  })
})
