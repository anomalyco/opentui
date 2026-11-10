import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createTestRenderer, type TestRenderer } from "@opentui/core/testing"
import { registerDefaultKeys, registerMetadataFields } from "@opentui/keymap/addons"
import { createOpenTuiKeymap } from "@opentui/keymap/opentui"
import { createDiagnosticHarness } from "../../../tests/diagnostic-harness.js"

let renderer: TestRenderer
const diagnostics = createDiagnosticHarness()

function getKeymap() {
  const keymap = diagnostics.trackKeymap(createOpenTuiKeymap(renderer))
  registerDefaultKeys(keymap)
  return keymap
}

describe("metadata addon", () => {
  beforeEach(async () => {
    const testSetup = await createTestRenderer({ width: 40, height: 10 })
    renderer = testSetup.renderer
  })

  afterEach(() => {
    renderer?.destroy()
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("registers binding and command metadata fields", () => {
    const keymap = getKeymap()
    registerMetadataFields(keymap)

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          desc: "Save file",
          title: "Save",
          category: "File",
          run() {},
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "save-file", desc: "Write current file", group: "File" }],
    })

    const activeKey = keymap.getActiveKeys({ includeBindings: true }).find((candidate) => candidate.stroke.name === "x")

    expect(activeKey?.bindings?.[0]?.attrs).toEqual({ desc: "Write current file", group: "File" })
    expect(activeKey?.command).toBe("save-file")
    expect(activeKey?.bindings?.[0]?.commandAttrs).toEqual({ desc: "Save file", title: "Save", category: "File" })
  })

  test("exposes generic binding and command metadata through includeMetadata", () => {
    const keymap = getKeymap()
    registerMetadataFields(keymap)

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          desc: "Save file",
          title: "Save",
          category: "File",
          run() {},
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "save-file", desc: "Write current file", group: "File" }],
    })

    const activeKey = keymap.getActiveKeys({ includeMetadata: true }).find((candidate) => candidate.stroke.name === "x")

    expect(activeKey?.bindings).toBeUndefined()
    expect(activeKey?.command).toBe("save-file")
    expect(activeKey?.bindingAttrs).toEqual({ desc: "Write current file", group: "File" })
    expect(activeKey?.commandAttrs).toEqual({ desc: "Save file", title: "Save", category: "File" })
  })

  test("can include both metadata and bindings", () => {
    const keymap = getKeymap()
    registerMetadataFields(keymap)

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          desc: "Save file",
          title: "Save",
          category: "File",
          run() {},
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "save-file", desc: "Write current file", group: "File" }],
    })

    const activeKey = keymap
      .getActiveKeys({ includeBindings: true, includeMetadata: true })
      .find((candidate) => candidate.stroke.name === "x")

    expect(activeKey?.bindings?.[0]?.attrs).toEqual({ desc: "Write current file", group: "File" })
    expect(activeKey?.bindingAttrs).toEqual({ desc: "Write current file", group: "File" })
    expect(activeKey?.commandAttrs).toEqual({ desc: "Save file", title: "Save", category: "File" })
  })

  test("normalizes metadata strings and rejects invalid values", () => {
    const keymap = getKeymap()
    const { takeErrors } = diagnostics.captureDiagnostics(keymap)
    registerMetadataFields(keymap)

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          desc: "  Save file  ",
          title: " Save ",
          category: " File ",
          run() {},
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "save-file", desc: "  Write file  ", group: "  File  " }],
    })

    const activeKey = keymap.getActiveKeys({ includeBindings: true }).find((candidate) => candidate.stroke.name === "x")
    expect(activeKey?.bindings?.[0]?.attrs).toEqual({ desc: "Write file", group: "File" })
    expect(activeKey?.command).toBe("save-file")
    expect(activeKey?.bindings?.[0]?.commandAttrs).toEqual({ desc: "Save file", title: "Save", category: "File" })

    expect(() => {
      keymap.registerLayer({
        commands: [
          {
            name: "bad-command",
            desc: 123,
            run() {},
          },
        ],
      })
    }).not.toThrow()

    expect(() => {
      keymap.registerLayer({
        bindings: [{ key: "y", cmd: "save-file", group: "   " }],
      })
    }).not.toThrow()

    expect(takeErrors().errors).toEqual([
      'Keymap metadata field "desc" must be a string',
      'Keymap metadata field "group" cannot be empty',
    ])
    expect(keymap.getCommands().some((command) => command.name === "bad-command")).toBe(false)
    expect(keymap.getActiveKeys().some((candidate) => candidate.stroke.name === "y")).toBe(false)
  })

  test("can be disposed to stop compiling metadata fields", () => {
    const keymap = getKeymap()
    const { takeWarnings } = diagnostics.captureDiagnostics(keymap)
    const offMetadata = registerMetadataFields(keymap)

    offMetadata()

    keymap.registerLayer({
      commands: [
        {
          name: "save-file",
          desc: "Save file",
          title: "Save",
          category: "File",
          run() {},
        },
      ],
    })

    keymap.registerLayer({
      bindings: [{ key: "x", cmd: "save-file", desc: "Write current file", group: "File" }],
    })

    const activeKey = keymap
      .getActiveKeys({ includeBindings: true, includeMetadata: true })
      .find((candidate) => candidate.stroke.name === "x")

    expect(activeKey?.bindingAttrs).toBeUndefined()
    expect(activeKey?.commandAttrs).toBeUndefined()
    expect(activeKey?.bindings?.[0]?.attrs).toBeUndefined()
    expect(activeKey?.bindings?.[0]?.commandAttrs).toBeUndefined()
    expect(takeWarnings().warnings).toEqual([
      '[Keymap] Unknown binding field "desc" was ignored',
      '[Keymap] Unknown binding field "group" was ignored',
    ])
  })
})
