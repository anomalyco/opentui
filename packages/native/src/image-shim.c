#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "lcms2.h"

#define WUFFS_IMPLEMENTATION
#define WUFFS_CONFIG__STATIC_FUNCTIONS
#define WUFFS_CONFIG__MODULES
#define WUFFS_CONFIG__MODULE__BASE
#define WUFFS_CONFIG__MODULE__ADLER32
#define WUFFS_CONFIG__MODULE__CRC32
#define WUFFS_CONFIG__MODULE__DEFLATE
#define WUFFS_CONFIG__MODULE__LZW
#define WUFFS_CONFIG__MODULE__ZLIB
#define WUFFS_CONFIG__MODULE__GIF
#define WUFFS_CONFIG__MODULE__PNG
#include "vendor/wuffs/wuffs-v0.3.c"

static _Thread_local int ot_image_stbi_out_of_memory = 0;

static void *ot_image_stbi_malloc(size_t size) {
    void *result = malloc(size);
    if (!result && size > 0) ot_image_stbi_out_of_memory = 1;
    return result;
}

static void *ot_image_stbi_realloc(void *pointer, size_t old_size, size_t new_size) {
    (void)old_size;
    void *result = realloc(pointer, new_size);
    if (!result && new_size > 0) ot_image_stbi_out_of_memory = 1;
    return result;
}

#define STBI_MALLOC(size) ot_image_stbi_malloc(size)
#define STBI_REALLOC_SIZED(pointer, old_size, new_size) ot_image_stbi_realloc(pointer, old_size, new_size)
#define STBI_FREE(pointer) free(pointer)
#define STB_IMAGE_IMPLEMENTATION
#define STB_IMAGE_STATIC
#define STBI_ONLY_JPEG
#define STBI_NO_STDIO
#define STBI_STRICT_JPEG
#include "vendor/stb/stb_image.h"

#include "src/webp/decode.h"

enum {
    OT_IMAGE_SHIM_OK = 0,
    OT_IMAGE_SHIM_INVALID = 1,
    OT_IMAGE_SHIM_OUT_OF_MEMORY = 2,
    OT_IMAGE_SHIM_OUTPUT_TOO_SMALL = 3,
    OT_IMAGE_SHIM_UNSUPPORTED = 4,
    OT_IMAGE_SHIM_UNSUPPORTED_COLOR = 5,
    OT_IMAGE_SHIM_UNSUPPORTED_FEATURE = 6,
    OT_IMAGE_SHIM_INTERNAL = 7,
};

static int ot_image_init_png_decoder(wuffs_png__decoder *decoder) {
    wuffs_base__status status = wuffs_png__decoder__initialize(
        decoder, sizeof(*decoder), WUFFS_VERSION, 0);
    return wuffs_base__status__is_ok(&status) ? OT_IMAGE_SHIM_OK : OT_IMAGE_SHIM_INVALID;
}

int ot_image_png_probe(const uint8_t *data, uint32_t data_len, uint32_t *width, uint32_t *height) {
    if (!data || data_len == 0 || !width || !height) return OT_IMAGE_SHIM_INVALID;

    wuffs_png__decoder *decoder = malloc(sizeof(*decoder));
    if (!decoder) return OT_IMAGE_SHIM_OUT_OF_MEMORY;

    int result = ot_image_init_png_decoder(decoder);
    if (result != OT_IMAGE_SHIM_OK) {
        free(decoder);
        return result;
    }

    wuffs_base__io_buffer src = wuffs_base__ptr_u8__reader((uint8_t *)data, data_len, true);
    wuffs_base__image_config config = wuffs_base__null_image_config();
    wuffs_base__status status = wuffs_png__decoder__decode_image_config(decoder, &config, &src);
    if (!wuffs_base__status__is_ok(&status) || !wuffs_base__pixel_config__is_valid(&config.pixcfg)) {
        free(decoder);
        return OT_IMAGE_SHIM_INVALID;
    }

    *width = wuffs_base__pixel_config__width(&config.pixcfg);
    *height = wuffs_base__pixel_config__height(&config.pixcfg);
    free(decoder);
    return (*width > 0 && *height > 0) ? OT_IMAGE_SHIM_OK : OT_IMAGE_SHIM_INVALID;
}

