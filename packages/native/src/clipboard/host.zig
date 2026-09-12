const std = @import("std");
const builtin = @import("builtin");
const handles = @import("../handles.zig");
const clipboard_clock = @import("clock.zig");
const clipboard_linux = @import("linux.zig");
const clipboard_wayland = @import("wayland.zig");
const clipboard_x11 = @import("x11.zig");
const clipboard_windows = @import("windows.zig");
const clipboard_windows_dib = @import("windows-dib.zig");
const clipboard_macos = @import("macos.zig");
const sync = @import("sync.zig");
const posix_io = @import("posix-io.zig");

test {
    _ = clipboard_clock;
    _ = clipboard_linux;
    _ = clipboard_wayland;
    _ = clipboard_x11;
    _ = clipboard_windows;
    _ = clipboard_windows_dib;
    _ = clipboard_macos;
}

const Allocator = std.mem.Allocator;
pub const Handle = handles.Handle;

pub const OperationStatus = enum(u8) {
    pending = 0,
    read = 1,
    empty = 2,
    written = 3,
    cleared = 4,
    unsupported = 5,
    cancelled = 6,
    timed_out = 7,
    limit_exceeded = 8,
    failed = 9,
    invalid_handle = 10,
};

pub const StartStatus = enum(u8) {
    ok = 0,
    invalid_service = 1,
    shutting_down = 2,
    limit_exceeded = 3,
    invalid_argument = 4,
    out_of_memory = 5,
};

pub const CancelStatus = enum(u8) {
    requested = 0,
    already_terminal = 1,
    invalid_handle = 2,
};

pub const CopyStatus = enum(u8) {
    ok = 0,
    buffer_too_small = 1,
    invalid_handle = 2,
    invalid_state = 3,
    invalid_argument = 4,
};

pub const DestroyStatus = enum(u8) {
    destroyed = 0,
    not_ready = 1,
    invalid_handle = 2,
};

pub const ShutdownStatus = enum(u8) {
    pending = 0,
    ready = 1,
    invalid_handle = 2,
};

const READ_MIME_COUNT_MAX: u32 = 64;
const READ_MIME_ESSENCE_BYTES_MAX: u32 = 255;
// Bounds within-operation restarts when a chosen offer's source vanishes mid-read.
const WAYLAND_READ_STALE_RETRY_MAX: u8 = 2;
const OPERATIONS_MAX_DEFAULT: u32 = 16;
const PROVIDER_TRANSFERS_MAX_DEFAULT: u32 = 16;
const ResultKind = enum { mime, data, diagnostic };
const Selection = enum(u8) { clipboard = 0, primary = 1 };
const OperationKind = enum { read, write, clear };
const WaylandTransferFormat = enum { direct, bmp_to_png };

const ErrorCode = enum(u32) {
    internal = 1,
    out_of_memory = 2,
    wayland_protocol = 100,
    wayland_dispatch = 101,
    wayland_flush = 102,
    wayland_provider = 103,
    wayland_transfer = 104,
    x11_protocol = 200,
    x11_flush = 201,
    x11_provider = 202,
    x11_transfer = 203,
};

extern "c" fn pthread_mach_thread_np(thread: std.c.pthread_t) std.c.mach_port_t;
extern "c" fn pthread_tryjoin_np(thread: std.Thread.Handle, result: ?*?*anyopaque) c_int;
extern "c" fn pthread_peekjoin_np(thread: std.Thread.Handle, result: ?*?*anyopaque) c_int;

fn tryJoinThread(thread: std.Thread) bool {
    return switch (builtin.os.tag) {
        .linux => switch (pthread_tryjoin_np(thread.getHandle(), null)) {
            0 => true,
            @intFromEnum(std.posix.E.BUSY) => false,
            else => false,
        },
        .freebsd => switch (pthread_peekjoin_np(thread.getHandle(), null)) {
            0 => {
                thread.join();
                return true;
            },
            @intFromEnum(std.posix.E.BUSY) => false,
            else => false,
        },
        .windows => blk: {
            const timeout: std.os.windows.LARGE_INTEGER = 0;
            if (std.os.windows.ntdll.NtWaitForSingleObject(thread.getHandle(), .FALSE, &timeout) != .SUCCESS) break :blk false;
            thread.join();
            break :blk true;
        },
        .macos => blk: {
            var info: std.c.thread_basic_info = undefined;
            var count = std.c.THREAD.BASIC.INFO_COUNT;
            const result = std.c.thread_info(
                pthread_mach_thread_np(thread.getHandle()),
                std.c.THREAD.BASIC.INFO,
                @ptrCast(&info),
                &count,
            );
            if (result != 0 and result != 4) break :blk false; // KERN_INVALID_ARGUMENT means the thread is gone.
            if (result == 0 and info.run_state != 5) break :blk false; // TH_STATE_HALTED
            thread.join();
            break :blk true;
        },
        else => @compileError("Unsupported clipboard worker target"),
    };
}

const Operation = struct {
    allocator: Allocator,
    handle: Handle = 0,
    service: *Service,
    mutex: sync.Mutex = .{},
    thread: ?std.Thread = null,
    status: OperationStatus = .pending,
    cancel_requested: bool = false,
    kind: OperationKind,
    request: []u8 = &.{},
    result: []u8 = &.{},
    error_code: u32 = 0,
    diagnostic: []const u8 = &.{},
    result_mime: []u8 = &.{},
    transfer_data: std.ArrayListUnmanaged(u8) = .empty,
    transfer_fd: ?std.posix.fd_t = null,
    wayland_transfer_format: WaylandTransferFormat = .direct,
    wayland_core_focus_acquired: bool = false,
    wayland_conversion_started: bool = false,
    wayland_connection_reset: bool = false,
    wayland_barrier_serial: u64 = 0,
    wayland_stale_retry_count: u8 = 0,
    max_bytes: u32 = 0,
    max_image_pixels: u32 = 0,
    max_conversion_bytes: u32 = 0,
    selection: Selection = .clipboard,
    preference_offset: usize = 4,
    candidate_failed: bool = false,
    implemented_candidate_attempted: bool = false,
    mechanism: ?clipboard_linux.Mechanism = null,
    x11_read: clipboard_x11.ReadState = .{},
    x11_write: clipboard_x11.WriteState = .{},
    x11_targets: [6]u32 = undefined,
    x11_target_count: u8 = 0,
    x11_target_index: u8 = 0,
    platform_cancel: std.atomic.Value(bool) = .init(false),
    platform_mutation_started: std.atomic.Value(bool) = .init(false),
    platform_terminal_request: ?OperationStatus = null,
    mutation_sequence: u64 = 0,
    timeout_ms: u32 = 0,
    started_ns: i128 = 0,

    fn waylandBmpWorker(operation: *Operation) void {
        const converted = clipboard_windows_dib.convertBmpToPng(
            operation.allocator,
            operation.transfer_data.items,
            .{
                .max_output_bytes = operation.max_bytes,
                .max_image_pixels = operation.max_image_pixels,
                .max_conversion_bytes = operation.max_conversion_bytes,
                .cancel_requested = &operation.platform_cancel,
                .deadline_ns = operation.started_ns + @as(i128, operation.timeout_ms) * std.time.ns_per_ms,
            },
        );

        operation.mutex.lock();
        defer operation.mutex.unlock();
        operation.transfer_data.deinit(operation.allocator);
        operation.transfer_data = .empty;
        if (operation.status != .pending) {
            if (converted) |png| operation.allocator.free(png) else |_| {}
            operation.wayland_conversion_started = false;
            return;
        }
        if (operation.cancel_requested) {
            if (converted) |png| operation.allocator.free(png) else |_| {}
            operation.status = .cancelled;
            operation.wayland_conversion_started = false;
            return;
        }
        if (platformDeadlineExpired(operation, clipboard_clock.nowNs())) {
            if (converted) |png| operation.allocator.free(png) else |_| {}
            operation.status = .timed_out;
            operation.wayland_conversion_started = false;
            return;
        }
        if (converted) |png| {
            operation.result = png;
            operation.status = .read;
        } else |err| switch (err) {
            error.Unsupported => {
                if (operation.result_mime.len > 0) operation.allocator.free(operation.result_mime);
                operation.result_mime = &.{};
            },
            error.InvalidData => {
                operation.rememberFailure(.wayland_transfer, "Wayland BMP clipboard image is malformed");
                operation.candidate_failed = true;
                if (operation.result_mime.len > 0) operation.allocator.free(operation.result_mime);
                operation.result_mime = &.{};
            },
            error.LimitExceeded => operation.status = .limit_exceeded,
            error.Cancelled => operation.status = .cancelled,
            error.TimedOut => operation.status = .timed_out,
            error.OutOfMemory => {
                operation.rememberFailure(.out_of_memory, "Failed to convert Wayland BMP clipboard image");
                operation.status = .failed;
            },
        }
        if (operation.status == .pending and operation.wayland_connection_reset) {
            operation.resetWaylandRetryState();
        }
        operation.wayland_conversion_started = false;
    }

    fn requestCancel(operation: *Operation) CancelStatus {
        operation.mutex.lock();
        if (operation.status != .pending) {
            operation.mutex.unlock();
            return .already_terminal;
        }
        if (operation.wayland_conversion_started) {
            operation.cancel_requested = true;
            operation.platform_cancel.store(true, .release);
            operation.mutex.unlock();
            return .requested;
        }
        if (comptime builtin.os.tag == .windows or builtin.os.tag == .macos) {
            if (operation.platform_mutation_started.load(.acquire)) {
                operation.mutex.unlock();
                return .already_terminal;
            }
            operation.cancel_requested = true;
            operation.platform_cancel.store(true, .release);
            if (operation.platform_terminal_request == null) operation.platform_terminal_request = .cancelled;
            operation.mutex.unlock();
            if (!operation.service.completeQueuedPlatformOperation(operation, .cancelled)) {
                operation.service.wakePlatformWorker();
            }
            return .requested;
        }
        defer operation.mutex.unlock();
        if (operation.x11_write.mutation_dispatched) {
            if (operation.x11_write.committed) {
                operation.status = if (operation.kind == .write) .written else .cleared;
                return .already_terminal;
            }
            if (operation.service.x11) |x11| x11.abandonMutationConfirmation(&operation.x11_write);
            operation.cancel_requested = true;
            operation.status = .cancelled;
            return .requested;
        }
        operation.cancel_requested = true;
        operation.platform_cancel.store(true, .release);
        operation.cleanupTransfer();
        operation.cleanupX11();
        operation.status = .cancelled;
        return .requested;
    }

    fn poll(operation: *Operation) OperationStatus {
        if (!operation.joinCompletedWorker()) return .pending;
        operation.mutex.lock();
        if (operation.status != .pending) {
            const status = operation.status;
            operation.mutex.unlock();
            return status;
        }
        if (operation.x11_write.committed) {
            operation.status = if (operation.kind == .write) .written else .cleared;
            const status = operation.status;
            operation.mutex.unlock();
            return status;
        }
        if (comptime builtin.os.tag == .windows or builtin.os.tag == .macos) {
            const now_ns = clipboard_clock.nowNs();
            if (platformDeadlineExpired(operation, now_ns) and operation.platform_terminal_request == null and
                !operation.platform_mutation_started.load(.acquire))
            {
                operation.platform_terminal_request = .timed_out;
                operation.platform_cancel.store(true, .release);
            }
            if (operation.platform_terminal_request) |requested| {
                operation.mutex.unlock();
                if (operation.service.completeQueuedPlatformOperation(operation, requested)) return requested;
                operation.service.wakePlatformWorker();
                return .pending;
            }
            operation.mutex.unlock();
            return .pending;
        }
        if (operation.cancel_requested) {
            if (operation.wayland_conversion_started) {
                operation.platform_cancel.store(true, .release);
                operation.mutex.unlock();
                return .pending;
            }
            operation.status = .cancelled;
            operation.mutex.unlock();
            return .cancelled;
        }
        const elapsed_ns = clipboard_clock.nowNs() - operation.started_ns;
        if (elapsed_ns >= @as(i128, operation.timeout_ms) * std.time.ns_per_ms) {
            if (operation.x11_write.mutation_dispatched) {
                if (operation.service.x11) |x11| x11.abandonMutationConfirmation(&operation.x11_write);
                operation.status = .timed_out;
                operation.mutex.unlock();
                return .timed_out;
            }
            if (operation.wayland_conversion_started) {
                operation.platform_cancel.store(true, .release);
                operation.mutex.unlock();
                return .pending;
            }
            operation.cleanupTransfer();
            operation.cleanupX11();
            operation.status = .timed_out;
            operation.mutex.unlock();
            return .timed_out;
        }
        operation.mutex.unlock();
        return operation.service.driveOperation(operation);
    }

    fn isReadyToDestroy(operation: *Operation) bool {
        operation.mutex.lock();
        const terminal = operation.status != .pending;
        operation.mutex.unlock();
        if (!terminal) return false;
        return operation.joinCompletedWorker();
    }

    fn joinCompletedWorker(operation: *Operation) bool {
        operation.mutex.lock();
        const thread = operation.thread orelse {
            operation.mutex.unlock();
            return true;
        };
        if (operation.wayland_conversion_started) {
            operation.mutex.unlock();
            return false;
        }
        operation.mutex.unlock();
        if (!tryJoinThread(thread)) return false;
        operation.mutex.lock();
        operation.thread = null;
        operation.mutex.unlock();
        return true;
    }

    fn deinit(operation: *Operation) void {
        std.debug.assert(operation.thread == null);
        if (operation.request.len > 0) operation.allocator.free(operation.request);
        if (operation.result.len > 0) operation.allocator.free(operation.result);
        if (operation.result_mime.len > 0) operation.allocator.free(operation.result_mime);
        operation.transfer_data.deinit(operation.allocator);
        operation.cleanupTransfer();
        operation.cleanupX11();
        operation.allocator.destroy(operation);
    }

    fn beginPlatformMutation(operation: *Operation) ?OperationStatus {
        operation.mutex.lock();
        defer operation.mutex.unlock();
        if (operation.platform_terminal_request) |requested| return requested;
        if (platformDeadlineExpired(operation, clipboard_clock.nowNs())) {
            operation.platform_terminal_request = .timed_out;
            operation.platform_cancel.store(true, .release);
            return .timed_out;
        }
        operation.platform_mutation_started.store(true, .release);
        return null;
    }

    fn cleanupTransfer(operation: *Operation) void {
        operation.releaseCoreFocus();
        operation.wayland_transfer_format = .direct;
        if (comptime builtin.os.tag != .linux) {
            operation.transfer_fd = null;
            return;
        }
        if (operation.transfer_fd) |fd| posix_io.close(fd);
        operation.transfer_fd = null;
    }

    fn resetWaylandConnectionState(operation: *Operation) void {
        operation.cleanupTransfer();
        operation.transfer_data.clearRetainingCapacity();
        if (operation.result_mime.len > 0) operation.allocator.free(operation.result_mime);
        operation.result_mime = &.{};
        operation.resetWaylandRetryState();
    }

    fn resetWaylandRetryState(operation: *Operation) void {
        operation.mechanism = null;
        operation.preference_offset = 4;
        operation.candidate_failed = false;
        operation.implemented_candidate_attempted = false;
        operation.wayland_connection_reset = false;
        operation.wayland_barrier_serial = 0;
        operation.wayland_stale_retry_count = 0;
    }

    fn releaseCoreFocus(operation: *Operation) void {
        if (!operation.wayland_core_focus_acquired) return;
        operation.wayland_core_focus_acquired = false;
        if (operation.service.wayland) |wayland| wayland.releaseCoreSelection();
    }

    fn rememberFailure(operation: *Operation, code: ErrorCode, diagnostic: []const u8) void {
        if (operation.error_code != 0) return;
        operation.error_code = @intFromEnum(code);
        operation.diagnostic = diagnostic;
    }

    fn cleanupX11(operation: *Operation) void {
        if (comptime builtin.os.tag != .linux) return;
        const x11 = operation.service.x11 orelse return;
        x11.cleanupRead(&operation.x11_read);
        x11.cleanupWrite(&operation.x11_write);
    }
};

