#include "video-shim.h"

#ifdef OTV_NO_FFMPEG

// Targets without a prebuilt FFmpeg (see build.zig) report video as unavailable.
#include <stdio.h>

int otv_open(const char *path, const otv_limits *limits, otv_decoder **out_decoder, otv_info *out_info,
                  char *error_out, uint32_t error_cap) {
    (void)path;
    (void)limits;
    (void)out_info;
    if (out_decoder) *out_decoder = NULL;
    if (error_out && error_cap > 0) snprintf(error_out, error_cap, "video decoding is unavailable on this target");
    return OTV_ERROR;
}
void otv_close(otv_decoder **decoder) {
    if (decoder) *decoder = NULL;
}
int otv_seek(otv_decoder *decoder, int64_t target_us) {
    (void)decoder;
    (void)target_us;
    return OTV_ERROR;
}
int otv_set_output_size(otv_decoder *decoder, uint32_t width, uint32_t height, uint32_t cover) {
    (void)decoder;
    (void)width;
    (void)height;
    (void)cover;
    return OTV_ERROR;
}
int otv_decode_frame(otv_decoder *decoder, int64_t target_us, const uint8_t **out_rgba,
                          uint32_t *out_width, uint32_t *out_height, uint32_t *out_stride,
                          int64_t *out_pts_us, uint64_t *out_serial) {
    (void)decoder;
    (void)target_us;
    (void)out_rgba;
    (void)out_width;
    (void)out_height;
    (void)out_stride;
    (void)out_pts_us;
    (void)out_serial;
    return OTV_ERROR;
}
int otv_read_audio(otv_decoder *decoder, float *out_samples, uint32_t capacity_frames,
                        uint32_t *out_frames) {
    (void)decoder;
    (void)out_samples;
    (void)capacity_frames;
    if (out_frames) *out_frames = 0;
    return OTV_ERROR;
}
const char *otv_last_error(const otv_decoder *decoder) {
    (void)decoder;
    return "video decoding is unavailable on this target";
}
const char *otv_stream_error(const otv_decoder *decoder, uint32_t audio_stream) {
    (void)audio_stream;
    return otv_last_error(decoder);
}
uint64_t otv_decoded_frames(const otv_decoder *decoder) {
    (void)decoder;
    return 0;
}
void otv_cancel(otv_decoder *decoder, uint32_t cancel) {
    (void)decoder;
    (void)cancel;
}

#else

#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libavutil/channel_layout.h>
#include <libavutil/cpu.h>
#include <libavutil/error.h>
#include <libavutil/hwcontext.h>
#include <libavutil/imgutils.h>
#include <libavutil/pixdesc.h>
#include <libavutil/log.h>
#include <libavutil/opt.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    AVFormatContext *format;
    AVCodecContext *codec;
    AVStream *stream;
    int stream_index;
    AVPacket *packet;
    AVFrame *frame;
    int packet_pending;
    int demux_eof;
    int drain_sent;
    // Written only by the thread driving this stream: the decode worker for
    // video, the caller for audio.
    char error[256];
} ot_stream_decoder;

struct otv_decoder {
    ot_stream_decoder video;
    ot_stream_decoder audio;
    AVBufferRef *hw_device;
    AVFrame *hw_transfer_frame;
    int has_audio;
    int64_t duration_us;
    int64_t origin_us;
    int64_t seek_us;
    uint32_t source_width;
    uint32_t source_height;
    uint32_t output_width;
    uint32_t output_height;
    int output_cover;
    struct SwsContext *sws;
    AVFrame *sws_dst;
    struct SwrContext *swr;
    uint8_t *rgba;
    size_t rgba_size;
    uint8_t *scaled_rgba;
    size_t scaled_rgba_size;
    AVFrame *video_lookahead;
    AVFrame *video_selected;
    int64_t frame_pts_us;
    uint64_t frame_serial;
    // The frame in video_selected stays across calls, so a paused output
    // reconfiguration converts it again instead of decoding from a keyframe.
    int64_t selected_pts_us;
    uint64_t converted_serial;
    // Timestamp of the newest frame received from the codec.
    int64_t decode_pts_us;
    float *audio_pending;
    size_t audio_pending_capacity;
    uint32_t audio_pending_frames;
    uint32_t audio_pending_offset;
    int audio_swr_drained;
    // Set once the first audio frame at or after seek_us was placed.
    int audio_started;
    // Silent frames that play before the pending audio.
    uint64_t audio_silence_frames;
    enum AVSampleFormat audio_source_format;
    int audio_source_rate;
    AVChannelLayout audio_source_layout;
    char error[256];
    otv_limits limits;
    // Video frames received from the codec; read across threads for diagnostics.
    uint64_t decoded_frames;
    // Set by the owner to stop an in-flight otv_decode_frame.
    uint32_t cancel;
};

