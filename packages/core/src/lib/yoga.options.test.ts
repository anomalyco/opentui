import { test, expect, describe } from "bun:test"
import {
  parseBoxSizing,
  parseDimension,
  parseDirection,
  parseDisplay,
  parseEdge,
  parseGutter,
  parseLogLevel,
  parseMeasureMode,
  parseUnit,
  parseAlign,
  parseAlignItems,
  parseFlexDirection,
  parseJustify,
  parseOverflow,
  parsePositionType,
  parseWrap,
} from "./yoga.options.js"
import {
  BoxSizing,
  Align,
  Dimension,
  Direction,
  Display,
  Edge,
  FlexDirection,
  Gutter,
  Justify,
  LogLevel,
  MeasureMode,
  Overflow,
  PositionType,
  Unit,
  Wrap,
} from "../yoga.js"

describe("parseBoxSizing", () => {
  test("parses border-box", () => {
    expect(parseBoxSizing("border-box")).toBe(BoxSizing.BorderBox)
  })

  test("parses content-box", () => {
    expect(parseBoxSizing("content-box")).toBe(BoxSizing.ContentBox)
  })

  test("handles uppercase", () => {
    expect(parseBoxSizing("BORDER-BOX")).toBe(BoxSizing.BorderBox)
    expect(parseBoxSizing("CONTENT-BOX")).toBe(BoxSizing.ContentBox)
  })

  test("returns default for invalid value", () => {
    expect(parseBoxSizing("invalid")).toBe(BoxSizing.BorderBox)
  })

  test("handles null", () => {
    expect(() => parseBoxSizing(null as any)).not.toThrow()
  })

  test("handles undefined", () => {
    expect(() => parseBoxSizing(undefined as any)).not.toThrow()
  })
})

describe("parseDimension", () => {
  test("parses width", () => {
    expect(parseDimension("width")).toBe(Dimension.Width)
  })

  test("parses height", () => {
    expect(parseDimension("height")).toBe(Dimension.Height)
  })

  test("handles uppercase", () => {
    expect(parseDimension("WIDTH")).toBe(Dimension.Width)
    expect(parseDimension("HEIGHT")).toBe(Dimension.Height)
  })

  test("returns default for invalid value", () => {
    expect(parseDimension("invalid")).toBe(Dimension.Width)
  })

  test("handles null", () => {
    expect(() => parseDimension(null as any)).not.toThrow()
  })

  test("handles undefined", () => {
    expect(() => parseDimension(undefined as any)).not.toThrow()
  })
})

describe("parseDirection", () => {
  test("parses inherit", () => {
    expect(parseDirection("inherit")).toBe(Direction.Inherit)
  })

  test("parses ltr", () => {
    expect(parseDirection("ltr")).toBe(Direction.LTR)
  })

  test("parses rtl", () => {
    expect(parseDirection("rtl")).toBe(Direction.RTL)
  })

  test("handles uppercase", () => {
    expect(parseDirection("INHERIT")).toBe(Direction.Inherit)
    expect(parseDirection("LTR")).toBe(Direction.LTR)
    expect(parseDirection("RTL")).toBe(Direction.RTL)
  })

  test("returns default for invalid value", () => {
    expect(parseDirection("invalid")).toBe(Direction.LTR)
  })

  test("handles null", () => {
    expect(() => parseDirection(null as any)).not.toThrow()
  })

  test("handles undefined", () => {
    expect(() => parseDirection(undefined as any)).not.toThrow()
  })
})

describe("parseDisplay", () => {
  test("parses flex", () => {
    expect(parseDisplay("flex")).toBe(Display.Flex)
  })

  test("parses none", () => {
    expect(parseDisplay("none")).toBe(Display.None)
  })

  test("parses contents", () => {
    expect(parseDisplay("contents")).toBe(Display.Contents)
  })

  test("handles uppercase", () => {
    expect(parseDisplay("FLEX")).toBe(Display.Flex)
    expect(parseDisplay("NONE")).toBe(Display.None)
    expect(parseDisplay("CONTENTS")).toBe(Display.Contents)
  })

  test("returns default for invalid value", () => {
    expect(parseDisplay("invalid")).toBe(Display.Flex)
  })

  test("handles null", () => {
    expect(() => parseDisplay(null as any)).not.toThrow()
  })

  test("handles undefined", () => {
    expect(() => parseDisplay(undefined as any)).not.toThrow()
  })
})