int ot_image_png_decode(const uint8_t *data, uint32_t data_len, uint8_t *output,
                        uint64_t output_len, uint32_t expected_width, uint32_t expected_height) {
    if (!data || data_len == 0 || !output || expected_width == 0 || expected_height == 0) {
        return OT_IMAGE_SHIM_INVALID;
    }

    uint64_t required = (uint64_t)expected_width * (uint64_t)expected_height * 4u;
    if (required > output_len || required > SIZE_MAX) return OT_IMAGE_SHIM_OUTPUT_TOO_SMALL;

    wuffs_png__decoder *decoder = malloc(sizeof(*decoder));
    if (!decoder) return OT_IMAGE_SHIM_OUT_OF_MEMORY;

    int result = ot_image_init_png_decoder(decoder);
    if (result != OT_IMAGE_SHIM_OK) {
        free(decoder);
        return result;
    }

    wuffs_base__io_buffer src = wuffs_base__ptr_u8__reader((uint8_t *)data, data_len, true);
    wuffs_base__image_config config = wuffs_base__null_image_config();
    wuffs_base__status status = wuffs_png__decoder__decode_image_config(decoder, &config, &src);
    if (!wuffs_base__status__is_ok(&status) ||
        wuffs_base__pixel_config__width(&config.pixcfg) != expected_width ||
        wuffs_base__pixel_config__height(&config.pixcfg) != expected_height) {
        free(decoder);
        return OT_IMAGE_SHIM_INVALID;
    }

    wuffs_base__pixel_config output_config = wuffs_base__null_pixel_config();
    wuffs_base__pixel_config__set(&output_config, WUFFS_BASE__PIXEL_FORMAT__RGBA_NONPREMUL,
                                  WUFFS_BASE__PIXEL_SUBSAMPLING__NONE,
                                  expected_width, expected_height);
    wuffs_base__pixel_buffer pixel_buffer;
    status = wuffs_base__pixel_buffer__set_from_slice(
        &pixel_buffer, &output_config, wuffs_base__make_slice_u8(output, (size_t)required));
    if (!wuffs_base__status__is_ok(&status)) {
        free(decoder);
        return OT_IMAGE_SHIM_INVALID;
    }

    wuffs_base__range_ii_u64 workbuf_range = wuffs_png__decoder__workbuf_len(decoder);
    uint64_t workbuf_len = workbuf_range.max_incl;
    if (workbuf_len > SIZE_MAX) {
        free(decoder);
        return OT_IMAGE_SHIM_OUT_OF_MEMORY;
    }

    uint8_t *workbuf = workbuf_len ? malloc((size_t)workbuf_len) : NULL;
    if (workbuf_len && !workbuf) {
        free(decoder);
        return OT_IMAGE_SHIM_OUT_OF_MEMORY;
    }

    status = wuffs_png__decoder__decode_frame(
        decoder, &pixel_buffer, &src, WUFFS_BASE__PIXEL_BLEND__SRC,
        wuffs_base__make_slice_u8(workbuf, (size_t)workbuf_len), NULL);
    free(workbuf);
    free(decoder);
    return wuffs_base__status__is_ok(&status) ? OT_IMAGE_SHIM_OK : OT_IMAGE_SHIM_INVALID;
}

typedef struct {
    int error_code;
    int out_of_memory;
} ot_image_icc_error_state;

typedef struct {
    cmsContext context;
    cmsHPROFILE input;
    cmsHPROFILE output;
    cmsHTRANSFORM transform;
    ot_image_icc_error_state error_state;
    uint8_t *profile_bytes;
    uint32_t profile_len;
    uint32_t max_profile_len;
    uint64_t last_used;
    int grayscale;
} ot_image_icc_transform;

#define OT_IMAGE_ICC_CACHE_CAPACITY 8
static ot_image_icc_transform *ot_image_icc_cache[OT_IMAGE_ICC_CACHE_CAPACITY];
static uint64_t ot_image_icc_cache_clock = 0;
static uint64_t ot_image_icc_cache_hits = 0;
static uint64_t ot_image_icc_cache_misses = 0;
static _Thread_local int ot_image_icc_test_fail_profile_copy_allocation = 0;

void ot_image_icc_test_fail_profile_copy_allocation_once(void) {
    ot_image_icc_test_fail_profile_copy_allocation = 1;
}

static void ot_image_icc_error_handler(cmsContext context, cmsUInt32Number error_code,
                                       const char *text) {
    ot_image_icc_error_state *state = cmsGetContextUserData(context);
    if (state) {
        state->error_code = (int)error_code;
        state->out_of_memory = error_code == cmsERROR_READ && text &&
            strncmp(text, "Couldn't allocate ", 18) == 0;
    }
}

static int ot_image_icc_error_result(int error_code) {
    switch (error_code) {
        case cmsERROR_COLORSPACE_CHECK:
            return OT_IMAGE_SHIM_UNSUPPORTED_COLOR;
        case cmsERROR_UNKNOWN_EXTENSION:
            return OT_IMAGE_SHIM_UNSUPPORTED_FEATURE;
        case cmsERROR_INTERNAL:
            return OT_IMAGE_SHIM_INTERNAL;
        default:
            return OT_IMAGE_SHIM_INVALID;
    }
}

static uint32_t ot_image_read_u32_be(const uint8_t *bytes) {
    return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) |
           ((uint32_t)bytes[2] << 8) | bytes[3];
}