static int fail_to(char *buffer, size_t capacity, int error, const char *operation) {
    char detail[AV_ERROR_MAX_STRING_SIZE] = {0};
    av_strerror(error, detail, sizeof(detail));
    snprintf(buffer, capacity, "%s: %s (%d)", operation, detail, error);
    return OTV_ERROR;
}

static int fail(otv_decoder *decoder, int error, const char *operation) {
    return fail_to(decoder->error, sizeof(decoder->error), error, operation);
}

static int fail_video(otv_decoder *decoder, int error, const char *operation) {
    return fail_to(decoder->video.error, sizeof(decoder->video.error), error, operation);
}

static int fail_audio(otv_decoder *decoder, int error, const char *operation) {
    return fail_to(decoder->audio.error, sizeof(decoder->audio.error), error, operation);
}

// FFmpeg also enforces max_pixels while it allocates a frame, so a frame above the limits may
// never arrive; the codec's current size names it then.
static int exceeds_limits(const otv_decoder *decoder, int width, int height) {
    return width > 0 && height > 0 &&
           ((uint32_t)width > decoder->limits.max_width || (uint32_t)height > decoder->limits.max_height ||
            (uint64_t)width * (uint64_t)height > decoder->limits.max_pixels);
}

static int fail_frame_size(otv_decoder *decoder, int width, int height) {
    snprintf(decoder->video.error, sizeof(decoder->video.error), "video frame %dx%d exceeds the image limits", width, height);
    return OTV_ERROR;
}

static void close_stream(ot_stream_decoder *stream) {
    av_frame_free(&stream->frame);
    av_packet_free(&stream->packet);
    avcodec_free_context(&stream->codec);
    avformat_close_input(&stream->format);
    memset(stream, 0, sizeof(*stream));
    stream->stream_index = -1;
}

// Prefers the hardware pixel format when a device is attached; otherwise the
// first software format keeps the decoder on the normal path.
static enum AVPixelFormat otv_select_pixel_format(AVCodecContext *codec, const enum AVPixelFormat *formats) {
    if (codec->hw_device_ctx) {
        for (const enum AVPixelFormat *format = formats; *format != AV_PIX_FMT_NONE; format++) {
            if (*format == AV_PIX_FMT_VIDEOTOOLBOX) return *format;
        }
    }
    for (const enum AVPixelFormat *format = formats; *format != AV_PIX_FMT_NONE; format++) {
        const AVPixFmtDescriptor *descriptor = av_pix_fmt_desc_get(*format);
        if (descriptor && !(descriptor->flags & AV_PIX_FMT_FLAG_HWACCEL)) return *format;
    }
    return formats[0];
}

// Hardware decoding is opt-in: it reduces CPU use several-fold, but FFmpeg's
// VideoToolbox integration decodes strictly synchronously (decodeFlags=0 plus
// WaitForAsynchronousFrames per frame), so the caller pays ~4-5ms of session
// wall time per 4K frame while software frame-threading delivers finished
// frames in microseconds. The GPU-to-CPU readback itself is cheap (~0.3ms).
// Playback adapts its cadence to wall time, so defaulting to hardware would
// trade presentation rate for idle CPU cores.
static int otv_hwaccel_enabled(void) {
    const char *value = getenv("OPENTUI_EXPERIMENTAL_VIDEO_HWACCEL");
    return value && (strcmp(value, "1") == 0 || strcmp(value, "true") == 0);
}

// Attaches a hardware decode device when one is available. Failure of any
// kind leaves the decoder on the software path; H.264 output is bit-exact
// either way.
static void otv_attach_hw_device(otv_decoder *decoder, ot_stream_decoder *stream) {
    if (!otv_hwaccel_enabled()) return;
    if (av_hwdevice_ctx_create(&decoder->hw_device, AV_HWDEVICE_TYPE_VIDEOTOOLBOX, NULL, NULL, 0) < 0) {
        decoder->hw_device = NULL;
        return;
    }
    stream->codec->hw_device_ctx = av_buffer_ref(decoder->hw_device);
    if (!stream->codec->hw_device_ctx) {
        av_buffer_unref(&decoder->hw_device);
        return;
    }
    stream->codec->get_format = otv_select_pixel_format;
}

