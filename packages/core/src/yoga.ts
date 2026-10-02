import { nativeConstants } from "./native-abi.generated.js"
import {
  NATIVE_EDGE_NONE,
  NATIVE_STYLE_BORDER_WIDTH,
  NativeStyleFlags,
  NativeStyleGroup,
  resolveRenderLib,
  type RenderLib,
  type SceneNodeHandle,
} from "./zig.js"
import type { FFICallbackInstance, Pointer } from "./platform/ffi.js"
import type { NativeScene } from "./NativeScene.js"

export enum Align {
  Auto = nativeConstants.OT_ALIGN_AUTO,
  FlexStart = nativeConstants.OT_ALIGN_FLEX_START,
  Center = nativeConstants.OT_ALIGN_CENTER,
  FlexEnd = nativeConstants.OT_ALIGN_FLEX_END,
  Stretch = nativeConstants.OT_ALIGN_STRETCH,
  Baseline = nativeConstants.OT_ALIGN_BASELINE,
  SpaceBetween = nativeConstants.OT_ALIGN_SPACE_BETWEEN,
  SpaceAround = nativeConstants.OT_ALIGN_SPACE_AROUND,
  SpaceEvenly = nativeConstants.OT_ALIGN_SPACE_EVENLY,
}

export enum BoxSizing {
  BorderBox = nativeConstants.OT_BOX_SIZING_BORDER_BOX,
  ContentBox = nativeConstants.OT_BOX_SIZING_CONTENT_BOX,
}

export enum Dimension {
  Width = nativeConstants.OT_DIMENSION_WIDTH,
  Height = nativeConstants.OT_DIMENSION_HEIGHT,
}

export enum Direction {
  Inherit = nativeConstants.OT_DIRECTION_INHERIT,
  LTR = nativeConstants.OT_DIRECTION_LTR,
  RTL = nativeConstants.OT_DIRECTION_RTL,
}

export enum Display {
  Flex = 0,
  None = 1,
  Contents = 2,
}

export enum Edge {
  Left = nativeConstants.OT_EDGE_LEFT,
  Top = nativeConstants.OT_EDGE_TOP,
  Right = nativeConstants.OT_EDGE_RIGHT,
  Bottom = nativeConstants.OT_EDGE_BOTTOM,
  Start = nativeConstants.OT_EDGE_START,
  End = nativeConstants.OT_EDGE_END,
  Horizontal = nativeConstants.OT_EDGE_HORIZONTAL,
  Vertical = nativeConstants.OT_EDGE_VERTICAL,
  All = nativeConstants.OT_EDGE_ALL,
}

export enum Errata {
  None = 0,
  StretchFlexBasis = 1,
  AbsolutePositionWithoutInsetsExcludesPadding = 2,
  AbsolutePercentAgainstInnerSize = 4,
  All = 2147483647,
  Classic = 2147483646,
}

export enum ExperimentalFeature {
  WebFlexBasis = 0,
}

export enum FlexDirection {
  Column = nativeConstants.OT_FLEX_DIRECTION_COLUMN,
  ColumnReverse = nativeConstants.OT_FLEX_DIRECTION_COLUMN_REVERSE,
  Row = nativeConstants.OT_FLEX_DIRECTION_ROW,
  RowReverse = nativeConstants.OT_FLEX_DIRECTION_ROW_REVERSE,
}

export enum Gutter {
  Column = nativeConstants.OT_GUTTER_COLUMN,
  Row = nativeConstants.OT_GUTTER_ROW,
  All = nativeConstants.OT_GUTTER_ALL,
}

export enum Justify {
  FlexStart = nativeConstants.OT_JUSTIFY_FLEX_START,
  Center = nativeConstants.OT_JUSTIFY_CENTER,
  FlexEnd = nativeConstants.OT_JUSTIFY_FLEX_END,
  SpaceBetween = nativeConstants.OT_JUSTIFY_SPACE_BETWEEN,
  SpaceAround = nativeConstants.OT_JUSTIFY_SPACE_AROUND,
  SpaceEvenly = nativeConstants.OT_JUSTIFY_SPACE_EVENLY,
}

export enum LogLevel {
  Error = 0,
  Warn = 1,
  Info = 2,
  Debug = 3,
  Verbose = 4,
  Fatal = 5,
}

export enum MeasureMode {
  Undefined = nativeConstants.OT_MEASURE_UNDEFINED,
  Exactly = nativeConstants.OT_MEASURE_EXACTLY,
  AtMost = nativeConstants.OT_MEASURE_AT_MOST,
}

export enum NodeType {
  Default = 0,
  Text = 1,
}

export enum Overflow {
  Visible = nativeConstants.OT_OVERFLOW_VISIBLE,
  Hidden = nativeConstants.OT_OVERFLOW_HIDDEN,
  Scroll = nativeConstants.OT_OVERFLOW_SCROLL,
}

export enum PositionType {
  Static = nativeConstants.OT_POSITION_STATIC,
  Relative = nativeConstants.OT_POSITION_RELATIVE,
  Absolute = nativeConstants.OT_POSITION_ABSOLUTE,
}

export enum Unit {
  Undefined = nativeConstants.OT_UNIT_UNDEFINED,
  Point = nativeConstants.OT_UNIT_POINT,
  Percent = nativeConstants.OT_UNIT_PERCENT,
  Auto = nativeConstants.OT_UNIT_AUTO,
}

export enum Wrap {
  NoWrap = nativeConstants.OT_FLEX_WRAP_NONE,
  Wrap = nativeConstants.OT_FLEX_WRAP_WRAP,
  WrapReverse = nativeConstants.OT_FLEX_WRAP_REVERSE,
}

export const ALIGN_AUTO = Align.Auto
export const ALIGN_FLEX_START = Align.FlexStart
export const ALIGN_CENTER = Align.Center
export const ALIGN_FLEX_END = Align.FlexEnd
export const ALIGN_STRETCH = Align.Stretch
export const ALIGN_BASELINE = Align.Baseline
export const ALIGN_SPACE_BETWEEN = Align.SpaceBetween
export const ALIGN_SPACE_AROUND = Align.SpaceAround
export const ALIGN_SPACE_EVENLY = Align.SpaceEvenly

export const BOX_SIZING_BORDER_BOX = BoxSizing.BorderBox
export const BOX_SIZING_CONTENT_BOX = BoxSizing.ContentBox

export const DIMENSION_WIDTH = Dimension.Width
export const DIMENSION_HEIGHT = Dimension.Height

