import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { createTar, publishSkill, skillMetadata, type SkillFile } from "./skill-archive"
import { writeSitemap } from "./sitemap"
import { validateSite } from "./validate-site"

function site(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "opentui-site-test-"))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

const page = (body: string, head = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`
const options = { site: "https://opentui.com", nextBase: "/docs/next" }

test("the skill archive is a deterministic ustar archive that tar reads back", async () => {
  const encoder = new TextEncoder()
  const long = `docs/${"nested/".repeat(16)}page.mdx`
  const files: SkillFile[] = [
    { path: "SKILL.md", content: encoder.encode("---\nname: opentui\ndescription: Build terminal UIs.\n---\n") },
    { path: long, content: encoder.encode("x".repeat(700)) },
  ]
  const root = site({})
  const first = await publishSkill(root, ["/", "/docs/next"], files)
  const second = await publishSkill(site({}), ["/"], files)

  expect(first.skills[0]).toMatchObject({ name: "opentui", type: "archive", url: "opentui.tar.gz" })
  expect(first.skills[0].digest).toBe(second.skills[0].digest)
  expect(JSON.parse(readFileSync(join(root, "docs/next/.well-known/agent-skills/index.json"), "utf8"))).toEqual(first)

  const listing = spawnSync("tar", ["-tzf", join(root, ".well-known/agent-skills/opentui.tar.gz")], {
    encoding: "utf8",
  })
  expect(listing.stdout.trim().split("\n")).toEqual(["SKILL.md", long])
  expect(createTar(files).byteLength % 512).toBe(0)
})

test.each([
  ["no frontmatter", "# Skill", "frontmatter"],
  ["an invalid name", "---\nname: OpenTUI\ndescription: d\n---\n", "lowercase"],
  ["no description", "---\nname: opentui\n---\n", "description"],
])("skill metadata rejects %s", (_, source, message) => {
  expect(() => skillMetadata(source)).toThrow(message)
})

test("the site validator reports broken links, missing fragments, and links that leave a channel", async () => {
  const root = site({
    "index.html": page('<a href="/docs/">Docs</a><a href="https://example.com/x">External</a>'),
    "docs/index.html": page(
      [
        '<h2 id="intro">Intro</h2>',
        '<a href="#intro">ok</a>',
        '<a href="#missing">bad fragment</a>',
        '<a href="/docs/next/">leaves</a>',
        '<a href="/docs/next/" data-docs-channel="next">switch</a>',
        '<a href="/docs/gone">broken</a>',
        '<img src="/docs/_astro/a.png">',
      ].join(""),
      '<link rel="canonical" href="https://opentui.com/docs/">',
    ),
    "docs/_astro/a.png": "",
    "docs/next/index.html": page('<a href="/docs/#intro">leaves</a><a href="/scrollback/">site page</a>'),
    "docs/old/index.html": page("", '<meta http-equiv="refresh" content="0;url=/docs/moved">'),
    "scrollback/index.html": page('<a href="/docs/next/">from outside the docs</a>'),
  })

  expect(await validateSite(root, options)).toEqual([
    { page: "/docs/", message: 'a href="#missing" names a missing fragment' },
    { page: "/docs/", message: 'a href="/docs/next/" leaves the release documentation' },
    { page: "/docs/", message: 'a href="/docs/gone" does not resolve to a file' },
    { page: "/docs/next/", message: 'a href="/docs/#intro" leaves the main-branch documentation' },
    { page: "/docs/old/", message: 'meta content="/docs/moved" does not resolve to a file' },
  ])
})

test("the sitemap lists indexable pages only", async () => {
  const root = site({
    "index.html": page(""),
    "404.html": page(""),
    "docs/index.html": page(""),
    "docs/next/index.html": page("", '<meta name="robots" content="noindex">'),
    "docs/old/index.html": page("", '<meta http-equiv="refresh" content="0;url=/docs">'),
    "docs/search-index.json": "[]",
  })

  expect(await writeSitemap(root, "https://opentui.com")).toEqual(["https://opentui.com/docs/", "https://opentui.com/"])
  expect(readFileSync(join(root, "sitemap-index.xml"), "utf8")).toContain(
    "<loc>https://opentui.com/sitemap-0.xml</loc>",
  )
})
