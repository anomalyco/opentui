import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { SyntaxStyle } from "./syntax-style.js"
import { RGBA } from "./lib/RGBA.js"
import type { StyleDefinition, ThemeTokenStyle } from "./syntax-style.js"

describe("NativeSyntaxStyle", () => {
  let style: SyntaxStyle

  beforeEach(() => {
    style = SyntaxStyle.create()
  })

  afterEach(() => {
    style.destroy()
  })

  describe("create", () => {
    it("should create a new NativeSyntaxStyle instance", () => {
      const newStyle = SyntaxStyle.create()
      expect(newStyle).toBeDefined()
      expect(newStyle.getStyleCount()).toBe(0)
      newStyle.destroy()
    })

    it("should create multiple independent instances", () => {
      const style1 = SyntaxStyle.create()
      const style2 = SyntaxStyle.create()

      style1.registerStyle("test", { fg: RGBA.fromValues(1, 0, 0, 1) })

      expect(style1.getStyleCount()).toBe(1)
      expect(style2.getStyleCount()).toBe(0)

      style1.destroy()
      style2.destroy()
    })
  })

  describe("registerStyle", () => {
    it("should register a simple style and return an ID", () => {
      const id = style.registerStyle("keyword", {
        fg: RGBA.fromValues(1, 0, 0, 1),
      })

      expect(id).toBeGreaterThan(0)
      expect(style.getStyleCount()).toBe(1)
    })

    it("should register style with both fg and bg colors", () => {
      const id = style.registerStyle("string", {
        fg: RGBA.fromValues(0, 1, 0, 1),
        bg: RGBA.fromValues(0, 0, 0, 1),
      })

      expect(id).toBeGreaterThan(0)
      expect(style.getStyleCount()).toBe(1)
    })

    it("should register style with attributes", () => {
      const id = style.registerStyle("bold-keyword", {
        fg: RGBA.fromValues(1, 0, 0, 1),
        bold: true,
      })

      expect(id).toBeGreaterThan(0)
      expect(style.getStyleCount()).toBe(1)
    })

    it("should register style with multiple attributes", () => {
      const id = style.registerStyle("styled", {
        fg: RGBA.fromValues(1, 0, 0, 1),
        bold: true,
        italic: true,
        underline: true,
      })

      expect(id).toBeGreaterThan(0)
      expect(style.getStyleCount()).toBe(1)
    })

    it("should register multiple different styles", () => {
      const id1 = style.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1) })
      const id2 = style.registerStyle("string", { fg: RGBA.fromValues(0, 1, 0, 1) })
      const id3 = style.registerStyle("comment", { fg: RGBA.fromValues(0.5, 0.5, 0.5, 1) })

      expect(id1).not.toBe(id2)
      expect(id2).not.toBe(id3)
      expect(id1).not.toBe(id3)
      expect(style.getStyleCount()).toBe(3)
    })

    it("should return existing ID when registering same style name", () => {
      const id1 = style.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1) })
      const id2 = style.registerStyle("keyword", { fg: RGBA.fromValues(0, 1, 0, 1) })

      expect(id1).toBe(id2)
      expect(style.getStyleCount()).toBe(1)
    })

    it("should handle style without colors", () => {
      const id = style.registerStyle("plain", {})

      expect(id).toBeGreaterThan(0)
      expect(style.getStyleCount()).toBe(1)
    })

    it("should handle style with only background color", () => {
      const id = style.registerStyle("highlighted", {
        bg: RGBA.fromValues(1, 1, 0, 1),
      })

      expect(id).toBeGreaterThan(0)
      expect(style.getStyleCount()).toBe(1)
    })

    it("should handle style with only attributes", () => {
      const id = style.registerStyle("bold-only", {
        bold: true,
      })

      expect(id).toBeGreaterThan(0)
      expect(style.getStyleCount()).toBe(1)
    })

    it("should handle style with dim attribute", () => {
      const id = style.registerStyle("dimmed", {
        fg: RGBA.fromValues(1, 1, 1, 1),
        dim: true,
      })

      expect(id).toBeGreaterThan(0)
      expect(style.getStyleCount()).toBe(1)
    })

    it("should register styles with special characters in names", () => {
      const id1 = style.registerStyle("keyword.control", { fg: RGBA.fromValues(1, 0, 0, 1) })
      const id2 = style.registerStyle("variable.parameter", { fg: RGBA.fromValues(0, 1, 0, 1) })

      expect(id1).toBeGreaterThan(0)
      expect(id2).toBeGreaterThan(0)
      expect(id1).not.toBe(id2)
      expect(style.getStyleCount()).toBe(2)
    })

    it("should register many styles without issue", () => {
      const ids: number[] = []
      for (let i = 0; i < 100; i++) {
        const id = style.registerStyle(`style-${i}`, {
          fg: RGBA.fromValues(i / 100, 0, 0, 1),
        })
        ids.push(id)
      }

      expect(style.getStyleCount()).toBe(100)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(100)
    })
  })

  describe("resolveStyleId", () => {
    it("should resolve registered style name to ID", () => {
      const registeredId = style.registerStyle("keyword", {
        fg: RGBA.fromValues(1, 0, 0, 1),
      })

      const resolvedId = style.resolveStyleId("keyword")
      expect(resolvedId).toBe(registeredId)
    })

    it("should return null for unregistered style", () => {
      const id = style.resolveStyleId("nonexistent")
      expect(id).toBeNull()
    })

    it("should resolve multiple styles correctly", () => {
      const id1 = style.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1) })
      const id2 = style.registerStyle("string", { fg: RGBA.fromValues(0, 1, 0, 1) })

      expect(style.resolveStyleId("keyword")).toBe(id1)
      expect(style.resolveStyleId("string")).toBe(id2)
    })

    it("should cache resolved style IDs", () => {
      const registeredId = style.registerStyle("keyword", {
        fg: RGBA.fromValues(1, 0, 0, 1),
      })

      const resolvedId1 = style.resolveStyleId("keyword")
      const resolvedId2 = style.resolveStyleId("keyword")

      expect(resolvedId1).toBe(registeredId)
      expect(resolvedId2).toBe(registeredId)
    })

    it("should handle empty string style name", () => {
      const id = style.registerStyle("", { fg: RGBA.fromValues(1, 0, 0, 1) })
      expect(style.resolveStyleId("")).toBe(id)
    })

    it("should be case-sensitive", () => {
      style.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1) })

      expect(style.resolveStyleId("keyword")).not.toBeNull()
      expect(style.resolveStyleId("Keyword")).toBeNull()
      expect(style.resolveStyleId("KEYWORD")).toBeNull()
    })
  })

  describe("getStyleId", () => {
    it("should return style ID for exact match", () => {
      const id = style.registerStyle("keyword", {
        fg: RGBA.fromValues(1, 0, 0, 1),
      })

      expect(style.getStyleId("keyword")).toBe(id)
    })

    it("should fall back to base scope for dotted names", () => {
      const baseId = style.registerStyle("keyword", {
        fg: RGBA.fromValues(1, 0, 0, 1),
      })

      expect(style.getStyleId("keyword.control")).toBe(baseId)
      expect(style.getStyleId("keyword.operator")).toBe(baseId)
    })

    it("should prefer exact match over base scope", () => {
      const baseId = style.registerStyle("keyword", {
        fg: RGBA.fromValues(1, 0, 0, 1),
      })
      const specificId = style.registerStyle("keyword.control", {
        fg: RGBA.fromValues(0, 1, 0, 1),
      })

      expect(style.getStyleId("keyword")).toBe(baseId)
      expect(style.getStyleId("keyword.control")).toBe(specificId)
      expect(style.getStyleId("keyword.operator")).toBe(baseId)
    })

    it("should return null for non-existent style without fallback", () => {
      expect(style.getStyleId("nonexistent")).toBeNull()
      expect(style.getStyleId("nonexistent.scope")).toBeNull()
    })

    it("should handle multiple dot levels", () => {
      const baseId = style.registerStyle("meta", {
        fg: RGBA.fromValues(1, 0, 0, 1),
      })

      expect(style.getStyleId("meta.tag.xml")).toBe(baseId)
    })

    it("should handle names without dots", () => {
      const id = style.registerStyle("comment", {
        fg: RGBA.fromValues(0.5, 0.5, 0.5, 1),
      })

      expect(style.getStyleId("comment")).toBe(id)
    })
  })

  describe("getStyleCount", () => {
    it("should return 0 for empty style registry", () => {
      expect(style.getStyleCount()).toBe(0)
    })

    it("should return correct count after registering styles", () => {
      style.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1) })
      expect(style.getStyleCount()).toBe(1)

      style.registerStyle("string", { fg: RGBA.fromValues(0, 1, 0, 1) })
      expect(style.getStyleCount()).toBe(2)

      style.registerStyle("comment", { fg: RGBA.fromValues(0.5, 0.5, 0.5, 1) })
      expect(style.getStyleCount()).toBe(3)
    })

    it("should not increment count for duplicate registrations", () => {
      style.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1) })
      expect(style.getStyleCount()).toBe(1)

      style.registerStyle("keyword", { fg: RGBA.fromValues(0, 1, 0, 1) })
      expect(style.getStyleCount()).toBe(1)
    })
  })

  describe("clearNameCache", () => {
    it("should clear the name-to-ID cache", () => {
      const id = style.registerStyle("keyword", {
        fg: RGBA.fromValues(1, 0, 0, 1),
      })

      style.resolveStyleId("keyword")
      style.clearNameCache()

      // Should still work after clearing cache
      expect(style.resolveStyleId("keyword")).toBe(id)
    })

    it("should not affect registered styles", () => {
      style.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1) })
      style.registerStyle("string", { fg: RGBA.fromValues(0, 1, 0, 1) })

      style.clearNameCache()

      expect(style.getStyleCount()).toBe(2)
    })
  })

  describe("ptr getter", () => {
    it("should return a valid pointer", () => {
      const ptr = style.ptr
      expect(ptr).toBeDefined()
      expect(typeof ptr === "number" || typeof ptr === "bigint").toBe(true)
    })

    it("should return same pointer for same instance", () => {
      const ptr1 = style.ptr
      const ptr2 = style.ptr
      expect(ptr1).toBe(ptr2)
    })

    it("should return different pointers for different instances", () => {
      const style2 = SyntaxStyle.create()
      const ptr1 = style.ptr
      const ptr2 = style2.ptr

      expect(ptr1).not.toBe(ptr2)

      style2.destroy()
    })
  })

  describe("destroy", () => {
    it("should destroy the style instance", () => {
      const testStyle = SyntaxStyle.create()
      testStyle.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1) })

      testStyle.destroy()

      expect(() => testStyle.getStyleCount()).toThrow("NativeSyntaxStyle is destroyed")
    })

    it("should be safe to call destroy multiple times", () => {
      const testStyle = SyntaxStyle.create()

      testStyle.destroy()
      expect(() => testStyle.destroy()).not.toThrow()
    })

    it("should throw error when using destroyed instance", () => {
      const testStyle = SyntaxStyle.create()
      testStyle.destroy()

      expect(() => testStyle.registerStyle("test", {})).toThrow("NativeSyntaxStyle is destroyed")
      expect(() => testStyle.resolveStyleId("test")).toThrow("NativeSyntaxStyle is destroyed")
      expect(() => testStyle.getStyleId("test")).toThrow("NativeSyntaxStyle is destroyed")
      expect(() => testStyle.getStyleCount()).toThrow("NativeSyntaxStyle is destroyed")
      expect(() => testStyle.ptr).toThrow("NativeSyntaxStyle is destroyed")
    })
  })

  describe("fromStyles", () => {
    it("should create style from styles object", () => {
      const styles: Record<string, StyleDefinition> = {
        keyword: { fg: RGBA.fromValues(1, 0, 0, 1), bold: true },
        string: { fg: RGBA.fromValues(0, 1, 0, 1) },
        comment: { fg: RGBA.fromValues(0.5, 0.5, 0.5, 1), italic: true },
      }

      const newStyle = SyntaxStyle.fromStyles(styles)

      expect(newStyle.getStyleCount()).toBe(3)
      expect(newStyle.resolveStyleId("keyword")).not.toBeNull()
      expect(newStyle.resolveStyleId("string")).not.toBeNull()
      expect(newStyle.resolveStyleId("comment")).not.toBeNull()

      newStyle.destroy()
    })

    it("should handle empty styles object", () => {
      const newStyle = SyntaxStyle.fromStyles({})

      expect(newStyle.getStyleCount()).toBe(0)

      newStyle.destroy()
    })

    it("should preserve style definitions", () => {
      const styles: Record<string, StyleDefinition> = {
        keyword: {
          fg: RGBA.fromValues(1, 0, 0, 1),
          bold: true,
          italic: true,
        },
      }

      const newStyle = SyntaxStyle.fromStyles(styles)
      const id = newStyle.resolveStyleId("keyword")

      expect(id).not.toBeNull()

      newStyle.destroy()
    })
  })

  describe("fromTheme", () => {
    it("should create style from theme", () => {
      const theme: ThemeTokenStyle[] = [
        {
          scope: ["keyword", "keyword.control"],
          style: {
            foreground: "#ff0000",
            bold: true,
          },
        },
        {
          scope: ["string"],
          style: {
            foreground: "#00ff00",
          },
        },
      ]

      const newStyle = SyntaxStyle.fromTheme(theme)

      expect(newStyle.getStyleCount()).toBe(3) // keyword, keyword.control, string
      expect(newStyle.resolveStyleId("keyword")).not.toBeNull()
      expect(newStyle.resolveStyleId("keyword.control")).not.toBeNull()
      expect(newStyle.resolveStyleId("string")).not.toBeNull()

      newStyle.destroy()
    })

    it("should handle empty theme", () => {
      const newStyle = SyntaxStyle.fromTheme([])

      expect(newStyle.getStyleCount()).toBe(0)

      newStyle.destroy()
    })

    it("should handle theme with multiple scopes", () => {
      const theme: ThemeTokenStyle[] = [
        {
          scope: ["comment", "comment.line", "comment.block"],
          style: {
            foreground: "#808080",
            italic: true,
          },
        },
      ]

      const newStyle = SyntaxStyle.fromTheme(theme)

      expect(newStyle.getStyleCount()).toBe(3)
      expect(newStyle.resolveStyleId("comment")).not.toBeNull()
      expect(newStyle.resolveStyleId("comment.line")).not.toBeNull()
      expect(newStyle.resolveStyleId("comment.block")).not.toBeNull()

      newStyle.destroy()
    })

    it("should handle theme with all style properties", () => {
      const theme: ThemeTokenStyle[] = [
        {
          scope: ["styled"],
          style: {
            foreground: "#ff0000",
            background: "#000000",
            bold: true,
            italic: true,
            underline: true,
            dim: true,
          },
        },
      ]

      const newStyle = SyntaxStyle.fromTheme(theme)

      expect(newStyle.getStyleCount()).toBe(1)
      expect(newStyle.resolveStyleId("styled")).not.toBeNull()

      newStyle.destroy()
    })

    it("should handle theme with rgb color format", () => {
      const theme: ThemeTokenStyle[] = [
        {
          scope: ["keyword"],
          style: {
            foreground: "rgb(255, 0, 0)",
          },
        },
      ]

      const newStyle = SyntaxStyle.fromTheme(theme)

      expect(newStyle.resolveStyleId("keyword")).not.toBeNull()

      newStyle.destroy()
    })
  })

  describe("integration tests", () => {
    it("should handle complex syntax highlighting scenario", () => {
      const theme: ThemeTokenStyle[] = [
        { scope: ["keyword"], style: { foreground: "#569cd6", bold: true } },
        { scope: ["string"], style: { foreground: "#ce9178" } },
        { scope: ["comment"], style: { foreground: "#6a9955", italic: true } },
        { scope: ["variable"], style: { foreground: "#9cdcfe" } },
        { scope: ["function"], style: { foreground: "#dcdcaa" } },
        { scope: ["operator"], style: { foreground: "#d4d4d4" } },
      ]

      const syntaxStyle = SyntaxStyle.fromTheme(theme)

      expect(syntaxStyle.getStyleCount()).toBe(6)

      const keywordId = syntaxStyle.getStyleId("keyword")
      const stringId = syntaxStyle.getStyleId("string")
      const commentId = syntaxStyle.getStyleId("comment")

      expect(keywordId).not.toBeNull()
      expect(stringId).not.toBeNull()
      expect(commentId).not.toBeNull()

      expect(keywordId).not.toBe(stringId)
      expect(stringId).not.toBe(commentId)

      syntaxStyle.destroy()
    })

    it("should handle registering and resolving many styles efficiently", () => {
      const start = Date.now()

      for (let i = 0; i < 1000; i++) {
        style.registerStyle(`style-${i}`, {
          fg: RGBA.fromValues(Math.random(), Math.random(), Math.random(), 1),
        })
      }

      const registerTime = Date.now() - start

      const resolveStart = Date.now()
      for (let i = 0; i < 1000; i++) {
        style.resolveStyleId(`style-${i}`)
      }
      const resolveTime = Date.now() - resolveStart

      expect(registerTime).toBeLessThan(1000) // Should register 1000 styles in < 1s
      expect(resolveTime).toBeLessThan(100) // Should resolve 1000 styles in < 100ms

      expect(style.getStyleCount()).toBe(1000)
    })

    it("should handle style name collisions correctly", () => {
      const id1 = style.registerStyle("test", {
        fg: RGBA.fromValues(1, 0, 0, 1),
      })

      const id2 = style.registerStyle("test", {
        fg: RGBA.fromValues(0, 1, 0, 1),
        bold: true,
      })

      expect(id1).toBe(id2)
      expect(style.getStyleCount()).toBe(1)
    })

    it("should maintain style registry across cache clears", () => {
      style.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1) })
      style.registerStyle("string", { fg: RGBA.fromValues(0, 1, 0, 1) })
      style.registerStyle("comment", { fg: RGBA.fromValues(0.5, 0.5, 0.5, 1) })

      const count1 = style.getStyleCount()
      style.clearNameCache()
      const count2 = style.getStyleCount()

      expect(count1).toBe(count2)
      expect(count1).toBe(3)
    })
  })

  describe("edge cases", () => {
    it("should handle very long style names", () => {
      const longName = "a".repeat(1000)
      const id = style.registerStyle(longName, {
        fg: RGBA.fromValues(1, 0, 0, 1),
      })

      expect(id).toBeGreaterThan(0)
      expect(style.resolveStyleId(longName)).toBe(id)
    })

    it("should handle style names with unicode characters", () => {
      const id = style.registerStyle("关键字", {
        fg: RGBA.fromValues(1, 0, 0, 1),
      })

      expect(id).toBeGreaterThan(0)
      expect(style.resolveStyleId("关键字")).toBe(id)
    })

    it("should handle style names with special characters", () => {
      const specialNames = [
        "style-with-dashes",
        "style_with_underscores",
        "style.with.dots",
        "style:with:colons",
        "style/with/slashes",
      ]

      for (const name of specialNames) {
        const id = style.registerStyle(name, {
          fg: RGBA.fromValues(1, 0, 0, 1),
        })
        expect(id).toBeGreaterThan(0)
        expect(style.resolveStyleId(name)).toBe(id)
      }
    })

    it("should handle colors with full alpha range", () => {
      const id1 = style.registerStyle("transparent", {
        fg: RGBA.fromValues(1, 0, 0, 0),
      })
      const id2 = style.registerStyle("semi-transparent", {
        fg: RGBA.fromValues(1, 0, 0, 0.5),
      })
      const id3 = style.registerStyle("opaque", {
        fg: RGBA.fromValues(1, 0, 0, 1),
      })

      expect(id1).toBeGreaterThan(0)
      expect(id2).toBeGreaterThan(0)
      expect(id3).toBeGreaterThan(0)
    })

    it("should handle all attribute combinations", () => {
      const combinations = [
        { bold: true },
        { italic: true },
        { underline: true },
        { dim: true },
        { bold: true, italic: true },
        { bold: true, underline: true },
        { bold: true, dim: true },
        { italic: true, underline: true },
        { italic: true, dim: true },
        { underline: true, dim: true },
        { bold: true, italic: true, underline: true },
        { bold: true, italic: true, dim: true },
        { bold: true, underline: true, dim: true },
        { italic: true, underline: true, dim: true },
        { bold: true, italic: true, underline: true, dim: true },
      ]

      for (let i = 0; i < combinations.length; i++) {
        const id = style.registerStyle(`combo-${i}`, {
          fg: RGBA.fromValues(1, 0, 0, 1),
          ...combinations[i],
        })
        expect(id).toBeGreaterThan(0)
      }

      expect(style.getStyleCount()).toBe(combinations.length)
    })
  })

  describe("getStyle", () => {
    it("should retrieve registered style definition", () => {
      const styleDef = { fg: RGBA.fromValues(1, 0, 0, 1), bold: true }
      style.registerStyle("keyword", styleDef)

      const retrieved = style.getStyle("keyword")
      expect(retrieved).toBeDefined()
      expect(retrieved?.fg).toEqual(styleDef.fg)
      expect(retrieved?.bold).toBe(true)
    })

    it("should return undefined for unregistered style", () => {
      expect(style.getStyle("nonexistent")).toBeUndefined()
    })

    it("should fall back to base scope for dotted names", () => {
      const baseDef = { fg: RGBA.fromValues(1, 0, 0, 1), bold: true }
      style.registerStyle("keyword", baseDef)

      const retrieved = style.getStyle("keyword.control")
      expect(retrieved).toBeDefined()
      expect(retrieved?.fg).toEqual(baseDef.fg)
      expect(retrieved?.bold).toBe(true)
    })

    it("should prefer exact match over base scope", () => {
      const baseDef = { fg: RGBA.fromValues(1, 0, 0, 1) }
      const specificDef = { fg: RGBA.fromValues(0, 1, 0, 1), bold: true }

      style.registerStyle("keyword", baseDef)
      style.registerStyle("keyword.control", specificDef)

      const exactMatch = style.getStyle("keyword.control")
      expect(exactMatch?.fg).toEqual(specificDef.fg)
      expect(exactMatch?.bold).toBe(true)

      const baseMatch = style.getStyle("keyword.operator")
      expect(baseMatch?.fg).toEqual(baseDef.fg)
    })

    it("should not return Object prototype properties", () => {
      expect(style.getStyle("constructor")).toBeUndefined()
      expect(style.getStyle("toString")).toBeUndefined()
      expect(style.getStyle("hasOwnProperty")).toBeUndefined()
    })

    it("should handle style named constructor correctly", () => {
      const constructorDef = { fg: RGBA.fromValues(1, 0.5, 0, 1), bold: true }
      style.registerStyle("constructor", constructorDef)

      const retrieved = style.getStyle("constructor")
      expect(retrieved).toBeDefined()
      expect(retrieved?.fg).toEqual(constructorDef.fg)
      expect(retrieved?.bold).toBe(true)
    })

    it("should handle multiple dot levels", () => {
      const baseDef = { fg: RGBA.fromValues(1, 0, 0, 1) }
      style.registerStyle("meta", baseDef)

      const retrieved = style.getStyle("meta.tag.xml")
      expect(retrieved).toBeDefined()
      expect(retrieved?.fg).toEqual(baseDef.fg)
    })
  })

  describe("mergeStyles", () => {
    it("should merge single style correctly", () => {
      style.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1), bold: true })

      const merged = style.mergeStyles("keyword")
      expect(merged.fg).toEqual(RGBA.fromValues(1, 0, 0, 1))
      expect(merged.attributes).toBeGreaterThan(0)
    })

    it("should merge multiple styles with later taking precedence", () => {
      style.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1), bold: true })
      style.registerStyle("emphasis", { italic: true })
      style.registerStyle("override", { fg: RGBA.fromValues(0, 1, 0, 1) })

      const merged = style.mergeStyles("keyword", "emphasis", "override")
      expect(merged.fg).toEqual(RGBA.fromValues(0, 1, 0, 1))
      expect(merged.attributes).toBeGreaterThan(0)
    })

    it("should handle dotted style names with fallback", () => {
      style.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1), bold: true })

      const merged = style.mergeStyles("keyword.operator")
      expect(merged.fg).toEqual(RGBA.fromValues(1, 0, 0, 1))
      expect(merged.attributes).toBeGreaterThan(0)
    })

    it("should return empty merge for non-existent styles", () => {
      const merged = style.mergeStyles("nonexistent")
      expect(merged.fg).toBeUndefined()
      expect(merged.bg).toBeUndefined()
      expect(merged.attributes).toBe(0)
    })

    it("should cache merged results", () => {
      style.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1) })

      expect(style.getCacheSize()).toBe(0)

      const result1 = style.mergeStyles("keyword.operator")
      expect(style.getCacheSize()).toBe(1)

      const result2 = style.mergeStyles("keyword.operator")
      expect(style.getCacheSize()).toBe(1)

      expect(result1).toBe(result2)
    })

    it("should handle all style attributes correctly", () => {
      style.registerStyle("complex", {
        fg: RGBA.fromValues(1, 0, 0, 1),
        bg: RGBA.fromValues(0.2, 0.2, 0.2, 1),
        bold: true,
        italic: true,
        underline: true,
        dim: true,
      })

      const merged = style.mergeStyles("complex")
      expect(merged.fg).toEqual(RGBA.fromValues(1, 0, 0, 1))
      expect(merged.bg).toEqual(RGBA.fromValues(0.2, 0.2, 0.2, 1))
      expect(merged.attributes).toBeGreaterThan(0)
    })

    it("should handle empty style names", () => {
      const merged = style.mergeStyles()
      expect(merged.fg).toBeUndefined()
      expect(merged.bg).toBeUndefined()
      expect(merged.attributes).toBe(0)
    })
  })

  describe("clearCache and getCacheSize", () => {
    it("should clear merged style cache", () => {
      style.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1) })
      style.mergeStyles("keyword")
      style.mergeStyles("keyword.operator")

      expect(style.getCacheSize()).toBe(2)

      style.clearCache()
      expect(style.getCacheSize()).toBe(0)
    })

    it("should not affect registered styles when clearing cache", () => {
      style.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1) })
      style.mergeStyles("keyword")

      style.clearCache()

      expect(style.getStyleCount()).toBe(1)
      expect(style.resolveStyleId("keyword")).not.toBeNull()
    })

    it("should allow re-merging after cache clear", () => {
      style.registerStyle("keyword", { fg: RGBA.fromValues(1, 0, 0, 1) })

      const result1 = style.mergeStyles("keyword")
      style.clearCache()
      const result2 = style.mergeStyles("keyword")

      expect(result1.fg).toEqual(result2.fg)
      expect(result1.attributes).toBe(result2.attributes)
    })
  })
})