export const DIRECTION_INHERIT = Direction.Inherit
export const DIRECTION_LTR = Direction.LTR
export const DIRECTION_RTL = Direction.RTL

export const DISPLAY_FLEX = Display.Flex
export const DISPLAY_NONE = Display.None
export const DISPLAY_CONTENTS = Display.Contents

export const EDGE_LEFT = Edge.Left
export const EDGE_TOP = Edge.Top
export const EDGE_RIGHT = Edge.Right
export const EDGE_BOTTOM = Edge.Bottom
export const EDGE_START = Edge.Start
export const EDGE_END = Edge.End
export const EDGE_HORIZONTAL = Edge.Horizontal
export const EDGE_VERTICAL = Edge.Vertical
export const EDGE_ALL = Edge.All

export const ERRATA_NONE = Errata.None
export const ERRATA_STRETCH_FLEX_BASIS = Errata.StretchFlexBasis
export const ERRATA_ABSOLUTE_POSITION_WITHOUT_INSETS_EXCLUDES_PADDING =
  Errata.AbsolutePositionWithoutInsetsExcludesPadding
export const ERRATA_ABSOLUTE_PERCENT_AGAINST_INNER_SIZE = Errata.AbsolutePercentAgainstInnerSize
export const ERRATA_ALL = Errata.All
export const ERRATA_CLASSIC = Errata.Classic

export const EXPERIMENTAL_FEATURE_WEB_FLEX_BASIS = ExperimentalFeature.WebFlexBasis

export const FLEX_DIRECTION_COLUMN = FlexDirection.Column
export const FLEX_DIRECTION_COLUMN_REVERSE = FlexDirection.ColumnReverse
export const FLEX_DIRECTION_ROW = FlexDirection.Row
export const FLEX_DIRECTION_ROW_REVERSE = FlexDirection.RowReverse

export const GUTTER_COLUMN = Gutter.Column
export const GUTTER_ROW = Gutter.Row
export const GUTTER_ALL = Gutter.All

export const JUSTIFY_FLEX_START = Justify.FlexStart
export const JUSTIFY_CENTER = Justify.Center
export const JUSTIFY_FLEX_END = Justify.FlexEnd
export const JUSTIFY_SPACE_BETWEEN = Justify.SpaceBetween
export const JUSTIFY_SPACE_AROUND = Justify.SpaceAround
export const JUSTIFY_SPACE_EVENLY = Justify.SpaceEvenly

export const LOG_LEVEL_ERROR = LogLevel.Error
export const LOG_LEVEL_WARN = LogLevel.Warn
export const LOG_LEVEL_INFO = LogLevel.Info
export const LOG_LEVEL_DEBUG = LogLevel.Debug
export const LOG_LEVEL_VERBOSE = LogLevel.Verbose
export const LOG_LEVEL_FATAL = LogLevel.Fatal

export const MEASURE_MODE_UNDEFINED = MeasureMode.Undefined
export const MEASURE_MODE_EXACTLY = MeasureMode.Exactly
export const MEASURE_MODE_AT_MOST = MeasureMode.AtMost

export const NODE_TYPE_DEFAULT = NodeType.Default
export const NODE_TYPE_TEXT = NodeType.Text

export const OVERFLOW_VISIBLE = Overflow.Visible
export const OVERFLOW_HIDDEN = Overflow.Hidden
export const OVERFLOW_SCROLL = Overflow.Scroll

export const POSITION_TYPE_STATIC = PositionType.Static
export const POSITION_TYPE_RELATIVE = PositionType.Relative
export const POSITION_TYPE_ABSOLUTE = PositionType.Absolute

export const UNIT_UNDEFINED = Unit.Undefined
export const UNIT_POINT = Unit.Point
export const UNIT_PERCENT = Unit.Percent
export const UNIT_AUTO = Unit.Auto

export const WRAP_NO_WRAP = Wrap.NoWrap
export const WRAP_WRAP = Wrap.Wrap
export const WRAP_WRAP_REVERSE = Wrap.WrapReverse

