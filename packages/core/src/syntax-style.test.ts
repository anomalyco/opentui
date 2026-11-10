import { ResourceContext } from "./buffer.js"
import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { SyntaxStyle } from "./syntax-style.js"
import { RGBA } from "./lib/RGBA.js"
import { createTextAttributes } from "./utils.js"
import type { StyleDefinition, StyleDefinitionInput } from "./syntax-style.js"

describe("NativeSyntaxStyle", () => {
  let style: SyntaxStyle
  let owner: ResourceContext

  beforeEach(() => {
    owner = new ResourceContext({ objectCapacity: 64, renderCellsMax: 1 })
    style = SyntaxStyle.create(owner)
  })

  afterEach(() => {
    style.destroy()
    owner.destroy()
  })

  it("releases a partially registered style after definition validation fails", () => {
    const context = new ResourceContext({ objectCapacity: 1, renderCellsMax: 1 })
    try {
      const invalid = RGBA.fromInts(255, 0, 0)
      invalid.buffer[3] = 256
      expect(() => SyntaxStyle.fromStyles({ first: { bold: true }, second: { fg: invalid } }, context)).toThrow()
      const retry = SyntaxStyle.fromStyles({ first: { italic: true } }, context)
      expect(retry.getStyleCount()).toBe(1)
      retry.destroy()
    } finally {
      context.destroy()
    }
  })

  it("keeps instances independent", () => {
    const other = SyntaxStyle.create(owner)
    style.registerStyle("test", { fg: RGBA.fromValues(1, 0, 0, 1) })
    expect(style.getStyleCount()).toBe(1)
    expect(other.getStyleCount()).toBe(0)
    expect(other.resolveStyleId("test")).toBeNull()
    other.destroy()
  })

  // Names, IDs, scope fallback, definitions, merging, and caches against a plain reference model.
  it.each([1, 2, 3])("matches a reference model over random operations (seed %j)", (seed) => {
    let state = seed
    const random = (count: number) => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return (state >>> 0) % count
    }
    const names = [
      "keyword",
      "keyword.control",
      "meta",
      "string",
      "",
      "关键字",
      "constructor",
      "a".repeat(1000),
      "x:y/z",
    ]
    const lookups = [...names, "Keyword", "keyword.operator", "meta.tag.xml", "nonexistent.scope", "toString"]
    const colors = [undefined, RGBA.fromValues(1, 0, 0, 1), RGBA.fromValues(0, 1, 0, 0.5), RGBA.fromValues(0, 0, 1, 0)]
    const flags = [undefined, true, false]
    const ids = new Map<string, number>()
    const definitions = new Map<string, StyleDefinition>()
    const merged = new Set<string>()
    const scoped = <T>(get: (name: string) => T | undefined, name: string): T | undefined =>
      get(name) ?? (name.includes(".") ? get(name.split(".")[0]) : undefined)
    const merge = (list: string[]) => {
      const result: StyleDefinition = {}
      for (const definition of list.map((name) => scoped((key) => definitions.get(key), name))) {
        if (definition?.fg) result.fg = definition.fg
        if (definition?.bg) result.bg = definition.bg
        for (const key of ["bold", "italic", "underline", "dim"] as const) {
          if (definition?.[key] !== undefined) result[key] = definition[key]
        }
      }
      return { fg: result.fg, bg: result.bg, attributes: createTextAttributes(result) }
    }

    for (let step = 0; step < 400; step++) {
      const name = lookups[random(lookups.length)]
      const operation = random(7)
      if (operation === 0) {
        const registered = names[random(names.length)]
        const definition: StyleDefinitionInput = { fg: colors[random(4)], bg: colors[random(4)] }
        for (const key of ["bold", "italic", "underline", "dim"] as const) definition[key] = flags[random(3)]
        const id = style.registerStyle(registered, definition)
        expect(id).toBe(ids.get(registered) ?? id)
        expect(id).toBeGreaterThan(0)
        expect([...ids].filter(([key, value]) => value === id && key !== registered)).toEqual([])
        ids.set(registered, id)
        definitions.set(registered, definition as StyleDefinition)
        merged.clear()
      } else if (operation === 1) {
        expect(style.resolveStyleId(name)).toBe(ids.get(name) ?? null)
      } else if (operation === 2) {
        expect(style.getStyleId(name)).toBe(scoped((key) => ids.get(key), name) ?? null)
      } else if (operation === 3) {
        expect(style.getStyle(name)).toEqual(scoped((key) => definitions.get(key), name))
      } else if (operation === 4) {
        // Non-empty lists: the cache key joins names with ":", so `[]` and `[""]` collide (also on `main`).
        const list = Array.from({ length: 1 + random(3) }, () => lookups[random(lookups.length)])
        const result = style.mergeStyles(...list)
        merged.add(list.join(":"))
        expect(result).toEqual(merge(list))
        // Callers own the returned colors; mutating them must not change the cache.
        result.fg?.buffer.fill(0.25)
        expect(style.mergeStyles(...list)).toEqual(merge(list))
        expect(style.getCacheSize()).toBe(merged.size)
      } else if (operation === 5) {
        style.clearNameCache()
      } else {
        style.clearCache()
        merged.clear()
        expect(style.getCacheSize()).toBe(0)
      }
      expect(style.getStyleCount()).toBe(ids.size)
    }
    expect(style.getRegisteredNames().sort()).toEqual([...definitions.keys()].sort())
    expect(style.getAllStyles()).toEqual(definitions)
    style.clearCache()
    expect(style.mergeStyles()).toEqual(merge([]))
  })

  it("rejects every call after destroy, and destroy is idempotent", () => {
    const destroyed = SyntaxStyle.create(owner)
    destroyed.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1) })
    destroyed.destroy()
    expect(() => destroyed.destroy()).not.toThrow()
    for (const call of [
      () => destroyed.registerStyle("test", {}),
      () => destroyed.resolveStyleId("test"),
      () => destroyed.getStyleId("test"),
      () => destroyed.getStyleCount(),
    ]) {
      expect(call).toThrow("NativeSyntaxStyle is destroyed")
    }
  })

  it("creates styles from a record, a map, and a theme", () => {
    const red = RGBA.fromValues(1, 0, 0, 1)
    const fromRecord = SyntaxStyle.fromStyles({ keyword: { fg: red, bold: true }, string: {} }, owner)
    const fromMap = SyntaxStyle.fromStyles(new Map([["comment", { italic: true }]]), owner)
    const fromTheme = SyntaxStyle.fromTheme(
      [
        { scope: ["keyword", "keyword.control"], style: { foreground: "#ff0000", bold: true } },
        { scope: ["styled"], style: { foreground: "#ff0000", background: "#000000", underline: true, dim: true } },
      ],
      owner,
    )
    const empty = SyntaxStyle.fromTheme([], owner)
    const bold = createTextAttributes({ bold: true })
    try {
      expect(fromRecord.getRegisteredNames()).toEqual(["keyword", "string"])
      expect(fromRecord.mergeStyles("keyword")).toEqual({ fg: red, bg: undefined, attributes: bold })
      expect(fromMap.mergeStyles("comment").attributes).toBe(createTextAttributes({ italic: true }))
      expect(fromTheme.getRegisteredNames()).toEqual(["keyword", "keyword.control", "styled"])
      expect(fromTheme.mergeStyles("keyword.control")).toEqual({ fg: red, bg: undefined, attributes: bold })
      expect(fromTheme.mergeStyles("styled")).toEqual({
        fg: red,
        bg: RGBA.fromValues(0, 0, 0, 1),
        attributes: createTextAttributes({ underline: true, dim: true }),
      })
      expect(empty.getStyleCount()).toBe(0)
    } finally {
      for (const created of [fromRecord, fromMap, fromTheme, empty]) created.destroy()
    }
  })
})