fn wslOperationUnsupported(libraries: clipboard_linux.Libraries, operation: *const Operation) bool {
    return libraries.is_wsl and (operation.selection == .primary or operation.kind == .clear);
}

const Service = struct {
    allocator: Allocator,
    max_operations: u32 = OPERATIONS_MAX_DEFAULT,
    max_provider_transfers: u32 = PROVIDER_TRANSFERS_MAX_DEFAULT,
    libraries: clipboard_linux.Libraries,
    wayland: ?*clipboard_wayland.Connection = null,
    x11: ?*clipboard_x11.Connection = null,
    drain_mechanism: clipboard_linux.Mechanism = .wayland,
    wayland_drain_provider: bool = false,
    requested_wayland_seat: []u8,
    environment_wayland_seat: []u8,
    shutting_down: bool = false,
    next_mutation_sequence: u64 = 1,
    operations: std.ArrayListUnmanaged(*Operation) = .empty,
    platform_mutex: sync.Mutex = .{},
    platform_condition: sync.Condition = .{},
    platform_queue: std.ArrayListUnmanaged(*Operation) = .empty,
    platform_thread: ?std.Thread = null,
    platform_stop: bool = false,
    platform_exited: bool = false,
    platform_failed: bool = false,

    fn takeMutationSequence(service: *Service) u64 {
        const sequence = service.next_mutation_sequence;
        std.debug.assert(sequence != std.math.maxInt(u64));
        service.next_mutation_sequence += 1;
        return sequence;
    }

    fn removeOperation(service: *Service, operation: *Operation) void {
        for (service.operations.items, 0..) |candidate, index| {
            if (candidate == operation) {
                _ = service.operations.swapRemove(index);
                return;
            }
        }
        unreachable;
    }

    fn enqueuePlatformOperation(service: *Service, operation: *Operation) void {
        if (comptime builtin.os.tag != .windows and builtin.os.tag != .macos) return;
        service.platform_mutex.lock();
        if (service.platform_failed) {
            service.platform_mutex.unlock();
            operation.rememberFailure(.internal, "Native clipboard worker initialization failed");
            operation.status = .failed;
            return;
        }
        std.debug.assert(service.platform_queue.items.len < service.platform_queue.capacity);
        service.platform_queue.appendAssumeCapacity(operation);
        service.platform_condition.signal();
        service.platform_mutex.unlock();
    }

    fn wakePlatformWorker(service: *Service) void {
        if (comptime builtin.os.tag != .windows and builtin.os.tag != .macos) return;
        service.platform_mutex.lock();
        service.platform_condition.signal();
        service.platform_mutex.unlock();
    }

    fn completeQueuedPlatformOperation(
        service: *Service,
        operation: *Operation,
        status: OperationStatus,
    ) bool {
        if (comptime builtin.os.tag != .windows and builtin.os.tag != .macos and !builtin.is_test) return false;
        service.platform_mutex.lock();
        var found = false;
        for (service.platform_queue.items, 0..) |candidate, index| {
            if (candidate != operation) continue;
            _ = service.platform_queue.orderedRemove(index);
            found = true;
            break;
        }
        if (!found) {
            service.platform_mutex.unlock();
            return false;
        }

        operation.mutex.lock();
        if (operation.status == .pending) {
            operation.platform_terminal_request = status;
            operation.platform_cancel.store(true, .release);
            operation.status = status;
        }
        operation.mutex.unlock();
        service.platform_mutex.unlock();
        return true;
    }

    fn platformWorker(service: *Service) void {
        if (comptime builtin.os.tag == .windows) {
            var worker = clipboard_windows.Worker.init() catch {
                service.failPlatformWorker();
                return;
            };
            defer worker.deinit();
            service.platformWorkerLoop(&worker);
        } else if (comptime builtin.os.tag == .macos) {
            service.platformWorkerLoop({});
        } else unreachable;

        service.platform_mutex.lock();
        service.platform_exited = true;
        service.platform_mutex.unlock();
    }

    fn failPlatformWorker(service: *Service) void {
        service.platform_mutex.lock();
        service.platform_failed = true;
        while (service.platform_queue.items.len > 0) {
            const operation = service.platform_queue.orderedRemove(0);
            operation.mutex.lock();
            operation.rememberFailure(.internal, "Native clipboard worker initialization failed");
            operation.status = .failed;
            operation.mutex.unlock();
        }
        service.platform_exited = true;
        service.platform_mutex.unlock();
    }

    fn platformWorkerLoop(service: *Service, worker: anytype) void {
        while (true) {
            service.platform_mutex.lock();
            while (service.platform_queue.items.len == 0 and !service.platform_stop) {
                if (comptime builtin.os.tag == .windows) {
                    service.platform_condition.timedWait(&service.platform_mutex, 10 * std.time.ns_per_ms) catch {};
                    if (service.platform_queue.items.len == 0 and !service.platform_stop) {
                        service.platform_mutex.unlock();
                        _ = worker.pumpMessages();
                        service.platform_mutex.lock();
                    }
                } else {
                    service.platform_condition.wait(&service.platform_mutex);
                }
            }
            if (service.platform_queue.items.len == 0 and service.platform_stop) {
                service.platform_mutex.unlock();
                return;
            }
            const operation = service.platform_queue.orderedRemove(0);
            service.platform_mutex.unlock();
            if (comptime builtin.os.tag == .windows) _ = worker.pumpMessages();
            service.executePlatformOperation(worker, operation);
            if (comptime builtin.os.tag == .windows) _ = worker.pumpMessages();
        }
    }

    fn executePlatformOperation(service: *Service, worker: anytype, operation: *Operation) void {
        operation.mutex.lock();
        const now_ns = clipboard_clock.nowNs();
        const requested = operation.platform_terminal_request orelse
            if (platformDeadlineExpired(operation, now_ns)) OperationStatus.timed_out else null;
        operation.mutex.unlock();
        if (requested) |status| {
            service.publishPlatformResult(operation, status, &.{}, &.{}, 0);
            return;
        }
        if (comptime builtin.os.tag == .windows) {
            if (operation.selection == .primary) {
                service.publishPlatformResult(operation, .unsupported, &.{}, &.{}, 0);
                return;
            }
        }

        if (comptime builtin.os.tag == .windows) {
            const job: clipboard_windows.Job = switch (operation.kind) {
                .read => .{ .read = .{
                    .request = operation.request,
                    .max_bytes = operation.max_bytes,
                    .max_image_pixels = operation.max_image_pixels,
                    .max_conversion_bytes = operation.max_conversion_bytes,
                } },
                .write => .{ .write = operation.request },
                .clear => .clear,
            };
            var result = worker.execute(service.allocator, job, .{
                .cancel_requested = &operation.platform_cancel,
                .begin_mutation = beginWindowsPlatformMutation,
                .mutation_context = operation,
                .deadline_ns = operation.started_ns + @as(i128, operation.timeout_ms) * std.time.ns_per_ms,
            });
            defer result.deinit(service.allocator);
            const status: OperationStatus = switch (result.status) {
                .read => .read,
                .empty => .empty,
                .written => .written,
                .cleared => .cleared,
                .unsupported => .unsupported,
                .cancelled => .cancelled,
                .timed_out => .timed_out,
                .limit_exceeded => .limit_exceeded,
                .invalid_request, .failed => .failed,
            };
            service.publishPlatformResult(operation, status, result.mime, result.data, result.error_code);
        } else if (comptime builtin.os.tag == .macos) {
            if (operation.selection == .primary) {
                service.publishPlatformResult(operation, .unsupported, &.{}, &.{}, 0);
                return;
            }
            const job: clipboard_macos.Job = switch (operation.kind) {
                .read => .{ .read = .{
                    .request = operation.request,
                    .max_bytes = operation.max_bytes,
                    .max_image_pixels = operation.max_image_pixels,
                    .max_conversion_bytes = operation.max_conversion_bytes,
                } },
                .write => .{ .write_text = .{ .text = operation.request } },
                .clear => .clear,
            };
            var result = clipboard_macos.runJob(service.allocator, job, .{
                .cancel_requested = &operation.platform_cancel,
                .begin_mutation = beginMacOSPlatformMutation,
                .mutation_context = operation,
                .deadline_ns = operation.started_ns + @as(i128, operation.timeout_ms) * std.time.ns_per_ms,
            }) catch |err| {
                const status: OperationStatus = if (err == error.LimitExceeded) .limit_exceeded else .failed;
                service.publishPlatformResult(operation, status, &.{}, &.{}, 0);
                return;
            };
            defer result.deinit(service.allocator);
            switch (result) {
                .read => |read| service.publishPlatformResult(operation, .read, read.mime.name(), read.data, 0),
                .empty => service.publishPlatformResult(operation, .empty, &.{}, &.{}, 0),
                .written => service.publishPlatformResult(operation, .written, &.{}, &.{}, 0),
                .cleared => service.publishPlatformResult(operation, .cleared, &.{}, &.{}, 0),
                .unsupported => service.publishPlatformResult(operation, .unsupported, &.{}, &.{}, 0),
                .cancelled => service.publishPlatformResult(operation, .cancelled, &.{}, &.{}, 0),
                .timed_out => service.publishPlatformResult(operation, .timed_out, &.{}, &.{}, 0),
                .failed => service.publishPlatformResult(operation, .failed, &.{}, &.{}, 0),
            }
        } else unreachable;
    }

    fn publishPlatformResult(
        service: *Service,
        operation: *Operation,
        platform_status: OperationStatus,
        mime: []const u8,
        data: []const u8,
        error_code: u32,
    ) void {
        service.publishPlatformResultAt(operation, platform_status, mime, data, error_code, clipboard_clock.nowNs());
    }

    fn publishPlatformResultAt(
        service: *Service,
        operation: *Operation,
        platform_status: OperationStatus,
        mime: []const u8,
        data: []const u8,
        error_code: u32,
        now_ns: i128,
    ) void {
        operation.mutex.lock();
        defer operation.mutex.unlock();
        var status = resolvePlatformStatus(operation, platform_status, now_ns);
        if (status == .read) {
            operation.result_mime = service.allocator.dupe(u8, mime) catch {
                status = .failed;
                operation.rememberFailure(.out_of_memory, "Failed to allocate native clipboard MIME result");
                operation.status = status;
                return;
            };
            operation.result = service.allocator.dupe(u8, data) catch blk: {
                service.allocator.free(operation.result_mime);
                operation.result_mime = &.{};
                status = .failed;
                operation.rememberFailure(.out_of_memory, "Failed to allocate native clipboard result");
                break :blk &.{};
            };
        }
        if (status == .failed) {
            if (operation.error_code == 0) {
                operation.error_code = if (error_code != 0) error_code else @intFromEnum(ErrorCode.internal);
            }
            if (operation.diagnostic.len == 0) operation.diagnostic = "Native platform clipboard operation failed";
        }
        operation.status = status;
    }

    fn beginShutdown(service: *Service) void {
        if (service.shutting_down) return;
        service.shutting_down = true;
        for (service.operations.items) |operation| {
            _ = operation.requestCancel();
        }
        if (comptime builtin.os.tag == .linux) {
            if (service.x11) |x11| x11.requestShutdown();
            if (service.wayland) |wayland| wayland.releaseProviders();
            if (service.x11) |x11| x11.releaseProviders();
        }
        if (comptime builtin.os.tag == .windows or builtin.os.tag == .macos) {
            service.platform_mutex.lock();
            service.platform_stop = true;
            service.platform_condition.signal();
            service.platform_mutex.unlock();
        }
    }

    fn pollShutdown(service: *Service) ShutdownStatus {
        if (!service.shutting_down) return .pending;
        for (service.operations.items) |operation| {
            if (!operation.isReadyToDestroy()) return .pending;
        }
        if (comptime builtin.os.tag == .windows or builtin.os.tag == .macos) {
            service.platform_mutex.lock();
            const exited = service.platform_exited;
            service.platform_mutex.unlock();
            if (!exited) return .pending;
            if (service.platform_thread) |thread| {
                if (comptime builtin.os.tag == .macos) {
                    // The worker publishes exited immediately before returning; Mach does not
                    // reliably expose terminated pthreads as TH_STATE_HALTED.
                    thread.join();
                } else if (!tryJoinThread(thread)) return .pending;
                service.platform_thread = null;
            }
        }
        if (comptime builtin.os.tag == .linux) {
            if (service.x11) |x11| if (!x11.shutdownReady()) return .pending;
        }
        return .ready;
    }

    fn deinit(service: *Service) void {
        for (service.operations.items) |operation| {
            std.debug.assert(operation.thread == null);
            handles.invalidate(operation.handle, .clipboard_operation);
            operation.deinit();
        }
        service.operations.deinit(service.allocator);
        service.platform_queue.deinit(service.allocator);
        if (comptime builtin.os.tag == .linux) {
            if (service.wayland) |wayland| {
                wayland.deinit();
                service.allocator.destroy(wayland);
            }
            if (service.x11) |x11| {
                x11.deinit();
                service.allocator.destroy(x11);
            }
        }
        if (service.requested_wayland_seat.len > 0) service.allocator.free(service.requested_wayland_seat);
        if (service.environment_wayland_seat.len > 0) service.allocator.free(service.environment_wayland_seat);
        service.allocator.destroy(service);
    }

    fn driveOperation(service: *Service, operation: *Operation) OperationStatus {
        if (comptime builtin.os.tag == .windows or builtin.os.tag == .macos) {
            return operation.status;
        }
        if (comptime builtin.os.tag != .linux) return service.finishOperation(operation, .unsupported);
        if (operation.kind == .read and !implementsNativeReadType(operation.request)) {
            return service.finishOperation(operation, .unsupported);
        }
        const libraries = service.libraries;
        if (wslOperationUnsupported(libraries, operation)) {
            return service.finishOperation(operation, .unsupported);
        }
        operation.mechanism = operation.mechanism orelse if (libraries.wayland)
            .wayland
        else if (libraries.x11)
            .x11
        else
            return service.finishOperation(operation, .unsupported);
        return switch (operation.mechanism.?) {
            .wayland => service.driveWayland(operation, libraries),
            .x11 => service.driveX11(operation),
        };
    }

    fn driveWayland(
        service: *Service,
        operation: *Operation,
        libraries: clipboard_linux.Libraries,
    ) OperationStatus {
        if (service.wayland == null) {
            const symbols = clipboard_linux.waylandSymbols() orelse
                return service.fallbackWayland(operation, libraries);
            const wayland = service.allocator.create(clipboard_wayland.Connection) catch {
                operation.rememberFailure(.out_of_memory, "Failed to allocate Wayland clipboard connection");
                return service.finishOperation(operation, .failed);
            };
            wayland.* = clipboard_wayland.Connection.init(
                service.allocator,
                symbols,
                service.requested_wayland_seat,
                service.environment_wayland_seat,
                service.max_provider_transfers,
            );
            wayland.allow_core_data_device = libraries.is_wsl;
            service.wayland = wayland;
        }
        return switch (service.wayland.?.drive()) {
            .pending => .pending,
            .ready => service.driveWaylandOperation(operation),
            .unsupported => service.fallbackWayland(operation, libraries),
            .failed => service.finishWaylandFailure(operation),
        };
    }

    fn fallbackWayland(
        service: *Service,
        operation: *Operation,
        libraries: clipboard_linux.Libraries,
    ) OperationStatus {
        if (!libraries.x11) return service.finishOperation(operation, .unsupported);
        operation.cleanupTransfer();
        operation.mechanism = .x11;
        operation.preference_offset = 4;
        operation.candidate_failed = false;
        operation.implemented_candidate_attempted = false;
        return .pending;
    }

    fn ensureX11(service: *Service, operation: *Operation) ?OperationStatus {
        if (service.x11 == null) {
            const symbols = clipboard_linux.xcbSymbols() orelse
                return service.finishOperation(operation, .unsupported);
            const x11 = service.allocator.create(clipboard_x11.Connection) catch {
                operation.rememberFailure(.out_of_memory, "Failed to allocate X11 clipboard connection");
                return service.finishOperation(operation, .failed);
            };
            x11.* = clipboard_x11.Connection.init(service.allocator, symbols, service.max_provider_transfers);
            service.x11 = x11;
        }
        return switch (service.x11.?.drive()) {
            .pending => .pending,
            .ready => null,
            .unsupported => service.finishOperation(operation, .unsupported),
            .failed => service.finishX11Failure(operation),
        };
    }

    fn driveX11(service: *Service, operation: *Operation) OperationStatus {
        if (service.ensureX11(operation)) |status| return status;
        service.driveX11EventUnit();
        return switch (operation.kind) {
            .read => service.driveX11Read(operation),
            .write => service.driveX11Write(operation),
            .clear => service.driveX11Clear(operation),
        };
    }

    fn driveWaylandOperation(service: *Service, operation: *Operation) OperationStatus {
        if (comptime builtin.os.tag != .linux) return service.finishOperation(operation, .unsupported);
        return switch (operation.kind) {
            .read => service.driveWaylandRead(operation),
            .write => service.driveWaylandWrite(operation),
            .clear => service.driveWaylandClear(operation),
        };
    }

    fn driveWaylandWrite(service: *Service, operation: *Operation) OperationStatus {
        if (comptime builtin.os.tag != .linux) return service.finishOperation(operation, .unsupported);
        if (service.hasEarlierSelectionMutation(operation)) return .pending;
        const result = service.wayland.?.publishText(operation.selection == .primary, operation.request);
        switch (result) {
            .ok, .committed => std.debug.assert(result == .ok or result == .committed),
            .pending => unreachable,
            .unsupported => return service.fallbackCurrentWayland(operation),
            .failed => return service.finishWaylandFailure(operation),
        }
        operation.request = &.{};
        return service.finishOperation(operation, .written);
    }

    fn driveWaylandClear(service: *Service, operation: *Operation) OperationStatus {
        if (comptime builtin.os.tag != .linux) return service.finishOperation(operation, .unsupported);
        if (service.hasEarlierSelectionMutation(operation)) return .pending;
        const result = service.wayland.?.clearSelection(operation.selection == .primary);
        switch (result) {
            .ok, .committed => std.debug.assert(result == .ok or result == .committed),
            .pending => unreachable,
            .unsupported => return service.fallbackCurrentWayland(operation),
            .failed => return service.finishWaylandFailure(operation),
        }
        return service.finishOperation(operation, .cleared);
    }

    fn driveWaylandRead(service: *Service, operation: *Operation) OperationStatus {
        if (comptime builtin.os.tag != .linux) return service.finishOperation(operation, .unsupported);
        if (operation.transfer_fd) |fd| {
            var buffer: [64 * 1024]u8 = undefined;
            const count = std.posix.read(fd, &buffer) catch |err| switch (err) {
                error.WouldBlock => return .pending,
                else => {
                    operation.rememberFailure(.wayland_transfer, "Wayland clipboard transfer read failed");
                    operation.cleanupTransfer();
                    operation.candidate_failed = true;
                    if (operation.result_mime.len > 0) operation.allocator.free(operation.result_mime);
                    operation.result_mime = &.{};
                    operation.transfer_data.clearRetainingCapacity();
                    return .pending;
                },
            };
            if (count == 0) {
                const transfer_format = operation.wayland_transfer_format;
                operation.cleanupTransfer();
                // Zero-byte text is valid clipboard content and stays a successful
                // read, matching the macOS and X11 backends. Zero-byte image data
                // is invalid and means the offer's source vanished mid-read, so
                // only image candidates retry. Wayland cannot distinguish empty
                // text from a vanished source; on compositors that skip the nil
                // selection update after a clear (Hyprland 0.55), a cleared
                // clipboard reads as zero-byte text instead of empty.
                const empty_image = operation.transfer_data.items.len == 0 and
                    !std.ascii.eqlIgnoreCase(operation.result_mime, "text/plain");
                if (empty_image) return service.retryStaleWaylandRead(operation);
                return service.completeWaylandRead(operation, transfer_format);
            }
            const transfer_limit: usize = @intCast(switch (operation.wayland_transfer_format) {
                .direct => operation.max_bytes,
                .bmp_to_png => operation.max_conversion_bytes,
            });
            if (count > transfer_limit -| operation.transfer_data.items.len) {
                operation.cleanupTransfer();
                return service.finishOperation(operation, .limit_exceeded);
            }
            operation.transfer_data.appendSlice(operation.allocator, buffer[0..count]) catch {
                operation.cleanupTransfer();
                operation.rememberFailure(.out_of_memory, "Failed to grow Wayland clipboard result");
                return service.finishOperation(operation, .failed);
            };
            return .pending;
        }

        const primary = operation.selection == .primary;
        if (primary and !service.wayland.?.primary_supported) {
            return service.fallbackCurrentWayland(operation);
        }
        if (service.wayland.?.usesCoreDataDevice()) {
            if (!operation.wayland_core_focus_acquired) {
                const acquired = service.wayland.?.acquireCoreSelection();
                switch (acquired) {
                    .pending => {},
                    .ready => unreachable,
                    .unsupported => return service.fallbackCurrentWayland(operation),
                    .failed => return service.finishWaylandFailure(operation),
                }
                operation.wayland_core_focus_acquired = true;
            }
            switch (service.wayland.?.coreSelectionProgress()) {
                .pending => return .pending,
                .ready => {},
                .unsupported => return service.fallbackCurrentWayland(operation),
                .failed => return service.finishWaylandFailure(operation),
            }
        }
        // Order every read after selection events emitted before its admission.
        if (operation.wayland_barrier_serial == 0) {
            operation.wayland_barrier_serial = service.wayland.?.requestSelectionBarrier() orelse
                return service.finishWaylandFailure(operation);
        }
        if (!service.wayland.?.selectionBarrierReached(operation.wayland_barrier_serial)) {
            return .pending;
        }
        const offer = service.wayland.?.currentOffer(primary) orelse {
            operation.releaseCoreFocus();
            return service.finishOperation(operation, .empty);
        };
        var implemented = false;
        var offset = operation.preference_offset;
        while (offset < operation.request.len) {
            const length = std.mem.readInt(u32, operation.request[offset..][0..4], .little);
            offset += 4;
            const preferred = operation.request[offset .. offset + length];
            offset += length;
            operation.preference_offset = offset;
            const preferred_essence = clipboard_wayland.canonicalMimeEssence(preferred) orelse continue;
            if (!std.ascii.eqlIgnoreCase(preferred_essence, "text/plain") and
                !isEncodedImageMime(preferred_essence)) continue;
            implemented = true;
            operation.implemented_candidate_attempted = true;
            const match = service.wayland.?.offeredMime(offer, preferred) orelse continue;
            return service.beginWaylandRead(operation, offer, match.requested, match.offered);
        }
        operation.releaseCoreFocus();
        return service.finishOperation(operation, waylandReadExhaustionStatus(
            implemented or operation.implemented_candidate_attempted,
            operation.candidate_failed,
        ));
    }

    // A zero-byte image transfer means the offer's source vanished, usually
    // because the selection changed after the offer was chosen. Restart candidate
    // selection behind a fresh barrier a bounded number of times; afterwards the
    // preference loop finishes the read as empty.
    fn retryStaleWaylandRead(_: *Service, operation: *Operation) OperationStatus {
        operation.implemented_candidate_attempted = true;
        if (operation.result_mime.len > 0) operation.allocator.free(operation.result_mime);
        operation.result_mime = &.{};
        operation.transfer_data.clearRetainingCapacity();
        if (operation.wayland_stale_retry_count < WAYLAND_READ_STALE_RETRY_MAX) {
            operation.wayland_stale_retry_count += 1;
            operation.wayland_barrier_serial = 0;
            operation.preference_offset = 4;
        }
        return .pending;
    }

    fn completeWaylandRead(
        service: *Service,
        operation: *Operation,
        transfer_format: WaylandTransferFormat,
    ) OperationStatus {
        if (transfer_format == .direct) {
            operation.result = operation.transfer_data.toOwnedSlice(operation.allocator) catch {
                operation.rememberFailure(.out_of_memory, "Failed to allocate Wayland clipboard result");
                return service.finishOperation(operation, .failed);
            };
            return service.finishOperation(operation, .read);
        }

        operation.wayland_conversion_started = true;
        operation.thread = std.Thread.spawn(.{}, Operation.waylandBmpWorker, .{operation}) catch {
            operation.wayland_conversion_started = false;
            operation.rememberFailure(.internal, "Failed to start Wayland BMP conversion worker");
            return service.finishOperation(operation, .failed);
        };
        return .pending;
    }

    fn implementsNativeReadType(request: []const u8) bool {
        var offset: usize = 4;
        while (offset < request.len) {
            const length = std.mem.readInt(u32, request[offset..][0..4], .little);
            offset += 4;
            const preferred = request[offset .. offset + length];
            offset += length;
            const essence = clipboard_wayland.canonicalMimeEssence(preferred) orelse continue;
            if (std.ascii.eqlIgnoreCase(essence, "text/plain") or isEncodedImageMime(essence)) return true;
        }
        return false;
    }

    fn beginWaylandRead(
        service: *Service,
        operation: *Operation,
        offer: *const clipboard_wayland.Offer,
        preferred: []const u8,
        offered: []const u8,
    ) OperationStatus {
        if (comptime builtin.os.tag != .linux) return service.finishOperation(operation, .unsupported);
        const pipe = posix_io.pipe(.{ .CLOEXEC = true }) catch {
            operation.rememberFailure(.wayland_transfer, "Failed to create Wayland clipboard transfer pipe");
            return service.rememberWaylandReadFailure(operation);
        };
        // Keep the transferred write end blocking; only the locally polled read end may return WouldBlock.
        const flags = posix_io.getFlags(pipe[0]) catch {
            posix_io.close(pipe[0]);
            posix_io.close(pipe[1]);
            operation.rememberFailure(.wayland_transfer, "Failed to configure Wayland clipboard transfer pipe");
            return service.rememberWaylandReadFailure(operation);
        };
        const nonblocking: u32 = @bitCast(std.posix.O{ .NONBLOCK = true });
        posix_io.setFlags(pipe[0], flags | nonblocking) catch {
            posix_io.close(pipe[0]);
            posix_io.close(pipe[1]);
            operation.rememberFailure(.wayland_transfer, "Failed to configure Wayland clipboard transfer pipe");
            return service.rememberWaylandReadFailure(operation);
        };
        const requested = service.wayland.?.receive(offer, offered, pipe[1]);
        posix_io.close(pipe[1]);
        if (!requested) {
            posix_io.close(pipe[0]);
            operation.rememberFailure(.wayland_flush, "Failed to request Wayland clipboard transfer");
            return service.rememberWaylandReadFailure(operation);
        }
        operation.releaseCoreFocus();
        operation.result_mime = operation.allocator.dupe(u8, preferred) catch {
            posix_io.close(pipe[0]);
            operation.rememberFailure(.out_of_memory, "Failed to allocate Wayland clipboard MIME result");
            return service.rememberWaylandReadFailure(operation);
        };
        operation.wayland_transfer_format = waylandTransferFormat(preferred, offered);
        operation.transfer_fd = pipe[0];
        return .pending;
    }

    fn isEncodedImageMime(mime: []const u8) bool {
        return std.ascii.eqlIgnoreCase(mime, "image/png") or
            std.ascii.eqlIgnoreCase(mime, "image/jpeg") or
            std.ascii.eqlIgnoreCase(mime, "image/webp") or
            std.ascii.eqlIgnoreCase(mime, "image/gif");
    }

    fn rememberWaylandReadFailure(_: *Service, operation: *Operation) OperationStatus {
        operation.candidate_failed = true;
        return .pending;
    }

    fn fallbackCurrentWayland(service: *Service, operation: *Operation) OperationStatus {
        return service.fallbackWayland(operation, service.libraries);
    }

    fn driveX11EventUnit(service: *Service) void {
        const x11 = service.x11 orelse return;
        const event = x11.pollEvent() orelse return;
        defer std.c.free(event);
        if (x11.consumeRetiredTimestampEvent(event)) return;
        for (service.operations.items) |candidate| {
            if (candidate.mechanism != .x11) continue;
            if (candidate.kind == .read and x11.routeReadEvent(&candidate.x11_read, event)) return;
            if (candidate.kind != .write and candidate.kind != .clear) continue;
            candidate.mutex.lock();
            if (candidate.status != .pending) {
                candidate.mutex.unlock();
                continue;
            }
            if (x11.isMutationTimestampEvent(&candidate.x11_write, event)) {
                const terminal: ?OperationStatus = if (candidate.cancel_requested)
                    .cancelled
                else if (platformDeadlineExpired(candidate, clipboard_clock.nowNs()))
                    .timed_out
                else
                    null;
                if (terminal) |status| {
                    candidate.cleanupX11();
                    candidate.status = status;
                    candidate.mutex.unlock();
                    _ = x11.consumeRetiredTimestampEvent(event);
                    return;
                }
            }
            const routed = x11.routeWriteEvent(&candidate.x11_write, event);
            if (routed and candidate.kind == .write and candidate.x11_write.mutation_dispatched) {
                candidate.request = &.{};
            }
            if (routed and candidate.x11_write.committed) {
                candidate.status = if (candidate.kind == .write) .written else .cleared;
            }
            candidate.mutex.unlock();
            if (routed) return;
        }
        x11.handleProviderEvent(event);
    }

    fn driveX11Read(service: *Service, operation: *Operation) OperationStatus {
        const x11 = service.x11.?;
        switch (x11.driveRead(&operation.x11_read, &operation.transfer_data, operation.max_bytes)) {
            .pending => {
                if (operation.x11_read.phase != .idle) return .pending;
            },
            .ready => {
                const empty_png = operation.result_mime.len > 0 and
                    std.ascii.eqlIgnoreCase(operation.result_mime, "image/png") and
                    operation.transfer_data.items.len == 0;
                if (!empty_png) {
                    operation.result = operation.transfer_data.toOwnedSlice(operation.allocator) catch {
                        x11.cleanupRead(&operation.x11_read);
                        operation.rememberFailure(.out_of_memory, "Failed to allocate X11 clipboard result");
                        return service.finishOperation(operation, .failed);
                    };
                    x11.cleanupRead(&operation.x11_read);
                    return service.finishOperation(operation, .read);
                }
                x11.cleanupRead(&operation.x11_read);
                operation.transfer_data.clearRetainingCapacity();
                operation.x11_target_index = operation.x11_target_count;
            },
            .refused => {
                x11.cleanupRead(&operation.x11_read);
                operation.x11_target_index += 1;
            },
            .limit_exceeded => {
                x11.cleanupRead(&operation.x11_read);
                return service.finishOperation(operation, .limit_exceeded);
            },
            .candidate_failed => {
                x11.cleanupRead(&operation.x11_read);
                operation.rememberFailure(.x11_transfer, "X11 clipboard property transfer failed");
                operation.candidate_failed = true;
                operation.transfer_data.clearRetainingCapacity();
                operation.x11_target_index += 1;
                return .pending;
            },
            .out_of_memory => {
                x11.cleanupRead(&operation.x11_read);
                operation.error_code = @intFromEnum(ErrorCode.out_of_memory);
                operation.diagnostic = "Failed to allocate X11 clipboard result";
                return service.finishOperation(operation, .failed);
            },
            .failed => {
                x11.cleanupRead(&operation.x11_read);
                return service.finishX11Failure(operation);
            },
        }

        while (true) {
            if (operation.x11_target_index < operation.x11_target_count) {
                operation.x11_read.phase = .refused;
                if (!x11.beginRead(
                    &operation.x11_read,
                    operation.selection == .primary,
                    operation.x11_targets[operation.x11_target_index],
                    operation.max_bytes,
                )) {
                    x11.cleanupRead(&operation.x11_read);
                    operation.rememberFailure(.x11_flush, "Failed to request X11 clipboard conversion");
                    return service.finishOperation(operation, .failed);
                }
                return .pending;
            }
            if (operation.result_mime.len > 0) {
                operation.allocator.free(operation.result_mime);
                operation.result_mime = &.{};
            }
            if (operation.preference_offset >= operation.request.len) {
                x11.cleanupRead(&operation.x11_read);
                return service.finishOperation(
                    operation,
                    if (operation.candidate_failed)
                        .failed
                    else if (operation.implemented_candidate_attempted)
                        .empty
                    else
                        .unsupported,
                );
            }
            const length = std.mem.readInt(u32, operation.request[operation.preference_offset..][0..4], .little);
            operation.preference_offset += 4;
            const preferred = operation.request[operation.preference_offset .. operation.preference_offset + length];
            operation.preference_offset += length;
            const targets = x11.targetAtoms(preferred, &operation.x11_targets);
            if (targets.len == 0) continue;
            operation.implemented_candidate_attempted = true;
            operation.result_mime = operation.allocator.dupe(u8, preferred) catch {
                x11.cleanupRead(&operation.x11_read);
                operation.rememberFailure(.out_of_memory, "Failed to allocate X11 clipboard MIME result");
                return service.finishOperation(operation, .failed);
            };
            operation.x11_target_count = @intCast(targets.len);
            operation.x11_target_index = 0;
        }
    }

    fn driveX11Write(service: *Service, operation: *Operation) OperationStatus {
        const x11 = service.x11.?;
        if (service.hasEarlierSelectionMutation(operation)) return .pending;
        if (operation.x11_write.selection == 0 and !operation.x11_write.committed and !operation.x11_write.failed) {
            return switch (x11.beginWrite(
                &operation.x11_write,
                operation.selection == .primary,
                operation.request,
            )) {
                .pending => .pending,
                .unsupported => service.finishOperation(operation, .unsupported),
                .failed => service.finishX11Failure(operation),
                .ok, .committed => unreachable,
            };
        }
        return switch (x11.driveWrite(&operation.x11_write)) {
            .pending => .pending,
            .ok, .committed => blk: {
                operation.request = &.{};
                break :blk service.finishOperation(operation, .written);
            },
            .unsupported => service.finishOperation(operation, .unsupported),
            .failed => service.finishX11Failure(operation),
        };
    }

    fn driveX11Clear(service: *Service, operation: *Operation) OperationStatus {
        const x11 = service.x11.?;
        if (service.hasEarlierSelectionMutation(operation)) return .pending;
        if (operation.x11_write.selection == 0 and !operation.x11_write.committed and !operation.x11_write.failed) {
            return switch (x11.beginClear(&operation.x11_write, operation.selection == .primary)) {
                .pending => .pending,
                .unsupported => service.finishOperation(operation, .unsupported),
                .failed => service.finishX11Failure(operation),
                .ok, .committed => unreachable,
            };
        }
        return switch (x11.driveWrite(&operation.x11_write)) {
            .pending => .pending,
            .ok, .committed => service.finishOperation(operation, .cleared),
            .unsupported => service.finishOperation(operation, .unsupported),
            .failed => service.finishX11Failure(operation),
        };
    }

    fn finishX11Failure(service: *Service, operation: *Operation) OperationStatus {
        const failure = if (service.x11) |x11| x11.takeFailure() else .protocol;
        switch (failure) {
            .none, .connection, .protocol, .atom => operation.rememberFailure(.x11_protocol, "X11 clipboard protocol failed"),
            .flush => operation.rememberFailure(.x11_flush, "X11 clipboard output flush failed"),
            .provider => operation.rememberFailure(.x11_provider, "X11 clipboard provider failed"),
        }
        operation.cleanupX11();
        return service.finishOperation(operation, .failed);
    }

    fn hasEarlierSelectionMutation(service: *const Service, operation: *const Operation) bool {
        for (service.operations.items) |candidate| {
            if (candidate.kind != .write and candidate.kind != .clear) continue;
            if (candidate.selection != operation.selection) continue;
            candidate.mutex.lock();
            const pending = candidate.status == .pending;
            candidate.mutex.unlock();
            if (!pending) continue;
            if (candidate.mutation_sequence < operation.mutation_sequence) return true;
        }
        return false;
    }

    fn finishOperation(_: *Service, operation: *Operation, status: OperationStatus) OperationStatus {
        if (status == .failed and operation.error_code == 0) {
            operation.rememberFailure(.internal, "Native clipboard operation failed");
        }
        operation.mutex.lock();
        defer operation.mutex.unlock();
        if (operation.status == .pending) operation.status = status;
        return operation.status;
    }

    fn finishWaylandFailure(service: *Service, operation: *Operation) OperationStatus {
        const failed_connection = if (service.wayland) |wayland| wayland.isFailed() else false;
        const failure = service.takeWaylandFailure();
        rememberWaylandFailure(operation, failure);
        operation.cleanupTransfer();
        if (failed_connection) service.resetWayland();
        return service.finishOperation(operation, .failed);
    }

    fn takeWaylandFailure(service: *Service) clipboard_wayland.Failure {
        return if (service.wayland) |wayland| wayland.takeFailure() else .protocol;
    }

    fn resetWayland(service: *Service) void {
        const wayland = service.wayland orelse return;
        for (service.operations.items) |operation| {
            operation.mutex.lock();
            defer operation.mutex.unlock();
            if (operation.status != .pending or operation.mechanism != .wayland) continue;
            if (operation.wayland_conversion_started) {
                operation.wayland_connection_reset = true;
                continue;
            }
            operation.resetWaylandConnectionState();
        }
        wayland.deinit();
        service.allocator.destroy(wayland);
        service.wayland = null;
        service.wayland_drain_provider = false;
    }

    fn rememberWaylandFailure(operation: *Operation, failure: clipboard_wayland.Failure) void {
        switch (failure) {
            .none, .protocol => operation.rememberFailure(.wayland_protocol, "Wayland clipboard protocol failed"),
            .dispatch => operation.rememberFailure(.wayland_dispatch, "Wayland clipboard event dispatch failed"),
            .flush => operation.rememberFailure(.wayland_flush, "Wayland clipboard output flush failed"),
            .provider => operation.rememberFailure(.wayland_provider, "Wayland clipboard provider publication failed"),
        }
    }
};

