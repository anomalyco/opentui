import { readFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import ts from "typescript"
import { API_MODIFIERS, compareText } from "../../src/lib/api-history"

// Extracts the API features of a package from declaration files laid out like the published npm package.
// The checker only resolves which declarations each entry point exports. Signatures are printed from the
// declaration syntax, so the output does not depend on external packages such as three or react.

export interface EntryPoint {
  /** The npm specifier, for example `@opentui/core/testing`. */
  module: string
  /** The absolute path of the declaration file. */
  file: string
}

export interface ExtractOptions {
  /** Keep public members whose name starts with `_`. They are excluded by default. */
  underscoreMembers?: boolean
}

export interface Extraction {
  features: string[]
  /** Exports that the extractor cannot record, for example a declaration kind that it does not know. */
  warnings: string[]
}

interface PackageManifest {
  name?: unknown
  types?: unknown
  typings?: unknown
  exports?: unknown
}

// The `types` target of one exports-map value. A bare string target that names a declaration file also
// serves types (early @opentui/solid releases map `./jsx-runtime` straight to `./jsx-runtime.d.ts`).
function typesTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value.endsWith(".d.ts") ? value : undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = typesTarget(item)
      if (target !== undefined) return target
    }
    return undefined
  }
  if (value === null || typeof value !== "object") return undefined
  for (const [condition, target] of Object.entries(value)) {
    if (condition === "types" && typeof target === "string") return target
    if (target !== null && typeof target === "object") {
      const nested = typesTarget(target)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

export function entryPoints(root: string): EntryPoint[] {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageManifest
  if (typeof manifest.name !== "string") throw new Error(`${join(root, "package.json")} has no name`)
  const name = manifest.name
  let exportsMap: Record<string, unknown> | undefined
  const exportsField = manifest.exports
  if (typeof exportsField === "string" || Array.isArray(exportsField)) exportsMap = { ".": exportsField }
  else if (exportsField !== null && typeof exportsField === "object") {
    const keys = Object.keys(exportsField)
    exportsMap = keys.every((key) => !key.startsWith(".")) ? { ".": exportsField } : (exportsField as typeof exportsMap)
  }
  const entries: EntryPoint[] = []
  if (exportsMap === undefined) {
    const types = manifest.types ?? manifest.typings
    if (typeof types === "string") entries.push({ module: name, file: resolve(root, types) })
    return entries
  }
  for (const [subpath, value] of Object.entries(exportsMap)) {
    if (subpath.includes("*")) throw new Error(`${name}: subpath pattern ${subpath} is not supported`)
    const types = typesTarget(value)
    if (types === undefined) continue
    entries.push({
      module: subpath === "." ? name : `${name}/${subpath.replace(/^\.\//, "")}`,
      file: resolve(root, types),
    })
  }
  return entries
}

// A compiler host that sees only the files of the package. Imports of other packages stay unresolved, so
// the result is the same for a tarball and for declarations emitted from source.
function packageHost(root: string, options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true)
  const inside = (path: string): boolean => {
    const rel = relative(root, resolve(path))
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.split(sep).includes("node_modules"))
  }
  const fileExists = host.fileExists.bind(host)
  const readFile = host.readFile.bind(host)
  const getSourceFile = host.getSourceFile.bind(host)
  const directoryExists = host.directoryExists?.bind(host)
  host.fileExists = (path) => inside(path) && fileExists(path)
  host.readFile = (path) => (inside(path) ? readFile(path) : undefined)
  host.getSourceFile = (path, language, onError, create) =>
    inside(path) ? getSourceFile(path, language, onError, create) : undefined
  host.directoryExists = (path) => inside(path) && (directoryExists?.(path) ?? true)
  host.realpath = (path) => path
  host.getDefaultLibFileName = () => join(root, "__nolib__.d.ts")
  return host
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  noLib: true,
  types: [],
  noEmit: true,
  skipLibCheck: true,
  allowJs: false,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
}

export function extractPackage(root: string, options: ExtractOptions = {}): Extraction {
  return extractEntryPoints(resolve(root), entryPoints(resolve(root)), options)
}

