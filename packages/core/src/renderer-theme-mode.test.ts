import { expect, test } from "bun:test"
import { SystemClock } from "./lib/clock.js"
import { RendererThemeMode } from "./renderer-theme-mode.js"
import conformance from "./theme-mode.conformance.json" with { type: "json" }

// The Rust crate's theme.rs runs the same rows.
test.each(conformance.rows)("%s", (_name, reply, mode) => {
  const themeMode = new RendererThemeMode({ queryThemeColors: () => false }, new SystemClock())
  themeMode.handleSequence(reply)
  expect(themeMode.themeMode).toBe(mode)
})
