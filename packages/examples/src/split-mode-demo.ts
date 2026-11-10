import {
  BoxRenderable,
  CliRenderEvents,
  TextRenderable,
  TextareaRenderable,
  createCliRenderer,
  type CliRenderer,
  type KeyEvent,
  type ScrollbackRenderContext,
  type ScrollbackSnapshot,
  type ScrollbackWriter,
  type ThemeMode,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

const DEFAULT_FOOTER_HEIGHT = 11
const MIN_FOOTER_HEIGHT = 8
const MIN_MAIN_SCREEN_HEIGHT = 5

const DEFAULT_STREAM_INTERVAL = 1600
const MIN_STREAM_INTERVAL = 180
const MAX_STREAM_INTERVAL = 2000
const STREAM_INTERVAL_STEP = 80
const CTRL_R_HOLD_REPEAT_MS = 45
const CTRL_R_HOLD_DURATION_MS = 1400
const CTRL_R_HOLD_BOOT_DELAY_MS = 600
// Stress-mode helpers are opt-in by default. This keeps the example usable for
// interactive/manual checks while still allowing scripted flicker repro loops.
const DEFAULT_AUTO_EXIT_MS = 0

const AUTO_CTRL_R_HOLD_ON_BOOT =
  process.env.OTUI_SPLIT_DEMO_AUTO_CTRL_R_HOLD === "1" ||
  process.env.OTUI_SPLIT_DEMO_AUTO_CTRL_R_HOLD?.toLowerCase() === "true"
const AUTO_EXIT_ENV = Number.parseInt(process.env.OTUI_SPLIT_DEMO_AUTO_EXIT_MS ?? "", 10)
const AUTO_EXIT_MS = Number.isFinite(AUTO_EXIT_ENV) && AUTO_EXIT_ENV > 0 ? AUTO_EXIT_ENV : DEFAULT_AUTO_EXIT_MS

interface WallLyricPassage {
  song: string
  lines: string[]
}

const WALL_STREAM_PASSAGES: WallLyricPassage[] = [
  {
    song: "In the Flesh?",
    lines: [
      "So ya thought ya might like to go to the show",
      "To feel the warm thrill of confusion",
      "That space cadet glow",
    ],
  },
  {
    song: "Another Brick in the Wall (Part 2)",
    lines: [
      "We don't need no education",
      "We don't need no thought control",
      "No dark sarcasm in the classroom",
      "Teacher leave us kids alone",
    ],
  },
  {
    song: "Mother",
    lines: [
      "Mother should I build the wall",
      "Mother should I trust the government",
      "Mother will they put me in the firing line",
      "Oooh is it just a waste of time",
    ],
  },
  {
    song: "Hey You",
    lines: [
      "Hey you! out there in the cold",
      "getting lonely, getting old, can you feel me",
      "Hey you! with your ears against the wall",
      "Waiting for someone to call out would you touch me",
      "Together we stand, divided we fall",
    ],
  },
  {
    song: "Nobody Home",
    lines: [
      "I've got a little black book with my poems in",
      "I've got thirteen channels on the TV to choose from",
      "When I try to get through on the telephone to you there'll be nobody home",
      "Ooooh Babe when I pick up the phone",
      "There's still nobody home",
    ],
  },
  {
    song: "Comfortably Numb",
    lines: [
      "Hello, is there anybody in there",
      "just nod if you can hear me",
      "There is no pain, you are receding",
      "The child is grown",
      "The dream is gone",
      "And I have become comfortably numb",
    ],
  },
  {
    song: "Outside the Wall",
    lines: [
      "All alone, or in twos",
      "The ones who really love you walk up and down outside the wall",
      "And when they've given you their all",
      "Some stagger and fall after all it's not easy",
      "Banging your heart against some mad bugger's wall",
    ],
  },
]

const WALL_ASSISTANT_LINES = [
  "Hello, is there anybody in there\njust nod if you can hear me",
  "Hey you! with your ears against the wall",
  "The show must go on",
  "All in all you're just another brick in the wall",
  "All alone, or in twos",
]

type DemoMode = "split-footer" | "fullscreen"
type MessageRole = "user" | "assistant" | "system" | "stream"

interface DemoPalette {
  appBackground: string
  shellBackground: string
  shellBorder: string
  titleText: string
  modeText: string
  helpText: string
  statusText: string
  streamHeadingText: string
  streamText: string
  composerBorder: string
  composerBackground: string
  composerHint: string
  inputPlaceholder: string
  inputText: string
  inputFocusedText: string
  inputFocusedBackground: string
  inputCursor: string
  controlText: string
  messageText: string
  userBorder: string
  assistantBorder: string
  systemBorder: string
  streamBorder: string
}

const DARK_PALETTE: DemoPalette = {
  appBackground: "#0A1222",
  shellBackground: "#0F1F39",
  shellBorder: "#4C6D94",
  titleText: "#F6FAFF",
  modeText: "#A7D4FF",
  helpText: "#C3D9F0",
  statusText: "#D5E7FA",
  streamHeadingText: "#66CCFF",
  streamText: "#CBE9FF",
  composerBorder: "#6A89AD",
  composerBackground: "#112642",
  composerHint: "#8CB6DF",
  inputPlaceholder: "#5F7FA0",
  inputText: "#E7F2FF",
  inputFocusedText: "#FFFFFF",
  inputFocusedBackground: "#153153",
  inputCursor: "#FFFFFF",
  controlText: "#A5C9EC",
  messageText: "#EDF6FF",
  userBorder: "#68C79E",
  assistantBorder: "#78A8DA",
  systemBorder: "#D9A568",
  streamBorder: "#4FB8F5",
}

const LIGHT_PALETTE: DemoPalette = {
  appBackground: "#EEF4FB",
  shellBackground: "#FBFDFF",
  shellBorder: "#90A8C1",
  titleText: "#17324F",
  modeText: "#245D93",
  helpText: "#395B7D",
  statusText: "#23435F",
  streamHeadingText: "#1F5F97",
  streamText: "#2D5D87",
  composerBorder: "#A5B8CB",
  composerBackground: "#FFFFFF",
  composerHint: "#4B6784",
  inputPlaceholder: "#7A93AB",
  inputText: "#1A334D",
  inputFocusedText: "#13293F",
  inputFocusedBackground: "#F3F8FF",
  inputCursor: "#1B3550",
  controlText: "#4A6481",
  messageText: "#19334F",
  userBorder: "#1F9968",
  assistantBorder: "#356FA8",
  systemBorder: "#B37F2D",
  streamBorder: "#2E73AF",
}

function resolveDemoPalette(themeMode: ThemeMode | null): DemoPalette {
  return themeMode === "light" ? LIGHT_PALETTE : DARK_PALETTE
}

interface BoxMessageEntry {
  role: MessageRole
  text: string
  timestamp: Date
  palette: DemoPalette
}

let snapshotNodeCounter = 0

function formatTimestamp(timestamp: Date): string {
  const hh = timestamp.getHours().toString().padStart(2, "0")
  const mm = timestamp.getMinutes().toString().padStart(2, "0")
  const ss = timestamp.getSeconds().toString().padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}

function truncateToWidth(text: string, width: number): string {
  if (width <= 0) {
    return ""
  }

  if (text.length <= width) {
    return text
  }

  if (width <= 3) {
    return text.slice(0, width)
  }

  return `${text.slice(0, width - 3)}...`
}

function splitLongToken(token: string, width: number): string[] {
  const clampedWidth = Math.max(1, width)
  const segments: string[] = []

  for (let offset = 0; offset < token.length; offset += clampedWidth) {
    segments.push(token.slice(offset, offset + clampedWidth))
  }

  return segments
}

function wrapText(text: string, width: number): string[] {
  const clampedWidth = Math.max(1, width)
  const normalized = text.replace(/\r/g, "")
  const paragraphs = normalized.split("\n")
  const wrapped: string[] = []

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      wrapped.push("")
      continue
    }

    const words = paragraph.split(/\s+/)
    let current = ""

    for (const word of words) {
      if (word.length === 0) {
        continue
      }

      if (current.length === 0) {
        if (word.length <= clampedWidth) {
          current = word
        } else {
          const segments = splitLongToken(word, clampedWidth)
          current = segments.pop() ?? ""
          wrapped.push(...segments)
        }
        continue
      }

      const candidate = `${current} ${word}`
      if (candidate.length <= clampedWidth) {
        current = candidate
        continue
      }

      wrapped.push(current)

      if (word.length <= clampedWidth) {
        current = word
      } else {
        const segments = splitLongToken(word, clampedWidth)
        current = segments.pop() ?? ""
        wrapped.push(...segments)
      }
    }

    wrapped.push(current)
  }

  return wrapped.length > 0 ? wrapped : [""]
}