export interface Layout {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface Value {
  unit: Unit
  value: number
}

export type MeasureFunction = (width: number, widthMode: MeasureMode, height: number, heightMode: MeasureMode) => Size
export type DirtiedFunction = (node: Node) => void

type ValueInput = number | "auto" | `${number}%` | Value | undefined
type ValueInputNoAuto = number | `${number}%` | Value | undefined

export const YogaEnumKind = {
  Direction: nativeConstants.OT_STYLE_ENUM_DIRECTION,
  FlexDirection: nativeConstants.OT_STYLE_ENUM_FLEX_DIRECTION,
  JustifyContent: nativeConstants.OT_STYLE_ENUM_JUSTIFY_CONTENT,
  AlignContent: nativeConstants.OT_STYLE_ENUM_ALIGN_CONTENT,
  AlignItems: nativeConstants.OT_STYLE_ENUM_ALIGN_ITEMS,
  AlignSelf: nativeConstants.OT_STYLE_ENUM_ALIGN_SELF,
  PositionType: nativeConstants.OT_STYLE_ENUM_POSITION_TYPE,
  FlexWrap: nativeConstants.OT_STYLE_ENUM_FLEX_WRAP,
  Overflow: nativeConstants.OT_STYLE_ENUM_OVERFLOW,
  Display: nativeConstants.OT_STYLE_ENUM_DISPLAY,
  BoxSizing: nativeConstants.OT_STYLE_ENUM_BOX_SIZING,
} as const

export const YogaFloatKind = {
  Flex: nativeConstants.OT_STYLE_FLOAT_FLEX,
  FlexGrow: nativeConstants.OT_STYLE_FLOAT_FLEX_GROW,
  FlexShrink: nativeConstants.OT_STYLE_FLOAT_FLEX_SHRINK,
  AspectRatio: nativeConstants.OT_STYLE_FLOAT_ASPECT_RATIO,
} as const

export const YogaValueKind = {
  Width: nativeConstants.OT_STYLE_VALUE_WIDTH,
  Height: nativeConstants.OT_STYLE_VALUE_HEIGHT,
  MinWidth: nativeConstants.OT_STYLE_VALUE_MIN_WIDTH,
  MinHeight: nativeConstants.OT_STYLE_VALUE_MIN_HEIGHT,
  MaxWidth: nativeConstants.OT_STYLE_VALUE_MAX_WIDTH,
  MaxHeight: nativeConstants.OT_STYLE_VALUE_MAX_HEIGHT,
  FlexBasis: nativeConstants.OT_STYLE_VALUE_FLEX_BASIS,
  Margin: nativeConstants.OT_STYLE_VALUE_MARGIN,
  Padding: nativeConstants.OT_STYLE_VALUE_PADDING,
  Position: nativeConstants.OT_STYLE_VALUE_POSITION,
  Gap: nativeConstants.OT_STYLE_VALUE_GAP,
} as const

export type YogaEnumKindId = (typeof YogaEnumKind)[keyof typeof YogaEnumKind]
export type YogaFloatKindId = (typeof YogaFloatKind)[keyof typeof YogaFloatKind]
export type YogaValueKindId = (typeof YogaValueKind)[keyof typeof YogaValueKind]

type SceneStyleNode = { _getSceneHandle(owner: NativeScene): SceneNodeHandle }

export function sceneSetEnum(scene: NativeScene, node: SceneStyleNode, kind: YogaEnumKindId, value: number): void {
  scene.setStyle(node, NativeStyleGroup.Enum, kind, NATIVE_EDGE_NONE, Unit.Undefined, value)
}

export function sceneGetEnum(
  scene: NativeScene,
  node: SceneStyleNode,
  kind: YogaEnumKindId,
  fallback?: number,
): number {
  return scene.getStyle(node, NativeStyleGroup.Enum, kind, NATIVE_EDGE_NONE).value ?? fallback
}

export function sceneSetFloat(
  scene: NativeScene,
  node: SceneStyleNode,
  kind: YogaFloatKindId,
  value: number | undefined,
): void {
  scene.setStyle(node, NativeStyleGroup.Float, kind, NATIVE_EDGE_NONE, Unit.Undefined, value ?? NaN)
}

export function sceneGetFloat(scene: NativeScene, node: SceneStyleNode, kind: YogaFloatKindId): number {
  return scene.getStyle(node, NativeStyleGroup.Float, kind, NATIVE_EDGE_NONE).value
}

export function sceneSetValue(
  scene: NativeScene,
  node: SceneStyleNode,
  kind: YogaValueKindId,
  edge: number,
  valueInput: ValueInput,
): void {
  const value = parseYogaValue(valueInput)
  scene.setStyle(node, NativeStyleGroup.Value, kind, edge, value.unit, value.value)
}

export function sceneGetValue(scene: NativeScene, node: SceneStyleNode, kind: YogaValueKindId, edge: number): Value {
  return scene.getStyle(node, NativeStyleGroup.Value, kind, edge)
}

export function sceneSetDimension(
  scene: NativeScene,
  node: SceneStyleNode,
  dimension: Dimension,
  input: ValueInput,
  disableFlexShrink: boolean = false,
): void {
  const value = parseYogaValue(input)
  scene.setStyle(
    node,
    NativeStyleGroup.Dimension,
    dimension,
    NATIVE_EDGE_NONE,
    value.unit,
    value.value,
    disableFlexShrink ? NativeStyleFlags.DisableFlexShrink : NativeStyleFlags.None,
  )
}

export function sceneSetBorder(scene: NativeScene, node: SceneStyleNode, edge: Edge, border: number | undefined): void {
  scene.setStyle(node, NativeStyleGroup.Border, NATIVE_STYLE_BORDER_WIDTH, edge, Unit.Point, border ?? NaN)
}

export function sceneGetBorder(scene: NativeScene, node: SceneStyleNode, edge: Edge): number {
  return scene.getStyle(node, NativeStyleGroup.Border, NATIVE_STYLE_BORDER_WIDTH, edge).value
}

const YogaEdgeLayoutKind = {
  Margin: 0,
  Padding: 1,
  Border: 2,
} as const

const UNDEFINED_VALUE: Value = { unit: Unit.Undefined, value: NaN }

export enum YogaStatus {
  Ok = 0,
  InvalidArgument = 1,
  OutOfMemory = 2,
  Exception = 3,
  Poisoned = 4,
  Busy = 5,
  DepthLimit = 6,
}

export class YogaError extends Error {
  readonly name = "YogaError"

  constructor(
    readonly operation: string,
    readonly status: YogaStatus,
  ) {
    super(`${operation} failed: ${YogaStatus[status] ?? "Unknown"} (status ${status})`)
  }
}

/** Callback state owned by one loaded RenderLib, never by the process. */
export class YogaHost {
  readonly configs = new Map<Pointer, Config>()
  private readonly pendingScenes = new Set<NativeScene>()
  private defaultConfig?: Config
  private callbackDepth = 0
  private mutationDepth = 0
  private callbackError?: { value: unknown }

  constructor(private readonly renderLib: RenderLib) {}

  getDefaultConfig(): Config {
    if (!this.defaultConfig || this.configs.get(this.defaultConfig.ptr) !== this.defaultConfig) {
      this.defaultConfig = Config.create(this.renderLib)
    }
    return this.defaultConfig
  }

  assertMutable(): void {
    if (this.callbackDepth !== 0) throw new Error("Cannot mutate Yoga during a callback")
  }

  stageScene(scene: NativeScene): void {
    this.pendingScenes.add(scene)
  }

  forgetScene(scene: NativeScene): void {
    this.pendingScenes.delete(scene)
  }

  flushSceneMutations(): void {
    this.assertMutable()
    for (const scene of this.pendingScenes) scene.flushStaged()
  }

  /** Whether a Yoga callback is executing on this library's owner thread. */
  get inCallback(): boolean {
    return this.callbackDepth !== 0
  }

  invokeCallback(callback: () => unknown): void {
    this.callbackDepth++
    try {
      rejectAsyncCallback(callback())
    } catch (error) {
      this.callbackError ??= { value: error }
    } finally {
      this.callbackDepth--
    }
  }

  runMutation<T>(operation: () => T): T {
    this.assertMutable()
    this.mutationDepth++
    let result!: T
    let failure: { value: unknown } | undefined
    try {
      result = operation()
    } catch (error) {
      failure = { value: error }
    } finally {
      this.mutationDepth--
    }
    this.throwCallbackError(failure)
    return result
  }

  throwCallbackError(failure?: { value: unknown }): void {
    if (this.callbackDepth !== 0 || this.mutationDepth !== 0) {
      if (failure) throw failure.value
      return
    }
    const callbackError = this.callbackError
    this.callbackError = undefined
    if (failure && callbackError) {
      throw new AggregateError([failure.value, callbackError.value], "Yoga operation and callback both failed")
    }
    if (failure) throw failure.value
    if (callbackError) throw callbackError.value
  }

