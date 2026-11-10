import {
  CliRenderEvents,
  ConsolePosition,
  type CliRenderer,
  type InputRenderable,
  type KeyEvent,
  TextAttributes,
  type Renderable,
  type TextareaRenderable,
} from "@opentui/core"
import { type ActiveKey, type Command } from "@opentui/keymap"
import * as addons from "@opentui/keymap/addons/opentui"
import type { ExCommandPayload } from "@opentui/keymap/addons/opentui"
import { formatKeySequence } from "@opentui/keymap/extras"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { KeymapProvider, useBindings, useKeymap, useKeymapSelector } from "@opentui/keymap/solid"
import { render, useRenderer } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount, Show, type Accessor, type JSX } from "solid-js"

const palette = {
  bg: "#1a1b26",
  surface: "#16161e",
  surfaceFocus: "#292e42",
  panel: "#1f2335",
  border: "#2f334d",
  borderStrong: "#3b4261",
  text: "#c0caf5",
  textDim: "#a9b1d6",
  textMuted: "#565f89",
  title: "#c0caf5",
  alpha: "#7dcfff",
  beta: "#9ece6a",
  accent: "#bb9af7",
  key: "#7dcfff",
  command: "#9ece6a",
  leader: "#e0af68",
  separator: "#3b4261",
} as const

const LEADER_TOKEN = "<leader>"
const COUNT_PATTERN = "count"
const KEY_FORMAT_OPTIONS = {
  tokenDisplay: {
    [LEADER_TOKEN]: "ctrl+x",
  },
} as const
const LEADER_TRIGGER_LABEL = KEY_FORMAT_OPTIONS.tokenDisplay[LEADER_TOKEN]

function createDemoKeymap(renderer: CliRenderer): ReturnType<typeof createDefaultOpenTuiKeymap> {
  return createDefaultOpenTuiKeymap(renderer)
}

type PanelId = "alpha" | "beta"
type EditorId = "notes" | "draft" | "scratch"

interface EditorSpec {
  id: EditorId
  label: string
  color: string
  initialValue?: string
  placeholder?: string
}

const editorSpecs: readonly EditorSpec[] = [
  {
    id: "notes",
    label: "Notes",
    color: palette.alpha,
    initialValue: "Notes editor\nTab/Shift+Tab switches focus.",
  },
  {
    id: "draft",
    label: "Draft",
    color: palette.beta,
    initialValue: "Draft editor\nPress dd here to delete the current line.",
  },
  {
    id: "scratch",
    label: "Scratch",
    color: palette.accent,
    placeholder: "Scratch editor. Unmapped text still inserts directly.",
  },
] as const

type ExArgCount = "0" | "1" | "?" | "*" | "+"

interface DemoExCommand extends Command<Renderable, KeyEvent, ExCommandPayload> {
  name: string
  aliases?: string[]
  nargs?: ExArgCount
  title: string
  desc: string
  category: string
  usage: string
}

interface ExPromptSuggestion {
  label: string
  insert: string
  usage: string
  desc: string
  expectsArgs: boolean
}

const EX_PROMPT_WIDTH = 54
const EX_PROMPT_MAX_VISIBLE_SUGGESTIONS = 4
const EX_PROMPT_CHROME_ROWS = 5
const EX_PROMPT_MAX_HEIGHT = EX_PROMPT_CHROME_ROWS + EX_PROMPT_MAX_VISIBLE_SUGGESTIONS

function normalizeExPromptName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    return ":"
  }

  return trimmed.startsWith(":") ? trimmed : `:${trimmed}`
}

function parseExPromptInput(input: string): { raw: string; name: string; args: string[] } | null {
  const normalized = normalizeExPromptName(input)
  if (normalized === ":") {
    return null
  }

  const parts = normalized.split(/\s+/)
  const [name, ...args] = parts
  if (!name) {
    return null
  }

  return {
    raw: normalized,
    name,
    args,
  }
}

function getExPromptCommandFieldText(command: Command<Renderable, KeyEvent>, fieldName: string): string | undefined {
  return getMetadataText(command[fieldName])
}

function getExPromptCommandNargs(command: Command<Renderable, KeyEvent>): ExArgCount | undefined {
  const value = command.nargs
  if (value === "0" || value === "1" || value === "?" || value === "*" || value === "+") {
    return value
  }

  return undefined
}

function buildExPromptSuggestions(commands: readonly Command<Renderable, KeyEvent>[]): ExPromptSuggestion[] {
  const suggestions: ExPromptSuggestion[] = []

  for (const command of commands) {
    const label = normalizeExPromptName(command.name)
    suggestions.push({
      label,
      insert: label,
      usage: getExPromptCommandFieldText(command, "usage") ?? label,
      desc: getExPromptCommandFieldText(command, "desc") ?? "",
      expectsArgs: getExPromptCommandNargs(command) !== "0",
    })
  }

  return suggestions
}

