import { spawnSync } from "node:child_process"
import { delimiter, dirname } from "node:path"

export const NODE26_VERSION = "v26.3.0"

export function requireNode26() {
  const nodeCommand = typeof process.versions?.bun === "string" ? "node" : process.execPath
  const result = spawnSync(
    nodeCommand,
    ["--eval", "process.stdout.write(JSON.stringify({ version: process.version, execPath: process.execPath }))"],
    { encoding: "utf8" },
  )

  if (result.error) {
    throw new Error(nodeVersionError(`${nodeCommand} is not available`), { cause: result.error })
  }

  if (result.status !== 0) {
    throw new Error(nodeVersionError(`${nodeCommand} exited with status ${result.status ?? "unknown"}`))
  }

  const runtime = parseNodeRuntime(nodeCommand, result.stdout)
  if (runtime.version !== NODE26_VERSION) {
    throw new Error(nodeVersionError(`${runtime.execPath} reports ${runtime.version}`))
  }

  // Keep npm and env-based child launches on the same runtime that was validated.
  process.env.PATH = [dirname(runtime.execPath), process.env.PATH].filter(Boolean).join(delimiter)
  return runtime.execPath
}

function parseNodeRuntime(nodeCommand, output) {
  try {
    const runtime = JSON.parse(output)
    if (typeof runtime.version === "string" && typeof runtime.execPath === "string" && runtime.execPath.length > 0) {
      return runtime
    }
  } catch (error) {
    throw new Error(nodeVersionError(`${nodeCommand} reported an invalid runtime`), { cause: error })
  }

  throw new Error(nodeVersionError(`${nodeCommand} reported an invalid runtime`))
}

function nodeVersionError(actualVersion) {
  return `Node.js ${NODE26_VERSION} is required, but ${actualVersion}. Select the required Node.js version before running this command; OpenTUI will not install it automatically.`
}