static int ot_image_icc_check_structure(const uint8_t *profile, uint32_t profile_len,
                                        uint32_t color_type) {
    if (!profile || profile_len < 132 || (profile_len & 3u) != 0 ||
        ot_image_read_u32_be(profile) != profile_len ||
        memcmp(profile + 36, "acsp", 4) != 0) {
        return OT_IMAGE_SHIM_INVALID;
    }
    if ((profile[9] >> 4) > 9 || (profile[9] & 0x0F) > 9 ||
        profile[10] != 0 || profile[11] != 0) {
        return OT_IMAGE_SHIM_INVALID;
    }
    if (profile[8] != 2 && profile[8] != 4) return OT_IMAGE_SHIM_UNSUPPORTED_FEATURE;
    if (memcmp(profile + 12, "mntr", 4) != 0) return OT_IMAGE_SHIM_UNSUPPORTED_COLOR;
    const char *expected_space = (color_type == 0 || color_type == 4) ? "GRAY" : "RGB ";
    if (memcmp(profile + 16, expected_space, 4) != 0) return OT_IMAGE_SHIM_UNSUPPORTED_COLOR;
    if (memcmp(profile + 20, "XYZ ", 4) != 0 && memcmp(profile + 20, "Lab ", 4) != 0) {
        return OT_IMAGE_SHIM_UNSUPPORTED_COLOR;
    }
    for (uint32_t index = 100; index < 128; ++index) {
        if (profile[index] != 0) return OT_IMAGE_SHIM_INVALID;
    }

    uint32_t tag_count = ot_image_read_u32_be(profile + 128);
    if (tag_count > 100) return OT_IMAGE_SHIM_UNSUPPORTED_FEATURE;
    uint64_t directory_end = 132u + ((uint64_t)tag_count * 12u);
    if (directory_end > profile_len) return OT_IMAGE_SHIM_INVALID;
    for (uint32_t index = 0; index < tag_count; ++index) {
        const uint8_t *entry = profile + 132u + (index * 12u);
        uint32_t offset = ot_image_read_u32_be(entry + 4);
        uint32_t size = ot_image_read_u32_be(entry + 8);
        if (size == 0 || (offset & 3u) != 0 || offset < directory_end ||
            (uint64_t)offset + size > profile_len) {
            return OT_IMAGE_SHIM_INVALID;
        }
        for (uint32_t previous = 0; previous < index; ++previous) {
            const uint8_t *other = profile + 132u + (previous * 12u);
            if (memcmp(entry, other, 4) == 0) return OT_IMAGE_SHIM_INVALID;
            uint32_t other_offset = ot_image_read_u32_be(other + 4);
            uint32_t other_size = ot_image_read_u32_be(other + 8);
            if (offset == other_offset && size == other_size) continue;
            if ((uint64_t)offset < (uint64_t)other_offset + other_size &&
                (uint64_t)other_offset < (uint64_t)offset + size) {
                return OT_IMAGE_SHIM_INVALID;
            }
        }
    }
    return OT_IMAGE_SHIM_OK;
}

static int ot_image_icc_decompress(const uint8_t *compressed, uint32_t compressed_len,
                                   uint32_t max_profile_len, uint8_t **profile,
                                   uint32_t *profile_len) {
    if (!compressed || compressed_len == 0 || max_profile_len == 0 ||
        max_profile_len == UINT32_MAX || !profile || !profile_len) {
        return OT_IMAGE_SHIM_INVALID;
    }
    size_t capacity = ((size_t)max_profile_len + 1u) < 4096u
        ? (size_t)max_profile_len + 1u
        : 4096u;
    for (int attempt = 0; attempt < 2; ++attempt) {
        uint8_t *output = malloc(capacity);
        if (!output) return OT_IMAGE_SHIM_OUT_OF_MEMORY;
        wuffs_zlib__decoder *decoder = wuffs_zlib__decoder__alloc();
        if (!decoder) {
            free(output);
            return OT_IMAGE_SHIM_OUT_OF_MEMORY;
        }

        wuffs_base__io_buffer src = wuffs_base__ptr_u8__reader((uint8_t *)compressed, compressed_len, true);
        wuffs_base__io_buffer dst = wuffs_base__ptr_u8__writer(output, capacity);
        uint8_t workbuf[WUFFS_ZLIB__DECODER_WORKBUF_LEN_MAX_INCL_WORST_CASE];
        wuffs_base__status status = wuffs_zlib__decoder__transform_io(
            decoder, &dst, &src, wuffs_base__make_slice_u8(workbuf, sizeof(workbuf)));
        free(decoder);

        if (status.repr == wuffs_base__suspension__short_write) {
            if (attempt != 0) {
                free(output);
                return OT_IMAGE_SHIM_INVALID;
            }
            if (dst.meta.wi < 4) {
                free(output);
                return OT_IMAGE_SHIM_OUTPUT_TOO_SMALL;
            }
            uint32_t declared_len = ot_image_read_u32_be(output);
            free(output);
            if (declared_len > max_profile_len) return OT_IMAGE_SHIM_OUTPUT_TOO_SMALL;
            if (declared_len < 132 || (size_t)declared_len + 1u <= capacity) {
                return OT_IMAGE_SHIM_INVALID;
            }
            capacity = (size_t)declared_len + 1u;
            continue;
        }
        if (!wuffs_base__status__is_ok(&status) || src.meta.ri != compressed_len ||
            dst.meta.wi > max_profile_len) {
            free(output);
            return OT_IMAGE_SHIM_INVALID;
        }
        *profile = output;
        *profile_len = (uint32_t)dst.meta.wi;
        return OT_IMAGE_SHIM_OK;
    }
    return OT_IMAGE_SHIM_INTERNAL;
}

