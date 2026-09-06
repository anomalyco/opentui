const compat = &@import("compatibility-context.zig").compatDefault;
const globalAllocator = compat.gpa.allocator();
const NativeHandle = @import("handles.zig").Handle;
const clipboard = @import("clipboard/host.zig");

export fn clipboardServiceCreate(
    max_operations: u32,
    max_provider_transfers: u32,
    wayland_seat_pointer: ?[*]const u8,
    wayland_seat_length: u32,
) NativeHandle {
    return clipboard.createService(
        globalAllocator,
        max_operations,
        max_provider_transfers,
        wayland_seat_pointer,
        wayland_seat_length,
    );
}

export fn clipboardServiceBeginShutdown(service_handle: NativeHandle) u8 {
    return @intFromEnum(clipboard.beginServiceShutdown(service_handle));
}

export fn clipboardServicePollShutdown(service_handle: NativeHandle) u8 {
    return @intFromEnum(clipboard.pollServiceShutdown(service_handle));
}

export fn clipboardServiceDestroy(service_handle: NativeHandle) u8 {
    return @intFromEnum(clipboard.destroyService(service_handle));
}

export fn clipboardServiceDrain(service_handle: NativeHandle) u8 {
    return clipboard.drainService(service_handle);
}

export fn clipboardReadOperationStart(
    service_handle: NativeHandle,
    request_pointer: ?[*]const u8,
    request_length: u32,
    selection: u8,
    max_bytes: u32,
    max_image_pixels: u32,
    max_conversion_bytes: u32,
    timeout_ms: u32,
    out_operation_handle: ?*NativeHandle,
) u8 {
    return @intFromEnum(clipboard.startReadOperation(
        service_handle,
        request_pointer,
        request_length,
        selection,
        max_bytes,
        max_image_pixels,
        max_conversion_bytes,
        timeout_ms,
        out_operation_handle,
    ));
}

export fn clipboardWriteOperationStart(
    service_handle: NativeHandle,
    text_pointer: ?[*]const u8,
    text_length: u32,
    selection: u8,
    timeout_ms: u32,
    out_operation_handle: ?*NativeHandle,
) u8 {
    return @intFromEnum(clipboard.startWriteOperation(
        service_handle,
        text_pointer,
        text_length,
        selection,
        timeout_ms,
        out_operation_handle,
    ));
}

export fn clipboardClearOperationStart(
    service_handle: NativeHandle,
    selection: u8,
    timeout_ms: u32,
    out_operation_handle: ?*NativeHandle,
) u8 {
    return @intFromEnum(clipboard.startClearOperation(
        service_handle,
        selection,
        timeout_ms,
        out_operation_handle,
    ));
}

export fn clipboardOperationPoll(operation_handle: NativeHandle) u8 {
    return @intFromEnum(clipboard.pollOperation(operation_handle));
}

export fn clipboardOperationCancel(operation_handle: NativeHandle) u8 {
    return @intFromEnum(clipboard.cancelOperation(operation_handle));
}

export fn clipboardOperationResultMimeLength(operation_handle: NativeHandle, out_length: ?*u32) u8 {
    return @intFromEnum(clipboard.resultMimeLength(operation_handle, out_length));
}

export fn clipboardOperationResultMimeCopy(operation_handle: NativeHandle, out_pointer: ?[*]u8, capacity: u32) u8 {
    return @intFromEnum(clipboard.resultMimeCopy(operation_handle, out_pointer, capacity));
}

export fn clipboardOperationResultDataLength(operation_handle: NativeHandle, out_length: ?*u32) u8 {
    return @intFromEnum(clipboard.resultDataLength(operation_handle, out_length));
}

export fn clipboardOperationResultDataCopy(operation_handle: NativeHandle, out_pointer: ?[*]u8, capacity: u32) u8 {
    return @intFromEnum(clipboard.resultDataCopy(operation_handle, out_pointer, capacity));
}

export fn clipboardOperationResultErrorCode(operation_handle: NativeHandle, out_error_code: ?*u32) u8 {
    return @intFromEnum(clipboard.resultErrorCode(operation_handle, out_error_code));
}

export fn clipboardOperationResultDiagnosticLength(operation_handle: NativeHandle, out_length: ?*u32) u8 {
    return @intFromEnum(clipboard.resultDiagnosticLength(operation_handle, out_length));
}

export fn clipboardOperationResultDiagnosticCopy(operation_handle: NativeHandle, out_pointer: ?[*]u8, capacity: u32) u8 {
    return @intFromEnum(clipboard.resultDiagnosticCopy(operation_handle, out_pointer, capacity));
}

export fn clipboardOperationDestroy(operation_handle: NativeHandle) u8 {
    return @intFromEnum(clipboard.destroyOperation(operation_handle));
}