static int open_stream(otv_decoder *decoder, const char *path, enum AVMediaType type,
                       enum AVCodecID required_codec, ot_stream_decoder *out) {
    memset(out, 0, sizeof(*out));
    out->stream_index = -1;
    int result = avformat_open_input(&out->format, path, NULL, NULL);
    if (result < 0) return fail(decoder, result, "avformat_open_input");
    result = avformat_find_stream_info(out->format, NULL);
    if (result < 0) return fail(decoder, result, "avformat_find_stream_info");
    const AVCodec *codec = NULL;
    result = av_find_best_stream(out->format, type, -1, -1, &codec, 0);
    if (result == AVERROR_STREAM_NOT_FOUND && type == AVMEDIA_TYPE_AUDIO) {
        close_stream(out);
        return OTV_EOF;
    }
    if (result < 0) return fail(decoder, result, "av_find_best_stream");
    out->stream_index = result;
    out->stream = out->format->streams[out->stream_index];
    if (out->stream->codecpar->codec_id != required_codec) {
        snprintf(decoder->error, sizeof(decoder->error), "unsupported %s codec: %s",
                 type == AVMEDIA_TYPE_VIDEO ? "video" : "audio",
                 avcodec_get_name(out->stream->codecpar->codec_id));
        return OTV_ERROR;
    }
    codec = avcodec_find_decoder(required_codec);
    if (!codec) return fail(decoder, AVERROR_DECODER_NOT_FOUND, "avcodec_find_decoder");
    out->codec = avcodec_alloc_context3(codec);
    if (!out->codec) return fail(decoder, AVERROR(ENOMEM), "avcodec_alloc_context3");
    result = avcodec_parameters_to_context(out->codec, out->stream->codecpar);
    if (result < 0) return fail(decoder, result, "avcodec_parameters_to_context");
    out->codec->pkt_timebase = out->stream->time_base;
    // The decoder skips `delay` samples once after opening, whatever packet comes first; after
    // an initial seek that drops the frame holding the target. Demuxers mark the priming samples
    // on the first packet instead, which also covers seeks back to the start.
    out->codec->delay = 0;
    // Enough threads to pipeline 4K decoding without drowning the process;
    // uncapped auto detection spawns one per logical core.
    int cpu_count = av_cpu_count();
    out->codec->thread_count = type == AVMEDIA_TYPE_VIDEO ? (cpu_count > 8 ? 8 : cpu_count) : 1;
    if (type == AVMEDIA_TYPE_VIDEO) {
        // Frames become native images, so sources beyond the image limits cannot play.
        const int width = out->codec->width, height = out->codec->height;
        if (width <= 0 || height <= 0) {
            snprintf(decoder->error, sizeof(decoder->error), "video size %dx%d is invalid", width, height);
            return OTV_ERROR;
        }
        if (exceeds_limits(decoder, width, height)) {
            snprintf(decoder->error, sizeof(decoder->error), "video size %dx%d exceeds the image limits", width, height);
            return OTV_ERROR;
        }
        out->codec->max_pixels = (int64_t)decoder->limits.max_pixels;
        otv_attach_hw_device(decoder, out);
    }
    result = avcodec_open2(out->codec, codec, NULL);
    if (result < 0) return fail(decoder, result, "avcodec_open2");
    out->packet = av_packet_alloc();
    out->frame = av_frame_alloc();
    if (!out->packet || !out->frame) return fail(decoder, AVERROR(ENOMEM), "allocate packet/frame");
    return OTV_OK;
}

static int64_t stream_pts_us(const otv_decoder *decoder, const ot_stream_decoder *stream,
                             const AVFrame *frame) {
    int64_t timestamp = frame->best_effort_timestamp;
    if (timestamp == AV_NOPTS_VALUE) timestamp = frame->pts;
    if (timestamp == AV_NOPTS_VALUE) return AV_NOPTS_VALUE;
    return av_rescale_q(timestamp, stream->stream->time_base, AV_TIME_BASE_Q) - decoder->origin_us;
}

static int receive_or_read(otv_decoder *decoder, ot_stream_decoder *stream) {
    for (;;) {
        av_frame_unref(stream->frame);
        int result = avcodec_receive_frame(stream->codec, stream->frame);
        if (result == 0) return OTV_OK;
        if (result == AVERROR_EOF) return OTV_EOF;
        if (result != AVERROR(EAGAIN)) return fail_to(stream->error, sizeof(stream->error), result, "avcodec_receive_frame");

        if (stream->demux_eof) {
            if (!stream->drain_sent) {
                result = avcodec_send_packet(stream->codec, NULL);
                if (result == AVERROR(EAGAIN)) continue;
                if (result < 0 && result != AVERROR_EOF) return fail_to(stream->error, sizeof(stream->error), result, "decoder drain");
                stream->drain_sent = 1;
                continue;
            }
            return OTV_EOF;
        }

        if (!stream->packet_pending) {
            do {
                av_packet_unref(stream->packet);
                result = av_read_frame(stream->format, stream->packet);
                if (result == AVERROR_EOF) {
                    stream->demux_eof = 1;
                    break;
                }
                if (result < 0) return fail_to(stream->error, sizeof(stream->error), result, "av_read_frame");
            } while (stream->packet->stream_index != stream->stream_index);
            if (stream->demux_eof) continue;
            stream->packet_pending = 1;
        }

        result = avcodec_send_packet(stream->codec, stream->packet);
        if (result == AVERROR(EAGAIN)) continue;
        av_packet_unref(stream->packet);
        stream->packet_pending = 0;
        if (result < 0) return fail_to(stream->error, sizeof(stream->error), result, "avcodec_send_packet");
    }
}

