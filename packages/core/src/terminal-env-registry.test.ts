import { expect, test } from "bun:test"

import { envRegistry, generateEnvMarkdown } from "./lib/env.js"
import "./zig.js"

test("native terminal environment registrations match native string semantics", () => {
  for (const name of ["OPENTUI_FORCE_WCWIDTH", "OPENTUI_FORCE_UNICODE", "OPENTUI_GRAPHICS", "OPENTUI_FORCE_NOZWJ"]) {
    expect(envRegistry[name]?.type).toBe("string")
    expect(envRegistry[name]?.default).toBeUndefined()
    expect(envRegistry[name]?.required).toBe(false)
  }

  const generated = generateEnvMarkdown()
  expect(generated).toContain("## OPENTUI_FORCE_WCWIDTH")
  expect(generated).toContain("**Default:** *unset*")
  expect(generated).toContain("Control Kitty and Sixel graphics detection")
})
