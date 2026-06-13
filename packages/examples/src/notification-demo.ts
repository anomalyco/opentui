import {
  BoxRenderable,
  CliRenderEvents,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
  createCliRenderer,
  t,
  bold,
  fg,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type RenderContext,
  type TerminalCapabilities,
} from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"

const P = {
  bg: "#08111f",
  panel: "#0f1b2d",
  panelAlt: "#111f34",
  border: "#223553",
  borderHot: "#22d3ee",
  text: "#d7e3f7",
  muted: "#7d8da8",
  cyan: "#22d3ee",
  violet: "#a78bfa",
  lime: "#bef264",
  rose: "#fb7185",
  amber: "#fbbf24",
  blue: "#60a5fa",
} as const

interface NotificationAction {
  key: string
  title: string
  subtitle: string
  accent: string
  message: string
  notificationTitle?: string
  delayed?: boolean
}

const actions: NotificationAction[] = [
  {
    key: "1",
    title: "Quick ping",
    subtitle: "Body-only notification",
    accent: P.cyan,
    message: "OpenTUI notification ping delivered.",
  },
  {
    key: "2",
    title: "Build complete",
    subtitle: "Title and body",
    accent: P.lime,
    notificationTitle: "OpenTUI build",
    message: "The example build finished successfully.",
  },
  {
    key: "3",
    title: "Async task",
    subtitle: "Waits, then notifies",
    accent: P.violet,
    notificationTitle: "Background task finished",
    message: "The simulated background task is complete.",
    delayed: true,
  },
  {
    key: "4",
    title: "Needs attention",
    subtitle: "Prompt-style alert",
    accent: P.rose,
    notificationTitle: "Action required",
    message: "A task is waiting for your input in the terminal.",
  },
]

let renderer: CliRenderer | null = null
let root: BoxRenderable | null = null
let statusText: TextRenderable | null = null
let logList: ScrollBoxRenderable | null = null
let keyHandler: ((key: KeyEvent) => void) | null = null
let capabilityHandler: ((capabilities: TerminalCapabilities) => void) | null = null
let pendingTimer: ReturnType<typeof setTimeout> | null = null
let cards: NotificationCard[] = []
let logRows: TextRenderable[] = []
let logEntryId = 0
const MAX_LOG_ENTRIES = 80

class NotificationCard extends BoxRenderable {
  private hovered = false
  private readonly action: NotificationAction
  private readonly actionHandler: (action: NotificationAction) => void

  constructor(ctx: RenderContext, action: NotificationAction, actionHandler: (action: NotificationAction) => void) {
    super(ctx, {
      id: `notification-card-${action.key}`,
      width: "auto",
      height: 9,
      minWidth: 18,
      flexGrow: 1,
      flexShrink: 1,
      flexDirection: "column",
      padding: 1,
      marginRight: 1,
      backgroundColor: P.panelAlt,
      border: true,
      borderStyle: "rounded",
      borderColor: P.border,
      title: ` ${action.key} `,
      titleAlignment: "left",
      zIndex: 5,
    })

    this.action = action
    this.actionHandler = actionHandler

    this.add(
      new TextRenderable(ctx, {
        id: `notification-card-${action.key}-title`,
        content: t`${bold(fg(action.accent)(action.title))}`,
        fg: P.text,
        flexGrow: 0,
        flexShrink: 0,
      }),
    )
    this.add(
      new TextRenderable(ctx, {
        id: `notification-card-${action.key}-subtitle`,
        content: t`${fg(P.muted)(action.subtitle)}`,
        fg: P.muted,
        flexGrow: 0,
        flexShrink: 0,
      }),
    )
    this.add(
      new TextRenderable(ctx, {
        id: `notification-card-${action.key}-spacer`,
        content: "",
        flexGrow: 1,
        flexShrink: 1,
      }),
    )
    this.add(
      new TextRenderable(ctx, {
        id: `notification-card-${action.key}-cta`,
        content: t`${fg(action.accent)("Click")} ${fg(P.muted)("or press")} ${bold(fg(P.text)(action.key))}`,
        fg: P.text,
        flexGrow: 0,
        flexShrink: 0,
      }),
    )
  }

