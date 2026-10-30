import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { availableParallelism } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Builds the minimal static FFmpeg that native video links. See src/vendor/ffmpeg/README.md.
const VERSION = "9.0.2"
const SHA256 = "8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e"
const URL = `https://ffmpeg.org/releases/ffmpeg-${VERSION}.tar.xz`
const ZLIB_VERSION = "1.3.2"
const ZLIB_SHA256 = "bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16"
const ZLIB_URL = `https://zlib.net/fossils/zlib-${ZLIB_VERSION}.tar.gz`
// FFmpeg's x86_64 SIMD assembly needs NASM on the build host.
const NASM_VERSION = "3.02"
const NASM_SHA256 = "87336eba53b4acfe917424ab5d500d2b0054d9f5148d35c2273ccf2cfb712f0d"
const NASM_URL = `https://www.nasm.us/pub/nasm/releasebuilds/${NASM_VERSION}/nasm-${NASM_VERSION}.tar.xz`
const BUILD_REVISION = "5"
// Must match the macOS minimum of the Zig-built library so the static FFmpeg
// objects never carry a newer availability floor than the final link.
const MACOS_VERSION_MIN = "13.0"
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cache = join(root, ".cache", "ffmpeg")
const archive = join(cache, "downloads", `ffmpeg-${VERSION}.tar.xz`)
const source = join(cache, "sources", `ffmpeg-${VERSION}`)
const zlibArchive = join(cache, "downloads", `zlib-${ZLIB_VERSION}.tar.gz`)
const zlibSource = join(cache, "sources", `zlib-${ZLIB_VERSION}`)
const nasmArchive = join(cache, "downloads", `nasm-${NASM_VERSION}.tar.xz`)
const nasm = join(cache, "tools", `nasm-${NASM_VERSION}`, "nasm")

interface Target {
  // Matches the output names in build.zig.
  name: string
  zig: string
  arch: "x86_64" | "aarch64"
  os: "darwin" | "linux" | "mingw32"
}

const targets: Target[] = [
  { name: "x86_64-linux", zig: "x86_64-linux-gnu.2.17", arch: "x86_64", os: "linux" },
  { name: "aarch64-linux", zig: "aarch64-linux-gnu.2.17", arch: "aarch64", os: "linux" },
  { name: "x86_64-linux-musl", zig: "x86_64-linux-musl", arch: "x86_64", os: "linux" },
  { name: "aarch64-linux-musl", zig: "aarch64-linux-musl", arch: "aarch64", os: "linux" },
  { name: "x86_64-macos", zig: "x86_64-macos", arch: "x86_64", os: "darwin" },
  { name: "aarch64-macos", zig: "aarch64-macos", arch: "aarch64", os: "darwin" },
  { name: "x86_64-windows", zig: "x86_64-windows-gnu", arch: "x86_64", os: "mingw32" },
  { name: "aarch64-windows", zig: "aarch64-windows-gnu", arch: "aarch64", os: "mingw32" },
]

