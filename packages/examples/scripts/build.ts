#!/usr/bin/env bun

import { chmodSync, existsSync, mkdirSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { BunPlugin } from "bun"

interface PackageJson {
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

type BuildTarget = {
  platform: "darwin" | "linux" | "windows"
  arch: "x64" | "arm64"
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const packageRoot = resolve(__dirname, "..")
const repoRoot = resolve(packageRoot, "../..")
const coreRoot = join(repoRoot, "packages", "core")
const keymapRoot = join(repoRoot, "packages", "keymap")
const qrcodeRoot = join(repoRoot, "packages", "qrcode")
const threeRoot = join(repoRoot, "packages", "three")
const examplesDir = join(packageRoot, "src")
const args = process.argv.slice(2)
const usePrebuiltArtifacts = process.env.OPENTUI_EXAMPLES_USE_PREBUILT_ARTIFACTS === "true"
const skipBunWebgpuInstall = process.env.OPENTUI_EXAMPLES_SKIP_BUN_WEBGPU_INSTALL === "true"
const buildHostOnly = args.includes("--host")
const canBuildLocalNativePackagesForAllTargets = process.platform === "darwin"

// Supported platforms and architectures based on bun-webgpu and opentui native binaries.
const targets: BuildTarget[] = [
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "windows", arch: "x64" },
]

const distDir = join(packageRoot, "dist")
mkdirSync(distDir, { recursive: true })

const packageJson: PackageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"))
const version = packageJson.version
const bunWebgpuVersion = packageJson.dependencies?.["bun-webgpu"] ?? packageJson.optionalDependencies?.["bun-webgpu"]

if (!bunWebgpuVersion) {
  throw new Error("bun-webgpu is not installed")
}

const workspaceAliasPlugin: BunPlugin = {
  name: "workspace-alias",
  setup(build) {
    build.onResolve({ filter: /^@opentui\/core-(?:darwin|linux|win32)-/ }, (args) => {
      if (existsSync(join(coreRoot, "node_modules", args.path))) return

      // Bun resolves unreachable dynamic imports while compiling. Keep absent
      // optional native variants external so host-only builds need only the host package.
      return { path: args.path, external: true }
    })

    build.onResolve({ filter: /^@opentui\/core$/ }, () => ({
      path: join(coreRoot, "src", "index.ts"),
    }))

    build.onResolve({ filter: /^@opentui\/three$/ }, () => ({
      path: join(threeRoot, "src", "index.ts"),
    }))

    build.onResolve({ filter: /^@opentui\/keymap$/ }, () => ({
      path: join(keymapRoot, "src", "index.ts"),
    }))

    build.onResolve({ filter: /^@opentui\/qrcode$/ }, () => ({
      path: join(qrcodeRoot, "src", "index.ts"),
    }))

    build.onResolve({ filter: /^@opentui\/keymap\/addons\/opentui$/ }, () => ({
      path: join(keymapRoot, "src", "addons", "opentui", "index.ts"),
    }))

    build.onResolve({ filter: /^@opentui\/keymap\/opentui$/ }, () => ({
      path: join(keymapRoot, "src", "opentui.ts"),
    }))
  },
}

function getNativePackageDir(platform: string, arch: string): string {
  const packagePlatform = platform === "windows" ? "win32" : platform
  return join(coreRoot, "node_modules", "@opentui", `core-${packagePlatform}-${arch}`)
}

function getHostBuildTarget(): BuildTarget {
  const hostPlatform =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "darwin"
        : process.platform === "linux"
          ? "linux"
          : null

  if (!hostPlatform || (process.arch !== "x64" && process.arch !== "arm64")) {
    throw new Error(`Unsupported host platform for examples build: ${process.platform}-${process.arch}`)
  }

  return { platform: hostPlatform, arch: process.arch }
}

function verifyNativePackages(buildTargets: BuildTarget[]): void {
  for (const { platform, arch } of buildTargets) {
    const packageDir = getNativePackageDir(platform, arch)
    if (!existsSync(packageDir)) {
      throw new Error(`Missing native package for ${platform}-${arch}: ${packageDir}`)
    }
  }
}

const buildTargets = buildHostOnly ? [getHostBuildTarget()] : targets

if (skipBunWebgpuInstall) {
  console.log(`Skipping bun-webgpu install; assuming bun-webgpu@${bunWebgpuVersion} is already prepared`)
} else {
  console.log("Installing bun-webgpu for all platforms...")
  await Bun.$`bun install --os="*" --cpu="*" bun-webgpu@${bunWebgpuVersion}`
  console.log(`✅ bun-webgpu@${bunWebgpuVersion} installed for all platforms`)
}

if (usePrebuiltArtifacts) {
  console.log("Using prebuilt native opentui packages from CI artifacts...")
  verifyNativePackages(buildTargets)
  console.log("✅ Prebuilt native opentui packages verified")
} else if (buildHostOnly) {
  console.log("Refreshing the host native opentui package...")
  await Bun.$`bun ${join(coreRoot, "scripts", "build.ts")} --native`
  verifyNativePackages(buildTargets)
  console.log("✅ Host native package refreshed")
} else if (canBuildLocalNativePackagesForAllTargets) {
  console.log("Building local native opentui packages for all platforms...")
  await Bun.$`bun ${join(coreRoot, "scripts", "build.ts")} --native --all`
  verifyNativePackages(buildTargets)
  console.log("✅ Local native opentui packages refreshed")
} else {
  throw new Error(
    "Full examples builds require macOS so current-source darwin native packages can be built. Use `bun run build:host` for a local host-only build.",
  )
}
console.log()

console.log(`Building examples executable for all platforms...`)
console.log(`Output directory: ${distDir}`)
console.log()

let successCount = 0
let failCount = 0

for (const { platform: targetPlatform, arch: targetArch } of buildTargets) {
  const exeName = targetPlatform === "windows" ? "opentui-examples.exe" : "opentui-examples"
  const outfile = join(distDir, `${targetPlatform}-${targetArch}`, exeName)
  const outDir = dirname(outfile)

  mkdirSync(outDir, { recursive: true })

  console.log(`Building for ${targetPlatform}-${targetArch}...`)

  try {
    const buildResult = await Bun.build({
      tsconfig: join(packageRoot, "tsconfig.json"),
      sourcemap: "external",
      plugins: [workspaceAliasPlugin],
      compile: {
        target: `bun-${targetPlatform}-${targetArch}` as any,
        outfile,
        execArgv: [`--user-agent=opentui-examples/${version}`, `--env-file=""`, `--`],
        windows: {},
      },
      entrypoints: [join(examplesDir, "index.ts")],
      define: {
        OPENCODE_VERSION: `'${version}'`,
        OPENCODE_CHANNEL: `'dev'`,
      },
    })

    if (buildResult.logs.length > 0) {
      console.log(`  Build logs for ${targetPlatform}-${targetArch}:`)
      buildResult.logs.forEach((log) => {
        if (log.level === "error") {
          console.error("  ERROR:", log.message)
        } else if (log.level === "warning") {
          console.warn("  WARNING:", log.message)
        } else {
          console.log("  INFO:", log.message)
        }
      })
    }

    if (buildResult.success) {
      console.log(`  ✅ Successfully built: ${outfile}`)

      // Make it executable on Unix-like systems
      if (targetPlatform !== "windows") {
        chmodSync(outfile, 0o755)
      }

      successCount++
    } else {
      console.error(`  ❌ Build failed for ${targetPlatform}-${targetArch}`)
      failCount++
    }
  } catch (error) {
    console.error(`  ❌ Build error for ${targetPlatform}-${targetArch}:`, error)
    failCount++
  }

  console.log()
}

console.log("=".repeat(60))
console.log(`Build complete: ${successCount} succeeded, ${failCount} failed`)
console.log(`Output directory: ${distDir}`)

if (failCount > 0) {
  process.exit(1)
}