static int configure_swr(otv_decoder *decoder, const AVFrame *frame) {
    AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
    swr_free(&decoder->swr);
    av_channel_layout_uninit(&decoder->audio_source_layout);
    int result = swr_alloc_set_opts2(&decoder->swr, &stereo, AV_SAMPLE_FMT_FLT, 48000,
                                     &frame->ch_layout, (enum AVSampleFormat)frame->format,
                                     frame->sample_rate, 0, NULL);
    if (result < 0) return fail_audio(decoder, result, "swr_alloc_set_opts2");
    result = swr_init(decoder->swr);
    if (result < 0) return fail_audio(decoder, result, "swr_init");
    decoder->audio_source_format = (enum AVSampleFormat)frame->format;
    decoder->audio_source_rate = frame->sample_rate;
    result = av_channel_layout_copy(&decoder->audio_source_layout, &frame->ch_layout);
    if (result < 0) return fail_audio(decoder, result, "av_channel_layout_copy");
    decoder->audio_swr_drained = 0;
    return OTV_OK;
}

static int ensure_audio_capacity(otv_decoder *decoder, size_t frames) {
    if (frames <= decoder->audio_pending_capacity) return OTV_OK;
    float *next = realloc(decoder->audio_pending, frames * 2 * sizeof(float));
    if (!next) return fail_audio(decoder, AVERROR(ENOMEM), "audio allocation");
    decoder->audio_pending = next;
    decoder->audio_pending_capacity = frames;
    return OTV_OK;
}

// FFmpeg's default log callback writes to stderr from its decode threads, over the screen a
// terminal app draws. Every failing call already records its status in the stream's error.
static void otv_log_silent(void *context, int level, const char *format, va_list args) {
    (void)context;
    (void)level;
    (void)format;
    (void)args;
}

static void copy_open_error(const otv_decoder *decoder, char *error_out, uint32_t error_cap) {
    if (!error_out || error_cap == 0) return;
    snprintf(error_out, error_cap, "%s", decoder ? decoder->error : "video decoder allocation failed");
}

int otv_open(const char *path, const otv_limits *limits, otv_decoder **out_decoder, otv_info *out_info,
                  char *error_out, uint32_t error_cap) {
    if (!path || !limits || !out_decoder || !out_info) return OTV_ERROR;
    *out_decoder = NULL;
    if (error_out && error_cap > 0) error_out[0] = '\0';
    av_log_set_callback(otv_log_silent);
    memset(out_info, 0, sizeof(*out_info));
    otv_decoder *decoder = calloc(1, sizeof(*decoder));
    if (!decoder) {
        copy_open_error(NULL, error_out, error_cap);
        return OTV_ERROR;
    }
    decoder->limits = *limits;
    decoder->video.stream_index = -1;
    decoder->audio.stream_index = -1;
    decoder->frame_pts_us = AV_NOPTS_VALUE;
    decoder->decode_pts_us = AV_NOPTS_VALUE;

    if (open_stream(decoder, path, AVMEDIA_TYPE_VIDEO, AV_CODEC_ID_H264, &decoder->video) != OTV_OK) {
        copy_open_error(decoder, error_out, error_cap);
        otv_close(&decoder);
        return OTV_ERROR;
    }
    int audio_result = open_stream(decoder, path, AVMEDIA_TYPE_AUDIO, AV_CODEC_ID_AAC, &decoder->audio);
    if (audio_result == OTV_ERROR) {
        copy_open_error(decoder, error_out, error_cap);
        otv_close(&decoder);
        return OTV_ERROR;
    }
    decoder->has_audio = audio_result == OTV_OK;
    decoder->origin_us = decoder->video.format->start_time == AV_NOPTS_VALUE ? 0 : decoder->video.format->start_time;
    decoder->duration_us = decoder->video.format->duration == AV_NOPTS_VALUE ? 0 : decoder->video.format->duration;
    decoder->source_width = decoder->video.stream->codecpar->width;
    decoder->source_height = decoder->video.stream->codecpar->height;
    decoder->output_width = decoder->source_width;
    decoder->output_height = decoder->source_height;
    decoder->video_lookahead = av_frame_alloc();
    decoder->video_selected = av_frame_alloc();
    if (!decoder->video_lookahead || !decoder->video_selected) {
        snprintf(decoder->error, sizeof(decoder->error), "video frame allocation failed");
        copy_open_error(decoder, error_out, error_cap);
        otv_close(&decoder);
        return OTV_ERROR;
    }

    AVRational fps = decoder->video.stream->avg_frame_rate;
    out_info->duration_us = decoder->duration_us;
    out_info->width = decoder->source_width;
    out_info->height = decoder->source_height;
    out_info->fps_num = fps.num > 0 ? (uint32_t)fps.num : 0;
    out_info->fps_den = fps.den > 0 ? (uint32_t)fps.den : 1;
    out_info->has_audio = decoder->has_audio;
    out_info->audio_sample_rate = decoder->has_audio ? 48000 : 0;
    out_info->audio_channels = decoder->has_audio ? 2 : 0;
    *out_decoder = decoder;
    return OTV_OK;
}

