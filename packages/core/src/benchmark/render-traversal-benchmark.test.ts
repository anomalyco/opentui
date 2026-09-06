import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ParityEvidence } from "./render-traversal-benchmark.js"
import { sceneGoldens } from "./render-traversal-goldens.js"

test.each([
  "layout-benchmark.ts",
  "box-draw-benchmark.ts",
  "text-buffer-render-benchmark.ts",
  "render-traversal-benchmark.ts",
])(
  "%s runs retained workloads without out-of-frame buffer writes",
  (script) => {
    const args = ["--iterations=1", "--warmup-iterations=1", "--no-output"]
    if (script === "layout-benchmark.ts") args.push("--rounds=1", "--min-sample-ms=1")
    const child = spawnSync(process.execPath, [join(import.meta.dir, script), ...args], {
      encoding: "utf8",
      timeout: 60_000,
    })
    expect(child.error).toBeUndefined()
    expect(child.stderr).toBe("")
    expect(child.status).toBe(0)
  },
  60_000,
)

test.each([
  [140, 44],
  [41, 21],
])("grayscale benchmark verifies dense changing output against frozen frames at %ix%i", (width, height) => {
  const directory = mkdtempSync(join(tmpdir(), "opentui-grayscale-benchmark-"))
  const output = join(directory, "parity.json")
  try {
    const child = spawnSync(
      process.execPath,
      [
        join(import.meta.dir, "render-traversal-benchmark.ts"),
        "--scenario=grayscale_changed",
        "--verify-only",
        `--width=${width}`,
        `--height=${height}`,
        `--json=${output}`,
        "--no-output",
      ],
      { encoding: "utf8", timeout: 20_000 },
    )
    expect(child.error).toBeUndefined()
    expect(child.stderr).toBe("")
    expect(child.status).toBe(0)
    const report = JSON.parse(readFileSync(output, "utf8"))
    const parity: ParityEvidence = report.metadata.parity.grayscale_changed
    expect(report.scenarios).toEqual([])
    expect(parity.golden).toBe(true)
    expect(parity).not.toHaveProperty("backends")
    expect(report.metadata).not.toHaveProperty("sceneBackend")
    expect(parity.workload).toEqual({
      frameBuffers: 1,
      panelWidth: Math.floor(width / 2),
      panelHeight: height,
      sampleScales: [1, 2],
      width,
      height,
      useMouse: true,
      mutation: "grayscale",
    })
    expect(parity.frames).toHaveLength(4)
    expect(parity.frames[1].cellsUpdated).toBe(0)
    expect(parity.frames[2].cellsUpdated).toBe(Math.floor(width / 2) * height * 2)
    expect(parity.frames[3].cellsUpdated).toBe(parity.frames[2].cellsUpdated)
    expect(parity.frames[0].digest).toBe(parity.frames[1].digest)
    expect(parity.frames[0].digest).not.toBe(parity.frames[2].digest)
    expect(parity.frames[0].digest).toBe(parity.frames[3].digest)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("retained scene preflight verifies all five workloads against frozen frames", () => {
  const directory = mkdtempSync(join(tmpdir(), "opentui-scene-benchmark-"))
  const output = join(directory, "parity.json")
  try {
    const child = spawnSync(
      process.execPath,
      [join(import.meta.dir, "render-traversal-benchmark.ts"), "--verify-only", `--json=${output}`, "--no-output"],
      { encoding: "utf8", timeout: 60_000 },
    )
    expect(child.error).toBeUndefined()
    expect(child.stderr).toBe("")
    expect(child.status).toBe(0)
    const report = JSON.parse(readFileSync(output, "utf8"))
    for (const name of [
      "boxes_steady_10000",
      "boxes_changed_10000",
      "log_unchanged_10000",
      "log_append_10000",
      "log_scroll_10000",
    ]) {
      const evidence: ParityEvidence = report.metadata.parity[name]
      expect(evidence.golden).toBe(true)
      expect(evidence.frames.length).toBeGreaterThanOrEqual(4)
      if (name.startsWith("log_")) {
        expect(evidence.frames.at(-1)?.step).toBe("cleanup")
        expect(evidence.digestKind).toBe("sha256-resolved-cell-bytes-planes-geometry-hits")
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 60_000)

test("scene preflight rejects a mismatched frozen frame", () => {
  const script = join(import.meta.dir, "render-traversal-benchmark.ts")
  const child = spawnSync(
    process.execPath,
    [
      "--eval",
      `const { sceneGoldens } = await import(${JSON.stringify(join(import.meta.dir, "render-traversal-goldens.ts"))})
       sceneGoldens["boxes_steady_10000/140x44"][0] = ["corrupted", 6160]
       process.argv = [process.execPath, ${JSON.stringify(script)}, "--scenario=boxes_steady_10000", "--verify-only", "--no-output"]
       await import(${JSON.stringify(script)})`,
    ],
    { encoding: "utf8", timeout: 20_000 },
  )
  expect(child.error).toBeUndefined()
  expect(child.status).not.toBe(0)
  expect(child.stderr).toContain("boxes_steady_10000/initial: golden mismatch")
})

test("historical runtime comparison includes encode timing and rejects output changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "opentui-grayscale-compare-"))
  try {
    const reports = [join(directory, "baseline.json"), join(directory, "current.json")]
    for (const [index, report] of reports.entries()) {
      const timing = { avgMs: { median: (2 - index) / 10 } }
      writeFileSync(
        report,
        JSON.stringify({
          runId: String(index),
          parity: {
            grayscale_changed: {
              terminal: { remote: true, widthMethod: "unicode", rgb: false, ansi256: false },
              workload: {
                frameBuffers: 1,
                panelWidth: 70,
                panelHeight: 44,
                sampleScales: [1, 2],
                width: 140,
                height: 44,
                useMouse: true,
                mutation: "grayscale",
              },
              digestKind: "sha256-cell-planes-geometry-hits",
              frames: sceneGoldens["grayscale_changed/140x44"].map(([digest, cellsUpdated]) => ({
                digest,
                cellsUpdated,
              })),
              ...(index === 0 ? { backends: ["legacy", "native"] } : { golden: true }),
            },
          },
          results: [
            {
              name: "grayscale_changed",
              bun: { ...timing, scene: timing, nativeRender: timing },
              node: { ...timing, scene: timing, nativeRender: timing },
              nodeToBun: { median: 1 },
            },
          ],
        }),
      )
    }
    const child = spawnSync(process.execPath, [join(import.meta.dir, "render-runtime-compare.ts"), ...reports], {
      encoding: "utf8",
      timeout: 10_000,
    })
    expect(child.status).toBe(0)
    expect(child.stdout).toContain("| native diff/encode | 0.2000ms | 0.1000ms | -50.0% |")
    const changed = JSON.parse(readFileSync(reports[1], "utf8"))
    changed.parity.grayscale_changed.frames[0].cellsUpdated++
    writeFileSync(reports[1], JSON.stringify(changed))
    const mismatch = spawnSync(process.execPath, [join(import.meta.dir, "render-runtime-compare.ts"), ...reports], {
      encoding: "utf8",
      timeout: 10_000,
    })
    expect(mismatch.status).not.toBe(0)
    expect(mismatch.stderr).toContain("grayscale_changed: frames differs")
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