function getExPromptSuggestions(
  commands: readonly Command<Renderable, KeyEvent>[],
  value: string,
): ExPromptSuggestion[] {
  const normalized = normalizeExPromptName(value)
  const spaceIndex = normalized.indexOf(" ")
  const query = spaceIndex === -1 ? normalized : normalized.slice(0, spaceIndex)
  const suggestions = buildExPromptSuggestions(commands)

  if (query === ":") {
    return suggestions.slice(0, EX_PROMPT_MAX_VISIBLE_SUGGESTIONS)
  }

  return suggestions
    .filter((suggestion) => suggestion.label.startsWith(query))
    .slice(0, EX_PROMPT_MAX_VISIBLE_SUGGESTIONS)
}

function getSelectedExPromptSuggestion(
  commands: readonly Command<Renderable, KeyEvent>[],
  value: string,
  selection: number,
): ExPromptSuggestion | null {
  const suggestions = getExPromptSuggestions(commands, value)
  if (suggestions.length === 0) {
    return null
  }

  return suggestions[Math.min(selection, suggestions.length - 1)] ?? null
}

function moveExPromptSelection(
  commands: readonly Command<Renderable, KeyEvent>[],
  value: string,
  selection: number,
  direction: 1 | -1,
): number {
  const suggestions = getExPromptSuggestions(commands, value)
  if (suggestions.length === 0) {
    return 0
  }

  const current = Math.min(selection, suggestions.length - 1)
  return (current + direction + suggestions.length) % suggestions.length
}

function applyExPromptSuggestion(
  commands: readonly Command<Renderable, KeyEvent>[],
  value: string,
  selection: number,
  direction?: 1 | -1,
): { value: string; selection: number } | null {
  const suggestions = getExPromptSuggestions(commands, value)
  if (suggestions.length === 0) {
    return null
  }

  const nextSelection = direction
    ? moveExPromptSelection(commands, value, selection, direction)
    : Math.min(selection, suggestions.length - 1)
  const suggestion = suggestions[nextSelection]
  if (!suggestion) {
    return null
  }

  const normalized = normalizeExPromptName(value)
  const spaceIndex = normalized.indexOf(" ")
  const rest = spaceIndex === -1 ? "" : normalized.slice(spaceIndex + 1).trimStart()
  const nextValue = rest
    ? `${suggestion.insert} ${rest}`
    : suggestion.expectsArgs
      ? `${suggestion.insert} `
      : suggestion.insert

  return {
    value: nextValue,
    selection: nextSelection,
  }
}

function KeyLabel(props: { children: JSX.Element }) {
  return <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>{props.children}</span>
}

function getMetadataText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const trimmed = value.trim()
  return trimmed || undefined
}

function getCountPayload(payload: unknown): number {
  if (!payload || typeof payload !== "object") {
    return 1
  }

  const count = (payload as { count?: unknown }).count
  return typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 1
}

function getActiveKeyLabel(activeKey: ActiveKey): string {
  if (activeKey.continues) {
    const group = getMetadataText(activeKey.bindingAttrs?.group)
    if (group) {
      return `+${group}`
    }
  }

  return (
    getMetadataText(activeKey.bindingAttrs?.desc) ??
    getMetadataText(activeKey.commandAttrs?.desc) ??
    getMetadataText(activeKey.commandAttrs?.title) ??
    (typeof activeKey.command === "string" ? activeKey.command : undefined) ??
    ""
  )
}

// -- CounterPanel ----------------------------------------------------------

