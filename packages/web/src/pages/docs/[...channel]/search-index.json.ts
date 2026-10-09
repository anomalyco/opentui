import type { APIRoute, GetStaticPaths } from "astro"

import { channelRoutes, channelUrl, type DocsChannel } from "../../../lib/docs-channel"
import { buildDocsSearchIndex } from "../../../lib/docs-search-index"

export const getStaticPaths = (() => channelRoutes()) satisfies GetStaticPaths

export const GET: APIRoute<{ channel: DocsChannel }> = async ({ props }) => {
  const entries = await buildDocsSearchIndex()
  return new Response(
    JSON.stringify(entries.map((entry) => ({ ...entry, url: channelUrl(entry.url, props.channel) }))),
    {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
    },
  )
}
