import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

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

interface PackageConfig {
  name: string
  rootDir: string
  distDir: string
  requiresCore?: boolean
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")

// Package configurations
const ALL_PACKAGES: PackageConfig[] = [
  {
    name: "@opentui/core",
    rootDir: join(rootDir, "packages", "core"),
    distDir: join(rootDir, "packages", "core", "dist"),
  },
  {
    name: "@opentui/three",
    rootDir: join(rootDir, "packages", "three"),
    distDir: join(rootDir, "packages", "three", "dist"),
    requiresCore: true,
  },
  {
    name: "@opentui/qrcode",
    rootDir: join(rootDir, "packages", "qrcode"),
    distDir: join(rootDir, "packages", "qrcode", "dist"),
    requiresCore: true,
  },
  {
    name: "@opentui/react",
    rootDir: join(rootDir, "packages", "react"),
    distDir: join(rootDir, "packages", "react", "dist"),
    requiresCore: true,
  },
  {
    name: "@opentui/solid",
    rootDir: join(rootDir, "packages", "solid"),
    distDir: join(rootDir, "packages", "solid", "dist"),
    requiresCore: true,
  },
  {
    name: "@opentui/keymap",
    rootDir: join(rootDir, "packages", "keymap"),
    distDir: join(rootDir, "packages", "keymap", "dist"),
    requiresCore: true,
  },
  {
    name: "@opentui/ssh",
    rootDir: join(rootDir, "packages", "ssh"),
    distDir: join(rootDir, "packages", "ssh", "dist"),
  },
]

const PACKAGES = ALL_PACKAGES

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

function verifyNpmAuth(): void {
  console.log("INFO: Verifying NPM authentication...")
  const npmAuth: SpawnSyncReturns<Buffer> = spawnSync("npm", ["whoami"], {})
  if (npmAuth.status !== 0) {
    console.error("ERROR: NPM authentication failed. Please run 'npm login' or ensure NPM_AUTH_TOKEN is set")
    process.exit(1)
  }
  console.log("SUCCESS: NPM authentication verified")
}

function checkVersionExists(packageName: string, version: string): boolean {
  try {
    const versions: string[] = JSON.parse(
      spawnSync("npm", ["view", packageName, "versions", "--json"], {}).stdout.toString().trim(),
    )
    return Array.isArray(versions) ? versions.includes(version) : versions === version
  } catch {
    // Package doesn't exist yet or network error - assume version doesn't exist
    return false
  }
}

function validatePackage(config: PackageConfig): void {
  console.log(`\nINFO: Validating ${config.name}...`)

  // Check if package.json exists
  const packageJsonPath = join(config.rootDir, "package.json")
  if (!existsSync(packageJsonPath)) {
    console.error(`ERROR: package.json not found: ${packageJsonPath}`)
    process.exit(1)
  }

  const packageJson: PackageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"))

  // Check if version already exists on npm
  if (checkVersionExists(packageJson.name, packageJson.version)) {
    console.error(`ERROR: ${packageJson.name}@${packageJson.version} already exists on npm`)
    console.error("Please update the version before publishing")
    process.exit(1)
  }
  console.log(`SUCCESS: Version ${packageJson.version} is available on npm`)

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

        // Also check if this version exists on npm
        if (checkVersionExists(depName, packageJson.version)) {
          console.error(`ERROR: ${depName}@${packageJson.version} already exists on npm`)
          console.error("Please update the version before publishing")
          process.exit(1)
        }
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

function main(): void {
  console.log("OpenTUI Pre-Publish Validation")
  console.log("=".repeat(50))

  // Setup NPM authentication once
  console.log("\nINFO: Setting up NPM authentication...")
  setupNpmAuth()
  verifyNpmAuth()

  // Validate all packages
  console.log("\nINFO: Validating all packages...")
  for (const packageConfig of PACKAGES) {
    validatePackage(packageConfig)
  }

  // Get user confirmation
  console.log("\n" + "=".repeat(50))
  console.log("SUCCESS: All validation checks passed!")
  getUserConfirmation()

  console.log("\nSUCCESS: Pre-publish validation complete! Ready to publish.")
  console.log("\nNext steps:")
  console.log("  • Run: bun run publish")
}

main()
