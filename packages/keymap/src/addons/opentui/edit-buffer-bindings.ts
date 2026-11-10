import {
  CliRenderEvents,
  InputRenderable,
  TextareaRenderable,
  defaultTextareaKeyBindings,
  type CliRenderer,
  type EditBufferRenderable,
  type KeyEvent,
  type Renderable,
  type TextareaAction,
} from "@opentui/core"
import type { Binding, Bindings, Command, Keymap, Layer } from "../../index.js"

interface KeyBindingLike {
  name: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
  super?: boolean
}

function keyBindingToString(binding: KeyBindingLike): string {
  const parts: string[] = []

  if (binding.ctrl) parts.push("ctrl")
  if (binding.shift) parts.push("shift")
  if (binding.meta) parts.push("meta")
  if (binding.super) parts.push("super")

  parts.push(binding.name)

  return parts.join("+")
}

const editBufferActions = [
  "move-left",
  "move-right",
  "move-up",
  "move-down",
  "select-left",
  "select-right",
  "select-up",
  "select-down",
  "line-home",
  "line-end",
  "select-line-home",
  "select-line-end",
  "visual-line-home",
  "visual-line-end",
  "select-visual-line-home",
  "select-visual-line-end",
  "buffer-home",
  "buffer-end",
  "select-buffer-home",
  "select-buffer-end",
  "delete-line",
  "delete-to-line-end",
  "delete-to-line-start",
  "backspace",
  "delete",
  "newline",
  "undo",
  "redo",
  "word-forward",
  "word-backward",
  "select-word-forward",
  "select-word-backward",
  "delete-word-forward",
  "delete-word-backward",
  "select-all",
  "submit",
] as const satisfies readonly TextareaAction[]

export type EditBufferCommandName = (typeof editBufferActions)[number]

export type EditBufferFineGroup = "Cursor" | "Selection" | "Delete" | "History" | "Insert" | "Submit"

const DEFAULT_EDIT_BUFFER_METADATA_GROUP = "Text Editing"

const editBufferCommandNames = {
  "move-left": "input.move.left",
  "move-right": "input.move.right",
  "move-up": "input.move.up",
  "move-down": "input.move.down",
  "select-left": "input.select.left",
  "select-right": "input.select.right",
  "select-up": "input.select.up",
  "select-down": "input.select.down",
  "line-home": "input.line.home",
  "line-end": "input.line.end",
  "select-line-home": "input.select.line.home",
  "select-line-end": "input.select.line.end",
  "visual-line-home": "input.visual.line.home",
  "visual-line-end": "input.visual.line.end",
  "select-visual-line-home": "input.select.visual.line.home",
  "select-visual-line-end": "input.select.visual.line.end",
  "buffer-home": "input.buffer.home",
  "buffer-end": "input.buffer.end",
  "select-buffer-home": "input.select.buffer.home",
  "select-buffer-end": "input.select.buffer.end",
  "delete-line": "input.delete.line",
  "delete-to-line-end": "input.delete.to.line.end",
  "delete-to-line-start": "input.delete.to.line.start",
  backspace: "input.backspace",
  delete: "input.delete",
  newline: "input.newline",
  undo: "input.undo",
  redo: "input.redo",
  "word-forward": "input.word.forward",
  "word-backward": "input.word.backward",
  "select-word-forward": "input.select.word.forward",
  "select-word-backward": "input.select.word.backward",
  "delete-word-forward": "input.delete.word.forward",
  "delete-word-backward": "input.delete.word.backward",
  "select-all": "input.select.all",
  submit: "input.submit",
} as const satisfies Record<EditBufferCommandName, string>

