#!/usr/bin/env bun
// TypeScript branch coverage from the engine's block coverage (Bun/JSC), no AST rewriting.
//
//   bun scripts/branch-cov.ts                        # source files changed in main...HEAD
//   bun scripts/branch-cov.ts --diff <git range>
//   bun scripts/branch-cov.ts --files src/renderer.ts src/NativeScene.ts
//   bun scripts/branch-cov.ts --tests <test files>   # default: the whole core suite
//   bun scripts/branch-cov.ts --json <path>          # also write the per-arm table as JSON
//
// Runs `bun test` with scripts/branch-cov-preload.ts, which records
// `Profiler.takePreciseCoverage` (block-level ranges with execution counts). The offsets are into
// the JavaScript Bun ran; `Bun.Transpiler` reproduces that text byte for byte, and
// branch-cov-map.ts aligns its tokens with the TypeScript source. Every byte whose innermost range
// has count 0 is code no test executed; each maximal run is reported once as UNCOVERED
// `file:line:col`. These are the branch arms: `if`/`else`, `?:`, `&&`, `||`, `??`, `case`,
// `catch`, early `return`, and never-called functions.
//
// Exit code 0; the agent decides what to do with each arm (delete, assert, or cover).
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildMapper } from "./branch-cov-map"

const coreDir = path.resolve(import.meta.dir, "..")
const repoRoot = path.resolve(coreDir, "../..")
const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1]
}
const many = (name: string) => {
  const out: string[] = []
  for (let i = 0; i < args.length; i++)
    if (args[i] === name) while (args[i + 1] && !args[i + 1].startsWith("--")) out.push(args[++i])
  return out
}
const explicit = many("--files")
const tests = many("--tests")
const diffRange = opt("--diff") ?? "main...HEAD"
const jsonOut = opt("--json")

// 1. Scope: absolute paths of source files.
let scope: string[]
if (explicit.length) scope = explicit.map((f) => path.resolve(f))
else {
  const r = spawnSync("git", ["diff", "--name-only", diffRange, "--", "packages/core/src"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  scope = r.stdout
    .split("\n")
    .filter(
      (f) =>
        /\.tsx?$/.test(f) &&
        !/\.test\.tsx?$/.test(f) &&
        !/\/tests?\//.test(f) &&
        !/\/testing\//.test(f) &&
        !/\.d\.ts$/.test(f),
    )
    .map((f) => path.join(repoRoot, f))
}
if (scope.length === 0) {
  console.log("branch-cov: no core source files in scope")
  process.exit(0)
}

// 2. Run the tests with the preload.
const tmp = mkdtempSync(path.join(tmpdir(), "ot-branch-cov-"))
const covFile = path.join(tmp, "cov.json")
const r = spawnSync(
  "bun",
  ["test", "--preload", "./scripts/branch-cov-preload.ts", "--path-ignore-patterns=src/zig/zig-pkg/**", ...tests],
  {
    cwd: coreDir,
    encoding: "utf8",
    maxBuffer: 1 << 30,
    env: { ...process.env, OT_BRANCH_COV: covFile, CI: "true" },
  },
)
const summary = r.stderr
  .split("\n")
  .filter((l) => /^\s*\d+ (pass|fail|skip)/.test(l))
  .map((l) => l.trim())
  .join(" | ")
if (r.status !== 0) {
  process.stderr.write(r.stderr.slice(-4000))
  console.error("branch-cov: bun test failed; coverage below is for the tests that ran")
}
type Range = { startOffset: number; endOffset: number; count: number }
type Fn = { functionName: string; ranges: Range[]; isBlockCoverage: boolean }
type Script = { url: string; functions: Fn[] }
const scripts: Script[] = JSON.parse(readFileSync(covFile, "utf8"))
const scopeSet = new Set(scope)
rmSync(tmp, { recursive: true, force: true })

// 3. Line table for the TS source.
function lineStartsOf(text: string) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}
function offsetToLineCol(starts: number[], off: number) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= off) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, col: off - starts[lo] + 1 }
}

