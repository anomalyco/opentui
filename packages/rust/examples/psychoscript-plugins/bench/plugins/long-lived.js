// The long-lived model: one run per plugin, parked on app.nextEvent() between events.
let ticks = 0
app.setSlot("ready", "1")
while (true) {
  const e = await app.nextEvent()
  if (e.type === "stop") return { ticks }
  ticks++
  app.setSlot("status", "tick " + ticks + " " + (e.key ?? ""))
}
