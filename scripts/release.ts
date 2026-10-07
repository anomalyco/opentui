import { spawnSync } from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

import { compareVersions, registryIntegrity } from "./npm-publish"

// Releases main, or a maintenance branch of an older release line such as 0.5.x. release.yml publishes
// each commit on those branches that raises the version, so a release is a "Release vX.Y.Z" commit,
// pushed directly or merged from a pull request. Run it on the branch to release. A maintenance branch
// must start at a release tag that has this script; the workflows of older tags do not release it.
//
//   bun run release <patch|minor|major|version> [--pr | --dry-run] [--no-watch]
//
// 1. Checks that the branch has no uncommitted changes and matches its origin branch.
// 2. Runs prepare-release, commits "Release vX.Y.Z", tags it vX.Y.Z, and pushes the commit to the
//    branch together with the tag. That needs the right to bypass the branch and tag rules. A
//    maintenance branch takes only versions of its line.
// 3. Follows the release.yml run of the tag push. Its publish job ends when npm serves every package,
//    and this script reports that time.
//
// --pr pushes the commit to a release/vX.Y.Z branch and opens a pull request instead. Merging it
// releases. The "Prepare Release" workflow, the release button, runs this mode.
//
// --dry-run tags the commit vX.Y.Z-dry.N and pushes only the tag. The branch does not change. The release
// run builds and packs every package but publishes nothing to npm; it creates a GitHub prerelease.
// --no-watch stops after the push.

type Mode = "push" | "pr" | "dry-run"

interface Options {
  target: string
  mode: Mode
  watch: boolean
}

interface Release {
  version: string
  // The branch that releases it: main or a maintenance branch.
  branch: string
  sha: string
  // The tag whose push starts the release run, or the pull request branch. Without refs/tags/ or
  // refs/heads/.
  ref: string
  pushedAt: number
}

interface WorkflowRun {
  id: number
  name: string
  status: string
  conclusion: string | null
  head_sha: string
  html_url: string
}

interface Job {
  name: string
  status: string
  conclusion: string | null
}

const MAIN = "main"
const MAINTENANCE_BRANCH = /^(\d+)\.(\d+)\.x$/
const RELEASE_WORKFLOW = "release.yml"
const NPM_PUBLISH_JOB = "NPM Publish / publish"
const RELEASE_TYPES = ["patch", "minor", "major"]
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
const POLL_MS = 10_000
const MAX_API_FAILURES = 5
const RUN_START_TIMEOUT_MS = 3 * 60_000
const RUN_TIMEOUT_MS = 60 * 60_000
const USAGE = "Usage: bun run release <patch|minor|major|version> [--pr | --dry-run] [--no-watch]"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// A definite failure. Polling retries other errors, which are usually failed API requests.
class ReleaseError extends Error {}

function parseOptions(args: readonly string[]): Options {
  const flags = args.filter((arg) => arg.startsWith("--"))
  const positional = args.filter((arg) => !arg.startsWith("--"))
  const unknown = flags.filter((flag) => !["--pr", "--dry-run", "--no-watch"].includes(flag))
  if (unknown.length > 0) throw new ReleaseError(`Unknown option ${unknown.join(", ")}\n${USAGE}`)
  if (flags.includes("--pr") && flags.includes("--dry-run")) throw new ReleaseError(`Use --pr or --dry-run\n${USAGE}`)
  if (positional.length !== 1) throw new ReleaseError(USAGE)
  const target = positional[0]!.replace(/^v/, "")
  if (!RELEASE_TYPES.includes(target) && !VERSION_PATTERN.test(target)) {
    throw new ReleaseError(`Not a release type or version: ${positional[0]}\n${USAGE}`)
  }
  // release.yml handles tags that contain these as snapshots and dry runs.
  if (target.includes("snapshot") || target.includes("-dry.")) {
    throw new ReleaseError(`A release version cannot contain "snapshot" or "-dry.": ${target}`)
  }
  const mode = flags.includes("--pr") ? "pr" : flags.includes("--dry-run") ? "dry-run" : "push"
  return { target, mode, watch: !flags.includes("--no-watch") }
}

function run(command: string, args: readonly string[], options: { inherit?: boolean } = {}): string {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].map((text) => text?.trim()).filter(Boolean)
    const shown = args.map((arg) =>
      arg.length > 60 || arg.includes("\n") ? `${arg.slice(0, 40).split("\n")[0]}...` : arg,
    )
    throw new Error([`${command} ${shown.join(" ")} failed`, ...output].join("\n"))
  }
  return result.stdout?.trim() ?? ""
}

