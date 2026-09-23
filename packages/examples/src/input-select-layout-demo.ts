import { CliRenderer, BoxRenderable, TextRenderable, createCliRenderer, type KeyEvent } from "@opentui/core"
import { InputRenderable, InputRenderableEvents } from "@opentui/core"
import { SelectRenderable, SelectRenderableEvents, type SelectOption } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let renderer: CliRenderer | null = null
let header: TextRenderable | null = null
let headerBox: BoxRenderable | null = null
let selectContainer: BoxRenderable | null = null
let selectContainerBox: BoxRenderable | null = null
let leftSelect: SelectRenderable | null = null
let leftSelectBox: BoxRenderable | null = null
let rightSelect: SelectRenderable | null = null
let rightSelectBox: BoxRenderable | null = null
let inputContainer: BoxRenderable | null = null
let inputContainerBox: BoxRenderable | null = null
let inputLabel: TextRenderable | null = null
let textInput: InputRenderable | null = null
let textInputBox: BoxRenderable | null = null
let footer: TextRenderable | null = null
let footerBox: BoxRenderable | null = null
let currentFocusIndex = 0

const focusableElements: Array<InputRenderable | SelectRenderable> = []
const focusableBoxes: Array<BoxRenderable | null> = []

const colorOptions: SelectOption[] = [
  { name: "Red", description: "A warm primary color", value: "#ff0000" },
  { name: "Blue", description: "A cool primary color", value: "#0066ff" },
  { name: "Green", description: "A natural color", value: "#00aa00" },
  { name: "Purple", description: "A regal color", value: "#8a2be2" },
  { name: "Orange", description: "A vibrant color", value: "#ff8c00" },
  { name: "Teal", description: "A calming color", value: "#008080" },
]

const sizeOptions: SelectOption[] = [
  { name: "Small", description: "Compact size (8px)", value: 8 },
  { name: "Medium", description: "Standard size (12px)", value: 12 },
  { name: "Large", description: "Big size (16px)", value: 16 },
  { name: "Extra Large", description: "Huge size (20px)", value: 20 },
]

