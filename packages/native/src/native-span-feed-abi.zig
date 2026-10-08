const runtime = @import("runtime.zig");
const native_span_feed = @import("native-span-feed.zig");

export fn createNativeSpanFeed(options_ptr: ?*const native_span_feed.Options) ?*native_span_feed.Stream {
    return native_span_feed.createNativeSpanFeedWithAllocator(runtime.allocator(), options_ptr);
}
