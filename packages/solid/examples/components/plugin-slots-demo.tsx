import type { PluginErrorEvent } from "@opentui/core"
import {
  Slot,
  createSolidSlotRegistry,
  type SlotMode,
  type SolidPlugin,
  useKeyboard,
  useRenderer,
} from "@opentui/solid"
import { batch, createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, type JSX } from "solid-js"

type DemoSlots = {
  statusbar: { label: string }
  sidebar: { section: string }
}

const DEMO_STATUS_LABEL = "host-status"
const DEMO_SIDEBAR_SECTION = "plugins"

const hostContext = {
  appName: "solid-plugin-slots-demo",
  version: "1.0.0",
}

function nextStatusbarMode(mode: SlotMode): SlotMode {
  if (mode === "append") {
    return "replace"
  }

  if (mode === "replace") {
    return "single_winner"
  }

  return "append"
}

function formatPluginError(event: PluginErrorEvent): string {
  return `${event.pluginId} [${event.phase}/${event.source}] @ ${event.slot ?? "<none>"}: ${event.error.message}`
}

const CrashNode = (props: { pluginId: string }) => {
  throw new Error(`Forced subtree crash in ${props.pluginId}`)
  return null as unknown as JSX.Element
}

const ClockStatusText = (props: { label: string }) => {
  const [time, setTime] = createSignal(new Date().toLocaleTimeString())

  onMount(() => {
    const timer = setInterval(() => {
      setTime(new Date().toLocaleTimeString())
    }, 1000)

    onCleanup(() => {
      clearInterval(timer)
    })
  })

  return <text fg="#93c5fd">{`Clock plugin -> ${props.label} (${time()})`}</text>
}

function createClockPlugin(crash: boolean): SolidPlugin<DemoSlots, typeof hostContext> {
  return {
    id: "clock-plugin",
    order: 0,
    slots: {
      statusbar(_ctx, props) {
        if (crash) {
          return <CrashNode pluginId="clock-plugin" />
        }

        return (
          <box
            border
            borderStyle="single"
            borderColor="#2563eb"
            marginLeft={1}
            paddingLeft={1}
            paddingRight={1}
            height={3}
          >
            <ClockStatusText label={props.label} />
          </box>
        )
      },
      sidebar(_ctx, props) {
        return (
          <box
            border
            borderStyle="single"
            borderColor="#0ea5e9"
            flexDirection="column"
            paddingLeft={1}
            paddingRight={1}
          >
            <text fg="#38bdf8">{`Clock Sidebar (${props.section})`}</text>
            <text fg="#e2e8f0">Healthy</text>
          </box>
        )
      },
    },
  }
}

function createActivityPlugin(crash: boolean): SolidPlugin<DemoSlots, typeof hostContext> {
  return {
    id: "activity-plugin",
    order: 10,
    slots: {
      statusbar() {
        if (crash) {
          throw new Error("Forced activity render failure")
        }

        return (
          <box
            border
            borderStyle="single"
            borderColor="#16a34a"
            marginLeft={1}
            paddingLeft={1}
            paddingRight={1}
            height={3}
          >
            <text fg="#86efac">Activity plugin healthy</text>
          </box>
        )
      },
    },
  }
}

