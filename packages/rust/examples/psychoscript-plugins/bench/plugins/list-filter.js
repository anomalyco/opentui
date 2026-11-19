// Filters 1,000 file paths by the substring typed so far; returns the first 20 matches and the count.
// The items come from the `items` binding when the host passes one, else from state, else from app.items().
// Items that came in through state go back out in state.
const s = state ?? { query: "" }
let query = s.query
if (event.type === "key") {
  if (event.key === "escape") query = ""
  else if (event.key === "backspace") query = query.slice(0, -1)
  else query += event.key
}
const list = items ?? s.items ?? app.items(1000)
let count = 0
const lines = []
for (const item of list) {
  if (!item.includes(query)) continue
  count++
  if (lines.length < 20) lines.push(item)
}
return {
  state: s.items ? { query, items: s.items } : { query },
  slots: { panel: { title: "Files: " + query, lines }, status: count + "/" + list.length + " files" },
}
