#!/usr/bin/env bun

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"
import { type BunPlugin } from "bun"
import { createSolidTransformPlugin } from "../scripts/solid-plugin.js"

type BuildTarget = {
  platform: "darwin" | "linux" | "windows"
  arch: "x64" | "arm64"
}

const ALL_TARGETS: BuildTarget[] = [
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "windows", arch: "x64" },
]

function normalizePlatform(platform: NodeJS.Platform): BuildTarget["platform"] | null {
  if (platform === "win32") {
    return "windows"
  }

  if (platform === "darwin" || platform === "linux") {
    return platform
  }

  return null
}

function getHostTarget(): BuildTarget {
  const platform = normalizePlatform(process.platform)
  if (!platform) {
    throw new Error(`Unsupported host platform: ${process.platform}`)
  }

  if (process.arch !== "x64" && process.arch !== "arm64") {
    throw new Error(`Unsupported host architecture: ${process.arch}`)
  }

  return {
    platform,
    arch: process.arch,
  }
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const packageRoot = resolve(__dirname, "..")
const distDir = join(__dirname, "dist")
const externalPluginSourceDir = join(__dirname, ".plugin")

const packageJson = JSON.parse(await Bun.file(join(packageRoot, "package.json")).text()) as { version?: string }
const version = packageJson.version ?? "0.0.0"

const args = process.argv.slice(2)
const buildAll = args.includes("--all")
const targets = buildAll ? ALL_TARGETS : [getHostTarget()]

const workspaceAliasPlugin: BunPlugin = {
  name: "workspace-alias",
  setup(build) {
    build.onResolve({ filter: /^@opentui\/solid$/ }, () => {
      return {
        path: join(packageRoot, "index.ts"),
      }
    })

    build.onResolve({ filter: /^@opentui\/core$/ }, () => {
      return {
        path: join(packageRoot, "..", "core", "src", "index.ts"),
      }
    })

    build.onResolve({ filter: /^@opentui\/core\/testing$/ }, () => {
      return {
        path: join(packageRoot, "..", "core", "src", "testing.ts"),
      }
    })

    build.onResolve({ filter: /^@opentui\/three$/ }, () => {
      return {
        path: join(packageRoot, "..", "three", "src", "index.ts"),
      }
    })

    build.onResolve({ filter: /^@opentui\/three\/runtime-modules$/ }, () => {
      return {
        path: join(packageRoot, "..", "three", "src", "runtime-modules.ts"),
      }
    })

    build.onResolve({ filter: /^@opentui\/solid\/runtime-plugin-support$/ }, () => {
      return {
        path: join(packageRoot, "scripts", "runtime-plugin-support.ts"),
      }
    })

    build.onResolve({ filter: /^@opentui\/solid\/runtime-plugin-support\/configure$/ }, () => {
      return {
        path: join(packageRoot, "scripts", "runtime-plugin-support-configure.ts"),
      }
    })
  },
}

mkdirSync(distDir, { recursive: true })

function syncExternalPluginFiles(targetDir: string): void {
  if (!existsSync(externalPluginSourceDir)) {
    return
  }

  const pluginOutDir = join(targetDir, ".plugin")
  rmSync(pluginOutDir, { recursive: true, force: true })
  cpSync(externalPluginSourceDir, pluginOutDir, { recursive: true })
}

console.log(`Building Solid examples executable${buildAll ? "s" : ""}...`)
console.log(`Output directory: ${distDir}`)
console.log()

let successCount = 0
let failCount = 0

for (const { platform, arch } of targets) {
  const exeName = platform === "windows" ? "opentui-solid-examples.exe" : "opentui-solid-examples"
  const nullConfigPath = platform === "windows" ? "NUL" : "/dev/null"
  const outfile = join(distDir, `${platform}-${arch}`, exeName)

  mkdirSync(dirname(outfile), { recursive: true })

  console.log(`Building for ${platform}-${arch}...`)

  try {
    const buildResult = await Bun.build({
      entrypoints: [join(__dirname, "index.tsx")],
      tsconfig: join(__dirname, "tsconfig.json"),
      sourcemap: "external",
      plugins: [workspaceAliasPlugin, createSolidTransformPlugin()],
      compile: {
        target: `bun-${platform}-${arch}` as any,
        outfile,
        execArgv: [
          `--user-agent=opentui-solid-examples/${version}`,
          `--config=${nullConfigPath}`,
          `--env-file=""`,
          `--`,
        ],
        windows: {},
      },
    })

    if (buildResult.logs.length > 0) {
      console.log(`  Build logs for ${platform}-${arch}:`)
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

    if (!buildResult.success) {
      console.error(`  ❌ Build failed for ${platform}-${arch}`)
      failCount++
      console.log()
      continue
    }

    if (platform !== "windows") {
      chmodSync(outfile, 0o755)
    }

    syncExternalPluginFiles(dirname(outfile))

    console.log(`  ✅ Successfully built: ${outfile}`)
    successCount++
  } catch (error) {
    console.error(`  ❌ Build error for ${platform}-${arch}:`, error)
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
