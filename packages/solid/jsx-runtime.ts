import { createComponent, createElement, spread } from "@opentui/solid"
import type {
  AsciiFontProps,
  BoxProps,
  CodeProps,
  ExtendedIntrinsicElements,
  InputProps,
  LinkProps,
  MarkdownProps,
  OpenTUIComponents,
  ScrollBoxProps,
  SelectProps,
  SpanProps,
  TabSelectProps,
  TextareaProps,
  TextProps,
} from "./src/types/elements.js"
import type { JSX as SolidJSX } from "solid-js"

type SolidComponent = (props: Record<string, unknown>) => unknown

interface JsxProps {
  children?: unknown
  key?: unknown
  [key: string]: unknown
}

function normalizeProps(props: JsxProps | null | undefined): Record<string, unknown> {
  if (!props) {
    return {}
  }

  if (!("key" in props)) {
    return props
  }

  const { key: _key, ...rest } = props
  return rest
}

function createIntrinsicElement(type: string, props: Record<string, unknown>): unknown {
  const element = createElement(type)
  spread(element, props)
  return element
}

export function jsx(type: string | SolidComponent, props: JsxProps | null = {}): unknown {
  const normalizedProps = normalizeProps(props)

  if (typeof type === "function") {
    return (createComponent as any)(type, normalizedProps)
  }

  return createIntrinsicElement(type, normalizedProps)
}

export const jsxs = jsx

export function jsxDEV(type: string | SolidComponent, props: JsxProps | null = {}): unknown {
  return jsx(type, props)
}

export function Fragment(props: { children?: unknown }): unknown {
  return props.children ?? null
}

export namespace JSX {
  export type Element = SolidJSX.Element

  export interface IntrinsicElements extends ExtendedIntrinsicElements<OpenTUIComponents> {
    box: BoxProps
    text: TextProps
    span: SpanProps
    input: InputProps
    select: SelectProps
    ascii_font: AsciiFontProps
    tab_select: TabSelectProps
    scrollbox: ScrollBoxProps
    code: CodeProps
    textarea: TextareaProps
    markdown: MarkdownProps

    b: SpanProps
    strong: SpanProps
    i: SpanProps
    em: SpanProps
    u: SpanProps
    br: {}
    a: LinkProps
  }

  export interface ElementChildrenAttribute {
    children: {}
  }
}
