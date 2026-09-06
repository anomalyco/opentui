const std = @import("std");
const compat = &@import("compatibility-context.zig").compatDefault;
const registry = &compat.registry;
const globalAllocator = compat.gpa.allocator();
const NativeHandle = @import("handles.zig").Handle;
const INVALID_HANDLE: NativeHandle = 0;
const native_image = @import("image.zig");
const context_abi = @import("context-abi.zig");

fn acquireImage(handle: NativeHandle) ?*native_image.Image {
    return registry.acquire(handle, .image, native_image.Image);
}

fn insertImage(image: *native_image.Image, out_handle: *NativeHandle) native_image.Status {
    out_handle.* = registry.insert(.image, @ptrCast(image)) catch {
        image.deinit();
        return .out_of_memory;
    };
    return .ok;
}

export fn imageInfo(data_ptr: ?[*]const u8, data_len: u32, out_info: ?*native_image.Info) u32 {
    const output = out_info orelse return @intFromEnum(native_image.Status.invalid_argument);
    if (data_len == 0 or data_ptr == null) return @intFromEnum(native_image.Status.invalid_argument);
    return @intFromEnum(native_image.inspect(globalAllocator, data_ptr.?[0..data_len], .{}, output));
}

export fn imageRetainIccCache() void {
    native_image.retainIccCache();
}

export fn imageReleaseIccCache() void {
    native_image.releaseIccCache();
}

export fn imageTestFailIccProfileCopyAllocationOnce() void {
    native_image.testFailIccProfileCopyAllocationOnce();
}

export fn imageDecode(data_ptr: ?[*]const u8, data_len: u32, out_handle: ?*NativeHandle) u32 {
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    if (data_len == 0 or data_ptr == null) return @intFromEnum(native_image.Status.invalid_argument);
    const image = native_image.decode(globalAllocator, data_ptr.?[0..data_len], .{}) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    return @intFromEnum(insertImage(image, output));
}

export fn imageCreateFromRgba(
    pixels_ptr: ?[*]const u8,
    pixels_len: u64,
    width: u32,
    height: u32,
    stride: u32,
    out_handle: ?*NativeHandle,
) u32 {
    return imageCreateFromPixels(
        pixels_ptr,
        pixels_len,
        width,
        height,
        stride,
        @intFromEnum(native_image.PixelFormat.rgba8),
        @intFromEnum(native_image.PixelAlpha.straight),
        out_handle,
    );
}

fn pixelImportOptions(stride: u32, format: u32, alpha: u32) !native_image.PixelImportOptions {
    return .{
        .stride = stride,
        .format = std.enums.fromInt(native_image.PixelFormat, format) orelse return error.InvalidArgument,
        .alpha = std.enums.fromInt(native_image.PixelAlpha, alpha) orelse return error.InvalidArgument,
    };
}

export fn imageCreateFromPixels(
    pixels_ptr: ?[*]const u8,
    pixels_len: u64,
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
    alpha: u32,
    out_handle: ?*NativeHandle,
) u32 {
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    if (pixels_len > std.math.maxInt(usize) or (pixels_len > 0 and pixels_ptr == null)) {
        return @intFromEnum(native_image.Status.invalid_argument);
    }
    const pixels = if (pixels_len == 0) "" else pixels_ptr.?[0..@intCast(pixels_len)];
    const options = pixelImportOptions(stride, format, alpha) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    const image = native_image.createFromPixels(globalAllocator, pixels, width, height, options) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    return @intFromEnum(insertImage(image, output));
}

export fn imageUpdatePixels(
    image_handle: NativeHandle,
    pixels_ptr: ?[*]const u8,
    pixels_len: u64,
    stride: u32,
    format: u32,
    alpha: u32,
) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    if (pixels_len > std.math.maxInt(usize) or (pixels_len > 0 and pixels_ptr == null)) {
        return @intFromEnum(native_image.Status.invalid_argument);
    }
    const pixels = if (pixels_len == 0) "" else pixels_ptr.?[0..@intCast(pixels_len)];
    const options = pixelImportOptions(stride, format, alpha) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    native_image.updatePixels(image, pixels, options) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    return @intFromEnum(native_image.Status.ok);
}

export fn imageDestroy(image_handle: NativeHandle) void {
    const token = registry.beginDestroy(image_handle, .image, native_image.Image) orelse return;
    token.ptr.deinit();
    registry.finishDestroy(token.handle);
}

