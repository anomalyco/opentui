# Terminal Startup Spec

This spec describes the startup flow for `createCliRenderer()` with `testing !== true`.

1. `createCliRenderer(config)` resolves stdin/stdout, render geometry, the native library, and creates the native renderer.

2. Native terminal initialization resolves the remote mode:
   - `config.remote === true` forces remote behavior.
   - `config.remote === false` forces local behavior.
   - An omitted `config.remote` auto-detects SSH/mosh sessions from `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY`, or `MOSH_CONNECTION` before environment-derived capability detection.

3. `CliRenderer` is constructed. During construction it:
   - Stores terminal streams and renderer configuration.
   - Forwards selected environment variables when `forwardEnvKeys` is provided or `config.remote === false`. An omitted `config.remote` leaves default environment detection native-owned.
   - Creates the stdin parser and registers input handlers.
   - Registers process lifecycle handlers.

4. `createCliRenderer()` calls `renderer.setupTerminal()`.

5. `setupTerminal()` marks terminal setup as active and enables stdin parser protocol contexts for startup capability responses.

6. `setupTerminal()` calls native `setupTerminal()`. Native startup writes terminal setup/query sequences, including theme color queries, `XTVERSION`, cursor position requests, capability queries, and width/scale probes.

7. `setupTerminal()` immediately reads initial native capabilities with `getTerminalCapabilities()`. At this point environment-derived capabilities are known, but async terminal responses may not have arrived yet.

8. `setupTerminal()` starts a 5000ms capability timeout. When it fires, startup capability parsing is disabled, the capability handler is removed, and any `XTVERSION` waiters are released.

9. Mouse and split-footer startup cursor seeding are initialized when configured.

10. Pixel resolution is queried.

11. Startup calls `refreshPalette()` only when native palette state is useful: terminal setup is active, the renderer is alive, `ansi256` is supported, and truecolor `rgb` is not supported. Truecolor terminals do not run startup palette detection.

12. `getPalette()` waits for `XTVERSION` only when native capabilities already indicate `multiplexer === "tmux"` but no tmux version is known from either `TERM_PROGRAM=tmux` with `TERM_PROGRAM_VERSION` or `XTVERSION`. This avoids choosing the wrong OSC 4 strategy for tmux while avoiding a 5000ms wait for remote or non-responding terminals.

13. `getPalette()` creates the palette detector after any required `XTVERSION` wait. The detector uses tmux version to choose OSC 4 behavior:
    - tmux `< 3.6`: wrap OSC palette queries in tmux DCS passthrough.
    - tmux `>= 3.6` or non-tmux: send plain OSC palette queries.

    In tmux, special color queries use only plain OSC 10/11/12. tmux has handlers for these and no OSC 13-17/19 handlers or reply routing, so DCS passthrough does not help those queries.

14. Palette detection uses a hard timeout plus an idle timeout. The idle timeout finishes detection after a short period of silence after palette queries, including when follow-up palette queries produce no responses.

15. When a palette result is detected, `PALETTE` is emitted if listeners exist and the detected palette signature changed since the last palette event.

16. When a palette result is detected and native palette state is useful, `syncNativePaletteState()` publishes the palette to native. It increments the palette epoch only when the normalized palette signature changes.

17. Async terminal responses are routed through the stdin parser. Capability responses call native `processCapabilityResponse()`, refresh TypeScript capabilities, emit `CAPABILITIES`, and release `XTVERSION` waiters when `terminal.from_xtversion` becomes true.

18. Theme-mode OSC responses update renderer theme mode. When the mode changes, palette cache is cleared. `refreshPalette()` is scheduled only if native palette state is useful or `PALETTE` listeners exist.

19. `setupTerminal()` resolves after the startup writes and synchronous initialization complete. Capability and palette detection may continue asynchronously.

## Current Gaps

- Remote callers must explicitly provide any local terminal environment they want native detection to use via `forwardEnvKeys` or equivalent forwarding. Auto-detected remote sessions do not use the remote process environment for terminal capability heuristics.

- Terminals are not required to answer `XTVERSION`. If no `TMUX` env was forwarded and `XTVERSION` never arrives, OpenTUI cannot infer tmux and will use non-tmux palette query behavior.

- Nested tmux is not modeled. OpenTUI currently treats tmux as a single layer and does not distinguish local tmux, remote tmux, or local-plus-remote nested tmux sessions.

- tmux can be detected from `TMUX`, `TERM` beginning with `tmux`, or `TERM_PROGRAM=tmux`. tmux version is only available from environment variables when `TERM_PROGRAM=tmux` and `TERM_PROGRAM_VERSION` are present. Otherwise, version-sensitive behavior depends on `XTVERSION`; without either, OpenTUI cannot reliably choose legacy tmux passthrough versus tmux 3.6 native OSC 4 handling.

- The palette query strategy assumes one effective terminal path. It does not support independently reasoning about a remote server terminal, a transport, and a local outer terminal.