void otv_close(otv_decoder **decoder_ptr) {
    if (!decoder_ptr || !*decoder_ptr) return;
    otv_decoder *decoder = *decoder_ptr;
    free(decoder->audio_pending);
    av_frame_free(&decoder->hw_transfer_frame);
    av_buffer_unref(&decoder->hw_device);
    av_channel_layout_uninit(&decoder->audio_source_layout);
    av_frame_free(&decoder->video_selected);
    av_frame_free(&decoder->video_lookahead);
    free(decoder->scaled_rgba);
    free(decoder->rgba);
    swr_free(&decoder->swr);
    av_frame_free(&decoder->sws_dst);
    sws_freeContext(decoder->sws);
    close_stream(&decoder->audio);
    close_stream(&decoder->video);
    free(decoder);
    *decoder_ptr = NULL;
}

int otv_set_output_size(otv_decoder *decoder, uint32_t width, uint32_t height, uint32_t cover) {
    if (!decoder || width == 0 || height == 0) return OTV_ERROR;
    decoder->output_width = width;
    decoder->output_height = height;
    decoder->output_cover = cover != 0;
    sws_freeContext(decoder->sws);
    decoder->sws = NULL;
    free(decoder->rgba);
    decoder->rgba = NULL;
    decoder->rgba_size = 0;
    decoder->frame_pts_us = AV_NOPTS_VALUE;
    // The selected frame is presented again at the new size under a new serial.
    decoder->frame_serial++;
    return OTV_OK;
}

static int seek_stream(otv_decoder *decoder, ot_stream_decoder *stream, int64_t target_us) {
    if (!stream->format || !stream->stream || !stream->codec || stream->stream_index < 0) return OTV_OK;
    int64_t absolute_us = target_us + decoder->origin_us;
    int64_t timestamp = av_rescale_q(absolute_us, AV_TIME_BASE_Q, stream->stream->time_base);
    int result = avformat_seek_file(stream->format, stream->stream_index, INT64_MIN, timestamp, timestamp, AVSEEK_FLAG_BACKWARD);
    if (result < 0) result = av_seek_frame(stream->format, stream->stream_index, timestamp, AVSEEK_FLAG_BACKWARD);
    if (result < 0) return fail_to(stream->error, sizeof(stream->error), result, "avformat_seek_file");
    avcodec_flush_buffers(stream->codec);
    av_packet_unref(stream->packet);
    stream->packet_pending = 0;
    av_frame_unref(stream->frame);
    stream->demux_eof = 0;
    stream->drain_sent = 0;
    return OTV_OK;
}

int otv_seek(otv_decoder *decoder, int64_t target_us) {
    if (!decoder) return OTV_ERROR;
    if (target_us < 0) target_us = 0;
    if (decoder->duration_us > 0 && target_us > decoder->duration_us) target_us = decoder->duration_us;
    if (seek_stream(decoder, &decoder->video, target_us) != OTV_OK) {
        snprintf(decoder->error, sizeof(decoder->error), "%s", decoder->video.error);
        return OTV_ERROR;
    }
    // An AAC frame overlaps the previous one, so audio starts a frame early and trims to the target.
    int64_t audio_target_us = target_us;
    if (decoder->has_audio && decoder->audio.codec->frame_size > 0 && decoder->audio.codec->sample_rate > 0)
        audio_target_us -= av_rescale(decoder->audio.codec->frame_size, AV_TIME_BASE, decoder->audio.codec->sample_rate);
    if (audio_target_us < 0) audio_target_us = 0;
    if (seek_stream(decoder, &decoder->audio, audio_target_us) != OTV_OK) {
        snprintf(decoder->error, sizeof(decoder->error), "%s", decoder->audio.error);
        return OTV_ERROR;
    }
    decoder->seek_us = target_us;
    decoder->frame_pts_us = AV_NOPTS_VALUE;
    decoder->decode_pts_us = AV_NOPTS_VALUE;
    decoder->audio_pending_frames = 0;
    decoder->audio_pending_offset = 0;
    decoder->audio_swr_drained = 0;
    decoder->audio_started = 0;
    decoder->audio_silence_frames = 0;
    av_frame_unref(decoder->video_lookahead);
    av_frame_unref(decoder->video_selected);
    swr_free(&decoder->swr);
    return OTV_OK;
}