  protected onMouseEvent(event: MouseEvent): void {
    if (event.type === "over") {
      this.hovered = true
      this.backgroundColor = "#172845"
      this.borderColor = this.action.accent
    } else if (event.type === "out") {
      this.hovered = false
      this.backgroundColor = P.panelAlt
      this.borderColor = P.border
    } else if (event.type === "down") {
      this.backgroundColor = "#20365b"
      this.actionHandler(this.action)
      event.stopPropagation()
    } else if (event.type === "up") {
      this.backgroundColor = this.hovered ? "#172845" : P.panelAlt
      event.stopPropagation()
    }
  }
}

function notificationSupported(): boolean {
  return renderer?.capabilities?.notifications === true
}

function addLog(message: string, color = P.muted): void {
  if (!renderer || !logList) return

  const stamp = new Date().toLocaleTimeString()
  const row = new TextRenderable(renderer, {
    id: `notification-demo-log-entry-${logEntryId++}`,
    content: `${stamp}  ${message}`,
    fg: color,
    flexGrow: 0,
    flexShrink: 0,
  })

  logList.add(row)
  logRows.push(row)

  while (logRows.length > MAX_LOG_ENTRIES) {
    const oldRow = logRows.shift()
    oldRow?.destroyRecursively()
  }
}

function updateStatus(): void {
  if (!renderer || !statusText) return

  const caps = renderer.capabilities
  const terminalName = caps?.terminal?.name || "detecting"
  const terminalVersion = caps?.terminal?.version ? ` ${caps.terminal.version}` : ""
  const supported = notificationSupported()
  const status = supported ? fg(P.lime)("enabled") : fg(P.rose)("not detected")
  const transport =
    caps?.multiplexer === "tmux"
      ? fg(P.amber)("tmux passthrough")
      : caps?.multiplexer === "zellij"
        ? fg(P.amber)("Zellij OSC 99")
        : fg(P.blue)("direct OSC")

  statusText.content = t`${bold(fg(P.text)("Terminal notifications"))}: ${status}
${fg(P.muted)("Terminal:")} ${fg(P.cyan)(`${terminalName}${terminalVersion}`)}  ${fg(P.muted)("Transport:")} ${transport}`
}

function triggerAction(action: NotificationAction): void {
  if (!renderer) return

  if (action.delayed) {
    if (pendingTimer) clearTimeout(pendingTimer)
    addLog("Started simulated background task...", action.accent)
    pendingTimer = setTimeout(() => {
      pendingTimer = null
      sendNotification(action)
    }, 1400)
    return
  }

  sendNotification(action)
}

function sendNotification(action: NotificationAction): void {
  if (!renderer) return

  const ok = renderer.triggerNotification(action.message, action.notificationTitle)
  addLog(ok ? `Sent: ${action.title}` : `Not sent: ${action.title} (unsupported)`, ok ? action.accent : P.rose)
  updateStatus()
}

