import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

test.each([
  { args: ["--native", "--skip-zig", "--target=openbsd-x64"], error: "Unsupported native target: openbsd-x64" },
  { args: ["--native", "--target=freebsd-x64"], error: "--target requires --skip-zig" },
  {
    args: ["--native", "--skip-zig", "--all", "--target=freebsd-x64"],
    error: "--target and --all cannot be combined",
  },
])("rejects invalid native packaging options: $error", ({ args, error }) => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./build.ts", import.meta.url)), ...args], {
    encoding: "utf8",
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain(error)
})

test("the native target environment does not affect library-only command validation", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./build.ts", import.meta.url))], {
    encoding: "utf8",
    env: { ...process.env, OPENTUI_NATIVE_TARGET: "freebsd-x64" },
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain("Please specify --lib, --native, or both")
  expect(result.stderr).not.toContain("--target requires --skip-zig")
})
