// A clock, the terminal size and the last key, from tick, resize and key events.
const clock = (ms) => new Date(ms).toISOString().slice(11, 19)
const next = { ...(state ?? { keys: 0, last: "", size: "", time: clock(app.now()) }) }

if (event.type === "tick") next.time = clock(event.now)
if (event.type === "resize") next.size = `${event.width}x${event.height}`
if (event.type === "key") {
  next.keys += 1
  next.last = event.key
}
return {
  state: next,
  slots: { status: `${next.time} · ${next.size} · ${next.keys} keys${next.last ? " (" + next.last + ")" : ""}` },
}