const editBufferCommandDescriptions = {
  "move-left": "Cursor left",
  "move-right": "Cursor right",
  "move-up": "Cursor up",
  "move-down": "Cursor down",
  "select-left": "Select left",
  "select-right": "Select right",
  "select-up": "Select up",
  "select-down": "Select down",
  "line-home": "Line start",
  "line-end": "Line end",
  "select-line-home": "Select to line start",
  "select-line-end": "Select to line end",
  "visual-line-home": "Visual line start",
  "visual-line-end": "Visual line end",
  "select-visual-line-home": "Select to visual line start",
  "select-visual-line-end": "Select to visual line end",
  "buffer-home": "Buffer start",
  "buffer-end": "Buffer end",
  "select-buffer-home": "Select to buffer start",
  "select-buffer-end": "Select to buffer end",
  "delete-line": "Delete line",
  "delete-to-line-end": "Delete to line end",
  "delete-to-line-start": "Delete to line start",
  backspace: "Delete backward",
  delete: "Delete forward",
  newline: "New line",
  undo: "Undo",
  redo: "Redo",
  "word-forward": "Next word",
  "word-backward": "Previous word",
  "select-word-forward": "Select next word",
  "select-word-backward": "Select previous word",
  "delete-word-forward": "Delete next word",
  "delete-word-backward": "Delete previous word",
  "select-all": "Select all",
  submit: "Submit",
} as const satisfies Record<EditBufferCommandName, string>

const editBufferFineGroups = {
  "move-left": "Cursor",
  "move-right": "Cursor",
  "move-up": "Cursor",
  "move-down": "Cursor",
  "select-left": "Selection",
  "select-right": "Selection",
  "select-up": "Selection",
  "select-down": "Selection",
  "line-home": "Cursor",
  "line-end": "Cursor",
  "select-line-home": "Selection",
  "select-line-end": "Selection",
  "visual-line-home": "Cursor",
  "visual-line-end": "Cursor",
  "select-visual-line-home": "Selection",
  "select-visual-line-end": "Selection",
  "buffer-home": "Cursor",
  "buffer-end": "Cursor",
  "select-buffer-home": "Selection",
  "select-buffer-end": "Selection",
  "delete-line": "Delete",
  "delete-to-line-end": "Delete",
  "delete-to-line-start": "Delete",
  backspace: "Delete",
  delete: "Delete",
  newline: "Insert",
  undo: "History",
  redo: "History",
  "word-forward": "Cursor",
  "word-backward": "Cursor",
  "select-word-forward": "Selection",
  "select-word-backward": "Selection",
  "delete-word-forward": "Delete",
  "delete-word-backward": "Delete",
  "select-all": "Selection",
  submit: "Submit",
} as const satisfies Record<EditBufferCommandName, EditBufferFineGroup>

interface EditBufferMetadataOptions {
  category: string
  group: string
  includeFineGroup: boolean
}

export interface EditBufferCommandOptions {
  category?: string
  group?: string
  includeFineGroup?: boolean
  commandNames?: Partial<Record<EditBufferCommandName, string>>
  descriptions?: Partial<Record<EditBufferCommandName, string>>
}

const EDIT_BUFFER_COMMANDS_RESOURCE = Symbol("keymap:edit-buffer-commands")
const TEXTAREA_MAPPING_SUSPENSION_RESOURCE = Symbol("keymap:textarea-mapping-suspension")

export type ManagedTextareaLayer = Omit<Layer<Renderable, KeyEvent>, "bindings" | "target" | "targetMode"> & {
  bindings?: Bindings<Renderable, KeyEvent>
  target?: never
  targetMode?: never
}

function isManagedTextarea(editor: EditBufferRenderable | null): editor is TextareaRenderable {
  return editor instanceof TextareaRenderable && !(editor instanceof InputRenderable)
}

function resolveEditBufferCommandDescriptions(
  options?: EditBufferCommandOptions,
): Record<EditBufferCommandName, string> {
  const descriptions: Record<EditBufferCommandName, string> = { ...editBufferCommandDescriptions }
  const overrides = options?.descriptions
  if (!overrides) {
    return descriptions
  }

  for (const name of editBufferActions) {
    const override = overrides[name]
    if (override === undefined) {
      continue
    }

    const normalized = override.trim()
    if (!normalized) {
      throw new Error(`Edit buffer command description for "${name}" cannot be empty`)
    }

    descriptions[name] = normalized
  }

  return descriptions
}

function normalizeEditBufferMetadataField(fieldName: "category" | "group", value: string | undefined): string {
  const normalized = (value ?? DEFAULT_EDIT_BUFFER_METADATA_GROUP).trim()
  if (!normalized) {
    throw new Error(`Edit buffer metadata field "${fieldName}" cannot be empty`)
  }

  return normalized
}

