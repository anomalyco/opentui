# OpenMono

OpenMono is the typeface for the site. It is Anomaly's monospace family,
built on [Iosevka](https://github.com/be5invis/Iosevka) by Belleve Invis,
under the SIL Open Font License 1.1. The license text is in
`public/fonts/LICENSE`.

The site does not compile the typeface. The files in `public/fonts/` are
the WOFF2 files that the OpenCode website serves. That website makes them
from the OpenMono 1.000 build with `services/site/script/openmono.py` in
`anomalyco/opencode`. The files have no ligatures. Each character is one
cell wide, and that includes arrows and geometric shapes.

Each style is split by `unicode-range`, so a page loads only the files that
its text needs:

- `latin`: Latin, punctuation, arrows, box drawing, block elements, and
  geometric shapes. Pages preload the Regular file.
- `cyrillic`: Cyrillic, for Regular and Bold. Italic text in Cyrillic uses a
  fallback font.
- `rest`: the other characters, such as math operators, combining marks, and
  `✓`.

`layouts/Minimal.astro` declares the files as the `OpenMono` family. The
`unicode-range` of each rule must be the range of that group in the
website's `openmono.json`. The browser uses a fallback font for a character
that is not in the files, such as Braille patterns and CJK.

## Update

Copy the files from a checkout of `anomalyco/opencode`:

```
cd packages/web
bun run fonts:update <opencode checkout>/services/site/src/asset/fonts
```

The script writes the ten font files and `public/fonts/LICENSE`. Then it
compares the rules in `layouts/Minimal.astro` with `openmono.json`. If a
range differs, it fails and prints the range that the rule needs.
