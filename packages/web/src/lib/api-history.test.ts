import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ApiHistory,
  checkApiFiles,
  compareVersions,
  diffFeatures,
  featureKey,
  formatApiFile,
  formatFeature,
  isApiVersion,
  loadApiHistory,
  parseApiFile,
  parseFeature,
  type ApiKeyHistory,
} from "./api-history"

const M = "@opentui/core"

describe("parseFeature", () => {
  const cases: Array<[string, string[], string, string, string]> = [
    [`${M}: class CliRenderer extends EventEmitter`, [], "class", "CliRenderer", " extends EventEmitter"],
    [`${M}: method CliRenderer.suspend(): Promise<void>`, [], "method", "CliRenderer.suspend", "(): Promise<void>"],
    [
      `${M}: readonly property CliRenderer.isDestroyed: boolean`,
      ["readonly"],
      "property",
      "CliRenderer.isDestroyed",
      ": boolean",
    ],
    [
      `${M}: property CliRendererConfig.exitOnCtrlC?: boolean`,
      [],
      "property",
      "CliRendererConfig.exitOnCtrlC",
      "?: boolean",
    ],
    [`${M}: type ColorInput = string | RGBA`, [], "type", "ColorInput", " = string | RGBA"],
    [`${M}: function f<T extends X = Y>(a: T): void`, [], "function", "f", "<T extends X = Y>(a: T): void"],
    [
      `${M}: deprecated static protected abstract readonly property A.b: number`,
      ["deprecated", "static", "protected", "abstract", "readonly"],
      "property",
      "A.b",
      ": number",
    ],
    [`${M}: enum-member Color.Red = 0`, [], "enum-member", "Color.Red", " = 0"],
    [`${M}: namespace Yoga`, [], "namespace", "Yoga", ""],
    [`@opentui/three: namespace THREE from "three"`, [], "namespace", "THREE", ' from "three"'],
    [
      `${M}: method Yoga.Node.create(config?: Config): Node`,
      [],
      "method",
      "Yoga.Node.create",
      "(config?: Config): Node",
    ],
    [`${M}: constructor Box(ctx: RenderContext)`, [], "constructor", "Box", "(ctx: RenderContext)"],
    [
      `${M}: readonly index Drawable[index: number]: string`,
      ["readonly"],
      "index",
      "Drawable",
      "[index: number]: string",
    ],
    [`${M}: call Drawable(x: number): string`, [], "call", "Drawable", "(x: number): string"],
    [`${M}: property Components."qr-code": typeof QR`, [], "property", 'Components."qr-code"', ": typeof QR"],
    [
      `${M}: method List.[Symbol.iterator](): Iterator<"]">`,
      [],
      "method",
      "List.[Symbol.iterator]",
      '(): Iterator<"]">',
    ],
    [`@opentui/react: reexport * from "react"`, [], "reexport", "*", ' from "react"'],
    [`@opentui/react: reexport jsx from "react/jsx-runtime"`, [], "reexport", "jsx", ' from "react/jsx-runtime"'],
    [`${M}: const default: { name: string; }`, [], "const", "default", ": { name: string; }"],
    [`${M}: property $state.$value: number`, [], "property", "$state.$value", ": number"],
  ]
  test.each(cases)("%s", (line, modifiers, kind, name, signature) => {
    const feature = parseFeature(line)
    expect(feature).toEqual({ line, module: line.slice(0, line.indexOf(": ")), modifiers, kind, name, signature })
    expect(formatFeature(feature)).toBe(line)
    expect(featureKey(feature)).toBe(`${feature.module}: ${kind} ${name}`)
  })

  test.each([`${M} class A`, `${M}: class`, `${M}: widget A`, `${M}: class (): void`, `${M}: property A."b: c`])(
    "rejects %s",
    (line) => expect(() => parseFeature(line)).toThrow(),
  )
})

test("compareVersions orders x.y.z numerically and rejects other versions", () => {
  const versions = ["0.10.0", "0.2.10", "0.2.9", "1.0.0", "0.2.9"]
  expect(versions.sort(compareVersions)).toEqual(["0.2.9", "0.2.9", "0.2.10", "0.10.0", "1.0.0"])
  expect(() => compareVersions("0.0.0-20261004-7dad729e", "0.1.0")).toThrow()
  expect(isApiVersion("0.5.17")).toBe(true)
  expect(isApiVersion("0.5.17-dry")).toBe(false)
})

