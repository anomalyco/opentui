// Fragment metadata keys follow the single snapshot rule. Each install path reads chunk
// properties once, retains keys before the native call, releases them when native rejects the
// install, and releases the previous install's keys on success.
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { fragmentKeysFor, FragmentKeyRegistry } from "../lib/fragment-keys.js"
import { StyledText } from "../lib/styled-text.js"
import { TextRenderable } from "../renderables/Text.js"
import { TextTableRenderable } from "../renderables/TextTable.js"
import { TextBuffer, type TextChunk } from "../text-buffer.js"
import { createTestRenderer, type TestRenderer } from "../testing.js"
import { NativeError, NativeStatus } from "../zig.js"

const renderers: TestRenderer[] = []
const resources: { destroy(): void }[] = []
afterEach(async () => {
  for (const resource of resources.splice(0).reverse()) resource.destroy()
  for (const renderer of renderers.splice(0)) {
    renderer.destroy()
    await renderer.closed.catch(() => {})
  }
})

async function setup(width = 40, height = 6) {
  const result = await createTestRenderer({ width, height })
  renderers.push(result.renderer)
  return { ...result, registry: fragmentKeysFor(result.renderer.nativeScene.driver.context) }
}

function chunk(text: string, metadata?: unknown): TextChunk {
  return metadata === undefined ? { __isChunk: true, text } : { __isChunk: true, text, metadata }
}

/** Total live references to each value, summed over every install scope. */
function refsOf(registry: FragmentKeyRegistry, values: unknown[]): number[] {
  const internal = registry as unknown as { byKey: Map<number, { value: unknown; refs: number }> }
  return values.map((value) => {
    let refs = 0
    for (const entry of internal.byKey.values()) if (entry.value === value) refs += entry.refs
    return refs
  })
}

function nativeReject(): never {
  throw new NativeError("test", NativeStatus.InvalidArgument)
}

describe("fragment keys: registry", () => {
  test("keys are stable per value and scope, counted per reference, and wrap around past live keys", () => {
    const registry = new FragmentKeyRegistry()
    const scope = {}
    const other = {}
    const a = { id: "a" }
    const b = { id: "b" }
    const keyA = registry.retain(a, scope)
    expect(registry.retain(a, scope)).toBe(keyA)
    const keyB = registry.retain(b, scope)
    expect(keyB).not.toBe(keyA)
    // The same value in another scope gets its own key, which names that scope.
    const keyOther = registry.retain(a, other)
    expect(keyOther).not.toBe(keyA)
    expect(registry.scopeOf(keyA)).toBe(scope)
    expect(registry.scopeOf(keyOther)).toBe(other)
    registry.release(keyOther)
    expect(registry.resolve(keyA)).toBe(a)
    registry.release(keyA)
    expect(registry.resolve(keyA)).toBe(a)
    registry.release(keyA)
    expect(registry.resolve(keyA)).toBeUndefined()
    expect(registry.scopeOf(keyA)).toBeUndefined()
    registry.release(keyA)
    registry.release(0)
    expect(registry.size).toBe(1)

    // Primitive metadata works by value; undefined never reaches the registry.
    const keyNull = registry.retain(null, scope)
    expect(registry.resolve(keyNull)).toBeNull()
    registry.release(keyNull)
    expect(registry.resolve(keyNull)).toBeUndefined()

    const internal = registry as unknown as { nextKey: number }
    internal.nextKey = 0xffff_ffff
    const last = registry.retain({ id: "last" }, scope)
    expect(last).toBe(0xffff_ffff)
    const wrapped = registry.retain({ id: "wrapped" }, scope)
    expect(wrapped).toBe(1)
    // Key 2 is still live (b), so the next key skips it and reuses the released key 3.
    expect(keyB).toBe(2)
    expect(registry.retain({ id: "next" }, scope)).toBe(3)
  })
})

