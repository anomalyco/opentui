import {
  BoxRenderable,
  CliRenderer,
  ScrollBoxRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  TextAttributes,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
  type KeyEvent,
  type SelectOption,
} from "@opentui/core"
import { ErrorCorrectionLevel, QRCode, QRCodeRenderable } from "@opentui/qrcode"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

const ROOT_ID = "qrcode-demo-root"
const DEFAULT_MAX_SCALE = 8

interface DemoTheme {
  name: string
  background: string
  panel: string
  panelAlt: string
  accent: string
  accent2: string
  text: string
  muted: string
  inputBg: string
  inputFocusedBg: string
  selectionBg: string
  qrFg: string
  qrBg: string
  qrFallback: string
}

interface PresetUrl {
  label: string
  url: string
}

const PRESET_URLS: PresetUrl[] = [
  { label: "OpenTUI", url: "https://opentui.com" },
  { label: "GitHub", url: "https://github.com/anomalyco/opentui" },
  { label: "Docs", url: "https://opentui.com/docs" },
  { label: "Examples", url: "https://opentui.com/examples" },
  { label: "QR Spec", url: "https://www.iso.org/standard/83389.html" },
  { label: "Terminal Art", url: "https://en.wikipedia.org/wiki/ANSI_art" },
  { label: "Matrix", url: "https://matrix.org" },
  { label: "TUI Ideas", url: "https://github.com/topics/tui" },
]