  dispose(): void {
    this.assertMutable()
    for (const config of this.configs.values()) config.assertUnused()
    for (const config of this.configs.values()) config.free()
    this.defaultConfig = undefined
    this.pendingScenes.clear()
  }
}

export function rejectAsyncCallback(value: unknown): void {
  if (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  ) {
    // Report the synchronous contract error, not an unrelated unhandled rejection.
    void Promise.resolve(value).catch(() => {})
    throw new TypeError("Yoga callbacks must be synchronous", { cause: value })
  }
}

function isValueObject(value: unknown): value is Value {
  return typeof value === "object" && value !== null && "unit" in value && "value" in value
}

export function parseYogaValue(value: ValueInput): Value {
  if (isValueObject(value)) {
    return value
  }
  if (value === undefined) {
    return UNDEFINED_VALUE
  }
  if (value === "auto") {
    return { unit: Unit.Auto, value: NaN }
  }
  if (typeof value === "string") {
    if (!value.endsWith("%")) {
      throw new Error(`Invalid Yoga value: ${value}`)
    }
    const numberValue = Number.parseFloat(value)
    if (Number.isNaN(numberValue)) {
      throw new Error(`Invalid Yoga percentage value: ${value}`)
    }
    return { unit: Unit.Percent, value: numberValue }
  }
  return { unit: Unit.Point, value }
}

function unpackValue(packedValue: number | bigint): Value {
  const packed = typeof packedValue === "bigint" ? packedValue : BigInt(packedValue)
  const unit = Number(packed & 0xffffffffn) as Unit
  const valueBits = Number((packed >> 32n) & 0xffffffffn)
  const buffer = new ArrayBuffer(4)
  const view = new DataView(buffer)
  view.setUint32(0, valueBits, true)
  return { unit, value: view.getFloat32(0, true) }
}

function normalizeLayoutInput(value: number | "auto" | undefined): number {
  return value === undefined || value === "auto" ? NaN : value
}

export class Config {
  readonly ptr: Pointer
  readonly nodes = new Map<Pointer, Node>()
  readonly measures = new Map<Pointer, MeasureFunction>()
  readonly dirtied = new Map<Pointer, { node: Node; callback: DirtiedFunction }>()
  private freed = false
  private measureCallback?: FFICallbackInstance
  private dirtiedCallback?: FFICallbackInstance

  private constructor(
    ptr: Pointer,
    readonly renderLib: RenderLib,
    private readonly ownsConfig: boolean,
  ) {
    this.ptr = ptr
    renderLib.getYogaHost().configs.set(ptr, this)
  }

  static create(renderLib: RenderLib = resolveRenderLib()): Config {
    return new Config(renderLib.yogaConfigCreate(), renderLib, true)
  }

  static fromBorrowedPointer(ptr: Pointer, renderLib: RenderLib = resolveRenderLib()): Config {
    return renderLib.getYogaHost().configs.get(ptr) ?? new Config(ptr, renderLib, false)
  }

  static destroy(config: Config): void {
    config.free()
  }

  free(): void {
    if (this.freed) return
    this.renderLib.getYogaHost().assertMutable()
    this.assertUnused()
    if (this.ownsConfig) {
      this.renderLib.yogaConfigFree(this.ptr)
    } else if (this.measureCallback?.ptr) {
      this.renderLib.yogaConfigClearCallbacks(this.ptr, this.measureCallback.ptr)
    }
    this.measureCallback?.close()
    this.dirtiedCallback?.close()
    this.renderLib.getYogaHost().configs.delete(this.ptr)
    this.freed = true
  }

  assertUnused(): void {
    if (this.nodes.size !== 0) throw new Error("Cannot free Yoga config while Yoga nodes are active")
  }

  assertAlive(): void {
    if (this.freed) throw new Error("Yoga config is freed")
  }

  ensureCallbacks(): void {
    this.assertAlive()
    this.renderLib.getYogaHost().assertMutable()
    if (this.measureCallback) return
    const measure = this.renderLib.createYogaMeasureCallback((node, width, widthMode, height, heightMode) => {
      const result = node ? this.measures.get(node)?.(width, widthMode, height, heightMode) : undefined
      rejectAsyncCallback(result)
      this.renderLib.yogaStoreMeasureResult(this.ptr, result?.width ?? NaN, result?.height ?? NaN)
    })
    let dirtied: FFICallbackInstance | undefined
    try {
      dirtied = this.renderLib.createYogaDirtiedCallback((node) => {
        const registration = node ? this.dirtied.get(node) : undefined
        return registration?.callback(registration.node)
      })
      if (!measure.ptr || !dirtied.ptr) throw new Error("Failed to create Yoga callbacks")
      if (!this.renderLib.yogaConfigSetCallbacks(this.ptr, measure.ptr, dirtied.ptr)) {
        throw new Error("Yoga config callbacks are owned by another native library facade")
      }
      this.measureCallback = measure
      this.dirtiedCallback = dirtied
    } catch (error) {
      measure.close()
      dirtied?.close()
      throw error
    }
  }

  setUseWebDefaults(useWebDefaults: boolean): void {
    if (this.freed) return
    this.renderLib.yogaConfigSetUseWebDefaults(this.ptr, useWebDefaults)
  }

  useWebDefaults(): boolean {
    if (this.freed) return false
    return this.renderLib.yogaConfigGetUseWebDefaults(this.ptr)
  }

  setPointScaleFactor(pointScaleFactor: number): void {
    if (this.freed) return
    this.renderLib.yogaConfigSetPointScaleFactor(this.ptr, pointScaleFactor)
  }

  getPointScaleFactor(): number {
    if (this.freed) return 0
    return this.renderLib.yogaConfigGetPointScaleFactor(this.ptr)
  }

  setErrata(errata: Errata): void {
    if (this.freed) return
    this.renderLib.yogaConfigSetErrata(this.ptr, errata)
  }

  getErrata(): Errata {
    if (this.freed) return Errata.None
    return this.renderLib.yogaConfigGetErrata(this.ptr) as Errata
  }

  setExperimentalFeatureEnabled(feature: ExperimentalFeature, enabled: boolean): void {
    if (this.freed) return
    this.renderLib.yogaConfigSetExperimentalFeatureEnabled(this.ptr, feature, enabled)
  }

