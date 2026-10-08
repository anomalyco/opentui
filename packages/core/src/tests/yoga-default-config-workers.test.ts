import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

// The test outlives the child's timeout, so a hung child fails with its signal instead of a test timeout.
const childTimeoutMs = 10_000

test(
  "Workers create and free OpenTUI Yoga nodes in the shared default config concurrently",
  () => {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js"
    const runtimeArgs = "bun" in process.versions ? [] : process.execArgv.filter((arg) => !arg.startsWith("--test"))
    const child = spawnSync(
      process.execPath,
      [...runtimeArgs, fileURLToPath(new URL(`yoga-default-config-worker-child.${extension}`, import.meta.url))],
      { encoding: "utf8", timeout: childTimeoutMs },
    )
    expect({ status: child.status, signal: child.signal, stdout: child.stdout.trim() }).toEqual({
      status: 0,
      signal: null,
      stdout: "default config survived: 3",
    })
  },
  childTimeoutMs + 5_000,
)