const THEMES: DemoTheme[] = [
  {
    name: "Dracula",
    background: "#282a36",
    panel: "#343746",
    panelAlt: "#44475a",
    accent: "#ff79c6",
    accent2: "#bd93f9",
    text: "#f8f8f2",
    muted: "#bfbfbf",
    inputBg: "#1e1f29",
    inputFocusedBg: "#44475a",
    selectionBg: "#6272a4",
    qrFg: "#5b2154",
    qrBg: "#ffd6f1",
    qrFallback: "#ff79c6",
  },
  {
    name: "Tokyo Night",
    background: "#1a1b26",
    panel: "#24283b",
    panelAlt: "#292e42",
    accent: "#7aa2f7",
    accent2: "#bb9af7",
    text: "#c0caf5",
    muted: "#a9b1d6",
    inputBg: "#16161e",
    inputFocusedBg: "#2f3549",
    selectionBg: "#3b4261",
    qrFg: "#1d4f91",
    qrBg: "#d8e6ff",
    qrFallback: "#7aa2f7",
  },
  {
    name: "Catppuccin Mocha",
    background: "#1e1e2e",
    panel: "#313244",
    panelAlt: "#45475a",
    accent: "#cba6f7",
    accent2: "#f5c2e7",
    text: "#cdd6f4",
    muted: "#a6adc8",
    inputBg: "#181825",
    inputFocusedBg: "#45475a",
    selectionBg: "#585b70",
    qrFg: "#6c3f99",
    qrBg: "#ead7ff",
    qrFallback: "#cba6f7",
  },
  {
    name: "Monokai Pro",
    background: "#2d2a2e",
    panel: "#403e41",
    panelAlt: "#4a474b",
    accent: "#ffd866",
    accent2: "#ff6188",
    text: "#fcfcfa",
    muted: "#c1c0c0",
    inputBg: "#221f22",
    inputFocusedBg: "#4a474b",
    selectionBg: "#5b595c",
    qrFg: "#7a5010",
    qrBg: "#ffe89a",
    qrFallback: "#ffd866",
  },
  {
    name: "SynthWave '84",
    background: "#262335",
    panel: "#2b213a",
    panelAlt: "#34294f",
    accent: "#ff7edb",
    accent2: "#36f9f6",
    text: "#f92aad",
    muted: "#c792ea",
    inputBg: "#1f1b2d",
    inputFocusedBg: "#34294f",
    selectionBg: "#614d85",
    qrFg: "#80306f",
    qrBg: "#ffd1f5",
    qrFallback: "#ff7edb",
  },
  {
    name: "Cyberpunk 2077",
    background: "#0b1026",
    panel: "#111936",
    panelAlt: "#1c2550",
    accent: "#fcee0a",
    accent2: "#00f0ff",
    text: "#fcee0a",
    muted: "#8ee6ff",
    inputBg: "#070b1a",
    inputFocusedBg: "#1c2550",
    selectionBg: "#005f73",
    qrFg: "#4f4800",
    qrBg: "#fff36b",
    qrFallback: "#fcee0a",
  },
  {
    name: "Nord Aurora",
    background: "#2e3440",
    panel: "#3b4252",
    panelAlt: "#434c5e",
    accent: "#88c0d0",
    accent2: "#b48ead",
    text: "#eceff4",
    muted: "#d8dee9",
    inputBg: "#242933",
    inputFocusedBg: "#434c5e",
    selectionBg: "#5e81ac",
    qrFg: "#2f5f73",
    qrBg: "#c9edf5",
    qrFallback: "#88c0d0",
  },
  {
    name: "Gruvbox Material",
    background: "#282828",
    panel: "#3c3836",
    panelAlt: "#504945",
    accent: "#fabd2f",
    accent2: "#fe8019",
    text: "#fbf1c7",
    muted: "#d5c4a1",
    inputBg: "#1d2021",
    inputFocusedBg: "#504945",
    selectionBg: "#665c54",
    qrFg: "#6b4b00",
    qrBg: "#f3d38b",
    qrFallback: "#fabd2f",
  },
  {
    name: "Kanagawa Wave",
    background: "#1f1f28",
    panel: "#2a2a37",
    panelAlt: "#363646",
    accent: "#7e9cd8",
    accent2: "#ff9e3b",
    text: "#dcd7ba",
    muted: "#c8c093",
    inputBg: "#16161d",
    inputFocusedBg: "#363646",
    selectionBg: "#54546d",
    qrFg: "#304f8a",
    qrBg: "#d7e4ff",
    qrFallback: "#7e9cd8",
  },
  {
    name: "Rosé Pine Moon",
    background: "#232136",
    panel: "#2a273f",
    panelAlt: "#393552",
    accent: "#eb6f92",
    accent2: "#c4a7e7",
    text: "#e0def4",
    muted: "#908caa",
    inputBg: "#1f1d2e",
    inputFocusedBg: "#393552",
    selectionBg: "#44415a",
    qrFg: "#83394f",
    qrBg: "#ffd6df",
    qrFallback: "#eb6f92",
  },
  {
    name: "One Dark Pro",
    background: "#282c34",
    panel: "#31353f",
    panelAlt: "#3e4451",
    accent: "#61afef",
    accent2: "#c678dd",
    text: "#abb2bf",
    muted: "#828997",
    inputBg: "#21252b",
    inputFocusedBg: "#3e4451",
    selectionBg: "#3f5873",
    qrFg: "#245f8f",
    qrBg: "#d6ecff",
    qrFallback: "#61afef",
  },
  {
    name: "Night Owl",
    background: "#011627",
    panel: "#0b2942",
    panelAlt: "#16324f",
    accent: "#82aaff",
    accent2: "#c792ea",
    text: "#d6deeb",
    muted: "#7fdbca",
    inputBg: "#010d18",
    inputFocusedBg: "#16324f",
    selectionBg: "#1d3b53",
    qrFg: "#0b4f85",
    qrBg: "#d6e8ff",
    qrFallback: "#82aaff",
  },
]

const ERROR_CORRECTION_OPTIONS: SelectOption[] = [
  { name: "L - 7% smallest", description: "", value: ErrorCorrectionLevel.L },
  { name: "M - 15% balanced", description: "", value: ErrorCorrectionLevel.M },
  { name: "Q - 25% durable", description: "", value: ErrorCorrectionLevel.Q },
  { name: "H - 30% strongest", description: "", value: ErrorCorrectionLevel.H },
]

const SCALE_OPTIONS: SelectOption[] = [
  { name: "Max scale 1", description: "", value: 1 },
  { name: "Max scale 2", description: "", value: 2 },
  { name: "Max scale 4", description: "", value: 4 },
  { name: "Max scale 8", description: "", value: DEFAULT_MAX_SCALE },
  { name: "Max scale 12", description: "", value: 12 },
]

