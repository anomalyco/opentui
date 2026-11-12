export const ANSI = {
  switchToAlternateScreen: "\x1b[?1049h",
  switchToMainScreen: "\x1b[?1049l",
  reset: "\x1b[0m",
  resetScrollRegion: "\x1b[r",
  home: "\x1b[H",
  clearScreen: "\x1b[2J",
  clearSavedLines: "\x1b[3J",

  scrollDown: (lines: number) => `\x1b[${lines}T`,
  // Line feeds on the last row (65535, the largest tty row count, clamps to it) keep the top rows in scrollback,
  // where xterm.js deletes them on CSI S. A screen packet holds 4096 bytes, so rows past 4000 still use CSI S.
  scrollIntoHistory: (lines: number) =>
    `\x1b[65535H${"\n".repeat(Math.min(lines, 4000))}${lines > 4000 ? `\x1b[${lines - 4000}S` : ""}`,

  moveCursor: (row: number, col: number) => `\x1b[${row};${col}H`,
  moveCursorAndClear: (row: number, col: number) => `\x1b[${row};${col}H\x1b[J`,

  setRgbBackground: (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`,
  resetBackground: "\x1b[49m",

  // Bracketed paste mode
  bracketedPasteStart: "\u001b[200~",
  bracketedPasteEnd: "\u001b[201~",
}
