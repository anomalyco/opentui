#ifndef OPENTUI_VIDEO_SHIM_H
#define OPENTUI_VIDEO_SHIM_H

#include <stddef.h>
#include <stdint.h>

typedef struct otv_decoder otv_decoder;

typedef struct {
    int64_t duration_us;
    uint32_t width;
    uint32_t height;
    uint32_t fps_num;
    uint32_t fps_den;
    uint32_t has_audio;
    uint32_t audio_sample_rate;
    uint32_t audio_channels;
} otv_info;

// Frames above these limits fail to decode, as sources above them fail to open.
typedef struct {
    uint64_t max_pixels;
    uint32_t max_width;
    uint32_t max_height;
} otv_limits;

enum {
    OTV_OK = 0,
    OTV_EOF = 1,
    OTV_CANCELLED = 2,
    OTV_ERROR = -1,
};

int otv_open(const char *path, const otv_limits *limits, otv_decoder **out_decoder, otv_info *out_info,
                  char *error_out, uint32_t error_cap);
void otv_close(otv_decoder **decoder);
int otv_seek(otv_decoder *decoder, int64_t target_us);
int otv_set_output_size(otv_decoder *decoder, uint32_t width, uint32_t height, uint32_t cover);
int otv_decode_frame(otv_decoder *decoder, int64_t target_us, const uint8_t **out_rgba,
                          uint32_t *out_width, uint32_t *out_height, uint32_t *out_stride,
                          int64_t *out_pts_us, uint64_t *out_serial);
int otv_read_audio(otv_decoder *decoder, float *out_samples, uint32_t capacity_frames,
                        uint32_t *out_frames);
const char *otv_last_error(const otv_decoder *decoder);
const char *otv_stream_error(const otv_decoder *decoder, uint32_t audio_stream);
uint64_t otv_decoded_frames(const otv_decoder *decoder);
// A nonzero value makes otv_decode_frame return OTV_CANCELLED until cleared.
void otv_cancel(otv_decoder *decoder, uint32_t cancel);

#endif