const QUIET_ZONE_OPTIONS: SelectOption[] = [
  { name: "Quiet 4 ISO min", description: "", value: 4 },
  { name: "Quiet 5", description: "", value: 5 },
  { name: "Quiet 6", description: "", value: 6 },
  { name: "Quiet 8 wide", description: "", value: 8 },
]

let renderer: CliRenderer | null = null
let root: BoxRenderable | null = null
let inputBox: BoxRenderable | null = null
let qrArea: BoxRenderable | null = null
let advancedBox: BoxRenderable | null = null
let advancedScrollBox: ScrollBoxRenderable | null = null
let qrCode: QRCodeRenderable | null = null
let customInput: TextareaRenderable | null = null
let footerText: TextRenderable | null = null
let eclSelect: SelectRenderable | null = null
let scaleSelect: SelectRenderable | null = null
let quietZoneSelect: SelectRenderable | null = null
let eclLabel: TextRenderable | null = null
let scaleLabel: TextRenderable | null = null
let quietZoneLabel: TextRenderable | null = null
let currentPresetIndex = 0
let currentThemeIndex = 0
let advancedVisible = false
let currentFocusIndex = 0
let keyboardHandler: ((key: KeyEvent) => void) | null = null
const focusableElements: Array<TextareaRenderable | SelectRenderable> = []
const advancedLabels: Array<{ label: TextRenderable; select: SelectRenderable; content: string }> = []

function currentTheme(): DemoTheme {
  return THEMES[currentThemeIndex]!
}

function activeContent(): string {
  return customInput?.plainText.trim() || PRESET_URLS[currentPresetIndex]!.url
}

function createLabel(
  rendererInstance: CliRenderer,
  select: SelectRenderable,
  content: string,
  marginTop = 0,
): TextRenderable {
  const label = new TextRenderable(rendererInstance, {
    content: `  ${content}`,
    fg: currentTheme().text,
    bg: "transparent",
    height: 1,
    marginTop,
    attributes: TextAttributes.BOLD,
    flexShrink: 0,
  })
  advancedLabels.push({ label, select, content })
  return label
}

function createSelect(
  rendererInstance: CliRenderer,
  id: string,
  options: SelectOption[],
  selectedIndex: number,
  height: number,
): SelectRenderable {
  return new SelectRenderable(rendererInstance, {
    id,
    width: "100%",
    height,
    options,
    selectedIndex,
    backgroundColor: currentTheme().panelAlt,
    focusedBackgroundColor: currentTheme().inputFocusedBg,
    textColor: currentTheme().text,
    focusedTextColor: currentTheme().text,
    selectedBackgroundColor: currentTheme().selectionBg,
    selectedTextColor: currentTheme().qrBg,
    descriptionColor: currentTheme().muted,
    selectedDescriptionColor: currentTheme().text,
    showDescription: false,
    showScrollIndicator: false,
    wrapSelection: true,
    flexShrink: 0,
  })
}

function applySelectTheme(select: SelectRenderable | null): void {
  if (!select) return
  const theme = currentTheme()
  select.backgroundColor = theme.panelAlt
  select.focusedBackgroundColor = theme.inputFocusedBg
  select.textColor = theme.text
  select.focusedTextColor = theme.text
  select.selectedBackgroundColor = theme.selectionBg
  select.selectedTextColor = theme.qrBg
  select.descriptionColor = theme.muted
  select.selectedDescriptionColor = theme.text
}