// 4. Walk zero-count ranges and map them.
type Arm = { file: string; line: number; col: number; fn: string; text: string }
const arms: Arm[] = []
const perFile = new Map<string, { arms: number; missed: Arm[] }>()
const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" })
for (const script of scripts) {
  const file = decodeURIComponent(script.url.replace("file://", ""))
  if (!scopeSet.has(file)) continue
  const tsSource = readFileSync(file, "utf8")
  const tsLines = tsSource.split("\n")
  const js = transpiler.transformSync(tsSource)
  const top = script.functions[0]?.ranges[0]
  if (top && top.endOffset !== js.length)
    console.error(
      `branch-cov: ${path.relative(repoRoot, file)}: runtime script length ${top.endOffset} != transpiled ${js.length}; positions may drift`,
    )
  const rec = { js }
  const mapOffset = buildMapper(tsSource, js)
  const tsStarts = lineStartsOf(tsSource)
  const toOriginal = (off: number) => {
    const o = mapOffset(off)
    return o === null ? null : offsetToLineCol(tsStarts, o)
  }
  const stat = perFile.get(file) ?? perFile.set(file, { arms: 0, missed: [] }).get(file)!
  const rel = path.relative(repoRoot, file)
  // Block coverage is nested: a range's count applies to its bytes except where a nested range
  // overrides it (innermost wins), so a zero-count range is "uncovered" only on the bytes that no
  // positive-count nested range covers. Resolve the effective count per byte, then report each
  // maximal zero-count run as one arm.
  const all: Range[] = []
  for (const fn of script.functions) if (fn.isBlockCoverage) all.push(...fn.ranges)
  const effective = new Int32Array(rec.js.length).fill(-1)
  // Larger ranges first, so smaller (inner) ranges overwrite.
  all.sort((a, b) => b.endOffset - b.startOffset - (a.endOffset - a.startOffset))
  for (const r of all) effective.fill(r.count, r.startOffset, Math.min(r.endOffset, rec.js.length))
  stat.arms = all.filter((r) => r.count >= 0).length
  let i = 0
  while (i < effective.length) {
    if (effective[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < effective.length && effective[j] === 0) j++
    let start = i
    while (start < j && /[\s{}();,]/.test(rec.js[start])) start++
    if (start < j) {
      const o = toOriginal(start)
      // Top-level `import` lines show up as zero-count ranges in JSC (module linking runs them,
      // not the profiler); they are not branches.
      if (o && !/^\s*(import|export \{|export \*)\b/.test(tsLines[o.line - 1] ?? "")) {
        const text = (tsLines[o.line - 1] ?? "").trim().slice(0, 90)
        const arm = { file: rel, line: o.line, col: o.col, fn: "", text }
        stat.missed.push(arm)
        arms.push(arm)
      }
    }
    i = j
  }
}

// 5. Report.
let totalArms = 0
for (const [file, stat] of [...perFile.entries()].sort()) {
  const rel = path.relative(repoRoot, file)
  totalArms += stat.arms
  // Several engine ranges can start on the same TS position (e.g. `a && b` and its `&&`); dedupe.
  // Several engine ranges can start on one TS line (e.g. `a && b` and its `&&`); report a line once.
  const seen = new Set<number>()
  const missed = stat.missed
    .sort((a, b) => a.line - b.line || a.col - b.col)
    .filter((m) => !seen.has(m.line) && seen.add(m.line))
  console.log(`\n${rel}: ${stat.arms - stat.missed.length}/${stat.arms} arms reached`)
  for (const m of missed) console.log(`  UNCOVERED ${rel}:${m.line}:${m.col}  ${m.text}`)
}
for (const f of scope) if (!perFile.has(f)) console.log(`\n${path.relative(repoRoot, f)}: not loaded by any test`)
console.log(`\n${summary}`)
console.log(
  `branch-cov: ${totalArms - arms.length}/${totalArms} arms reached in ${perFile.size} file(s); ${arms.length} uncovered`,
)
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(arms, null, 2))
