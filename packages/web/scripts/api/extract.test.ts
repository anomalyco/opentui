import { describe, expect, test } from "bun:test"
import { join, relative } from "node:path"

import { RELEASE_PACKAGES } from "../../../../scripts/npm-publish"
import { entryPoints, extractPackage, normalizeSignature } from "./extract"
import { packageVersionFor, readTar } from "./npm"
import { publishedExports } from "./source"

const fixture = join(import.meta.dirname, "fixtures", "package")

test("entry points are the exports subpaths with a types target", () => {
  const entries = entryPoints(fixture).map((entry) => [entry.module, relative(fixture, entry.file)])
  expect(entries).toEqual([
    ["@fixture/pkg", "index.d.ts"],
    ["@fixture/pkg/extra", "extra.d.ts"],
    ["@fixture/pkg/jsx", "jsx.d.ts"],
  ])
})

test("extraction prints each exported declaration and its own members", () => {
  const { features, warnings } = extractPackage(fixture)
  expect(warnings).toEqual([])
  expect(features).toEqual([
    // A symbol exported by two entry points appears once per entry point. A private constructor is not API.
    "@fixture/pkg/extra: class Widget",
    // A bare `.d.ts` exports target is an entry point.
    "@fixture/pkg/jsx: function jsx(type: string): unknown",
    "@fixture/pkg: abstract class Abstract<T extends object = {}>",
    "@fixture/pkg: call Drawable(x: number): string",
    // Inherited members are recorded on the base class only.
    "@fixture/pkg: class Base extends EventEmitter",
    // `export { Widget as RenamedWidget }`
    "@fixture/pkg: class RenamedWidget",
    "@fixture/pkg: class Shape extends Base implements Drawable",
    "@fixture/pkg: const Geometry.Units.scale: number",
    '@fixture/pkg: const VERSION = "1.0.0"',
    // `export { default } from "./default.js"`
    "@fixture/pkg: const default: { name: string; }",
    "@fixture/pkg: construct Drawable(x: number): Drawable",
    "@fixture/pkg: constructor Shape(id: string)",
    // One line per overload; JSDoc @deprecated marks only its own overload.
    "@fixture/pkg: deprecated function area(radius: number): number",
    "@fixture/pkg: deprecated method Shape.old(): void",
    "@fixture/pkg: enum Color",
    '@fixture/pkg: enum-member Color.Blue = "blue"',
    "@fixture/pkg: enum-member Color.Red = 0",
    "@fixture/pkg: function Geometry.distance(a: number, b: number): number",
    // `import("./shapes.js").Shape` prints as `Shape`.
    "@fixture/pkg: function Inner.innerFunction(): Shape",
    "@fixture/pkg: function area(width: number, height: number): number",
    "@fixture/pkg: interface Drawable",
    "@fixture/pkg: let mutable: number",
    "@fixture/pkg: method Base.baseMethod(): void",
    "@fixture/pkg: method Drawable.draw(): void",
    "@fixture/pkg: method Shape.draw(): void",
    "@fixture/pkg: method Shape.overload(a: number): void",
    "@fixture/pkg: method Shape.overload(a: string): void",
    // A namespace export of another package records only the namespace.
    '@fixture/pkg: namespace External from "external-namespace"',
    "@fixture/pkg: namespace Geometry",
    "@fixture/pkg: namespace Geometry.Units",
    // A namespace export of a module in the package records its members.
    "@fixture/pkg: namespace Inner",
    // `export * as Self` inside Inner refers back to Inner and stops there.
    "@fixture/pkg: namespace Inner.Self",
    '@fixture/pkg: property Drawable."quoted-name"?: boolean',
    // Members of merged interface declarations, without comments and with collapsed whitespace.
    "@fixture/pkg: property Drawable.merged: { nested: string; other: number; }",
    // A getter with a setter is a writable property.
    "@fixture/pkg: property Shape.label: string",
    "@fixture/pkg: property Shape.optional?: boolean",
    "@fixture/pkg: protected abstract method Abstract.paint(target: T): void",
    "@fixture/pkg: protected method Shape.render(): void",
    // A protected `_` member is subclass API. Public `_`, private, #private, and @internal members are not.
    "@fixture/pkg: protected property Shape._subclassState: number",
    "@fixture/pkg: readonly index Drawable[index: number]: string",
    "@fixture/pkg: readonly property Shape.id: string",
    // A getter without a setter is readonly.
    "@fixture/pkg: readonly property Shape.size: number",
    '@fixture/pkg: reexport * from "external-star"',
    '@fixture/pkg: reexport externalThing from "external-named"',
    '@fixture/pkg: reexport renamedThing from "external-named" as original',
    "@fixture/pkg: static method Shape.create(): Shape",
    "@fixture/pkg: static readonly property Abstract.DEFAULT = 1",
    "@fixture/pkg: static readonly property Shape.count: number",
    "@fixture/pkg: type ColorInput = string | Color | Widget",
  ])
})