function applyTheme(): void {
  const theme = currentTheme()

  renderer?.setBackgroundColor(theme.background)
  if (root) root.backgroundColor = theme.background
  if (qrArea) qrArea.backgroundColor = theme.panel
  if (inputBox) {
    inputBox.backgroundColor = theme.panel
    inputBox.borderColor = theme.accent
    inputBox.focusedBorderColor = theme.accent2
  }
  if (advancedBox) {
    advancedBox.backgroundColor = theme.panelAlt
    advancedBox.borderColor = theme.accent2
  }
  if (advancedScrollBox) {
    advancedScrollBox.backgroundColor = theme.panelAlt
    advancedScrollBox.wrapper.backgroundColor = theme.panelAlt
    advancedScrollBox.viewport.backgroundColor = theme.panelAlt
    advancedScrollBox.content.backgroundColor = theme.panelAlt
    advancedScrollBox.verticalScrollBar.trackOptions = {
      foregroundColor: theme.accent,
      backgroundColor: theme.panel,
    }
  }
  if (customInput) {
    customInput.backgroundColor = theme.inputBg
    customInput.focusedBackgroundColor = theme.inputFocusedBg
    customInput.textColor = theme.text
    customInput.focusedTextColor = theme.text
    customInput.placeholderColor = theme.muted
    customInput.cursorColor = theme.accent
    customInput.selectionBg = theme.selectionBg
    customInput.selectionFg = theme.qrBg
  }
  if (footerText) footerText.fg = theme.muted
  for (const { label, select } of advancedLabels) {
    label.fg = select.focused ? theme.accent : theme.text
  }

  applySelectTheme(eclSelect)
  applySelectTheme(scaleSelect)
  applySelectTheme(quietZoneSelect)
  updateFocusStyles()
  updateQRCode()
}

function updateQRCode(): void {
  if (!qrCode) return

  const theme = currentTheme()
  const content = activeContent()
  const selectedEcl =
    (eclSelect?.getSelectedOption()?.value as ErrorCorrectionLevel | undefined) ?? ErrorCorrectionLevel.M

  try {
    QRCode.encodeText(content, selectedEcl)
    if (qrCode.content !== content && qrCode.errorCorrectionLevel !== selectedEcl) {
      qrCode.content = ""
    }
    qrCode.errorCorrectionLevel = selectedEcl
    qrCode.content = content
    qrCode.scale = (scaleSelect?.getSelectedOption()?.value as number | undefined) ?? DEFAULT_MAX_SCALE
    qrCode.quietZone = (quietZoneSelect?.getSelectedOption()?.value as number | undefined) ?? 4
    qrCode.fit = "contain"
    qrCode.foregroundColor = theme.qrFg
    qrCode.backgroundColor = theme.qrBg
    qrCode.fallbackColor = theme.qrFallback
  } catch {
    // Keep the previous valid QR visible if the current textarea content cannot be encoded.
  }
}

function rebuildFocusableElements(): void {
  focusableElements.length = 0
  if (customInput) focusableElements.push(customInput)
  if (advancedVisible) {
    if (eclSelect) focusableElements.push(eclSelect)
    if (scaleSelect) focusableElements.push(scaleSelect)
    if (quietZoneSelect) focusableElements.push(quietZoneSelect)
  }
  currentFocusIndex = Math.min(currentFocusIndex, Math.max(0, focusableElements.length - 1))
}

function updateFocus(): void {
  for (const element of [customInput, eclSelect, scaleSelect, quietZoneSelect]) {
    element?.blur()
  }
  focusableElements[currentFocusIndex]?.focus()
  ensureFocusedAdvancedControlVisible()
  updateFocusStyles()
}

function ensureFocusedAdvancedControlVisible(): void {
  if (!advancedScrollBox || !advancedVisible) return

  const focusedRows: Array<{ select: SelectRenderable | null; top: number; height: number }> = [
    { select: eclSelect, top: 0, height: 5 },
    { select: scaleSelect, top: 6, height: 6 },
    { select: quietZoneSelect, top: 13, height: 5 },
  ]
  const focused = focusedRows.find((item) => item.select?.focused)
  if (!focused) return

  const viewportTop = advancedScrollBox.scrollTop
  const viewportBottom = viewportTop + advancedScrollBox.viewport.height
  if (focused.top < viewportTop) {
    advancedScrollBox.scrollTop = focused.top
  } else if (focused.top + focused.height > viewportBottom) {
    advancedScrollBox.scrollTop = focused.top + focused.height - advancedScrollBox.viewport.height
  }
}

function updateFocusStyles(): void {
  const theme = currentTheme()
  for (const { label, select, content } of advancedLabels) {
    const focused = select.focused
    label.content = `${focused ? ">" : " "} ${content}`
    label.fg = focused ? theme.accent : theme.text
    select.selectedBackgroundColor = focused ? theme.accent : theme.selectionBg
    select.selectedTextColor = focused ? theme.qrBg : theme.text
  }
}

