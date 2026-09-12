import { spawnSync } from "node:child_process"
import { delimiter, dirname } from "node:path"

export const NODE26_MIN_VERSION = "v26.4.0"

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
  if (!isSupportedNode26Version(runtime.version)) {
    throw new Error(nodeVersionError(`${runtime.execPath} reports ${runtime.version}`))
  }

  // Keep npm and env-based child launches on the same runtime that was validated.
  process.env.PATH = [dirname(runtime.execPath), process.env.PATH].filter(Boolean).join(delimiter)
  return runtime.execPath
}

export function isSupportedNode26Version(version) {
  const parsed = parseNodeVersion(version)
  const minimum = parseNodeVersion(NODE26_MIN_VERSION)
  if (parsed === null || minimum === null) {
    return false
  }

  return compareNodeVersion(parsed, minimum) >= 0
}

export function parseNodeVersion(version) {
  if (typeof version !== "string") {
    return null
  }

  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) {
    return null
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function compareNodeVersion(left, right) {
  if (left.major !== right.major) {
    return left.major < right.major ? -1 : 1
  }

  if (left.minor !== right.minor) {
    return left.minor < right.minor ? -1 : 1
  }

  if (left.patch !== right.patch) {
    return left.patch < right.patch ? -1 : 1
  }

  return 0
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
  return `Node.js ${NODE26_MIN_VERSION} or later is required, but ${actualVersion}. Select a supported Node.js version before running this command; OpenTUI will not install it automatically.`
}
