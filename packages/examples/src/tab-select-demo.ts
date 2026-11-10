import {
  createCliRenderer,
  TabSelectRenderable,
  TabSelectRenderableEvents,
  RenderableEvents,
  BoxRenderable,
  type TabSelectOption,
  type CliRenderer,
  t,
  bold,
  fg,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import { TextRenderable } from "@opentui/core"

let tabSelect: TabSelectRenderable | null = null
let renderer: CliRenderer | null = null
let keyboardHandler: ((key: any) => void) | null = null
let parentContainer: BoxRenderable | null = null
let keyLegendDisplay: TextRenderable | null = null
let statusDisplay: TextRenderable | null = null
let lastSelectedItem: TabSelectOption | null = null

const tabOptions: TabSelectOption[] = [
  { name: "Home", description: "Welcome to the home page", value: "home" },
  { name: "Profile", description: "Manage your user profile", value: "profile" },
  { name: "Settings", description: "Configure application settings", value: "settings" },
  { name: "About", description: "Learn more about this application", value: "about" },
  { name: "Help", description: "Get help and support", value: "help" },
  { name: "Projects", description: "View and manage your projects", value: "projects" },
  { name: "Dashboard", description: "View analytics and statistics", value: "dashboard" },
  { name: "Reports", description: "Generate and view reports", value: "reports" },
  { name: "Users", description: "Manage user accounts", value: "users" },
  { name: "Admin", description: "Administrative functions", value: "admin" },
  { name: "Tools", description: "Various utility tools", value: "tools" },
  { name: "API", description: "API documentation and testing", value: "api" },
]

function updateDisplays() {
  if (!tabSelect || !parentContainer) return

  const underlineStatus = tabSelect.showUnderline ? "on" : "off"
  const description = tabSelect.showDescription ? "on" : "off"
  const scrollArrows = tabSelect.showScrollArrows ? "on" : "off"
  const wrap = tabSelect.wrapSelection ? "on" : "off"

  const keyLegendText = t`${bold(fg("#FFFFFF")("Key Controls:"))}
←/→ or [/]: Navigate tabs
Enter: Select tab
F: Toggle focus
U: Toggle underline
P: Toggle description
S: Toggle scroll arrows
W: Toggle wrap selection`

  if (keyLegendDisplay) {
    keyLegendDisplay.content = keyLegendText
  }

  const currentHighlighted = tabSelect.getSelectedOption()
  const highlightedText = currentHighlighted
    ? `Highlighted: ${currentHighlighted.name} (${currentHighlighted.value}) - Index: ${tabSelect.getSelectedIndex()}`
    : "No highlighted item"

  const selectedText = lastSelectedItem
    ? `Last Selected: ${lastSelectedItem.name} (${lastSelectedItem.value})`
    : "No item selected yet (press Enter to select)"

  const focusText = tabSelect.focused ? "Tab selector is FOCUSED" : "Tab selector is BLURRED"
  const focusColor = tabSelect.focused ? "#00FF00" : "#FF0000"

  const statusText = t`${fg("#00FF00")(highlightedText)}
${fg("#FFFF00")(selectedText)}

${fg(focusColor)(focusText)}

${fg("#CCCCCC")(`Underline: ${underlineStatus} | Description: ${description} | Scroll arrows: ${scrollArrows} | Wrap: ${wrap}`)}`

  if (statusDisplay) {
    statusDisplay.content = statusText
  }
}

export function run(rendererInstance: CliRenderer): void {
  renderer = rendererInstance
  renderer.setBackgroundColor("#001122")

  parentContainer = new BoxRenderable(renderer, {
    id: "tab-select-container",
    zIndex: 10,
  })
  renderer.root.add(parentContainer)

  tabSelect = new TabSelectRenderable(renderer, {
    id: "main-tabs",
    position: "absolute",
    left: 5,
    top: 2,
    width: 70,
    options: tabOptions,
    zIndex: 100,
    tabWidth: 12,
    backgroundColor: "#1e293b",
    focusedBackgroundColor: "#2d3748",
    textColor: "#e2e8f0",
    focusedTextColor: "#f7fafc",
    selectedBackgroundColor: "#3b82f6",
    selectedTextColor: "#ffffff",
    selectedDescriptionColor: "#cbd5e1",
    showDescription: true,
    showUnderline: true,
    showScrollArrows: true,
    wrapSelection: false,
  })

  renderer.root.add(tabSelect)

  keyLegendDisplay = new TextRenderable(renderer, {
    id: "key-legend",
    content: t``,
    width: 40,
    height: 10,
    position: "absolute",
    left: 5,
    top: 8,
    zIndex: 50,
    fg: "#AAAAAA",
  })
  parentContainer.add(keyLegendDisplay)

  // Create status display
  statusDisplay = new TextRenderable(renderer, {
    id: "status-display",
    content: t``,
    width: 80,
    height: 6,
    position: "absolute",
    left: 5,
    top: 19,
    zIndex: 50,
  })
  parentContainer.add(statusDisplay)

  tabSelect.on(TabSelectRenderableEvents.SELECTION_CHANGED, (index: number, option: TabSelectOption) => {
    updateDisplays()
  })

  tabSelect.on(TabSelectRenderableEvents.ITEM_SELECTED, (index: number, option: TabSelectOption) => {
    lastSelectedItem = option
    updateDisplays()
  })

  tabSelect.on(RenderableEvents.FOCUSED, () => {
    updateDisplays()
  })

  tabSelect.on(RenderableEvents.BLURRED, () => {
    updateDisplays()
  })

  updateDisplays()

  keyboardHandler = (key) => {
    if (key.name === "f") {
      if (tabSelect?.focused) {
        tabSelect.blur()
      } else {
        tabSelect?.focus()
      }
    } else if (key.name === "u") {
      tabSelect!.showUnderline = !tabSelect!.showUnderline
      updateDisplays()
    } else if (key.name === "p") {
      tabSelect!.showDescription = !tabSelect!.showDescription
      updateDisplays()
    } else if (key.name === "s") {
      tabSelect!.showScrollArrows = !tabSelect!.showScrollArrows
      updateDisplays()
    } else if (key.name === "w") {
      tabSelect!.wrapSelection = !tabSelect!.wrapSelection
      updateDisplays()
    }
  }

  rendererInstance.keyInput.on("keypress", keyboardHandler)
  tabSelect.focus()
}

export function destroy(rendererInstance: CliRenderer): void {
  if (keyboardHandler) {
    rendererInstance.keyInput.off("keypress", keyboardHandler)
    keyboardHandler = null
  }

  if (tabSelect) {
    rendererInstance.root.remove(tabSelect)
    tabSelect.destroy()
    tabSelect = null
  }

  if (parentContainer) {
    const tabSelectContainer = rendererInstance.root.getRenderable("tab-select-container")
    tabSelectContainer?.destroyRecursively()
    parentContainer = null
  }

  keyLegendDisplay = null
  statusDisplay = null
  lastSelectedItem = null
  renderer = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  })

  run(renderer)
  setupCommonDemoKeys(renderer)
}
