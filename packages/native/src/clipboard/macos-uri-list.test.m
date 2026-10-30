#import "macos-shim.m"
#include <assert.h>
#include <stdio.h>

static int32_t stop_read(const void *context) {
    return *(const int32_t *)context;
}

static NSPasteboard *file_pasteboard(NSArray<NSString *> *files) {
    NSPasteboard *pasteboard = [NSPasteboard pasteboardWithUniqueName];
    NSMutableArray<NSPasteboardItem *> *items = [NSMutableArray array];
    for (NSString *file in files) {
        NSPasteboardItem *item = [[NSPasteboardItem alloc] init];
        assert([item setString:file forType:NSPasteboardTypeFileURL]);
        [items addObject:item];
    }
    if ([items count] > 0) assert([pasteboard writeObjects:items]);
    return pasteboard;
}

int main(void) {
    @autoreleasepool {
        NSData *data = nil;
        NSPasteboard *pasteboard = file_pasteboard(@[
            @"file:///tmp/copied%20image.jpg",
            @"file:///tmp/%D1%84%D0%BE%D1%82%D0%BE.png",
        ]);
        NSData *expected = [@"file:///tmp/copied%20image.jpg\r\nfile:///tmp/%D1%84%D0%BE%D1%82%D0%BE.png\r\n"
            dataUsingEncoding:NSUTF8StringEncoding];
        assert(ot_clipboard_macos_read_uri_list(pasteboard, (uint32_t)[expected length], NULL, NULL, &data) ==
            OT_CLIPBOARD_MACOS_STATUS_OK);
        assert([data isEqualToData:expected]);
        data = nil;
        assert(ot_clipboard_macos_read_uri_list(pasteboard, (uint32_t)[expected length] - 1, NULL, NULL, &data) ==
            OT_CLIPBOARD_MACOS_STATUS_LIMIT_EXCEEDED);
        assert(data == nil);
        int32_t cancelled = OT_CLIPBOARD_MACOS_STATUS_CANCELLED;
        assert(ot_clipboard_macos_read_uri_list(pasteboard, 4096, stop_read, &cancelled, &data) == cancelled);
        assert(data == nil);
        int32_t timed_out = OT_CLIPBOARD_MACOS_STATUS_TIMED_OUT;
        assert(ot_clipboard_macos_read_uri_list(pasteboard, 4096, stop_read, &timed_out, &data) == timed_out);
        assert(data == nil);
        [pasteboard releaseGlobally];

        pasteboard = file_pasteboard(@[]);
        assert(ot_clipboard_macos_read_uri_list(pasteboard, 4096, NULL, NULL, &data) ==
            OT_CLIPBOARD_MACOS_STATUS_EMPTY);
        assert([pasteboard setString:@"ordinary text" forType:NSPasteboardTypeString]);
        assert(ot_clipboard_macos_read_uri_list(pasteboard, 4096, NULL, NULL, &data) ==
            OT_CLIPBOARD_MACOS_STATUS_EMPTY);
        [pasteboard releaseGlobally];

        pasteboard = file_pasteboard(@[@"https://example.com/image.jpg", @"not a URL", @"file://other-host/image.jpg"]);
        assert(ot_clipboard_macos_read_uri_list(pasteboard, 4096, NULL, NULL, &data) ==
            OT_CLIPBOARD_MACOS_STATUS_EMPTY);
        [pasteboard releaseGlobally];

        pasteboard = file_pasteboard(@[@"file:///tmp/image.jpg"]);
        assert(ot_clipboard_macos_read_uri_list(pasteboard, 0, NULL, NULL, &data) ==
            OT_CLIPBOARD_MACOS_STATUS_LIMIT_EXCEEDED);
        [pasteboard releaseGlobally];
    }
    puts("macOS clipboard URI-list tests passed (private pasteboards only)");
    return 0;
}