export fn ot_image_import_compat(context: ?*context_abi.ContextHandle, source: u32, out_ptr: ?*@import("context_abi_c").ot_handle) @import("context_abi_c").ot_status {
    const c = @import("context_abi_c");
    const status = context_abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const owner = context.?;
    const out = out_ptr orelse return context_abi.sessionError(owner, error.InvalidOptions);
    const image = acquireImage(source) orelse return context_abi.sessionError(owner, error.StaleHandle);
    out.* = context_abi.handleToC(owner.core.importImage(image) catch |err| return context_abi.sessionError(owner, err));
    return c.OT_OK;
}

export fn imageRetain(image_handle: NativeHandle, out_handle: ?*NativeHandle) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    if (image.ref_count == std.math.maxInt(u32)) return @intFromEnum(native_image.Status.memory_limit);
    image.retain();
    return @intFromEnum(insertImage(image, output));
}

export fn imageGetInfo(image_handle: NativeHandle, out_info: ?*native_image.Info) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const output = out_info orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = image.info();
    return @intFromEnum(native_image.Status.ok);
}

export fn imageGetPixelsPtr(image_handle: NativeHandle) ?[*]u8 {
    const image = acquireImage(image_handle) orelse return null;
    if (image.ref_count != 1) return null;
    const pixels = image.ensurePixels() catch return null;
    image.discardEncoded();
    // Callers receive mutable pixels, so opacity can no longer be proven.
    image.metadata.has_alpha = 1;
    return pixels.ptr;
}

export fn imageMaterialize(image_handle: NativeHandle) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    if (image.ref_count != 1) return @intFromEnum(native_image.Status.invalid_argument);
    _ = image.ensurePixels() catch |err| return @intFromEnum(native_image.statusFromError(err));
    return @intFromEnum(native_image.Status.ok);
}

export fn imageEnsureEncodedPng(image_handle: NativeHandle) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    _ = image.ensureEncodedPng() catch |err| return @intFromEnum(native_image.statusFromError(err));
    return @intFromEnum(native_image.Status.ok);
}

export fn imageClone(image_handle: NativeHandle, out_handle: ?*NativeHandle) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    const cloned = image.clone() catch |err| return @intFromEnum(native_image.statusFromError(err));
    return @intFromEnum(insertImage(cloned, output));
}

export fn imageCopyPixels(
    image_handle: NativeHandle,
    destination_ptr: ?[*]u8,
    destination_len: u64,
    stride: u32,
    bgra: u8,
) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    if (destination_len > std.math.maxInt(usize) or destination_ptr == null or bgra > 1) {
        return @intFromEnum(native_image.Status.invalid_argument);
    }
    const destination = destination_ptr.?[0..@intCast(destination_len)];
    return @intFromEnum(native_image.copyPixels(image, destination, stride, bgra == 1));
}

test "imageGetPixelsPtr aliases the image pixel allocation" {
    const pixels = [_]u8{ 1, 2, 3, 4, 5, 6, 7, 8 };
    var handle: NativeHandle = INVALID_HANDLE;
    try std.testing.expectEqual(
        @as(u32, @intFromEnum(native_image.Status.ok)),
        imageCreateFromRgba(&pixels, pixels.len, 2, 1, 8, &handle),
    );
    defer imageDestroy(handle);

    const pointer = imageGetPixelsPtr(handle) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqualSlices(u8, &pixels, pointer[0..pixels.len]);
    pointer[0] = 42;

    var copied: [pixels.len]u8 = undefined;
    try std.testing.expectEqual(
        @as(u32, @intFromEnum(native_image.Status.ok)),
        imageCopyPixels(handle, &copied, copied.len, 8, 0),
    );
    try std.testing.expectEqual(@as(u8, 42), copied[0]);
}

test "imageGetPixelsPtr requires exclusive ownership and invalidates encoded state" {
    const value = try native_image.createFromRgba(globalAllocator, &[_]u8{ 1, 2, 3, 255 }, 1, 1, 4);
    value.encoded_png = try globalAllocator.dupe(u8, "encoded");
    var handle: NativeHandle = INVALID_HANDLE;
    try std.testing.expectEqual(native_image.Status.ok, insertImage(value, &handle));
    defer imageDestroy(handle);

    value.retain();
    try std.testing.expectEqual(@as(?[*]u8, null), imageGetPixelsPtr(handle));
    value.deinit();

    try std.testing.expect(imageGetPixelsPtr(handle) != null);
    try std.testing.expectEqual(@as(?[]u8, null), value.encoded_png);
    try std.testing.expectEqual(@as(u32, 1), value.metadata.has_alpha);
}

