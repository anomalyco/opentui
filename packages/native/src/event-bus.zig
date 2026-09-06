const std = @import("std");

pub const EventCallback = *const fn (namePtr: [*]const u8, nameLen: u32, dataPtr: [*]const u8, dataLen: u32) callconv(.c) void;

pub const EventSink = struct {
    callback: ?EventCallback = null,
    handler: ?struct {
        userdata: *anyopaque,
        callback: *const fn (*anyopaque, []const u8, []const u8) void,
    } = null,
    last_edit_buffer_id: u32 = 0,

    pub fn allocateEditBufferId(self: *EventSink) error{EditBufferIdExhausted}!u32 {
        if (self.last_edit_buffer_id == std.math.maxInt(u32)) return error.EditBufferIdExhausted;
        self.last_edit_buffer_id += 1;
        return self.last_edit_buffer_id;
    }
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
        if (event_sink.handler) |handler| {
            handler.callback(handler.userdata, name, data);
            return;
        }
        if (event_sink.callback) |callback| {
            const name_len = std.math.cast(u32, name.len) orelse return;
            const data_len = std.math.cast(u32, data.len) orelse return;
            callback(name.ptr, name_len, data.ptr, data_len);
        }
    }
}
