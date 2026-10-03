import { beforeAll, describe, expect, test } from "bun:test"
import { compileHeader, generateNativeABI, verifyNativeABI, type HeaderABI } from "./native-abi.js"

let abi: HeaderABI

beforeAll(() => {
  abi = compileHeader()
}, 120_000)

describe("checked native ABI generation", () => {
  test("the committed output matches every header symbol and record", async () => {
    verifyNativeABI(await generateNativeABI(abi))
  }, 120_000)

  test("C compiler record layouts must match the translated records", () => {
    // Translate-C ignores #pragma pack, so only the C compiler sees this 12-byte layout.
    const header = [
      "#include <stdint.h>",
      "#pragma pack(push, 2)",
      "typedef struct ot_z { uint32_t a; uint64_t b; } ot_z;",
      "#pragma pack(pop)",
    ].join("\n")
    expect(() => compileHeader({ header })).toThrow("C layout differs from Translate-C: ot_z")
  }, 120_000)
})
