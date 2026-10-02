import { transformAsync } from "@babel/core"
// @ts-expect-error - Types not important.
import ts from "@babel/preset-typescript"
// @ts-expect-error - Types not important.
import moduleResolver from "babel-plugin-module-resolver"
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

export function isSolidJsxSource(path: string): boolean {
  return jsxPattern.test(stripQueryAndHash(path))
}

export function useSolidJsxImportSource(code: string, moduleName: string): string {
  const rewritten = code.replace(/(@jsxImportSource\s+)@opentui\/solid\b/g, `$1${moduleName}`)
  if (rewritten !== code || /@jsxImportSource\s+/.test(code)) return rewritten
  return `/** @jsxImportSource ${moduleName} */\n${code}`
}

export async function transformSolidSource(code: string, options: TransformSolidSourceOptions): Promise<string> {
  const filename = stripQueryAndHash(options.filename)
  const plugins = options.resolvePath
    ? [
        [
          moduleResolver,
          {
            resolvePath(specifier: string) {
              return options.resolvePath?.(specifier) ?? specifier
            },
          },
        ],
      ]
    : []

  const presets = []

  if (isSolidJsxSource(filename)) {
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
