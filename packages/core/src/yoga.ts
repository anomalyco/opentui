import {
  resolveRenderLib,
  type NativeYogaDirtiedCallback,
  type NativeYogaMeasureCallback,
  type RenderLib,
} from "./zig.js"
import type { FFICallbackInstance, Pointer } from "./platform/ffi.js"

export enum Align {
  Auto = 0,
  FlexStart = 1,
  Center = 2,
  FlexEnd = 3,
  Stretch = 4,
  Baseline = 5,
  SpaceBetween = 6,
  SpaceAround = 7,
  SpaceEvenly = 8,
}

export enum BoxSizing {
  BorderBox = 0,
  ContentBox = 1,
}

export enum Dimension {
  Width = 0,
  Height = 1,
}

export enum Direction {
  Inherit = 0,
  LTR = 1,
  RTL = 2,
}

export enum Display {
  Flex = 0,
  None = 1,
  Contents = 2,
}

export enum Edge {
  Left = 0,
  Top = 1,
  Right = 2,
  Bottom = 3,
  Start = 4,
  End = 5,
  Horizontal = 6,
  Vertical = 7,
  All = 8,
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
  Column = 0,
  ColumnReverse = 1,
  Row = 2,
  RowReverse = 3,
}

export enum Gutter {
  Column = 0,
  Row = 1,
  All = 2,
}

export enum Justify {
  FlexStart = 0,
  Center = 1,
  FlexEnd = 2,
  SpaceBetween = 3,
  SpaceAround = 4,
  SpaceEvenly = 5,
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
  Undefined = 0,
  Exactly = 1,
  AtMost = 2,
}

export enum NodeType {
  Default = 0,
  Text = 1,
}

export enum Overflow {
  Visible = 0,
  Hidden = 1,
  Scroll = 2,
}

export enum PositionType {
  Static = 0,
  Relative = 1,
  Absolute = 2,
}

export enum Unit {
  Undefined = 0,
  Point = 1,
  Percent = 2,
  Auto = 3,
}

export enum Wrap {
  NoWrap = 0,
  Wrap = 1,
  WrapReverse = 2,
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

const YogaEnumKind = {
  Direction: 0,
  FlexDirection: 1,
  JustifyContent: 2,
  AlignContent: 3,
  AlignItems: 4,
  AlignSelf: 5,
  PositionType: 6,
  FlexWrap: 7,
  Overflow: 8,
  Display: 9,
  BoxSizing: 10,
} as const

const YogaFloatKind = {
  Flex: 0,
  FlexGrow: 1,
  FlexShrink: 2,
  AspectRatio: 3,
} as const

const YogaValueKind = {
  Width: 0,
  Height: 1,
  MinWidth: 2,
  MinHeight: 3,
  MaxWidth: 4,
  MaxHeight: 5,
  FlexBasis: 6,
  Margin: 7,
  Padding: 8,
  Position: 9,
  Gap: 10,
} as const

const YogaEdgeLayoutKind = {
  Margin: 0,
  Padding: 1,
  Border: 2,
} as const

const UNDEFINED_VALUE: Value = { unit: Unit.Undefined, value: NaN }

const nodeRegistry = new Map<string, Node>()

function lib(): RenderLib {
  return resolveRenderLib()
}

function pointerKey(pointer: Pointer): string {
  return String(pointer)
}

function isValueObject(value: unknown): value is Value {
  return typeof value === "object" && value !== null && "unit" in value && "value" in value
}

function parseValue(value: ValueInput): Value {
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
  private freed = false

  private constructor(ptr: Pointer) {
    this.ptr = ptr
  }

  static create(): Config {
    return new Config(lib().yogaConfigCreate())
  }

  static destroy(config: Config): void {
    config.free()
  }

  free(): void {
    if (this.freed) return
    this.freed = true
    lib().yogaConfigFree(this.ptr)
  }

  setUseWebDefaults(useWebDefaults: boolean): void {
    if (this.freed) return
    lib().yogaConfigSetUseWebDefaults(this.ptr, useWebDefaults)
  }

  useWebDefaults(): boolean {
    if (this.freed) return false
    return lib().yogaConfigGetUseWebDefaults(this.ptr)
  }

  setPointScaleFactor(pointScaleFactor: number): void {
    if (this.freed) return
    lib().yogaConfigSetPointScaleFactor(this.ptr, pointScaleFactor)
  }

  getPointScaleFactor(): number {
    if (this.freed) return 0
    return lib().yogaConfigGetPointScaleFactor(this.ptr)
  }

  setErrata(errata: Errata): void {
    if (this.freed) return
    lib().yogaConfigSetErrata(this.ptr, errata)
  }

  getErrata(): Errata {
    if (this.freed) return Errata.None
    return lib().yogaConfigGetErrata(this.ptr) as Errata
  }

  setExperimentalFeatureEnabled(feature: ExperimentalFeature, enabled: boolean): void {
    if (this.freed) return
    lib().yogaConfigSetExperimentalFeatureEnabled(this.ptr, feature, enabled)
  }

  isExperimentalFeatureEnabled(feature: ExperimentalFeature): boolean {
    if (this.freed) return false
    return lib().yogaConfigIsExperimentalFeatureEnabled(this.ptr, feature)
  }
}

export class Node {
  readonly ptr: Pointer
  private freed = false
  private measureCallback: FFICallbackInstance | null = null
  private dirtiedCallback: FFICallbackInstance | null = null

