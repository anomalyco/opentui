import {
  createCliRenderer,
  SelectRenderable,
  SelectRenderableEvents,
  RenderableEvents,
  type SelectOption,
  type CliRenderer,
  t,
  bold,
  fg,
  BoxRenderable,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import { TextRenderable } from "@opentui/core"

let selectElement: SelectRenderable | null = null
let renderer: CliRenderer | null = null
let keyboardHandler: ((key: any) => void) | null = null
let keyLegendDisplay: TextRenderable | null = null
let statusDisplay: TextRenderable | null = null
let lastActionText: string = "Welcome to SelectRenderable demo! Use the controls to test features."
let lastActionColor: string = "#FFCC00"

const selectOptions: SelectOption[] = [
  { name: "Home", description: "Navigate to the home page", value: "home" },
  { name: "Profile", description: "View and edit your user profile", value: "profile" },
  { name: "Settings", description: "Configure application preferences", value: "settings" },
  { name: "Dashboard", description: "View analytics and key metrics", value: "dashboard" },
  { name: "Projects", description: "Manage your active projects", value: "projects" },
  { name: "Reports", description: "Generate and view detailed reports", value: "reports" },
  { name: "Users", description: "Manage user accounts and permissions", value: "users" },
  { name: "Analytics", description: "Deep dive into usage analytics", value: "analytics" },
  { name: "Tools", description: "Access various utility tools", value: "tools" },
  { name: "API Documentation", description: "Browse API endpoints and examples", value: "api" },
  { name: "Help Center", description: "Find answers to common questions", value: "help" },
  { name: "Support", description: "Contact our support team", value: "support" },
  { name: "Billing", description: "Manage your subscription and billing", value: "billing" },
  { name: "Integrations", description: "Connect with third-party services", value: "integrations" },
  { name: "Security", description: "Configure security settings", value: "security" },
  { name: "Notifications", description: "Manage your notification preferences", value: "notifications" },
  { name: "Backup", description: "Backup and restore your data", value: "backup" },
  { name: "Import/Export", description: "Import or export your data", value: "import-export" },
  { name: "Advanced Settings", description: "Configure advanced options", value: "advanced" },
  { name: "About", description: "Learn more about this application", value: "about" },
]

function updateDisplays() {
  if (!selectElement) return

  const scrollIndicator = selectElement.showScrollIndicator ? "on" : "off"
  const description = selectElement.showDescription ? "on" : "off"
  const wrap = selectElement.wrapSelection ? "on" : "off"

  const keyLegendText = t`${bold(fg("#FFFFFF")("Key Controls:"))}
↑/↓ or j/k: Navigate items
Shift+↑/↓ or Shift+j/k: Fast scroll
Enter: Select item
F: Toggle focus
D: Toggle descriptions
S: Toggle scroll indicator
W: Toggle wrap selection`

  if (keyLegendDisplay) {
    keyLegendDisplay.content = keyLegendText
  }

  const currentSelection = selectElement.getSelectedOption()
  const selectionText = currentSelection
    ? `Selection: ${currentSelection.name} (${currentSelection.value}) - Index: ${selectElement.getSelectedIndex()}`
    : "No selection"

  const focusText = selectElement.focused ? "Select element is FOCUSED" : "Select element is BLURRED"
  const focusColor = selectElement.focused ? "#00FF00" : "#FF0000"

  const statusText = t`${fg("#00FF00")(selectionText)}

${fg(focusColor)(focusText)}

${fg("#CCCCCC")(`Scroll indicator: ${scrollIndicator} | Description: ${description} | Wrap: ${wrap}`)}

${fg(lastActionColor)(lastActionText)}`

  if (statusDisplay) {
    statusDisplay.content = statusText
  }
}

export function run(rendererInstance: CliRenderer): void {
  renderer = rendererInstance
  renderer.setBackgroundColor("#001122")

  const parentContainer = new BoxRenderable(renderer, {
    id: "parent-container",
    zIndex: 10,
  })
  renderer.root.add(parentContainer)

  selectElement = new SelectRenderable(renderer, {
    id: "demo-select",
    position: "absolute",
    left: 5,
    top: 2,
    width: 50,
    height: 20,
    options: selectOptions,
    zIndex: 100,
    backgroundColor: "#1e293b",
    focusedBackgroundColor: "#2d3748",
    textColor: "#e2e8f0",
    focusedTextColor: "#f7fafc",
    selectedBackgroundColor: "#3b82f6",
    selectedTextColor: "#ffffff",
    descriptionColor: "#94a3b8",
    selectedDescriptionColor: "#cbd5e1",
    showDescription: true,
    showScrollIndicator: true,
    wrapSelection: false,
    fastScrollStep: 5,
  })

  renderer.root.add(selectElement)

  keyLegendDisplay = new TextRenderable(renderer, {
    id: "key-legend",
    content: t``,
    width: 40,
    height: 9,
    position: "absolute",
    left: 60,
    top: 3,
    zIndex: 50,
    fg: "#AAAAAA",
  })
  parentContainer.add(keyLegendDisplay)

  statusDisplay = new TextRenderable(renderer, {
    id: "status-display",
    content: t``,
    width: 80,
    height: 8,
    position: "absolute",
    left: 5,
    top: 24,
    zIndex: 50,
  })
  parentContainer.add(statusDisplay)

  selectElement.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number, option: SelectOption) => {
    lastActionText = `Navigation: Moved to "${option.name}"`
    lastActionColor = "#FFCC00"
    updateDisplays()
  })

  selectElement.on(SelectRenderableEvents.ITEM_SELECTED, (index: number, option: SelectOption) => {
    lastActionText = `*** ACTIVATED: ${option.name} (${option.value}) ***`
    lastActionColor = "#FF00FF"
    updateDisplays()
    setTimeout(() => {
      lastActionColor = "#FFCC00"
      updateDisplays()
    }, 1000)
  })

  selectElement.on(RenderableEvents.FOCUSED, () => {
    updateDisplays()
  })

  selectElement.on(RenderableEvents.BLURRED, () => {
    updateDisplays()
  })

  updateDisplays()

  keyboardHandler = (key) => {
    if (key.name === "f") {
      if (selectElement?.focused) {
        selectElement.blur()
        lastActionText = "Focus removed from select element"
      } else {
        selectElement?.focus()
        lastActionText = "Select element focused"
      }
      lastActionColor = "#FFCC00"
      updateDisplays()
    } else if (key.name === "d") {
      const newState = !selectElement?.showDescription
      selectElement!.showDescription = newState
      lastActionText = `Descriptions ${newState ? "enabled" : "disabled"}`
      lastActionColor = "#FFCC00"
      updateDisplays()
    } else if (key.name === "s") {
      const newState = !selectElement?.showScrollIndicator
      selectElement!.showScrollIndicator = newState
      lastActionText = `Scroll indicator ${newState ? "enabled" : "disabled"}`
      lastActionColor = "#FFCC00"
      updateDisplays()
    } else if (key.name === "w") {
      const newState = !selectElement?.wrapSelection
      selectElement!.wrapSelection = newState
      lastActionText = `Wrap selection ${newState ? "enabled" : "disabled"}`
      lastActionColor = "#FFCC00"
      updateDisplays()
    }
  }

  rendererInstance.keyInput.on("keypress", keyboardHandler)
  selectElement.focus()
}

export function destroy(rendererInstance: CliRenderer): void {
  if (keyboardHandler) {
    rendererInstance.keyInput.off("keypress", keyboardHandler)
    keyboardHandler = null
  }

  selectElement?.destroy()
  selectElement = null
  const parentContainer = rendererInstance.root.getRenderable("parent-container")
  parentContainer?.destroyRecursively()

  keyLegendDisplay = null
  statusDisplay = null
  renderer = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  })

  run(renderer)
  setupCommonDemoKeys(renderer)
  renderer.start()
}
