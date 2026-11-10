#!/usr/bin/env bun
import { BoxRenderable, type CliRenderer, createCliRenderer, type KeyEvent, TextRenderable } from "../src/index.js"
import { parseColor } from "../src/lib/RGBA.js"

let renderer: CliRenderer | null = null
let titleText: TextRenderable | null = null
let themeText: TextRenderable | null = null
let statusText: TextRenderable | null = null
let eventCountText: TextRenderable | null = null
let firstDrawText: TextRenderable | null = null
let waitForThemeModeText: TextRenderable | null = null
let historyText: TextRenderable | null = null
let helpText: TextRenderable | null = null
let themeModeEventCount = 0
let firstDrawStartedAt = 0
let timeToFirstDrawMs: number | null = null
let waitForThemeModeStartedAt = 0
let waitForThemeModeResolvedMs: number | null = null
let waitForThemeModeResolvedValue: string | null = null
const updateThemeHistory: string[] = []

function stringifySequence(sequence: string): string {
  return JSON.stringify(sequence)
}

function classifyDebugSequence(sequence: string): string | null {
  if (sequence === "\x1b[?997;1n" || sequence === "\x1b[?997;2n") {
    return "csi-theme-notify"
  }

  if (sequence.startsWith("\x1bP")) {
    if (sequence.includes("\x1b]10;") || sequence.includes("\x1b]11;")) {
      return "dcs-theme-reply"
    }
    if (sequence.includes(">|tmux")) {
      return "dcs-xtversion"
    }
    return "dcs"
  }

  if (sequence.startsWith("\x1b]")) {
    if (sequence.includes("\x1b]10;") || sequence.includes("\x1b]11;")) {
      return "osc-theme-reply"
    }
    return "osc"
  }

  if (/^\x1b\[[0-9;]+R$/.test(sequence)) {
    return "cpr"
  }

  if (sequence.includes("$y")) {
    return "decrqm"
  }

  if (sequence.startsWith("\x1b[") && sequence.endsWith("c")) {
    return "device-attributes"
  }

  return null
}

function updateThemeDisplay() {
  if (!renderer || renderer.isDestroyed) return
  if (
    !titleText ||
    !themeText ||
    !statusText ||
    !eventCountText ||
    !firstDrawText ||
    !waitForThemeModeText ||
    !historyText ||
    !helpText
  )
    return

  const currentTheme = renderer.themeMode
  updateThemeHistory.push(`updateThemeDisplay ${updateThemeHistory.length + 1}: themeMode=${currentTheme ?? "null"}`)
  console.log("[theme-mode-debug] updateThemeDisplay", {
    themeMode: currentTheme,
    themeModeEventCount,
    timeToFirstDrawMs,
    waitForThemeModeResolvedMs,
    waitForThemeModeResolvedValue,
  })

  eventCountText.content = `theme_mode events: ${themeModeEventCount}`
  firstDrawText.content =
    timeToFirstDrawMs === null ? "time to first draw: pending" : `time to first draw: ${timeToFirstDrawMs.toFixed(1)}ms`
  waitForThemeModeText.content =
    waitForThemeModeResolvedMs === null
      ? "waitForThemeMode: pending"
      : `waitForThemeMode: ${waitForThemeModeResolvedMs.toFixed(1)}ms (resolved ${waitForThemeModeResolvedValue ?? "null"})`
  historyText.content = `updateThemeDisplay history:
${updateThemeHistory.join("\n")}`

  if (currentTheme === "dark") {
    titleText.fg = parseColor("#6BCF7F")
    themeText.content = "🌙 Dark Mode"
    themeText.fg = parseColor("#A5D6FF")
    statusText.content = "Terminal is in dark mode"
    statusText.fg = parseColor("#D7DBE0")
    eventCountText.fg = parseColor("#B8C0CC")
    firstDrawText.fg = parseColor("#B8C0CC")
    waitForThemeModeText.fg = parseColor("#B8C0CC")
    historyText.fg = parseColor("#B8C0CC")
    helpText.fg = parseColor("#8F9BA8")
    renderer.setBackgroundColor("#1a1a2e")
  } else if (currentTheme === "light") {
    titleText.fg = parseColor("#166534")
    themeText.content = "☀️ Light Mode"
    themeText.fg = parseColor("#C2410C")
    statusText.content = "Terminal is in light mode"
    statusText.fg = parseColor("#1F2937")
    eventCountText.fg = parseColor("#374151")
    firstDrawText.fg = parseColor("#374151")
    waitForThemeModeText.fg = parseColor("#374151")
    historyText.fg = parseColor("#374151")
    helpText.fg = parseColor("#4B5563")
    renderer.setBackgroundColor("#f5f5f0")
  } else {
    titleText.fg = parseColor("#6BCF7F")
    themeText.content = "❓ Unknown"
    themeText.fg = parseColor("#FFA500")
    statusText.content = "Theme mode not detected. Try switching your terminal theme."
    statusText.fg = parseColor("#D7DBE0")
    eventCountText.fg = parseColor("#B8C0CC")
    firstDrawText.fg = parseColor("#B8C0CC")
    waitForThemeModeText.fg = parseColor("#B8C0CC")
    historyText.fg = parseColor("#B8C0CC")
    helpText.fg = parseColor("#8F9BA8")
    renderer.setBackgroundColor("#2d2d2d")
  }
}

async function main() {
  firstDrawStartedAt = performance.now()
  console.log("[theme-mode-debug] starting", {
    tmux: process.env.TMUX ?? null,
    term: process.env.TERM ?? null,
    termProgram: process.env.TERM_PROGRAM ?? null,
    termProgramVersion: process.env.TERM_PROGRAM_VERSION ?? null,
  })

  renderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
    prependInputHandlers: [
      (sequence) => {
        const debugKind = classifyDebugSequence(sequence)
        if (debugKind) {
          console.log("[theme-mode-debug] input", {
            kind: debugKind,
            sequence: stringifySequence(sequence),
          })
        }
        return false
      },
    ],
  })

  console.log("[theme-mode-debug] renderer created", {
    initialThemeMode: renderer.themeMode,
    consoleMode: renderer.consoleMode,
  })

  const mainContainer = new BoxRenderable(renderer, {
    id: "main-container",
    flexGrow: 1,
    flexDirection: "column",
    padding: 2,
  })

  renderer.root.add(mainContainer)

  titleText = new TextRenderable(renderer, {
    id: "title",
    content: "Theme Mode Monitor",
    bold: true,
    fg: parseColor("#6BCF7F"),
    marginBottom: 2,
  })

  themeText = new TextRenderable(renderer, {
    id: "theme-display",
    content: "Detecting...",
    bold: true,
    marginBottom: 1,
  })

  statusText = new TextRenderable(renderer, {
    id: "status",
    content: "Waiting for theme detection...",
    marginBottom: 2,
  })

  eventCountText = new TextRenderable(renderer, {
    id: "event-count",
    content: "theme_mode events: 0",
    marginBottom: 2,
  })

  firstDrawText = new TextRenderable(renderer, {
    id: "first-draw",
    content: "time to first draw: pending",
    marginBottom: 2,
  })

  waitForThemeModeText = new TextRenderable(renderer, {
    id: "wait-for-theme-mode",
    content: "waitForThemeMode: pending",
    marginBottom: 2,
  })

  historyText = new TextRenderable(renderer, {
    id: "history",
    content: "updateThemeDisplay history:\n(none)",
    marginBottom: 2,
  })

  helpText = new TextRenderable(renderer, {
    id: "help",
    content:
      "Press ` to toggle the renderer console. Press Ctrl+C to exit. Try switching your terminal's light/dark theme to see updates.",
    fg: parseColor("#888888"),
  })

  mainContainer.add(titleText)
  mainContainer.add(themeText)
  mainContainer.add(statusText)
  mainContainer.add(eventCountText)
  mainContainer.add(firstDrawText)
  mainContainer.add(waitForThemeModeText)
  mainContainer.add(historyText)
  mainContainer.add(helpText)

  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.name === "`" || key.name === '"') {
      console.log("[theme-mode-debug] toggling console", {
        key: key.name,
        ctrl: key.ctrl,
        meta: key.meta,
        shift: key.shift,
      })
      renderer?.console.toggle()
    }
  })

  // Listen for theme mode changes from the terminal
  renderer.on("theme_mode", () => {
    themeModeEventCount++
    console.log("[theme-mode-debug] theme_mode event", {
      count: themeModeEventCount,
      themeMode: renderer?.themeMode ?? null,
    })
    updateThemeDisplay()
  })

  waitForThemeModeStartedAt = performance.now()
  console.log("[theme-mode-debug] waiting for theme mode")
  const resolvedThemeMode = await renderer.waitForThemeMode()
  waitForThemeModeResolvedMs = performance.now() - waitForThemeModeStartedAt
  waitForThemeModeResolvedValue = resolvedThemeMode
  console.log("[theme-mode-debug] waitForThemeMode resolved", {
    resolvedThemeMode,
    waitForThemeModeResolvedMs,
  })

  updateThemeDisplay()

  const handleFirstDraw = async () => {
    if (!renderer || !firstDrawText || timeToFirstDrawMs !== null) {
      return
    }

    timeToFirstDrawMs = performance.now() - firstDrawStartedAt
    console.log("[theme-mode-debug] first draw", { timeToFirstDrawMs })
    renderer.removeFrameCallback(handleFirstDraw)
    updateThemeDisplay()
  }

  renderer.setFrameCallback(handleFirstDraw)

  renderer.requestRender()
}

main().catch((err) => {
  console.error("Error:", err)
  process.exit(1)
})
