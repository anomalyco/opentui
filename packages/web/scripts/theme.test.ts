import { readFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import { expect, test } from "bun:test"
import config from "../astro.config.mjs"

const source = await readFile(new URL("../src/scripts/theme.js", import.meta.url), "utf8")

function page({
  saved = null as string | null,
  dark = false,
  blocked = false,
  control = true,
  ready = true,
  url = "https://opentui.test/docs",
} = {}) {
  const root = { dataset: {} as Record<string, string> }
  const metas = [{ content: "#ffffff" }, { content: "#000000" }]
  const toggle = Object.assign(new EventTarget(), { ariaLabel: "Use blue tint", title: "Use blue tint" })
  const system = Object.assign(new EventTarget(), { matches: dark })
  const storage = new Map(saved ? [["theme", saved]] : [])
  const location = { href: url }
  const document = Object.assign(new EventTarget(), {
    documentElement: root,
    querySelector: () => (control ? toggle : null),
    querySelectorAll: () => metas,
  })

  runInNewContext(source, {
    document,
    location,
    URL,
    history: {
      replaceState: (_state: unknown, _title: string, url: URL) => {
        location.href = String(url)
      },
    },
    matchMedia: () => system,
    localStorage: {
      getItem(key: string) {
        if (blocked) throw new Error("Storage blocked")
        return storage.get(key) ?? null
      },
      setItem(key: string, value: string) {
        if (blocked) throw new Error("Storage blocked")
        storage.set(key, value)
      },
    },
  })
  if (ready) document.dispatchEvent(new Event("DOMContentLoaded"))

  return {
    root,
    metas,
    toggle,
    storage,
    location,
    click: () => toggle.dispatchEvent(new Event("click")),
    systemChange(matches: boolean) {
      system.matches = matches
      system.dispatchEvent(new Event("change"))
    },
  }
}

test.each([
  ["light", "#ffffff"],
  ["blue", "#ffffff"],
  ["cobalt", "#fffdf8"],
  ["dark", "#000000"],
])("restores %s and its browser chrome before the body loads", (saved, color) => {
  const { root, metas } = page({ saved, dark: true, ready: false })
  expect(root.dataset.theme).toBe(saved)
  expect(metas.map((meta) => meta.content)).toEqual([color, color])
})

test("cycles through all themes, persists the choice, and names the next action", () => {
  const view = page()
  const cycle = [
    ["blue", "#ffffff", "Use cobalt colors"],
    ["cobalt", "#fffdf8", "Use dark mode"],
    ["dark", "#000000", "Use light mode"],
    ["light", "#ffffff", "Use blue tint"],
  ]
  expect(view.toggle.ariaLabel).toBe("Use blue tint")
  for (const [theme, color, label] of cycle) {
    view.click()
    expect(view.root.dataset.theme).toBe(theme)
    expect(view.storage.get("theme")).toBe(theme)
    expect(view.metas.map((meta) => meta.content)).toEqual([color!, color!])
    expect(view.toggle.ariaLabel).toBe(label)
    expect(view.toggle.title).toBe(label)
  }
})

test.each([null, "sepia", "__proto__"])("uses system appearance when the stored theme is %s", (saved) => {
  const view = page({ saved, dark: true })
  expect(view.root.dataset.theme).toBeUndefined()
  expect(view.toggle.ariaLabel).toBe("Use light mode")
  view.systemChange(false)
  expect(view.toggle.ariaLabel).toBe("Use blue tint")
  view.click()
  expect(view.root.dataset.theme).toBe("blue")
})

test("old Martens selections migrate to cobalt before the body loads", () => {
  const view = page({ saved: "martens", ready: false })
  expect(view.root.dataset.theme).toBe("cobalt")
  expect(view.storage.get("theme")).toBe("cobalt")
  expect(view.metas.map((meta) => meta.content)).toEqual(["#fffdf8", "#fffdf8"])
})

test("system changes do not replace a migrated theme", () => {
  const view = page({ saved: "martens" })
  view.systemChange(true)
  expect(view.root.dataset.theme).toBe("cobalt")
  expect(view.toggle.ariaLabel).toBe("Use dark mode")
})

test("theme switching still works when storage is unavailable", () => {
  const view = page({ blocked: true })
  view.click()
  view.click()
  expect(view.root.dataset.theme).toBe("cobalt")
  expect(view.toggle.ariaLabel).toBe("Use dark mode")
  expect(view.metas.map((meta) => meta.content)).toEqual(["#fffdf8", "#fffdf8"])
})

test("pages without a theme control still restore the saved theme", () => {
  const view = page({ saved: "martens", control: false })
  expect(view.root.dataset.theme).toBe("cobalt")
})

test("a theme preview link selects and remembers cobalt before the body loads", () => {
  const view = page({ saved: "dark", ready: false, url: "https://opentui.test/docs?path=core&theme=cobalt#code" })
  expect(view.root.dataset.theme).toBe("cobalt")
  expect(view.storage.get("theme")).toBe("cobalt")
  expect(view.metas.map((meta) => meta.content)).toEqual(["#fffdf8", "#fffdf8"])
  expect(view.location.href).toBe("https://opentui.test/docs?path=core#code")
})

test.each([false, true])("old Martens links select cobalt when storage is blocked: %s", (blocked) => {
  const view = page({ saved: "light", blocked, url: "https://opentui.test/docs?theme=martens#code" })
  expect(view.root.dataset.theme).toBe("cobalt")
  expect(view.toggle.ariaLabel).toBe("Use dark mode")
  expect(view.location.href).toBe("https://opentui.test/docs#code")
  if (!blocked) expect(view.storage.get("theme")).toBe("cobalt")
})

test("consumed preview links do not override a later theme choice on reload", () => {
  const view = page({ url: "https://opentui.test/?theme=cobalt" })
  view.click()
  expect(view.root.dataset.theme).toBe("dark")
  const reloaded = page({ saved: view.storage.get("theme"), url: view.location.href })
  expect(reloaded.root.dataset.theme).toBe("dark")
})

test("preview links work without storage, and unknown theme names are ignored", () => {
  expect(page({ blocked: true, url: "https://opentui.test/?theme=cobalt" }).root.dataset.theme).toBe("cobalt")
  const view = page({ saved: "dark", url: "https://opentui.test/?theme=__proto__" })
  expect(view.root.dataset.theme).toBe("dark")
  expect(view.storage.get("theme")).toBe("dark")
})

test("cobalt distinguishes syntax roles with readable colors", async () => {
  const require = createRequire(import.meta.resolve("astro/config"))
  const { createHighlighter } = await import(require.resolve("shiki"))
  expect(Object.keys(config.markdown!.shikiConfig!.themes!).sort()).toEqual(["blue", "cobalt", "dark", "light"])
  const highlighter = await createHighlighter({
    themes: [config.markdown!.shikiConfig!.themes!.cobalt],
    langs: ["tsx"],
  })

  try {
    const { tokens, bg, fg } = highlighter.codeToTokens(
      `// A counter
const count: number = 42
const ready = true
function greet() { return "hello" }
const renderer = createCliRenderer()
const label = new TextRenderable(renderer, {})
const view = <text>{count}</text>`,
      { lang: "tsx", theme: "opentui-cobalt" },
    )
    const segments = tokens.flat() as Array<{ content: string; color: string; fontStyle: number }>
    const token = (text: string) => segments.find((segment) => segment.content.includes(text))
    expect(fg).toBe("#200f1a")
    expect(token("const")).toMatchObject({ color: "#C32F18", fontStyle: 2 })
    expect(token('"hello"')).toMatchObject({ color: "#2046E8" })
    expect(token("greet")).toMatchObject({ color: "#202B81" })
    expect(token("createCliRenderer")).toMatchObject({ color: "#202B81" })
    expect(token("TextRenderable")).toMatchObject({ color: "#202B81" })
    expect(token("number")).toMatchObject({ color: "#202B81" })
    expect(token("text")).toMatchObject({ color: "#202B81" })
    expect(token("42")).toMatchObject({ color: "#946400" })
    expect(token("true")).toMatchObject({ color: "#946400" })
    expect(token("// A counter")).toMatchObject({ color: "#71676C", fontStyle: 1 })
    expect(bg).toBe("#fffdf8")

    function luminance(hex: string) {
      const channels = hex
        .slice(1)
        .match(/../g)!
        .map((channel) => {
          const value = parseInt(channel, 16) / 255
          return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
        })
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
    }

    for (const segment of segments) {
      expect((luminance(bg) + 0.05) / (luminance(segment.color) + 0.05)).toBeGreaterThanOrEqual(4.5)
    }
  } finally {
    highlighter.dispose()
  }
})

test("wordmark ink plates preserve the letters and overlap only at the p and t joins", async () => {
  const svg = await readFile(new URL("../src/components/OpenTUILogo.astro", import.meta.url), "utf8")
  const plates = [...svg.matchAll(/data-ink="(cyan|magenta|yellow)"\s+d="([^"]+)"/g)]
  expect(plates.map((plate) => plate[1])).toEqual(["cyan", "magenta", "yellow"])

  const layers = plates.map(([, , path]) => {
    const cells = new Set<string>()
    const rectangles = [...path!.matchAll(/M(\d+) (\d+)h(\d+)v(\d+)h-(\d+)z/g)]
    expect(rectangles.map((rectangle) => rectangle[0]).join("")).toBe(path!)
    for (const rectangle of rectangles) {
      const [, x, y, width, height, returnWidth] = rectangle.map(Number)
      expect(width).toBe(returnWidth!)
      expect(Math.min(width!, height!)).toBe(1)
      expect(Math.max(width!, height!)).toBeGreaterThan(1)
      for (let dy = 0; dy < height!; dy++) {
        for (let dx = 0; dx < width!; dx++) cells.add(`${x! + dx},${y! + dy}`)
      }
    }
    return cells
  })

  const [cyan, magenta, yellow] = layers
  expect([...cyan!].filter((cell) => magenta!.has(cell))).toEqual(["5,4"])
  expect([...magenta!].filter((cell) => yellow!.has(cell))).toEqual(["17,1"])
  expect([...cyan!].filter((cell) => yellow!.has(cell))).toEqual([])
  const cells = new Set(layers.flatMap((layer) => [...layer]))
  expect(cells.size).toBe(61)
  expect(
    Array.from({ length: 6 }, (_, y) =>
      Array.from({ length: 25 }, (_, x) => (cells.has(`${x + 1},${y}`) ? "#" : ".")).join(""),
    ),
  ).toEqual([
    "................#........",
    "###.###.###.##..###.#.#.#",
    "#.#.#.#.#.#.#.#.#...#.#.#",
    "#.#.#.#.#...#.#.#.#.#.#.#",
    "###.###.###.#.#.###.###.#",
    "....#....................",
  ])
})
