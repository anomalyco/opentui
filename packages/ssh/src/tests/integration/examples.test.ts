import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const packageRoot = fileURLToPath(new URL("../../..", import.meta.url))
for (const [name, entrypoint, extraArgs] of [
  ["minimal", "examples/minimal.ts", []],
  ["imperative", "examples/imperative.ts", []],
  ["auth", "examples/auth.ts", []],
  ["authorized keys", "examples/authorized-keys.ts", []],
  ["lifecycle", "examples/lifecycle.ts", []],
  ["middleware", "examples/middleware.ts", []],
  ["React", "examples/react.tsx", []],
  ["Solid", "examples/solid.tsx", ["--jsx-import-source", "@opentui/solid"]],
] as const) {
  test(`${name} example compiles`, () => {
    const outdir = mkdtempSync(join(tmpdir(), `opentui-ssh-${name.toLowerCase()}-`))
    try {
      const result = Bun.spawnSync(
        [
          process.execPath,
          "build",
          entrypoint,
          "--target",
          "bun",
          "--packages",
          "external",
          "--outdir",
          outdir,
          ...extraArgs,
        ],
        {
          cwd: packageRoot,
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      expect(result.exitCode, result.stderr.toString()).toBe(0)
    } finally {
      rmSync(outdir, { recursive: true, force: true })
    }
  })
}

test("documentation uses the logging middleware factory correctly", () => {
  const readme = readFileSync(join(packageRoot, "README.md"), "utf8")
  const shapeExample = readme.slice(readme.indexOf("## The shape"), readme.indexOf("### `Session`"))

  expect(shapeExample).toContain(".use(logging())")
  expect(shapeExample).not.toContain(".use(logging) ")
})

for (const entrypoint of [
  "minimal.ts",
  "imperative.ts",
  "auth.ts",
  "authorized-keys.ts",
  "lifecycle.ts",
  "middleware.ts",
  "react.tsx",
  "solid.tsx",
]) {
  test(`${entrypoint} lets the remote user quit with q or Ctrl-C`, () => {
    const implementation = entrypoint === "solid.tsx" ? "solid-app.tsx" : entrypoint
    const example = readFileSync(join(packageRoot, "examples", implementation), "utf8")

    expect(example).toContain('key.name === "q"')
    expect(example).toContain('key.ctrl && key.name === "c"')
    expect(example).toContain("session.end()")
  })
}