describe("parseEdge", () => {
  test("parses left", () => {
    expect(parseEdge("left")).toBe(Edge.Left)
  })

  test("parses top", () => {
    expect(parseEdge("top")).toBe(Edge.Top)
  })

  test("parses right", () => {
    expect(parseEdge("right")).toBe(Edge.Right)
  })

  test("parses bottom", () => {
    expect(parseEdge("bottom")).toBe(Edge.Bottom)
  })

  test("parses start", () => {
    expect(parseEdge("start")).toBe(Edge.Start)
  })

  test("parses end", () => {
    expect(parseEdge("end")).toBe(Edge.End)
  })

  test("parses horizontal", () => {
    expect(parseEdge("horizontal")).toBe(Edge.Horizontal)
  })

  test("parses vertical", () => {
    expect(parseEdge("vertical")).toBe(Edge.Vertical)
  })

  test("parses all", () => {
    expect(parseEdge("all")).toBe(Edge.All)
  })

  test("handles uppercase", () => {
    expect(parseEdge("LEFT")).toBe(Edge.Left)
    expect(parseEdge("TOP")).toBe(Edge.Top)
  })

  test("returns default for invalid value", () => {
    expect(parseEdge("invalid")).toBe(Edge.All)
  })

  test("handles null", () => {
    expect(() => parseEdge(null as any)).not.toThrow()
  })

  test("handles undefined", () => {
    expect(() => parseEdge(undefined as any)).not.toThrow()
  })
})

describe("parseGutter", () => {
  test("parses column", () => {
    expect(parseGutter("column")).toBe(Gutter.Column)
  })

  test("parses row", () => {
    expect(parseGutter("row")).toBe(Gutter.Row)
  })

  test("parses all", () => {
    expect(parseGutter("all")).toBe(Gutter.All)
  })

  test("handles uppercase", () => {
    expect(parseGutter("COLUMN")).toBe(Gutter.Column)
    expect(parseGutter("ROW")).toBe(Gutter.Row)
    expect(parseGutter("ALL")).toBe(Gutter.All)
  })

  test("returns default for invalid value", () => {
    expect(parseGutter("invalid")).toBe(Gutter.All)
  })

  test("handles null", () => {
    expect(() => parseGutter(null as any)).not.toThrow()
  })

  test("handles undefined", () => {
    expect(() => parseGutter(undefined as any)).not.toThrow()
  })
})

describe("parseLogLevel", () => {
  test("parses error", () => {
    expect(parseLogLevel("error")).toBe(LogLevel.Error)
  })

  test("parses warn", () => {
    expect(parseLogLevel("warn")).toBe(LogLevel.Warn)
  })

  test("parses info", () => {
    expect(parseLogLevel("info")).toBe(LogLevel.Info)
  })

  test("parses debug", () => {
    expect(parseLogLevel("debug")).toBe(LogLevel.Debug)
  })

  test("parses verbose", () => {
    expect(parseLogLevel("verbose")).toBe(LogLevel.Verbose)
  })

  test("parses fatal", () => {
    expect(parseLogLevel("fatal")).toBe(LogLevel.Fatal)
  })

  test("handles uppercase", () => {
    expect(parseLogLevel("ERROR")).toBe(LogLevel.Error)
    expect(parseLogLevel("WARN")).toBe(LogLevel.Warn)
    expect(parseLogLevel("INFO")).toBe(LogLevel.Info)
  })

  test("returns default for invalid value", () => {
    expect(parseLogLevel("invalid")).toBe(LogLevel.Info)
  })

  test("handles null", () => {
    expect(() => parseLogLevel(null as any)).not.toThrow()
  })

  test("handles undefined", () => {
    expect(() => parseLogLevel(undefined as any)).not.toThrow()
  })
})

describe("parseMeasureMode", () => {
  test("parses undefined", () => {
    expect(parseMeasureMode("undefined")).toBe(MeasureMode.Undefined)
  })

  test("parses exactly", () => {
    expect(parseMeasureMode("exactly")).toBe(MeasureMode.Exactly)
  })

  test("parses at-most", () => {
    expect(parseMeasureMode("at-most")).toBe(MeasureMode.AtMost)
  })

  test("handles uppercase", () => {
    expect(parseMeasureMode("UNDEFINED")).toBe(MeasureMode.Undefined)
    expect(parseMeasureMode("EXACTLY")).toBe(MeasureMode.Exactly)
    expect(parseMeasureMode("AT-MOST")).toBe(MeasureMode.AtMost)
  })

  test("returns default for invalid value", () => {
    expect(parseMeasureMode("invalid")).toBe(MeasureMode.Undefined)
  })

  test("handles null", () => {
    expect(() => parseMeasureMode(null as any)).not.toThrow()
  })

  test("handles undefined value", () => {
    expect(() => parseMeasureMode(undefined as any)).not.toThrow()
  })
})

