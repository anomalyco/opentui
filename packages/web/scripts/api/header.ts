import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { C_MODULE } from "../../src/lib/api-history"

// Extracts the API features of the C ABI: the declarations of opentui.h as written, so the features keep its
// typedef names and parameter names, with the field offsets and constant values of native-abi.generated.ts.
// `bun run check:abi` in packages/core derives that file from the header with the C compiler. Its names must
// match the declarations read here, so a declaration that this reader misses fails the extraction.

export const HEADER_FILE = "packages/native/include/opentui.h"
export const GENERATED_ABI_FILE = "packages/core/src/native-abi.generated.ts"

/** The parts of native-abi.generated.ts that the features use. */
export interface GeneratedAbi {
  nativeSymbols: Record<string, { args: string[] }>
  nativeCallbacks: Record<string, { args: string[] }>
  nativeLayouts: Record<string, { fields: Record<string, { offset: number }> }>
  nativeConstants: Record<string, number>
}

interface Header {
  functions: Array<{ name: string; params: string[]; returns: string }>
  callbacks: Array<{ name: string; params: string[]; returns: string }>
  records: Array<{ name: string; fields: Array<{ name: string; type: string }> }>
  /** Typedefs of other types, such as `int32_t` or an incomplete struct, as C type names. */
  types: Array<{ name: string; type: string }>
  constants: string[]
}

/** The API features of the C ABI in a source tree, or none when it has no header. */
export function headerFeaturesIn(root: string): string[] {
  const header = join(root, HEADER_FILE)
  if (!existsSync(header)) return []
  const generated = join(root, GENERATED_ABI_FILE)
  if (!existsSync(generated)) throw new Error(`${root} has ${HEADER_FILE} but not ${GENERATED_ABI_FILE}`)
  return headerFeatures(readFileSync(header, "utf8"), parseGeneratedAbi(readFileSync(generated, "utf8")))
}

/** The API features of the C ABI at a git ref, or undefined when the repository has no such ref. */
export function headerFeaturesAt(repoRoot: string, ref: string): string[] | undefined {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 << 20 })
  if (git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).status !== 0) return undefined
  const show = (file: string) => {
    const result = git("show", `${ref}:${file}`)
    return result.status === 0 ? result.stdout : undefined
  }
  const header = show(HEADER_FILE)
  if (header === undefined) return []
  const generated = show(GENERATED_ABI_FILE)
  if (generated === undefined) throw new Error(`${ref} has ${HEADER_FILE} but not ${GENERATED_ABI_FILE}`)
  return headerFeatures(header, parseGeneratedAbi(generated))
}

export function headerFeatures(header: string, abi: GeneratedAbi): string[] {
  const declared = readHeader(header)
  const problems = compareAbi(declared, abi)
  if (problems.length > 0) {
    throw new Error(
      `${HEADER_FILE} and ${GENERATED_ABI_FILE} disagree. Run bun run generate:abi in packages/core, or fix the ` +
        `header reader in packages/web/scripts/api/header.ts:\n${problems.join("\n")}`,
    )
  }
  const lines: string[] = []
  const feature = (text: string) => lines.push(`${C_MODULE}: ${text}`)
  const list = (params: string[]) => (params.length > 0 ? params.join(", ") : "void")
  for (const { name, params, returns } of declared.functions) feature(`function ${name}(${list(params)}): ${returns}`)
  for (const { name, params, returns } of declared.callbacks) feature(`type ${name} = ${returns} (*)(${list(params)})`)
  for (const { name, type } of declared.types) feature(`type ${name} = ${type}`)
  for (const { name, fields } of declared.records) {
    feature(`struct ${name}`)
    const offsets = abi.nativeLayouts[name]!.fields
    for (const field of fields)
      feature(`field ${name}.${field.name}: ${field.type}, offset ${offsets[field.name]!.offset}`)
  }
  for (const name of declared.constants) feature(`const ${name} = ${abi.nativeConstants[name]}`)
  return lines
}