describe("fragment keys: snapshot reads", () => {
  test("a getter that mutates the chunk during encoding cannot split records from keys", async () => {
    const { renderer, renderOnce, registry } = await setup()
    const first = { id: "first" }
    const second = { id: "second" }
    let reads = 0
    const mutating = {
      __isChunk: true as const,
      text: "abc",
      get metadata() {
        reads++
        // A later read would see a different value; the encoder must not read it again.
        return reads === 1 ? first : second
      },
    }
    const text = new TextRenderable(renderer, { position: "absolute", left: 0, top: 0, width: 10, height: 1 })
    renderer.root.add(text)
    text.content = new StyledText([mutating as TextChunk])
    await renderOnce()
    expect(reads).toBe(1)
    expect(refsOf(registry, [first, second])).toEqual([1, 0])
    expect(renderer.getTextMetadataAt(0, 0)).toBe(first)
  })

  test("a throwing getter installs nothing and releases keys retained earlier in the same pass", async () => {
    const { renderer, renderOnce, registry } = await setup()
    const kept = { id: "kept" }
    const early = { id: "early" }
    const text = new TextRenderable(renderer, { position: "absolute", left: 0, top: 0, width: 10, height: 1 })
    renderer.root.add(text)
    text.content = new StyledText([chunk("old", kept)])
    await renderOnce()
    const throwing = {
      __isChunk: true as const,
      get text(): string {
        throw new Error("getter failed")
      },
    }
    expect(() => {
      text.content = new StyledText([chunk("new", early), throwing as unknown as TextChunk])
    }).toThrow("getter failed")
    expect(refsOf(registry, [kept, early])).toEqual([1, 0])
    await renderOnce()
    expect(renderer.getTextMetadataAt(0, 0)).toBe(kept)
    expect(text.plainText).toBe("old")
  })

  test("a TextBuffer getter failure keeps the previous content and its keys", async () => {
    const { renderer, registry } = await setup()
    const buffer = TextBuffer.create("unicode", renderer.nativeScene)
    resources.push(buffer)
    const kept = { id: "kept" }
    const early = { id: "early" }
    buffer.setStyledText(new StyledText([chunk("old", kept)]))
    const throwing = {
      __isChunk: true as const,
      text: "x",
      get fg(): never {
        throw new Error("fg getter failed")
      },
    }
    expect(() => buffer.setStyledText(new StyledText([chunk("new", early), throwing as unknown as TextChunk]))).toThrow(
      "fg getter failed",
    )
    expect(buffer.getPlainText()).toBe("old")
    expect(refsOf(registry, [kept, early])).toEqual([1, 0])
    buffer.destroy()
    expect(refsOf(registry, [kept])).toEqual([0])
  })

  test.each([
    ["text bytes", 8],
    ["URL bytes", 21],
  ] as const)(
    "a failure allocating the encoded %s releases the new keys and keeps the old content",
    async (_, size) => {
      const { renderer, registry } = await setup()
      const buffer = TextBuffer.create("unicode", renderer.nativeScene)
      resources.push(buffer)
      const kept = { id: "kept" }
      const fresh = { id: "fresh" }
      buffer.setStyledText(new StyledText([chunk("old", kept)]))
      // "new text" is 8 bytes and "https://example.com/u" is 21 bytes. Each is allocated once,
      // after every chunk was read and every key retained.
      const next = new StyledText([
        { __isChunk: true, text: "new text", metadata: fresh, link: { url: "https://example.com/u" } },
      ])
      const failure = new RangeError("encoded allocation failed")
      const original = globalThis.Uint8Array
      globalThis.Uint8Array = new Proxy(original, {
        construct(target, args) {
          if (args.length === 1 && args[0] === size) throw failure
          return Reflect.construct(target, args)
        },
      })
      try {
        expect(() => buffer.setStyledText(next)).toThrow(failure)
      } finally {
        globalThis.Uint8Array = original
      }
      expect(buffer.getPlainText()).toBe("old")
      expect(refsOf(registry, [kept, fresh])).toEqual([1, 0])
      buffer.destroy()
      expect(registry.size).toBe(0)
    },
  )
})

