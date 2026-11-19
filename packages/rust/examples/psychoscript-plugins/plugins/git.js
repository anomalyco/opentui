// Git status in the status bar: on load, on `g`, and every ten ticks. `app.git.status()` is asynchronous.
const refresh = async () => {
  const s = await app.git.status()
  return s.branch + (s.dirty ? " *" : "") + (s.ahead ? " ↑" + s.ahead : "")
}

if (event.type === "init") {
  return {
    state: { ticks: 0 },
    slots: { status: await refresh() },
    commands: [{ name: "git.refresh", title: "Refresh git status", key: "g" }],
  }
}
if (event.type === "command" && event.name === "git.refresh") {
  return { slots: { status: await refresh() } }
}
if (event.type === "tick") {
  const ticks = state.ticks + 1
  return ticks % 10 === 0 ? { state: { ticks }, slots: { status: await refresh() } } : { state: { ticks } }
}
return {}