// The problems when the header and the generated ABI do not declare the same functions, callbacks, structs,
// fields, and macros.
function compareAbi(header: Header, abi: GeneratedAbi): string[] {
  const problems: string[] = []
  const sameNames = (what: string, read: string[], generated: string[]) => {
    const left = new Set(read)
    const right = new Set(generated)
    for (const name of read) if (!right.has(name)) problems.push(`${what} ${name} is only in the header`)
    for (const name of generated) if (!left.has(name)) problems.push(`${what} ${name} is only in the generated ABI`)
  }
  const sameArity = (what: string, read: Header["functions"], generated: Record<string, { args: string[] }>) => {
    sameNames(
      what,
      read.map((item) => item.name),
      Object.keys(generated),
    )
    for (const { name, params } of read) {
      const args = generated[name]?.args
      if (args && args.length !== params.length) {
        problems.push(
          `${what} ${name} has ${params.length} parameters in the header and ${args.length} in the generated ABI`,
        )
      }
    }
  }
  sameArity("function", header.functions, abi.nativeSymbols)
  sameArity("callback", header.callbacks, abi.nativeCallbacks)
  sameNames(
    "struct",
    header.records.map((record) => record.name),
    Object.keys(abi.nativeLayouts),
  )
  for (const record of header.records) {
    const fields = Object.keys(abi.nativeLayouts[record.name]?.fields ?? {})
    const read = record.fields.map((field) => field.name)
    if (abi.nativeLayouts[record.name] && read.join() !== fields.join()) {
      problems.push(
        `struct ${record.name} has fields ${read.join(", ")} in the header and ${fields.join(", ")} in the generated ABI`,
      )
    }
  }
  sameNames("constant", header.constants, Object.keys(abi.nativeConstants))
  return problems
}

/** Reads the declarations of the header. Anything outside the subset that opentui.h uses is an error. */
function readHeader(source: string): Header {
  const header: Header = { functions: [], callbacks: [], records: [], types: [], constants: [] }
  const code: string[] = []
  // Each conditional is true when its lines are read. Lines under `#ifdef __cplusplus` hold `extern "C"`.
  const conditions: boolean[] = []
  const lines = withoutComments(source).replace(/\\\n/g, " ").split("\n")
  for (const [index, line] of lines.entries()) {
    const directive = /^\s*#\s*(\w+)\s*(.*?)\s*$/.exec(line)
    const active = conditions.every(Boolean)
    if (!directive) {
      if (active) code.push(line)
      continue
    }
    const [, name, rest] = directive as unknown as [string, string, string]
    const unsupported = () => new Error(`${HEADER_FILE}:${index + 1}: unsupported #${name} ${rest}`.trim())
    if (name === "if" || name === "ifdef" || name === "ifndef") {
      // The include guard is the only condition whose lines are read.
      if (!active || (name === "ifdef" && rest === "__cplusplus")) conditions.push(false)
      else if (name === "ifndef" && /^\w+$/.test(rest)) conditions.push(true)
      else throw unsupported()
    } else if (name === "endif") {
      if (conditions.pop() === undefined) throw unsupported()
    } else if (name === "else" || name === "elif") {
      throw unsupported()
    } else if (!active || name === "include") {
      continue
    } else if (name === "define") {
      const macro = /^(\w+)(\(?)/.exec(rest)
      if (!macro) throw unsupported()
      if (!macro[1]!.startsWith("OT_")) continue
      if (macro[2]) throw new Error(`${HEADER_FILE}:${index + 1}: function-like macro ${macro[1]} is not supported`)
      header.constants.push(macro[1]!)
    } else {
      throw unsupported()
    }
  }
  if (conditions.length > 0) throw new Error(`${HEADER_FILE}: unterminated #if`)

  for (const declaration of topLevel(code.join("\n"), ";")) {
    const text = declaration.replace(/\s+/g, " ").trim()
    if (text === "") continue
    const record = /^typedef struct (\w+) ?\{(.*)\} ?(\w+)$/.exec(text)
    const incomplete = /^typedef struct (\w+) (\w+)$/.exec(text)
    const callback = /^typedef ([^(]+)\( ?\* ?(\w+) ?\) ?\((.*)\)$/.exec(text)
    const alias = /^typedef ([^(){}]+?)\b(\w+)$/.exec(text)
    const fn = /^([^(){}]+?)\b(\w+) ?\((.*)\)$/.exec(text)
    let name: string
    if (record) {
      name = record[3]!
      if (record[1] !== name) throw new Error(`${HEADER_FILE}: struct ${record[1]} has the typedef name ${name}`)
      const members = topLevel(record[2]!, ";").filter((member) => member.trim())
      header.records.push({ name, fields: members.flatMap(readFields) })
    } else if (incomplete) {
      name = incomplete[2]!
      header.types.push({ name, type: `struct ${incomplete[1]}` })
    } else if (callback) {
      name = callback[2]!
      header.callbacks.push({ name, params: readParams(callback[3]!), returns: cType(callback[1]!) })
    } else if (alias) {
      name = alias[2]!
      header.types.push({ name, type: cType(alias[1]!) })
    } else if (fn && !text.startsWith("typedef ")) {
      name = fn[2]!
      header.functions.push({ name, params: readParams(fn[3]!), returns: cType(fn[1]!) })
    } else {
      throw new Error(`${HEADER_FILE}: unsupported declaration: ${text.slice(0, 120)}`)
    }
    if (!name.startsWith("ot_")) throw new Error(`${HEADER_FILE}: ${name} does not start with ot_`)
  }
  return header
}

// A member declaration such as `uint32_t width, height` or `const uint8_t *bytes` declares one field per
// declarator, each with the base type.
function readFields(text: string): Array<{ name: string; type: string }> {
  const [first, ...rest] = topLevel(text.replace(/\s+/g, " "), ",").map((part) => part.trim())
  const head = /^([^{}:*]+?) ?(\**) ?(\w+)((?: ?\[[^\]]*\])*)$/.exec(first!)
  if (!head) throw new Error(`${HEADER_FILE}: unsupported struct field: ${text.trim()}`)
  const base = head[1]!
  return [first!, ...rest].map((part, index) => {
    const declarator = index === 0 ? head.slice(2) : /^(\**) ?(\w+)((?: ?\[[^\]]*\])*)$/.exec(part)?.slice(1)
    if (!declarator) throw new Error(`${HEADER_FILE}: unsupported struct field: ${text.trim()}`)
    const [stars, name, dimensions] = declarator as [string, string, string]
    return { name, type: cType(`${base} ${stars}${dimensions}`) }
  })
}

