;(() => {
  const themes = [
    { id: "light", color: "#ffffff", label: "Use light mode" },
    { id: "blue", color: "#ffffff", label: "Use blue tint" },
    { id: "cobalt", color: "#fffdf8", label: "Use cobalt colors" },
    { id: "dark", color: "#000000", label: "Use dark mode" },
  ]
  const root = document.documentElement
  const systemTheme = matchMedia("(prefers-color-scheme: dark)")

  function resolveTheme(id) {
    return themes.find((theme) => theme.id === (id === "martens" ? "cobalt" : id))
  }

  function apply(theme, remember = false) {
    root.dataset.theme = theme.id
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      meta.content = theme.color
    }
    if (remember) {
      try {
        localStorage.setItem("theme", theme.id)
      } catch {}
    }
  }

  const url = new URL(location.href)
  const requested = resolveTheme(url.searchParams.get("theme"))
  if (requested) {
    apply(requested, true)
    url.searchParams.delete("theme")
    try {
      history.replaceState(null, "", url)
    } catch {}
  } else {
    try {
      const id = localStorage.getItem("theme")
      const saved = resolveTheme(id)
      if (saved) apply(saved, saved.id !== id)
    } catch {}
  }

  document.addEventListener(
    "DOMContentLoaded",
    () => {
      const toggle = document.querySelector("[data-theme-toggle]")
      if (!toggle) return

      function next() {
        const current = root.dataset.theme || (systemTheme.matches ? "dark" : "light")
        return themes[(themes.findIndex((theme) => theme.id === current) + 1) % themes.length]
      }

      function updateLabel() {
        toggle.ariaLabel = next().label
        toggle.title = toggle.ariaLabel
      }

      toggle.addEventListener("click", () => {
        const theme = next()
        apply(theme, true)
        updateLabel()
      })

      systemTheme.addEventListener("change", updateLabel)
      updateLabel()
    },
    { once: true },
  )
})()
