#!/usr/bin/env bun
// Copies the OpenMono files that the site serves into public/fonts.
//
// The OpenCode website makes the files from the OpenMono build with services/site/script/openmono.py in
// anomalyco/opencode. That script splits each style by unicode-range: "latin" (the file that pages preload),
// "cyrillic", and "rest" (the other characters). The files have no ligatures, and each character is one cell
// wide. openmono.json in the same folder has the range of each group.
//
// The @font-face rules in src/layouts/Minimal.astro repeat those ranges. This script fails when a rule and
// openmono.json differ, because a copied file is only correct with the range that its rule declares.
//
// "cyrillic" and "rest" both have U+0300-0301, the stress marks of Cyrillic text. The browser uses the last rule
// that has a character, so the "cyrillic" rule of a style must be after its "rest" rule. Then Cyrillic text with
// a stress mark loads only the "cyrillic" file. This script fails when the rules are in another order.
//
// Usage: bun scripts/update-fonts.ts <opencode checkout>/services/site/src/asset/fonts

import { join, resolve } from "node:path"

// The order of the rules of each style in Minimal.astro.
const GROUPS = ["latin", "rest", "cyrillic"] as const
const STYLES = ["regular", "bold", "italic", "bold-italic"]
const LICENSE = "OpenMono-OFL.txt"
const RANGES = "openmono.json"
const CREDIT = "These files are copies from anomalyco/opencode, services/site/src/asset/fonts.\n\n"

if (!Bun.argv[2]) {
  console.error("Usage: bun scripts/update-fonts.ts <opencode checkout>/services/site/src/asset/fonts")
  process.exit(1)
}

const source = resolve(Bun.argv[2])
const web = resolve(import.meta.dir, "..")
const fonts = join(web, "public/fonts")
const faces = STYLES.flatMap((style) => GROUPS.map((group) => ({ group, name: `openmono-${style}-${group}.woff2` })))

// A folder that is being rebuilt has files missing. Copy nothing rather than a part of the set.
const missing = (
  await Promise.all(
    [RANGES, LICENSE, ...faces.map((face) => face.name)].map(async (name) =>
      (await Bun.file(join(source, name)).exists()) ? [] : [name],
    ),
  )
).flat()
if (missing.length > 0) {
  console.error(`Not in ${source}: ${missing.join(", ")}`)
  process.exit(1)
}

for (const face of faces) {
  const bytes = await Bun.write(join(fonts, face.name), Bun.file(join(source, face.name)))
  console.log(`${face.name}  ${bytes} bytes`)
}
await Bun.write(join(fonts, "LICENSE"), CREDIT + (await Bun.file(join(source, LICENSE)).text()))

const ranges: Record<(typeof GROUPS)[number], string> = await Bun.file(join(source, RANGES)).json()
const compact = (text: string) => text.replaceAll(/\s/g, "")
const rules = compact(await Bun.file(join(web, "src/layouts/Minimal.astro")).text()).match(/@font-face\{[^}]*\}/g) ?? []
const stale = faces.filter(
  (face) =>
    !rules.some(
      (rule) =>
        rule.includes(`/fonts/${face.name}"`) && rule.includes(compact(`unicode-range: ${ranges[face.group]};`)),
    ),
)
if (stale.length > 0) {
  console.error("Update src/layouts/Minimal.astro to match openmono.json:")
  for (const face of stale) console.error(`  ${face.name} needs unicode-range: ${ranges[face.group]};`)
  process.exit(1)
}
if (rules.length !== faces.length) {
  console.error(`src/layouts/Minimal.astro has ${rules.length} @font-face rules for ${faces.length} files.`)
  process.exit(1)
}
if (faces.some((face, index) => !rules[index]!.includes(`/fonts/${face.name}"`))) {
  console.error(`Put the rules of each style in src/layouts/Minimal.astro in this order: ${GROUPS.join(", ")}.`)
  process.exit(1)
}
console.log(`src/layouts/Minimal.astro declares the ${faces.length} files with the ranges of ${RANGES}.`)
