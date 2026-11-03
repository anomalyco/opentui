import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"
import { C_MODULE } from "../../src/lib/api-history"

// Extracts the API features of the C ABI: the declarations of opentui.h as written, so the features keep its
// typedef names and parameter names, with the field offsets and macro values of native-abi.generated.ts, which
// `bun run check:abi` in packages/core derives from the header with the C compiler.

export const HEADER_FILE = "packages/native/include/opentui.h"
export const GENERATED_ABI_FILE = "packages/core/src/native-abi.generated.ts"

/** The parts of native-abi.generated.ts that the features use. */
export interface GeneratedAbi {
  nativeLayouts: Record<string, { fields: Record<string, { offset: number }> }>
  nativeConstants: Record<string, number>
}

interface Header {
  functions: Array<{ name: string; params: string[]; returns: string }>
  callbacks: Array<{ name: string; params: string[]; returns: string }>
  records: Array<{ name: string; fields: Array<{ name: string; type: string }> }>
  /** Typedefs of other types, such as `int32_t` or an incomplete struct, as C type names. */
  types: Array<{ name: string; type: string }>
}

/** The API features of the C ABI in a source tree, or none when it has no header. */
export function headerFeaturesIn(root: string): string[] {
  const header = join(root, HEADER_FILE)
  if (!existsSync(header)) return []
  const generated = readFileSync(join(root, GENERATED_ABI_FILE), "utf8")
  return headerFeatures(readFileSync(header, "utf8"), parseGeneratedAbi(generated))
}

/** The API features of the C ABI at a git ref, or undefined when the repository has no such ref. */
export function headerFeaturesAt(repoRoot: string, ref: string): string[] | undefined {
  const git = (...args: string[]) => spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 << 20 })
  if (git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).status !== 0) return undefined
  const header = git("show", `${ref}:${HEADER_FILE}`)
  if (header.status !== 0) return []
  return headerFeatures(header.stdout, parseGeneratedAbi(git("show", `${ref}:${GENERATED_ABI_FILE}`).stdout))
}

export function headerFeatures(header: string, abi: GeneratedAbi): string[] {
  const declared = readHeader(header)
  const lines: string[] = []
  const feature = (text: string) => lines.push(`${C_MODULE}: ${text}`)
  const list = (params: string[]) => (params.length > 0 ? params.join(", ") : "void")
  for (const { name, params, returns } of declared.functions) feature(`function ${name}(${list(params)}): ${returns}`)
  for (const { name, params, returns } of declared.callbacks) feature(`type ${name} = ${returns} (*)(${list(params)})`)
  for (const { name, type } of declared.types) feature(`type ${name} = ${type}`)
  for (const { name, fields } of declared.records) {
    feature(`struct ${name}`)
    const offsets = abi.nativeLayouts[name]!.fields
    for (const field of fields) {
      feature(`field ${name}.${field.name}: ${field.type}, offset ${offsets[field.name]!.offset}`)
    }
  }
  for (const [name, value] of Object.entries(abi.nativeConstants)) feature(`const ${name} = ${value}`)
  return lines
}

/** Reads the declarations of the header. Lines under `#ifdef __cplusplus` hold `extern "C"` and are skipped. */
function readHeader(source: string): Header {
  const header: Header = { functions: [], callbacks: [], records: [], types: [] }
  const code: string[] = []
  const conditions: boolean[] = []
  for (const line of withoutComments(source).replace(/\\\n/g, " ").split("\n")) {
    const directive = /^\s*#\s*(\w+)\s*(.*?)\s*$/.exec(line)
    if (!directive) {
      if (conditions.every(Boolean)) code.push(line)
    } else if (directive[1]!.startsWith("if")) {
      conditions.push(!(directive[1] === "ifdef" && directive[2] === "__cplusplus"))
    } else if (directive[1] === "endif") {
      conditions.pop()
    }
  }

  for (const declaration of topLevel(code.join("\n"), ";")) {
    const text = declaration.replace(/\s+/g, " ").trim()
    const record = /^typedef struct (\w+) ?\{(.*)\} ?(\w+)$/.exec(text)
    const incomplete = /^typedef struct (\w+) (\w+)$/.exec(text)
    const callback = /^typedef ([^(]+)\( ?\* ?(\w+) ?\) ?\((.*)\)$/.exec(text)
    const alias = /^typedef ([^(){}]+?)\b(\w+)$/.exec(text)
    const fn = /^([^(){}]+?)\b(\w+) ?\((.*)\)$/.exec(text)
    if (record) header.records.push({ name: record[3]!, fields: topLevel(record[2]!, ";").flatMap(readFields) })
    else if (incomplete) header.types.push({ name: incomplete[2]!, type: `struct ${incomplete[1]}` })
    else if (callback) {
      header.callbacks.push({ name: callback[2]!, params: readParams(callback[3]!), returns: cType(callback[1]!) })
    } else if (alias) header.types.push({ name: alias[2]!, type: cType(alias[1]!) })
    else if (fn && !text.startsWith("typedef ")) {
      header.functions.push({ name: fn[2]!, params: readParams(fn[3]!), returns: cType(fn[1]!) })
    }
  }
  return header
}

// A member declaration such as `uint32_t width, height` or `const uint8_t *bytes` declares one field per
// declarator, each with the base type.
function readFields(text: string): Array<{ name: string; type: string }> {
  const [first, ...rest] = topLevel(text.replace(/\s+/g, " "), ",").map((part) => part.trim())
  const head = /^([^{}:*]+?) ?(\**) ?(\w+)((?: ?\[[^\]]*\])*)$/.exec(first!)
  if (!head) return []
  const declarators = [head.slice(2), ...rest.map((part) => /^(\**) ?(\w+)((?: ?\[[^\]]*\])*)$/.exec(part)?.slice(1))]
  return declarators
    .filter((declarator) => declarator !== undefined)
    .map(([stars, name, dimensions]) => ({ name: name!, type: cType(`${head[1]} ${stars}${dimensions}`) }))
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
    } else if (source.startsWith("/*", index) || source.startsWith("//", index)) {
      // A block comment ends after its "*/"; a line comment ends before its newline.
      const block = source[index + 1] === "*"
      const end = block ? source.indexOf("*/", index + 2) : source.indexOf("\n", index)
      text += " "
      index = end < 0 ? source.length : block ? end + 1 : end - 1
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
  if (!ts.isObjectLiteralExpression(node)) return undefined
  const value: Record<string, unknown> = {}
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      value[property.name.text] = literal(property.initializer)
    }
  }
  return value
}