test("diffFeatures returns sorted additions and removals", () => {
  expect(diffFeatures([`${M}: const b: 1`, `${M}: const a: 1`], [`${M}: const c: 1`, `${M}: const a: 1`])).toEqual({
    added: [`${M}: const c: 1`],
    removed: [`${M}: const b: 1`],
  })
})

describe("API files", () => {
  const text = [
    "base 0.5.16",
    // Keys ignore modifiers, so `static method CliRenderer.create` sorts as `method CliRenderer.create`.
    `+ ${M}: static method CliRenderer.create(): CliRenderer`,
    `- ${M}: method CliRenderer.dumpBuffers(timestamp?: number): void`,
    `- ${M}: method CliRenderer.suspend(): void`,
    `+ ${M}: method CliRenderer.suspend(): Promise<void>`,
    "",
  ].join("\n")

  test("parse and format round trip", () => {
    const release = parseApiFile("0.5.17", text)
    expect(release).toEqual({
      version: "0.5.17",
      base: "0.5.16",
      added: [
        `${M}: static method CliRenderer.create(): CliRenderer`,
        `${M}: method CliRenderer.suspend(): Promise<void>`,
      ],
      removed: [
        `${M}: method CliRenderer.dumpBuffers(timestamp?: number): void`,
        `${M}: method CliRenderer.suspend(): void`,
      ],
    })
    expect(formatApiFile(release)).toBe(text)
    expect(
      formatApiFile({ ...release, added: [...release.added].reverse(), removed: [...release.removed].reverse() }),
    ).toBe(text)
  })

  test("a file without changes holds only the header", () => {
    expect(formatApiFile({ version: "0.1.0", base: null, added: [], removed: [] })).toBe("base none\n")
    expect(parseApiFile("0.1.0", "base none\n")).toEqual({ version: "0.1.0", base: null, added: [], removed: [] })
  })

  test.each([
    ["", "first line"],
    ["base latest\n", "first line"],
    [`base none\n${M}: const a: 1\n`, "expected"],
    [`base none\n+ ${M}: bogus a\n`, "Unknown API kind"],
  ])("rejects %j", (body, message) => expect(() => parseApiFile("0.1.0", body)).toThrow(message))
})

// A history with a maintenance release: 0.2.1 was published after 0.3.0, relative to 0.2.0.
const files = [
  { version: "0.1.0", text: `base none\n+ ${M}: const keep: 1\n+ ${M}: function f(): void\n+ ${M}: const gone: 1\n` },
  { version: "0.2.0", text: `base 0.1.0\n- ${M}: function f(): void\n+ ${M}: function f(): Promise<void>\n` },
  {
    version: "0.3.0",
    text: `base 0.2.0\n- ${M}: const gone: 1\n+ ${M}: deprecated const keep: 1\n- ${M}: const keep: 1\n`,
  },
  { version: "0.2.1", text: `base 0.2.0\n+ ${M}: const backport: 1\n` },
  { version: "0.3.1", text: `base 0.3.0\n+ ${M}: const gone: 2\n` },
].map((file) => ({ ...file, text: formatApiFile(parseApiFile(file.version, file.text)) }))