function cyclePreset(): void {
  currentPresetIndex = (currentPresetIndex + 1) % PRESET_URLS.length
  customInput?.setText(PRESET_URLS[currentPresetIndex]!.url)
  updateQRCode()
}

function cycleTheme(): void {
  currentThemeIndex = (currentThemeIndex + 1) % THEMES.length
  applyTheme()
}

function toggleAdvanced(): void {
  advancedVisible = !advancedVisible
  if (advancedBox) advancedBox.visible = advancedVisible
  rebuildFocusableElements()
  updateFocus()
}

function setupEvents(rendererInstance: CliRenderer): void {
  customInput?.on("line-info-change", updateQRCode)

  for (const select of [eclSelect, scaleSelect, quietZoneSelect]) {
    select?.on(SelectRenderableEvents.SELECTION_CHANGED, updateQRCode)
  }

  keyboardHandler = (key: KeyEvent) => {
    if (key.name === "tab") {
      if (focusableElements.length === 0) return
      key.preventDefault()
      currentFocusIndex = key.shift
        ? (currentFocusIndex - 1 + focusableElements.length) % focusableElements.length
        : (currentFocusIndex + 1) % focusableElements.length
      updateFocus()
      return
    }

    if (key.ctrl && key.name === "n") {
      key.preventDefault()
      cyclePreset()
    } else if (key.ctrl && key.name === "t") {
      key.preventDefault()
      cycleTheme()
    } else if (key.ctrl && key.name === "a") {
      key.preventDefault()
      toggleAdvanced()
    }
  }

  rendererInstance.keyInput.on("keypress", keyboardHandler)
}

