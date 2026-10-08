const std = @import("std");
const c = @import("context_abi_c");
const abi = @import("context-abi.zig");
const image = @import("image.zig");
const ContextHandle = abi.ContextHandle;

fn failure(owner: *ContextHandle, err: anyerror) c.ot_status {
    const status: c.ot_status = switch (err) {
        error.InvalidArgument => c.OT_INVALID_ARGUMENT,
        error.UnsupportedFormat => c.OT_IMAGE_UNSUPPORTED_FORMAT,
        error.UnsupportedColorSpace => c.OT_IMAGE_UNSUPPORTED_COLOR_SPACE,
        error.MalformedInput => c.OT_IMAGE_MALFORMED_DATA,
        error.DimensionLimit => c.OT_IMAGE_DIMENSION_LIMIT,
        error.MemoryLimit => c.OT_IMAGE_MEMORY_LIMIT,
        error.OutputTooSmall => c.OT_IMAGE_OUTPUT_TOO_SMALL,
        error.UnsupportedFeature => c.OT_IMAGE_UNSUPPORTED_FEATURE,
        error.Busy => c.OT_IMAGE_BUSY,
        else => return abi.sessionError(owner, err),
    };
    owner.last_error = status;
    return status;
}

fn span(comptime Slice: type, pointer: anytype, length: u64) !Slice {
    if (length > std.math.maxInt(usize) or (length != 0 and pointer == null)) return error.InvalidArgument;
    return if (length == 0) &.{} else pointer.?[0..@intCast(length)];
}

fn pixelOptions(stride: u32, format: u32, alpha: u32) !image.PixelImportOptions {
    return .{
        .stride = stride,
        .format = std.enums.fromInt(image.PixelFormat, format) orelse return error.InvalidArgument,
        .alpha = std.enums.fromInt(image.PixelAlpha, alpha) orelse return error.InvalidArgument,
    };
}

pub fn ot_image_inspect(context: ?*ContextHandle, bytes: ?[*]const u8, count: u64, out_ptr: ?*c.ot_image_info) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const out = out_ptr orelse return failure(owner, error.InvalidArgument);
    const data = span([]const u8, bytes, count) catch |err| return failure(owner, err);
    const info = owner.core.inspectImage(data) catch |err| return failure(owner, err);
    out.* = @bitCast(info);
    return c.OT_OK;
}

pub fn ot_image_decode(context: ?*ContextHandle, bytes: ?[*]const u8, count: u64, out_ptr: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const out = out_ptr orelse return failure(owner, error.InvalidArgument);
    const data = span([]const u8, bytes, count) catch |err| return failure(owner, err);
    out.* = abi.handleToC(owner.core.decodeImage(data) catch |err| return failure(owner, err));
    return c.OT_OK;
}

pub fn ot_image_create_pixels(context: ?*ContextHandle, pixels: ?[*]const u8, count: u64, width: u32, height: u32, stride: u32, format: u32, alpha: u32, out_ptr: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const out = out_ptr orelse return failure(owner, error.InvalidArgument);
    const data = span([]const u8, pixels, count) catch |err| return failure(owner, err);
    const options = pixelOptions(stride, format, alpha) catch |err| return failure(owner, err);
    out.* = abi.handleToC(owner.core.createImagePixels(data, width, height, options) catch |err| return failure(owner, err));
    return c.OT_OK;
}

pub fn ot_image_update_pixels(context: ?*ContextHandle, image_ptr: ?*const c.ot_handle, pixels: ?[*]const u8, count: u64, stride: u32, format: u32, alpha: u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = image_ptr orelse return failure(owner, error.InvalidArgument);
    const data = span([]const u8, pixels, count) catch |err| return failure(owner, err);
    const options = pixelOptions(stride, format, alpha) catch |err| return failure(owner, err);
    owner.core.updateImagePixels(abi.handleFromC(id.*), data, options) catch |err| return failure(owner, err);
    return c.OT_OK;
}

pub fn ot_image_clone(context: ?*ContextHandle, source: ?*ContextHandle, image_ptr: ?*const c.ot_handle, out_ptr: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const source_status = abi.sessionContextStatus(source);
    if (source_status != c.OT_OK) return source_status;
    const owner = context.?;
    const id = image_ptr orelse return failure(owner, error.InvalidArgument);
    const out = out_ptr orelse return failure(owner, error.InvalidArgument);
    out.* = abi.handleToC(owner.core.cloneImageFrom(source.?.core, abi.handleFromC(id.*)) catch |err| return failure(owner, err));
    return c.OT_OK;
}