function run(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed`)
  return result.stdout.trim()
}

function digest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

async function download(url: string, path: string, sha256: string, name: string): Promise<void> {
  // Source hosts reset connections now and then; retry before failing the build.
  for (let attempt = 1; !existsSync(path) || digest(path) !== sha256; attempt++) {
    try {
      const response = await fetch(url)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      writeFileSync(path, new Uint8Array(await response.arrayBuffer()))
      break
    } catch (error) {
      if (attempt === 4) throw new Error(`Failed to download ${name} from ${url}`, { cause: error })
      console.warn(`Download of ${name} failed (${error}); retrying in ${attempt * 5} s`)
      await new Promise((resolve) => setTimeout(resolve, attempt * 5_000))
    }
  }
  if (digest(path) !== sha256) throw new Error(`${name} archive SHA-256 mismatch`)
}

async function prepareSource(): Promise<void> {
  mkdirSync(dirname(archive), { recursive: true })
  mkdirSync(dirname(source), { recursive: true })
  await download(URL, archive, SHA256, "FFmpeg")
  if (!existsSync(source)) run("tar", ["-xf", archive, "-C", dirname(source)])
  await download(ZLIB_URL, zlibArchive, ZLIB_SHA256, "zlib")
  if (!existsSync(zlibSource)) run("tar", ["-xf", zlibArchive, "-C", dirname(zlibSource)])
  await download(NASM_URL, nasmArchive, NASM_SHA256, "NASM")
}

function buildNasm(): void {
  if (existsSync(nasm)) return
  console.log(`Building NASM ${NASM_VERSION}...`)
  const build = join(cache, "build", "nasm")
  rmSync(build, { recursive: true, force: true })
  mkdirSync(build, { recursive: true })
  run("tar", ["-xf", nasmArchive, "-C", build])
  const sourceDir = join(build, `nasm-${NASM_VERSION}`)
  const cc = process.platform === "darwin" ? "xcrun clang" : "zig cc"
  // Zig's clang rejects NASM's __DATE__ version string by default.
  run(join(sourceDir, "configure"), [`CC=${cc}`, "CFLAGS=-O2 -Wno-date-time"], sourceDir)
  run("make", [`-j${Math.max(1, availableParallelism())}`, "nasm"], sourceDir)
  mkdirSync(dirname(nasm), { recursive: true })
  writeFileSync(nasm, readFileSync(join(sourceDir, "nasm")))
  chmodSync(nasm, 0o755)
}

function buildZlib(target: Target, cc: string, prefix: string): void {
  const build = join(cache, "build", target.name, "zlib")
  mkdirSync(build, { recursive: true })
  mkdirSync(join(prefix, "include"), { recursive: true })
  mkdirSync(join(prefix, "lib"), { recursive: true })
  const sources = ["adler32", "compress", "crc32", "deflate", "infback", "inffast", "inflate", "inftrees", "trees"]
  const objects = [...sources, "uncompr", "zutil"].map((file) => {
    const object = join(build, `${file}.o`)
    run(cc, [
      "-O3",
      "-fvisibility=hidden",
      ...(target.os === "mingw32" ? [] : ["-fPIC"]),
      `-I${zlibSource}`,
      "-c",
      join(zlibSource, `${file}.c`),
      "-o",
      object,
    ])
    return object
  })
  run("zig", ["ar", "rcs", join(prefix, "lib", "libz.a"), ...objects])
  for (const header of ["zlib.h", "zconf.h"]) {
    writeFileSync(join(prefix, "include", header), readFileSync(join(zlibSource, header)))
  }
}

// The library target and the test target: Linux tests link musl executables (see build.zig).
function hostTargets(): Target[] {
  const platform = { darwin: "macos", win32: "windows", linux: "linux" }[process.platform as string]
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch as string]
  if (!platform || !arch) throw new Error(`Unsupported FFmpeg build host: ${process.platform}-${process.arch}`)
  const names = platform === "linux" ? [`${arch}-linux`, `${arch}-linux-musl`] : [`${arch}-${platform}`]
  return names.map((name) => targets.find((target) => target.name === name)!)
}

function prefixOf(target: Target): string {
  return join(cache, "prefix", target.name)
}

function isBuilt(target: Target): boolean {
  const marker = join(prefixOf(target), "opentui-build")
  return (
    existsSync(join(prefixOf(target), "lib", "libavcodec.a")) &&
    existsSync(marker) &&
    readFileSync(marker, "utf8") === BUILD_REVISION
  )
}

function buildTarget(target: Target): void {
  if (isBuilt(target)) return
  console.log(`Building FFmpeg ${VERSION} for ${target.name}...`)
  const prefix = prefixOf(target)
  rmSync(prefix, { recursive: true, force: true })
  const build = join(cache, "build", target.name)
  const tools = join(cache, "toolchains", target.name)
  rmSync(build, { recursive: true, force: true })
  mkdirSync(build, { recursive: true })
  mkdirSync(tools, { recursive: true })

  const sdk = target.os === "darwin" ? run("xcrun", ["--sdk", "macosx", "--show-sdk-path"]) : ""
  const cc = join(tools, "cc")
  writeFileSync(
    cc,
    target.os === "darwin"
      ? `#!/bin/sh\nexec xcrun --sdk macosx clang -arch ${target.arch === "aarch64" ? "arm64" : "x86_64"} -isysroot "${sdk}" -mmacosx-version-min=${MACOS_VERSION_MIN} "$@"\n`
      : target.os === "mingw32"
        ? `#!/bin/bash\nargs=()\nfor arg in "$@"; do\n  if [[ "$arg" == "-Wl,--pic-executable,-e,mainCRTStartup" ]]; then arg="-Wl,-e,mainCRTStartup"; fi\n  args+=("$arg")\ndone\nexec zig cc -target ${target.zig} "\${args[@]}"\n`
        : `#!/bin/sh\nexec zig cc -target ${target.zig} "$@"\n`,
  )
  chmodSync(cc, 0o755)
  buildZlib(target, cc, prefix)
  if (target.arch === "x86_64") buildNasm()

  const configure = [
    `--prefix=${prefix}`,
    "--disable-everything",
    "--disable-autodetect",
    "--disable-programs",
    "--disable-doc",
    "--disable-debug",
    "--disable-network",
    "--disable-avdevice",
    "--disable-avfilter",
    "--disable-encoders",
    "--disable-muxers",
    "--disable-indevs",
    "--disable-outdevs",
    "--disable-hwaccels",
    "--disable-filters",
    "--disable-bzlib",
    "--disable-iconv",
    "--disable-lzma",
    "--enable-zlib",
    "--disable-gpl",
    "--disable-version3",
    "--disable-nonfree",
    "--enable-static",
    "--disable-shared",
    "--enable-small",
    "--enable-demuxer=mov",
    "--enable-decoder=h264,aac",
    "--enable-parser=h264,aac",
    "--enable-protocol=file",
    "--enable-swscale",
    "--enable-swresample",
    "--enable-cross-compile",
    `--cc=${cc}`,
    "--ar=zig ar",
    "--ranlib=zig ranlib",
    `--arch=${target.arch}`,
    `--target-os=${target.os}`,
    `--extra-cflags=-Os -ffunction-sections -fdata-sections -fvisibility=hidden -I${join(prefix, "include")}`,
    `--extra-ldflags=-L${join(prefix, "lib")}`,
    "--extra-libs=-lz",
    // VideoToolbox ships with macOS and needs no extra runtime dependencies.
    ...(target.os === "darwin" ? ["--enable-videotoolbox", "--enable-hwaccel=h264_videotoolbox"] : []),
    ...(target.arch === "x86_64" ? [`--x86asmexe=${nasm}`] : []),
    // On mingw this only defines PIC, so x86_64 inline asm uses RIP-relative addressing instead of
    // 32-bit absolute relocations that truncate when Windows loads the image above 4 GiB.
    "--enable-pic",
    ...(target.os === "mingw32" ? ["--disable-pthreads", "--enable-w32threads"] : ["--enable-pthreads"]),
    ...(sdk ? [`--sysroot=${sdk}`] : []),
  ]
  run(join(source, "configure"), configure, build)
  if (target.os === "linux") {
    const configPath = join(build, "config.h")
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf8").replace("#define HAVE_SYSCTL 1", "#define HAVE_SYSCTL 0"),
    )
  }
  run("make", [`-j${Math.max(1, availableParallelism())}`], build)
  run("make", ["install"], build)
  installObjects(build, prefix)
  writeFileSync(join(prefix, "opentui-build"), BUILD_REVISION)
}