function readParams(text: string): string[] {
  const params = topLevel(text, ",").map(cType)
  return params.length === 1 && params[0] === "void" ? [] : params
}

/** A C type or parameter with its whitespace normalized: `const ot_handle *node`, `ot_context **`, `uint16_t[4]`. */
function cType(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/ ?\* ?/g, "*")
    .replace(/([^ *(])\*/g, "$1 *")
    .replace(/ ?\[ ?/g, "[")
    .replace(/ ?\]/g, "]")
    .trim()
}

/** Splits the text at each separator outside parentheses, brackets, and braces. */
function topLevel(text: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if ("([{".includes(char)) depth++
    else if (")]}".includes(char)) depth--
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** The source with each comment replaced by a space, as the C preprocessor does. */
function withoutComments(source: string): string {
  let text = ""
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!
    if (char === '"' || char === "'") {
      let end = index + 1
      while (end < source.length && source[end] !== char) end += source[end] === "\\" ? 2 : 1
      text += source.slice(index, end + 1)
      index = end
    } else if (source.startsWith("/*", index)) {
      const end = source.indexOf("*/", index + 2)
      if (end < 0) throw new Error(`${HEADER_FILE}: unterminated comment`)
      text += " "
      index = end + 1
    } else if (source.startsWith("//", index)) {
      const end = source.indexOf("\n", index)
      text += " "
      index = (end < 0 ? source.length : end) - 1
    } else {
      text += char
    }
  }
  return text
}

/** Reads the object literals of native-abi.generated.ts without running it. */
export function parseGeneratedAbi(source: string): GeneratedAbi {
  const file = ts.createSourceFile(GENERATED_ABI_FILE, source, ts.ScriptTarget.Latest)
  const values: Record<string, unknown> = {}
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        values[declaration.name.text] = literal(declaration.initializer)
      }
    }
  }
  for (const name of ["nativeSymbols", "nativeCallbacks", "nativeLayouts", "nativeConstants"]) {
    if (typeof values[name] !== "object" || values[name] === null)
      throw new Error(`${GENERATED_ABI_FILE} has no ${name}`)
  }
  return values as unknown as GeneratedAbi
}

function literal(node: ts.Expression): unknown {
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) return literal(node.expression)
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    return -(literal(node.operand) as number)
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.map(literal)
  if (ts.isObjectLiteralExpression(node)) {
    const value: Record<string, unknown> = {}
    for (const property of node.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      ) {
        throw new Error(`${GENERATED_ABI_FILE}: unsupported property`)
      }
      value[property.name.text] = literal(property.initializer)
    }
    return value
  }
  throw new Error(`${GENERATED_ABI_FILE}: unsupported value ${ts.SyntaxKind[node.kind]}`)
}
