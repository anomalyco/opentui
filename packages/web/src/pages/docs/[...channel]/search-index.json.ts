import type { APIRoute, GetStaticPaths } from "astro"

import { channelUrl, docsChannel, docsRouteParam } from "../../../lib/docs-channel"
import { buildDocsSearchIndex } from "../../../lib/docs-search-index"

export const getStaticPaths = (() => [
  { params: { channel: docsRouteParam(docsChannel().base) } },
]) satisfies GetStaticPaths

export const GET: APIRoute = async () => {
  const channel = docsChannel()
  const entries = await buildDocsSearchIndex()
  return new Response(JSON.stringify(entries.map((entry) => ({ ...entry, url: channelUrl(entry.url, channel) }))), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  })
}
