import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Renderable, TextareaRenderable } from "@opentui/core"
import { createTestRenderer, type TestRendererOptions } from "@opentui/core/testing"
import { registerCommaBindings, registerTimedLeader } from "@opentui/keymap/addons"
import { registerManagedTextareaLayer } from "@opentui/keymap/addons/opentui"
import { stringifyKeySequence } from "@opentui/keymap"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider, reactiveMatcherFromSignal, useBindings } from "@opentui/keymap/solid"
import { render, type JSX } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createDiagnosticHarness } from "../../tests/diagnostic-harness.js"

const diagnostics = createDiagnosticHarness()

async function testRender(
  node: () => JSX.Element,
  renderConfig: TestRendererOptions = {},
  options?: {
    setupKeymap?: (keymap: ReturnType<typeof createDefaultOpenTuiKeymap>, renderer: typeof testSetup.renderer) => void
  },
) {
  const testSetup = await createTestRenderer({
    ...renderConfig,
    onDestroy: () => {
      renderConfig.onDestroy?.()
    },
  })

  const keymap = diagnostics.trackKeymap(createDefaultOpenTuiKeymap(testSetup.renderer))
  options?.setupKeymap?.(keymap, testSetup.renderer)
  await render(() => <KeymapProvider keymap={keymap}>{node()}</KeymapProvider>, testSetup.renderer)

  return { ...testSetup, keymap }
}

let testSetup: Awaited<ReturnType<typeof testRender>>

async function flush() {
  await Bun.sleep(0)
  await testSetup.renderOnce()
}

function getPending() {
  return stringifyKeySequence(testSetup.keymap.getPendingSequence(), { preferDisplay: true }) || "<root>"
}

function getActive() {
  return (
    testSetup.keymap
      .getActiveKeys({ includeMetadata: true })
      .map((activeKey) => `${activeKey.display}=${String(activeKey.bindingAttrs?.desc ?? activeKey.command ?? "")}`)
      .sort()
      .join(",") || "<none>"
  )
}

function getReachableCommandNames() {
  return testSetup.keymap
    .getCommandEntries({ visibility: "reachable" })
    .map((entry) => entry.command.name)
    .sort()
}

