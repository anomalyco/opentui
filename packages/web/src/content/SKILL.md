---
name: opentui
description: Build terminal UIs with OpenTUI. Covers the core API, native audio, keymaps, React and Solid bindings, components, layout, keyboard input, plugins, and testing.
---

# OpenTUI Skill

Canonical reference docs are authored once in sibling `docs/**/*.mdx` files.

Inside the OpenTUI repo, this skill root lives at `packages/web/src/content/`, so the same files are also visible at `packages/web/src/content/docs/**/*.mdx`.

## Path invariant

- `/docs/<slug>` maps to `docs/<slug>.mdx` relative to this skill root
- in the repo, that same slug maps to `packages/web/src/content/docs/<slug>.mdx`

## Reading order by area

- Getting started: `/docs/getting-started`
- Core: `/docs/core-concepts/renderer`
- Testing: `/docs/core-concepts/testing`
- Audio: `/docs/core-concepts/audio`
- Keymap: `/docs/keymap/overview`
- React: `/docs/bindings/react`
- Solid: `/docs/bindings/solid`
- Components: `/docs/components/text`, `/docs/components/input`
- Layout: `/docs/core-concepts/layout`
- Keyboard: `/docs/core-concepts/keyboard`
- Plugins: `/docs/plugins/slots`
- Reference: `/docs/reference/env-vars`

## Quick routing by intent

| Intent(s)                                                  | Start here                        |
| ---------------------------------------------------------- | --------------------------------- |
| `getting-started`, `installation`, `quickstart`, `intro`   | `docs/getting-started.mdx`        |
| `core`, `renderer`, `terminal`, `scrollback`, `lifecycle`  | `docs/core-concepts/renderer.mdx` |
| `audio`, `native-audio`, `sound`, `playback`, `pcm`, `fft` | `docs/core-concepts/audio.mdx`    |
| `keymap`, `keybindings`, `shortcuts`, `commands`, `leader` | `docs/keymap/overview.mdx`        |
| `layout`, `flexbox`, `yoga`, `positioning`                 | `docs/core-concepts/layout.mdx`   |
| `keyboard`, `input`, `keybindings`, `paste`, `focus`       | `docs/core-concepts/keyboard.mdx` |
| `testing`, `test-renderer`, `snapshots`, `frames`          | `docs/core-concepts/testing.mdx`  |
| `react`, `jsx`, `hooks`, `animation`, `testing`            | `docs/bindings/react.mdx`         |
| `solid`, `signals`, `jsx`, `hooks`, `animation`, `testing` | `docs/bindings/solid.mdx`         |
| `plugins`, `plugin`, `slots`, `registry`, `extensions`     | `docs/plugins/slots.mdx`          |
| `text`, `styling`, `content`, `selection`                  | `docs/components/text.mdx`        |
| `input`, `form`, `editing`, `focus`                        | `docs/components/input.mdx`       |
| `env`, `environment`, `configuration`, `flags`             | `docs/reference/env-vars.mdx`     |

For concrete component requests, jump straight to `docs/components/<name>.mdx` after the relevant entry page. For plugin implementation details, narrow from `docs/plugins/slots.mdx` into `docs/plugins/core.mdx`, `docs/plugins/react.mdx`, or `docs/plugins/solid.mdx`.

## Current skill entry pages

- `docs/getting-started.mdx`
- `docs/core-concepts/renderer.mdx`
- `docs/core-concepts/audio.mdx`
- `docs/keymap/overview.mdx`
- `docs/core-concepts/layout.mdx`
- `docs/core-concepts/keyboard.mdx`
- `docs/bindings/react.mdx`
- `docs/bindings/solid.mdx`
- `docs/plugins/slots.mdx`
- `docs/components/text.mdx`
- `docs/components/input.mdx`
- `docs/reference/env-vars.mdx`

## Working rules

- Prefer the current entry pages first, then read narrower docs in the same section.
- Read the sibling `docs/**/*.mdx` files directly instead of copying prose into this file.
- Use stable `/docs/...` URLs when cross-referencing docs.