function git(...args: string[]): string {
  return run("git", args)
}

function gh<T>(path: string): T {
  return JSON.parse(run("gh", ["api", path])) as T
}

function ghPost<T>(path: string, fields: Record<string, string>): T {
  const args = Object.entries(fields).flatMap(([key, value]) => ["--raw-field", `${key}=${value}`])
  return JSON.parse(run("gh", ["api", "--method", "POST", ...args, path])) as T
}

// Reads every page of a list endpoint. `jq` selects the items of one page.
function ghList<T>(path: string, jq: string): T[] {
  return run("gh", ["api", "--paginate", "--jq", jq, path])
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

function short(sha: string | undefined): string {
  return sha ? sha.slice(0, 9) : "nothing"
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

async function poll<T>(what: string, timeoutMs: number, attempt: () => T | undefined): Promise<T> {
  const start = Date.now()
  let failures = 0
  while (true) {
    try {
      const result = attempt()
      failures = 0
      if (result !== undefined) return result
    } catch (error) {
      if (error instanceof ReleaseError || ++failures >= MAX_API_FAILURES) throw error
      console.error(`${error instanceof Error ? error.message : error}; retrying`)
    }
    if (Date.now() - start > timeoutMs) {
      throw new ReleaseError(`Timed out after ${formatDuration(timeoutMs)} waiting for ${what}`)
    }
    await sleep(POLL_MS)
  }
}

function githubRepo(): string {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY
  const url = git("remote", "get-url", "origin")
  const match = /github\.com[:/](.+?)(?:\.git)?\/?$/.exec(url)
  if (!match) throw new ReleaseError(`origin is not a GitHub repository: ${url}`)
  return match[1]!
}

function remoteSha(ref: string): string | undefined {
  return git("ls-remote", "origin", ref).split(/\s+/)[0] || undefined
}

// Returns the checked-out release branch and its commit.
function checkBranch(): { branch: string; head: string } {
  let branch = ""
  try {
    branch = git("symbolic-ref", "--quiet", "--short", "HEAD")
  } catch {}
  if (branch !== MAIN && !MAINTENANCE_BRANCH.test(branch)) {
    throw new ReleaseError(`Check out ${MAIN} or a maintenance branch such as 0.5.x. HEAD is ${branch || "detached"}.`)
  }
  if (git("status", "--porcelain", "--untracked-files=no")) {
    throw new ReleaseError("Commit or stash the uncommitted changes first")
  }
  const head = git("rev-parse", "HEAD")
  const remote = remoteSha(`refs/heads/${branch}`)
  if (head !== remote) {
    throw new ReleaseError(`Local ${branch} is at ${short(head)} but origin/${branch} is at ${short(remote)}`)
  }
  return { branch, head }
}

function coreVersion(): string {
  return (JSON.parse(readFileSync(join(repoRoot, "packages", "core", "package.json"), "utf8")) as { version: string })
    .version
}

function nextDryRunTag(version: string): string {
  const prefix = `v${version}-dry.`
  const numbers = git("ls-remote", "--tags", "--refs", "origin", `refs/tags/${prefix}*`)
    .split("\n")
    .map((line) => Number(line.split(`refs/tags/${prefix}`)[1]))
    .filter(Number.isInteger)
  return `${prefix}${Math.max(0, ...numbers) + 1}`
}

// The commit that a tag on origin points to.
function remoteTagCommit(tag: string): string | undefined {
  const lines = git("ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`).split("\n")
  const peeled = lines.find((line) => line.endsWith("^{}")) ?? lines[0]
  return peeled?.split(/\s+/)[0] || undefined
}

// Pushes the refs together. The last one is the ref whose push starts the release run.
function push(refspecs: readonly string[], sha: string): void {
  try {
    run("git", ["push", "--atomic", "origin", ...refspecs], { inherit: true })
  } catch (error) {
    // The push can reach origin and still fail here, for example when the connection drops.
    const last = refspecs.at(-1)!
    const target = last.slice(last.indexOf(":") + 1)
    const landed = target.startsWith("refs/tags/")
      ? remoteTagCommit(target.slice("refs/tags/".length))
      : remoteSha(target)
    if (landed === sha) return
    throw error
  }
}

// Undoes the release commit, tag, and pull request branch. The working tree had no uncommitted changes
// before them.
function restore(branch: string, base: string, tag: string | undefined, prBranch: string | undefined): void {
  console.error(`Restoring ${branch} to ${short(base)}`)
  git("switch", "--quiet", "--force", branch)
  git("reset", "--quiet", "--hard", base)
  if (tag) spawnSync("git", ["tag", "--delete", tag], { cwd: repoRoot, stdio: "ignore" })
  if (prBranch) spawnSync("git", ["branch", "--delete", "--force", prBranch], { cwd: repoRoot, stdio: "ignore" })
}

async function pushRelease(options: Options, branch: string, base: string): Promise<Release> {
  const previous = coreVersion()
  let tag: string | undefined
  let prBranch: string | undefined
  let interrupted = false
  const onInterrupt = () => {
    interrupted = true
  }
  const stopIfInterrupted = () => {
    if (interrupted) throw new ReleaseError("Interrupted")
  }
  process.on("SIGINT", onInterrupt)
  try {
    // A dry run commits on a detached HEAD, so the branch does not change.
    if (options.mode === "dry-run") git("switch", "--quiet", "--detach")
    const prepareArgs = RELEASE_TYPES.includes(options.target) ? [`--${options.target}`] : [options.target]
    console.log(`Running prepare-release ${prepareArgs[0]}...`)
    run("bun", ["scripts/prepare-release.ts", ...prepareArgs])
    stopIfInterrupted()

    const version = coreVersion()
    if (compareVersions(version, previous) <= 0) {
      throw new ReleaseError(`${version} is not newer than ${previous}, the version on ${branch}`)
    }
    const line = MAINTENANCE_BRANCH.exec(branch)
    if (line && !version.startsWith(`${line[1]}.${line[2]}.`)) {
      throw new ReleaseError(`${version} is not a version of ${branch}`)
    }
    if (remoteSha(`refs/tags/v${version}`)) throw new ReleaseError(`Tag v${version} already exists on origin`)
    if ((await registryIntegrity("@opentui/core", version)) !== undefined) {
      throw new ReleaseError(`@opentui/core@${version} is already on npm`)
    }
    // The branch and the tag are recorded only once created, so that a failure never deletes one that
    // existed before.
    if (options.mode === "pr") {
      const name = `release/v${version}`
      if (remoteSha(`refs/heads/${name}`)) throw new ReleaseError(`Branch ${name} already exists on origin`)
      git("switch", "--quiet", "--create", name)
      prBranch = name
    }
    stopIfInterrupted()

    console.log(`Prepared ${previous} -> ${version}. Committing...`)
    run("git", ["commit", "--quiet", "--all", "--message", `Release v${version}`], { inherit: true })
    if (options.mode !== "pr") {
      const name = options.mode === "dry-run" ? nextDryRunTag(version) : `v${version}`
      run("git", ["tag", "--annotate", name, "--message", `Release ${name}`], { inherit: true })
      tag = name
    }
    const sha = git("rev-parse", "HEAD")
    stopIfInterrupted()

    // A release pushes the commit with its tag. The run of the tag push releases it, with the tag as
    // its ref, which is the ref that the Windows signing in Azure trusts.
    const ref = tag ?? prBranch!
    const refspecs = {
      push: [`HEAD:refs/heads/${branch}`, `refs/tags/${ref}`],
      "dry-run": [`refs/tags/${ref}`],
      pr: [`HEAD:refs/heads/${ref}`],
    }[options.mode]
    push(refspecs, sha)
    const release = { version, branch, sha, ref, pushedAt: Date.now() }
    if (options.mode !== "push") git("switch", "--quiet", branch)
    if (prBranch) git("branch", "--quiet", "--delete", "--force", prBranch)
    return release
  } catch (error) {
    try {
      restore(branch, base, tag, prBranch)
    } catch (restoreError) {
      console.error(restoreError instanceof Error ? restoreError.message : restoreError)
    }
    throw error
  } finally {
    process.off("SIGINT", onInterrupt)
  }
}

async function findReleaseRun(repo: string, release: Release): Promise<WorkflowRun> {
  const path = `repos/${repo}/actions/workflows/${RELEASE_WORKFLOW}/runs?event=push&branch=${encodeURIComponent(release.ref)}&head_sha=${release.sha}&per_page=10`
  return poll(`the ${RELEASE_WORKFLOW} run of ${short(release.sha)}`, RUN_START_TIMEOUT_MS, () =>
    gh<{ workflow_runs: WorkflowRun[] }>(path).workflow_runs.find(
      (workflowRun) => workflowRun.head_sha === release.sha,
    ),
  )
}

// Pull requests opened with the GITHUB_TOKEN of a workflow start no workflows, so the required checks
// do not run on them.
function openPullRequest(repo: string, release: Release): string {
  const body = `Merging this pull request releases v${release.version}. release.yml publishes each commit on ${release.branch} that raises the version.`
  try {
    return ghPost<{ html_url: string }>(`repos/${repo}/pulls`, {
      title: `Release v${release.version}`,
      head: release.ref,
      base: release.branch,
      body,
    }).html_url
  } catch (error) {
    spawnSync("git", ["push", "--quiet", "origin", "--delete", `refs/heads/${release.ref}`], {
      cwd: repoRoot,
      stdio: "ignore",
    })
    throw error
  }
}

// Prints each job as it starts and ends. Returns the finished run and when the publish job succeeded.
async function watchRelease(
  repo: string,
  releaseRun: WorkflowRun,
  release: Release,
  dryRun: boolean,
): Promise<{ finished: WorkflowRun; npmDoneAt?: number }> {
  const states = new Map<string, string>()
  let npmDoneAt: number | undefined
  const finished = await poll(releaseRun.html_url, RUN_TIMEOUT_MS, () => {
    for (const job of ghList<Job>(`repos/${repo}/actions/runs/${releaseRun.id}/jobs?per_page=100`, ".jobs[]")) {
      const state =
        job.status === "completed" ? (job.conclusion ?? "completed") : job.status === "in_progress" ? "started" : ""
      if (!state || state === "skipped" || states.get(job.name) === state) continue
      states.set(job.name, state)
      console.log(`${formatDuration(Date.now() - release.pushedAt).padStart(7)}  ${job.name}: ${state}`)
      if (job.name === NPM_PUBLISH_JOB && state === "success" && npmDoneAt === undefined) {
        npmDoneAt = Date.now()
        console.log(
          dryRun
            ? "Dry run: every package packed, nothing published"
            : `npm serves every package of ${release.version}`,
        )
      }
    }
    const current = gh<WorkflowRun>(`repos/${repo}/actions/runs/${releaseRun.id}`)
    return current.status === "completed" ? current : undefined
  })
  return { finished, npmDoneAt }
}

function report(lines: readonly string[]): void {
  console.log(`\n${lines.join("\n")}`)
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) appendFileSync(summary, `${lines.join("\n")}\n`)
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const repo = githubRepo()
  const { branch, head: base } = checkBranch()
  console.log(`Releasing ${repo} ${branch} at ${short(base)}: ${options.target}, ${options.mode}`)

  const release = await pushRelease(options, branch, base)
  const pushedTo = options.mode === "push" ? `${release.branch} and ${release.ref}` : release.ref
  console.log(`Pushed Release v${release.version} (${short(release.sha)}) to ${pushedTo}`)
  if (options.mode === "pr") {
    const url = openPullRequest(repo, release)
    report([`Opened ${url}`, `- Merge it to release v${release.version}.`])
    return
  }

  const tag = release.ref
  const releaseRun = await findReleaseRun(repo, release)
  console.log(`Release run: ${releaseRun.html_url}`)
  if (!options.watch) {
    report([`Pushed ${tag}`, `- Release run: ${releaseRun.html_url}`])
    return
  }

  const dryRun = options.mode === "dry-run"
  const { finished, npmDoneAt } = await watchRelease(repo, releaseRun, release, dryRun)
  const elapsed = (time: number) => formatDuration(time - release.pushedAt)
  if (finished.conclusion !== "success") {
    report([
      `Release ${tag} failed: ${finished.conclusion}`,
      `- Release run: ${finished.html_url}`,
      "- Publishing resumes where it stopped: re-run the failed jobs, then follow them with `gh run watch`.",
    ])
    throw new ReleaseError(`The release run of ${tag} ended with ${finished.conclusion}`)
  }
  // A run whose prepare job saw no release skips every other job and still succeeds.
  if (npmDoneAt === undefined) {
    report([`Release ${tag} did not run`, `- Release run: ${finished.html_url}`])
    throw new ReleaseError(`The release run of ${tag} skipped the publish job`)
  }
  report([
    dryRun ? `Dry run ${tag} passed` : `Released ${tag}`,
    dryRun
      ? `- Packages packed ${elapsed(npmDoneAt)} after the push`
      : `- npm serves every package ${elapsed(npmDoneAt)} after the push`,
    `- Release run finished ${elapsed(Date.now())} after the push: ${finished.html_url}`,
    `- GitHub release: https://github.com/${repo}/releases/tag/${tag}`,
  ])
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