// Zig stores static archives inside libopentui.a as nested members that other linkers cannot read, so
// build.zig links these objects instead. objects.txt lists them relative to the prefix.
function installObjects(build: string, prefix: string): void {
  const objects: string[] = []
  for (const [library, directory] of [
    ["libavformat", "libavformat"],
    ["libavcodec", "libavcodec"],
    ["libswscale", "libswscale"],
    ["libswresample", "libswresample"],
    ["libavutil", "libavutil"],
    ["libz", "zlib"],
  ]) {
    // Archive members carry only base names. The build tree also holds host tool objects, such as aarch64/ops_asmgen.o.
    const members = run("zig", ["ar", "t", join(prefix, "lib", `${library}.a`)])
      .split(/\r?\n/)
      .sort()
    const files = readdirSync(join(build, directory), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".o") && members.includes(basename(file)))
      .sort()
    // Every member must map to exactly one object, so a duplicate base name cannot pick the wrong file.
    const names = files.map((file) => basename(file)).sort()
    if (members.join("\n") !== names.join("\n")) throw new Error(`${library} objects do not match its archive`)
    for (const file of files) {
      const object = join("objects", library, file)
      mkdirSync(dirname(join(prefix, object)), { recursive: true })
      copyFileSync(join(build, directory, file), join(prefix, object))
      objects.push(object.replaceAll("\\", "/"))
    }
  }
  writeFileSync(join(prefix, "objects.txt"), `${objects.join("\n")}\n`)
}

