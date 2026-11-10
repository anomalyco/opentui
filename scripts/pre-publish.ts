import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"

import { publishedState, RELEASE_PACKAGES, type ReleasePackage } from "./npm-publish"

interface PackageJson {
  name: string
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

interface VersionMismatch {
  name: string
  dir: string
  expected: string
  actual: string
}

function setupNpmAuth(): void {
  if (!process.env.NPM_AUTH_TOKEN) {
    console.log("WARNING: NPM_AUTH_TOKEN not found, skipping auth setup")
    return
  }

  const npmrcPath = join(process.env.HOME as string, ".npmrc")
  const npmrcContent = `//registry.npmjs.org/:_authToken=${process.env.NPM_AUTH_TOKEN}\n`

  if (existsSync(npmrcPath)) {
    const existing = readFileSync(npmrcPath, "utf8")
    if (!existing.includes("//registry.npmjs.org/:_authToken")) {
      writeFileSync(npmrcPath, existing + "\n" + npmrcContent)
      console.log("SUCCESS: NPM auth token added to existing ~/.npmrc")
    } else {
      console.log("SUCCESS: NPM auth token already present in ~/.npmrc")
    }
  } else {
    writeFileSync(npmrcPath, npmrcContent)
    console.log("SUCCESS: NPM auth token written to ~/.npmrc")
  }
}

function isTrustedPublishing(): boolean {
  return (
    process.env.GITHUB_ACTIONS === "true" &&
    Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL) &&
    Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)
  )
}

function verifyNpmAuth(): void {
  console.log("INFO: Verifying NPM authentication...")
  const npmAuth: SpawnSyncReturns<Buffer> = spawnSync("npm", ["whoami"], {})
  if (npmAuth.status !== 0) {
    console.error("ERROR: NPM authentication failed. Please run 'npm login' or ensure NPM_AUTH_TOKEN is set")
    process.exit(1)
  }
  console.log("SUCCESS: NPM authentication verified")
}

// A version that npm already has with identical contents is from an earlier attempt of this
// release. The publish step skips it.
async function checkPublishedState(directory: string, name: string, version: string): Promise<void> {
  const state = await publishedState(directory)
  if (state === "different") {
    console.error(`ERROR: ${name}@${version} already exists on npm with different contents`)
    console.error("Please update the version before publishing")
    process.exit(1)
  }
  if (state === "identical") {
    console.log(`SUCCESS: ${name}@${version} is already on npm with identical contents and will be skipped`)
  } else {
    console.log(`SUCCESS: ${name}@${version} is available on npm`)
  }
}

