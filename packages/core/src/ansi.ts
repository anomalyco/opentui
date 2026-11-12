export const ANSI = {
  switchToAlternateScreen: "\x1b[?1049h",
  switchToMainScreen: "\x1b[?1049l",
  reset: "\x1b[0m",
  resetScrollRegion: "\x1b[r",
  home: "\x1b[H",
  clearScreen: "\x1b[2J",
  clearSavedLines: "\x1b[3J",

  scrollDown: (lines: number) => `\x1b[${lines}T`,
  // Line feeds on the last row; CSI S deletes the top rows on xterm instead of keeping them in scrollback.
  scrollIntoHistory: (lines: number) => `\x1b7\x1b[9999;1H${"\n".repeat(lines)}\x1b8`,

  moveCursor: (row: number, col: number) => `\x1b[${row};${col}H`,
  moveCursorAndClear: (row: number, col: number) => `\x1b[${row};${col}H\x1b[J`,

  setRgbBackground: (r: number, g: number, b: number) => `\x1b[48;2;${r};${g};${b}m`,
  resetBackground: "\x1b[49m",

  // Bracketed paste mode
  bracketedPasteStart: "\u001b[200~",
  bracketedPasteEnd: "\u001b[201~",
}