function roleBorderColor(role: MessageRole, palette: DemoPalette): string {
  switch (role) {
    case "user":
      return palette.userBorder
    case "assistant":
      return palette.assistantBorder
    case "system":
      return palette.systemBorder
    case "stream":
      return palette.streamBorder
  }
}

function roleLabel(role: MessageRole): string {
  switch (role) {
    case "user":
      return "YOU"
    case "assistant":
      return "ASSISTANT"
    case "system":
      return "SYSTEM"
    case "stream":
      return "STREAM LIVE"
  }
}

function roleHeadingColor(role: MessageRole, palette: DemoPalette): string {
  switch (role) {
    case "user":
      return palette.userBorder
    case "assistant":
      return palette.assistantBorder
    case "system":
      return palette.systemBorder
    case "stream":
      return palette.streamHeadingText
  }
}

function roleHeadingAttributes(role: MessageRole): number {
  if (role === "stream") {
    return 5
  }

  return 1
}

function roleBodyColor(role: MessageRole, palette: DemoPalette): string {
  switch (role) {
    case "system":
      return palette.helpText
    case "stream":
      return palette.streamText
    default:
      return palette.messageText
  }
}

function buildSimpleTextBoxSnapshot(entry: BoxMessageEntry, ctx: ScrollbackRenderContext): ScrollbackSnapshot {
  const maxTextWidth = Math.max(18, Math.min(ctx.width - 4, 90))
  const headingCore = truncateToWidth(
    `${roleLabel(entry.role)} | ${formatTimestamp(entry.timestamp)}`,
    Math.max(1, maxTextWidth - 2),
  )
  const headingLine = ` ${headingCore}`
  const bodyIndent = entry.role === "stream" ? " > " : " "
  const bodyWrapWidth = Math.max(1, maxTextWidth - bodyIndent.length)
  const bodyLines = wrapText(entry.text, bodyWrapWidth).map((line) => `${bodyIndent}${line}`)
  const longestBody = bodyLines.reduce((maxWidth, line) => Math.max(maxWidth, line.length), 1)
  const longestLine = Math.max(headingLine.length, longestBody)

  const textWidth = Math.min(maxTextWidth, Math.max(2, longestLine + 1))
  const boxWidth = Math.min(ctx.width, Math.max(4, textWidth + 1))
  const boxHeight = Math.max(4, bodyLines.length + 3)

  const box = new BoxRenderable(ctx.renderContext, {
    id: `split-simple-box-${snapshotNodeCounter++}`,
    position: "absolute",
    left: 0,
    top: 0,
    width: boxWidth,
    height: boxHeight,
    border: ["left"],
    borderStyle: "double",
    borderColor: roleBorderColor(entry.role, entry.palette),
    backgroundColor: "transparent",
  })

  const headingText = new TextRenderable(ctx.renderContext, {
    id: `split-simple-heading-${snapshotNodeCounter++}`,
    position: "absolute",
    left: 1,
    top: 1,
    width: Math.max(1, boxWidth - 1),
    height: 1,
    content: headingLine,
    fg: roleHeadingColor(entry.role, entry.palette),
    attributes: roleHeadingAttributes(entry.role),
  })

  const bodyText = new TextRenderable(ctx.renderContext, {
    id: `split-simple-body-${snapshotNodeCounter++}`,
    position: "absolute",
    left: 1,
    top: 2,
    width: Math.max(1, boxWidth - 1),
    height: Math.max(1, boxHeight - 3),
    content: bodyLines.join("\n"),
    fg: roleBodyColor(entry.role, entry.palette),
  })

  box.add(headingText)
  box.add(bodyText)

  return {
    root: box,
    width: boxWidth,
    height: boxHeight,
  }
}