pub fn ot_image_retain(context: ?*ContextHandle, image_ptr: ?*const c.ot_handle, out_ptr: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = image_ptr orelse return failure(owner, error.InvalidArgument);
    const out = out_ptr orelse return failure(owner, error.InvalidArgument);
    out.* = abi.handleToC(owner.core.retainImage(abi.handleFromC(id.*)) catch |err| return failure(owner, err));
    return c.OT_OK;
}

pub fn ot_image_get_info(context: ?*ContextHandle, image_ptr: ?*const c.ot_handle, out_ptr: ?*c.ot_image_info) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = image_ptr orelse return failure(owner, error.InvalidArgument);
    const out = out_ptr orelse return failure(owner, error.InvalidArgument);
    out.* = @bitCast(owner.core.imageInfo(abi.handleFromC(id.*)) catch |err| return failure(owner, err));
    return c.OT_OK;
}

pub fn ot_image_resize(context: ?*ContextHandle, image_ptr: ?*const c.ot_handle, width: u32, height: u32, filter: u32, out_ptr: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = image_ptr orelse return failure(owner, error.InvalidArgument);
    const out = out_ptr orelse return failure(owner, error.InvalidArgument);
    const mode = std.enums.fromInt(image.ResizeFilter, filter) orelse return failure(owner, error.InvalidArgument);
    out.* = abi.handleToC(owner.core.resizeImage(abi.handleFromC(id.*), width, height, mode) catch |err| return failure(owner, err));
    return c.OT_OK;
}

pub fn ot_image_extract(context: ?*ContextHandle, image_ptr: ?*const c.ot_handle, left: u32, top: u32, width: u32, height: u32, out_ptr: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = image_ptr orelse return failure(owner, error.InvalidArgument);
    const out = out_ptr orelse return failure(owner, error.InvalidArgument);
    out.* = abi.handleToC(owner.core.extractImage(abi.handleFromC(id.*), left, top, width, height) catch |err| return failure(owner, err));
    return c.OT_OK;
}

pub fn ot_image_extend(context: ?*ContextHandle, image_ptr: ?*const c.ot_handle, top: u32, right: u32, bottom: u32, left: u32, background: ?*const [4]u8, out_ptr: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = image_ptr orelse return failure(owner, error.InvalidArgument);
    const out = out_ptr orelse return failure(owner, error.InvalidArgument);
    const color = background orelse return failure(owner, error.InvalidArgument);
    out.* = abi.handleToC(owner.core.extendImage(abi.handleFromC(id.*), top, right, bottom, left, color.*) catch |err| return failure(owner, err));
    return c.OT_OK;
}

pub fn ot_image_transform(context: ?*ContextHandle, image_ptr: ?*const c.ot_handle, operation: u32, out_ptr: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = image_ptr orelse return failure(owner, error.InvalidArgument);
    const out = out_ptr orelse return failure(owner, error.InvalidArgument);
    const mode = std.enums.fromInt(image.Transform, operation) orelse return failure(owner, error.InvalidArgument);
    out.* = abi.handleToC(owner.core.transformImage(abi.handleFromC(id.*), mode) catch |err| return failure(owner, err));
    return c.OT_OK;
}

pub fn ot_image_composite(context: ?*ContextHandle, base_ptr: ?*const c.ot_handle, overlay_ptr: ?*const c.ot_handle, left: i32, top: i32, blend: u32, opacity: u8, out_ptr: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const base = base_ptr orelse return failure(owner, error.InvalidArgument);
    const overlay = overlay_ptr orelse return failure(owner, error.InvalidArgument);
    const out = out_ptr orelse return failure(owner, error.InvalidArgument);
    const mode = std.enums.fromInt(image.Blend, blend) orelse return failure(owner, error.InvalidArgument);
    out.* = abi.handleToC(owner.core.compositeImage(abi.handleFromC(base.*), abi.handleFromC(overlay.*), left, top, mode, opacity) catch |err| return failure(owner, err));
    return c.OT_OK;
}

pub fn ot_image_copy_pixels(context: ?*ContextHandle, image_ptr: ?*const c.ot_handle, destination: ?[*]u8, count: u64, stride: u32, format: u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = image_ptr orelse return failure(owner, error.InvalidArgument);
    const data = span([]u8, destination, count) catch |err| return failure(owner, err);
    const mode = std.enums.fromInt(image.PixelFormat, format) orelse return failure(owner, error.InvalidArgument);
    owner.core.copyImagePixels(abi.handleFromC(id.*), data, stride, mode) catch |err| return failure(owner, err);
    return c.OT_OK;
}

