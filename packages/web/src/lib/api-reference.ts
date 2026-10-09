import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { exportName, UNRELEASED, type ChannelApi } from "./api-docs"
import { C_MODULE, compareText, compareVersions, featureKey, type ApiFeature } from "./api-history"
import { documentedSymbols } from "./api-index-symbols"
import { REPO_ROOT } from "./repo-root"

// The generated API reference: every export of each published entry point and of the C ABI, grouped by kind, with
// the release that added it, like the index of a pkg.go.dev package page.

export const EXPORT_GROUPS = [
  { id: "functions", title: "Functions", kinds: ["function"] },
  { id: "classes", title: "Classes", kinds: ["class"] },
  { id: "interfaces", title: "Interfaces", kinds: ["interface"] },
  { id: "structs", title: "Structs", kinds: ["struct"] },
  { id: "types", title: "Types", kinds: ["type"] },
  { id: "enums", title: "Enums", kinds: ["enum"] },
  { id: "variables", title: "Constants and variables", kinds: ["const", "let"] },
  { id: "namespaces", title: "Namespaces and re-exports", kinds: ["namespace", "reexport"] },
] as const

export interface ApiExport {
  name: string
  /** The export's own lines: one per overload or declaration. */
  declarations: ApiFeature[]
  members: Array<{ feature: ApiFeature; label?: string }>
  /** The release that added the export, when it is later than the module's first release. */
  label?: string
  deprecated: boolean
  /** Logical URL of the guide that documents the export. */
  guide?: string
}

export interface ApiModule {
  module: string
  slug: string
  exports: ApiExport[]
}

/** The URL path of a module under /docs/api: core/testing for @opentui/core/testing, and c for the C ABI. */
export function moduleSlug(module: string): string {
  return module === C_MODULE ? "c" : module.replace(/^@opentui\//, "")
}

export async function apiModules(api: ChannelApi): Promise<ApiModule[]> {
  const apiIndex = await readFile(
    join(REPO_ROOT, "packages/web/src/content/docs/reference/api-index.mdx"),
    "utf8",
  ).catch(() => "")
  const guides = new Map(documentedSymbols(apiIndex).map((symbol) => [`${symbol.module} ${symbol.name}`, symbol.page]))
  const since = (feature: ApiFeature) => api.keys.get(featureKey(feature))?.since

  const byModule = new Map<string, ApiFeature[]>()
  for (const feature of api.features) {
    const features = byModule.get(feature.module)
    if (features) features.push(feature)
    else byModule.set(feature.module, [feature])
  }

  return [...byModule]
    .sort(([left], [right]) => compareText(left, right))
    .map(([module, features]) => {
      // A module that no release has yet starts with the unreleased changes.
      const first =
        features
          .map(since)
          .filter((version): version is string => version !== undefined && version !== UNRELEASED)
          .sort(compareVersions)[0] ?? UNRELEASED
      const label = (feature: ApiFeature) => {
        const version = since(feature)
        return version && version !== first ? version : undefined
      }

      const exports = new Map<string, ApiExport>()
      for (const feature of features.toSorted((left, right) => compareText(left.line, right.line))) {
        const name = exportName(feature.name)
        let entry = exports.get(name)
        if (!entry) {
          entry = { name, declarations: [], members: [], deprecated: false, guide: guides.get(`${module} ${name}`) }
          exports.set(name, entry)
        }
        if (feature.name === name) entry.declarations.push(feature)
        else entry.members.push({ feature, label: label(feature) })
      }
      for (const entry of exports.values()) {
        entry.members.sort((left, right) => compareFields(left.feature, right.feature))
        const labels = entry.declarations.map(label)
        entry.label = labels.includes(undefined) ? undefined : labels.sort(compareLabels)[0]
        entry.deprecated =
          entry.declarations.length > 0 &&
          entry.declarations.every((feature) => feature.modifiers.includes("deprecated"))
      }

      return {
        module,
        slug: moduleSlug(module),
        exports: [...exports.values()].sort((left, right) =>
          compareText(left.name.toLowerCase(), right.name.toLowerCase()),
        ),
      }
    })
}

/** The group an export belongs to, by its first declaration's kind. */
export function exportGroup(entry: ApiExport): (typeof EXPORT_GROUPS)[number]["id"] {
  const kind = entry.declarations[0]?.kind ?? entry.members[0]?.feature.kind
  return EXPORT_GROUPS.find((group) => (group.kinds as readonly string[]).includes(kind ?? ""))?.id ?? "namespaces"
}

// A struct lists its fields in layout order, from lines such as "field ot_handle.slot: uint32_t, offset 8". Other
// members keep their order.
function compareFields(left: ApiFeature, right: ApiFeature): number {
  if (left.kind !== "field" || right.kind !== "field") return 0
  const offset = (feature: ApiFeature) => Number(/, offset (\d+)$/.exec(feature.signature)?.[1] ?? 0)
  return offset(left) - offset(right)
}

function compareLabels(left: string | undefined, right: string | undefined): number {
  if (left === right) return 0
  if (left === undefined || right === UNRELEASED) return -1
  if (right === undefined || left === UNRELEASED) return 1
  return compareVersions(left, right)
}
