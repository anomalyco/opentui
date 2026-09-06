export const DOC_SECTIONS = [
  { id: "start", title: "Start", order: 1 },
  { id: "frameworks", title: "Frameworks", order: 2 },
  { id: "core", title: "Core", order: 3 },
  { id: "components", title: "Components", order: 4 },
  { id: "application-apis", title: "Application APIs", order: 5 },
  { id: "test-debug", title: "Test and debug", order: 6 },
  { id: "plugin-slots", title: "Plugin slots", order: 7 },
  { id: "keymap", title: "Keymap", order: 8 },
  { id: "integrations", title: "Integrations", order: 9 },
  { id: "native", title: "Native", order: 10 },
  { id: "ship", title: "Ship", order: 11 },
  { id: "reference", title: "Reference", order: 12 },
] as const

export type DocSectionId = (typeof DOC_SECTIONS)[number]["id"]

export type DocPageType =
  | "orientation"
  | "concept"
  | "decision-guide"
  | "task-guide"
  | "component-reference"
  | "framework-guide"
  | "extension-subsystem"
  | "integration"
  | "reference"
  | "low-level-api"
  | "internals"

export interface DocAvailability {
  core: string
  react: string
  solid: string
}

export interface ComponentMetadata {
  purpose: string
  coreRenderable: string
  react: string
  solid: string
}

export interface DocManifestEntry {
  canonicalSection: string
  conceptualGroup?: string
  section: DocSectionId
  group?: string
  navTitle: string
  navOrder: number
  pageType: DocPageType
  status: string
  component?: ComponentMetadata
  primaryNav: boolean
  packages: string[]
  availability: DocAvailability
  runtimes: string[]
  searchSymbols: string[]
  related: string[]
  slug?: string
  url?: "/docs"
}

type DocManifestOptions = Partial<
  Pick<
    DocManifestEntry,
    | "canonicalSection"
    | "conceptualGroup"
    | "group"
    | "status"
    | "component"
    | "primaryNav"
    | "packages"
    | "availability"
    | "runtimes"
    | "searchSymbols"
    | "related"
    | "slug"
    | "url"
  >
>

const NOT_APPLICABLE: DocAvailability = {
  core: "Not applicable",
  react: "Not applicable",
  solid: "Not applicable",
}

const CORE_API: DocAvailability = {
  core: "Built in",
  react: "Available through Core",
  solid: "Available through Core",
}

const FRAMEWORKS: DocAvailability = {
  core: "Use the Core API",
  react: "Built in",
  solid: "Built in",
}

const BUILT_IN_ALL: DocAvailability = {
  core: "Built in",
  react: "Built in",
  solid: "Built in",
}

const CORE_ONLY: DocAvailability = {
  core: "Built in",
  react: "Unavailable",
  solid: "Unavailable",
}

const CANONICAL_SECTION: Record<DocSectionId, string> = {
  start: "Start",
  frameworks: "Frameworks",
  core: "Build / Core model",
  components: "Build / Components",
  "application-apis": "Build / Application capabilities",
  "test-debug": "Test and debug",
  "plugin-slots": "Extend / Plugin slots",
  keymap: "Extend / Keymap",
  integrations: "Integrate",
  native: "Native rendering and embedding",
  ship: "Ship",
  reference: "Reference / Lookup",
}

/* Sidebar labels: the 13rem column fits 24 monospace characters at the
 * 14px body size. Keep navTitle within that; the full title lives in
 * frontmatter. */
function page(
  section: DocSectionId,
  navOrder: number,
  navTitle: string,
  pageType: DocPageType,
  options: DocManifestOptions = {},
): DocManifestEntry {
  return {
    canonicalSection: CANONICAL_SECTION[section],
    conceptualGroup: options.conceptualGroup ?? options.group,
    section,
    navOrder,
    navTitle,
    pageType,
    status: "Supported",
    primaryNav: true,
    packages: ["@opentui/core"],
    availability: CORE_API,
    runtimes: ["Bun", "Node.js"],
    searchSymbols: [],
    related: [],
    ...options,
  }
}

