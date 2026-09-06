import {
  BoxRenderable,
  type CliRenderer,
  createCliRenderer,
  createCoreSlotRegistry,
  registerCorePlugin,
  SlotRenderable,
  TextRenderable,
  type CorePlugin,
  type CoreSlotMode,
  type CoreSlotRegistry,
  type PluginErrorEvent,
  type KeyEvent,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

type DemoSlot = "statusbar" | "sidebar"
type DemoContext = { appName: string; version: string }
type DemoSlotData = { label?: string; section?: string }

const DEMO_STATUS_LABEL = "host-status"
const DEMO_SIDEBAR_SECTION = "plugins"
const DEMO_CONTEXT: DemoContext = { appName: "core-plugin-slots-demo", version: "1.0.0" }

interface PluginStats {
  statusbarCreates: number
  sidebarCreates: number
}

let renderer: CliRenderer | null = null
let rootContainer: BoxRenderable | null = null
let statusbarSlot: SlotRenderable<DemoSlot, DemoContext, DemoSlotData> | null = null
let sidebarSlot: SlotRenderable<DemoSlot, DemoContext, DemoSlotData> | null = null
let infoPanel: BoxRenderable | null = null
let infoText: TextRenderable | null = null

let slotRegistry: CoreSlotRegistry<DemoSlot, DemoContext, DemoSlotData> | null = null

let unregisterClockPlugin: (() => void) | null = null
let unregisterActivityPlugin: (() => void) | null = null

const clockStats: PluginStats = {
  statusbarCreates: 0,
  sidebarCreates: 0,
}

const activityStats: PluginStats = {
  statusbarCreates: 0,
  sidebarCreates: 0,
}

let clockPluginEnabled = false
let activityPluginEnabled = false
let orderFlipped = false
let statusbarMode: CoreSlotMode = "append"
let clockStatusbarErrorEnabled = false
let clockSidebarErrorEnabled = false
let activityStatusbarErrorEnabled = false
let showPluginFailurePlaceholder = true
let unregisterPluginErrorListener: (() => void) | null = null
let pluginErrorHistory: string[] = []
let placeholderCreateCount = 0

const MAX_PLUGIN_ERROR_HISTORY = 6

const getClockOrder = () => (orderFlipped ? 20 : 0)
const getActivityOrder = () => (orderFlipped ? -10 : 10)

function nextStatusbarMode(mode: CoreSlotMode): CoreSlotMode {
  if (mode === "append") {
    return "replace"
  }

  if (mode === "replace") {
    return "single_winner"
  }

  return "append"
}

function formatPluginError(event: PluginErrorEvent): string {
  const slot = event.slot ?? "<none>"
  return `${event.pluginId} [${event.phase}/${event.source}] @ ${slot}: ${event.error.message}`
}

function pushPluginError(event: PluginErrorEvent): void {
  pluginErrorHistory = [formatPluginError(event), ...pluginErrorHistory].slice(0, MAX_PLUGIN_ERROR_HISTORY)
}

function createPluginFailurePlaceholder(
  rendererInstance: CliRenderer,
  failure: PluginErrorEvent,
  color: string,
): BoxRenderable {
  placeholderCreateCount++

  const container = new BoxRenderable(rendererInstance, {
    id: `plugin-error-${failure.pluginId}-${placeholderCreateCount}`,
    border: true,
    borderStyle: "single",
    borderColor: color,
    paddingLeft: 1,
    paddingRight: 1,
    marginLeft: 1,
    backgroundColor: "#1f1115",
  })

  const title = new TextRenderable(rendererInstance, {
    id: `plugin-error-title-${failure.pluginId}-${placeholderCreateCount}`,
    content: `Plugin error: ${failure.pluginId}`,
    fg: "#fecaca",
  })

  const details = new TextRenderable(rendererInstance, {
    id: `plugin-error-details-${failure.pluginId}-${placeholderCreateCount}`,
    content: `${failure.phase}/${failure.source} @ ${failure.slot ?? "unknown"}`,
    fg: "#fca5a5",
  })

  container.add(title)
  container.add(details)
  return container
}

function remountEnabledPlugins(): void {
  if (!slotRegistry || !renderer) {
    return
  }

  if (clockPluginEnabled) {
    unregisterClockPlugin?.()
    unregisterClockPlugin = registerCorePlugin(slotRegistry, createClockPlugin(renderer))
  }

  if (activityPluginEnabled) {
    unregisterActivityPlugin?.()
    unregisterActivityPlugin = registerCorePlugin(slotRegistry, createActivityPlugin(renderer))
  }

  statusbarSlot?.refresh()
  sidebarSlot?.refresh()
}

function resetPluginFailureState(): void {
  clockStatusbarErrorEnabled = false
  clockSidebarErrorEnabled = false
  activityStatusbarErrorEnabled = false
  pluginErrorHistory = []
  slotRegistry?.clearPluginErrors()

  remountEnabledPlugins()
  updateInfoPanel()
}

function updateInfoPanel(): void {
  if (!infoText) {
    return
  }

  infoText.content = [
    "Core Plugin Slot Demo",
    "",
    `Statusbar mode: ${statusbarMode.toUpperCase()} (press m to cycle)`,
    `Clock plugin: ${clockPluginEnabled ? "ON" : "OFF"} (press 1)`,
    `Activity plugin: ${activityPluginEnabled ? "ON" : "OFF"} (press 2)`,
    `Order flipped: ${orderFlipped ? "YES" : "NO"} (press o)`,
    `Show error placeholders: ${showPluginFailurePlaceholder ? "YES" : "NO"} (press p)`,
    "",
    `Clock statusbar throw: ${clockStatusbarErrorEnabled ? "ON" : "OFF"} (press e)`,
    `Clock sidebar throw: ${clockSidebarErrorEnabled ? "ON" : "OFF"} (press w)`,
    `Activity statusbar throw: ${activityStatusbarErrorEnabled ? "ON" : "OFF"} (press d)`,
    "Press x to reset all forced errors.",
    "",
    `Clock create counts -> statusbar: ${clockStats.statusbarCreates}, sidebar: ${clockStats.sidebarCreates}`,
    `Activity create counts -> statusbar: ${activityStats.statusbarCreates}`,
    "",
    "Press r to force slot refresh.",
    `Statusbar slot data.label: ${statusbarSlot?.data.label ?? DEMO_STATUS_LABEL}`,
    `Sidebar slot data.section: ${sidebarSlot?.data.section ?? DEMO_SIDEBAR_SECTION}`,
    "",
    "Statusbar fallback is always shown in APPEND mode.",
    "Sidebar fallback appears only when no sidebar plugin is active.",
    "",
    "Recent plugin errors:",
    ...(pluginErrorHistory.length > 0 ? pluginErrorHistory : ["(none)"]),
  ].join("\n")
}

function createClockPlugin(rendererInstance: CliRenderer): CorePlugin<DemoSlot, DemoContext, DemoSlotData> {
  let statusbarItem: BoxRenderable | null = null
  let statusText: TextRenderable | null = null
  let sidebarPanel: BoxRenderable | null = null
  let sidebarText: TextRenderable | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  const activeSlots = new Set<DemoSlot>()
  let statusbarLabel = "status"

  const startClockTimer = () => {
    if (timer) {
      return
    }

    updateClockText()
    timer = setInterval(updateClockText, 1000)
  }

  const stopClockTimer = () => {
    if (!timer) {
      return
    }

    clearInterval(timer)
    timer = null
  }

  const syncClockTimer = () => {
    if (activeSlots.size > 0) {
      startClockTimer()
      return
    }

    stopClockTimer()
  }

  const disposeStatusbarNode = () => {
    statusbarItem?.destroyRecursively()
    statusbarItem = null
    statusText = null
  }

  const disposeSidebarNode = () => {
    sidebarPanel?.destroyRecursively()
    sidebarPanel = null
    sidebarText = null
  }

  const updateClockText = () => {
    const timestamp = new Date().toLocaleTimeString()

    if (statusText) {
      if (statusText.isDestroyed) {
        statusText = null
      } else {
        statusText.content = `Clock plugin -> ${statusbarLabel} (${timestamp})`
      }
    }

    if (sidebarText) {
      if (sidebarText.isDestroyed) {
        sidebarText = null
      } else {
        sidebarText.content = `Last tick: ${timestamp}`
      }
    }
  }

  return {
    id: "clock-plugin",
    order: getClockOrder(),
    dispose() {
      stopClockTimer()
      activeSlots.clear()
      disposeStatusbarNode()
      disposeSidebarNode()
    },
    slots: {
      statusbar: {
        render(_ctx, data) {
          if (clockStatusbarErrorEnabled) {
            throw new Error("Forced clock statusbar failure")
          }

          statusbarLabel = data.label ?? "status"

          clockStats.statusbarCreates++

          const item = new BoxRenderable(rendererInstance, {
            id: `clock-statusbar-${clockStats.statusbarCreates}`,
            border: true,
            borderStyle: "single",
            borderColor: "#2563eb",
            paddingLeft: 1,
            paddingRight: 1,
            height: 3,
            marginLeft: 1,
            backgroundColor: "#0f172a",
          })
          statusbarItem = item

          statusText = new TextRenderable(rendererInstance, {
            id: `clock-statusbar-text-${clockStats.statusbarCreates}`,
            content: `Clock plugin -> ${statusbarLabel}`,
            fg: "#93c5fd",
          })

          item.add(statusText)
          updateClockText()
          updateInfoPanel()
          return item
        },
        onActivate() {
          activeSlots.add("statusbar")
          syncClockTimer()
        },
        onDeactivate() {
          activeSlots.delete("statusbar")
          disposeStatusbarNode()
          syncClockTimer()
        },
        onDispose() {
          activeSlots.delete("statusbar")
          disposeStatusbarNode()
          syncClockTimer()
        },
      },
      sidebar: {
        render(_ctx, data) {
          if (clockSidebarErrorEnabled) {
            throw new Error("Forced clock sidebar failure")
          }

          clockStats.sidebarCreates++

          const panel = new BoxRenderable(rendererInstance, {
            id: `clock-sidebar-${clockStats.sidebarCreates}`,
            border: true,
            borderStyle: "single",
            borderColor: "#0ea5e9",
            flexDirection: "column",
            height: 6,
            marginBottom: 1,
            padding: 1,
          })
          sidebarPanel = panel

          panel.add(
            new TextRenderable(rendererInstance, {
              id: `clock-sidebar-title-${clockStats.sidebarCreates}`,
              content: `Clock Sidebar (${data.section ?? "left"})`,
              fg: "#38bdf8",
            }),
          )

          sidebarText = new TextRenderable(rendererInstance, {
            id: `clock-sidebar-text-${clockStats.sidebarCreates}`,
            content: "Last tick: --:--:--",
            fg: "#e2e8f0",
            marginTop: 1,
          })

          panel.add(sidebarText)
          updateClockText()
          updateInfoPanel()
          return panel
        },
        onActivate() {
          activeSlots.add("sidebar")
          syncClockTimer()
        },
        onDeactivate() {
          activeSlots.delete("sidebar")
          disposeSidebarNode()
          syncClockTimer()
        },
        onDispose() {
          activeSlots.delete("sidebar")
          disposeSidebarNode()
          syncClockTimer()
        },
      },
    },
  }
}

function createActivityPlugin(rendererInstance: CliRenderer): CorePlugin<DemoSlot, DemoContext, DemoSlotData> {
  let activityItem: BoxRenderable | null = null
  let activityText: TextRenderable | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let phase = 0
  let statusbarActive = false
  let statusbarLabel = "status"

  const pulse = [".", "..", "...", "...."]

  const startActivityTimer = () => {
    if (timer) {
      return
    }

    updateActivityText()
    timer = setInterval(updateActivityText, 700)
  }

  const stopActivityTimer = () => {
    if (!timer) {
      return
    }

    clearInterval(timer)
    timer = null
  }

  const syncActivityTimer = () => {
    if (statusbarActive) {
      startActivityTimer()
      return
    }

    stopActivityTimer()
  }

  const disposeStatusbarNode = () => {
    activityItem?.destroyRecursively()
    activityItem = null
    activityText = null
  }

  const updateActivityText = () => {
    phase = (phase + 1) % pulse.length
    if (activityText) {
      if (activityText.isDestroyed) {
        activityText = null
      } else {
        activityText.content = `Activity (${statusbarLabel})${pulse[phase]}`
      }
    }
  }

  return {
    id: "activity-plugin",
    order: getActivityOrder(),
    dispose() {
      statusbarActive = false
      stopActivityTimer()
      disposeStatusbarNode()
    },
    slots: {
      statusbar: {
        render(_ctx, data) {
          if (activityStatusbarErrorEnabled) {
            throw new Error("Forced activity statusbar failure")
          }

          statusbarLabel = data.label ?? "status"

          activityStats.statusbarCreates++

          const item = new BoxRenderable(rendererInstance, {
            id: `activity-statusbar-${activityStats.statusbarCreates}`,
            border: true,
            borderStyle: "single",
            borderColor: "#16a34a",
            paddingLeft: 1,
            paddingRight: 1,
            height: 3,
            marginLeft: 1,
            backgroundColor: "#052e16",
          })
          activityItem = item

          activityText = new TextRenderable(rendererInstance, {
            id: `activity-statusbar-text-${activityStats.statusbarCreates}`,
            content: `Activity (${statusbarLabel})`,
            fg: "#86efac",
          })

          item.add(activityText)
          updateActivityText()
          updateInfoPanel()
          return item
        },
        onActivate() {
          statusbarActive = true
          syncActivityTimer()
        },
        onDeactivate() {
          statusbarActive = false
          disposeStatusbarNode()
          syncActivityTimer()
        },
        onDispose() {
          statusbarActive = false
          disposeStatusbarNode()
          syncActivityTimer()
        },
      },
    },
  }
}

function setClockPluginEnabled(enabled: boolean): void {
  if (!slotRegistry || !renderer) {
    return
  }

  if (enabled && !clockPluginEnabled) {
    unregisterClockPlugin = registerCorePlugin(slotRegistry, createClockPlugin(renderer))
    clockPluginEnabled = true
  } else if (!enabled && clockPluginEnabled) {
    unregisterClockPlugin?.()
    unregisterClockPlugin = null
    clockPluginEnabled = false
  }

  updateInfoPanel()
}

function setActivityPluginEnabled(enabled: boolean): void {
  if (!slotRegistry || !renderer) {
    return
  }

  if (enabled && !activityPluginEnabled) {
    unregisterActivityPlugin = registerCorePlugin(slotRegistry, createActivityPlugin(renderer))
    activityPluginEnabled = true
  } else if (!enabled && activityPluginEnabled) {
    unregisterActivityPlugin?.()
    unregisterActivityPlugin = null
    activityPluginEnabled = false
  }

  updateInfoPanel()
}

function handleKeyPress(key: KeyEvent): void {
  if (!slotRegistry) {
    return
  }

  switch (key.name) {
    case "1":
      setClockPluginEnabled(!clockPluginEnabled)
      break
    case "2":
      setActivityPluginEnabled(!activityPluginEnabled)
      break
    case "m":
      statusbarMode = nextStatusbarMode(statusbarMode)
      if (statusbarSlot) {
        statusbarSlot.mode = statusbarMode
      }
      updateInfoPanel()
      break
    case "o":
      orderFlipped = !orderFlipped
      slotRegistry.updateOrder("clock-plugin", getClockOrder())
      slotRegistry.updateOrder("activity-plugin", getActivityOrder())
      updateInfoPanel()
      break
    case "r":
      statusbarSlot?.refresh()
      sidebarSlot?.refresh()
      updateInfoPanel()
      break
    case "e":
      clockStatusbarErrorEnabled = !clockStatusbarErrorEnabled
      remountEnabledPlugins()
      updateInfoPanel()
      break
    case "w":
      clockSidebarErrorEnabled = !clockSidebarErrorEnabled
      remountEnabledPlugins()
      updateInfoPanel()
      break
    case "d":
      activityStatusbarErrorEnabled = !activityStatusbarErrorEnabled
      remountEnabledPlugins()
      updateInfoPanel()
      break
    case "p":
      showPluginFailurePlaceholder = !showPluginFailurePlaceholder
      remountEnabledPlugins()
      updateInfoPanel()
      break
    case "x":
      resetPluginFailureState()
      break
  }
}

function createLayout(rendererInstance: CliRenderer): void {
  rootContainer = new BoxRenderable(rendererInstance, {
    id: "core-plugin-demo-root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
    backgroundColor: "#020617",
  })

  const body = new BoxRenderable(rendererInstance, {
    id: "core-plugin-demo-body",
    width: "100%",
    flexGrow: 1,
    flexDirection: "row",
  })

  infoPanel = new BoxRenderable(rendererInstance, {
    id: "core-plugin-demo-info-panel",
    flexGrow: 1,
    border: true,
    borderStyle: "single",
    borderColor: "#334155",
    flexDirection: "column",
    padding: 1,
  })

  infoText = new TextRenderable(rendererInstance, {
    id: "core-plugin-demo-info-text",
    fg: "#e2e8f0",
    content: "",
  })

  infoPanel.add(infoText)

  rootContainer.add(body)
  rendererInstance.root.add(rootContainer)

  // The SlotRenderables are created later in run() after the registry exists,
  // but we need to save the body reference to add them.
  // We'll add the slots in run() instead.
  ;(rootContainer as any).__body = body
}

export function run(rendererInstance: CliRenderer): void {
  clockStats.statusbarCreates = 0
  clockStats.sidebarCreates = 0
  activityStats.statusbarCreates = 0
  activityStats.sidebarCreates = 0

  renderer = rendererInstance
  renderer.setBackgroundColor("#000000")

  createLayout(rendererInstance)

  slotRegistry = createCoreSlotRegistry<DemoSlot, DemoContext, DemoSlotData>(rendererInstance, DEMO_CONTEXT)

  if (!slotRegistry || !rootContainer) {
    return
  }

  const body = (rootContainer as any).__body as BoxRenderable

  unregisterPluginErrorListener = slotRegistry.onPluginError((event) => {
    pushPluginError(event)
    updateInfoPanel()
  })

  statusbarSlot = new SlotRenderable(rendererInstance, {
    id: "core-plugin-demo-statusbar-slot",
    registry: slotRegistry,
    name: "statusbar",
    data: { label: DEMO_STATUS_LABEL },
    mode: statusbarMode,
    width: "100%",
    height: 5,
    alignItems: "center",
    flexDirection: "row",
    paddingLeft: 1,
    marginBottom: 1,
    fallback: () =>
      new TextRenderable(rendererInstance, {
        id: "statusbar-fallback",
        content: "Fallback statusbar content",
        fg: "#94a3b8",
      }),
    pluginFailurePlaceholder: (failure) => {
      if (!showPluginFailurePlaceholder) {
        return undefined
      }

      return createPluginFailurePlaceholder(rendererInstance, failure, "#fb7185")
    },
  })

  sidebarSlot = new SlotRenderable(rendererInstance, {
    id: "core-plugin-demo-sidebar-slot",
    registry: slotRegistry,
    name: "sidebar",
    data: { section: DEMO_SIDEBAR_SECTION },
    mode: "replace",
    width: 36,
    flexDirection: "column",
    padding: 1,
    marginRight: 1,
    fallback: () =>
      new TextRenderable(rendererInstance, {
        id: "sidebar-fallback",
        content: "No sidebar plugin active",
        fg: "#94a3b8",
      }),
    pluginFailurePlaceholder: (failure) => {
      if (!showPluginFailurePlaceholder) {
        return undefined
      }

      return createPluginFailurePlaceholder(rendererInstance, failure, "#f97316")
    },
  })

  // Insert statusbar before the body
  rootContainer.add(statusbarSlot, 0)
  body.add(sidebarSlot)
  body.add(infoPanel!)

  setClockPluginEnabled(true)
  setActivityPluginEnabled(true)

  renderer.keyInput.on("keypress", handleKeyPress)
  updateInfoPanel()
}

export function destroy(rendererInstance: CliRenderer): void {
  rendererInstance.keyInput.off("keypress", handleKeyPress)
  unregisterPluginErrorListener?.()
  unregisterPluginErrorListener = null

  unregisterClockPlugin?.()
  unregisterClockPlugin = null
  unregisterActivityPlugin?.()
  unregisterActivityPlugin = null

  // SlotRenderables are destroyed as part of the tree via destroyRecursively
  statusbarSlot = null
  sidebarSlot = null

  slotRegistry = null

  rootContainer?.destroyRecursively()

  rootContainer = null
  infoPanel = null
  infoText = null

  clockPluginEnabled = false
  activityPluginEnabled = false
  statusbarMode = "append"
  orderFlipped = false
  clockStatusbarErrorEnabled = false
  clockSidebarErrorEnabled = false
  activityStatusbarErrorEnabled = false
  showPluginFailurePlaceholder = true
  pluginErrorHistory = []
  placeholderCreateCount = 0

  renderer = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
  })

  run(renderer)
  setupCommonDemoKeys(renderer)
}