test("underscoreMembers keeps public members named with `_`", () => {
  const { features } = extractPackage(fixture, { underscoreMembers: true })
  expect(features.filter((line) => line.includes("._"))).toEqual([
    "@fixture/pkg: property Shape._hidden: string",
    "@fixture/pkg: protected property Shape._subclassState: number",
  ])
})

test.each([
  ["a:\n    string;", "a: string"],
  ["\"two  spaces\"  |  'a\tb'", "\"two  spaces\" | 'a\tb'"],
  ["`${number}  %`", "`${number}  %`"],
  ['import("./a.js").B<import("@opentui/core").C>', "B<C>"],
  ['typeof import("./yoga.js")', 'typeof import("./yoga.js")'],
])("normalizeSignature(%j)", (input, output) => expect(normalizeSignature(input)).toBe(output))

test.each([
  [["0.1.0", "0.2.0"], "0.2.0", "0.2.0"],
  // Skipped a release that came between two of its own: keep the previous features.
  [["0.1.0", "0.3.0"], "0.2.0", "0.1.0"],
  // Not published yet.
  [["0.3.0"], "0.2.0", undefined],
  // No longer published.
  [["0.1.0"], "0.2.0", undefined],
])("packageVersionFor(%j, %s)", (published, version, expected) => {
  expect(packageVersionFor(published, version)).toBe(expected)
})

test("readTar reads ustar prefixes and pax paths", () => {
  const block = (fields: Array<[number, string]>, size = 0): Uint8Array => {
    const header = new Uint8Array(512)
    for (const [offset, value] of fields) header.set(new TextEncoder().encode(value), offset)
    header.set(new TextEncoder().encode(size.toString(8).padStart(11, "0")), 124)
    return header
  }
  const data = (text: string): Uint8Array => {
    const bytes = new Uint8Array(Math.ceil(text.length / 512) * 512)
    bytes.set(new TextEncoder().encode(text))
    return bytes
  }
  const pax = "31 path=package/long/name.d.ts\n"
  const archive = new Uint8Array([
    ...block(
      [
        [0, "index.d.ts"],
        [156, "0"],
        [345, "package"],
      ],
      3,
    ),
    ...data("abc"),
    ...block(
      [
        [0, "PaxHeader"],
        [156, "x"],
      ],
      pax.length,
    ),
    ...data(pax),
    ...block(
      [
        [0, "short"],
        [156, "0"],
      ],
      1,
    ),
    ...data("z"),
    ...new Uint8Array(1024),
  ])
  const files = readTar(archive)
  expect([...files.keys()]).toEqual(["package/index.d.ts", "package/long/name.d.ts"])
  expect(new TextDecoder().decode(files.get("package/long/name.d.ts"))).toBe("z")
})

describe("published exports maps", () => {
  test.each(RELEASE_PACKAGES.map((releasePackage) => [releasePackage.name, releasePackage.rootDir]))(
    "%s build script names a types target for its main entry point",
    (_, rootDir) => {
      const exports = publishedExports(join(rootDir, "scripts", "build.ts"))
      expect(JSON.stringify(exports["."])).toContain('"types":"./')
    },
  )

  test("reads an inline exports map", () => {
    const ssh = RELEASE_PACKAGES.find((releasePackage) => releasePackage.name === "@opentui/ssh")!
    expect(publishedExports(join(ssh.rootDir, "scripts", "build.ts"))).toEqual({
      ".": { types: "./src/index.d.ts", import: "./index.js" },
    })
  })
})