function buildLayout(rendererInstance: CliRenderer): void {
  renderer = rendererInstance
  renderer.start()
  renderer.setBackgroundColor(P.bg)

  root = new BoxRenderable(renderer, {
    id: "notification-demo-root",
    flexGrow: 1,
    maxWidth: "100%",
    maxHeight: "100%",
    flexDirection: "column",
    backgroundColor: P.bg,
    padding: 1,
  })
  renderer.root.add(root)

  const header = new BoxRenderable(renderer, {
    id: "notification-demo-header",
    width: "100%",
    height: 6,
    flexDirection: "column",
    flexGrow: 0,
    flexShrink: 0,
    padding: 1,
    marginBottom: 1,
    backgroundColor: "#0d1b30",
    border: true,
    borderStyle: "rounded",
    borderColor: P.borderHot,
    title: " OSC Notifications ",
    titleAlignment: "center",
  })

  header.add(
    new TextRenderable(renderer, {
      id: "notification-demo-title",
      content: t`${bold(fg(P.cyan)("System notifications"))} ${fg(P.muted)("from terminal OSC sequences")}`,
      attributes: TextAttributes.BOLD,
      flexGrow: 0,
      flexShrink: 0,
    }),
  )

  statusText = new TextRenderable(renderer, {
    id: "notification-demo-status",
    content: "",
    fg: P.text,
    flexGrow: 0,
    flexShrink: 0,
  })
  header.add(statusText)

  root.add(header)

  const body = new BoxRenderable(renderer, {
    id: "notification-demo-body",
    width: "100%",
    height: "auto",
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "column",
    backgroundColor: P.bg,
  })
  root.add(body)

  const cardsRow = new BoxRenderable(renderer, {
    id: "notification-demo-cards",
    width: "100%",
    height: "auto",
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "row",
    gap: 1,
    marginBottom: 1,
    backgroundColor: P.bg,
  })
  body.add(cardsRow)

  cards = actions.map((action) => new NotificationCard(renderer!, action, triggerAction))
  for (const card of cards) cardsRow.add(card)

  const footer = new BoxRenderable(renderer, {
    id: "notification-demo-footer",
    width: "100%",
    height: 16,
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: "row",
    gap: 1,
    backgroundColor: P.bg,
  })
  body.add(footer)

  const controls = new BoxRenderable(renderer, {
    id: "notification-demo-controls",
    width: 38,
    height: "100%",
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: "column",
    padding: 1,
    backgroundColor: P.panel,
    border: true,
    borderStyle: "rounded",
    borderColor: P.border,
    title: " Controls ",
  })
  controls.add(
    new TextRenderable(renderer, {
      id: "notification-demo-controls-text",
      content: t`${fg(P.cyan)("1")} Quick ping
${fg(P.lime)("2")} Build complete
${fg(P.violet)("3")} Async task
${fg(P.rose)("4")} Needs attention
${fg(P.muted)("Mouse")} Click any card
${fg(P.muted)("Esc")} Return to menu`,
    }),
  )
  footer.add(controls)

  const log = new BoxRenderable(renderer, {
    id: "notification-demo-log",
    width: "auto",
    height: "100%",
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "column",
    padding: 1,
    backgroundColor: P.panel,
    border: true,
    borderStyle: "rounded",
    borderColor: P.border,
    title: " Activity ",
  })
  logList = new ScrollBoxRenderable(renderer, {
    id: "notification-demo-log-list",
    stickyScroll: true,
    stickyStart: "bottom",
    rootOptions: {
      backgroundColor: P.panel,
      border: false,
    },
    wrapperOptions: {
      backgroundColor: P.panel,
    },
    viewportOptions: {
      backgroundColor: P.panel,
    },
    contentOptions: {
      backgroundColor: P.panel,
    },
    scrollbarOptions: {
      trackOptions: {
        foregroundColor: P.cyan,
        backgroundColor: P.border,
      },
    },
    height: "100%",
    width: "auto",
    flexGrow: 1,
    flexShrink: 1,
  })
  log.add(logList)
  footer.add(log)

  updateStatus()
  addLog("Demo ready. Press 1-4 or click a card.", P.cyan)
}

export function run(rendererInstance: CliRenderer): void {
  buildLayout(rendererInstance)

  capabilityHandler = () => updateStatus()
  rendererInstance.on(CliRenderEvents.CAPABILITIES, capabilityHandler)

  keyHandler = (key: KeyEvent) => {
    const action = actions.find((candidate) => candidate.key === key.name)
    if (action) {
      triggerAction(action)
    }
  }
  rendererInstance.keyInput.on("keypress", keyHandler)
}

export function destroy(rendererInstance: CliRenderer): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
  if (keyHandler) {
    rendererInstance.keyInput.off("keypress", keyHandler)
    keyHandler = null
  }
  if (capabilityHandler) {
    rendererInstance.off(CliRenderEvents.CAPABILITIES, capabilityHandler)
    capabilityHandler = null
  }
  if (root) {
    rendererInstance.root.remove(root.id)
    root.destroyRecursively()
  }

  root = null
  statusText = null
  logList = null
  renderer = null
  cards = []
  logRows = []
  logEntryId = 0
}

if (import.meta.main) {
  const renderer = await createCliRenderer({ exitOnCtrlC: true })
  run(renderer)
  setupCommonDemoKeys(renderer)
}
