#!/usr/bin/env bun
// Native branch coverage from LLVM SanitizerCoverage edge counters, with no source rewriting.
//
//   bun scripts/branch-cov.ts                      # files changed in main...HEAD
//   bun scripts/branch-cov.ts --diff <git range>   # files changed in that range
//   bun scripts/branch-cov.ts --files src/scene.zig src/buffer.zig
//   bun scripts/branch-cov.ts --all                # every file under src/ (not vendor/tests/bench)
//   ... --filter <substring>                       # run only matching tests (zig -Dtest-filter)
//   ... --json <path>                              # also write the per-site table as JSON
//
// How it works:
//   1. `zig build test-cov` compiles src/test.zig with `fuzz = true` (LLVM emits one 8-bit counter
//      in `__sancov_cntrs` per basic block: every branch arm, error return and switch case gets its
//      own counter) and with src/cov_runner.zig as the test runner, which runs the tests and dumps
//      the counter bytes to `$OT_COV_OUT`.
//   2. `objdump -d` finds every instruction that references `__start___sancov_cntrs+<offset>`; the
//      instruction address is inside the basic block that owns the counter.
//   3. `llvm-symbolizer` maps those addresses to file:line:column, so a single-line
//      `if (x) return error.X;` reports its untaken arm separately.
//
// Output: per file, every arm with zero hits as `UNCOVERED file:line:col  function`, then totals.
// Exit code 0; the agent decides what to do with uncovered arms (delete, assert, or cover).
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const nativeDir = path.resolve(import.meta.dir, "..")
const repoRoot = path.resolve(nativeDir, "../..")
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

const all = args.includes("--all")
const explicit = many("--files")
const diffRange = opt("--diff") ?? "main...HEAD"
const filter = opt("--filter")
const jsonOut = opt("--json")
const binary = path.join(nativeDir, "zig-out/bin/test-cov")

function run(cmd: string, argv: string[], cwd = nativeDir, input?: string) {
  const r = spawnSync(cmd, argv, { cwd, encoding: "utf8", input, maxBuffer: 1 << 30 })
  if (r.status !== 0) {
    process.stderr.write(r.stdout + r.stderr)
    throw new Error(`${cmd} ${argv.join(" ")} failed (${r.status})`)
  }
  return r.stdout
}

// 1. Scope.
let scope: Set<string>
if (all) {
  scope = new Set(
    run("git", ["ls-files", "src"])
      .split("\n")
      .filter((f) => f.endsWith(".zig") && !/^src\/(vendor|tests|bench)\//.test(f) && f !== "src/cov_runner.zig"),
  )
} else if (explicit.length) {
  scope = new Set(explicit.map((f) => path.relative(nativeDir, path.resolve(f))))
} else {
  const changed = run("git", ["diff", "--name-only", diffRange, "--", "packages/native/src"], repoRoot)
  scope = new Set(
    changed
      .split("\n")
      .filter((f) => f.endsWith(".zig") && !/\/(vendor|tests|bench)\//.test(f))
      .map((f) => f.replace(/^packages\/native\//, "")),
  )
}
if (scope.size === 0) {
  console.log("branch-cov: no native source files in scope")
  process.exit(0)
}

// 2. Build and run the instrumented tests.
run("zig", ["build", "test-cov", ...(filter ? [`-Dcov-filter=${filter}`] : [])])
if (!existsSync(binary)) throw new Error(`missing ${binary}`)
const tmp = mkdtempSync(path.join(tmpdir(), "ot-branch-cov-"))
const covFile = path.join(tmp, "cov.bin")
const runResult = spawnSync(binary, [], {
  cwd: nativeDir,
  env: { ...process.env, OT_COV_OUT: covFile },
  stdio: ["ignore", "pipe", "pipe"],
})
const summary = (runResult.stderr.toString().trim().split("\n").pop() ?? "").trim()
if (runResult.status !== 0) {
  process.stderr.write(runResult.stderr.toString())
  throw new Error("test-cov binary reported failures")
}
const dump = readFileSync(covFile)
rmSync(tmp, { recursive: true, force: true })
const headerEnd = dump.indexOf(0x0a)
const [, , countStr] = dump.subarray(0, headerEnd).toString().split(" ")
const counters = dump.subarray(headerEnd + 1, headerEnd + 1 + Number(countStr))

// 3. Counter offset -> instruction address, from the disassembly.
const disasm = run("objdump", ["-d", "--no-show-raw-insn", binary])
const ref = /^\s*([0-9a-f]+):\s+\S+.*<__start___sancov_cntrs(?:\+0x([0-9a-f]+))?>/
const siteAddr = new Map<number, number>()
for (const line of disasm.split("\n")) {
  const m = ref.exec(line)
  if (!m) continue
  const off = parseInt(m[2] ?? "0", 16)
  if (!siteAddr.has(off)) siteAddr.set(off, parseInt(m[1], 16))
}

// 4. Symbolize once.
const entries = [...siteAddr.entries()]
const symOut = run(
  "llvm-symbolizer",
  ["--no-inlines", "--output-style=JSON", "-e", binary],
  nativeDir,
  entries.map(([, a]) => "0x" + a.toString(16)).join("\n"),
)
const symLines = symOut.trim().split("\n")

type Site = { file: string; line: number; col: number; fn: string; hits: number }
const merged = new Map<string, Site>()
for (let i = 0; i < entries.length; i++) {
  const [off] = entries[i]
  const s = JSON.parse(symLines[i]).Symbol?.[0]
  if (!s?.FileName || s.Line === 0) continue
  const rel = path.isAbsolute(s.FileName) ? path.relative(nativeDir, s.FileName) : s.FileName
  if (!scope.has(rel)) continue
  // Generic instantiations (`foo__anon_123`) share one source site; merge them.
  const fn = String(s.FunctionName).replace(/__anon_\d+/g, "")
  const key = `${rel}:${s.Line}:${s.Column}:${fn}`
  const hits = counters[off] ?? 0
  const prev = merged.get(key)
  if (prev) prev.hits += hits
  else merged.set(key, { file: rel, line: s.Line, col: s.Column, fn, hits })
}

// 5. Report.
const byFile = new Map<string, Site[]>()
for (const s of merged.values()) (byFile.get(s.file) ?? byFile.set(s.file, []).get(s.file)!).push(s)
let totalArms = 0
let totalMissed = 0
for (const [file, list] of [...byFile.entries()].sort()) {
  list.sort((a, b) => a.line - b.line || a.col - b.col)
  const missed = list.filter((s) => s.hits === 0)
  totalArms += list.length
  totalMissed += missed.length
  console.log(`\n${file}: ${list.length - missed.length}/${list.length} arms reached`)
  for (const s of missed) console.log(`  UNCOVERED ${file}:${s.line}:${s.col}  ${s.fn}`)
}
for (const f of scope)
  if (!byFile.has(f)) console.log(`\n${f}: no instrumented code (not compiled into the test binary?)`)
console.log(`\n${summary}`)
console.log(
  `branch-cov: ${totalArms - totalMissed}/${totalArms} arms reached in ${byFile.size} file(s); ${totalMissed} uncovered`,
)
if (jsonOut) writeFileSync(jsonOut, JSON.stringify([...merged.values()], null, 2))