function createLayoutElements(rendererInstance: CliRenderer): void {
  renderer = rendererInstance
  renderer.setBackgroundColor("#001122")

  headerBox = new BoxRenderable(renderer, {
    id: "header-box",
    zIndex: 0,
    width: "auto",
    height: 3,
    backgroundColor: "#3b82f6",
    borderStyle: "single",
    borderColor: "#2563eb",
    flexGrow: 0,
    flexShrink: 0,
    border: true,
  })

  header = new TextRenderable(renderer, {
    id: "header",
    content: "INPUT & SELECT LAYOUT DEMO",
    fg: "#ffffff",
    bg: "transparent",
    zIndex: 1,
    flexGrow: 1,
    flexShrink: 1,
  })

  headerBox.add(header)

  selectContainerBox = new BoxRenderable(renderer, {
    id: "select-container-box",
    zIndex: 0,
    width: "auto",
    height: "auto",
    flexGrow: 1,
    flexShrink: 1,
    minHeight: 10,
    backgroundColor: "#1e293b",
    borderStyle: "single",
    borderColor: "#475569",
    border: true,
  })

  selectContainer = new BoxRenderable(renderer, {
    id: "select-container",
    zIndex: 1,
    width: "auto",
    height: "auto",
    flexDirection: "row",
    flexGrow: 1,
    flexShrink: 1,
  })

  selectContainerBox.add(selectContainer)

  leftSelectBox = new BoxRenderable(renderer, {
    id: "color-select-box",
    zIndex: 0,
    width: "auto",
    height: "auto",
    minHeight: 8,
    borderStyle: "single",
    borderColor: "#475569",
    focusedBorderColor: "#3b82f6",
    title: "Color Selection",
    titleAlignment: "center",
    flexGrow: 1,
    flexShrink: 1,
    backgroundColor: "transparent",
    border: true,
  })

  leftSelect = new SelectRenderable(renderer, {
    id: "color-select",
    zIndex: 1,
    width: "auto",
    height: "auto",
    minHeight: 6,
    options: colorOptions,
    backgroundColor: "#1e293b",
    focusedBackgroundColor: "#2d3748",
    textColor: "#e2e8f0",
    focusedTextColor: "#f7fafc",
    selectedBackgroundColor: "#3b82f6",
    selectedTextColor: "#ffffff",
    descriptionColor: "#94a3b8",
    selectedDescriptionColor: "#cbd5e1",
    showScrollIndicator: true,
    wrapSelection: true,
    showDescription: true,
    flexGrow: 1,
    flexShrink: 1,
  })

  leftSelectBox.add(leftSelect)

  rightSelectBox = new BoxRenderable(renderer, {
    id: "size-select-box",
    zIndex: 0,
    width: "auto",
    height: "auto",
    minHeight: 8,
    borderStyle: "single",
    borderColor: "#475569",
    focusedBorderColor: "#059669",
    title: "Size Selection",
    titleAlignment: "center",
    flexGrow: 1,
    flexShrink: 1,
    backgroundColor: "transparent",
    border: true,
  })

  rightSelect = new SelectRenderable(renderer, {
    id: "size-select",
    zIndex: 1,
    width: "auto",
    height: "auto",
    minHeight: 6,
    options: sizeOptions,
    backgroundColor: "#1e293b",
    focusedBackgroundColor: "#2d3748",
    textColor: "#e2e8f0",
    focusedTextColor: "#f7fafc",
    selectedBackgroundColor: "#059669",
    selectedTextColor: "#ffffff",
    descriptionColor: "#94a3b8",
    selectedDescriptionColor: "#cbd5e1",
    showScrollIndicator: true,
    wrapSelection: true,
    showDescription: true,
    flexGrow: 1,
    flexShrink: 1,
  })

  rightSelectBox.add(rightSelect)

  inputContainerBox = new BoxRenderable(renderer, {
    id: "input-container-box",
    zIndex: 0,
    width: "auto",
    height: 7,
    flexGrow: 0,
    flexShrink: 0,
    backgroundColor: "#0f172a",
    borderStyle: "single",
    borderColor: "#334155",
    border: true,
  })

  inputContainer = new BoxRenderable(renderer, {
    id: "input-container",
    zIndex: 1,
    width: "auto",
    height: "auto",
    flexDirection: "column",
    flexGrow: 1,
    flexShrink: 1,
  })

  inputContainerBox.add(inputContainer)

  inputLabel = new TextRenderable(renderer, {
    id: "input-label",
    content: "Enter your text:",
    fg: "#f1f5f9",
    bg: "#0f172a",
    zIndex: 0,
    flexGrow: 0,
    flexShrink: 0,
  })

  textInputBox = new BoxRenderable(renderer, {
    id: "text-input-box",
    zIndex: 0,
    width: "auto",
    height: 3,
    borderStyle: "single",
    borderColor: "#475569",
    focusedBorderColor: "#eab308",
    flexGrow: 0,
    flexShrink: 0,
    marginTop: 1,
    backgroundColor: "transparent",
    border: true,
  })

  textInput = new InputRenderable(renderer, {
    id: "text-input",
    zIndex: 1,
    width: "auto",
    height: 1,
    placeholder: "Type something here...",
    backgroundColor: "#1e293b",
    focusedBackgroundColor: "#334155",
    textColor: "#f1f5f9",
    focusedTextColor: "#ffffff",
    placeholderColor: "#64748b",
    cursorColor: "#f1f5f9",
    maxLength: 100,
    flexGrow: 1,
    flexShrink: 1,
  })

  textInputBox.add(textInput)

  footerBox = new BoxRenderable(renderer, {
    id: "footer-box",
    zIndex: 0,
    width: "auto",
    height: 3,
    backgroundColor: "#1e40af",
    borderStyle: "single",
    borderColor: "#1d4ed8",
    flexGrow: 0,
    flexShrink: 0,
    border: true,
  })

  footer = new TextRenderable(renderer, {
    id: "footer",
    content: "TAB: focus next | SHIFT+TAB: focus prev | ARROWS/JK: navigate | ESC: quit",
    fg: "#dbeafe",
    bg: "transparent",
    zIndex: 1,
    flexGrow: 1,
    flexShrink: 1,
  })

  footerBox.add(footer)

  selectContainer.add(leftSelectBox)
  selectContainer.add(rightSelectBox)
  inputContainer.add(inputLabel)
  inputContainer.add(textInputBox)

  renderer.root.add(headerBox)
  renderer.root.add(selectContainerBox)
  renderer.root.add(inputContainerBox)
  renderer.root.add(footerBox)

  focusableElements.push(leftSelect, rightSelect, textInput)
  focusableBoxes.push(leftSelectBox, rightSelectBox, textInputBox)
  setupEventHandlers()
  updateFocus()

  renderer.on("resize", handleResize)
}

