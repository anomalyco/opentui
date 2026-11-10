import { createCliRenderer, MouseEvent, type CliRenderer } from "@opentui/core"
import {
  Box,
  Text,
  Generic,
  type VNode,
  instantiate,
  delegate,
  Input,
  BoxRenderable,
  type BoxOptions,
  vstyles,
} from "@opentui/core"
import type { RenderContext } from "@opentui/core"
import type { OptimizedBuffer } from "@opentui/core"
import { setupCommonDemoKeys } from "./lib/standalone-keys.js"
import { RGBA, parseColor } from "@opentui/core"
import type { Renderable } from "@opentui/core"
import { TextAttributes } from "@opentui/core"

const textColor = parseColor("#FFFFFF")
const globalbgColor = parseColor("#333333")
const transparent = parseColor("transparent")

const { bold, italic, underline, dim, boldItalic, boldUnderline, italicUnderline, color, bgColor, styled } = vstyles

// This is NOT react and not reactive, it's just a declarative way to compose renderables
// and mount them into a parent container.
function MyRenderable(props: any, children: VNode[] = []) {
  const mouseHandler = (event: MouseEvent) => {
    console.log("mouseHandler", event.type)
  }

  return Box({ id: "inner" }, [
    Box(
      {
        border: true,
        borderStyle: "double",
        padding: 1,
        onMouseDown: mouseHandler,
        flexDirection: "row",
      },
      children,
    ),
  ])
}

function Button(
  props: {
    title: string
    onClick: () => void
    borderColor?: string | RGBA
  },
  children: VNode[] = [],
) {
  return Box(
    {
      id: "button",
      border: true,
      onMouseDown: props.onClick,
      borderColor: props.borderColor,
    },
    Text({ content: props.title, selectable: false }),
    ...children,
  )
}

// Custom Rendering Functional Construct
function VNodeButton(
  props: {
    title: string
    onClick: () => void
    borderColor?: RGBA
  },
  children: VNode[] = [],
) {
  return Generic(
    {
      render: (buffer, deltaTime, renderable) => demoRenderFn(props, buffer, deltaTime, renderable),
      maxWidth: props.title.length + 4,
      margin: 1,
    },
    Box(
      {
        id: "button",
        height: 3,
        onMouseDown: props.onClick,
      },
      children,
    ),
  )
}

// Custom Rendering - Class Method Example
class MyRoot {
  width: number

  constructor(private readonly props: { title: string; borderColor?: RGBA }) {
    this.width = Math.max(props.title.length + 4, 12)
    Object.assign(this, props)
  }

  render(buffer: OptimizedBuffer, deltaTime: number, renderable: Renderable) {
    demoRenderFn(this.props, buffer, deltaTime, renderable)
  }
}

function ButtonWithClassRender(
  props: { title: string; onClick: () => void; borderColor?: RGBA; marginLeft?: number },
  children: VNode[] = [],
) {
  return Generic(
    new MyRoot(props),
    Box(
      {
        id: "button",
        height: 3,
        onMouseDown: props.onClick,
      },
      ...children,
    ),
  )
}

// Host Override Example
function MyDelegateToVNodeRenderable(props: any, children: VNode[] = []) {
  return delegate(
    {
      add: `${props.id}_box3`,
      remove: `${props.id}_box3`,
    },
    Box({ id: `${props.id}_outer3`, border: true, borderColor: "blue" }, [
      Box({ id: `${props.id}_inner3`, border: true, borderColor: "magenta" }, [
        Box({ id: `${props.id}_box3`, flexDirection: "row", border: true, padding: 1 }, children),
      ]),
    ]),
  )
}

function MyDelegateToRenderableComponent(renderer: RenderContext, props: any, children: VNode[] = []) {
  return delegate(
    {
      add: "__box4",
      remove: "__box4",
    },
    instantiate(
      renderer,
      Box({ id: "__outer4", border: true, borderColor: "blue" }, [
        Box({ id: "__inner4", border: true, borderColor: "magenta" }, [
          Box({ id: "__box4", flexDirection: "row", border: true, padding: 1 }, children),
        ]),
      ]),
    ),
  )
}

function MyInstancedRenderable(renderer: RenderContext, props: any, children: VNode[] = []) {
  return instantiate(renderer, MyDelegateToVNodeRenderable(props, children))
}

