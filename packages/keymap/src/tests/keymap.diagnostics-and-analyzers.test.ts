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
import { getGraphSnapshot } from "../extras/graph.js"
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
  getGraphKeymap,
  createBareKeymap,
  getCommand,
  getCommandEntry,
  getActiveKeyDisplay,
  captureDiagnostics,
  matchEventAs,
  createBracketTokenParser,
  createReactiveBoolean,
} = createKeymapTestHelpers(diagnostics, () => renderer)

describe("keymap: diagnostics and analyzers", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
    mockInput = testSetup.mockInput
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })
  test("skips bindings with conflicting requirements from typed fields", () => {
    const keymap = getGraphKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.registerBindingFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
      state(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    expect(() => {
      keymap.registerLayer({
        bindings: [{ key: "x", mode: "normal", state: "visual", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual(['Conflicting keymap requirement for "vim.mode" from field state'])
    expect(getActiveKey(keymap, "x")).toBeUndefined()
  })

  test("skips layers with conflicting requirements from typed layer fields", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.registerLayerFields({
      mode(value, ctx) {
        ctx.require("vim.mode", value)
      },
      state(value, ctx) {
        ctx.require("vim.mode", value)
      },
    })

    expect(() => {
      keymap.registerLayer({
        mode: "normal",
        state: "visual",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual(['Conflicting keymap requirement for "vim.mode" from field state'])
    expect(getActiveKey(keymap, "x")).toBeUndefined()
  })

  test("skips layers with conflicting attributes from typed layer fields", () => {
    const keymap = getGraphKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.registerLayerFields({
      desc(value, ctx) {
        ctx.attr("label", value)
      },
      title(value, ctx) {
        ctx.attr("label", value)
      },
    })

    expect(() => {
      keymap.registerLayer({
        desc: "Navigation",
        title: "Navigate",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual(['Conflicting keymap attribute for "label" from field title'])
    expect(getActiveKey(keymap, "x")).toBeUndefined()
    expect(getGraphSnapshot(keymap).layers).toHaveLength(0)
  })

  test("skips bindings with conflicting attributes from typed binding fields", () => {
    const keymap = getParserKeymap()
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.registerBindingFields({
      desc(value, ctx) {
        ctx.attr("label", value)
      },
      title(value, ctx) {
        ctx.attr("label", value)
      },
    })

    expect(() => {
      keymap.registerLayer({
        bindings: [{ key: "x", desc: "Delete line", title: "Delete", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual(['Conflicting keymap attribute for "label" from field title'])
    expect(getActiveKey(keymap, "x")).toBeUndefined()
  })

  test("ignores unknown binding fields", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "noop",
          run() {
            calls.push("noop")
          },
        },
      ],
    })

    expect(() => {
      keymap.registerLayer({
        bindings: [{ key: "x", mode: "normal", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(getActiveKey(keymap, "x")).toBeDefined()

    mockInput.pressKey("x")

    expect(takeWarnings().warnings).toEqual(['[Keymap] Unknown binding field "mode" was ignored'])
    expect(calls).toEqual(["noop"])
  })

  test("ignores unknown layer fields", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.registerLayer({
      commands: [
        {
          name: "noop",
          run() {
            calls.push("noop")
          },
        },
      ],
    })

    expect(() => {
      keymap.registerLayer({
        mode: "normal",
        bindings: [{ key: "x", cmd: "noop" }],
      })
    }).not.toThrow()

    expect(getActiveKey(keymap, "x")).toBeDefined()

    mockInput.pressKey("x")

    expect(takeWarnings().warnings).toEqual(['[Keymap] Unknown layer field "mode" was ignored'])
    expect(calls).toEqual(["noop"])
  })

  test("stores raw command fields without requiring command field compilers", () => {
    const keymap = getParserKeymap()
    const calls: string[] = []

    expect(() => {
      keymap.registerLayer({
        commands: [
          {
            name: "save-file",
            desc: "Save the current file",
            usage: ":write <file>",
            tags: ["file", "write"],
            run() {
              calls.push("save-file")
            },
          },
        ],
      })
    }).not.toThrow()

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "save-file" }],
    })

    expect(getCommand(keymap, "save-file")).toMatchObject({
      name: "save-file",
      desc: "Save the current file",
      usage: ":write <file>",
      tags: ["file", "write"],
    })

    expect(getActiveKey(keymap, "x")).toBeDefined()

    mockInput.pressKey("x")

    expect(calls).toEqual(["save-file"])
  })

  test("emits warnings only for unknown binding and layer fields", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = captureDiagnostics(keymap)

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          desc: "Save the current file",
          run() {},
        },
        {
          name: "open-file",
          desc: "Open the current file",
          run() {},
        },
      ],
    })

    keymap.registerLayer({
      mode: "normal",
      bindings: [
        { key: "x", when: "normal", cmd: "save-file" },
        { key: "y", when: "insert", cmd: "open-file" },
      ],
    })

    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Unknown layer field "mode" was ignored',
      '[Keymap] Unknown binding field "when" was ignored',
    ])
  })

  test("emits unknown token warnings", () => {
    const keymap = getKeymap(renderer)
    const capture = captureDiagnostics(keymap)

    keymap.registerLayer({ commands: [{ name: "noop", run() {} }] })
    keymap.registerLayer({
      bindings: [
        { key: "<leader>x", cmd: "noop" },
        { key: "<leader>y", cmd: "noop" },
      ],
    })

    const { warnings, warningEvents } = capture.takeWarnings()
    expect(warnings).toEqual([
      '[Keymap] Unknown token "leader" in key sequence "<leader>x"; binding was skipped until the token is registered',
    ])
    expect(warningEvents).toEqual([
      {
        code: "unknown-token",
        message:
          '[Keymap] Unknown token "leader" in key sequence "<leader>x"; binding was skipped until the token is registered',
        warning: { token: "leader", sequence: "<leader>x" },
      },
    ])
  })

  test("does not warn about dead metadata-only bindings by default", () => {
    const keymap = getKeymap(renderer)
    const { warnings } = captureDiagnostics(keymap)

    keymap.registerLayer({
      bindings: [{ key: "x" }],
    })

    expect(warnings).toEqual([])
  })

  test("registerLayerAnalyzer analyzes compiled layers and can be unsubscribed", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    const off = keymap.appendLayerAnalyzer((ctx) => {
      calls.push(`${ctx.order}:${ctx.bindings.length}:${ctx.hasTokenBindings ? "tokens" : "plain"}`)
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: () => {} }],
    })

    off()

    keymap.registerLayer({
      bindings: [{ key: "y", cmd: () => {} }],
    })

    expect(calls).toEqual(["0:1:plain"])
  })

  test("prependLayerAnalyzer runs before appended analyzers", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendLayerAnalyzer(() => {
      calls.push("append")
    })
    keymap.prependLayerAnalyzer(() => {
      calls.push("prepend")
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: () => {} }],
    })

    expect(calls).toEqual(["prepend", "append"])
  })

  test("clearLayerAnalyzers removes registered analyzers", () => {
    const keymap = getKeymap(renderer)
    const calls: string[] = []

    keymap.appendLayerAnalyzer(() => {
      calls.push("analyzed")
    })
    keymap.clearLayerAnalyzers()

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: () => {} }],
    })

    expect(calls).toEqual([])
  })

  test("registerLayerAnalyzer reruns on token-driven recompilation", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings } = captureDiagnostics(keymap)
    const calls: string[] = []

    keymap.appendLayerAnalyzer((ctx) => {
      calls.push(`${ctx.order}:${ctx.bindings[0]?.sequence[0]?.display ?? "missing"}`)
    })

    keymap.registerLayer({
      bindings: [{ key: "<leader>x", cmd: () => {} }],
    })

    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Unknown token "leader" in key sequence "<leader>x"; binding was skipped until the token is registered',
    ])

    keymap.registerToken({ name: "leader", key: { name: "space" } })

    expect(calls).toEqual(["0:missing", "0:<leader>"])
  })

  test("registerLayerAnalyzer warnings flow through warning events", () => {
    const keymap = getKeymap(renderer)
    const capture = captureDiagnostics(keymap)

    keymap.appendLayerAnalyzer((ctx) => {
      ctx.warnOnce(`layer:${ctx.order}`, "layer-warning", { order: ctx.order }, `layer ${ctx.order} warning`)
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: () => {} }],
    })

    const { warnings, warningEvents } = capture.takeWarnings()
    expect(warnings).toEqual(["layer 0 warning"])
    expect(warningEvents).toEqual([{ code: "layer-warning", message: "layer 0 warning", warning: { order: 0 } }])
  })

  test("registerLayerAnalyzer errors flow through error events", () => {
    const keymap = getKeymap(renderer)
    const capture = captureDiagnostics(keymap)

    keymap.appendLayerAnalyzer(() => {
      throw new Error("analysis boom")
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: () => {} }],
    })

    const { errors, errorEvents } = capture.takeErrors()
    expect(errors).toEqual(["[Keymap] Error in layer analyzer:"])
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0]?.code).toBe("layer-analyzer-error")
    expect(errorEvents[0]?.error).toBeInstanceOf(Error)
  })

  test("emits runtime matcher failures as errors", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings, takeErrors } = captureDiagnostics(keymap)

    keymap.registerBindingFields({
      active(value, ctx) {
        if (value !== true) {
          throw new Error('Keymap binding field "active" must be true')
        }

        ctx.activeWhen(() => {
          throw new Error("boom")
        })
      },
    })

    keymap.registerLayer({ commands: [{ name: "runtime-binding", run() {} }] })
    keymap.registerLayer({
      bindings: [{ key: "x", active: true, cmd: "runtime-binding" }],
    })

    expect(() => keymap.getActiveKeys()).not.toThrow()
    expect(
      takeErrors().errors.some((message) => message.includes("Error evaluating runtime matcher from field active:")),
    ).toBe(true)
    expect(takeWarnings().warnings).toEqual([])
  })

  test("ignores thrown warning and error listeners while notifying remaining listeners", () => {
    const keymap = getKeymap(renderer)
    const warnings: string[] = []
    const errors: string[] = []

    keymap.registerLayer({ commands: [{ name: "noop", run() {} }] })

    keymap.on("warning", () => {
      throw new Error("warning listener boom")
    })
    keymap.on("warning", (event) => {
      warnings.push(event.message)
    })
    keymap.on("error", () => {
      throw new Error("error listener boom")
    })
    keymap.on("error", (event) => {
      errors.push(event.message)
    })

    expect(() => {
      keymap.registerLayer({
        mode: "normal",
        bindings: [{ key: "x", cmd: "noop" }],
      })
      keymap.registerLayer({
        bindings: [{ key: "y", cmd: "   " }],
      })
    }).not.toThrow()

    expect(warnings).toEqual(['[Keymap] Unknown layer field "mode" was ignored'])
    expect(errors).toEqual(["Invalid keymap command: command cannot be empty"])
  })

  test("can unsubscribe warning and error listeners", () => {
    const keymap = getKeymap(renderer)
    const { takeWarnings, takeErrors } = captureDiagnostics(keymap)
    const warnings: string[] = []
    const errors: string[] = []
    const originalWarn = console.warn
    const originalError = console.error
    console.warn = () => {}
    console.error = () => {}

    try {
      const offWarning = keymap.on("warning", (event) => {
        warnings.push(event.message)
      })
      const offError = keymap.on("error", (event) => {
        errors.push(event.message)
      })

      offWarning()
      offError()

      keymap.registerLayer({
        mode: "normal",
        bindings: [{ key: "x", cmd: "   " }],
      })
    } finally {
      console.warn = originalWarn
      console.error = originalError
    }

    expect(warnings).toEqual([])
    expect(errors).toEqual([])
    expect(takeWarnings().warnings).toEqual(['[Keymap] Unknown layer field "mode" was ignored'])
    expect(takeErrors().errors).toEqual(["Invalid keymap command: command cannot be empty"])
  })

  test("falls back to console.warn when no warning listener is registered", () => {
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const originalWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }

    try {
      keymap.registerLayer({
        mode: "normal",
        bindings: [],
      })
    } finally {
      console.warn = originalWarn
    }

    expect(warnings).toEqual([['[unknown-layer-field] [Keymap] Unknown layer field "mode" was ignored']])
  })

  test("falls back to console.error when no error listener is registered", () => {
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const originalError = console.error
    const errors: unknown[][] = []
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }

    try {
      // Use a no-cause error path so console.error only receives the message.
      keymap.registerCommandFields({
        name() {},
      })
    } finally {
      console.error = originalError
    }

    expect(errors).toEqual([['[reserved-command-field] Keymap command field "name" is reserved']])
  })

  test("falls back to console.error with cause when no error listener is registered", () => {
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const cause = new Error("filter boom")
    const originalError = console.error
    const errors: unknown[][] = []
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }

    keymap.registerLayer({ commands: [{ name: "noop", run() {} }] })

    try {
      keymap.getCommands({
        filter: () => {
          throw cause
        },
      })
    } finally {
      console.error = originalError
    }

    expect(errors).toEqual([["[command-query-filter-error] [Keymap] Error in command query filter:", cause]])
  })

  test("does not call console.warn or console.error when a listener is registered", () => {
    const keymap = getKeymap(renderer)
    const warnings: string[] = []
    const errors: string[] = []

    keymap.on("warning", (event) => {
      warnings.push(event.message)
    })
    keymap.on("error", (event) => {
      errors.push(event.message)
    })

    const originalWarn = console.warn
    const originalError = console.error
    const warnCalls: unknown[][] = []
    const errorCalls: unknown[][] = []
    console.warn = (...args: unknown[]) => {
      warnCalls.push(args)
    }
    console.error = (...args: unknown[]) => {
      errorCalls.push(args)
    }

    try {
      keymap.registerLayer({
        mode: "normal",
        bindings: [{ key: "y", cmd: "   " }],
      })
    } finally {
      console.warn = originalWarn
      console.error = originalError
    }

    expect(warnings).toEqual(['[Keymap] Unknown layer field "mode" was ignored'])
    expect(errors).toEqual(["Invalid keymap command: command cannot be empty"])
    expect(warnCalls).toEqual([])
    expect(errorCalls).toEqual([])
  })

  test("ignores reserved command field registrations", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    expect(() => {
      keymap.registerCommandFields({
        name() {},
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual(['Keymap command field "name" is reserved'])
  })

  test("ignores reserved layer field registrations", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    expect(() => {
      keymap.registerLayerFields({
        targetMode() {},
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual(['Keymap layer field "targetMode" is reserved'])
  })

  test("ignores reserved and duplicate binding field registrations", () => {
    const keymap = getKeymap(renderer)
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.registerBindingFields({
      active() {},
    })

    expect(() => {
      keymap.registerBindingFields({
        key() {},
        active() {},
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual([
      'Keymap binding field "key" is reserved',
      'Keymap binding field "active" is already registered',
    ])
  })

  test("skips commands with conflicting attributes from typed command fields", () => {
    const keymap = getParserKeymap()
    const { takeErrors } = captureDiagnostics(keymap)

    keymap.registerCommandFields({
      desc(value, ctx) {
        ctx.attr("label", value)
      },
      title(value, ctx) {
        ctx.attr("label", value)
      },
    })

    expect(() => {
      keymap.registerLayer({
        commands: [
          {
            name: "save-file",
            desc: "Save",
            title: "Write",
            run() {},
          },
        ],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual(['Conflicting keymap attribute for "label" from field title'])
    expect(getCommand(keymap, "save-file")).toBeUndefined()
  })
})