class SplitFooterDemo {
  private shell: BoxRenderable
  private headerRow: BoxRenderable
  private titleText: TextRenderable
  private modeText: TextRenderable
  private composerBox: BoxRenderable
  private composer: TextareaRenderable
  private statusRow: BoxRenderable
  private statusText: TextRenderable
  private metaText: TextRenderable
  private controlsRow: BoxRenderable
  private controlsText: TextRenderable

  private palette: DemoPalette
  private mode: DemoMode = "split-footer"
  private desiredFooterHeight = DEFAULT_FOOTER_HEIGHT
  private pendingAssistantReply: ReturnType<typeof setTimeout> | null = null
  private streamTimer: ReturnType<typeof setInterval> | null = null
  private ctrlRHoldTimer: ReturnType<typeof setInterval> | null = null
  private ctrlRBootTimer: ReturnType<typeof setTimeout> | null = null
  private ctrlRHoldDeadlineMs = 0
  private streamEnabled = true
  private streamIntervalMs = DEFAULT_STREAM_INTERVAL
  private streamCount = 0
  private commitCount = 0
  private messageCount = 0
  private assistantTyping = false
  private statusMessage = "Ready"
  private destroyed = false

  constructor(private renderer: CliRenderer) {
    this.palette = resolveDemoPalette(this.renderer.themeMode)
    this.desiredFooterHeight = this.clampFooterHeight(this.desiredFooterHeight)

    if (this.renderer.screenMode !== "split-footer") {
      this.renderer.screenMode = "split-footer"
    }

    this.renderer.footerHeight = this.desiredFooterHeight

    if (this.renderer.externalOutputMode !== "capture-stdout") {
      this.renderer.externalOutputMode = "capture-stdout"
    }

    this.mode = "split-footer"
    this.renderer.setBackgroundColor(this.palette.appBackground)

    this.shell = new BoxRenderable(this.renderer, {
      id: "split-footer-shell",
      width: "100%",
      height: "100%",
      border: false,
      backgroundColor: this.palette.shellBackground,
      padding: 0,
      gap: 0,
      flexDirection: "column",
      zIndex: 10,
    })

    this.headerRow = new BoxRenderable(this.renderer, {
      id: "split-footer-header-row",
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    })

    this.titleText = new TextRenderable(this.renderer, {
      id: "split-footer-title",
      content: "Split Footer Demo",
      fg: this.palette.titleText,
    })

    this.modeText = new TextRenderable(this.renderer, {
      id: "split-footer-mode",
      content: "",
      fg: this.palette.modeText,
    })

    this.composerBox = new BoxRenderable(this.renderer, {
      id: "split-footer-composer-frame",
      width: "100%",
      minHeight: 4,
      flexGrow: 1,
      border: false,
      backgroundColor: this.palette.composerBackground,
      padding: 0,
      gap: 0,
      flexDirection: "column",
    })

    this.composer = new TextareaRenderable(this.renderer, {
      id: "split-footer-composer",
      width: "100%",
      minHeight: 3,
      flexGrow: 1,
      wrapMode: "word",
      showCursor: true,
      placeholder: "Type message or /command... (Enter = new line, Ctrl+Enter = send)",
      placeholderColor: this.palette.inputPlaceholder,
      textColor: this.palette.inputText,
      focusedTextColor: this.palette.inputFocusedText,
      backgroundColor: this.palette.composerBackground,
      focusedBackgroundColor: this.palette.inputFocusedBackground,
      cursorColor: this.palette.inputCursor,
      onSubmit: this.handleComposerSubmit,
      keyBindings: [
        { name: "return", ctrl: true, action: "submit" },
        { name: "linefeed", ctrl: true, action: "submit" },
      ],
    })

    this.statusRow = new BoxRenderable(this.renderer, {
      id: "split-footer-status-row",
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    })

    this.statusText = new TextRenderable(this.renderer, {
      id: "split-footer-status",
      content: "",
      fg: this.palette.statusText,
    })

    this.metaText = new TextRenderable(this.renderer, {
      id: "split-footer-meta",
      content: "",
      fg: this.palette.streamText,
    })

    this.controlsRow = new BoxRenderable(this.renderer, {
      id: "split-footer-controls-row",
      width: "100%",
      height: 1,
      flexDirection: "row",
      justifyContent: "flex-start",
      alignItems: "center",
    })

    this.controlsText = new TextRenderable(this.renderer, {
      id: "split-footer-controls",
      content: "",
      width: "100%",
      height: 1,
      fg: this.palette.controlText,
    })

    this.headerRow.add(this.titleText)
    this.headerRow.add(this.modeText)

    this.composerBox.add(this.composer)

    this.statusRow.add(this.statusText)
    this.statusRow.add(this.metaText)

    this.controlsRow.add(this.controlsText)

    this.shell.add(this.headerRow)
    this.shell.add(this.composerBox)
    this.shell.add(this.statusRow)
    this.shell.add(this.controlsRow)
    this.renderer.root.add(this.shell)

    this.composer.on("line-info-change", this.handleDraftChanged)
    this.renderer.keyInput.on("keypress", this.handleKeyPress)
    this.renderer.on("resize", this.handleResize)
    this.renderer.on(CliRenderEvents.THEME_MODE, this.handleThemeMode)
    this.renderer.on(CliRenderEvents.DESTROY, this.handleRendererDestroy)

    this.applyPalette()
    this.refreshStatus("ready")
    this.publishWelcomeMessages()
    if (AUTO_CTRL_R_HOLD_ON_BOOT) {
      this.scheduleCtrlRHoldBootSimulation()
    }
    this.syncStreamLoop()
    this.composer.focus()
  }