function CounterPanel(props: {
  id: PanelId
  label: string
  saveTarget: string
  step: number
  color: string
  setRef?: (value: Renderable) => void
  count: Accessor<number>
  setCount: (value: number) => void
  announce: (message: string) => void
}) {
  const manager = useKeymap()
  const [target, setTarget] = createSignal<Renderable | undefined>(undefined)
  const incrementCommand = `${props.id}-up`
  const decrementCommand = `${props.id}-down`
  const incrementCountCommand = `${props.id}-up-count`
  const decrementCountCommand = `${props.id}-down-count`

  const offCommands = manager.registerLayer({
    commands: [
      {
        name: incrementCommand,
        title: `${props.label} +${props.step}`,
        desc: `${props.label} +${props.step}`,
        category: props.label,
        run() {
          const next = props.count() + props.step
          props.setCount(next)
          props.announce(`${props.label} increased to ${next}`)
        },
      },
      {
        name: incrementCountCommand,
        title: `${props.label} +count`,
        desc: `${props.label} +count`,
        category: props.label,
        run({ payload }) {
          const amount = getCountPayload(payload) * props.step
          const next = props.count() + amount
          props.setCount(next)
          props.announce(`${props.label} increased by ${amount} to ${next}`)
        },
      },
      {
        name: decrementCommand,
        title: `${props.label} -${props.step}`,
        desc: `${props.label} -${props.step}`,
        category: props.label,
        run() {
          const next = props.count() - props.step
          props.setCount(next)
          props.announce(`${props.label} decreased to ${next}`)
        },
      },
      {
        name: decrementCountCommand,
        title: `${props.label} -count`,
        desc: `${props.label} -count`,
        category: props.label,
        run({ payload }) {
          const amount = getCountPayload(payload) * props.step
          const next = props.count() - amount
          props.setCount(next)
          props.announce(`${props.label} decreased by ${amount} to ${next}`)
        },
      },
    ],
  })

  useBindings(() => ({
    target,
    bindings: [
      { key: "j", cmd: decrementCommand, desc: `${props.label} -${props.step}` },
      { key: "k", cmd: incrementCommand, desc: `${props.label} +${props.step}` },
      { key: "{count}j", cmd: decrementCountCommand, desc: `${props.label} -count` },
      { key: "{count}k", cmd: incrementCountCommand, desc: `${props.label} +count` },
      { key: "return", cmd: `:w ${props.saveTarget}`, desc: `Write ${props.label.toLowerCase()} panel` },
    ],
  }))

  onCleanup(() => {
    offCommands()
  })

  return (
    <box
      id={`keymap-demo-${props.id}`}
      ref={(value: Renderable) => {
        setTarget(value)
        props.setRef?.(value)
      }}
      border
      borderStyle="single"
      focusable
      borderColor={palette.border}
      focusedBorderColor={props.color}
      backgroundColor={palette.panel}
      paddingX={1}
      flexDirection="column"
      flexGrow={1}
      title={` ${props.label} `}
      titleAlignment="left"
    >
      <text height={1}>
        <span style={{ fg: palette.textDim }}>Count: </span>
        <span style={{ fg: props.color, attributes: TextAttributes.BOLD }}>{String(props.count())}</span>
      </text>
      <text height={1}>
        <KeyLabel>j</KeyLabel>
        <span style={{ fg: palette.textDim }}>{` +${props.step}  `}</span>
        <KeyLabel>k</KeyLabel>
        <span style={{ fg: palette.textDim }}>{` -${props.step}`}</span>
        <span style={{ fg: palette.separator }}>{"  |  "}</span>
        <KeyLabel>enter</KeyLabel>
        <span style={{ fg: palette.textDim }}>{` save ${props.label.toLowerCase()}`}</span>
      </text>
    </box>
  )
}

// -- KeymapDemo (root) --------------------------------------------------------

