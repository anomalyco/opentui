import { RGBA, rgbToHex } from "@opentui/core"
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing"

type Cleanup = () => void | Promise<void>

export interface DocVisualFixture {
  id: string
  label: string
  width: number
  height: number
  cursor?: boolean
  inheritTerminalColors?: boolean
  render(
    setup: TestRendererSetup,
    registerCleanup: (cleanup: Cleanup) => void,
  ): void | Cleanup | Promise<void | Cleanup>
}

export async function renderDocVisual(fixture: DocVisualFixture) {
  const properties: Array<{ target: object; name: string; descriptor: PropertyDescriptor | undefined }> = [
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "window",
  ].map((name) => ({ target: globalThis, name, descriptor: Object.getOwnPropertyDescriptor(globalThis, name) }))

  if (globalThis.window) {
    properties.push({
      target: globalThis.window,
      name: "requestAnimationFrame",
      descriptor: Object.getOwnPropertyDescriptor(globalThis.window, "requestAnimationFrame"),
    })
  }

  let setup: TestRendererSetup | undefined
  const cleanups: Cleanup[] = []

  try {
    setup = await createTestRenderer({
      width: fixture.width,
      height: fixture.height,
      useThread: false,
      remote: false,
      forwardEnvKeys: [],
    })

    setup.renderer.setBackgroundColor(RGBA.defaultBackground())
    const cleanup = await fixture.render(setup, (callback) => cleanups.push(callback))
    if (cleanup) cleanups.push(cleanup)
    await setup.renderOnce()

    const frame = setup.captureSpans()
    const state = setup.renderer.getCursorState()
    const colors: ReturnType<typeof serializeColor>[] = []
    const colorIndexes = new Map<string, number>()

    function colorIndex(color: RGBA, channel: "foreground" | "background") {
      if (fixture.inheritTerminalColors && color.intent === "rgb") {
        const value = rgbToHex(color)

        if (channel === "background" && value === "#000000") color = RGBA.defaultBackground()
        else if (channel === "foreground" && value === "#ffffff") color = RGBA.defaultForeground()
        else if (channel === "foreground" && value === "#808080") color = RGBA.fromIndex(244)
      }

      const value = serializeColor(color)
      const key = `${value.intent}:${value.slot ?? ""}:${value.value}`
      let index = colorIndexes.get(key)

      if (index === undefined) {
        index = colors.push(value) - 1
        colorIndexes.set(key, index)
      }

      return index
    }

    const lines = frame.lines.map(({ spans }) =>
      spans.map(({ text, width, fg, bg, attributes }) => ({
        text,
        width,
        foreground: colorIndex(fg, "foreground"),
        background: colorIndex(bg, "background"),
        ...(attributes ? { attributes } : {}),
      })),
    )

    return {
      label: fixture.label,
      cols: frame.cols,
      rows: frame.rows,
      colors,
      cursor: fixture.cursor && state.visible ? { column: state.x - 1, row: state.y - 1, style: state.style } : null,
      lines,
    }
  } finally {
    try {
      try {
        setup?.renderer.destroy()
      } finally {
        const errors: unknown[] = []

        for (const cleanup of cleanups.toReversed()) {
          try {
            await cleanup()
          } catch (error) {
            errors.push(error)
          }
        }

        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) throw new AggregateError(errors, "Documentation visual cleanup failed")
      }
    } finally {
      for (const { target, name, descriptor } of properties.toReversed()) {
        if (descriptor) Object.defineProperty(target, name, descriptor)
        else Reflect.deleteProperty(target, name)
      }
    }
  }
}

function serializeColor(color: RGBA) {
  return {
    intent: color.intent,
    value: rgbToHex(color),
    ...(color.intent === "indexed" ? { slot: color.slot } : {}),
  }
}
