import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// @ts-ignore Bun embeds imported assets and returns their runtime paths.
import dragonPath from "../assets/dragon.mp4" with { type: "file" }

// FFmpeg opens only real files: a compiled binary embeds the clip in Bun's virtual file system, and a Node
// bundle names it relative to the bundle.
export function dragonFile(): string {
  const path = resolve(dirname(fileURLToPath(import.meta.url)), dragonPath as string)
  if (!/\$bunfs|^B:[\\/]~BUN/i.test(path)) return path
  const file = join(tmpdir(), basename(path))
  if (!existsSync(file)) writeFileSync(file, readFileSync(path))
  return file
}