function LabeledInput(props: { id: string; label: string; placeholder: string }) {
  return delegate(
    {
      focus: `${props.id}-input`,
    },
    Box(
      { flexDirection: "row", id: `${props.id}-labeled-outer` },
      Text({ content: props.label + " " }),
      Input({
        id: `${props.id}-input`,
        placeholder: props.placeholder,
        width: 20,
        backgroundColor: "white",
        textColor: "black",
        cursorColor: "blue",
        focusedBackgroundColor: "orange",
      }),
    ),
  )
}

function BaseBox(props: BoxOptions, children: VNode[] = []) {
  return Box(
    {
      id: "base-box",
      border: true,
      borderColor: "blue",
      backgroundColor: "orange",
      ...props,
      renderAfter(buffer: OptimizedBuffer, deltaTime: number) {
        buffer.drawText("Hello", this.x + 1, this.y + 1, RGBA.fromInts(255, 255, 255, 255))
        props.renderAfter?.call(this, buffer, deltaTime)
      },
    },
    children,
  )
}

function ExtendedBaseBox(props: BoxOptions, children: VNode[] = []) {
  return BaseBox(
    {
      id: "extended-base-box",
      ...props,
      renderAfter(buffer: OptimizedBuffer, deltaTime: number) {
        buffer.drawText("Extended", this.x + 1, this.y + 2, RGBA.fromInts(255, 255, 255, 255))
      },
    },
    children,
  )
}

export function run(renderer: CliRenderer) {
  renderer.start()
  const mainGroup = new BoxRenderable(renderer, {
    id: "main-group",
  })
  renderer.root.add(mainGroup)

  // BaseBox example
  mainGroup.add(ExtendedBaseBox({ width: 20, height: 10, position: "absolute", left: 55, top: 10, zIndex: 1000 }))

  // Proxied VNode example
  const tree = MyRenderable({ id: "demo-root" }, [
    Box({ id: "child-1", width: 20, height: 3, border: true, marginBottom: 1 }, [Text({ content: "Hello" })]),
    Box({ id: "child-2", width: 24, height: 3, border: true }, [Text({ content: "VNode world" })]),
  ])
  tree.backgroundColor = RGBA.fromInts(0, 155, 155, 100)

  mainGroup.add(tree)

  const input = LabeledInput({ id: "labeled-input", label: "Label:", placeholder: "Enter your text..." })
  input.focus()
  mainGroup.add(input)

  //
  // VNode delegated version
  const instance1 = MyDelegateToVNodeRenderable({ id: "delegated-demo-root" }, [
    Box({ id: "child-1", width: 20, height: 3, border: true, marginBottom: 1 }, [
      Text({ content: "Hello delegated 1" }),
    ]),
    Box({ id: "child-2", width: 24, height: 3, border: true }, [Text({ content: "VNode world delegated 1" })]),
  ])
  instance1.backgroundColor = RGBA.fromInts(155, 0, 155, 100)

  mainGroup.add(instance1)

  //
  // Instaced Delegated version
  const instance = MyInstancedRenderable(renderer, { id: "demo-root" }, [
    Box({ id: "child-1", width: 20, height: 3, border: true, marginBottom: 1 }, [Text({ content: "Hello 2" })]),
    Box({ id: "child-2", width: 24, height: 3, border: true }, [Text({ content: "VNode world 2" })]),
  ])

  mainGroup.add(instance)

  // Delegated to __box3, would otherwise end up in the top-level group!
  instance.add(Box({ id: "child-3", width: 24, height: 3, border: true }, [Text({ content: "VNode world 3" })]))
  instance.add(Button({ title: "Click me", onClick: () => console.log("clicked"), borderColor: "red" }))

  //
  // Renderable delegated version
  const renderableInstance = MyDelegateToRenderableComponent(renderer, { id: "demo-root" }, [
    Box({ id: "child-1", width: 20, height: 3, border: true, marginBottom: 1 }, [Text({ content: "Hello 4" })]),
    Box({ id: "child-2", width: 24, height: 3, border: true }, [Text({ content: "VNode world 4" })]),
  ])
  mainGroup.add(renderableInstance)

  // Delegated to __box4, would otherwise end up in the top-level group!
  renderableInstance.add(Button({ title: "Click me too!", onClick: () => console.log("clicked"), borderColor: "red" }))

  //
  // Add animated VNode button
  mainGroup.add(
    VNodeButton({
      title: "Animated VNode",
      onClick: () => console.log("vnode 1 clicked"),
      borderColor: RGBA.fromInts(0, 0, 255, 255),
    }),
  )
  mainGroup.add(
    VNodeButton({
      title: "Same VNode, different props",
      onClick: () => console.log("vnode 2 clicked"),
      borderColor: RGBA.fromInts(255, 0, 255, 255),
    }),
  )

  //
  // Add button with class render function
  mainGroup.add(
    ButtonWithClassRender({
      marginLeft: 1,
      title: "ClassRender",
      onClick: () => console.log("clicked"),
      borderColor: RGBA.fromInts(0, 0, 255, 255),
    }),
  )

  mainGroup.add(
    Box({ flexDirection: "column", marginTop: 2 }, [
      // Basic styles
      Text({}, bold("Bold Text")),
      Text({}, italic("Italic Text")),
      Text({}, underline("Underlined Text")),
      Text({}, dim("Dim Text")),

      // Combined styles
      Text({}, boldItalic("Bold and Italic")),
      Text({}, boldUnderline("Bold and Underlined")),
      Text({}, italicUnderline("Italic and Underlined")),

      // Colors
      Text({}, color("#ff6b6b", "Red Text")),
      Text({}, bgColor("#4ecdc4", "Text with Background")),

      // Custom styling
      Text({}, styled(TextAttributes.BOLD | TextAttributes.UNDERLINE, "Custom Styled")),

      // Stacked styles
      Text({}, bold(underline("hello"), " world")),
      Text({}, color("#ff6b6b", bold("Bold Red"), " normal")),
      Text({}, italic(color("#4ecdc4", "Green Italic"), " normal again")),
    ]),
  )
}

