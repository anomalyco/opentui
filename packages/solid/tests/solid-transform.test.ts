import { describe, expect, it } from "bun:test"
import { parseAsync } from "@babel/core"
import { transformSolidSource, type TransformSolidSourceOptions } from "../scripts/solid-transform.js"

describe("Solid source import resolution", () => {
  it("rewrites a literal require through the configured resolver", async () => {
    const output = await transformSolidSource('export const value = require("fixture");', {
      filename: "fixture.js",
      resolvePath: (specifier) => (specifier === "fixture" ? "runtime:fixture" : null),
    })
    expect(output).toBe('export const value = require("runtime:fixture");')
  })

  it("rewrites the established literal module-call forms", async () => {
    const output = await transformSolidSource(
      [
        'require.resolve("fixture");',
        'require["resolve"]("fixture");',
        'System.import("fixture");',
        'jest.genMockFromModule("fixture");',
        'jest.mock("fixture", () => ({}));',
        'jest.unmock("fixture");',
        'jest.doMock("fixture");',
        'jest.dontMock("fixture");',
        'jest.setMock("fixture", {});',
        'jest.requireActual("fixture");',
        'jest.requireMock("fixture");',
        'require.requireActual("fixture");',
        'require.requireMock("fixture");',
        'import("fixture");',
      ].join("\n"),
      {
        filename: "fixture.js",
        resolvePath: (specifier) => (specifier === "fixture" ? "runtime:fixture" : null),
      },
    )
    expect(output).toBe(
      [
        'require.resolve("runtime:fixture");',
        'require["resolve"]("runtime:fixture");',
        'System.import("runtime:fixture");',
        'jest.genMockFromModule("runtime:fixture");',
        'jest.mock("runtime:fixture", () => ({}));',
        'jest.unmock("runtime:fixture");',
        'jest.doMock("runtime:fixture");',
        'jest.dontMock("runtime:fixture");',
        'jest.setMock("runtime:fixture", {});',
        'jest.requireActual("runtime:fixture");',
        'jest.requireMock("runtime:fixture");',
        'require.requireActual("runtime:fixture");',
        'require.requireMock("runtime:fixture");',
        'import("runtime:fixture");',
      ].join("\n"),
    )
  })

  it("preserves the callback interface for imports and re-exports without recursive rewriting", async () => {
    const calls: { specifier: string; receiver: unknown; arity: number }[] = []
    const options: TransformSolidSourceOptions = {
      filename: "fixture.js",
      resolvePath(specifier) {
        calls.push({ specifier, receiver: this, arity: arguments.length })
        if (specifier === "fixture") return "runtime:fixture"
        if (specifier === "./relative?query#hash") return "../target.js?query#hash"
        return "must-not-resolve-the-output-again"
      },
    }
    const output = await transformSolidSource(
      [
        'import { value } from "fixture";',
        'import "fixture";',
        'export { next } from "./relative?query#hash";',
        'export * from "fixture";',
      ].join("\n"),
      options,
    )
    expect(output).toBe(
      [
        'import { value } from "runtime:fixture";',
        'import "runtime:fixture";',
        'export { next } from "../target.js?query#hash";',
        'export * from "runtime:fixture";',
      ].join("\n"),
    )
    expect(calls.map(({ specifier }) => specifier)).toEqual(["fixture", "fixture", "./relative?query#hash", "fixture"])
    expect(calls.every(({ receiver, arity }) => receiver === options && arity === 1)).toBe(true)
  })

  it("leaves nonliteral specifiers and unrelated call syntax outside the resolver", async () => {
    const calls: string[] = []
    const output = await transformSolidSource(
      [
        'const marker = "fixture";',
        'other("fixture");',
        'other.require("fixture");',
        'require.resolve.extra("fixture");',
        'require[method]("fixture");',
        "require(`fixture`);",
        "require(name);",
        "require();",
        'require?.("fixture");',
        'require.resolve?.("fixture");',
        "import(`fixture`);",
        "import(name);",
      ].join("\n"),
      {
        filename: "fixture.js",
        resolvePath(specifier) {
          calls.push(specifier)
          return "must-not-appear"
        },
      },
    )
    expect(calls).toEqual([])
    expect(output).not.toContain("must-not-appear")
    expect(output).toContain('const marker = "fixture";')
  })

  it("resolves Solid-generated runtime imports without resolving original imports twice", async () => {
    const calls: string[] = []
    const output = await transformSolidSource(
      'import { value } from "fixture"; export const View = () => <text>{value}</text>;',
      {
        filename: "fixture.tsx",
        resolvePath(specifier) {
          calls.push(specifier)
          if (specifier === "fixture") return "runtime:fixture"
          if (specifier === "@opentui/solid") return "runtime:solid"
          return "must-not-resolve-the-output-again"
        },
      },
    )
    expect(output).toContain('from "runtime:fixture"')
    expect(output).toContain('from "runtime:solid"')
    expect(output).not.toContain('from "@opentui/solid"')
    expect(output).not.toContain("must-not-resolve-the-output-again")
    expect(calls.filter((specifier) => specifier === "fixture")).toHaveLength(1)
    expect(calls.every((specifier) => specifier === "fixture" || specifier === "@opentui/solid")).toBe(true)
  })

  it("retains null and empty-result fallback while allowing an empty input specifier to be mapped", async () => {
    const calls: string[] = []
    const output = await transformSolidSource('import ""; import "unchanged"; import "empty-result";', {
      filename: "fixture.js",
      resolvePath(specifier) {
        calls.push(specifier)
        if (specifier === "") return "runtime:empty"
        if (specifier === "empty-result") return ""
        return null
      },
    })
    expect(output).toBe('import "runtime:empty";\nimport "unchanged";\nimport "empty-result";')
    expect(calls).toEqual(["", "unchanged", "empty-result"])
  })

  it("resolves type-only sources before TypeScript removes them", async () => {
    const calls: string[] = []
    const output = await transformSolidSource(
      'import type { Shape } from "types"; import { value } from "fixture"; export const result: number = value;',
      {
        filename: "fixture.ts?reload=1#source",
        resolvePath(specifier) {
          calls.push(specifier)
          if (specifier === "fixture") return "runtime:fixture"
          return null
        },
      },
    )
    expect(output).toBe('import { value } from "runtime:fixture";\nexport const result = value;')
    expect(calls).toEqual(["types", "fixture"])
  })

  it("emits resolver output as a single string literal rather than executable source", async () => {
    const replacement = 'runtime:";globalThis.compromised=true;//\n\u2028'
    const output = await transformSolidSource('import "fixture";', {
      filename: "fixture.js",
      resolvePath: () => replacement,
    })
    const parsed = await parseAsync(output, { configFile: false, babelrc: false })
    expect(parsed?.program.body).toHaveLength(1)
    expect(parsed?.program.body[0]).toMatchObject({
      type: "ImportDeclaration",
      source: { type: "StringLiteral", value: replacement },
    })
  })

  it("propagates a resolver error without affecting concurrent or subsequent transforms", async () => {
    const failed = transformSolidSource('import "fixture";', {
      filename: "failed.js",
      resolvePath() {
        throw new Error("resolver failed")
      },
    })
    const successful = transformSolidSource('import "fixture";', {
      filename: "successful.js",
      resolvePath: () => "runtime:successful",
    })
    await expect(failed).rejects.toThrow("resolver failed")
    expect(await successful).toBe('import "runtime:successful";')
    expect(
      await transformSolidSource('import "fixture";', {
        filename: "subsequent.js",
        resolvePath: () => "runtime:subsequent",
      }),
    ).toBe('import "runtime:subsequent";')
  })

  it("retains the established syntactic matching of parameter-shadowed module calls", async () => {
    const output = await transformSolidSource(
      'function load(require, jest) { return [require("fixture"), jest.mock("fixture")]; }',
      {
        filename: "fixture.js",
        resolvePath: () => "runtime:fixture",
      },
    )
    expect(output).toBe(
      'function load(require, jest) {\n  return [require("runtime:fixture"), jest.mock("runtime:fixture")];\n}',
    )
  })
})
