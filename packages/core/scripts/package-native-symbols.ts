import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"
import { variants } from "./variants"

const root = resolve(import.meta.dir, "../../..")
const output = resolve(root, process.argv[2] ?? "artifacts/native-symbols")
const version = JSON.parse(readFileSync(join(root, "packages/core/package.json"), "utf8")).version
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
mkdirSync(output, { recursive: true })

for (const { platform, arch, abi } of variants) {
  const target = `${platform}-${arch}${abi ? `-${abi}` : ""}`
  const symbols = join(root, "packages/native/symbols", target)
  const native = join(root, "packages/core/node_modules/@opentui", `core-${target}`)
  const manifest = JSON.parse(readFileSync(join(symbols, "manifest.json"), "utf8"))
  if (
    manifest.version !== version ||
    manifest.commit !== commit ||
    manifest.preSigningSha256 !== hash(join(native, manifest.binary))
  ) {
    throw new Error(`Stale or mismatched release symbols: ${target}`)
  }
  for (const file of manifest.symbols) {
    if (hash(join(symbols, file.path)) !== file.sha256)
      throw new Error(`Symbol checksum mismatch: ${target}/${file.path}`)
  }
  for (const name of readdirSync(native).filter((name) => /^(LICENSE|PATENTS|AUTHORS)/.test(name))) {
    copyFileSync(join(native, name), join(symbols, name))
  }
  const archive = join(output, `native-symbols-${target}.zip`)
  rmSync(archive, { force: true })
  execFileSync("zip", ["-qr", archive, "."], { cwd: symbols, stdio: "inherit" })
  execFileSync("unzip", ["-tq", archive], { stdio: "inherit" })
  console.log(`Archived matching symbols: ${target}`)
}
