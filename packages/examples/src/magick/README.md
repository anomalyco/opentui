# Magick Arena

Magick Arena renders a Three.js scene through a two-slot `NativeImagePool` and `ImageRenderable`.
The demo requires Bun and WebGPU.

## Controls

| Key                         | Action                                              |
| --------------------------- | --------------------------------------------------- |
| WASD                        | Move the red wizard                                 |
| Space                       | Pause or resume the scene                           |
| R                           | Reset time and player position                      |
| T                           | Cycle Kitty transport: raw, zlib, file              |
| C                           | Show GPU, image transport, and renderer diagnostics |
| Backtick or `"`             | Toggle the captured console                         |
| `.`                         | Toggle renderer statistics                          |
| Ctrl+A                      | Log native arena allocation                         |
| Ctrl+G                      | Dump the hit grid                                   |
| Shift+L / Shift+S / Shift+A | Start / stop / use automatic rendering              |
| Escape                      | Return to the selector, or quit in standalone mode  |
| Ctrl+C                      | Quit                                                |
| Q                           | Quit in standalone mode only                        |

Pause stops continuous GPU readbacks, but pending or reset frames can still render.
Diagnostics remain available. Movement stops while the console is open or the terminal
loses focus. Legacy keyboard input uses approximate movement pulses instead of key-release events.

## Rendering

The framebuffer defaults to 640x360 and stays fixed when the terminal resizes. Press `T`
to cycle transport without restarting the scene, including while paused. The status line
shows the requested and effective Kitty transport, or marks it inactive for other image
protocols. File and zlib modes can fall back to raw output. `C` shows the full transport
status. Returning to the selector restores its previous transport setting.

The demo reads GPU pixels into CPU memory. File transport sends a temporary file path,
not a shared GPU image.

The private GPU adapter is experimental and uses pinned bun-webgpu internals. It releases
per-frame GPU objects. Repeated GPU renderer creation still has a separate provider issue,
so the selector reuses one renderer across visits. It releases that renderer when the
terminal renderer closes. Each return to the selector releases scene resources, images,
and input listeners.