describe("fragment keys: native rejection", () => {
  test("scene text: a native rejection keeps the previous keys and releases the new ones", async () => {
    const { renderer, registry } = await setup()
    const lib = renderer.nativeScene.driver.renderLib as unknown as {
      opentui: { symbols: Record<string, () => number> }
    }
    const kept = { id: "kept" }
    const rejected = { id: "rejected" }
    const text = new TextRenderable(renderer, { position: "absolute", left: 0, top: 0, width: 10, height: 1 })
    renderer.root.add(text)
    text.content = new StyledText([chunk("old", kept)])
    const set = spyOn(lib.opentui.symbols, "ot_scene_set_styled_text").mockImplementation(
      () => NativeStatus.OutOfMemory,
    )
    try {
      expect(() => {
        text.content = new StyledText([chunk("new", rejected), chunk("more", kept)])
      }).toThrow(NativeError)
    } finally {
      set.mockRestore()
    }
    expect(refsOf(registry, [kept, rejected])).toEqual([1, 0])
  })

  test("TextBuffer: a native rejection keeps the previous keys and releases the new ones", async () => {
    const { renderer, registry } = await setup()
    const lib = renderer.nativeScene.driver.renderLib as unknown as {
      opentui: { symbols: Record<string, () => number> }
    }
    const buffer = TextBuffer.create("unicode", renderer.nativeScene)
    resources.push(buffer)
    const kept = { id: "kept" }
    const rejected = { id: "rejected" }
    buffer.setStyledText(new StyledText([chunk("old", kept)]))
    const set = spyOn(lib.opentui.symbols, "ot_text_buffer_set_styled_text").mockImplementation(
      () => NativeStatus.OutOfMemory,
    )
    try {
      expect(() => buffer.setStyledText(new StyledText([chunk("new", rejected)]))).toThrow(NativeError)
    } finally {
      set.mockRestore()
    }
    expect(buffer.getPlainText()).toBe("old")
    expect(refsOf(registry, [kept, rejected])).toEqual([1, 0])
    // Plain-text installs release the previous keys after native accepts them.
    buffer.setText("plain")
    expect(refsOf(registry, [kept])).toEqual([0])
  })

  test("table batch: a rejected batch keeps every cell's previous keys", async () => {
    const { renderer, renderOnce, registry } = await setup()
    const lib = renderer.nativeScene.driver.renderLib as unknown as {
      opentui: { symbols: Record<string, () => number> }
    }
    const keptA = { id: "keptA" }
    const keptB = { id: "keptB" }
    const rejected = { id: "rejected" }
    const table = new TextTableRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      content: [[[chunk("a", keptA)], [chunk("b", keptB)]]],
    })
    renderer.root.add(table)
    await renderOnce()
    const batch = spyOn(lib.opentui.symbols, "ot_text_buffer_replace_styled_batch").mockImplementation(
      () => NativeStatus.OutOfMemory,
    )
    try {
      expect(() => {
        table.content = [[[chunk("x", rejected)], [chunk("y", rejected)]]]
      }).toThrow(NativeError)
    } finally {
      batch.mockRestore()
    }
    expect(refsOf(registry, [keptA, keptB, rejected])).toEqual([1, 1, 0])
    await renderOnce()
    expect(table.getStyledTextHit(1, 1)?.metadata).toBe(keptA)
  })

  test("table fallback: an oversized batch creates new cells, and a failure releases every new key", async () => {
    const { renderer, renderOnce, registry } = await setup(40, 8)
    const lib = renderer.nativeScene.driver.renderLib as unknown as {
      opentui: { symbols: Record<string, () => number> }
    }
    const rows = 300
    const kept = { id: "kept" }
    const fresh = { id: "fresh" }
    const grid = (value: unknown, tag: string) => Array.from({ length: rows }, () => [[chunk(tag, value)]])
    const table = new TextTableRenderable(renderer, { position: "absolute", left: 0, top: 0, content: grid(kept, "a") })
    renderer.root.add(table)
    await renderOnce()
    expect(refsOf(registry, [kept])).toEqual([rows])

    // 300 changed cells exceed the batch limit, so cells are rebuilt one by one. The 200th
    // install fails: every new encoding's key is released, and the old cells keep theirs.
    let installs = 0
    const original = lib.opentui.symbols.ot_text_buffer_set_styled_text!
    const set = spyOn(lib.opentui.symbols, "ot_text_buffer_set_styled_text").mockImplementation(((
      ...args: unknown[]
    ) => {
      if (++installs === 200) return NativeStatus.OutOfMemory
      return (original as (...values: unknown[]) => number)(...args)
    }) as () => number)
    try {
      expect(() => {
        table.content = grid(fresh, "b")
      }).toThrow(NativeError)
    } finally {
      set.mockRestore()
    }
    expect(refsOf(registry, [kept, fresh])).toEqual([rows, 0])

    // Without the failure, the fallback publishes all new keys and releases the old ones.
    table.content = grid(fresh, "b")
    expect(refsOf(registry, [kept, fresh])).toEqual([0, rows])
    await renderOnce()
    expect(table.getStyledTextHit(1, 1)).toEqual({ metadata: fresh, cell: { row: 0, column: 0 } })
    table.destroy()
    expect(refsOf(registry, [fresh])).toEqual([0])
  })

  test("table: reentrant replacement during preparation is rejected and keeps both sets of keys balanced", async () => {
    const { renderer, renderOnce, registry } = await setup()
    const kept = { id: "kept" }
    const outer = { id: "outer" }
    const inner = { id: "inner" }
    const table = new TextTableRenderable(renderer, {
      position: "absolute",
      left: 0,
      top: 0,
      content: [[[chunk("a", kept)]]],
    })
    renderer.root.add(table)
    await renderOnce()
    let nested = false
    const reentrant = {
      __isChunk: true as const,
      get text() {
        if (!nested) {
          nested = true
          // A getter that replaces the table while the outer replacement is still preparing.
          table.content = [[[chunk("inner", inner)]]]
        }
        return "outer"
      },
      metadata: outer,
    }
    expect(() => {
      table.content = [[[reentrant as unknown as TextChunk]]]
    }).toThrow("TextTable changed during cell preparation")
    // The inner replacement won; the outer one kept nothing.
    expect(refsOf(registry, [kept, outer, inner])).toEqual([0, 0, 1])
    await renderOnce()
    expect(table.getStyledTextHit(1, 1)?.metadata).toBe(inner)
    table.destroy()
    expect(refsOf(registry, [inner])).toEqual([0])
  })

  test("metadata on a destination without a registry is rejected before native code", async () => {
    const { renderer } = await setup()
    const lib = renderer.nativeScene.driver.renderLib
    expect(() => lib.encodeTextBufferStyledText(new StyledText([chunk("x", { id: 1 })]))).toThrow(TypeError)
  })
})