static void ot_image_icc_transform_deinit(ot_image_icc_transform *value) {
    if (value->transform) cmsDeleteTransform(value->transform);
    if (value->output) cmsCloseProfile(value->output);
    if (value->input) cmsCloseProfile(value->input);
    if (value->context) cmsDeleteContext(value->context);
    free(value->profile_bytes);
    memset(value, 0, sizeof(*value));
}

static int ot_image_icc_transform_init(ot_image_icc_transform *value,
                                       const uint8_t *profile, uint32_t profile_len,
                                       uint32_t color_type) {
    memset(value, 0, sizeof(*value));
    value->error_state.error_code = 0;
    value->error_state.out_of_memory = 0;
    int result = ot_image_icc_check_structure(profile, profile_len, color_type);
    if (result != OT_IMAGE_SHIM_OK) return result;
    value->grayscale = color_type == 0 || color_type == 4;
    value->context = cmsCreateContext(NULL, &value->error_state);
    if (!value->context) return OT_IMAGE_SHIM_OUT_OF_MEMORY;
    cmsSetLogErrorHandlerTHR(value->context, ot_image_icc_error_handler);
    if (ot_image_icc_test_fail_profile_copy_allocation) {
        ot_image_icc_test_fail_profile_copy_allocation = 0;
        value->error_state.error_code = cmsERROR_READ;
        value->error_state.out_of_memory = 1;
    } else {
        value->input = cmsOpenProfileFromMemTHR(value->context, profile, profile_len);
    }
    if (!value->input && value->error_state.out_of_memory) return OT_IMAGE_SHIM_OUT_OF_MEMORY;
    if (!value->input) return value->error_state.error_code
        ? ot_image_icc_error_result(value->error_state.error_code)
        : OT_IMAGE_SHIM_OUT_OF_MEMORY;

    cmsColorSpaceSignature expected_space = value->grayscale ? cmsSigGrayData : cmsSigRgbData;
    cmsColorSpaceSignature pcs = cmsGetPCS(value->input);
    if (cmsGetDeviceClass(value->input) != cmsSigDisplayClass ||
        cmsGetColorSpace(value->input) != expected_space ||
        (pcs != cmsSigXYZData && pcs != cmsSigLabData)) {
        return OT_IMAGE_SHIM_UNSUPPORTED_COLOR;
    }
    cmsUInt32Number intent = cmsGetHeaderRenderingIntent(value->input);
    if (intent > INTENT_ABSOLUTE_COLORIMETRIC ||
        !cmsIsIntentSupported(value->input, intent, LCMS_USED_AS_INPUT)) {
        return OT_IMAGE_SHIM_UNSUPPORTED_FEATURE;
    }

    value->output = cmsCreate_sRGBProfileTHR(value->context);
    if (!value->output) return OT_IMAGE_SHIM_OUT_OF_MEMORY;
    value->transform = cmsCreateTransformTHR(
        value->context, value->input, value->grayscale ? TYPE_GRAYA_8 : TYPE_RGBA_8,
        value->output, TYPE_RGBA_8, intent, cmsFLAGS_COPY_ALPHA);
    if (!value->transform) return value->error_state.error_code
        ? ot_image_icc_error_result(value->error_state.error_code)
        : OT_IMAGE_SHIM_OUT_OF_MEMORY;
    return OT_IMAGE_SHIM_OK;
}

static int ot_image_icc_cache_get(const uint8_t *compressed, uint32_t compressed_len,
                                  uint32_t color_type, uint32_t max_profile_len,
                                  ot_image_icc_transform **out) {
    if (!compressed || compressed_len == 0 || !out) return OT_IMAGE_SHIM_INVALID;
    uint8_t *profile = NULL;
    uint32_t profile_len = 0;
    int result = ot_image_icc_decompress(
        compressed, compressed_len, max_profile_len, &profile, &profile_len);
    if (result != OT_IMAGE_SHIM_OK) return result;

    if (!ot_image_icc_test_fail_profile_copy_allocation) {
        for (size_t index = 0; index < OT_IMAGE_ICC_CACHE_CAPACITY; ++index) {
            ot_image_icc_transform *entry = ot_image_icc_cache[index];
            if (entry && entry->profile_len == profile_len &&
                entry->grayscale == (color_type == 0 || color_type == 4) &&
                entry->max_profile_len == max_profile_len &&
                memcmp(entry->profile_bytes, profile, profile_len) == 0) {
                free(profile);
                entry->last_used = ++ot_image_icc_cache_clock;
                entry->error_state.error_code = 0;
                ++ot_image_icc_cache_hits;
                *out = entry;
                return OT_IMAGE_SHIM_OK;
            }
        }
    }

    ++ot_image_icc_cache_misses;
    ot_image_icc_transform *entry = calloc(1, sizeof(*entry));
    if (!entry) {
        free(profile);
        return OT_IMAGE_SHIM_OUT_OF_MEMORY;
    }
    result = ot_image_icc_transform_init(entry, profile, profile_len, color_type);
    if (result != OT_IMAGE_SHIM_OK) {
        free(profile);
        ot_image_icc_transform_deinit(entry);
        free(entry);
        return result;
    }
    entry->profile_bytes = profile;
    entry->profile_len = profile_len;
    entry->max_profile_len = max_profile_len;
    entry->last_used = ++ot_image_icc_cache_clock;

    size_t slot = 0;
    for (size_t index = 0; index < OT_IMAGE_ICC_CACHE_CAPACITY; ++index) {
        ot_image_icc_transform *candidate = ot_image_icc_cache[index];
        if (!candidate) {
            slot = index;
            break;
        }
        if (candidate->last_used < ot_image_icc_cache[slot]->last_used) slot = index;
    }
    ot_image_icc_transform *evicted = ot_image_icc_cache[slot];
    ot_image_icc_cache[slot] = entry;
    if (evicted) {
        ot_image_icc_transform_deinit(evicted);
        free(evicted);
    }
    *out = entry;
    return OT_IMAGE_SHIM_OK;
}

