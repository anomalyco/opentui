import { beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  compileHeader,
  generateNativeABI,
  serializeNativeABIAudit,
  verifyNativeABI,
  type HeaderABI,
} from "./native-abi.js"
import { nativeAddressFields, nativePointerPolicies } from "./native-abi-pointers.js"

const header = readFileSync(fileURLToPath(new URL("../../native/include/opentui.h", import.meta.url)), "utf8")
let abi: HeaderABI

beforeAll(() => {
  abi = compileHeader()
}, 120_000)

describe("checked native ABI generation", () => {
  test("the committed output matches every header symbol and record", async () => {
    verifyNativeABI(await generateNativeABI(abi))
  }, 120_000)

  test("audit inspection exposes the complete fingerprint input", async () => {
    const audit = serializeNativeABIAudit(abi)
    expect(JSON.parse(audit)).toEqual({
      abi,
      pointerPolicies: nativePointerPolicies,
      addressFields: nativeAddressFields,
    })
    expect(await generateNativeABI(abi)).toContain(
      `// ABI audit SHA-256: ${createHash("sha256").update(audit).digest("hex")}`,
    )
  })

  test("new pointers require explicit policies, even on existing symbols", async () => {
    const changed = header.replace(
      "uint32_t ot_context_abi_version(void);",
      "uint32_t ot_context_abi_version(uint8_t *);",
    )
    await expect(generateNativeABI(compileHeader({ header: changed }))).rejects.toThrow(
      "ot_context_abi_version argument 0",
    )
  }, 120_000)

  test("removed pointers cannot leave unused policies", async () => {
    const policies = {
      ...nativePointerPolicies,
      ot_context_abi_version: { 0: nativePointerPolicies.ot_context_destroy[0] },
    }
    await expect(generateNativeABI(abi, policies)).rejects.toThrow(
      "Unused pointer policy: ot_context_abi_version argument 0",
    )
  }, 120_000)

  test.each([
    ["uint32_t ot_context_abi_version(void);", "uint64_t ot_context_abi_version(void);"],
    ["uint64_t context_id;", "uint32_t context_id;"],
    ["uint32_t slot;\n    uint32_t generation;", "uint32_t generation;\n    uint32_t slot;"],
    ["uint32_t generation, uint32_t event);", "uint32_t generation, uint64_t event);"],
    ["ot_context_error *out_error);", "ot_context_options *out_error);"],
    ["ot_edit_event_callback", "ot_renamed_edit_event_callback"],
  ])(
    "compiler-derived signatures and records detect drift: %s",
    async (before, after) => {
      const changed = header.replaceAll(before, after)
      expect(changed).not.toBe(header)
      const generated = await generateNativeABI(compileHeader({ header: changed }))
      expect(generated).not.toBe(await generateNativeABI(abi))
      expect(() => verifyNativeABI(generated)).toThrow("stale")
    },
    120_000,
  )

  test("ownership policy changes detect drift without changing FFI signatures", async () => {
    const policies = {
      ...nativePointerPolicies,
      ot_scene_set_measure: {
        ...nativePointerPolicies.ot_scene_set_measure,
        2: nativePointerPolicies.ot_context_set_edit_event_callback[1],
      },
    }
    const generated = await generateNativeABI(abi, policies)
    expect(generated).not.toBe(await generateNativeABI(abi))
    expect(() => verifyNativeABI(generated)).toThrow("stale")
  })

  test("address ownership is audited even though its FFI representation is an integer", async () => {
    const addresses = {
      ...nativeAddressFields,
      ot_buffer_lease_snapshot: {
        ...nativeAddressFields.ot_buffer_lease_snapshot,
        char_ptr: { ...nativeAddressFields.ot_buffer_lease_snapshot.char_ptr, release: "ot_context_destroy" },
      },
    }
    const generated = await generateNativeABI(abi, nativePointerPolicies, addresses)
    expect(generated).not.toBe(await generateNativeABI(abi))
    expect(() => verifyNativeABI(generated)).toThrow("stale")
  })

  test("address field type drift fails with the record and field name", async () => {
    const changed = header.replace("uint64_t char_ptr;", "uint32_t char_ptr;")
    expect(changed).not.toBe(header)
    await expect(generateNativeABI(compileHeader({ header: changed }))).rejects.toThrow(
      "Address field drift: ot_buffer_lease_snapshot.char_ptr",
    )
  }, 120_000)

  test("nullable and retained pointers cannot silently become transient buffers", async () => {
    const policies = {
      ...nativePointerPolicies,
      ot_scene_set_measure: {
        ...nativePointerPolicies.ot_scene_set_measure,
        2: { ...nativePointerPolicies.ot_scene_set_measure[2], ffi: "buffer" as const },
      },
    }
    await expect(generateNativeABI(abi, policies)).rejects.toThrow("Invalid transient buffer policy")
  })

  test("changing a parameter to another existing callback type is signature drift", async () => {
    const changed = header.replace(
      "ot_context_set_edit_event_callback(ot_context *, ot_edit_event_callback);",
      "ot_context_set_edit_event_callback(ot_context *, ot_scene_measure_callback);",
    )
    expect(changed).not.toBe(header)
    const compiled = compileHeader({ header: changed })
    expect(compiled.callbacks).toEqual(abi.callbacks)
    const generated = await generateNativeABI(compiled)
    expect(() => verifyNativeABI(generated)).toThrow("stale")
  }, 120_000)

  test("record callback arrays require explicit ownership support", async () => {
    const changed = header.replace("uint32_t reserved[3];", "ot_edit_event_callback reserved[1];")
    expect(changed).not.toBe(header)
    await expect(generateNativeABI(compileHeader({ header: changed }))).rejects.toThrow("ABI record pointer")
  }, 120_000)

  test.each([
    "struct { const uint8_t *bytes; } reserved;",
    "struct { uint32_t first; uint32_t second; } reserved;",
    "struct { uint32_t second; uint32_t first; } reserved;",
  ])(
    "anonymous nested records fail closed: %s",
    (field) => {
      const changed = header.replace("uint32_t reserved[3];", field)
      expect(changed).not.toBe(header)
      expect(() => compileHeader({ header: changed })).toThrow("Unsupported nested ABI record")
    },
    120_000,
  )

  test.each([
    "typedef struct ot_review_bits { uint32_t enabled : 1; } ot_review_bits;",
    "typedef struct ot_review_bits { uint32_t enabled : 1; } ot_review_bits; typedef struct ot_review_outer { ot_review_bits bits; } ot_review_outer;",
  ])(
    "compiler-demoted complete records fail closed: %s",
    (declaration) => {
      expect(() => compileHeader({ header: header + "\n" + declaration })).toThrow("Unsupported opaque ABI type")
    },
    120_000,
  )

  test.each([
    ["typedef void (*ot_edit_event_callback)", "typedef void (__attribute__((ms_abi)) *ot_edit_event_callback)"],
    ["uint32_t ot_context_abi_version(void);", "uint32_t __attribute__((ms_abi)) ot_context_abi_version(void);"],
    [
      "ot_status ot_context_set_edit_event_callback(ot_context *, ot_edit_event_callback);",
      "ot_status ot_context_set_edit_event_callback(ot_context *, void (__attribute__((ms_abi)) *)(uint64_t, uint32_t, uint32_t, uint32_t));",
    ],
  ])(
    "nonportable calling conventions fail closed: %s",
    (before, after) => {
      const changed = header.replace(before, after)
      expect(changed).not.toBe(header)
      expect(() => compileHeader({ header: changed, allTargets: true })).toThrow("Unsupported ABI calling convention")
    },
    120_000,
  )

  test("all-target verification rejects target-specific ABI drift", () => {
    const changed =
      header + "\n#if defined(_WIN32)\n#define OT_TARGET_TEST 1\n#else\n#define OT_TARGET_TEST 2\n#endif\n"
    expect(() => compileHeader({ header: changed, allTargets: true })).toThrow(
      "Checked ABI differs from the generated host ABI",
    )
  }, 120_000)
})
