#!/usr/bin/env bun

import {
  ASCIIFontRenderable,
  BoxRenderable,
  CliRenderer,
  createCliRenderer,
  InputRenderable,
  InputRenderableEvents,
  RGBA,
  RenderableEvents,
  SelectRenderable,
  SelectRenderableEvents,
  TextRenderable,
  TimeToFirstDrawRenderable,
  type KeyEvent,
  type SelectOption,
  type ThemeMode,
} from "@opentui/core"
import { measureText } from "@opentui/core"
import * as boxExample from "./fonts.js"
import * as framebufferExample from "./framebuffer-demo.js"
import * as opentuiDemo from "./opentui-demo.js"
import * as nestedZIndexDemo from "./nested-zindex-demo.js"
import * as relativePositioningDemo from "./relative-positioning-demo.js"
import * as transparencyDemo from "./transparency-demo.js"
import * as scrollExample from "./scroll-example.js"
import * as stickyScrollExample from "./sticky-scroll-example.js"
import * as timelineExample from "./timeline-example.js"
import * as tabSelectExample from "./tab-select-demo.js"
import * as selectExample from "./select-demo.js"
import * as inputExample from "./input-demo.js"
import * as layoutExample from "./simple-layout-example.js"
import * as inputSelectLayoutExample from "./input-select-layout-demo.js"
import * as styledTextExample from "./styled-text-demo.js"
import * as textTableExample from "./text-table-demo.js"
import * as mouseInteractionExample from "./mouse-interaction-demo.js"
import * as textSelectionExample from "./text-selection-demo.js"
import * as asciiFontSelectionExample from "./ascii-font-selection-demo.js"
import * as splitModeExample from "./split-mode-demo.js"
import * as splitFooterStreamingDemo from "./split-footer-streaming-demo.js"
import * as consoleExample from "./console-demo.js"
import * as notificationDemo from "./notification-demo.js"
import * as vnodeCompositionDemo from "./vnode-composition-demo.js"
import * as hastSyntaxHighlightingExample from "./hast-syntax-highlighting-demo.js"
import * as codeDemo from "./code-demo.js"
import * as liveStateExample from "./live-state-demo.js"
import * as fullUnicodeExample from "./full-unicode-demo.js"
import * as textNodeDemo from "./text-node-demo.js"
import * as textWrapExample from "./text-wrap.js"
import * as editorDemo from "./editor-demo.js"
import * as sliderDemo from "./slider-demo.js"
import * as terminalDemo from "./terminal.js"
import * as terminalTitleDemo from "./terminal-title.js"
import * as diffDemo from "./diff-demo.js"
import * as keypressDebugDemo from "./keypress-debug-demo.js"
import * as extmarksDemo from "./extmarks-demo.js"
import * as markdownDemo from "./markdown-demo.js"
import * as markdownCodeBlockRendererDemo from "./markdown-code-block-renderer-demo.js"
import * as qrcodeDemo from "./qrcode-demo.js"
import * as linkDemo from "./link-demo.js"
import * as opacityExample from "./opacity-example.js"
import * as scrollboxOverlayHitTest from "./scrollbox-overlay-hit-test.js"
import * as scrollboxMouseTest from "./scrollbox-mouse-test.js"
import * as textTruncationDemo from "./text-truncation-demo.js"
import * as grayscaleBufferDemo from "./grayscale-buffer-demo.js"
import * as focusRestoreDemo from "./focus-restore-demo.js"
import * as keymapDemo from "./keymap-demo.js"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import * as corePluginSlotsDemo from "./core-plugin-slots-demo.js"
import * as wideGraphemeOverlayDemo from "./wide-grapheme-overlay-demo.js"
import * as nativeAudioDemo from "./native-audio-demo.js"

type ExampleCategory =
  | "Layout & Composition"
  | "Input & Editing"
  | "Scroll & Navigation"
  | "Text & Documents"
  | "Rendering & Effects"
  | "Runtime & Tooling"
  | "Terminal & Native"
  | "3D & Physics"

interface ExampleDefinition {
  name: string
  description: string
  run?: (renderer: CliRenderer) => void | Promise<void>
  destroy?: (renderer: CliRenderer) => void
  unavailableMessage?: string
}

interface Example extends ExampleDefinition {
  category: ExampleCategory
}

interface ExampleSection {
  category: ExampleCategory
  examples: readonly ExampleDefinition[]
}

interface ExampleModule {
  run?: (renderer: CliRenderer) => void | Promise<void>
  destroy?: (renderer: CliRenderer) => void
}

declare const OPENTUI_BUN_ONLY_EXAMPLES: boolean | undefined

interface CategoryMenuValue {
  kind: "category"
  category: ExampleCategory
}

interface SpacerMenuValue {
  kind: "spacer"
}

interface MessageMenuValue {
  kind: "message"
}

interface ExampleMenuValue {
  kind: "example"
  example: Example
}

type MenuOptionValue = CategoryMenuValue | SpacerMenuValue | MessageMenuValue | ExampleMenuValue
type MenuOption = Omit<SelectOption, "value"> & { value: MenuOptionValue }
type MenuFocusArea = "filter" | "list"

interface ExampleTheme {
  titleColor: RGBA
  borderColor: string
  focusedBorderColor: string
  inputTextColor: string
  inputFocusedTextColor: string
  inputPlaceholderColor: string
  inputCursorColor: string
  selectSelectedBackgroundColor: string
  selectTextColor: string
  selectSelectedTextColor: string
  selectDescriptionColor: string
  selectSelectedDescriptionColor: string
  instructionsColor: string
  notImplementedColor: string
}