describe("parseUnit", () => {
  test("parses undefined", () => {
    expect(parseUnit("undefined")).toBe(Unit.Undefined)
  })

  test("parses point", () => {
    expect(parseUnit("point")).toBe(Unit.Point)
  })

  test("parses percent", () => {
    expect(parseUnit("percent")).toBe(Unit.Percent)
  })

  test("parses auto", () => {
    expect(parseUnit("auto")).toBe(Unit.Auto)
  })

  test("handles uppercase", () => {
    expect(parseUnit("UNDEFINED")).toBe(Unit.Undefined)
    expect(parseUnit("POINT")).toBe(Unit.Point)
    expect(parseUnit("PERCENT")).toBe(Unit.Percent)
    expect(parseUnit("AUTO")).toBe(Unit.Auto)
  })

  test("returns default for invalid value", () => {
    expect(parseUnit("invalid")).toBe(Unit.Point)
  })

  test("handles null", () => {
    expect(() => parseUnit(null as any)).not.toThrow()
  })

  test("handles undefined value", () => {
    expect(() => parseUnit(undefined as any)).not.toThrow()
  })
})

describe("parseAlign", () => {
  test("parses auto", () => {
    expect(parseAlign("auto")).toBe(Align.Auto)
  })

  test("parses flex-start", () => {
    expect(parseAlign("flex-start")).toBe(Align.FlexStart)
  })

  test("parses center", () => {
    expect(parseAlign("center")).toBe(Align.Center)
  })

  test("parses flex-end", () => {
    expect(parseAlign("flex-end")).toBe(Align.FlexEnd)
  })

  test("parses stretch", () => {
    expect(parseAlign("stretch")).toBe(Align.Stretch)
  })

  test("parses baseline", () => {
    expect(parseAlign("baseline")).toBe(Align.Baseline)
  })

  test("parses space-between", () => {
    expect(parseAlign("space-between")).toBe(Align.SpaceBetween)
  })

  test("parses space-around", () => {
    expect(parseAlign("space-around")).toBe(Align.SpaceAround)
  })

  test("parses space-evenly", () => {
    expect(parseAlign("space-evenly")).toBe(Align.SpaceEvenly)
  })

  test("handles null", () => {
    expect(parseAlign(null)).toBe(Align.Auto)
  })

  test("handles undefined", () => {
    expect(parseAlign(undefined)).toBe(Align.Auto)
  })

  test("handles uppercase", () => {
    expect(parseAlign("CENTER")).toBe(Align.Center)
  })

  test("returns default for invalid value", () => {
    expect(parseAlign("invalid")).toBe(Align.Auto)
  })
})

describe("parseAlignItems", () => {
  test("parses auto", () => {
    expect(parseAlignItems("auto")).toBe(Align.Auto)
  })

  test("parses flex-start", () => {
    expect(parseAlignItems("flex-start")).toBe(Align.FlexStart)
  })

  test("parses center", () => {
    expect(parseAlignItems("center")).toBe(Align.Center)
  })

  test("parses flex-end", () => {
    expect(parseAlignItems("flex-end")).toBe(Align.FlexEnd)
  })

  test("parses stretch", () => {
    expect(parseAlignItems("stretch")).toBe(Align.Stretch)
  })

  test("parses baseline", () => {
    expect(parseAlignItems("baseline")).toBe(Align.Baseline)
  })

  test("parses space-between", () => {
    expect(parseAlignItems("space-between")).toBe(Align.SpaceBetween)
  })

  test("parses space-around", () => {
    expect(parseAlignItems("space-around")).toBe(Align.SpaceAround)
  })

  test("parses space-evenly", () => {
    expect(parseAlignItems("space-evenly")).toBe(Align.SpaceEvenly)
  })

  test("returns Stretch for null", () => {
    expect(parseAlignItems(null)).toBe(Align.Stretch)
  })

  test("returns Stretch for undefined", () => {
    expect(parseAlignItems(undefined)).toBe(Align.Stretch)
  })

  test("handles uppercase", () => {
    expect(parseAlignItems("CENTER")).toBe(Align.Center)
  })

  test("returns Stretch for invalid value", () => {
    expect(parseAlignItems("invalid")).toBe(Align.Stretch)
  })
})

