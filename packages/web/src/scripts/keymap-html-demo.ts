import {
  createHtmlKeymapHost,
  createHtmlKeymapEvent,
  htmlEventMatchResolver,
  type HtmlKeymapEvent,
} from "@opentui/keymap/html"
import { Keymap, type ActiveKey, type DispatchEvent } from "@opentui/keymap"
import * as addons from "@opentui/keymap/addons"
import { getGraphSnapshot, type GraphBinding, type GraphSnapshot } from "@opentui/keymap/extras/graph"
import { formatKeySequence } from "@opentui/keymap/extras"

type HtmlGraphSnapshot = GraphSnapshot<HTMLElement, HtmlKeymapEvent>
type HtmlGraphBinding = GraphBinding<HTMLElement, HtmlKeymapEvent>
type HtmlDispatchEvent = DispatchEvent<HTMLElement, HtmlKeymapEvent>

const app = document.getElementById("app") as HTMLElement | null
const keymapRoot = document.body
const alphaPanel = document.getElementById("alpha-panel") as HTMLElement | null
const betaPanel = document.getElementById("beta-panel") as HTMLElement | null
const notesCard = document.getElementById("notes-card") as HTMLElement | null
const draftCard = document.getElementById("draft-card") as HTMLElement | null
const notesField = document.getElementById("notes-field") as HTMLTextAreaElement | null
const draftField = document.getElementById("draft-field") as HTMLTextAreaElement | null
const promptOverlay = document.getElementById("prompt-overlay") as HTMLElement | null
const promptShell = document.getElementById("prompt-shell") as HTMLElement | null
const commandInput = document.getElementById("command-input") as HTMLInputElement | null
const commandHelp = document.getElementById("command-help") as HTMLElement | null
const commandSuggestions = document.getElementById("command-suggestions") as HTMLElement | null
const leaderState = document.getElementById("leader-state") as HTMLElement | null
const pendingSequence = document.getElementById("pending-sequence") as HTMLElement | null
const focusedTarget = document.getElementById("focused-target") as HTMLElement | null
const alphaCount = document.getElementById("alpha-count") as HTMLElement | null
const betaCount = document.getElementById("beta-count") as HTMLElement | null
const graphCanvasCard = document.getElementById("graph-canvas-card") as HTMLElement | null
const graphCanvas = document.getElementById("graph-canvas") as HTMLCanvasElement | null
const logCard = document.getElementById("log-card") as HTMLElement | null
const logLines = document.getElementById("log-lines") as HTMLElement | null
const graphCard = document.getElementById("graph-card") as HTMLElement | null
const keymapGraph = document.getElementById("keymap-graph") as HTMLElement | null
const helpCard = document.getElementById("help-card") as HTMLElement | null
const helpCopy = document.getElementById("help-copy") as HTMLElement | null

if (
  !app ||
  !alphaPanel ||
  !betaPanel ||
  !notesCard ||
  !draftCard ||
  !notesField ||
  !draftField ||
  !promptOverlay ||
  !promptShell ||
  !commandInput ||
  !commandHelp ||
  !commandSuggestions ||
  !leaderState ||
  !pendingSequence ||
  !focusedTarget ||
  !alphaCount ||
  !betaCount ||
  !graphCanvasCard ||
  !graphCanvas ||
  !logCard ||
  !logLines ||
  !graphCard ||
  !keymapGraph ||
  !helpCard ||
  !helpCopy
) {
  throw new Error("HTML keymap example is missing required DOM nodes")
}

const keymap = new Keymap(createHtmlKeymapHost(keymapRoot))
addons.registerDefaultKeys(keymap)
addons.registerEnabledFields(keymap)
addons.registerMetadataFields(keymap)
keymap.prependEventMatchResolver(htmlEventMatchResolver)
const focusableTargets = [alphaPanel, betaPanel, notesField, draftField, logCard]

let alphaValue = 0
let betaValue = 0
let helpVisible = true
let graphVisible = false
let promptVisible = false
let leaderArmed = false
let promptRestoreTarget: HTMLElement | null = null
let selectedSuggestion = 0
let lastAction = "Focus a panel or textarea to begin."
let logEntries: Array<{ at: string; message: string }> = []
let graphPulses: CanvasGraphPulse[] = []
let graphPulseFrame = 0

const DEBUG_NAMESPACE = "[html-keymap-demo]"
const LEADER_TOKEN = "leader"
const COUNT_PATTERN = "count"
const KEY_FORMAT_OPTIONS = {
  tokenDisplay: {
    [LEADER_TOKEN]: "space",
  },
} as const
const LEADER_TRIGGER_LABEL = KEY_FORMAT_OPTIONS.tokenDisplay[LEADER_TOKEN]

function summarizeActiveKeys(keys: readonly ActiveKey[]): string[] {
  return keys.map((entry) => {
    const summary = entry.continues ? "prefix" : typeof entry.command === "string" ? entry.command : "fn"
    return `${formatKeySequence([entry], KEY_FORMAT_OPTIONS)}:${summary}`
  })
}

function getCountPayload(payload: unknown): number {
  if (!payload || typeof payload !== "object") {
    return 1
  }

  const count = (payload as { count?: unknown }).count
  return typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 1
}

function debug(label: string, details?: Record<string, unknown>): void {
  if (details) {
    console.groupCollapsed(`${DEBUG_NAMESPACE} ${label}`)
    console.table(details)
    console.groupEnd()
    return
  }

  console.log(`${DEBUG_NAMESPACE} ${label}`)
}

function debugKeyEvent(phase: "keydown" | "keyup", event: KeyboardEvent): void {
  const normalized = createHtmlKeymapEvent(event)
  debug(`${phase} ${event.key}`, {
    rawKey: event.key,
    code: event.code,
    target: event.target instanceof HTMLElement ? event.target.id || event.target.tagName.toLowerCase() : "unknown",
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
    meta: event.metaKey,
    repeat: event.repeat,
    cancelable: event.cancelable,
    defaultPrevented: event.defaultPrevented,
    normalizedName: normalized.name,
    normalizedCtrl: normalized.ctrl,
    normalizedShift: normalized.shift,
    normalizedMeta: normalized.meta,
    normalizedSuper: normalized.super,
    focused: getCurrentFocusedTarget()?.id ?? "none",
    activeKeys: summarizeActiveKeys(keymap.getActiveKeys({ includeMetadata: true })).join(", ") || "none",
    pending: formatKeySequence(keymap.getPendingSequence(), KEY_FORMAT_OPTIONS) || "none",
    promptVisible,
  })
}

interface ExSuggestion {
  label: string
  insert: string
  usage: string
  desc: string
  expectsArgs: boolean
}

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

function getCommandNargs(record: ReturnType<typeof keymap.getCommands>[number]): string | undefined {
  const value = record.nargs
  if (value === "0" || value === "1" || value === "?" || value === "*" || value === "+") {
    return value
  }

  return undefined
}