const DEFAULT_THEME_MODE: ThemeMode = "dark"
const isBunRuntime = typeof process !== "undefined" && typeof process.versions?.bun === "string"
const includeThreeExamples = typeof OPENTUI_BUN_ONLY_EXAMPLES === "boolean" ? OPENTUI_BUN_ONLY_EXAMPLES : isBunRuntime
const MENU_TERMINAL_TITLE = "OpenTUI Examples"
const EXAMPLES_BOX_TITLE = "Examples"
const EXAMPLE_NAME_INDENT = "  "
const EXAMPLE_DESCRIPTION_INDENT = "    "
const CATEGORY_LABELS: Record<ExampleCategory, string> = {
  "Layout & Composition": "Layout",
  "Input & Editing": "Input",
  "Scroll & Navigation": "Scroll",
  "Text & Documents": "Text",
  "Rendering & Effects": "Rendering",
  "Runtime & Tooling": "Runtime",
  "Terminal & Native": "Terminal",
  "3D & Physics": "3D",
}

function unavailableThreeExample(name: string, description: string): ExampleDefinition {
  return {
    name,
    description: `${description} (Requires @opentui/three in Node.js)`,
    unavailableMessage: "This example requires @opentui/three and remains disabled in the Node.js examples bundle.",
  }
}

function threeExample(name: string, description: string, load: () => Promise<ExampleModule>): ExampleDefinition {
  let loaded: ExampleModule | null = null

  async function loadModule(): Promise<ExampleModule> {
    loaded ??= await load()
    return loaded
  }

  return {
    name,
    description,
    async run(renderer) {
      const module = await loadModule()
      return module.run?.(renderer)
    },
    destroy(renderer) {
      loaded?.destroy?.(renderer)
    },
  }
}

function sortExampleDefinitions(examples: readonly ExampleDefinition[]): ExampleDefinition[] {
  return [...examples].sort((left, right) => left.name.localeCompare(right.name))
}

function section(category: ExampleCategory, examples: readonly ExampleDefinition[]): ExampleSection {
  return {
    category,
    examples: sortExampleDefinitions(examples),
  }
}

const THREE_EXAMPLES: ExampleDefinition[] = includeThreeExamples
  ? [
      threeExample(
        "Draggable ThreeRenderable",
        "Draggable WebGPU cube with live animation",
        () => import("./draggable-three-demo.js"),
      ),
      threeExample("Fractal Shader", "Fractal rendering with shaders", () => import("./fractal-shader-demo.js")),
      threeExample(
        "Golden Star Demo",
        "3D golden star with particle effects and animated text celebrating 5000 stars",
        () => import("./golden-star-demo.js"),
      ),
      threeExample("Physics Planck", "2D physics with Planck.js", () => import("./physx-planck-2d-demo.js")),
      threeExample("Physics Rapier", "2D physics with Rapier", () => import("./physx-rapier-2d-demo.js")),
      threeExample("Phong Lighting", "Phong lighting model demo", () => import("./lights-phong-demo.js")),
      threeExample("Shader Cube", "3D cube with custom shaders", () => import("./shader-cube-demo.js")),
      threeExample("Sprite Animation", "Animated sprite sequences", () => import("./sprite-animation-demo.js")),
      threeExample(
        "Sprite Particles",
        "Particle system with sprites",
        () => import("./sprite-particle-generator-demo.js"),
      ),
      threeExample("Static Sprite", "Static sprite rendering demo", () => import("./static-sprite-demo.js")),
      threeExample("Texture Loading", "Loading and displaying textures", () => import("./texture-loading-demo.js")),
    ]
  : [
      unavailableThreeExample("Draggable ThreeRenderable", "Draggable WebGPU cube with live animation"),
      unavailableThreeExample("Fractal Shader", "Fractal rendering with shaders"),
      unavailableThreeExample(
        "Golden Star Demo",
        "3D golden star with particle effects and animated text celebrating 5000 stars",
      ),
      unavailableThreeExample("Physics Planck", "2D physics with Planck.js"),
      unavailableThreeExample("Physics Rapier", "2D physics with Rapier"),
      unavailableThreeExample("Phong Lighting", "Phong lighting model demo"),
      unavailableThreeExample("Shader Cube", "3D cube with custom shaders"),
      unavailableThreeExample("Sprite Animation", "Animated sprite sequences"),
      unavailableThreeExample("Sprite Particles", "Particle system with sprites"),
      unavailableThreeExample("Static Sprite", "Static sprite rendering demo"),
      unavailableThreeExample("Texture Loading", "Loading and displaying textures"),
    ]

const MENU_THEMES: Record<ThemeMode, ExampleTheme> = {
  dark: {
    titleColor: RGBA.fromInts(240, 248, 255, 255),
    borderColor: "#475569",
    focusedBorderColor: "#60A5FA",
    inputTextColor: "#E2E8F0",
    inputFocusedTextColor: "#F8FAFC",
    inputPlaceholderColor: "#94A3B8",
    inputCursorColor: "#60A5FA",
    selectSelectedBackgroundColor: "#1E3A5F",
    selectTextColor: "#E2E8F0",
    selectSelectedTextColor: "#38BDF8",
    selectDescriptionColor: "#64748B",
    selectSelectedDescriptionColor: "#94A3B8",
    instructionsColor: "#94A3B8",
    notImplementedColor: "#FACC15",
  },
  light: {
    titleColor: RGBA.fromInts(15, 23, 42, 255),
    borderColor: "#CBD5E1",
    focusedBorderColor: "#2563EB",
    inputTextColor: "#0F172A",
    inputFocusedTextColor: "#0B1221",
    inputPlaceholderColor: "#64748B",
    inputCursorColor: "#2563EB",
    selectSelectedBackgroundColor: "#DBEAFE",
    selectTextColor: "#0F172A",
    selectSelectedTextColor: "#1D4ED8",
    selectDescriptionColor: "#475569",
    selectSelectedDescriptionColor: "#1E40AF",
    instructionsColor: "#475569",
    notImplementedColor: "#B45309",
  },
}