  isExperimentalFeatureEnabled(feature: ExperimentalFeature): boolean {
    if (this.freed) return false
    return this.renderLib.yogaConfigIsExperimentalFeatureEnabled(this.ptr, feature)
  }
}

export class Node {
  private freed = false

  private constructor(
    readonly ptr: Pointer,
    private readonly config: Config,
  ) {
    config.nodes.set(ptr, this)
  }

  private get renderLib(): RenderLib {
    return this.config.renderLib
  }

  static create(config?: Config): Node {
    config ??= resolveRenderLib().getYogaHost().getDefaultConfig()
    config.assertAlive()
    return Node.fromPointer(config.renderLib.yogaNodeCreateWithConfig(config.ptr), config.renderLib)
  }

  static createForOpenTUI(): Node {
    const renderLib = resolveRenderLib()
    return Node.fromPointer(renderLib.yogaNodeCreateForOpenTUI(), renderLib)
  }

  static createDefault(): Node {
    return Node.create()
  }

  static createWithConfig(config: Config): Node {
    return Node.create(config)
  }

  static destroy(node: Node): void {
    node.free()
  }

  private static fromPointer(ptr: Pointer, renderLib: RenderLib): Node {
    const config = Config.fromBorrowedPointer(renderLib.yogaNodeGetConfig(ptr), renderLib)
    const existing = config.nodes.get(ptr)
    if (existing) return existing
    return new Node(ptr, config)
  }

  isFreed(): boolean {
    return this.freed
  }

  assertMutable(): void {
    this.renderLib.getYogaHost().assertMutable()
  }

  runMutation<T>(operation: () => T): T {
    return this.renderLib.getYogaHost().runMutation(operation)
  }

  free(): void {
    if (this.freed) return
    this.assertMutable()

    this.runMutation(() => {
      this.renderLib.yogaNodeFree(this.ptr)
      this.markFreed()
    })
  }

  freeRecursive(): void {
    if (this.freed) return
    this.assertMutable()
    const nodes = this.collectSubtree([])
    this.runMutation(() => {
      this.renderLib.yogaNodeFreeRecursive(this.ptr)
      for (const node of nodes) node.markFreed()
    })
  }

  reset(): void {
    if (this.freed) return
    this.runMutation(() => {
      this.renderLib.yogaNodeReset(this.ptr)
      this.unregisterCallbacks()
    })
  }

  copyStyle(node: Node): void {
    if (this.freed) return
    this.assertSameLibrary(node)
    this.renderLib.yogaNodeCopyStyle(this.ptr, node.ptr)
  }

  insertChild(child: Node, index: number): void {
    if (this.freed) return
    this.assertSameLibrary(child)
    this.renderLib.yogaNodeInsertChild(this.ptr, child.ptr, index)
  }

  removeChild(child: Node): void {
    if (this.freed) return
    this.assertSameLibrary(child)
    this.renderLib.yogaNodeRemoveChild(this.ptr, child.ptr)
  }

  removeAllChildren(): void {
    if (this.freed) return
    this.renderLib.yogaNodeRemoveAllChildren(this.ptr)
  }

  getChild(index: number): Node | null {
    if (this.freed) return null
    const child = this.renderLib.yogaNodeGetChild(this.ptr, index)
    return child ? Node.fromPointer(child, this.renderLib) : null
  }

  getChildCount(): number {
    if (this.freed) return 0
    return this.renderLib.yogaNodeGetChildCount(this.ptr)
  }

  getParent(): Node | null {
    if (this.freed) return null
    const parent = this.renderLib.yogaNodeGetParent(this.ptr)
    return parent ? Node.fromPointer(parent, this.renderLib) : null
  }

  calculateLayout(width?: number | "auto", height?: number | "auto", direction: Direction = Direction.LTR): void {
    if (this.freed) return
    this.renderLib.yogaNodeCalculateLayout(
      this.ptr,
      normalizeLayoutInput(width),
      normalizeLayoutInput(height),
      direction,
    )
  }

  hasNewLayout(): boolean {
    if (this.freed) return false
    return this.renderLib.yogaNodeGetHasNewLayout(this.ptr)
  }

  markLayoutSeen(): void {
    if (this.freed) return
    this.renderLib.yogaNodeSetHasNewLayout(this.ptr, false)
  }

  markDirty(): void {
    if (this.freed) return
    this.renderLib.yogaNodeMarkDirty(this.ptr)
  }

  isDirty(): boolean {
    if (this.freed) return true
    return this.renderLib.yogaNodeIsDirty(this.ptr)
  }

  getComputedLayout(): Layout {
    if (this.freed) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    return this.renderLib.yogaNodeGetComputedLayout(this.ptr)
  }

  getComputedLeft(): number {
    return this.getComputedLayout().left
  }

  getComputedTop(): number {
    return this.getComputedLayout().top
  }

  getComputedRight(): number {
    return this.getComputedLayout().right
  }

  getComputedBottom(): number {
    return this.getComputedLayout().bottom
  }

  getComputedWidth(): number {
    return this.getComputedLayout().width
  }

  getComputedHeight(): number {
    return this.getComputedLayout().height
  }

  getComputedMargin(edge: Edge): number {
    if (this.freed) return 0
    return this.renderLib.yogaNodeLayoutGetEdge(this.ptr, YogaEdgeLayoutKind.Margin, edge)
  }

  getComputedPadding(edge: Edge): number {
    if (this.freed) return 0
    return this.renderLib.yogaNodeLayoutGetEdge(this.ptr, YogaEdgeLayoutKind.Padding, edge)
  }

  getComputedBorder(edge: Edge): number {
    if (this.freed) return 0
    return this.renderLib.yogaNodeLayoutGetEdge(this.ptr, YogaEdgeLayoutKind.Border, edge)
  }

  setDirection(direction: Direction): void {
    this.setEnum(YogaEnumKind.Direction, direction)
  }

  getDirection(): Direction {
    return this.getEnum(YogaEnumKind.Direction, Direction.Inherit) as Direction
  }

  setFlexDirection(flexDirection: FlexDirection): void {
    this.setEnum(YogaEnumKind.FlexDirection, flexDirection)
  }

  getFlexDirection(): FlexDirection {
    return this.getEnum(YogaEnumKind.FlexDirection, FlexDirection.Column) as FlexDirection
  }

  setJustifyContent(justifyContent: Justify): void {
    this.setEnum(YogaEnumKind.JustifyContent, justifyContent)
  }

