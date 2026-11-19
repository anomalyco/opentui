# Plugin research

Survey of the OpenCode and OpenTUI/terminal plugin ecosystems, rewritten under the PsychoScript reducer model
(`{ event, state }` → `{ state, slots, commands }`, host functions only). This directory is the merge output.

- **[`TOP100.md`](./TOP100.md)** — the 100 plugins to support, merged from the two surveys and ranked by popularity
  (stars + npm downloads, 2026-11-19), then complexity. Deduplicated same-job plugins (notified inline), 15+ figures
  re-spot-checked against the live source, with per-row: archetype, events, state, returns, host functions, blocker.
- **[`HOST-API.md`](./HOST-API.md)** — **the main output.** The minimal union of every host function the 100 plugins
  need, grouped by namespace with signature, sync/async/durable, need-count, capability class, and the Rust host
  implementation. Includes the ★ top-20 functions, the event catalogue, the UI slots and return shapes, and the four
  blockers with the smallest host capability that removes each.
- **[`opencode-plugins.md`](./opencode-plugins.md)** — source survey: OpenCode community plugins and the API surface
  they call.
- **[`tui-ecosystem-plugins.md`](./tui-ecosystem-plugins.md)** — source survey: OpenTUI packages and the plugin systems
  of lazygit, k9s, yazi, helix, zellij, wezterm, Neovim and tmux.

Decision: no compatibility with today's plugin APIs; every event runs the plugin once; plugins reach the outside only
through host functions (sync/async/durable/namespaces). See the host-side prototype at
`anomalyco/opentui`, branch `psychoscript-plugins`.