function resolveEditBufferMetadataOptions(options?: EditBufferCommandOptions): EditBufferMetadataOptions {
  return {
    category: normalizeEditBufferMetadataField("category", options?.category),
    group: normalizeEditBufferMetadataField("group", options?.group),
    includeFineGroup: options?.includeFineGroup === true,
  }
}

function resolveEditBufferCommandNames(options?: EditBufferCommandOptions): Record<EditBufferCommandName, string> {
  const commandNames: Record<EditBufferCommandName, string> = { ...editBufferCommandNames }
  const overrides = options?.commandNames

  if (overrides) {
    for (const action of editBufferActions) {
      const override = overrides[action]
      if (override === undefined) {
        continue
      }

      const normalized = override.trim()
      if (!normalized) {
        throw new Error(`Edit buffer command name for "${action}" cannot be empty`)
      }

      commandNames[action] = normalized
    }
  }

  const seenNames = new Map<string, EditBufferCommandName>()

  for (const action of editBufferActions) {
    const commandName = commandNames[action]
    const existingAction = seenNames.get(commandName)
    if (existingAction !== undefined) {
      throw new Error(
        `Edit buffer command name "${commandName}" is assigned to both "${existingAction}" and "${action}"`,
      )
    }

    seenNames.set(commandName, action)
  }

  return commandNames
}

function setTextareaSuspend(editor: TextareaRenderable, suspended: boolean): void {
  const nextTraits = { ...editor.traits }
  if (suspended) {
    nextTraits.suspend = true
  } else {
    delete nextTraits.suspend
  }

  editor.traits = nextTraits
}

function createDefaultTextareaBindings(
  commandNames: Readonly<Record<EditBufferCommandName, string>>,
  descriptions: Readonly<Record<EditBufferCommandName, string>>,
  metadata: Readonly<EditBufferMetadataOptions>,
): Binding[] {
  return defaultTextareaKeyBindings.map((binding) => {
    const generated: Binding = {
      key: keyBindingToString(binding),
      cmd: commandNames[binding.action],
      desc: descriptions[binding.action],
      group: metadata.group,
    }

    if (metadata.includeFineGroup) {
      generated.fineGroup = editBufferFineGroups[binding.action]
    }

    return generated
  })
}

/**
 * Returns the default textarea bindings with any overrides prepended so they
 * take precedence. Prefer `registerManagedTextareaLayer` unless you are
 * composing a custom textarea integration.
 */
export function createTextareaBindings(overrides?: readonly Binding[], options?: EditBufferCommandOptions): Binding[] {
  return createTextareaBindingsWithResolvedOptions(
    overrides,
    resolveEditBufferCommandNames(options),
    resolveEditBufferCommandDescriptions(options),
    resolveEditBufferMetadataOptions(options),
  )
}

function createTextareaBindingsWithResolvedOptions(
  overrides: readonly Binding[] | undefined,
  commandNames: Readonly<Record<EditBufferCommandName, string>>,
  descriptions: Readonly<Record<EditBufferCommandName, string>>,
  metadata: Readonly<EditBufferMetadataOptions>,
): Binding[] {
  const overrideBindings = overrides ?? []
  return [...overrideBindings, ...createDefaultTextareaBindings(commandNames, descriptions, metadata)]
}

function getLiveRenderer(renderer: CliRenderer): CliRenderer {
  if (renderer.isDestroyed) {
    throw new Error("Cannot use a keymap after its renderer was destroyed")
  }

  return renderer
}

/**
 * Suspends a focused `TextareaRenderable`'s own key handling so keymap
 * bindings can take over, restoring the previous suspend state on cleanup or
 * focus change. Reference-counted per `Keymap`; prefer
 * `registerManagedTextareaLayer` unless you need this separately.
 */
