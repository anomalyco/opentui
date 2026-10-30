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
    // Outside libuv's job object, an unhandled exception in the child reaches Windows Error Reporting.
    // Node's spawnSync honors `detached`, but its types leave it out.
    const options = { encoding: "utf8" as const, timeout: childTimeoutMs, detached: process.platform === "win32" }
    const child = spawnSync(
      process.execPath,
      [...runtimeArgs, fileURLToPath(new URL(`yoga-default-config-worker-child.${extension}`, import.meta.url))],
      options,
    )
    const stdout = child.stdout.trim()
    const passed = child.status === 0 && stdout === "default config survived: 3"
    // A failure shows the tail of the child's stderr, so a crash explains itself.
    expect({
      status: child.status,
      signal: child.signal,
      stdout,
      stderr: passed ? "" : child.stderr.slice(-4096),
    }).toEqual({
      status: 0,
      signal: null,
      stdout: "default config survived: 3",
      stderr: "",
    })
  },
  childTimeoutMs + 5_000,
)
