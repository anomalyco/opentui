#import <AppKit/AppKit.h>
#import <ImageIO/ImageIO.h>

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum {
    OT_CLIPBOARD_MACOS_STATUS_OK = 0,
    OT_CLIPBOARD_MACOS_STATUS_EMPTY = 1,
    OT_CLIPBOARD_MACOS_STATUS_LIMIT_EXCEEDED = 2,
    OT_CLIPBOARD_MACOS_STATUS_INVALID_ARGUMENT = 3,
    OT_CLIPBOARD_MACOS_STATUS_INVALID_TEXT = 4,
    OT_CLIPBOARD_MACOS_STATUS_FAILED = 5,
    OT_CLIPBOARD_MACOS_STATUS_CANCELLED = 6,
    OT_CLIPBOARD_MACOS_STATUS_TIMED_OUT = 7,
};

enum {
    OT_CLIPBOARD_MACOS_MIME_TEXT_PLAIN = 1,
    OT_CLIPBOARD_MACOS_MIME_IMAGE_PNG = 2,
};

typedef int32_t (*ot_clipboard_macos_stop_callback)(const void *context);

typedef struct {
    CFMutableDataRef data;
    size_t length;
    size_t limit;
    BOOL limit_exceeded;
} ot_clipboard_macos_output;

static int32_t ot_clipboard_macos_validate_pasteboard(NSPasteboard *pasteboard) {
    return pasteboard == nil ? OT_CLIPBOARD_MACOS_STATUS_FAILED : OT_CLIPBOARD_MACOS_STATUS_OK;
}

static size_t ot_clipboard_macos_put_png_bytes(void *context, const void *bytes, size_t count) {
    ot_clipboard_macos_output *output = context;
    if (output->limit_exceeded || count > output->limit - output->length) {
        output->limit_exceeded = YES;
        return 0;
    }
    CFDataAppendBytes(output->data, bytes, (CFIndex)count);
    output->length += count;
    return count;
}

static const CGDataConsumerCallbacks ot_clipboard_macos_output_callbacks = {
    .putBytes = ot_clipboard_macos_put_png_bytes,
    .releaseConsumer = NULL,
};

static int32_t ot_clipboard_macos_check_stop(ot_clipboard_macos_stop_callback stop_callback,
                                             const void *stop_context) {
    return stop_callback == NULL ? OT_CLIPBOARD_MACOS_STATUS_OK : stop_callback(stop_context);
}