function buildCommandSuggestions(): ExSuggestion[] {
  const records = keymap.getCommands({ namespace: "excommands" })
  return records.map((record) => {
    const label = normalizeExPromptName(record.name)
    const usage = getText(record.usage) ?? label
    const desc = getText(record.desc) ?? ""

    return {
      label,
      insert: label,
      usage,
      desc,
      expectsArgs: getCommandNargs(record) !== "0",
    }
  })
}

function appendLog(message: string): void {
  lastAction = message
  logEntries = [{ at: new Date().toLocaleTimeString(), message }, ...logEntries].slice(0, 40)
  console.log(`${DEBUG_NAMESPACE} action`, message)
  renderLog()
}

function getCurrentFocusedTarget(): HTMLElement | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) {
    return null
  }

  if (active === app || app.contains(active)) {
    return active
  }

  return null
}

function focusOffset(delta: number): void {
  const current = getCurrentFocusedTarget()
  const currentIndex = focusableTargets.findIndex((target) => target === current)
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + delta + focusableTargets.length) % focusableTargets.length
  debug("focus offset", {
    delta,
    current: current?.id ?? "none",
    next: focusableTargets[nextIndex]?.id ?? "none",
  })
  focusableTargets[nextIndex]?.focus()
}

function getScrollablePane(target: HTMLElement | null): HTMLElement | null {
  if (target === logCard) {
    return logLines
  }

  return null
}

function scrollFocusedPane(delta: number): boolean {
  const pane = getScrollablePane(getCurrentFocusedTarget())
  if (!pane) {
    return false
  }

  const lineHeight = Number.parseFloat(getComputedStyle(pane).lineHeight)
  const fallbackStep = 48
  const step = Number.isFinite(lineHeight) ? Math.max(24, lineHeight * 3) : fallbackStep
  pane.scrollBy({ top: delta * step, behavior: "auto" })
  return true
}

function scrollFocusedPanePage(delta: number): boolean {
  const pane = getScrollablePane(getCurrentFocusedTarget())
  if (!pane) {
    return false
  }

  pane.scrollBy({ top: delta * Math.max(48, pane.clientHeight * 0.85), behavior: "auto" })
  return true
}

function scrollFocusedPaneEdge(position: "top" | "bottom"): boolean {
  const pane = getScrollablePane(getCurrentFocusedTarget())
  if (!pane) {
    return false
  }

  pane.scrollTo({ top: position === "top" ? 0 : pane.scrollHeight, behavior: "auto" })
  return true
}

function setPromptVisible(visible: boolean): void {
  promptVisible = visible
  app.classList.toggle("prompt-open", visible)
  promptOverlay.classList.toggle("is-hidden", !visible)
}

function getText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }

  return trimmed
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      default:
        return "&quot;"
    }
  })
}

function getTargetLabel(target: HTMLElement | undefined): string {
  if (!target) {
    return "root"
  }

  if (target.id) {
    return `#${target.id}`
  }

  return target.tagName.toLowerCase()
}

function getGraphLayerLabel(layer: HtmlGraphSnapshot["layers"][number]): string {
  return getText(layer.attrs?.name) ?? `L${layer.order}`
}

function getReasonLabel(reasons: readonly string[]): string {
  return reasons.length === 0 ? "ready" : reasons.join(" + ")
}

function getBindingCommandLabel(binding: HtmlGraphBinding, snapshot: HtmlGraphSnapshot): string {
  const resolved = binding.commandIds
    .map((id) => snapshot.commands.find((command) => command.id === id)?.name)
    .filter((name): name is string => !!name)

  if (typeof binding.command === "string") {
    return resolved.length === 0 ? binding.command : `${binding.command} -> ${resolved.join(" -> ")}`
  }

  if (typeof binding.command === "function") {
    return "inline fn"
  }

  return "prefix"
}

function getBindingDescription(binding: HtmlGraphBinding): string {
  return (
    getText(binding.attrs?.desc) ??
    getText(binding.commandAttrs?.title) ??
    getText(binding.commandAttrs?.desc) ??
    getReasonLabel(binding.inactiveReasons)
  )
}

function getGraphBindingLabel(binding: HtmlGraphBinding): string {
  return formatKeySequence(binding.sequence, KEY_FORMAT_OPTIONS) || "bind"
}

function getPatternPayloadLabel(binding: HtmlGraphBinding): string | undefined {
  const keys = new Set<string>()
  for (const part of binding.sequence) {
    if (part.payloadKey) {
      keys.add(part.payloadKey)
    }
  }

  return keys.size > 0 ? [...keys].join(", ") : undefined
}

function getCapturedPatternLabel(snapshot: HtmlGraphSnapshot, patternName: string): string | undefined {
  const parts = snapshot.pendingSequence.filter((part) => part.patternName === patternName)
  return parts.length > 0 ? formatKeySequence(parts, KEY_FORMAT_OPTIONS) : undefined
}

function getGraphBindingKey(binding: HtmlGraphBinding): string {
  let key = binding.event
  for (const part of binding.sequence) {
    key += ":" + part.match.length + ":" + part.match
  }

  return key
}

interface SequencePartLike {
  match: string
  tokenName?: string
  patternName?: string
}

function isPatternPart(part: { patternName?: string } | undefined): boolean {
  return !!part?.patternName
}

function bindingHasPattern(binding: HtmlGraphBinding): boolean {
  return binding.sequence.some((part) => isPatternPart(part))
}

function sequencePartMatchesPattern(patternName: string, part: SequencePartLike | undefined): boolean {
  return part?.patternName === patternName
}

interface CanvasGraphNode {
  id: string
  x: number
  y: number
  radius: number
  label: string
  kind: "layer" | "binding" | "command"
  active: boolean
  reachable: boolean
  pending: boolean
  pattern: boolean
  pulse: number
}

interface CanvasBindingGroup {
  id: string
  label: string
  active: boolean
  reachable: boolean
  pending: boolean
  pattern: boolean
  pulse: number
}

interface CanvasGraphPulse {
  phase: HtmlDispatchEvent["phase"]
  layerOrder?: number
  bindingIndex?: number
  command?: string
  sequence: readonly SequencePartLike[]
  startedAt: number
  expiresAt: number
}

interface CanvasPalette {
  bg: string
  panel: string
  border: string
  comment: string
  fg: string
  blue: string
  cyan: string
  green: string
  yellow: string
  magenta: string
  red: string
}

function getCanvasPalette(): CanvasPalette {
  const styles = getComputedStyle(document.documentElement)
  const color = (name: string) => styles.getPropertyValue(name).trim()

  return {
    bg: color("--tn-bg-dark"),
    panel: color("--tn-bg-panel"),
    border: color("--tn-border"),
    comment: color("--tn-comment"),
    fg: color("--tn-fg"),
    blue: color("--tn-blue"),
    cyan: color("--tn-cyan"),
    green: color("--tn-green"),
    yellow: color("--tn-yellow"),
    magenta: color("--tn-magenta"),
    red: color("--tn-red"),
  }
}