const EXAMPLE_SECTIONS: ExampleSection[] = [
  section("Layout & Composition", [
    {
      name: "Input & Select Layout Demo",
      description: "Interactive layout with input and select elements",
      run: inputSelectLayoutExample.run,
      destroy: inputSelectLayoutExample.destroy,
    },
    {
      name: "Layout System Demo",
      description: "Flex layout system with multiple configurations",
      run: layoutExample.run,
      destroy: layoutExample.destroy,
    },
    {
      name: "Nested Z-Index Demo",
      description: "Demonstrates z-index behavior with nested render objects",
      run: nestedZIndexDemo.run,
      destroy: nestedZIndexDemo.destroy,
    },
    {
      name: "OpenTUI Demo",
      description: "Multi-tab demo with various features",
      run: opentuiDemo.run,
      destroy: opentuiDemo.destroy,
    },
    {
      name: "Relative Positioning Demo",
      description: "Shows how child positions are relative to their parent containers",
      run: relativePositioningDemo.run,
      destroy: relativePositioningDemo.destroy,
    },
    {
      name: "Split Footer Streaming Demo",
      description: "Focused split-footer surface demo for progressive text, code, and markdown scrollback",
      run: splitFooterStreamingDemo.run,
      destroy: splitFooterStreamingDemo.destroy,
    },
    {
      name: "Split Mode Demo (Experimental)",
      description: "Renderer confined to bottom area with normal terminal output above",
      run: splitModeExample.run,
      destroy: splitModeExample.destroy,
    },
    {
      name: "VNode Composition Demo",
      description: "Declarative Box(Box(Box(children))) composition",
      run: vnodeCompositionDemo.run,
      destroy: vnodeCompositionDemo.destroy,
    },
  ]),
  section("Input & Editing", [
    {
      name: "ASCII Font Selection Demo",
      description: "Text selection with ASCII fonts - precise character-level selection across different font types",
      run: asciiFontSelectionExample.run,
      destroy: asciiFontSelectionExample.destroy,
    },
    {
      name: "Editor Demo",
      description: "Interactive text editor with TextareaRenderable - supports full editing capabilities",
      run: editorDemo.run,
      destroy: editorDemo.destroy,
    },
    {
      name: "Extmarks Demo",
      description: "Virtual extmarks - text ranges that the cursor jumps over, with deletion handling",
      run: extmarksDemo.run,
      destroy: extmarksDemo.destroy,
    },
    {
      name: "Input Demo",
      description: "Interactive InputElement demo with validation and multiple fields",
      run: inputExample.run,
      destroy: inputExample.destroy,
    },
    {
      name: "Keymap Demo",
      description:
        "Global and local bindings with counters, leader commands, a centered : prompt, and three switchable textareas",
      run: keymapDemo.run,
      destroy: keymapDemo.destroy,
    },
    {
      name: "Mouse Interaction Demo",
      description: "Interactive mouse trails and clickable cells demonstration",
      run: mouseInteractionExample.run,
      destroy: mouseInteractionExample.destroy,
    },
    {
      name: "Select Demo",
      description: "Interactive SelectElement demo with customizable options",
      run: selectExample.run,
      destroy: selectExample.destroy,
    },
    {
      name: "Slider Demo",
      description: "Interactive slider components with various orientations and configurations",
      run: sliderDemo.run,
      destroy: sliderDemo.destroy,
    },
    {
      name: "Tab Select",
      description: "Tab selection demo",
      run: tabSelectExample.run,
      destroy: tabSelectExample.destroy,
    },
    {
      name: "Text Selection Demo",
      description: "Text selection across multiple renderables with mouse drag",
      run: textSelectionExample.run,
      destroy: textSelectionExample.destroy,
    },
  ]),
  section("Scroll & Navigation", [
    {
      name: "ScrollBox Demo",
      description: "Scrollable container with customization",
      run: scrollExample.run,
      destroy: scrollExample.destroy,
    },
    {
      name: "Scrollbox Mouse Test",
      description: "Test scrollbox mouse hit detection with hover and click events",
      run: scrollboxMouseTest.run,
      destroy: scrollboxMouseTest.destroy,
    },
    {
      name: "Scrollbox Overlay Hit Test",
      description: "Test scrollbox hit detection with overlays and dialogs",
      run: scrollboxOverlayHitTest.run,
      destroy: scrollboxOverlayHitTest.destroy,
    },
    {
      name: "Sticky Scroll Demo",
      description: "ScrollBox with sticky scroll behavior - maintains position at borders when content changes",
      run: stickyScrollExample.run,
      destroy: stickyScrollExample.destroy,
    },
  ]),
  section("Text & Documents", [
    {
      name: "ASCII Font Demo",
      description: "ASCII font rendering with various colors and text",
      run: boxExample.run,
      destroy: boxExample.destroy,
    },
    {
      name: "Code Demo",
      description:
        "Code viewer with line numbers, diff highlights, and diagnostics using CodeRenderable + LineNumberRenderable",
      run: codeDemo.run,
      destroy: codeDemo.destroy,
    },
    {
      name: "Diff Demo",
      description: "Unified and split diff views with syntax highlighting and multiple themes",
      run: diffDemo.run,
      destroy: diffDemo.destroy,
    },
    {
      name: "Full Unicode Demo",
      description: "Draggable boxes and background filled with complex graphemes",
      run: fullUnicodeExample.run,
      destroy: fullUnicodeExample.destroy,
    },
    {
      name: "HAST Syntax Highlighting Demo",
      description: "Convert HAST trees to syntax-highlighted text with efficient chunk generation",
      run: hastSyntaxHighlightingExample.run,
      destroy: hastSyntaxHighlightingExample.destroy,
    },
    {
      name: "Link Demo",
      description: "Hyperlink support with OSC 8 - clickable links and link inheritance in styled text",
      run: linkDemo.run,
      destroy: linkDemo.destroy,
    },
    {
      name: "Markdown Demo",
      description: "Markdown rendering with table alignment, syntax highlighting, and theme switching",
      run: markdownDemo.run,
      destroy: markdownDemo.destroy,
    },
    {
      name: "Markdown Code Block Renderer Demo",
      description: "Custom fenced-code rendering for a fake taskflow DSL inside markdown",
      run: markdownCodeBlockRendererDemo.run,
      destroy: markdownCodeBlockRendererDemo.destroy,
    },
    {
      name: "QR Code Demo",
      description: "Intrinsic QR code renderable with manual scaling and terminal-friendly half-block output",
      run: qrcodeDemo.run,
      destroy: qrcodeDemo.destroy,
    },
    {
      name: "Styled Text Demo",
      description: "Template literals with styled text, colors, and formatting",
      run: styledTextExample.run,
      destroy: styledTextExample.destroy,
    },
    {
      name: "Text Truncation Demo",
      description: "Middle truncation with ellipsis - toggle with 'T' key and resize to test responsive behavior",
      run: textTruncationDemo.run,
      destroy: textTruncationDemo.destroy,
    },
    {
      name: "Text Wrap Demo",
      description: "Text wrapping example",
      run: textWrapExample.run,
      destroy: textWrapExample.destroy,
    },
    {
      name: "TextNode Demo",
      description: "TextNode API for building complex styled text structures",
      run: textNodeDemo.run,
      destroy: textNodeDemo.destroy,
    },
    {
      name: "TextTable Demo",
      description: "TextTable renderable with styled chunks, Unicode content, and wrap/border toggles",
      run: textTableExample.run,
      destroy: textTableExample.destroy,
    },
    {
      name: "Wide Grapheme Overlay Demo",
      description: "Drag transparent boxes over CJK/emoji, toggle dimming scrim with D key",
      run: wideGraphemeOverlayDemo.run,
      destroy: wideGraphemeOverlayDemo.destroy,
    },
  ]),
  section("Rendering & Effects", [
    {
      name: "Framebuffer Demo",
      description: "Framebuffer rendering techniques",
      run: framebufferExample.run,
      destroy: framebufferExample.destroy,
    },
    {
      name: "Grayscale Buffer",
      description: "Grayscale buffer rendering with 1x vs 2x supersampled intensity",
      run: grayscaleBufferDemo.run,
      destroy: grayscaleBufferDemo.destroy,
    },
    {
      name: "Opacity Demo",
      description: "Box opacity and transparency effects with animated opacity transitions",
      run: opacityExample.run,
      destroy: opacityExample.destroy,
    },
    {
      name: "Timeline Example",
      description: "Animation timeline system",
      run: timelineExample.run,
      destroy: timelineExample.destroy,
    },
    {
      name: "Transparency Demo",
      description: "Alpha blending and transparency effects demonstration",
      run: transparencyDemo.run,
      destroy: transparencyDemo.destroy,
    },
  ]),
  section("Runtime & Tooling", [
    {
      name: "Console Demo",
      description: "Interactive console logging with clickable buttons for different log levels",
      run: consoleExample.run,
      destroy: consoleExample.destroy,
    },
    {
      name: "Core Plugin Slots Demo",
      description: "Framework-free plugin slots with cached renderables and deterministic ordering",
      run: corePluginSlotsDemo.run,
      destroy: corePluginSlotsDemo.destroy,
    },
    {
      name: "Live State Management Demo",
      description: "Test automatic renderer lifecycle management with live renderables",
      run: liveStateExample.run,
      destroy: liveStateExample.destroy,
    },
  ]),
  section("Terminal & Native", [
    {
      name: "Audio Demo",
      description: "WAV-based native mixer with sound groups and live meter stats",
      run: nativeAudioDemo.run,
      destroy: nativeAudioDemo.destroy,
    },
    {
      name: "Focus Restore Demo",
      description: "Test focus restore - alt-tab away and back to verify mouse tracking resumes",
      run: focusRestoreDemo.run,
      destroy: focusRestoreDemo.destroy,
    },
    {
      name: "Keypress Debug Tool",
      description: "Debug tool to inspect keypress events, raw input, and terminal capabilities",
      run: keypressDebugDemo.run,
      destroy: keypressDebugDemo.destroy,
    },
    {
      name: "Notification Demo",
      description: "Standalone OSC terminal notification demo with capability detection and interactive triggers",
      run: notificationDemo.run,
      destroy: notificationDemo.destroy,
    },
    {
      name: "Terminal Palette Demo",
      description: "Terminal color palette detection and visualization - fetch and display all 256 terminal colors",
      run: terminalDemo.run,
      destroy: terminalDemo.destroy,
    },
    {
      name: "Terminal Title Demo",
      description: "Set and update the terminal window title with OSC title sequences",
      run: terminalTitleDemo.run,
      destroy: terminalTitleDemo.destroy,
    },
  ]),
  section("3D & Physics", THREE_EXAMPLES),
]