test "imageEnsureEncodedPng attaches an encoding that pixel mutation discards" {
    const pixels = [_]u8{ 1, 2, 3, 255, 4, 5, 6, 255 };
    var handle: NativeHandle = INVALID_HANDLE;
    try std.testing.expectEqual(
        @as(u32, @intFromEnum(native_image.Status.ok)),
        imageCreateFromRgba(&pixels, pixels.len, 2, 1, 8, &handle),
    );
    defer imageDestroy(handle);

    try std.testing.expectEqual(
        @as(u32, @intFromEnum(native_image.Status.invalid_handle)),
        imageEnsureEncodedPng(INVALID_HANDLE),
    );
    try std.testing.expectEqual(@as(u32, @intFromEnum(native_image.Status.ok)), imageEnsureEncodedPng(handle));
    const image = acquireImage(handle) orelse return error.TestUnexpectedResult;
    try std.testing.expect(image.encoded_png != null);

    try std.testing.expect(imageGetPixelsPtr(handle) != null);
    try std.testing.expectEqual(@as(?[]u8, null), image.encoded_png);
}

test "Context image import ABI clones compatibility sources and rejects wrong thread reentry" {
    const c = @import("context_abi_c");
    var options = std.mem.zeroes(c.ot_context_options);
    options.struct_size = @sizeOf(c.ot_context_options);
    options.abi_version = c.OT_CONTEXT_ABI_VERSION;
    options.object_capacity = 4;
    options.render_cells_max = 4;
    var context: ?*context_abi.ContextHandle = null;
    try std.testing.expectEqual(c.OT_OK, context_abi.ot_context_create(&options, &context));
    defer std.testing.expectEqual(c.OT_OK, context_abi.ot_context_destroy(context)) catch unreachable;
    const pixels = [_]u8{ 255, 0, 0, 255 };
    var source: NativeHandle = INVALID_HANDLE;
    try std.testing.expectEqual(@intFromEnum(native_image.Status.ok), imageCreateFromRgba(&pixels, pixels.len, 1, 1, 4, &source));
    defer imageDestroy(source);
    const sentinel: c.ot_handle = .{ .context_id = 99, .slot = 99, .generation = 99 };
    var output = sentinel;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_image_import_compat(null, source, &output));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, ot_image_import_compat(context, source, null));
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_image_import_compat(context, 0, &output));
    try std.testing.expectEqualDeep(sentinel, output);
    {
        context.?.core.mutating = true;
        defer context.?.core.mutating = false;
        context.?.core.scene_measuring = true;
        defer context.?.core.scene_measuring = false;
        try std.testing.expectEqual(c.OT_CONTEXT_BUSY, ot_image_import_compat(context, source, &output));
        try std.testing.expectEqualDeep(sentinel, output);
    }
    const Worker = struct {
        fn run(owner: *context_abi.ContextHandle, token: u32) void {
            const api = @import("context_abi_c");
            var out: api.ot_handle = .{ .context_id = 99, .slot = 99, .generation = 99 };
            std.testing.expectEqual(api.OT_WRONG_THREAD, ot_image_import_compat(owner, token, &out)) catch unreachable;
            std.testing.expectEqual(99, out.context_id) catch unreachable;
            std.testing.expectEqual(api.OT_WRONG_THREAD, context_abi.ot_image_destroy(owner, null)) catch unreachable;
            std.testing.expectEqual(api.OT_WRONG_THREAD, context_abi.ot_scene_set_image(owner, null, null, 0, 0, null)) catch unreachable;
            std.testing.expectEqual(api.OT_WRONG_THREAD, context_abi.ot_buffer_draw_image(owner, null, null, null, null, null)) catch unreachable;
            std.testing.expectEqual(api.OT_WRONG_THREAD, context_abi.ot_session_set_image_resolution(owner, null, 0, 0, 0, 0)) catch unreachable;
        }
    };
    const thread = try std.Thread.spawn(.{}, Worker.run, .{ context.?, source });
    thread.join();
    try std.testing.expectEqual(c.OT_OK, ot_image_import_compat(context, source, &output));
    const copied = try context.?.core.getImage(context_abi.handleFromC(output));
    try std.testing.expect(copied != acquireImage(source).?);
    try std.testing.expectEqual(1, acquireImage(source).?.ref_count);
    imageDestroy(source);
    try std.testing.expectEqualSlices(u8, &pixels, try copied.ensurePixels());
    var rejected = sentinel;
    try std.testing.expectEqual(c.OT_STALE_HANDLE, ot_image_import_compat(context, source, &rejected));
    try std.testing.expectEqualDeep(sentinel, rejected);
    try std.testing.expectEqual(c.OT_OK, context_abi.ot_image_destroy(context, &output));
}

