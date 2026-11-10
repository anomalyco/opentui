import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { BoxRenderable, type KeyEvent, type Renderable } from "@opentui/core"
import { createTestRenderer, type MockInput, type TestRenderer } from "@opentui/core/testing"
import * as addons from "./addons/index.js"
import {
  createBindingLookup,
  formatCommandBindings,
  formatKeySequence,
  type BindingValue,
  type SequenceBindingLike,
} from "./extras/index.js"
import { type BindingParser, type Keymap, type ReactiveMatcher } from "./index.js"
import { createDefaultOpenTuiKeymap as getKeymap } from "./opentui.js"

// Defaults favor stable baseline comparisons over quick local smoke runs.
// Override these from the CLI when iterating on benchmark code.
const DEFAULT_ITERATIONS = 1_000
const DEFAULT_WARMUP = 1_000
const DEFAULT_ROUNDS = 7
const DEFAULT_MIN_SAMPLE_MS = 500
const KEY_POOL = "abcdefghijklmnopqrstuvwxyz0123456789"

interface BenchmarkArgs {
  iterations: number
  warmupIterations: number
  rounds: number
  minSampleMs: number
  scenarioNames?: Set<string>
  jsonPath?: string
  listScenarios: boolean
}

interface ScenarioResources {
  renderer: TestRenderer
  mockInput: MockInput
  keymap: OpenTuiKeymap
}

interface ScenarioInstance {
  resources: ScenarioResources
  runIteration?: (iteration: number) => unknown
  runIterationAsync?: (iteration: number) => Promise<unknown>
  cleanup: () => void
}

type OpenTuiKeymap = Keymap<Renderable, KeyEvent>
type BenchmarkKind =
  | "cache-hit"
  | "cache-miss"
  | "command-query"
  | "compile"
  | "dispatch"
  | "formatting"
  | "state-churn"
  | "trace"
  | "utility"

interface BenchmarkScenario {
  name: string
  description: string
  kind?: BenchmarkKind
  setup: () => Promise<ScenarioInstance>
}

interface BenchmarkSample {
  round: number
  iterations: number
  durationMs: number
  opsPerSecond: number
  nsPerOperation: number
}

interface BenchmarkResult {
  name: string
  description: string
  kind: BenchmarkKind
  iterations: number
  warmupIterations: number
  rounds: number
  minSampleMs: number
  batchIterations: number
  totalMeasuredIterations: number
  medianDurationMs: number
  bestDurationMs: number
  medianOpsPerSecond: number
  meanOpsPerSecond: number
  medianNsPerOperation: number
  p95NsPerOperation: number
  stdDevNsPerOperation: number
  rmePercent: number
  samples: BenchmarkSample[]
}

interface BenchmarkSinkState {
  value: unknown
  checksum: number
}

const blackhole: BenchmarkSinkState = {
  value: undefined,
  checksum: 0,
}