async function validatePackage(config: ReleasePackage): Promise<void> {
  console.log(`\nINFO: Validating ${config.name}...`)

  // Check if package.json exists
  const packageJsonPath = join(config.rootDir, "package.json")
  if (!existsSync(packageJsonPath)) {
    console.error(`ERROR: package.json not found: ${packageJsonPath}`)
    process.exit(1)
  }

  const packageJson: PackageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"))

  // Check if dist directory exists
  if (!existsSync(config.distDir)) {
    console.error(`ERROR: dist directory not found: ${config.distDir}`)
    console.error("Please run 'bun run build' first")
    process.exit(1)
  }
  console.log(`SUCCESS: dist directory exists`)

  // Check dist package.json
  const distPackageJsonPath = join(config.distDir, "package.json")
  if (!existsSync(distPackageJsonPath)) {
    console.error(`ERROR: dist/package.json not found: ${distPackageJsonPath}`)
    process.exit(1)
  }

  const distPackageJson: PackageJson = JSON.parse(readFileSync(distPackageJsonPath, "utf8"))

  // Check version mismatch between source and dist
  if (distPackageJson.version !== packageJson.version) {
    console.error(`ERROR: Version mismatch between source and dist package.json`)
    console.error(`  Source version: ${packageJson.version}`)
    console.error(`  Dist version: ${distPackageJson.version}`)
    console.error("Please rebuild the package with 'bun run build'")
    process.exit(1)
  }
  console.log(`SUCCESS: Source and dist versions match`)

  await checkPublishedState(config.distDir, packageJson.name, packageJson.version)

  // For core package, check optional dependencies versions
  if (config.name === "@opentui/core") {
    const mismatches: VersionMismatch[] = []

    if (distPackageJson.optionalDependencies) {
      for (const depName of Object.keys(distPackageJson.optionalDependencies).filter((x) =>
        x.startsWith("@opentui/core"),
      )) {
        const nativeDir = join(config.rootDir, "node_modules", depName)
        if (!existsSync(nativeDir)) {
          console.error(`ERROR: Native package directory not found: ${nativeDir}`)
          console.error("Please run 'bun run build:native' first")
          process.exit(1)
        }

        const nativePackageJson: PackageJson = JSON.parse(readFileSync(join(nativeDir, "package.json"), "utf8"))

        if (nativePackageJson.version !== packageJson.version) {
          mismatches.push({
            name: depName,
            dir: nativeDir,
            expected: packageJson.version,
            actual: nativePackageJson.version,
          })
        }

        await checkPublishedState(nativeDir, depName, nativePackageJson.version)
      }
    }

    if (mismatches.length > 0) {
      console.error("ERROR: Version mismatch detected between root package and native packages:")
      mismatches.forEach((m) =>
        console.error(`  - ${m.name}: expected ${m.expected}, found ${m.actual}\n    ^ "${m.dir}"`),
      )
      process.exit(1)
    }
    console.log(`SUCCESS: All optional dependencies versions match`)
  }

  // For packages that publish an @opentui/core dependency, check the version.
  if (config.requiresCore) {
    const coreDependencyVersion = distPackageJson.dependencies?.["@opentui/core"]
    if (coreDependencyVersion !== packageJson.version) {
      console.error(`ERROR: @opentui/core dependency version mismatch in dist`)
      console.error(`  Expected: ${packageJson.version}`)
      console.error(`  Found: ${coreDependencyVersion}`)
      console.error("Please rebuild the package with 'bun run build'")
      process.exit(1)
    }
    console.log(`SUCCESS: @opentui/core dependency version matches`)
  }

  console.log(`SUCCESS: ${config.name} validation complete`)
}

function getUserConfirmation(): void {
  console.log(
    `

Pre-publish checklist:

1. [OK] Version fields in package.json files have been updated
2. [OK] All packages have been built (bun run build) 
3. [OK] Changes have been committed and pushed to GitHub
4. [OK] All validation checks have passed

Continue with publishing? (y/n)
`.trim(),
  )

  if (process.env.CI === "true") {
    console.log("INFO: Running in CI environment, skipping user confirmation")
    return
  }

  const confirm: SpawnSyncReturns<Buffer> = spawnSync(
    "node",
    [
      "-e",
      `
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', (data) => {
        const input = data.toString().toLowerCase();
        if (input === 'y') process.exit(0);
        if (input === 'n' || input === '\\x03') process.exit(1);
      });
      `,
    ],
    {
      shell: false,
      stdio: "inherit",
    },
  )

  if (confirm.status !== 0) {
    console.log("ABORTED: Publishing cancelled")
    process.exit(1)
  }
}

async function main(): Promise<void> {
  console.log("OpenTUI Pre-Publish Validation")
  console.log("=".repeat(50))

  // OIDC credentials are exchanged by `npm publish` itself, so `npm whoami`
  // cannot verify Trusted Publishing authentication ahead of time.
  if (isTrustedPublishing()) {
    console.log("\nINFO: Using npm Trusted Publishing (OIDC)")
  } else {
    console.log("\nINFO: Setting up NPM authentication...")
    setupNpmAuth()
    verifyNpmAuth()
  }

  // Validate all packages
  console.log("\nINFO: Validating all packages...")
  for (const packageConfig of RELEASE_PACKAGES) {
    await validatePackage(packageConfig)
  }

  // Get user confirmation
  console.log("\n" + "=".repeat(50))
  console.log("SUCCESS: All validation checks passed!")
  getUserConfirmation()

  console.log("\nSUCCESS: Pre-publish validation complete! Ready to publish.")
  console.log("\nNext steps:")
  console.log("  • Run: bun run publish")
}

await main()
