import { resolveRenderLib } from "../zig.js"

type NativeSymbol = (...args: any[]) => any

export const nativeSymbols = (resolveRenderLib() as any).opentui.symbols as Record<string, NativeSymbol>

/** Replaces native symbols while `fn` runs and records each call's arguments by symbol name. */
export function withStubbedSymbols(
  replacements: Record<string, NativeSymbol>,
  fn: (calls: Record<string, any[][]>) => void,
): void {
  const originals = Object.keys(replacements).map((name) => [name, nativeSymbols[name]!] as const)
  const calls: Record<string, any[][]> = {}
  for (const [name, replacement] of Object.entries(replacements)) {
    const recorded: any[][] = (calls[name] = [])
    nativeSymbols[name] = (...args) => {
      recorded.push(args)
      return replacement(...args)
    }
  }
  try {
    fn(calls)
  } finally {
    for (const [name, original] of originals) nativeSymbols[name] = original
  }
}
