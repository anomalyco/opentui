import { describe, expect, test } from "bun:test"
import { transformSolidSource } from "../scripts/solid-transform.js"

// Each module-specifier form the transform rewrites, and forms it leaves alone.
const cases: [file: string, source: string, expected: string][] = [
  [
    "a.js",
    'import a from "m"; export * from "m"; export { b } from "m"',
    'import a from "m!"; export * from "m!"; export { b } from "m!"',
  ],
  [
    "a.js",
    'require("m"); import("m"); require.resolve("m"); System.import("m"); jest.mock("m")',
    'require("m!"); import("m!"); require.resolve("m!"); System.import("m!"); jest.mock("m!")',
  ],
  [
    "a.js",
    'require.requireActual("m"); require.requireMock("m"); jest.genMockFromModule("m"); jest.unmock("m"); jest.doMock("m"); jest.dontMock("m"); jest.setMock("m"); jest.requireActual("m"); jest.requireMock("m")',
    'require.requireActual("m!"); require.requireMock("m!"); jest.genMockFromModule("m!"); jest.unmock("m!"); jest.doMock("m!"); jest.dontMock("m!"); jest.setMock("m!"); jest.requireActual("m!"); jest.requireMock("m!")',
  ],
  [
    "a.ts",
    'import("m" as const); require("m" satisfies string); require.resolve("m"!); require(<string>"m"); require(("m")); require!("m"!)',
    'import("m"); require("m"); require.resolve("m"); require("m"); require("m!"); require("m!")',
  ],
  ["a.tsx", 'export const A = () => <box>{require("m" as string)}</box>', 'require("m!")'],
  [
    "a.js",
    'require(x); require(`m`); a.require("m"); require?.("m"); require()',
    'require(x); require(`m`); a.require("m"); require?.("m"); require()',
  ],
  ["a.ts", 'import type { T } from "m"; import { v } from "m"; v', 'import { v } from "m!"; v'],
  ["a.tsx", 'export const A = () => <box>{require("m")}</box>', 'require("m!")'],
  ["a.tsx", "export const A = () => <text>hi</text>", 'from "@opentui/solid!"'],
]

describe("transformSolidSource resolvePath", () => {
  test.each(cases)("%s %s", async (file, source, expected) => {
    const output = await transformSolidSource(source, {
      filename: file,
      resolvePath: (s) => (s === "x" ? null : s + "!"),
    })
    expect(output.replace(/;?\n/g, "; ").replace(/; $/, "")).toContain(expected)
  })
})
