// Git status in the status bar: ticks bump a counter, the git.refresh command asks the host for the status.
const s = state ?? { ticks: 0, text: "git: ?" }
if (event.type === "init") {
  return {
    state: s,
    slots: { status: s.text },
    commands: [{ name: "git.refresh", title: "Git: Refresh Status", key: "ctrl+g" }],
  }
}
if (event.type === "tick") {
  const next = { ticks: s.ticks + 1, text: s.text }
  return { state: next, slots: { status: next.text + " · " + next.ticks } }
}
if (event.type === "command" && event.name === "git.refresh") {
  const g = await app.git.status()
  const text = g.branch + (g.dirty ? " *" : "") + (g.ahead > 0 ? " ↑" + g.ahead : "")
  return { state: { ticks: s.ticks, text }, slots: { status: text } }
}
return { state: s }