describe("ApiHistory", () => {
  const history = ApiHistory.fromFiles(files)

  test("versions ascend and snapshots replay the base chain", () => {
    expect(history.versions).toEqual(["0.1.0", "0.2.0", "0.2.1", "0.3.0", "0.3.1"])
    expect(history.latest).toBe("0.3.1")
    expect([...history.snapshot("0.2.1")].sort()).toEqual([
      `${M}: const backport: 1`,
      `${M}: const gone: 1`,
      `${M}: const keep: 1`,
      `${M}: function f(): Promise<void>`,
    ])
    expect([...history.snapshot("0.3.0")].sort()).toEqual([
      `${M}: deprecated const keep: 1`,
      `${M}: function f(): Promise<void>`,
    ])
  })

  test("changes group lines by key", () => {
    expect(
      history.changes("0.3.0").map(({ key, type, before, after }) => [key, type, before.length, after.length]),
    ).toEqual([
      [`${M}: const gone`, "removed", 1, 0],
      [`${M}: const keep`, "deprecated", 1, 1],
    ])
    expect(history.changes("0.2.0").map((change) => [change.name, change.type])).toEqual([["f", "changed"]])
    expect(history.changes("0.2.1").map((change) => [change.kind, change.name, change.type])).toEqual([
      ["const", "backport", "added"],
    ])
    expect(history.changes("0.1.0").every((change) => change.type === "added")).toBe(true)
  })

  test("keyHistory records since, changes, deprecation, removal, and re-addition", () => {
    const keys = history.keyHistory()
    expect(keys.get(`${M}: function f`)).toEqual({ key: `${M}: function f`, since: "0.1.0", changedIn: ["0.2.0"] })
    expect(keys.get(`${M}: const keep`)).toEqual({
      key: `${M}: const keep`,
      since: "0.1.0",
      changedIn: [],
      deprecatedIn: "0.3.0",
    })
    // The maintenance release is older than 0.3.0, which does not contain the backport.
    expect(keys.get(`${M}: const backport`)).toMatchObject({ since: "0.2.1", removedIn: "0.3.0" })
    expect(keys.get(`${M}: const gone`)).toEqual({ key: `${M}: const gone`, since: "0.1.0", changedIn: [] })
    const upTo = history.keyHistory("0.3.0")
    expect(upTo.get(`${M}: const gone`)).toMatchObject({ since: "0.1.0", removedIn: "0.3.0" })
    expect(history.keyHistory("0.2.0").get(`${M}: const keep`)?.deprecatedIn).toBeUndefined()
  })

  test("unknown versions and broken chains throw", () => {
    expect(() => history.snapshot("9.9.9")).toThrow("No API file")
    expect(() => ApiHistory.fromFiles([{ version: "0.1.0", text: "base 0.0.9\n" }])).toThrow("No API file for 0.0.9")
    expect(() =>
      ApiHistory.fromFiles([
        { version: "0.1.0", text: "base 0.2.0\n" },
        { version: "0.2.0", text: "base 0.1.0\n" },
      ]),
    ).toThrow("cycle")
  })
})

// The reference walks every snapshot in version order. keyHistory must agree with it while it keeps only
// the states that later versions use as a base.
function referenceKeyHistory(history: ApiHistory, upTo?: string): Map<string, ApiKeyHistory> {
  const result = new Map<string, ApiKeyHistory>()
  let previous = new Map<string, string[]>()
  const deprecated = (lines: string[]) => lines.every((line) => parseFeature(line).modifiers[0] === "deprecated")
  for (const version of history.versions.filter((v) => upTo === undefined || compareVersions(v, upTo) <= 0)) {
    const next = new Map<string, string[]>()
    for (const line of history.snapshot(version)) {
      const key = featureKey(parseFeature(line))
      next.set(key, [...(next.get(key) ?? []), line])
    }
    for (const key of new Set([...previous.keys(), ...next.keys()])) {
      const before = previous.get(key) ?? []
      const after = next.get(key) ?? []
      const entry = result.get(key)
      if (after.length === 0) {
        if (before.length > 0) entry!.removedIn = version
        continue
      }
      if (entry === undefined || before.length === 0) {
        const fresh = entry ?? { key, since: version, changedIn: [] }
        fresh.removedIn = undefined
        fresh.deprecatedIn = deprecated(after) ? version : undefined
        result.set(key, fresh)
        continue
      }
      const lost = before.filter((line) => !after.includes(line))
      const gained = after.filter((line) => !before.includes(line))
      if (lost.length + gained.length === 0) continue
      if (!deprecated(before) && deprecated(after)) entry.deprecatedIn = version
      if (deprecated(before) && !deprecated(after)) entry.deprecatedIn = undefined
      const onlyDeprecated =
        lost.length > 0 &&
        lost.length === gained.length &&
        lost.every((line) => {
          const feature = parseFeature(line)
          return (
            !feature.modifiers.includes("deprecated") &&
            gained.includes(formatFeature({ ...feature, modifiers: ["deprecated", ...feature.modifiers] }))
          )
        })
      if (!onlyDeprecated) entry.changedIn.push(version)
    }
    previous = next
  }
  return result
}

