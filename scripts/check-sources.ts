// Checks copies of build facts and package notices against their owners.
// Usage: bun scripts/check-sources.ts [<repository root>]

import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import process from "node:process"
import { variantName, variants, zigOutputName } from "../packages/core/scripts/variants"
import { NODE26_MIN_VERSION } from "./node26.mjs"

const root = resolve(process.argv[2] ?? join(import.meta.dirname, ".."))
const problems = new Set<string>()
const read = (file: string) => readFileSync(join(root, file), "utf8")
const json = (file: string) => JSON.parse(read(file))

// Each match of `pattern` (its first group) in `file` must be `expected`, and there must be at least one.
function expectAll(file: string, pattern: RegExp, expected: string, owner: string): void {
  const found = [...read(file).matchAll(pattern)].map((match) => match[1])
  if (found.length === 0) problems.add(`${file}: no ${pattern} (expected ${expected}, from ${owner})`)
  for (const value of found) {
    if (value !== expected) problems.add(`${file}: ${value}, expected ${expected} from ${owner}`)
  }
}

// The targets that `file` names (each match's first group, else the match) must be `expected` (all: true) or some
// of them.
function expectTargets(
  file: string,
  pattern: RegExp,
  expected: Set<string>,
  all: boolean,
  normalize = (name: string) => name,
): void {
  const found = new Set([...read(file).matchAll(pattern)].map((match) => normalize(match[1] ?? match[0])))
  for (const name of found) if (!expected.has(name)) problems.add(`${file}: ${name} is not a target of variants.ts`)
  if (all) for (const name of expected) if (!found.has(name)) problems.add(`${file}: missing target ${name}`)
}

// Versions. Owners: core's package.json version, build.zig.zon's minimum_zig_version, the root packageManager,
// core's engines.bun, and scripts/node26.mjs. CI reads Bun from packageManager and Node from .node-version.
const zon = read("packages/native/build.zig.zon")
const coreVersion = json("packages/core/package.json").version
const zigVersion = zon.match(/\.minimum_zig_version = "([^"]+)"/)![1]!
const bunVersion = json("package.json").packageManager.replace(/^bun@/, "")
const bunMinimum = json("packages/core/package.json").engines.bun
const nodeMinimum = `>=${NODE26_MIN_VERSION.replace(/^v/, "")}`
expectAll(
  "packages/native/build.zig.zon",
  /^ {4}\.version = "([^"]+)"/gm,
  coreVersion,
  "@opentui/core (prepare-release.ts)",
)
expectAll(
  "packages/native/examples/hello/build.zig.zon",
  /\.minimum_zig_version = "([^"]+)"/g,
  zigVersion,
  "build.zig.zon",
)
expectAll(".zig-version", /^(\S+)$/gm, zigVersion, "build.zig.zon")
expectAll("README.md", /\bZig (\d+\.\d+\.\d+)/g, zigVersion, "build.zig.zon")
expectAll("README.md", /\bBun (\d+\.\d+\.\d+) or later/g, bunVersion, "packageManager")
for (const page of ["native/c.mdx", "native/zig.mdx"]) {
  expectAll(`packages/web/src/content/docs/${page}`, /Use Zig `(\d+\.\d+\.\d+)`/g, zigVersion, "build.zig.zon")
}
expectAll(
  "packages/web/src/content/docs/test-and-debug/troubleshooting.mdx",
  /zig-local-(\d+\.\d+\.\d+)/g,
  zigVersion,
  "build.zig.zon",
)
expectAll(".github/workflows/build-core.yml", /bun-version: (\S+)/g, bunMinimum.replace(/^>=/, ""), "core engines.bun")
for (const name of readdirSync(join(root, "packages"))) {
  let manifest: { engines?: { bun?: string; node?: string } }
  try {
    manifest = json(`packages/${name}/package.json`)
  } catch {
    continue
  }
  const { bun, node } = manifest.engines ?? {}
  if (bun !== undefined && bun !== bunMinimum)
    problems.add(`packages/${name}/package.json: engines.bun ${bun}, expected ${bunMinimum} from @opentui/core`)
  if (node !== undefined && node !== nodeMinimum)
    problems.add(`packages/${name}/package.json: engines.node ${node}, expected ${nodeMinimum} from scripts/node26.mjs`)
}

