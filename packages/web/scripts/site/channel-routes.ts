// Prints, as a JSON array, the logical /docs URLs that a channel's build renders: documentation pages, release
// pages, and API reference pages. scripts/build-site.ts runs it for each channel's source tree, with the same
// OPENTUI_DOCS_* and OPENTUI_API_CURRENT environment as the build, so each build knows what the other one has.
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { channelApi } from "../../src/lib/api-docs"
import { moduleSlug } from "../../src/lib/api-reference"
import { docsChannel } from "../../src/lib/docs-channel"
import { buildDocsIndex } from "../../src/lib/docs-index"
import { channelVersions } from "../../src/lib/release-notes"
import { REPO_ROOT } from "../../src/lib/repo-root"

const channel = docsChannel()
const [index, api, notes] = await Promise.all([
  buildDocsIndex(),
  channelApi(channel),
  readdir(join(REPO_ROOT, "packages/web/src/content/docs/releases")).catch(() => [] as string[]),
])

const versions = channelVersions(
  channel,
  notes.filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -".md".length)),
  api?.versions ?? [],
)
const urls = [
  ...index.pages.map((page) => page.url),
  "/docs/releases",
  ...versions.map((version) => `/docs/releases/${version}`),
  ...(api?.unreleased ? ["/docs/releases/unreleased"] : []),
  ...(api ? ["/docs/api", ...new Set(api.features.map((feature) => `/docs/api/${moduleSlug(feature.module)}`))] : []),
]
console.log(JSON.stringify(urls))
