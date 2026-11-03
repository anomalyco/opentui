import type * as React from "react"
import type {
  AsciiFontProps,
  BoxProps,
  CodeProps,
  DiffProps,
  ExtendedIntrinsicElements,
  ImageProps,
  InputProps,
  LineBreakProps,
  LineNumberProps,
  LinkProps,
  MarkdownProps,
  OpenTUIComponents,
  ScrollBoxProps,
  SelectProps,
  SpanProps,
  TabSelectProps,
  TextareaProps,
  TextProps,
  VideoProps,
} from "./src/types/components.js"

export namespace JSX {
  type Element = React.ReactNode

  interface ElementClass extends React.Component<any> {
    render(): React.ReactNode
  }

  interface ElementAttributesProperty {
    props: {}
  }

  interface ElementChildrenAttribute {
    children: {}
  }

  interface IntrinsicAttributes extends React.Attributes {}

  interface IntrinsicElements extends React.JSX.IntrinsicElements, ExtendedIntrinsicElements<OpenTUIComponents> {
    box: BoxProps
    text: TextProps
    span: SpanProps
    code: CodeProps
    diff: DiffProps
    markdown: MarkdownProps
    input: InputProps
    textarea: TextareaProps
    select: SelectProps
    scrollbox: ScrollBoxProps
    "ascii-font": AsciiFontProps
    "tab-select": TabSelectProps
    "line-number": LineNumberProps
    image: ImageProps
    video: VideoProps
    // Text modifiers
    b: SpanProps
    i: SpanProps
    u: SpanProps
    strong: SpanProps
    em: SpanProps
    br: LineBreakProps
    a: LinkProps
  }
}
