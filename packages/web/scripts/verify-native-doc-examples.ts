import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import xterm, { type Terminal } from "@xterm/headless"
import { requireNode26 } from "../../../scripts/node26.mjs"

const root = resolve(import.meta.dir, "../../..")
const native = join(root, "packages/native")
const core = join(root, "packages/core")
const library = join(native, "lib/x86_64-linux")

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("The native documentation examples currently require Linux x86_64 glibc")
}

const node = requireNode26()
const work = await mkdtemp(join(tmpdir(), "opentui-native-docs-"))
const env = {
  ...process.env,
  OTUI_ASSET_ROOT: join(core, "node_modules"),
  OPENTUI_LIB_DIR: library,
  LD_LIBRARY_PATH: [library, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
}

function run(command: string[], cwd = work, exitCode = 0, input?: string) {
  const result = spawnSync(command[0], command.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    input,
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  if (result.error) throw result.error
  assert.equal(result.status, exitCode, `${command.join(" ")}\n${result.stdout}\n${result.stderr}`)
  return result
}

async function code(page: string, language: string, tag?: string): Promise<string> {
  const source = await readFile(join(root, `packages/web/src/content/docs/native/${page}.mdx`), "utf8")
  const blocks = [...source.matchAll(/^```(\w+)([^\n]*)\n([\s\S]*?)^```\s*$/gm)].filter(
    (block) => block[1] === language && (!tag || block[2].trim().split(/\s+/).includes(tag)),
  )
  assert.ok(blocks.length, `${page}: missing ${language} ${tag ?? ""} example`)
  return blocks.map((block) => block[3]).join("\n")
}

function captureFrame(terminal: Terminal): string {
  return `${Array.from({ length: 3 }, (_, y) =>
    terminal.buffer.active.getLine(terminal.buffer.active.viewportY + y)?.translateToString(false, 0, 12),
  ).join("\n")}\n`
}

async function checkFrames(directory: string, page = "overview") {
  const terminal = new xterm.Terminal({ cols: 12, rows: 3, scrollback: 0, allowProposedApi: true })
  try {
    for (const name of ["hello", "ready"]) {
      const bytes = await readFile(join(directory, `${name}.ansi`))
      assert.ok(bytes.length, `${directory}: missing ${name} output`)
      await new Promise<void>((resolve) => terminal.write(bytes, resolve))
      assert.equal(captureFrame(terminal), await code(page, "text", `frame=${name}`), `${directory}: ${name} screen`)
    }
  } finally {
    terminal.dispose()
  }
}

async function checkPreview(directory: string) {
  await writeFile(join(directory, "preview.sh"), await code("frames", "bash", "example=preview"))
  const output = run(["script", "-q", "-e", "-c", "bash ./preview.sh", "/dev/null"], directory, 0, "\n\n").stdout
  const terminal = new xterm.Terminal({ cols: 80, rows: 24, scrollback: 0, allowProposedApi: true })
  try {
    await new Promise<void>((resolve) => terminal.write("Previous screen", resolve))
    let offset = 0
    for (const [name, prompt] of [
      ["hello", "Enter: show Ready"],
      ["ready", "Enter: return to shell"],
    ]) {
      const end = output.indexOf(prompt, offset)
      assert.ok(end > offset, `Preview did not reach ${name}`)
      await new Promise<void>((resolve) => terminal.write(output.slice(offset, end), resolve))
      assert.equal(terminal.buffer.active.type, "alternate")
      assert.equal(captureFrame(terminal), await code("overview", "text", `frame=${name}`))
      offset = end
    }
    await new Promise<void>((resolve) => terminal.write(output.slice(offset), resolve))
    assert.equal(terminal.buffer.active.type, "normal")
    assert.equal(terminal.buffer.active.getLine(0)?.translateToString(true), "Previous screen")
  } finally {
    terminal.dispose()
  }
}

async function checkWriteFailure(executable: string, name: string) {
  const directory = join(work, `${name}-write-failure`)
  await mkdir(directory)
  await symlink("/dev/full", join(directory, "hello.ansi"))
  const result = run([executable], directory, 1)
  assert.doesNotMatch(
    result.stderr,
    /ContextBusy|native cleanup failed|panic|ot_(session_cancel|context_destroy) returned/i,
    `${name}: failed cleanup`,
  )
}

async function runC(name: string, source: string, page = "overview") {
  const directory = join(work, name)
  await mkdir(directory)
  await writeFile(join(directory, "native-hello.c"), source)
  const executable = join(directory, "native-hello")
  run([
    "cc",
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    `-I${library}`,
    join(directory, "native-hello.c"),
    `-L${library}`,
    `-Wl,-rpath,${library}`,
    "-lopentui",
    "-o",
    executable,
  ])
  run([executable], directory)
  await checkFrames(directory, page)
  await checkWriteFailure(executable, name)
  return directory
}

try {
  const cParts = await Promise.all(
    ["setup", "nodes", "update", "submit", "output"].map((part) => code("c", "c", `example=${part}`)),
  )
  const cDir = await runC("c", cParts.join("\n"))
  console.log("PASS: C tutorial renders both screens and handles a failed write")
  await checkPreview(cDir)
  console.log("PASS: authored terminal preview shows both frames and restores the previous screen")

  const hookProgram = [
    cParts[0],
    cParts[1],
    await code("c", "c", "example=register"),
    cParts[2],
    await code("c", "c", "example=hook-submit"),
    cParts[4],
  ].join("\n")
  await runC("hooks", hookProgram, "c")
  console.log("PASS: C frame-step extension draws the host mark in both frames and handles a failed write")

  const rustDir = join(work, "rust")
  await mkdir(join(rustDir, "src"), { recursive: true })
  await writeFile(join(rustDir, "Cargo.toml"), (await code("rust", "toml")).replaceAll("/path/to/opentui", root))
  await writeFile(join(rustDir, "src/main.rs"), await code("rust", "rust"))
  const build = run(
    ["cargo", "build", "--offline", "--quiet", "--target-dir", join(rustDir, "target"), "--message-format=json"],
    rustDir,
  )
  const executable = build.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find(
      (message) =>
        message.reason === "compiler-artifact" && message.target.name === "native-hello" && message.executable,
    )?.executable
  assert.equal(typeof executable, "string", "Cargo did not report the native-hello executable")
  run([executable], rustDir)
  await checkFrames(rustDir)
  await checkWriteFailure(executable, "rust")
  console.log("PASS: external Rust consumer renders both screens and handles a failed write")

  const zigDir = join(work, "zig")
  const hello = join(native, "examples/hello")
  await mkdir(join(zigDir, "src"), { recursive: true })
  await writeFile(join(zigDir, "build.zig"), await readFile(join(hello, "build.zig"), "utf8"))
  await writeFile(
    join(zigDir, "build.zig.zon"),
    (await readFile(join(hello, "build.zig.zon"), "utf8")).replace('"../.."', JSON.stringify(relative(zigDir, native))),
  )
  await writeFile(join(zigDir, "src/main.zig"), await code("zig", "zig", "example=scene"))
  await writeFile(join(zigDir, "src/acceptance_test.zig"), await code("zig", "zig", "example=buffer"))
  run(["zig", "build", "run"], zigDir)
  await checkFrames(zigDir)
  await checkWriteFailure(join(zigDir, "zig-out/bin/opentui-hello"), "zig")
  run(["zig", "build", "test", "--summary", "all"], zigDir)
  console.log("PASS: Zig tutorial renders both screens, handles a failed write, and tests owned buffer access")

  await mkdir(join(work, "node_modules/@opentui"), { recursive: true })
  await symlink(core, join(work, "node_modules/@opentui/core"), "dir")
  await symlink(join(core, "node_modules/web-tree-sitter"), join(work, "node_modules/web-tree-sitter"), "dir")
  await writeFile(join(work, "package.json"), JSON.stringify({ type: "module" }))

  const files: string[] = []
  for (const name of ["hook", "resource"]) {
    const output = await code("core", "text", `example=${name}-output`)
    const file = join(work, `core-${name}.ts`)
    files.push(file)
    await writeFile(file, await code("core", "typescript", `example=${name}`))
    assert.equal(run([process.execPath, file]).stdout, output, `${name}: Bun output`)

    const bundle = await Bun.build({
      entrypoints: [file],
      outdir: join(work, "node"),
      target: "node",
      external: ["web-tree-sitter", "@opentui/core/parser.worker", "*.wasm", "*.scm"],
    })
    assert.ok(bundle.success, `${name}: ${bundle.logs.join("\n")}`)
    assert.equal(
      run([node, "--experimental-ffi", "--disable-warning=ExperimentalWarning", join(work, "node", `core-${name}.js`)])
        .stdout,
      output,
      `${name}: Node output`,
    )
    console.log(`PASS: Core ${name} example on Bun and Node`)
  }

  await writeFile(
    join(work, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "NodeNext",
        strict: true,
        skipLibCheck: true,
        noEmit: true,
        types: ["bun", "node"],
        typeRoots: [join(core, "node_modules/@types")],
      },
      files,
    }),
  )
  run([process.execPath, join(root, "packages/web/node_modules/typescript/bin/tsc"), "-p", join(work, "tsconfig.json")])
  console.log("PASS: complete Core examples type-check against workspace source")
} finally {
  await rm(work, { recursive: true, force: true })
}
