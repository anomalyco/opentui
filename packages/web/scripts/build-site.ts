#!/usr/bin/env bun
// Builds the deployable site in two documentation channels, like go.dev and tip.golang.org:
//
//   /docs        the docs of the latest npm release, built from that release's tag
//   /docs/next   the docs of this checkout (main), marked unreleased
//
// Everything else on the site (home, packages, scrollback, release notes) comes from this checkout. The release
// channel uses this checkout's site code with the release tag's documentation content (RELEASE_CONTENT), so site
// fixes reach both channels while each channel documents its own code. The script then merges the builds,
// publishes the agent skill of each channel, writes the sitemap, and validates every link in the result.
//
// Usage: bun scripts/build-site.ts [--out <dir>] [--release <version>] [--keep]
//   --release  the release /docs documents (default: the npm "latest" dist-tag of @opentui/core)
//   --keep     keep the temporary build directories

import { spawn, spawnSync } from "node:child_process"
import { copyFile, cp, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import { DOCS_CHANNEL_BASES } from "../src/lib/docs-channel"
import { REPO_ROOT } from "../src/lib/repo-root"
import { publishSkill, readSkillFiles } from "./site/skill-archive"
import { writeSitemap } from "./site/sitemap"
import { listFiles, validateSite } from "./site/validate-site"

const SITE = "https://opentui.com"
const WEB = "packages/web"
const CONTENT = `${WEB}/src/content`

/** Paths that a release's documentation comes from. Release notes stay current: they come from this checkout. */
const RELEASE_CONTENT = [
  `${CONTENT}/docs`,
  `${CONTENT}/SKILL.md`,
  `${WEB}/src/lib/docs-manifest.ts`,
  `${WEB}/src/data/doc-visuals.json`,
]
const RELEASE_NOTES = `${CONTENT}/docs/releases`

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    out: { type: "string", default: "dist-site" },
    release: { type: "string" },
    keep: { type: "boolean", default: false },
  },
})

const out = resolve(values.out!)
const release = values.release ?? (await npmLatest("@opentui/core"))
if (!/^\d+\.\d+\.\d+$/.test(release)) throw new Error(`Invalid release version: ${release}`)

const temp = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "opentui-site-"))
const started = performance.now()

try {
  console.log(`Building the site: /docs documents ${release}, /docs/next documents this checkout.`)

  const nextWeb = join(REPO_ROOT, WEB)
  const releaseWeb = await releaseSourceTree(join(temp, "release-source"), release)

  // The API of this checkout's source, for /docs/next and its unreleased changes.
  const apiCurrent = join(temp, "api-current.txt")
  run("bun", ["scripts/api.ts", "current", "--out", apiCurrent], nextWeb)

  const nextEnv = { OPENTUI_DOCS_CHANNEL: "next", OPENTUI_DOCS_RELEASE: release, OPENTUI_API_CURRENT: apiCurrent }
  const releaseEnv = { OPENTUI_DOCS_CHANNEL: "stable", OPENTUI_DOCS_RELEASE: release }
  const pages = join(temp, "pages.json")
  await Bun.write(pages, JSON.stringify({ stable: routes(releaseWeb, releaseEnv), next: routes(nextWeb, nextEnv) }))

  const nextOut = join(temp, "next")
  const releaseOut = join(temp, "release")
  await astroBuild(nextWeb, nextOut, { ...nextEnv, OPENTUI_DOCS_PAGES: pages })
  await astroBuild(releaseWeb, releaseOut, {
    ...releaseEnv,
    OPENTUI_DOCS_PAGES: pages,
    OPENTUI_ASTRO_ASSETS: "docs/_astro",
  })

  await rm(out, { recursive: true, force: true })
  await cp(nextOut, out, { recursive: true })
  await expectEntries(join(out, "docs"), ["next"], "The main-branch build")
  await expectEntries(join(releaseOut, "docs"), undefined, "The release build", ["next"])
  await mergeTree(join(releaseOut, "docs"), join(out, "docs"))

  const releaseSkill = await publishSkill(out, ["/", "/docs"], await readSkillFiles(join(releaseWeb, "src/content")))
  const nextSkill = await publishSkill(out, [DOCS_CHANNEL_BASES.next], await readSkillFiles(join(REPO_ROOT, CONTENT)))
  console.log(`Skill ${release}: ${releaseSkill.skills[0].digest}; next: ${nextSkill.skills[0].digest}`)

  const urls = await writeSitemap(out, SITE)
  console.log(`Sitemap: ${urls.length} pages.`)

  const problems = await validateSite(out, { site: SITE, nextBase: DOCS_CHANNEL_BASES.next })
  for (const problem of problems) console.error(`${problem.page}: ${problem.message}`)
  if (problems.length > 0) throw new Error(`${problems.length} site link problems`)

  console.log(`Built ${out} in ${((performance.now() - started) / 1000).toFixed(1)}s.`)
} finally {
  if (values.keep) console.log(`Kept ${temp}`)
  else await rm(temp, { recursive: true, force: true })
}

