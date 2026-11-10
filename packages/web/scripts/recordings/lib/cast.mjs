// Parse asciicast v2/v3 files into { cols, rows, theme, events, durationMs }.
// Events are normalized to absolute milliseconds: { at, type, data }.

export function parseCast(text) {
  const lines = text.split("\n").filter((line) => line.trim().length)
  const header = JSON.parse(lines[0])
  let cols
  let rows
  let theme = null

  if (header.version === 2) {
    cols = header.width
    rows = header.height
    if (header.theme) theme = normalizeTheme(header.theme)
  } else if (header.version === 3) {
    cols = header.term?.cols
    rows = header.term?.rows
    if (header.term?.theme) theme = normalizeTheme(header.term.theme)
  } else {
    throw new Error(`unsupported asciicast version: ${header.version}`)
  }
  if (!cols || !rows) throw new Error("cast header is missing terminal dimensions")

  const events = []
  let clock = 0
  for (const line of lines.slice(1)) {
    const [time, type, data] = JSON.parse(line)
    // v3 times are intervals since the previous event; v2 times are absolute.
    clock = header.version === 3 ? clock + time * 1000 : time * 1000
    events.push({ at: Math.round(clock), type, data })
  }

  return { cols, rows, theme, events, durationMs: Math.round(clock) }
}

// Cast themes use { fg, bg, palette: "#a:#b:..." }; theme files use
// { foreground, background, palette: [...] }. Normalize to the latter.
function normalizeTheme(raw) {
  const palette = Array.isArray(raw.palette) ? raw.palette : (raw.palette || "").split(":")
  if (palette.length !== 8 && palette.length !== 16) return null
  const full = palette.length === 16 ? palette : [...palette, ...palette]
  return {
    name: raw.name ?? "recorded terminal",
    foreground: raw.foreground ?? raw.fg,
    background: raw.background ?? raw.bg,
    palette: full,
  }
}

export function markers(cast) {
  let count = 0
  return cast.events
    .filter((event) => event.type === "m")
    .map((event) => ({ at: event.at, label: event.data || `marker-${(count += 1)}` }))
}
