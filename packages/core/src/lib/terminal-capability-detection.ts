/**
 * Terminal capability response detection utilities.
 *
 * Detects various terminal capability response sequences:
 * - DECRPM (DEC Request Mode): ESC[?...;N$y where N is 0,1,2,3,4
 * - XTVersion: ESC P >| ... ESC \
 * - Kitty Graphics: ESC _ G ... ESC \
 * - Kitty Keyboard Query: ESC[?Nu where N is 0,1,2,etc
 * - DA1 (Device Attributes): ESC[?...c
 * - Pixel Resolution: ESC[4;height;widtht
 * - OSC 99 notification capability query response
 * - iTerm2 OSC 1337 feature-reporting response
 * - OSC 7501 program status query response
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

  // XTVersion: ESC P >| ... ESC \
  if (/\x1bP>\|[\s\S]*?\x1b\\/.test(sequence)) {
    return true
  }

  // XTGETTCAP Ms: consume replies to our query here; native parsing separately
  // validates whether a positive value is sufficient evidence of support.
  if (/\x1bP(?:1\+r4d73(?:=[^\x1b]*)?|0\+r(?:4d73)?)\x1b\\/i.test(sequence)) {
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

  // OSC 7501 program status query response: ESC ] 7501 ; ? [: pairs] ST
  if (/\x1b\]7501; *\?[^\x07\x1b]*(?:\x07|\x1b\\)/.test(sequence)) {
    return true
  }

  return false
}

/**
 * Check if a cursor position report answers the explicit width or scaled text probe: ESC[1;NR with N >= 2.
 * ESC[1;1R means the cursor did not move, so the terminal has no width support. Shift, Alt and Ctrl+F3 send the
 * same bytes, so only a report the parser classified as one may be checked.
 */
export function isExplicitWidthReport(sequence: string): boolean {
  return /\x1b\[1;(?!1R)\d+R/.test(sequence)
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
    const width = Number(match[2])
    const height = Number(match[1])
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width > 0x7fffffff || height > 0x7fffffff)
      return null
    return { width, height }
  }
  return null
}