export function run(rendererInstance: CliRenderer): void {
  renderer = rendererInstance
  renderer.start()
  renderer.setBackgroundColor(currentTheme().background)

  root = new BoxRenderable(renderer, {
    id: ROOT_ID,
    width: "100%",
    height: "100%",
    padding: 0,
    flexDirection: "column",
    rowGap: 0,
    backgroundColor: currentTheme().background,
  })
  renderer.root.add(root)

  inputBox = new BoxRenderable(renderer, {
    id: `${ROOT_ID}-input`,
    width: "100%",
    height: 3,
    paddingX: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: currentTheme().accent,
    focusedBorderColor: currentTheme().accent2,
    backgroundColor: currentTheme().panel,
    flexShrink: 0,
  })
  root.add(inputBox)

  customInput = new TextareaRenderable(renderer, {
    id: `${ROOT_ID}-custom-url`,
    width: "100%",
    height: "100%",
    initialValue: PRESET_URLS[currentPresetIndex]!.url,
    backgroundColor: currentTheme().inputBg,
    focusedBackgroundColor: currentTheme().inputFocusedBg,
    textColor: currentTheme().text,
    focusedTextColor: currentTheme().text,
    placeholder: "Type or paste a URL...",
    placeholderColor: currentTheme().muted,
    cursorColor: currentTheme().accent,
    selectionBg: currentTheme().selectionBg,
    selectionFg: currentTheme().qrBg,
    wrapMode: "char",
    showCursor: true,
  })
  inputBox.add(customInput)

  const body = new BoxRenderable(renderer, {
    id: `${ROOT_ID}-body`,
    width: "100%",
    height: "auto",
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "row",
    columnGap: 0,
    backgroundColor: "transparent",
  })
  root.add(body)

  qrArea = new BoxRenderable(renderer, {
    id: `${ROOT_ID}-qr-area`,
    width: "auto",
    height: "100%",
    flexGrow: 1,
    flexShrink: 1,
    backgroundColor: currentTheme().panel,
    alignItems: "center",
    justifyContent: "center",
  })
  body.add(qrArea)

  qrCode = new QRCodeRenderable(renderer, {
    id: `${ROOT_ID}-qr`,
    width: "100%",
    height: "100%",
    content: PRESET_URLS[currentPresetIndex]!.url,
    errorCorrectionLevel: ErrorCorrectionLevel.M,
    quietZone: 4,
    scale: DEFAULT_MAX_SCALE,
    fit: "contain",
    foregroundColor: currentTheme().qrFg,
    backgroundColor: currentTheme().qrBg,
    fallbackContent: "Resize terminal for QR",
    fallbackColor: currentTheme().qrFallback,
    onSizeChange() {
      queueMicrotask(updateQRCode)
    },
  })
  qrArea.add(qrCode)

  advancedBox = new BoxRenderable(renderer, {
    id: `${ROOT_ID}-advanced`,
    width: 34,
    height: "100%",
    flexShrink: 0,
    padding: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: currentTheme().accent2,
    backgroundColor: currentTheme().panelAlt,
    flexDirection: "column",
    rowGap: 0,
    visible: false,
  })
  body.add(advancedBox)

  advancedScrollBox = new ScrollBoxRenderable(renderer, {
    id: `${ROOT_ID}-advanced-scroll`,
    width: "100%",
    height: "100%",
    flexGrow: 1,
    flexShrink: 1,
    scrollX: false,
    scrollY: true,
    rootOptions: {
      backgroundColor: currentTheme().panelAlt,
      border: false,
    },
    wrapperOptions: {
      backgroundColor: currentTheme().panelAlt,
    },
    viewportOptions: {
      backgroundColor: currentTheme().panelAlt,
    },
    contentOptions: {
      backgroundColor: currentTheme().panelAlt,
      flexDirection: "column",
    },
    scrollbarOptions: {
      trackOptions: {
        foregroundColor: currentTheme().accent,
        backgroundColor: currentTheme().panel,
      },
    },
  })
  advancedBox.add(advancedScrollBox)

  eclSelect = createSelect(renderer, `${ROOT_ID}-ecl`, ERROR_CORRECTION_OPTIONS, 1, 4)
  scaleSelect = createSelect(renderer, `${ROOT_ID}-scale`, SCALE_OPTIONS, 3, 5)
  quietZoneSelect = createSelect(renderer, `${ROOT_ID}-quiet`, QUIET_ZONE_OPTIONS, 0, 4)
  eclLabel = createLabel(renderer, eclSelect, "Error correction")
  advancedScrollBox.add(eclLabel)
  advancedScrollBox.add(eclSelect)
  scaleLabel = createLabel(renderer, scaleSelect, "Scale cap", 1)
  advancedScrollBox.add(scaleLabel)
  advancedScrollBox.add(scaleSelect)
  quietZoneLabel = createLabel(renderer, quietZoneSelect, "Quiet zone", 1)
  advancedScrollBox.add(quietZoneLabel)
  advancedScrollBox.add(quietZoneSelect)

  footerText = new TextRenderable(renderer, {
    id: `${ROOT_ID}-footer`,
    content: "Tab focus | Ctrl+N next URL | Ctrl+T theme | Ctrl+A advanced | Esc quits",
    fg: currentTheme().muted,
    height: 1,
    flexShrink: 0,
  })
  root.add(footerText)

  rebuildFocusableElements()
  setupEvents(renderer)
  applyTheme()
  updateFocus()
}

export function destroy(rendererInstance: CliRenderer): void {
  if (keyboardHandler) {
    rendererInstance.keyInput.off("keypress", keyboardHandler)
    keyboardHandler = null
  }

  rendererInstance.root.getRenderable(ROOT_ID)?.destroyRecursively()
  rendererInstance.setCursorPosition(0, 0, false)

  renderer = null
  root = null
  inputBox = null
  qrArea = null
  advancedBox = null
  advancedScrollBox = null
  qrCode = null
  customInput = null
  footerText = null
  eclSelect = null
  scaleSelect = null
  quietZoneSelect = null
  eclLabel = null
  scaleLabel = null
  quietZoneLabel = null
  currentPresetIndex = 0
  currentThemeIndex = 0
  advancedVisible = false
  currentFocusIndex = 0
  focusableElements.length = 0
  advancedLabels.length = 0
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  })

  run(renderer)
  setupCommonDemoKeys(renderer)
}