  private get draftLength(): number {
    if (this.destroyed || this.composer.isDestroyed) {
      return 0
    }

    return this.composer.plainText.length
  }

  private isSplitCaptureMode(): boolean {
    return this.renderer.screenMode === "split-footer" && this.renderer.externalOutputMode === "capture-stdout"
  }

  private clampFooterHeight(requestedHeight: number): number {
    const maxFooterHeight = Math.max(1, this.renderer.terminalHeight - MIN_MAIN_SCREEN_HEIGHT)
    const minFooterHeight = Math.min(MIN_FOOTER_HEIGHT, maxFooterHeight)
    return Math.min(Math.max(requestedHeight, minFooterHeight), maxFooterHeight)
  }

  private applyPalette(): void {
    this.renderer.setBackgroundColor(this.palette.appBackground)
    this.shell.backgroundColor = this.palette.shellBackground
    this.shell.borderColor = this.palette.shellBorder
    this.titleText.fg = this.palette.titleText
    this.modeText.fg = this.palette.modeText
    this.statusText.fg = this.palette.statusText
    this.metaText.fg = this.palette.streamText
    this.composerBox.borderColor = this.palette.composerBorder
    this.composerBox.backgroundColor = this.palette.composerBackground
    this.composer.placeholderColor = this.palette.inputPlaceholder
    this.composer.textColor = this.palette.inputText
    this.composer.focusedTextColor = this.palette.inputFocusedText
    this.composer.backgroundColor = this.palette.composerBackground
    this.composer.focusedBackgroundColor = this.palette.inputFocusedBackground
    this.composer.cursorColor = this.palette.inputCursor
    this.controlsText.fg = this.palette.controlText
  }