fn platformDeadlineExpired(operation: *const Operation, now_ns: i128) bool {
    return now_ns - operation.started_ns >= @as(i128, operation.timeout_ms) * std.time.ns_per_ms;
}

fn beginWindowsPlatformMutation(context: ?*anyopaque) ?clipboard_windows.Status {
    const operation: *Operation = @ptrCast(@alignCast(context orelse return .invalid_request));
    const status = operation.beginPlatformMutation() orelse return null;
    return switch (status) {
        .cancelled => .cancelled,
        .timed_out => .timed_out,
        else => .failed,
    };
}

fn beginMacOSPlatformMutation(context: ?*anyopaque) ?clipboard_macos.Status {
    const operation: *Operation = @ptrCast(@alignCast(context orelse return .failed));
    const status = operation.beginPlatformMutation() orelse return null;
    return switch (status) {
        .cancelled => .cancelled,
        .timed_out => .timed_out,
        else => .failed,
    };
}

fn resolvePlatformStatus(
    operation: *const Operation,
    platform_status: OperationStatus,
    now_ns: i128,
) OperationStatus {
    if ((platform_status == .written or platform_status == .cleared) and
        operation.platform_mutation_started.load(.acquire)) return platform_status;
    if (operation.platform_terminal_request) |requested| return requested;
    if (!operation.platform_mutation_started.load(.acquire) and platformDeadlineExpired(operation, now_ns)) return .timed_out;
    return platform_status;
}