static int convert_video_frame(otv_decoder *decoder, const AVFrame *frame, int64_t pts) {
    if (frame->format == AV_PIX_FMT_VIDEOTOOLBOX) {
        if (!decoder->hw_transfer_frame) {
            decoder->hw_transfer_frame = av_frame_alloc();
            if (!decoder->hw_transfer_frame) return fail_video(decoder, AVERROR(ENOMEM), "hw transfer allocation");
        }
        av_frame_unref(decoder->hw_transfer_frame);
        int transfer = av_hwframe_transfer_data(decoder->hw_transfer_frame, frame, 0);
        if (transfer < 0) return fail_video(decoder, transfer, "av_hwframe_transfer_data");
        // The data transfer does not carry color metadata; scaling reads the
        // colorspace from the frame, so hardware and software paths must be
        // tagged identically to stay bit-exact.
        transfer = av_frame_copy_props(decoder->hw_transfer_frame, frame);
        if (transfer < 0) return fail_video(decoder, transfer, "av_frame_copy_props");
        frame = decoder->hw_transfer_frame;
    }
    uint32_t scaled_width = decoder->output_width;
    uint32_t scaled_height = decoder->output_height;
    if (decoder->output_cover) {
        const double source_aspect = (double)frame->width / frame->height;
        const double target_aspect = (double)decoder->output_width / decoder->output_height;
        if (source_aspect > target_aspect)
            scaled_width = (uint32_t)(source_aspect * decoder->output_height + 0.999999);
        else
            scaled_height = (uint32_t)(decoder->output_width / source_aspect + 0.999999);
    }
    // Dynamic-mode swscale with automatic slice threading; it reconfigures
    // itself when source dimensions or pixel formats change between frames.
    if (!decoder->sws) {
        decoder->sws = sws_alloc_context();
        if (!decoder->sws) return fail_video(decoder, AVERROR(ENOMEM), "sws_alloc_context");
        // Terminal-sized outputs saturate quickly; more slices only add
        // wakeup churn.
        int sws_cpu = av_cpu_count();
        decoder->sws->threads = sws_cpu > 4 ? 4 : sws_cpu;
        decoder->sws->flags = SWS_BILINEAR;
    }
    if (!decoder->sws_dst) {
        decoder->sws_dst = av_frame_alloc();
        if (!decoder->sws_dst) return fail_video(decoder, AVERROR(ENOMEM), "sws frame allocation");
    }
    const size_t required = (size_t)decoder->output_width * decoder->output_height * 4;
    if (required != decoder->rgba_size) {
        uint8_t *next = realloc(decoder->rgba, required);
        if (!next) return fail_video(decoder, AVERROR(ENOMEM), "RGBA allocation");
        decoder->rgba = next;
        decoder->rgba_size = required;
    }
    const size_t scaled_size = (size_t)scaled_width * scaled_height * 4;
    uint8_t *scale_target = decoder->rgba;
    if (decoder->output_cover && (scaled_width != decoder->output_width || scaled_height != decoder->output_height)) {
        if (scaled_size != decoder->scaled_rgba_size) {
            uint8_t *next = realloc(decoder->scaled_rgba, scaled_size);
            if (!next) return fail_video(decoder, AVERROR(ENOMEM), "cover allocation");
            decoder->scaled_rgba = next;
            decoder->scaled_rgba_size = scaled_size;
        }
        scale_target = decoder->scaled_rgba;
    }
    AVFrame *scale_frame = decoder->sws_dst;
    scale_frame->format = AV_PIX_FMT_RGBA;
    scale_frame->width = (int)scaled_width;
    scale_frame->height = (int)scaled_height;
    scale_frame->data[0] = scale_target;
    scale_frame->linesize[0] = (int)(scaled_width * 4);
    int scaled = sws_scale_frame(decoder->sws, scale_frame, frame);
    scale_frame->data[0] = NULL;
    if (scaled < 0) return fail_video(decoder, scaled, "sws_scale_frame");
    if (scale_target != decoder->rgba) {
        const uint32_t crop_x = (scaled_width - decoder->output_width) / 2;
        const uint32_t crop_y = (scaled_height - decoder->output_height) / 2;
        const size_t output_row = (size_t)decoder->output_width * 4;
        for (uint32_t y = 0; y < decoder->output_height; y++)
            memcpy(decoder->rgba + (size_t)y * output_row,
                   decoder->scaled_rgba + ((size_t)(crop_y + y) * scaled_width + crop_x) * 4,
                   output_row);
    }
    decoder->frame_pts_us = pts;
    return OTV_OK;
}

// Jumps to the last keyframe at or before target_us when it lies ahead of the
// decode position, so a long gap costs one group of pictures instead of every
// frame in between.
static int skip_to_keyframe(otv_decoder *decoder, int64_t target_us) {
    if (decoder->decode_pts_us == AV_NOPTS_VALUE || target_us <= decoder->decode_pts_us) return OTV_OK;
    AVStream *stream = decoder->video.stream;
    const AVIndexEntry *first = avformat_index_get_entry(stream, 0);
    if (!first || stream->start_time == AV_NOPTS_VALUE) return OTV_OK;
    // MP4 index entries hold decode times, which B-frames shift before the presentation times seeks take.
    int64_t shift = first->timestamp - stream->start_time;
    if (target_us > INT64_MAX - decoder->origin_us) target_us = INT64_MAX - decoder->origin_us;
    int64_t timestamp = av_rescale_q(target_us + decoder->origin_us, AV_TIME_BASE_Q, stream->time_base);
    int index = av_index_search_timestamp(stream, timestamp + shift, AVSEEK_FLAG_BACKWARD);
    if (index < 0) return OTV_OK;
    const AVIndexEntry *entry = avformat_index_get_entry(stream, index);
    if (!entry || !(entry->flags & AVINDEX_KEYFRAME)) return OTV_OK;
    int64_t keyframe_us = av_rescale_q(entry->timestamp - shift, stream->time_base, AV_TIME_BASE_Q) - decoder->origin_us;
    if (keyframe_us <= decoder->decode_pts_us) return OTV_OK;
    if (seek_stream(decoder, &decoder->video, keyframe_us) != OTV_OK) return OTV_ERROR;
    av_frame_unref(decoder->video_lookahead);
    decoder->decode_pts_us = AV_NOPTS_VALUE;
    return OTV_OK;
}

