import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { featureKey, parseFeature } from "../../src/lib/api-history"
import { documentedSymbols } from "../../src/lib/api-index-symbols"
import { headerFeatures, headerFeaturesIn, parseGeneratedAbi, type GeneratedAbi } from "./header"

const repoRoot = join(import.meta.dirname, "../../../..")

const header = `#ifndef FIXTURE_H
#define FIXTURE_H

#include <stdint.h>

#ifdef __cplusplus
#if __cplusplus >= 201103L
#define OT_NOEXCEPT noexcept
#endif
extern "C" {
#endif

/* A context's owner can't share it. // not a line comment */
#define OT_OK INT32_C(0)
#define OT_LIMIT (OT_OK + 4) // a value that refers to another macro
typedef int32_t ot_status;
typedef struct ot_context ot_context;
typedef struct ot_handle {
    uint64_t context_id;
    uint32_t slot, generation;
} ot_handle;
typedef struct ot_options {
    uint32_t struct_size;
    const uint8_t *name;
    uint16_t color[4];
} ot_options;
typedef void (*ot_callback)(void *user_data, uint32_t   event);

uint32_t ot_version(void);
ot_status ot_create(const ot_options *options,
                    ot_context **out_context);

#ifdef __cplusplus
}
#endif

#endif
`

const abi: GeneratedAbi = {
  nativeSymbols: { ot_version: { args: [] }, ot_create: { args: ["buffer", "buffer"] } },
  nativeCallbacks: { ot_callback: { args: ["ptr", "u32"] } },
  nativeLayouts: {
    ot_handle: { fields: { context_id: { offset: 0 }, slot: { offset: 8 }, generation: { offset: 12 } } },
    ot_options: { fields: { struct_size: { offset: 0 }, name: { offset: 8 }, color: { offset: 16 } } },
  },
  nativeConstants: { OT_OK: 0, OT_LIMIT: 4 },
}

test("the header's declarations are features with the generated offsets and values", () => {
  expect(headerFeatures(header, abi)).toEqual([
    "opentui.h: function ot_version(void): uint32_t",
    "opentui.h: function ot_create(const ot_options *options, ot_context **out_context): ot_status",
    "opentui.h: type ot_callback = void (*)(void *user_data, uint32_t event)",
    "opentui.h: type ot_status = int32_t",
    "opentui.h: type ot_context = struct ot_context",
    "opentui.h: struct ot_handle",
    "opentui.h: field ot_handle.context_id: uint64_t, offset 0",
    "opentui.h: field ot_handle.slot: uint32_t, offset 8",
    "opentui.h: field ot_handle.generation: uint32_t, offset 12",
    "opentui.h: struct ot_options",
    "opentui.h: field ot_options.struct_size: uint32_t, offset 0",
    "opentui.h: field ot_options.name: const uint8_t *, offset 8",
    "opentui.h: field ot_options.color: uint16_t[4], offset 16",
    "opentui.h: const OT_OK = 0",
    "opentui.h: const OT_LIMIT = 4",
  ])
})

test.each([
  ["#define OT_PACK(a) (a)", "function-like macro OT_PACK"],
  ["#if OT_FEATURE\n#endif", "unsupported #if OT_FEATURE"],
  ["#ifdef __cplusplus\n#else\n#endif", "unsupported #else"],
  ["#pragma pack(1)", "unsupported #pragma pack(1)"],
  ["#endif", "unsupported #endif"],
  ["#ifndef GUARD", "unterminated #if"],
  ["typedef struct ot_x { struct { uint32_t a; } inner; } ot_x;", "unsupported struct field"],
  ["typedef struct ot_x { uint32_t a : 3; } ot_x;", "unsupported struct field"],
  ["typedef struct ot_x { uint32_t a; } ot_y;", "struct ot_x has the typedef name ot_y"],
  ["typedef enum ot_kind { OT_A } ot_kind;", "unsupported declaration"],
  ["extern uint32_t ot_global;", "unsupported declaration"],
  ["uint32_t version(void);", "version does not start with ot_"],
  ["/* unterminated", "unterminated comment"],
])("the header reader rejects %j", (source, message) => {
  expect(() => headerFeatures(source, abi)).toThrow(message)
})

test.each<[string, (abi: GeneratedAbi) => void, string]>([
  ["a missing function", (abi) => delete abi.nativeSymbols.ot_version, "function ot_version is only in the header"],
  [
    "an extra callback",
    (abi) => (abi.nativeCallbacks.ot_other = { args: [] }),
    "callback ot_other is only in the generated",
  ],
  ["another arity", (abi) => abi.nativeSymbols.ot_create!.args.pop(), "ot_create has 2 parameters in the header and 1"],
  ["a missing struct", (abi) => delete abi.nativeLayouts.ot_options, "struct ot_options is only in the header"],
  [
    "another field order",
    (abi) =>
      (abi.nativeLayouts.ot_handle!.fields = {
        slot: { offset: 8 },
        context_id: { offset: 0 },
        generation: { offset: 12 },
      }),
    "struct ot_handle has fields context_id, slot, generation in the header and slot, context_id, generation",
  ],
  ["an extra macro", (abi) => (abi.nativeConstants.OT_EXTRA = 1), "constant OT_EXTRA is only in the generated ABI"],
])("the generated ABI with %s disagrees with the header", (_, change, message) => {
  const changed = structuredClone(abi)
  change(changed)
  expect(() => headerFeatures(header, changed)).toThrow(message)
})

test("the generated ABI is read without running it", () => {
  const source = `export const nativeSymbols = { ot_a: { args: ["ptr"], returns: "i32" } } as const
export const nativeCallbacks = {} as const
export const nativeLayouts = { ot_b: { size: 4, fields: { "x": { offset: 0 } } } } as const
export const nativeConstants = { OT_C: -1, OT_D: 4294967295 } as const`
  expect(parseGeneratedAbi(source)).toEqual({
    nativeSymbols: { ot_a: { args: ["ptr"], returns: "i32" } },
    nativeCallbacks: {},
    nativeLayouts: { ot_b: { size: 4, fields: { x: { offset: 0 } } } },
    nativeConstants: { OT_C: -1, OT_D: 4294967295 },
  } as unknown as GeneratedAbi)
  expect(() => parseGeneratedAbi("export const nativeSymbols = {}")).toThrow("has no nativeCallbacks")
})

test("the repository's header agrees with its generated ABI, and the API index names its declarations", () => {
  const features = headerFeaturesIn(repoRoot).map(parseFeature)
  expect(features.length).toBeGreaterThan(0)
  expect(new Set(features.map(featureKey)).size).toBe(features.length)
  const declared = new Set(features.map((feature) => feature.name))
  const index = readFileSync(join(repoRoot, "packages/web/src/content/docs/reference/api-index.mdx"), "utf8")
  const indexed = documentedSymbols(index).filter((symbol) => symbol.module === "opentui.h")
  expect(indexed.length).toBeGreaterThan(0)
  expect(indexed.filter((symbol) => !declared.has(symbol.name))).toEqual([])
})