fn waylandReadExhaustionStatus(implemented: bool, failed: bool) OperationStatus {
    if (failed) return .failed;
    return if (implemented) .empty else .unsupported;
}

fn waylandTransferFormat(preferred: []const u8, offered: []const u8) WaylandTransferFormat {
    const preferred_essence = clipboard_wayland.canonicalMimeEssence(preferred) orelse return .direct;
    const offered_essence = clipboard_wayland.canonicalMimeEssence(offered) orelse return .direct;
    if (std.ascii.eqlIgnoreCase(preferred_essence, "image/png") and
        std.ascii.eqlIgnoreCase(offered_essence, "image/bmp")) return .bmp_to_png;
    return .direct;
}

fn erasePtr(pointer: anytype) *anyopaque {
    return @ptrCast(pointer);
}

fn acquireService(handle: Handle) ?*Service {
    return handles.acquire(handle, .clipboard_service, Service);
}

fn acquireOperation(handle: Handle) ?*Operation {
    return handles.acquire(handle, .clipboard_operation, Operation);
}

fn sliceFromPointer(pointer: ?[*]const u8, length: u32) ?[]const u8 {
    if (length == 0) return "";
    const valid_pointer = pointer orelse return null;
    return valid_pointer[0..@as(usize, length)];
}

pub fn createService(
    allocator: Allocator,
    max_operations: u32,
    max_provider_transfers: u32,
    wayland_seat_pointer: ?[*]const u8,
    wayland_seat_length: u32,
) Handle {
    if (max_operations == 0 or max_provider_transfers == 0) return 0;
    const configured_seat = sliceFromPointer(wayland_seat_pointer, wayland_seat_length) orelse return 0;
    clipboard_clock.init() catch return 0;
    var requested_wayland_seat: []u8 = &.{};
    var environment_wayland_seat: []u8 = &.{};
    const libraries: clipboard_linux.Libraries = switch (builtin.os.tag) {
        .linux => blk: {
            if (configured_seat.len > 0) {
                requested_wayland_seat = allocator.dupe(u8, configured_seat) catch return 0;
            } else if (posix_io.getEnv("XDG_SEAT")) |seat| {
                if (seat.len > 0) environment_wayland_seat = allocator.dupe(u8, seat) catch return 0;
            }
            break :blk clipboard_linux.initialize(clipboard_linux.Environment.detectProcess());
        },
        else => .{},
    };
    const service = allocator.create(Service) catch {
        if (requested_wayland_seat.len > 0) allocator.free(requested_wayland_seat);
        if (environment_wayland_seat.len > 0) allocator.free(environment_wayland_seat);
        return 0;
    };
    service.* = .{
        .allocator = allocator,
        .max_operations = max_operations,
        .max_provider_transfers = max_provider_transfers,
        .libraries = libraries,
        .requested_wayland_seat = requested_wayland_seat,
        .environment_wayland_seat = environment_wayland_seat,
    };
    if (comptime builtin.os.tag == .windows or builtin.os.tag == .macos) {
        service.platform_queue.ensureTotalCapacity(allocator, max_operations) catch {
            service.deinit();
            return 0;
        };
    }
    const service_handle = handles.insert(.clipboard_service, erasePtr(service)) catch {
        service.deinit();
        return 0;
    };
    if (comptime builtin.os.tag == .windows or builtin.os.tag == .macos) {
        service.platform_thread = std.Thread.spawn(.{}, Service.platformWorker, .{service}) catch {
            handles.invalidate(service_handle, .clipboard_service);
            service.deinit();
            return 0;
        };
    }
    return service_handle;
}

