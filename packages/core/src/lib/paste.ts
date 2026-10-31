export type PasteKind = "text" | "binary" | "unknown"

export interface PasteMetadata {
  mimeType?: string
  kind?: PasteKind
}

const PASTE_TEXT_DECODER = new TextDecoder()

// ECMA-48 sequences in ESC and C1 form: a control sequence through its final byte, a control string (OSC, DCS, SOS,
// PM, APC) through BEL or ST, and any other escape through its final byte. A sequence also ends at the first
// character that cannot continue it, so a lone ESC and a cut-off sequence go too. Bun and Node share this policy.
const ANSI_SEQUENCES =
  /(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]?|(?:\x1b[P\]X^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)?|\x1b[\x20-\x2f]*[\x30-\x7e]?/g

export function decodePasteBytes(bytes: Uint8Array): string {
  return PASTE_TEXT_DECODER.decode(bytes)
}

export function stripAnsiSequences(text: string): string {
  return text.replace(ANSI_SEQUENCES, "")
}
