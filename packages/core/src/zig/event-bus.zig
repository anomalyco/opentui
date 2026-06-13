const std = @import("std");

pub const EventCallback = *const fn (namePtr: [*]const u8, nameLen: u32, dataPtr: [*]const u8, dataLen: u32) callconv(.c) void;

pub const EventSink = struct {
    callback: ?EventCallback,
};

pub fn createEventSink(allocator: std.mem.Allocator, callback: EventCallback) !*EventSink {
    const sink = try allocator.create(EventSink);
    sink.* = .{ .callback = callback };
    return sink;
}

pub fn destroyEventSink(allocator: std.mem.Allocator, sink: *EventSink) void {
    sink.callback = null;
    allocator.destroy(sink);
}

pub fn emit(sink: ?*EventSink, name: []const u8, data: []const u8) void {
    if (sink) |event_sink| {
        if (event_sink.callback) |callback| {
            const name_len = std.math.cast(u32, name.len) orelse return;
            const data_len = std.math.cast(u32, data.len) orelse return;
            callback(name.ptr, name_len, data.ptr, data_len);
        }
    }
}
