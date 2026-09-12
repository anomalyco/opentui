import type { APIRoute } from "astro"

import { buildDocsSearchIndex } from "../../lib/docs-search-index"

export const GET: APIRoute = async () => {
  const entries = await buildDocsSearchIndex()
  return new Response(JSON.stringify(entries), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  })
}
