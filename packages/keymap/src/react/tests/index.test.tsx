/** @jsxImportSource @opentui/react */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { Renderable } from "@opentui/core"
import { createTestRenderer, type TestRendererOptions } from "@opentui/core/testing"
import { KEYMAP_EXTENSION_CONTEXT, stringifyKeySequence } from "@opentui/keymap"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import {
  KeymapProvider,
  reactiveMatcherFromStore,
  useActiveKeys,
  useBindings,
  useKeymap,
  usePendingSequence,
} from "@opentui/keymap/react"
import { createRoot, type Root } from "@opentui/react"
import { act, type ReactNode } from "react"
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react"
import { createDiagnosticHarness } from "../../tests/diagnostic-harness.js"

const diagnostics = createDiagnosticHarness()

function setIsReactActEnvironment(isReactActEnvironment: boolean) {
  // @ts-expect-error test environment flag
  globalThis.IS_REACT_ACT_ENVIRONMENT = isReactActEnvironment
}

async function testRender(node: ReactNode, testRendererOptions: TestRendererOptions) {
  let root: Root | null = null
  setIsReactActEnvironment(true)

  const testSetup = await createTestRenderer({
    ...testRendererOptions,
    onDestroy() {
      act(() => {
        root?.unmount()
        root = null
      })
      testRendererOptions.onDestroy?.()
      setIsReactActEnvironment(false)
    },
  })

  const keymap = diagnostics.trackKeymap(createDefaultOpenTuiKeymap(testSetup.renderer))
  root = createRoot(testSetup.renderer)
  act(() => {
    root?.render(<KeymapProvider keymap={keymap}>{node}</KeymapProvider>)
  })

  return testSetup
}

let testSetup: Awaited<ReturnType<typeof testRender>>