  private refreshStatus(message?: string): void {
    if (this.destroyed) {
      return
    }

    if (message) {
      this.statusMessage = message
    }

    const modeLabel = this.mode === "split-footer" ? `split:${this.renderer.footerHeight}` : "fullscreen"
    const streamLabel = this.streamEnabled ? `${this.streamIntervalMs}ms` : "off"
    const mouseLabel = this.renderer.useMouse ? "mouse:on" : "mouse:off"
    const typingLabel = this.assistantTyping ? "typing" : "idle"

    this.modeText.content = modeLabel
    this.statusText.content = `msg ${this.messageCount} draft ${this.draftLength} ${typingLabel} | ${this.statusMessage}`
    this.metaText.content = `${mouseLabel} stream:${streamLabel} commits:${this.commitCount} lines:${this.streamCount}`
    this.controlsText.content =
      "Ctrl+Enter send · Enter newline · Shift+U mouse · Ctrl+S stream · Ctrl+0 mode · Ctrl+R hold-demo · /help"
  }

  private activateSplitFooterMode(announce: boolean = true): void {
    this.desiredFooterHeight = this.clampFooterHeight(this.desiredFooterHeight)

    if (this.renderer.screenMode !== "split-footer") {
      this.renderer.screenMode = "split-footer"
    }

    this.renderer.footerHeight = this.desiredFooterHeight

    if (this.renderer.externalOutputMode !== "capture-stdout") {
      this.renderer.externalOutputMode = "capture-stdout"
    }

    this.mode = "split-footer"
    this.syncStreamLoop()
    this.refreshStatus("split-footer mode")

    if (announce) {
      this.publishMessage(
        "system",
        `Switched to split-footer mode (height ${this.renderer.footerHeight}). Stream capture is active.`,
        false,
      )
    }
  }

  private activateFullscreenMode(): void {
    if (this.renderer.externalOutputMode !== "passthrough") {
      this.renderer.externalOutputMode = "passthrough"
    }

    if (this.renderer.screenMode !== "main-screen") {
      this.renderer.screenMode = "main-screen"
    }

    this.mode = "fullscreen"
    this.syncStreamLoop()
    this.refreshStatus("fullscreen mode")
  }

  private toggleMode(): void {
    if (this.mode === "split-footer") {
      this.activateFullscreenMode()
    } else {
      this.activateSplitFooterMode(true)
    }
  }

  private enqueueScrollback(write: ScrollbackWriter, failureStatus: string): void {
    if (!this.isSplitCaptureMode()) {
      this.refreshStatus("output paused in fullscreen")
      return
    }

    if (this.destroyed || !this.isSplitCaptureMode()) {
      return
    }

    try {
      this.renderer.writeToScrollback(write)

      if (this.destroyed) {
        return
      }

      this.commitCount += 1
      this.refreshStatus()
    } catch (error) {
      if (!this.destroyed) {
        this.refreshStatus(failureStatus)
        console.error("split-mode-demo publish failed", error)
      }
    }
  }

  private publishMessage(role: MessageRole, text: string, countAsMessage: boolean = true): void {
    if (countAsMessage) {
      this.messageCount += 1
    }

    const paletteSnapshot: DemoPalette = { ...this.palette }

    this.enqueueScrollback(
      (ctx) =>
        buildSimpleTextBoxSnapshot(
          {
            role,
            text,
            timestamp: new Date(),
            palette: paletteSnapshot,
          },
          ctx,
        ),
      "failed to publish text box",
    )
  }

  private getPassage(index: number): WallLyricPassage {
    const total = WALL_STREAM_PASSAGES.length
    const safeIndex = ((index % total) + total) % total
    return WALL_STREAM_PASSAGES[safeIndex]!
  }

  private passageText(passage: WallLyricPassage): string {
    return `${passage.song}\n${passage.lines.join("\n")}`
  }

  private publishWelcomeMessages(): void {
    this.publishMessage(
      "system",
      `Lyric cue pack loaded. Width ${this.renderer.width}. Use /demo for a guided mini medley.`,
      false,
    )

    this.publishMessage("system", "Stream mode rotates through a short ordered setlist.", false)
  }

  private syncStreamLoop(): void {
    const shouldRun = this.streamEnabled && this.isSplitCaptureMode() && !this.destroyed

    if (!shouldRun) {
      if (this.streamTimer) {
        clearInterval(this.streamTimer)
        this.streamTimer = null
      }
      return
    }

    if (this.streamTimer) {
      return
    }

    this.streamTimer = setInterval(this.emitStreamTick, this.streamIntervalMs)
  }