function selectTargets(): Target[] {
  if (process.argv.includes("--all")) return targets
  const requested = process.argv.find((argument) => argument.startsWith("--target="))?.slice("--target=".length)
  if (!requested) return hostTargets()
  const target = targets.find((candidate) => candidate.name === requested)
  if (!target) throw new Error(`Unknown FFmpeg target: ${requested}`)
  return [target]
}

// Concurrent builds would share build directories and prefixes, so one process builds at a time.
// Like scripts/prepare-zig-deps.sh, a lock left by a dead process must be removed by hand.
const lock = join(cache, "build.lock")
const lockWaitSeconds = 30 * 60

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function acquireLock(selected: Target[]): Promise<boolean> {
  mkdirSync(cache, { recursive: true })
  // Linking a complete owner file creates the lock with its pid atomically.
  const owner = `${lock}.${process.pid}`
  writeFileSync(owner, String(process.pid))
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        linkSync(owner, lock)
        process.on("exit", () => {
          if (existsSync(lock) && readFileSync(lock, "utf8") === String(process.pid)) rmSync(lock)
        })
        for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(1))
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
      if (selected.every(isBuilt)) return false
      let pid: number
      try {
        pid = Number.parseInt(readFileSync(lock, "utf8"), 10)
      } catch {
        continue
      }
      if (!processAlive(pid)) throw new Error(`Stale FFmpeg build lock; remove ${lock}`)
      if (attempt >= lockWaitSeconds) throw new Error("Timed out waiting for another FFmpeg build")
      if (attempt === 0) console.log("Waiting for another FFmpeg build...")
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  } finally {
    rmSync(owner, { force: true })
  }
}

const explicit = process.argv.some((argument) => argument === "--all" || argument.startsWith("--target="))
const selectedTargets = selectTargets()
if (!selectedTargets.every(isBuilt)) {
  // configure and make need a POSIX host. build.zig compiles video as unavailable without a prefix.
  if (process.platform === "win32") {
    const names = selectedTargets.map((target) => target.name).join(", ")
    const message =
      `FFmpeg cannot be built on Windows hosts. Cross-build ${names} on Linux or macOS with ` +
      "`bun scripts/build-ffmpeg.ts --target=<name>` in packages/native and copy its .cache/ffmpeg/prefix/<name> " +
      "directory to the same place here. CI publishes x86_64-windows as the ffmpeg-x86_64-windows artifact of Build Core."
    if (explicit) throw new Error(message)
    console.warn(`warning: ${message} Building without video.`)
  } else if (await acquireLock(selectedTargets)) {
    if (!selectedTargets.every(isBuilt)) await prepareSource()
    for (const target of selectedTargets) buildTarget(target)
  }
}