function sequenceMatchesPrefix(sequence: readonly SequencePartLike[], prefix: readonly SequencePartLike[]): boolean {
  if (prefix.length === 0) {
    return false
  }

  let sequenceIndex = 0
  let prefixIndex = 0
  while (prefixIndex < prefix.length && sequenceIndex < sequence.length) {
    const sequencePart = sequence[sequenceIndex]
    const prefixPart = prefix[prefixIndex]
    const patternName = sequencePart?.patternName

    if (patternName) {
      let consumed = 0
      while (prefixIndex < prefix.length && sequencePartMatchesPattern(patternName, prefix[prefixIndex])) {
        consumed += 1
        prefixIndex += 1
      }

      if (consumed === 0) {
        return false
      }

      sequenceIndex += 1
      continue
    }

    if (sequencePart?.match !== prefixPart?.match) {
      return false
    }

    sequenceIndex += 1
    prefixIndex += 1
  }

  return prefixIndex === prefix.length
}

function sequenceMatchesExact(left: readonly SequencePartLike[], right: readonly SequencePartLike[]): boolean {
  if (left.length !== right.length) {
    return false
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.match !== right[index]?.match) {
      return false
    }
  }

  return true
}

function getPulseValue(pulse: CanvasGraphPulse, now: number): number {
  if (now >= pulse.expiresAt) {
    return 0
  }

  const duration = pulse.expiresAt - pulse.startedAt
  if (duration <= 0) {
    return 0
  }

  return Math.max(0, Math.min(1, (pulse.expiresAt - now) / duration))
}

function getLayerPulse(layerOrder: number, now: number): number {
  let pulseValue = 0
  for (const pulse of graphPulses) {
    if (pulse.layerOrder !== layerOrder) {
      continue
    }

    pulseValue = Math.max(pulseValue, getPulseValue(pulse, now))
  }

  return pulseValue
}

function getBindingPulse(binding: HtmlGraphBinding, now: number): number {
  let pulseValue = 0
  for (const pulse of graphPulses) {
    if (pulse.layerOrder !== binding.sourceLayerOrder) {
      continue
    }

    if (pulse.bindingIndex !== undefined && pulse.bindingIndex !== binding.bindingIndex) {
      continue
    }

    if (
      !sequenceMatchesExact(binding.sequence, pulse.sequence) &&
      !sequenceMatchesPrefix(binding.sequence, pulse.sequence)
    ) {
      continue
    }

    pulseValue = Math.max(pulseValue, getPulseValue(pulse, now))
  }

  return pulseValue
}

function getCommandPulse(command: HtmlGraphSnapshot["commands"][number], now: number): number {
  let pulseValue = 0
  for (const pulse of graphPulses) {
    if (pulse.command !== command.name) {
      continue
    }

    pulseValue = Math.max(pulseValue, getPulseValue(pulse, now))
  }

  return pulseValue
}

function scheduleGraphPulseFrame(): void {
  if (graphPulseFrame !== 0) {
    return
  }

  graphPulseFrame = window.requestAnimationFrame(() => {
    graphPulseFrame = 0
    renderGraphCanvas(getGraphSnapshot(keymap))
  })
}

function addGraphPulse(event: HtmlDispatchEvent): void {
  const now = performance.now()
  const command = typeof event.command === "string" ? event.command : undefined
  graphPulses = [
    ...graphPulses.filter((pulse) => pulse.expiresAt > now),
    {
      phase: event.phase,
      layerOrder: event.layer?.order,
      bindingIndex: event.binding?.bindingIndex,
      command,
      sequence: event.sequence.map((part) => ({
        match: part.match,
        tokenName: part.tokenName,
        patternName: part.patternName,
      })),
      startedAt: now,
      expiresAt: now + (event.phase === "binding-reject" ? 900 : 650),
    },
  ]
  scheduleGraphPulseFrame()
}

function drawCanvasLine(
  ctx: CanvasRenderingContext2D,
  from: CanvasGraphNode,
  to: CanvasGraphNode,
  color: string,
  alpha: number,
  width: number,
  pulseOverride?: number,
): void {
  const pulse = pulseOverride ?? Math.max(from.pulse, to.pulse)
  ctx.save()
  ctx.globalAlpha = Math.min(1, alpha + pulse * 0.55)
  ctx.strokeStyle = color
  ctx.lineWidth = width + pulse * 3
  ctx.beginPath()
  ctx.moveTo(from.x + from.radius, from.y)
  const midX = (from.x + to.x) / 2
  ctx.bezierCurveTo(midX, from.y, midX, to.y, to.x - to.radius, to.y)
  ctx.stroke()
  ctx.restore()
}

function getCanvasNodeColor(node: CanvasGraphNode, palette: CanvasPalette): string {
  return node.pending
    ? palette.yellow
    : node.kind === "layer"
      ? palette.green
      : node.kind === "binding"
        ? node.pattern
          ? palette.blue
          : palette.cyan
        : palette.magenta
}

