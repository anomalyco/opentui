// Turns the checked ABI into packages/rust/crates/opentui-sys/src/generated.rs: repr(C) records, extern declarations,
// callback types, typed constants, and compile-time layout assertions. native-abi.ts writes and checks it.
import type { HeaderABI } from "./native-abi.js"

type Signature = HeaderABI["symbols"][string]

// The header hash that opentui-sys's build checks. Must match fnv1a64 in packages/rust/crates/opentui-sys/build.rs.
export function fnv1a64(bytes: Uint8Array): string {
  let hash = 0xcbf29ce484222325n
  for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn
  return `0x${hash.toString(16).padStart(16, "0")}`
}

const keywords = new Set(
  (
    "as async await break const continue crate dyn else enum extern false fn for gen if impl in let loop match mod " +
    "move mut pub ref return self Self static struct super trait true try type unsafe use where while abstract " +
    "become box do final macro override priv typeof unsized virtual yield"
  ).split(" "),
)

// Rust cannot spell these four as raw identifiers.
const unrawable = new Set(["self", "Self", "super", "crate"])
const ident = (name: string) => (!keywords.has(name) ? name : unrawable.has(name) ? `${name}_` : `r#${name}`)

const cTypeName = /^(const|void|float|double|char|u?int(8|16|32|64)_t|ot_[a-z0-9_]+)$/

