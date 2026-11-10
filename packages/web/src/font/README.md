# OpenTUI Mono

OpenTUI Mono is the typeface for the site. Iosevka compiles
`private-build-plans.toml` into static WOFF2 files. Iosevka does not write
an OpenType variable font.

The live files are Regular, Bold, Italic, and Bold Italic in
`public/fonts/`. `/lab/font` compares those files with the next compile in
`public/fonts/candidate/`.

## Plan

The plan sets glyphs, metrics, weights (100 to 900), and widths (Normal +
SemiCondensed). Ligatures are off. The plan makes one web-subset family.
Change keys in the plan. Do not start from a blank UFO or FontForge file.

Identity glyphs: `a g l I 1 0 8 6 9 @ { } ( ) _ *`.

These keys change the look first: `sb`, width `shape`, `xHeight`,
`archDepth`, and the identity keys in `variants.design`.

## Compile

You need Node 18+ and a clone of [Iosevka](https://github.com/be5invis/Iosevka)
at `v34.4.0`. You do not need `ttfautohint` for `webfont-unhinted`.

```
git clone --depth 1 --branch v34.4.0 https://github.com/be5invis/Iosevka.git
cp packages/web/src/font/private-build-plans.toml Iosevka/
cd Iosevka && npm install
npm run build -- --jCmd=4 webfont-unhinted::OpenTUIMono
```

Copy the next compile into `packages/web/public/fonts/candidate/` as
`OpenTUIMono-{Regular,Bold,Italic,BoldItalic}.woff2`. Compare it with
the live files at `/lab/font`. When you accept the next compile, copy those
four files to `packages/web/public/fonts/`.