  getJustifyContent(): Justify {
    return this.getEnum(YogaEnumKind.JustifyContent, Justify.FlexStart) as Justify
  }

  setAlignContent(alignContent: Align): void {
    this.setEnum(YogaEnumKind.AlignContent, alignContent)
  }

  getAlignContent(): Align {
    return this.getEnum(YogaEnumKind.AlignContent, Align.FlexStart) as Align
  }

  setAlignItems(alignItems: Align): void {
    this.setEnum(YogaEnumKind.AlignItems, alignItems)
  }

  getAlignItems(): Align {
    return this.getEnum(YogaEnumKind.AlignItems, Align.Stretch) as Align
  }

  setAlignSelf(alignSelf: Align): void {
    this.setEnum(YogaEnumKind.AlignSelf, alignSelf)
  }

  getAlignSelf(): Align {
    return this.getEnum(YogaEnumKind.AlignSelf, Align.Auto) as Align
  }

  setPositionType(positionType: PositionType): void {
    this.setEnum(YogaEnumKind.PositionType, positionType)
  }

  getPositionType(): PositionType {
    return this.getEnum(YogaEnumKind.PositionType, PositionType.Relative) as PositionType
  }

  setFlexWrap(flexWrap: Wrap): void {
    this.setEnum(YogaEnumKind.FlexWrap, flexWrap)
  }

  getFlexWrap(): Wrap {
    return this.getEnum(YogaEnumKind.FlexWrap, Wrap.NoWrap) as Wrap
  }

  setOverflow(overflow: Overflow): void {
    this.setEnum(YogaEnumKind.Overflow, overflow)
  }

  getOverflow(): Overflow {
    return this.getEnum(YogaEnumKind.Overflow, Overflow.Visible) as Overflow
  }

  setDisplay(display: Display): void {
    this.setEnum(YogaEnumKind.Display, display)
  }

  getDisplay(): Display {
    return this.getEnum(YogaEnumKind.Display, Display.Flex) as Display
  }

  setBoxSizing(boxSizing: BoxSizing): void {
    this.setEnum(YogaEnumKind.BoxSizing, boxSizing)
  }

  getBoxSizing(): BoxSizing {
    return this.getEnum(YogaEnumKind.BoxSizing, BoxSizing.BorderBox) as BoxSizing
  }

  setFlex(flex: number | undefined): void {
    this.setFloat(YogaFloatKind.Flex, flex)
  }

  getFlex(): number {
    return this.getFloat(YogaFloatKind.Flex)
  }

  setFlexGrow(flexGrow: number | undefined): void {
    this.setFloat(YogaFloatKind.FlexGrow, flexGrow)
  }

  getFlexGrow(): number {
    return this.getFloat(YogaFloatKind.FlexGrow)
  }

  setFlexShrink(flexShrink: number | undefined): void {
    this.setFloat(YogaFloatKind.FlexShrink, flexShrink)
  }

  getFlexShrink(): number {
    return this.getFloat(YogaFloatKind.FlexShrink)
  }

  setAspectRatio(aspectRatio: number | undefined): void {
    this.setFloat(YogaFloatKind.AspectRatio, aspectRatio)
  }

  getAspectRatio(): number {
    return this.getFloat(YogaFloatKind.AspectRatio)
  }

  setFlexBasis(flexBasis: ValueInput): void {
    this.setValue(YogaValueKind.FlexBasis, NATIVE_EDGE_NONE, flexBasis)
  }

  setFlexBasisPercent(flexBasis: number | undefined): void {
    this.setValue(
      YogaValueKind.FlexBasis,
      NATIVE_EDGE_NONE,
      flexBasis === undefined ? undefined : { unit: Unit.Percent, value: flexBasis },
    )
  }

  setFlexBasisAuto(): void {
    this.setValue(YogaValueKind.FlexBasis, NATIVE_EDGE_NONE, "auto")
  }

  getFlexBasis(): Value {
    return this.getValue(YogaValueKind.FlexBasis, NATIVE_EDGE_NONE)
  }

  setWidth(width: ValueInput): void {
    this.setValue(YogaValueKind.Width, NATIVE_EDGE_NONE, width)
  }

  setDimension(dimension: Dimension, input: ValueInput, disableFlexShrink: boolean = false): void {
    if (this.freed) return
    const value = parseYogaValue(input)
    this.renderLib.yogaNodeStyleSetDimension(this.ptr, dimension, value.unit, value.value, disableFlexShrink)
  }

  setPositions(positions: readonly [ValueInput, ValueInput, ValueInput, ValueInput]): void {
    if (this.freed) return
    const units = new Uint32Array(Edge.Bottom + 1)
    const values = new Float32Array(Edge.Bottom + 1)
    let mask = 0
    for (let edge = 0; edge <= Edge.Bottom; edge++) {
      if (positions[edge] === undefined) continue
      const value = parseYogaValue(positions[edge])
      if (!Number.isInteger(value.unit) || value.unit < Unit.Undefined || value.unit > Unit.Auto) {
        throw new YogaError("yogaNodeStyleSetPositionsChecked", YogaStatus.InvalidArgument)
      }
      mask |= 1 << edge
      units[edge] = value.unit
      values[edge] = value.value
    }
    this.renderLib.yogaNodeStyleSetPositions(this.ptr, mask, units, values)
  }

  setWidthPercent(width: number | undefined): void {
    this.setValue(
      YogaValueKind.Width,
      NATIVE_EDGE_NONE,
      width === undefined ? undefined : { unit: Unit.Percent, value: width },
    )
  }

  setWidthAuto(): void {
    this.setValue(YogaValueKind.Width, NATIVE_EDGE_NONE, "auto")
  }

  getWidth(): Value {
    return this.getValue(YogaValueKind.Width, NATIVE_EDGE_NONE)
  }

  setHeight(height: ValueInput): void {
    this.setValue(YogaValueKind.Height, NATIVE_EDGE_NONE, height)
  }

  setHeightPercent(height: number | undefined): void {
    this.setValue(
      YogaValueKind.Height,
      NATIVE_EDGE_NONE,
      height === undefined ? undefined : { unit: Unit.Percent, value: height },
    )
  }

  setHeightAuto(): void {
    this.setValue(YogaValueKind.Height, NATIVE_EDGE_NONE, "auto")
  }

  getHeight(): Value {
    return this.getValue(YogaValueKind.Height, NATIVE_EDGE_NONE)
  }