describe("solid keymap leader behavior", () => {
  beforeEach(async () => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
  })

  afterEach(() => {
    if (testSetup) {
      testSetup.renderer.destroy()
    }
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("supports leader bindings across global layers with a focused managed textarea", async () => {
    const calls: string[] = []
    let editor!: TextareaRenderable
    let offLeader!: () => void
    let offCommaBindings!: () => void
    let offManagedTextarea!: () => void

    testSetup = await testRender(
      () => {
        const [bindingsEnabled] = createSignal(true)

        useBindings(() => ({
          commands: [
            {
              name: "command.palette.show",
              run() {
                calls.push("command.palette.show")
              },
            },
            {
              name: "session.list",
              run() {
                calls.push("session.list")
              },
            },
            {
              name: "session.new",
              run() {
                calls.push("session.new")
              },
            },
            {
              name: "model.list",
              run() {
                calls.push("model.list")
              },
            },
            {
              name: "model.cycle_recent",
              run() {
                calls.push("model.cycle_recent")
              },
            },
            {
              name: "model.cycle_recent_reverse",
              run() {
                calls.push("model.cycle_recent_reverse")
              },
            },
            {
              name: "agent.list",
              run() {
                calls.push("agent.list")
              },
            },
            {
              name: "agent.cycle",
              run() {
                calls.push("agent.cycle")
              },
            },
            {
              name: "variant.cycle",
              run() {
                calls.push("variant.cycle")
              },
            },
            {
              name: "agent.cycle.reverse",
              run() {
                calls.push("agent.cycle.reverse")
              },
            },
            {
              name: "prompt.editor.shortcut",
              run() {
                calls.push("prompt.editor.shortcut")
              },
            },
            {
              name: "opencode.status",
              run() {
                calls.push("opencode.status")
              },
            },
            {
              name: "theme.switch",
              run() {
                calls.push("theme.switch")
              },
            },
            {
              name: "app.exit",
              run() {
                calls.push("app.exit")
              },
            },
            {
              name: "terminal.suspend",
              run() {
                calls.push("terminal.suspend")
              },
            },
          ],
        }))

        useBindings(() => ({
          enabled: reactiveMatcherFromSignal(bindingsEnabled),
          bindings: [
            { key: "ctrl+p", cmd: "command.palette.show", desc: "command.palette.show" },
            { key: "<leader>l", cmd: "session.list", desc: "session.list" },
            { key: "<leader>n", cmd: "session.new", desc: "session.new" },
            { key: "<leader>m", cmd: "model.list", desc: "model.list" },
            { key: "f2", cmd: "model.cycle_recent", desc: "model.cycle_recent" },
            { key: "shift+f2", cmd: "model.cycle_recent_reverse", desc: "model.cycle_recent_reverse" },
            { key: "<leader>a", cmd: "agent.list", desc: "agent.list" },
            { key: "tab", cmd: "agent.cycle", desc: "agent.cycle" },
            { key: "ctrl+t", cmd: "variant.cycle", desc: "variant.cycle" },
            { key: "shift+tab", cmd: "agent.cycle.reverse", desc: "agent.cycle.reverse" },
            { key: "<leader>e", cmd: "prompt.editor.shortcut", desc: "prompt.editor.shortcut" },
            { key: "<leader>s", cmd: "opencode.status", desc: "opencode.status" },
            { key: "<leader>t", cmd: "theme.switch", desc: "theme.switch" },
            { key: "ctrl+d,<leader>q", cmd: "app.exit", desc: "app.exit" },
            { key: "ctrl+z", cmd: "terminal.suspend", desc: "terminal.suspend" },
          ],
        }))

        useBindings(() => ({
          targetMode: "focus-within",
          target: () => editor,
          bindings: [{ key: "!", cmd: () => calls.push("prompt.shell") }],
        }))

        useBindings(() => ({
          commands: [
            {
              name: "tips.toggle",
              run() {
                calls.push("tips.toggle")
              },
            },
          ],
          bindings: [{ key: "<leader>h", cmd: "tips.toggle", desc: "tips.toggle" }],
        }))

        return (
          <box width={80} height={10}>
            <textarea
              id="editor"
              ref={(value: TextareaRenderable) => {
                editor = value
              }}
              width={40}
              height={5}
              focused
            />
          </box>
        )
      },
      {
        width: 80,
        height: 10,
        onDestroy() {
          offManagedTextarea?.()
          offCommaBindings?.()
          offLeader?.()
        },
      },
      {
        setupKeymap(keymap, renderer) {
          offCommaBindings = registerCommaBindings(keymap)
          offLeader = registerTimedLeader(keymap, {
            trigger: { name: "x", ctrl: true },
            timeoutMs: 1_000,
          })
          offManagedTextarea = registerManagedTextareaLayer(keymap, renderer, {})
        },
      },
    )

    editor.focus()
    await flush()

    expect(editor.traits.suspend).toBe(true)

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()

    expect(getPending()).toBe("<leader>")
    expect(getActive()).toBe(
      "a=agent.list,e=prompt.editor.shortcut,h=tips.toggle,l=session.list,m=model.list,n=session.new,q=app.exit,s=opencode.status,t=theme.switch",
    )

    testSetup.mockInput.pressKey("m")
    await flush()

    expect(getPending()).toBe("<root>")
    expect(calls).toEqual(["model.list"])
    expect(editor.plainText).toBe("")
  })

  test("keeps commands reachable when only the bindings layer is disabled", async () => {
    let setBindingsEnabled!: (value: boolean) => void
    const calls: string[] = []

    let offLeader!: () => void
    testSetup = await testRender(
      () => {
        const [bindingsEnabled, setBindingsEnabledSignal] = createSignal(false)
        setBindingsEnabled = setBindingsEnabledSignal

        useBindings(() => ({
          commands: [
            {
              name: "console-toggle",
              run() {
                calls.push("console-toggle")
              },
            },
            {
              name: "session-list",
              run() {
                calls.push("session-list")
              },
            },
          ],
        }))

        useBindings(() => ({
          enabled: reactiveMatcherFromSignal(bindingsEnabled),
          bindings: [
            { key: "ctrl+p", cmd: "console-toggle", desc: "console-toggle" },
            { key: "<leader>l", cmd: "session-list", desc: "session-list" },
          ],
        }))

        return <box width={40} height={6} />
      },
      {
        width: 40,
        height: 6,
        onDestroy() {
          offLeader?.()
        },
      },
      {
        setupKeymap(keymap) {
          offLeader = registerTimedLeader(keymap, {
            trigger: { name: "x", ctrl: true },
            timeoutMs: 1_000,
          })
        },
      },
    )
    await flush()

    expect(getReachableCommandNames()).toEqual(["console-toggle", "session-list"])

    testSetup.mockInput.pressKey("p", { ctrl: true })
    await flush()
    expect(calls).toEqual([])

    setBindingsEnabled(true)
    await flush()

    testSetup.mockInput.pressKey("p", { ctrl: true })
    await flush()
    expect(calls).toEqual(["console-toggle"])
  })

  test("supports leader bindings across separate components with extra focus-within layers", async () => {
    const calls: string[] = []
    let editor!: TextareaRenderable
    let offLeader!: () => void
    let offCommaBindings!: () => void
    let offManagedTextarea!: () => void

    function GlobalCommands() {
      useBindings(() => ({
        commands: [
          {
            name: "session.list",
            run() {
              calls.push("session.list")
            },
          },
          {
            name: "model.list",
            run() {
              calls.push("model.list")
            },
          },
          {
            name: "agent.list",
            run() {
              calls.push("agent.list")
            },
          },
        ],
      }))

      return <text>global-commands</text>
    }

    function GlobalBindings() {
      const [bindingsEnabled] = createSignal(true)

      useBindings(() => ({
        enabled: reactiveMatcherFromSignal(bindingsEnabled),
        bindings: [
          { key: "<leader>l", cmd: "session.list", desc: "session.list" },
          { key: "<leader>m", cmd: "model.list", desc: "model.list" },
          { key: "<leader>a", cmd: "agent.list", desc: "agent.list" },
        ],
      }))

      return <text>global-bindings</text>
    }

    function TipsBindings() {
      useBindings(() => ({
        commands: [
          {
            name: "tips.toggle",
            run() {
              calls.push("tips.toggle")
            },
          },
        ],
        bindings: [{ key: "<leader>h", cmd: "tips.toggle", desc: "tips.toggle" }],
      }))

      return <text>tips-bindings</text>
    }

    function PromptBindings() {
      useBindings(() => ({
        targetMode: "focus-within",
        target: () => editor,
        bindings: [
          { key: "!", cmd: () => calls.push("prompt.shell") },
          { key: "ctrl+v", cmd: () => calls.push("prompt.paste") },
          { key: "escape", cmd: () => calls.push("prompt.escape") },
        ],
      }))

      useBindings(() => ({
        targetMode: "focus-within",
        target: () => editor,
        bindings: [{ key: "tab", cmd: () => calls.push("prompt.tab") }],
      }))

      return (
        <textarea
          id="editor-multi-layer"
          ref={(value: TextareaRenderable) => {
            editor = value
          }}
          width={40}
          height={5}
          focused
        />
      )
    }

    testSetup = await testRender(
      () => (
        <box width={80} height={10} flexDirection="column">
          <GlobalCommands />
          <GlobalBindings />
          <TipsBindings />
          <PromptBindings />
        </box>
      ),
      {
        width: 80,
        height: 10,
        onDestroy() {
          offManagedTextarea?.()
          offCommaBindings?.()
          offLeader?.()
        },
      },
      {
        setupKeymap(keymap, renderer) {
          offCommaBindings = registerCommaBindings(keymap)
          offLeader = registerTimedLeader(keymap, {
            trigger: { name: "x", ctrl: true },
            timeoutMs: 1_000,
          })
          offManagedTextarea = registerManagedTextareaLayer(keymap, renderer, {})
        },
      },
    )

    editor.focus()
    await flush()

    expect(editor.traits.suspend).toBe(true)

    testSetup.mockInput.pressKey("x", { ctrl: true })
    await flush()

    expect(getPending()).toBe("<leader>")
    expect(getActive()).toBe("a=agent.list,h=tips.toggle,l=session.list,m=model.list")

    testSetup.mockInput.pressKey("l")
    await flush()

    expect(getPending()).toBe("<root>")
    expect(calls).toEqual(["session.list"])
    expect(editor.plainText).toBe("")
  })
})