export const examples: Example[] = EXAMPLE_SECTIONS.flatMap(({ category, examples }) =>
  examples.map((example) => ({
    ...example,
    category,
  })),
)

function createMenuOptions(filteredExamples: readonly Example[]): MenuOption[] {
  if (filteredExamples.length === 0) {
    return [
      {
        name: "No matching examples",
        description: "Try a broader filter or press Escape to clear it.",
        value: { kind: "message" },
      },
    ]
  }

  const options: MenuOption[] = []
  let shouldInsertSectionGap = false

  for (const section of EXAMPLE_SECTIONS) {
    const sectionExamples = filteredExamples.filter((example) => example.category === section.category)
    if (sectionExamples.length === 0) {
      continue
    }

    if (shouldInsertSectionGap) {
      options.push({
        name: "",
        description: "",
        value: { kind: "spacer" },
      })
    }

    shouldInsertSectionGap = true

    options.push({
      name: CATEGORY_LABELS[section.category].toUpperCase(),
      description: "",
      value: { kind: "category", category: section.category },
    })

    for (const example of sectionExamples) {
      options.push({
        name: `${EXAMPLE_NAME_INDENT}${example.name}`,
        description: `${EXAMPLE_DESCRIPTION_INDENT}${example.description}`,
        value: { kind: "example", example },
      })
    }
  }

  return options
}