// Native targets. Owner: packages/core/scripts/variants.ts. Directory names such as x86_64-linux-musl are
// build.zig's output names; package names such as linux-x64-musl are the npm packages' suffixes.
const zigNames = new Set(variants.map(zigOutputName))
const npmNames = new Set(variants.map(variantName))
const zigPattern = /\b(?:x86_64|aarch64)-(?:linux|macos|windows)(?:-musl)?\b/g
const npmPattern = /\b(?:darwin|linux|win32|windows)-(?:x64|arm64)(?:-[a-z0-9]+)?\b/g
const npm = (name: string) => name.replace(/^windows-/, "win32-")
expectTargets("packages/native/build.zig", /\.output_name = "([^"]+)"/g, zigNames, true)
expectTargets("packages/native/scripts/build-ffmpeg.ts", /\{ name: "([^"]+)"/g, zigNames, true)
expectTargets("packages/rust/crates/opentui-sys/build.rs", /\("[^"]+", "([^"]+)",/g, zigNames, true)
expectTargets("packages/rust/README.md", /\| `([^`]+)` +\|$/gm, zigNames, true)
for (const file of ["packages/rust/scripts/check-targets.sh", "packages/rust/run.sh", "packages/rust/test.sh"]) {
  expectTargets(file, zigPattern, zigNames, false)
}
for (const file of [
  "packages/core/src/platform/runtime-assets.bun.ts",
  "packages/web/src/content/docs/getting-started/runtime-support.mdx",
  "packages/web/src/content/docs/reference/api-index.mdx",
]) {
  expectTargets(file, /@opentui\/core-([a-z0-9-]+)/g, npmNames, true)
}
for (const file of [".github/workflows/build-native.yml", ".github/workflows/release.yml"]) {
  expectTargets(file, npmPattern, npmNames, true, npm)
}
// CI reads Bun and Node from their files (build-core.yml's minimum-Bun job aside), and FFmpeg's objects belong to
// one Zig version, so its cache keys hash .zig-version.
for (const dir of [
  ".github/workflows",
  ...readdirSync(join(root, ".github/actions")).map((name) => `.github/actions/${name}`),
]) {
  for (const name of readdirSync(join(root, dir)).filter((name) => name.endsWith(".yml"))) {
    const file = `${dir}/${name}`
    expectTargets(file, npmPattern, npmNames, false, npm)
    const text = read(file)
    if (/^\s*node-version:/m.test(text))
      problems.add(`${file}: node-version, expected node-version-file: .node-version`)
    if (/^\s*bun-version:/m.test(text) && file !== ".github/workflows/build-core.yml")
      problems.add(`${file}: bun-version, expected bun-version-file: package.json`)
    for (const key of text.match(/key: ffmpeg-.*/g) ?? [])
      if (!key.includes("'.zig-version'")) problems.add(`${file}: FFmpeg cache key without .zig-version: ${key}`)
  }
}
const optional = Object.keys(json("packages/core/package.json").optionalDependencies ?? {})
const packages = new Set([...npmNames].map((name) => `@opentui/core-${name}`))
if (optional.length !== packages.size || !optional.every((name) => packages.has(name))) {
  problems.add(
    `packages/core/package.json: optionalDependencies ${optional.join(", ")}, expected ${[...packages].join(", ")}`,
  )
}

for (const [name, source] of Object.entries({
  "LICENSE-FFMPEG": "COPYING.LGPLv2.1",
  "FFMPEG-SOURCE.md": "README.md",
  "LICENSE-ZLIB": "LICENSE-ZLIB",
})) {
  const copy = `packages/rust/crates/opentui-sys/${name}`
  const owner = `packages/native/src/vendor/ffmpeg/${source}`
  if (!readFileSync(join(root, copy)).equals(readFileSync(join(root, owner)))) {
    problems.add(`${copy}: differs from ${owner}`)
  }
}

for (const problem of problems) console.error(problem)
if (problems.size > 0) {
  console.error(`${problems.size} copies disagree with their owner`)
  process.exit(1)
}
console.log("Every checked copy agrees with its owner")
