export function slugifyHeading(text: string): string {
  return text
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/[*~]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_\s-]/g, "")
    .trim()
    .replace(/\s/g, "-")
}

export function getFenceMarker(line: string): { marker: string; length: number } | undefined {
  const match = line.match(/^(`{3,}|~{3,})/)
  if (!match) {
    return undefined
  }

  return { marker: match[1][0], length: match[1].length }
}

export function closesFence(line: string, fence: { marker: string; length: number }): boolean {
  const pattern = new RegExp(`^${fence.marker}{${fence.length},}\\s*$`)
  return pattern.test(line)
}
