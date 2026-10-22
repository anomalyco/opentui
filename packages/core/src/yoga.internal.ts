import { nativeConstants } from "./native-abi.generated.js"
import type { NativeScene } from "./NativeScene.js"
import type { Pointer } from "./platform/ffi.js"
import { NATIVE_EDGE_NONE, NativeStyleFlags, NativeStyleGroup, type RenderLib, type SceneNodeHandle } from "./zig.js"
import { Config, Unit, type Dimension, type Value } from "./yoga.js"

// Scene style staging and the Yoga callback boundary. Not part of the public Yoga namespace.
// Module initialization reads only native constants: this module loads inside the yoga/zig import cycle.

export type ValueInput = number | "auto" | `${number}%` | Value | undefined

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

export function sceneGetEnum(scene: NativeScene, node: SceneStyleNode, kind: YogaEnumKindId): number {
  return scene.getStyle(node, NativeStyleGroup.Enum, kind, NATIVE_EDGE_NONE).value
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

export const UNDEFINED_VALUE: Value = { unit: nativeConstants.OT_UNIT_UNDEFINED, value: NaN }

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
