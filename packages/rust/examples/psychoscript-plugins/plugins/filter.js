// A list filter over the repository's files (up to 1,000), in a panel. `f` cycles the query.
const queries = ["", "src", "test", ".zig", "rust", ".md"]

const view = (query) => {
  const files = app.files(1000)
  const matches = query ? files.filter((f) => f.includes(query)) : files
  return {
    panel: {
      title: `files: ${query || "all"} (${matches.length} of ${files.length})`,
      lines: matches.slice(0, 12),
    },
  }
}

if (event.type === "init") {
  const query = state?.query ?? ""
  return {
    state: { query },
    slots: view(query),
    commands: [{ name: "filter.cycle", title: "Next file filter", key: "f" }],
  }
}
if (event.type === "command" && event.name === "filter.cycle") {
  const query = queries[(queries.indexOf(state.query) + 1) % queries.length]
  return { state: { query }, slots: view(query) }
}
return {}