int ot_image_icc_validate(const uint8_t *compressed, uint32_t compressed_len,
                          uint32_t color_type, uint32_t max_profile_len) {
    ot_image_icc_transform *entry = NULL;
    return ot_image_icc_cache_get(
        compressed, compressed_len, color_type, max_profile_len, &entry);
}

int ot_image_icc_transform_rgba(const uint8_t *compressed, uint32_t compressed_len,
                                uint32_t color_type, uint32_t max_profile_len,
                                uint8_t *pixels, uint32_t width, uint32_t height) {
    if (!pixels || width == 0 || height == 0 || width > UINT32_MAX / 4u) {
        return OT_IMAGE_SHIM_INVALID;
    }
    ot_image_icc_transform *entry = NULL;
    int result = ot_image_icc_cache_get(
        compressed, compressed_len, color_type, max_profile_len, &entry);
    if (result != OT_IMAGE_SHIM_OK) return result;

    if (!entry->grayscale) {
        uint32_t stride = width * 4u;
        entry->error_state.error_code = 0;
        cmsDoTransformLineStride(entry->transform, pixels, pixels, width, height,
                                 stride, stride, 0, 0);
    } else {
#if SIZE_MAX < UINT32_MAX
        if (width > SIZE_MAX / 2u) {
            return OT_IMAGE_SHIM_OUT_OF_MEMORY;
        }
#endif
        uint8_t *gray_alpha = malloc((size_t)width * 2u);
        if (!gray_alpha) return OT_IMAGE_SHIM_OUT_OF_MEMORY;
        for (uint32_t y = 0; y < height; ++y) {
            uint8_t *row = pixels + ((size_t)y * width * 4u);
            for (uint32_t x = 0; x < width; ++x) {
                gray_alpha[x * 2u] = row[x * 4u];
                gray_alpha[x * 2u + 1u] = row[x * 4u + 3u];
            }
            cmsDoTransformLineStride(entry->transform, gray_alpha, row, width, 1,
                                     width * 2u, width * 4u, 0, 0);
        }
        free(gray_alpha);
    }
    return entry->error_state.error_code ? OT_IMAGE_SHIM_INTERNAL : OT_IMAGE_SHIM_OK;
}

void ot_image_icc_cache_clear(void) {
    for (size_t index = 0; index < OT_IMAGE_ICC_CACHE_CAPACITY; ++index) {
        ot_image_icc_transform *entry = ot_image_icc_cache[index];
        if (entry) {
            ot_image_icc_transform_deinit(entry);
            free(entry);
            ot_image_icc_cache[index] = NULL;
        }
    }
    ot_image_icc_cache_clock = 0;
    ot_image_icc_cache_hits = 0;
    ot_image_icc_cache_misses = 0;
}

void ot_image_icc_cache_stats(uint64_t *hits, uint64_t *misses, uint32_t *entries) {
    if (hits) *hits = ot_image_icc_cache_hits;
    if (misses) *misses = ot_image_icc_cache_misses;
    if (entries) {
        uint32_t count = 0;
        for (size_t index = 0; index < OT_IMAGE_ICC_CACHE_CAPACITY; ++index) {
            if (ot_image_icc_cache[index]) ++count;
        }
        *entries = count;
    }
}

static int ot_image_init_gif_decoder(wuffs_gif__decoder *decoder) {
    wuffs_base__status status = wuffs_gif__decoder__initialize(
        decoder, sizeof(*decoder), WUFFS_VERSION, 0);
    if (!wuffs_base__status__is_ok(&status)) return OT_IMAGE_SHIM_INVALID;
    wuffs_gif__decoder__set_quirk_enabled(
        decoder, WUFFS_GIF__QUIRK_IMAGE_BOUNDS_ARE_STRICT, true);
    wuffs_gif__decoder__set_quirk_enabled(
        decoder, WUFFS_GIF__QUIRK_HONOR_BACKGROUND_COLOR, true);
    return OT_IMAGE_SHIM_OK;
}