export function extractEntryPoints(root: string, entries: EntryPoint[], options: ExtractOptions = {}): Extraction {
  const program = ts.createProgram({
    rootNames: entries.map((entry) => entry.file),
    options: COMPILER_OPTIONS,
    host: packageHost(root, COMPILER_OPTIONS),
  })
  const checker = program.getTypeChecker()
  const features = new Set<string>()
  const warnings: string[] = []
  for (const entry of entries) {
    const sourceFile = program.getSourceFile(entry.file)
    if (sourceFile === undefined) {
      warnings.push(`${entry.module}: missing declaration file ${relative(root, entry.file)}`)
      continue
    }
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile)
    if (moduleSymbol === undefined) continue
    const extractor = new ModuleExtractor(checker, entry.module, features, warnings, options)
    for (const symbol of checker.getExportsOfModule(moduleSymbol)) extractor.symbol(symbol, symbol.name, [moduleSymbol])
    extractor.starExports(sourceFile, "")
  }
  return { features: [...features].sort(compareText), warnings }
}

const printer = ts.createPrinter({ removeComments: true, omitTrailingSemicolon: true })

// Collapses whitespace outside string and template literals and drops `import("…").` qualifiers.
export function normalizeSignature(text: string): string {
  let out = ""
  let quote = ""
  let space = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quote !== "") {
      out += char
      if (char === "\\") out += text[++index] ?? ""
      else if (char === quote) quote = ""
      continue
    }
    if (/\s/.test(char)) {
      space = true
      continue
    }
    if (space && out !== "") out += " "
    space = false
    if (char === '"' || char === "'" || char === "`") quote = char
    out += char
  }
  return out.replace(/import\((["'])[^"'`]*\1\)\./g, "").replace(/;+$/, "")
}

class ModuleExtractor {
  constructor(
    private readonly checker: ts.TypeChecker,
    private readonly module: string,
    private readonly features: Set<string>,
    private readonly warnings: string[],
    private readonly options: ExtractOptions,
  ) {}

  symbol(exported: ts.Symbol, name: string, stack: ts.Symbol[]): void {
    const target = exported.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(exported) : exported
    const declarations = target.declarations ?? []
    if (declarations.length === 0) {
      this.unresolved(exported, name)
      return
    }
    for (const declaration of declarations) this.declaration(declaration, target, name, stack)
  }

  // An alias whose module did not resolve comes from another package: `export * as THREE from "three"`
  // or `export { createElement } from "react"`.
  private unresolved(exported: ts.Symbol, name: string): void {
    let symbol: ts.Symbol | undefined = exported
    let last: ts.Declaration | undefined
    while (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias) {
      last = symbol.declarations?.[0]
      symbol = this.checker.getImmediateAliasedSymbol(symbol)
    }
    const specifier = last === undefined ? undefined : moduleSpecifier(last)
    if (last === undefined || specifier === undefined) {
      this.warnings.push(`${this.module}: cannot resolve export ${name}`)
      return
    }
    const from = ` from ${JSON.stringify(specifier)}`
    if (ts.isNamespaceExport(last) || ts.isNamespaceImport(last)) {
      this.add([], "namespace", name, from)
      return
    }
    let original = "default"
    if (ts.isExportSpecifier(last) || ts.isImportSpecifier(last)) original = (last.propertyName ?? last.name).text
    const local = name.slice(name.lastIndexOf(".") + 1)
    this.add(this.modifiers(last), "reexport", name, original === local ? from : `${from} as ${original}`)
  }

  // `export * from "react"` adds no symbols that the checker can see, so record it by name `*`.
  starExports(sourceFile: ts.SourceFile, prefix: string, seen = new Set<ts.SourceFile>()): void {
    if (seen.has(sourceFile)) return
    seen.add(sourceFile)
    for (const statement of sourceFile.statements) {
      if (!ts.isExportDeclaration(statement) || statement.exportClause !== undefined) continue
      const specifier = statement.moduleSpecifier
      if (specifier === undefined || !ts.isStringLiteral(specifier)) continue
      const target = this.checker.getSymbolAtLocation(specifier)?.valueDeclaration
      if (target !== undefined && ts.isSourceFile(target)) this.starExports(target, prefix, seen)
      else this.add([], "reexport", `${prefix}*`, ` from ${JSON.stringify(specifier.text)}`)
    }
  }

  private declaration(node: ts.Declaration, target: ts.Symbol, name: string, stack: ts.Symbol[]): void {
    if (ts.isSourceFile(node)) {
      this.add([], "namespace", name, "")
      if (stack.includes(target)) return
      for (const symbol of this.checker.getExportsOfModule(target)) {
        this.symbol(symbol, `${name}.${symbol.name}`, [...stack, target])
      }
      this.starExports(node, `${name}.`)
    } else if (ts.isModuleDeclaration(node)) {
      if (!ts.isIdentifier(node.name)) return
      this.add(this.modifiers(node), "namespace", name, "")
      if (stack.includes(target)) return
      for (const symbol of this.checker.getExportsOfModule(target)) {
        if (!symbol.declarations?.some((declaration) => enclosingNamespace(declaration) === node)) continue
        this.symbol(symbol, `${name}.${symbol.name}`, [...stack, target])
      }
    } else if (ts.isClassDeclaration(node)) {
      const signature = this.typeParameters(node.typeParameters) + this.heritage(node.heritageClauses)
      this.add(this.modifiers(node), "class", name, signature)
      this.members(node.members, name)
    } else if (ts.isInterfaceDeclaration(node)) {
      const signature = this.typeParameters(node.typeParameters) + this.heritage(node.heritageClauses)
      this.add(this.modifiers(node), "interface", name, signature)
      this.members(node.members, name)
    } else if (ts.isTypeAliasDeclaration(node)) {
      this.add(
        this.modifiers(node),
        "type",
        name,
        `${this.typeParameters(node.typeParameters)} = ${this.print(node.type)}`,
      )
    } else if (ts.isFunctionDeclaration(node)) {
      this.add(this.modifiers(node), "function", name, this.callSignature(node))
    } else if (ts.isVariableDeclaration(node)) {
      const kind = node.parent.flags & ts.NodeFlags.Const ? "const" : "let"
      this.add(this.modifiers(node), kind, name, this.valueSignature(node))
    } else if (ts.isEnumDeclaration(node)) {
      this.add(this.modifiers(node), "enum", name, "")
      for (const member of node.members) {
        const memberName = this.memberName(member.name)
        if (memberName === undefined || this.excluded(member, memberName)) continue
        const value = member.initializer ? ` = ${this.print(member.initializer)}` : ""
        this.add(this.modifiers(member), "enum-member", `${name}.${memberName}`, value)
      }
    } else if (ts.isExportAssignment(node)) {
      this.add([], "const", name, ` = ${this.print(node.expression)}`)
    } else {
      this.warnings.push(`${this.module}: export ${name} has unsupported declaration ${ts.SyntaxKind[node.kind]}`)
    }
  }

  private members(members: ts.NodeArray<ts.ClassElement | ts.TypeElement>, owner: string): void {
    const accessors = new Map<string, { get?: ts.GetAccessorDeclaration; set?: ts.SetAccessorDeclaration }>()
    for (const member of members) {
      if (ts.isConstructorDeclaration(member)) {
        if (!this.excluded(member, "constructor"))
          this.add(this.modifiers(member), "constructor", owner, this.callSignature(member))
        continue
      }
      if (ts.isCallSignatureDeclaration(member) || ts.isConstructSignatureDeclaration(member)) {
        const kind = ts.isCallSignatureDeclaration(member) ? "call" : "construct"
        if (!this.excluded(member, "")) this.add(this.modifiers(member), kind, owner, this.callSignature(member))
        continue
      }
      if (ts.isIndexSignatureDeclaration(member)) {
        const parameters = member.parameters.map((parameter) => this.print(parameter)).join(", ")
        const signature = `[${parameters}]: ${this.print(member.type)}`
        if (!this.excluded(member, "")) this.add(this.modifiers(member), "index", owner, signature)
        continue
      }
      if (member.name === undefined) continue
      const memberName = this.memberName(member.name)
      if (memberName === undefined || this.excluded(member, memberName)) continue
      const qualified = `${owner}.${memberName}`
      if (ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        const static_ = ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static ? "static " : ""
        const key = static_ + memberName
        const pair = accessors.get(key) ?? {}
        if (ts.isGetAccessorDeclaration(member)) pair.get = member
        else pair.set = member
        accessors.set(key, pair)
      } else if (ts.isMethodDeclaration(member) || ts.isMethodSignature(member)) {
        const optional = member.questionToken ? "?" : ""
        this.add(this.modifiers(member), "method", qualified, optional + this.callSignature(member))
      } else if (ts.isPropertyDeclaration(member) || ts.isPropertySignature(member)) {
        const optional = member.questionToken ? "?" : ""
        this.add(this.modifiers(member), "property", qualified, optional + this.valueSignature(member))
      } else if (!ts.isSemicolonClassElement(member) && !ts.isClassStaticBlockDeclaration(member)) {
        this.warnings.push(`${this.module}: member ${qualified} has unsupported kind ${ts.SyntaxKind[member.kind]}`)
      }
    }
    for (const { get, set } of accessors.values()) {
      const node = (get ?? set)!
      const modifiers = new Set([...this.modifiers(node), ...(get && set ? this.modifiers(set) : [])])
      if (get !== undefined && set === undefined) modifiers.add("readonly")
      const type = get?.type ?? set?.parameters[0]?.type
      const name = `${owner}.${this.memberName(node.name)!}`
      this.add(
        API_MODIFIERS.filter((modifier) => modifiers.has(modifier)),
        "property",
        name,
        type ? `: ${this.print(type)}` : "",
      )
    }
  }

  // Private, `#private`, and `@internal` members are not API. A public member named `_x` is internal by
  // convention; a protected one is state that subclasses use, so it stays.
  private excluded(member: ts.Node, name: string): boolean {
    const flags = ts.getCombinedModifierFlags(member as ts.Declaration)
    if (flags & ts.ModifierFlags.Private) return true
    if (name.startsWith("_") && !(flags & ts.ModifierFlags.Protected) && !this.options.underscoreMembers) return true
    return hasTag(member, "internal")
  }

  private modifiers(node: ts.Node): string[] {
    const flags = ts.getCombinedModifierFlags(node as ts.Declaration)
    const modifiers: string[] = []
    if (hasTag(node, "deprecated")) modifiers.push("deprecated")
    if (flags & ts.ModifierFlags.Static) modifiers.push("static")
    if (flags & ts.ModifierFlags.Protected) modifiers.push("protected")
    if (flags & ts.ModifierFlags.Abstract) modifiers.push("abstract")
    if (flags & ts.ModifierFlags.Readonly) modifiers.push("readonly")
    return modifiers
  }

  private memberName(name: ts.PropertyName): string | undefined {
    if (ts.isPrivateIdentifier(name)) return undefined
    if (ts.isIdentifier(name)) return name.text
    return this.print(name)
  }

  private callSignature(node: ts.SignatureDeclarationBase): string {
    const parameters = node.parameters.map((parameter) => this.print(parameter)).join(", ")
    const type = node.type ? `: ${this.print(node.type)}` : ""
    return `${this.typeParameters(node.typeParameters)}(${parameters})${type}`
  }

  private valueSignature(node: ts.VariableDeclaration | ts.PropertyDeclaration | ts.PropertySignature): string {
    const type = node.type ? `: ${this.print(node.type)}` : ""
    const initializer = "initializer" in node && node.initializer ? ` = ${this.print(node.initializer)}` : ""
    return type + initializer
  }

  private typeParameters(parameters: ts.NodeArray<ts.TypeParameterDeclaration> | undefined): string {
    if (parameters === undefined || parameters.length === 0) return ""
    return `<${parameters.map((parameter) => this.print(parameter)).join(", ")}>`
  }

  private heritage(clauses: ts.NodeArray<ts.HeritageClause> | undefined): string {
    return (clauses ?? []).map((clause) => ` ${this.print(clause)}`).join("")
  }

  private print(node: ts.Node): string {
    return normalizeSignature(printer.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()))
  }

  private add(modifiers: string[], kind: string, name: string, signature: string): void {
    this.features.add(normalizeSignature(`${this.module}: ${[...modifiers, kind].join(" ")} ${name}${signature}`))
  }
}

function hasTag(node: ts.Node, tag: string): boolean {
  return ts.getJSDocTags(node).some((jsDocTag) => jsDocTag.tagName.text === tag)
}

function enclosingNamespace(node: ts.Node): ts.ModuleDeclaration | undefined {
  for (let parent = node.parent; parent !== undefined; parent = parent.parent) {
    if (ts.isModuleDeclaration(parent)) return parent
    if (ts.isSourceFile(parent)) return undefined
  }
  return undefined
}

function moduleSpecifier(node: ts.Node): string | undefined {
  for (let current: ts.Node | undefined = node; current !== undefined; current = current.parent) {
    if (ts.isExportDeclaration(current) || ts.isImportDeclaration(current)) {
      const specifier = current.moduleSpecifier
      return specifier !== undefined && ts.isStringLiteral(specifier) ? specifier.text : undefined
    }
    if (ts.isSourceFile(current)) return undefined
  }
  return undefined
}