function matchesExample(example: Example, filterText: string): boolean {
  const searchableText =
    `${example.category}\n${CATEGORY_LABELS[example.category]}\n${example.name}\n${example.description}`.toLowerCase()
  return searchableText.includes(filterText)
}

function isExampleMenuValue(value: MenuOptionValue | undefined): value is ExampleMenuValue {
  return value?.kind === "example"
}

function getExampleFromOption(option: SelectOption | null): Example | null {
  const menuOption = option as MenuOption | null
  return isExampleMenuValue(menuOption?.value) ? menuOption.value.example : null
}

function getFirstExampleOptionIndex(options: readonly MenuOption[]): number {
  for (let index = 0; index < options.length; index += 1) {
    if (isExampleMenuValue(options[index]?.value)) {
      return index
    }
  }

  return -1
}

function getExampleOptionIndexByName(options: readonly MenuOption[], name: string | null): number {
  if (!name) {
    return -1
  }

  for (let index = 0; index < options.length; index += 1) {
    const optionValue = options[index]?.value
    if (isExampleMenuValue(optionValue) && optionValue.example.name === name) {
      return index
    }
  }

  return -1
}

function getExamplesBoxTitle(filteredCount: number, isFiltered: boolean): string {
  if (!isFiltered || filteredCount > 0) {
    return EXAMPLES_BOX_TITLE
  }

  return `${EXAMPLES_BOX_TITLE} (No Matches)`
}

function getPrintableKeyText(key: KeyEvent): string | null {
  if (key.ctrl || key.meta || key.super || key.hyper || key.option) {
    return null
  }

  if (key.name === "space") {
    return " "
  }

  if (!key.sequence || Array.from(key.sequence).length !== 1) {
    return null
  }

  const firstCharCode = key.sequence.charCodeAt(0)
  if (firstCharCode < 32 || firstCharCode === 127) {
    return null
  }

  return key.sequence
}

function findNearestExampleOptionIndex(
  options: readonly MenuOption[],
  startIndex: number,
  direction: -1 | 1,
  wrap: boolean,
): number {
  if (options.length === 0) {
    return -1
  }

  let index = startIndex

  for (let attempts = 0; attempts < options.length; attempts += 1) {
    if (index < 0 || index >= options.length) {
      if (!wrap) {
        return -1
      }

      index = index < 0 ? options.length - 1 : 0
    }

    if (isExampleMenuValue(options[index]?.value)) {
      return index
    }

    index += direction
  }

  return -1
}

class ExampleSelector {
  private renderer: CliRenderer
  private currentExample: Example | null = null
  private inMenu = true
  private themeMode: ThemeMode = DEFAULT_THEME_MODE

  private menuContainer: BoxRenderable | null = null
  private title: ASCIIFontRenderable | null = null
  private filterBox: BoxRenderable | null = null
  private filterInput: InputRenderable | null = null
  private instructions: TextRenderable | null = null
  private timeToFirstDrawText: TimeToFirstDrawRenderable | null = null
  private selectElement: SelectRenderable | null = null
  private selectBox: BoxRenderable | null = null
  private notImplementedText: TextRenderable | null = null
  private readonly allExamples: Example[] = examples
  private selectedExampleName: string | null = examples[0]?.name ?? null
  private menuFocusArea: MenuFocusArea = "filter"
  private filterText = ""

  constructor(renderer: CliRenderer) {
    this.renderer = renderer
    this.themeMode = this.renderer.themeMode ?? DEFAULT_THEME_MODE
    this.renderer.setTerminalTitle(MENU_TERMINAL_TITLE)
    this.createLayout()
    this.setupKeyboardHandling()

    this.renderer.on("theme_mode", (mode: ThemeMode) => {
      this.applyTheme(mode)
      console.log(`Theme mode changed to ${mode}, applied new theme to menu`)
    })

    this.applyTheme(this.renderer.themeMode)

    this.renderer.on("resize", (width: number, height: number) => {
      this.handleResize(width, height)
    })
  }

