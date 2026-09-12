export interface Variant {
  platform: string
  arch: string
  abi?: string
}

export const variants: Variant[] = [
  { platform: "darwin", arch: "x64" },
  { platform: "darwin", arch: "arm64" },
  { platform: "linux", arch: "x64" },
  { platform: "linux", arch: "arm64" },
  { platform: "linux", arch: "x64", abi: "musl" },
  { platform: "linux", arch: "arm64", abi: "musl" },
  { platform: "win32", arch: "x64" },
  { platform: "win32", arch: "arm64" },
]