export function generateRustABI(abi: HeaderABI, headerBytes: Uint8Array): string {
  const headerText = new TextDecoder().decode(headerBytes)
  const header = headerText
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, "")
    .replace(/^\s*#.*$/gm, "")

  const callbackAliases = new Map<string, string>()
  for (const [name, signature] of Object.entries(abi.callbacks)) {
    const key = `callback(${signature.args.join(",")})->${signature.returns}`
    if (callbackAliases.has(key)) {
      throw new Error(`ambiguous callback signature: ${key}`)
    }
    callbackAliases.set(key, name)
  }

  function rustType(type: string): string {
    if (type.startsWith("callback(")) {
      const alias = callbackAliases.get(type)
      if (alias === undefined) {
        throw new Error(`unknown callback type: ${type}`)
      }
      return alias
    }
    if (type.startsWith("*const ")) return `*const ${rustType(type.slice(7))}`
    if (type.startsWith("*")) return `*mut ${rustType(type.slice(1))}`
    const array = /^\[(\d+)\](.+)$/.exec(type)
    if (array) return `[${rustType(array[2]!)}; ${array[1]}]`
    if (/^[ui](8|16|32|64)$/.test(type) || type === "f32" || type === "f64") {
      return type
    }
    if (type === "void") return "c_void"
    if (/^ot_\w+$/.test(type)) return type
    throw new Error(`unsupported C ABI type: ${type}`)
  }

  // Parameter names come from the header text; the ABI description only has types.
  function parameterNames(params: string, types: string[], context: string): string[] {
    const parts = params.trim() === "void" || params.trim() === "" ? [] : params.split(",")
    if (parts.length !== types.length) {
      throw new Error(`${context}: header has ${parts.length} parameters, ABI has ${types.length}`)
    }
    const names = parts.map((part, index) => {
      const tokens = part
        .replace(/\[[^\]]*\]/g, "")
        .replace(/\*/g, " * ")
        .split(/\s+/)
        .filter(Boolean)
      const last = tokens.at(-1)
      if (tokens.length >= 2 && last !== undefined && last !== "*" && !cTypeName.test(last)) return last
      const type = rustType(types[index]!)
      if (type === "*mut ot_context") return "context"
      if (types[index]!.startsWith("callback(")) return "callback"
      const base = type.replace(/^(\*(const|mut) )+/, "").replace(/^ot_/, "")
      const prefix = type.startsWith("*mut") ? "out_" : ""
      return type.startsWith("*") ? `${prefix}${base === "u8" ? "bytes" : base}` : "arg"
    })
    const seen = new Map<string, number>()
    const total = new Map<string, number>()
    for (const name of names) total.set(name, (total.get(name) ?? 0) + 1)
    return names.map((name) => {
      if (total.get(name)! === 1) return ident(name)
      const count = (seen.get(name) ?? 0) + 1
      seen.set(name, count)
      return `${name}${count}`
    })
  }

  function prototype(name: string): { returns: string; params: string } {
    const match = new RegExp(`\\b([A-Za-z_][A-Za-z0-9_]*)\\s*\\b${name}\\s*\\(([^;]*?)\\)\\s*;`).exec(header)
    if (match === null) throw new Error(`missing header prototype: ${name}`)
    return { returns: match[1]!, params: match[2]! }
  }

  function callbackPrototype(name: string): string {
    const match = new RegExp(`typedef\\s+\\w+\\s*\\(\\s*\\*\\s*${name}\\s*\\)\\s*\\(([^;]*?)\\)\\s*;`).exec(header)
    if (match === null) {
      throw new Error(`missing header callback typedef: ${name}`)
    }
    return match[1]!
  }

  function returnType(spelled: string, type: string): string {
    if (type === "void") return ""
    return ` -> ${spelled === "ot_status" ? "ot_status" : rustType(type)}`
  }

  const args = (names: string[], signature: Signature) =>
    signature.args.map((type, index) => `${names[index]}: ${rustType(type)}`).join(", ")

  const lines: string[] = []
  lines.push(
    "// @generated from packages/native/include/opentui.h by packages/core/scripts/native-abi-rust.ts. Do not edit.",
    "// Regenerate with `bun run generate:abi` in packages/core.",
    "",
    "use core::ffi::c_void;",
    "",
    "/// FNV-1a 64-bit hash of the `opentui.h` these declarations were generated from.",
    "/// The build script rejects native artifacts whose header has a different hash.",
    `pub const OPENTUI_HEADER_FNV1A64: u64 = ${fnv1a64(headerBytes)};`,
    "",
    "pub type ot_status = i32;",
    "",
    "/// Opaque native Context. Only pointers to it cross the ABI.",
    "#[repr(C)]",
    "pub struct ot_context {",
    "    _data: [u8; 0],",
    "    _marker: core::marker::PhantomData<(*mut u8, core::marker::PhantomPinned)>,",
    "}",
    "",
  )

  // The ABI description has constant values only; the header spells 64-bit ones with UINT64_C, signed ones with INT32_C.
  const wideConstants = new Set([...headerText.matchAll(/^#define\s+(\w+)\s+UINT64_C\(/gm)].map((match) => match[1]))
  const signedConstants = new Set([...headerText.matchAll(/^#define\s+(\w+)\s+INT32_C\(/gm)].map((match) => match[1]))
  for (const [name, value] of Object.entries(abi.constants)) {
    const type = value < 0 || signedConstants.has(name) ? "i32" : wideConstants.has(name) ? "u64" : "u32"
    lines.push(`pub const ${name}: ${type} = ${value};`)
  }
  lines.push("")

  for (const [name, signature] of Object.entries(abi.callbacks)) {
    const names = parameterNames(callbackPrototype(name), signature.args, name)
    lines.push(
      `pub type ${name} = Option<unsafe extern "C" fn(${args(names, signature)})${returnType("", signature.returns)}>;`,
    )
  }
  lines.push("")

  const versioned = (fields: Record<string, unknown>) => "struct_size" in fields && "abi_version" in fields
  // True when the type's bytes are all field bytes, so viewing it as bytes never reads padding.
  const unpadded = (type: string): boolean => {
    const array = /^\[\d+\](.+)$/.exec(type)
    if (array) return unpadded(array[1]!)
    const nested = abi.layouts[type]
    if (nested === undefined) return /^([ui](8|16|32|64)|f32|f64)$/.test(type)
    let end = 0
    for (const field of Object.values(nested.fields)) {
      if (field.offset !== end || !unpadded(field.type)) return false
      end = field.offset + field.size
    }
    return end === nested.size
  }
  const floating = (type: string): boolean => {
    if (type === "f32" || type === "f64") return true
    const array = /^\[\d+\](.+)$/.exec(type)
    if (array) return floating(array[1]!)
    const nested = abi.layouts[type]
    return nested !== undefined && Object.values(nested.fields).some((field) => floating(field.type))
  }

  for (const [name, layout] of Object.entries(abi.layouts)) {
    const fields = Object.entries(layout.fields)
    const derives = ["Clone", "Copy", "Debug", "PartialEq"]
    if (!fields.some(([, field]) => floating(field.type))) {
      derives.push("Eq", "Hash")
    }
    lines.push("#[repr(C)]", `#[derive(${derives.join(", ")})]`, `pub struct ${name} {`)
    for (const [field, info] of fields) {
      lines.push(`    pub ${ident(field)}: ${rustType(info.type)},`)
    }
    lines.push("}", "")
    if (unpadded(name)) {
      lines.push(
        `// SAFETY: the record has no padding and only integer or float fields.`,
        `unsafe impl Pod for ${name} {}`,
        "",
      )
    }

    const assignments: string[] = []
    if (versioned(layout.fields)) {
      assignments.push(
        "value.struct_size = core::mem::size_of::<Self>() as u32;",
        "value.abi_version = OT_CONTEXT_ABI_VERSION;",
      )
    }
    // A draw record's embedded header carries the size of the complete record.
    if (layout.fields.header?.type === "ot_buffer_draw_header") {
      assignments.push(
        "value.header.struct_size = core::mem::size_of::<Self>() as u32;",
        "value.header.abi_version = OT_CONTEXT_ABI_VERSION;",
      )
    }
    lines.push(`impl Default for ${name} {`, "    fn default() -> Self {")
    lines.push(
      "        // SAFETY: every field is an integer, a float, or an array or record of them; all-zero is valid.",
    )
    if (assignments.length === 0) {
      lines.push("        unsafe { core::mem::zeroed() }")
    } else {
      lines.push("        let mut value: Self = unsafe { core::mem::zeroed() };")
      for (const assignment of assignments) lines.push(`        ${assignment}`)
      lines.push("        value")
    }
    lines.push("    }", "}", "")

    lines.push("const _: () = {")
    lines.push(`    assert!(core::mem::size_of::<${name}>() == ${layout.size});`)
    lines.push(`    assert!(core::mem::align_of::<${name}>() == ${layout.alignment});`)
    for (const [field, info] of fields) {
      lines.push(`    assert!(core::mem::offset_of!(${name}, ${ident(field)}) == ${info.offset});`)
    }
    lines.push("};", "")
  }

  lines.push('unsafe extern "C" {')
  for (const [name, signature] of Object.entries(abi.symbols)) {
    const spelled = prototype(name)
    const names = parameterNames(spelled.params, signature.args, name)
    lines.push(`    pub fn ${name}(${args(names, signature)})${returnType(spelled.returns, signature.returns)};`)
  }
  lines.push("}", "")
  return lines.join("\n")
}
