// Declaration-build shim: tsconfig.build maps @opentui/react here so keymap
// can emit d.ts for its React entrypoint without importing framework sources.
import type { CliRenderer } from "@opentui/core"

export function useRenderer(): CliRenderer