function normalized(map: Map<string, ApiKeyHistory>): ApiKeyHistory[] {
  return [...map.values()]
    .map((entry) => JSON.parse(JSON.stringify(entry)) as ApiKeyHistory)
    .sort((a, b) => (a.key < b.key ? -1 : 1))
}

test("keyHistory matches a snapshot-by-snapshot reference on random histories", () => {
  let seed = 7
  const random = (limit: number) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % limit
  }
  const pool = ["a", "b", "c", "d", "e"].flatMap((name) => [
    `${M}: const ${name}: 1`,
    `${M}: const ${name}: 2`,
    `${M}: deprecated const ${name}: 1`,
    `${M}: function ${name}(): void`,
    `${M}: function ${name}(x: number): void`,
  ])
  for (let round = 0; round < 40; round++) {
    const files: Array<{ version: string; text: string }> = []
    const snapshots = new Map<string, Set<string>>()
    const count = 2 + random(10)
    for (let index = 0; index < count; index++) {
      const version = `0.${index}.0`
      // Mostly linear, with some bases further back, as a maintenance release has.
      const base = index === 0 ? null : random(4) === 0 ? `0.${random(index)}.0` : `0.${index - 1}.0`
      const next = new Set(base === null ? [] : snapshots.get(base))
      for (let change = random(6); change > 0; change--) {
        const line = pool[random(pool.length)]!
        if (next.has(line)) next.delete(line)
        else next.add(line)
      }
      snapshots.set(version, next)
      const diff = diffFeatures(base === null ? [] : snapshots.get(base)!, next)
      files.push({ version, text: formatApiFile({ version, base, ...diff }) })
    }
    // Store the files out of order: a later version can be the base of an earlier one.
    const history = ApiHistory.fromFiles(files.reverse())
    expect(checkApiFiles(files)).toEqual([])
    for (const [version, snapshot] of snapshots)
      expect([...history.snapshot(version)].sort()).toEqual([...snapshot].sort())
    expect(normalized(history.keyHistory())).toEqual(normalized(referenceKeyHistory(history)))
    const upTo = `0.${random(count)}.0`
    expect(normalized(history.keyHistory(upTo))).toEqual(normalized(referenceKeyHistory(history, upTo)))
  }
})

describe("checkApiFiles", () => {
  test("accepts a valid history", () => expect(checkApiFiles(files)).toEqual([]))

  test.each([
    [
      "an unsorted file",
      { version: "0.4.0", text: `base 0.3.1\n+ ${M}: const z: 1\n+ ${M}: const a: 1\n` },
      "canonical order",
    ],
    ["an unknown base", { version: "0.4.0", text: "base 0.3.9\n" }, "base 0.3.9 has no API file"],
    [
      "a feature listed twice",
      { version: "0.4.0", text: `base 0.3.1\n+ ${M}: const a: 1\n+ ${M}: const a: 1\n` },
      "twice",
    ],
    [
      "an addition of a present feature",
      { version: "0.4.0", text: `base 0.3.1\n+ ${M}: const gone: 2\n` },
      "adds a present",
    ],
    [
      "a removal of a missing feature",
      { version: "0.4.0", text: `base 0.3.1\n- ${M}: const gone: 1\n` },
      "removes a missing",
    ],
    ["a bad file name", { version: "next", text: "base none\n" }, "not an x.y.z version"],
  ])("reports %s", (_, file, message) => {
    const problems = checkApiFiles([...files, file])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(message)
  })
})

test("loadApiHistory reads the version files of a directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "api-history-"))
  try {
    for (const file of files) await writeFile(join(dir, `${file.version}.txt`), file.text)
    await writeFile(join(dir, "README.md"), "not an API file")
    const history = await loadApiHistory(dir)
    expect(history.versions).toEqual(["0.1.0", "0.2.0", "0.2.1", "0.3.0", "0.3.1"])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
