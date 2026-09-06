import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { format } from "oxfmt"
import {
  nativeAddressFields,
  nativePointerPolicies,
  type AddressFields,
  type PointerPolicies,
} from "./native-abi-pointers.js"
import { variants } from "./variants.js"

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const nativeRoot = resolve(scriptRoot, "../../native")
const outputPath = resolve(scriptRoot, "../src/native-abi.generated.ts")
const archNames: Record<string, string> = { x64: "x86_64", arm64: "aarch64" }
const osNames: Record<string, string> = { linux: "linux-musl", darwin: "macos", win32: "windows-gnu" }

interface Signature {
  args: string[]
  returns: string
}

export interface HeaderABI {
  symbols: Record<string, Signature>
  callbacks: Record<string, Signature>
  layouts: Record<
    string,
    {
      size: number
      alignment: number
      fields: Record<string, { offset: number; size: number; alignment: number; type: string }>
    }
  >
  constants: Record<string, number>
}

function zig(args: string[]): string {
  const result = spawnSync("zig", args, {
    cwd: nativeRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`zig ${args[0]} failed:\n${result.stderr}`)
  return result.stdout
}

function cType(type: string, callbacks: Map<string, string>): string {
  if (callbacks.has(type)) return callbacks.get(type)!
  if (type.startsWith("*const ")) return `${cType(type.slice(7), callbacks)} const *`
  if (type.startsWith("*")) return `${cType(type.slice(1), callbacks)} *`
  if (/^[ui](8|16|32|64)$/.test(type)) return `${type[0] === "u" ? "u" : ""}int${type.slice(1)}_t`
  if (type === "f32") return "float"
  if (type === "f64") return "double"
  if (type === "void" || /^ot_\w+$/.test(type)) return type
  throw new Error(`Unsupported C ABI type: ${type}`)
}

export function compileHeader(options: { header?: string; allTargets?: boolean } = {}): HeaderABI {
  const hostArch = archNames[process.arch]
  const hostOS = osNames[process.platform]
  if (!hostArch || !hostOS) throw new Error(`Unsupported ABI generator host: ${process.platform}-${process.arch}`)
  mkdirSync(join(nativeRoot, ".zig-cache"), { recursive: true })
  const temporary = mkdtempSync(join(nativeRoot, ".zig-cache/native-abi-"))
  try {
    const headerPath =
      options.header === undefined ? join(nativeRoot, "include/opentui.h") : join(temporary, "opentui.h")
    if (options.header !== undefined) writeFileSync(headerPath, options.header)
    const translatedPath = join(temporary, "header.zig")
    const target = `${hostArch}-${hostOS}`
    writeFileSync(translatedPath, zig(["translate-c", headerPath, "-target", target]))
    const json = zig([
      "run",
      "-fstrip",
      "-target",
      target,
      "--dep",
      "context_abi_c",
      `-Mroot=${join(scriptRoot, "native-abi.zig")}`,
      "-target",
      target,
      `-Mcontext_abi_c=${translatedPath}`,
    ])
    const abi: HeaderABI = JSON.parse(json)
    // Translate-C 0.16 drops some callback conventions, including inline parameter types.
    const callbacks = new Map<string, string>()
    const declarations = ['#include "opentui.h"']
    const prototype = (signature: Signature, name = "") => {
      const args = signature.args.map((type) => cType(type, callbacks)).join(", ") || "void"
      return `${cType(signature.returns, callbacks)} (*${name})(${args})`
    }
    for (const [index, [name, signature]] of Object.entries(abi.callbacks).entries()) {
      const alias = `opentui_ffi_callback_${index}`
      declarations.push(`typedef ${prototype(signature, alias)};`)
      declarations.push(
        `_Static_assert(__builtin_types_compatible_p(${name}, ${alias}), "Unsupported ABI calling convention or callback translation: ${name}");`,
      )
      callbacks.set(`callback(${signature.args.join(",")})->${signature.returns}`, alias)
    }
    for (const [name, signature] of Object.entries(abi.symbols)) {
      declarations.push(
        `_Static_assert(__builtin_types_compatible_p(__typeof__(&${name}), ${prototype(signature)}), "Unsupported ABI calling convention or function translation: ${name}");`,
      )
    }
    const callbacksPath = join(temporary, "prototypes.c")
    writeFileSync(callbacksPath, declarations.join("\n"))
    const checkPrototypes = (target: string) =>
      zig([
        "cc",
        "-c",
        "-std=c11",
        "-I",
        dirname(headerPath),
        "-target",
        target,
        callbacksPath,
        "-o",
        join(temporary, "callbacks.o"),
      ])
    checkPrototypes(target)
    if (options.allTargets) {
      writeFileSync(join(temporary, "expected.json"), json)
      const verifyPath = join(temporary, "verify.zig")
      writeFileSync(
        verifyPath,
        `const std = @import("std");
const abi = @import("abi");
comptime {
    @setEvalBranchQuota(2 * abi.json.len);
    if (!std.mem.eql(u8, abi.json, @embedFile("expected.json")))
        @compileError("Checked ABI differs from the generated host ABI");
}
`,
      )
      for (const variant of variants) {
        const arch = archNames[variant.arch]
        const os =
          variant.platform === "linux"
            ? `linux-${variant.abi ?? "gnu.2.17"}`
            : variant.platform === "darwin"
              ? "macos.13.0"
              : osNames[variant.platform]
        if (!arch || !os) throw new Error(`Unsupported ABI target: ${JSON.stringify(variant)}`)
        const crossTarget = `${arch}-${os}`
        checkPrototypes(crossTarget)
        writeFileSync(translatedPath, zig(["translate-c", headerPath, "-target", crossTarget]))
        zig([
          "build-obj",
          "-fno-emit-bin",
          "-target",
          crossTarget,
          "--dep",
          "abi",
          `-Mroot=${verifyPath}`,
          "--dep",
          "context_abi_c",
          "-target",
          crossTarget,
          `-Mabi=${join(scriptRoot, "native-abi.zig")}`,
          "-target",
          crossTarget,
          `-Mcontext_abi_c=${translatedPath}`,
        ])
      }
    }
    return abi
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export function serializeNativeABIAudit(
  abi: HeaderABI,
  policies: PointerPolicies = nativePointerPolicies,
  addressFields: AddressFields = nativeAddressFields,
): string {
  return JSON.stringify({ abi, pointerPolicies: policies, addressFields }, null, 2) + "\n"
}

export async function generateNativeABI(
  abi: HeaderABI,
  policies: PointerPolicies = nativePointerPolicies,
  addressFields: AddressFields = nativeAddressFields,
): Promise<string> {
  const used = new Set<string>()
  const signatures: Record<string, Record<string, Signature>> = { symbols: {}, callbacks: {} }
  for (const group of ["symbols", "callbacks"] as const) {
    for (const [name, signature] of Object.entries(abi[group])) {
      const convert = (type: string, position: number | "returns"): string => {
        const callback = type.startsWith("callback(")
        if (!type.startsWith("*") && !callback) {
          if (!["void", "u8", "i8", "u16", "i16", "u32", "i32", "u64", "i64", "f32", "f64"].includes(type)) {
            throw new Error(`Unsupported FFI type: ${name} ${position}: ${type}`)
          }
          return type
        }
        const label = `${name} argument ${position}`
        const policy = policies[name]?.[position]
        if (!policy) throw new Error(`Missing pointer policy: ${label} (${type})`)
        if (
          policy.ffi === "buffer" &&
          (policy.nullable !== "never" || policy.retention !== "call" || policy.source !== "view")
        ) {
          throw new Error(`Invalid transient buffer policy: ${label}`)
        }
        if (callback !== (policy.source === "callback")) throw new Error(`Callback policy mismatch: ${label}`)
        if (position === "returns" && policy.ffi !== "ptr") throw new Error(`Pointer returns must use ptr: ${label}`)
        used.add(label)
        return policy.ffi
      }
      signatures[group][name] = { args: signature.args.map(convert), returns: convert(signature.returns, "returns") }
    }
  }
  for (const [name, positions] of Object.entries(policies)) {
    for (const position of Object.keys(positions)) {
      const label = `${name} argument ${position}`
      if (!used.has(label)) throw new Error(`Unused pointer policy: ${label}`)
    }
  }
  for (const [name, record] of Object.entries(abi.layouts)) {
    for (const [field, info] of Object.entries(record.fields)) {
      if (info.type.includes("*") || info.type.includes("callback(")) {
        throw new Error(`ABI record pointer needs an explicit ownership policy: ${name}.${field}`)
      }
    }
  }
  for (const [name, fields] of Object.entries(addressFields)) {
    for (const [field, policy] of Object.entries(fields)) {
      if (abi.layouts[name]?.fields[field]?.type !== policy.type)
        throw new Error(`Address field drift: ${name}.${field}`)
    }
  }
  for (const [name, value] of Object.entries(abi.constants)) {
    if (!Number.isSafeInteger(value)) throw new Error(`ABI constant needs bigint support: ${name}`)
  }
  // Audit the complete compiler ABI and ownership, including pointees erased by ptr/buffer.
  const fingerprint = createHash("sha256")
    .update(serializeNativeABIAudit(abi, policies, addressFields))
    .digest("hex")
  const exports = {
    nativeSymbols: signatures.symbols,
    nativeCallbacks: signatures.callbacks,
    nativeLayouts: abi.layouts,
    nativeConstants: abi.constants,
  }
  const source =
    "// Generated from packages/native/include/opentui.h and scripts/native-abi-pointers.ts.\n" +
    "// Run `bun run generate:abi` in packages/core. Do not edit.\n" +
    "// Inspect audit input: bun scripts/native-abi.ts --audit\n" +
    `// ABI audit SHA-256: ${fingerprint}\n\n` +
    Object.entries(exports)
      .map(([name, value]) => `export const ${name} = ${JSON.stringify(value)} as const\n`)
      .join("\n")
  const formatted = await format(outputPath, source, { semi: false, printWidth: 120 })
  if (formatted.errors.length) throw new Error(`Cannot format generated ABI: ${JSON.stringify(formatted.errors)}`)
  return formatted.code
}

export function verifyNativeABI(generated: string): void {
  if (readFileSync(outputPath, "utf8") !== generated) {
    throw new Error(
      "native-abi.generated.ts is stale; run bun run generate:abi in packages/core.\n" +
        "Review ../native/include/opentui.h and scripts/native-abi-pointers.ts changes; " +
        "inspect compiler ABI and ownership with bun scripts/native-abi.ts --audit.",
    )
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== "--check" && arg !== "--all-targets" && arg !== "--audit"))
    throw new Error("Expected --check, --all-targets and/or --audit")
  const abi = compileHeader({ allTargets: args.includes("--all-targets") })
  const generated = await generateNativeABI(abi)
  if (args.includes("--check")) verifyNativeABI(generated)
  else if (!args.includes("--audit")) writeFileSync(outputPath, generated)
  if (args.includes("--audit")) process.stdout.write(serializeNativeABIAudit(abi))
  else
    console.log(`Checked ABI: ${Object.keys(abi.symbols).length} symbols, ${Object.keys(abi.layouts).length} records`)
}
