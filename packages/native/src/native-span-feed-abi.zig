const runtime = @import("runtime.zig");
const native_span_feed = @import("native-span-feed.zig");

// Exported here, not in native-span-feed.zig, so that two units that both import the feed, such
// as `opentui-bench` and its isolated bench unit, can link into one executable.
comptime {
    for (.{
        "streamSetCallback",    "attachNativeSpanFeed", "streamClose",    "destroyNativeSpanFeed",
        "streamReleaseSpan",    "streamWrite",          "streamCommit",   "streamReserve",
        "streamCommitReserved", "streamSetOptions",     "streamGetStats", "streamDrainSpans",
    }) |name| @export(&@field(native_span_feed, name), .{ .name = name });
}

export fn createNativeSpanFeed(options_ptr: ?*const native_span_feed.Options) ?*native_span_feed.Stream {
    return native_span_feed.createNativeSpanFeedWithAllocator(runtime.allocator(), options_ptr);
}