describe("React keymap hooks", () => {
  beforeEach(async () => {
    if (testSetup) {
      act(() => {
        testSetup.renderer.destroy()
      })
    }
  })

  afterEach(() => {
    if (testSetup) {
      act(() => {
        testSetup.renderer.destroy()
      })
    }
    diagnostics.assertNoUnhandledDiagnostics()
  })

  test("useKeymap returns the provided keymap", async () => {
    let first: ReturnType<typeof useKeymap> | undefined
    let second: ReturnType<typeof useKeymap> | undefined

    function Probe() {
      first = useKeymap()
      second = useKeymap()

      return <box width={10} height={4} />
    }

    await act(async () => {
      testSetup = await testRender(<Probe />, { width: 20, height: 6 })
    })

    expect(first).toBeDefined()
    expect(second).toBe(first)
  })

  test("useBindings registers global bindings and cleans them up on unmount", async () => {
    const calls: string[] = []
    let setVisible!: Dispatch<SetStateAction<boolean>>

    function GlobalBindings() {
      const manager = useKeymap()

      useEffect(() => {
        return manager.registerLayer({
          commands: [
            {
              name: "global",
              run() {
                calls.push("global")
              },
            },
          ],
        })
      }, [manager])

      useBindings(() => ({ bindings: [{ key: "x", cmd: "global" }] }))

      return <text>bindings</text>
    }

    function App() {
      const [visible, setVisibleSignal] = useState(true)
      setVisible = setVisibleSignal

      return (
        <box width={20} height={6}>
          {visible ? <GlobalBindings /> : null}
        </box>
      )
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 20, height: 6 })
    })

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["global"])

    act(() => {
      setVisible(false)
    })
    await testSetup.renderOnce()

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["global"])
  })

  test("useBindings factory does not re-register on unrelated rerenders", async () => {
    let setTick!: Dispatch<SetStateAction<number>>
    let registerCalls = 0

    function App() {
      const manager = useKeymap()
      const [tick, setTickSignal] = useState(0)
      setTick = setTickSignal

      useEffect(() => {
        return manager.registerLayer({ commands: [{ name: "probe", run() {} }] })
      }, [manager])

      useEffect(() => {
        const layers = manager[KEYMAP_EXTENSION_CONTEXT]().layers
        const original = layers.replaceLayer
        layers.replaceLayer = (slot, layer) => {
          registerCalls += 1
          return original(slot, layer)
        }

        return () => {
          layers.replaceLayer = original
        }
      }, [manager])

      useBindings(() => ({ bindings: [{ key: "x", cmd: "probe" }] }))

      return <text>{tick}</text>
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 20, height: 6 })
    })

    expect(registerCalls).toBe(1)

    act(() => {
      setTick((value) => value + 1)
    })
    await testSetup.renderOnce()

    expect(registerCalls).toBe(1)
  })

  test("useBindings moves its layer when the provided keymap changes", async () => {
    let first!: ReturnType<typeof useKeymap>
    let second!: ReturnType<typeof useKeymap>
    let setSecond!: Dispatch<SetStateAction<boolean>>

    function Probe() {
      useBindings(() => ({ commands: [{ name: "probe", run() {} }] }))
      return <text>probe</text>
    }

    function App() {
      first = useKeymap()
      const [useSecond, setUseSecond] = useState(false)
      setSecond = setUseSecond
      return (
        <KeymapProvider keymap={useSecond ? second : first}>
          <Probe />
        </KeymapProvider>
      )
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 20, height: 6 })
    })
    second = diagnostics.trackKeymap(createDefaultOpenTuiKeymap(testSetup.renderer))
    act(() => {
      setSecond(true)
    })

    const names = (keymap: typeof first) => keymap.getCommands({ visibility: "registered" }).map(({ name }) => name)
    expect([names(first), names(second)]).toEqual([[], ["probe"]])
  })

  test("useBindings supports declarative release bindings", async () => {
    const calls: string[] = []

    function App() {
      const manager = useKeymap()

      useEffect(() => {
        return manager.registerLayer({
          commands: [
            {
              name: "release-command",
              run() {
                calls.push("release")
              },
            },
            {
              name: "press-command",
              run() {
                calls.push("press")
              },
            },
          ],
        })
      }, [manager])

      useBindings(() => ({
        bindings: [
          { key: "a", cmd: "release-command", event: "release" },
          { key: "b", cmd: "press-command" },
        ],
      }))

      const activeKeys = useActiveKeys()

      return <text>{`Active: ${activeKeys.map((key) => key.stroke.name).join(",") || "<none>"}`}</text>
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 20, height: 6, kittyKeyboard: true })
    })

    await testSetup.renderOnce()
    expect(testSetup.captureCharFrame()).toContain("Active: b")

    act(() => {
      testSetup.mockInput.pressKey("a")
    })
    expect(calls).toEqual([])

    act(() => {
      testSetup.renderer.stdin.emit("data", Buffer.from("\x1b[97;1:3u"))
    })
    expect(calls).toEqual(["release"])

    act(() => {
      testSetup.mockInput.pressKey("b")
    })
    expect(calls).toEqual(["release", "press"])
  })

  test("useActiveKeys updates on focus changes and direct blur", async () => {
    let firstTarget!: Renderable
    let secondTarget!: Renderable

    function App() {
      const manager = useKeymap()
      const activeKeys = useActiveKeys()
      const firstTargetRef = useRef<Renderable | null>(null)
      const secondTargetRef = useRef<Renderable | null>(null)

      useEffect(() => {
        return manager.registerLayer({
          commands: [
            { name: "first", run() {} },
            { name: "second", run() {} },
          ],
        })
      }, [manager])

      useBindings(() => ({
        targetMode: "focus-within" as const,
        targetRef: firstTargetRef,
        bindings: [{ key: "x", cmd: "first" }],
      }))
      useBindings(() => ({
        targetMode: "focus-within" as const,
        targetRef: secondTargetRef,
        bindings: [{ key: "y", cmd: "second" }],
      }))

      return (
        <box width={24} height={8} flexDirection="column">
          <text>{`Active: ${activeKeys.map((key) => key.stroke.name).join(",") || "<none>"}`}</text>
          <box
            ref={(value) => {
              firstTargetRef.current = value
              if (value) {
                firstTarget = value
              }
            }}
            width={8}
            height={2}
            focusable
            focused
          />
          <box
            ref={(value) => {
              secondTargetRef.current = value
              if (value) {
                secondTarget = value
              }
            }}
            width={8}
            height={2}
            focusable
          />
        </box>
      )
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 24, height: 8 })
    })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Active: x")

    act(() => {
      secondTarget.focus()
    })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Active: y")

    act(() => {
      secondTarget.blur()
    })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Active: <none>")
  })

  test("usePendingSequence updates without manual subscriptions", async () => {
    function App() {
      const manager = useKeymap()
      const pendingSequence = usePendingSequence()

      useEffect(() => {
        return manager.registerLayer({ commands: [{ name: "delete-line", run() {} }] })
      }, [manager])

      useBindings(() => ({ bindings: [{ key: "dd", cmd: "delete-line" }] }))

      return <text>{`Pending: ${stringifyKeySequence(pendingSequence, { preferDisplay: true }) || "<root>"}`}</text>
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 24, height: 6 })
    })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Pending: <root>")

    act(() => {
      testSetup.mockInput.pressKey("d")
    })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Pending: d")

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    await testSetup.renderOnce()

    expect(testSetup.captureCharFrame()).toContain("Pending: <root>")
  })

  test("useBindings can bind local bindings through targetRef", async () => {
    const calls: string[] = []
    let setActive!: Dispatch<SetStateAction<"first" | "second">>

    function App() {
      const manager = useKeymap()
      const [active, setActiveSignal] = useState<"first" | "second">("first")
      const targetRef = useRef<Renderable | null>(null)
      setActive = setActiveSignal

      useEffect(() => {
        return manager.registerLayer({
          commands: [
            {
              name: "target",
              run() {
                calls.push("target")
              },
            },
          ],
        })
      }, [manager])

      useBindings(() => ({
        targetMode: "focus-within" as const,
        targetRef,
        bindings: [{ key: "x", cmd: "target" }],
      }))

      return (
        <box width={20} height={6}>
          <box ref={targetRef} width={8} height={3} focusable focused={active === "first"} />
          <box width={8} height={3} focusable focused={active === "second"} />
        </box>
      )
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 20, height: 6 })
    })

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["target"])

    act(() => {
      setActive("second")
    })
    await testSetup.renderOnce()

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["target"])
  })

  test("useBindings follows a stable ref when it retargets to a new renderable", async () => {
    const calls: string[] = []
    let setActive!: Dispatch<SetStateAction<"first" | "second">>

    function App() {
      const manager = useKeymap()
      const [active, setActiveSignal] = useState<"first" | "second">("first")
      const targetRef = useRef<Renderable | null>(null)
      setActive = setActiveSignal

      useEffect(() => {
        return manager.registerLayer({
          commands: [
            {
              name: "target",
              run() {
                calls.push("target")
              },
            },
          ],
        })
      }, [manager])

      useBindings(() => ({
        targetMode: "focus-within" as const,
        targetRef,
        bindings: [{ key: "x", cmd: "target" }],
      }))

      return (
        <box width={20} height={6}>
          {active === "first" ? (
            <box key="first" id="first" ref={targetRef} width={8} height={3} focusable focused />
          ) : (
            <box key="second" id="second" ref={targetRef} width={8} height={3} focusable focused />
          )}
        </box>
      )
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 20, height: 6 })
    })
    await testSetup.renderOnce()

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["target"])

    act(() => {
      setActive("second")
    })
    await testSetup.renderOnce()

    expect(testSetup.renderer.currentFocusedRenderable?.id).toBe("second")

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["target", "target"])
  })

  test("useBindings can reactively enable layers via reactiveMatcherFromStore", async () => {
    const calls: string[] = []

    const createEnabledStore = () => {
      let enabled = false
      const listeners = new Set<() => void>()
      return {
        getSnapshot: () => enabled,
        subscribe: (onChange: () => void) => {
          listeners.add(onChange)
          return () => listeners.delete(onChange)
        },
        set(next: boolean) {
          if (enabled === next) return
          enabled = next
          for (const fn of listeners) fn()
        },
      }
    }

    const store = createEnabledStore()

    function App() {
      const manager = useKeymap()

      useEffect(() => {
        const offCommands = manager.registerLayer({
          commands: [
            {
              name: "reactive",
              run() {
                calls.push("reactive")
              },
            },
          ],
        })

        return () => {
          offCommands()
        }
      }, [manager])

      const matcher = useMemo(() => reactiveMatcherFromStore(store.subscribe, store.getSnapshot), [])

      useBindings(() => ({ enabled: matcher, bindings: [{ key: "x", cmd: "reactive" }] }), [matcher])

      return <box width={20} height={6} />
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 20, height: 6 })
    })

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual([])

    act(() => {
      store.set(true)
    })

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["reactive"])

    act(() => {
      store.set(false)
    })

    act(() => {
      testSetup.mockInput.pressKey("x")
    })
    expect(calls).toEqual(["reactive"])
  })

  test("reactiveMatcherFromStore: applies predicate when snapshot is not boolean", async () => {
    const calls: string[] = []

    const createModeStore = () => {
      let mode: "normal" | "visual" = "visual"
      const listeners = new Set<() => void>()
      return {
        getSnapshot: () => mode,
        subscribe: (onChange: () => void) => {
          listeners.add(onChange)
          return () => listeners.delete(onChange)
        },
        set(next: "normal" | "visual") {
          if (mode === next) return
          mode = next
          for (const fn of listeners) fn()
        },
      }
    }

    const store = createModeStore()

    function App() {
      const manager = useKeymap()

      useEffect(() => {
        const offCommands = manager.registerLayer({
          commands: [
            {
              name: "normal-only",
              run() {
                calls.push("normal")
              },
            },
          ],
        })
        return () => {
          offCommands()
        }
      }, [manager])

      const matcher = useMemo(
        () => reactiveMatcherFromStore(store.subscribe, store.getSnapshot, (mode) => mode === "normal"),
        [],
      )

      useBindings(() => ({ enabled: matcher, bindings: [{ key: "x", cmd: "normal-only" }] }), [matcher])

      return <box width={20} height={6} />
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 20, height: 6 })
    })

    act(() => testSetup.mockInput.pressKey("x"))
    expect(calls).toEqual([])

    act(() => store.set("normal"))
    act(() => testSetup.mockInput.pressKey("x"))
    expect(calls).toEqual(["normal"])

    act(() => store.set("visual"))
    act(() => testSetup.mockInput.pressKey("x"))
    expect(calls).toEqual(["normal"])
  })

  test("reactiveMatcherFromStore: unsubscribes from store on layer unregister", async () => {
    let listenerCount = 0
    const storeListeners = new Set<() => void>()
    const store = {
      getSnapshot: () => false,
      subscribe(onChange: () => void) {
        listenerCount += 1
        storeListeners.add(onChange)
        return () => {
          listenerCount -= 1
          storeListeners.delete(onChange)
        }
      },
    }

    let setMounted!: Dispatch<SetStateAction<boolean>>

    function Child() {
      const matcher = useMemo(() => reactiveMatcherFromStore(store.subscribe, store.getSnapshot), [])
      useBindings(() => ({ enabled: matcher, bindings: [{ key: "x", cmd: "probe" }] }), [matcher])
      return <box width={10} height={2} />
    }

    function App() {
      const [mounted, setter] = useState(true)
      setMounted = setter

      const manager = useKeymap()

      // Install these before the child's `useBindings` effect runs.
      useMemo(() => {
        manager.registerLayer({ commands: [{ name: "probe", run() {} }] })
      }, [manager])

      return <>{mounted ? <Child /> : null}</>
    }

    await act(async () => {
      testSetup = await testRender(<App />, { width: 20, height: 6 })
    })

    expect(listenerCount).toBe(1)

    act(() => {
      setMounted(false)
    })

    expect(listenerCount).toBe(0)
    expect(storeListeners.size).toBe(0)
  })

  test("useBindings shows an error for local bindings without a targetRef", async () => {
    const originalConsoleError = console.error
    console.error = () => {}

    try {
      function App() {
        useBindings(() => ({
          targetMode: "focus-within",
          bindings: [{ key: "x", cmd: "target" }],
        }))

        return <text>bindings</text>
      }

      await act(async () => {
        testSetup = await testRender(<App />, {
          width: 140,
          height: 12,
        })
      })
      await testSetup.renderOnce()

      const frame = testSetup.captureCharFrame()
      expect(frame).toContain("useBindings local bindings need a targetRef")
    } finally {
      console.error = originalConsoleError
    }
  })

  test("useBindings can wait for a targetRef to become available", async () => {
    const calls: string[] = []
    let setVisible!: Dispatch<SetStateAction<boolean>>

    function App() {
      const manager = useKeymap()
      const [visible, setVisibleState] = useState(false)
      const targetRef = useRef<Renderable | null>(null)
      setVisible = setVisibleState

      const offCommands = manager.registerLayer({
        commands: [
          {
            name: "target",
            run() {
              calls.push("target")
            },
          },
        ],
      })

      useEffect(() => offCommands, [offCommands])

      useBindings<Renderable>(
        () => ({
          targetMode: "focus-within",
          targetRef,
          bindings: [{ key: "x", cmd: "target" }],
        }),
        [],
      )

      return (
        <box width={20} height={6}>
          {visible ? <box ref={targetRef} width={8} height={3} focusable focused /> : null}
        </box>
      )
    }

    await act(async () => {
      testSetup = await testRender(<App />, {
        width: 20,
        height: 6,
      })
    })

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual([])

    await act(async () => {
      setVisible(true)
    })

    testSetup.mockInput.pressKey("x")
    expect(calls).toEqual(["target"])
  })
})
