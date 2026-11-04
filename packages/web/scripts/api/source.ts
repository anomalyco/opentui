import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative, resolve } from "node:path"
import ts from "typescript"
import { RELEASE_PACKAGES } from "../../../../scripts/npm-publish"

// Emits the declarations of each release package from a source tree into a temporary directory laid out
// like the published package: the files that `tsc -p tsconfig.build.json` writes to dist, the
// hand-written declaration files that the exports map names, and a package.json with the exports map
// that scripts/build.ts publishes. It does not run the package builds.

const repoRoot = resolve(import.meta.dirname, "../../../..")

export interface EmittedPackage {
  name: string
  version: string
  /** The directory with package.json and the declaration files. */
  dir: string
  milliseconds: number
}

type Json = string | { [key: string]: Json }

// The `exports` object literal of the manifest that scripts/build.ts writes with
// `writeFileSync(join(distDir, "package.json"), JSON.stringify({ …, exports }))`.
export function publishedExports(buildScript: string): Record<string, Json> {
  const sourceFile = ts.createSourceFile(buildScript, readFileSync(buildScript, "utf8"), ts.ScriptTarget.Latest, true)
  const manifests: ts.ObjectLiteralExpression[] = []
  const variables: ts.ObjectLiteralExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(sourceFile) === "writeFileSync") {
      const [path, data] = node.arguments
      const manifest = data && ts.isCallExpression(data) ? data.arguments[0] : undefined
      if (
        path !== undefined &&
        /\bdistDir\b/.test(path.getText(sourceFile)) &&
        path.getText(sourceFile).includes('"package.json"') &&
        manifest !== undefined &&
        ts.isObjectLiteralExpression(manifest)
      ) {
        manifests.push(manifest)
      }
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(sourceFile) === "exports" &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      variables.push(node.initializer)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (manifests.length !== 1)
    throw new Error(`${buildScript}: expected one dist package.json, found ${manifests.length}`)
  const property = manifests[0]!.properties.find((item) => item.name?.getText(sourceFile) === "exports")
  let literal: ts.Expression | undefined
  if (property !== undefined && ts.isPropertyAssignment(property)) literal = property.initializer
  else if (property !== undefined && ts.isShorthandPropertyAssignment(property) && variables.length === 1) {
    literal = variables[0]
  }
  if (literal === undefined) throw new Error(`${buildScript}: cannot find the exports map of the dist package.json`)
  return literalValue(literal, buildScript) as Record<string, Json>
}

function literalValue(node: ts.Expression, file: string): Json {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  if (!ts.isObjectLiteralExpression(node)) throw new Error(`${file}: exports map holds a non-literal value`)
  const value: Record<string, Json> = {}
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      throw new Error(`${file}: exports map holds a non-literal property`)
    }
    value[property.name.text] = literalValue(property.initializer, file)
  }
  return value
}

function typesTargets(value: Json): string[] {
  if (typeof value === "string") return value.endsWith(".d.ts") ? [value] : []
  return Object.entries(value).flatMap(([condition, target]) =>
    condition === "types" && typeof target === "string"
      ? [target]
      : typeof target === "object"
        ? typesTargets(target)
        : [],
  )
}

// Copies a hand-written declaration file that the exports map names, and the relative declaration files
// it imports, over the emitted ones. The react and solid builds copy jsx-runtime.d.ts after tsc.
function copyDeclaration(source: string, target: string, copied = new Set<string>()): void {
  if (copied.has(source) || !existsSync(source)) return
  copied.add(source)
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  const info = ts.preProcessFile(readFileSync(source, "utf8"), true, true)
  for (const reference of [...info.importedFiles, ...info.referencedFiles]) {
    if (!reference.fileName.startsWith(".") || !reference.fileName.endsWith(".d.ts")) continue
    const next = resolve(dirname(source), reference.fileName)
    copyDeclaration(next, resolve(dirname(target), reference.fileName), copied)
  }
}

// Emits one package. `distDirs` maps the dist directory of each emitted package to its output, so
// tsconfig `paths` such as `"@opentui/core": ["../core/dist"]` see the fresh declarations.
function emitPackage(packageDir: string, outDir: string, distDirs: Map<string, string>): string {
  // Use the TypeScript of the source tree so the declarations match its own builds.
  const tsc = createRequire(join(packageDir, "package.json"))("typescript") as typeof ts
  const configPath = join(packageDir, "tsconfig.build.json")
  const parsed = tsc.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...tsc.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(tsc.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    },
  })
  if (parsed === undefined) throw new Error(`Cannot read ${configPath}`)
  const options: ts.CompilerOptions = {
    ...parsed.options,
    outDir,
    declarationDir: undefined,
    noEmit: false,
    declaration: true,
    emitDeclarationOnly: true,
    declarationMap: false,
    sourceMap: false,
    inlineSourceMap: false,
    incremental: false,
    composite: false,
    tsBuildInfoFile: undefined,
  }
  if (options.paths !== undefined) {
    const base = options.baseUrl ?? (options.pathsBasePath as string | undefined) ?? packageDir
    options.paths = Object.fromEntries(
      Object.entries(options.paths).map(([pattern, targets]) => [
        pattern,
        targets.map((target) => {
          const absolute = resolve(base, target)
          for (const [dist, emitted] of distDirs) {
            const rest = relative(dist, absolute)
            if (rest === "" || (!rest.startsWith("..") && !rest.startsWith("/"))) return join(emitted, rest)
          }
          return absolute
        }),
      ]),
    )
  }
  const program = tsc.createProgram({
    rootNames: parsed.fileNames,
    options,
    projectReferences: parsed.projectReferences,
  })
  const result = program.emit(undefined, undefined, undefined, true)
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.category === tsc.DiagnosticCategory.Error)
  if (errors.length > 0) {
    const host = {
      getCanonicalFileName: (f: string) => f,
      getCurrentDirectory: () => packageDir,
      getNewLine: () => "\n",
    }
    throw new Error(`Declaration emit failed for ${packageDir}:\n${tsc.formatDiagnostics(errors, host)}`)
  }
  return options.rootDir ?? packageDir
}

export function emitDeclarations(root: string, outRoot: string): EmittedPackage[] {
  const distDirs = new Map<string, string>()
  const emitted: EmittedPackage[] = []
  for (const releasePackage of RELEASE_PACKAGES) {
    const start = performance.now()
    const packageDir = resolve(root, relative(repoRoot, releasePackage.rootDir))
    const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { version: string }
    const outDir = join(outRoot, releasePackage.name)
    const rootDir = emitPackage(packageDir, outDir, distDirs)
    distDirs.set(join(packageDir, "dist"), outDir)

    const exports = publishedExports(join(packageDir, "scripts", "build.ts"))
    for (const target of Object.values(exports).flatMap(typesTargets)) {
      copyDeclaration(resolve(rootDir, target), resolve(outDir, target))
    }
    writeFileSync(
      join(outDir, "package.json"),
      JSON.stringify({ name: releasePackage.name, version: manifest.version, exports }, null, 2) + "\n",
    )
    emitted.push({
      name: releasePackage.name,
      version: manifest.version,
      dir: outDir,
      milliseconds: performance.now() - start,
    })
  }
  return emitted
}