export function destroy(renderer: CliRenderer) {
  renderer.root.getRenderable("main-group")?.destroyRecursively()
  renderer.requestRender()
}

if (import.meta.main) {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
  })

  run(renderer)
  setupCommonDemoKeys(renderer)
  renderer.start()
}

function demoRenderFn(
  props: { title: string; borderColor?: RGBA },
  buffer: OptimizedBuffer,
  deltaTime: number,
  renderable: Renderable,
) {
  const x = renderable.x
  const y = renderable.y
  const width = renderable.width
  const height = renderable.height

  const borderColor = props.borderColor ?? RGBA.fromInts(255, 255, 0, 255)

  // Draw a simple animated button with pulsing border
  const timeInSeconds = Date.now() / 1000
  const pulse = Math.sin(timeInSeconds * 4) * 0.5 + 0.5 // Fast pulsing, 0-1 oscillation

  const pulsingBorderColor = RGBA.fromValues(
    borderColor.r * (0.1 + pulse * 0.9),
    borderColor.g * (0.1 + pulse * 0.9),
    borderColor.b * (0.1 + pulse * 0.9),
    borderColor.a,
  )

  const bgPulse = Math.sin(timeInSeconds * 2 + Math.PI / 2) * 0.4 + 0.6 // Different frequency and phase
  const pulsingBgColor = RGBA.fromValues(
    globalbgColor.r * bgPulse,
    globalbgColor.g * bgPulse,
    globalbgColor.b * bgPulse,
    globalbgColor.a,
  )

  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const isTop = row === 0
      const isBottom = row === height - 1
      const isLeft = col === 0
      const isRight = col === width - 1
      const isBorder = isTop || isBottom || isLeft || isRight

      if (isBorder) {
        buffer.setCell(x + col, y + row, "█", pulsingBorderColor, pulsingBgColor)
      } else {
        buffer.setCell(x + col, y + row, " ", textColor, pulsingBgColor)
      }
    }
  }

  const titlePulse = Math.sin(timeInSeconds * 6) * 0.5 + 0.5 // Even faster text pulse
  const textScale = 0.3 + titlePulse * 0.7
  const pulsingTextColor = RGBA.fromValues(
    textColor.r * textScale,
    textColor.g * textScale,
    textColor.b * textScale,
    textColor.a,
  )

  const titleX = x + Math.floor((width - props.title.length) / 2)
  const titleY = y + Math.floor(height / 2)
  if (titleY >= y && titleY < y + height) {
    buffer.drawText(props.title, titleX, titleY, pulsingTextColor, transparent)
  }
}