  private constructor(ptr: Pointer) {
    this.ptr = ptr
    nodeRegistry.set(pointerKey(ptr), this)
  }

  static create(config?: Config): Node {
    return Node.fromPointer(config ? lib().yogaNodeCreateWithConfig(config.ptr) : lib().yogaNodeCreate())
  }

  static createForOpenTUI(): Node {
    return Node.fromPointer(lib().yogaNodeCreateForOpenTUI())
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

  private static fromPointer(ptr: Pointer): Node {
    const key = pointerKey(ptr)
    const existing = nodeRegistry.get(key)
    if (existing) return existing
    return new Node(ptr)
  }

  isFreed(): boolean {
    return this.freed
  }

  free(): void {
    if (this.freed) return
    this.unsetMeasureFunc()
    this.unsetDirtiedFunc()
    lib().yogaNodeFree(this.ptr)
    this.markFreed()
  }

  freeRecursive(): void {
    if (this.freed) return
    const nodes = this.collectSubtree([])
    for (const node of nodes) {
      node.closeMeasureCallback()
      node.closeDirtiedCallback()
    }
    lib().yogaNodeFreeRecursive(this.ptr)
    for (const node of nodes) {
      node.markFreed()
    }
  }

  reset(): void {
    if (this.freed) return
    this.unsetMeasureFunc()
    this.unsetDirtiedFunc()
    lib().yogaNodeReset(this.ptr)
  }

  copyStyle(node: Node): void {
    if (this.freed) return
    lib().yogaNodeCopyStyle(this.ptr, node.ptr)
  }

  insertChild(child: Node, index: number): void {
    if (this.freed) return
    lib().yogaNodeInsertChild(this.ptr, child.ptr, index)
  }

  removeChild(child: Node): void {
    if (this.freed) return
    lib().yogaNodeRemoveChild(this.ptr, child.ptr)
  }

  removeAllChildren(): void {
    if (this.freed) return
    lib().yogaNodeRemoveAllChildren(this.ptr)
  }

  getChild(index: number): Node | null {
    if (this.freed) return null
    const child = lib().yogaNodeGetChild(this.ptr, index)
    return child ? Node.fromPointer(child) : null
  }

  getChildCount(): number {
    if (this.freed) return 0
    return lib().yogaNodeGetChildCount(this.ptr)
  }

  getParent(): Node | null {
    if (this.freed) return null
    const parent = lib().yogaNodeGetParent(this.ptr)
    return parent ? Node.fromPointer(parent) : null
  }

  calculateLayout(width?: number | "auto", height?: number | "auto", direction: Direction = Direction.LTR): void {
    if (this.freed) return
    lib().yogaNodeCalculateLayout(this.ptr, normalizeLayoutInput(width), normalizeLayoutInput(height), direction)
  }

  hasNewLayout(): boolean {
    if (this.freed) return false
    return lib().yogaNodeGetHasNewLayout(this.ptr)
  }

  markLayoutSeen(): void {
    if (this.freed) return
    lib().yogaNodeSetHasNewLayout(this.ptr, false)
  }

  markDirty(): void {
    if (this.freed) return
    lib().yogaNodeMarkDirty(this.ptr)
  }

  isDirty(): boolean {
    if (this.freed) return true
    return lib().yogaNodeIsDirty(this.ptr)
  }

  getComputedLayout(): Layout {
    if (this.freed) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
    return lib().yogaNodeGetComputedLayout(this.ptr)
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
    return lib().yogaNodeLayoutGetEdge(this.ptr, YogaEdgeLayoutKind.Margin, edge)
  }

  getComputedPadding(edge: Edge): number {
    if (this.freed) return 0
    return lib().yogaNodeLayoutGetEdge(this.ptr, YogaEdgeLayoutKind.Padding, edge)
  }

  getComputedBorder(edge: Edge): number {
    if (this.freed) return 0
    return lib().yogaNodeLayoutGetEdge(this.ptr, YogaEdgeLayoutKind.Border, edge)
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
    this.setValue(YogaValueKind.FlexBasis, 0, flexBasis)
  }

  setFlexBasisPercent(flexBasis: number | undefined): void {
    this.setValue(
      YogaValueKind.FlexBasis,
      0,
      flexBasis === undefined ? undefined : { unit: Unit.Percent, value: flexBasis },
    )
  }

  setFlexBasisAuto(): void {
    this.setValue(YogaValueKind.FlexBasis, 0, "auto")
  }

  getFlexBasis(): Value {
    return this.getValue(YogaValueKind.FlexBasis, 0)
  }

  setWidth(width: ValueInput): void {
    this.setValue(YogaValueKind.Width, 0, width)
  }

  setWidthPercent(width: number | undefined): void {
    this.setValue(YogaValueKind.Width, 0, width === undefined ? undefined : { unit: Unit.Percent, value: width })
  }

  setWidthAuto(): void {
    this.setValue(YogaValueKind.Width, 0, "auto")
  }

  getWidth(): Value {
    return this.getValue(YogaValueKind.Width, 0)
  }

  setHeight(height: ValueInput): void {
    this.setValue(YogaValueKind.Height, 0, height)
  }

  setHeightPercent(height: number | undefined): void {
    this.setValue(YogaValueKind.Height, 0, height === undefined ? undefined : { unit: Unit.Percent, value: height })
  }

  setHeightAuto(): void {
    this.setValue(YogaValueKind.Height, 0, "auto")
  }

  getHeight(): Value {
    return this.getValue(YogaValueKind.Height, 0)
  }

  setMinWidth(minWidth: ValueInputNoAuto): void {
    this.setValue(YogaValueKind.MinWidth, 0, minWidth)
  }

  setMinWidthPercent(minWidth: number | undefined): void {
    this.setValue(
      YogaValueKind.MinWidth,
      0,
      minWidth === undefined ? undefined : { unit: Unit.Percent, value: minWidth },
    )
  }

  getMinWidth(): Value {
    return this.getValue(YogaValueKind.MinWidth, 0)
  }

  setMinHeight(minHeight: ValueInputNoAuto): void {
    this.setValue(YogaValueKind.MinHeight, 0, minHeight)
  }

  setMinHeightPercent(minHeight: number | undefined): void {
    this.setValue(
      YogaValueKind.MinHeight,
      0,
      minHeight === undefined ? undefined : { unit: Unit.Percent, value: minHeight },
    )
  }

  getMinHeight(): Value {
    return this.getValue(YogaValueKind.MinHeight, 0)
  }

  setMaxWidth(maxWidth: ValueInputNoAuto): void {
    this.setValue(YogaValueKind.MaxWidth, 0, maxWidth)
  }

  setMaxWidthPercent(maxWidth: number | undefined): void {
    this.setValue(
      YogaValueKind.MaxWidth,
      0,
      maxWidth === undefined ? undefined : { unit: Unit.Percent, value: maxWidth },
    )
  }

  getMaxWidth(): Value {
    return this.getValue(YogaValueKind.MaxWidth, 0)
  }

  setMaxHeight(maxHeight: ValueInputNoAuto): void {
    this.setValue(YogaValueKind.MaxHeight, 0, maxHeight)
  }

  setMaxHeightPercent(maxHeight: number | undefined): void {
    this.setValue(
      YogaValueKind.MaxHeight,
      0,
      maxHeight === undefined ? undefined : { unit: Unit.Percent, value: maxHeight },
    )
  }

  getMaxHeight(): Value {
    return this.getValue(YogaValueKind.MaxHeight, 0)
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
    lib().yogaNodeStyleSetBorder(this.ptr, edge, border ?? NaN)
  }

  getBorder(edge: Edge): number {
    if (this.freed) return NaN
    return lib().yogaNodeStyleGetBorder(this.ptr, edge)
  }

  setIsReferenceBaseline(isReferenceBaseline: boolean): void {
    if (this.freed) return
    lib().yogaNodeSetIsReferenceBaseline(this.ptr, isReferenceBaseline)
  }

  isReferenceBaseline(): boolean {
    if (this.freed) return false
    return lib().yogaNodeIsReferenceBaseline(this.ptr)
  }

  setAlwaysFormsContainingBlock(alwaysFormsContainingBlock: boolean): void {
    if (this.freed) return
    lib().yogaNodeSetAlwaysFormsContainingBlock(this.ptr, alwaysFormsContainingBlock)
  }

  getAlwaysFormsContainingBlock(): boolean {
    if (this.freed) return false
    return lib().yogaNodeGetAlwaysFormsContainingBlock(this.ptr)
  }

  setMeasureFunc(measureFunc: MeasureFunction | null): void {
    if (this.freed) return
    this.unsetMeasureFunc()

    if (!measureFunc) return

    const callback: NativeYogaMeasureCallback = (_node, width, widthMode, height, heightMode) => {
      const result = measureFunc(width, widthMode as MeasureMode, height, heightMode as MeasureMode)
      lib().yogaStoreMeasureResult(result.width ?? NaN, result.height ?? NaN)
    }

    this.measureCallback = lib().createYogaMeasureCallback(callback)
    if (!this.measureCallback.ptr) {
      this.measureCallback.close()
      this.measureCallback = null
      throw new Error("Failed to create Yoga measure callback")
    }

    lib().yogaNodeSetMeasureFunc(this.ptr, this.measureCallback.ptr)
  }

  unsetMeasureFunc(): void {
    if (this.freed) return
    lib().yogaNodeUnsetMeasureFunc(this.ptr)
    this.closeMeasureCallback()
  }

  hasMeasureFunc(): boolean {
    if (this.freed) return false
    return lib().yogaNodeHasMeasureFunc(this.ptr)
  }

  setDirtiedFunc(dirtiedFunc: DirtiedFunction | null): void {
    if (this.freed) return
    this.unsetDirtiedFunc()

    if (!dirtiedFunc) return

    const callback: NativeYogaDirtiedCallback = () => {
      dirtiedFunc(this)
    }

    this.dirtiedCallback = lib().createYogaDirtiedCallback(callback)
    if (!this.dirtiedCallback.ptr) {
      this.dirtiedCallback.close()
      this.dirtiedCallback = null
      throw new Error("Failed to create Yoga dirtied callback")
    }

    lib().yogaNodeSetDirtiedFunc(this.ptr, this.dirtiedCallback.ptr)
  }

  unsetDirtiedFunc(): void {
    if (this.freed) return
    lib().yogaNodeUnsetDirtiedFunc(this.ptr)
    this.closeDirtiedCallback()
  }

  private setEnum(kind: number, value: number): void {
    if (this.freed) return
    lib().yogaNodeStyleSetEnum(this.ptr, kind, value)
  }

  private getEnum(kind: number, fallback: number): number {
    if (this.freed) return fallback
    return lib().yogaNodeStyleGetEnum(this.ptr, kind)
  }

  private setFloat(kind: number, value: number | undefined): void {
    if (this.freed) return
    lib().yogaNodeStyleSetFloat(this.ptr, kind, value ?? NaN)
  }

  private getFloat(kind: number): number {
    if (this.freed) return NaN
    return lib().yogaNodeStyleGetFloat(this.ptr, kind)
  }

  private setValue(kind: number, edgeOrGutter: number, valueInput: ValueInput): void {
    if (this.freed) return
    const value = parseValue(valueInput)
    lib().yogaNodeStyleSetValue(this.ptr, kind, edgeOrGutter, value.unit, value.value)
  }

  private getValue(kind: number, edgeOrGutter: number): Value {
    if (this.freed) return UNDEFINED_VALUE
    return unpackValue(lib().yogaNodeStyleGetValue(this.ptr, kind, edgeOrGutter))
  }

  private collectSubtree(nodes: Node[]): Node[] {
    for (let index = 0; index < this.getChildCount(); index++) {
      this.getChild(index)?.collectSubtree(nodes)
    }
    nodes.push(this)
    return nodes
  }

  private closeMeasureCallback(): void {
    if (!this.measureCallback) return
    this.measureCallback.close()
    this.measureCallback = null
  }

  private closeDirtiedCallback(): void {
    if (!this.dirtiedCallback) return
    this.dirtiedCallback.close()
    this.dirtiedCallback = null
  }

  private markFreed(): void {
    this.freed = true
    nodeRegistry.delete(pointerKey(this.ptr))
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