function drawCanvasNode(ctx: CanvasRenderingContext2D, node: CanvasGraphNode, palette: CanvasPalette): void {
  const color = getCanvasNodeColor(node, palette)
  const alpha = node.reachable ? 1 : node.active ? 0.62 : 0.25

  ctx.save()
  ctx.globalAlpha = Math.min(1, alpha + node.pulse * 0.7)
  ctx.fillStyle = palette.bg
  ctx.strokeStyle = node.pulse > 0 ? (node.kind === "binding" ? palette.yellow : color) : color
  ctx.lineWidth = node.pending ? 2.2 : 1.4 + node.pulse * 3
  ctx.beginPath()
  ctx.arc(node.x, node.y, node.radius + node.pulse * 3, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()

  if (node.reachable || node.pending || node.pulse > 0) {
    ctx.globalAlpha = 0.18 + node.pulse * 0.28
    ctx.fillStyle = node.pulse > 0 ? palette.yellow : color
    ctx.beginPath()
    ctx.arc(node.x, node.y, node.radius + 5 + node.pulse * 12, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.restore()
}

function drawCanvasNodeLabel(ctx: CanvasRenderingContext2D, node: CanvasGraphNode, palette: CanvasPalette): void {
  const label = node.label.slice(0, 12)
  const labelX = node.kind === "command" ? node.x - node.radius - 5 : node.x + node.radius + 5

  ctx.save()
  ctx.font = "10px JetBrains Mono, Fira Code, monospace"
  ctx.textAlign = node.kind === "command" ? "right" : "left"
  ctx.textBaseline = "middle"
  ctx.globalAlpha = node.reachable || node.pending || node.pulse > 0 ? 1 : 0.58
  ctx.fillStyle = node.pending ? palette.yellow : palette.fg
  ctx.fillText(label, labelX, node.y)
  ctx.restore()
}

function renderGraphCanvas(snapshot: HtmlGraphSnapshot): void {
  const now = performance.now()
  graphPulses = graphPulses.filter((pulse) => pulse.expiresAt > now)
  const rect = graphCanvas.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    return
  }

  const dpr = Math.max(1, window.devicePixelRatio || 1)
  const width = Math.floor(rect.width)
  const height = Math.floor(rect.height)
  graphCanvas.width = Math.floor(width * dpr)
  graphCanvas.height = Math.floor(height * dpr)

  const ctx = graphCanvas.getContext("2d")
  if (!ctx) {
    return
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const palette = getCanvasPalette()
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = palette.bg
  ctx.fillRect(0, 0, width, height)

  ctx.save()
  ctx.globalAlpha = 0.35
  ctx.strokeStyle = palette.border
  ctx.lineWidth = 1
  for (let x = 18; x < width; x += 28) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }
  for (let y = 18; y < height; y += 28) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }
  ctx.restore()

  const top = 28
  const bottom = height - 28
  const graphHeight = Math.max(1, bottom - top)
  const layerX = 30
  const bindingX = Math.max(92, width * 0.48)
  const commandX = Math.max(bindingX + 68, width - 40)
  const layerNodes = new Map<string, CanvasGraphNode>()
  const bindingNodes = new Map<string, CanvasGraphNode>()
  const commandNodes = new Map<string, CanvasGraphNode>()
  const visibleBindings = [...snapshot.bindings].sort((left, right) => {
    if (left.reachable !== right.reachable) return left.reachable ? -1 : 1
    if (left.active !== right.active) return left.active ? -1 : 1
    return getGraphBindingLabel(left).localeCompare(getGraphBindingLabel(right))
  })
  const bindingGroups = new Map<string, CanvasBindingGroup>()
  const bindingKeys = new Map<string, string>()

  for (const binding of visibleBindings) {
    const key = getGraphBindingKey(binding)
    bindingKeys.set(binding.id, key)
    const pending = sequenceMatchesPrefix(binding.sequence, snapshot.pendingSequence)
    const pulse = getBindingPulse(binding, now)
    const existing = bindingGroups.get(key)

    if (existing) {
      existing.active ||= binding.active
      existing.reachable ||= binding.reachable
      existing.pending ||= pending
      existing.pattern ||= bindingHasPattern(binding)
      existing.pulse = Math.max(existing.pulse, pulse)
      continue
    }

    bindingGroups.set(key, {
      id: `binding:${key}`,
      label: getGraphBindingLabel(binding),
      active: binding.active,
      reachable: binding.reachable,
      pending,
      pattern: bindingHasPattern(binding),
      pulse,
    })
  }
  const visibleBindingGroups = [...bindingGroups]

  snapshot.layers.forEach((layer, index) => {
    const y = top + (graphHeight * (index + 0.5)) / Math.max(1, snapshot.layers.length)
    layerNodes.set(layer.id, {
      id: layer.id,
      x: layerX,
      y,
      radius: 8,
      label: getGraphLayerLabel(layer),
      kind: "layer",
      active: layer.active,
      reachable: layer.active,
      pending: false,
      pattern: false,
      pulse: getLayerPulse(layer.order, now),
    })
  })

  visibleBindingGroups.forEach(([key, group], index) => {
    const y = top + (graphHeight * (index + 0.5)) / Math.max(1, visibleBindingGroups.length)
    bindingNodes.set(key, {
      id: group.id,
      x: bindingX,
      y,
      radius: group.reachable ? 6 : 4.5,
      label: group.label,
      kind: "binding",
      active: group.active,
      reachable: group.reachable,
      pending: group.pending,
      pattern: group.pattern,
      pulse: group.pulse,
    })
  })

  snapshot.commands.forEach((command, index) => {
    const y = top + (graphHeight * (index + 0.5)) / Math.max(1, snapshot.commands.length)
    commandNodes.set(command.id, {
      id: command.id,
      x: commandX,
      y,
      radius: command.reachable ? 6.5 : 4.5,
      label: command.name.replace(/^:/, ""),
      kind: "command",
      active: command.active,
      reachable: command.reachable,
      pending: false,
      pattern: false,
      pulse: getCommandPulse(command, now),
    })
  })

  for (const binding of visibleBindings) {
    const layer = layerNodes.get(binding.layerId)
    const bindingNodeKey = bindingKeys.get(binding.id)
    const bindingNode = bindingNodeKey ? bindingNodes.get(bindingNodeKey) : undefined
    if (!layer || !bindingNode) {
      continue
    }

    const bindingPending = sequenceMatchesPrefix(binding.sequence, snapshot.pendingSequence)
    drawCanvasLine(
      ctx,
      layer,
      bindingNode,
      bindingPending ? palette.yellow : bindingHasPattern(binding) ? palette.blue : palette.cyan,
      binding.reachable ? 0.68 : 0.16,
      1.2,
      Math.max(layer.pulse, getBindingPulse(binding, now)),
    )

    for (const commandId of binding.commandIds) {
      const commandNode = commandNodes.get(commandId)
      if (!commandNode) {
        continue
      }

      drawCanvasLine(
        ctx,
        bindingNode,
        commandNode,
        binding.reachable && commandNode.reachable ? palette.green : palette.comment,
        binding.reachable && commandNode.reachable ? 0.72 : 0.12,
        binding.reachable && commandNode.reachable ? 1.6 : 1,
        Math.max(getBindingPulse(binding, now), commandNode.pulse),
      )
    }
  }

  const allNodes = [...layerNodes.values(), ...bindingNodes.values(), ...commandNodes.values()]
  for (const node of allNodes) {
    drawCanvasNode(ctx, node, palette)
  }

  ctx.save()
  ctx.fillStyle = palette.comment
  ctx.font = "10px JetBrains Mono, Fira Code, monospace"
  ctx.textAlign = "left"
  ctx.textBaseline = "top"
  ctx.fillText("layers", 8, 8)
  ctx.textAlign = "center"
  ctx.fillText("bindings", bindingX, 8)
  ctx.textAlign = "right"
  ctx.fillText("commands", width - 8, 8)
  ctx.restore()

  for (const node of allNodes) {
    drawCanvasNodeLabel(ctx, node, palette)
  }

  if (graphPulses.length > 0) {
    scheduleGraphPulseFrame()
  }
}

function getCommandSuggestions(): ExSuggestion[] {
  const normalized = normalizeExPromptName(commandInput.value)
  const spaceIndex = normalized.indexOf(" ")
  const query = spaceIndex === -1 ? normalized : normalized.slice(0, spaceIndex)
  const suggestions = buildCommandSuggestions()

  if (query === ":") {
    return suggestions.slice(0, 6)
  }

  return suggestions.filter((suggestion) => suggestion.label.startsWith(query)).slice(0, 6)
}

function applySuggestion(delta: number): void {
  const suggestions = getCommandSuggestions()
  if (suggestions.length === 0) {
    return
  }

  selectedSuggestion = (selectedSuggestion + delta + suggestions.length) % suggestions.length
  renderPrompt()
}

function completeSuggestion(direction?: 1 | -1): void {
  const suggestions = getCommandSuggestions()
  if (suggestions.length === 0) {
    return
  }

  const nextSelection = direction
    ? (selectedSuggestion + direction + suggestions.length) % suggestions.length
    : Math.min(selectedSuggestion, suggestions.length - 1)
  const suggestion = suggestions[nextSelection]
  if (!suggestion) {
    return
  }

  const normalized = normalizeExPromptName(commandInput.value)
  const spaceIndex = normalized.indexOf(" ")
  const rest = spaceIndex === -1 ? "" : normalized.slice(spaceIndex + 1).trimStart()
  const nextValue = rest
    ? `${suggestion.insert} ${rest}`
    : suggestion.expectsArgs
      ? `${suggestion.insert} `
      : suggestion.insert

  commandInput.value = nextValue
  selectedSuggestion = nextSelection
  commandInput.setSelectionRange(commandInput.value.length, commandInput.value.length)
  renderPrompt()
}

function openPrompt(): void {
  if (promptVisible) {
    debug("prompt already open", {
      focused: getCurrentFocusedTarget()?.id ?? "none",
    })
    commandInput.focus()
    return
  }

  promptRestoreTarget = getCurrentFocusedTarget()
  selectedSuggestion = 0
  commandInput.value = ":"
  setPromptVisible(true)
  commandInput.focus()
  commandInput.setSelectionRange(commandInput.value.length, commandInput.value.length)
  appendLog("Opened ex prompt")
  debug("prompt opened", {
    restoreTarget: promptRestoreTarget?.id ?? "none",
    focused: getCurrentFocusedTarget()?.id ?? "none",
  })
  renderPrompt()
  renderAll()
}

function closePrompt(): void {
  if (!promptVisible) {
    return
  }

  setPromptVisible(false)
  selectedSuggestion = 0
  commandInput.value = ":"

  if (promptRestoreTarget && document.contains(promptRestoreTarget)) {
    promptRestoreTarget.focus()
  }

  promptRestoreTarget = null
  appendLog("Closed ex prompt")
  debug("prompt closed", {
    focused: getCurrentFocusedTarget()?.id ?? "none",
  })
  renderPrompt()
  renderAll()
}

function runPromptCommand(): void {
  const parsed = parseExPromptInput(commandInput.value)
  if (!parsed) {
    closePrompt()
    return
  }

  debug("run prompt command", {
    command: parsed.raw,
    focused:
      (promptRestoreTarget && document.contains(promptRestoreTarget) ? promptRestoreTarget : getCurrentFocusedTarget())
        ?.id ?? "none",
  })

  const focused =
    promptRestoreTarget && document.contains(promptRestoreTarget) ? promptRestoreTarget : getCurrentFocusedTarget()
  const result = keymap.dispatchCommand(parsed.raw, { focused })
  if (result.ok) {
    appendLog(`Ran ${parsed.raw}`)
    closePrompt()
    return
  }

  appendLog(`Command failed: ${parsed.raw} (${result.reason})`)
  renderPrompt()
}

function saveSnapshot(label: string): void {
  appendLog(
    `${label}: alpha=${alphaValue}, beta=${betaValue}, notes=${notesField.value.length} chars, draft=${draftField.value.length} chars`,
  )
}

function resetDemo(): void {
  alphaValue = 0
  betaValue = 0
  renderCounters()
  appendLog("Reset counters")
  renderAll()
}

function toggleHelp(): void {
  helpVisible = !helpVisible
  helpCard.classList.toggle("is-hidden", !helpVisible)
  appendLog(helpVisible ? "Help opened" : "Help hidden")
}

function toggleGraph(): void {
  graphVisible = !graphVisible
  graphCard.classList.toggle("is-hidden", !graphVisible)
  appendLog(graphVisible ? "Graph opened" : "Graph hidden")
}

function incrementAlpha(delta: number): void {
  alphaValue += delta
  renderCounters()
  appendLog(`Alpha ${delta > 0 ? "incremented" : "decremented"} to ${alphaValue}`)
}

function incrementBeta(delta: number): void {
  betaValue += delta
  renderCounters()
  appendLog(`Beta ${delta > 0 ? "incremented" : "decremented"} to ${betaValue}`)
}

function captureTextarea(name: string, field: HTMLTextAreaElement): void {
  appendLog(`${name}: ${field.value.split(/\n+/)[0] ?? ""}`)
}

function renderCounters(): void {
  alphaCount.textContent = String(alphaValue)
  betaCount.textContent = String(betaValue)
}

function renderStatus(): void {
  leaderState.textContent = leaderArmed ? "Armed" : "Idle"

  const pending = keymap.getPendingSequence()
  pendingSequence.textContent = pending.length === 0 ? "None" : formatKeySequence(pending, KEY_FORMAT_OPTIONS)

  const focused = getCurrentFocusedTarget()
  focusedTarget.textContent = focused?.id ?? "None"
}

function renderGraph(): void {
  graphCard.classList.toggle("is-hidden", !graphVisible)
  const snapshot = getGraphSnapshot(keymap)
  renderGraphCanvas(snapshot)
  graphCard.dataset.activeLayers = String(snapshot.layers.filter((layer) => layer.active).length)
  const activeView = snapshot.activeKeys
    .map((key) => {
      const label = escapeHtml(formatKeySequence([key], KEY_FORMAT_OPTIONS))
      return `<span class="graph-chip is-active">${label}${key.continues ? " ..." : ""}</span>`
    })
    .join("")
  const pendingPath = snapshot.sequenceNodes
    .filter((node) => node.pendingPath && node.depth > 0)
    .map((node) => {
      const label = escapeHtml(formatKeySequence(node.sequence, KEY_FORMAT_OPTIONS) || node.display)
      const patternName = node.sequence.at(-1)?.patternName
      const captured = patternName ? getCapturedPatternLabel(snapshot, patternName) : undefined
      const pendingClass = node.pending ? " graph-chip is-pending" : " graph-chip is-path"
      return `<span class="${pendingClass.trim()}">${label}${captured ? ` <em>${escapeHtml(captured)}</em>` : ""}</span>`
    })
    .join("")

  const layerHtml = snapshot.layers
    .map((layer) => {
      const layerClass = layer.active ? "graph-layer is-active" : "graph-layer is-inactive"
      const commands = layer.commandIds
        .map((id) => snapshot.commands.find((command) => command.id === id))
        .filter((command): command is HtmlGraphSnapshot["commands"][number] => !!command)
      const bindings = layer.bindingIds
        .map((id) => snapshot.bindings.find((binding) => binding.id === id))
        .filter((binding): binding is HtmlGraphBinding => !!binding)
      const nodes = snapshot.sequenceNodes.filter((node) => node.layerId === layer.id && node.depth > 0)
      const targetLabel = escapeHtml(getTargetLabel(layer.target))
      const reasonLabel = escapeHtml(getReasonLabel(layer.inactiveReasons))
      const commandHtml = commands
        .map((command) => {
          const commandClass = command.reachable ? "graph-command is-reachable" : "graph-command is-dimmed"
          const title = getText(command.attrs?.title) ?? getText(command.fields.title) ?? command.name
          return `<span class="${commandClass}">${escapeHtml(command.name)}<small>${escapeHtml(title)}</small></span>`
        })
        .join("")
      const bindingHtml = bindings
        .map((binding) => {
          const bindingClass = `${
            binding.reachable
              ? "graph-binding is-reachable"
              : binding.active
                ? "graph-binding is-shadowed"
                : "graph-binding is-inactive"
          }${bindingHasPattern(binding) ? " is-pattern" : ""}`
          const label = escapeHtml(formatKeySequence(binding.sequence, KEY_FORMAT_OPTIONS))
          const command = escapeHtml(getBindingCommandLabel(binding, snapshot))
          const payloadLabel = getPatternPayloadLabel(binding)
          const description = escapeHtml(
            payloadLabel
              ? `${getBindingDescription(binding)} · payload: ${payloadLabel}`
              : getBindingDescription(binding),
          )
          return `
            <div class="${bindingClass}">
              <kbd>${label}</kbd>
              <span>${command}</span>
              <small>${description}</small>
            </div>
          `
        })
        .join("")
      const nodeHtml = nodes
        .map((node) => {
          const patternName = node.sequence.at(-1)?.patternName
          const captured = patternName ? getCapturedPatternLabel(snapshot, patternName) : undefined
          const nodeClass = `${
            node.pending ? "graph-node is-pending" : node.reachable ? "graph-node is-reachable" : "graph-node is-dimmed"
          }${patternName ? " is-pattern" : ""}`
          const label = escapeHtml(formatKeySequence(node.sequence, KEY_FORMAT_OPTIONS) || node.display)
          return `<span class="${nodeClass}">${label}${captured ? `<small>${escapeHtml(captured)}</small>` : ""}</span>`
        })
        .join("")

      return `
        <article class="${layerClass}">
          <div class="graph-layer-title">
            <strong>${escapeHtml(getGraphLayerLabel(layer))}</strong>
            <span>${targetLabel}</span>
            <em>${reasonLabel}</em>
          </div>
          <div class="graph-row"><b>keys</b><div>${nodeHtml || '<span class="graph-empty">none</span>'}</div></div>
          <div class="graph-row"><b>bindings</b><div>${bindingHtml || '<span class="graph-empty">none</span>'}</div></div>
          <div class="graph-row"><b>commands</b><div>${commandHtml || '<span class="graph-empty">none</span>'}</div></div>
        </article>
      `
    })
    .join("")

  keymapGraph.innerHTML = `
    <div class="graph-current">
      <div><span>focused</span><strong>${escapeHtml(getTargetLabel(snapshot.focused ?? undefined))}</strong></div>
      <div><span>pending path</span><div>${pendingPath || '<span class="graph-chip is-dimmed">none</span>'}</div></div>
      <div><span>active view</span><div>${activeView || '<span class="graph-chip is-dimmed">none</span>'}</div></div>
    </div>
    <div class="graph-layers">${layerHtml}</div>
  `
}

function renderLog(): void {
  logLines.innerHTML = logEntries
    .map((entry) => {
      return `<div class="log-line"><time>${entry.at}</time><div>${entry.message}</div></div>`
    })
    .join("")
}

function renderPrompt(): void {
  if (!promptVisible) {
    commandHelp.textContent = "Prompt hidden. Press : to open it."
    commandSuggestions.innerHTML = ""
    return
  }

  const suggestions = getCommandSuggestions()
  const selected = suggestions[selectedSuggestion] ?? suggestions[0]
  if (selected && suggestions[0] && !suggestions[selectedSuggestion]) {
    selectedSuggestion = 0
  }

  commandHelp.textContent = selected
    ? `${selected.usage}${selected.desc ? ` - ${selected.desc}` : ""}`
    : "No matching ex command"
  commandSuggestions.innerHTML = suggestions
    .map((suggestion, index) => {
      const selectedClass = index === selectedSuggestion ? " suggestion is-selected" : " suggestion"
      return `
        <div class="${selectedClass.trim()}">
          <div class="suggestion-header">
            <strong>${suggestion.label}</strong>
            <span class="suggestion-usage">${suggestion.usage}</span>
          </div>
          <div class="suggestion-desc">${suggestion.desc || "No description"}</div>
        </div>
      `
    })
    .join("")
}

function renderHelp(): void {
  helpCard.classList.toggle("is-hidden", !helpVisible)
  helpCopy.innerHTML = [
    "<div><kbd>Tab</kbd> and <kbd>Shift+Tab</kbd> cycle focus between panels, textareas, and the log pane.</div>",
    `<div><kbd>${LEADER_TRIGGER_LABEL}</kbd> arms a leader sequence for <kbd>${LEADER_TRIGGER_LABEL} s</kbd>, <kbd>${LEADER_TRIGGER_LABEL} h</kbd>, and <kbd>${LEADER_TRIGGER_LABEL} r</kbd>.</div>`,
    `<div><kbd>?</kbd> toggles Quick Help; <kbd>!</kbd> or <kbd>${LEADER_TRIGGER_LABEL} g</kbd> toggles the runtime graph.</div>`,
    "<div><kbd>:</kbd> opens the ex prompt as a modal overlay. Try <kbd>:help</kbd>, <kbd>:reset</kbd>, <kbd>:write alpha</kbd>, or <kbd>:focus draft</kbd>.</div>",
    "<div>The Alpha and Beta panels each install their own focus-within layers with <kbd>j</kbd>, <kbd>k</kbd>, and <kbd>Enter</kbd>.</div>",
    "<div>Panel counters also use the generic <kbd>{count}</kbd> sequence pattern: try <kbd>5</kbd><kbd>k</kbd> or <kbd>3</kbd><kbd>j</kbd> and watch the graph show the pattern node plus captured digits.</div>",
    "<div>The Notes and Draft textareas use plain browser editing plus keymap bindings for <kbd>Ctrl+Enter</kbd>.</div>",
    "<div>The Recent Actions pane can be focused and scrolled with <kbd>j</kbd>, <kbd>k</kbd>, <kbd>Ctrl+d</kbd>, <kbd>Ctrl+u</kbd>, <kbd>g</kbd>, <kbd>gg</kbd>, and <kbd>Shift+g</kbd>.</div>",
  ].join("")
}

function renderAll(): void {
  renderCounters()
  renderStatus()
  renderGraph()
  renderPrompt()
  renderHelp()
}

function debugStateSnapshot(source: string): void {
  debug(`state ${source}`, {
    focused: getCurrentFocusedTarget()?.id ?? "none",
    promptVisible,
    leaderArmed,
    pending: formatKeySequence(keymap.getPendingSequence(), KEY_FORMAT_OPTIONS) || "none",
    activeKeys: summarizeActiveKeys(keymap.getActiveKeys({ includeMetadata: true })).join(", ") || "none",
  })
}

disposers()

function disposers(): void {
  addons.registerExCommands(keymap)
  addons.registerTimedLeader(keymap, {
    trigger: " ",
    timeoutMs: 1600,
    onArm() {
      leaderArmed = true
      renderStatus()
    },
    onDisarm() {
      leaderArmed = false
      renderStatus()
    },
  })
  addons.registerNeovimDisambiguation(keymap)
  addons.registerEscapeClearsPendingSequence(keymap)
  addons.registerBackspacePopsPendingSequence(keymap)
  keymap.registerSequencePattern({
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
  keymap.registerLayerFields({
    name(value, ctx) {
      if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error("Layer name must be a non-empty string")
      }
      ctx.attr("name", value.trim())
    },
  })

  keymap.registerLayer({
    name: "Commands",
    commands: [
      {
        name: ":help",
        desc: "Toggle the help card",
        run() {
          debug("command :help")
          toggleHelp()
        },
      },
      {
        name: ":reset",
        desc: "Reset the counters",
        run() {
          debug("command :reset")
          resetDemo()
        },
      },
      {
        name: ":write",
        aliases: ["w"],
        nargs: "?",
        desc: "Log a snapshot for the current demo state",
        usage: ":write [label]",
        run({ payload }) {
          debug("command :write", {
            args: payload.args.join(" "),
          })
          saveSnapshot(payload.args[0] ?? "write")
        },
      },
      {
        name: ":focus",
        nargs: "1",
        desc: "Focus alpha, beta, notes, draft, or log",
        usage: ":focus <alpha|beta|notes|draft|log>",
        run({ payload }) {
          debug("command :focus", {
            args: payload.args.join(" "),
          })
          const targetName = payload.args[0]?.toLowerCase()
          const targets = new Map<string, HTMLElement>([
            ["alpha", alphaPanel],
            ["beta", betaPanel],
            ["notes", notesField],
            ["draft", draftField],
            ["log", logCard],
          ])
          const target = targetName ? targets.get(targetName) : undefined
          if (!target) {
            appendLog(`Unknown focus target: ${targetName ?? ""}`)
            return false
          }

          target.focus()
          appendLog(`Focused ${target.id}`)
        },
      },
      {
        name: "focus-next",
        title: "Focus Next",
        desc: "Move to the next focus target",
        run() {
          focusOffset(1)
        },
      },
      {
        name: "focus-prev",
        title: "Focus Previous",
        desc: "Move to the previous focus target",
        run() {
          focusOffset(-1)
        },
      },
      {
        name: "toggle-help",
        title: "Toggle Help",
        desc: "Show or hide the help card",
        run() {
          toggleHelp()
        },
      },
      {
        name: "toggle-graph",
        title: "Toggle Graph",
        desc: "Show or hide the runtime keymap graph",
        run() {
          toggleGraph()
        },
      },
      {
        name: "prompt-open",
        title: "Open Ex Prompt",
        desc: "Open the ex command prompt",
        run() {
          openPrompt()
        },
      },
      {
        name: "prompt-close",
        title: "Close Ex Prompt",
        desc: "Close the ex command prompt",
        run() {
          closePrompt()
        },
      },
      {
        name: "prompt-submit",
        title: "Run Ex Command",
        desc: "Run the current ex command",
        run() {
          runPromptCommand()
        },
      },
      {
        name: "prompt-next",
        title: "Next Suggestion",
        desc: "Move to the next ex suggestion",
        run() {
          applySuggestion(1)
        },
      },
      {
        name: "prompt-prev",
        title: "Previous Suggestion",
        desc: "Move to the previous ex suggestion",
        run() {
          applySuggestion(-1)
        },
      },
      {
        name: "prompt-complete",
        title: "Complete Suggestion",
        desc: "Insert the selected ex suggestion",
        run() {
          completeSuggestion()
        },
      },
      {
        name: "prompt-complete-prev",
        title: "Previous Completion",
        desc: "Insert the previous ex suggestion",
        run() {
          completeSuggestion(-1)
        },
      },
      {
        name: "save-session",
        title: "Save Session",
        desc: "Log a synthetic write snapshot",
        run() {
          saveSnapshot("leader")
        },
      },
      {
        name: "alpha-up",
        title: "Alpha Up",
        desc: "Increment the Alpha counter",
        run() {
          incrementAlpha(1)
        },
      },
      {
        name: "alpha-up-count",
        title: "Alpha Up Count",
        desc: "Increment Alpha by a captured count",
        run({ payload }) {
          incrementAlpha(getCountPayload(payload))
        },
      },
      {
        name: "alpha-down",
        title: "Alpha Down",
        desc: "Decrement the Alpha counter",
        run() {
          incrementAlpha(-1)
        },
      },
      {
        name: "alpha-down-count",
        title: "Alpha Down Count",
        desc: "Decrement Alpha by a captured count",
        run({ payload }) {
          incrementAlpha(-getCountPayload(payload))
        },
      },
      {
        name: "beta-up",
        title: "Beta Up",
        desc: "Increment the Beta counter",
        run() {
          incrementBeta(1)
        },
      },
      {
        name: "beta-up-count",
        title: "Beta Up Count",
        desc: "Increment Beta by a captured count",
        run({ payload }) {
          incrementBeta(getCountPayload(payload))
        },
      },
      {
        name: "beta-down",
        title: "Beta Down",
        desc: "Decrement the Beta counter",
        run() {
          incrementBeta(-1)
        },
      },
      {
        name: "beta-down-count",
        title: "Beta Down Count",
        desc: "Decrement Beta by a captured count",
        run({ payload }) {
          incrementBeta(-getCountPayload(payload))
        },
      },
      {
        name: "panel-write",
        title: "Panel Write",
        desc: "Log a panel write action",
        run(ctx) {
          appendLog(`Panel write from ${ctx.focused?.id ?? "unknown"}`)
        },
      },
      {
        name: "capture-notes",
        title: "Capture Notes",
        desc: "Log the Notes textarea snapshot",
        run() {
          captureTextarea("notes", notesField)
        },
      },
      {
        name: "capture-draft",
        title: "Capture Draft",
        desc: "Log the Draft textarea snapshot",
        run() {
          captureTextarea("draft", draftField)
        },
      },
      {
        name: "scroll-pane-down",
        title: "Scroll Pane Down",
        desc: "Scroll the focused sidebar pane down",
        run() {
          return scrollFocusedPane(1)
        },
      },
      {
        name: "scroll-pane-up",
        title: "Scroll Pane Up",
        desc: "Scroll the focused sidebar pane up",
        run() {
          return scrollFocusedPane(-1)
        },
      },
      {
        name: "scroll-pane-page-down",
        title: "Scroll Pane Page Down",
        desc: "Page the focused sidebar pane downward",
        run() {
          return scrollFocusedPanePage(1)
        },
      },
      {
        name: "scroll-pane-page-up",
        title: "Scroll Pane Page Up",
        desc: "Page the focused sidebar pane upward",
        run() {
          return scrollFocusedPanePage(-1)
        },
      },
      {
        name: "scroll-pane-top",
        title: "Scroll Pane Top",
        desc: "Jump the focused sidebar pane to the top",
        run() {
          return scrollFocusedPaneEdge("top")
        },
      },
      {
        name: "scroll-pane-bottom",
        title: "Scroll Pane Bottom",
        desc: "Jump the focused sidebar pane to the bottom",
        run() {
          return scrollFocusedPaneEdge("bottom")
        },
      },
    ],
  })

  keymap.registerLayer({
    name: "Global",
    enabled: () => !promptVisible,
    bindings: [
      { key: "tab", cmd: "focus-next", desc: "Next focus target" },
      { key: "shift+tab", cmd: "focus-prev", desc: "Previous focus target" },
      { key: "?", cmd: "toggle-help", desc: "Toggle help" },
      { key: "!", cmd: "toggle-graph", desc: "Toggle runtime graph" },
      { key: ":", cmd: "prompt-open", desc: "Open ex prompt" },
      { key: "<leader>s", cmd: "save-session", desc: "Log a write snapshot" },
      { key: "<leader>h", cmd: "toggle-help", desc: "Toggle help" },
      { key: "<leader>g", cmd: "toggle-graph", desc: "Toggle runtime graph" },
      { key: "<leader>r", cmd: ":reset", desc: "Reset counters" },
      { key: "<leader>f", cmd: ":focus notes", desc: "Focus the notes editor" },
    ],
  })

  keymap.registerLayer({
    name: "Alpha",
    target: alphaPanel,
    targetMode: "focus-within",
    bindings: [
      { key: "j", cmd: "alpha-down", desc: "Alpha -1" },
      { key: "k", cmd: "alpha-up", desc: "Alpha +1" },
      { key: "{count}j", cmd: "alpha-down-count", desc: "Alpha -count" },
      { key: "{count}k", cmd: "alpha-up-count", desc: "Alpha +count" },
      { key: "return", cmd: "panel-write", desc: "Write alpha snapshot" },
    ],
  })

  keymap.registerLayer({
    name: "Beta",
    target: betaPanel,
    targetMode: "focus-within",
    bindings: [
      { key: "j", cmd: "beta-down", desc: "Beta -1" },
      { key: "k", cmd: "beta-up", desc: "Beta +1" },
      { key: "{count}j", cmd: "beta-down-count", desc: "Beta -count" },
      { key: "{count}k", cmd: "beta-up-count", desc: "Beta +count" },
      { key: "return", cmd: "panel-write", desc: "Write beta snapshot" },
    ],
  })

  keymap.registerLayer({
    name: "Notes",
    target: notesCard,
    targetMode: "focus-within",
    bindings: [{ key: "ctrl+return", cmd: "capture-notes", desc: "Capture notes snapshot" }],
  })

  keymap.registerLayer({
    name: "Draft",
    target: draftCard,
    targetMode: "focus-within",
    bindings: [{ key: "ctrl+return", cmd: "capture-draft", desc: "Capture draft snapshot" }],
  })

  keymap.registerLayer({
    name: "Log",
    target: logCard,
    targetMode: "focus-within",
    bindings: [
      { key: "j", cmd: "scroll-pane-down", desc: "Scroll recent actions down" },
      { key: "k", cmd: "scroll-pane-up", desc: "Scroll recent actions up" },
      { key: "ctrl+d", cmd: "scroll-pane-page-down", desc: "Page recent actions down" },
      { key: "ctrl+u", cmd: "scroll-pane-page-up", desc: "Page recent actions up" },
      { key: "g", cmd: "scroll-pane-page-up", desc: "Page recent actions up", group: "Go" },
      { key: "gg", cmd: "scroll-pane-top", desc: "Jump to the top", group: "Go" },
      { key: "shift+g", cmd: "scroll-pane-bottom", desc: "Jump to the bottom" },
    ],
  })

  keymap.registerLayer({
    name: "Prompt",
    target: promptShell,
    targetMode: "focus-within",
    enabled: () => promptVisible,
    bindings: [
      { key: "escape", cmd: "prompt-close", desc: "Close prompt" },
      { key: "return", cmd: "prompt-submit", desc: "Run ex command" },
      { key: "tab", cmd: "prompt-complete", desc: "Complete suggestion" },
      { key: "shift+tab", cmd: "prompt-complete-prev", desc: "Previous completion" },
      { key: "up", cmd: "prompt-prev", desc: "Previous suggestion" },
      { key: "down", cmd: "prompt-next", desc: "Next suggestion" },
    ],
  })

  keymap.on("state", () => {
    debugStateSnapshot("event")
    renderAll()
  })
  keymap.on("dispatch", (event) => {
    addGraphPulse(event)
  })
  keymap.on("warning", (event) => {
    debug("warning", {
      code: event.code,
      message: event.message,
    })
    appendLog(`Warning: ${event.message}`)
  })
  keymap.on("error", (event) => {
    debug("error", {
      code: event.code,
      message: event.message,
    })
    appendLog(`Error: ${event.message}`)
  })
}

commandInput.addEventListener("input", () => {
  selectedSuggestion = 0
  debug("prompt input", {
    value: commandInput.value,
    suggestions:
      getCommandSuggestions()
        .map((suggestion) => suggestion.label)
        .join(", ") || "none",
  })
  renderPrompt()
})

app.addEventListener("keydown", (event) => {
  debugKeyEvent("keydown", event)
})

app.addEventListener("keyup", (event) => {
  debugKeyEvent("keyup", event)
})

app.addEventListener("focusin", () => {
  debug("focusin", {
    focused: getCurrentFocusedTarget()?.id ?? "none",
  })
})

app.addEventListener("focusout", () => {
  queueMicrotask(() => {
    debug("focusout", {
      focused: getCurrentFocusedTarget()?.id ?? "none",
    })
  })
})

promptOverlay.addEventListener("mousedown", (event) => {
  if (event.target !== promptOverlay) {
    return
  }

  debug("prompt backdrop click")
  closePrompt()
})

window.addEventListener("resize", () => {
  renderGraphCanvas(getGraphSnapshot(keymap))
})

renderCounters()
renderHelp()
appendLog(lastAction)
renderAll()
alphaPanel.focus()
debugStateSnapshot("initial")
