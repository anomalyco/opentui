import {
  TextAttributes,
  createCliRenderer,
  RGBA,
  TextRenderable,
  BoxRenderable,
  OptimizedBuffer,
  type KeyEvent,
  type MouseEvent,
  t,
  bold,
  underline,
  fg,
} from "@opentui/core"
import type { CliRenderer, RenderContext, ThemeMode } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

let nextZIndex = 101
let draggableBoxes: DraggableTransparentBox[] = []
let keyListener: ((key: KeyEvent) => void) | null = null
let themeModeListener: ((mode: ThemeMode) => void) | null = null
let demoRunVersion = 0

const DEFAULT_THEME_MODE: ThemeMode = "dark"

const THEMES = {
  dark: {
    backgroundColor: "#0A0E14",
    headerAccent: "#00D4AA",
    headerMuted: "#A8A8B2",
    textUnderAlpha: "#FFB84D",
    moreTextUnder: "#7B68EE",
    boxLabelColor: RGBA.fromInts(255, 255, 255, 220),
    label: "dark",
  },
  light: {
    backgroundColor: "#F6F1E5",
    headerAccent: "#0F766E",
    headerMuted: "#4B5563",
    textUnderAlpha: "#B45309",
    moreTextUnder: "#6D28D9",
    boxLabelColor: RGBA.fromInts(17, 24, 39, 220),
    label: "light",
  },
  transparent: {
    backgroundColor: "transparent",
    headerAccent: "#0284C7",
    headerMuted: "#64748B",
    textUnderAlpha: "#D97706",
    moreTextUnder: "#7C3AED",
    boxLabelColor: RGBA.fromInts(255, 255, 255, 220),
    label: "transparent",
  },
} as const

type ThemeName = keyof typeof THEMES
const THEME_ORDER: ThemeName[] = ["dark", "light", "transparent"]

function getTransparentFallbackBackgroundColor(themeMode: ThemeMode): RGBA {
  return themeMode === "light" ? RGBA.fromInts(255, 255, 255, 0) : RGBA.fromInts(0, 0, 0, 0)
}

function getThemeBackgroundColor(themeName: ThemeName, themeMode: ThemeMode): string | RGBA {
  if (themeName === "transparent") {
    return getTransparentFallbackBackgroundColor(themeMode)
  }

  return THEMES[themeName].backgroundColor
}

function getHeaderText(themeName: ThemeName) {
  const theme = THEMES[themeName]

  return t`${bold(underline(fg(theme.headerAccent)("Interactive Alpha Transparency & Blending Demo - Drag the boxes!")))}
${fg(theme.headerMuted)(`Drag boxes with the mouse • Press B to cycle dark/light/transparent (current: ${theme.label})`)}`
}

class DraggableTransparentBox extends BoxRenderable {
  private isDragging = false
  private dragOffsetX = 0
  private dragOffsetY = 0
  private alphaPercentage: number
  private labelColor: RGBA

  constructor(
    ctx: RenderContext,
    id: string,
    x: number,
    y: number,
    width: number,
    height: number,
    bg: RGBA,
    zIndex: number,
  ) {
    super(ctx, {
      id,
      width,
      height,
      zIndex,
      backgroundColor: bg,
      position: "absolute",
      left: x,
      top: y,
    })
    this.alphaPercentage = Math.round(bg.a * 100)
    this.labelColor = THEMES.dark.boxLabelColor
  }

  public setLabelColor(color: RGBA): void {
    this.labelColor = color
  }

  protected renderSelf(buffer: OptimizedBuffer): void {
    super.renderSelf(buffer)

    const alphaText = `${this.alphaPercentage}%`
    const centerX = this.x + Math.floor(this.width / 2 - alphaText.length / 2)
    const centerY = this.y + Math.floor(this.height / 2)

    buffer.drawText(alphaText, centerX, centerY, this.labelColor)
  }

