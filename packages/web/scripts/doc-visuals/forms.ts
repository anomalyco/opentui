import {
  BoxRenderable,
  InputRenderable,
  RGBA,
  SelectRenderable,
  TabSelectRenderable,
  TextareaRenderable,
  TextRenderable,
} from "@opentui/core"
import type { DocVisualFixture } from "./shared"

const foreground = RGBA.defaultForeground()
const background = RGBA.defaultBackground()
const muted = RGBA.fromIndex(244)
const selection = RGBA.fromIndex(238)

export const formVisuals: DocVisualFixture[] = [
  {
    id: "input-placeholder",
    label: "An unfocused name input displaying the placeholder Enter your name",
    width: 28,
    height: 2,
    render({ renderer }) {
      const field = new BoxRenderable(renderer, { width: 28, height: 2 })

      field.add(new TextRenderable(renderer, { content: "Name", fg: muted, bg: background }))
      field.add(
        new InputRenderable(renderer, {
          width: 28,
          placeholder: "Enter your name",
          placeholderColor: muted,
          backgroundColor: background,
          focusedBackgroundColor: selection,
          textColor: foreground,
          focusedTextColor: foreground,
          cursorColor: foreground,
        }),
      )

      renderer.root.add(field)
    },
  },
  {
    id: "input-focused",
    label: "A focused name input containing Ada Lovelace with its cursor visible",
    width: 28,
    height: 2,
    cursor: true,
    render({ renderer, mockInput }) {
      const field = new BoxRenderable(renderer, { width: 28, height: 2 })
      const input = new InputRenderable(renderer, {
        width: 28,
        placeholder: "Enter your name",
        placeholderColor: muted,
        backgroundColor: background,
        focusedBackgroundColor: selection,
        textColor: foreground,
        focusedTextColor: foreground,
        cursorColor: foreground,
      })

      field.add(new TextRenderable(renderer, { content: "Name", fg: muted, bg: background }))
      field.add(input)
      renderer.root.add(field)
      input.focus()
      mockInput.typeText("Ada Lovelace")
    },
  },
  {
    id: "textarea-wrap",
    label: "A multiline textarea wrapping a long line at a word boundary",
    width: 30,
    height: 4,
    render({ renderer }) {
      const field = new BoxRenderable(renderer, { width: 30, height: 4 })

      field.add(new TextRenderable(renderer, { content: "Notes", fg: muted, bg: background }))
      field.add(
        new TextareaRenderable(renderer, {
          width: 30,
          height: 3,
          initialValue: "Long lines wrap at word boundaries.\nKeep paragraphs readable.",
          wrapMode: "word",
          backgroundColor: background,
          focusedBackgroundColor: background,
          textColor: foreground,
          focusedTextColor: foreground,
          cursorColor: foreground,
        }),
      )

      renderer.root.add(field)
    },
  },
  {
    id: "textarea-selection",
    label: "A focused multiline textarea with keyboard focus selected",
    width: 30,
    height: 4,
    cursor: true,
    render({ renderer }) {
      const value = "Plan the release\nReview keyboard focus\nShip the update"
      const field = new BoxRenderable(renderer, { width: 30, height: 4 })
      const textarea = new TextareaRenderable(renderer, {
        width: 30,
        height: 3,
        initialValue: value,
        backgroundColor: background,
        focusedBackgroundColor: background,
        textColor: foreground,
        focusedTextColor: foreground,
        selectionBg: selection,
        selectionFg: foreground,
        cursorColor: foreground,
      })

      field.add(new TextRenderable(renderer, { content: "Draft", fg: muted, bg: background }))
      field.add(textarea)
      renderer.root.add(field)
      textarea.focus()
      textarea.setCursor(1, "Review keyboard focus".length)

      const start = value.indexOf("keyboard focus")
      textarea.setSelection(start, start + "keyboard focus".length)
    },
  },
  {
    id: "select-options",
    label: "New file, Open file, and Save options with Open file selected",
    width: 32,
    height: 6,
    render({ renderer, mockInput }) {
      const select = new SelectRenderable(renderer, {
        width: 32,
        height: 6,
        options: [
          { name: "New file", description: "Create a document" },
          { name: "Open file", description: "Browse existing files" },
          { name: "Save", description: "Write current changes" },
        ],
        backgroundColor: background,
        focusedBackgroundColor: background,
        textColor: foreground,
        focusedTextColor: foreground,
        selectedBackgroundColor: selection,
        selectedTextColor: foreground,
        descriptionColor: muted,
        selectedDescriptionColor: foreground,
      })

      renderer.root.add(select)
      select.focus()
      mockInput.pressArrow("down")
    },
  },
  {
    id: "tab-select-tabs",
    label: "Home, Files, and Settings tabs with Files selected and underlined",
    width: 36,
    height: 3,
    render({ renderer, mockInput }) {
      const tabs = new TabSelectRenderable(renderer, {
        width: 36,
        tabWidth: 12,
        options: [
          { name: "Home", description: "View project overview" },
          { name: "Files", description: "Browse project files" },
          { name: "Settings", description: "Configure the project" },
        ],
        backgroundColor: background,
        focusedBackgroundColor: background,
        textColor: muted,
        focusedTextColor: muted,
        selectedBackgroundColor: selection,
        selectedTextColor: foreground,
        selectedDescriptionColor: muted,
      })

      renderer.root.add(tabs)
      tabs.focus()
      mockInput.pressArrow("right")
    },
  },
  {
    id: "interaction-selection-focus",
    label: "The word text is selected above a focused command input containing deploy --check",
    width: 32,
    height: 4,
    cursor: true,
    async render({ renderer, mockInput, mockMouse, renderOnce }) {
      const layout = new BoxRenderable(renderer, { width: 32, height: 4, gap: 1 })
      const text = new TextRenderable(renderer, {
        width: 32,
        content: "Select text, then focus input",
        fg: foreground,
        bg: background,
        selectionBg: selection,
        selectionFg: foreground,
      })
      const field = new BoxRenderable(renderer, { width: 32, height: 2 })
      const input = new InputRenderable(renderer, {
        width: 32,
        backgroundColor: background,
        focusedBackgroundColor: selection,
        textColor: foreground,
        focusedTextColor: foreground,
        cursorColor: foreground,
      })

      field.add(new TextRenderable(renderer, { content: "Command", fg: muted, bg: background }))
      field.add(input)
      layout.add(text)
      layout.add(field)
      renderer.root.add(layout)
      await renderOnce()
      await mockMouse.drag(text.x + 7, text.y, text.x + 10, text.y, undefined, { delayMs: 0 })
      input.focus()
      mockInput.typeText("deploy --check")
    },
  },
]