export const DOC_MANIFEST = {
  "getting-started": page("start", 1, "Introduction", "orientation", {
    packages: ["@opentui/core", "@opentui/react", "@opentui/solid"],
    availability: FRAMEWORKS,
    searchSymbols: ["createCliRenderer"],
    related: ["getting-started/quickstart", "bindings/react", "bindings/solid"],
    url: "/docs",
  }),
  "getting-started/quickstart": page("start", 2, "Quickstart", "orientation", {
    searchSymbols: ["createCliRenderer", "TextRenderable"],
    related: ["core-concepts/renderer", "bindings/react", "bindings/solid", "core-concepts/lifecycle"],
  }),
  "getting-started/runtime-support": page("start", 3, "Runtime support", "decision-guide", {
    packages: [
      "@opentui/core",
      "@opentui/react",
      "@opentui/solid",
      "@opentui/keymap",
      "@opentui/qrcode",
      "@opentui/ssh",
      "@opentui/three",
    ],
    availability: FRAMEWORKS,
    searchSymbols: ["Bun", "Node.js", "FFI", "glibc", "musl"],
    related: ["getting-started/quickstart", "reference/package-entrypoints", "ship/deploy"],
  }),

  "bindings/react": page("frameworks", 1, "React", "framework-guide", {
    packages: ["@opentui/react"],
    availability: { core: "Use the Core API", react: "Built in", solid: "Use the Solid bindings" },
    searchSymbols: ["createRoot", "useRenderer", "useKeyboard", "usePaste", "useTimeline"],
    related: ["bindings/solid", "components/text", "keymap/react", "plugins/react"],
  }),
  "bindings/solid": page("frameworks", 2, "Solid", "framework-guide", {
    packages: ["@opentui/solid"],
    availability: { core: "Use the Core API", react: "Use the React bindings", solid: "Built in" },
    searchSymbols: ["render", "useRenderer", "useKeyboard", "useTimeline"],
    related: ["bindings/react", "components/text", "keymap/solid", "plugins/solid"],
  }),

  "core-concepts/renderer": page("core", 1, "Renderer", "concept", {
    searchSymbols: ["CliRenderer", "createCliRenderer"],
    related: [
      "core-concepts/lifecycle",
      "core-concepts/clipboard",
      "core-concepts/notifications",
      "core-concepts/console",
      "reference/env-vars",
    ],
  }),
  "core-concepts/renderables": page("core", 2, "Renderables", "concept", {
    searchSymbols: ["Renderable", "BaseRenderable", "RenderableOptions"],
    related: ["core-concepts/layout", "core-concepts/lifecycle"],
  }),
  "core-concepts/layout": page("core", 3, "Layout", "concept", {
    searchSymbols: ["LayoutOptions", "PositionType", "Overflow"],
    related: ["components/box", "components/scrollbox", "core-concepts/rendering-pipeline"],
  }),
  "core-concepts/interaction": page("core", 4, "Interaction", "concept", {
    searchSymbols: ["MouseEvent", "FocusableRenderable", "Selection", "SelectionEvent"],
    related: ["core-concepts/keyboard", "components/input", "components/text", "core-concepts/testing"],
  }),
  "core-concepts/keyboard": page("core", 5, "Keyboard input", "concept", {
    searchSymbols: ["KeyEvent", "KeyHandler", "onKeypress", "onPaste"],
    related: ["keymap/overview", "core-concepts/renderables", "core-concepts/testing"],
  }),
  "core-concepts/text-and-cells": page("core", 6, "Text and terminal cells", "concept", {
    searchSymbols: ["StyledText", "TextChunk", "string-width", "detectLinks"],
    related: ["components/text", "core-concepts/layout", "core-concepts/interaction"],
  }),
  "core-concepts/colors": page("core", 7, "Colors", "concept", {
    searchSymbols: ["RGBA", "parseColor", "TerminalPalette"],
    related: ["components/text", "components/frame-buffer", "reference/color-matrix"],
  }),
  "core-concepts/lifecycle": page("core", 8, "Lifecycle and cleanup", "concept", {
    searchSymbols: ["destroy", "destroyTreeSitterClient", "destroyAudioSystem"],
    related: ["core-concepts/renderer", "bindings/react", "bindings/solid"],
  }),
  "core-concepts/rendering-pipeline": page("core", 9, "Rendering pipeline", "internals", {
    primaryNav: false,
    status: "Maintained internals",
    searchSymbols: ["OptimizedBuffer", "CliRenderer", "render"],
    related: [
      "native/overview",
      "native/frames",
      "core-concepts/layout",
      "components/frame-buffer",
      "components/image",
    ],
  }),
  "extend/custom-renderables": page("core", 10, "Custom renderables", "task-guide", {
    canonicalSection: "Extend / Custom UI",
    primaryNav: false,
    status: "Advanced",
    searchSymbols: ["BaseRenderable", "Renderable", "render", "measure"],
    related: ["core-concepts/renderables", "core-concepts/lifecycle", "bindings/react", "bindings/solid"],
  }),

  "components/overview": page("components", 1, "Overview", "reference", {
    slug: "components",
    availability: FRAMEWORKS,
    searchSymbols: [
      "TextRenderable",
      "BoxRenderable",
      "InputRenderable",
      "ImageRenderable",
      "EmbeddedTerminalRenderable",
    ],
    related: ["core-concepts/renderables", "bindings/react", "bindings/solid"],
  }),
  "components/text": page("components", 2, "Text", "component-reference", {
    group: "Display and layout",
    availability: BUILT_IN_ALL,
    status: "Built in",
    component: {
      purpose: "Displays read-only styled, wrapping, and selectable text.",
      coreRenderable: "TextRenderable",
      react: "<text> (built in)",
      solid: "<text> (built in)",
    },
    searchSymbols: ["TextRenderable", "text", "StyledText"],
    related: ["components/box", "core-concepts/colors"],
  }),
  "components/box": page("components", 3, "Box", "component-reference", {
    group: "Display and layout",
    availability: BUILT_IN_ALL,
    status: "Built in",
    component: {
      purpose: "Provides layout, fill, borders, titles, clipping, and child layout.",
      coreRenderable: "BoxRenderable",
      react: "<box> (built in)",
      solid: "<box> (built in)",
    },
    searchSymbols: ["BoxRenderable", "box"],
    related: ["components/text", "core-concepts/layout"],
  }),
  "components/input": page("components", 4, "Input", "component-reference", {
    group: "Input and selection",
    availability: BUILT_IN_ALL,
    status: "Built in",
    component: {
      purpose: "Edits one line of text and emits input, change, and submit events.",
      coreRenderable: "InputRenderable",
      react: "<input> (built in)",
      solid: "<input> (built in)",
    },
    searchSymbols: ["InputRenderable", "input"],
    related: ["components/textarea", "core-concepts/keyboard"],
  }),
  "components/textarea": page("components", 5, "Textarea", "component-reference", {
    group: "Input and selection",
    availability: BUILT_IN_ALL,
    status: "Built in",
    component: {
      purpose: "Edits multiline text with cursor movement, selection, history, and key bindings.",
      coreRenderable: "TextareaRenderable",
      react: "<textarea> (built in)",
      solid: "<textarea> (built in)",
    },
    searchSymbols: ["TextareaRenderable", "Textarea", "textarea"],
    related: ["components/input", "core-concepts/keyboard"],
  }),
  "components/select": page("components", 6, "Select", "component-reference", {
    group: "Input and selection",
    availability: BUILT_IN_ALL,
    status: "Built in",
    component: {
      purpose: "Displays a focusable vertical list for highlighted and confirmed choices.",
      coreRenderable: "SelectRenderable",
      react: "<select> (built in)",
      solid: "<select> (built in)",
    },
    searchSymbols: ["SelectRenderable", "select"],
    related: ["components/tab-select", "core-concepts/keyboard"],
  }),
  "components/tab-select": page("components", 7, "TabSelect", "component-reference", {
    group: "Input and selection",
    availability: BUILT_IN_ALL,
    status: "Built in",
    component: {
      purpose: "Displays a focusable horizontal tab selector.",
      coreRenderable: "TabSelectRenderable",
      react: "<tab-select> (built in)",
      solid: "<tab_select> (built in)",
    },
    searchSymbols: ["TabSelectRenderable", "tabSelect"],
    related: ["components/select", "components/scrollbox"],
  }),
  "components/slider": page("components", 8, "Slider", "component-reference", {
    group: "Input and selection",
    availability: CORE_ONLY,
    status: "Built-in Core renderable",
    component: {
      purpose: "Provides a pointer-draggable horizontal or vertical numeric thumb.",
      coreRenderable: "SliderRenderable",
      react: "Unavailable",
      solid: "Unavailable",
    },
    searchSymbols: ["SliderRenderable", "Slider", "slider"],
    related: ["components/input", "core-concepts/keyboard"],
  }),
  "components/scrollbox": page("components", 9, "ScrollBox", "component-reference", {
    group: "Scrolling",
    availability: BUILT_IN_ALL,
    status: "Built in",
    component: {
      purpose: "Clips and scrolls child content with integrated scroll bars and viewport culling.",
      coreRenderable: "ScrollBoxRenderable",
      react: "<scrollbox> (built in)",
      solid: "<scrollbox> (built in)",
    },
    searchSymbols: ["ScrollBoxRenderable", "scrollBox"],
    related: ["components/scrollbar", "core-concepts/layout"],
  }),
  "components/scrollbar": page("components", 10, "ScrollBar", "component-reference", {
    group: "Scrolling",
    availability: CORE_ONLY,
    status: "Built-in Core renderable",
    component: {
      purpose: "Maps content size, viewport size, and position onto a focusable scroll control.",
      coreRenderable: "ScrollBarRenderable",
      react: "Unavailable",
      solid: "Unavailable",
    },
    searchSymbols: ["ScrollBarRenderable", "ScrollBar", "scrollBar"],
    related: ["components/scrollbox", "core-concepts/layout"],
  }),
  "components/code": page("components", 11, "Code", "component-reference", {
    group: "Rich content",
    availability: BUILT_IN_ALL,
    status: "Built in",
    component: {
      purpose: "Displays selectable source text with optional Tree-sitter highlighting.",
      coreRenderable: "CodeRenderable",
      react: "<code> (built in)",
      solid: "<code> (built in)",
    },
    searchSymbols: ["CodeRenderable", "code"],
    related: ["components/markdown", "components/line-number", "reference/tree-sitter"],
  }),
  "components/markdown": page("components", 12, "Markdown", "component-reference", {
    group: "Rich content",
    availability: BUILT_IN_ALL,
    status: "Built in",
    component: {
      purpose: "Parses markdown into text, code, layout, list, rule, and table children.",
      coreRenderable: "MarkdownRenderable",
      react: "<markdown> (built in)",
      solid: "<markdown> (built in)",
    },
    searchSymbols: ["MarkdownRenderable", "Markdown", "markdown"],
    related: ["components/code", "reference/tree-sitter"],
  }),
  "components/line-number": page("components", 13, "Line numbers", "component-reference", {
    group: "Rich content",
    availability: {
      core: "Built in",
      react: "Built in",
      solid: "Built in; exact props declaration unavailable",
    },
    status: "Built in with a Solid typing limitation",
    component: {
      purpose: "Adds line numbers, signs, and backgrounds beside one line-info target.",
      coreRenderable: "LineNumberRenderable",
      react: "<line-number> (built in)",
      solid: "<line_number> (built in; exact props declaration unavailable)",
    },
    searchSymbols: ["LineNumberRenderable"],
    related: ["components/code", "components/diff"],
  }),
  "components/diff": page("components", 14, "Diff", "component-reference", {
    group: "Rich content",
    availability: {
      core: "Built in",
      react: "Built in",
      solid: "Built in; exact props declaration unavailable",
    },
    status: "Built in with a Solid typing limitation",
    component: {
      purpose: "Displays the first patch in unified or side-by-side code panes.",
      coreRenderable: "DiffRenderable",
      react: "<diff> (built in)",
      solid: "<diff> (built in; exact props declaration unavailable)",
    },
    searchSymbols: ["DiffRenderable", "Diff", "diff"],
    related: ["components/code", "components/line-number"],
  }),
  "components/text-table": page("components", 15, "TextTable", "component-reference", {
    group: "Rich content",
    availability: CORE_ONLY,
    status: "Built-in Core renderable",
    component: {
      purpose: "Measures and draws styled tabular text with wrapping, borders, padding, and grid selection.",
      coreRenderable: "TextTableRenderable",
      react: "Unavailable",
      solid: "Unavailable",
    },
    searchSymbols: ["TextTableRenderable", "TextTable", "textTable"],
    related: ["components/text", "components/scrollbox"],
  }),
  "components/ascii-font": page("components", 16, "ASCIIFont", "component-reference", {
    group: "Graphics and media",
    availability: BUILT_IN_ALL,
    status: "Built in",
    component: {
      purpose: "Measures and draws text with a bundled large-glyph font.",
      coreRenderable: "ASCIIFontRenderable",
      react: "<ascii-font> (built in)",
      solid: "<ascii_font> (built in)",
    },
    searchSymbols: ["ASCIIFontRenderable", "asciiFont"],
    related: ["components/text", "components/frame-buffer"],
  }),
  "components/frame-buffer": page("components", 17, "FrameBuffer", "component-reference", {
    group: "Graphics and media",
    availability: CORE_ONLY,
    status: "Advanced",
    component: {
      purpose: "Owns a layout-sized OptimizedBuffer and composites its cells into the render tree.",
      coreRenderable: "FrameBufferRenderable",
      react: "Unavailable",
      solid: "Unavailable",
    },
    searchSymbols: ["FrameBufferRenderable", "frameBuffer", "OptimizedBuffer"],
    related: ["components/image", "reference/color-matrix"],
  }),
  "components/image": page("components", 18, "Image", "component-reference", {
    group: "Graphics and media",
    availability: BUILT_IN_ALL,
    status: "Built in",
    component: {
      purpose: "Draws a NativeImage with Kitty, Sixel, or Unicode blocks.",
      coreRenderable: "ImageRenderable",
      react: "<image> (built in)",
      solid: "<image> (built in)",
    },
    searchSymbols: ["ImageRenderable", "Image", "image"],
    related: ["reference/native-image", "components/frame-buffer"],
  }),
  "components/qr-code": page("components", 19, "QR code", "component-reference", {
    group: "Graphics and media",
    packages: ["@opentui/qrcode"],
    availability: {
      core: "Built in from @opentui/qrcode",
      react: "Register @opentui/qrcode/react",
      solid: "Register @opentui/qrcode/solid",
    },
    status: "Separately registered",
    component: {
      purpose: "Encodes text as QR Code Model 2 and draws its modules with terminal half blocks.",
      coreRenderable: "QRCodeRenderable",
      react: "registerQRCode(), then <qr-code>",
      solid: "registerQRCode(), then <qr_code>",
    },
    searchSymbols: ["QRCodeRenderable", "QRCode", "qrCode"],
    related: ["reference/qr-encoder", "components/image"],
  }),
  "components/embedded-terminal": page("components", 20, "Embedded terminal", "component-reference", {
    group: "Graphics and media",
    availability: CORE_ONLY,
    status: "Built-in Core renderable",
    component: {
      purpose: "Parses VT output and draws a child terminal screen in the render tree.",
      coreRenderable: "EmbeddedTerminalRenderable",
      react: "Unavailable",
      solid: "Unavailable",
    },
    searchSymbols: [
      "EmbeddedTerminalRenderable",
      "EmbeddedTerminalOptions",
      "EmbeddedTerminalScreen",
      "EmbeddedTerminalDataSource",
    ],
    related: [
      "core-concepts/interaction",
      "core-concepts/keyboard",
      "core-concepts/testing",
      "extend/custom-renderables",
    ],
  }),

  "core-concepts/clipboard": page("application-apis", 1, "Clipboard", "task-guide", {
    searchSymbols: ["Clipboard", "OSC52", "copyToClipboard"],
    related: ["core-concepts/renderer", "reference/ssh"],
  }),
  "core-concepts/notifications": page("application-apis", 2, "Notifications", "task-guide", {
    searchSymbols: ["sendNotification"],
    related: ["core-concepts/renderer", "reference/env-vars"],
  }),
  "core-concepts/audio": page("application-apis", 3, "Audio", "task-guide", {
    searchSymbols: ["Audio", "setupAudio", "AudioSound", "AudioVoice", "AudioGroup"],
    related: ["core-concepts/lifecycle", "reference/standalone-executables"],
  }),
  "application-apis/audio-streaming": page("application-apis", 4, "Streaming audio", "task-guide", {
    searchSymbols: ["AudioStream", "AudioStreamError", "createIcyStreamDemuxer"],
    related: ["core-concepts/audio", "application-apis/audio-capture", "core-concepts/lifecycle"],
  }),
  "application-apis/audio-capture": page("application-apis", 5, "Audio capture", "task-guide", {
    searchSymbols: ["AudioCaptureStream", "AudioCaptureStreamError", "AudioRecorder", "AudioRecorderError"],
    related: ["core-concepts/audio", "application-apis/audio-streaming", "core-concepts/lifecycle"],
  }),
  "application-apis/animation": page("application-apis", 6, "Animation and Timeline", "task-guide", {
    searchSymbols: ["Timeline", "createTimeline", "engine", "useTimeline"],
    related: ["bindings/react", "bindings/solid", "core-concepts/lifecycle"],
  }),

  "core-concepts/testing": page("test-debug", 1, "Testing", "task-guide", {
    packages: ["@opentui/core", "@opentui/react", "@opentui/solid", "@opentui/keymap"],
    availability: {
      core: "Built in from @opentui/core/testing",
      react: "Built in from @opentui/react/test-utils",
      solid: "Built in from @opentui/solid",
    },
    searchSymbols: ["TestRenderer", "createTestRenderer", "testRender", "createTestKeymap"],
    related: ["bindings/react", "bindings/solid", "keymap/overview"],
  }),
  "core-concepts/console": page("test-debug", 2, "Console overlay", "task-guide", {
    searchSymbols: ["ConsoleOverlay", "renderer.console"],
    related: ["core-concepts/renderer", "reference/env-vars"],
  }),
  "test-and-debug/rendering-diagnostics": page("test-debug", 3, "Rendering diagnostics", "task-guide", {
    searchSymbols: ["TimeToFirstDraw", "renderStats", "fps"],
    related: ["components/time-to-first-draw", "core-concepts/console", "core-concepts/testing"],
  }),
  "components/time-to-first-draw": page("test-debug", 4, "TimeToFirstDraw", "component-reference", {
    primaryNav: false,
    availability: BUILT_IN_ALL,
    status: "Built-in diagnostic",
    component: {
      purpose: "Captures and displays one performance.now() timestamp on its first draw.",
      coreRenderable: "TimeToFirstDrawRenderable",
      react: "TimeToFirstDraw or <time-to-first-draw> (built in)",
      solid: "TimeToFirstDraw or <time_to_first_draw> (built in)",
    },
    searchSymbols: ["TimeToFirstDrawRenderable", "TimeToFirstDraw"],
    related: ["core-concepts/renderer", "core-concepts/testing"],
  }),
  "test-and-debug/native-crashes": page("test-debug", 4, "Native crash debugging", "task-guide", {
    searchSymbols: ["GDB", "LLDB", "PDB", "dSYM", "debug symbols", "core dump"],
    related: ["test-and-debug/troubleshooting", "getting-started/runtime-support"],
  }),
  "test-and-debug/troubleshooting": page("test-debug", 5, "Troubleshooting", "task-guide", {
    packages: [
      "@opentui/core",
      "@opentui/react",
      "@opentui/solid",
      "@opentui/keymap",
      "@opentui/qrcode",
      "@opentui/ssh",
      "@opentui/three",
    ],
    availability: FRAMEWORKS,
    searchSymbols: ["FFI", "Tree-sitter", "Kitty", "Sixel", "OSC 52"],
    related: ["getting-started/runtime-support", "reference/terminal-capabilities", "reference/env-vars"],
  }),

  "plugins/slots": page("plugin-slots", 1, "Overview", "extension-subsystem", {
    searchSymbols: ["PluginRegistry", "PluginSlot", "PluginContribution"],
    related: ["plugins/core", "plugins/react", "plugins/solid"],
  }),
  "plugins/core": page("plugin-slots", 2, "Core", "extension-subsystem", {
    searchSymbols: ["CoreSlot", "BaseRenderable"],
    related: ["plugins/slots", "core-concepts/renderables"],
  }),
  "plugins/react": page("plugin-slots", 3, "React", "extension-subsystem", {
    packages: ["@opentui/react"],
    availability: { core: "Use Core plugin slots", react: "Built in", solid: "Use Solid plugin slots" },
    searchSymbols: ["PluginSlot"],
    related: ["plugins/slots", "bindings/react"],
  }),
  "plugins/solid": page("plugin-slots", 4, "Solid", "extension-subsystem", {
    packages: ["@opentui/solid"],
    availability: { core: "Use Core plugin slots", react: "Use React plugin slots", solid: "Built in" },
    searchSymbols: ["PluginSlot"],
    related: ["plugins/slots", "bindings/solid"],
  }),
  "extend/runtime-plugins": page("plugin-slots", 5, "Load at runtime", "task-guide", {
    canonicalSection: "Extend / Runtime extensions",
    packages: ["@opentui/core", "@opentui/react", "@opentui/solid"],
    availability: FRAMEWORKS,
    runtimes: ["Bun"],
    searchSymbols: ["RuntimePlugin", "installRuntimePluginSupport", "Bun.plugin"],
    related: ["plugins/slots", "reference/standalone-executables", "reference/package-entrypoints"],
  }),

  "keymap/overview": page("keymap", 1, "Overview", "extension-subsystem", {
    packages: ["@opentui/keymap"],
    availability: FRAMEWORKS,
    runtimes: ["Bun", "Node.js", "Browser"],
    searchSymbols: ["createKeymap", "Keymap", "KeyBinding", "KeyCommand"],
    related: ["core-concepts/keyboard", "keymap/hosts", "keymap/core"],
  }),
  "keymap/hosts": page("keymap", 2, "Hosts", "extension-subsystem", {
    packages: ["@opentui/keymap"],
    availability: FRAMEWORKS,
    runtimes: ["Bun", "Node.js", "Browser"],
    searchSymbols: ["KeymapHost", "createOpenTUIKeymapHost", "createHTMLKeymapHost"],
    related: ["keymap/overview", "keymap/core"],
  }),
  "keymap/core": page("keymap", 3, "Core engine", "reference", {
    packages: ["@opentui/keymap"],
    availability: FRAMEWORKS,
    runtimes: ["Bun", "Node.js", "Browser"],
    searchSymbols: ["Keymap", "KeymapEngine", "parseKeyBinding"],
    related: ["keymap/overview", "keymap/hosts", "keymap/custom-addons"],
  }),
  "keymap/react": page("keymap", 4, "React", "framework-guide", {
    packages: ["@opentui/keymap"],
    availability: { core: "Use the Core engine", react: "Built in", solid: "Use the Solid integration" },
    searchSymbols: ["KeymapProvider", "useKeymap", "useKeymapState"],
    related: ["bindings/react", "keymap/overview"],
  }),
  "keymap/solid": page("keymap", 5, "Solid", "framework-guide", {
    packages: ["@opentui/keymap"],
    availability: { core: "Use the Core engine", react: "Use the React integration", solid: "Built in" },
    searchSymbols: ["KeymapProvider", "useKeymap", "useKeymapState"],
    related: ["bindings/solid", "keymap/overview"],
  }),
  "keymap/addons": page("keymap", 6, "Built-in addons", "reference", {
    packages: ["@opentui/keymap"],
    availability: FRAMEWORKS,
    searchSymbols: ["vim", "emacs", "tmux"],
    related: ["keymap/overview", "keymap/custom-addons"],
  }),
  "keymap/custom-addons": page("keymap", 7, "Custom addons", "extension-subsystem", {
    packages: ["@opentui/keymap"],
    availability: FRAMEWORKS,
    searchSymbols: ["KeymapAddon", "ExtensionCallback"],
    related: ["keymap/core", "keymap/addons"],
  }),

  "reference/tree-sitter": page("integrations", 1, "Tree-sitter", "integration", {
    packages: ["@opentui/core", "web-tree-sitter"],
    searchSymbols: ["getTreeSitterClient", "SyntaxStyle"],
    related: ["components/code", "components/markdown"],
  }),
  "reference/ssh": page("integrations", 2, "SSH", "integration", {
    packages: ["@opentui/ssh"],
    availability: FRAMEWORKS,
    searchSymbols: ["createSSHServer", "OpenTUISSHSession"],
    related: ["core-concepts/clipboard", "reference/standalone-executables"],
  }),
  "reference/three": page("integrations", 3, "Three.js WebGPU", "integration", {
    packages: ["@opentui/three", "three"],
    availability: { core: "Built in", react: "Available through Core", solid: "Available through Core" },
    runtimes: ["Bun"],
    searchSymbols: ["ThreeCliRenderer", "WebGPURenderer"],
    related: ["components/frame-buffer", "reference/color-matrix"],
  }),
  "reference/qr-encoder": page("integrations", 4, "QR encoder", "integration", {
    packages: ["@opentui/qrcode"],
    availability: FRAMEWORKS,
    searchSymbols: ["createQRCode", "renderQRCode", "renderQRCodeSvg"],
    related: ["components/qr-code"],
  }),

  "native/overview": page("native", 1, "Overview", "concept", {
    status: "Experimental native ABI",
    packages: ["@opentui/native"],
    availability: NOT_APPLICABLE,
    runtimes: ["Native"],
    searchSymbols: ["retained scene", "native rendering"],
    related: ["native/resources", "native/frames", "native/core", "native/c", "native/zig", "native/rust"],
  }),
  "native/resources": page("native", 2, "Resources and ownership", "low-level-api", {
    status: "Experimental native ABI",
    packages: ["@opentui/native"],
    availability: NOT_APPLICABLE,
    runtimes: ["Native"],
    searchSymbols: ["ot_handle", "ot_context_destroy", "ot_buffer_create", "storage lease"],
    related: ["native/overview", "native/frames", "native/core", "native/c", "native/zig", "native/rust"],
  }),
  "native/frames": page("native", 3, "Frames and output", "low-level-api", {
    status: "Experimental native ABI",
    packages: ["@opentui/native"],
    availability: NOT_APPLICABLE,
    runtimes: ["Native"],
    searchSymbols: [
      "ot_scene_frame_step_with_geometry",
      "ot_scene_frame_commit",
      "ot_scene_frame_request",
      "ot_session_pump",
      "ot_session_complete_output",
    ],
    related: ["native/resources", "native/core", "native/c", "native/zig", "native/rust"],
  }),
  "native/core": page("native", 4, "How Core uses native", "internals", {
    status: "Maintained Core integration",
    searchSymbols: [
      "NativeScene",
      "NativeSession",
      "ResourceContext",
      "NativeResourceOwner",
      "BufferAccess",
      "nativeScenePaintBudget",
      "nativeSceneWorkBudget",
    ],
    related: [
      "native/overview",
      "core-concepts/rendering-pipeline",
      "extend/custom-renderables",
      "reference/buffer-api",
    ],
  }),
  "native/c": page("native", 5, "C", "integration", {
    status: "Experimental native ABI",
    packages: ["@opentui/native"],
    availability: NOT_APPLICABLE,
    runtimes: ["Native"],
    searchSymbols: ["ot_context_create", "ot_scene_create_node", "opentui.h", "C ABI"],
    related: ["native/resources", "native/frames", "native/zig", "native/rust"],
  }),
  "native/zig": page("native", 6, "Zig", "integration", {
    status: "Experimental native module",
    packages: ["@opentui/native"],
    availability: NOT_APPLICABLE,
    runtimes: ["Native"],
    searchSymbols: ["Zig", "Context.init", "sceneCreateNode", "scenePaint", "renderSession"],
    related: ["native/resources", "native/frames", "native/c", "native/rust"],
  }),
  "native/rust": page("native", 7, "Rust", "integration", {
    status: "Example binding; Linux x86_64 glibc only",
    packages: ["@opentui/native"],
    availability: NOT_APPLICABLE,
    runtimes: ["Native"],
    searchSymbols: ["Rust", "Cargo", "Context", "Session", "Node", "OPENTUI_LIB_DIR"],
    related: ["native/resources", "native/frames", "native/c", "native/zig"],
  }),

  "reference/standalone-executables": page("ship", 2, "Standalone executables", "task-guide", {
    packages: ["@opentui/core", "@opentui/react", "@opentui/solid"],
    availability: FRAMEWORKS,
    searchSymbols: ["bun build --compile", "node:sea"],
    related: ["reference/env-vars", "reference/ssh"],
  }),
  "ship/deploy": page("ship", 1, "Deploy", "task-guide", {
    packages: [
      "@opentui/core",
      "@opentui/react",
      "@opentui/solid",
      "@opentui/keymap",
      "@opentui/qrcode",
      "@opentui/ssh",
      "@opentui/three",
    ],
    availability: FRAMEWORKS,
    searchSymbols: ["bun build --compile", "Node.js SEA", "SSH"],
    related: ["reference/standalone-executables", "reference/ssh", "getting-started/runtime-support"],
  }),

  "reference/api-index": page("reference", 1, "API and symbol index", "reference", {
    packages: [
      "@opentui/core",
      "@opentui/react",
      "@opentui/solid",
      "@opentui/keymap",
      "@opentui/qrcode",
      "@opentui/ssh",
      "@opentui/three",
    ],
    availability: NOT_APPLICABLE,
    runtimes: ["Bun", "Node.js", "Browser", "Build time"],
    searchSymbols: ["API", "exports", "symbols"],
    related: ["reference/package-entrypoints", "components/overview", "getting-started/runtime-support"],
  }),
  "reference/package-entrypoints": page("reference", 2, "Package entry points", "reference", {
    packages: [
      "@opentui/core",
      "@opentui/react",
      "@opentui/solid",
      "@opentui/keymap",
      "@opentui/qrcode",
      "@opentui/ssh",
      "@opentui/three",
    ],
    availability: NOT_APPLICABLE,
    runtimes: ["Bun", "Node.js", "Browser", "Build time"],
    searchSymbols: ["exports"],
    related: ["reference/env-vars", "getting-started/quickstart"],
  }),
  "reference/env-vars": page("reference", 3, "Environment variables", "reference", {
    packages: ["@opentui/core", "@opentui/react", "@opentui/solid", "@opentui/three"],
    availability: NOT_APPLICABLE,
    searchSymbols: ["OTUI_DEBUG", "OTUI_USE_CONSOLE", "OTUI_TREE_SITTER_WORKER_PATH"],
    related: ["core-concepts/renderer", "core-concepts/console", "reference/standalone-executables"],
  }),
  "reference/terminal-capabilities": page("reference", 4, "Terminal capabilities", "reference", {
    searchSymbols: ["TerminalCapabilities", "Kitty", "Sixel", "OSC 52"],
    related: ["core-concepts/renderer", "components/image", "core-concepts/clipboard", "core-concepts/notifications"],
  }),
  "reference/native-image": page("reference", 5, "Native images", "low-level-api", {
    canonicalSection: "Reference / Low-level rendering",
    group: "Low-level rendering",
    status: "Advanced",
    searchSymbols: ["NativeImage", "decodeImage", "ImageFormat"],
    related: ["components/image", "components/frame-buffer"],
  }),
  "reference/color-matrix": page("reference", 6, "Color matrices", "low-level-api", {
    canonicalSection: "Reference / Low-level rendering",
    group: "Low-level rendering",
    status: "Advanced",
    searchSymbols: ["OptimizedBuffer", "ColorMatrix", "applyColorMatrix"],
    related: ["components/frame-buffer", "core-concepts/colors"],
  }),
  "reference/native-span-feed": page("reference", 7, "NativeSpanFeed", "low-level-api", {
    canonicalSection: "Reference / Low-level rendering",
    group: "Low-level rendering",
    primaryNav: false,
    status: "Advanced",
    searchSymbols: ["NativeSpanFeed"],
    related: ["core-concepts/renderer", "core-concepts/lifecycle"],
  }),
  "reference/buffer-api": page("reference", 8, "Buffer API", "low-level-api", {
    canonicalSection: "Reference / Low-level rendering",
    group: "Low-level rendering",
    primaryNav: false,
    status: "Advanced",
    searchSymbols: ["OptimizedBuffer", "BufferView", "drawText", "drawBox"],
    related: ["components/frame-buffer", "reference/color-matrix", "extend/post-processing"],
  }),
  "extend/editing": page("reference", 9, "Editing buffers and views", "low-level-api", {
    canonicalSection: "Extend / Custom UI",
    conceptualGroup: "Editing model",
    primaryNav: false,
    status: "Advanced; extmarks are experimental",
    searchSymbols: ["TextBuffer", "TextBufferView", "EditBuffer", "EditorView", "Extmark"],
    related: ["components/input", "components/textarea", "extend/custom-renderables"],
  }),
  "extend/post-processing": page("reference", 10, "Post-processing effects", "low-level-api", {
    canonicalSection: "Extend / Custom UI",
    conceptualGroup: "Post-processing",
    primaryNav: false,
    status: "Advanced",
    searchSymbols: ["Filter", "Effect", "ColorMatrix"],
    related: ["components/frame-buffer", "reference/buffer-api", "reference/color-matrix"],
  }),
  "reference/data-paths": page("reference", 11, "Application data paths", "reference", {
    primaryNav: false,
    status: "Advanced",
    searchSymbols: ["DataPathsManager", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"],
    related: ["reference/env-vars", "getting-started/runtime-support"],
  }),
  "reference/yoga": page("reference", 12, "Yoga API", "low-level-api", {
    canonicalSection: "Reference / Native interfaces",
    primaryNav: false,
    status: "Advanced; ExperimentalFeature is experimental",
    searchSymbols: ["Yoga", "YGNode", "@opentui/core/yoga"],
    related: ["core-concepts/layout", "reference/package-entrypoints"],
  }),
} satisfies Record<string, DocManifestEntry>

export type DocSourceId = keyof typeof DOC_MANIFEST

export interface DocLearningSequence {
  id: string
  title: string
  pages: string[]
}

export const DOC_LEARNING_SEQUENCES: DocLearningSequence[] = [
  {
    id: "core",
    title: "Core learning path",
    pages: [
      "getting-started",
      "getting-started/quickstart",
      "getting-started/runtime-support",
      "core-concepts/renderer",
      "core-concepts/renderables",
      "core-concepts/layout",
      "core-concepts/interaction",
      "core-concepts/keyboard",
      "core-concepts/text-and-cells",
      "core-concepts/colors",
      "core-concepts/lifecycle",
      "components",
      "core-concepts/testing",
    ],
  },
  {
    id: "react",
    title: "React learning path",
    pages: [
      "getting-started/quickstart",
      "bindings/react",
      "components",
      "keymap/react",
      "plugins/react",
      "core-concepts/testing",
    ],
  },
  {
    id: "solid",
    title: "Solid learning path",
    pages: [
      "getting-started/quickstart",
      "bindings/solid",
      "components",
      "keymap/solid",
      "plugins/solid",
      "core-concepts/testing",
    ],
  },
  {
    id: "keymap",
    title: "Keymap learning path",
    pages: [
      "keymap/overview",
      "keymap/hosts",
      "keymap/core",
      "keymap/react",
      "keymap/solid",
      "keymap/addons",
      "keymap/custom-addons",
    ],
  },
  {
    id: "audio",
    title: "Audio learning path",
    pages: ["core-concepts/audio", "application-apis/audio-streaming", "application-apis/audio-capture"],
  },
  {
    id: "test-debug",
    title: "Test and debug learning path",
    pages: [
      "core-concepts/testing",
      "core-concepts/console",
      "test-and-debug/rendering-diagnostics",
      "test-and-debug/native-crashes",
      "test-and-debug/troubleshooting",
    ],
  },
  {
    id: "native",
    title: "Native C learning path",
    pages: ["native/overview", "native/resources", "native/frames", "native/core", "native/c"],
  },
  {
    id: "native-zig",
    title: "Native Zig learning path",
    pages: ["native/overview", "native/resources", "native/frames", "native/core", "native/zig"],
  },
  {
    id: "native-rust",
    title: "Native Rust learning path",
    pages: ["native/overview", "native/resources", "native/frames", "native/core", "native/rust"],
  },
  {
    id: "ship",
    title: "Deployment learning path",
    pages: ["ship/deploy", "reference/standalone-executables", "reference/ssh"],
  },
]
