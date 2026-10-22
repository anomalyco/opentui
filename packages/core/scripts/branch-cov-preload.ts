// Branch coverage preload for `bun test`, using the engine's own block coverage (no AST rewriting).
//
//   OT_BRANCH_COV=<out.json> bun test --preload ./scripts/branch-cov-preload.ts [test files]
//
// JavaScriptCore (Bun) and V8 (Node) implement the inspector protocol's
// `Profiler.startPreciseCoverage({ detailed: true })`: per function, byte ranges with execution
// counts, where each conditional arm (`if`/`else`, `?:`, `&&`, `||`, `??`, `switch` case, `catch`,
// early `return`) is its own range. `bun test --coverage` collapses these to lines when it writes
// lcov; this preload keeps the ranges. The offsets are into the JavaScript Bun ran (the output of
// `Bun.Transpiler` on the TypeScript source); `branch-cov.ts` maps them back to TypeScript.
//
// `bun test` does not run `process.on("exit")` from a preload, but a preload's `afterAll` runs once
// after the last test file, and `takePreciseCoverage` is cumulative over the process.
import inspector from "node:inspector"
import { writeFileSync } from "node:fs"
import { afterAll } from "bun:test"

const out = process.env.OT_BRANCH_COV
if (out) {
  const session = new inspector.Session()
  session.connect()
  session.post("Profiler.enable")
  session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true })
  afterAll(() => {
    session.post("Profiler.takePreciseCoverage", (err, res) => {
      if (err) throw err
      const scripts = res.result.filter((s) => s.url.startsWith("file://") && !s.url.includes("/node_modules/"))
      writeFileSync(out, JSON.stringify(scripts))
    })
  })
}
