#if defined(__x86_64__) || defined(_M_X64)
#define WEBP_USE_SSE41
#pragma clang attribute push(__attribute__((target("sse4.1"))), apply_to = function)

#include "vendor/libwebp/src/dsp/alpha_processing_sse41.c"
#include "vendor/libwebp/src/dsp/dec_sse41.c"
#include "vendor/libwebp/src/dsp/lossless_sse41.c"
#include "vendor/libwebp/src/dsp/upsampling_sse41.c"
#include "vendor/libwebp/src/dsp/yuv_sse41.c"

#pragma clang attribute pop
#endif
