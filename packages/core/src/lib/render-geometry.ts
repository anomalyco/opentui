export type RenderGeometryScreenMode = "alternate-screen" | "main-screen" | "split-footer"

export interface RenderGeometry {
  effectiveFooterHeight: number
  renderOffset: number
  renderWidth: number
  renderHeight: number
}

export function calculateRenderGeometry(
  screenMode: RenderGeometryScreenMode,
  terminalWidth: number,
  terminalHeight: number,
  footerHeight: number,
): RenderGeometry {
  const safeTerminalWidth = Math.max(terminalWidth, 0)
  const safeTerminalHeight = Math.max(terminalHeight, 0)

  if (screenMode !== "split-footer") {
    return {
      effectiveFooterHeight: 0,
      renderOffset: 0,
      renderWidth: safeTerminalWidth,
      renderHeight: safeTerminalHeight,
    }
  }

  const effectiveFooterHeight = Math.min(footerHeight, safeTerminalHeight)

  return {
    effectiveFooterHeight,
    renderOffset: safeTerminalHeight - effectiveFooterHeight,
    renderWidth: safeTerminalWidth,
    renderHeight: effectiveFooterHeight,
  }
}
