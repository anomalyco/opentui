const std = @import("std");
const c = @import("context_abi_c");
const abi = @import("context-abi.zig");
const handles = @import("context-handles.zig");
const clipboard = @import("clipboard/host.zig");
const ContextHandle = abi.ContextHandle;
const Handle = handles.Handle;

fn objects(context: ?*ContextHandle) ?*handles.Table {
    if (abi.sessionContextStatus(context) != c.OT_OK) return null;
    return &context.?.core.objects;
}

fn serviceHandle(table: *handles.Table) ?Handle {
    var cursor: usize = 0;
    return table.next(.clipboard_service, &cursor);
}

fn outHandle(out: ?*c.ot_handle) ?*Handle {
    return @ptrCast(out);
}

fn operationHandle(operation: ?*const c.ot_handle) ?Handle {
    return if (operation) |ptr| abi.handleFromC(ptr.*) else null;
}

pub fn ot_clipboard_service_create(
    context: ?*ContextHandle,
    max_operations: u32,
    max_provider_transfers: u32,
    wayland_seat_pointer: ?[*]const u8,
    wayland_seat_length: u32,
) callconv(.c) i32 {
    if (abi.sessionContextStatus(context) != c.OT_OK) return -1;
    _ = context.?.core.createClipboardService(
        max_operations,
        max_provider_transfers,
        wayland_seat_pointer,
        wayland_seat_length,
    ) catch return -1;
    return 0;
}

pub fn ot_clipboard_service_begin_shutdown(context: ?*ContextHandle) callconv(.c) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.ShutdownStatus.invalid_handle);
    const service = serviceHandle(table) orelse return @intFromEnum(clipboard.ShutdownStatus.invalid_handle);
    return @intFromEnum(clipboard.beginServiceShutdown(table, service));
}

pub fn ot_clipboard_service_poll_shutdown(context: ?*ContextHandle) callconv(.c) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.ShutdownStatus.invalid_handle);
    const service = serviceHandle(table) orelse return @intFromEnum(clipboard.ShutdownStatus.invalid_handle);
    return @intFromEnum(clipboard.pollServiceShutdown(table, service));
}

pub fn ot_clipboard_service_destroy(context: ?*ContextHandle) callconv(.c) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.DestroyStatus.invalid_handle);
    const service = serviceHandle(table) orelse return @intFromEnum(clipboard.DestroyStatus.invalid_handle);
    return @intFromEnum(clipboard.destroyService(table, service));
}

pub fn ot_clipboard_service_drain(context: ?*ContextHandle) callconv(.c) u8 {
    const table = objects(context) orelse return 2;
    const service = serviceHandle(table) orelse return 2;
    return clipboard.drainService(table, service);
}

pub fn ot_clipboard_read_operation_start(
    context: ?*ContextHandle,
    request_pointer: ?[*]const u8,
    request_length: u32,
    selection: u8,
    max_bytes: u32,
    max_image_pixels: u32,
    max_conversion_bytes: u32,
    timeout_ms: u32,
    out_operation: ?*c.ot_handle,
) callconv(.c) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.StartStatus.invalid_service);
    const service = serviceHandle(table) orelse return @intFromEnum(clipboard.StartStatus.invalid_service);
    return @intFromEnum(clipboard.startReadOperation(
        table,
        service,
        request_pointer,
        request_length,
        selection,
        max_bytes,
        max_image_pixels,
        max_conversion_bytes,
        timeout_ms,
        outHandle(out_operation),
    ));
}

pub fn ot_clipboard_write_operation_start(
    context: ?*ContextHandle,
    text_pointer: ?[*]const u8,
    text_length: u32,
    selection: u8,
    timeout_ms: u32,
    out_operation: ?*c.ot_handle,
) callconv(.c) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.StartStatus.invalid_service);
    const service = serviceHandle(table) orelse return @intFromEnum(clipboard.StartStatus.invalid_service);
    return @intFromEnum(clipboard.startWriteOperation(
        table,
        service,
        text_pointer,
        text_length,
        selection,
        timeout_ms,
        outHandle(out_operation),
    ));
}