export function registerTextareaMappingSuspension(
  keymap: Keymap<Renderable, KeyEvent>,
  renderer: CliRenderer,
): () => void {
  return keymap.acquireResource(TEXTAREA_MAPPING_SUSPENSION_RESOURCE, () => {
    const previousSuspendStates = new WeakMap<TextareaRenderable, boolean>()
    let suspendedEditor: TextareaRenderable | null = null

    const suspendEditor = (editor: EditBufferRenderable | null): void => {
      if (!isManagedTextarea(editor) || editor.isDestroyed) {
        suspendedEditor = null
        return
      }

      if (!previousSuspendStates.has(editor)) {
        previousSuspendStates.set(editor, editor.traits.suspend === true)
      }

      setTextareaSuspend(editor, true)
      suspendedEditor = editor
    }

    const restoreEditor = (editor: EditBufferRenderable | null): void => {
      if (!isManagedTextarea(editor)) {
        return
      }

      const previousSuspend = previousSuspendStates.get(editor)
      if (previousSuspend === undefined) {
        return
      }

      previousSuspendStates.delete(editor)
      if (!editor.isDestroyed) {
        setTextareaSuspend(editor, previousSuspend)
      }

      if (suspendedEditor === editor) {
        suspendedEditor = null
      }
    }

    const onFocusedEditor = (current: EditBufferRenderable | null, previous: EditBufferRenderable | null): void => {
      restoreEditor(previous)
      suspendEditor(current)
    }

    const liveRenderer = getLiveRenderer(renderer)

    liveRenderer.on(CliRenderEvents.FOCUSED_EDITOR, onFocusedEditor)
    suspendEditor(liveRenderer.currentFocusedEditor)

    return () => {
      liveRenderer.off(CliRenderEvents.FOCUSED_EDITOR, onFocusedEditor)
      restoreEditor(suspendedEditor)
    }
  })
}

function withFocusedEditor(renderer: CliRenderer, run: (editor: EditBufferRenderable) => boolean): boolean {
  const editor = getLiveRenderer(renderer).currentFocusedEditor
  if (!editor || editor.isDestroyed) {
    return false
  }

  return run(editor)
}

function hasSubmit(editor: EditBufferRenderable): editor is EditBufferRenderable & { submit: () => boolean } {
  return typeof (editor as { submit?: unknown }).submit === "function"
}

const editBufferCommandHandlers = {
  "move-left": (editor: EditBufferRenderable) => editor.moveCursorLeft(),
  "move-right": (editor: EditBufferRenderable) => editor.moveCursorRight(),
  "move-up": (editor: EditBufferRenderable) => editor.moveCursorUp(),
  "move-down": (editor: EditBufferRenderable) => editor.moveCursorDown(),
  "select-left": (editor: EditBufferRenderable) => editor.moveCursorLeft({ select: true }),
  "select-right": (editor: EditBufferRenderable) => editor.moveCursorRight({ select: true }),
  "select-up": (editor: EditBufferRenderable) => editor.moveCursorUp({ select: true }),
  "select-down": (editor: EditBufferRenderable) => editor.moveCursorDown({ select: true }),
  "line-home": (editor: EditBufferRenderable) => editor.gotoLineHome(),
  "line-end": (editor: EditBufferRenderable) => editor.gotoLineEnd(),
  "select-line-home": (editor: EditBufferRenderable) => editor.gotoLineHome({ select: true }),
  "select-line-end": (editor: EditBufferRenderable) => editor.gotoLineEnd({ select: true }),
  "visual-line-home": (editor: EditBufferRenderable) => editor.gotoVisualLineHome(),
  "visual-line-end": (editor: EditBufferRenderable) => editor.gotoVisualLineEnd(),
  "select-visual-line-home": (editor: EditBufferRenderable) => editor.gotoVisualLineHome({ select: true }),
  "select-visual-line-end": (editor: EditBufferRenderable) => editor.gotoVisualLineEnd({ select: true }),
  "buffer-home": (editor: EditBufferRenderable) => editor.gotoBufferHome(),
  "buffer-end": (editor: EditBufferRenderable) => editor.gotoBufferEnd(),
  "select-buffer-home": (editor: EditBufferRenderable) => editor.gotoBufferHome({ select: true }),
  "select-buffer-end": (editor: EditBufferRenderable) => editor.gotoBufferEnd({ select: true }),
  "delete-line": (editor: EditBufferRenderable) => editor.deleteLine(),
  "delete-to-line-end": (editor: EditBufferRenderable) => editor.deleteToLineEnd(),
  "delete-to-line-start": (editor: EditBufferRenderable) => editor.deleteToLineStart(),
  backspace: (editor: EditBufferRenderable) => editor.deleteCharBackward(),
  delete: (editor: EditBufferRenderable) => editor.deleteChar(),
  newline: (editor: EditBufferRenderable) => editor.newLine(),
  undo: (editor: EditBufferRenderable) => editor.undo(),
  redo: (editor: EditBufferRenderable) => editor.redo(),
  "word-forward": (editor: EditBufferRenderable) => editor.moveWordForward(),
  "word-backward": (editor: EditBufferRenderable) => editor.moveWordBackward(),
  "select-word-forward": (editor: EditBufferRenderable) => editor.moveWordForward({ select: true }),
  "select-word-backward": (editor: EditBufferRenderable) => editor.moveWordBackward({ select: true }),
  "delete-word-forward": (editor: EditBufferRenderable) => editor.deleteWordForward(),
  "delete-word-backward": (editor: EditBufferRenderable) => editor.deleteWordBackward(),
  "select-all": (editor: EditBufferRenderable) => editor.selectAll(),
  submit: (editor: EditBufferRenderable) => {
    if (!hasSubmit(editor)) {
      return false
    }

    return editor.submit()
  },
} as const satisfies Record<EditBufferCommandName, (editor: EditBufferRenderable) => boolean>

