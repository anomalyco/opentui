#if defined(__x86_64__) || defined(_M_X64)
#define WEBP_USE_AVX2
#pragma clang attribute push(__attribute__((target("avx2"))), apply_to = function)

#include "vendor/libwebp/src/dsp/lossless_avx2.c"

#pragma clang attribute pop
#endif
