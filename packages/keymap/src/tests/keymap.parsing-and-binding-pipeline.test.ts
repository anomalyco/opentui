import { Buffer } from "node:buffer"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { BoxRenderable, KeyEvent, type Renderable } from "@opentui/core"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import * as addons from "../addons/index.js"
import {
  stringifyKeySequence,
  stringifyKeyStroke,
  type ActiveKey,
  type ActiveKeyOptions,
  type BindingParser,
  type ErrorEvent,
  type EventMatchResolverContext,
  type Keymap,
  type ReactiveMatcher,
  type WarningEvent,
} from "../index.js"
import { createDefaultOpenTuiKeymap, createOpenTuiKeymap } from "../opentui.js"
import { createDiagnosticHarness } from "./diagnostic-harness.js"
import { createKeymapTestHelpers, type OpenTuiKeymap } from "./keymap.test-support.js"

let renderer: TestRenderer
let mockInput: MockInput
const diagnostics = createDiagnosticHarness()
const {
  createFocusableBox,
  getActiveKey,
  getActiveKeyNames,
  getParserKeymap,
  getKeymap,
  createBareKeymap,
  getCommand,
  getCommandEntry,
  getActiveKeyDisplay,
  captureDiagnostics,
  matchEventAs,
  createBracketTokenParser,
  createReactiveBoolean,
} = createKeymapTestHelpers(diagnostics, () => renderer)