function setupEventHandlers(): void {
  if (!leftSelect || !rightSelect || !textInput) return

  leftSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number, option: SelectOption) => {
    updateDisplay()
  })

  leftSelect.on(SelectRenderableEvents.ITEM_SELECTED, (index: number, option: SelectOption) => {
    updateDisplay()
  })

  rightSelect.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number, option: SelectOption) => {
    updateDisplay()
  })

  rightSelect.on(SelectRenderableEvents.ITEM_SELECTED, (index: number, option: SelectOption) => {
    updateDisplay()
  })

  textInput.on(InputRenderableEvents.INPUT, (value: string) => {
    updateDisplay()
  })

  textInput.on(InputRenderableEvents.CHANGE, (value: string) => {
    updateDisplay()
  })
}

function updateDisplay(): void {
  if (!leftSelect || !rightSelect || !textInput || !inputLabel) return

  const selectedColor = leftSelect.getSelectedOption()
  const selectedSize = rightSelect.getSelectedOption()
  const inputValue = textInput.value

  let displayText = "Enter your text:"
  if (inputValue) {
    displayText += ` "${inputValue}"`
  }
  if (selectedColor) {
    displayText += ` in ${selectedColor.name}`
  }
  if (selectedSize) {
    displayText += ` (${selectedSize.name})`
  }

  inputLabel.content = displayText
}

function handleResize(width: number, height: number): void {
  // Root layout is automatically resized by the renderer
}

function updateFocus(): void {
  focusableElements.forEach((element) => element.blur())
  focusableBoxes.forEach((box) => {
    if (box) box.blur()
  })

  if (focusableElements[currentFocusIndex]) {
    focusableElements[currentFocusIndex].focus()
  }
  if (focusableBoxes[currentFocusIndex]) {
    focusableBoxes[currentFocusIndex]!.focus()
  }
}

function handleKeyPress(key: KeyEvent): void {
  if (key.name === "tab") {
    if (key.shift) {
      currentFocusIndex = (currentFocusIndex - 1 + focusableElements.length) % focusableElements.length
    } else {
      currentFocusIndex = (currentFocusIndex + 1) % focusableElements.length
    }
    updateFocus()
    return
  }
}

export function run(rendererInstance: CliRenderer): void {
  createLayoutElements(rendererInstance)
  rendererInstance.keyInput.on("keypress", handleKeyPress)
  updateDisplay()
}

export function destroy(rendererInstance: CliRenderer): void {
  rendererInstance.keyInput.off("keypress", handleKeyPress)

  if (renderer) {
    renderer.off("resize", handleResize)
  }

  // Properly destroy all elements that need cleanup
  if (leftSelect) leftSelect.destroy()
  if (rightSelect) rightSelect.destroy()
  if (textInput) textInput.destroy()

  // Clean up elements directly from root
  headerBox?.destroyRecursively()
  selectContainerBox?.destroyRecursively()
  inputContainerBox?.destroyRecursively()
  footerBox?.destroyRecursively()

  // Clean up all elements
  header = null
  headerBox = null
  selectContainer = null
  selectContainerBox = null
  leftSelect = null
  leftSelectBox = null
  rightSelect = null
  rightSelectBox = null
  inputContainer = null
  inputContainerBox = null
  inputLabel = null
  textInput = null
  textInputBox = null
  footer = null
  footerBox = null
  renderer = null
  currentFocusIndex = 0
  focusableElements.length = 0
  focusableBoxes.length = 0
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
  })
  run(renderer)
  setupCommonDemoKeys(renderer)
  renderer.start()
}