static int32_t ot_clipboard_macos_read_png(NSPasteboard *pasteboard, uint32_t max_bytes,
                                           uint32_t max_image_pixels,
                                           uint32_t max_conversion_bytes,
                                           ot_clipboard_macos_stop_callback stop_callback,
                                           const void *stop_context, NSData **out_data) {
    BOOL png_failed = NO;
    if ([pasteboard availableTypeFromArray:@[ NSPasteboardTypePNG ]] != nil) {
        NSData *data = [pasteboard dataForType:NSPasteboardTypePNG];
        int32_t status = ot_clipboard_macos_check_stop(stop_callback, stop_context);
        if (status != OT_CLIPBOARD_MACOS_STATUS_OK) {
            return status;
        }
        if (data != nil && [data length] > 0) {
            *out_data = data;
            return OT_CLIPBOARD_MACOS_STATUS_OK;
        }
        png_failed = data == nil;
    }

    if ([pasteboard availableTypeFromArray:@[ NSPasteboardTypeTIFF ]] == nil) {
        return png_failed ? OT_CLIPBOARD_MACOS_STATUS_FAILED : OT_CLIPBOARD_MACOS_STATUS_EMPTY;
    }
    NSData *tiff = [pasteboard dataForType:NSPasteboardTypeTIFF];
    if (tiff == nil) {
        return OT_CLIPBOARD_MACOS_STATUS_FAILED;
    }
    int32_t status = ot_clipboard_macos_check_stop(stop_callback, stop_context);
    if (status != OT_CLIPBOARD_MACOS_STATUS_OK) {
        return status;
    }
    if ([tiff length] == 0) {
        return png_failed ? OT_CLIPBOARD_MACOS_STATUS_FAILED : OT_CLIPBOARD_MACOS_STATUS_EMPTY;
    }
    if ([tiff length] > max_conversion_bytes) {
        return OT_CLIPBOARD_MACOS_STATUS_LIMIT_EXCEEDED;
    }

    NSDictionary *metadata_options = @{
        (__bridge NSString *)kCGImageSourceShouldCache : @NO,
    };
    id image_source_owner = CFBridgingRelease(CGImageSourceCreateWithData(
        (__bridge CFDataRef)tiff, (__bridge CFDictionaryRef)metadata_options));
    if (image_source_owner == nil) {
        return OT_CLIPBOARD_MACOS_STATUS_FAILED;
    }
    CGImageSourceRef image_source = (__bridge CGImageSourceRef)image_source_owner;
    NSDictionary *properties = CFBridgingRelease(CGImageSourceCopyPropertiesAtIndex(
        image_source, 0, (__bridge CFDictionaryRef)metadata_options));
    status = ot_clipboard_macos_check_stop(stop_callback, stop_context);
    if (status != OT_CLIPBOARD_MACOS_STATUS_OK) {
        return status;
    }
    NSNumber *pixels_wide = properties[(__bridge NSString *)kCGImagePropertyPixelWidth];
    NSNumber *pixels_high = properties[(__bridge NSString *)kCGImagePropertyPixelHeight];
    NSNumber *depth = properties[(__bridge NSString *)kCGImagePropertyDepth];
    if (pixels_wide == nil || pixels_high == nil || depth == nil) {
        return OT_CLIPBOARD_MACOS_STATUS_FAILED;
    }

    uint64_t width = [pixels_wide unsignedLongLongValue];
    uint64_t height = [pixels_high unsignedLongLongValue];
    if (width == 0 || height == 0) {
        return OT_CLIPBOARD_MACOS_STATUS_FAILED;
    }
    if (width > max_image_pixels || height > max_image_pixels / width) {
        return OT_CLIPBOARD_MACOS_STATUS_LIMIT_EXCEEDED;
    }
    uint64_t pixel_count = width * height;
    uint64_t depth_bits = [depth unsignedLongLongValue];
    if (depth_bits == 0 || depth_bits > 64) {
        return OT_CLIPBOARD_MACOS_STATUS_FAILED;
    }
    uint64_t component_count = 4;
    NSString *color_model = properties[(__bridge NSString *)kCGImagePropertyColorModel];
    if ([color_model isEqualToString:(__bridge NSString *)kCGImagePropertyColorModelGray]) {
        component_count = 1;
    } else if ([color_model isEqualToString:(__bridge NSString *)kCGImagePropertyColorModelRGB] ||
               [color_model isEqualToString:(__bridge NSString *)kCGImagePropertyColorModelLab]) {
        component_count = 3;
    }
    NSNumber *has_alpha = properties[(__bridge NSString *)kCGImagePropertyHasAlpha];
    if ([has_alpha boolValue]) {
        component_count += 1;
    }
    uint64_t bytes_per_pixel = component_count * ((depth_bits + 7) / 8);
    if (pixel_count > max_conversion_bytes / bytes_per_pixel) {
        return OT_CLIPBOARD_MACOS_STATUS_LIMIT_EXCEEDED;
    }

    NSDictionary *decode_options = @{
        (__bridge NSString *)kCGImageSourceShouldAllowFloat : @NO,
        (__bridge NSString *)kCGImageSourceShouldCacheImmediately : @YES,
    };
    id image_owner = CFBridgingRelease(CGImageSourceCreateImageAtIndex(
        image_source, 0, (__bridge CFDictionaryRef)decode_options));
    if (image_owner == nil) {
        return OT_CLIPBOARD_MACOS_STATUS_FAILED;
    }
    status = ot_clipboard_macos_check_stop(stop_callback, stop_context);
    if (status != OT_CLIPBOARD_MACOS_STATUS_OK) {
        return status;
    }
    CGImageRef image = (__bridge CGImageRef)image_owner;
    if (CGImageGetWidth(image) != width || CGImageGetHeight(image) != height) {
        return OT_CLIPBOARD_MACOS_STATUS_FAILED;
    }
    if (CGImageGetBytesPerRow(image) > max_conversion_bytes / height) {
        return OT_CLIPBOARD_MACOS_STATUS_LIMIT_EXCEEDED;
    }

    NSMutableData *png = [NSMutableData data];
    ot_clipboard_macos_output output = {
        .data = (__bridge CFMutableDataRef)png,
        .length = 0,
        .limit = max_bytes,
        .limit_exceeded = NO,
    };
    id consumer_owner = CFBridgingRelease(CGDataConsumerCreate(
        &output, &ot_clipboard_macos_output_callbacks));
    if (consumer_owner == nil) {
        return OT_CLIPBOARD_MACOS_STATUS_FAILED;
    }
    id destination_owner = CFBridgingRelease(CGImageDestinationCreateWithDataConsumer(
        (__bridge CGDataConsumerRef)consumer_owner, CFSTR("public.png"), 1, NULL));
    if (destination_owner == nil) {
        return OT_CLIPBOARD_MACOS_STATUS_FAILED;
    }
    CGImageDestinationRef destination = (__bridge CGImageDestinationRef)destination_owner;
    NSNumber *orientation = properties[(__bridge NSString *)kCGImagePropertyOrientation];
    NSDictionary *destination_properties =
        orientation == nil ? nil : @{ (__bridge NSString *)kCGImagePropertyOrientation : orientation };
    CGImageDestinationAddImage(destination, image, (__bridge CFDictionaryRef)destination_properties);
    BOOL finalized = CGImageDestinationFinalize(destination);
    status = ot_clipboard_macos_check_stop(stop_callback, stop_context);
    if (status != OT_CLIPBOARD_MACOS_STATUS_OK) {
        return status;
    }
    if (output.limit_exceeded) {
        return OT_CLIPBOARD_MACOS_STATUS_LIMIT_EXCEEDED;
    }
    if (!finalized || output.length == 0 || [png length] != output.length) {
        return OT_CLIPBOARD_MACOS_STATUS_FAILED;
    }
    *out_data = png;
    return OT_CLIPBOARD_MACOS_STATUS_OK;
}

