import { afterAll, beforeAll, expect, test } from "bun:test"
import { isDeepStrictEqual } from "node:util"
import * as core from "../index.js"
import { CliRenderEvents, Renderable, RGBA, SyntaxStyle, TabSelectRenderable } from "../index.js"
import { createTestRenderer, type TestRenderer } from "../testing/test-renderer.js"
import { Edge, Gutter } from "../yoga.js"

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

// Accepted, but the value after a nullish write follows `main` instead of the constructor default. Key as above.
const mainResults: Record<string, string> = {
  scrollSpeed: "Math.max(0, value)",
  flexShrink: "1, not the 0 that a numeric width or height selects",
  "LineNumberRenderable.flexDirection": "column, not the class default row",
  "ScrollBoxRenderable.flexDirection": "column, not the class default row",
  "ScrollBarRenderable.alignSelf": "auto, not the class default stretch",
  "TimeToFirstDrawRenderable.alignSelf": "auto, not the class default center",
  "ScrollBarRenderable.scrollSize": "a size write runs auto-hide, which the constructor does not",
  "ScrollBarRenderable.viewportSize": "a size write runs auto-hide, which the constructor does not",
  "DiffRenderable.view": "stores null, which lays out as a row",
  "TabSelectRenderable.showDescription": "stores null, which hides the description",
  "TabSelectRenderable.showUnderline": "stores null, which hides the underline",
}

// The constructor and `main` map `null` (not `undefined`) to these values.
const nullResults: Record<string, unknown> = { opacity: 0 }

// A non-default value per prop whose getter gives none; booleans, numbers, and colors derive one from their default.
const samples: Record<string, unknown> = {
  titleAlignment: "center",
  bottomTitleAlignment: "right",
  textAlign: "center",
  wrapMode: "none",
  orientation: "vertical",
  direction: "left",
  cursorStyle: { style: "line", blinking: false },
  flexDirection: "row",
  flexWrap: "wrap",
  alignItems: "center",
  alignSelf: "center",
  justifyContent: "center",
  position: "absolute",
  overflow: "hidden",
  ...Object.fromEntries(
    `top right bottom left minWidth minHeight maxWidth maxHeight flexBasis flexGrow gap rowGap columnGap margin marginX
    marginY marginTop marginRight marginBottom marginLeft padding paddingX paddingY paddingTop paddingRight paddingBottom
    paddingLeft`
      .split(/\s+/)
      .map((prop) => [prop, 1]),
  ),
}

const edges = [Edge.Left, Edge.Top, Edge.Right, Edge.Bottom, Edge.Horizontal, Edge.Vertical, Edge.All]
const styleGetters = `getWidth getHeight getMinWidth getMinHeight getMaxWidth getMaxHeight getFlexBasis getFlexGrow
  getFlexShrink getFlexDirection getFlexWrap getAlignItems getAlignSelf getJustifyContent getPositionType`.split(
  /\s+/,
) as (keyof Renderable)[]

