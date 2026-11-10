// Declaration-build shim: tsconfig.build maps @opentui/solid here so keymap
// can emit d.ts for its Solid entrypoint without importing framework sources.
import type { CliRenderer } from "@opentui/core"

export function useRenderer(): CliRenderer
