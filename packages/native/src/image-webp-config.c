#include "src/dsp/cpu.h"

#if defined(__x86_64__) || defined(_M_X64)
#if !defined(WEBP_HAVE_SSE2)
#error "x64 WebP builds must include SSE2 runtime dispatch"
#endif
#if !defined(WEBP_HAVE_SSE41)
#error "x64 WebP builds must include SSE4.1 runtime dispatch"
#endif
#if !defined(WEBP_HAVE_AVX2)
#error "x64 WebP builds must include AVX2 runtime dispatch"
#endif
#endif