  private createLayout(): void {
    const width = this.renderer.terminalWidth
    const theme = MENU_THEMES[this.themeMode]

    // Menu container with column layout
    this.menuContainer = new BoxRenderable(this.renderer, {
      id: "example-menu-container",
      flexDirection: "column",
      width: "100%",
      height: "100%",
    })
    this.renderer.root.add(this.menuContainer)

    // Title
    const titleText = "OPENTUI EXAMPLES"
    const titleFont = "tiny"
    const { width: titleWidth } = measureText({ text: titleText, font: titleFont })
    const centerX = Math.floor(width / 2) - Math.floor(titleWidth / 2)

    this.title = new ASCIIFontRenderable(this.renderer, {
      id: "example-index-title",
      left: centerX,
      margin: 1,
      text: titleText,
      font: titleFont,
      color: theme.titleColor,
      backgroundColor: "transparent",
    })
    this.menuContainer.add(this.title)

    // Filter box with border (grows with content)
    this.filterBox = new BoxRenderable(this.renderer, {
      id: "example-index-filter-box",
      marginLeft: 1,
      marginRight: 1,
      flexShrink: 0,
      backgroundColor: "transparent",
      border: true,
      borderStyle: "single",
      borderColor: theme.borderColor,
    })
    this.menuContainer.add(this.filterBox)

    // Filter input inside the box (transparent bg so box bg shows through)
    this.filterInput = new InputRenderable(this.renderer, {
      id: "example-index-filter-input",
      width: "100%",
      placeholder: "Filter examples...",
      placeholderColor: theme.inputPlaceholderColor,
      backgroundColor: "transparent",
      focusedBackgroundColor: "transparent",
      textColor: theme.inputTextColor,
      focusedTextColor: theme.inputFocusedTextColor,
      showCursor: true,
      cursorColor: theme.inputCursorColor,
    })
    this.filterBox.add(this.filterInput)

    this.filterInput.on(InputRenderableEvents.INPUT, (value: string) => {
      this.filterText = value
      this.filterExamples()
    })

    // Select box (grows to fill remaining space)
    this.selectBox = new BoxRenderable(this.renderer, {
      id: "example-selector-box",
      marginLeft: 1,
      marginRight: 1,
      marginBottom: 1,
      flexGrow: 1,
      borderStyle: "single",
      borderColor: theme.borderColor,
      focusedBorderColor: theme.focusedBorderColor,
      title: EXAMPLES_BOX_TITLE,
      titleAlignment: "center",
      backgroundColor: "transparent",
      shouldFill: true,
      border: true,
    })
    this.menuContainer.add(this.selectBox)

    // Select element
    const selectOptions = createMenuOptions(this.allExamples)
    const initialSelectedIndex = Math.max(0, getFirstExampleOptionIndex(selectOptions))

    this.selectElement = new SelectRenderable(this.renderer, {
      id: "example-selector",
      height: "100%",
      options: selectOptions,
      selectedIndex: initialSelectedIndex,
      backgroundColor: "transparent",
      focusedBackgroundColor: "transparent",
      focusedTextColor: theme.selectTextColor,
      selectedBackgroundColor: theme.selectSelectedBackgroundColor,
      textColor: theme.selectTextColor,
      selectedTextColor: theme.selectSelectedTextColor,
      descriptionColor: theme.selectDescriptionColor,
      selectedDescriptionColor: theme.selectSelectedDescriptionColor,
      showScrollIndicator: true,
      wrapSelection: false,
      showDescription: true,
      fastScrollStep: 5,
    })
    this.selectBox.add(this.selectElement)

    this.filterInput.on(RenderableEvents.FOCUSED, () => {
      this.menuFocusArea = "filter"
      this.syncFilterInputText()
      this.updateMenuFocusStyles()
    })

    this.selectElement.on(RenderableEvents.FOCUSED, () => {
      this.menuFocusArea = "list"
      this.updateMenuFocusStyles()
    })

    this.selectElement.on(SelectRenderableEvents.SELECTION_CHANGED, (index: number, option: SelectOption) => {
      const selectedExample = getExampleFromOption(option)
      if (!selectedExample) {
        this.focusNearestExampleOption(index, 1)
        return
      }

      this.selectedExampleName = selectedExample.name
    })

    this.selectElement.on(SelectRenderableEvents.ITEM_SELECTED, (index: number, option: SelectOption) => {
      const selectedExample = getExampleFromOption(option)
      if (!selectedExample) {
        this.focusNearestExampleOption(index, 1)
        return
      }

      void this.runSelected(selectedExample)
    })

    this.setMenuFocus("filter")

    this.timeToFirstDrawText = new TimeToFirstDrawRenderable(this.renderer, {
      id: "example-index-time-to-first-draw",
      fg: theme.instructionsColor,
    })
    this.menuContainer.add(this.timeToFirstDrawText)

    // Instructions at the bottom
    this.instructions = new TextRenderable(this.renderer, {
      id: "example-index-instructions",
      height: 1,
      flexShrink: 0,
      alignSelf: "center",
      content: "Tab/Esc switch focus | Type in filter | ↑↓/j/k list | Enter run | / filter | ctrl+c quit",
      fg: theme.instructionsColor,
    })
    this.menuContainer.add(this.instructions)
  }

