import { expect, test } from "bun:test"
import { dlopen, FFIType } from "bun:ffi"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { separateNativeSymbols } from "./native-symbols"

test.skipIf(process.platform !== "linux")(
  "release symbols resolve the distributed code without shipping in npm",
  () => {
    const root = mkdtempSync(join(tmpdir(), "opentui-symbols-"))
    try {
      const source = join(root, "fixture.c")
      const binary = join(root, "libfixture.so")
      writeFileSync(source, '__attribute__((visibility("default"))) int fixture(int n) { return n * 7; }\n')
      execFileSync("cc", ["-shared", "-fPIC", "-O2", "-g", "-Wl,--build-id=sha1", source, "-o", binary])
      const manifest = separateNativeSymbols({
        binary,
        symbolsDir: join(root, "symbols"),
        platform: "linux",
        target: "linux-x64",
        version: "0.0.0-test",
        commit: "fixture",
      })
      const sections = execFileSync("readelf", ["-SW", binary], { encoding: "utf8" })
      expect(sections).not.toContain(".debug_info")
      expect(sections).not.toContain(".symtab")
      expect(sections).toContain(".eh_frame")
      expect(sections).toContain(".gnu_debuglink")
      const debug = join(root, "symbols", "libfixture.so.debug")
      const address = execFileSync("nm", ["-D", "--defined-only", binary], { encoding: "utf8" }).split(" ")[0]
      expect(execFileSync("addr2line", ["-e", debug, address], { encoding: "utf8" })).toContain("fixture.c:1")
      expect(manifest.binaryIdentity).toMatch(/^[a-f0-9]{40}$/)
      expect(manifest.symbols.length).toBe(1)
      expect(JSON.parse(readFileSync(join(root, "symbols", "manifest.json"), "utf8"))).toEqual(manifest)
      const library = dlopen(binary, { fixture: { args: [FFIType.i32], returns: FFIType.i32 } })
      try {
        expect(library.symbols.fixture(6)).toBe(42)
      } finally {
        library.close()
      }
      const link = join(root, "debuglink")
      execFileSync("objcopy", [`--dump-section=.gnu_debuglink=${link}`, binary])
      const linkBytes = readFileSync(link)
      expect(linkBytes.subarray(0, linkBytes.indexOf(0)).toString()).toBe("libfixture.so.debug")
      let crc = 0xffffffff
      for (const byte of readFileSync(debug)) {
        crc ^= byte
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
      }
      expect(linkBytes.readUInt32LE(linkBytes.length - 4)).toBe((crc ^ 0xffffffff) >>> 0)
      expect(() =>
        separateNativeSymbols({
          binary,
          symbolsDir: join(root, "again"),
          platform: "linux",
          target: "linux-x64",
          version: "0.0.0-test",
          commit: "fixture",
        }),
      ).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== "linux")("a release without a binary identity is rejected before stripping", () => {
  const root = mkdtempSync(join(tmpdir(), "opentui-symbols-"))
  try {
    const source = join(root, "fixture.c")
    const binary = join(root, "fixture.so")
    writeFileSync(source, "int fixture(void) { return 42; }\n")
    execFileSync("cc", ["-shared", "-fPIC", "-O2", "-g", "-Wl,--build-id=none", source, "-o", binary])
    const before = readFileSync(binary)
    expect(() =>
      separateNativeSymbols({
        binary,
        symbolsDir: join(root, "symbols"),
        platform: "linux",
        target: "linux-x64",
        version: "test",
        commit: "fixture",
      }),
    ).toThrow("Missing ELF build ID")
    expect(readFileSync(binary)).toEqual(before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