test "imageRetain creates independently disposable handles without copying pixels" {
    const pixels = [_]u8{ 1, 2, 3, 255 };
    var handle: NativeHandle = INVALID_HANDLE;
    try std.testing.expectEqual(
        @as(u32, @intFromEnum(native_image.Status.ok)),
        imageCreateFromRgba(&pixels, pixels.len, 1, 1, 4, &handle),
    );
    defer imageDestroy(handle);

    var retained_handle: NativeHandle = INVALID_HANDLE;
    try std.testing.expectEqual(
        @as(u32, @intFromEnum(native_image.Status.ok)),
        imageRetain(handle, &retained_handle),
    );
    defer imageDestroy(retained_handle);
    try std.testing.expect(handle != retained_handle);
    const image = acquireImage(handle) orelse return error.TestUnexpectedResult;
    try std.testing.expectEqual(image, acquireImage(retained_handle));

    imageDestroy(handle);
    try std.testing.expect(acquireImage(handle) == null);
    try std.testing.expectEqual(image, acquireImage(retained_handle));
}

export fn imageResize(image_handle: NativeHandle, width: u32, height: u32, filter: u32, out_handle: ?*NativeHandle) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    const resize_filter = std.enums.fromInt(native_image.ResizeFilter, filter) orelse return @intFromEnum(native_image.Status.invalid_argument);
    const resized = native_image.resize(globalAllocator, image, width, height, resize_filter) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    return @intFromEnum(insertImage(resized, output));
}

export fn imageExtract(
    image_handle: NativeHandle,
    left: u32,
    top: u32,
    width: u32,
    height: u32,
    out_handle: ?*NativeHandle,
) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    const extracted = native_image.extract(globalAllocator, image, left, top, width, height) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    return @intFromEnum(insertImage(extracted, output));
}

export fn imageExtend(
    image_handle: NativeHandle,
    top: u32,
    right: u32,
    bottom: u32,
    left: u32,
    background_ptr: ?[*]const u8,
    out_handle: ?*NativeHandle,
) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    const background = background_ptr orelse return @intFromEnum(native_image.Status.invalid_argument);
    const extended = native_image.extend(globalAllocator, image, top, right, bottom, left, .{
        background[0], background[1], background[2], background[3],
    }) catch |err| return @intFromEnum(native_image.statusFromError(err));
    return @intFromEnum(insertImage(extended, output));
}

export fn imageTransform(image_handle: NativeHandle, operation: u32, out_handle: ?*NativeHandle) u32 {
    const image = acquireImage(image_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    const transform_operation = std.enums.fromInt(native_image.Transform, operation) orelse return @intFromEnum(native_image.Status.invalid_argument);
    const transformed = native_image.transform(globalAllocator, image, transform_operation) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    return @intFromEnum(insertImage(transformed, output));
}

export fn imageComposite(
    base_handle: NativeHandle,
    overlay_handle: NativeHandle,
    left: i32,
    top: i32,
    blend: u32,
    opacity: u8,
    out_handle: ?*NativeHandle,
) u32 {
    const base = acquireImage(base_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const overlay = acquireImage(overlay_handle) orelse return @intFromEnum(native_image.Status.invalid_handle);
    const output = out_handle orelse return @intFromEnum(native_image.Status.invalid_argument);
    output.* = INVALID_HANDLE;
    const blend_mode = std.enums.fromInt(native_image.Blend, blend) orelse return @intFromEnum(native_image.Status.invalid_argument);
    const composited = native_image.composite(globalAllocator, base, overlay, left, top, blend_mode, opacity) catch |err| {
        return @intFromEnum(native_image.statusFromError(err));
    };
    return @intFromEnum(insertImage(composited, output));
}
