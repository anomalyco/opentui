---
date: 2026-11-07
summary: OpenTUI asks the terminal for 24-bit color support, so colors over SSH no longer fall back to the 256-color palette.
---

Over ssh, sshd drops `COLORTERM`. A terminal that draws 24-bit color but sends `TERM=xterm-256color` without `COLORTERM` therefore got every color mapped to the 256-color palette. In WezTerm and xterm over ssh, a navy `#23344b` turned into a gray `#3a3a3a`. In 0.8.2, only a kitty XTVERSION reply turned on 24-bit color. In 0.8.3, when `COLORTERM` does not settle the question, the startup queries also ask XTGETTCAP `RGB` and `Tc`. A positive reply turns on 24-bit color. So does an XTVERSION reply from Ghostty, WezTerm, foot, XTerm, iTerm2, or tmux, because tmux converts 24-bit colors for its client itself. The replies come back through ssh, so this works without `COLORTERM`. Inside GNU Screen, OpenTUI sends neither query, because Screen drops 24-bit colors and prints the query bodies as text. When nothing answers, the old `TERM` rule still applies. Alacritty and mosh answer none of these queries, so they still need `COLORTERM=truecolor`.

The width method decides how many cells an emoji sequence takes. When OpenTUI picks a different method than the terminal uses, the line overflows or leaves gaps. Before, OpenTUI kept the unicode method in terminals that do not report mode 2027, even though many of them draw a sequence one code point at a time. tmux 3.6 and later draws a sequence as one cluster but got wcwidth. An inherited `TERM_PROGRAM=ghostty` also forced unicode-wide in other terminals. Now the method comes from one place, with the strongest evidence first:

1. `OPENTUI_FORCE_*`, also over SSH.
2. The multiplexer.
3. The DECRPM 2027 reply. An unrecognized or permanently reset mode means wcwidth, except in kitty and iTerm2.
4. XTVERSION.
5. The environment, where `TERM` wins over an inherited `TERM_PROGRAM`.

| Terminal                                                                  | Before       | After        |
| ------------------------------------------------------------------------- | ------------ | ------------ |
| Alacritty, xterm, urxvt, GNOME Terminal, VS Code, Zellij, foot (wcswidth) | unicode      | wcwidth      |
| tmux 3.6+                                                                 | wcwidth      | unicode      |
| kitty started from Ghostty                                                | unicode-wide | unicode      |
| Ghostty over SSH, libghostty                                              | unicode      | unicode-wide |

No method matches tmux when `variation-selector-always-wide` is off. Unicode is the closest. If the new choice is wrong for your terminal, set `OPENTUI_FORCE_UNICODE` or `OPENTUI_FORCE_WCWIDTH`. These settings still win.

Before this release, a host that started an unmodified OpenTUI app could not easily make it load a different native build. `setRenderLibPath()` needs code, and `OTUI_ASSET_ROOT` needs the whole asset tree under one root. `OPENTUI_LIB_PATH` names one library file, under both Bun and Node:

```sh
OPENTUI_LIB_PATH=../opentui/packages/native/lib/x86_64-linux/libopentui.so bun run src/index.ts
```

A relative path resolves against the working directory. `setRenderLibPath()` takes precedence over the variable, and the variable takes precedence over `OTUI_ASSET_ROOT` and the platform package. If the file is missing or does not load, the error names the variable. Core now also checks the context ABI version when it loads a library, so a library built for another context ABI fails at load and not at a later call.

A host that embeds a terminal often has to know where the terminal's view is. For example, it can pass an unused wheel step to an outer scroll view or draw a scrollbar. Counting scroll steps does not give the answer. Output and resizes keep the view on its history rows, a scrollback clear jumps to the live screen, and the alternate screen has no history. `EmbeddedTerminalRenderable.getScroll()` reads the current view from the emulator, including the moves that the emulator makes on its own:

```ts
function scrollStatus(terminal: EmbeddedTerminalRenderable): string {
  const { offset, total, visible } = terminal.getScroll()
  if (offset === 0) return "live"
  return `${offset} of ${total - visible} rows back`
}
```

C and Rust hosts get two changes. First, the `@opentui/core-<platform>` packages now ship the `opentui.h` that their library was built from. Before, a binding that took the library from npm had no matching header. Second, `opentui.h` now declares the audio engine. Before, a host could bind it only by copying Zig signatures. With `OT_AUDIO_START_NO_DEVICE`, the engine mixes only when the host calls `ot_audio_mix`, so tests can play sounds without a device. Voice IDs now carry a generation. An old ID no longer stops a new sound that reused its slot.

## Added