fn parseSelection(value: u8) ?Selection {
    return std.enums.fromInt(Selection, value);
}

fn validateReadRequest(request: []const u8) bool {
    if (request.len < @sizeOf(u32)) return false;
    const count = std.mem.readInt(u32, request[0..4], .little);
    if (count == 0 or count > READ_MIME_COUNT_MAX) return false;

    var offset: usize = 4;
    var index: u32 = 0;
    while (index < count) : (index += 1) {
        if (request.len - offset < @sizeOf(u32)) return false;
        const length = std.mem.readInt(u32, request[offset..][0..4], .little);
        offset += 4;
        if (length == 0 or length > READ_MIME_ESSENCE_BYTES_MAX or length > request.len - offset) return false;
        offset += length;
    }
    return offset == request.len;
}

fn startImmediateOperation(
    service: *Service,
    service_handle: Handle,
    kind: OperationKind,
    request: []const u8,
    timeout_ms: u32,
    max_bytes: u32,
    max_image_pixels: u32,
    max_conversion_bytes: u32,
    selection: Selection,
    out_handle: *Handle,
) StartStatus {
    const owned_request = service.allocator.dupe(u8, request) catch return .out_of_memory;
    const operation = service.allocator.create(Operation) catch {
        if (owned_request.len > 0) service.allocator.free(owned_request);
        return .out_of_memory;
    };
    operation.* = .{
        .allocator = service.allocator,
        .service = service,
        .kind = kind,
        .request = owned_request,
        .status = if (timeout_ms == 0) .timed_out else .pending,
        .timeout_ms = timeout_ms,
        .started_ns = clipboard_clock.nowNs(),
        .max_bytes = max_bytes,
        .max_image_pixels = max_image_pixels,
        .max_conversion_bytes = max_conversion_bytes,
        .selection = selection,
        .mutation_sequence = if (kind == .write or kind == .clear) service.takeMutationSequence() else 0,
    };
    const operation_handle = handles.insertOwnedChild(
        .clipboard_operation,
        erasePtr(operation),
        service_handle,
    ) catch {
        if (owned_request.len > 0) service.allocator.free(owned_request);
        service.allocator.destroy(operation);
        return .out_of_memory;
    };
    operation.handle = operation_handle;
    service.operations.append(service.allocator, operation) catch {
        handles.invalidate(operation_handle, .clipboard_operation);
        if (owned_request.len > 0) service.allocator.free(owned_request);
        service.allocator.destroy(operation);
        return .out_of_memory;
    };
    if (comptime builtin.os.tag == .windows or builtin.os.tag == .macos) {
        if (operation.status == .pending) service.enqueuePlatformOperation(operation);
    }
    out_handle.* = operation_handle;
    return .ok;
}

pub fn startReadOperation(
    service_handle: Handle,
    request_pointer: ?[*]const u8,
    request_length: u32,
    selection_value: u8,
    max_bytes: u32,
    max_image_pixels: u32,
    max_conversion_bytes: u32,
    timeout_ms: u32,
    out_operation_handle: ?*Handle,
) StartStatus {
    const out_handle = out_operation_handle orelse return .invalid_argument;
    out_handle.* = 0;
    const service = acquireService(service_handle) orelse return .invalid_service;
    if (service.shutting_down) return .shutting_down;
    if (service.operations.items.len >= service.max_operations) return .limit_exceeded;
    const selection = parseSelection(selection_value) orelse return .invalid_argument;
    const request = sliceFromPointer(request_pointer, request_length) orelse return .invalid_argument;
    if (!validateReadRequest(request)) return .invalid_argument;
    return startImmediateOperation(
        service,
        service_handle,
        .read,
        request,
        timeout_ms,
        max_bytes,
        max_image_pixels,
        max_conversion_bytes,
        selection,
        out_handle,
    );
}

pub fn startWriteOperation(
    service_handle: Handle,
    text_pointer: ?[*]const u8,
    text_length: u32,
    selection_value: u8,
    timeout_ms: u32,
    out_operation_handle: ?*Handle,
) StartStatus {
    const out_handle = out_operation_handle orelse return .invalid_argument;
    out_handle.* = 0;
    const service = acquireService(service_handle) orelse return .invalid_service;
    if (service.shutting_down) return .shutting_down;
    if (service.operations.items.len >= service.max_operations) return .limit_exceeded;
    const selection = parseSelection(selection_value) orelse return .invalid_argument;
    const text = sliceFromPointer(text_pointer, text_length) orelse return .invalid_argument;
    if (text.len == 0 or std.mem.indexOfScalar(u8, text, 0) != null or !std.unicode.utf8ValidateSlice(text)) {
        return .invalid_argument;
    }
    return startImmediateOperation(service, service_handle, .write, text, timeout_ms, 0, 0, 0, selection, out_handle);
}

pub fn startClearOperation(
    service_handle: Handle,
    selection_value: u8,
    timeout_ms: u32,
    out_operation_handle: ?*Handle,
) StartStatus {
    const out_handle = out_operation_handle orelse return .invalid_argument;
    out_handle.* = 0;
    const service = acquireService(service_handle) orelse return .invalid_service;
    if (service.shutting_down) return .shutting_down;
    if (service.operations.items.len >= service.max_operations) return .limit_exceeded;
    const selection = parseSelection(selection_value) orelse return .invalid_argument;
    return startImmediateOperation(service, service_handle, .clear, "", timeout_ms, 0, 0, 0, selection, out_handle);
}

