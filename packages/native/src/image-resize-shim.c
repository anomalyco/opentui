#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// Keep stb_image_resize2 isolated for one accepted upstream exception. Three
// SIMD sRGB lookups form `fp32_to_srgb8_tab4 - 912`; clamped indexes 912...1015
// resolve to the real 104-entry table at 0...103. The effective reads are in
// range, but forming the pre-array pointer violates C's pointer model and trips
// bounds instrumentation. Only `bounds` is disabled for this translation unit;
// pointer-overflow, alignment, and other sanitizers remain enabled, and
// image-shim.c keeps normal instrumentation. This is unrelated to OpenTUI's
// coefficient-copy alignment patch. See vendor/stb/README.md for evidence,
// scope, accepted policy, and the permanent remediation.
#define STB_IMAGE_RESIZE_IMPLEMENTATION
#define STB_IMAGE_RESIZE_STATIC
#include "vendor/stb/stb_image_resize2.h"

enum {
    OT_IMAGE_RESIZE_SHIM_OK = 0,
    OT_IMAGE_RESIZE_SHIM_INVALID = 1,
    OT_IMAGE_RESIZE_SHIM_OUT_OF_MEMORY = 2,
};

int ot_image_resize_rgba(const uint8_t *input, uint32_t input_width, uint32_t input_height,
                         uint32_t input_stride, uint8_t *output, uint32_t output_width,
                         uint32_t output_height, uint32_t output_stride, uint32_t filter) {
    if (!input || !output || input_width == 0 || input_height == 0 ||
        output_width == 0 || output_height == 0 || input_width > INT32_MAX ||
        input_height > INT32_MAX || output_width > INT32_MAX || output_height > INT32_MAX ||
        input_stride > INT32_MAX || output_stride > INT32_MAX || filter > STBIR_FILTER_POINT_SAMPLE) {
        return OT_IMAGE_RESIZE_SHIM_INVALID;
    }

    void *result = stbir_resize(
        input, (int)input_width, (int)input_height, (int)input_stride,
        output, (int)output_width, (int)output_height, (int)output_stride,
        STBIR_RGBA, STBIR_TYPE_UINT8_SRGB, STBIR_EDGE_CLAMP, (stbir_filter)filter);
    return result ? OT_IMAGE_RESIZE_SHIM_OK : OT_IMAGE_RESIZE_SHIM_OUT_OF_MEMORY;
}