pub fn ot_image_copy_png(context: ?*ContextHandle, image_ptr: ?*const c.ot_handle, destination: ?[*]u8, capacity: u64, out_ptr: ?*u64) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = image_ptr orelse return failure(owner, error.InvalidArgument);
    const out = out_ptr orelse return failure(owner, error.InvalidArgument);
    const data = span([]u8, destination, capacity) catch |err| return failure(owner, err);
    out.* = owner.core.copyImagePng(abi.handleFromC(id.*), data) catch |err| return failure(owner, err);
    return c.OT_OK;
}

pub fn ot_image_take_pixels(context: ?*ContextHandle, image_ptr: ?*const c.ot_handle, out_ptr: ?*c.ot_image_pixels) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = image_ptr orelse return failure(owner, error.InvalidArgument);
    const out = out_ptr orelse return failure(owner, error.InvalidArgument);
    const lease = owner.core.takeImagePixels(abi.handleFromC(id.*)) catch |err| return failure(owner, err);
    const pixels = owner.core.imagePixelsSnapshot(lease) catch unreachable;
    out.* = .{ .lease = abi.handleToC(lease), .pixels = @intFromPtr(pixels.ptr), .byte_count = pixels.len };
    return c.OT_OK;
}

pub fn ot_image_pixels_release(context: ?*ContextHandle, lease_ptr: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const id = lease_ptr orelse return failure(owner, error.InvalidArgument);
    owner.core.releaseImagePixels(abi.handleFromC(id.*)) catch |err| return failure(owner, err);
    return c.OT_OK;
}

export fn imageRetainIccCache() void {
    image.retainIccCache();
}

export fn imageReleaseIccCache() void {
    image.releaseIccCache();
}

export fn imageTestFailIccProfileCopyAllocationOnce() void {
    image.testFailIccProfileCopyAllocationOnce();
}

test "Context checked image ABI validates spans owners and output publication" {
    const owner = try abi.createTestContext(.{ .object_capacity = 8, .render_cells_max = 1 });
    defer std.testing.expectEqual(c.OT_OK, abi.ot_context_destroy(owner)) catch unreachable;
    const other = try abi.createTestContext(.{ .object_capacity = 8, .render_cells_max = 1 });
    defer std.testing.expectEqual(c.OT_OK, abi.ot_context_destroy(other)) catch unreachable;
    const sentinel = c.ot_handle{ .context_id = 99, .slot = 99, .generation = 99 };
    var out = sentinel;
    const pixels = [_]u8{ 1, 2, 3, 255 };
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_image_create_pixels(owner, null, 4, 1, 1, 4, 0, 0, &out));
    try std.testing.expectEqualDeep(sentinel, out);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_image_create_pixels(owner, &pixels, 4, 1, 1, 4, 2, 0, &out));
    try std.testing.expectEqualDeep(sentinel, out);
    try std.testing.expectEqual(c.OT_OK, ot_image_create_pixels(owner, &pixels, 4, 1, 1, 4, 0, 0, &out));
    var copy = sentinel;
    try std.testing.expectEqual(c.OT_WRONG_CONTEXT, ot_image_retain(other, &out, &copy));
    try std.testing.expectEqualDeep(sentinel, copy);
    try std.testing.expectEqual(c.OT_OK, ot_image_clone(other, owner, &out, &copy));
    try std.testing.expectEqual(c.OT_OK, abi.ot_image_destroy(owner, &out));
    var raw: c.ot_image_pixels = undefined;
    try std.testing.expectEqual(c.OT_OK, ot_image_take_pixels(other, &copy, &raw));
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, abi.ot_context_destroy(other));
    var info: c.ot_image_info = undefined;
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_image_get_info(other, &copy, &info));
    try std.testing.expectEqualSlices(u8, &pixels, @as([*]u8, @ptrFromInt(raw.pixels))[0..@intCast(raw.byte_count)]);
    try std.testing.expectEqual(c.OT_OK, ot_image_pixels_release(other, &raw.lease));
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_image_pixels_release(other, &raw.lease));
    owner.core.mutating = true;
    try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_image_decode(owner, &pixels, 4, &out));
    owner.core.mutating = false;
    const Worker = struct {
        fn run(context: *ContextHandle) void {
            std.testing.expectEqual(c.OT_WRONG_THREAD, ot_image_decode(context, null, 0, null)) catch unreachable;
            std.testing.expectEqual(c.OT_WRONG_THREAD, ot_image_take_pixels(context, null, null)) catch unreachable;
        }
    };
    const thread = try std.Thread.spawn(.{}, Worker.run, .{owner});
    thread.join();
}