pub fn pollOperation(operation_handle: Handle) OperationStatus {
    const operation = acquireOperation(operation_handle) orelse return .invalid_handle;
    return operation.poll();
}

pub fn cancelOperation(operation_handle: Handle) CancelStatus {
    const operation = acquireOperation(operation_handle) orelse return .invalid_handle;
    return operation.requestCancel();
}

fn resultSlice(operation: *Operation, kind: ResultKind) ?[]const u8 {
    operation.mutex.lock();
    defer operation.mutex.unlock();
    return switch (kind) {
        .mime => if (operation.status == .read) operation.result_mime else null,
        .data => if (operation.status == .read) operation.result else null,
        .diagnostic => if (operation.status == .failed) operation.diagnostic else null,
    };
}

fn resultLength(operation_handle: Handle, out_length: ?*u32, kind: ResultKind) CopyStatus {
    const operation = acquireOperation(operation_handle) orelse return .invalid_handle;
    const output = out_length orelse return .invalid_argument;
    const result = resultSlice(operation, kind) orelse return .invalid_state;
    output.* = @intCast(result.len);
    return .ok;
}

fn resultCopy(
    operation_handle: Handle,
    output_pointer: ?[*]u8,
    output_capacity: u32,
    kind: ResultKind,
) CopyStatus {
    const operation = acquireOperation(operation_handle) orelse return .invalid_handle;
    const result = resultSlice(operation, kind) orelse return .invalid_state;
    if (output_capacity < result.len) return .buffer_too_small;
    if (result.len == 0) return .ok;
    const output = output_pointer orelse return .invalid_argument;
    @memcpy(output[0..result.len], result);
    return .ok;
}

pub fn resultMimeLength(operation_handle: Handle, out_length: ?*u32) CopyStatus {
    return resultLength(operation_handle, out_length, .mime);
}

pub fn resultMimeCopy(operation_handle: Handle, output_pointer: ?[*]u8, output_capacity: u32) CopyStatus {
    return resultCopy(operation_handle, output_pointer, output_capacity, .mime);
}

pub fn resultDataLength(operation_handle: Handle, out_length: ?*u32) CopyStatus {
    return resultLength(operation_handle, out_length, .data);
}

pub fn resultDataCopy(operation_handle: Handle, output_pointer: ?[*]u8, output_capacity: u32) CopyStatus {
    return resultCopy(operation_handle, output_pointer, output_capacity, .data);
}

pub fn resultErrorCode(operation_handle: Handle, out_error_code: ?*u32) CopyStatus {
    const operation = acquireOperation(operation_handle) orelse return .invalid_handle;
    const output = out_error_code orelse return .invalid_argument;
    operation.mutex.lock();
    defer operation.mutex.unlock();
    if (operation.status != .failed) return .invalid_state;
    output.* = operation.error_code;
    return .ok;
}

pub fn resultDiagnosticLength(operation_handle: Handle, out_length: ?*u32) CopyStatus {
    return resultLength(operation_handle, out_length, .diagnostic);
}

pub fn resultDiagnosticCopy(operation_handle: Handle, output_pointer: ?[*]u8, output_capacity: u32) CopyStatus {
    return resultCopy(operation_handle, output_pointer, output_capacity, .diagnostic);
}

pub fn destroyOperation(operation_handle: Handle) DestroyStatus {
    const operation = acquireOperation(operation_handle) orelse return .invalid_handle;
    if (!operation.isReadyToDestroy()) return .not_ready;
    operation.service.removeOperation(operation);
    handles.invalidate(operation_handle, .clipboard_operation);
    operation.deinit();
    return .destroyed;
}

pub fn beginServiceShutdown(service_handle: Handle) ShutdownStatus {
    const service = acquireService(service_handle) orelse return .invalid_handle;
    service.beginShutdown();
    return .pending;
}

pub fn pollServiceShutdown(service_handle: Handle) ShutdownStatus {
    const service = acquireService(service_handle) orelse return .invalid_handle;
    return service.pollShutdown();
}

pub fn destroyService(service_handle: Handle) DestroyStatus {
    const service = acquireService(service_handle) orelse return .invalid_handle;
    if (service.pollShutdown() != .ready) return .not_ready;
    handles.invalidate(service_handle, .clipboard_service);
    service.deinit();
    return .destroyed;
}

pub fn drainService(service_handle: Handle) u8 {
    const service = acquireService(service_handle) orelse return 2;
    if (service.shutting_down) return 0;
    if (comptime builtin.os.tag != .linux) return 0;
    var active = false;
    const mechanism = service.drain_mechanism;
    service.drain_mechanism = if (mechanism == .wayland) .x11 else .wayland;
    switch (mechanism) {
        .wayland => if (service.wayland) |wayland| {
            if (service.wayland_drain_provider) {
                active = wayland.driveProviderUnit();
            } else {
                switch (wayland.drive()) {
                    .failed => wayland.retireProviders(),
                    else => {},
                }
            }
            service.wayland_drain_provider = !service.wayland_drain_provider;
        },
        .x11 => if (service.x11) |x11| {
            service.driveX11EventUnit();
            active = x11.driveProviderUnit();
        },
    }
    if (service.wayland) |wayland| active = active or wayland.hasWork();
    if (service.x11) |x11| active = active or x11.hasWork();
    return if (active) 1 else 0;
}

fn destroyTestService(service: Handle) void {
    _ = beginServiceShutdown(service);
    var status = pollServiceShutdown(service);
    var attempts: u32 = 0;
    while (status == .pending and attempts < 2_000) : (attempts += 1) {
        clipboard_clock.sleep(std.time.ns_per_ms);
        status = pollServiceShutdown(service);
    }
    if (status != .ready) @panic("clipboard service shutdown exceeded 2 seconds");
    _ = destroyService(service);
}

test "clipboard status values are stable" {
    try std.testing.expectEqual(@as(u8, 0), @intFromEnum(OperationStatus.pending));
    try std.testing.expectEqual(@as(u8, 1), @intFromEnum(OperationStatus.read));
    try std.testing.expectEqual(@as(u8, 10), @intFromEnum(OperationStatus.invalid_handle));
    try std.testing.expectEqual(@as(u8, 1), @intFromEnum(CopyStatus.buffer_too_small));
    try std.testing.expectEqual(@as(u8, 2), @intFromEnum(DestroyStatus.invalid_handle));
}

test "clipboard service preserves a configured native operation limit" {
    const operation_limit = 2;
    const service = createService(std.testing.allocator, operation_limit, PROVIDER_TRANSFERS_MAX_DEFAULT, null, 0);
    try std.testing.expect(service != 0);
    defer destroyTestService(service);

    var operations: [operation_limit]Handle = @splat(0);
    for (&operations) |*operation| {
        try std.testing.expectEqual(StartStatus.ok, startClearOperation(service, 0, 0, operation));
    }
    var excess_operation: Handle = 99;
    try std.testing.expectEqual(StartStatus.limit_exceeded, startClearOperation(service, 0, 0, &excess_operation));
    try std.testing.expectEqual(@as(Handle, 0), excess_operation);
    for (operations) |operation| {
        try std.testing.expectEqual(DestroyStatus.destroyed, destroyOperation(operation));
    }
}

test "clipboard cancellation and service shutdown are asynchronous and isolated" {
    if (comptime builtin.os.tag == .windows or builtin.os.tag == .macos) return error.SkipZigTest;
    const first_service = createService(std.testing.allocator, 1, PROVIDER_TRANSFERS_MAX_DEFAULT, null, 0);
    const second_service = createService(std.testing.allocator, 1, PROVIDER_TRANSFERS_MAX_DEFAULT, null, 0);
    try std.testing.expect(first_service != 0);
    try std.testing.expect(second_service != 0);
    acquireService(first_service).?.libraries = .{};
    acquireService(second_service).?.libraries = .{};
    defer destroyTestService(second_service);

    var first_operation: Handle = 0;
    var second_operation: Handle = 0;
    const read_request = [_]u8{ 1, 0, 0, 0, 10, 0, 0, 0 } ++ "text/plain".*;
    try std.testing.expectEqual(
        StartStatus.ok,
        startReadOperation(first_service, &read_request, read_request.len, 0, 1024, 1024, 4096, 100, &first_operation),
    );
    try std.testing.expectEqual(
        StartStatus.ok,
        startReadOperation(second_service, &read_request, read_request.len, 0, 1024, 1024, 4096, 100, &second_operation),
    );
    try std.testing.expectEqual(CancelStatus.requested, cancelOperation(first_operation));
    try std.testing.expectEqual(CancelStatus.already_terminal, cancelOperation(first_operation));
    _ = beginServiceShutdown(first_service);
    var first_shutdown = pollServiceShutdown(first_service);
    var first_shutdown_attempts: u32 = 0;
    while (first_shutdown == .pending and first_shutdown_attempts < 2_000) : (first_shutdown_attempts += 1) {
        clipboard_clock.sleep(std.time.ns_per_ms);
        first_shutdown = pollServiceShutdown(first_service);
    }
    try std.testing.expectEqual(ShutdownStatus.ready, first_shutdown);
    try std.testing.expectEqual(DestroyStatus.destroyed, destroyService(first_service));
    try std.testing.expectEqual(OperationStatus.invalid_handle, pollOperation(first_operation));

    try std.testing.expectEqual(OperationStatus.unsupported, pollOperation(second_operation));
    try std.testing.expectEqual(DestroyStatus.destroyed, destroyOperation(second_operation));
}

test "clipboard production operations validate requests and remain unsupported until platform protocols exist" {
    if (comptime builtin.os.tag == .windows or builtin.os.tag == .macos) return error.SkipZigTest;
    const service = createService(std.testing.allocator, 3, PROVIDER_TRANSFERS_MAX_DEFAULT, null, 0);
    try std.testing.expect(service != 0);
    acquireService(service).?.libraries = .{};
    defer destroyTestService(service);

    var operation: Handle = 0;
    const malformed_read = [_]u8{ 1, 0, 0, 0, 4, 0, 0, 0, 't' };
    try std.testing.expectEqual(
        StartStatus.invalid_argument,
        startReadOperation(service, &malformed_read, malformed_read.len, 0, 1024, 1024, 4096, 100, &operation),
    );
    try std.testing.expectEqual(@as(Handle, 0), operation);

    const read_request = [_]u8{ 1, 0, 0, 0, 10, 0, 0, 0 } ++ "text/plain".*;
    try std.testing.expectEqual(
        StartStatus.ok,
        startReadOperation(service, &read_request, read_request.len, 0, 1024, 1024, 4096, 100, &operation),
    );
    try std.testing.expectEqual(OperationStatus.unsupported, pollOperation(operation));
    try std.testing.expectEqual(DestroyStatus.destroyed, destroyOperation(operation));
    try std.testing.expectEqual(OperationStatus.invalid_handle, pollOperation(operation));
    try std.testing.expectEqual(DestroyStatus.invalid_handle, destroyOperation(operation));

    try std.testing.expectEqual(
        StartStatus.invalid_argument,
        startWriteOperation(service, "bad\x00text", 8, 0, 100, &operation),
    );
    try std.testing.expectEqual(
        StartStatus.invalid_argument,
        startWriteOperation(service, "bad\xfftext", 8, 0, 100, &operation),
    );
    try std.testing.expectEqual(
        StartStatus.ok,
        startClearOperation(service, 1, 0, &operation),
    );
    try std.testing.expectEqual(OperationStatus.timed_out, pollOperation(operation));
    try std.testing.expectEqual(DestroyStatus.destroyed, destroyOperation(operation));
}

test "clipboard read request validation enforces exact native MIME bounds" {
    var exact: [4 + 64 * 5]u8 = @splat(0);
    std.mem.writeInt(u32, exact[0..4], 64, .little);
    var offset: usize = 4;
    var index: u32 = 0;
    while (index < 64) : (index += 1) {
        std.mem.writeInt(u32, exact[offset..][0..4], 1, .little);
        exact[offset + 4] = 'x';
        offset += 5;
    }
    try std.testing.expect(validateReadRequest(&exact));

    var too_many: [4 + 65 * 5]u8 = @splat(0);
    std.mem.writeInt(u32, too_many[0..4], 65, .little);
    offset = 4;
    index = 0;
    while (index < 65) : (index += 1) {
        std.mem.writeInt(u32, too_many[offset..][0..4], 1, .little);
        too_many[offset + 4] = 'x';
        offset += 5;
    }
    try std.testing.expect(!validateReadRequest(&too_many));

    var exact_essence: [4 + 4 + 255]u8 = @splat('x');
    std.mem.writeInt(u32, exact_essence[0..4], 1, .little);
    std.mem.writeInt(u32, exact_essence[4..8], 255, .little);
    try std.testing.expect(validateReadRequest(&exact_essence));

    var oversized_essence: [4 + 4 + 256]u8 = @splat('x');
    std.mem.writeInt(u32, oversized_essence[0..4], 1, .little);
    std.mem.writeInt(u32, oversized_essence[4..8], 256, .little);
    try std.testing.expect(!validateReadRequest(&oversized_essence));

    const service = createService(std.testing.allocator, 1, 1, null, 0);
    try std.testing.expect(service != 0);
    defer destroyTestService(service);
    var operation: Handle = 99;
    try std.testing.expectEqual(
        StartStatus.invalid_argument,
        startReadOperation(service, &oversized_essence, oversized_essence.len, 0, 1, 1, 1, 1, &operation),
    );
    try std.testing.expectEqual(@as(Handle, 0), operation);
    try std.testing.expectEqual(@as(usize, 0), acquireService(service).?.operations.items.len);
}