  setMinWidth(minWidth: ValueInputNoAuto): void {
    this.setValue(YogaValueKind.MinWidth, NATIVE_EDGE_NONE, minWidth)
  }

  setMinWidthPercent(minWidth: number | undefined): void {
    this.setValue(
      YogaValueKind.MinWidth,
      NATIVE_EDGE_NONE,
      minWidth === undefined ? undefined : { unit: Unit.Percent, value: minWidth },
    )
  }

  getMinWidth(): Value {
    return this.getValue(YogaValueKind.MinWidth, NATIVE_EDGE_NONE)
  }

  setMinHeight(minHeight: ValueInputNoAuto): void {
    this.setValue(YogaValueKind.MinHeight, NATIVE_EDGE_NONE, minHeight)
  }

  setMinHeightPercent(minHeight: number | undefined): void {
    this.setValue(
      YogaValueKind.MinHeight,
      NATIVE_EDGE_NONE,
      minHeight === undefined ? undefined : { unit: Unit.Percent, value: minHeight },
    )
  }

  getMinHeight(): Value {
    return this.getValue(YogaValueKind.MinHeight, NATIVE_EDGE_NONE)
  }

  setMaxWidth(maxWidth: ValueInputNoAuto): void {
    this.setValue(YogaValueKind.MaxWidth, NATIVE_EDGE_NONE, maxWidth)
  }

  setMaxWidthPercent(maxWidth: number | undefined): void {
    this.setValue(
      YogaValueKind.MaxWidth,
      NATIVE_EDGE_NONE,
      maxWidth === undefined ? undefined : { unit: Unit.Percent, value: maxWidth },
    )
  }

  getMaxWidth(): Value {
    return this.getValue(YogaValueKind.MaxWidth, NATIVE_EDGE_NONE)
  }

  setMaxHeight(maxHeight: ValueInputNoAuto): void {
    this.setValue(YogaValueKind.MaxHeight, NATIVE_EDGE_NONE, maxHeight)
  }

  setMaxHeightPercent(maxHeight: number | undefined): void {
    this.setValue(
      YogaValueKind.MaxHeight,
      NATIVE_EDGE_NONE,
      maxHeight === undefined ? undefined : { unit: Unit.Percent, value: maxHeight },
    )
  }

  getMaxHeight(): Value {
    return this.getValue(YogaValueKind.MaxHeight, NATIVE_EDGE_NONE)
  }

  setMargin(edge: Edge, margin: ValueInput): void {
    this.setValue(YogaValueKind.Margin, edge, margin)
  }

  setMarginPercent(edge: Edge, margin: number | undefined): void {
    this.setValue(YogaValueKind.Margin, edge, margin === undefined ? undefined : { unit: Unit.Percent, value: margin })
  }

  setMarginAuto(edge: Edge): void {
    this.setValue(YogaValueKind.Margin, edge, "auto")
  }

  getMargin(edge: Edge): Value {
    return this.getValue(YogaValueKind.Margin, edge)
  }

  setPadding(edge: Edge, padding: ValueInputNoAuto): void {
    this.setValue(YogaValueKind.Padding, edge, padding)
  }

  setPaddingPercent(edge: Edge, padding: number | undefined): void {
    this.setValue(
      YogaValueKind.Padding,
      edge,
      padding === undefined ? undefined : { unit: Unit.Percent, value: padding },
    )
  }

  getPadding(edge: Edge): Value {
    return this.getValue(YogaValueKind.Padding, edge)
  }

  setPosition(edge: Edge, position: ValueInput): void {
    this.setValue(YogaValueKind.Position, edge, position)
  }

  setPositionPercent(edge: Edge, position: number | undefined): void {
    this.setValue(
      YogaValueKind.Position,
      edge,
      position === undefined ? undefined : { unit: Unit.Percent, value: position },
    )
  }

  setPositionAuto(edge: Edge): void {
    this.setValue(YogaValueKind.Position, edge, "auto")
  }

  getPosition(edge: Edge): Value {
    return this.getValue(YogaValueKind.Position, edge)
  }

  setGap(gutter: Gutter, gap: ValueInputNoAuto): void {
    this.setValue(YogaValueKind.Gap, gutter, gap)
  }

  setGapPercent(gutter: Gutter, gap: number | undefined): void {
    this.setValue(YogaValueKind.Gap, gutter, gap === undefined ? undefined : { unit: Unit.Percent, value: gap })
  }

  getGap(gutter: Gutter): Value {
    return this.getValue(YogaValueKind.Gap, gutter)
  }

  setBorder(edge: Edge, border: number | undefined): void {
    if (this.freed) return
    this.renderLib.yogaNodeStyleSetBorder(this.ptr, edge, border ?? NaN)
  }

  getBorder(edge: Edge): number {
    if (this.freed) return NaN
    return this.renderLib.yogaNodeStyleGetBorder(this.ptr, edge)
  }

  setIsReferenceBaseline(isReferenceBaseline: boolean): void {
    if (this.freed) return
    this.renderLib.yogaNodeSetIsReferenceBaseline(this.ptr, isReferenceBaseline)
  }

  isReferenceBaseline(): boolean {
    if (this.freed) return false
    return this.renderLib.yogaNodeIsReferenceBaseline(this.ptr)
  }

  setAlwaysFormsContainingBlock(alwaysFormsContainingBlock: boolean): void {
    if (this.freed) return
    this.renderLib.yogaNodeSetAlwaysFormsContainingBlock(this.ptr, alwaysFormsContainingBlock)
  }

  getAlwaysFormsContainingBlock(): boolean {
    if (this.freed) return false
    return this.renderLib.yogaNodeGetAlwaysFormsContainingBlock(this.ptr)
  }

  // A Yoga node has a single measure slot, shared with native-backed measurement
  // (NativeRenderable). Setting a JS measure func on a node that has a native
  // measure target replaces the native one, and vice versa.
  setMeasureFunc(measureFunc: MeasureFunction | null): void {
    if (this.freed) return
    if (!measureFunc) return this.unsetMeasureFunc()

    this.config.ensureCallbacks()
    this.runMutation(() => {
      this.renderLib.yogaNodeSetMeasureFunc(this.ptr, true)
      this.config.measures.set(this.ptr, measureFunc)
    })
  }

  unsetMeasureFunc(): void {
    if (this.freed) return
    this.runMutation(() => {
      this.renderLib.yogaNodeUnsetMeasureFunc(this.ptr)
      this.config.measures.delete(this.ptr)
    })
  }

