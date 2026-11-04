import { execSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

interface RootPackageJson {
  workspaces?: string[]
}

interface PackageJson {
  name?: string
  version?: string
  optionalDependencies?: Record<string, string>
  [key: string]: unknown
}

interface WorkspacePackage {
  name: string
  packageJsonPath: string
  packageJson: PackageJson
}

type ReleaseType = "patch" | "minor" | "major"

const CORE_PACKAGE_NAME = "@opentui/core"
const LOCKSTEP_PACKAGE_PREFIX = "@opentui/"
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")

const args = process.argv.slice(2)
const dryRun = args.includes("--dry-run")
const noInstall = args.includes("--no-install")
const explicitVersion = args.find((arg) => !arg.startsWith("--"))
const releaseType = getRequestedReleaseType(args, explicitVersion)

const lockstepPackages = getLockstepPackages()
const corePackage = lockstepPackages.find((pkg) => pkg.name === CORE_PACKAGE_NAME)

if (!corePackage) {
  console.error(`Error: ${CORE_PACKAGE_NAME} was not found in the workspace packages`)
  process.exit(1)
}

if (!corePackage.packageJson.version) {
  console.error(`Error: ${CORE_PACKAGE_NAME} does not have a version field`)
  process.exit(1)
}

const currentVersion = corePackage.packageJson.version
const version = resolveTargetVersion(explicitVersion, releaseType, currentVersion)

if (!VERSION_PATTERN.test(version)) {
  console.error(`Error: Invalid version format: ${version}`)
  console.error("Version should follow semver format (e.g., 1.0.0, 1.0.0-beta.1)")
  process.exit(1)
}

warnOnVersionDrift(lockstepPackages, currentVersion)

console.log(
  `\nPreparing release ${version}${dryRun ? " (dry run)" : ""} for ${lockstepPackages.length} lock-step packages...\n`,
)

for (const workspacePackage of lockstepPackages) {
  updateWorkspacePackage(workspacePackage, version, dryRun)
}

if (dryRun) {
  console.log("\nDry run: skipped writing package.json files and bun install")
} else if (noInstall) {
  console.log("\nSkipping bun install (--no-install)")
} else {
  console.log("\nUpdating bun.lock...")

  try {
    execSync("bun install", { cwd: rootDir, stdio: "inherit" })
    console.log("  bun.lock updated successfully")
  } catch (error) {
    console.error(`  Failed to update bun.lock: ${error}`)
    process.exit(1)
  }
}

if (dryRun) {
  console.log(`\nDry run complete for release ${version}.`)
  process.exit(0)
}

console.log(`
Successfully prepared release ${version} for ${lockstepPackages.length} lock-step packages!

Packages:
${lockstepPackages.map((pkg) => `- ${pkg.name}`).join("\n")}

Next steps:
1. Review the changes: git diff
2. Commit the changes: git add -A && git commit -m "Release v${version}"
3. Get the commit onto main, pushed or through a pull request. release.yml releases each commit on
   main that raises the version, and creates the v${version} tag.

\`bun run release\` does all of this and follows the release.
  `)

function getRequestedReleaseType(args: string[], explicitVersion?: string): ReleaseType | null {
  const requestedReleaseTypes = ["--patch", "--minor", "--major"].filter((arg) => args.includes(arg))

  if (requestedReleaseTypes.length > 1) {
    console.error("Error: Please specify only one of --patch, --minor, or --major")
    process.exit(1)
  }

  if (explicitVersion && requestedReleaseTypes.length > 0 && explicitVersion !== "*") {
    console.error("Error: Provide either an explicit version or a release type flag, not both")
    process.exit(1)
  }

  if (explicitVersion === "*" || requestedReleaseTypes[0] === "--patch") {
    return "patch"
  }

  if (requestedReleaseTypes[0] === "--minor") {
    return "minor"
  }

  if (requestedReleaseTypes[0] === "--major") {
    return "major"
  }

  return null
}

function resolveTargetVersion(
  explicitVersion: string | undefined,
  releaseType: ReleaseType | null,
  currentVersion: string,
): string {
  if (explicitVersion && explicitVersion !== "*") {
    return explicitVersion
  }

  const effectiveReleaseType = releaseType ?? "patch"
  const nextVersion = incrementVersion(currentVersion, effectiveReleaseType)
  console.log(`Auto-incrementing ${effectiveReleaseType} version from ${currentVersion} to ${nextVersion}`)
  return nextVersion
}

function incrementVersion(version: string, releaseType: ReleaseType): string {
  if (version.includes("-")) {
    console.error(`Error: Auto-increment is only supported for stable versions. Current version: ${version}`)
    console.error("Please provide the target prerelease version explicitly")
    process.exit(1)
  }

  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match) {
    console.error(`Error: Invalid current version format: ${version}`)
    process.exit(1)
  }

  const major = Number.parseInt(match[1], 10)
  const minor = Number.parseInt(match[2], 10)
  const patch = Number.parseInt(match[3], 10)

  if (releaseType === "major") {
    return `${major + 1}.0.0`
  }

  if (releaseType === "minor") {
    return `${major}.${minor + 1}.0`
  }

  return `${major}.${minor}.${patch + 1}`
}

