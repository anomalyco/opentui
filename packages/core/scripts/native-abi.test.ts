import { describe, expect, test } from "bun:test"
import type { AddressFields, PointerPolicies } from "./native-abi-pointers.js"
import { compileHeader, generateNativeABI, verifyNativeABI, type HeaderABI } from "./native-abi.js"

// `bun run check:abi` checks the committed output for the real header before `bun test` runs.
const buffer = { ffi: "buffer", nullable: "never", retention: "call", source: "view" } as const
const callback = { ffi: "ptr", nullable: "optional", retention: "call", source: "callback" } as const

function syntheticABI(): { abi: HeaderABI; policies: PointerPolicies; addresses: AddressFields } {
  return {
    abi: {
      symbols: { ot_f: { args: ["*const u8", "callback(u32)->void", "u32"], returns: "i32" } },
      callbacks: {},
      layouts: {
        ot_r: { size: 8, alignment: 8, fields: { address: { offset: 0, size: 8, alignment: 8, type: "u64" } } },
      },
      constants: { OT_STYLE_ENUM_A: 0, OT_STYLE_ENUM_A_MAX: 2 },
    },
    policies: { ot_f: { 0: buffer, 1: callback } },
    addresses: {
      ot_r: { address: { type: "u64", nullable: false, lifetime: "lease", release: "ot_f", element: "u8" } },
    },
  }
}

type Mutation = (input: ReturnType<typeof syntheticABI>) => void

describe("checked native ABI generation", () => {
  test("a synthetic ABI generates, and stale output rejects", async () => {
    const { abi, policies, addresses } = syntheticABI()
    expect(await generateNativeABI(abi, policies, addresses)).toContain(
      'ot_f: { args: ["buffer", "ptr", "u32"], returns: "i32" }',
    )
    expect(() => verifyNativeABI("stale")).toThrow("native-abi.generated.ts is stale")
  })

  test.each<[string, Mutation]>([
    ["Unsupported FFI type: ot_f returns: bool", ({ abi }) => (abi.symbols.ot_f!.returns = "bool")],
    ["Missing pointer policy: ot_f argument 0", ({ policies }) => delete policies.ot_f![0]],
    ["must use buffer: ot_f argument 0", ({ policies }) => (policies.ot_f![0] = { ...buffer, ffi: "ptr" })],
    ["must use ptr: ot_f argument 0", ({ policies }) => (policies.ot_f![0] = { ...buffer, nullable: "empty" })],
    [
      "Callback policy mismatch: ot_f argument 1",
      ({ policies }) => (policies.ot_f![1] = { ...callback, source: "view" }),
    ],
    [
      "Pointer returns must use ptr: ot_f argument returns",
      ({ abi, policies }) => {
        abi.symbols.ot_f!.returns = "*u8"
        policies.ot_f!.returns = buffer
      },
    ],
    ["Unused pointer policy: ot_g argument 0", ({ policies }) => (policies.ot_g = { 0: buffer })],
    ["explicit ownership policy: ot_r.address", ({ abi }) => (abi.layouts.ot_r!.fields.address!.type = "*u8")],
    ["Address field drift: ot_r.address", ({ abi }) => (abi.layouts.ot_r!.fields.address!.type = "u32")],
    ["needs bigint support: OT_BIG", ({ abi }) => (abi.constants.OT_BIG = 2 ** 53)],
    ["Missing style enum constraint: OT_STYLE_ENUM_A", ({ abi }) => delete abi.constants.OT_STYLE_ENUM_A_MAX],
    ["Missing style enum constraint: OT_STYLE_ENUM_B", ({ abi }) => (abi.constants.OT_STYLE_ENUM_B = 2)],
  ])("generation rejects %s", async (message, mutate) => {
    const input = syntheticABI()
    mutate(input)
    await expect(generateNativeABI(input.abi, input.policies, input.addresses)).rejects.toThrow(message)
  })

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