// Declared Yoga style and the box from the last layout pass. Prop getters do not show them.
function layoutState(node: Renderable): unknown[] {
  return [
    node.getLayout(),
    styleGetters.map((name) => (node[name] as () => unknown)()),
    edges.map((edge) => [node.getMargin(edge), node.getPadding(edge)]),
    [Gutter.Column, Gutter.Row, Gutter.All].map((gutter) => node.getGap(gutter)),
  ]
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

function classOptions(name: string, style = syntaxStyle): object {
  const options: Record<string, object> = {
    ArrowRenderable: { direction: "right" },
    CodeRenderable: { content: "let a = 1", syntaxStyle: style },
    DiffRenderable: { diff: "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n" },
    MarkdownRenderable: { content: "# hi", syntaxStyle: style },
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

function listed(list: Record<string, unknown>, name: string, prop: string): boolean {
  return prop in list || `${name}.${prop}` in list
}

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
  if (prop in samples) return samples[prop]
  if (typeof fallback === "boolean") return !fallback
  if (typeof fallback === "number") return fallback === 0 ? 1 : fallback / 2
  if (fallback instanceof RGBA) return RGBA.fromInts(10, 20, 30)
  return fallback
}

test.each(renderableClasses)("%s setters accept null and undefined", async (name, RenderableClass) => {
  const failures: string[] = []
  const options = classOptions(name)
  const fresh = new RenderableClass(renderer, classOptions(name))
  const props = publicSetters(fresh).filter((prop) => !listed(excludedProps, name, prop))
  expect(props.length).toBeGreaterThan(0)
  for (const prop of props) {
    const fallback = read(fresh, prop)
    const value = sample(prop, fallback)
    // Each nullish write after the first follows the sample, so a setter that ignores it keeps the sample.
    const writes = [null, value, undefined, value, null]
    const reads: unknown[] = []
    const states: unknown[] = []
    const node = new RenderableClass(renderer, classOptions(name))
    renderer.root.add(node)
    // Focus-only colors paint only while focused.
    node.focus()
    await renderOnce()
    const initial = layoutState(node)
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
      states.push(layoutState(node))
    }
    node.destroyRecursively()
    // Check the reset only where the fresh value is the default.
    if (prop in options || listed(mainResults, name, prop)) continue
    for (const index of [0, 2, 4]) {
      if (index < states.length && !isDeepStrictEqual(states[index], initial)) {
        failures.push(`${prop} = ${writes[index]}: layout style differs from the constructor default`)
      }
    }
    // The getter check also needs a getter that returns the written value.
    if (reads.length < writes.length || !isDeepStrictEqual(reads[1], writes[1])) continue
    for (const index of [0, 2, 4]) {
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

// Frameworks write props while they unmount, also after the renderer is destroyed. As on `main`, a destroyed
// renderable ignores them. Listed: subclass setters and methods that call the scene or a native resource directly and
// still need their own guard (owner unit in the comment).
const editorSetters = ["cursorOffset", "selectionOccupancy", "syntaxStyle"] // U21: threw on `main` too
const throwsAfterDestroy: Record<string, string[]> = {
  CodeRenderable: ["scrollX", "scrollY"], // threw on `main` too (U20 Also-on-main)
  TextBufferRenderable: ["scrollX", "scrollY"], // threw on `main` too (U20 Also-on-main)
  TextRenderable: ["content", "scrollX", "scrollY"], // threw on `main` too (U20 Also-on-main)
  EditBufferRenderable: [...editorSetters, "backgroundColor", "textColor"], // threw on `main` too (U21 Also-on-main)
  InputRenderable: [...editorSetters, "maxLength", "value", "focus()"], // threw on `main` too (U21 Also-on-main)
  TextareaRenderable: editorSetters, // threw on `main` too (U21 Also-on-main)
}

function writeAfterDestroy(node: Renderable, writes: [string, unknown[]][], skipped: string[] = []): string[] {
  const failures: string[] = []
  const attempt = (label: string, action: () => unknown) => {
    if (skipped.includes(label)) return
    try {
      action()
    } catch (error) {
      failures.push(`${label}: ${error}`)
    }
  }
  for (const [prop, values] of writes) {
    for (const value of values) attempt(`${prop} = ${value}`, () => Reflect.set(node, prop, value))
  }
  attempt("focus()", () => node.focus())
  attempt("blur()", () => node.blur())
  attempt("requestRender()", () => node.requestRender())
  attempt("setPosition()", () => node.setPosition({ left: 1 }))
  attempt("setMeasureProvider()", () => node.setMeasureProvider(null))
  attempt("invalidateIntrinsicSize()", () => node.invalidateIntrinsicSize())
  attempt("primaryAxis", () => node.primaryAxis)
  attempt("marginTop", () => node.marginTop)
  attempt("getChildrenSortedByPrimaryAxis()", () => node.getChildrenSortedByPrimaryAxis())
  return failures
}

test.each(renderableClasses)("%s ignores writes after destroy", async (name, RenderableClass) => {
  const skipped = throwsAfterDestroy[name] ?? []
  const fresh = new RenderableClass(renderer, classOptions(name))
  const writes = publicSetters(fresh)
    .filter((prop) => !skipped.includes(prop))
    .map((prop): [string, unknown[]] => {
      const value = sample(prop, read(fresh, prop))
      // Without a default, only a value read from the node is known to be valid.
      return [prop, !listed(excludedProps, name, prop) ? [value, null] : value == null ? [] : [value]]
    })
  fresh.destroyRecursively()

  const node = new RenderableClass(renderer, classOptions(name))
  renderer.root.add(node)
  node.focus()
  await renderOnce()
  node.destroyRecursively()
  const failures = writeAfterDestroy(node, writes, skipped).map((failure) => `destroyed: ${failure}`)
  await renderOnce()
  expect(frameErrors.splice(0)).toEqual([])

  const other = (await createTestRenderer({ width: 24, height: 8 })).renderer
  const orphan = new RenderableClass(other, classOptions(name, SyntaxStyle.create(other.nativeScene)))
  other.root.add(orphan)
  other.destroy()
  failures.push(...writeAfterDestroy(orphan, writes, skipped).map((failure) => `renderer destroyed: ${failure}`))
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