function KeymapDemoContent() {
  const renderer = useRenderer()
  const manager = useKeymap()
  let alphaPanelRef: Renderable | undefined
  let betaPanelRef: Renderable | undefined
  let commandInputRef: InputRenderable | undefined
  let commandPromptRestoreTarget: Renderable | undefined
  const editorRefs: Array<TextareaRenderable | undefined> = []

  const [alphaCount, setAlphaCount] = createSignal(0)
  const [betaCount, setBetaCount] = createSignal(0)
  const [helpVisible, setHelpVisible] = createSignal(true)
  const [leaderArmed, setLeaderArmed] = createSignal(false)
  const [commandPromptVisible, setCommandPromptVisible] = createSignal(false)
  const [commandPromptTarget, setCommandPromptTarget] = createSignal<InputRenderable | undefined>(undefined)
  const [commandPromptValue, setCommandPromptValue] = createSignal(":")
  const [commandPromptSelection, setCommandPromptSelection] = createSignal(0)
  const [lastAction, setLastAction] = createSignal("Click a panel or press Tab to start.")
  const [logs, setLogs] = createSignal<string[]>([])
  const [statusVersion, setStatusVersion] = createSignal(0)

  const activeKeys = useKeymapSelector((keymap) => keymap.getActiveKeys({ includeMetadata: true }))
  const pendingSequence = useKeymapSelector((keymap) => keymap.getPendingSequence())

  const bumpStatus = () => {
    setStatusVersion((value) => value + 1)
  }

  const addLog = (message: string) => {
    setLogs((current) => {
      if (current[0] === message) {
        return current
      }

      return [message, ...current].slice(0, 8)
    })
  }

  const announce = (message: string) => {
    setLastAction(message)
    addLog(message)
  }

  const syncCommandPromptInput = (value: string) => {
    if (!commandInputRef) {
      return
    }

    if (commandInputRef.value !== value) {
      commandInputRef.value = value
    }

    commandInputRef.cursorOffset = value.length
  }

  const getFocusableTargets = (): Renderable[] => {
    return [alphaPanelRef, betaPanelRef, ...editorRefs].filter((target): target is Renderable => target !== undefined)
  }

  const getFocusableLabel = (target: Renderable): string => {
    if (target === alphaPanelRef) {
      return "Alpha panel"
    }

    if (target === betaPanelRef) {
      return "Beta panel"
    }

    const editorIndex = editorRefs.findIndex((editor) => editor === target)
    if (editorIndex !== -1) {
      return `${editorSpecs[editorIndex]!.label} editor`
    }

    return "target"
  }

  const moveFocus = (direction: 1 | -1) => {
    const targets = getFocusableTargets()
    if (targets.length === 0) {
      return
    }

    const currentIndex = targets.findIndex((target) => target === renderer.currentFocusedRenderable)
    const startIndex = currentIndex === -1 ? 0 : currentIndex
    const nextIndex = (startIndex + direction + targets.length) % targets.length
    const target = targets[nextIndex]
    if (!target) {
      return
    }

    target.focus()
    announce(`Focused ${getFocusableLabel(target)}`)
  }

  const restoreCommandPromptFocus = () => {
    const restoreTarget = commandPromptRestoreTarget
    commandPromptRestoreTarget = undefined

    if (restoreTarget && !restoreTarget.isDestroyed) {
      restoreTarget.focus()
      return
    }

    alphaPanelRef?.focus()
  }

  const hideCommandPrompt = () => {
    setCommandPromptVisible(false)
    setCommandPromptValue(":")
    setCommandPromptSelection(0)
  }

  const closeCommandPrompt = (message: string) => {
    hideCommandPrompt()
    restoreCommandPromptFocus()
    announce(message)
  }

  const dismissCommandPromptForFocusChange = (focused: Renderable | null) => {
    if (!commandPromptVisible() || focused === commandInputRef) {
      return
    }

    hideCommandPrompt()
    commandPromptRestoreTarget = undefined
    announce("Closed ex prompt")
  }

  const openCommandPrompt = () => {
    if (commandPromptVisible()) {
      return
    }

    commandPromptRestoreTarget = renderer.currentFocusedRenderable ?? undefined
    setCommandPromptVisible(true)
    setCommandPromptValue(":")
    setCommandPromptSelection(0)
    syncCommandPromptInput(":")
    commandInputRef?.focus()
    announce("Opened ex prompt")
  }

  const offCommands = manager.registerLayer({
    commands: [
      {
        name: "focus-next",
        title: "Next target",
        desc: "Next target",
        category: "Navigation",
        run() {
          moveFocus(1)
        },
      },
      {
        name: "focus-prev",
        title: "Previous target",
        desc: "Previous target",
        category: "Navigation",
        run() {
          moveFocus(-1)
        },
      },
      {
        name: "toggle-help",
        title: "Toggle help",
        desc: "Toggle help",
        category: "View",
        run() {
          setHelpVisible((value) => {
            const next = !value
            announce(next ? "Help shown" : "Help hidden")
            return next
          })
        },
      },
      {
        name: "open-ex-prompt",
        title: "Open ex prompt",
        desc: "Open ex prompt",
        category: "Ex",
        run() {
          openCommandPrompt()
        },
      },
    ],
  })

  const exCommands: DemoExCommand[] = [
    {
      name: "reset",
      aliases: ["r"],
      nargs: "0",
      title: "Reset counters",
      desc: "Reset counters",
      category: "Session",
      usage: ":reset",
      run() {
        setAlphaCount(0)
        setBetaCount(0)
        announce("Counters reset through :reset")
      },
    },
    {
      name: "write",
      aliases: ["w"],
      nargs: "1",
      title: "Write file",
      desc: "Write file",
      category: "File",
      usage: ":write <file>",
      run({ payload }) {
        announce(`Wrote ${payload.args[0]}`)
      },
    },
  ]

  const offEx = addons.registerExCommands(manager)
  const offExCommands = manager.registerLayer({
    commands: exCommands.map((command) => ({ ...command, namespace: "excommands" })),
  })

  const discoveredExCommands = createMemo(() => {
    commandPromptVisible()
    return manager.getCommands({ namespace: "excommands" })
  })

  const commandPromptSuggestions = createMemo(() => {
    return getExPromptSuggestions(discoveredExCommands(), commandPromptValue())
  })

  const commandPromptSuggestionRows = createMemo(() => {
    return Math.max(commandPromptSuggestions().length, 1)
  })

  const selectedCommandPromptSuggestion = createMemo(() => {
    return getSelectedExPromptSuggestion(discoveredExCommands(), commandPromptValue(), commandPromptSelection())
  })

  const commandPromptUsage = createMemo(() => {
    const selected = selectedCommandPromptSuggestion()
    if (!selected) {
      return "No matching ex commands"
    }

    return `Usage: ${selected.usage}  |  ${selected.desc}`
  })

  const moveCommandPromptSelection = (direction: 1 | -1) => {
    setCommandPromptSelection((current) => {
      return moveExPromptSelection(discoveredExCommands(), commandPromptValue(), current, direction)
    })
  }

  const applyCommandPromptSuggestion = (direction?: 1 | -1) => {
    const result = applyExPromptSuggestion(
      discoveredExCommands(),
      commandPromptValue(),
      commandPromptSelection(),
      direction,
    )
    if (!result) {
      return
    }

    setCommandPromptSelection(result.selection)
    setCommandPromptValue(result.value)
    syncCommandPromptInput(result.value)
  }

  const executeCommandPrompt = () => {
    const parsed = parseExPromptInput(commandPromptValue())
    if (!parsed) {
      closeCommandPrompt("Closed ex prompt")
      return
    }

    const restoreTarget = commandPromptRestoreTarget
    const focused = restoreTarget && !restoreTarget.isDestroyed ? restoreTarget : renderer.currentFocusedRenderable
    const result = manager.dispatchCommand(parsed.raw, { focused: focused ?? null, includeCommand: true })

    if (!result.ok) {
      if (result.reason === "not-found") {
        announce(`Unknown ex command ${parsed.name}`)
        return
      }

      if (result.reason === "invalid-args") {
        announce(
          `Usage: ${result.command ? (getExPromptCommandFieldText(result.command, "usage") ?? parsed.name) : parsed.name}`,
        )
        return
      }

      if (result.reason === "error") {
        announce(`Error running ${parsed.name}`)
        return
      }

      announce(`Command ${parsed.name} was rejected`)
      return
    }

    hideCommandPrompt()
    restoreCommandPromptFocus()
  }

  const offLeader = addons.registerTimedLeader(manager, {
    trigger: { name: "x", ctrl: true },
    onArm() {
      setLeaderArmed(true)
      announce("Leader armed: press s or h")
    },
    onDisarm() {
      setLeaderArmed(false)
    },
  })
  const offNeovimDisambiguation = addons.registerNeovimDisambiguation(manager)
  const offEscapePending = addons.registerEscapeClearsPendingSequence(manager)
  const offBackspacePending = addons.registerBackspacePopsPendingSequence(manager)
  const offCountPattern = manager.registerSequencePattern({
    name: COUNT_PATTERN,
    match(event) {
      if (!/^\d$/.test(event.name)) {
        return undefined
      }

      return { value: event.name, display: event.name }
    },
    finalize(values) {
      return Number(values.join(""))
    },
  })

  const offManagedTextareas = addons.registerManagedTextareaLayer(manager, renderer, {
    enabled: () => !commandPromptVisible() && renderer.currentFocusedEditor !== null,
    bindings: [
      { key: "left", cmd: "input.move.left", desc: "Cursor left" },
      { key: "right", cmd: "input.move.right", desc: "Cursor right" },
      { key: "up", cmd: "input.move.up", desc: "Cursor up" },
      { key: "down", cmd: "input.move.down", desc: "Cursor down" },
      { key: "backspace", cmd: "input.backspace", desc: "Delete backward" },
      { key: "delete", cmd: "input.delete", desc: "Delete forward" },
      { key: "return", cmd: "input.newline", desc: "New line" },
      { key: "ctrl+a", cmd: "input.line.home", desc: "Line start" },
      { key: "ctrl+e", cmd: "input.line.end", desc: "Line end" },
      { key: "d", group: "Delete" },
      { key: "dd", cmd: "input.delete.line", desc: "Delete line" },
      { key: "g", cmd: "input.line.home", desc: "Line start", group: "Go" },
      { key: "gg", cmd: "input.buffer.home", desc: "Buffer start", group: "Go" },
      { key: "shift+g", cmd: "input.buffer.end", desc: "Buffer end", group: "Go" },
    ],
  })

  useBindings(() => ({
    enabled: () => !commandPromptVisible(),
    bindings: [
      { key: "tab", cmd: "focus-next", desc: "Next target" },
      { key: "shift+tab", cmd: "focus-prev", desc: "Previous target" },
      { key: "?", cmd: "toggle-help", desc: "Toggle help" },
      { key: "ctrl+r", cmd: ":reset", desc: "Reset counters" },
      { key: "<leader>", group: "Leader" },
      { key: "<leader>s", cmd: ":w session.log", desc: "Write session log", group: "Leader" },
      { key: "<leader>h", cmd: "toggle-help", desc: "Toggle help", group: "Leader" },
    ],
  }))

  useBindings(() => ({
    enabled: () => !commandPromptVisible(),
    bindings: [{ key: ":", cmd: "open-ex-prompt", desc: "Open ex prompt" }],
  }))

  const focusedEditorIndex = createMemo(() => {
    statusVersion()
    return editorRefs.findIndex((editor) => editor === renderer.currentFocusedEditor)
  })

  const focusedLabel = createMemo(() => {
    statusVersion()

    if (renderer.currentFocusedRenderable === commandInputRef) {
      return "Ex command prompt"
    }

    if (renderer.currentFocusedRenderable === alphaPanelRef) {
      return "Alpha panel"
    }

    if (renderer.currentFocusedRenderable === betaPanelRef) {
      return "Beta panel"
    }

    const editorIndex = focusedEditorIndex()
    if (editorIndex !== -1) {
      return `${editorSpecs[editorIndex]!.label} editor`
    }

    return "None"
  })

  const focusedColor = createMemo(() => {
    statusVersion()

    if (renderer.currentFocusedRenderable === commandInputRef) {
      return palette.leader
    }

    if (renderer.currentFocusedRenderable === alphaPanelRef) {
      return palette.alpha
    }

    if (renderer.currentFocusedRenderable === betaPanelRef) {
      return palette.beta
    }

    const editorIndex = focusedEditorIndex()
    if (editorIndex !== -1) {
      return editorSpecs[editorIndex]!.color
    }

    return palette.textMuted
  })

  const focusedEditor = createMemo(() => {
    statusVersion()
    return renderer.currentFocusedEditor
  })

  const whichKeyEntries = createMemo(() => {
    const sortedActiveKeys = [...activeKeys()].sort((left, right) => {
      return formatKeySequence([left], KEY_FORMAT_OPTIONS).localeCompare(formatKeySequence([right], KEY_FORMAT_OPTIONS))
    })

    return sortedActiveKeys.map((activeKey) => ({
      key: formatKeySequence([activeKey], KEY_FORMAT_OPTIONS),
      command: getActiveKeyLabel(activeKey),
    }))
  })

  const whichKeyPrefix = createMemo(() => {
    return formatKeySequence(pendingSequence(), KEY_FORMAT_OPTIONS) || "<root>"
  })

  const pendingSequenceLabel = createMemo(() => {
    const pending = pendingSequence()
    return pending.length === 0 ? "None" : formatKeySequence(pending, KEY_FORMAT_OPTIONS)
  })

  useBindings<InputRenderable>(() => ({
    target: commandPromptTarget,
    enabled: () => commandPromptVisible(),
    commands: [
      {
        name: "ex-prompt-close",
        run() {
          closeCommandPrompt("Closed ex prompt")
        },
      },
      {
        name: "ex-prompt-prev",
        run() {
          moveCommandPromptSelection(-1)
        },
      },
      {
        name: "ex-prompt-next",
        run() {
          moveCommandPromptSelection(1)
        },
      },
      {
        name: "ex-prompt-complete",
        run() {
          applyCommandPromptSuggestion()
        },
      },
      {
        name: "ex-prompt-complete-prev",
        run() {
          applyCommandPromptSuggestion(-1)
        },
      },
      {
        name: "ex-prompt-submit",
        run() {
          executeCommandPrompt()
        },
      },
    ],
    bindings: [
      { key: "escape", cmd: "ex-prompt-close", desc: "Close ex prompt" },
      { key: "up", cmd: "ex-prompt-prev", desc: "Previous suggestion" },
      { key: "down", cmd: "ex-prompt-next", desc: "Next suggestion" },
      { key: "tab", cmd: "ex-prompt-complete", desc: "Complete suggestion" },
      { key: "shift+tab", cmd: "ex-prompt-complete-prev", desc: "Previous completion" },
      { key: "return", cmd: "ex-prompt-submit", desc: "Run ex command" },
    ],
  }))

  const onFocusedRenderable = (focused: Renderable | null) => {
    dismissCommandPromptForFocusChange(focused)
    bumpStatus()
  }

  const onFocusedEditor = () => {
    bumpStatus()
  }

  onMount(() => {
    renderer.setBackgroundColor(palette.bg)
    renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, onFocusedRenderable)
    renderer.on(CliRenderEvents.FOCUSED_EDITOR, onFocusedEditor)
    addLog("Tab switches focus across panels and editors.")
    addLog(`${LEADER_TRIGGER_LABEL} arms the leader extension.`)
    addLog("Editors use g/gg/shift+g for Vim-style navigation.")
    addLog(": opens the centered ex prompt.")
    alphaPanelRef?.focus()
    announce("Focused Alpha panel")
  })

  onCleanup(() => {
    renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, onFocusedRenderable)
    renderer.off(CliRenderEvents.FOCUSED_EDITOR, onFocusedEditor)
    offManagedTextareas()
    offLeader()
    offNeovimDisambiguation()
    offEscapePending()
    offBackspacePending()
    offCountPattern()
    offEx()
    offExCommands()
    offCommands()
  })

  return (
    <box id="keymap-demo-root" flexDirection="column" flexGrow={1} padding={1} backgroundColor={palette.bg}>
      <box id="keymap-demo-panels" flexDirection="row" height={4}>
        <CounterPanel
          id="alpha"
          label="Alpha"
          saveTarget="alpha-panel.txt"
          step={1}
          color={palette.alpha}
          setRef={(value) => {
            alphaPanelRef = value
          }}
          count={alphaCount}
          setCount={setAlphaCount}
          announce={announce}
        />
        <CounterPanel
          id="beta"
          label="Beta"
          saveTarget="beta-panel.txt"
          step={5}
          color={palette.beta}
          setRef={(value) => {
            betaPanelRef = value
          }}
          count={betaCount}
          setCount={setBetaCount}
          announce={announce}
        />
      </box>

      <box id="keymap-demo-editors" flexDirection="row" height={5}>
        <For each={editorSpecs}>
          {(spec, index) => (
            <box
              id={`keymap-demo-editor-frame-${spec.id}`}
              border
              borderStyle="single"
              borderColor={focusedEditorIndex() === index() ? spec.color : palette.border}
              backgroundColor={palette.panel}
              flexDirection="column"
              flexGrow={1}
              flexBasis={0}
              minWidth={0}
              title={` ${index() + 1}. ${spec.label}${focusedEditorIndex() === index() ? " *" : ""} `}
              titleAlignment="left"
            >
              <textarea
                id={`keymap-demo-editor-${index() + 1}`}
                ref={(value: TextareaRenderable) => {
                  editorRefs[index()] = value
                }}
                width="100%"
                height="100%"
                initialValue={spec.initialValue}
                placeholder={spec.placeholder ?? null}
                backgroundColor={palette.surface}
                focusedBackgroundColor={palette.surfaceFocus}
                textColor={palette.text}
                focusedTextColor={palette.title}
                placeholderColor={palette.textMuted}
                selectionBg={palette.surfaceFocus}
                selectionFg={palette.text}
                wrapMode="word"
                onContentChange={() => {
                  bumpStatus()
                }}
                onCursorChange={() => {
                  bumpStatus()
                }}
              />
            </box>
          )}
        </For>
      </box>

      <box
        id="keymap-demo-footer"
        border
        borderStyle="single"
        borderColor={palette.border}
        backgroundColor={palette.panel}
        paddingX={1}
        gap={2}
        flexDirection="row"
        flexGrow={1}
        minHeight={4}
      >
        <box id="keymap-demo-details-column" flexGrow={1} minWidth={0} flexDirection="column">
          <text id="keymap-demo-status-focused" fg={palette.text} height={1}>
            <span style={{ fg: palette.textDim }}>Focused: </span>
            <span style={{ fg: focusedColor(), attributes: TextAttributes.BOLD }}>{focusedLabel()}</span>
          </text>

          <text id="keymap-demo-status-info" fg={palette.text} height={1}>
            <Show
              when={focusedEditor()}
              fallback={
                <>
                  <span style={{ fg: palette.textDim }}>Alpha: </span>
                  <span style={{ fg: palette.text }}>{String(alphaCount())}</span>
                  <span style={{ fg: palette.separator }}>{"  |  "}</span>
                  <span style={{ fg: palette.textDim }}>Beta: </span>
                  <span style={{ fg: palette.text }}>{String(betaCount())}</span>
                </>
              }
            >
              {(editor) => (
                <>
                  <span style={{ fg: palette.textDim }}>Cursor: </span>
                  <span
                    style={{ fg: palette.text }}
                  >{`${editor().logicalCursor.row + 1}:${editor().logicalCursor.col + 1}`}</span>
                  <span style={{ fg: palette.separator }}>{"  |  "}</span>
                  <span style={{ fg: palette.textDim }}>Lines: </span>
                  <span style={{ fg: palette.text }}>{String(editor().lineCount)}</span>
                  <span style={{ fg: palette.separator }}>{"  |  "}</span>
                  <span style={{ fg: palette.textDim }}>Chars: </span>
                  <span style={{ fg: palette.text }}>{String(editor().plainText.length)}</span>
                  <span style={{ fg: palette.separator }}>{"  |  "}</span>
                  <span style={{ fg: palette.textDim }}>Keys: </span>
                  <span style={{ fg: palette.command }}>{editor().traits.suspend === true ? "keymap" : "local"}</span>
                </>
              )}
            </Show>
          </text>

          <text id="keymap-demo-status-leader" fg={palette.text} height={1}>
            <span style={{ fg: palette.textDim }}>Leader: </span>
            <Show when={leaderArmed()} fallback={<span style={{ fg: palette.textMuted }}>idle</span>}>
              <span
                style={{ fg: palette.leader, attributes: TextAttributes.BOLD }}
              >{`armed (${LEADER_TRIGGER_LABEL})`}</span>
            </Show>
          </text>

          <text id="keymap-demo-status-pending" fg={palette.text} height={1}>
            <span style={{ fg: palette.textDim }}>Pending: </span>
            <span style={{ fg: palette.leader }}>{pendingSequenceLabel()}</span>
          </text>

          <text id="keymap-demo-status-last" fg={palette.text} height={1}>
            <span style={{ fg: palette.textDim }}>Last: </span>
            <span style={{ fg: palette.text }}>{lastAction()}</span>
          </text>

          <box id="keymap-demo-help" flexDirection="column" marginTop={1} visible={helpVisible()}>
            <text fg={palette.text} height={1}>
              <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>tab</span>
              <span style={{ fg: palette.textMuted }}>{" / "}</span>
              <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>shift+tab</span>
              <span style={{ fg: palette.textDim }}>: switch panels and editors</span>
            </text>
            <text fg={palette.text} height={1}>
              <span style={{ fg: palette.textDim }}>Panels use local j/k/enter. </span>
              <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>:</span>
              <span style={{ fg: palette.textDim }}> opens the ex prompt.</span>
            </text>
            <text fg={palette.text} height={1}>
              <span style={{ fg: palette.textDim }}>Editors use </span>
              <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>g</span>
              <span style={{ fg: palette.textDim }}>, </span>
              <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>gg</span>
              <span style={{ fg: palette.textDim }}>, and </span>
              <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>shift+g</span>
              <span style={{ fg: palette.textDim }}> for line, buffer, and end navigation.</span>
            </text>
          </box>

          <box id="keymap-demo-log" flexDirection="column" marginTop={1}>
            <text style={{ fg: palette.textDim, attributes: TextAttributes.BOLD }} height={1}>
              Log
            </text>
            <Show when={logs().length > 0} fallback={<text fg={palette.textMuted}>(no events yet)</text>}>
              <For each={logs()}>{(entry) => <text fg={palette.textMuted}>{entry}</text>}</For>
            </Show>
          </box>
        </box>

        <box
          id="keymap-demo-which-key-column"
          width="40%"
          minWidth={30}
          maxWidth={48}
          flexShrink={0}
          flexDirection="column"
        >
          <text id="keymap-demo-wk-header-text" fg={palette.text} height={1}>
            <span style={{ fg: palette.accent, attributes: TextAttributes.BOLD }}>Which Key</span>
            <span style={{ fg: palette.textDim }}>{`  ${whichKeyPrefix()}`}</span>
          </text>

          <scrollbox
            id="keymap-demo-wk-scrollbox"
            flexGrow={1}
            flexShrink={1}
            contentOptions={{ paddingRight: 1 }}
            verticalScrollbarOptions={{ visible: true }}
            horizontalScrollbarOptions={{ visible: false }}
          >
            <Show when={whichKeyEntries().length > 0} fallback={<text fg={palette.textMuted}>(no active keys)</text>}>
              <For each={whichKeyEntries()}>
                {(entry) => (
                  <text fg={palette.text} width="100%" wrapMode="word">
                    <span style={{ fg: palette.key, attributes: TextAttributes.BOLD }}>{entry.key}</span>
                    <span style={{ fg: palette.textMuted }}>{" -> "}</span>
                    <span style={{ fg: palette.command }}>{entry.command}</span>
                  </text>
                )}
              </For>
            </Show>
          </scrollbox>
        </box>
      </box>

      <box
        id="keymap-demo-ex-prompt-shell"
        position="absolute"
        left="50%"
        top="50%"
        width={EX_PROMPT_WIDTH}
        marginLeft={-(EX_PROMPT_WIDTH / 2)}
        marginTop={-Math.ceil(EX_PROMPT_MAX_HEIGHT / 2)}
        flexDirection="column"
        zIndex={40}
        visible={commandPromptVisible()}
      >
        <box
          id="keymap-demo-ex-prompt"
          width={EX_PROMPT_WIDTH}
          height={EX_PROMPT_CHROME_ROWS}
          border
          borderStyle="single"
          borderColor={palette.accent}
          backgroundColor={palette.surface}
          paddingX={1}
          paddingY={0}
          flexDirection="column"
          title=" Ex Command "
          titleAlignment="center"
        >
          <text id="keymap-demo-ex-prompt-hint" fg={palette.textMuted} height={1}>
            tab complete | up/down | enter | esc
          </text>
          <input
            id="keymap-demo-ex-input"
            ref={(value: InputRenderable) => {
              commandInputRef = value
              setCommandPromptTarget(value)
            }}
            width="100%"
            value={commandPromptValue()}
            placeholder=":write session.log"
            backgroundColor={palette.surface}
            focusedBackgroundColor={palette.surfaceFocus}
            textColor={palette.title}
            focusedTextColor={palette.title}
            placeholderColor={palette.textMuted}
            onInput={(value) => {
              setCommandPromptValue(value)
              setCommandPromptSelection(0)
            }}
          />
          <text
            id="keymap-demo-ex-prompt-usage"
            fg={selectedCommandPromptSuggestion() ? palette.text : palette.textMuted}
            height={1}
          >
            {commandPromptUsage()}
          </text>
        </box>
        <box
          id="keymap-demo-ex-prompt-list"
          width={EX_PROMPT_WIDTH}
          height={commandPromptSuggestionRows()}
          backgroundColor={palette.surface}
          paddingX={1}
          paddingY={0}
          flexDirection="column"
        >
          <Show
            when={commandPromptSuggestions().length > 0}
            fallback={
              <text id="keymap-demo-ex-prompt-suggestions" fg={palette.textMuted}>
                (no suggestions)
              </text>
            }
          >
            <For each={commandPromptSuggestions()}>
              {(suggestion, index) => {
                const isSelected = () =>
                  index() === Math.min(commandPromptSelection(), commandPromptSuggestions().length - 1)

                return (
                  <text
                    id={index() === 0 ? "keymap-demo-ex-prompt-suggestions" : undefined}
                    fg={palette.text}
                    height={1}
                  >
                    <span style={{ fg: isSelected() ? palette.leader : palette.textDim }}>
                      {isSelected() ? "> " : "  "}
                    </span>
                    <span
                      style={{ fg: isSelected() ? palette.title : palette.command, attributes: TextAttributes.BOLD }}
                    >
                      {suggestion.label}
                    </span>
                    <span style={{ fg: palette.separator }}>{"  "}</span>
                    <span style={{ fg: palette.textMuted }}>{suggestion.desc}</span>
                  </text>
                )
              }}
            </For>
          </Show>
        </box>
      </box>
    </box>
  )
}

export default function KeymapDemo() {
  const renderer = useRenderer()
  const keymap = createMemo(() => createDemoKeymap(renderer))

  return (
    <KeymapProvider keymap={keymap()}>
      <KeymapDemoContent />
    </KeymapProvider>
  )
}

if (import.meta.main) {
  render(KeymapDemo, {
    exitOnCtrlC: true,
    consoleOptions: {
      position: ConsolePosition.BOTTOM,
      maxStoredLogs: 1000,
      sizePercent: 40,
    },
  })
}
