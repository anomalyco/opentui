export interface TerminalRenderOptions {
  /** Quiet zone in modules. ISO requires at least 4 for QR Code. */
  border?: number
  /**
   * Render using ANSI background colors. Recommended when a real scanner will read the terminal.
   * The ANSI renderer paints light modules white and dark modules black independent of terminal theme.
   */
  ansi?: boolean
  /** Swap light and dark output. Leave false for normal black-on-white scanner-facing output. */
  invert?: boolean
}

export interface NormalizedTerminalRenderOptions {
  border: number
  ansi: boolean
  invert: boolean
}

export function matrixToSvg(
  matrix: boolean[][],
  border: number,
  minimumBorder: number,
  moduleSize: number,
  lightColor: string,
  darkColor: string,
): string {
  if (!Number.isInteger(border) || border < minimumBorder) {
    throw new RangeError(`Border/quiet zone must be at least ${minimumBorder} modules`)
  }
  if (moduleSize <= 0) throw new RangeError("moduleSize must be positive")
  const size = matrix.length
  const dimension = (size + border * 2) * moduleSize
  const parts: string[] = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dimension} ${dimension}" width="${dimension}" height="${dimension}" shape-rendering="crispEdges">`,
  )
  parts.push(`<rect width="100%" height="100%" fill="${escapeXml(lightColor)}"/>`)
  const path: string[] = []
  for (let y = 0; y < size; y++) {
    let x = 0
    while (x < size) {
      if (!matrix[y][x]) {
        x++
        continue
      }
      const startX = x
      while (x < size && matrix[y][x]) x++
      const rectX = (startX + border) * moduleSize
      const rectY = (y + border) * moduleSize
      const rectW = (x - startX) * moduleSize
      path.push(`M${rectX},${rectY}h${rectW}v${moduleSize}h-${rectW}z`)
    }
  }
  parts.push(`<path d="${path.join("")}" fill="${escapeXml(darkColor)}"/>`)
  parts.push("</svg>")
  return parts.join("")
}

export function normalizeTerminalOptions(
  options: number | TerminalRenderOptions,
  defaultBorder: number,
  minimumBorder: number,
): NormalizedTerminalRenderOptions {
  const result: NormalizedTerminalRenderOptions =
    typeof options === "number"
      ? { border: options, ansi: false, invert: false }
      : { border: options.border ?? defaultBorder, ansi: options.ansi === true, invert: options.invert === true }
  if (!Number.isInteger(result.border) || result.border < minimumBorder) {
    throw new RangeError(`Terminal border/quiet zone must be at least ${minimumBorder} modules`)
  }
  return result
}

export function matrixToTerminal(matrix: boolean[][], options: NormalizedTerminalRenderOptions): string {
  const size = matrix.length
  const darkText = options.invert ? "  " : "██"
  const lightText = options.invert ? "██" : "  "
  const darkAnsi = options.invert ? "\x1b[47m  " : "\x1b[40m  "
  const lightAnsi = options.invert ? "\x1b[40m  " : "\x1b[47m  "
  const lines: string[] = []
  for (let y = -options.border; y < size + options.border; y++) {
    let line = ""
    for (let x = -options.border; x < size + options.border; x++) {
      const dark = x >= 0 && y >= 0 && x < size && y < size && matrix[y][x]
      line += options.ansi ? (dark ? darkAnsi : lightAnsi) : dark ? darkText : lightText
    }
    lines.push(options.ansi ? `${line}\x1b[0m` : line)
  }
  return lines.join("\n")
}

function escapeXml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&apos;", '"': "&quot;" })[ch]!,
  )
}
