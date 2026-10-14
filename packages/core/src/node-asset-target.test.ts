import { describe, expect, test } from "bun:test"

import { getNativeAssetDescriptor } from "./node-asset-target.js"
import { variants } from "../scripts/variants.js"

describe("FreeBSD native assets", () => {
  test.each(["x64", "arm64"] as const)("resolves the %s shared library", (arch) => {
    expect(getNativeAssetDescriptor({ platform: "freebsd", arch })).toEqual({
      packageName: `@opentui/core-freebsd-${arch}`,
      fileName: "libopentui.so",
      key: `@opentui/core-freebsd-${arch}/libopentui.so`,
    })
  })

  test("rejects Linux libc selectors on FreeBSD", () => {
    expect(() => getNativeAssetDescriptor({ platform: "freebsd", arch: "x64", libc: "glibc" })).toThrow(
      "libc is only supported on Linux",
    )
    expect(() => getNativeAssetDescriptor({ platform: "freebsd", arch: "arm64", libc: "musl" })).toThrow(
      "libc is only supported on Linux",
    )
  })

  test("packages both FreeBSD architectures without a Linux ABI suffix", () => {
    expect(variants.filter((variant) => variant.platform === "freebsd")).toEqual([
      { platform: "freebsd", arch: "x64" },
      { platform: "freebsd", arch: "arm64" },
    ])
  })
})
