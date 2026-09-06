import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

test("Yoga callback failures unwind safely and remain isolated by owner", () => {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
  const runtimeArgs = "bun" in process.versions ? [] : process.execArgv.filter((arg) => !arg.startsWith("--test"))
  const child = spawnSync(
    process.execPath,
    [...runtimeArgs, fileURLToPath(new URL(`yoga-callback-boundary-child.${extension}`, import.meta.url))],
    { encoding: "utf8", timeout: 30_000 },
  )
  expect({ status: child.status, signal: child.signal, stderr: child.stderr, error: child.error?.message }).toEqual({
    status: 0,
    signal: null,
    stderr: "",
    error: undefined,
  })
  expect(child.stdout.trim()).toMatch(
    /^(?:Measure function returned an invalid dimension to Yoga: \[width=nan, height=nan\])*Yoga callback boundary passed$/,
  )
})