  private setStreamEnabled(enabled: boolean): void {
    this.streamEnabled = enabled
    if (!enabled && this.streamTimer) {
      clearInterval(this.streamTimer)
      this.streamTimer = null
    }
    if (enabled) {
      this.syncStreamLoop()
    }
    this.refreshStatus(`stream ${enabled ? "enabled" : "disabled"}`)
  }

  private setStreamInterval(requestedInterval: number): void {
    const clampedInterval = Math.min(Math.max(requestedInterval, MIN_STREAM_INTERVAL), MAX_STREAM_INTERVAL)
    if (clampedInterval === this.streamIntervalMs) {
      this.refreshStatus("stream speed unchanged")
      return
    }

    this.streamIntervalMs = clampedInterval

    if (this.streamTimer) {
      clearInterval(this.streamTimer)
      this.streamTimer = null
    }

    this.syncStreamLoop()
    this.refreshStatus(`stream interval ${clampedInterval}ms`)
  }

  private emitStreamTick = (): void => {
    if (this.destroyed || !this.streamEnabled || !this.isSplitCaptureMode()) {
      return
    }

    const nextPassage = this.getPassage(this.streamCount)
    this.streamCount += 1
    this.publishMessage("stream", this.passageText(nextPassage), false)
    this.refreshStatus()
  }

  private publishCommandHelp(): void {
    this.publishMessage(
      "system",
      [
        "Commands:",
        "/help - show this command guide",
        "/demo - append a compact lyric medley",
        "/mouse on|off|toggle - toggle mouse handling",
        "/stream on|off|toggle - control stream output",
        "/speed <ms> - set stream interval",
        "/mode split|full|toggle - switch split/footer mode",
        "/footer <n> - set split footer height",
        "keys: Ctrl+Enter send, Enter newline, Shift+U mouse, Ctrl+S stream, Ctrl+R held demo burst",
      ].join("\n"),
      false,
    )
  }

  private publishDemoTranscript(): void {
    const medleySequence = [0, 1, 2, 3, 4, 5, 6]

    this.publishMessage("system", "Mini medley:", false)
    medleySequence.forEach((index) => {
      this.publishMessage("assistant", this.passageText(this.getPassage(index)))
    })

    this.publishMessage(
      "system",
      "All alone, or in twos, the ones who really love you walk up and down outside the wall.",
      false,
    )
    this.refreshStatus("demo transcript queued")
  }

  private scheduleCtrlRHoldBootSimulation(): void {
    if (this.ctrlRBootTimer || this.destroyed) {
      return
    }

    this.ctrlRBootTimer = setTimeout(() => {
      this.ctrlRBootTimer = null
      if (this.destroyed) {
        return
      }

      this.startCtrlRHoldSimulation(CTRL_R_HOLD_DURATION_MS)
    }, CTRL_R_HOLD_BOOT_DELAY_MS)
  }

  private runCtrlRHoldTick = (): void => {
    if (this.destroyed || !this.isSplitCaptureMode()) {
      this.stopCtrlRHoldSimulation(false)
      return
    }

    if (Date.now() >= this.ctrlRHoldDeadlineMs) {
      this.stopCtrlRHoldSimulation(true)
      return
    }

    this.publishDemoTranscript()
  }

  private startCtrlRHoldSimulation(durationMs: number = CTRL_R_HOLD_DURATION_MS): void {
    if (this.destroyed || !this.isSplitCaptureMode()) {
      return
    }

    this.ctrlRHoldDeadlineMs = Math.max(this.ctrlRHoldDeadlineMs, Date.now() + durationMs)

    if (this.ctrlRHoldTimer) {
      return
    }

    this.publishDemoTranscript()
    this.ctrlRHoldTimer = setInterval(this.runCtrlRHoldTick, CTRL_R_HOLD_REPEAT_MS)
    this.refreshStatus("simulating Ctrl+R hold")
  }

  private stopCtrlRHoldSimulation(announceDone: boolean): void {
    if (this.ctrlRHoldTimer) {
      clearInterval(this.ctrlRHoldTimer)
      this.ctrlRHoldTimer = null
    }

    this.ctrlRHoldDeadlineMs = 0

    if (!announceDone || this.destroyed) {
      return
    }

    this.refreshStatus("Ctrl+R hold simulation complete")
  }

