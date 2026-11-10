import { describe, expect, it, spyOn } from "bun:test"
import { TextNodeRenderable, isTextNodeRenderable } from "./TextNode.js"
import { RGBA } from "../lib/RGBA.js"
import { StyledText, red, bold, t } from "../lib/styled-text.js"

describe("TextNodeRenderable", () => {
  describe("Constructor and Options", () => {
    it("should create TextNode with default options", () => {
      const node = new TextNodeRenderable({})

      expect(node.fg).toBeUndefined()
      expect(node.bg).toBeUndefined()
      expect(node.attributes).toBe(0)
      expect(node.children).toEqual([])
    })

    it("should create TextNode with custom options", () => {
      const fgColor = RGBA.fromInts(255, 0, 0, 255)
      const bgColor = RGBA.fromInts(0, 0, 255, 255)
      const attributes = 1

      const node = new TextNodeRenderable({
        fg: fgColor,
        bg: bgColor,
        attributes,
      })

      expect(node.fg).toEqual(fgColor)
      expect(node.bg).toEqual(bgColor)
      expect(node.attributes).toBe(attributes)
    })

    it("should parse color strings in constructor", () => {
      const node = new TextNodeRenderable({
        fg: "#ff0000",
        bg: "blue",
      })

      expect(node.fg?.r).toBe(1)
      expect(node.fg?.g).toBe(0)
      expect(node.fg?.b).toBe(0)
      expect(node.fg?.a).toBe(1)
      expect(node.bg?.r).toBe(0)
      expect(node.bg?.g).toBe(0)
      expect(node.bg?.b).toBe(1)
      expect(node.bg?.a).toBe(1)
    })

    it("should preserve RGBA intent constructors in constructor and setters", () => {
      const node = new TextNodeRenderable({
        fg: RGBA.fromIndex(6),
        bg: RGBA.defaultBackground(),
      })

      expect(node.fg).toBeDefined()
      expect(node.bg).toBeDefined()
      expect(node.fg).toBeInstanceOf(RGBA)
      expect(node.bg).toBeInstanceOf(RGBA)
      expect(node.fg!.intent).toBe("indexed")
      expect(node.fg!.slot).toBe(6)
      expect(node.bg!.intent).toBe("default")

      node.fg = RGBA.defaultForeground()
      node.bg = RGBA.fromIndex(4)

      expect(node.fg).toBeInstanceOf(RGBA)
      expect(node.bg).toBeInstanceOf(RGBA)
      expect(node.fg!.intent).toBe("default")
      expect(node.bg!.intent).toBe("indexed")
      expect(node.bg!.slot).toBe(4)
    })

    it("should handle undefined colors", () => {
      const node = new TextNodeRenderable({
        fg: undefined,
        bg: undefined,
      })

      expect(node.fg).toBeUndefined()
      expect(node.bg).toBeUndefined()
    })
  })

  describe("Type Guard", () => {
    it("should identify TextNodeRenderable instances", () => {
      const node = new TextNodeRenderable({})
      const plainObject = {}

      expect(isTextNodeRenderable(node)).toBe(true)
      expect(isTextNodeRenderable(plainObject)).toBe(false)
      expect(isTextNodeRenderable(null)).toBe(false)
      expect(isTextNodeRenderable(undefined)).toBe(false)
    })
  })

  describe("add Method", () => {
    it("should add string child using add", () => {
      const node = new TextNodeRenderable({})

      const index = node.add("Hello")

      expect(index).toBe(0)
      expect(node.children).toEqual(["Hello"])
    })

    it("should add TextNode child using add", () => {
      const parent = new TextNodeRenderable({})
      const child = new TextNodeRenderable({})

      const index = parent.add(child)

      expect(index).toBe(0)
      expect(parent.children).toEqual([child])
    })

    it("should add multiple children sequentially", () => {
      const node = new TextNodeRenderable({})

      node.add("First")
      node.add("Second")
      const childNode = new TextNodeRenderable({})
      node.add(childNode)

      expect(node.children).toEqual(["First", "Second", childNode])
    })

    it("should add child at specific index using add method", () => {
      const node = new TextNodeRenderable({})
      const child1 = new TextNodeRenderable({})
      const child2 = new TextNodeRenderable({})

      node.add("First")
      node.add(child1, 0) // Insert at beginning
      node.add(child2, 2) // Insert at end

      expect(node.children).toEqual([child1, "First", child2])
    })

    it("should add string at specific index using add method", () => {
      const node = new TextNodeRenderable({})
      const child1 = new TextNodeRenderable({})

      node.add("First")
      node.add(child1, 0) // Insert at beginning
      node.add("Middle", 1) // Insert in middle
      node.add("Last") // Append at end

      expect(node.children).toEqual([child1, "Middle", "First", "Last"])
    })

    it("should reject non-TextNode children in add method", () => {
      const node = new TextNodeRenderable({})
      const invalidChild = { id: "invalid" }

      expect(() => {
        node.add(invalidChild as any, 0)
      }).toThrow("TextNodeRenderable only accepts strings, TextNodeRenderable instances, or StyledText instances")
    })

    it("should add StyledText child using add method", () => {
      const node = new TextNodeRenderable({})
      const styledText = new StyledText([
        { __isChunk: true, text: "Hello", fg: RGBA.fromInts(255, 0, 0, 255), attributes: 1 },
        { __isChunk: true, text: " World", fg: RGBA.fromInts(0, 255, 0, 255), attributes: 0 },
      ])

      const index = node.add(styledText)

      expect(index).toBe(0)
      expect(node.children).toHaveLength(2)
      expect(node.children[0]).toBeInstanceOf(TextNodeRenderable)
      expect(node.children[1]).toBeInstanceOf(TextNodeRenderable)

      const firstChild = node.children[0] as TextNodeRenderable
      const secondChild = node.children[1] as TextNodeRenderable

      expect(firstChild.children).toEqual(["Hello"])
      expect(firstChild.fg).toEqual(RGBA.fromInts(255, 0, 0, 255))
      expect(firstChild.attributes).toBe(1)

      expect(secondChild.children).toEqual([" World"])
      expect(secondChild.fg).toEqual(RGBA.fromInts(0, 255, 0, 255))
      expect(secondChild.attributes).toBe(0)
    })

    it("should add StyledText child at specific index using add method", () => {
      const node = new TextNodeRenderable({})
      node.add("First")
      node.add("Third")

      const styledText = new StyledText([
        { __isChunk: true, text: "Second", fg: RGBA.fromInts(255, 255, 0, 255), attributes: 2 },
      ])

      node.add(styledText, 1)

      expect(node.children).toHaveLength(3)
      expect(node.children[0]).toBe("First")
      expect(node.children[1]).toBeInstanceOf(TextNodeRenderable)
      expect(node.children[2]).toBe("Third")

      const styledChild = node.children[1] as TextNodeRenderable
      expect(styledChild.children).toEqual(["Second"])
      expect(styledChild.fg).toEqual(RGBA.fromInts(255, 255, 0, 255))
      expect(styledChild.attributes).toBe(2)
    })
  })

  describe("insertBefore and remove Methods", () => {
    it("should insert child before anchor node", () => {
      const node = new TextNodeRenderable({})
      const anchor = new TextNodeRenderable({})

      node.add("First")
      node.add(anchor)
      node.add("Last")

      node.insertBefore("Middle", anchor)

      expect(node.children).toEqual(["First", "Middle", anchor, "Last"])
    })

    it("should throw error when anchor node not found in insertBefore", () => {
      const node = new TextNodeRenderable({})
      const anchor = new TextNodeRenderable({})

      expect(() => {
        node.insertBefore("Test", anchor)
      }).toThrow("Anchor node not found in children")
    })

    it("should insert StyledText before anchor node", () => {
      const node = new TextNodeRenderable({})
      const anchor = new TextNodeRenderable({})
      anchor.add("Anchor")

      node.add("First")
      node.add(anchor)
      node.add("Last")

      const styledText = new StyledText([
        { __isChunk: true, text: "Middle", fg: RGBA.fromInts(128, 128, 128, 255), attributes: 4 },
      ])

      node.insertBefore(styledText, anchor)

      expect(node.children).toHaveLength(4)
      expect(node.children[0]).toBe("First")
      expect(node.children[1]).toBeInstanceOf(TextNodeRenderable)
      expect(node.children[2]).toBe(anchor)
      expect(node.children[3]).toBe("Last")

      const styledChild = node.children[1] as TextNodeRenderable
      expect(styledChild.children).toEqual(["Middle"])
      expect(styledChild.fg).toEqual(RGBA.fromInts(128, 128, 128, 255))
      expect(styledChild.attributes).toBe(4)
    })

    it("should remove child from node", () => {
      const node = new TextNodeRenderable({})
      const child = new TextNodeRenderable({})

      node.add("First")
      node.add(child)
      node.add("Last")

      node.remove(child)

      expect(node.children).toEqual(["First", "Last"])
      expect(child.parent).toBeNull()
    })

    it("should remove duplicate-id children by first public match or exact object", () => {
      const node = new TextNodeRenderable({})
      const first = new TextNodeRenderable({ id: "duplicate" })
      const second = new TextNodeRenderable({ id: "duplicate" })

      node.add(first)
      node.add(second)

      expect(node.getRenderable("duplicate")).toBe(first)

      node.remove(second)

      expect(node.children).toHaveLength(1)
      expect(node.children[0]).toBe(first)
      expect(first.parent).toBe(node)
      expect(second.parent).toBeNull()
      expect(node.getRenderable("duplicate")).toBe(first)

      const found = node.getRenderable("duplicate")
      expect(found).toBe(first)
      if (found) node.remove(found)

      expect(node.children).toHaveLength(0)
      expect(first.parent).toBeNull()
    })

    it("should warn in dev instead of throwing for a child not contained by the node", () => {
      const node = new TextNodeRenderable({})
      const child = new TextNodeRenderable({})

      const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
      try {
        expect(() => node.remove(child)).not.toThrow()
        expect(warnSpy).toHaveBeenCalledTimes(1)
      } finally {
        warnSpy.mockRestore()
      }
    })

    it("should not warn when removing an actual child", () => {
      const node = new TextNodeRenderable({})
      const child = new TextNodeRenderable({})
      node.add(child)

      const warnSpy = spyOn(console, "warn").mockImplementation(() => {})
      try {
        node.remove(child)
        expect(warnSpy).not.toHaveBeenCalled()
      } finally {
        warnSpy.mockRestore()
      }
    })

    it("should reject string ids at runtime", () => {
      const node = new TextNodeRenderable({})
      const child = new TextNodeRenderable({ id: "child" })
      node.add(child)

      expect(() => (node as any).remove("child")).toThrow("remove expects a TextNodeRenderable child object")
      expect(node.children[0]).toBe(child)
    })
  })

  describe("clear Method", () => {
    it("should clear all children and change log", () => {
      const node = new TextNodeRenderable({})

      node.add("Test")
      node.add(new TextNodeRenderable({}))

      expect(node.children).toHaveLength(2)

      node.clear()

      expect(node.children).toEqual([])
    })
  })

  describe("Style Inheritance and Merging", () => {
    it("should merge styles with parent styles", () => {
      const node = new TextNodeRenderable({
        fg: RGBA.fromInts(255, 0, 0, 255),
        attributes: 1,
      })

      const parentStyle = {
        bg: RGBA.fromInts(0, 0, 255, 255),
        attributes: 2,
      }

      const merged = node.mergeStyles(parentStyle)

      expect(merged.fg).toEqual(RGBA.fromInts(255, 0, 0, 255))
      expect(merged.bg).toEqual(RGBA.fromInts(0, 0, 255, 255))
      expect(merged.attributes).toBe(3)
    })

    it("should inherit undefined styles from parent", () => {
      const node = new TextNodeRenderable({
        fg: RGBA.fromInts(255, 0, 0, 255),
        // bg and attributes undefined (attributes defaults to 0)
      })

      const parentStyle = {
        bg: RGBA.fromInts(0, 0, 255, 255),
        attributes: 2,
      }

      const merged = node.mergeStyles(parentStyle)

      expect(merged.fg?.r).toBe(1)
      expect(merged.fg?.g).toBe(0)
      expect(merged.fg?.b).toBe(0)
      expect(merged.bg?.r).toBe(0)
      expect(merged.bg?.g).toBe(0)
      expect(merged.bg?.b).toBe(1)
      expect(merged.attributes).toBe(2)
    })

    it("should inherit nothing when parent has no styling", () => {
      const node = new TextNodeRenderable({}) // No styles defined

      const parentStyle = {
        fg: undefined,
        bg: undefined,
        attributes: 0,
      }

      const merged = node.mergeStyles(parentStyle)

      expect(merged.fg).toBeUndefined()
      expect(merged.bg).toBeUndefined()
      expect(merged.attributes).toBe(0)
    })

    it("should combine attributes using bitwise OR", () => {
      // Test various attribute combinations
      const testCases = [
        { nodeAttrs: 0, parentAttrs: 0, expected: 0 }, // 0 | 0 = 0
        { nodeAttrs: 1, parentAttrs: 0, expected: 1 }, // 1 | 0 = 1 (bold)
        { nodeAttrs: 0, parentAttrs: 2, expected: 2 }, // 0 | 2 = 2 (italic)
        { nodeAttrs: 1, parentAttrs: 2, expected: 3 }, // 1 | 2 = 3 (bold + italic)
        { nodeAttrs: 3, parentAttrs: 4, expected: 7 }, // 3 | 4 = 7 (bold + italic + underline)
        { nodeAttrs: 7, parentAttrs: 8, expected: 15 }, // 7 | 8 = 15 (all previous + strikethrough)
      ]

      testCases.forEach(({ nodeAttrs, parentAttrs, expected }) => {
        const node = new TextNodeRenderable({ attributes: nodeAttrs })
        const parentStyle = { fg: undefined, bg: undefined, attributes: parentAttrs }

        const merged = node.mergeStyles(parentStyle)
        expect(merged.attributes).toBe(expected)
      })
    })
  })

  describe("gatherWithInheritedStyle Method", () => {
    it("should gather chunks with inherited styles", () => {
      const node = new TextNodeRenderable({
        fg: RGBA.fromInts(255, 0, 0, 255),
        bg: RGBA.fromInts(0, 0, 255, 255),
        attributes: 1,
      })

      node.add("Hello")
      node.add(" ")
      node.add("World")

      const chunks = node.gatherWithInheritedStyle()

      expect(chunks).toHaveLength(3)
      chunks.forEach((chunk) => {
        expect(chunk.fg).toEqual(RGBA.fromInts(255, 0, 0, 255))
        expect(chunk.bg).toEqual(RGBA.fromInts(0, 0, 255, 255))
        expect(chunk.attributes).toBe(1)
      })

      expect(chunks[0].text).toBe("Hello")
      expect(chunks[1].text).toBe(" ")
      expect(chunks[2].text).toBe("World")
    })

    it("should recursively gather from child TextNodes", () => {
      const parent = new TextNodeRenderable({
        fg: RGBA.fromInts(255, 0, 0, 255),
      })

      const child = new TextNodeRenderable({
        bg: RGBA.fromInts(0, 255, 0, 255),
      })

      child.add("Child")
      parent.add("Parent")
      parent.add(child)

      const chunks = parent.gatherWithInheritedStyle()

      expect(chunks).toHaveLength(2)
      expect(chunks[0].text).toBe("Parent")
      expect(chunks[0].fg).toEqual(RGBA.fromInts(255, 0, 0, 255))
      expect(chunks[0].bg).toBeUndefined()

      expect(chunks[1].text).toBe("Child")
      expect(chunks[1].fg).toEqual(RGBA.fromInts(255, 0, 0, 255)) // Inherited from parent
      expect(chunks[1].bg).toEqual(RGBA.fromInts(0, 255, 0, 255)) // Own style
    })

    it("should inherit nothing when parent has no default styling", () => {
      const parent = new TextNodeRenderable({}) // No styles

      const child = new TextNodeRenderable({}) // No styles
      child.add("Child")

      parent.add("Parent")
      parent.add(child)

      const chunks = parent.gatherWithInheritedStyle()

      expect(chunks).toHaveLength(2)
      expect(chunks[0].text).toBe("Parent")
      expect(chunks[0].fg).toBeUndefined()
      expect(chunks[0].bg).toBeUndefined()
      expect(chunks[0].attributes).toBe(0)

      expect(chunks[1].text).toBe("Child")
      expect(chunks[1].fg).toBeUndefined() // Nothing inherited
      expect(chunks[1].bg).toBeUndefined() // Nothing inherited
      expect(chunks[1].attributes).toBe(0) // Nothing inherited
    })

    it("should allow children to override parent styles independently", () => {
      const parent = new TextNodeRenderable({
        fg: RGBA.fromInts(255, 0, 0, 255),
        bg: RGBA.fromInts(0, 0, 255, 255),
        attributes: 1,
      })

      const childOverrideFg = new TextNodeRenderable({
        fg: RGBA.fromInts(0, 255, 0, 255),
      })
      childOverrideFg.add("Green Text")

      const childOverrideBg = new TextNodeRenderable({
        bg: RGBA.fromInts(255, 255, 0, 255),
      })
      childOverrideBg.add("Yellow BG")

      const childOverrideAttrs = new TextNodeRenderable({
        attributes: 2,
      })
      childOverrideAttrs.add("Italic")

      parent.add(childOverrideFg)
      parent.add(childOverrideBg)
      parent.add(childOverrideAttrs)

      const chunks = parent.gatherWithInheritedStyle()

      expect(chunks).toHaveLength(3)

      // First child: overrides fg, inherits bg and attributes
      expect(chunks[0].text).toBe("Green Text")
      expect(chunks[0].fg).toEqual(RGBA.fromInts(0, 255, 0, 255)) // Overridden
      expect(chunks[0].bg).toEqual(RGBA.fromInts(0, 0, 255, 255)) // Inherited
      expect(chunks[0].attributes).toBe(1) // Inherited

      // Second child: overrides bg, inherits fg and attributes
      expect(chunks[1].text).toBe("Yellow BG")
      expect(chunks[1].fg).toEqual(RGBA.fromInts(255, 0, 0, 255)) // Inherited
      expect(chunks[1].bg).toEqual(RGBA.fromInts(255, 255, 0, 255)) // Overridden
      expect(chunks[1].attributes).toBe(1) // Inherited

      // Third child: overrides attributes (OR'd), inherits fg and bg
      expect(chunks[2].text).toBe("Italic")
      expect(chunks[2].fg).toEqual(RGBA.fromInts(255, 0, 0, 255)) // Inherited
      expect(chunks[2].bg).toEqual(RGBA.fromInts(0, 0, 255, 255)) // Inherited
      expect(chunks[2].attributes).toBe(3) // 1 | 2 = 3
    })

    it("should support multi-level inheritance (grandparent -> parent -> child)", () => {
      const grandparent = new TextNodeRenderable({
        fg: RGBA.fromInts(255, 0, 0, 255),
        attributes: 1,
      })

      const parent = new TextNodeRenderable({
        bg: RGBA.fromInts(0, 0, 255, 255),
      })

      const child = new TextNodeRenderable({
        fg: RGBA.fromInts(0, 255, 0, 255),
        attributes: 2,
      })

      child.add("Grandchild")
      parent.add("Parent")
      parent.add(child)
      grandparent.add("Grandparent")
      grandparent.add(parent)

      const chunks = grandparent.gatherWithInheritedStyle()

      expect(chunks).toHaveLength(3)

      expect(chunks[0].text).toBe("Grandparent")
      expect(chunks[0].fg).toEqual(RGBA.fromInts(255, 0, 0, 255))
      expect(chunks[0].bg).toBeUndefined()
      expect(chunks[0].attributes).toBe(1)

      expect(chunks[1].text).toBe("Parent")
      expect(chunks[1].fg).toEqual(RGBA.fromInts(255, 0, 0, 255))
      expect(chunks[1].bg).toEqual(RGBA.fromInts(0, 0, 255, 255))
      expect(chunks[1].attributes).toBe(1)

      expect(chunks[2].text).toBe("Grandchild")
      expect(chunks[2].fg).toEqual(RGBA.fromInts(0, 255, 0, 255))
      expect(chunks[2].bg).toEqual(RGBA.fromInts(0, 0, 255, 255))
      expect(chunks[2].attributes).toBe(3)
    })

    it("should support partial style overrides in children", () => {
      const parent = new TextNodeRenderable({
        fg: RGBA.fromInts(255, 0, 0, 255),
        bg: RGBA.fromInts(0, 0, 255, 255),
        attributes: 1,
      })

      const childPartial1 = new TextNodeRenderable({
        fg: RGBA.fromInts(0, 255, 0, 255),
      })
      childPartial1.add("Green on Blue")

      const childPartial2 = new TextNodeRenderable({
        bg: RGBA.fromInts(255, 255, 0, 255),
      })
      childPartial2.add("Red on Yellow")

      const childPartial3 = new TextNodeRenderable({
        attributes: 2,
      })
      childPartial3.add("Red on Blue Bold+Italic")

      const childPartial4 = new TextNodeRenderable({
        fg: RGBA.fromInts(255, 255, 255, 255),
        attributes: 4,
      })
      childPartial4.add("White on Blue Bold+Underline")

      parent.add(childPartial1)
      parent.add(childPartial2)
      parent.add(childPartial3)
      parent.add(childPartial4)

      const chunks = parent.gatherWithInheritedStyle()

      expect(chunks).toHaveLength(4)

      // Child 1: only fg overridden
      expect(chunks[0].text).toBe("Green on Blue")
      expect(chunks[0].fg).toEqual(RGBA.fromInts(0, 255, 0, 255))
      expect(chunks[0].bg).toEqual(RGBA.fromInts(0, 0, 255, 255))
      expect(chunks[0].attributes).toBe(1)

      // Child 2: only bg overridden
      expect(chunks[1].text).toBe("Red on Yellow")
      expect(chunks[1].fg).toEqual(RGBA.fromInts(255, 0, 0, 255))
      expect(chunks[1].bg).toEqual(RGBA.fromInts(255, 255, 0, 255))
      expect(chunks[1].attributes).toBe(1)

      // Child 3: only attributes overridden (OR'd)
      expect(chunks[2].text).toBe("Red on Blue Bold+Italic")
      expect(chunks[2].fg).toEqual(RGBA.fromInts(255, 0, 0, 255))
      expect(chunks[2].bg).toEqual(RGBA.fromInts(0, 0, 255, 255))
      expect(chunks[2].attributes).toBe(3) // 1 | 2 = 3

      // Child 4: fg and attributes overridden, bg inherited
      expect(chunks[3].text).toBe("White on Blue Bold+Underline")
      expect(chunks[3].fg).toEqual(RGBA.fromInts(255, 255, 255, 255))
      expect(chunks[3].bg).toEqual(RGBA.fromInts(0, 0, 255, 255))
      expect(chunks[3].attributes).toBe(5) // 1 | 4 = 5
    })
  })

  describe("Static Factory Methods", () => {
    it("should create TextNode from string using fromString", () => {
      const node = TextNodeRenderable.fromString("Hello World", {
        fg: "#ff0000",
        attributes: 1,
      })

      expect(node.children).toEqual(["Hello World"])
      expect(node.fg?.r).toBe(1)
      expect(node.fg?.g).toBe(0)
      expect(node.fg?.b).toBe(0)
      expect(node.attributes).toBe(1)
    })

    it("should create TextNode from nodes using fromNodes", () => {
      const child1 = new TextNodeRenderable({})
      const child2 = new TextNodeRenderable({})

      child1.add("First")
      child2.add("Second")

      const parent = TextNodeRenderable.fromNodes([child1, child2], {
        fg: RGBA.fromInts(255, 255, 0, 255),
      })

      expect(parent.children).toEqual([child1, child2])
      expect(parent.fg).toEqual(RGBA.fromInts(255, 255, 0, 255))
    })
  })

  describe("Utility Methods", () => {
    it("should convert to chunks using toChunks", () => {
      const node = new TextNodeRenderable({
        fg: "#00ff00",
      })

      node.add("Test")

      const chunks = node.toChunks()

      expect(chunks).toHaveLength(1)
      expect(chunks[0].text).toBe("Test")
      expect(chunks[0].fg).toBeInstanceOf(RGBA)
      expect((chunks[0].fg as RGBA).r).toBe(0)
      expect((chunks[0].fg as RGBA).g).toBe(1)
      expect((chunks[0].fg as RGBA).b).toBe(0)
    })

    it("should get children using getChildren", () => {
      const node = new TextNodeRenderable({})

      node.add("String child")
      const textNodeChild = new TextNodeRenderable({})
      node.add(textNodeChild)

      const children = node.getChildren()

      expect(children).toHaveLength(1)
      expect(children[0]).toBe(textNodeChild)
    })

    it("should get children count", () => {
      const node = new TextNodeRenderable({})

      expect(node.getChildrenCount()).toBe(0)

      node.add("First")
      expect(node.getChildrenCount()).toBe(1)

      node.add(new TextNodeRenderable({}))
      expect(node.getChildrenCount()).toBe(2)
    })

    it("should find renderable by id", () => {
      const node = new TextNodeRenderable({})

      const child1 = new TextNodeRenderable({ id: "child1" })
      const child2 = new TextNodeRenderable({ id: "child2" })

      node.add(child1)
      node.add(child2)

      expect(node.getRenderable("child1")).toBe(child1)
      expect(node.getRenderable("child2")).toBe(child2)
      expect(node.getRenderable("nonexistent")).toBeUndefined()
    })
  })

  describe("StyledText Integration", () => {
    it("should work with template literal styled text", () => {
      const node = new TextNodeRenderable({})
      const styled = t`Hello ${red("World")} with ${bold("bold")} text!`

      node.add(styled)

      expect(node.children).toHaveLength(5) // All parts become TextNodeRenderable instances
      expect(node.children[0]).toBeInstanceOf(TextNodeRenderable)
      expect(node.children[1]).toBeInstanceOf(TextNodeRenderable)
      expect(node.children[2]).toBeInstanceOf(TextNodeRenderable)
      expect(node.children[3]).toBeInstanceOf(TextNodeRenderable)
      expect(node.children[4]).toBeInstanceOf(TextNodeRenderable)

      // Check first chunk: "Hello " (no styling)
      const helloChild = node.children[0] as TextNodeRenderable
      expect(helloChild.children).toEqual(["Hello "])
      expect(helloChild.fg).toBeUndefined()
      expect(helloChild.attributes).toBe(0)

      // Check second chunk: "World" (red styling)
      const redChild = node.children[1] as TextNodeRenderable
      expect(redChild.children).toEqual(["World"])
      expect(redChild.fg?.r).toBe(1)
      expect(redChild.fg?.g).toBe(0)
      expect(redChild.fg?.b).toBe(0)
      expect(redChild.attributes).toBe(0)

      // Check third chunk: " with " (no styling)
      const withChild = node.children[2] as TextNodeRenderable
      expect(withChild.children).toEqual([" with "])
      expect(withChild.fg).toBeUndefined()
      expect(withChild.attributes).toBe(0)

      // Check fourth chunk: "bold" (bold styling)
      const boldChild = node.children[3] as TextNodeRenderable
      expect(boldChild.children).toEqual(["bold"])
      expect(boldChild.fg).toBeUndefined()
      expect(boldChild.attributes).toBe(1) // bold attribute

      // Check fifth chunk: " text!" (no styling)
      const textChild = node.children[4] as TextNodeRenderable
      expect(textChild.children).toEqual([" text!"])
      expect(textChild.fg).toBeUndefined()
      expect(textChild.attributes).toBe(0)
    })

    it("should preserve styles when converting StyledText to TextNodes", () => {
      const node = new TextNodeRenderable({})
      const styledText = new StyledText([
        {
          __isChunk: true,
          text: "Red",
          fg: RGBA.fromInts(255, 0, 0, 255),
          bg: RGBA.fromInts(0, 0, 0, 255),
          attributes: 1,
        },
        { __isChunk: true, text: "Blue", fg: RGBA.fromInts(0, 0, 255, 255), attributes: 2 },
        { __isChunk: true, text: "Green", fg: RGBA.fromInts(0, 255, 0, 255), attributes: 0 },
      ])

      node.add(styledText)

      expect(node.children).toHaveLength(3)

      const redNode = node.children[0] as TextNodeRenderable
      expect(redNode.children).toEqual(["Red"])
      expect(redNode.fg).toEqual(RGBA.fromInts(255, 0, 0, 255))
      expect(redNode.bg).toEqual(RGBA.fromInts(0, 0, 0, 255))
      expect(redNode.attributes).toBe(1)

      const blueNode = node.children[1] as TextNodeRenderable
      expect(blueNode.children).toEqual(["Blue"])
      expect(blueNode.fg).toEqual(RGBA.fromInts(0, 0, 255, 255))
      expect(blueNode.bg).toBeUndefined()
      expect(blueNode.attributes).toBe(2)

      const greenNode = node.children[2] as TextNodeRenderable
      expect(greenNode.children).toEqual(["Green"])
      expect(greenNode.fg).toEqual(RGBA.fromInts(0, 255, 0, 255))
      expect(greenNode.bg).toBeUndefined()
      expect(greenNode.attributes).toBe(0)
    })

    it("should handle empty StyledText", () => {
      const node = new TextNodeRenderable({})
      const emptyStyledText = new StyledText([])

      // Add empty StyledText
      const index = node.add(emptyStyledText)
      expect(index).toBe(0)

      // Should have no children since empty StyledText produces no TextNodes
      expect(node.children).toHaveLength(0)

      // Verify that gatherWithInheritedStyle returns empty array
      const chunks = node.gatherWithInheritedStyle()
      expect(chunks).toHaveLength(0)
    })

    it("should handle StyledText with empty text chunks", () => {
      const node = new TextNodeRenderable({})
      const styledTextWithEmptyChunks = new StyledText([
        { __isChunk: true, text: "", fg: RGBA.fromInts(255, 0, 0, 255), attributes: 1 },
        { __isChunk: true, text: "middle", fg: RGBA.fromInts(0, 255, 0, 255), attributes: 0 },
        { __isChunk: true, text: "", fg: RGBA.fromInts(0, 0, 255, 255), attributes: 2 },
      ])

      node.add(styledTextWithEmptyChunks)

      expect(node.children).toHaveLength(3)

      // First chunk: empty text with red styling
      const emptyRedNode = node.children[0] as TextNodeRenderable
      expect(emptyRedNode.children).toEqual([""])
      expect(emptyRedNode.fg).toEqual(RGBA.fromInts(255, 0, 0, 255))
      expect(emptyRedNode.attributes).toBe(1)

      // Second chunk: "middle" with green styling
      const middleNode = node.children[1] as TextNodeRenderable
      expect(middleNode.children).toEqual(["middle"])
      expect(middleNode.fg).toEqual(RGBA.fromInts(0, 255, 0, 255))
      expect(middleNode.attributes).toBe(0)

      // Third chunk: empty text with blue styling
      const emptyBlueNode = node.children[2] as TextNodeRenderable
      expect(emptyBlueNode.children).toEqual([""])
      expect(emptyBlueNode.fg).toEqual(RGBA.fromInts(0, 0, 255, 255))
      expect(emptyBlueNode.attributes).toBe(2)
    })
  })

  describe("Link Inheritance", () => {
    it("should inherit link from parent to child", () => {
      const parent = new TextNodeRenderable({
        link: { url: "https://opentui.com" },
      })

      const child = new TextNodeRenderable({})
      child.add("Child text")

      parent.add("Parent text")
      parent.add(child)

      const chunks = parent.gatherWithInheritedStyle()

      expect(chunks).toHaveLength(2)
      expect(chunks[0].text).toBe("Parent text")
      expect(chunks[0].link?.url).toBe("https://opentui.com")

      expect(chunks[1].text).toBe("Child text")
      expect(chunks[1].link?.url).toBe("https://opentui.com")
    })

    it("should allow child to override parent link", () => {
      const parent = new TextNodeRenderable({
        link: { url: "https://parent.com" },
      })

      const child = new TextNodeRenderable({
        link: { url: "https://child.com" },
      })
      child.add("Child text")

      parent.add("Parent text")
      parent.add(child)

      const chunks = parent.gatherWithInheritedStyle()

      expect(chunks).toHaveLength(2)
      expect(chunks[0].link?.url).toBe("https://parent.com")
      expect(chunks[1].link?.url).toBe("https://child.com")
    })

    it("should inherit link through multiple nesting levels", () => {
      const grandparent = new TextNodeRenderable({
        link: { url: "https://example.com" },
      })

      const parent = new TextNodeRenderable({})
      const child = new TextNodeRenderable({})

      child.add("Grandchild")
      parent.add(child)
      grandparent.add(parent)

      const chunks = grandparent.gatherWithInheritedStyle()

      expect(chunks).toHaveLength(1)
      expect(chunks[0].text).toBe("Grandchild")
      expect(chunks[0].link?.url).toBe("https://example.com")
    })

    it("should merge link with other styles", () => {
      const parent = new TextNodeRenderable({
        fg: RGBA.fromInts(255, 0, 0, 255),
        attributes: 1,
        link: { url: "https://opentui.com" },
      })

      const child = new TextNodeRenderable({
        bg: RGBA.fromInts(0, 0, 255, 255),
        attributes: 2,
      })
      child.add("Styled linked text")

      parent.add(child)

      const chunks = parent.gatherWithInheritedStyle()

      expect(chunks).toHaveLength(1)
      expect(chunks[0].text).toBe("Styled linked text")
      expect(chunks[0].fg).toEqual(RGBA.fromInts(255, 0, 0, 255))
      expect(chunks[0].bg).toEqual(RGBA.fromInts(0, 0, 255, 255))
      expect(chunks[0].attributes).toBe(3) // 1 | 2
      expect(chunks[0].link?.url).toBe("https://opentui.com")
    })

    it("should handle undefined link in parent", () => {
      const parent = new TextNodeRenderable({})

      const child = new TextNodeRenderable({
        link: { url: "https://child.com" },
      })
      child.add("Child with link")

      parent.add("Parent without link")
      parent.add(child)

      const chunks = parent.gatherWithInheritedStyle()

      expect(chunks).toHaveLength(2)
      expect(chunks[0].link).toBeUndefined()
      expect(chunks[1].link?.url).toBe("https://child.com")
    })

    it("should preserve link when merging styles", () => {
      const node = new TextNodeRenderable({
        link: { url: "https://example.com" },
        attributes: 1,
      })

      const parentStyle = {
        fg: RGBA.fromInts(255, 0, 0, 255),
        bg: undefined,
        attributes: 2,
      }

      const merged = node.mergeStyles(parentStyle)

      expect(merged.link?.url).toBe("https://example.com")
      expect(merged.fg).toEqual(RGBA.fromInts(255, 0, 0, 255))
      expect(merged.attributes).toBe(3)
    })

    it("should inherit link when node has no link", () => {
      const node = new TextNodeRenderable({
        fg: RGBA.fromInts(0, 255, 0, 255),
      })

      const parentStyle = {
        fg: undefined,
        bg: undefined,
        attributes: 0,
        link: { url: "https://inherited.com" },
      }

      const merged = node.mergeStyles(parentStyle)

      expect(merged.link?.url).toBe("https://inherited.com")
      expect(merged.fg).toEqual(RGBA.fromInts(0, 255, 0, 255))
    })

    it("should handle complex link inheritance tree", () => {
      // Grandparent with link
      const grandparent = new TextNodeRenderable({
        link: { url: "https://grandparent.com" },
        fg: RGBA.fromInts(255, 0, 0, 255),
      })

      // Parent inherits link, adds bg
      const parent = new TextNodeRenderable({
        bg: RGBA.fromInts(0, 0, 255, 255),
      })

      // Child1 inherits link, overrides fg
      const child1 = new TextNodeRenderable({
        fg: RGBA.fromInts(0, 255, 0, 255),
      })
      child1.add("Child1")

      // Child2 overrides link
      const child2 = new TextNodeRenderable({
        link: { url: "https://child2.com" },
      })
      child2.add("Child2")

      // Child3 has no link set, should inherit from parent
      const child3 = new TextNodeRenderable({
        attributes: 1,
      })
      child3.add("Child3")

      parent.add(child1)
      parent.add(child2)
      parent.add(child3)
      grandparent.add(parent)

      const chunks = grandparent.gatherWithInheritedStyle()

      expect(chunks).toHaveLength(3)

      // Child1: inherits link from grandparent
      expect(chunks[0].text).toBe("Child1")
      expect(chunks[0].link?.url).toBe("https://grandparent.com")
      expect(chunks[0].fg).toEqual(RGBA.fromInts(0, 255, 0, 255))

      // Child2: overrides link
      expect(chunks[1].text).toBe("Child2")
      expect(chunks[1].link?.url).toBe("https://child2.com")

      // Child3: inherits link from grandparent
      expect(chunks[2].text).toBe("Child3")
      expect(chunks[2].link?.url).toBe("https://grandparent.com")
    })
  })

  describe("Edge Cases and Error Handling", () => {
    it("should handle empty strings", () => {
      const node = new TextNodeRenderable({})

      node.add("")
      node.add(" ")

      const chunks = node.gatherWithInheritedStyle()
      expect(chunks).toHaveLength(2)
      expect(chunks[0].text).toBe("")
      expect(chunks[1].text).toBe(" ")
    })

    it("should handle nested empty TextNodes", () => {
      const parent = new TextNodeRenderable({})
      const child = new TextNodeRenderable({})

      parent.add(child)

      const chunks = parent.gatherWithInheritedStyle()
      expect(chunks).toHaveLength(0)
    })

    it("should handle multiple operations in sequence", () => {
      const node = new TextNodeRenderable({})

      // Add multiple items
      for (let i = 0; i < 5; i++) {
        node.add(`Item ${i}`)
      }

      expect(node.children).toHaveLength(5)

      // Clear and verify
      node.clear()
      expect(node.children).toHaveLength(0)
    })

    it("should efficiently calculate positions for large trees", () => {
      const root = new TextNodeRenderable({})

      // Add many children to test position calculation efficiency
      for (let i = 0; i < 10; i++) {
        const child = new TextNodeRenderable({})
        for (let j = 0; j < 5; j++) {
          child.add(`Child ${i}-${j}`)
        }
        root.add(child)
      }

      // Insert before the 5th child - should be efficient
      const fifthChild = root.children[4] as TextNodeRenderable
      const insertChild = new TextNodeRenderable({})
      insertChild.add("Inserted")

      const startTime = performance.now()
      root.insertBefore(insertChild, fifthChild)
      const endTime = performance.now()

      // Should complete quickly (less than 1ms for this small tree)
      expect(endTime - startTime).toBeLessThan(1)

      // Verify correct position
      expect(root.children.indexOf(insertChild)).toBe(4)
    })
  })
})