export default function PluginSlotsDemo() {
  const renderer = useRenderer()
  const registry = createSolidSlotRegistry<DemoSlots, typeof hostContext>(renderer, hostContext)

  const [statusbarMode, setStatusbarMode] = createSignal<SlotMode>("append")
  const [clockEnabled, setClockEnabled] = createSignal(true)
  const [activityEnabled, setActivityEnabled] = createSignal(true)
  const [clockCrashEnabled, setClockCrashEnabled] = createSignal(false)
  const [activityCrashEnabled, setActivityCrashEnabled] = createSignal(false)
  const [showPlaceholder, setShowPlaceholder] = createSignal(true)
  const [refreshNonce, setRefreshNonce] = createSignal(0)
  const [errorLines, setErrorLines] = createSignal<string[]>([])

  const AppSlot = Slot<DemoSlots, typeof hostContext>

  const pluginFailurePlaceholder = (failure: PluginErrorEvent) => {
    return (
      <box border borderStyle="single" borderColor="#fb7185" marginLeft={1} paddingLeft={1} paddingRight={1}>
        <text fg="#fecaca">{`Plugin error: ${failure.pluginId}`}</text>
        <text fg="#fca5a5">{`${failure.phase}/${failure.source} @ ${failure.slot ?? "unknown"}`}</text>
      </box>
    )
  }

  onMount(() => {
    renderer.setBackgroundColor("#000000")
  })

  const unsubscribePluginErrors = registry.onPluginError((event) => {
    setErrorLines((current) => [formatPluginError(event), ...current].slice(0, 6))
  })
  onCleanup(unsubscribePluginErrors)

  createEffect(
    on(
      [refreshNonce, clockEnabled, activityEnabled, clockCrashEnabled, activityCrashEnabled],
      ([
        _currentRefreshNonce,
        currentClockEnabled,
        currentActivityEnabled,
        currentClockCrashEnabled,
        currentActivityCrashEnabled,
      ]) => {
        const unregisterCallbacks: Array<() => void> = []

        if (currentClockEnabled) {
          unregisterCallbacks.push(registry.register(createClockPlugin(currentClockCrashEnabled)))
        }

        if (currentActivityEnabled) {
          unregisterCallbacks.push(registry.register(createActivityPlugin(currentActivityCrashEnabled)))
        }

        onCleanup(() => {
          for (const unregister of unregisterCallbacks.reverse()) {
            unregister()
          }
        })
      },
      { defer: false },
    ),
  )

  useKeyboard((key) => {
    switch (key.name) {
      case "1":
        setClockEnabled((current) => !current)
        return
      case "2":
        setActivityEnabled((current) => !current)
        return
      case "m":
        setStatusbarMode((current) => nextStatusbarMode(current))
        return
      case "e":
        setClockCrashEnabled((current) => !current)
        return
      case "d":
        setActivityCrashEnabled((current) => !current)
        return
      case "p":
        setShowPlaceholder((current) => !current)
        return
      case "r":
        setRefreshNonce((current) => current + 1)
        return
      case "x":
        batch(() => {
          setClockCrashEnabled(false)
          setActivityCrashEnabled(false)
          setErrorLines([])
          registry.clearPluginErrors()
          setRefreshNonce((current) => current + 1)
        })
        return
      case "c":
        if (key.ctrl) {
          key.preventDefault()
          renderer.destroy()
        }
        return
    }
  })

  const info = createMemo(() => {
    return [
      "Solid Plugin Slot Demo",
      "",
      `Statusbar mode: ${statusbarMode().toUpperCase()} (press m to cycle)`,
      `Clock plugin: ${clockEnabled() ? "ON" : "OFF"} (press 1)`,
      `Activity plugin: ${activityEnabled() ? "ON" : "OFF"} (press 2)`,
      `Clock subtree crash: ${clockCrashEnabled() ? "ON" : "OFF"} (press e)`,
      `Activity throw: ${activityCrashEnabled() ? "ON" : "OFF"} (press d)`,
      `Show placeholders: ${showPlaceholder() ? "YES" : "NO"} (press p)`,
      "",
      `Statusbar slot label: ${DEMO_STATUS_LABEL}`,
      `Sidebar slot section: ${DEMO_SIDEBAR_SECTION}`,
      "",
      "Press r to re-register active plugins.",
      "Press x to reset errors and clear history.",
      "",
      "Recent plugin errors:",
      ...(errorLines().length > 0 ? errorLines() : ["(none)"]),
    ].join("\n")
  })

  const renderStatusbarSlot = () => {
    const mode = statusbarMode()

    if (showPlaceholder()) {
      return (
        <Show when={mode} keyed>
          {(currentMode) => (
            <AppSlot
              registry={registry}
              name="statusbar"
              label={DEMO_STATUS_LABEL}
              mode={currentMode}
              pluginFailurePlaceholder={pluginFailurePlaceholder}
            >
              <text fg="#94a3b8">Fallback statusbar content</text>
            </AppSlot>
          )}
        </Show>
      )
    }

    return (
      <Show when={mode} keyed>
        {(currentMode) => (
          <AppSlot registry={registry} name="statusbar" label={DEMO_STATUS_LABEL} mode={currentMode}>
            <text fg="#94a3b8">Fallback statusbar content</text>
          </AppSlot>
        )}
      </Show>
    )
  }

  const renderSidebarSlot = () => {
    if (showPlaceholder()) {
      return (
        <AppSlot
          registry={registry}
          name="sidebar"
          section={DEMO_SIDEBAR_SECTION}
          mode="replace"
          pluginFailurePlaceholder={pluginFailurePlaceholder}
        >
          <text fg="#94a3b8">No sidebar plugin active</text>
        </AppSlot>
      )
    }

    return (
      <AppSlot registry={registry} name="sidebar" section={DEMO_SIDEBAR_SECTION} mode="replace">
        <text fg="#94a3b8">No sidebar plugin active</text>
      </AppSlot>
    )
  }

  return (
    <box width="100%" height="100%" flexDirection="column" padding={1} backgroundColor="#020617">
      <box
        height={5}
        width="100%"
        border
        borderStyle="single"
        borderColor="#334155"
        alignItems="center"
        flexDirection="row"
        paddingLeft={1}
        marginBottom={1}
      >
        {renderStatusbarSlot()}
      </box>

      <box width="100%" flexGrow={1} flexDirection="row">
        <box
          width={36}
          border
          borderStyle="single"
          borderColor="#334155"
          flexDirection="column"
          padding={1}
          marginRight={1}
        >
          {renderSidebarSlot()}
        </box>

        <box flexGrow={1} border borderStyle="single" borderColor="#334155" flexDirection="column" padding={1}>
          <text fg="#e2e8f0" content={info()} />
        </box>
      </box>
    </box>
  )
}