test "clipboard Wayland transfer format uses canonical offered essence" {
    try std.testing.expectEqual(
        WaylandTransferFormat.bmp_to_png,
        waylandTransferFormat("image/png", "image/bmp; version=3"),
    );
    try std.testing.expectEqual(
        WaylandTransferFormat.direct,
        waylandTransferFormat("image/png", "image/png; version=3"),
    );
}

test "clipboard Wayland connection reset clears connection-scoped read state" {
    var operation: Operation = .{
        .allocator = std.testing.allocator,
        .service = undefined,
        .kind = .read,
        .mechanism = .wayland,
        .preference_offset = 17,
        .candidate_failed = true,
        .implemented_candidate_attempted = true,
        .wayland_barrier_serial = 9,
        .wayland_stale_retry_count = 1,
        .wayland_connection_reset = true,
    };
    defer operation.transfer_data.deinit(std.testing.allocator);
    try operation.transfer_data.appendSlice(std.testing.allocator, "partial");
    operation.result_mime = try std.testing.allocator.dupe(u8, "text/plain");

    operation.resetWaylandConnectionState();

    try std.testing.expectEqual(@as(?clipboard_linux.Mechanism, null), operation.mechanism);
    try std.testing.expectEqual(@as(usize, 0), operation.transfer_data.items.len);
    try std.testing.expectEqual(@as(usize, 0), operation.result_mime.len);
    try std.testing.expectEqual(@as(u32, 4), operation.preference_offset);
    try std.testing.expect(!operation.candidate_failed);
    try std.testing.expect(!operation.implemented_candidate_attempted);
    try std.testing.expect(!operation.wayland_connection_reset);
    try std.testing.expectEqual(@as(u64, 0), operation.wayland_barrier_serial);
    try std.testing.expectEqual(@as(u8, 0), operation.wayland_stale_retry_count);
}

test "clipboard Wayland candidate exhaustion preserves the observable result" {
    try std.testing.expectEqual(OperationStatus.empty, waylandReadExhaustionStatus(true, false));
    try std.testing.expectEqual(OperationStatus.unsupported, waylandReadExhaustionStatus(false, false));
    try std.testing.expectEqual(OperationStatus.failed, waylandReadExhaustionStatus(true, true));
}

test "clipboard WSL policy rejects primary and clear without blocking standard read and write" {
    const libraries: clipboard_linux.Libraries = .{ .wayland = true, .x11 = true, .is_wsl = true };
    const TestCase = struct {
        kind: OperationKind,
        selection: Selection,
        unsupported: bool,
    };
    const cases = [_]TestCase{
        .{ .kind = .read, .selection = .primary, .unsupported = true },
        .{ .kind = .write, .selection = .primary, .unsupported = true },
        .{ .kind = .clear, .selection = .primary, .unsupported = true },
        .{ .kind = .clear, .selection = .clipboard, .unsupported = true },
        .{ .kind = .read, .selection = .clipboard, .unsupported = false },
        .{ .kind = .write, .selection = .clipboard, .unsupported = false },
    };
    for (cases) |case| {
        var operation: Operation = .{
            .allocator = std.testing.allocator,
            .service = undefined,
            .kind = case.kind,
            .selection = case.selection,
        };
        try std.testing.expectEqual(case.unsupported, wslOperationUnsupported(libraries, &operation));
    }
}

test "clipboard Wayland BMP transfer converts to PNG and releases source bytes" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    try clipboard_clock.init();
    var service: Service = .{
        .allocator = std.testing.allocator,
        .libraries = .{},
        .requested_wayland_seat = &.{},
        .environment_wayland_seat = &.{},
    };
    var operation: Operation = .{
        .allocator = std.testing.allocator,
        .service = &service,
        .kind = .read,
        .max_bytes = 1024,
        .max_image_pixels = 1,
        .max_conversion_bytes = 1024,
        .timeout_ms = 1000,
        .started_ns = clipboard_clock.nowNs(),
    };
    const operation_handle = try handles.insert(.clipboard_operation, erasePtr(&operation));
    defer handles.invalidate(operation_handle, .clipboard_operation);
    defer {
        if (operation.result.len > 0) std.testing.allocator.free(operation.result);
        operation.transfer_data.deinit(std.testing.allocator);
    }
    var bmp: [58]u8 = @splat(0);
    bmp[0..2].* = "BM".*;
    std.mem.writeInt(u32, bmp[2..6], bmp.len, .little);
    std.mem.writeInt(u32, bmp[10..14], 54, .little);
    std.mem.writeInt(u32, bmp[14..18], 40, .little);
    std.mem.writeInt(i32, bmp[18..22], 1, .little);
    std.mem.writeInt(i32, bmp[22..26], 1, .little);
    std.mem.writeInt(u16, bmp[26..28], 1, .little);
    std.mem.writeInt(u16, bmp[28..30], 24, .little);
    std.mem.writeInt(u32, bmp[34..38], 4, .little);
    bmp[54..58].* = .{ 0, 0, 255, 0 };
    try operation.transfer_data.appendSlice(std.testing.allocator, &bmp);

    try std.testing.expectEqual(
        OperationStatus.pending,
        service.completeWaylandRead(&operation, .bmp_to_png),
    );
    var status = operation.poll();
    var attempts: u32 = 0;
    while (status == .pending and attempts < 2_000) : (attempts += 1) {
        clipboard_clock.sleep(std.time.ns_per_ms);
        status = operation.poll();
    }
    try std.testing.expectEqual(OperationStatus.read, status);
    try std.testing.expect(operation.isReadyToDestroy());
    var length: u32 = 0;
    try std.testing.expectEqual(CopyStatus.ok, resultDataLength(operation_handle, &length));
    try std.testing.expectEqual(@as(u32, @intCast(operation.result.len)), length);
    var too_small = [_]u8{0xaa} ** 7;
    try std.testing.expectEqual(CopyStatus.buffer_too_small, resultDataCopy(operation_handle, &too_small, too_small.len));
    try std.testing.expectEqualSlices(u8, &([_]u8{0xaa} ** 7), &too_small);
    var output: [1024]u8 = undefined;
    try std.testing.expectEqual(CopyStatus.ok, resultDataCopy(operation_handle, &output, @intCast(operation.result.len)));
    try std.testing.expectEqualStrings("\x89PNG\r\n\x1a\n", output[0..8]);
    try std.testing.expectEqualStrings("\x89PNG\r\n\x1a\n", operation.result[0..8]);
    try std.testing.expectEqual(@as(usize, 0), operation.transfer_data.items.len);
    try std.testing.expectEqual(@as(usize, 0), operation.transfer_data.capacity);
}

test "clipboard failed operations always publish a portable diagnostic" {
    var operation: Operation = .{
        .allocator = std.testing.allocator,
        .service = undefined,
        .kind = .read,
    };
    var service: Service = undefined;

    try std.testing.expectEqual(OperationStatus.failed, service.finishOperation(&operation, .failed));
    try std.testing.expect(operation.error_code != 0);
    try std.testing.expect(operation.diagnostic.len > 0);
}

test "clipboard queued platform terminal requests complete before worker execution" {
    var service: Service = .{
        .allocator = std.testing.allocator,
        .libraries = .{},
        .requested_wayland_seat = &.{},
        .environment_wayland_seat = &.{},
    };
    var first: Operation = .{
        .allocator = std.testing.allocator,
        .service = &service,
        .kind = .read,
    };
    var second: Operation = .{
        .allocator = std.testing.allocator,
        .service = &service,
        .kind = .read,
    };
    var queue_storage: [2]*Operation = undefined;
    service.platform_queue = .{ .items = queue_storage[0..0], .capacity = queue_storage.len };
    service.platform_queue.appendAssumeCapacity(&first);
    service.platform_queue.appendAssumeCapacity(&second);

    try std.testing.expect(service.completeQueuedPlatformOperation(&second, .cancelled));
    try std.testing.expectEqual(OperationStatus.cancelled, second.status);
    try std.testing.expectEqual(@as(usize, 1), service.platform_queue.items.len);
    try std.testing.expect(service.platform_queue.items[0] == &first);
}

test "clipboard platform result resolution enforces deadline before late read success" {
    var service: Service = .{
        .allocator = std.testing.allocator,
        .libraries = .{},
        .requested_wayland_seat = &.{},
        .environment_wayland_seat = &.{},
    };
    var operation: Operation = .{
        .allocator = std.testing.allocator,
        .service = &service,
        .kind = .read,
        .timeout_ms = 5,
        .started_ns = 100,
    };

    service.publishPlatformResultAt(
        &operation,
        .read,
        "text/plain",
        "late result",
        0,
        100 + 5 * std.time.ns_per_ms,
    );

    try std.testing.expectEqual(OperationStatus.timed_out, operation.status);
    try std.testing.expectEqual(@as(usize, 0), operation.result.len);
    try std.testing.expectEqual(@as(usize, 0), operation.result_mime.len);
}

test "clipboard platform result preserves out of memory after data allocation failure" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{ .fail_index = 1 });
    const allocator = failing.allocator();
    var service: Service = .{
        .allocator = allocator,
        .libraries = .{},
        .requested_wayland_seat = &.{},
        .environment_wayland_seat = &.{},
    };
    var operation: Operation = .{
        .allocator = allocator,
        .service = &service,
        .kind = .read,
        .timeout_ms = 100,
    };

    service.publishPlatformResultAt(&operation, .read, "text/plain", "data", 999, 0);

    try std.testing.expectEqual(OperationStatus.failed, operation.status);
    try std.testing.expectEqual(@intFromEnum(ErrorCode.out_of_memory), operation.error_code);
}

test "clipboard cancellation recorded before a platform mutation wins over late success" {
    var operation: Operation = .{
        .allocator = std.testing.allocator,
        .service = undefined,
        .kind = .write,
        .timeout_ms = 100,
        .started_ns = 100,
        .platform_terminal_request = .cancelled,
    };

    try std.testing.expectEqual(
        OperationStatus.cancelled,
        resolvePlatformStatus(&operation, .written, 100 + std.time.ns_per_ms),
    );
}

test "clipboard platform mutation commit wins over later cancellation" {
    var operation: Operation = .{
        .allocator = std.testing.allocator,
        .service = undefined,
        .kind = .write,
        .timeout_ms = 100,
        .started_ns = 100,
        .platform_terminal_request = .cancelled,
    };
    operation.platform_mutation_started.store(true, .release);

    try std.testing.expectEqual(
        OperationStatus.written,
        resolvePlatformStatus(&operation, .written, 100 + std.time.ns_per_ms),
    );
}

test "clipboard platform mutation callbacks mark the shared operation state" {
    try clipboard_clock.init();
    var operation: Operation = .{
        .allocator = std.testing.allocator,
        .service = undefined,
        .kind = .write,
        .timeout_ms = 100,
        .started_ns = clipboard_clock.nowNs(),
    };

    try std.testing.expect(beginWindowsPlatformMutation(&operation) == null);
    try std.testing.expect(operation.platform_mutation_started.load(.acquire));

    operation.platform_mutation_started.store(false, .release);
    try std.testing.expect(beginMacOSPlatformMutation(&operation) == null);
    try std.testing.expect(operation.platform_mutation_started.load(.acquire));
}

