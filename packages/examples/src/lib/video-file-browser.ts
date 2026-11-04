import { readdir, stat } from "node:fs/promises"
import { extname, join, resolve } from "node:path"

export type VideoFileEntryType = "directory" | "file"

export interface VideoFileEntry {
  type: VideoFileEntryType
  path: string
  name: string
}

const SUPPORTED_VIDEO_FILE_EXTENSIONS = new Set([".mov", ".mp4"])

export function isSupportedVideoFileName(fileName: string): boolean {
  return SUPPORTED_VIDEO_FILE_EXTENSIONS.has(extname(fileName).toLowerCase())
}

export function resolveVideoDirectoryPath(currentDirectory: string, input: string): string {
  return resolve(currentDirectory, input.trim())
}

async function classifyEntry(
  directory: string,
  name: string,
  isDirectory: boolean,
  isFile: boolean,
): Promise<VideoFileEntry | null> {
  if (name.startsWith(".")) return null

  const path = join(directory, name)
  if (isDirectory) return { type: "directory", path, name }
  if (isFile) return isSupportedVideoFileName(name) ? { type: "file", path, name } : null

  try {
    const entryStat = await stat(path)
    if (entryStat.isDirectory()) return { type: "directory", path, name }
    if (entryStat.isFile() && isSupportedVideoFileName(name)) return { type: "file", path, name }
  } catch {
    return null
  }

  return null
}

export async function listVideoDirectory(directory: string): Promise<VideoFileEntry[]> {
  const resolvedDirectory = resolve(directory)
  const dirents = await readdir(resolvedDirectory, { withFileTypes: true })
  const entries = await Promise.all(
    dirents.map((dirent) => classifyEntry(resolvedDirectory, dirent.name, dirent.isDirectory(), dirent.isFile())),
  )

  return entries
    .filter((entry): entry is VideoFileEntry => entry !== null)
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1
      return a.name.localeCompare(b.name)
    })
}
