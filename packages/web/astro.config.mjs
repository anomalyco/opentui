import { defineConfig } from "astro/config"
import mdx from "@astrojs/mdx"
import sitemap from "@astrojs/sitemap"

const copyButtonTransformer = {
  name: "copy-button",
  pre(node) {
    node.properties["data-code"] = this.source
    if (this.options?.lang) node.properties["data-language"] = this.options.lang

    if (this.options?.lang === "text") {
      const metadata = this.options.meta?.__raw ?? ""
      const visual = metadata.match(/(?:^|\s)terminal=([a-z0-9-]+)(?=\s|$)/)
      if (visual) {
        node.properties["data-terminal-visual"] = visual[1]
        if (/(?:^|\s)surface(?=\s|$)/.test(metadata)) node.properties["data-terminal-surface"] = true
      }
    }
  },
}

// Monochrome highlighting: identifiers plain, keywords bold, literals gray,
// comments fainter gray italic. Structure through weight and shade, not hue.
function grayscaleTheme({ name, type, foreground, background, literal, comment }) {
  return {
    name,
    type,
    colors: {
      "editor.background": background,
      "editor.foreground": foreground,
    },
    settings: [
      { settings: { foreground, background } },
      {
        scope: ["comment", "punctuation.definition.comment"],
        settings: { foreground: comment, fontStyle: "italic" },
      },
      {
        scope: ["string", "constant.numeric", "constant.language", "constant.character.escape"],
        settings: { foreground: literal },
      },
      {
        scope: ["keyword.control", "keyword.other", "keyword.declaration", "storage.type", "storage.modifier"],
        settings: { fontStyle: "bold" },
      },
    ],
  }
}

const codeLight = grayscaleTheme({
  name: "opentui-light",
  type: "light",
  foreground: "#000000",
  background: "#ffffff",
  literal: "#4a4a4a",
  comment: "#767676",
})

const codeDark = grayscaleTheme({
  name: "opentui-dark",
  type: "dark",
  foreground: "#ededed",
  background: "#000000",
  literal: "#b0b0b0",
  comment: "#8a8a8a",
})

// Blue tint: the grayscale ramp shifted onto the ink hue.
const codeBlue = grayscaleTheme({
  name: "opentui-blue",
  type: "light",
  foreground: "#1131e9",
  background: "#ffffff",
  literal: "#475ac2",
  comment: "#7783c5",
})

const codeCobalt = {
  name: "opentui-cobalt",
  type: "light",
  colors: {
    "editor.foreground": "#200f1a",
    "editor.background": "#fffdf8",
  },
  settings: [
    { settings: { foreground: "#200f1a", background: "#fffdf8" } },
    {
      scope: ["comment", "punctuation.definition.comment"],
      settings: { foreground: "#71676c", fontStyle: "italic" },
    },
    {
      scope: ["keyword", "storage"],
      settings: { foreground: "#c32f18", fontStyle: "bold" },
    },
    {
      scope: ["keyword.operator"],
      settings: { foreground: "#200f1a", fontStyle: "" },
    },
    {
      scope: ["string", "constant", "support.constant", "markup.inline.raw"],
      settings: { foreground: "#2046e8" },
    },
    {
      scope: [
        "entity.name.function",
        "entity.name.type",
        "entity.name.class",
        "entity.name.tag",
        "support.function",
        "support.type",
        "support.class",
        "variable.function",
      ],
      settings: { foreground: "#202b81" },
    },
    {
      scope: ["constant.numeric", "constant.language"],
      settings: { foreground: "#946400" },
    },
  ],
}

export default defineConfig({
  integrations: [
    mdx(),
    sitemap({
      filter: (page) => {
        const path = new URL(page).pathname
        return path !== "/404/" && !path.startsWith("/lab/")
      },
    }),
  ],
  site: "https://opentui.com",
  vite: {
    server: {
      allowedHosts: true,
    },
  },
  redirects: {
    "/docs/getting-started": "/docs",
    "/docs/core-concepts/constructs": "/docs/core-concepts/renderables",
    "/docs/core-concepts/renderables-vs-constructs": "/docs/core-concepts/renderables",
    "/docs/native/c-zig": "/docs/native/c",
  },
  markdown: {
    shikiConfig: {
      themes: {
        light: codeLight,
        dark: codeDark,
        blue: codeBlue,
        cobalt: codeCobalt,
      },
      transformers: [copyButtonTransformer],
    },
  },
})