static wuffs_base__color_u32_argb_premul ot_image_gif_background_color(
        const uint8_t *data, uint32_t data_len,
        wuffs_base__color_u32_argb_premul decoded_background) {
    if ((decoded_background >> 24) == 0 || data_len < 13 || (data[10] & 0x80) == 0) {
        return decoded_background;
    }

    uint32_t palette_entries = 2u << (data[10] & 0x07);
    uint32_t background_index = data[11];
    uint32_t palette_offset = 13u + (background_index * 3u);
    if (background_index >= palette_entries || palette_offset + 3u > data_len) {
        return decoded_background;
    }
    return 0xFF000000u | ((uint32_t)data[palette_offset] << 16) |
           ((uint32_t)data[palette_offset + 1] << 8) | data[palette_offset + 2];
}

static int ot_image_gif_validate_remainder(wuffs_gif__decoder *decoder,
                                           wuffs_base__io_buffer *src) {
    while (1) {
        wuffs_base__status status = wuffs_gif__decoder__decode_frame_config(decoder, NULL, src);
        if (status.repr == wuffs_base__note__end_of_data) {
            return (src->meta.ri > 0 && src->data.ptr[src->meta.ri - 1] == 0x3B)
                       ? OT_IMAGE_SHIM_OK
                       : OT_IMAGE_SHIM_INVALID;
        }
        if (!wuffs_base__status__is_ok(&status)) return OT_IMAGE_SHIM_INVALID;
    }
}

int ot_image_gif_probe(const uint8_t *data, uint32_t data_len, uint32_t *width,
                       uint32_t *height, uint32_t *has_alpha) {
    if (!data || data_len == 0 || !width || !height || !has_alpha) return OT_IMAGE_SHIM_INVALID;

    wuffs_gif__decoder *decoder = malloc(sizeof(*decoder));
    if (!decoder) return OT_IMAGE_SHIM_OUT_OF_MEMORY;
    int result = ot_image_init_gif_decoder(decoder);
    if (result != OT_IMAGE_SHIM_OK) {
        free(decoder);
        return result;
    }

    wuffs_base__io_buffer src = wuffs_base__ptr_u8__reader((uint8_t *)data, data_len, true);
    wuffs_base__image_config config = wuffs_base__null_image_config();
    wuffs_base__status status = wuffs_gif__decoder__decode_image_config(decoder, &config, &src);
    if (!wuffs_base__status__is_ok(&status) || !wuffs_base__pixel_config__is_valid(&config.pixcfg)) {
        free(decoder);
        return OT_IMAGE_SHIM_INVALID;
    }

    *width = wuffs_base__pixel_config__width(&config.pixcfg);
    *height = wuffs_base__pixel_config__height(&config.pixcfg);
    *has_alpha = wuffs_base__image_config__first_frame_is_opaque(&config) ? 0u : 1u;
    result = ot_image_gif_validate_remainder(decoder, &src);
    free(decoder);
    return (*width > 0 && *height > 0 && result == OT_IMAGE_SHIM_OK) ? OT_IMAGE_SHIM_OK : OT_IMAGE_SHIM_INVALID;
}

int ot_image_gif_decode_first_frame(const uint8_t *data, uint32_t data_len, uint8_t *output,
                                    uint64_t output_len, uint32_t expected_width,
                                    uint32_t expected_height) {
    if (!data || data_len == 0 || !output || expected_width == 0 || expected_height == 0) {
        return OT_IMAGE_SHIM_INVALID;
    }
    uint64_t required = (uint64_t)expected_width * (uint64_t)expected_height * 4u;
    if (required > output_len || required > SIZE_MAX) return OT_IMAGE_SHIM_OUTPUT_TOO_SMALL;

    wuffs_gif__decoder *decoder = malloc(sizeof(*decoder));
    if (!decoder) return OT_IMAGE_SHIM_OUT_OF_MEMORY;
    int result = ot_image_init_gif_decoder(decoder);
    if (result != OT_IMAGE_SHIM_OK) {
        free(decoder);
        return result;
    }

    wuffs_base__io_buffer src = wuffs_base__ptr_u8__reader((uint8_t *)data, data_len, true);
    wuffs_base__image_config config = wuffs_base__null_image_config();
    wuffs_base__status status = wuffs_gif__decoder__decode_image_config(decoder, &config, &src);
    if (!wuffs_base__status__is_ok(&status) ||
        wuffs_base__pixel_config__width(&config.pixcfg) != expected_width ||
        wuffs_base__pixel_config__height(&config.pixcfg) != expected_height) {
        free(decoder);
        return OT_IMAGE_SHIM_INVALID;
    }

    wuffs_base__frame_config frame_config = wuffs_base__null_frame_config();
    status = wuffs_gif__decoder__decode_frame_config(decoder, &frame_config, &src);
    if (!wuffs_base__status__is_ok(&status)) {
        free(decoder);
        return OT_IMAGE_SHIM_INVALID;
    }

    wuffs_base__pixel_config output_config = wuffs_base__null_pixel_config();
    wuffs_base__pixel_config__set(&output_config, WUFFS_BASE__PIXEL_FORMAT__RGBA_NONPREMUL,
                                  WUFFS_BASE__PIXEL_SUBSAMPLING__NONE,
                                  expected_width, expected_height);
    wuffs_base__pixel_buffer pixel_buffer;
    status = wuffs_base__pixel_buffer__set_from_slice(
        &pixel_buffer, &output_config, wuffs_base__make_slice_u8(output, (size_t)required));
    if (!wuffs_base__status__is_ok(&status)) {
        free(decoder);
        return OT_IMAGE_SHIM_INVALID;
    }

    wuffs_base__color_u32_argb_premul background_color =
        wuffs_base__frame_config__background_color(&frame_config);
    background_color = ot_image_gif_background_color(data, data_len, background_color);
    if (!wuffs_base__color_u32_argb_premul__is_valid(background_color)) {
        free(decoder);
        return OT_IMAGE_SHIM_INVALID;
    }
    status = wuffs_base__pixel_buffer__set_color_u32_fill_rect(
        &pixel_buffer, wuffs_base__make_rect_ie_u32(0, 0, expected_width, expected_height), background_color);
    if (!wuffs_base__status__is_ok(&status)) {
        free(decoder);
        return OT_IMAGE_SHIM_INVALID;
    }
    wuffs_base__range_ii_u64 workbuf_range = wuffs_gif__decoder__workbuf_len(decoder);
    uint64_t workbuf_len = workbuf_range.max_incl;
    if (workbuf_len > SIZE_MAX) {
        free(decoder);
        return OT_IMAGE_SHIM_OUT_OF_MEMORY;
    }
    uint8_t *workbuf = workbuf_len ? malloc((size_t)workbuf_len) : NULL;
    if (workbuf_len && !workbuf) {
        free(decoder);
        return OT_IMAGE_SHIM_OUT_OF_MEMORY;
    }

    status = wuffs_gif__decoder__decode_frame(
        decoder, &pixel_buffer, &src, WUFFS_BASE__PIXEL_BLEND__SRC_OVER,
        wuffs_base__make_slice_u8(workbuf, (size_t)workbuf_len), NULL);
    free(workbuf);
    if (wuffs_base__status__is_ok(&status)) {
        result = ot_image_gif_validate_remainder(decoder, &src);
    } else {
        result = OT_IMAGE_SHIM_INVALID;
    }
    free(decoder);
    return result;
}

