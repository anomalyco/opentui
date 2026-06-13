/**
 * Terminal capability response detection utilities.
 *
 * Detects various terminal capability response sequences:
 * - DECRPM (DEC Request Mode): ESC[?...;N$y where N is 0,1,2,3,4
 * - CPR (Cursor Position Report): ESC[row;colR (used for width detection)
 * - XTVersion: ESC P >| ... ESC \
 * - Kitty Graphics: ESC _ G ... ESC \
 * - Kitty Keyboard Query: ESC[?Nu where N is 0,1,2,etc
 * - DA1 (Device Attributes): ESC[?...c
 * - Pixel Resolution: ESC[4;height;widtht
 * - OSC 99 notification capability query response
 * - iTerm2 OSC 1337 feature-reporting response
 */

/**
 * Check if a sequence is a terminal capability response.
 * Returns true if the sequence matches any known capability response pattern.
 */
export function isCapabilityResponse(sequence: string): boolean {
  // DECRPM: ESC[?digits;digits$y
  if (/\x1b\[\?\d+(?:;\d+)*\$y/.test(sequence)) {
    return true
  }

  // CPR for explicit width/scaled text detection: ESC[1;NR where N >= 2
  // The column number tells us how many characters were rendered with width annotations
  // ESC[1;1R means no width support (cursor didn't move)
  // ESC[1;2R or higher means width support (cursor moved after rendering)
  // We accept any column >= 2 to handle cases where cursor wasn't at exact home position
  if (/\x1b\[1;(?!1R)\d+R/.test(sequence)) {
    return true
  }

  // XTVersion: ESC P >| ... ESC \
  if (/\x1bP>\|[\s\S]*?\x1b\\/.test(sequence)) {
    return true
  }

  // Kitty graphics response: ESC _ G ... ESC \
  // Matches any graphics response including OK, errors, etc.
  // This is for filtering capability responses from user input
  if (/\x1b_G[\s\S]*?\x1b\\/.test(sequence)) {
    return true
  }

  // Kitty keyboard query response: ESC[?Nu or ESC[?N;Mu (progressive enhancement)
  if (/\x1b\[\?\d+(?:;\d+)?u/.test(sequence)) {
    return true
  }

  // DA1 (Device Attributes): ESC[?...c
  if (/\x1b\[\?[0-9;]*c/.test(sequence)) {
    return true
  }

  // Kitty desktop notification capability query response.
  if (/\x1b\]99;[^\x07\x1b]*i=opentui-notifications[^\x07\x1b]*p=\?[\s\S]*?(?:\x07|\x1b\\)/.test(sequence)) {
    return true
  }

  // iTerm2 feature reporting response. The native parser decides whether the
  // feature string contains the Notifications feature code.
  if (/\x1b\]1337;Capabilities=[\s\S]*?(?:\x07|\x1b\\)/.test(sequence)) {
    return true
  }

  return false
}

/**
 * Check if a sequence is a pixel resolution response.
 * Format: ESC[4;height;widtht
 */
export function isPixelResolutionResponse(sequence: string): boolean {
  return /\x1b\[4;\d+;\d+t/.test(sequence)
}

/**
 * Parse pixel resolution from response sequence.
 * Returns { width, height } or null if not a valid resolution response.
 */
export function parsePixelResolution(sequence: string): { width: number; height: number } | null {
  const match = sequence.match(/\x1b\[4;(\d+);(\d+)t/)
  if (match) {
    return {
      width: parseInt(match[2]),
      height: parseInt(match[1]),
    }
  }
  return null
}