describe("parseFlexDirection", () => {
  test("parses column", () => {
    expect(parseFlexDirection("column")).toBe(FlexDirection.Column)
  })

  test("parses column-reverse", () => {
    expect(parseFlexDirection("column-reverse")).toBe(FlexDirection.ColumnReverse)
  })

  test("parses row", () => {
    expect(parseFlexDirection("row")).toBe(FlexDirection.Row)
  })

  test("parses row-reverse", () => {
    expect(parseFlexDirection("row-reverse")).toBe(FlexDirection.RowReverse)
  })

  test("handles null", () => {
    expect(parseFlexDirection(null)).toBe(FlexDirection.Column)
  })

  test("handles undefined", () => {
    expect(parseFlexDirection(undefined)).toBe(FlexDirection.Column)
  })

  test("handles uppercase", () => {
    expect(parseFlexDirection("ROW")).toBe(FlexDirection.Row)
  })

  test("returns default for invalid value", () => {
    expect(parseFlexDirection("invalid")).toBe(FlexDirection.Column)
  })
})

describe("parseJustify", () => {
  test("parses flex-start", () => {
    expect(parseJustify("flex-start")).toBe(Justify.FlexStart)
  })

  test("parses center", () => {
    expect(parseJustify("center")).toBe(Justify.Center)
  })

  test("parses flex-end", () => {
    expect(parseJustify("flex-end")).toBe(Justify.FlexEnd)
  })

  test("parses space-between", () => {
    expect(parseJustify("space-between")).toBe(Justify.SpaceBetween)
  })

  test("parses space-around", () => {
    expect(parseJustify("space-around")).toBe(Justify.SpaceAround)
  })

  test("parses space-evenly", () => {
    expect(parseJustify("space-evenly")).toBe(Justify.SpaceEvenly)
  })

  test("handles null", () => {
    expect(parseJustify(null)).toBe(Justify.FlexStart)
  })

  test("handles undefined", () => {
    expect(parseJustify(undefined)).toBe(Justify.FlexStart)
  })

  test("handles uppercase", () => {
    expect(parseJustify("CENTER")).toBe(Justify.Center)
  })

  test("returns default for invalid value", () => {
    expect(parseJustify("invalid")).toBe(Justify.FlexStart)
  })
})

describe("parseOverflow", () => {
  test("parses visible", () => {
    expect(parseOverflow("visible")).toBe(Overflow.Visible)
  })

  test("parses hidden", () => {
    expect(parseOverflow("hidden")).toBe(Overflow.Hidden)
  })

  test("parses scroll", () => {
    expect(parseOverflow("scroll")).toBe(Overflow.Scroll)
  })

  test("handles null", () => {
    expect(parseOverflow(null)).toBe(Overflow.Visible)
  })

  test("handles undefined", () => {
    expect(parseOverflow(undefined)).toBe(Overflow.Visible)
  })

  test("handles uppercase", () => {
    expect(parseOverflow("HIDDEN")).toBe(Overflow.Hidden)
  })

  test("returns default for invalid value", () => {
    expect(parseOverflow("invalid")).toBe(Overflow.Visible)
  })
})

describe("parsePositionType", () => {
  test("parses static", () => {
    expect(parsePositionType("static")).toBe(PositionType.Static)
  })

  test("parses relative", () => {
    expect(parsePositionType("relative")).toBe(PositionType.Relative)
  })

  test("parses absolute", () => {
    expect(parsePositionType("absolute")).toBe(PositionType.Absolute)
  })

  test("handles null", () => {
    expect(parsePositionType(null)).toBe(PositionType.Relative)
  })

  test("handles undefined", () => {
    expect(parsePositionType(undefined)).toBe(PositionType.Relative)
  })

  test("handles uppercase", () => {
    expect(parsePositionType("ABSOLUTE")).toBe(PositionType.Absolute)
  })

  test("returns default for invalid value", () => {
    expect(parsePositionType("invalid")).toBe(PositionType.Static)
  })
})

describe("parseWrap", () => {
  test("parses no-wrap", () => {
    expect(parseWrap("no-wrap")).toBe(Wrap.NoWrap)
  })

  test("parses wrap", () => {
    expect(parseWrap("wrap")).toBe(Wrap.Wrap)
  })

  test("parses wrap-reverse", () => {
    expect(parseWrap("wrap-reverse")).toBe(Wrap.WrapReverse)
  })

  test("handles null", () => {
    expect(parseWrap(null)).toBe(Wrap.NoWrap)
  })

  test("handles undefined", () => {
    expect(parseWrap(undefined)).toBe(Wrap.NoWrap)
  })

  test("handles uppercase", () => {
    expect(parseWrap("WRAP")).toBe(Wrap.Wrap)
  })

  test("returns default for invalid value", () => {
    expect(parseWrap("invalid")).toBe(Wrap.NoWrap)
  })
})
