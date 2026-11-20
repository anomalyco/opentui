import { transformAsync, types, type NodePath, type PluginObj } from "@babel/core"
// @ts-expect-error - Types not important.
import ts from "@babel/preset-typescript"
// @ts-expect-error - Types not important.
import solid from "babel-preset-solid"

export type ResolveImportPath = (specifier: string) => string | null

export interface TransformSolidSourceOptions {
  filename: string
  moduleName?: string
  resolvePath?: ResolveImportPath
}

const nodeModulesPattern = /[/\\]node_modules[/\\]/
const tsPattern = /\.[cm]?tsx?$/
const jsxPattern = /\.[cm]?[jt]sx$/

export function stripQueryAndHash(path: string): string {
  const searchIndex = path.indexOf("?")
  const hashIndex = path.indexOf("#")
  const end = [searchIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0]
  return end === undefined ? path : path.slice(0, end)
}

export function isNodeModulesPath(path: string): boolean {
  return nodeModulesPattern.test(path)
}

export function resolveNodeSolidRuntimeImport(specifier: string): string | null {
  switch (specifier) {
    case "solid-js":
      return "solid-js/dist/solid.js"
    case "solid-js/store":
      return "solid-js/store/dist/store.js"
    default:
      return null
  }
}

// The call forms babel-plugin-module-resolver rewrote, besides require() and import().
const moduleCalls = ["require.resolve", "System.import", "require.requireActual", "require.requireMock"].concat(
  ["genMockFromModule", "mock", "unmock", "doMock", "dontMock", "setMock", "requireActual", "requireMock"].map(
    (name) => "jest." + name,
  ),
)

function isModuleCall(path: NodePath<types.CallExpression>): boolean {
  const callee = path.get("callee")
  return (
    callee.isImport() || callee.isIdentifier({ name: "require" }) || moduleCalls.some((p) => callee.matchesPattern(p))
  )
}

// Rewrites module specifiers once, after the Solid preset has added its runtime imports.
function importResolver(options: TransformSolidSourceOptions): PluginObj {
  // Like the resolver, leave a call alone whose argument was not a plain string before TypeScript erased its cast.
  const castCalls = new WeakSet<NodePath>()
  const rewrite = (source: NodePath<any> | NodePath<any>[] | undefined) => {
    if (Array.isArray(source) || !source?.isStringLiteral()) return
    const value = options.resolvePath?.(source.node.value) ?? source.node.value
    if (value) source.replaceWith(types.stringLiteral(value))
  }
  const findCasts = {
    CallExpression(path: NodePath<types.CallExpression>) {
      if (isModuleCall(path) && !path.get("arguments")[0]?.isStringLiteral()) castCalls.add(path)
    },
  }
  const visitor = {
    "ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration"(path: NodePath<any>) {
      rewrite(path.get("source"))
    },
    CallExpression(path: NodePath<types.CallExpression>) {
      if (!castCalls.has(path) && isModuleCall(path)) rewrite(path.get("arguments")[0])
    },
  }
  return {
    visitor: {
      Program: { enter: (program) => program.traverse(findCasts), exit: (program) => program.traverse(visitor) },
    },
  }
}

export async function transformSolidSource(code: string, options: TransformSolidSourceOptions): Promise<string> {
  const filename = stripQueryAndHash(options.filename)
  const plugins = options.resolvePath ? [importResolver(options)] : []

  const presets = []

  if (jsxPattern.test(filename)) {
    presets.push([
      solid,
      {
        moduleName: options.moduleName ?? "@opentui/solid",
        generate: "universal",
      },
    ])
  }

  if (tsPattern.test(filename)) {
    presets.push([ts])
  }

  const transformed = await transformAsync(code, {
    filename,
    configFile: false,
    babelrc: false,
    plugins,
    presets,
  })

  return transformed?.code ?? code
}