pub fn ot_clipboard_clear_operation_start(
    context: ?*ContextHandle,
    selection: u8,
    timeout_ms: u32,
    out_operation: ?*c.ot_handle,
) callconv(.c) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.StartStatus.invalid_service);
    const service = serviceHandle(table) orelse return @intFromEnum(clipboard.StartStatus.invalid_service);
    return @intFromEnum(clipboard.startClearOperation(
        table,
        service,
        selection,
        timeout_ms,
        outHandle(out_operation),
    ));
}

pub fn ot_clipboard_operation_poll(context: ?*ContextHandle, operation: ?*const c.ot_handle) callconv(.c) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.OperationStatus.invalid_handle);
    const id = operationHandle(operation) orelse return @intFromEnum(clipboard.OperationStatus.invalid_handle);
    return @intFromEnum(clipboard.pollOperation(table, id));
}

pub fn ot_clipboard_operation_cancel(context: ?*ContextHandle, operation: ?*const c.ot_handle) callconv(.c) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.CancelStatus.invalid_handle);
    const id = operationHandle(operation) orelse return @intFromEnum(clipboard.CancelStatus.invalid_handle);
    return @intFromEnum(clipboard.cancelOperation(table, id));
}

pub fn ot_clipboard_operation_result_mime_length(
    context: ?*ContextHandle,
    operation: ?*const c.ot_handle,
    out_length: ?*u32,
) callconv(.c) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    const id = operationHandle(operation) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    return @intFromEnum(clipboard.resultMimeLength(table, id, out_length));
}

pub fn ot_clipboard_operation_result_mime_copy(
    context: ?*ContextHandle,
    operation: ?*const c.ot_handle,
    out_pointer: ?[*]u8,
    capacity: u32,
) callconv(.c) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    const id = operationHandle(operation) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    return @intFromEnum(clipboard.resultMimeCopy(table, id, out_pointer, capacity));
}

pub fn ot_clipboard_operation_result_data_length(
    context: ?*ContextHandle,
    operation: ?*const c.ot_handle,
    out_length: ?*u32,
) callconv(.c) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    const id = operationHandle(operation) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    return @intFromEnum(clipboard.resultDataLength(table, id, out_length));
}

pub fn ot_clipboard_operation_result_data_copy(
    context: ?*ContextHandle,
    operation: ?*const c.ot_handle,
    out_pointer: ?[*]u8,
    capacity: u32,
) callconv(.c) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    const id = operationHandle(operation) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    return @intFromEnum(clipboard.resultDataCopy(table, id, out_pointer, capacity));
}

pub fn ot_clipboard_operation_result_error_code(
    context: ?*ContextHandle,
    operation: ?*const c.ot_handle,
    out_error_code: ?*u32,
) callconv(.c) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    const id = operationHandle(operation) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    return @intFromEnum(clipboard.resultErrorCode(table, id, out_error_code));
}

pub fn ot_clipboard_operation_result_diagnostic_length(
    context: ?*ContextHandle,
    operation: ?*const c.ot_handle,
    out_length: ?*u32,
) callconv(.c) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    const id = operationHandle(operation) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    return @intFromEnum(clipboard.resultDiagnosticLength(table, id, out_length));
}

pub fn ot_clipboard_operation_result_diagnostic_copy(
    context: ?*ContextHandle,
    operation: ?*const c.ot_handle,
    out_pointer: ?[*]u8,
    capacity: u32,
) callconv(.c) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    const id = operationHandle(operation) orelse return @intFromEnum(clipboard.CopyStatus.invalid_handle);
    return @intFromEnum(clipboard.resultDiagnosticCopy(table, id, out_pointer, capacity));
}

pub fn ot_clipboard_operation_destroy(context: ?*ContextHandle, operation: ?*const c.ot_handle) callconv(.c) u8 {
    const table = objects(context) orelse return @intFromEnum(clipboard.DestroyStatus.invalid_handle);
    const id = operationHandle(operation) orelse return @intFromEnum(clipboard.DestroyStatus.invalid_handle);
    return @intFromEnum(clipboard.destroyOperation(table, id));
}

comptime {
    std.debug.assert(@sizeOf(Handle) == @sizeOf(c.ot_handle));
    std.debug.assert(@alignOf(Handle) == @alignOf(c.ot_handle));
}
