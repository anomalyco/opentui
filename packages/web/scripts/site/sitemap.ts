import { readFile, writeFile } from "node:fs/promises"
import { join, relative, sep } from "node:path"
import { elements, listFiles } from "./validate-site"

// The sitemap lists every indexable page of the assembled site: not 404, not redirects, and not pages with a
// robots noindex meta tag (the main-branch docs and lab pages). It keeps the file names that robots.txt names.

export async function writeSitemap(root: string, site: string): Promise<string[]> {
  const urls: string[] = []
  const files = (await listFiles(root)).map((file) => relative(root, file).split(sep).join("/"))

  for (const file of files.filter((file) => file.endsWith(".html") && file !== "404.html").sort()) {
    const tags = elements(await readFile(join(root, file), "utf8")).filter((element) => element.name === "meta")
    const noindex = tags.some(
      (meta) => meta.attributes.get("name") === "robots" && /\bnoindex\b/.test(meta.attributes.get("content") ?? ""),
    )
    const redirect = tags.some((meta) => meta.attributes.get("http-equiv")?.toLowerCase() === "refresh")
    if (noindex || redirect) continue

    const path = file === "index.html" ? "" : file.endsWith("/index.html") ? file.slice(0, -"index.html".length) : file
    urls.push(new URL(`/${path}`, site).href)
  }

  const entries = urls.map((url) => `<url><loc>${escapeXml(url)}</loc></url>`).join("")
  await writeFile(
    join(root, "sitemap-0.xml"),
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries}</urlset>\n`,
  )
  await writeFile(
    join(root, "sitemap-index.xml"),
    `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${escapeXml(new URL("/sitemap-0.xml", site).href)}</loc></sitemap></sitemapindex>\n`,
  )
  return urls
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}