test "clipboard X11 cancellation and timeout settle pending ownership confirmation" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    try clipboard_clock.init();
    var symbols: clipboard_linux.XcbSymbols = undefined;
    symbols.xcb_discard_reply = testX11DiscardReply;
    var fake_connection: u8 = 0;
    var x11 = clipboard_x11.Connection.init(std.testing.allocator, &symbols, 1);
    x11.connection = @ptrCast(&fake_connection);
    var service: Service = .{
        .allocator = std.testing.allocator,
        .libraries = .{},
        .requested_wayland_seat = &.{},
        .environment_wayland_seat = &.{},
        .x11 = &x11,
    };
    var operation: Operation = .{
        .allocator = std.testing.allocator,
        .service = &service,
        .kind = .write,
        .x11_write = .{ .owner_cookie = .{ .sequence = 1 }, .mutation_dispatched = true },
    };

    try std.testing.expectEqual(CancelStatus.requested, operation.requestCancel());
    try std.testing.expectEqual(OperationStatus.cancelled, operation.status);
    try std.testing.expect(operation.cancel_requested);
    try std.testing.expect(operation.x11_write.owner_cookie == null);

    operation.status = .pending;
    operation.cancel_requested = false;
    operation.timeout_ms = 1;
    operation.started_ns = 0;
    operation.x11_write = .{ .owner_cookie = .{ .sequence = 2 }, .mutation_dispatched = true };
    try std.testing.expectEqual(OperationStatus.timed_out, operation.poll());
    try std.testing.expect(operation.x11_write.owner_cookie == null);
}

test "clipboard mutation ordering is selection-scoped when operation storage is reordered" {
    var service: Service = undefined;
    var earlier: Operation = .{
        .allocator = std.testing.allocator,
        .service = &service,
        .kind = .write,
        .selection = .clipboard,
        .mutation_sequence = 2,
    };
    var later: Operation = .{
        .allocator = std.testing.allocator,
        .service = &service,
        .kind = .clear,
        .selection = .primary,
        .mutation_sequence = 3,
    };
    var storage = [_]*Operation{ &later, &earlier };
    service.operations = .{ .items = &storage, .capacity = storage.len };

    try std.testing.expect(!service.hasEarlierSelectionMutation(&later));
    try std.testing.expect(!service.hasEarlierSelectionMutation(&earlier));

    later.selection = .clipboard;
    try std.testing.expect(service.hasEarlierSelectionMutation(&later));
}

test "clipboard expired X11 mutation cannot commit while draining timestamp events" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    try clipboard_clock.init();
    var symbols: clipboard_linux.XcbSymbols = undefined;
    symbols.xcb_poll_for_event = testX11PollTimestampEvent;
    symbols.xcb_destroy_window = testX11DestroyWindow;
    symbols.xcb_set_selection_owner = testX11SetSelectionOwner;
    symbols.xcb_flush = testX11Flush;
    var fake_connection: u8 = 0;
    var x11 = clipboard_x11.Connection.init(std.testing.allocator, &symbols, 1);
    x11.connection = @ptrCast(&fake_connection);
    x11.phase = .ready;
    x11.output_ready_override = true;
    x11.owner_window = 9;
    x11.atom_values[10] = 110;
    var service: Service = .{
        .allocator = std.testing.allocator,
        .libraries = .{},
        .requested_wayland_seat = &.{},
        .environment_wayland_seat = &.{},
        .x11 = &x11,
    };
    var operation: Operation = .{
        .allocator = std.testing.allocator,
        .service = &service,
        .kind = .clear,
        .selection = .primary,
        .mechanism = .x11,
        .timeout_ms = 1,
        .started_ns = clipboard_clock.nowNs() - 2 * std.time.ns_per_ms,
        .x11_write = .{
            .clear = true,
            .selection = clipboard_x11.ATOM_PRIMARY,
            .waiting_timestamp = true,
            .timestamp_window = 22,
        },
    };
    var storage = [_]*Operation{&operation};
    service.operations = .{ .items = &storage, .capacity = storage.len };
    test_x11_set_owner_count = 0;

    service.driveX11EventUnit();

    try std.testing.expectEqual(OperationStatus.timed_out, operation.status);
    try std.testing.expectEqual(@as(u32, 0), test_x11_set_owner_count);
    try std.testing.expect(!operation.x11_write.mutation_dispatched);
}

test "clipboard Wayland BMP worker cancellation beats late conversion publication" {
    try clipboard_clock.init();
    var service: Service = .{
        .allocator = std.testing.allocator,
        .libraries = .{},
        .requested_wayland_seat = &.{},
        .environment_wayland_seat = &.{},
        .shutting_down = true,
    };
    var operation: Operation = .{
        .allocator = std.testing.allocator,
        .service = &service,
        .kind = .read,
        .wayland_conversion_started = true,
        .cancel_requested = true,
        .max_bytes = 1024,
        .timeout_ms = 1000,
        .started_ns = clipboard_clock.nowNs(),
    };
    var bmp: [58]u8 = @splat(0);
    bmp[0..2].* = "BM".*;
    std.mem.writeInt(u32, bmp[2..6], bmp.len, .little);
    std.mem.writeInt(u32, bmp[10..14], 54, .little);
    std.mem.writeInt(u32, bmp[14..18], 40, .little);
    std.mem.writeInt(i32, bmp[18..22], 1, .little);
    std.mem.writeInt(i32, bmp[22..26], 1, .little);
    std.mem.writeInt(u16, bmp[26..28], 1, .little);
    std.mem.writeInt(u16, bmp[28..30], 24, .little);
    std.mem.writeInt(u32, bmp[34..38], 4, .little);
    bmp[54..58].* = .{ 0, 0, 255, 0 };
    try operation.transfer_data.appendSlice(std.testing.allocator, &bmp);

    Operation.waylandBmpWorker(&operation);

    try std.testing.expectEqual(OperationStatus.cancelled, operation.status);
    try std.testing.expect(!operation.wayland_conversion_started);
    try std.testing.expectEqual(@as(usize, 0), operation.result.len);
}

test "clipboard failed core selection progress releases operation focus" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    var symbols: clipboard_linux.WaylandSymbols = undefined;
    var wayland = clipboard_wayland.Connection.init(std.testing.allocator, &symbols, "", "", 1);
    wayland.phase = .ready;
    wayland.core_data_device = true;
    wayland.core_focus_users = 1;
    var service: Service = .{
        .allocator = std.testing.allocator,
        .libraries = .{ .wayland = true, .x11 = true, .is_wsl = true },
        .wayland = &wayland,
        .requested_wayland_seat = &.{},
        .environment_wayland_seat = &.{},
    };
    var request: [18]u8 = @splat(0);
    std.mem.writeInt(u32, request[0..4], 1, .little);
    std.mem.writeInt(u32, request[4..8], 10, .little);
    request[8..18].* = "text/plain".*;
    var operation: Operation = .{
        .allocator = std.testing.allocator,
        .service = &service,
        .kind = .read,
        .request = &request,
        .mechanism = .wayland,
    };

    try std.testing.expectEqual(OperationStatus.failed, service.driveWaylandRead(&operation));
    try std.testing.expectEqual(clipboard_linux.Mechanism.wayland, operation.mechanism.?);
    try std.testing.expect(!operation.wayland_core_focus_acquired);
    try std.testing.expectEqual(@as(u32, 1), wayland.core_focus_users);
}

test "clipboard Wayland fallback transitions to X11 only when available" {
    var service: Service = .{
        .allocator = std.testing.allocator,
        .libraries = .{ .wayland = true, .x11 = true },
        .requested_wayland_seat = &.{},
        .environment_wayland_seat = &.{},
    };
    var operation: Operation = .{
        .allocator = std.testing.allocator,
        .service = &service,
        .kind = .write,
    };

    try std.testing.expectEqual(OperationStatus.pending, service.fallbackWayland(&operation, service.libraries));
    try std.testing.expectEqual(clipboard_linux.Mechanism.x11, operation.mechanism.?);

    operation.mechanism = .wayland;
    service.libraries.x11 = false;
    try std.testing.expectEqual(OperationStatus.unsupported, service.fallbackWayland(&operation, service.libraries));
    try std.testing.expectEqual(clipboard_linux.Mechanism.wayland, operation.mechanism.?);
}

test "clipboard X11 candidate failure advances to the next compatible target" {
    var symbols: clipboard_linux.XcbSymbols = undefined;
    var fake_connection: u8 = 0;
    var x11 = clipboard_x11.Connection.init(std.testing.allocator, &symbols, 1);
    x11.connection = @ptrCast(&fake_connection);
    var service: Service = .{
        .allocator = std.testing.allocator,
        .libraries = .{},
        .requested_wayland_seat = &.{},
        .environment_wayland_seat = &.{},
        .x11 = &x11,
    };
    var operation: Operation = .{
        .allocator = std.testing.allocator,
        .service = &service,
        .kind = .read,
        .x11_read = .{ .phase = .failed },
        .x11_target_count = 2,
    };
    try operation.transfer_data.appendSlice(std.testing.allocator, "partial");
    defer operation.transfer_data.deinit(std.testing.allocator);

    try std.testing.expectEqual(OperationStatus.pending, service.driveX11Read(&operation));
    try std.testing.expectEqual(@as(u8, 1), operation.x11_target_index);
    try std.testing.expect(operation.candidate_failed);
    try std.testing.expectEqual(@as(usize, 0), operation.transfer_data.items.len);
}

test "clipboard final X11 refusal cleans read state before publication" {
    var symbols: clipboard_linux.XcbSymbols = undefined;
    symbols.xcb_delete_property = testX11DeleteProperty;
    symbols.xcb_destroy_window = testX11DestroyWindow;
    var fake_connection: u8 = 0;
    var x11 = clipboard_x11.Connection.init(std.testing.allocator, &symbols, 1);
    x11.connection = @ptrCast(&fake_connection);
    var service: Service = .{
        .allocator = std.testing.allocator,
        .libraries = .{},
        .x11 = &x11,
        .requested_wayland_seat = &.{},
        .environment_wayland_seat = &.{},
    };
    var request = [_]u8{ 0, 0, 0, 0 };
    var operation: Operation = .{
        .allocator = std.testing.allocator,
        .service = &service,
        .kind = .read,
        .request = &request,
        .implemented_candidate_attempted = true,
        .x11_read = .{ .phase = .refused, .window = 42 },
        .x11_target_count = 1,
    };

    try std.testing.expectEqual(OperationStatus.empty, service.driveX11Read(&operation));
    try std.testing.expectEqual(clipboard_x11.ReadState{}, operation.x11_read);
}

test "clipboard shutdown cancels unconfirmed X11 mutations before releasing providers" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    var symbols: clipboard_linux.XcbSymbols = undefined;
    symbols.xcb_discard_reply = testX11DiscardReply;
    var fake_connection: u8 = 0;
    var x11 = clipboard_x11.Connection.init(std.testing.allocator, &symbols, 1);
    x11.connection = @ptrCast(&fake_connection);
    const provider = try std.testing.allocator.create(clipboard_x11.Provider);
    provider.* = .{ .selection = 1, .data = &.{} };
    x11.providers[0] = provider;
    x11.primary_provider = provider;
    var service: Service = .{
        .allocator = std.testing.allocator,
        .libraries = .{},
        .requested_wayland_seat = &.{},
        .environment_wayland_seat = &.{},
        .x11 = &x11,
    };
    var operation: Operation = .{
        .allocator = std.testing.allocator,
        .service = &service,
        .kind = .write,
        .x11_write = .{
            .selection = 1,
            .owner_cookie = .{ .sequence = 1 },
            .mutation_dispatched = true,
        },
    };
    var storage = [_]*Operation{&operation};
    service.operations = .{ .items = &storage, .capacity = storage.len };

    service.beginShutdown();

    try std.testing.expectEqual(OperationStatus.cancelled, operation.status);
    try std.testing.expect(operation.x11_write.provider == null);
    try std.testing.expect(x11.providers[0] == null);
}

fn testX11DiscardReply(_: *clipboard_linux.XcbConnection, _: u32) callconv(.c) void {}

var test_x11_set_owner_count: u32 = 0;

fn testX11PollTimestampEvent(_: *clipboard_linux.XcbConnection) callconv(.c) ?*clipboard_linux.XcbGenericEvent {
    const memory = std.c.malloc(@sizeOf(clipboard_linux.XcbPropertyNotifyEvent)) orelse unreachable;
    const event: *clipboard_linux.XcbPropertyNotifyEvent = @ptrCast(@alignCast(memory));
    event.* = .{
        .response_type = 28,
        .pad0 = 0,
        .sequence = 0,
        .window = 22,
        .atom = 110,
        .time = 7,
        .state = 0,
        .pad1 = .{0} ** 3,
    };
    return @ptrCast(event);
}

fn testX11DestroyWindow(_: *clipboard_linux.XcbConnection, _: u32) callconv(.c) clipboard_linux.XcbCookie {
    return .{ .sequence = 1 };
}

fn testX11DeleteProperty(_: *clipboard_linux.XcbConnection, _: u32, _: u32) callconv(.c) clipboard_linux.XcbCookie {
    return .{ .sequence = 1 };
}

fn testX11SetSelectionOwner(
    _: *clipboard_linux.XcbConnection,
    _: u32,
    _: u32,
    _: u32,
) callconv(.c) clipboard_linux.XcbCookie {
    test_x11_set_owner_count += 1;
    return .{ .sequence = 1 };
}

fn testX11Flush(_: *clipboard_linux.XcbConnection) callconv(.c) c_int {
    return 1;
}
