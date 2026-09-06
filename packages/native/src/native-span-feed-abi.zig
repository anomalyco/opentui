const compat = &@import("compatibility-context.zig").compatDefault;
const globalAllocator = compat.gpa.allocator();
const native_span_feed = @import("native-span-feed.zig");

export fn createNativeSpanFeed(options_ptr: ?*const native_span_feed.Options) ?*native_span_feed.Stream {
    return native_span_feed.createNativeSpanFeedWithAllocator(globalAllocator, options_ptr);
}