static int ot_image_jpeg_has_complete_structure(const uint8_t *data, uint32_t data_len) {
    if (!data || data_len < 4 || data[0] != 0xFF || data[1] != 0xD8) return 0;

    uint32_t pos = 2;
    int entropy_data = 0;
    int saw_scan = 0;
    while (pos < data_len) {
        uint8_t marker = 0;
        if (entropy_data) {
            while (pos < data_len) {
                if (data[pos++] != 0xFF) continue;
                while (pos < data_len && data[pos] == 0xFF) ++pos;
                if (pos >= data_len) return 0;
                marker = data[pos++];
                if (marker == 0x00 || (marker >= 0xD0 && marker <= 0xD7)) continue;
                break;
            }
            if (marker == 0) return 0;
        } else {
            if (data[pos++] != 0xFF) return 0;
            while (pos < data_len && data[pos] == 0xFF) ++pos;
            if (pos >= data_len) return 0;
            marker = data[pos++];
            if (marker == 0x00 || marker == 0xD8) return 0;
        }

        if (marker == 0xD9) return saw_scan;
        if (marker == 0x01) continue;
        if (marker >= 0xD0 && marker <= 0xD7) {
            entropy_data = 0;
            continue;
        }
        if (pos + 2 > data_len) return 0;
        uint32_t segment_len = ((uint32_t)data[pos] << 8) | data[pos + 1];
        if (segment_len < 2 || segment_len > data_len - pos) return 0;
        pos += segment_len;
        if (marker == 0xDA) saw_scan = 1;
        entropy_data = marker == 0xDA || (entropy_data && marker == 0xDC);
    }
    return 0;
}

int ot_image_jpeg_header_probe(const uint8_t *data, uint32_t data_len, uint32_t *width, uint32_t *height) {
    if (!data || data_len == 0 || data_len > INT32_MAX || !width || !height) return OT_IMAGE_SHIM_INVALID;
    int w = 0;
    int h = 0;
    int channels = 0;
    ot_image_stbi_out_of_memory = 0;
    if (!stbi_info_from_memory(data, (int)data_len, &w, &h, &channels) || w <= 0 || h <= 0) {
        return ot_image_stbi_out_of_memory ? OT_IMAGE_SHIM_OUT_OF_MEMORY : OT_IMAGE_SHIM_INVALID;
    }
    *width = (uint32_t)w;
    *height = (uint32_t)h;
    return OT_IMAGE_SHIM_OK;
}

int ot_image_jpeg_probe(const uint8_t *data, uint32_t data_len, uint32_t *width, uint32_t *height) {
    if (!data || data_len == 0 || data_len > INT32_MAX || !width || !height) return OT_IMAGE_SHIM_INVALID;
    if (!ot_image_jpeg_has_complete_structure(data, data_len)) return OT_IMAGE_SHIM_INVALID;
    int w = 0;
    int h = 0;
    int channels = 0;
    ot_image_stbi_out_of_memory = 0;
    uint8_t *decoded = stbi_load_from_memory(data, (int)data_len, &w, &h, &channels, 4);
    if (!decoded) return ot_image_stbi_out_of_memory ? OT_IMAGE_SHIM_OUT_OF_MEMORY : OT_IMAGE_SHIM_INVALID;
    stbi_image_free(decoded);
    if (w <= 0 || h <= 0) return OT_IMAGE_SHIM_INVALID;
    *width = (uint32_t)w;
    *height = (uint32_t)h;
    return OT_IMAGE_SHIM_OK;
}