function parseNumberArg(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback
  }

  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric benchmark argument: ${value}`)
  }

  return parsed
}

function parseArgs(argv: string[]): BenchmarkArgs {
  let iterations = DEFAULT_ITERATIONS
  let warmupIterations = DEFAULT_WARMUP
  let rounds = DEFAULT_ROUNDS
  let minSampleMs = DEFAULT_MIN_SAMPLE_MS
  let scenarioNames: Set<string> | undefined
  let jsonPath: string | undefined
  let listScenarios = false

  for (const arg of argv) {
    if (arg === "--list-scenarios") {
      listScenarios = true
      continue
    }

    if (arg.startsWith("--iterations=")) {
      iterations = parseNumberArg(arg.slice("--iterations=".length), DEFAULT_ITERATIONS)
      continue
    }

    if (arg.startsWith("--warmup=")) {
      warmupIterations = parseNumberArg(arg.slice("--warmup=".length), DEFAULT_WARMUP)
      continue
    }

    if (arg.startsWith("--rounds=")) {
      rounds = parseNumberArg(arg.slice("--rounds=".length), DEFAULT_ROUNDS)
      continue
    }

    if (arg.startsWith("--min-sample-ms=")) {
      minSampleMs = parseNumberArg(arg.slice("--min-sample-ms=".length), DEFAULT_MIN_SAMPLE_MS)
      continue
    }

    if (arg.startsWith("--scenario=")) {
      const names = arg
        .slice("--scenario=".length)
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)

      scenarioNames = new Set(names)
      continue
    }

    if (arg.startsWith("--json=")) {
      jsonPath = arg.slice("--json=".length)
    }
  }

  return {
    iterations,
    warmupIterations,
    rounds,
    minSampleMs,
    scenarioNames,
    jsonPath,
    listScenarios,
  }
}

function nowNs(): bigint {
  return process.hrtime.bigint()
}

function nsToMs(ns: bigint): number {
  return Number(ns) / 1_000_000
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const value = sorted[middle]
  if (value === undefined) {
    return 0
  }

  if (sorted.length % 2 === 1) {
    return value
  }

  const previous = sorted[middle - 1]
  if (previous === undefined) {
    return value
  }

  return (previous + value) / 2
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0
  }

  let total = 0
  for (const value of values) {
    total += value
  }

  return total / values.length
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0
  }

  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[index] ?? 0
}

function sampleStdDev(values: readonly number[]): number {
  if (values.length <= 1) {
    return 0
  }

  const average = mean(values)
  let total = 0
  for (const value of values) {
    const delta = value - average
    total += delta * delta
  }

  return Math.sqrt(total / (values.length - 1))
}

function tCritical95(degreesOfFreedom: number): number {
  const table = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228]
  if (degreesOfFreedom <= 0) {
    return 0
  }

  return table[degreesOfFreedom - 1] ?? 1.96
}

function relativeMarginOfError(values: readonly number[]): number {
  if (values.length <= 1) {
    return 0
  }

  const average = mean(values)
  if (average === 0) {
    return 0
  }

  const sem = sampleStdDev(values) / Math.sqrt(values.length)
  return Math.abs((sem * tCritical95(values.length - 1) * 100) / average)
}

function consume(value: unknown): void {
  blackhole.value = value

  let contribution = 1
  if (typeof value === "number") {
    contribution = value | 0
  } else if (typeof value === "string" || Array.isArray(value)) {
    contribution = value.length
  } else if (value instanceof Map || value instanceof Set) {
    contribution = value.size
  } else if (typeof value === "boolean") {
    contribution = value ? 1 : 0
  } else if (value === null || value === undefined) {
    contribution = 0
  }

  blackhole.checksum = (blackhole.checksum + contribution) >>> 0
}

function roundIterations(value: number): number {
  if (value <= 1_000) {
    return Math.max(1, Math.ceil(value))
  }

  if (value <= 10_000) {
    return Math.ceil(value / 10) * 10
  }

  if (value <= 100_000) {
    return Math.ceil(value / 100) * 100
  }

  return Math.ceil(value / 1_000) * 1_000
}

function createFocusableBox(renderer: TestRenderer, id: string): BoxRenderable {
  return new BoxRenderable(renderer, {
    id,
    width: 10,
    height: 4,
    focusable: true,
  })
}

function createKey(index: number): string {
  return KEY_POOL[index % KEY_POOL.length] ?? "x"
}

const noopBindingParser: BindingParser = () => undefined

function createBracketTokenParser(): BindingParser {
  return ({ input, index, tokens, normalizeTokenName, parseObjectKey }) => {
    if (input[index] !== "[") {
      return undefined
    }

    const end = input.indexOf("]", index)
    if (end === -1) {
      throw new Error(`Invalid key sequence "${input}": unterminated token`)
    }

    const tokenName = normalizeTokenName(input.slice(index + 1, end))
    const token = tokens.get(tokenName)
    if (!token) {
      return { parts: [], nextIndex: end + 1, unknownTokens: [tokenName] }
    }

    return {
      parts: [parseObjectKey(token.stroke, { display: `[${tokenName}]`, match: token.match, tokenName })],
      nextIndex: end + 1,
      usedTokens: [tokenName],
    }
  }
}

function registerGlobalLayers(keymap: OpenTuiKeymap, count: number, cmd = "noop"): void {
  for (let index = 0; index < count; index += 1) {
    keymap.registerLayer({
      priority: index % 3,
      bindings: [{ key: createKey(index), cmd }],
    })
  }
}

function registerTargetLayer(
  keymap: OpenTuiKeymap,
  target: BoxRenderable,
  index: number,
  key = createKey(index),
  cmd = "noop",
): void {
  keymap.registerLayer({
    target,
    targetMode: index % 2 === 0 ? "focus-within" : "focus",
    priority: index % 4,
    bindings: [{ key, cmd }],
  })
}

function registerModeBindingFields(keymap: OpenTuiKeymap): void {
  keymap.registerBindingFields({
    mode(value, ctx) {
      ctx.require("vim.mode", value)
    },
    state(value, ctx) {
      ctx.require("vim.state", value)
    },
  })
}

function registerModeLayerFields(keymap: OpenTuiKeymap): void {
  keymap.registerLayerFields({
    mode(value, ctx) {
      ctx.require("vim.mode", value)
    },
    state(value, ctx) {
      ctx.require("vim.state", value)
    },
  })
}

function registerModeCommandFields(keymap: OpenTuiKeymap): void {
  keymap.registerCommandFields({
    mode(value, ctx) {
      ctx.require("vim.mode", value)
    },
    state(value, ctx) {
      ctx.require("vim.state", value)
    },
  })
}

function normalizeFlagKey(value: unknown, source: string): string {
  if (typeof value !== "string") {
    throw new Error(`${source} must be a string`)
  }

  const trimmed = value.trim()
  if (!trimmed) {
    throw new Error(`${source} cannot be empty`)
  }

  return trimmed
}

function registerNamedBindingFields(keymap: OpenTuiKeymap): void {
  keymap.registerBindingFields({
    activeWhen(value, ctx) {
      ctx.require(normalizeFlagKey(value, "binding field activeWhen"), true)
    },
  })
}

function registerNamedLayerFields(keymap: OpenTuiKeymap): void {
  keymap.registerLayerFields({
    activeWhen(value, ctx) {
      ctx.require(normalizeFlagKey(value, "layer field activeWhen"), true)
    },
  })
}

function createFlagKey(index: number): string {
  return `flag-${index}`
}

// Per-key reactive flag store used to benchmark matcher subscriptions against
// the old keyed invalidation pattern.
interface FlagStore {
  flags: Record<string, boolean>
  listeners: Map<string, Set<() => void>>
  set(key: string, value: boolean): void
}

function createFlagStore(): FlagStore {
  const flags: Record<string, boolean> = Object.create(null)
  const listeners = new Map<string, Set<() => void>>()

  return {
    flags,
    listeners,
    set(key, value) {
      if (flags[key] === value) {
        return
      }
      flags[key] = value
      const bucket = listeners.get(key)
      if (!bucket) {
        return
      }
      for (const onChange of bucket) {
        onChange()
      }
    },
  }
}

function createFlagMatcher(store: FlagStore, key: string): ReactiveMatcher {
  return {
    get: () => store.flags[key] === true,
    subscribe(onChange) {
      let bucket = store.listeners.get(key)
      if (!bucket) {
        bucket = new Set()
        store.listeners.set(key, bucket)
      }
      bucket.add(onChange)
      return () => {
        const current = store.listeners.get(key)
        if (!current) {
          return
        }
        current.delete(onChange)
        if (current.size === 0) {
          store.listeners.delete(key)
        }
      }
    },
  }
}

function registerExternalBindingFields(keymap: OpenTuiKeymap, store: FlagStore): void {
  keymap.registerBindingFields({
    activeExternally(value, ctx) {
      const key = normalizeFlagKey(value, "binding field activeExternally")
      ctx.activeWhen(createFlagMatcher(store, key))
    },
  })
}

function registerStateChangeNoopListener(keymap: OpenTuiKeymap): () => void {
  let events = 0

  const offState = keymap.on("state", () => {
    events += 1
  })

  return () => {
    offState()
    consume(events)
  }
}

function registerStateChangeReadListeners(keymap: OpenTuiKeymap): () => void {
  let sink = 0

  const offActiveKeys = keymap.on("state", () => {
    sink += keymap.getActiveKeys().length
  })
  const offPendingSequence = keymap.on("state", () => {
    sink += keymap.getPendingSequence().length
  })

  return () => {
    offPendingSequence()
    offActiveKeys()
    consume(sink)
  }
}

function registerStateChangeMetadataListeners(keymap: OpenTuiKeymap): () => void {
  let sink = 0

  const offActiveKeys = keymap.on("state", () => {
    sink += keymap.getActiveKeys({ includeMetadata: true }).length
  })
  const offPendingSequence = keymap.on("state", () => {
    sink += keymap.getPendingSequence().length
  })

  return () => {
    offPendingSequence()
    offActiveKeys()
    consume(sink)
  }
}

function registerStateChangeBindingListeners(keymap: OpenTuiKeymap): () => void {
  let sink = 0

  const offActiveKeys = keymap.on("state", () => {
    sink += keymap.getActiveKeys({ includeBindings: true }).length
  })
  const offPendingSequence = keymap.on("state", () => {
    sink += keymap.getPendingSequence().length
  })

  return () => {
    offPendingSequence()
    offActiveKeys()
    consume(sink)
  }
}

function readActiveKeysRepeatedly(keymap: OpenTuiKeymap, count: number): void {
  for (let index = 0; index < count; index += 1) {
    consume(keymap.getActiveKeys())
  }
}

function setupStateChangeFocusChurn(resources: ScenarioResources): {
  first: BoxRenderable
  second: BoxRenderable
} {
  const first = createFocusableBox(resources.renderer, "state-focus-first")
  const second = createFocusableBox(resources.renderer, "state-focus-second")

  resources.renderer.root.add(first)
  resources.renderer.root.add(second)

  for (let index = 0; index < 8; index += 1) {
    registerTargetLayer(resources.keymap, first, index, createKey(index + 1))
    registerTargetLayer(resources.keymap, second, index + 100, createKey(index + 11))
  }

  registerGlobalLayers(resources.keymap, 120)

  return { first, second }
}

function setupMetadataFocusTree(resources: ScenarioResources): BoxRenderable[] {
  const commands = Array.from({ length: 36 + 300 + 150 }, (_, index) => ({
    name: `metadata-command-${index}`,
    title: `Action ${index}`,
    desc: `Action ${index}`,
    run() {},
  }))

  resources.keymap.registerLayer({ commands: commands })

  const focusChain = createFocusTree(resources, 6)
  let commandIndex = 0

  for (let index = 0; index < focusChain.length; index += 1) {
    const target = focusChain[index]
    if (!target) {
      continue
    }

    for (let layerIndex = 0; layerIndex < 6; layerIndex += 1) {
      resources.keymap.registerLayer({
        target,
        targetMode: index % 2 === 0 ? "focus-within" : "focus",
        priority: layerIndex % 4,
        bindings: [
          {
            key: createKey(index * 10 + layerIndex),
            cmd: `metadata-command-${commandIndex}`,
            desc: `Binding ${commandIndex}`,
            group: `Panel ${index}`,
          },
        ],
      })

      commandIndex += 1
    }
  }

  for (let index = 0; index < 300; index += 1) {
    const sibling = createFocusableBox(resources.renderer, `metadata-sibling-${index}`)
    resources.renderer.root.add(sibling)
    resources.keymap.registerLayer({
      target: sibling,
      targetMode: index % 2 === 0 ? "focus-within" : "focus",
      priority: index % 4,
      bindings: [
        {
          key: createKey(index + 4000),
          cmd: `metadata-command-${commandIndex}`,
          desc: `Binding ${commandIndex}`,
          group: "Sibling",
        },
      ],
    })
    commandIndex += 1
  }

  for (let index = 0; index < 150; index += 1) {
    resources.keymap.registerLayer({
      priority: index % 3,
      bindings: [
        {
          key: createKey(index + 8000),
          cmd: `metadata-command-${commandIndex}`,
          desc: `Binding ${commandIndex}`,
          group: "Global",
        },
      ],
    })
    commandIndex += 1
  }

  return focusChain
}

async function createScenarioResources(): Promise<ScenarioResources> {
  const testSetup = await createTestRenderer({ width: 80, height: 24 })
  const keymap = getKeymap(testSetup.renderer)
  keymap.registerLayer({
    commands: [
      {
        name: "noop",
        run() {},
      },
    ],
  })

  return {
    renderer: testSetup.renderer,
    mockInput: testSetup.mockInput,
    keymap,
  }
}

function registerDigitPattern(keymap: OpenTuiKeymap): void {
  keymap.registerSequencePattern({
    name: "count",
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
}

function createFocusTree(resources: ScenarioResources, depth: number): BoxRenderable[] {
  const chain: BoxRenderable[] = []
  let parent: { add(child: BoxRenderable): void } = resources.renderer.root

  for (let index = 0; index < depth; index += 1) {
    const node = createFocusableBox(resources.renderer, `focus-${index}`)
    parent.add(node)
    chain.push(node)
    parent = node
  }

  chain.at(-1)?.focus()
  return chain
}

function inferScenarioKind(name: string): BenchmarkKind {
  if (name.startsWith("trace_")) {
    return "trace"
  }

  if (name.startsWith("compile_") || name.startsWith("register_commands_")) {
    return "compile"
  }

  if (name.startsWith("dispatch_") || name.startsWith("run_command_")) {
    return "dispatch"
  }

  if (name.startsWith("get_commands_") || name.startsWith("get_command_")) {
    return "command-query"
  }

  if (name.startsWith("format_") || name.startsWith("binding_lookup_")) {
    return "formatting"
  }

  if (name.startsWith("state_change_") || name.includes("_churn")) {
    return "state-churn"
  }

  if (name.startsWith("active_keys_") || name.startsWith("pending_sequence_")) {
    return name.includes("sparse_data_churn") ? "cache-miss" : "cache-hit"
  }

  return "utility"
}

function setupTraceTargets(resources: ScenarioResources, count: number): BoxRenderable[] {
  const targets: BoxRenderable[] = []
  for (let index = 0; index < count; index += 1) {
    const target = createFocusableBox(resources.renderer, `trace-target-${index}`)
    ;(target as BoxRenderable & { setMaxListeners?: (count: number) => void }).setMaxListeners?.(0)
    resources.renderer.root.add(target)
    targets.push(target)
  }

  targets[0]?.focus()
  return targets
}

function setupTraceCommandCatalog(resources: ScenarioResources, count: number): void {
  registerModeCommandFields(resources.keymap)
  resources.keymap.registerLayer({
    commands: Array.from({ length: count }, (_, index) => ({
      name: `trace.command.${index}`,
      namespace: index % 3 === 0 ? "editor" : index % 3 === 1 ? "palette" : "panel",
      title: index % 4 === 0 ? `Write File ${index}` : `Open Buffer ${index}`,
      desc: `Trace command ${index}`,
      usage: index % 4 === 0 ? `:write trace-${index}.txt` : `:open trace-${index}.txt`,
      tags: index % 4 === 0 ? ["file", "write"] : ["file", "open"],
      mode: index % 5 === 0 ? "normal" : undefined,
      run(ctx) {
        const current = Number(ctx.keymap.getData("trace.commandCount") ?? 0)
        ctx.keymap.setData("trace.commandCount", current + 1)
      },
    })),
  })
}

function setupTraceBindings(resources: ScenarioResources, targets: readonly BoxRenderable[]): void {
  registerDigitPattern(resources.keymap)
  registerModeBindingFields(resources.keymap)
  registerModeLayerFields(resources.keymap)
  addons.registerLeader(resources.keymap, { trigger: "space" })
  addons.registerModBindings(resources.keymap)
  addons.registerCommaBindings(resources.keymap)
  addons.registerEscapeClearsPendingSequence(resources.keymap)
  addons.registerBackspacePopsPendingSequence(resources.keymap)
  resources.keymap.appendDisambiguationResolver((ctx) => ctx.continueSequence())
  resources.keymap.setData("vim.mode", "normal")
  resources.keymap.setData("vim.state", "idle")

  resources.keymap.registerLayer({
    priority: 4,
    bindings: [
      { key: "ctrl+p", cmd: "trace.command.1", desc: "Open palette", group: "Global" },
      { key: "mod+s, ctrl+s", cmd: "trace.command.4", desc: "Save", group: "Global" },
      { key: "<leader>f", cmd: "trace.command.8", desc: "Find file", group: "Global" },
      { key: "<leader>b", cmd: "trace.command.12", desc: "Open buffer", group: "Global" },
    ],
  })

  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]
    if (!target) {
      continue
    }

    resources.keymap.registerLayer({
      target,
      targetMode: "focus-within",
      priority: 2,
      mode: index % 2 === 0 ? "normal" : undefined,
      bindings: [
        { key: "j", cmd: `trace.command.${20 + index}`, desc: "Move down", group: `Pane ${index}` },
        { key: "k", cmd: `trace.command.${24 + index}`, desc: "Move up", group: `Pane ${index}` },
        { key: "dd", cmd: `trace.command.${28 + index}`, desc: "Delete line", group: `Pane ${index}` },
        { key: "gg", cmd: `trace.command.${32 + index}`, desc: "Top", group: `Pane ${index}` },
        { key: "{count}j", cmd: `trace.command.${36 + index}`, desc: "Move count", group: `Pane ${index}` },
        { key: "x, y, z", cmd: `trace.command.${40 + index}`, desc: "Edit", group: `Pane ${index}` },
      ],
    })
  }

  for (let index = 0; index < 160; index += 1) {
    const target = targets[index % targets.length]
    if (!target) {
      continue
    }

    resources.keymap.registerLayer({
      target,
      targetMode: index % 2 === 0 ? "focus" : "focus-within",
      priority: index % 3,
      bindings: [
        {
          key: createKey(index),
          cmd: `trace.command.${index % 48}`,
          desc: `Generated binding ${index}`,
          group: "Generated",
        },
      ],
    })
  }
}

function setupTraceApp(resources: ScenarioResources): BoxRenderable[] {
  const targets = setupTraceTargets(resources, 8)
  setupTraceCommandCatalog(resources, 96)
  setupTraceBindings(resources, targets)
  return targets
}

const scenarios: BenchmarkScenario[] = [
  {
    name: "compile_layer_default_parser",
    description: "Repeated layer registration using the default binding parser",
    async setup() {
      const resources = await createScenarioResources()
      resources.keymap.registerToken({ name: "leader", key: { name: "x", ctrl: true } })

      return {
        resources,
        runIteration() {
          const off = resources.keymap.registerLayer({
            bindings: [{ key: "g<leader>d", cmd: "noop" }],
          })
          off()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "compile_layer_default_parser_with_local_commands",
    description: "Repeated layer registration with per-layer commands compiled on mount",
    async setup() {
      const resources = await createScenarioResources()
      resources.keymap.registerToken({ name: "leader", key: { name: "x", ctrl: true } })

      return {
        resources,
        runIteration() {
          const off = resources.keymap.registerLayer({
            commands: [
              {
                name: "bench-local",
                run() {},
              },
            ],
            bindings: [{ key: "g<leader>d", cmd: "bench-local" }],
          })
          off()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "compile_layer_many_noop_parsers",
    description: "Repeated layer registration with many no-op parsers ahead of default",
    async setup() {
      const resources = await createScenarioResources()
      resources.keymap.registerToken({ name: "leader", key: { name: "x", ctrl: true } })

      for (let index = 0; index < 32; index += 1) {
        resources.keymap.prependBindingParser(noopBindingParser)
      }

      return {
        resources,
        runIteration() {
          const off = resources.keymap.registerLayer({
            bindings: [{ key: "g<leader>d", cmd: "noop" }],
          })
          off()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "compile_layer_replaced_parser_chain",
    description: "Repeated layer registration after replacing the parser chain",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.clearBindingParsers()
      resources.keymap.appendBindingParser(createBracketTokenParser())
      resources.keymap.appendBindingParser(addons.defaultBindingParser)
      resources.keymap.registerToken({ name: "leader", key: { name: "x", ctrl: true } })

      return {
        resources,
        runIteration() {
          const off = resources.keymap.registerLayer({
            bindings: [{ key: "g[leader]d", cmd: "noop" }],
          })
          off()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "compile_layer_many_noop_expanders",
    description: "Repeated layer registration with many no-op expanders before parsing",
    async setup() {
      const resources = await createScenarioResources()

      for (let index = 0; index < 32; index += 1) {
        resources.keymap.appendBindingExpander(() => undefined)
      }

      return {
        resources,
        runIteration() {
          const off = resources.keymap.registerLayer({
            bindings: [{ key: "ctrl+x", cmd: "noop" }],
          })
          off()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "compile_layer_comma_expander",
    description: "Repeated layer registration with comma-separated binding expansion",
    async setup() {
      const resources = await createScenarioResources()
      addons.registerCommaBindings(resources.keymap)

      return {
        resources,
        runIteration() {
          const off = resources.keymap.registerLayer({
            bindings: [{ key: "a, b, c, d", cmd: "noop" }],
          })
          off()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "compile_layer_mod_expander",
    description: "Repeated layer registration with platform-aware mod binding expansion",
    async setup() {
      const resources = await createScenarioResources()
      addons.registerModBindings(resources.keymap)

      return {
        resources,
        runIteration() {
          const off = resources.keymap.registerLayer({
            bindings: [{ key: "mod+x", cmd: "noop" }],
          })
          off()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "compile_layer_mod_comma_expanders",
    description: "Repeated layer registration with stacked mod and comma binding expansion",
    async setup() {
      const resources = await createScenarioResources()
      addons.registerModBindings(resources.keymap)
      addons.registerCommaBindings(resources.keymap)

      return {
        resources,
        runIteration() {
          const off = resources.keymap.registerLayer({
            bindings: [{ key: "mod+a, mod+b, mod+c, mod+d", cmd: "noop" }],
          })
          off()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "compile_layer_sequence_pattern",
    description: "Repeated layer registration using a dynamic sequence pattern segment",
    async setup() {
      const resources = await createScenarioResources()
      registerDigitPattern(resources.keymap)

      return {
        resources,
        runIteration() {
          const off = resources.keymap.registerLayer({
            bindings: [{ key: "d{count}w", cmd: "noop" }],
          })
          off()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "register_commands_custom_fields",
    description: "Repeated command registration with compiled and raw custom fields",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.registerCommandFields({
        benchDesc(value, ctx) {
          ctx.attr("desc", value)
        },
        benchTitle(value, ctx) {
          ctx.attr("title", value)
        },
        benchCategory(value, ctx) {
          ctx.attr("category", value)
        },
      })

      return {
        resources,
        runIteration() {
          const off = resources.keymap.registerLayer({
            commands: [
              {
                name: "bench-command",
                namespace: "bench",
                benchDesc: "Write the current file",
                benchTitle: "Write File",
                benchCategory: "File",
                usage: ":write <file>",
                tags: ["file", "write"],
                run() {},
              },
            ],
          })

          off()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "register_commands_custom_fields_with_conditions",
    description: "Repeated command registration with compiled custom fields and command runtime conditions",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.registerCommandFields({
        benchDesc(value, ctx) {
          ctx.attr("desc", value)
        },
        benchTitle(value, ctx) {
          ctx.attr("title", value)
        },
        benchCategory(value, ctx) {
          ctx.attr("category", value)
        },
        mode(value, ctx) {
          ctx.require("vim.mode", value)
        },
        state(value, ctx) {
          ctx.require("vim.state", value)
        },
      })

      return {
        resources,
        runIteration() {
          const off = resources.keymap.registerLayer({
            commands: [
              {
                name: "bench-command",
                namespace: "bench",
                benchDesc: "Write the current file",
                benchTitle: "Write File",
                benchCategory: "File",
                usage: ":write <file>",
                tags: ["file", "write"],
                mode: "normal",
                state: "idle",
                run() {},
              },
            ],
          })

          off()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "get_commands_query",
    description: "Repeated command discovery with search and filter over raw fields and attrs",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.registerCommandFields({
        label(value, ctx) {
          ctx.attr("label", value)
        },
      })

      resources.keymap.registerLayer({
        commands: Array.from({ length: 512 }, (_, index) => ({
          name: `command-${index}`,
          namespace: index % 2 === 0 ? "bench" : "other",
          label: index % 4 === 0 ? `Write File ${index}` : `Open Buffer ${index}`,
          usage: index % 4 === 0 ? `:write file-${index}.txt` : `:open file-${index}.txt`,
          tags: index % 4 === 0 ? ["file", "write"] : ["file", "open"],
          run() {},
        })),
      })

      return {
        resources,
        runIteration() {
          return resources.keymap.getCommands({
            search: "write",
            searchIn: ["name", "title", "usage", "label"],
            filter: {
              namespace: "bench",
              tags: "file",
            },
          })
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "get_commands_namespace_query",
    description: "Repeated command discovery with top-level namespace filtering",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.registerCommandFields({
        label(value, ctx) {
          ctx.attr("label", value)
        },
      })

      resources.keymap.registerLayer({
        commands: Array.from({ length: 512 }, (_, index) => ({
          name: `command-${index}`,
          namespace: index % 2 === 0 ? "bench" : "other",
          label: index % 4 === 0 ? `Write File ${index}` : `Open Buffer ${index}`,
          usage: index % 4 === 0 ? `:write file-${index}.txt` : `:open file-${index}.txt`,
          tags: index % 4 === 0 ? ["file", "write"] : ["file", "open"],
          run() {},
        })),
      })

      return {
        resources,
        runIteration() {
          return resources.keymap.getCommands({
            namespace: "bench",
            filter: {
              tags: "file",
            },
          })
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "get_commands_query_function_filter",
    description: "Repeated command discovery with search and a full-record filter predicate",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.registerCommandFields({
        label(value, ctx) {
          ctx.attr("label", value)
        },
      })

      resources.keymap.registerLayer({
        commands: Array.from({ length: 512 }, (_, index) => ({
          name: `command-${index}`,
          namespace: index % 2 === 0 ? "bench" : "other",
          label: index % 4 === 0 ? `Write File ${index}` : `Open Buffer ${index}`,
          usage: index % 4 === 0 ? `:write file-${index}.txt` : `:open file-${index}.txt`,
          tags: index % 4 === 0 ? ["file", "write"] : ["file", "open"],
          run() {},
        })),
      })

      return {
        resources,
        runIteration() {
          return resources.keymap.getCommands({
            search: "write",
            searchIn: ["name", "title", "usage", "label"],
            filter(command) {
              return command.namespace === "bench" && Array.isArray(command.tags) && command.tags.includes("file")
            },
          })
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "get_commands_registered_query",
    description: "Repeated registered command discovery with namespace filtering",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.registerCommandFields({
        label(value, ctx) {
          ctx.attr("label", value)
        },
      })

      for (let layerIndex = 0; layerIndex < 64; layerIndex += 1) {
        resources.keymap.registerLayer({
          commands: Array.from({ length: 8 }, (_, index) => ({
            name: `command-${layerIndex}-${index}`,
            namespace: index % 2 === 0 ? "bench" : "other",
            label: `Command ${layerIndex}-${index}`,
            usage: `:${layerIndex}-${index}`,
            run() {},
          })),
        })
      }

      return {
        resources,
        runIteration() {
          return resources.keymap.getCommands({ visibility: "registered", namespace: "bench" })
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "get_command_entries_query",
    description: "Repeated command-plus-binding discovery with search and filter over raw fields and attrs",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.registerCommandFields({
        label(value, ctx) {
          ctx.attr("label", value)
        },
      })

      resources.keymap.registerLayer({
        commands: Array.from({ length: 512 }, (_, index) => ({
          name: `command-${index}`,
          namespace: index % 2 === 0 ? "bench" : "other",
          label: index % 4 === 0 ? `Write File ${index}` : `Open Buffer ${index}`,
          usage: index % 4 === 0 ? `:write file-${index}.txt` : `:open file-${index}.txt`,
          tags: index % 4 === 0 ? ["file", "write"] : ["file", "open"],
          run() {},
        })),
        bindings: Array.from({ length: 512 }, (_, index) => ({
          key: createKey(index),
          cmd: `command-${index}`,
          desc: `Binding ${index}`,
        })),
      })

      return {
        resources,
        runIteration() {
          return resources.keymap.getCommandEntries({
            search: "write",
            searchIn: ["name", "title", "usage", "label"],
            filter: {
              namespace: "bench",
              tags: "file",
            },
          })
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "get_command_entries_registered_query",
    description: "Repeated registered command-entry discovery with namespace filtering",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.registerCommandFields({
        label(value, ctx) {
          ctx.attr("label", value)
        },
      })

      for (let layerIndex = 0; layerIndex < 64; layerIndex += 1) {
        resources.keymap.registerLayer({
          commands: Array.from({ length: 8 }, (_, index) => ({
            name: `command-${layerIndex}-${index}`,
            namespace: index % 2 === 0 ? "bench" : "other",
            label: `Command ${layerIndex}-${index}`,
            usage: `:${layerIndex}-${index}`,
            run() {},
          })),
          bindings: Array.from({ length: 8 }, (_, index) => ({
            key: createKey(layerIndex * 8 + index),
            cmd: `command-${layerIndex}-${index}`,
          })),
        })
      }

      return {
        resources,
        runIteration() {
          return resources.keymap.getCommandEntries({ visibility: "registered", namespace: "bench" })
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "get_command_entries_registered_command_filter",
    description: "Repeated registered command-entry discovery for a requested command set",
    async setup() {
      const resources = await createScenarioResources()
      const commands = Array.from({ length: 64 }, (_, index) => `command-${index}-0`)

      for (let layerIndex = 0; layerIndex < 64; layerIndex += 1) {
        resources.keymap.registerLayer({
          commands: Array.from({ length: 8 }, (_, index) => ({
            name: `command-${layerIndex}-${index}`,
            namespace: index % 2 === 0 ? "bench" : "other",
            title: `Command ${layerIndex}-${index}`,
            usage: `:${layerIndex}-${index}`,
            run() {},
          })),
          bindings: Array.from({ length: 8 }, (_, index) => ({
            key: createKey(layerIndex * 8 + index),
            cmd: `command-${layerIndex}-${index}`,
          })),
        })
      }

      return {
        resources,
        runIteration() {
          return resources.keymap.getCommandEntries({ visibility: "registered", filter: { name: commands } })
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "get_command_bindings_registered_subset",
    description: "Repeated registered command-binding grouping for varied requested command sets",
    async setup() {
      const resources = await createScenarioResources()
      const commandSets = Array.from({ length: 8 }, (_, setIndex) =>
        Array.from({ length: 64 }, (_, index) => {
          const layerIndex = (index + setIndex * 7) % 64
          const commandIndex = ((index + setIndex) % 4) * 2
          return `command-${layerIndex}-${commandIndex}`
        }),
      )

      for (let layerIndex = 0; layerIndex < 64; layerIndex += 1) {
        resources.keymap.registerLayer({
          commands: Array.from({ length: 8 }, (_, index) => ({
            name: `command-${layerIndex}-${index}`,
            namespace: index % 2 === 0 ? "bench" : "other",
            title: `Command ${layerIndex}-${index}`,
            usage: `:${layerIndex}-${index}`,
            run() {},
          })),
          bindings: Array.from({ length: 8 }, (_, index) => ({
            key: createKey(layerIndex * 8 + index),
            cmd: `command-${layerIndex}-${index}`,
          })),
        })
      }

      return {
        resources,
        runIteration(iteration) {
          const commands = commandSets[iteration % commandSets.length] ?? commandSets[0]!
          return resources.keymap.getCommandBindings({ visibility: "registered", commands })
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "get_command_entries_reachable_shadowed_bindings",
    description: "Repeated reachable command-entry discovery while shadowed commands share bindings by name",
    async setup() {
      const resources = await createScenarioResources()
      const focusChain = createFocusTree(resources, 4)
      const focusedTarget = focusChain.at(-1)
      if (!focusedTarget) {
        throw new Error("Expected focused target for reachable command-entry benchmark")
      }

      resources.keymap.registerLayer({
        commands: Array.from({ length: 128 }, (_, index) => ({
          name: `command-${index}`,
          title: `Global ${index}`,
          run() {},
        })),
        bindings: Array.from({ length: 128 }, (_, index) => ({
          key: createKey(index),
          cmd: `command-${index}`,
        })),
      })

      resources.keymap.registerLayer({
        target: focusedTarget,
        commands: Array.from({ length: 64 }, (_, index) => ({
          name: `command-${index}`,
          title: `Local ${index}`,
          run() {},
        })),
        bindings: Array.from({ length: 64 }, (_, index) => ({
          key: createKey(index + 128),
          cmd: `command-${index}`,
        })),
      })

      return {
        resources,
        runIteration() {
          return resources.keymap.getCommandEntries()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "get_command_bindings_reachable_shadowed_subset",
    description: "Repeated reachable command-binding grouping while shadowed commands share bindings by name",
    async setup() {
      const resources = await createScenarioResources()
      const focusChain = createFocusTree(resources, 4)
      const focusedTarget = focusChain.at(-1)
      const commands = Array.from({ length: 64 }, (_, index) => `command-${index}`)
      if (!focusedTarget) {
        throw new Error("Expected focused target for reachable command-binding benchmark")
      }

      resources.keymap.registerLayer({
        commands: Array.from({ length: 128 }, (_, index) => ({
          name: `command-${index}`,
          title: `Global ${index}`,
          run() {},
        })),
        bindings: Array.from({ length: 128 }, (_, index) => ({
          key: createKey(index),
          cmd: `command-${index}`,
        })),
      })

      resources.keymap.registerLayer({
        target: focusedTarget,
        commands: Array.from({ length: 64 }, (_, index) => ({
          name: `command-${index}`,
          title: `Local ${index}`,
          run() {},
        })),
        bindings: Array.from({ length: 64 }, (_, index) => ({
          key: createKey(index + 128),
          cmd: `command-${index}`,
        })),
      })

      return {
        resources,
        runIteration() {
          return resources.keymap.getCommandBindings({ commands })
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "binding_lookup_small_mixed",
    description: "Repeated binding lookup creation for a small mixed app config",
    async setup() {
      const resources = await createScenarioResources()
      const config: Record<string, BindingValue> = {
        show_palette: "ctrl+p",
        exit_app: ["ctrl+c", "ctrl+d", "<leader>q"],
        save_file: { name: "s", ctrl: true },
        close_file: false,
        paste_prompt: { key: "ctrl+v", preventDefault: false, fallthrough: true },
        prompt_history_previous: "up",
        prompt_history_next: "down",
        confirm_dialog: "enter",
        cancel_dialog: ["escape", "ctrl+c"],
        ignore_dialog: [],
      }
      const appCommands = ["show_palette", "exit_app", "save_file", "close_file"]
      let sink = 0

      return {
        resources,
        runIteration() {
          const lookup = createBindingLookup(config)
          sink += lookup.gather("app", appCommands).length
          sink += lookup.get("exit_app").length
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "binding_lookup_small_mixed_defaults",
    description: "Repeated binding lookup creation with binding defaults for a small mixed app config",
    async setup() {
      const resources = await createScenarioResources()
      const config: Record<string, BindingValue> = {
        show_palette: "ctrl+p",
        exit_app: ["ctrl+c", "ctrl+d", "<leader>q"],
        save_file: { name: "s", ctrl: true },
        close_file: false,
        paste_prompt: { key: "ctrl+v", preventDefault: false, fallthrough: true },
        prompt_history_previous: "up",
        prompt_history_next: "down",
        confirm_dialog: "enter",
        cancel_dialog: ["escape", "ctrl+c"],
        ignore_dialog: [],
      }
      const appCommands = ["show_palette", "exit_app", "save_file", "close_file"]
      let sink = 0

      return {
        resources,
        runIteration() {
          const lookup = createBindingLookup(config, {
            bindingDefaults({ binding }) {
              if (binding.group !== undefined) return
              return { group: "default" }
            },
          })
          sink += lookup.gather("app", appCommands).length
          sink += lookup.get("exit_app").length
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "binding_lookup_pick_small_mixed",
    description: "Repeated gathered binding command selection for a small mixed app config",
    async setup() {
      const resources = await createScenarioResources()
      const lookup = createBindingLookup({
        show_palette: "ctrl+p",
        exit_app: ["ctrl+c", "ctrl+d", "<leader>q"],
        save_file: { name: "s", ctrl: true },
        close_file: false,
        paste_prompt: { key: "ctrl+v", preventDefault: false, fallthrough: true },
        prompt_history_previous: "up",
        prompt_history_next: "down",
      })
      lookup.gather("app", ["show_palette", "exit_app", "save_file", "close_file"])
      lookup.gather("prompt", ["paste_prompt", "prompt_history_previous", "prompt_history_next"])
      const appCommands = ["exit_app", "missing", "show_palette"]
      const promptCommands = ["prompt_history_next", "paste_prompt"]
      let sink = 0

      return {
        resources,
        runIteration() {
          sink += lookup.pick("app", appCommands).length
          sink += lookup.pick("prompt", promptCommands).length
          sink += lookup.pick("missing", appCommands).length
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "binding_lookup_omit_small_mixed",
    description: "Repeated gathered binding command exclusion for a small mixed app config",
    async setup() {
      const resources = await createScenarioResources()
      const lookup = createBindingLookup({
        show_palette: "ctrl+p",
        exit_app: ["ctrl+c", "ctrl+d", "<leader>q"],
        save_file: { name: "s", ctrl: true },
        close_file: false,
        paste_prompt: { key: "ctrl+v", preventDefault: false, fallthrough: true },
        prompt_history_previous: "up",
        prompt_history_next: "down",
      })
      lookup.gather("app", ["show_palette", "exit_app", "save_file", "close_file"])
      lookup.gather("prompt", ["paste_prompt", "prompt_history_previous", "prompt_history_next"])
      const appCommands = ["exit_app", "missing"]
      const promptCommands = ["prompt_history_next"]
      let sink = 0

      return {
        resources,
        runIteration() {
          sink += lookup.omit("app", appCommands).length
          sink += lookup.omit("prompt", promptCommands).length
          sink += lookup.omit("missing", appCommands).length
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "binding_lookup_large_mixed",
    description: "Repeated binding lookup creation for many groups and mixed binding value shapes",
    async setup() {
      const resources = await createScenarioResources()
      const config: Record<string, BindingValue> = Object.create(null)
      const groupCommands = Array.from({ length: 40 }, (_, sectionIndex) =>
        Array.from({ length: 64 }, (_, commandIndex) => `group_${sectionIndex}_command_${commandIndex}`),
      )

      for (let sectionIndex = 0; sectionIndex < 32; sectionIndex += 1) {
        const commands = groupCommands[sectionIndex]!

        for (let commandIndex = 0; commandIndex < 64; commandIndex += 1) {
          const command = commands[commandIndex]!
          switch (commandIndex % 6) {
            case 0:
              config[command] = false
              break
            case 1:
              config[command] = []
              break
            case 2:
              config[command] = createKey(commandIndex)
              break
            case 3:
              config[command] = [createKey(commandIndex), `ctrl+${createKey(commandIndex + 1)}`, "none"]
              break
            case 4:
              config[command] = { key: { name: createKey(commandIndex), ctrl: true }, preventDefault: false }
              break
            default:
              config[command] = "none"
              break
          }
        }
      }

      let sink = 0

      return {
        resources,
        runIteration() {
          const lookup = createBindingLookup(config)
          sink += lookup.gather("group-0", groupCommands[0]!).length
          sink += lookup.get("group_3_command_4").length
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "binding_lookup_large_mixed_defaults",
    description:
      "Repeated binding lookup creation with binding defaults for many groups and mixed binding value shapes",
    async setup() {
      const resources = await createScenarioResources()
      const config: Record<string, BindingValue> = Object.create(null)
      const groupCommands = Array.from({ length: 40 }, (_, sectionIndex) =>
        Array.from({ length: 64 }, (_, commandIndex) => `group_${sectionIndex}_command_${commandIndex}`),
      )

      for (let sectionIndex = 0; sectionIndex < 32; sectionIndex += 1) {
        const commands = groupCommands[sectionIndex]!

        for (let commandIndex = 0; commandIndex < 64; commandIndex += 1) {
          const command = commands[commandIndex]!
          switch (commandIndex % 6) {
            case 0:
              config[command] = false
              break
            case 1:
              config[command] = []
              break
            case 2:
              config[command] = createKey(commandIndex)
              break
            case 3:
              config[command] = [createKey(commandIndex), `ctrl+${createKey(commandIndex + 1)}`, "none"]
              break
            case 4:
              config[command] = { key: { name: createKey(commandIndex), ctrl: true }, preventDefault: false }
              break
            default:
              config[command] = "none"
              break
          }
        }
      }

      let sink = 0

      return {
        resources,
        runIteration() {
          const lookup = createBindingLookup(config, {
            bindingDefaults({ binding }) {
              if (binding.group !== undefined) return
              return { group: "default" }
            },
          })
          sink += lookup.gather("group-0", groupCommands[0]!).length
          sink += lookup.get("group_3_command_4").length
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "binding_lookup_get_large_mixed",
    description: "Repeated command lookup over a large mixed binding config",
    async setup() {
      const resources = await createScenarioResources()
      const config: Record<string, BindingValue> = Object.create(null)

      for (let commandIndex = 0; commandIndex < 1024; commandIndex += 1) {
        const command = `command_${commandIndex}`
        switch (commandIndex % 5) {
          case 0:
            config[command] = false
            break
          case 1:
            config[command] = createKey(commandIndex)
            break
          case 2:
            config[command] = [createKey(commandIndex), `ctrl+${createKey(commandIndex + 1)}`]
            break
          case 3:
            config[command] = { key: { name: createKey(commandIndex), ctrl: true }, preventDefault: false }
            break
          default:
            config[command] = []
            break
        }
      }

      const lookup = createBindingLookup(config)
      const commands = Array.from({ length: 128 }, (_, index) => `command_${(index * 7) % 1024}`)
      let sink = 0

      return {
        resources,
        runIteration(iteration) {
          sink += lookup.get(commands[iteration % commands.length]!).length
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "binding_lookup_gather_cached_large_mixed",
    description: "Repeated cached gather calls for a large mixed binding group",
    async setup() {
      const resources = await createScenarioResources()
      const config: Record<string, BindingValue> = Object.create(null)
      const commands = Array.from({ length: 512 }, (_, index) => `command_${index}`)

      for (let commandIndex = 0; commandIndex < commands.length; commandIndex += 1) {
        const command = commands[commandIndex]!
        switch (commandIndex % 6) {
          case 0:
            config[command] = false
            break
          case 1:
            config[command] = []
            break
          case 2:
            config[command] = createKey(commandIndex)
            break
          case 3:
            config[command] = [createKey(commandIndex), `ctrl+${createKey(commandIndex + 1)}`, "none"]
            break
          case 4:
            config[command] = { key: { name: createKey(commandIndex), ctrl: true }, preventDefault: false }
            break
          default:
            config[command] = "none"
            break
        }
      }

      const lookup = createBindingLookup(config)
      lookup.gather("app", commands)
      let sink = 0

      return {
        resources,
        runIteration() {
          sink += lookup.gather("app", commands).length
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "binding_lookup_gather_cold_large_mixed",
    description: "Repeated invalidated gather calls for a large mixed binding group",
    async setup() {
      const resources = await createScenarioResources()
      const config: Record<string, BindingValue> = Object.create(null)
      const commands = Array.from({ length: 512 }, (_, index) => `command_${index}`)

      for (let commandIndex = 0; commandIndex < commands.length; commandIndex += 1) {
        const command = commands[commandIndex]!
        switch (commandIndex % 6) {
          case 0:
            config[command] = false
            break
          case 1:
            config[command] = []
            break
          case 2:
            config[command] = createKey(commandIndex)
            break
          case 3:
            config[command] = [createKey(commandIndex), `ctrl+${createKey(commandIndex + 1)}`, "none"]
            break
          case 4:
            config[command] = { key: { name: createKey(commandIndex), ctrl: true }, preventDefault: false }
            break
          default:
            config[command] = "none"
            break
        }
      }

      const lookup = createBindingLookup(config)
      let sink = 0

      return {
        resources,
        runIteration() {
          lookup.invalidate("app")
          sink += lookup.gather("app", commands).length
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "binding_lookup_update_large_mixed",
    description: "Repeated lookup rebuilds from large mixed binding configs",
    async setup() {
      const resources = await createScenarioResources()
      const configs = Array.from({ length: 2 }, (_, variant) => {
        const config: Record<string, BindingValue> = Object.create(null)

        for (let commandIndex = 0; commandIndex < 512; commandIndex += 1) {
          const command = `command_${commandIndex}`
          switch ((commandIndex + variant) % 6) {
            case 0:
              config[command] = false
              break
            case 1:
              config[command] = []
              break
            case 2:
              config[command] = createKey(commandIndex)
              break
            case 3:
              config[command] = [createKey(commandIndex), `ctrl+${createKey(commandIndex + 1)}`, "none"]
              break
            case 4:
              config[command] = { key: { name: createKey(commandIndex), ctrl: true }, preventDefault: false }
              break
            default:
              config[command] = "none"
              break
          }
        }

        return config
      })
      const lookup = createBindingLookup(configs[0]!)
      const commands = Array.from({ length: 64 }, (_, index) => `command_${index}`)
      let sink = 0

      return {
        resources,
        runIteration(iteration) {
          lookup.update(configs[iteration % configs.length]!)
          sink += lookup.gather("app", commands).length
          sink += lookup.get("command_7").length
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "binding_lookup_pick_large_mixed",
    description: "Repeated gathered binding command selection for many commands and binding value shapes",
    async setup() {
      const resources = await createScenarioResources()
      const config: Record<string, BindingValue> = Object.create(null)

      for (let commandIndex = 0; commandIndex < 256; commandIndex += 1) {
        const command = `command_${commandIndex}`
        switch (commandIndex % 6) {
          case 0:
            config[command] = false
            break
          case 1:
            config[command] = []
            break
          case 2:
            config[command] = createKey(commandIndex)
            break
          case 3:
            config[command] = [createKey(commandIndex), `ctrl+${createKey(commandIndex + 1)}`, "none"]
            break
          case 4:
            config[command] = { key: { name: createKey(commandIndex), ctrl: true }, preventDefault: false }
            break
          default:
            config[command] = "none"
            break
        }
      }

      const lookup = createBindingLookup(config)
      const allCommands = Array.from({ length: 256 }, (_, index) => `command_${index}`)
      const commands = Array.from({ length: 96 }, (_, index) => `command_${(index * 5) % 256}`)
      lookup.gather("app", allCommands)
      let sink = 0

      return {
        resources,
        runIteration() {
          sink += lookup.pick("app", commands).length
          sink += lookup.pick("missing", commands).length
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "binding_lookup_omit_large_mixed",
    description: "Repeated gathered binding command exclusion for many commands and binding value shapes",
    async setup() {
      const resources = await createScenarioResources()
      const config: Record<string, BindingValue> = Object.create(null)

      for (let commandIndex = 0; commandIndex < 256; commandIndex += 1) {
        const command = `command_${commandIndex}`
        switch (commandIndex % 6) {
          case 0:
            config[command] = false
            break
          case 1:
            config[command] = []
            break
          case 2:
            config[command] = createKey(commandIndex)
            break
          case 3:
            config[command] = [createKey(commandIndex), `ctrl+${createKey(commandIndex + 1)}`, "none"]
            break
          case 4:
            config[command] = { key: { name: createKey(commandIndex), ctrl: true }, preventDefault: false }
            break
          default:
            config[command] = "none"
            break
        }
      }

      const lookup = createBindingLookup(config)
      const allCommands = Array.from({ length: 256 }, (_, index) => `command_${index}`)
      const commands = Array.from({ length: 96 }, (_, index) => `command_${(index * 5) % 256}`)
      lookup.gather("app", allCommands)
      let sink = 0

      return {
        resources,
        runIteration() {
          sink += lookup.omit("app", commands).length
          sink += lookup.omit("missing", commands).length
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "binding_lookup_exact_spaced_commands",
    description: "Repeated binding lookup creation with exact spaced command names and disables",
    async setup() {
      const resources = await createScenarioResources()
      const config: Record<string, BindingValue> = Object.create(null)

      for (let index = 0; index < 512; index += 1) {
        config[` command_${index} `] = createKey(index)
        config[`command_${index}`] = index % 4 === 0 ? false : [createKey(index + 1), { key: createKey(index + 2) }]
      }

      let sink = 0

      return {
        resources,
        runIteration() {
          const lookup = createBindingLookup(config)
          sink += lookup.bindings.length
          sink += lookup.get(" command_7 ").length
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "format_key_sequence_plain",
    description: "Repeated plain key-sequence formatting without custom options",
    async setup() {
      const resources = await createScenarioResources()
      const sequence = resources.keymap.parseKeySequence("gdd")
      let sink = ""

      return {
        resources,
        runIteration() {
          sink = formatKeySequence(sequence)
          return sink
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "format_key_sequence_token_aliases",
    description: "Repeated key-sequence formatting with token, key, modifier, and separator options",
    async setup() {
      const resources = await createScenarioResources()
      resources.keymap.registerToken({ name: "leader", key: { name: "space" } })
      const sequence = [
        ...resources.keymap.parseKeySequence("<leader>s"),
        ...resources.keymap.parseKeySequence({ name: "return", ctrl: true, shift: true, meta: true }),
      ]
      const options = {
        tokenDisplay: {
          leader: "space",
        },
        keyNameAliases: {
          enter: "return",
        },
        modifierAliases: {
          ctrl: "C",
          shift: "S",
          meta: "M",
        },
        separator: " then ",
      }
      let sink = ""

      return {
        resources,
        runIteration() {
          sink = formatKeySequence(sequence, options)
          return sink
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "format_command_bindings_dedupe_many",
    description: "Repeated command-binding formatting with display-based dedupe over many bindings",
    async setup() {
      const resources = await createScenarioResources()
      resources.keymap.registerToken({ name: "leader", key: { name: "space" } })
      const sequences = [
        resources.keymap.parseKeySequence("ctrl+s"),
        resources.keymap.parseKeySequence("ctrl+s"),
        resources.keymap.parseKeySequence("<leader>s"),
        resources.keymap.parseKeySequence("dd"),
        resources.keymap.parseKeySequence("enter"),
        resources.keymap.parseKeySequence("return"),
      ]
      const bindings: SequenceBindingLike[] = Array.from({ length: 512 }, (_, index) => ({
        sequence: sequences[index % sequences.length] ?? sequences[0]!,
      }))
      let sink: string | undefined

      return {
        resources,
        runIteration() {
          sink = formatCommandBindings(bindings)
          return sink
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "format_command_bindings_no_dedupe_many",
    description: "Repeated command-binding formatting retaining duplicate bindings",
    async setup() {
      const resources = await createScenarioResources()
      resources.keymap.registerToken({ name: "leader", key: { name: "space" } })
      const sequences = [
        resources.keymap.parseKeySequence("ctrl+s"),
        resources.keymap.parseKeySequence("<leader>s"),
        resources.keymap.parseKeySequence("dd"),
        resources.keymap.parseKeySequence({ name: "return", ctrl: true, shift: true }),
      ]
      const bindings: SequenceBindingLike[] = Array.from({ length: 512 }, (_, index) => ({
        sequence: sequences[index % sequences.length] ?? sequences[0]!,
      }))
      const options = {
        dedupe: false,
        bindingSeparator: " | ",
        tokenDisplay: {
          leader: "space",
        },
      }
      let sink: string | undefined

      return {
        resources,
        runIteration() {
          sink = formatCommandBindings(bindings, options)
          return sink
        },
        cleanup() {
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "run_command_registered",
    description: "Repeated programmatic execution of a directly registered command",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.registerLayer({
        commands: [
          {
            name: "bench-run-command",
            title: "Bench Run Command",
            desc: "Bench Run Command",
            run() {},
          },
        ],
      })

      return {
        resources,
        runIteration() {
          return resources.keymap.runCommand("bench-run-command")
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "run_command_registered_with_command",
    description: "Repeated programmatic execution of a directly registered command with command metadata included",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.registerLayer({
        commands: [
          {
            name: "bench-run-command",
            title: "Bench Run Command",
            desc: "Bench Run Command",
            run() {},
          },
        ],
      })

      return {
        resources,
        runIteration() {
          return resources.keymap.runCommand("bench-run-command", { includeCommand: true })
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_global_layers",
    description: "Repeated getActiveKeys with many global layers",
    async setup() {
      const resources = await createScenarioResources()
      registerGlobalLayers(resources.keymap, 400)

      return {
        resources,
        runIteration() {
          return resources.keymap.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_focus_tree",
    description: "Repeated getActiveKeys with deep focus chain and many unrelated target layers",
    async setup() {
      const resources = await createScenarioResources()
      const focusChain = createFocusTree(resources, 6)

      for (let index = 0; index < focusChain.length; index += 1) {
        const target = focusChain[index]
        if (!target) {
          continue
        }

        for (let layerIndex = 0; layerIndex < 6; layerIndex += 1) {
          registerTargetLayer(resources.keymap, target, index * 10 + layerIndex)
        }
      }

      for (let index = 0; index < 300; index += 1) {
        const sibling = createFocusableBox(resources.renderer, `sibling-${index}`)
        resources.renderer.root.add(sibling)
        registerTargetLayer(resources.keymap, sibling, index + 1000)
      }

      registerGlobalLayers(resources.keymap, 150)

      return {
        resources,
        runIteration() {
          return resources.keymap.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_focus_tree",
    description: "Repeated key dispatch with deep focus chain and many unrelated target layers",
    async setup() {
      const resources = await createScenarioResources()
      const focusChain = createFocusTree(resources, 6)

      for (let index = 0; index < focusChain.length; index += 1) {
        const target = focusChain[index]
        if (!target) {
          continue
        }

        for (let layerIndex = 0; layerIndex < 6; layerIndex += 1) {
          registerTargetLayer(resources.keymap, target, index * 10 + layerIndex, createKey(layerIndex + 1))
        }
      }

      const focusedTarget = focusChain.at(-1)
      if (!focusedTarget) {
        throw new Error("Expected a focused target for dispatch benchmark")
      }

      resources.keymap.registerLayer({
        target: focusedTarget,
        bindings: [{ key: "x", cmd: "noop" }],
      })

      for (let index = 0; index < 300; index += 1) {
        const sibling = createFocusableBox(resources.renderer, `dispatch-sibling-${index}`)
        resources.renderer.root.add(sibling)
        registerTargetLayer(resources.keymap, sibling, index + 2000)
      }

      registerGlobalLayers(resources.keymap, 150)

      return {
        resources,
        runIteration() {
          resources.mockInput.pressKey("x")
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_static_sequence_start_clear",
    description: "Repeated static sequence prefix dispatch followed by pending clear",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.registerLayer({
        bindings: [{ key: "gw", cmd: "noop" }],
      })

      return {
        resources,
        runIteration() {
          resources.mockInput.pressKey("g")
          resources.keymap.clearPendingSequence()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_pattern_sequence_start_clear",
    description: "Repeated pattern sequence prefix dispatch followed by pending clear",
    async setup() {
      const resources = await createScenarioResources()
      registerDigitPattern(resources.keymap)

      resources.keymap.registerLayer({
        bindings: [{ key: "{count}w", cmd: "noop" }],
      })

      return {
        resources,
        runIteration() {
          resources.mockInput.pressKey("1")
          resources.keymap.clearPendingSequence()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_static_sequence_complete",
    description: "Repeated static two-stroke sequence dispatch through command execution",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.registerLayer({
        bindings: [{ key: "gw", cmd: "noop" }],
      })

      return {
        resources,
        runIteration() {
          resources.mockInput.pressKey("g")
          resources.mockInput.pressKey("w")
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_pattern_sequence_complete",
    description: "Repeated dynamic pattern sequence dispatch through payload command execution",
    async setup() {
      const resources = await createScenarioResources()
      registerDigitPattern(resources.keymap)

      resources.keymap.registerLayer({
        bindings: [{ key: "{count}w", cmd: "noop" }],
      })

      return {
        resources,
        runIteration() {
          resources.mockInput.pressKey("1")
          resources.mockInput.pressKey("w")
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_static_key_with_pattern_sibling",
    description: "Repeated exact-key dispatch while the same layer also has a pattern binding",
    async setup() {
      const resources = await createScenarioResources()
      registerDigitPattern(resources.keymap)

      resources.keymap.registerLayer({
        bindings: [
          { key: "x", cmd: "noop" },
          { key: "{count}w", cmd: "noop" },
        ],
      })

      return {
        resources,
        runIteration() {
          resources.mockInput.pressKey("x")
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_no_match_static_layer",
    description: "Repeated no-match dispatch against a layer with only static bindings",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.registerLayer({
        bindings: [{ key: "x", cmd: "noop" }],
      })

      return {
        resources,
        runIteration() {
          resources.mockInput.pressKey("z")
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_no_match_pattern_layer",
    description: "Repeated no-match dispatch against a layer with a pattern binding",
    async setup() {
      const resources = await createScenarioResources()
      registerDigitPattern(resources.keymap)

      resources.keymap.registerLayer({
        bindings: [{ key: "{count}w", cmd: "noop" }],
      })

      return {
        resources,
        runIteration() {
          resources.mockInput.pressKey("z")
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_disambiguation_default_fast_path",
    description: "Repeated exact-key dispatch with no disambiguation resolver installed",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.registerLayer({
        bindings: [{ key: "g", cmd: "noop" }],
      })

      return {
        resources,
        runIteration() {
          resources.mockInput.pressKey("g")
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_disambiguation_sync_run_exact",
    description: "Repeated ambiguous first-stroke dispatch with a sync runExact disambiguation resolver",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.appendDisambiguationResolver((ctx) => ctx.runExact())
      resources.keymap.registerLayer({
        bindings: [
          { key: "g", cmd: "noop" },
          { key: "gg", cmd: "noop" },
        ],
      })

      return {
        resources,
        runIteration() {
          resources.mockInput.pressKey("g")
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_disambiguation_sync_continue_sequence",
    description: "Repeated ambiguous first-stroke dispatch with a sync continueSequence disambiguation resolver",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.appendDisambiguationResolver((ctx) => ctx.continueSequence())
      resources.keymap.registerLayer({
        bindings: [
          { key: "g", cmd: "noop" },
          { key: "gg", cmd: "noop" },
        ],
      })

      return {
        resources,
        runIteration() {
          resources.mockInput.pressKey("g")
          resources.keymap.clearPendingSequence()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_disambiguation_deferred_timeout_run_exact",
    description:
      "Repeated ambiguous first-stroke dispatch with a deferred timeout resolver that later runs the exact binding",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.appendDisambiguationResolver((ctx) => {
        return ctx.defer(async (deferred) => {
          const elapsed = await deferred.sleep(0)
          if (!elapsed) {
            return
          }

          return deferred.runExact()
        })
      })
      resources.keymap.registerLayer({
        bindings: [
          { key: "g", cmd: "noop" },
          { key: "gg", cmd: "noop" },
        ],
      })

      return {
        resources,
        async runIterationAsync() {
          resources.mockInput.pressKey("g")
          await Bun.sleep(0)
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_disambiguation_deferred_timeout_cancelled",
    description:
      "Repeated ambiguous first-stroke dispatch with a deferred timeout resolver that is cancelled before it resolves",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.appendDisambiguationResolver((ctx) => {
        return ctx.defer(async (deferred) => {
          const elapsed = await deferred.sleep(0)
          if (!elapsed) {
            return
          }

          return deferred.runExact()
        })
      })
      resources.keymap.registerLayer({
        bindings: [
          { key: "g", cmd: "noop" },
          { key: "gg", cmd: "noop" },
        ],
      })

      return {
        resources,
        async runIterationAsync() {
          resources.mockInput.pressKey("g")
          resources.keymap.clearPendingSequence()
          await Bun.sleep(0)
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_pending_sequence",
    description: "Repeated getActiveKeys while a multi-key sequence is pending",
    async setup() {
      const resources = await createScenarioResources()
      const focusChain = createFocusTree(resources, 5)

      for (let index = 0; index < focusChain.length; index += 1) {
        const target = focusChain[index]
        if (!target) {
          continue
        }

        for (let layerIndex = 0; layerIndex < 5; layerIndex += 1) {
          registerTargetLayer(resources.keymap, target, index * 10 + layerIndex, createKey(layerIndex + 1))
        }
      }

      registerGlobalLayers(resources.keymap, 120)
      resources.keymap.registerLayer({
        bindings: [
          { key: "ga", cmd: "noop" },
          { key: "gb", cmd: "noop" },
          { key: "gc", cmd: "noop" },
          { key: "gd", cmd: "noop" },
        ],
      })

      resources.mockInput.pressKey("g")

      return {
        resources,
        runIteration() {
          return resources.keymap.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_pending_sequence_pattern",
    description: "Repeated getActiveKeys while a dynamic sequence pattern is pending",
    async setup() {
      const resources = await createScenarioResources()
      const focusChain = createFocusTree(resources, 5)
      registerDigitPattern(resources.keymap)

      for (let index = 0; index < focusChain.length; index += 1) {
        const target = focusChain[index]
        if (!target) {
          continue
        }

        for (let layerIndex = 0; layerIndex < 5; layerIndex += 1) {
          registerTargetLayer(resources.keymap, target, index * 10 + layerIndex, createKey(layerIndex + 1))
        }
      }

      registerGlobalLayers(resources.keymap, 120)
      resources.keymap.registerLayer({
        bindings: [
          { key: "{count}a", cmd: "noop" },
          { key: "{count}b", cmd: "noop" },
          { key: "{count}c", cmd: "noop" },
          { key: "{count}d", cmd: "noop" },
        ],
      })

      resources.mockInput.pressKey("1")

      return {
        resources,
        runIteration() {
          return resources.keymap.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_pending_recompiled_token_prefix",
    description: "Repeated getActiveKeys while a late-registered token prefix is pending",
    async setup() {
      const resources = await createScenarioResources()
      const offWarning = resources.keymap.on("warning", () => {})

      for (let index = 0; index < 320; index += 1) {
        resources.keymap.registerLayer({
          bindings: [{ key: `<leader>${createKey(index)}`, cmd: "noop" }],
        })
      }

      resources.keymap.registerToken({
        name: "leader",
        key: { name: "x", ctrl: true },
      })
      resources.mockInput.pressKey("x", { ctrl: true })

      return {
        resources,
        runIteration() {
          return resources.keymap.getActiveKeys()
        },
        cleanup() {
          offWarning()
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_requirement_heavy",
    description: "Repeated getActiveKeys with many runtime-gated bindings",
    async setup() {
      const resources = await createScenarioResources()
      registerModeBindingFields(resources.keymap)
      resources.keymap.setData("vim.mode", "normal")
      resources.keymap.setData("vim.state", "idle")

      for (let index = 0; index < 320; index += 1) {
        resources.keymap.registerLayer({
          bindings: [
            {
              key: createKey(index),
              mode: index % 2 === 0 ? "normal" : "visual",
              state: index % 3 === 0 ? "idle" : "busy",
              cmd: "noop",
            },
            {
              key: createKey(index + 1),
              mode: index % 2 === 0 ? "visual" : "normal",
              state: index % 4 === 0 ? "idle" : "busy",
              cmd: "noop",
            },
          ],
        })
      }

      return {
        resources,
        runIteration() {
          return resources.keymap.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_layer_requirement_heavy",
    description: "Repeated getActiveKeys with many runtime-gated layers",
    async setup() {
      const resources = await createScenarioResources()
      registerModeLayerFields(resources.keymap)
      resources.keymap.setData("vim.mode", "normal")
      resources.keymap.setData("vim.state", "idle")

      for (let index = 0; index < 320; index += 1) {
        resources.keymap.registerLayer({
          mode: index % 2 === 0 ? "normal" : "visual",
          state: index % 3 === 0 ? "idle" : "busy",
          bindings: [
            { key: createKey(index), cmd: "noop" },
            { key: createKey(index + 1), cmd: "noop" },
          ],
        })
      }

      return {
        resources,
        runIteration() {
          return resources.keymap.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_enabled_callback_heavy",
    description: "Repeated getActiveKeys with many callback-enabled layers",
    async setup() {
      const resources = await createScenarioResources()
      const enabledStates: boolean[] = []

      for (let index = 0; index < 320; index += 1) {
        enabledStates.push(index % 3 !== 0)
        resources.keymap.registerLayer({
          enabled: () => enabledStates[index] ?? false,
          bindings: [
            { key: createKey(index), cmd: "noop" },
            { key: createKey(index + 1), cmd: "noop" },
          ],
        })
      }

      return {
        resources,
        runIteration() {
          return resources.keymap.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "get_commands_command_requirement_heavy",
    description: "Repeated getCommands with many runtime-gated commands using keyed requirements",
    async setup() {
      const resources = await createScenarioResources()
      registerModeCommandFields(resources.keymap)
      resources.keymap.setData("vim.mode", "normal")
      resources.keymap.setData("vim.state", "idle")

      resources.keymap.registerLayer({
        commands: Array.from({ length: 512 }, (_, index) => ({
          name: `command-${index}`,
          mode: index % 2 === 0 ? "normal" : "visual",
          state: index % 3 === 0 ? "idle" : "busy",
          title: `Command ${index}`,
          run() {},
        })),
      })

      return {
        resources,
        runIteration() {
          return resources.keymap.getCommands()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "get_commands_enabled_command_callback_heavy",
    description: "Repeated getCommands with many callback-enabled commands via the enabled fields addon",
    async setup() {
      const resources = await createScenarioResources()
      const enabledStates: boolean[] = []

      addons.registerEnabledFields(resources.keymap)

      resources.keymap.registerLayer({
        commands: Array.from({ length: 512 }, (_, index) => {
          enabledStates.push(index % 3 !== 0)

          return {
            name: `command-${index}`,
            enabled: () => enabledStates[index] ?? false,
            title: `Command ${index}`,
            run() {},
          }
        }),
      })

      return {
        resources,
        runIteration() {
          return resources.keymap.getCommands()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_binding_sparse_data_churn",
    description: "Repeated setData and getActiveKeys with per-binding dependency keys",
    async setup() {
      const resources = await createScenarioResources()
      registerNamedBindingFields(resources.keymap)

      for (let index = 0; index < 320; index += 1) {
        resources.keymap.setData(createFlagKey(index), false)
        resources.keymap.registerLayer({
          bindings: [
            {
              key: createKey(index),
              activeWhen: createFlagKey(index),
              cmd: "noop",
            },
          ],
        })
      }

      return {
        resources,
        runIteration(iteration) {
          const key = createFlagKey(iteration % 320)
          const nextValue = Math.floor(iteration / 320) % 2 === 0
          resources.keymap.setData(key, nextValue)
          return resources.keymap.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_layer_sparse_data_churn",
    description: "Repeated setData and getActiveKeys with per-layer dependency keys",
    async setup() {
      const resources = await createScenarioResources()
      registerNamedLayerFields(resources.keymap)

      for (let index = 0; index < 320; index += 1) {
        resources.keymap.setData(createFlagKey(index), false)
        resources.keymap.registerLayer({
          activeWhen: createFlagKey(index),
          bindings: [{ key: createKey(index), cmd: "noop" }],
        })
      }

      return {
        resources,
        runIteration(iteration) {
          const key = createFlagKey(iteration % 320)
          const nextValue = Math.floor(iteration / 320) % 2 === 0
          resources.keymap.setData(key, nextValue)
          return resources.keymap.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "state_change_focus_churn_noop",
    description: "Repeated focus changes with a noop state listener",
    async setup() {
      const resources = await createScenarioResources()
      const { first, second } = setupStateChangeFocusChurn(resources)
      const offStateChange = registerStateChangeNoopListener(resources.keymap)
      let focusFirst = false

      first.focus()

      return {
        resources,
        runIteration() {
          if (focusFirst) {
            first.focus()
          } else {
            second.focus()
          }

          focusFirst = !focusFirst
        },
        cleanup() {
          offStateChange()
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "state_change_focus_churn_read_heavy",
    description: "Repeated focus changes with active key and prefix listeners",
    async setup() {
      const resources = await createScenarioResources()
      const { first, second } = setupStateChangeFocusChurn(resources)
      const offStateChange = registerStateChangeReadListeners(resources.keymap)
      let focusFirst = false

      first.focus()

      return {
        resources,
        runIteration() {
          if (focusFirst) {
            first.focus()
          } else {
            second.focus()
          }

          focusFirst = !focusFirst
        },
        cleanup() {
          offStateChange()
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "state_change_focus_churn_metadata_read_heavy",
    description: "Repeated focus changes with active metadata and prefix listeners",
    async setup() {
      const resources = await createScenarioResources()
      const focusChain = setupMetadataFocusTree(resources)
      const offStateChange = registerStateChangeMetadataListeners(resources.keymap)
      const first = focusChain[0]
      const second = focusChain[1]
      let focusFirst = false

      if (!first || !second) {
        throw new Error("Expected metadata focus targets for metadata benchmark")
      }

      first.focus()

      return {
        resources,
        runIteration() {
          if (focusFirst) {
            first.focus()
          } else {
            second.focus()
          }

          focusFirst = !focusFirst
        },
        cleanup() {
          offStateChange()
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "state_change_focus_churn_bindings_read_heavy",
    description: "Repeated focus changes with active binding and prefix listeners",
    async setup() {
      const resources = await createScenarioResources()
      const focusChain = setupMetadataFocusTree(resources)
      const offStateChange = registerStateChangeBindingListeners(resources.keymap)
      const first = focusChain[0]
      const second = focusChain[1]
      let focusFirst = false

      if (!first || !second) {
        throw new Error("Expected metadata focus targets for binding benchmark")
      }

      first.focus()

      return {
        resources,
        runIteration() {
          if (focusFirst) {
            first.focus()
          } else {
            second.focus()
          }

          focusFirst = !focusFirst
        },
        cleanup() {
          offStateChange()
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "state_change_focus_churn_repeat_reads_5x",
    description: "Repeated focus changes followed by five active key reads",
    async setup() {
      const resources = await createScenarioResources()
      const { first, second } = setupStateChangeFocusChurn(resources)
      let focusFirst = false

      first.focus()

      return {
        resources,
        runIteration() {
          if (focusFirst) {
            first.focus()
          } else {
            second.focus()
          }

          readActiveKeysRepeatedly(resources.keymap, 5)
          focusFirst = !focusFirst
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "state_change_pending_blur_read_heavy",
    description: "Repeated pending sequence blur clears with state listeners",
    async setup() {
      const resources = await createScenarioResources()
      const target = createFocusableBox(resources.renderer, "state-pending-target")
      const offStateChange = registerStateChangeReadListeners(resources.keymap)

      resources.renderer.root.add(target)
      resources.keymap.registerLayer({
        target,
        bindings: [{ key: "dd", cmd: "noop" }],
      })

      return {
        resources,
        runIteration() {
          target.focus()
          resources.mockInput.pressKey("d")
          target.blur()
        },
        cleanup() {
          offStateChange()
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "state_change_external_invalidation_read_heavy",
    description: "Repeated external reactive-matcher invalidation with state listeners",
    async setup() {
      const resources = await createScenarioResources()
      const store = createFlagStore()
      const offStateChange = registerStateChangeReadListeners(resources.keymap)

      registerExternalBindingFields(resources.keymap, store)

      for (let index = 0; index < 320; index += 1) {
        const key = createFlagKey(index)
        store.flags[key] = false
        resources.keymap.registerLayer({
          bindings: [
            {
              key: createKey(index),
              activeExternally: key,
              cmd: "noop",
            },
          ],
        })
      }

      return {
        resources,
        runIteration(iteration) {
          const key = createFlagKey(iteration % 320)
          store.set(key, Math.floor(iteration / 320) % 2 === 0)
        },
        cleanup() {
          offStateChange()
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "active_keys_prefix_merge_heavy",
    description: "Repeated getActiveKeys with many overlapping prefixes across layers",
    async setup() {
      const resources = await createScenarioResources()

      for (let index = 0; index < 160; index += 1) {
        resources.keymap.registerLayer({
          bindings: [
            { key: "ga", cmd: "noop" },
            { key: "gb", cmd: "noop" },
            { key: "gc", cmd: "noop" },
            { key: "gd", cmd: "noop" },
          ],
        })
      }

      return {
        resources,
        runIteration() {
          return resources.keymap.getActiveKeys()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_key_hooks_heavy",
    description: "Repeated key dispatch with many registered key hooks",
    async setup() {
      const resources = await createScenarioResources()

      for (let index = 0; index < 80; index += 1) {
        resources.keymap.intercept(
          "key",
          ({ event }) => {
            if (event.name === "z") {
              return
            }
          },
          { priority: index % 5 },
        )
      }

      return {
        resources,
        runIteration() {
          resources.mockInput.pressKey("x")
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "dispatch_command_data_heavy",
    description: "Repeated matched dispatch while commands receive many runtime data fields",
    async setup() {
      const resources = await createScenarioResources()

      resources.keymap.registerLayer({
        commands: [
          {
            name: "consume-data",
            run(ctx) {
              if (ctx.data["field-0"] === "value-0") {
                return
              }
            },
          },
        ],
      })

      for (let index = 0; index < 20; index += 1) {
        resources.keymap.setData(`field-${index}`, `value-${index}`)
      }

      resources.keymap.registerLayer({
        bindings: [{ key: "x", cmd: "consume-data" }],
      })

      return {
        resources,
        runIteration() {
          resources.mockInput.pressKey("x")
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "trace_editor_mixed_dispatch",
    kind: "trace",
    description:
      "Mixed editor-like dispatch trace with focus changes, sequences, patterns, commands, and unrelated layers",
    async setup() {
      const resources = await createScenarioResources()
      const targets = setupTraceApp(resources)
      const operations = [
        () => resources.mockInput.pressKey("j"),
        () => resources.mockInput.pressKey("k"),
        () => resources.mockInput.pressKey("d"),
        () => resources.mockInput.pressKey("d"),
        () => resources.mockInput.pressKey("g"),
        () => resources.mockInput.pressKey("g"),
        () => resources.mockInput.pressKey("1"),
        () => resources.mockInput.pressKey("2"),
        () => resources.mockInput.pressKey("j"),
        () => resources.mockInput.pressKey("p", { ctrl: true }),
        () => resources.mockInput.pressKey("s", { ctrl: true }),
        () => resources.mockInput.pressKey("space"),
        () => resources.mockInput.pressKey("f"),
        () => resources.keymap.setData("vim.mode", "insert"),
        () => resources.mockInput.pressKey("x"),
        () => resources.keymap.setData("vim.mode", "normal"),
        () => resources.mockInput.pressKey("escape"),
      ]

      return {
        resources,
        runIteration(iteration) {
          if (iteration % 11 === 0) {
            targets[(iteration / 11) % targets.length]?.focus()
          }

          operations[iteration % operations.length]?.()
          consume(resources.keymap.getPendingSequence())
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "trace_active_keys_subscribers",
    kind: "trace",
    description:
      "Which-key style trace: state/focus changes followed by active-key and pending-sequence subscriber reads",
    async setup() {
      const resources = await createScenarioResources()
      const targets = setupTraceApp(resources)
      let sink = 0

      const offState = resources.keymap.on("state", () => {
        sink += resources.keymap.getActiveKeys({ includeMetadata: true }).length
        sink += resources.keymap.getPendingSequence().length
      })
      const offPending = resources.keymap.on("pendingSequence", (sequence) => {
        sink += sequence.length
      })

      return {
        resources,
        runIteration(iteration) {
          switch (iteration % 8) {
            case 0:
              targets[(iteration / 8) % targets.length]?.focus()
              break
            case 1:
              resources.keymap.setData("vim.mode", iteration % 16 === 1 ? "visual" : "normal")
              break
            case 2:
              resources.mockInput.pressKey("g")
              break
            case 3:
              consume(resources.keymap.getActiveKeys({ includeBindings: true, includeMetadata: true }))
              break
            case 4:
              resources.keymap.clearPendingSequence()
              break
            case 5:
              consume(resources.keymap.getCommandEntries({ search: "write", searchIn: ["name", "title", "usage"] }))
              break
            case 6:
              resources.mockInput.pressKey("space")
              break
            default:
              consume(resources.keymap.getActiveKeys())
              break
          }
        },
        cleanup() {
          offPending()
          offState()
          consume(sink)
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "trace_command_palette_typing",
    kind: "trace",
    description: "Command-palette typing trace with varied searches, filters, entries, bindings, and formatting",
    async setup() {
      const resources = await createScenarioResources()
      const targets = setupTraceTargets(resources, 4)
      setupTraceCommandCatalog(resources, 768)
      setupTraceBindings(resources, targets)
      const searches = ["w", "wr", "write", "open", "buffer", "trace", "file", ""]

      return {
        resources,
        runIteration(iteration) {
          const search = searches[iteration % searches.length] ?? ""
          const namespace = iteration % 3 === 0 ? "editor" : iteration % 3 === 1 ? "palette" : undefined
          const entries = resources.keymap.getCommandEntries({
            search,
            searchIn: ["name", "title", "usage", "desc"],
            namespace,
            filter: iteration % 2 === 0 ? { tags: "file" } : undefined,
            limit: 50,
          })

          consume(entries)
          const first = entries[0]
          if (first) {
            consume(formatCommandBindings(first.bindings))
          }
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
  {
    name: "trace_layer_mount_unmount",
    kind: "trace",
    description:
      "Component mount/unmount trace registering local commands and bindings, reading active keys, then disposing",
    async setup() {
      const resources = await createScenarioResources()
      const targets = setupTraceTargets(resources, 12)
      setupTraceCommandCatalog(resources, 128)
      registerDigitPattern(resources.keymap)
      resources.keymap.appendDisambiguationResolver((ctx) => ctx.continueSequence())

      return {
        resources,
        runIteration(iteration) {
          const target = targets[iteration % targets.length]
          if (!target) {
            return
          }

          target.focus()
          const commandName = `trace.local.${iteration % 32}`
          const off = resources.keymap.registerLayer({
            target,
            priority: iteration % 5,
            commands: [
              {
                name: commandName,
                title: `Local ${iteration % 32}`,
                run() {},
              },
            ],
            bindings: [
              { key: createKey(iteration), cmd: commandName, desc: "Local action", group: "Local" },
              { key: `g${createKey(iteration + 1)}`, cmd: commandName, desc: "Local sequence", group: "Local" },
              { key: `{count}${createKey(iteration + 2)}`, cmd: commandName, desc: "Local count", group: "Local" },
            ],
          })

          consume(resources.keymap.getActiveKeys({ includeMetadata: true }))
          off()
        },
        cleanup() {
          resources.renderer.destroy()
        },
      }
    },
  },
]

async function runScenario(scenario: BenchmarkScenario, args: BenchmarkArgs): Promise<BenchmarkResult> {
  const instance = await scenario.setup()

  try {
    let nextIteration = 0
    nextIteration = await runIterations(instance, args.warmupIterations, nextIteration)

    let batchIterations = args.iterations
    const calibration = await timeIterations(instance, batchIterations, nextIteration)
    nextIteration = calibration.nextIteration

    if (calibration.durationMs > 0 && calibration.durationMs < args.minSampleMs) {
      const scaledIterations = (batchIterations * args.minSampleMs) / calibration.durationMs
      batchIterations = roundIterations(scaledIterations)
    }

    if (batchIterations !== args.iterations) {
      nextIteration = await runIterations(instance, Math.min(batchIterations, args.warmupIterations), nextIteration)
    }

    const samples: BenchmarkSample[] = []
    for (let round = 0; round < args.rounds; round += 1) {
      const start = nowNs()
      let sampleIterations = 0
      let durationMs = 0

      do {
        nextIteration = await runIterations(instance, batchIterations, nextIteration)
        sampleIterations += batchIterations
        durationMs = nsToMs(nowNs() - start)
      } while (durationMs < args.minSampleMs)

      samples.push({
        round: round + 1,
        iterations: sampleIterations,
        durationMs,
        opsPerSecond: (sampleIterations * 1000) / durationMs,
        nsPerOperation: (durationMs * 1_000_000) / sampleIterations,
      })
    }

    const durations = samples.map((sample) => sample.durationMs)
    const opsPerSecond = samples.map((sample) => sample.opsPerSecond)
    const nsPerOperation = samples.map((sample) => sample.nsPerOperation)

    return {
      name: scenario.name,
      description: scenario.description,
      kind: scenario.kind ?? inferScenarioKind(scenario.name),
      iterations: args.iterations,
      warmupIterations: args.warmupIterations,
      rounds: args.rounds,
      minSampleMs: args.minSampleMs,
      batchIterations,
      totalMeasuredIterations: samples.reduce((total, sample) => total + sample.iterations, 0),
      medianDurationMs: median(durations),
      bestDurationMs: Math.min(...durations),
      medianOpsPerSecond: median(opsPerSecond),
      meanOpsPerSecond: mean(opsPerSecond),
      medianNsPerOperation: median(nsPerOperation),
      p95NsPerOperation: percentile(nsPerOperation, 95),
      stdDevNsPerOperation: sampleStdDev(nsPerOperation),
      rmePercent: relativeMarginOfError(nsPerOperation),
      samples,
    }
  } finally {
    instance.cleanup()
  }
}

async function timeIterations(
  instance: ScenarioInstance,
  count: number,
  startIteration: number,
): Promise<{ durationMs: number; nextIteration: number }> {
  const start = nowNs()
  const nextIteration = await runIterations(instance, count, startIteration)
  return {
    durationMs: nsToMs(nowNs() - start),
    nextIteration,
  }
}

async function runIterations(instance: ScenarioInstance, count: number, startIteration: number): Promise<number> {
  if (count <= 0) {
    return startIteration
  }

  const runIteration = instance.runIteration
  if (runIteration) {
    for (let iteration = 0; iteration < count; iteration += 1) {
      consume(runIteration(startIteration + iteration))
    }
    return startIteration + count
  }

  const runIterationAsync = instance.runIterationAsync
  if (!runIterationAsync) {
    throw new Error("Benchmark scenario must provide runIteration or runIterationAsync")
  }

  for (let iteration = 0; iteration < count; iteration += 1) {
    consume(await runIterationAsync(startIteration + iteration))
  }

  return startIteration + count
}

function formatNumber(value: number): string {
  return value.toFixed(2)
}

function printResults(results: BenchmarkResult[], args: BenchmarkArgs): void {
  console.log(
    `keymap-benchmark iters=${args.iterations} warmup=${args.warmupIterations} rounds=${args.rounds} min_sample_ms=${args.minSampleMs} scenarios=${results.length} checksum=${blackhole.checksum}`,
  )
  console.log("")

  const header = ["scenario", "kind", "batch", "median ns/op", "p95 ns/op", "median ops/sec", "rme %"]
  const rows = results.map((result) => [
    result.name,
    result.kind,
    String(result.batchIterations),
    formatNumber(result.medianNsPerOperation),
    formatNumber(result.p95NsPerOperation),
    formatNumber(result.medianOpsPerSecond),
    formatNumber(result.rmePercent),
  ])

  const widths = header.map((title, index) => {
    return Math.max(title.length, ...rows.map((row) => row[index]?.length ?? 0))
  })

  const lines = [header, ...rows].map((row, rowIndex) => {
    const line = row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ")
    if (rowIndex !== 0) {
      return line
    }

    const divider = widths.map((width) => "-".repeat(width)).join("  ")
    return `${line}\n${divider}`
  })

  console.log(lines.join("\n"))
  console.log("")

  for (const result of results) {
    console.log(`${result.name}: ${result.description}`)
    for (const sample of result.samples) {
      console.log(
        `  round ${sample.round}: ${sample.iterations} iters, ${formatNumber(sample.durationMs)} ms, ${formatNumber(sample.nsPerOperation)} ns/op (${formatNumber(sample.opsPerSecond)} ops/sec)`,
      )
    }
  }
}

function writeResults(results: BenchmarkResult[], args: BenchmarkArgs, jsonPath: string): void {
  const absolutePath = path.isAbsolute(jsonPath) ? jsonPath : path.resolve(process.cwd(), jsonPath)
  mkdirSync(path.dirname(absolutePath), { recursive: true })
  writeFileSync(
    absolutePath,
    JSON.stringify(
      {
        meta: {
          timestamp: new Date().toISOString(),
          iterations: args.iterations,
          warmupIterations: args.warmupIterations,
          rounds: args.rounds,
          minSampleMs: args.minSampleMs,
          cwd: process.cwd(),
          args: process.argv.slice(2),
          runtime: {
            bun: typeof Bun !== "undefined" ? Bun.version : undefined,
            node: process.versions.node,
            v8: process.versions.v8,
            platform: process.platform,
            arch: process.arch,
          },
          blackholeChecksum: blackhole.checksum,
        },
        results,
      },
      null,
      2,
    ),
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const results: BenchmarkResult[] = []

  if (args.listScenarios) {
    for (const scenario of scenarios) {
      console.log(`${scenario.name}\t${scenario.kind ?? inferScenarioKind(scenario.name)}\t${scenario.description}`)
    }
    return
  }

  const selectedScenarios = args.scenarioNames
    ? scenarios.filter((scenario) => args.scenarioNames!.has(scenario.name))
    : scenarios

  if (selectedScenarios.length === 0) {
    throw new Error("No benchmark scenarios matched the provided --scenario filter")
  }

  for (const scenario of selectedScenarios) {
    results.push(await runScenario(scenario, args))
  }

  printResults(results, args)

  if (args.jsonPath) {
    writeResults(results, args, args.jsonPath)
  }
}

await main()
