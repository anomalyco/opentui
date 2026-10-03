import { describe, expect, test } from "bun:test"
import Yoga, {
  Align,
  BoxSizing,
  Direction,
  Display,
  Edge,
  Errata,
  ExperimentalFeature,
  FlexDirection,
  Gutter,
  Justify,
  MeasureMode,
  Overflow,
  PositionType,
  Unit,
  Wrap,
  YogaError,
  YogaStatus,
  type Value,
} from "../yoga.js"
import { YogaEnumKind } from "../yoga.internal.js"
import { FFIRenderLib } from "../zig.js"

function expectYogaValue(actual: Value, unit: Unit, value?: number): void {
  expect(actual.unit).toBe(unit)
  if (value === undefined) return
  if (Number.isNaN(value)) {
    expect(Number.isNaN(actual.value)).toBe(true)
  } else {
    expect(actual.value).toBe(value)
  }
}

describe("native Yoga API coverage", () => {
  test("covers config lifecycle and option getters", () => {
    const config = Yoga.Config.create()

    expect(config.useWebDefaults()).toBe(false)
    config.setUseWebDefaults(true)
    expect(config.useWebDefaults()).toBe(true)

    config.setPointScaleFactor(2)
    expect(config.getPointScaleFactor()).toBe(2)

    config.setErrata(Errata.All)
    expect(config.getErrata()).toBe(Errata.All)
    config.setErrata(Errata.None)
    expect(config.getErrata()).toBe(Errata.None)

    config.setExperimentalFeatureEnabled(ExperimentalFeature.WebFlexBasis, true)
    expect(config.isExperimentalFeatureEnabled(ExperimentalFeature.WebFlexBasis)).toBe(true)
    config.setExperimentalFeatureEnabled(ExperimentalFeature.WebFlexBasis, false)
    expect(config.isExperimentalFeatureEnabled(ExperimentalFeature.WebFlexBasis)).toBe(false)

    Yoga.Config.destroy(config)
    expect(config.useWebDefaults()).toBe(false)
  })

  test("covers node factories, parent-child APIs, removal APIs, and destroy helpers", () => {
    const config = Yoga.Config.create()
    const root = Yoga.Node.createWithConfig(config)
    const child0 = Yoga.Node.createDefault()
    const child1 = Yoga.Node.create(config)

    root.insertChild(child0, 0)
    root.insertChild(child1, 1)

    expect(root.getChildCount()).toBe(2)
    expect(root.getChild(0)).toBe(child0)
    expect(root.getChild(1)).toBe(child1)
    expect(root.getChild(2)).toBeNull()
    expect(child0.getParent()).toBe(root)
    expect(child1.getParent()).toBe(root)

    root.removeChild(child0)
    expect(root.getChildCount()).toBe(1)
    expect(child0.getParent()).toBeNull()

    root.insertChild(child0, 1)
    root.removeAllChildren()
    expect(root.getChildCount()).toBe(0)
    expect(child0.getParent()).toBeNull()
    expect(child1.getParent()).toBeNull()

    Yoga.Node.destroy(child0)
    expect(child0.isFreed()).toBe(true)
    child1.free()
    expect(child1.isFreed()).toBe(true)
    root.free()
    expect(root.isFreed()).toBe(true)
    config.free()
  })

  test("covers recursive free marking all known subtree wrappers freed", () => {
    const config = Yoga.Config.create()
    const root = Yoga.Node.create(config)
    const child = Yoga.Node.create(config)
    const grandchild = Yoga.Node.create(config)

    root.insertChild(child, 0)
    child.insertChild(grandchild, 0)
    grandchild.setMeasureFunc(() => ({ width: 1, height: 1 }))
    grandchild.setDirtiedFunc(() => {})
    root.calculateLayout()
    expect(grandchild.getComputedHeight()).toBe(1)

    root.freeRecursive()

    expect(root.isFreed()).toBe(true)
    expect(child.isFreed()).toBe(true)
    expect(grandchild.isFreed()).toBe(true)
    expect(config.nodes.size).toBe(0)
    expect(config.measures.size).toBe(0)
    expect(config.dirtied.size).toBe(0)
    config.free()
  })

  test("style setters round-trip through their getters and reset with undefined like Yoga JS", () => {
    const node = Yoga.Node.create()
    const point = (value: number) => ({ unit: Unit.Point, value })
    const percent = (value: number) => ({ unit: Unit.Percent, value })
    const auto = { unit: Unit.Auto, value: NaN }
    const unset = { unit: Unit.Undefined, value: NaN }
    // Rows run in order on one node; a row that writes undefined resets the value set by the row above it.
    const rows: [set: () => void, get: () => unknown, expected: unknown][] = [
      [() => node.setDirection(Direction.RTL), () => node.getDirection(), Direction.RTL],
      [() => node.setFlexDirection(FlexDirection.RowReverse), () => node.getFlexDirection(), FlexDirection.RowReverse],
      [() => node.setJustifyContent(Justify.SpaceEvenly), () => node.getJustifyContent(), Justify.SpaceEvenly],
      [() => node.setAlignContent(Align.SpaceAround), () => node.getAlignContent(), Align.SpaceAround],
      [() => node.setAlignItems(Align.Center), () => node.getAlignItems(), Align.Center],
      [() => node.setAlignSelf(Align.FlexEnd), () => node.getAlignSelf(), Align.FlexEnd],
      [() => node.setPositionType(PositionType.Absolute), () => node.getPositionType(), PositionType.Absolute],
      [() => node.setFlexWrap(Wrap.WrapReverse), () => node.getFlexWrap(), Wrap.WrapReverse],
      [() => node.setOverflow(Overflow.Scroll), () => node.getOverflow(), Overflow.Scroll],
      [() => node.setDisplay(Display.None), () => node.getDisplay(), Display.None],
      [() => node.setDisplay(Display.Contents), () => node.getDisplay(), Display.Contents],
      [() => node.setBoxSizing(BoxSizing.ContentBox), () => node.getBoxSizing(), BoxSizing.ContentBox],
      [() => node.setFlex(2), () => node.getFlex(), 2],
      [() => node.setFlex(undefined), () => node.getFlex(), NaN],
      [() => node.setFlexGrow(3), () => node.getFlexGrow(), 3],
      [() => node.setFlexGrow(undefined), () => node.getFlexGrow(), 0],
      [() => node.setFlexShrink(4), () => node.getFlexShrink(), 4],
      [() => node.setFlexShrink(undefined), () => node.getFlexShrink(), 0],
      [() => node.setAspectRatio(1.5), () => node.getAspectRatio(), 1.5],
      [() => node.setAspectRatio(undefined), () => node.getAspectRatio(), NaN],
      [() => node.setFlexBasis(10), () => node.getFlexBasis(), point(10)],
      [() => node.setFlexBasis(undefined), () => node.getFlexBasis(), unset],
      [() => node.setFlexBasisPercent(25), () => node.getFlexBasis(), percent(25)],
      [() => node.setFlexBasisAuto(), () => node.getFlexBasis(), auto],
      [() => node.setWidth(100), () => node.getWidth(), point(100)],
      [() => node.setWidth(undefined), () => node.getWidth(), unset],
      [() => node.setWidthPercent(50), () => node.getWidth(), percent(50)],
      [() => node.setWidthAuto(), () => node.getWidth(), auto],
      [() => node.setHeight({ unit: Unit.Point, value: 80 }), () => node.getHeight(), point(80)],
      [() => node.setHeightPercent(40), () => node.getHeight(), percent(40)],
      [() => node.setHeightPercent(undefined), () => node.getHeight(), unset],
      [() => node.setHeightAuto(), () => node.getHeight(), auto],
      [() => node.setMinWidth(11), () => node.getMinWidth(), point(11)],
      [() => node.setMinWidth(undefined), () => node.getMinWidth(), unset],
      [() => node.setMinWidthPercent(12), () => node.getMinWidth(), percent(12)],
      [() => node.setMinHeight(13), () => node.getMinHeight(), point(13)],
      [() => node.setMinHeightPercent(14), () => node.getMinHeight(), percent(14)],
      [() => node.setMinHeightPercent(undefined), () => node.getMinHeight(), unset],
      [() => node.setMaxWidth(15), () => node.getMaxWidth(), point(15)],
      [() => node.setMaxWidth(undefined), () => node.getMaxWidth(), unset],
      [() => node.setMaxWidthPercent(16), () => node.getMaxWidth(), percent(16)],
      [() => node.setMaxHeight(17), () => node.getMaxHeight(), point(17)],
      [() => node.setMaxHeightPercent(18), () => node.getMaxHeight(), percent(18)],
      [() => node.setMaxHeightPercent(undefined), () => node.getMaxHeight(), unset],
      [() => node.setMargin(Edge.Left, 19), () => node.getMargin(Edge.Left), point(19)],
      [() => node.setMargin(Edge.Left, undefined), () => node.getMargin(Edge.Left), unset],
      [() => node.setMarginPercent(Edge.Left, 20), () => node.getMargin(Edge.Left), percent(20)],
      [() => node.setMarginAuto(Edge.Left), () => node.getMargin(Edge.Left), auto],
      [() => node.setPadding(Edge.Top, 21), () => node.getPadding(Edge.Top), point(21)],
      [() => node.setPaddingPercent(Edge.Top, 22), () => node.getPadding(Edge.Top), percent(22)],
      [() => node.setPaddingPercent(Edge.Top, undefined), () => node.getPadding(Edge.Top), unset],
      [() => node.setPosition(Edge.Right, 23), () => node.getPosition(Edge.Right), point(23)],
      [() => node.setPosition(Edge.Right, undefined), () => node.getPosition(Edge.Right), unset],
      [() => node.setPositionPercent(Edge.Right, 24), () => node.getPosition(Edge.Right), percent(24)],
      [() => node.setPositionAuto(Edge.Right), () => node.getPosition(Edge.Right), auto],
      [() => node.setGap(Gutter.Column, 25), () => node.getGap(Gutter.Column), point(25)],
      [() => node.setGap(Gutter.Column, undefined), () => node.getGap(Gutter.Column), unset],
      // YGNodeStyleGetGap returns a float, so a percent gap reads back as points (as on main).
      [() => node.setGapPercent(Gutter.Column, 26), () => node.getGap(Gutter.Column), point(26)],
      [() => node.setBorder(Edge.Bottom, 27), () => node.getBorder(Edge.Bottom), 27],
      [() => node.setBorder(Edge.Bottom, undefined), () => node.getBorder(Edge.Bottom), NaN],
      [() => node.setIsReferenceBaseline(true), () => node.isReferenceBaseline(), true],
      [() => node.setAlwaysFormsContainingBlock(true), () => node.getAlwaysFormsContainingBlock(), true],
      [() => node.setAlwaysFormsContainingBlock(false), () => node.getAlwaysFormsContainingBlock(), false],
    ]
    const show = (value: unknown) => JSON.stringify(value, (_, item) => (Number.isNaN(item) ? "NaN" : item))
    const results = rows.map(([set, get]) => {
      set()
      return [String(set), show(get())]
    })
    expect(results).toEqual(rows.map(([set, , expected]) => [String(set), show(expected)]))
    node.free()
  })

  test("covers copyStyle", () => {
    const source = Yoga.Node.create()
    const target = Yoga.Node.create()

    source.setWidth(33)
    source.setHeight("44%")
    source.setMargin(Edge.Left, 5)
    source.setPadding(Edge.Top, 6)
    source.setFlexGrow(7)

    target.copyStyle(source)

    expectYogaValue(target.getWidth(), Unit.Point, 33)
    expectYogaValue(target.getHeight(), Unit.Percent, 44)
    expectYogaValue(target.getMargin(Edge.Left), Unit.Point, 5)
    expectYogaValue(target.getPadding(Edge.Top), Unit.Point, 6)
    expect(target.getFlexGrow()).toBe(7)

    source.free()
    target.free()
  })

  test("covers layout accessors and computed edge accessors", () => {
    const root = Yoga.Node.create()
    const child = Yoga.Node.create()

    root.setWidth(100)
    root.setHeight(80)
    child.setPositionType(PositionType.Absolute)
    child.setPosition(Edge.Left, 7)
    child.setPosition(Edge.Top, 9)
    child.setWidth(20)
    child.setHeight(10)
    child.setMargin(Edge.Left, 3)
    child.setPadding(Edge.Left, 4)
    child.setBorder(Edge.Left, 5)
    root.insertChild(child, 0)

    root.calculateLayout(undefined, undefined, Direction.LTR)

    const layout = child.getComputedLayout()
    expect(child.getComputedLeft()).toBe(layout.left)
    expect(child.getComputedTop()).toBe(layout.top)
    expect(child.getComputedRight()).toBe(layout.right)
    expect(child.getComputedBottom()).toBe(layout.bottom)
    expect(child.getComputedWidth()).toBe(layout.width)
    expect(child.getComputedHeight()).toBe(layout.height)
    expect(layout.left).toBe(10)
    expect(layout.top).toBe(9)
    expect(layout.width).toBe(20)
    expect(layout.height).toBe(10)
    expect(child.getComputedMargin(Edge.Left)).toBe(3)
    expect(child.getComputedPadding(Edge.Left)).toBe(4)
    expect(child.getComputedBorder(Edge.Left)).toBe(5)

    root.freeRecursive()
  })

  test("covers measure, dirtied, dirty, and new-layout lifecycle APIs", () => {
    const root = Yoga.Node.create()

    expect(root.isDirty()).toBe(true)
    expect(root.hasMeasureFunc()).toBe(false)

    root.setMeasureFunc((width, widthMode, height, heightMode) => {
      expect(Number.isNaN(width)).toBe(true)
      expect(widthMode).toBe(MeasureMode.Undefined)
      expect(Number.isNaN(height)).toBe(true)
      expect(heightMode).toBe(MeasureMode.Undefined)
      return { width: 10, height: 10 }
    })
    expect(root.hasMeasureFunc()).toBe(true)

    root.calculateLayout(undefined, undefined, Direction.LTR)
    expect(root.isDirty()).toBe(false)
    expect(root.hasNewLayout()).toBe(true)

    root.markLayoutSeen()
    expect(root.hasNewLayout()).toBe(false)

    let dirtied = 0
    root.setDirtiedFunc((node) => {
      expect(node).toBe(root)
      dirtied++
    })

    root.markDirty()
    expect(root.isDirty()).toBe(true)
    expect(dirtied).toBe(1)

    root.calculateLayout(undefined, undefined, Direction.LTR)
    root.unsetDirtiedFunc()
    root.markDirty()
    expect(dirtied).toBe(1)

    root.unsetMeasureFunc()
    expect(root.hasMeasureFunc()).toBe(false)

    root.reset()
    expect(root.hasNewLayout()).toBe(true)

    root.free()
  })

  test("YogaError reports the native status of a rejected operation", () => {
    const other = new FFIRenderLib()
    const config = Yoga.Config.create()
    const nodes = Array.from({ length: 257 }, () => Yoga.Node.create(config))
    // Native Yoga trees hold at most 256 levels.
    for (let depth = 1; depth < 256; depth++) nodes[depth - 1].insertChild(nodes[depth], 0)
    const leaf = nodes[256]
    // Another library passes its own callback guard, so native refuses the mutation during layout.
    leaf.setMeasureFunc(() => {
      other.yogaNodeStyleSetEnum(leaf.ptr, YogaEnumKind.Display, Display.None)
      return { width: 1, height: 1 }
    })
    const statusOf = (call: () => void) => {
      try {
        call()
      } catch (error) {
        return error instanceof YogaError ? YogaStatus[error.status] : error
      }
      return "no error"
    }
    const rows: [string, () => void, keyof typeof YogaStatus][] = [
      ["a child that already has an owner", () => nodes[2].insertChild(nodes[1], 0), "InvalidArgument"],
      ["a negative child index", () => leaf.insertChild(nodes[0], -1), "InvalidArgument"],
      ["a 257th level", () => nodes[255].insertChild(leaf, 0), "DepthLimit"],
      ["a mutation during layout", () => leaf.calculateLayout(), "Busy"],
    ]
    try {
      expect(rows.map(([name, call]) => [name, statusOf(call)])).toEqual(rows.map(([name, , status]) => [name, status]))
      expect(new YogaError("yogaNodeFreeChecked", 99 as YogaStatus).message).toBe(
        "yogaNodeFreeChecked failed: Unknown (status 99)",
      )
    } finally {
      nodes[0].freeRecursive()
      leaf.free()
      config.free()
    }

    // Disposal frees idle configs, including a default config that is recreated after a free.
    const freedDefault = other.getYogaHost().getDefaultConfig()
    freedDefault.free()
    const idle = other.getYogaHost().getDefaultConfig()
    expect(idle).not.toBe(freedDefault)
    other.dispose()
    expect(() => idle.assertAlive()).toThrow("Yoga config is freed")
  })

  test("freed nodes and configs answer every call without native access", () => {
    const lib = new FFIRenderLib()
    const config = Yoga.Config.create(lib)
    const node = Yoga.Node.create(config)
    node.free()
    config.free()
    const native = Object.getOwnPropertyNames(FFIRenderLib.prototype).filter((name) => name.startsWith("yoga"))
    for (const name of native) {
      Object.defineProperty(lib, name, {
        configurable: true,
        value: () => {
          throw new Error(`${name} reached native code`)
        },
      })
    }
    // These throw by design or need real arguments; every other method returns before native access.
    const exempt = [
      "constructor",
      "assertAlive",
      "ensureCallbacks",
      "runMutation",
      "assertSameLibrary",
      "collectSubtree",
    ]
    try {
      for (const target of [node, config]) {
        const prototype = Object.getPrototypeOf(target)
        for (const name of Object.getOwnPropertyNames(prototype)) {
          const method = Object.getOwnPropertyDescriptor(prototype, name)!.value
          if (typeof method !== "function" || exempt.includes(name)) continue
          expect(() => method.call(target, 0, 0, 0)).not.toThrow()
        }
      }
      expect(node.getChild(0)).toBeNull()
      expect(node.isDirty()).toBe(true)
      expect(Number.isNaN(node.getWidth().value)).toBe(true)
    } finally {
      for (const name of native) delete (lib as unknown as Record<string, unknown>)[name]
      lib.dispose()
    }
  })
})
