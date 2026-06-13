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
  type Value,
} from "../yoga.js"

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
    const root = Yoga.Node.create()
    const child = Yoga.Node.create()
    const grandchild = Yoga.Node.create()

    root.insertChild(child, 0)
    child.insertChild(grandchild, 0)

    root.freeRecursive()

    expect(root.isFreed()).toBe(true)
    expect(child.isFreed()).toBe(true)
    expect(grandchild.isFreed()).toBe(true)
  })

  test("covers enum, float, value, and edge style round trips", () => {
    const node = Yoga.Node.create()

    node.setDirection(Direction.RTL)
    expect(node.getDirection()).toBe(Direction.RTL)

    node.setFlexDirection(FlexDirection.RowReverse)
    expect(node.getFlexDirection()).toBe(FlexDirection.RowReverse)

    node.setJustifyContent(Justify.SpaceEvenly)
    expect(node.getJustifyContent()).toBe(Justify.SpaceEvenly)

    node.setAlignContent(Align.SpaceAround)
    expect(node.getAlignContent()).toBe(Align.SpaceAround)

    node.setAlignItems(Align.Center)
    expect(node.getAlignItems()).toBe(Align.Center)

    node.setAlignSelf(Align.FlexEnd)
    expect(node.getAlignSelf()).toBe(Align.FlexEnd)

    node.setPositionType(PositionType.Absolute)
    expect(node.getPositionType()).toBe(PositionType.Absolute)

    node.setFlexWrap(Wrap.WrapReverse)
    expect(node.getFlexWrap()).toBe(Wrap.WrapReverse)

    node.setOverflow(Overflow.Scroll)
    expect(node.getOverflow()).toBe(Overflow.Scroll)

    node.setDisplay(Display.None)
    expect(node.getDisplay()).toBe(Display.None)
    node.setDisplay(Display.Contents)
    expect(node.getDisplay()).toBe(Display.Contents)

    node.setBoxSizing(BoxSizing.ContentBox)
    expect(node.getBoxSizing()).toBe(BoxSizing.ContentBox)

    node.setFlex(2)
    expect(node.getFlex()).toBe(2)

    node.setFlexGrow(3)
    expect(node.getFlexGrow()).toBe(3)

    node.setFlexShrink(4)
    expect(node.getFlexShrink()).toBe(4)

    node.setAspectRatio(1.5)
    expect(node.getAspectRatio()).toBe(1.5)

    node.setFlexBasis(10)
    expectYogaValue(node.getFlexBasis(), Unit.Point, 10)
    node.setFlexBasisPercent(25)
    expectYogaValue(node.getFlexBasis(), Unit.Percent, 25)
    node.setFlexBasisAuto()
    expectYogaValue(node.getFlexBasis(), Unit.Auto)

    node.setWidth(100)
    expectYogaValue(node.getWidth(), Unit.Point, 100)
    node.setWidthPercent(50)
    expectYogaValue(node.getWidth(), Unit.Percent, 50)
    node.setWidthAuto()
    expectYogaValue(node.getWidth(), Unit.Auto)

    node.setHeight({ unit: Unit.Point, value: 80 })
    expectYogaValue(node.getHeight(), Unit.Point, 80)
    node.setHeightPercent(40)
    expectYogaValue(node.getHeight(), Unit.Percent, 40)
    node.setHeightAuto()
    expectYogaValue(node.getHeight(), Unit.Auto)

    node.setMinWidth(11)
    expectYogaValue(node.getMinWidth(), Unit.Point, 11)
    node.setMinWidthPercent(12)
    expectYogaValue(node.getMinWidth(), Unit.Percent, 12)

    node.setMinHeight(13)
    expectYogaValue(node.getMinHeight(), Unit.Point, 13)
    node.setMinHeightPercent(14)
    expectYogaValue(node.getMinHeight(), Unit.Percent, 14)

    node.setMaxWidth(15)
    expectYogaValue(node.getMaxWidth(), Unit.Point, 15)
    node.setMaxWidthPercent(16)
    expectYogaValue(node.getMaxWidth(), Unit.Percent, 16)

    node.setMaxHeight(17)
    expectYogaValue(node.getMaxHeight(), Unit.Point, 17)
    node.setMaxHeightPercent(18)
    expectYogaValue(node.getMaxHeight(), Unit.Percent, 18)

    node.setMargin(Edge.Left, 19)
    expectYogaValue(node.getMargin(Edge.Left), Unit.Point, 19)
    node.setMarginPercent(Edge.Left, 20)
    expectYogaValue(node.getMargin(Edge.Left), Unit.Percent, 20)
    node.setMarginAuto(Edge.Left)
    expectYogaValue(node.getMargin(Edge.Left), Unit.Auto)

    node.setPadding(Edge.Top, 21)
    expectYogaValue(node.getPadding(Edge.Top), Unit.Point, 21)
    node.setPaddingPercent(Edge.Top, 22)
    expectYogaValue(node.getPadding(Edge.Top), Unit.Percent, 22)

    node.setPosition(Edge.Right, 23)
    expectYogaValue(node.getPosition(Edge.Right), Unit.Point, 23)
    node.setPositionPercent(Edge.Right, 24)
    expectYogaValue(node.getPosition(Edge.Right), Unit.Percent, 24)
    node.setPositionAuto(Edge.Right)
    expectYogaValue(node.getPosition(Edge.Right), Unit.Auto)

    node.setGap(Gutter.Column, 25)
    expectYogaValue(node.getGap(Gutter.Column), Unit.Point, 25)
    node.setGapPercent(Gutter.Column, 26)
    expect(node.getGap(Gutter.Column).value).toBe(26)

    node.setBorder(Edge.Bottom, 27)
    expect(node.getBorder(Edge.Bottom)).toBe(27)

    node.setIsReferenceBaseline(true)
    expect(node.isReferenceBaseline()).toBe(true)

    node.setAlwaysFormsContainingBlock(true)
    expect(node.getAlwaysFormsContainingBlock()).toBe(true)
    node.setAlwaysFormsContainingBlock(false)
    expect(node.getAlwaysFormsContainingBlock()).toBe(false)

    node.free()
  })

  test("resets optional style values with undefined like Yoga JS", () => {
    const node = Yoga.Node.create()
    const expectUndefinedValue = (value: Value): void => expectYogaValue(value, Unit.Undefined, NaN)

    node.setFlex(2)
    node.setFlex(undefined)
    expect(Number.isNaN(node.getFlex())).toBe(true)

    node.setFlexGrow(3)
    node.setFlexGrow(undefined)
    expect(node.getFlexGrow()).toBe(0)

    node.setFlexShrink(4)
    node.setFlexShrink(undefined)
    expect(node.getFlexShrink()).toBe(0)

    node.setAspectRatio(1.5)
    node.setAspectRatio(undefined)
    expect(Number.isNaN(node.getAspectRatio())).toBe(true)

    node.setFlexBasis(10)
    node.setFlexBasis(undefined)
    expectUndefinedValue(node.getFlexBasis())

    node.setWidth(100)
    node.setWidth(undefined)
    expectUndefinedValue(node.getWidth())

    node.setHeightPercent(40)
    node.setHeightPercent(undefined)
    expectUndefinedValue(node.getHeight())

    node.setMinWidth(11)
    node.setMinWidth(undefined)
    expectUndefinedValue(node.getMinWidth())

    node.setMinHeightPercent(14)
    node.setMinHeightPercent(undefined)
    expectUndefinedValue(node.getMinHeight())

    node.setMaxWidth(15)
    node.setMaxWidth(undefined)
    expectUndefinedValue(node.getMaxWidth())

    node.setMaxHeightPercent(18)
    node.setMaxHeightPercent(undefined)
    expectUndefinedValue(node.getMaxHeight())

    node.setMargin(Edge.Left, 19)
    node.setMargin(Edge.Left, undefined)
    expectUndefinedValue(node.getMargin(Edge.Left))

    node.setPaddingPercent(Edge.Top, 22)
    node.setPaddingPercent(Edge.Top, undefined)
    expectUndefinedValue(node.getPadding(Edge.Top))

    node.setPosition(Edge.Right, 23)
    node.setPosition(Edge.Right, undefined)
    expectUndefinedValue(node.getPosition(Edge.Right))

    node.setGap(Gutter.Column, 25)
    node.setGap(Gutter.Column, undefined)
    expectUndefinedValue(node.getGap(Gutter.Column))

    node.setBorder(Edge.Bottom, 27)
    node.setBorder(Edge.Bottom, undefined)
    expect(Number.isNaN(node.getBorder(Edge.Bottom))).toBe(true)

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
      expect(width).toBeNaN()
      expect(widthMode).toBe(MeasureMode.Undefined)
      expect(height).toBeNaN()
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
})