  private handleCommand(commandLine: string): void {
    const [command, ...args] = commandLine.trim().split(/\s+/)

    switch (command.toLowerCase()) {
      case "/help": {
        this.publishCommandHelp()
        this.refreshStatus("help published")
        return
      }

      case "/demo": {
        this.publishDemoTranscript()
        return
      }

      case "/mouse": {
        const option = (args[0] ?? "toggle").toLowerCase()

        if (option === "on") {
          this.renderer.useMouse = true
        } else if (option === "off") {
          this.renderer.useMouse = false
        } else {
          this.renderer.useMouse = !this.renderer.useMouse
        }

        this.refreshStatus(`mouse ${this.renderer.useMouse ? "enabled" : "disabled"}`)
        return
      }

      case "/stream": {
        const option = (args[0] ?? "toggle").toLowerCase()
        if (option === "on") {
          this.setStreamEnabled(true)
        } else if (option === "off") {
          this.setStreamEnabled(false)
        } else {
          this.setStreamEnabled(!this.streamEnabled)
        }
        return
      }

      case "/speed": {
        if (args.length === 0) {
          this.publishMessage("system", `Current stream interval is ${this.streamIntervalMs}ms.`, false)
          return
        }

        const requested = Number.parseInt(args[0], 10)
        if (!Number.isFinite(requested)) {
          this.publishMessage("system", `Invalid speed value: ${args[0]}`, false)
          this.refreshStatus("invalid speed value")
          return
        }

        this.setStreamInterval(requested)
        return
      }

      case "/mode": {
        const option = (args[0] ?? "toggle").toLowerCase()
        if (option === "split" || option === "footer") {
          this.activateSplitFooterMode(true)
        } else if (option === "full" || option === "fullscreen" || option === "main") {
          this.activateFullscreenMode()
        } else {
          this.toggleMode()
        }
        return
      }

      case "/footer": {
        if (args.length === 0) {
          this.publishMessage("system", "usage: /footer <height>", false)
          return
        }

        const requested = Number.parseInt(args[0], 10)
        if (!Number.isFinite(requested)) {
          this.publishMessage("system", `Invalid footer height: ${args[0]}`, false)
          this.refreshStatus("invalid footer height")
          return
        }

        this.desiredFooterHeight = this.clampFooterHeight(requested)
        if (this.mode === "split-footer") {
          this.renderer.footerHeight = this.desiredFooterHeight
          this.publishMessage("system", `footer height set to ${this.desiredFooterHeight}`, false)
        }
        this.refreshStatus(`footer target ${this.desiredFooterHeight}`)
        return
      }

      default: {
        this.publishMessage("system", `Unknown command: ${command}`, false)
        this.refreshStatus("unknown command")
      }
    }
  }

  private handleComposerSubmit = (): void => {
    const value = this.composer.plainText
    const trimmed = value.trim()

    if (trimmed.length === 0) {
      this.refreshStatus("empty draft ignored")
      return
    }

    this.composer.setText("")
    this.composer.focus()

    if (trimmed.startsWith("/")) {
      this.handleCommand(trimmed)
      return
    }

    this.publishMessage("user", trimmed)
    this.scheduleAssistantReply(trimmed)
  }

  private scheduleAssistantReply(userText: string): void {
    if (this.pendingAssistantReply) {
      clearTimeout(this.pendingAssistantReply)
      this.pendingAssistantReply = null
    }

    this.assistantTyping = true
    this.refreshStatus("assistant composing")

    const delayMs = Math.min(1100, 250 + userText.length * 10)
    this.pendingAssistantReply = setTimeout(() => {
      this.pendingAssistantReply = null
      if (this.destroyed) {
        return
      }

      this.publishMessage("assistant", this.buildAssistantReply(userText))
      this.assistantTyping = false
      this.refreshStatus("assistant reply queued")
    }, delayMs)
  }

  private buildAssistantReply(userText: string): string {
    const normalized = userText.toLowerCase()

    if (normalized.includes("wall")) {
      return "All in all you're just another brick in the wall"
    }

    if (normalized.includes("home")) {
      return "Open your heart, I'm coming home"
    }

    if (normalized.includes("show")) {
      return "The show must go on"
    }

    if (normalized.includes("hello") || normalized.includes("anybody")) {
      return "Hello, is there anybody in there"
    }

    if (normalized.includes("goodbye")) {
      return "Goodbye cruel world, I'm leaving you today"
    }

    if (normalized.includes("more") || normalized.includes("next")) {
      return this.passageText(this.getPassage(this.streamCount))
    }

    return WALL_ASSISTANT_LINES[(this.messageCount + userText.length) % WALL_ASSISTANT_LINES.length]!
  }

  private adjustFooterHeight(delta: number): void {
    if (this.mode !== "split-footer") {
      this.refreshStatus("footer height can only change in split mode")
      return
    }

    const nextHeight = this.clampFooterHeight(this.renderer.footerHeight + delta)
    if (nextHeight === this.renderer.footerHeight) {
      this.refreshStatus("footer already at limit")
      return
    }

    this.desiredFooterHeight = nextHeight
    this.renderer.footerHeight = nextHeight
    this.refreshStatus(`footer height ${nextHeight}`)
    this.publishMessage("system", `footer height adjusted to ${nextHeight}`, false)
  }