  private applyTheme(mode: ThemeMode | null): void {
    this.themeMode = mode ?? DEFAULT_THEME_MODE
    const theme = MENU_THEMES[this.themeMode]

    if (this.title) {
      this.title.color = theme.titleColor
    }

    if (this.filterInput) {
      this.filterInput.textColor = theme.inputTextColor
      this.filterInput.focusedTextColor = theme.inputFocusedTextColor
      this.filterInput.placeholderColor = theme.inputPlaceholderColor
      this.filterInput.cursorColor = theme.inputCursorColor
    }

    if (this.filterBox) {
      this.filterBox.borderColor = theme.borderColor
    }

    if (this.selectBox) {
      this.selectBox.focusedBorderColor = theme.focusedBorderColor
    }

    if (this.selectElement) {
      this.selectElement.selectedBackgroundColor = theme.selectSelectedBackgroundColor
      this.selectElement.textColor = theme.selectTextColor
      this.selectElement.focusedTextColor = theme.selectTextColor
      this.selectElement.selectedTextColor = theme.selectSelectedTextColor
      this.selectElement.descriptionColor = theme.selectDescriptionColor
      this.selectElement.selectedDescriptionColor = theme.selectSelectedDescriptionColor
    }

    if (this.instructions) {
      this.instructions.fg = theme.instructionsColor
    }

    if (this.timeToFirstDrawText) {
      this.timeToFirstDrawText.color = theme.instructionsColor
    }

    if (this.notImplementedText) {
      this.notImplementedText.fg = theme.notImplementedColor
    }

    this.updateMenuFocusStyles()
    this.renderer.requestRender()
  }

  private setMenuFocus(focusArea: MenuFocusArea): void {
    this.menuFocusArea = focusArea

    if (focusArea === "filter") {
      this.selectElement?.blur()
      this.syncFilterInputText()
      this.filterInput?.focus()
    } else {
      this.filterInput?.blur()
      this.selectElement?.focus()
    }

    this.updateMenuFocusStyles()
  }

  private updateMenuFocusStyles(): void {
    const theme = MENU_THEMES[this.themeMode]

    if (this.filterBox) {
      this.filterBox.borderColor = this.menuFocusArea === "filter" ? theme.focusedBorderColor : theme.borderColor
    }

    if (this.selectBox) {
      this.selectBox.borderColor = this.menuFocusArea === "list" ? theme.focusedBorderColor : theme.borderColor
    }
  }

  private clearFilter(): void {
    if (!this.filterInput || this.filterText.length === 0) {
      return
    }

    this.filterText = ""
    this.filterInput.setText("")
    this.filterInput.cursorOffset = 0
  }

  private syncFilterInputText(): void {
    if (!this.filterInput || this.filterInput.plainText === this.filterText) {
      return
    }

    this.filterInput.setText(this.filterText)
    this.filterInput.cursorOffset = this.filterInput.plainText.length
  }

  private updateSelectOptions(filteredExamples: readonly Example[]): void {
    if (!this.selectElement) {
      return
    }

    if (this.selectBox) {
      this.selectBox.title = getExamplesBoxTitle(filteredExamples.length, this.filterText.trim().length > 0)
    }

    const options = createMenuOptions(filteredExamples)
    this.selectElement.options = options

    if (options.length === 0) {
      return
    }

    const selectedIndex = getExampleOptionIndexByName(options, this.selectedExampleName)
    const nextIndex = selectedIndex >= 0 ? selectedIndex : getFirstExampleOptionIndex(options)

    if (nextIndex < 0) {
      return
    }

    this.setSelectedOptionIndex(nextIndex)
  }

  private setSelectedOptionIndex(index: number): void {
    if (!this.selectElement) {
      return
    }

    this.selectElement.selectedIndex = index
    const option = (this.selectElement.options as MenuOption[])[index] ?? null
    this.selectedExampleName = getExampleFromOption(option)?.name ?? this.selectedExampleName
  }

  private focusNearestExampleOption(startIndex: number, direction: -1 | 1): void {
    if (!this.selectElement) {
      return
    }

    const options = this.selectElement.options as MenuOption[]
    const nextIndex = findNearestExampleOptionIndex(
      options,
      startIndex + direction,
      direction,
      this.selectElement.wrapSelection,
    )

    if (nextIndex >= 0) {
      this.setSelectedOptionIndex(nextIndex)
      return
    }

    const fallbackIndex = findNearestExampleOptionIndex(
      options,
      startIndex - direction,
      direction === 1 ? -1 : 1,
      this.selectElement.wrapSelection,
    )

    if (fallbackIndex >= 0) {
      this.setSelectedOptionIndex(fallbackIndex)
    }
  }

  private moveSelection(direction: -1 | 1, steps: number): void {
    if (!this.selectElement) {
      return
    }

    const options = this.selectElement.options as MenuOption[]
    if (options.length === 0) {
      return
    }

    let currentIndex = this.selectElement.getSelectedIndex()

    for (let step = 0; step < steps; step += 1) {
      const nextIndex = findNearestExampleOptionIndex(
        options,
        currentIndex + direction,
        direction,
        this.selectElement.wrapSelection,
      )

      if (nextIndex < 0) {
        break
      }

      currentIndex = nextIndex
    }

    this.setSelectedOptionIndex(currentIndex)
  }

  private filterExamples(): void {
    if (!this.filterInput || !this.selectElement) return

    const filterText = this.filterText.toLowerCase().trim()

    if (filterText === "") {
      this.updateSelectOptions(this.allExamples)
    } else {
      const filtered = this.allExamples.filter((example) => matchesExample(example, filterText))
      this.updateSelectOptions(filtered)
    }
  }