function createEditBufferCommand(
  renderer: CliRenderer,
  action: EditBufferCommandName,
  commandNames: Readonly<Record<EditBufferCommandName, string>>,
  run: (editor: EditBufferRenderable) => boolean,
  descriptions: Readonly<Record<EditBufferCommandName, string>>,
  metadata: Readonly<EditBufferMetadataOptions>,
): Command<Renderable, KeyEvent> {
  return {
    name: commandNames[action],
    desc: descriptions[action],
    category: metadata.category,
    run() {
      return withFocusedEditor(renderer, run)
    },
  }
}

function createEditBufferCommands(
  renderer: CliRenderer,
  commandNames: Readonly<Record<EditBufferCommandName, string>>,
  descriptions: Readonly<Record<EditBufferCommandName, string>>,
  metadata: Readonly<EditBufferMetadataOptions>,
): Command<Renderable, KeyEvent>[] {
  return editBufferActions.map((action) =>
    createEditBufferCommand(renderer, action, commandNames, editBufferCommandHandlers[action], descriptions, metadata),
  )
}

/**
 * Registers the standard edit-buffer commands against
 * `renderer.currentFocusedEditor`. Reference-counted per `Keymap`; prefer
 * `registerManagedTextareaLayer` unless you need the commands without the
 * default bindings or textarea suspension.
 */
export function registerEditBufferCommands(
  keymap: Keymap<Renderable, KeyEvent>,
  renderer: CliRenderer,
  options?: EditBufferCommandOptions,
): () => void {
  const commandNames = resolveEditBufferCommandNames(options)
  const descriptions = resolveEditBufferCommandDescriptions(options)
  const metadata = resolveEditBufferMetadataOptions(options)

  return keymap.acquireResource(EDIT_BUFFER_COMMANDS_RESOURCE, () => {
    return keymap.registerLayer({
      commands: createEditBufferCommands(renderer, commandNames, descriptions, metadata),
    })
  })
}

/**
 * High-level global textarea integration: registers the edit-buffer commands,
 * suspends the textarea's built-in key handling while focused, and installs
 * the layer with default bindings plus overrides. Safe to combine with the
 * lower-level helpers because they are reference-counted.
 */
export function registerManagedTextareaLayer(
  keymap: Keymap<Renderable, KeyEvent>,
  renderer: CliRenderer,
  layer: ManagedTextareaLayer,
  options?: EditBufferCommandOptions,
): () => void {
  const commandNames = resolveEditBufferCommandNames(options)
  const descriptions = resolveEditBufferCommandDescriptions(options)
  const metadata = resolveEditBufferMetadataOptions(options)
  const offCommands = registerEditBufferCommands(keymap, renderer, options)
  const offSuspension = registerTextareaMappingSuspension(keymap, renderer)

  try {
    const { bindings, target: _ignoredTarget, targetMode: _ignoredTargetMode, ...rest } = layer
    const offLayer = keymap.registerLayer({
      ...rest,
      bindings: createTextareaBindingsWithResolvedOptions(bindings, commandNames, descriptions, metadata),
    })

    return () => {
      offLayer()
      offSuspension()
      offCommands()
    }
  } catch (error) {
    offSuspension()
    offCommands()
    throw error
  }
}