describe("keymap: parsing and binding pipeline", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })
  test("prefers direct stroke matches over registered fallback strokes", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendEventMatchResolver((event, ctx) => {
      if (event.name !== "x") {
        return undefined
      }

      return [matchEventAs(ctx, event, "y")]
    })

    keymap.registerLayer({
      commands: [
        {
          name: "fallback",
          run() {
            calls.push("fallback")
          },
        },
        {
          name: "direct",
          run() {
            calls.push("direct")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [
        { key: "y", cmd: "fallback" },
        { key: "x", cmd: "direct" },
      ],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["direct"])
  })

  test("matches ctrl+space from Kitty keyboard protocol", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "leader",
          run() {
            calls.push("leader")
          },
        },
      ],
    })
    keymap.registerLayer({ bindings: [{ key: "ctrl+space", cmd: "leader" }] })

    renderer.stdin.emit("data", Buffer.from("\x1b[32;5u"))

    expect(calls).toEqual(["leader"])
  })

  test("prefers lower-layer direct strokes over higher-layer fallback strokes", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendEventMatchResolver((event, ctx) => {
      if (event.name !== "x") return undefined
      return [matchEventAs(ctx, event, "y")]
    })

    keymap.registerLayer({
      commands: [
        {
          name: "direct",
          run() {
            calls.push("direct")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "direct" }],
    })
    keymap.registerLayer({
      commands: [
        {
          name: "fallback",
          run() {
            calls.push("fallback")
          },
        },
      ],
      bindings: [{ key: "y", cmd: "fallback" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["direct"])
  })

  test("keeps higher-layer direct strokes ahead of lower-layer direct strokes", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "lower",
          run() {
            calls.push("lower")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "lower" }],
    })
    keymap.registerLayer({
      commands: [
        {
          name: "higher",
          run() {
            calls.push("higher")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "higher" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["higher"])
  })

  test("uses fallback strokes when no direct stroke is reachable", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendEventMatchResolver((event, ctx) => {
      if (event.name !== "x") return undefined
      return [matchEventAs(ctx, event, "y")]
    })

    keymap.registerLayer({
      enabled: false,
      commands: [
        {
          name: "direct",
          run() {
            calls.push("direct")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "direct" }],
    })
    keymap.registerLayer({
      commands: [
        {
          name: "fallback",
          run() {
            calls.push("fallback")
          },
        },
      ],
      bindings: [{ key: "y", cmd: "fallback" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["fallback"])
  })

  test("prefers direct strokes over higher-layer fallback sequence prefixes", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendEventMatchResolver((event, ctx) => {
      if (event.name !== "x") return undefined
      return [matchEventAs(ctx, event, "g")]
    })

    keymap.registerLayer({
      commands: [
        {
          name: "direct",
          run() {
            calls.push("direct")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "direct" }],
    })
    keymap.registerLayer({
      commands: [
        {
          name: "fallback-sequence",
          run() {
            calls.push("fallback-sequence")
          },
        },
      ],
      bindings: [{ key: "ga", cmd: "fallback-sequence" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["direct"])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("supports pending-sequence dispatch through registered fallback strokes", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendEventMatchResolver((event, ctx) => {
      if (event.name !== "x") {
        return undefined
      }

      return [matchEventAs(ctx, event, "g")]
    })

    keymap.registerLayer({
      commands: [
        {
          name: "delete-line",
          run() {
            calls.push("delete-line")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "ga", cmd: "delete-line" }],
    })

    mockInput.pressKey("x")
    expect(stringifyKeySequence(keymap.getPendingSequence(), { preferDisplay: true })).toBe("g")

    mockInput.pressKey("a")

    expect(calls).toEqual(["delete-line"])
    expect(keymap.getPendingSequence()).toEqual([])
  })

  test("supports custom binding parsers ahead of the default parser", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.prependBindingParser(createBracketTokenParser())

    keymap.registerToken({ name: "leader", key: { name: "x", ctrl: true } })
    keymap.registerLayer({
      commands: [
        {
          name: "leader-action",
          run() {
            calls.push("leader")
          },
        },
      ],
    })
    keymap.registerLayer({
      bindings: [{ key: "[leader]d", cmd: "leader-action" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("d")

    expect(calls).toEqual(["leader"])
  })

  test("clearBindingParsers allows replacing the default parser", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.clearBindingParsers()
    keymap.appendBindingParser(createBracketTokenParser())

    keymap.registerToken({ name: "leader", key: { name: "x", ctrl: true } })
    keymap.registerLayer({
      commands: [
        {
          name: "leader-only",
          run() {
            calls.push("leader")
          },
        },
      ],
    })
    keymap.registerLayer({
      bindings: [{ key: "[leader]", cmd: "leader-only" }],
    })

    mockInput.pressKey("x", { ctrl: true })

    expect(calls).toEqual(["leader"])
  })

  test("createKeyMatcher uses the keymap's current parser and token configuration", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = captureDiagnostics(keymap)

    keymap.clearBindingParsers()
    keymap.appendBindingParser(createBracketTokenParser({ preserveDisplayCase: true }))
    keymap.appendBindingParser(addons.defaultBindingParser)

    keymap.registerLayer({
      commands: [
        {
          name: "case-token",
          run() {},
        },
      ],
    })
    keymap.registerLayer({
      bindings: [{ key: "[Leader]d", cmd: "case-token" }],
    })

    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Unknown token "leader" in key sequence "[Leader]d"; binding was skipped until the token is registered',
    ])

    keymap.registerToken({ name: "leader", key: { name: "x", ctrl: true } })

    const matchesLeader = keymap.createKeyMatcher("[Leader]")

    mockInput.pressKey("x", { ctrl: true })

    const [head] = keymap.getPendingSequence()
    expect(matchesLeader(head)).toBe(true)
  })

  test("clearEventMatchResolvers disables default event matching until custom resolvers are added", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "run",
          run() {
            calls.push("run")
          },
        },
      ],
    })
    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "run" }],
    })

    keymap.clearEventMatchResolvers()
    mockInput.pressKey("x")
    expect(calls).toEqual([])

    keymap.appendEventMatchResolver((event, ctx) => {
      if (event.name !== "x") {
        return undefined
      }

      return [matchEventAs(ctx, event, "x")]
    })

    mockInput.pressKey("x")
    expect(calls).toEqual(["run"])
  })

  test("can dispose registered event match resolvers", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    const offResolver = keymap.appendEventMatchResolver((event, ctx) => {
      if (event.name !== "x") {
        return undefined
      }

      return [matchEventAs(ctx, event, "y")]
    })

    keymap.registerLayer({
      commands: [
        {
          name: "fallback",
          run() {
            calls.push("fallback")
          },
        },
      ],
    })
    keymap.registerLayer({
      bindings: [{ key: "y", cmd: "fallback" }],
    })

    mockInput.pressKey("x")
    expect(calls).toEqual(["fallback"])

    offResolver()

    mockInput.pressKey("x")
    expect(calls).toEqual(["fallback"])
  })

  test("prependEventMatchResolver runs before appended resolvers", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendEventMatchResolver((event, ctx) => {
      if (event.name !== "x") {
        return undefined
      }

      return [matchEventAs(ctx, event, "y")]
    })
    keymap.prependEventMatchResolver((event, ctx) => {
      if (event.name !== "x") {
        return undefined
      }

      return [matchEventAs(ctx, event, "z")]
    })

    keymap.registerLayer({
      commands: [
        {
          name: "fallback",
          run() {
            calls.push("fallback")
          },
        },
      ],
    })
    keymap.registerLayer({
      bindings: [{ key: "z", cmd: "fallback" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["fallback"])
  })

  test("matches bindings using parser-provided opaque parser matches", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.prependBindingParser(({ input, index, createMatch, parseObjectKey }) => {
      if (index !== 0 || input !== "@") {
        return undefined
      }

      return {
        parts: [
          parseObjectKey(
            { name: "custom-visible", ctrl: false, shift: false, meta: false, super: false },
            { display: "custom-visible", match: createMatch("custom:stroke") },
          ),
        ],
        nextIndex: input.length,
      }
    })

    keymap.appendEventMatchResolver((event, ctx) => {
      if (event.name !== "x") {
        return undefined
      }

      return [ctx.resolveKey("@")]
    })

    keymap.registerLayer({
      commands: [
        {
          name: "custom-match",
          run() {
            calls.push("custom")
          },
        },
      ],
    })
    keymap.registerLayer({
      bindings: [{ key: "@", cmd: "custom-match" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["custom"])
    expect(getActiveKey(keymap, "custom-visible")?.display).toBe("custom-visible")
  })

  test("supports binding expanders that split one key definition into multiple bindings", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendBindingExpander(({ input }) => {
      if (!input.includes(",")) {
        return undefined
      }

      return input
        .split(",")
        .map((candidate) => candidate.trim())
        .filter(Boolean)
        .map((key) => ({ key }))
    })

    keymap.registerLayer({
      commands: [
        {
          name: "split-command",
          run() {
            calls.push("split")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x, y", cmd: "split-command" }],
    })

    expect(getActiveKeyNames(keymap)).toEqual(["x", "y"])

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["split", "split"])
  })

  test("binding expanders can preserve display metadata", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendBindingExpander(({ input }) => {
      if (input !== "alias-x") {
        return undefined
      }

      return [{ key: "ctrl+x", displays: ["alias-x"] }]
    })

    keymap.registerLayer({
      commands: [
        {
          name: "alias-command",
          run() {
            calls.push("alias")
          },
        },
      ],
      bindings: [{ key: "alias-x", cmd: "alias-command" }],
    })

    const activeKey = getActiveKey(keymap, "x")
    expect(activeKey?.stroke.ctrl).toBe(true)
    expect(activeKey?.display).toBe("alias-x")

    mockInput.pressKey("x", { ctrl: true })
    expect(calls).toEqual(["alias"])
  })

  test("skips bindings when expansion display count does not match the parsed sequence", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.appendBindingExpander(({ input }) => {
      if (input !== "alias") {
        return undefined
      }

      return [{ key: "xy", displays: ["alias"] }]
    })

    expect(() => {
      keymap.registerLayer({
        bindings: [{ key: "alias", cmd() {} }],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual([
      'Keymap binding expansion displays length must match parsed sequence length for "xy"',
    ])
    expect(keymap.getActiveKeys()).toEqual([])
  })

  test("supports prepending binding expanders ahead of appended expanders", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendBindingExpander(({ input }) => {
      if (!input.includes(",")) {
        return undefined
      }

      return input
        .split(",")
        .map((candidate) => candidate.trim())
        .filter(Boolean)
        .map((key) => ({ key }))
    })
    keymap.prependBindingExpander(({ input }) => {
      if (!input.includes("~")) {
        return undefined
      }

      return [{ key: input.replaceAll("~", "") }]
    })

    keymap.registerLayer({
      commands: [
        {
          name: "prepend-append",
          run() {
            calls.push("hit")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "~x,~y", cmd: "prepend-append" }],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["hit", "hit"])
  })

  test("prependBindingTransformer runs before appended transformers", () => {
    const keymap = getKeymap(renderer)
    const transformerOrder: string[] = []

    keymap.appendBindingTransformer((binding, ctx) => {
      transformerOrder.push("append")
      ctx.add({ ...binding, sequence: [ctx.parseKey("y")] })
      ctx.skipOriginal()
    })
    keymap.prependBindingTransformer((binding, ctx) => {
      transformerOrder.push("prepend")
      ctx.add({ ...binding, sequence: [ctx.parseKey("x")] })
      ctx.skipOriginal()
    })

    keymap.registerLayer({ commands: [{ name: "submit", run() {} }] })

    keymap.registerLayer({
      bindings: [{ key: "z", cmd: "submit" }],
    })

    expect(transformerOrder).toEqual(["prepend", "append"])
  })

  test("prependLayerBindingsTransformer runs before appended layer binding transformers", () => {
    const keymap = getKeymap(renderer)
    const transformerOrder: string[] = []

    keymap.appendLayerBindingsTransformer((bindings) => {
      transformerOrder.push("append")
      return bindings.map((binding) => ({ ...binding, cmd: "append" }))
    })
    keymap.prependLayerBindingsTransformer((bindings) => {
      transformerOrder.push("prepend")
      return bindings.map((binding) => ({ ...binding, cmd: "prepend" }))
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "original" }],
    })

    expect(transformerOrder).toEqual(["prepend", "append"])
  })

  test("clearBindingTransformers removes registered binding transformers", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendBindingTransformer((binding, ctx) => {
      ctx.add({ ...binding, sequence: [ctx.parseKey("x")] })
      ctx.skipOriginal()
    })
    keymap.clearBindingTransformers()

    keymap.registerLayer({
      commands: [
        {
          name: "submit",
          run() {
            calls.push("submit")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "z", cmd: "submit" }],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("z")

    expect(calls).toEqual(["submit"])
  })

  test("prependCommandTransformer runs before appended command transformers", () => {
    const keymap = getKeymap(renderer)
    const transformerOrder: string[] = []

    keymap.appendCommandTransformer(() => {
      transformerOrder.push("append")
    })
    keymap.prependCommandTransformer(() => {
      transformerOrder.push("prepend")
    })

    keymap.registerLayer({ commands: [{ name: "submit", run() {} }] })

    expect(transformerOrder).toEqual(["prepend", "append"])
  })

  test("command transformers can add commands and skip the original before command fields compile", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerCommandFields({
      summary(value, ctx) {
        ctx.attr("desc", value)
      },
    })

    keymap.appendCommandTransformer((command, ctx) => {
      if (command.alias !== "alias-submit") {
        return
      }

      ctx.add({ ...command, name: "alias-submit", summary: "Alias submit" })
      ctx.skipOriginal()
    })

    keymap.registerLayer({
      commands: [
        {
          name: "submit",
          alias: "alias-submit",
          run() {
            calls.push("submit")
          },
        },
      ],
      bindings: [{ key: "x", cmd: "alias-submit" }],
    })

    expect(keymap.getCommands({ visibility: "registered" }).map((command) => command.name)).toEqual(["alias-submit"])
    expect(getActiveKey(keymap, "x", { includeMetadata: true })?.commandAttrs).toEqual({ desc: "Alias submit" })

    mockInput.pressKey("x")

    expect(calls).toEqual(["submit"])
  })

  test("clearCommandTransformers removes registered command transformers", () => {
    const keymap = getKeymap(renderer)

    keymap.appendCommandTransformer((command, ctx) => {
      ctx.add({ ...command, name: "alias-submit" })
      ctx.skipOriginal()
    })
    keymap.clearCommandTransformers()

    keymap.registerLayer({ commands: [{ name: "submit", run() {} }] })

    expect(keymap.getCommands({ visibility: "registered" }).map((command) => command.name)).toEqual(["submit"])
  })

  test("can dispose command transformers to stop transforming future layer registrations", () => {
    const keymap = getKeymap(renderer)

    const offTransformer = keymap.appendCommandTransformer((command, ctx) => {
      if (command.alias !== "alias-submit") {
        return
      }

      ctx.add({ ...command, name: "alias-submit" })
      ctx.skipOriginal()
    })

    keymap.registerLayer({ commands: [{ name: "submit", alias: "alias-submit", run() {} }] })
    offTransformer()
    keymap.registerLayer({ commands: [{ name: "save", alias: "alias-save", run() {} }] })

    expect(keymap.getCommands({ visibility: "registered" }).map((command) => command.name)).toEqual([
      "alias-submit",
      "save",
    ])
  })

  test("clearLayerBindingsTransformers removes registered layer binding transformers", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendLayerBindingsTransformer((bindings) => {
      return bindings.map((binding) => ({ ...binding, key: "x" }))
    })
    keymap.clearLayerBindingsTransformers()

    keymap.registerLayer({
      commands: [
        {
          name: "submit",
          run() {
            calls.push("submit")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "z", cmd: "submit" }],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("z")

    expect(calls).toEqual(["submit"])
  })

  test("binding expanders can use layer fields for optional emacs-style key strings", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.registerLayerFields({
      emacsStyle(value) {
        if (typeof value !== "boolean") {
          throw new Error('Keymap layer field "emacsStyle" must be a boolean')
        }
      },
    })

    keymap.appendBindingExpander(({ input, layer }) => {
      if (layer.emacsStyle !== true) {
        return undefined
      }

      const strokes = input.trim().split(/\s+/).filter(Boolean)

      if (strokes.length <= 1) {
        return undefined
      }

      const tokenized: string[] = []
      for (const stroke of strokes) {
        const match = /^ctrl\+([a-z0-9])$/i.exec(stroke)
        if (!match || !match[1]) {
          return undefined
        }

        tokenized.push(`<c-${match[1].toLowerCase()}>`)
      }

      return [{ key: tokenized.join("") }]
    })

    keymap.registerToken({ name: "c-x", key: { name: "x", ctrl: true } })
    keymap.registerToken({ name: "c-s", key: { name: "s", ctrl: true } })
    keymap.registerLayer({
      commands: [
        {
          name: "save-buffer",
          run() {
            calls.push("save")
          },
        },
      ],
    })

    keymap.registerLayer({
      emacsStyle: true,
      bindings: [{ key: "ctrl+x ctrl+s", cmd: "save-buffer" }],
    })

    mockInput.pressKey("x", { ctrl: true })
    mockInput.pressKey("s", { ctrl: true })

    expect(calls).toEqual(["save"])

    expect(() => {
      keymap.registerLayer({
        bindings: [{ key: "ctrl+x ctrl+s", cmd: "save-buffer" }],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual(['Invalid key "ctrl+x ctrl+s": multiple key names are not supported'])
  })

  test("clearBindingExpanders allows replacing the expander chain", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendBindingExpander(({ input }) => {
      if (!input.includes(",")) {
        return undefined
      }

      return input
        .split(",")
        .map((candidate) => candidate.trim())
        .filter(Boolean)
        .map((key) => ({ key }))
    })
    keymap.clearBindingExpanders()

    keymap.appendBindingExpander(({ input }) => {
      if (!input.includes("|")) {
        return undefined
      }

      return input
        .split("|")
        .map((candidate) => candidate.trim())
        .filter(Boolean)
        .map((key) => ({ key }))
    })

    keymap.registerLayer({
      commands: [
        {
          name: "comma-command",
          run() {
            calls.push("comma")
          },
        },
        {
          name: "pipe-command",
          run() {
            calls.push("pipe")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "a,b", cmd: "comma-command" }],
    })
    keymap.registerLayer({
      bindings: [{ key: "x|y", cmd: "pipe-command" }],
    })

    mockInput.pressKey("a")
    expect(calls).toEqual([])

    mockInput.pressKey(",")
    mockInput.pressKey("b")
    mockInput.pressKey("x")
    mockInput.pressKey("y")

    expect(calls).toEqual(["comma", "pipe", "pipe"])
  })

  test("layer binding transformers run only when the layer registers", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = captureDiagnostics(keymap)
    let runs = 0

    keymap.appendLayerBindingsTransformer((bindings) => {
      runs += 1
      return bindings
    })

    keymap.registerLayer({
      bindings: [{ key: "<leader>x", cmd: "submit" }],
    })

    expect(runs).toBe(1)

    keymap.registerToken({ name: "leader", key: { name: "space" } })

    expect(runs).toBe(1)
    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Unknown token "leader" in key sequence "<leader>x"; binding was skipped until the token is registered',
    ])
  })

  test("can dispose binding transformers to stop transforming future layer registrations", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = captureDiagnostics(keymap)
    const calls: string[] = []

    const offTransformer = keymap.appendBindingTransformer((binding, ctx) => {
      if (binding.blocked !== true) {
        return
      }

      ctx.skipOriginal()
    })

    keymap.registerLayer({
      commands: [
        {
          name: "blocked",
          run() {
            calls.push("blocked")
          },
        },
        {
          name: "active",
          run() {
            calls.push("active")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", blocked: true, cmd: "blocked" }],
    })

    mockInput.pressKey("x")
    expect(calls).toEqual([])

    offTransformer()

    keymap.registerLayer({
      bindings: [{ key: "y", blocked: true, cmd: "active" }],
    })

    expect(takeWarnings().warnings).toEqual(['[Keymap] Unknown binding field "blocked" was ignored'])
    mockInput.pressKey("y")
    expect(calls).toEqual(["active"])
  })

  test("binding transformer ctx.parseKey normalizes object keys", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendBindingTransformer((binding, ctx) => {
      ctx.add({
        ...binding,
        sequence: [ctx.parseKey({ name: " RETURN " })],
      })
      ctx.skipOriginal()
    })

    keymap.registerLayer({
      commands: [
        {
          name: "submit",
          run() {
            calls.push("submit")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "submit" }],
    })

    mockInput.pressEnter()

    expect(calls).toEqual(["submit"])
    expect(getActiveKey(keymap, "return")?.display).toBe("enter")
    expect(getActiveKey(keymap, "x")).toBeUndefined()
  })

  test("binding transformer ctx.parseKey uses the current parser and token configuration", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.clearBindingParsers()
    keymap.appendBindingParser(createBracketTokenParser({ preserveDisplayCase: true }))
    keymap.appendBindingParser(addons.defaultBindingParser)

    keymap.appendBindingTransformer((binding, ctx) => {
      ctx.add({
        ...binding,
        sequence: [ctx.parseKey("[Leader]")],
      })
      ctx.skipOriginal()
    })

    keymap.registerToken({ name: "leader", key: { name: "x", ctrl: true } })
    keymap.registerLayer({
      commands: [
        {
          name: "submit",
          run() {
            calls.push("submit")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "z", cmd: "submit" }],
    })

    const activeKey = getActiveKey(keymap, "x", { includeBindings: true })

    expect(activeKey?.display).toBe("[Leader]")
    expect(activeKey?.tokenName).toBe("leader")
    expect(activeKey?.bindings?.[0]?.sequence[0]?.tokenName).toBe("leader")

    mockInput.pressKey("x", { ctrl: true })

    expect(calls).toEqual(["submit"])
  })

  test("binding parser ctx.parseObjectKey normalizes object keys", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.prependBindingParser(({ input, index, parseObjectKey }) => {
      if (index !== 0 || input !== "@") {
        return undefined
      }

      return {
        parts: [parseObjectKey({ name: " RETURN " })],
        nextIndex: input.length,
      }
    })

    keymap.registerLayer({
      commands: [
        {
          name: "submit",
          run() {
            calls.push("submit")
          },
        },
      ],
    })
    keymap.registerLayer({
      bindings: [{ key: "@", cmd: "submit" }],
    })

    mockInput.pressEnter()

    expect(calls).toEqual(["submit"])
    expect(getActiveKey(keymap, "return")?.display).toBe("enter")
  })

  test("skips bindings when a binding expander returns an empty expansion", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.appendBindingExpander(() => {
      return []
    })

    expect(() => {
      keymap.registerLayer({
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual(['Keymap binding expander must return at least one key sequence for "x"'])
    expect(getActiveKey(keymap, "x")).toBeUndefined()
  })

  test("skips bindings when a binding parser does not advance the input", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.clearBindingParsers()
    keymap.appendBindingParser(() => {
      return { parts: [], nextIndex: 0 }
    })

    expect(() => {
      keymap.registerLayer({
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual(['Keymap binding parser must advance the input for "x" at index 0'])
    expect(getActiveKey(keymap, "x")).toBeUndefined()
  })

  test("supports release dispatch through registered fallback strokes", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendEventMatchResolver((event, ctx) => {
      if (event.name !== "x") {
        return undefined
      }

      return [matchEventAs(ctx, event, "y")]
    })

    keymap.registerLayer({
      commands: [
        {
          name: "release-action",
          run() {
            calls.push("release")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "y", event: "release", cmd: "release-action" }],
    })

    renderer.keyInput.emit(
      "keyrelease",
      new KeyEvent({
        name: "x",
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        sequence: "x",
        number: false,
        raw: "x",
        eventType: "release",
        source: "raw",
      }),
    )

    expect(calls).toEqual(["release"])
  })

  test("prefers lower-layer direct release strokes over higher-layer fallback release strokes", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendEventMatchResolver((event, ctx) => {
      if (event.name !== "x") return undefined
      return [matchEventAs(ctx, event, "y")]
    })

    keymap.registerLayer({
      commands: [
        {
          name: "direct-release",
          run() {
            calls.push("direct")
          },
        },
      ],
      bindings: [{ key: "x", event: "release", cmd: "direct-release" }],
    })
    keymap.registerLayer({
      commands: [
        {
          name: "fallback-release",
          run() {
            calls.push("fallback")
          },
        },
      ],
      bindings: [{ key: "y", event: "release", cmd: "fallback-release" }],
    })

    renderer.keyInput.emit(
      "keyrelease",
      new KeyEvent({
        name: "x",
        ctrl: false,
        meta: false,
        shift: false,
        option: false,
        sequence: "x",
        number: false,
        raw: "x",
        eventType: "release",
        source: "raw",
      }),
    )

    expect(calls).toEqual(["direct"])
  })

  test("event match resolver ctx.match normalizes object keys", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendEventMatchResolver((event, ctx) => {
      if (event.name !== "x") {
        return undefined
      }

      return [ctx.resolveKey({ name: " RETURN " })]
    })

    keymap.registerLayer({
      commands: [
        {
          name: "submit",
          run() {
            calls.push("submit")
          },
        },
      ],
    })
    keymap.registerLayer({
      bindings: [{ key: "return", cmd: "submit" }],
    })

    mockInput.pressKey("x")

    expect(calls).toEqual(["submit"])
  })

  test("event match resolver ctx.match uses the current parser and token configuration", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.clearBindingParsers()
    keymap.appendBindingParser(createBracketTokenParser({ preserveDisplayCase: true }))
    keymap.appendBindingParser(addons.defaultBindingParser)

    keymap.appendEventMatchResolver((event, ctx) => {
      if (event.name !== "x" || !event.ctrl) {
        return undefined
      }

      return [ctx.resolveKey("[Leader]")]
    })

    keymap.registerToken({ name: "leader", key: { name: "z" } })
    keymap.registerLayer({
      commands: [
        {
          name: "leader-fallback",
          run() {
            calls.push("leader")
          },
        },
      ],
    })
    keymap.registerLayer({
      bindings: [{ key: "[Leader]", cmd: "leader-fallback" }],
    })

    mockInput.pressKey("x", { ctrl: true })

    expect(calls).toEqual(["leader"])
  })

  test("supports hyper key bindings", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "plain",
          run() {
            calls.push("plain")
          },
        },
        {
          name: "hyper",
          run() {
            calls.push("hyper")
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [
        { key: "x", cmd: "plain" },
        { key: "hyper+x", cmd: "hyper" },
      ],
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[27;17;120~"))
    mockInput.pressKey("x")

    expect(calls).toEqual(["hyper", "plain"])
  })

  test("treats unterminated token and pattern openers as literal sequence keys", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors, takeWarnings } = captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "literal-left-angle",
          run() {
            calls.push("x<")
          },
        },
        {
          name: "literal-left-brace",
          run() {
            calls.push("x{")
          },
        },
        {
          name: "literal-openers",
          run() {
            calls.push("openers")
          },
        },
      ],
      bindings: [
        { key: "x<", cmd: "literal-left-angle" },
        { key: "x{", cmd: "literal-left-brace" },
        { key: "<{", cmd: "literal-openers" },
      ],
    })

    mockInput.pressKey("x")
    mockInput.pressKey("<")
    mockInput.pressKey("x")
    mockInput.pressKey("{")
    mockInput.pressKey("<")
    mockInput.pressKey("{")

    expect(calls).toEqual(["x<", "x{", "openers"])
    expect(takeErrors().errors).toEqual([])
    expect(takeWarnings().warnings).toEqual([])
  })

  test("treats modified angle and brace openers as literal single-stroke bindings", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors, takeWarnings } = captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "ctrl-left-angle",
          run() {
            calls.push("ctrl+<")
          },
        },
        {
          name: "ctrl-left-brace",
          run() {
            calls.push("ctrl+{")
          },
        },
      ],
      bindings: [
        { key: "ctrl+<", cmd: "ctrl-left-angle" },
        { key: "ctrl+{", cmd: "ctrl-left-brace" },
      ],
    })

    renderer.keyInput.emit(
      "keypress",
      new KeyEvent({
        name: "<",
        ctrl: true,
        meta: false,
        shift: false,
        option: false,
        sequence: "<",
        number: false,
        raw: "<",
        eventType: "press",
        source: "raw",
      }),
    )
    renderer.keyInput.emit(
      "keypress",
      new KeyEvent({
        name: "{",
        ctrl: true,
        meta: false,
        shift: false,
        option: false,
        sequence: "{",
        number: false,
        raw: "{",
        eventType: "press",
        source: "raw",
      }),
    )

    expect(calls).toEqual(["ctrl+<", "ctrl+{"])
    expect(takeErrors().errors).toEqual([])
    expect(takeWarnings().warnings).toEqual([])
  })

  test("passes lock-state flags to command handlers", async () => {
    renderer.destroy()
    const testSetup = await createTestRenderer({ width: 40, height: 10, kittyKeyboard: true })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput

    const keymap = getKeymap(renderer)
    const calls: Array<{ capsLock: boolean; numLock: boolean }> = []

    keymap.registerLayer({
      commands: [
        {
          name: "inspect-locks",
          run({ event }) {
            calls.push({
              capsLock: event.capsLock === true,
              numLock: event.numLock === true,
            })
          },
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "a", cmd: "inspect-locks" }],
    })

    renderer.stdin.emit("data", Buffer.from("\x1b[97;193u"))

    expect(calls).toEqual([{ capsLock: true, numLock: true }])
  })
})
