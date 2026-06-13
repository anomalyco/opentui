import type { CliRenderer } from "../renderer.js"
import type { TerminalCapabilities, TerminalInfo } from "../types.js"

export interface TerminalCapabilitiesOverrides extends Partial<Omit<TerminalCapabilities, "terminal">> {
  terminal?: Partial<TerminalInfo>
}

export function createTerminalCapabilities(overrides: TerminalCapabilitiesOverrides = {}): TerminalCapabilities {
  return {
    kitty_keyboard: false,
    kitty_graphics: false,
    rgb: false,
    ansi256: false,
    unicode: "unicode",
    sgr_pixels: false,
    color_scheme_updates: false,
    explicit_width: false,
    scaled_text: false,
    sixel: false,
    focus_tracking: false,
    sync: false,
    bracketed_paste: false,
    hyperlinks: false,
    osc52: false,
    notifications: false,
    explicit_cursor_positioning: false,
    remote: false,
    multiplexer: "none",
    ...overrides,
    terminal: {
      name: "",
      version: "",
      from_xtversion: false,
      ...overrides.terminal,
    },
  }
}

export function setRendererCapabilities(
  renderer: CliRenderer,
  overrides: TerminalCapabilitiesOverrides = {},
): TerminalCapabilities {
  const capabilities = createTerminalCapabilities(overrides)
  ;(renderer as unknown as { _capabilities: TerminalCapabilities })._capabilities = capabilities
  return capabilities
}