  private handleResize(width: number, height: number): void {
    if (this.title) {
      const titleWidth = this.title.frameBuffer.width
      const centerX = Math.floor(width / 2) - Math.floor(titleWidth / 2)
      this.title.x = centerX
    }

    this.renderer.requestRender()
  }

  private setupKeyboardHandling(): void {
    this.renderer.keyInput.on("keypress", (key: KeyEvent) => {
      if (key.name === "c" && key.ctrl) {
        this.cleanup()
        return
      }

      if (!this.inMenu) {
        switch (key.name) {
          case "escape":
            this.returnToMenu()
            break
        }
        return
      }

      if (key.name === "tab" || key.name === "escape") {
        key.preventDefault()
        key.stopPropagation()
        this.setMenuFocus(this.menuFocusArea === "filter" ? "list" : "filter")
        return
      }

      const printableText = getPrintableKeyText(key)

      if (this.menuFocusArea === "list") {
        if (key.name === "up" || key.name === "k") {
          key.preventDefault()
          this.moveSelection(-1, key.shift ? 5 : 1)
          return
        }

        if (key.name === "down" || key.name === "j") {
          key.preventDefault()
          this.moveSelection(1, key.shift ? 5 : 1)
          return
        }

        if (printableText === "/") {
          key.preventDefault()
          key.stopPropagation()
          this.setMenuFocus("filter")
          return
        }
      }

      if (this.menuFocusArea === "filter" && this.selectElement) {
        if (key.name === "up") {
          key.preventDefault()
          this.moveSelection(-1, key.shift ? 5 : 1)
          return
        }

        if (key.name === "down") {
          key.preventDefault()
          this.moveSelection(1, key.shift ? 5 : 1)
          return
        }

        if (key.name === "return" || key.name === "linefeed") {
          key.preventDefault()
          this.selectElement.selectCurrent()
          return
        }
      }

      if (key.name === "c" && key.ctrl) {
        this.cleanup()
        return
      }
      switch (key.name) {
        case "c":
          console.log("Capabilities:", this.renderer.capabilities)
          break
        case "z":
          if (key.ctrl) {
            console.log("Suspending renderer... (will auto-resume in 5 seconds)")
            this.renderer.suspend()
            setTimeout(() => {
              console.log("Resuming renderer...")
              this.renderer.resume()
            }, 5000)
          }
          break
      }
    })
    setupCommonDemoKeys(this.renderer)
  }

  private async runSelected(selected: Example): Promise<void> {
    this.inMenu = false
    this.hideMenuElements()

    if (selected.run) {
      this.currentExample = selected
      await selected.run(this.renderer)
    } else {
      if (!this.notImplementedText) {
        const theme = MENU_THEMES[this.themeMode]
        const unavailableMessage = selected.unavailableMessage ?? `${selected.name} is not implemented yet.`
        this.notImplementedText = new TextRenderable(this.renderer, {
          id: "not-implemented",
          position: "absolute",
          left: 10,
          top: 10,
          content: `${unavailableMessage} Press Escape to return.`,
          fg: theme.notImplementedColor,
          zIndex: 10,
        })
        this.renderer.root.add(this.notImplementedText)
      }
      this.renderer.requestRender()
    }
  }

  private hideMenuElements(): void {
    if (this.menuContainer) {
      this.menuContainer.visible = false
    }
    if (this.title) {
      this.title.visible = false
    }
    if (this.filterBox) {
      this.filterBox.visible = false
    }
    if (this.selectBox) {
      this.selectBox.visible = false
    }
    if (this.instructions) {
      this.instructions.visible = false
    }
    if (this.timeToFirstDrawText) {
      this.timeToFirstDrawText.visible = false
    }
    if (this.filterInput) {
      this.filterInput.blur()
    }
    if (this.selectElement) {
      this.selectElement.blur()
    }
  }

  private showMenuElements(): void {
    this.renderer.setTerminalTitle(MENU_TERMINAL_TITLE)

    if (this.menuContainer) {
      this.menuContainer.visible = true
    }
    if (this.title) {
      this.title.visible = true
    }
    if (this.filterBox) {
      this.filterBox.visible = true
    }
    if (this.selectBox) {
      this.selectBox.visible = true
    }
    if (this.instructions) {
      this.instructions.visible = true
    }
    if (this.timeToFirstDrawText) {
      this.timeToFirstDrawText.visible = true
    }

    this.clearFilter()
    this.setMenuFocus("filter")
  }

  private returnToMenu(): void {
    if (this.currentExample) {
      this.currentExample.destroy?.(this.renderer)
      this.currentExample = null
    }

    if (this.notImplementedText) {
      this.renderer.root.remove(this.notImplementedText.id)
      this.notImplementedText = null
    }

    this.inMenu = true
    this.restart()
  }

  private restart(): void {
    this.renderer.pause()
    this.renderer.auto()
    this.showMenuElements()
    this.renderer.setBackgroundColor("transparent")
    this.renderer.requestRender()
  }

  private cleanup(): void {
    if (this.currentExample) {
      this.currentExample.destroy?.(this.renderer)
    }
    if (this.filterInput) {
      this.filterInput.blur()
    }
    if (this.selectElement) {
      this.selectElement.blur()
    }
    if (this.menuContainer) {
      this.menuContainer.destroy()
    }
    this.renderer.destroy()
  }
}

const renderer = await createCliRenderer({
  exitOnCtrlC: false,
  targetFps: 60,
  // useAlternateScreen: false,
})

renderer.setBackgroundColor("transparent")
new ExampleSelector(renderer)
