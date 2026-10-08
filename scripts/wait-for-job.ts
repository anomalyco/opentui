import process from "node:process"
import { setTimeout as sleep } from "node:timers/promises"

// Waits until a job in the current workflow run succeeds. A job can then do its own setup while the
// other job runs, instead of starting only after it with `needs`. Fails if that job fails or the
// wait times out. Needs GITHUB_TOKEN with `actions: read`.

interface Job {
  name: string
  status: string
  conclusion: string | null
  run_attempt: number
}

const POLL_MS = 5_000
const MAX_API_FAILURES = 5

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}`)
  return value
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`)
  return value
}

// A partial re-run keeps jobs from earlier attempts, so use the job's latest attempt.
async function latestJob(name: string): Promise<Job | undefined> {
  const url = `${requireEnv("GITHUB_API_URL")}/repos/${requireEnv("GITHUB_REPOSITORY")}/actions/runs/${requireEnv("GITHUB_RUN_ID")}/jobs?filter=all&per_page=100`
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${requireEnv("GITHUB_TOKEN")}`,
      "x-github-api-version": "2022-11-28",
    },
  })
  if (!response.ok) throw new Error(`GitHub API returned ${response.status} for ${url}`)
  const { jobs } = (await response.json()) as { jobs: Job[] }
  return jobs.filter((job) => job.name === name).sort((left, right) => right.run_attempt - left.run_attempt)[0]
}

async function main(): Promise<void> {
  const name = readFlag("--name")
  if (!name) throw new Error("Usage: wait-for-job.ts --name <job name> [--timeout <seconds>]")
  const timeoutSeconds = Number(readFlag("--timeout") ?? "1800")
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error("--timeout must be a positive number")

  const start = Date.now()
  let failures = 0
  let lastStatus = ""
  while (true) {
    let job: Job | undefined
    try {
      job = await latestJob(name)
      failures = 0
    } catch (error) {
      failures++
      if (failures >= MAX_API_FAILURES) throw error
      console.error(`${error instanceof Error ? error.message : error}; retrying`)
    }
    if (job) {
      if (job.status === "completed") {
        if (job.conclusion !== "success") throw new Error(`${name} finished with ${job.conclusion}`)
        console.log(`${name} succeeded after ${Math.round((Date.now() - start) / 1000)}s of waiting`)
        return
      }
      if (job.status !== lastStatus) console.log(`${name} is ${job.status}`)
      lastStatus = job.status
    } else if (failures === 0) {
      throw new Error(`No job named ${name} in this run`)
    }
    if (Date.now() - start > timeoutSeconds * 1000)
      throw new Error(`Timed out after ${timeoutSeconds}s waiting for ${name}`)
    await sleep(POLL_MS)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
