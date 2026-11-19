// A misbehaving plugin: `t` throws, `l` loops forever. Neither freezes the app: the loop hits the per-event timeout on
// the plugin's own thread, and a failed event leaves the state as it was.
if (event.type === "init") {
  return {
    state: { events: 0 },
    slots: { status: "ok · 0 events" },
    commands: [
      { name: "bad.throw", title: "Throw", key: "t" },
      { name: "bad.loop", title: "Loop forever", key: "l" },
    ],
  }
}
if (event.type === "command" && event.name === "bad.throw") throw new Error("boom")
if (event.type === "command" && event.name === "bad.loop") while (true) {}
const events = state.events + 1
return { state: { events }, slots: { status: `ok · ${events} events` } }
