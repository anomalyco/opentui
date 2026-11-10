import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { resolveExternalPluginCandidates } from "./external-plugin-path.js"

describe("external plugin path", () => {
  it("prefers the dist sibling plugin before the source plugin", () => {
    const root = "/repo/packages/solid/examples"
    const dist = join(root, "dist", "darwin-arm64")
    const source = join(root, "components", "external-plugin-slots-demo.tsx")
    const candidates = resolveExternalPluginCandidates({
      cwd: dist,
      execPath: join(dist, "opentui-solid-examples"),
      moduleUrl: pathToFileURL(source).href,
    })

    expect(candidates[0]).toBe(join(dist, ".plugin", "index.tsx"))
    expect(candidates.indexOf(join(dist, ".plugin", "index.tsx"))).toBeLessThan(
      candidates.indexOf(join(root, ".plugin", "index.tsx")),
    )
  })

  it("supports running from the workspace root in dev", () => {
    const cwd = "/repo"
    const root = join(cwd, "packages", "solid", "examples")
    const source = join(root, "components", "external-plugin-slots-demo.tsx")
    const candidates = resolveExternalPluginCandidates({
      cwd,
      execPath: "/tmp/bun",
      moduleUrl: pathToFileURL(source).href,
    })

    expect(candidates).toContain(join(root, ".plugin", "index.tsx"))
  })
})
