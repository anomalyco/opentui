import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

interface PackageJson {
  name: string
  version: string
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const rootDir = resolve(__dirname, "..")

const packageJson: PackageJson = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"))

console.log(`Publishing ${packageJson.name}@${packageJson.version}...`)
console.log("Make sure you've run the pre-publish validation script first!")

const distDir = join(rootDir, "dist")
const isSnapshot = packageJson.version.includes("-snapshot") || /^0\.0\.0-\d{8}-[a-f0-9]{8}$/.test(packageJson.version)
const publishArgs = ["publish", "--access=public"]

if (isSnapshot) {
  publishArgs.push("--tag", "snapshot")
  console.log("  Publishing as snapshot (--tag snapshot)")
}

const publish: SpawnSyncReturns<Buffer> = spawnSync("npm", publishArgs, {
  cwd: distDir,
  stdio: "inherit",
})

if (publish.status !== 0) {
  console.error(`Failed to publish '${packageJson.name}@${packageJson.version}'.`)
  process.exit(1)
}

console.log(`Successfully published '${packageJson.name}@${packageJson.version}'`)
