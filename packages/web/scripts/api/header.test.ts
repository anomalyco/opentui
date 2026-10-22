import { expect, test } from "bun:test"

import { headerFeatures, parseGeneratedAbi, type GeneratedAbi } from "./header"

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
})
