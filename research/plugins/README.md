# Plugin research

Survey of the OpenCode and OpenTUI/terminal plugin ecosystems, rewritten under the PsychoScript reducer model
(`{ event, state }` → `{ state, slots, commands }`, host functions only). Split by runtime: the OpenCode TUI is moving
to Rust (OpenTUI + PsychoScript), the server stays in TypeScript for now.

- **[`tui/TOP100.md`](./tui/TOP100.md)** — **TUI focus.** 73 TUI plugins (62 TUI + 11 Both, TUI portion), re-ranked by
  popularity, with side classification and full detail: archetype, events, state, returns, host functions, blocker.
- **[`tui/HOST-API.md`](./tui/HOST-API.md)** — the TUI host API: the 38 client functions, the TUI event surface, slots
  and return shapes, and the TUI blockers. Includes the ★ top-15 TUI host functions.
- **[`server/TOP100.md`](./server/TOP100.md)** — 38 server plugins (27 Server + 11 Both, server portion).
- **[`server/HOST-API.md`](./server/HOST-API.md)** — the 19 server functions, server events, and the no-UI return shapes
  (tools, slash commands, context injection, permissions, tool results).
- **[`TOP100.md`](./TOP100.md)** / **[`HOST-API.md`](./HOST-API.md)** — stubs pointing at the split above.

Sources: **[`opencode-plugins.md`](./opencode-plugins.md)** (OpenCode community plugins and the API they call) and
**[`tui-ecosystem-plugins.md`](./tui-ecosystem-plugins.md)** (OpenTUI packages and the plugin systems of lazygit, k9s,
yazi, helix, zellij, wezterm, Neovim and tmux). Host-side prototype: `anomalyco/opentui`, branch `psychoscript-plugins`.