- **core:** `EmbeddedTerminalRenderable.getScroll()` returns the view's `offset` from the live screen, the `total` rows, and the `visible` rows. See [Embedded terminal](/docs/components/embedded-terminal). ([#1934](https://github.com/anomalyco/opentui/pull/1934))
- **core:** `OPENTUI_LIB_PATH` names a native library file. Under Bun and Node, Core loads it instead of the `OTUI_ASSET_ROOT` copy or the platform package. `setRenderLibPath()` takes precedence over the variable. See [Environment variables](/docs/reference/env-vars). ([#1933](https://github.com/anomalyco/opentui/pull/1933))
- **native:** `ot_embedded_terminal_scrollbar_get` fills an `ot_embedded_terminal_scrollbar` record with the offset from the live screen, the total rows, and the visible rows. See [Embedded terminal](/docs/components/embedded-terminal). ([#1934](https://github.com/anomalyco/opentui/pull/1934))
- **native:** `opentui.h` declares nine `ot_audio_*` functions that address an audio engine by `ot_handle` and return `ot_status`. With the `OT_AUDIO_START_NO_DEVICE` flag, `ot_audio_start` opens no device, and the engine mixes only in `ot_audio_mix`. See [C](/docs/native/c). ([#1935](https://github.com/anomalyco/opentui/pull/1935))
- **native:** The `@opentui/core-<platform>` packages include the `opentui.h` that the library was built from. On Windows, they also include `opentui.lib`. See [C](/docs/native/c). ([#1932](https://github.com/anomalyco/opentui/pull/1932))
- **native:** The `OT_INPUT_KEY_TYPED` key flag marks a key whose code is a printable character that the terminal sent as text or as a CSI 27 code. See [Keyboard input](/docs/core-concepts/keyboard). ([#1919](https://github.com/anomalyco/opentui/pull/1919))

## Changed

- **core:** When `COLORTERM` does not enable 24-bit color, the renderer asks the terminal with XTGETTCAP `RGB` and `Tc`. A positive reply, or an XTVERSION reply from Ghostty, WezTerm, foot, XTerm, iTerm2, or tmux, enables `rgb`, also over SSH. See [Terminal capabilities](/docs/reference/terminal-capabilities). ([#1941](https://github.com/anomalyco/opentui/pull/1941))
- **core:** OpenTUI chooses the width method from `OPENTUI_FORCE_*`, the multiplexer, the DECRPM 2027 reply, XTVERSION, and then the environment. Alacritty, xterm, GNOME Terminal, VS Code, and Zellij now get wcwidth, and tmux 3.6 and later gets unicode. See [Terminal capabilities](/docs/reference/terminal-capabilities). ([#1920](https://github.com/anomalyco/opentui/pull/1920))
- **core:** When no Linux clipboard backend can do an operation, the result stays `unsupported`, and the process logs once why each backend failed. The log names a library that did not load, a display that did not connect, or a missing Wayland protocol. See [Clipboard](/docs/core-concepts/clipboard). ([#1921](https://github.com/anomalyco/opentui/pull/1921))
- **core:** Core checks the context ABI version of the native library when it loads the library. A library built for a different context ABI throws at load. See [Environment variables](/docs/reference/env-vars). ([#1933](https://github.com/anomalyco/opentui/pull/1933))

## Fixed

- **core:** A frame that changes only the pointer shape from `setMousePointer()` no longer hides a visible text cursor. The frame sends only the OSC 22 sequence, and C hosts get the same fix. See [Renderer](/docs/core-concepts/renderer). ([#1939](https://github.com/anomalyco/opentui/pull/1939))
- **core:** A clipboard read on Wayland no longer freezes the process when the compositor stops accepting connections. The read settles as `timed-out` at its deadline. See [Clipboard](/docs/core-concepts/clipboard). ([#1923](https://github.com/anomalyco/opentui/pull/1923))
- **core:** With the native input parser, a typed character from U+E000 to U+E06E, such as a Nerd Fonts glyph, gives a key with that character instead of Escape, Return, or Backspace. A Textarea now inserts the glyph. See [Keyboard input](/docs/core-concepts/keyboard). ([#1919](https://github.com/anomalyco/opentui/pull/1919))
- **core:** With the native input parser, a typed U+FEFF keeps its character in `raw` and `sequence`, so a Textarea no longer drops it. See [Keyboard input](/docs/core-concepts/keyboard). ([#1915](https://github.com/anomalyco/opentui/pull/1915))
- **core:** With the native input parser, a drag in URxvt continues after a wheel tick, so a selection keeps growing. See [Interaction, focus, and selection](/docs/core-concepts/interaction). ([#1917](https://github.com/anomalyco/opentui/pull/1917))
- **core:** A node that changes size and then publishes its hooks again before its first frame still gets its first `onResize` call. This happens, for example, when you assign `renderAfter`. A `buffered: true` node then resizes its buffer and does not clip its drawing to the old width. See [Renderables](/docs/core-concepts/renderables). ([#1918](https://github.com/anomalyco/opentui/pull/1918))
- **core:** Layout no longer makes items millions of cells wide when every item of an overflowing flex line freezes at its minimum size. The vendored Yoga includes the upstream fix. See [Layout](/docs/core-concepts/layout). ([#1922](https://github.com/anomalyco/opentui/pull/1922))
- **core:** Text measurement treats a width that is less than 0.0001 below a whole cell as that cell. After a resize, flex-shrink and flex-grow layouts no longer keep a text one cell wider than a fresh layout. See [Layout](/docs/core-concepts/layout). ([#1926](https://github.com/anomalyco/opentui/pull/1926))
- **core:** `stopVoice()` with the ID of a voice that ended no longer stops a newer sound. Voice IDs now carry a generation. See [Audio](/docs/core-concepts/audio). ([#1935](https://github.com/anomalyco/opentui/pull/1935))
