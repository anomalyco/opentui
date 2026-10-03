import { afterAll, beforeAll, expect, test } from "bun:test"
import { isDeepStrictEqual } from "node:util"
import * as core from "../index.js"
import { CliRenderEvents, Renderable, RGBA, SyntaxStyle, TabSelectRenderable } from "../index.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"

// React writes `null` when a prop is removed, and Solid writes `undefined` when a prop expression becomes undefined.
// Every public setter of every exported renderable accepts both, keeps frames rendering, and restores the value that
// the constructor uses when the option is omitted.

const excludedClasses: Record<string, string> = {
  RootRenderable: "one per renderer",
  SlotRenderable: "needs a framework slot registry",
}

// Key: `prop` for every class, or `Class.prop`. None of these accepted a nullish write on `main` either, unless noted.
const excludedProps: Record<string, string> = {
  renderSelf: "paint hook method, not a prop",
  onResize: "layout hook method, not a prop",
  onLayoutResize: "layout hook method, not a prop",
  onUpdate: "lifecycle method: a nullish write restores the base no-op, not a subclass override",
  keyBindings: "list without a default",
  traits: "editor traits without a default",
  cursorStyle: "style object without a default",
  options: "Select, TabSelect: option list without a default",
  "TextRenderable.content": "text without a default",
  "CodeRenderable.content": "text without a default",
  "InputRenderable.value": "text without a default",
  "ASCIIFontRenderable.text": "text without a default",
  "ASCIIFontRenderable.font": "font lookup without a default",
  "SelectRenderable.font": "font lookup without a default",
  "SliderRenderable.orientation": "required option (setter new on this branch)",
  "ArrowRenderable.direction": "required option without a default; main stored it raw, this branch rejects it",
  "TimeToFirstDrawRenderable.fg": "frame fails at paint (file has no owner unit)",
  "TimeToFirstDrawRenderable.color": "frame fails at paint (file has no owner unit)",
  "EmbeddedTerminalRenderable.focusable": "accepted, but the constructor sets focus, not the class default (U24)",
}

// Accepted, but the value after a nullish write follows `main` instead of the constructor default.
const mainResults: Record<string, string> = {
  x: "keeps the layout position",
  y: "keeps the layout position",
  scrollSpeed: "Math.max(0, value)",
}

// The constructor and `main` map `null` (not `undefined`) to these values.
const nullResults: Record<string, unknown> = { opacity: 0 }

// A non-default value per enum prop; booleans, numbers, and colors derive one from their default.
const enumSamples: Record<string, unknown> = {
  titleAlignment: "center",
  bottomTitleAlignment: "right",
  textAlign: "center",
  wrapMode: "none",
}

let renderer: TestRenderer
let renderOnce: () => Promise<void>
let captureSpans: () => unknown
let syntaxStyle: SyntaxStyle
const frameErrors: string[] = []

beforeAll(async () => {
  ;({ renderer, renderOnce, captureSpans } = await createTestRenderer({ width: 24, height: 8 }))
  syntaxStyle = SyntaxStyle.create(renderer.nativeScene)
  renderer.on(CliRenderEvents.RENDER_ERROR, (event: { error: Error }) => frameErrors.push(event.error.message))
})

afterAll(() => {
  renderer.destroy()
})

function classOptions(name: string): object {
  const options: Record<string, object> = {
    ArrowRenderable: { direction: "right" },
    CodeRenderable: { content: "let a = 1", syntaxStyle },
    DiffRenderable: { diff: "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n" },
    MarkdownRenderable: { content: "# hi", syntaxStyle },
    ScrollBarRenderable: { orientation: "vertical" },
    SelectRenderable: { options: [{ name: "a", description: "b" }] },
    SliderRenderable: { orientation: "horizontal" },
    TabSelectRenderable: { options: [{ name: "a", description: "b" }] },
    TextRenderable: { content: "hello" },
    TextTableRenderable: { content: [[[{ __isChunk: true, text: "a" }], [{ __isChunk: true, text: "b" }]]] },
  }
  return { width: 12, height: 4, ...options[name] }
}

