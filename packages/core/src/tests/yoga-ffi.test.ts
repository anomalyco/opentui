import { describe, expect, test } from "bun:test"
import Yoga, { Align, Direction, Edge, FlexDirection, MeasureMode, Unit } from "../yoga.js"

describe("native Yoga FFI facade", () => {
  test("computes a basic flex layout", () => {
    const config = Yoga.Config.create()
    config.setUseWebDefaults(false)
    config.setPointScaleFactor(1)

    const root = Yoga.Node.create(config)
    const child = Yoga.Node.create(config)

    root.setFlexDirection(FlexDirection.Row)
    root.setWidth(100)
    root.setHeight(100)
    child.setFlexGrow(1)
    root.insertChild(child, 0)

    root.calculateLayout(undefined, undefined, Direction.LTR)

    expect(child.getComputedLayout()).toEqual({ left: 0, top: 0, right: 0, bottom: 0, width: 100, height: 100 })
    expect(root.isDirty()).toBe(false)

    root.freeRecursive()
    config.free()
  })

  test("returns independent computed-layout snapshots", () => {
    const node = Yoga.Node.create()
    node.setWidth(10)
    node.setHeight(5)
    node.calculateLayout(undefined, undefined, Direction.LTR)
    const first = node.getComputedLayout()

    node.setWidth(20)
    node.calculateLayout(undefined, undefined, Direction.LTR)
    const second = node.getComputedLayout()

    expect(first.width).toBe(10)
    expect(second.width).toBe(20)
    expect(first).not.toBe(second)
    node.freeRecursive()
  })

  test("supports percentage margins and RTL computed edges", () => {
    const root = Yoga.Node.create()
    root.setWidth(100)
    root.setHeight(100)
    root.setMargin(Edge.Start, "10%")

    root.calculateLayout(100, 100, Direction.LTR)
    expect(root.getComputedMargin(Edge.Left)).toBe(10)
    expect(root.getComputedMargin(Edge.Right)).toBe(0)

    root.calculateLayout(100, 100, Direction.RTL)
    expect(root.getComputedMargin(Edge.Left)).toBe(0)
    expect(root.getComputedMargin(Edge.Right)).toBe(10)

    root.freeRecursive()
  })

  test("packs style values with Yoga-compatible units", () => {
    const node = Yoga.Node.create()

    expect(node.getFlexBasis().unit).toBe(Unit.Auto)

    node.setFlexBasis(10)
    expect(node.getFlexBasis()).toEqual({ unit: Unit.Point, value: 10 })

    node.setFlexBasisAuto()
    expect(node.getFlexBasis().unit).toBe(Unit.Auto)

    node.setWidth("50%")
    expect(node.getWidth()).toEqual({ unit: Unit.Percent, value: 50 })

    node.freeRecursive()
  })

  test("runs JS measure callbacks through the native trampoline", () => {
    const root = Yoga.Node.create()
    root.setWidth(100)
    root.setHeight(100)
    root.setAlignItems(Align.FlexStart)

    let calls = 0
    const measured = Yoga.Node.create()
    measured.setMeasureFunc((width, widthMode, height, heightMode) => {
      calls++
      expect(width).toBe(100)
      expect(widthMode).toBe(MeasureMode.AtMost)
      expect(height).toBe(100)
      expect(heightMode).toBe(MeasureMode.AtMost)
      return { width: 40, height: 12 }
    })

    root.insertChild(measured, 0)
    root.calculateLayout(undefined, undefined, Direction.LTR)

    expect(calls).toBe(1)
    expect(measured.getComputedWidth()).toBe(40)
    expect(measured.getComputedHeight()).toBe(12)

    root.freeRecursive()
  })

  test("handles incomplete measure dimensions like the previous Yoga binding", () => {
    const root = Yoga.Node.create()
    root.setWidth(100)
    root.setHeight(100)

    const heightOnly = Yoga.Node.create()
    const widthOnly = Yoga.Node.create()
    const empty = Yoga.Node.create()

    root.insertChild(heightOnly, root.getChildCount())
    root.insertChild(widthOnly, root.getChildCount())
    root.insertChild(empty, root.getChildCount())

    heightOnly.setMeasureFunc(() => ({ width: undefined as unknown as number, height: 10 }))
    widthOnly.setMeasureFunc(() => ({ width: 10, height: undefined as unknown as number }))
    empty.setMeasureFunc(() => ({}) as { width: number; height: number })

    root.calculateLayout(undefined, undefined, Direction.LTR)

    expect(heightOnly.getComputedWidth()).toBe(100)
    expect(heightOnly.getComputedHeight()).toBe(10)
    expect(widthOnly.getComputedWidth()).toBe(100)
    expect(widthOnly.getComputedHeight()).toBe(0)
    expect(empty.getComputedWidth()).toBe(100)
    expect(empty.getComputedHeight()).toBe(0)

    root.freeRecursive()
  })
})
