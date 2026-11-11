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

/** The variant's suffix in package and symbol directory names, such as linux-x64-musl. */
export function variantName({ platform, arch, abi }: Variant): string {
  return `${platform}-${arch}${abi ? `-${abi}` : ""}`
}

/** The output name of the variant in packages/native/build.zig, its directory under lib/: x86_64-linux-musl. */
export function zigOutputName({ platform, arch, abi }: Variant): string {
  const platformMap: Record<string, string> = { darwin: "macos", win32: "windows", linux: "linux" }
  const archMap: Record<string, string> = { x64: "x86_64", arm64: "aarch64" }
  const base = `${archMap[arch] ?? arch}-${platformMap[platform] ?? platform}`
  return abi ? `${base}-${abi}` : base
}
