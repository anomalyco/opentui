import { spawnSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { requireNode26 } from "../../../scripts/node26.mjs"

const root = resolve(import.meta.dir, "..")
const temp = mkdtempSync(join(tmpdir(), "opentui-ssh-dist-"))
const nodePath = requireNode26()
const skipBuild = process.argv.includes("--skip-build")
let tarball: string | undefined

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout
}

try {
  if (!skipBuild) run("bun", ["run", "build"], root)
  const distPackage = JSON.parse(readFileSync(join(root, "dist/package.json"), "utf8")) as {
    peerDependencies: { "@opentui/core": string }
  }
  for (const file of readdirSync(join(root, "dist"))) {
    if (file.startsWith("opentui-ssh-") && file.endsWith(".tgz")) unlinkSync(join(root, "dist", file))
  }
  const packed = JSON.parse(run("npm", ["pack", "--json"], join(root, "dist"))) as [{ filename: string }]
  tarball = join(root, "dist", packed[0].filename)
  const coreStub = join(temp, "core-stub")
  mkdirSync(coreStub)
  writeFileSync(
    join(coreStub, "package.json"),
    JSON.stringify({
      name: "@opentui/core",
      version: distPackage.peerDependencies["@opentui/core"],
      type: "module",
      types: "./index.d.ts",
      exports: { ".": { types: "./index.d.ts", import: "./index.js" } },
    }),
  )
  writeFileSync(
    join(coreStub, "index.js"),
    'export const CliRenderEvents = { DESTROY: "destroy" }; export async function createCliRenderer(options) { return { width: options.width, height: options.height, resize(width, height) { this.width = width; this.height = height }, on() {}, destroy() {} } }\n',
  )
  writeFileSync(
    join(coreStub, "index.d.ts"),
    'export declare const CliRenderEvents: { readonly DESTROY: "destroy" }; export interface CliRenderer {} export declare function createCliRenderer(): Promise<CliRenderer>\n',
  )
  writeFileSync(
    join(temp, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@opentui/core": "file:./core-stub",
        "@opentui/ssh": `file:${tarball}`,
        "@types/node": "^24.0.0",
        ssh2: "^1.16.0",
        typescript: "^5",
      },
    }),
  )
  writeFileSync(
    join(temp, "consumer.mjs"),
    `import { createServer, logging, ConfigError } from "@opentui/ssh"
import ssh2 from "ssh2"
const { Client } = ssh2
if (typeof createServer !== "function" || typeof logging !== "function" || typeof ConfigError !== "function") process.exit(1)
let handlerCalls = 0
const server = createServer({ startupBanner: false }).serve((session) => {
  handlerCalls++
  session.write("PACKED_SSH_OK")
  session.end()
})
const info = await server.listen(0)
if (!(info.port > 0)) process.exit(1)
const output = await new Promise((resolve, reject) => {
  const client = new Client()
  let data = ""
  client
    .on("ready", () => {
      client.shell((error, stream) => {
        if (error) return reject(error)
        stream.on("data", (chunk) => { data += chunk.toString() })
        stream.on("close", () => { client.end(); resolve(data) })
      })
    })
    .on("error", reject)
    .connect({ host: "127.0.0.1", port: info.port, username: "packed" })
})
if (handlerCalls !== 1 || !output.includes("PACKED_SSH_OK")) process.exit(1)
await server.close()
`,
  )
  writeFileSync(
    join(temp, "consumer.ts"),
    'import { createServer, type ListenInfo } from "@opentui/ssh"; const server = createServer().serve(() => {}); const listen: Promise<ListenInfo> = server.listen(0); void listen\n',
  )
  run("npm", ["install", "--ignore-scripts", "--no-package-lock"], temp)
  run(nodePath, ["consumer.mjs"], temp)
  run(
    join(temp, "node_modules/.bin/tsc"),
    ["--noEmit", "--target", "ESNext", "--module", "NodeNext", "--moduleResolution", "NodeNext", "consumer.ts"],
    temp,
  )
  run("bun", ["consumer.mjs"], temp)
  console.log("Packed SSH Node and Bun consumer smoke tests passed")
} finally {
  if (tarball && existsSync(tarball)) unlinkSync(tarball)
  rmSync(temp, { recursive: true, force: true })
}