  hasMeasureFunc(): boolean {
    if (this.freed) return false
    return this.renderLib.yogaNodeHasMeasureFunc(this.ptr)
  }

  setDirtiedFunc(dirtiedFunc: DirtiedFunction | null): void {
    if (this.freed) return
    if (!dirtiedFunc) return this.unsetDirtiedFunc()

    this.config.ensureCallbacks()
    this.runMutation(() => {
      this.renderLib.yogaNodeSetDirtiedFunc(this.ptr, true)
      this.config.dirtied.set(this.ptr, { node: this, callback: dirtiedFunc })
    })
  }

  unsetDirtiedFunc(): void {
    if (this.freed) return
    this.runMutation(() => {
      this.renderLib.yogaNodeUnsetDirtiedFunc(this.ptr)
      this.config.dirtied.delete(this.ptr)
    })
  }

  private setEnum(kind: YogaEnumKindId, value: number): void {
    if (this.freed) return
    this.renderLib.yogaNodeStyleSetEnum(this.ptr, kind, value)
  }

  private getEnum(kind: YogaEnumKindId, fallback: number): number {
    if (this.freed) return fallback
    return this.renderLib.yogaNodeStyleGetEnum(this.ptr, kind)
  }

  private setFloat(kind: YogaFloatKindId, value: number | undefined): void {
    if (this.freed) return
    this.renderLib.yogaNodeStyleSetFloat(this.ptr, kind, value ?? NaN)
  }

  private getFloat(kind: YogaFloatKindId): number {
    if (this.freed) return NaN
    return this.renderLib.yogaNodeStyleGetFloat(this.ptr, kind)
  }

  private setValue(kind: YogaValueKindId, edgeOrGutter: number, valueInput: ValueInput): void {
    if (this.freed) return
    const value = parseYogaValue(valueInput)
    this.renderLib.yogaNodeStyleSetValue(this.ptr, kind, edgeOrGutter, value.unit, value.value)
  }

  private getValue(kind: YogaValueKindId, edgeOrGutter: number): Value {
    if (this.freed) return UNDEFINED_VALUE
    return unpackValue(this.renderLib.yogaNodeStyleGetValue(this.ptr, kind, edgeOrGutter))
  }

  private collectSubtree(nodes: Node[]): Node[] {
    for (let index = 0; index < this.getChildCount(); index++) {
      this.getChild(index)?.collectSubtree(nodes)
    }
    nodes.push(this)
    return nodes
  }

  private unregisterCallbacks(): void {
    this.config.measures.delete(this.ptr)
    this.config.dirtied.delete(this.ptr)
  }

  private markFreed(): void {
    this.unregisterCallbacks()
    this.freed = true
    this.config.nodes.delete(this.ptr)
  }

  private assertSameLibrary(node: Node): void {
    if (this.renderLib !== node.renderLib) throw new Error("Yoga nodes belong to different native libraries")
    if (node.freed) throw new Error("Yoga node is freed")
  }
}

const Yoga = {
  Config,
  Node,
  Align,
  BoxSizing,
  Dimension,
  Direction,
  Display,
  Edge,
  Errata,
  ExperimentalFeature,
  FlexDirection,
  Gutter,
  Justify,
  LogLevel,
  MeasureMode,
  NodeType,
  Overflow,
  PositionType,
  Unit,
  Wrap,
  ALIGN_AUTO,
  ALIGN_FLEX_START,
  ALIGN_CENTER,
  ALIGN_FLEX_END,
  ALIGN_STRETCH,
  ALIGN_BASELINE,
  ALIGN_SPACE_BETWEEN,
  ALIGN_SPACE_AROUND,
  ALIGN_SPACE_EVENLY,
  BOX_SIZING_BORDER_BOX,
  BOX_SIZING_CONTENT_BOX,
  DIMENSION_WIDTH,
  DIMENSION_HEIGHT,
  DIRECTION_INHERIT,
  DIRECTION_LTR,
  DIRECTION_RTL,
  DISPLAY_FLEX,
  DISPLAY_NONE,
  DISPLAY_CONTENTS,
  EDGE_LEFT,
  EDGE_TOP,
  EDGE_RIGHT,
  EDGE_BOTTOM,
  EDGE_START,
  EDGE_END,
  EDGE_HORIZONTAL,
  EDGE_VERTICAL,
  EDGE_ALL,
  ERRATA_NONE,
  ERRATA_STRETCH_FLEX_BASIS,
  ERRATA_ABSOLUTE_POSITION_WITHOUT_INSETS_EXCLUDES_PADDING,
  ERRATA_ABSOLUTE_PERCENT_AGAINST_INNER_SIZE,
  ERRATA_ALL,
  ERRATA_CLASSIC,
  EXPERIMENTAL_FEATURE_WEB_FLEX_BASIS,
  FLEX_DIRECTION_COLUMN,
  FLEX_DIRECTION_COLUMN_REVERSE,
  FLEX_DIRECTION_ROW,
  FLEX_DIRECTION_ROW_REVERSE,
  GUTTER_COLUMN,
  GUTTER_ROW,
  GUTTER_ALL,
  JUSTIFY_FLEX_START,
  JUSTIFY_CENTER,
  JUSTIFY_FLEX_END,
  JUSTIFY_SPACE_BETWEEN,
  JUSTIFY_SPACE_AROUND,
  JUSTIFY_SPACE_EVENLY,
  LOG_LEVEL_ERROR,
  LOG_LEVEL_WARN,
  LOG_LEVEL_INFO,
  LOG_LEVEL_DEBUG,
  LOG_LEVEL_VERBOSE,
  LOG_LEVEL_FATAL,
  MEASURE_MODE_UNDEFINED,
  MEASURE_MODE_EXACTLY,
  MEASURE_MODE_AT_MOST,
  NODE_TYPE_DEFAULT,
  NODE_TYPE_TEXT,
  OVERFLOW_VISIBLE,
  OVERFLOW_HIDDEN,
  OVERFLOW_SCROLL,
  POSITION_TYPE_STATIC,
  POSITION_TYPE_RELATIVE,
  POSITION_TYPE_ABSOLUTE,
  UNIT_UNDEFINED,
  UNIT_POINT,
  UNIT_PERCENT,
  UNIT_AUTO,
  WRAP_NO_WRAP,
  WRAP_WRAP,
  WRAP_WRAP_REVERSE,
}

export default Yoga
