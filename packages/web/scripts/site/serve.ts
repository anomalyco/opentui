// Serves a built site the way GitHub Pages does: directory paths redirect to a trailing slash and serve
// index.html, unknown paths serve 404.html with status 404, and dotfiles such as .well-known are served.
//
// Usage: bun scripts/site/serve.ts [directory] [port]
import { stat } from "node:fs/promises"
import { join, normalize } from "node:path"

const root = process.argv[2] ?? "dist-site"
const port = Number(process.argv[3] ?? 4400)

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url)
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.(\/|$))+/, "")
    const file = join(root, path)
    const info = await stat(file).catch(() => undefined)

    if (info?.isDirectory()) {
      if (!url.pathname.endsWith("/")) return Response.redirect(`${url.pathname}/${url.search}`, 301)
      const index = Bun.file(join(file, "index.html"))
      if (await index.exists()) return new Response(index)
    } else if (info?.isFile()) {
      return new Response(Bun.file(file))
    }
    return new Response(Bun.file(join(root, "404.html")), { status: 404, headers: { "content-type": "text/html" } })
  },
})

console.log(`Serving ${root} at ${server.url}`)