  private handleDraftChanged = (): void => {
    this.refreshStatus()
  }

  private isModeToggleKey(key: KeyEvent): boolean {
    if (!key.ctrl) {
      return false
    }

    if (key.baseCode === 48) {
      return true
    }

    if (key.name === "0" || key.name === "kp0" || key.name === ")") {
      return true
    }

    return key.raw === "\u001b[27;5;48~" || key.raw === "\u001b[27;6;48~"
  }

  private handleKeyPress = (key: KeyEvent): void => {
    if (!key.ctrl && !key.meta && key.shift && key.name === "u") {
      key.preventDefault()
      this.renderer.useMouse = !this.renderer.useMouse
      this.refreshStatus(`mouse ${this.renderer.useMouse ? "enabled" : "disabled"}`)
      return
    }

    if (key.ctrl && key.name === "s") {
      key.preventDefault()
      this.setStreamEnabled(!this.streamEnabled)
      return
    }

    if (this.isModeToggleKey(key)) {
      key.preventDefault()
      this.toggleMode()
      return
    }

    if (key.ctrl && key.name === "r") {
      key.preventDefault()
      this.startCtrlRHoldSimulation(CTRL_R_HOLD_DURATION_MS)
      return
    }

    if (key.ctrl && key.name === "l") {
      key.preventDefault()
      this.composer.setText("")
      this.refreshStatus("draft cleared")
      return
    }

    if (key.ctrl && key.name === "up") {
      key.preventDefault()
      this.adjustFooterHeight(1)
      return
    }

    if (key.ctrl && key.name === "down") {
      key.preventDefault()
      this.adjustFooterHeight(-1)
      return
    }

    if (key.ctrl && key.name === "]") {
      key.preventDefault()
      this.setStreamInterval(this.streamIntervalMs - STREAM_INTERVAL_STEP)
      return
    }

    if (key.ctrl && key.name === "[") {
      key.preventDefault()
      this.setStreamInterval(this.streamIntervalMs + STREAM_INTERVAL_STEP)
      return
    }

    if (key.name === "escape") {
      this.composer.focus()
      this.refreshStatus("composer focused")
    }
  }

  private handleThemeMode = (mode: ThemeMode): void => {
    this.palette = resolveDemoPalette(mode)
    this.applyPalette()
    this.refreshStatus(`theme ${mode}`)
  }

  private handleResize = (): void => {
    this.desiredFooterHeight = this.clampFooterHeight(this.desiredFooterHeight)
    if (this.mode === "split-footer" && this.renderer.footerHeight !== this.desiredFooterHeight) {
      this.renderer.footerHeight = this.desiredFooterHeight
    }

    this.refreshStatus("layout resized")
  }

  private handleRendererDestroy = (): void => {
    this.destroy()
  }

  public destroy(): void {
    if (this.destroyed) {
      return
    }

    this.destroyed = true
    this.streamEnabled = false

    if (this.pendingAssistantReply) {
      clearTimeout(this.pendingAssistantReply)
      this.pendingAssistantReply = null
    }

    if (this.ctrlRBootTimer) {
      clearTimeout(this.ctrlRBootTimer)
      this.ctrlRBootTimer = null
    }

    this.stopCtrlRHoldSimulation(false)

    if (this.streamTimer) {
      clearInterval(this.streamTimer)
      this.streamTimer = null
    }

    this.composer.off("line-info-change", this.handleDraftChanged)
    this.composer.onSubmit = undefined
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("resize", this.handleResize)
    this.renderer.off(CliRenderEvents.THEME_MODE, this.handleThemeMode)
    this.renderer.off(CliRenderEvents.DESTROY, this.handleRendererDestroy)

    this.shell.destroyRecursively()

    if (!this.renderer.isDestroyed) {
      this.renderer.externalOutputMode = "passthrough"
      this.renderer.screenMode = "main-screen"
    }
  }
}

let activeDemo: SplitFooterDemo | null = null

export function run(rendererInstance: CliRenderer): void {
  if (activeDemo) {
    activeDemo.destroy()
  }

  activeDemo = new SplitFooterDemo(rendererInstance)
}

export function destroy(_rendererInstance: CliRenderer): void {
  if (!activeDemo) {
    return
  }

  activeDemo.destroy()
  activeDemo = null
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    targetFps: 30,
    exitOnCtrlC: true,
    useMouse: true,
    screenMode: "split-footer",
    footerHeight: DEFAULT_FOOTER_HEIGHT,
    externalOutputMode: "capture-stdout",
    consoleMode: "disabled",
  })

  run(renderer)
  setupCommonDemoKeys(renderer)
  renderer.start()

  // Used by capture scripts to bound each run to a fixed duration.
  if (AUTO_EXIT_MS > 0) {
    setTimeout(() => {
      if (!renderer.isDestroyed) {
        renderer.destroy()
      }
    }, AUTO_EXIT_MS)
  }
}