/**
 * A copy of packages/web from the working tree with the release's documentation content, linked to the rest of
 * this checkout. It shares node_modules with the checkout but keeps its own Astro and Vite caches.
 */
async function releaseSourceTree(root: string, version: string): Promise<string> {
  const tag = `v${version}`
  ensureTag(tag)

  const web = join(root, WEB)
  const files = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", WEB])
    .split("\0")
    .filter((file) => file && !file.startsWith(`${WEB}/public/`) && existsSync(join(REPO_ROOT, file)))
  for (const file of files) {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await cp(join(REPO_ROOT, file), join(root, file))
  }
  await symlink(join(REPO_ROOT, WEB, "public"), join(web, "public"))

  for (const entry of await readdir(join(REPO_ROOT, "packages"))) {
    if (entry !== "web") await symlink(join(REPO_ROOT, "packages", entry), join(root, "packages", entry))
  }
  for (const entry of ["node_modules", "package.json", "api"]) {
    if (existsSync(join(REPO_ROOT, entry))) await symlink(join(REPO_ROOT, entry), join(root, entry))
  }
  await mkdir(join(web, "node_modules"))
  for (const entry of await readdir(join(REPO_ROOT, WEB, "node_modules"))) {
    if (entry === ".astro" || entry === ".vite" || entry === ".cache") continue
    await symlink(join(REPO_ROOT, WEB, "node_modules", entry), join(web, "node_modules", entry))
  }

  for (const path of RELEASE_CONTENT) await rm(join(root, path), { recursive: true, force: true })
  await extract(tag, RELEASE_CONTENT, root)
  await rm(join(root, RELEASE_NOTES), { recursive: true, force: true })
  if (existsSync(join(REPO_ROOT, RELEASE_NOTES))) {
    await cp(join(REPO_ROOT, RELEASE_NOTES), join(root, RELEASE_NOTES), { recursive: true })
  }
  return web
}

/** The logical URLs that a channel's build renders, from its source tree of packages/web. */
function routes(web: string, env: Record<string, string>): string[] {
  return JSON.parse(run("bun", ["scripts/site/channel-routes.ts"], web, env)) as string[]
}

function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
  const result = spawnSync(command, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed in ${cwd}:\n${result.stderr}`)
  return result.stdout
}

function ensureTag(tag: string) {
  const ref = `refs/tags/${tag}`
  const present = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: REPO_ROOT })
  if (present.status === 0) return
  console.log(`Fetching ${tag}`)
  git(["fetch", "--no-tags", "--depth=1", "origin", `+${ref}:${ref}`])
}

async function extract(tag: string, paths: string[], destination: string) {
  const archive = spawn("git", ["archive", "--format=tar", tag, "--", ...paths], { cwd: REPO_ROOT })
  const tar = spawn("tar", ["-x", "-C", destination], { stdio: ["pipe", "inherit", "inherit"] })
  archive.stdout.pipe(tar.stdin)
  archive.stderr.pipe(process.stderr)
  const [archiveCode, tarCode] = await Promise.all([exited(archive), exited(tar)])
  if (archiveCode !== 0 || tarCode !== 0) throw new Error(`Could not extract ${paths.join(", ")} from ${tag}`)
}

async function astroBuild(cwd: string, outDir: string, env: Record<string, string>) {
  console.log(
    `astro build (${Object.entries(env)
      .map(([key, value]) => `${key}=${value}`)
      .join(" ")})`,
  )
  const child = spawn(join(cwd, "node_modules/.bin/astro"), ["build", "--outDir", outDir], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "inherit", "inherit"],
  })
  if ((await exited(child)) !== 0) throw new Error(`astro build failed in ${cwd}`)
}

/** Copies every file of source into destination and fails on a file that both builds wrote. */
async function mergeTree(source: string, destination: string) {
  for (const file of await listFiles(source)) {
    const target = join(destination, relative(source, file))
    if (existsSync(target)) throw new Error(`Both builds wrote ${target}`)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(file, target)
  }
}

async function expectEntries(directory: string, only?: string[], label = directory, forbidden: string[] = []) {
  const entries = await readdir(directory)
  if (only && entries.join() !== only.join()) {
    throw new Error(`${label} must write only ${only.join(", ")} under /docs, not ${entries.join(", ")}`)
  }
  const clash = entries.filter((entry) => forbidden.includes(entry))
  if (clash.length > 0) throw new Error(`${label} must not write ${clash.join(", ")} under /docs`)
}

async function npmLatest(name: string): Promise<string> {
  const response = await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  })
  if (!response.ok) throw new Error(`npm registry: ${response.status} for ${name}`)
  const metadata = (await response.json()) as { "dist-tags"?: { latest?: string } }
  const latest = metadata["dist-tags"]?.latest
  if (!latest) throw new Error(`${name} has no latest dist-tag`)
  return latest
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`)
  return result.stdout
}

function exited(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", resolve)
  })
}
