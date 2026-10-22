import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildChannels,
  channelCounterpart,
  channelLinks,
  channelUrl,
  docsRedirects,
  docsRouteParam,
  pageChannel,
  switchChannelPath,
  type DocsChannel,
} from "./docs-channel"

const stable: DocsChannel = { id: "stable", base: "/docs", release: "0.5.17" }
const next: DocsChannel = { id: "next", base: "/docs/next", release: "0.5.17" }

test.each([
  ["/docs", "/docs/next"],
  ["/docs/core-concepts/layout", "/docs/next/core-concepts/layout"],
  ["/docs/core-concepts/layout#cell-rounding", "/docs/next/core-concepts/layout#cell-rounding"],
  ["/docs?path=core", "/docs/next?path=core"],
  ["/docs#intro", "/docs/next#intro"],
  ["/docsearch", "/docsearch"],
  ["/packages/core", "/packages/core"],
  ["https://opentui.com/docs/x", "https://opentui.com/docs/x"],
  ["#local", "#local"],
])("channelUrl maps %s to %s on the main-branch channel", (url, expected) => {
  expect(channelUrl(url, next)).toBe(expected)
  expect(channelUrl(url, stable)).toBe(url)
})

test.each([
  ["/docs", undefined],
  ["/docs/next", "next"],
  ["/docs/next/releases/0.5.17", "next/releases/0.5.17"],
])("docsRouteParam(%s) is %s", (path, param) => {
  expect(docsRouteParam(path)).toBe(param)
})

test("switchChannelPath maps a page and its home between channels", () => {
  expect(switchChannelPath("/docs/next/reference/ssh", next, stable)).toBe("/docs/reference/ssh")
  expect(switchChannelPath("/docs/reference/ssh", stable, next)).toBe("/docs/next/reference/ssh")
  expect(switchChannelPath("/docs/next", next, stable)).toBe("/docs")
  expect(switchChannelPath("/packages", stable, next)).toBe("/docs/next")
})

test("a build renders the channel the environment names, or both", () => {
  const env = { OPENTUI_DOCS_RELEASE: "1.2.3" }
  expect(buildChannels({ ...env, OPENTUI_DOCS_CHANNEL: "next" })).toEqual([
    { id: "next", base: "/docs/next", release: "1.2.3" },
  ])
  expect(buildChannels(env).map((channel) => channel.id)).toEqual(["stable", "next"])
  expect(() => buildChannels({ OPENTUI_DOCS_CHANNEL: "beta" })).toThrow("stable")
  expect(() => buildChannels({ OPENTUI_DOCS_RELEASE: "v1.2.3" })).toThrow("version")
})

test.each([
  ["/docs", "stable"],
  ["/docs/core-concepts/layout/", "stable"],
  ["/docs/nextjs", "stable"],
  ["/docs/next", "next"],
  ["/docs/next/", "next"],
  ["/docs/next/releases/0.5.17/", "next"],
])("the page at %s is in the %s channel", (path, id) => {
  expect(pageChannel(path, { OPENTUI_DOCS_RELEASE: "1.2.3" }).id).toBe(id as "stable" | "next")
})

test("channelLinks maps the documentation links of rendered HTML", () => {
  const html = '<p><a href="/docs/x#y">x</a> <a class="c" href="/docs">home</a> <a href="https://e.com/docs">e</a></p>'
  expect(channelLinks(html, next)).toBe(
    '<p><a href="/docs/next/x#y">x</a> <a class="c" href="/docs/next">home</a> <a href="https://e.com/docs">e</a></p>',
  )
  expect(channelLinks(html, stable)).toBe(html)
})

test("pages that one channel lacks link to the nearest page the other channel has", () => {
  const pages = join(mkdtempSync(join(tmpdir(), "docs-channel-")), "pages.json")
  writeFileSync(
    pages,
    JSON.stringify({
      stable: ["/docs", "/docs/reference/ssh", "/docs/releases", "/docs/releases/0.5.17"],
      next: ["/docs", "/docs/reference/ssh", "/docs/native/c", "/docs/releases", "/docs/releases/0.5.18"],
    }),
  )
  const env = { OPENTUI_DOCS_PAGES: pages }

  expect(channelCounterpart("/docs/next/reference/ssh", next, "stable", env)).toEqual({
    href: "/docs/reference/ssh",
    present: true,
  })
  expect(channelCounterpart("/docs/next/native/c", next, "stable", env)).toEqual({ href: "/docs", present: false })
  expect(channelCounterpart("/docs/next/releases/0.5.18", next, "stable", env)).toEqual({
    href: "/docs/releases",
    present: false,
  })
  expect(channelCounterpart("/docs/releases/0.5.17", stable, "next", env)).toEqual({
    href: "/docs/next/releases",
    present: false,
  })
  // A page outside the lists, such as during development, counts as present everywhere.
  expect(channelCounterpart("/docs/next/native/c", next, "stable", {}).present).toBe(true)
})

test("redirects are generated only where the target exists and the source is not a page", () => {
  expect(docsRedirects(next, new Set(["/docs", "/docs/core-concepts/renderables", "/docs/native/c"]))).toEqual({
    "/docs/next/getting-started": "/docs/next",
    "/docs/next/core-concepts/constructs": "/docs/next/core-concepts/renderables",
    "/docs/next/core-concepts/renderables-vs-constructs": "/docs/next/core-concepts/renderables",
    "/docs/next/native/c-zig": "/docs/next/native/c",
  })
  expect(Object.keys(docsRedirects(stable, new Set(["/docs", "/docs/native/c-zig", "/docs/native/c"])))).toEqual([
    "/docs/getting-started",
  ])
  // By default, the pages are the ones docs-manifest.ts lists.
  expect(docsRedirects(stable)["/docs/getting-started"]).toBe("/docs")
})
