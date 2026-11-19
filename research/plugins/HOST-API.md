# Host API — split into TUI and Server

Moved. The host-function catalogue, events, slots and blockers are now split by runtime:

- **[`tui/HOST-API.md`](./tui/HOST-API.md)** — the **TUI host API** (the focus). 38 client functions (27 TUI + 11 Both),
  the TUI event surface (key, command, prompt-input, message-rendered, session-switched, selection, resize, tick,
  focus, file-changed, …), the slots and return shapes, and the TUI blockers.
- **[`server/HOST-API.md`](./server/HOST-API.md)** — the **server host API**. 19 server functions (8 Server + 11 Both),
  the server events, the no-UI return shapes (tools, slash, inject, permit, result), and the server blockers.

Functions classified **27 TUI · 8 Server · 11 Both**. The TUI file is the detailed one; the server file is the
model/agent-side half.