const renderableClasses = Object.entries(core).filter(
  (entry): entry is [string, new (ctx: TestRenderer, options: object) => Renderable] =>
    typeof entry[1] === "function" && entry[1].prototype instanceof Renderable && !(entry[0] in excludedClasses),
)

function publicSetters(node: object): string[] {
  const names = new Set<string>()
  for (let proto = Object.getPrototypeOf(node); proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
      if (descriptor.set && !name.startsWith("_")) names.add(name)
    }
  }
  return [...names].sort()
}

function read(node: Renderable, prop: string): unknown {
  try {
    return (node as unknown as Record<string, unknown>)[prop]
  } catch (error) {
    return `getter threw: ${error}`
  }
}

function sample(prop: string, fallback: unknown): unknown {
  if (typeof fallback === "boolean") return !fallback
  if (typeof fallback === "number") return fallback === 0 ? 1 : fallback / 2
  if (fallback instanceof RGBA) return RGBA.fromInts(10, 20, 30)
  return enumSamples[prop] ?? fallback
}

test.each(renderableClasses)("%s setters accept null and undefined", async (name, RenderableClass) => {
  const failures: string[] = []
  const options = classOptions(name)
  const fresh = new RenderableClass(renderer, classOptions(name))
  const props = publicSetters(fresh).filter((prop) => !(prop in excludedProps) && !(`${name}.${prop}` in excludedProps))
  expect(props.length).toBeGreaterThan(0)
  for (const prop of props) {
    const fallback = read(fresh, prop)
    const writes = [null, undefined, sample(prop, fallback), null]
    const reads: unknown[] = []
    const node = new RenderableClass(renderer, classOptions(name))
    renderer.root.add(node)
    // Focus-only colors paint only while focused.
    node.focus()
    for (const value of writes) {
      try {
        ;(node as unknown as Record<string, unknown>)[prop] = value
        await renderOnce()
      } catch (error) {
        failures.push(`${prop} = ${value}: ${error}`)
        break
      }
      if (frameErrors.length > 0) {
        failures.push(`${prop} = ${value}: frame failed: ${frameErrors.splice(0).join("; ")}`)
        break
      }
      reads.push(read(node, prop))
    }
    node.destroyRecursively()
    // Check the reset only where the fresh value is the default and the getter returns the written value.
    if (prop in options || prop in mainResults) continue
    if (reads.length < writes.length || !isDeepStrictEqual(reads[2], writes[2])) continue
    for (const index of [0, 1, 3]) {
      const value = writes[index]
      const expected = value === null && prop in nullResults ? nullResults[prop] : fallback
      // A getter that returns the nullish value itself stores it raw, as `main` did.
      if (reads[index] != null && !isDeepStrictEqual(reads[index], expected)) {
        failures.push(`${prop} = ${value}: read ${String(reads[index])}, expected ${String(expected)}`)
      }
    }
  }
  fresh.destroyRecursively()
  expect(failures).toEqual([])
})

// Write-only setters have no getter for the reset check, so compare the focused frame with a fresh node instead.
test.each([{}, { textColor: "#00ff00", backgroundColor: "#0000ff" }])(
  "TabSelect focused colors reset to the constructor fallback (%j)",
  async (colors) => {
    const tabs = [
      { name: "a", description: "" },
      { name: "b", description: "" },
    ]
    const options = { width: 12, options: tabs, ...colors }
    const focusedFrame = async (node: TabSelectRenderable) => {
      renderer.root.add(node)
      node.focus()
      await renderOnce()
      const spans = captureSpans()
      node.destroyRecursively()
      return spans
    }
    const expected = await focusedFrame(new TabSelectRenderable(renderer, options))
    const node = new TabSelectRenderable(renderer, {
      ...options,
      focusedTextColor: "red",
      focusedBackgroundColor: "red",
    })
    Object.assign(node, { focusedTextColor: null, focusedBackgroundColor: undefined })
    expect(await focusedFrame(node)).toEqual(expected)
  },
)
