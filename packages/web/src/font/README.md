# OpenMono

OpenMono is the typeface for the site. It is Anomaly's monospace family,
built on [Iosevka](https://github.com/be5invis/Iosevka) by Renzhi Li
(Belleve Invis), under the SIL Open Font License 1.1. The license text is in
`public/fonts/LICENSE`.

The site does not compile the typeface. The files in `public/fonts/` are
the WOFF2 files that the OpenCode website serves. That website makes them
from the OpenMono 1.000 build with `services/site/script/openmono.py` in
`anomalyco/opencode`. The files have no ligatures. Each character is one
cell wide, and that includes arrows and geometric shapes.

Each style is split by `unicode-range`, so a page loads only the files that
its text needs:

- `latin`: Latin, punctuation, arrows, shortcut keys such as `⌘` and `⇧`,
  box drawing, block elements, geometric shapes, and common symbols such
  as `✓`, `⚠`, and `≠`. Pages preload the Regular file.
- `cyrillic`: Cyrillic and its stress marks (U+0300 to U+0301).
- `rest`: the other characters, such as Greek, Vietnamese, Armenian, the
  other math operators, and combining marks.

`layouts/Minimal.astro` declares the files as the `OpenMono` family. The
`unicode-range` of each rule must be the range of that group in the
website's `openmono.json`. The rules of each style must be in the order
`latin`, `rest`, `cyrillic`. Both `rest` and `cyrillic` have the stress
marks, and the browser uses the last rule that has a character. With this
order, Cyrillic text with a stress mark loads only the `cyrillic` file.

The browser uses a fallback font for a character that is not in the files,
such as Braille patterns and CJK.

## Update

Copy the files from a checkout of `anomalyco/opencode`:

```
cd packages/web
bun run fonts:update <opencode checkout>/services/site/src/asset/fonts
```

The script writes the twelve font files and `public/fonts/LICENSE`. Then it
compares the rules in `layouts/Minimal.astro` with `openmono.json`. If a
range differs, it fails and prints the range that the rule needs. It also
fails if the rules of a style are in another order.