  protected onMouseEvent(event: MouseEvent): void {
    switch (event.type) {
      case "down":
        this.isDragging = true
        this.dragOffsetX = event.x - this.x
        this.dragOffsetY = event.y - this.y
        this.zIndex = nextZIndex++
        event.stopPropagation()
        break

      case "drag-end":
        if (this.isDragging) {
          this.isDragging = false
          event.stopPropagation()
        }
        break

      case "drag":
        if (this.isDragging) {
          const newX = event.x - this.dragOffsetX
          const newY = event.y - this.dragOffsetY

          this.x = Math.max(0, Math.min(newX, this._ctx.width - this.width))
          this.y = Math.max(4, Math.min(newY, this._ctx.height - this.height))

          event.stopPropagation()
        }
        break
    }
  }
}

export function run(renderer: CliRenderer): void {
  renderer.start()

  const currentRunVersion = ++demoRunVersion
  let currentTheme: ThemeName = "dark"
  let currentThemeMode: ThemeMode = renderer.themeMode ?? DEFAULT_THEME_MODE
  let transparentBackgroundColor = getTransparentFallbackBackgroundColor(currentThemeMode)
  let transparentPaletteRequestVersion = 0
  renderer.setBackgroundColor(getThemeBackgroundColor(currentTheme, currentThemeMode))

  const parentContainer = new BoxRenderable(renderer, {
    id: "parent-container",
    zIndex: 10,
  })
  renderer.root.add(parentContainer)

  const headerDisplay = new TextRenderable(renderer, {
    id: "header-text",
    content: getHeaderText(currentTheme),
    width: 85,
    height: 3,
    position: "absolute",
    left: 10,
    top: 2,
    zIndex: 1,
    selectable: false,
  })
  parentContainer.add(headerDisplay)

  const textUnderAlpha = new TextRenderable(renderer, {
    id: "text-under-alpha",
    content: "This text should not be selectable",
    position: "absolute",
    left: 10,
    top: 6,
    fg: THEMES[currentTheme].textUnderAlpha,
    attributes: TextAttributes.BOLD,
    zIndex: 4,
    selectable: false,
  })
  parentContainer.add(textUnderAlpha)

  const moreTextUnder = new TextRenderable(renderer, {
    id: "more-text-under",
    content: "Selectable text to show character preservation",
    position: "absolute",
    left: 15,
    top: 10,
    fg: THEMES[currentTheme].moreTextUnder,
    attributes: TextAttributes.BOLD,
    zIndex: 1,
  })
  parentContainer.add(moreTextUnder)

  const alphaBox50 = new DraggableTransparentBox(
    renderer,
    "alpha-box-50",
    15,
    5,
    25,
    8,
    RGBA.fromValues(64 / 255, 176 / 255, 255 / 255, 128 / 255),
    50,
  )
  parentContainer.add(alphaBox50)
  draggableBoxes.push(alphaBox50)

  const alphaBox75 = new DraggableTransparentBox(
    renderer,
    "alpha-box-75",
    30,
    7,
    25,
    8,
    RGBA.fromValues(255 / 255, 107 / 255, 129 / 255, 192 / 255),
    30,
  )
  parentContainer.add(alphaBox75)
  draggableBoxes.push(alphaBox75)

  const alphaBox25 = new DraggableTransparentBox(
    renderer,
    "alpha-box-25",
    45,
    9,
    25,
    8,
    RGBA.fromValues(139 / 255, 69 / 255, 193 / 255, 64 / 255),
    10,
  )
  parentContainer.add(alphaBox25)
  draggableBoxes.push(alphaBox25)

  const alphaGreen = new DraggableTransparentBox(
    renderer,
    "alpha-green",
    20,
    11,
    30,
    5,
    RGBA.fromValues(88 / 255, 214 / 255, 141 / 255, 96 / 255),
    20,
  )
  parentContainer.add(alphaGreen)
  draggableBoxes.push(alphaGreen)

  const alphaYellow = new DraggableTransparentBox(
    renderer,
    "alpha-yellow",
    25,
    13,
    20,
    6,
    RGBA.fromValues(255 / 255, 183 / 255, 77 / 255, 128 / 255),
    40,
  )
  parentContainer.add(alphaYellow)
  draggableBoxes.push(alphaYellow)

  const alphaOverlay = new DraggableTransparentBox(
    renderer,
    "alpha-overlay",
    10,
    17,
    65,
    4,
    RGBA.fromValues(200 / 255, 162 / 255, 255 / 255, 32 / 255),
    60,
  )
  parentContainer.add(alphaOverlay)
  draggableBoxes.push(alphaOverlay)

  const applyTheme = (themeName: ThemeName): void => {
    currentTheme = themeName

    const theme = THEMES[themeName]
    renderer.setBackgroundColor(themeName === "transparent" ? transparentBackgroundColor : theme.backgroundColor)
    headerDisplay.content = getHeaderText(themeName)
    textUnderAlpha.fg = theme.textUnderAlpha
    moreTextUnder.fg = theme.moreTextUnder

    for (const box of draggableBoxes) {
      box.setLabelColor(theme.boxLabelColor)
    }

    if (themeName === "transparent") {
      void updateTransparentBackgroundColor()
    }
  }

  const updateTransparentBackgroundColor = async (): Promise<void> => {
    const requestVersion = ++transparentPaletteRequestVersion
    transparentBackgroundColor = getTransparentFallbackBackgroundColor(currentThemeMode)

    if (currentTheme === "transparent") {
      renderer.setBackgroundColor(transparentBackgroundColor)
    }

    try {
      const palette = await renderer.getPalette()

      if (currentRunVersion !== demoRunVersion || requestVersion !== transparentPaletteRequestVersion) {
        return
      }

      if (palette.defaultBackground) {
        transparentBackgroundColor = RGBA.fromHex(palette.defaultBackground)
        transparentBackgroundColor.a = 0
      }
    } catch {
      if (currentRunVersion !== demoRunVersion || requestVersion !== transparentPaletteRequestVersion) {
        return
      }
    }

    if (currentTheme === "transparent") {
      renderer.setBackgroundColor(transparentBackgroundColor)
    }
  }

  applyTheme(currentTheme)

  if (keyListener) {
    renderer.keyInput.off("keypress", keyListener)
  }

  if (themeModeListener) {
    renderer.off("theme_mode", themeModeListener)
  }

  keyListener = (key: KeyEvent) => {
    if (key.name !== "b") {
      return
    }

    const currentThemeIndex = THEME_ORDER.indexOf(currentTheme)
    const nextTheme = THEME_ORDER[(currentThemeIndex + 1) % THEME_ORDER.length]
    applyTheme(nextTheme)
  }

  renderer.keyInput.on("keypress", keyListener)

  themeModeListener = (mode: ThemeMode) => {
    currentThemeMode = mode
    renderer.clearPaletteCache()

    if (currentTheme === "transparent") {
      void updateTransparentBackgroundColor()
    }
  }

  renderer.on("theme_mode", themeModeListener)
}

export function destroy(renderer: CliRenderer): void {
  demoRunVersion += 1
  renderer.clearFrameCallbacks()

  if (keyListener) {
    renderer.keyInput.off("keypress", keyListener)
    keyListener = null
  }

  if (themeModeListener) {
    renderer.off("theme_mode", themeModeListener)
    themeModeListener = null
  }

  for (const box of draggableBoxes) {
    box.destroyRecursively()
  }
  draggableBoxes = []

  const parentContainer = renderer.root.getRenderable("parent-container")
  parentContainer?.destroyRecursively()
  renderer.setCursorPosition(0, 0, false)
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  })

  run(renderer)
  setupCommonDemoKeys(renderer)
  renderer.start()
}
