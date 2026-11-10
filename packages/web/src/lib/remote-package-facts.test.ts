import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { updatePackageFacts } from "../../scripts/update-package-facts"
import { remotePackageFactsSchema } from "./remote-package-facts"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("remote package facts schema", () => {
  test("rejects malformed facts and bounds", () => {
    expect(remotePackageFactsSchema.safeParse({ schemaVersion: 1, packages: [{ id: "empty" }] }).success).toBe(false)
    expect(
      remotePackageFactsSchema.safeParse({ schemaVersion: 1, packages: [{ id: "bad", version: "x".repeat(129) }] })
        .success,
    ).toBe(false)
    expect(remotePackageFactsSchema.safeParse({ schemaVersion: 1, packages: [{ id: "bad", stars: -1 }] }).success).toBe(
      false,
    )
    expect(
      remotePackageFactsSchema.safeParse({
        schemaVersion: 1,
        packages: [
          { id: "duplicate", stars: 1 },
          { id: "duplicate", stars: 2 },
        ],
      }).success,
    ).toBe(false)
    expect(
      remotePackageFactsSchema.safeParse({
        schemaVersion: 1,
        packages: Array.from({ length: 257 }, (_, index) => ({ id: `package-${index}`, stars: 0 })),
      }).success,
    ).toBe(false)
  })
})

describe("package facts updater", () => {
  test("deduplicates requests, authenticates GitHub, and applies source precedence", async () => {
    const root = await temporaryRoot()
    const firstParty = join(root, "official")
    const community = join(root, "community")
    await Promise.all([mkdir(firstParty), mkdir(community)])
    await writeEntry(firstParty, "official-one", true, [{ type: "npm", identifier: "ignored" }])
    await writeEntry(firstParty, "official-two", true, [{ type: "source" }])
    await writeEntry(community, "npm-package", false, [
      { type: "github-release", identifier: "example/shared" },
      { type: "npm", identifier: "npm-package" },
      { type: "npm", identifier: "beta-package" },
    ])
    await writeEntry(community, "release-package", false, [{ type: "github-release", identifier: "example/shared" }])
    await writeEntry(
      community,
      "non-github-package",
      false,
      [{ type: "npm", identifier: "non-github-package" }],
      "https://gitlab.com/example/non-github-package",
    )

    const calls: Array<{ url: string; init?: RequestInit }> = []
    const responses: Record<string, unknown> = {
      "https://api.github.com/repos/anomalyco/opentui": {
        stargazers_count: 100,
        license: { spdx_id: "MIT" },
      },
      "https://api.github.com/repos/example/shared": { stargazers_count: 7, license: { spdx_id: "Apache-2.0" } },
      "https://api.github.com/repos/example/shared/releases/latest": { tag_name: "v2.0.0" },
      "https://gitlab.com/example/non-github-package": {},
      "https://registry.npmjs.org/beta-package": {},
      "https://registry.npmjs.org/ignored": {},
      "https://registry.npmjs.org/non-github-package/latest": { version: "3.0.0", license: "BSD-2-Clause" },
      "https://registry.npmjs.org/npm-package/latest": { version: "1.4.0", license: "ISC" },
    }
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      const body = responses[url]
      if (!body) return new Response("missing", { status: 404 })
      return Response.json(body)
    }) as typeof fetch

    const facts = await updatePackageFacts(community, {
      firstPartyDirectory: firstParty,
      fetch: fetchMock,
      githubToken: "secret-token",
    })

    expect(calls.filter(({ url }) => url === "https://api.github.com/repos/anomalyco/opentui")).toHaveLength(1)
    expect(calls.filter(({ url }) => url.endsWith("/releases/latest"))).toHaveLength(1)
    expect(calls.filter(({ url }) => url === "https://registry.npmjs.org/ignored")).toHaveLength(1)
    expect(calls.find(({ url }) => url === "https://registry.npmjs.org/ignored")?.init?.method).toBe("HEAD")
    expect(calls.filter(({ url }) => url === "https://registry.npmjs.org/beta-package/latest")).toHaveLength(0)
    expect(calls.filter(({ url }) => url === "https://gitlab.com/example/non-github-package")).toHaveLength(1)
    const githubHeaders = new Headers(calls.find(({ url }) => url.includes("api.github.com"))?.init?.headers)
    expect(githubHeaders.get("Authorization")).toBe("Bearer secret-token")
    expect(githubHeaders.get("Accept")).toBe("application/vnd.github+json")
    expect(githubHeaders.get("X-GitHub-Api-Version")).toBe("2022-11-28")
    expect(githubHeaders.get("User-Agent")).toBe("opentui-package-facts")
    expect(facts.packages).toEqual([
      { id: "non-github-package", version: "3.0.0", license: "BSD-2-Clause" },
      { id: "npm-package", version: "1.4.0", license: "ISC", stars: 7 },
      { id: "official-one", stars: 100 },
      { id: "official-two", stars: 100 },
      { id: "release-package", version: "v2.0.0", license: "Apache-2.0", stars: 7 },
    ])
    expect(JSON.parse(await readFile(join(community, "facts.json"), "utf8"))).toEqual(facts)
    await expect(
      updatePackageFacts(community, {
        firstPartyDirectory: firstParty,
        fetch: fetchMock,
        githubToken: "invalid token",
      }),
    ).rejects.toThrow("GITHUB_TOKEN must be a nonempty token without whitespace")

    await writeEntry(community, "ssh-package", false, [{ type: "source" }], "ssh://git@gitlab.com/example/package.git")
    await expect(updatePackageFacts(community, { firstPartyDirectory: firstParty, fetch: fetchMock })).rejects.toThrow(
      "Cannot verify non-HTTP source URL",
    )
  })

  test("stops before exceeding the GitHub request budget", async () => {
    const root = await temporaryRoot()
    const firstParty = join(root, "official")
    const community = join(root, "community")
    await Promise.all([mkdir(firstParty), mkdir(community)])
    await Promise.all(
      Array.from({ length: 63 }, (_, packageIndex) =>
        writeEntry(
          community,
          `package-${packageIndex}`,
          false,
          Array.from({ length: 8 }, (_, repositoryIndex) => ({
            type: "github-release",
            identifier: `owner-${packageIndex}/repository-${repositoryIndex}`,
          })),
        ),
      ),
    )

    let requests = 0
    const fetchMock = (async () => {
      requests++
      return Response.json({ stargazers_count: 1, tag_name: "v1.0.0", license: { spdx_id: "MIT" } })
    }) as typeof fetch

    await expect(updatePackageFacts(community, { firstPartyDirectory: firstParty, fetch: fetchMock })).rejects.toThrow(
      "GitHub request count exceeds maximum 500",
    )
    expect(requests).toBe(500)
  })
})

async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opentui-package-facts-"))
  temporaryDirectories.push(directory)
  return directory
}

async function writeEntry(
  directory: string,
  id: string,
  official: boolean,
  distributions: Array<{ type: string; identifier?: string }>,
  source = official ? "https://github.com/anomalyco/opentui" : "https://github.com/example/shared",
) {
  const maintainers = official ? "" : "maintainers:\n  - example\n"
  const distributionYaml = distributions
    .map(({ type, identifier }) => `  - type: ${type}${identifier ? `\n    identifier: ${identifier}` : ""}`)
    .join("\n")
  await writeFile(
    join(directory, `${id}.mdx`),
    `---\nid: ${id}\nname: ${id}\nsummary: Test package.\nkind: library\nofficial: ${official}\n${maintainers}source:\n  url: ${source}\ndistributions:\n${distributionYaml}\n---\n`,
  )
}