int32_t ot_clipboard_macos_read(uint32_t mime, uint32_t max_bytes, uint32_t max_image_pixels,
                                uint32_t max_conversion_bytes,
                                ot_clipboard_macos_stop_callback stop_callback,
                                const void *stop_context, uint8_t **out_bytes, uint32_t *out_length) {
    if (out_bytes == NULL || out_length == NULL) {
        return OT_CLIPBOARD_MACOS_STATUS_INVALID_ARGUMENT;
    }

    *out_bytes = NULL;
    *out_length = 0;

    @autoreleasepool {
        @try {
            int32_t status = ot_clipboard_macos_check_stop(stop_callback, stop_context);
            if (status != OT_CLIPBOARD_MACOS_STATUS_OK) {
                return status;
            }
            NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
            if (ot_clipboard_macos_validate_pasteboard(pasteboard) != OT_CLIPBOARD_MACOS_STATUS_OK) {
                return OT_CLIPBOARD_MACOS_STATUS_FAILED;
            }
            const void *source = NULL;
            NSUInteger length = 0;
            NSString *text = nil;
            NSData *data = nil;

            if (mime == OT_CLIPBOARD_MACOS_MIME_TEXT_PLAIN) {
                if ([pasteboard availableTypeFromArray:@[ NSPasteboardTypeString ]] == nil) {
                    return OT_CLIPBOARD_MACOS_STATUS_EMPTY;
                }
                text = [pasteboard stringForType:NSPasteboardTypeString];
                if (text == nil) {
                    return OT_CLIPBOARD_MACOS_STATUS_FAILED;
                }
                status = ot_clipboard_macos_check_stop(stop_callback, stop_context);
                if (status != OT_CLIPBOARD_MACOS_STATUS_OK) {
                    return status;
                }
                length = [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
                source = [text UTF8String];
            } else if (mime == OT_CLIPBOARD_MACOS_MIME_IMAGE_PNG) {
                status = ot_clipboard_macos_read_png(pasteboard, max_bytes, max_image_pixels,
                                                      max_conversion_bytes, stop_callback,
                                                     stop_context, &data);
                if (status != OT_CLIPBOARD_MACOS_STATUS_OK) {
                    return status;
                }
                length = [data length];
                source = [data bytes];
            } else {
                return OT_CLIPBOARD_MACOS_STATUS_EMPTY;
            }

            if (length > max_bytes || length > UINT32_MAX) {
                return OT_CLIPBOARD_MACOS_STATUS_LIMIT_EXCEEDED;
            }
            if (length > 0 && source == NULL) {
                return OT_CLIPBOARD_MACOS_STATUS_FAILED;
            }

            uint8_t *copy = NULL;
            if (length > 0) {
                copy = malloc(length);
                if (copy == NULL) {
                    return OT_CLIPBOARD_MACOS_STATUS_FAILED;
                }
                memcpy(copy, source, length);
            }

            *out_bytes = copy;
            *out_length = (uint32_t)length;
            return OT_CLIPBOARD_MACOS_STATUS_OK;
        } @catch (__unused NSException *exception) {
            return OT_CLIPBOARD_MACOS_STATUS_FAILED;
        }
    }
}

int32_t ot_clipboard_macos_write_text(const uint8_t *bytes, uint32_t length) {
    if (length > 0 && bytes == NULL) {
        return OT_CLIPBOARD_MACOS_STATUS_INVALID_ARGUMENT;
    }

    @autoreleasepool {
        @try {
            NSString *text = length == 0
                                 ? @""
                                 : [[NSString alloc] initWithBytes:bytes
                                                          length:length
                                                        encoding:NSUTF8StringEncoding];
            if (text == nil) {
                return OT_CLIPBOARD_MACOS_STATUS_INVALID_TEXT;
            }

            NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
            [pasteboard clearContents];
            if (![pasteboard setString:text forType:NSPasteboardTypeString]) {
                return OT_CLIPBOARD_MACOS_STATUS_FAILED;
            }
            return OT_CLIPBOARD_MACOS_STATUS_OK;
        } @catch (__unused NSException *exception) {
            return OT_CLIPBOARD_MACOS_STATUS_FAILED;
        }
    }
}

static int32_t ot_clipboard_macos_clear_pasteboard(NSPasteboard *pasteboard) {
    if (pasteboard == nil) {
        return OT_CLIPBOARD_MACOS_STATUS_FAILED;
    }
    [pasteboard clearContents];
    return OT_CLIPBOARD_MACOS_STATUS_OK;
}

int32_t ot_clipboard_macos_clear(void) {
    @autoreleasepool {
        @try {
            return ot_clipboard_macos_clear_pasteboard([NSPasteboard generalPasteboard]);
        } @catch (__unused NSException *exception) {
            return OT_CLIPBOARD_MACOS_STATUS_FAILED;
        }
    }
}

__attribute__((visibility("hidden"))) int32_t
ot_clipboard_macos_test_bounded_output(uint32_t limit, uint32_t first_count,
                                       uint32_t second_count, uint32_t *out_length) {
    if (first_count > 16 || second_count > 16 || out_length == NULL) {
        return OT_CLIPBOARD_MACOS_STATUS_INVALID_ARGUMENT;
    }
    @autoreleasepool {
        uint8_t bytes[16] = {0};
        NSMutableData *data = [NSMutableData data];
        ot_clipboard_macos_output output = {
            .data = (__bridge CFMutableDataRef)data,
            .length = 0,
            .limit = limit,
            .limit_exceeded = NO,
        };
        (void)ot_clipboard_macos_put_png_bytes(&output, bytes, first_count);
        (void)ot_clipboard_macos_put_png_bytes(&output, bytes, second_count);
        *out_length = (uint32_t)[data length];
        return output.limit_exceeded ? OT_CLIPBOARD_MACOS_STATUS_LIMIT_EXCEEDED
                                     : OT_CLIPBOARD_MACOS_STATUS_OK;
    }
}

void ot_clipboard_macos_free_bytes(uint8_t *bytes) {
    free(bytes);
}
