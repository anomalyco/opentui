// Conformance vectors for the Kitty base-layout fallback, shared by Core's key-binding lookup and
// @opentui/keymap's registerBaseLayoutFallback(): (typed key, base-layout codepoint, modifiers) -> matched
// bindings, in lookup order. A typed key falls back when it is one non-ASCII character or its base key is a digit.
export const baseLayoutBindings = [..."-.0123456789=cdgqzㅎ"].map((key) => `ctrl+${key}`).concat("j", "l", "meta+a")

export const baseLayoutVectors = [
  ["ㅊ", 99, "ctrl", ["ctrl+c"]], // Korean
  ["с", 99, "ctrl", ["ctrl+c"]], // Russian
  ["ψ", 99, "ctrl", ["ctrl+c"]], // Greek
  ["ב", 99, "ctrl", ["ctrl+c"]], // Hebrew
  ["ؤ", 99, "ctrl", ["ctrl+c"]], // Arabic
  ["ß", 45, "ctrl", ["ctrl+-"]], // German: a Latin letter, but not ASCII
  ["&", 49, "ctrl", ["ctrl+1"]], // AZERTY digit row
  ["é", 50, "ctrl", ["ctrl+2"]],
  ['"', 51, "ctrl", ["ctrl+3"]],
  ["'", 52, "ctrl", ["ctrl+4"]],
  ["(", 53, "ctrl", ["ctrl+5"]],
  ["-", 54, "ctrl", ["ctrl+-", "ctrl+6"]],
  ["è", 55, "ctrl", ["ctrl+7"]],
  ["_", 56, "ctrl", ["ctrl+8"]],
  ["ç", 57, "ctrl", ["ctrl+9"]],
  ["à", 48, "ctrl", ["ctrl+0"]],
  ["/", 50, "ctrl", ["ctrl+2"]], // Thai digit row
  ["-", 51, "ctrl", ["ctrl+-", "ctrl+3"]],
  ["/", 57, "ctrl", ["ctrl+9"]], // Bépo digit row
  ["*", 48, "ctrl", ["ctrl+0"]],
  ["\u0080", 99, "ctrl", ["ctrl+c"]],
  ["~", 99, "ctrl", []],
  ["𠀀", 99, "ctrl", ["ctrl+c"]],
  ["ㅊ", 67, "ctrl", ["ctrl+c"]],
  ["ㅊ", undefined, "ctrl", []],
  ["ㅊ", 32, "ctrl", []],
  ["ㅎ", 103, "ctrl", ["ctrl+ㅎ", "ctrl+g"]],
  ["ㅓ", 106, "", ["j"]],
  ["ㅣ", 108, "", ["l"]],
  ["ф", 97, "meta", ["meta+a"]],
  ["j", 99, "ctrl", []], // Dvorak
  ["e", 100, "ctrl", []], // Dvorak
  [";", 122, "ctrl", []], // Dvorak
  ["v", 46, "ctrl", []], // Dvorak
  ["]", 61, "ctrl", []], // Dvorak
  ["s", 100, "ctrl", []], // Colemak
  ["h", 106, "", []],
  ["a", 113, "ctrl", []], // AZERTY
] as const

// Test name of a row; a control character such as U+0080 prints as an escape.
export function baseLayoutVectorName([name, baseCode, modifiers, matches]: (typeof baseLayoutVectors)[number]) {
  const typed = name.replace(/\p{Cc}/gu, (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, "0")}`)
  return `${typed}/${baseCode} ${modifiers} -> ${JSON.stringify(matches)}`
}