int ot_image_jpeg_decode(const uint8_t *data, uint32_t data_len, uint8_t *output,
                         uint64_t output_len, uint32_t expected_width, uint32_t expected_height) {
    if (!data || data_len == 0 || data_len > INT32_MAX || !output ||
        expected_width == 0 || expected_height == 0) return OT_IMAGE_SHIM_INVALID;
    uint64_t required = (uint64_t)expected_width * (uint64_t)expected_height * 4u;
    if (required > output_len || required > SIZE_MAX) return OT_IMAGE_SHIM_OUTPUT_TOO_SMALL;
    if (!ot_image_jpeg_has_complete_structure(data, data_len)) return OT_IMAGE_SHIM_INVALID;

    int width = 0;
    int height = 0;
    int channels = 0;
    ot_image_stbi_out_of_memory = 0;
    uint8_t *decoded = stbi_load_from_memory(data, (int)data_len, &width, &height, &channels, 4);
    if (!decoded) return ot_image_stbi_out_of_memory ? OT_IMAGE_SHIM_OUT_OF_MEMORY : OT_IMAGE_SHIM_INVALID;
    if ((uint32_t)width != expected_width || (uint32_t)height != expected_height) {
        stbi_image_free(decoded);
        return OT_IMAGE_SHIM_INVALID;
    }
    memcpy(output, decoded, (size_t)required);
    stbi_image_free(decoded);
    return OT_IMAGE_SHIM_OK;
}

int ot_image_webp_probe(const uint8_t *data, uint32_t data_len, uint32_t *width,
                        uint32_t *height, uint32_t *has_alpha) {
    if (!data || data_len == 0 || !width || !height || !has_alpha) return OT_IMAGE_SHIM_INVALID;
    WebPBitstreamFeatures features;
    VP8StatusCode status = WebPGetFeatures(data, data_len, &features);
    if (status != VP8_STATUS_OK) return status == VP8_STATUS_OUT_OF_MEMORY ? OT_IMAGE_SHIM_OUT_OF_MEMORY : OT_IMAGE_SHIM_INVALID;
    if (features.has_animation) return OT_IMAGE_SHIM_UNSUPPORTED;
    if (features.width <= 0 || features.height <= 0) return OT_IMAGE_SHIM_INVALID;
    *width = (uint32_t)features.width;
    *height = (uint32_t)features.height;
    *has_alpha = features.has_alpha ? 1u : 0u;
    return OT_IMAGE_SHIM_OK;
}

int ot_image_webp_decode(const uint8_t *data, uint32_t data_len, uint8_t *output,
                         uint64_t output_len, uint32_t expected_width, uint32_t expected_height) {
    if (!data || data_len == 0 || !output || expected_width == 0 || expected_height == 0) {
        return OT_IMAGE_SHIM_INVALID;
    }
    uint64_t required = (uint64_t)expected_width * (uint64_t)expected_height * 4u;
    if (required > output_len || required > SIZE_MAX || expected_width > INT32_MAX) {
        return OT_IMAGE_SHIM_OUTPUT_TOO_SMALL;
    }

    WebPDecoderConfig config;
    if (!WebPInitDecoderConfig(&config)) return OT_IMAGE_SHIM_INVALID;
    VP8StatusCode status = WebPGetFeatures(data, data_len, &config.input);
    if (status != VP8_STATUS_OK) return status == VP8_STATUS_OUT_OF_MEMORY ? OT_IMAGE_SHIM_OUT_OF_MEMORY : OT_IMAGE_SHIM_INVALID;
    if (config.input.has_animation) return OT_IMAGE_SHIM_UNSUPPORTED;
    if ((uint32_t)config.input.width != expected_width || (uint32_t)config.input.height != expected_height) {
        return OT_IMAGE_SHIM_INVALID;
    }

    config.output.colorspace = MODE_RGBA;
    config.output.is_external_memory = 1;
    config.output.u.RGBA.rgba = output;
    config.output.u.RGBA.stride = (int)(expected_width * 4u);
    config.output.u.RGBA.size = (size_t)required;
    config.options.use_threads = 0;
    status = WebPDecode(data, data_len, &config);
    WebPFreeDecBuffer(&config.output);
    if (status == VP8_STATUS_OK) return OT_IMAGE_SHIM_OK;
    if (status == VP8_STATUS_OUT_OF_MEMORY) return OT_IMAGE_SHIM_OUT_OF_MEMORY;
    if (status == VP8_STATUS_UNSUPPORTED_FEATURE) return OT_IMAGE_SHIM_UNSUPPORTED;
    return OT_IMAGE_SHIM_INVALID;
}