void otv_cancel(otv_decoder *decoder, uint32_t cancel) {
    if (decoder) __atomic_store_n(&decoder->cancel, cancel, __ATOMIC_RELEASE);
}

int otv_decode_frame(otv_decoder *decoder, int64_t target_us, const uint8_t **out_rgba,
                          uint32_t *out_width, uint32_t *out_height, uint32_t *out_stride,
                          int64_t *out_pts_us, uint64_t *out_serial) {
    if (!decoder || !out_rgba || !out_width || !out_height || !out_stride || !out_pts_us || !out_serial)
        return OTV_ERROR;
    int reached_eof = 0;
    if (skip_to_keyframe(decoder, target_us) != OTV_OK) return OTV_ERROR;
    for (;;) {
        if (__atomic_load_n(&decoder->cancel, __ATOMIC_ACQUIRE)) return OTV_CANCELLED;
        AVFrame *candidate = decoder->video_lookahead;
        if (!candidate->buf[0]) {
            int result = receive_or_read(decoder, &decoder->video);
            if (result == OTV_EOF) {
                reached_eof = 1;
                break;
            }
            if (result != OTV_OK) {
                const AVCodecContext *codec = decoder->video.codec;
                if (result == OTV_ERROR && exceeds_limits(decoder, codec->width, codec->height))
                    return fail_frame_size(decoder, codec->width, codec->height);
                return result;
            }
            __atomic_add_fetch(&decoder->decoded_frames, 1, __ATOMIC_RELAXED);
            candidate = decoder->video.frame;
            if (exceeds_limits(decoder, candidate->width, candidate->height))
                return fail_frame_size(decoder, candidate->width, candidate->height);
            int64_t received_pts = stream_pts_us(decoder, &decoder->video, candidate);
            decoder->decode_pts_us = received_pts != AV_NOPTS_VALUE ? received_pts
                                     : decoder->decode_pts_us == AV_NOPTS_VALUE ? 0
                                                                                : decoder->decode_pts_us;
        }
        int64_t pts = stream_pts_us(decoder, &decoder->video, candidate);
        if (pts == AV_NOPTS_VALUE) pts = decoder->decode_pts_us;
        if (decoder->video_selected->buf[0] && pts > target_us) {
            if (candidate != decoder->video_lookahead) {
                av_frame_unref(decoder->video_lookahead);
                if (av_frame_ref(decoder->video_lookahead, candidate) < 0)
                    return fail_video(decoder, AVERROR(ENOMEM), "av_frame_ref");
            }
            break;
        }
        av_frame_unref(decoder->video_selected);
        if (av_frame_ref(decoder->video_selected, candidate) < 0)
            return fail_video(decoder, AVERROR(ENOMEM), "av_frame_ref selected");
        decoder->selected_pts_us = pts;
        decoder->frame_serial++;
        if (candidate == decoder->video_lookahead) av_frame_unref(decoder->video_lookahead);
        if (pts >= target_us) break;
    }
    if (reached_eof && decoder->duration_us > 0 && target_us >= decoder->duration_us) return OTV_EOF;
    if (!decoder->video_selected->buf[0]) return OTV_EOF;
    if (!decoder->rgba || decoder->converted_serial != decoder->frame_serial) {
        if (convert_video_frame(decoder, decoder->video_selected, decoder->selected_pts_us) != OTV_OK) return OTV_ERROR;
        decoder->converted_serial = decoder->frame_serial;
    }
    *out_rgba = decoder->rgba;
    *out_width = decoder->output_width;
    *out_height = decoder->output_height;
    *out_stride = decoder->output_width * 4;
    *out_pts_us = decoder->frame_pts_us;
    *out_serial = decoder->frame_serial;
    return OTV_OK;
}

