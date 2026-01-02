const std = @import("std");

var global_event_callback: ?*const fn (namePtr: [*]const u8, nameLen: usize, dataPtr: [*]const u8, dataLen: usize) callconv(.c) void = null;

pub fn setEventCallback(callback: ?*const fn (namePtr: [*]const u8, nameLen: usize, dataPtr: [*]const u8, dataLen: usize) callconv(.c) void) void {
    global_event_callback = callback;
}

pub fn emit(name: []const u8, data: []const u8) void {
    if (global_event_callback) |callback| {
        callback(name.ptr, name.len, data.ptr, data.len);
    }
}
