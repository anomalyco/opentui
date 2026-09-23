import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { requireNode26 } from "../../../scripts/node26.mjs"

const root = resolve(import.meta.dir, "..")
const temp = mkdtempSync(join(tmpdir(), "opentui-ssh-dist-"))
const nodePath = requireNode26()
const skipBuild = process.argv.includes("--skip-build")

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: 120_000 })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout
}

function pack(directory: string): string {
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", temp], directory)) as [
    { filename: string },
  ]
  return `file:${join(temp, packed[0].filename)}`
}

try {
  if (!skipBuild) run("bun", ["run", "build"], root)
  const distPackage = JSON.parse(readFileSync(join(root, "dist/package.json"), "utf8")) as {
    peerDependencies: { "@opentui/core": string }
  }
  const core = resolve(root, "../core")
  const nativeName = `@opentui/core-${process.platform}-${process.arch}`
  const native = join(core, "node_modules", nativeName)
  if (!existsSync(join(core, "dist/package.json")) || !existsSync(native)) {
    throw new Error("Matching Core/native artifacts are required. Run bun run build from the repository root first.")
  }
  const corePackage = JSON.parse(readFileSync(join(core, "dist/package.json"), "utf8")) as { version: string }
  const nativePackage = JSON.parse(readFileSync(join(native, "package.json"), "utf8")) as { version: string }
  if (
    corePackage.version !== distPackage.peerDependencies["@opentui/core"] ||
    nativePackage.version !== corePackage.version
  ) {
    throw new Error("SSH, Core, and native packed artifacts must have matching versions")
  }
  const nativeTarball = pack(native)
  writeFileSync(
    join(temp, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@opentui/core": pack(join(core, "dist")),
        "@opentui/ssh": pack(join(root, "dist")),
        [nativeName]: nativeTarball,
        "@types/node": "^24.0.0",
        ssh2: "^1.16.0",
        typescript: "^5",
      },
      overrides: { [nativeName]: nativeTarball },
    }),
  )
  copyFileSync(join(root, "scripts/dist-consumer.mjs"), join(temp, "consumer.mjs"))
  writeFileSync(
    join(temp, "consumer.ts"),
    'import { createServer, OutputPressureError, type ListenInfo } from "@opentui/ssh"; const server = createServer().serve(() => {}); const listen: Promise<ListenInfo> = server.listen(0); void listen; new OutputPressureError()\n',
  )
  run("bun", ["install", "--ignore-scripts"], temp)
  run(nodePath, ["--experimental-ffi", "--no-warnings", "consumer.mjs"], temp)
  run(
    join(temp, "node_modules/.bin/tsc"),
    [
      "--noEmit",
      "--skipLibCheck",
      "--target",
      "ESNext",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "consumer.ts",
    ],
    temp,
  )
  run("bun", ["consumer.mjs"], temp)
  console.log("Packed SSH Node and Bun consumers passed with real Core/native rendering, resize, denial, and close")
} finally {
  rmSync(temp, { recursive: true, force: true })
}