function getLockstepPackages(): WorkspacePackage[] {
  const rootPackageJson = readJson<RootPackageJson>(join(rootDir, "package.json"))
  const workspacePatterns = rootPackageJson.workspaces ?? []

  const workspaceDirs = [...new Set(workspacePatterns.flatMap(expandWorkspacePattern))]
  const packages = workspaceDirs
    .map((workspaceDir) => join(workspaceDir, "package.json"))
    .filter((packageJsonPath) => existsSync(packageJsonPath))
    .map((packageJsonPath) => ({
      packageJsonPath,
      packageJson: readJson<PackageJson>(packageJsonPath),
    }))
    .filter(
      (entry): entry is { packageJsonPath: string; packageJson: PackageJson & { name: string; version: string } } =>
        typeof entry.packageJson.name === "string" &&
        entry.packageJson.name.startsWith(LOCKSTEP_PACKAGE_PREFIX) &&
        typeof entry.packageJson.version === "string",
    )
    .map((entry) => ({
      name: entry.packageJson.name,
      packageJsonPath: entry.packageJsonPath,
      packageJson: entry.packageJson,
    }))

  return packages.sort((left, right) => {
    if (left.name === CORE_PACKAGE_NAME) {
      return -1
    }

    if (right.name === CORE_PACKAGE_NAME) {
      return 1
    }

    return left.name.localeCompare(right.name)
  })
}

function expandWorkspacePattern(pattern: string): string[] {
  if (!pattern.includes("*")) {
    return [join(rootDir, pattern)]
  }

  if (pattern.endsWith("/*") && pattern.indexOf("*") === pattern.length - 1) {
    const baseDir = join(rootDir, pattern.slice(0, -2))

    if (!existsSync(baseDir)) {
      return []
    }

    return readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(baseDir, entry.name))
  }

  console.error(`Error: Unsupported workspace pattern: ${pattern}`)
  process.exit(1)
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n")
}

function warnOnVersionDrift(lockstepPackages: WorkspacePackage[], sourceVersion: string): void {
  const driftedPackages = lockstepPackages.filter((pkg) => pkg.packageJson.version !== sourceVersion)

  if (driftedPackages.length === 0) {
    return
  }

  console.warn("Detected version drift across lock-step packages. Using @opentui/core as the source of truth:")
  console.warn(`  ${CORE_PACKAGE_NAME}: ${sourceVersion}`)

  for (const workspacePackage of driftedPackages) {
    console.warn(`  ${workspacePackage.name}: ${workspacePackage.packageJson.version}`)
  }
}

function updateWorkspacePackage(workspacePackage: WorkspacePackage, version: string, dryRun: boolean): void {
  const previousVersion = workspacePackage.packageJson.version

  if (previousVersion === version) {
    console.log(`No change for ${workspacePackage.name} (already ${version})`)
  } else {
    console.log(`Updating ${workspacePackage.name} from ${previousVersion} to ${version}`)
  }

  workspacePackage.packageJson.version = version

  if (workspacePackage.name === CORE_PACKAGE_NAME) {
    const updatedOptionalDependencies = updateCoreOptionalDependencies(workspacePackage.packageJson, version)

    for (const dependencyName of updatedOptionalDependencies) {
      console.log(`  Updated ${dependencyName} to ${version}`)
    }
  }

  if (!dryRun) {
    writeJson(workspacePackage.packageJsonPath, workspacePackage.packageJson)
  }
}

function updateCoreOptionalDependencies(packageJson: PackageJson, version: string): string[] {
  if (!packageJson.optionalDependencies) {
    return []
  }

  const updatedDependencyNames: string[] = []

  for (const dependencyName of Object.keys(packageJson.optionalDependencies)) {
    if (!dependencyName.startsWith("@opentui/core-")) {
      continue
    }

    packageJson.optionalDependencies[dependencyName] = version
    updatedDependencyNames.push(dependencyName)
  }

  return updatedDependencyNames
}