int otv_read_audio(otv_decoder *decoder, float *out_samples, uint32_t capacity_frames,
                        uint32_t *out_frames) {
    if (!decoder || !out_frames || (capacity_frames > 0 && !out_samples)) return OTV_ERROR;
    *out_frames = 0;
    if (!decoder->has_audio || capacity_frames == 0) return OTV_OK;
    while (*out_frames < capacity_frames) {
        if (decoder->audio_silence_frames > 0) {
            uint32_t count = capacity_frames - *out_frames;
            if (decoder->audio_silence_frames < count) count = (uint32_t)decoder->audio_silence_frames;
            memset(out_samples + (size_t)*out_frames * 2, 0, (size_t)count * 2 * sizeof(float));
            decoder->audio_silence_frames -= count;
            *out_frames += count;
            continue;
        }
        if (decoder->audio_pending_offset < decoder->audio_pending_frames) {
            uint32_t available = decoder->audio_pending_frames - decoder->audio_pending_offset;
            uint32_t count = available < capacity_frames - *out_frames ? available : capacity_frames - *out_frames;
            memcpy(out_samples + (size_t)*out_frames * 2,
                   decoder->audio_pending + (size_t)decoder->audio_pending_offset * 2,
                   (size_t)count * 2 * sizeof(float));
            decoder->audio_pending_offset += count;
            *out_frames += count;
            continue;
        }
        decoder->audio_pending_frames = 0;
        decoder->audio_pending_offset = 0;
        int result = receive_or_read(decoder, &decoder->audio);
        if (result == OTV_EOF) {
            if (decoder->swr && !decoder->audio_swr_drained) {
                int capacity = swr_get_out_samples(decoder->swr, 0);
                if (capacity < 0) return fail_audio(decoder, capacity, "swr_get_out_samples drain");
                if (ensure_audio_capacity(decoder, (size_t)capacity) != OTV_OK) return OTV_ERROR;
                uint8_t *output[1] = {(uint8_t *)decoder->audio_pending};
                int produced = swr_convert(decoder->swr, output, capacity, NULL, 0);
                if (produced < 0) return fail_audio(decoder, produced, "swr_convert drain");
                decoder->audio_swr_drained = 1;
                decoder->audio_pending_frames = (uint32_t)produced;
                if (produced > 0) continue;
            }
            break;
        }
        if (result != OTV_OK) return result;
        int64_t pts = stream_pts_us(decoder, &decoder->audio, decoder->audio.frame);
        int64_t end_us = pts == AV_NOPTS_VALUE ? decoder->seek_us : pts + av_rescale_q(decoder->audio.frame->nb_samples,
                                                                                       (AVRational){1, decoder->audio.frame->sample_rate},
                                                                                       AV_TIME_BASE_Q);
        if (end_us <= decoder->seek_us) continue;
        if (!decoder->swr || decoder->audio_source_format != (enum AVSampleFormat)decoder->audio.frame->format ||
            decoder->audio_source_rate != decoder->audio.frame->sample_rate ||
            av_channel_layout_compare(&decoder->audio_source_layout, &decoder->audio.frame->ch_layout) != 0) {
            if (configure_swr(decoder, decoder->audio.frame) != OTV_OK) return OTV_ERROR;
        }
        // The clock counts played samples from seek_us, so a track that starts later plays
        // silence until its first sample.
        if (!decoder->audio_started && pts != AV_NOPTS_VALUE && pts > decoder->seek_us)
            decoder->audio_silence_frames = (uint64_t)av_rescale_rnd(pts - decoder->seek_us, 48000, AV_TIME_BASE, AV_ROUND_NEAR_INF);
        decoder->audio_started = 1;
        int capacity = swr_get_out_samples(decoder->swr, decoder->audio.frame->nb_samples);
        if (capacity < 0) return fail_audio(decoder, capacity, "swr_get_out_samples");
        if (ensure_audio_capacity(decoder, (size_t)capacity) != OTV_OK) return OTV_ERROR;
        uint8_t *output[1] = {(uint8_t *)decoder->audio_pending};
        int produced = swr_convert(decoder->swr, output, capacity,
                                   (const uint8_t *const *)decoder->audio.frame->extended_data,
                                   decoder->audio.frame->nb_samples);
        if (produced < 0) return fail_audio(decoder, produced, "swr_convert");
        if (pts != AV_NOPTS_VALUE && pts < decoder->seek_us && produced > 0) {
            // Microsecond timestamps are rounded, so the nearest sample is the exact one.
            int64_t trim = av_rescale_rnd(decoder->seek_us - pts, 48000, AV_TIME_BASE, AV_ROUND_NEAR_INF);
            if (trim > produced) trim = produced;
            if (trim > 0) {
                memmove(decoder->audio_pending, decoder->audio_pending + trim * 2,
                        (size_t)(produced - trim) * 2 * sizeof(float));
                produced -= (int)trim;
            }
        }
        decoder->audio_pending_frames = (uint32_t)produced;
    }
    return OTV_OK;
}

const char *otv_last_error(const otv_decoder *decoder) {
    return decoder ? decoder->error : "invalid video decoder";
}

const char *otv_stream_error(const otv_decoder *decoder, uint32_t audio_stream) {
    if (!decoder) return "invalid video decoder";
    return audio_stream ? decoder->audio.error : decoder->video.error;
}

uint64_t otv_decoded_frames(const otv_decoder *decoder) {
    return decoder ? __atomic_load_n(&decoder->decoded_frames, __ATOMIC_RELAXED) : 0;
}

#endif
