import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const defaultPluginEntry = ".plugin/index.tsx"

type ResolveExternalPluginCandidatesInput = {
  cwd: string
  execPath: string
  moduleUrl: string
  envPath?: string
}

function normalizeExternalPluginPath(input: string, cwd: string): string {
  if (input.startsWith("file://")) {
    return fileURLToPath(input)
  }

  if (isAbsolute(input)) {
    return input
  }

  return resolve(cwd, input)
}

export function resolveExternalPluginCandidates(input: ResolveExternalPluginCandidatesInput): string[] {
  const paths = new Set<string>()
  const moduleDir = dirname(fileURLToPath(input.moduleUrl))
  const execDir = dirname(input.execPath)

  if (input.envPath && input.envPath.trim().length > 0) {
    paths.add(normalizeExternalPluginPath(input.envPath.trim(), input.cwd))
  }

  paths.add(resolve(input.cwd, defaultPluginEntry))
  paths.add(join(execDir, defaultPluginEntry))
  paths.add(resolve(execDir, "..", defaultPluginEntry))
  paths.add(resolve(moduleDir, "..", defaultPluginEntry))
  paths.add(resolve(input.cwd, "packages", "solid", "examples", defaultPluginEntry))
  paths.add(resolve(execDir, "..", "..", defaultPluginEntry))

  return [...paths]
}
