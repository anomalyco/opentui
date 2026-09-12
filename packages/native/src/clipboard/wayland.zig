const std = @import("std");
const posix_io = @import("posix-io.zig");
const builtin = @import("builtin");
const clipboard_clock = @import("clock.zig");
const linux = @import("linux.zig");
const protocol = @import("wayland-protocol.zig");

const WlArgument = linux.WlArgument;
const WlInterface = linux.WlInterface;
const WlProxy = linux.WlProxy;
const MAX_SEATS = 16;
const MAX_SEAT_NAME_BYTES = 255;
const MAX_OFFERS = 8;
const MAX_OFFER_MIME_TYPES = 6;
const MAX_MIME_BYTES = 255;
const MAX_PROVIDERS = 4;
// Clipboard payloads use file descriptors, so protocol metadata does not need unbounded connection buffers.
const WAYLAND_CONNECTION_BUFFER_SIZE_MAX = 1024 * 1024;
const WL_SEAT_CAPABILITY_KEYBOARD = 2;
const PROVIDER_TRANSFER_IDLE_TIMEOUT_NS = 30 * std.time.ns_per_s;
// One drive call dispatches at most this many queued events, enough to settle a
// selection-change backlog in one call while keeping per-call work bounded.
const DISPATCH_EVENTS_PER_DRIVE_MAX = 64;

pub const Progress = enum { pending, ready, unsupported, failed };
pub const SelectionResult = enum { ok, pending, committed, unsupported, failed };
const FlushResult = enum { complete, pending, failed };
const FlushOutcome = struct { result: c_int, errno: std.posix.E };

pub const Failure = enum {
    none,
    protocol,
    dispatch,
    flush,
    provider,
};

const Phase = enum { idle, registry, seats, device, ready, unsupported, failed };

const Seat = struct {
    global_name: u32,
    proxy: *WlProxy,
    name: [MAX_SEAT_NAME_BYTES]u8 = undefined,
    name_length: u8 = 0,
    capabilities: u32 = 0,

    fn nameSlice(self: *const Seat) []const u8 {
        return self.name[0..self.name_length];
    }
};

const Mime = struct {
    bytes: [MAX_MIME_BYTES]u8,
    length: u8,

    fn slice(self: *const Mime) []const u8 {
        return self.bytes[0..self.length];
    }
};

pub const Offer = struct {
    proxy: *WlProxy,
    mimes: [MAX_OFFER_MIME_TYPES]Mime = undefined,
    mime_count: u8 = 0,
};

const Transfer = struct {
    fd: std.posix.fd_t,
    offset: usize = 0,
    last_progress_ns: i128,
};

const Provider = struct {
    connection: *Connection,
    source: *WlProxy,
    primary: bool,
    data: []u8,
    transfers: []Transfer,
    transfer_count: u32 = 0,
    transfer_cursor: u32 = 0,
    cancelled: bool = false,
};

pub const MimeMatch = struct {
    offered: []const u8,
    requested: []const u8,
};

pub const Connection = struct {
    allocator: std.mem.Allocator,
    symbols: *const linux.WaylandSymbols,
    max_provider_transfers: u32,
    display: ?*linux.WlDisplay = null,
    registry: ?*WlProxy = null,
    sync_callback: ?*WlProxy = null,
    phase: Phase = .idle,
    sync_done: bool = false,
    // Selection barriers are wl_display.sync roundtrips issued at read admission.
    // At most one is in flight; later admissions wait for the follow-up barrier.
    barrier_callback: ?*WlProxy = null,
    barrier_serial_completed: u64 = 0,
    barrier_serial_inflight: u64 = 0,
    barrier_serial_requested: u64 = 0,
    output_pending: bool = false,
    failure: Failure = .none,
    ext_global: ?u32 = null,
    wlr_global: ?u32 = null,
    wlr_version: u32 = 0,
    core_manager_global: ?u32 = null,
    compositor_global: ?u32 = null,
    shm_global: ?u32 = null,
    shell_global: ?u32 = null,
    seats: [MAX_SEATS]Seat = undefined,
    seat_count: u8 = 0,
    seats_overflowed: bool = false,
    requested_seat: []const u8,
    environment_seat: []const u8,
    metadata: protocol.Metadata = undefined,
    manager: ?*WlProxy = null,
    core_data_device: bool = false,
    bound_manager_global: ?u32 = null,
    device: ?*WlProxy = null,
    compositor: ?*WlProxy = null,
    shm: ?*WlProxy = null,
    shell: ?*WlProxy = null,
    keyboard: ?*WlProxy = null,
    helper_surface: ?*WlProxy = null,
    helper_shell_surface: ?*WlProxy = null,
    helper_pool: ?*WlProxy = null,
    helper_buffer: ?*WlProxy = null,
    helper_fd: ?std.posix.fd_t = null,
    core_focus_entered: bool = false,
    core_focus_lost: bool = false,
    core_selection_seen: bool = false,
    core_focus_users: u32 = 0,
    offers: [MAX_OFFERS]Offer = undefined,
    offer_count: u8 = 0,
    clipboard_offer: ?*WlProxy = null,
    primary_offer: ?*WlProxy = null,
    primary_supported: bool = false,
    bound_seat_global: ?u32 = null,
    providers: [MAX_PROVIDERS]?*Provider = .{null} ** MAX_PROVIDERS,
    clipboard_provider: ?*Provider = null,
    primary_provider: ?*Provider = null,
    provider_cursor: u8 = 0,
    allow_core_data_device: bool = false,
    flush_outcome_override: ?FlushOutcome = null,
    test_marshal_count: u8 = 0,
    test_flush_marshal_count: u8 = 0,
    display_error_override: ?c_int = null,

    pub fn init(
        allocator: std.mem.Allocator,
        symbols: *const linux.WaylandSymbols,
        requested_seat: []const u8,
        environment_seat: []const u8,
        max_provider_transfers: u32,
    ) Connection {
        return .{
            .allocator = allocator,
            .symbols = symbols,
            .requested_seat = requested_seat,
            .environment_seat = environment_seat,
            .max_provider_transfers = max_provider_transfers,
        };
    }

    pub fn deinit(self: *Connection) void {
        self.releaseProviders();
        self.destroyCoreHelper();
        for (self.offers[0..self.offer_count]) |offer| self.destroyOffer(offer.proxy);
        if (self.device) |device| {
            if (self.core_data_device) self.symbols.wl_proxy_destroy(device) else self.destroyProtocolProxy(device, 1);
        }
        if (self.manager) |manager| {
            if (self.core_data_device) self.symbols.wl_proxy_destroy(manager) else self.destroyProtocolProxy(manager, 2);
        }
        if (self.keyboard) |keyboard| self.symbols.wl_proxy_destroy(keyboard);
        if (self.shell) |shell| self.symbols.wl_proxy_destroy(shell);
        if (self.shm) |shm| self.symbols.wl_proxy_destroy(shm);
        if (self.compositor) |compositor| self.symbols.wl_proxy_destroy(compositor);
        for (self.seats[0..self.seat_count]) |seat| self.symbols.wl_proxy_destroy(seat.proxy);
        if (self.barrier_callback) |callback| self.symbols.wl_proxy_destroy(callback);
        if (self.sync_callback) |callback| self.symbols.wl_proxy_destroy(callback);
        if (self.registry) |registry| self.symbols.wl_proxy_destroy(registry);
        if (self.display != null) _ = self.queueFlush();
        if (self.display) |display| self.symbols.wl_display_disconnect(display);
        self.* = undefined;
    }

    pub fn drive(self: *Connection) Progress {
        if (self.output_pending) {
            switch (self.flushOutput()) {
                .complete => {},
                .pending => return .pending,
                .failed => return self.fail(.flush),
            }
        }
        switch (self.phase) {
            .idle => self.start() catch |err| switch (err) {
                error.ConnectFailed => {
                    self.phase = .unsupported;
                    return .unsupported;
                },
                else => return self.fail(.protocol),
            },
            .unsupported => return .unsupported,
            .failed => return .failed,
            .ready => {
                if (!self.dispatchAvailable()) return self.fail(.dispatch);
                return if (self.phase == .ready) .ready else .failed;
            },
            else => {},
        }

        if (!self.dispatchAvailable()) {
            return self.fail(.dispatch);
        }
        if (!self.sync_done) return .pending;

        self.sync_done = false;
        switch (self.phase) {
            .registry => {
                if (self.ext_global == null and self.wlr_global == null and !self.coreDataDeviceAvailable()) {
                    self.phase = .unsupported;
                    return .unsupported;
                }
                self.phase = .seats;
                if (!self.sendSync()) return self.fail(.protocol);
            },
            .seats => {
                switch (self.bindDevice()) {
                    .ok, .pending => {},
                    .committed => unreachable,
                    .unsupported => {
                        self.phase = .unsupported;
                        return .unsupported;
                    },
                    .failed => return self.fail(.protocol),
                }
                self.phase = .device;
                if (!self.sendSync()) return self.fail(.protocol);
            },
            .device => {
                self.phase = .ready;
            },
            else => {},
        }
        return if (self.phase == .ready) .ready else .pending;
    }

    pub fn currentOffer(self: *Connection, primary: bool) ?*const Offer {
        const proxy = if (primary) self.primary_offer else self.clipboard_offer;
        const selected = proxy orelse return null;
        for (self.offers[0..self.offer_count]) |*offer| {
            if (offer.proxy == selected) return offer;
        }
        return null;
    }

    pub fn usesCoreDataDevice(self: *const Connection) bool {
        return self.core_data_device;
    }

    // A selection barrier is one wl_display.sync roundtrip. Its completion proves
    // every selection event the compositor emitted before the request has been
    // dispatched, so a read admitted before the barrier cannot choose an offer
    // that predates its admission.
    pub fn requestSelectionBarrier(self: *Connection) ?u64 {
        if (self.barrier_callback != null) {
            // The in-flight sync was requested before this admission, so only the
            // follow-up barrier issued at its completion covers this read.
            self.barrier_serial_requested = self.barrier_serial_inflight + 1;
            return self.barrier_serial_requested;
        }
        return self.issueSelectionBarrier();
    }

    pub fn selectionBarrierReached(self: *const Connection, serial: u64) bool {
        return self.barrier_serial_completed >= serial;
    }

    fn issueSelectionBarrier(self: *Connection) ?u64 {
        std.debug.assert(self.barrier_callback == null);
        const display = self.display orelse return null;
        const callback = self.marshal(@ptrCast(display), 0, self.symbols.wl_callback_interface, 1, 0, &.{}) orelse
            return null;
        if (self.addListener(callback, &barrier_listener) != 0) {
            self.symbols.wl_proxy_destroy(callback);
            return null;
        }
        self.barrier_callback = callback;
        self.barrier_serial_inflight = self.barrier_serial_completed + 1;
        if (self.barrier_serial_requested < self.barrier_serial_inflight) {
            self.barrier_serial_requested = self.barrier_serial_inflight;
        }
        if (self.queueFlush() == .failed) {
            _ = self.fail(.flush);
            return null;
        }
        return self.barrier_serial_inflight;
    }

    fn barrierDone(data: ?*anyopaque, callback: ?*WlProxy, _: u32) callconv(.c) void {
        const self: *Connection = @ptrCast(@alignCast(data.?));
        std.debug.assert(self.barrier_callback == callback);
        std.debug.assert(self.barrier_serial_inflight == self.barrier_serial_completed + 1);
        if (callback) |proxy| self.symbols.wl_proxy_destroy(proxy);
        self.barrier_callback = null;
        self.barrier_serial_completed += 1;
        if (self.barrier_serial_requested <= self.barrier_serial_completed) return;
        if (self.issueSelectionBarrier() == null) {
            // Reads waiting on the follow-up barrier cannot progress on a
            // connection that cannot even queue a sync request.
            _ = self.fail(.protocol);
        }
    }

    pub fn acquireCoreSelection(self: *Connection) Progress {
        if (!self.core_data_device) return .unsupported;
        if (self.phase == .failed) return .failed;
        std.debug.assert(self.core_focus_users < std.math.maxInt(u32));
        self.core_focus_users += 1;
        if (self.core_focus_users > 1) return .pending;
        self.core_selection_seen = false;
        self.core_focus_lost = false;
        if (self.clipboard_offer) |offer| self.removeOffer(offer);
        self.clipboard_offer = null;
        if (!self.createCoreHelper()) {
            self.core_focus_users = 0;
            return .failed;
        }
        return .pending;
    }

    pub fn coreSelectionProgress(self: *const Connection) Progress {
        if (!self.core_data_device) return .unsupported;
        if (self.phase == .failed) return .failed;
        if (self.core_focus_users == 0 or self.helper_surface == null) return .failed;
        if (self.core_focus_lost) return .failed;
        return if (self.core_focus_entered and self.core_selection_seen) .ready else .pending;
    }

    pub fn releaseCoreSelection(self: *Connection) void {
        if (!self.core_data_device or self.core_focus_users == 0) return;
        self.core_focus_users -= 1;
        if (self.core_focus_users == 0) self.destroyCoreHelper();
    }

    pub fn takeFailure(self: *Connection) Failure {
        const failure = self.failure;
        if (self.phase == .ready) self.failure = .none;
        return failure;
    }

    pub fn isFailed(self: *const Connection) bool {
        return self.phase == .failed;
    }

    pub fn receive(self: *Connection, offer: *const Offer, mime: []const u8, fd: std.posix.fd_t) bool {
        if (mime.len > MAX_MIME_BYTES) return false;
        var mime_z: [MAX_MIME_BYTES:0]u8 = undefined;
        @memcpy(mime_z[0..mime.len], mime);
        mime_z[mime.len] = 0;
        var arguments = [_]WlArgument{ .{ .s = mime_z[0..mime.len :0].ptr }, .{ .h = fd } };
        _ = self.marshal(offer.proxy, if (self.core_data_device) 1 else 0, null, 1, 0, &arguments);
        return self.queueFlush() != .failed;
    }

    pub fn publishText(self: *Connection, primary: bool, data: []u8) SelectionResult {
        self.failure = .none;
        if (self.core_data_device) return .unsupported;
        if (primary and !self.primary_supported) return .unsupported;
        const manager = self.manager orelse return self.selectionFailure(.protocol);
        const device = self.device orelse return self.selectionFailure(.protocol);
        if (!self.canPublishProvider(primary)) return self.selectionFailure(.provider);
        const slot = self.freeProviderSlot() orelse return self.selectionFailure(.provider);
        const provider = self.allocator.create(Provider) catch return self.selectionFailure(.provider);
        const transfers = self.allocator.alloc(Transfer, self.max_provider_transfers) catch {
            self.allocator.destroy(provider);
            return self.selectionFailure(.provider);
        };
        const source = self.marshal(manager, 0, &self.metadata.source, 1, 0, &.{}) orelse {
            self.allocator.free(transfers);
            self.allocator.destroy(provider);
            return self.selectionFailure(.provider);
        };
        provider.* = .{
            .connection = self,
            .source = source,
            .primary = primary,
            .data = data,
            .transfers = transfers,
        };
        if (self.symbols.wl_proxy_add_listener(source, source_listener[0..].ptr, provider) != 0 or
            !self.offerSource(source, "text/plain") or
            !self.offerSource(source, "text/plain;charset=utf-8"))
        {
            self.symbols.wl_proxy_destroy(source);
            self.allocator.free(transfers);
            self.allocator.destroy(provider);
            return self.selectionFailure(.provider);
        }
        var arguments = [_]WlArgument{.{ .o = source }};
        _ = self.marshal(device, if (primary) 2 else 0, null, self.symbols.wl_proxy_get_version(device), 0, &arguments);
        if (!self.displayHealthy()) {
            self.symbols.wl_proxy_destroy(source);
            self.allocator.free(transfers);
            self.allocator.destroy(provider);
            return self.selectionFailure(.protocol);
        }
        const flush_result = self.queueFlush();
        if (flush_result == .failed) {
            self.symbols.wl_proxy_destroy(source);
            self.allocator.free(transfers);
            self.allocator.destroy(provider);
            _ = self.fail(.flush);
            return .failed;
        }
        const previous = if (primary) self.primary_provider else self.clipboard_provider;
        if (previous) |old| self.retireProvider(old);
        slot.* = provider;
        if (primary) self.primary_provider = provider else self.clipboard_provider = provider;
        return if (flush_result == .complete) .ok else .committed;
    }

    pub fn clearSelection(self: *Connection, primary: bool) SelectionResult {
        self.failure = .none;
        if (self.core_data_device) return .unsupported;
        if (primary and !self.primary_supported) return .unsupported;
        const device = self.device orelse return self.selectionFailure(.protocol);
        var arguments = [_]WlArgument{.{ .o = null }};
        _ = self.marshal(device, if (primary) 2 else 0, null, self.symbols.wl_proxy_get_version(device), 0, &arguments);
        if (!self.displayHealthy()) return self.selectionFailure(.protocol);
        const flush_result = self.queueFlush();
        if (flush_result == .failed) {
            _ = self.fail(.flush);
            return .failed;
        }
        const provider = if (primary) self.primary_provider else self.clipboard_provider;
        if (provider) |value| self.retireProvider(value);
        if (primary) self.primary_provider = null else self.clipboard_provider = null;
        return if (flush_result == .complete) .ok else .committed;
    }

    pub fn hasProviders(self: *const Connection) bool {
        for (self.providers) |provider| if (provider != null) return true;
        return false;
    }

    pub fn hasWork(self: *const Connection) bool {
        // An in-flight barrier counts as work so a cancelled read cannot strand
        // its sync callback once no operation keeps the connection draining.
        return self.output_pending or self.barrier_callback != null or self.hasProviders();
    }

    pub fn releaseProviders(self: *Connection) void {
        for (&self.providers) |*slot| {
            const provider = slot.* orelse continue;
            self.freeProvider(provider);
            slot.* = null;
        }
        self.clipboard_provider = null;
        self.primary_provider = null;
        if (self.display != null) _ = self.queueFlush();
    }

    pub fn retireProviders(self: *Connection) void {
        self.clipboard_provider = null;
        self.primary_provider = null;
        self.output_pending = false;
        for (&self.providers) |*slot| {
            const provider = slot.* orelse continue;
            provider.cancelled = true;
            if (provider.transfer_count > 0) continue;
            self.freeProvider(provider);
            slot.* = null;
        }
    }

    pub fn driveProviderUnit(self: *Connection) bool {
        var visited: u8 = 0;
        while (visited < MAX_PROVIDERS) : (visited += 1) {
            const slot_index = self.provider_cursor;
            self.provider_cursor = (self.provider_cursor + 1) % MAX_PROVIDERS;
            const provider = self.providers[slot_index] orelse continue;
            if (provider.cancelled and provider.transfer_count == 0) {
                self.retireProvider(provider);
                continue;
            }
            if (provider.transfer_count == 0) continue;
            const transfer_index = provider.transfer_cursor % provider.transfer_count;
            provider.transfer_cursor = (provider.transfer_cursor + 1) % provider.transfer_count;
            self.driveProviderTransfer(provider, transfer_index);
            break;
        }
        return self.hasWork();
    }

    pub fn offeredMime(self: *const Connection, offer: *const Offer, preferred: []const u8) ?MimeMatch {
        const requested = canonicalMimeEssence(preferred) orelse return null;
        for (offer.mimes[0..offer.mime_count]) |*mime| {
            const offered = canonicalMimeEssence(mime.slice()) orelse continue;
            if (std.ascii.eqlIgnoreCase(offered, requested)) return .{ .offered = mime.slice(), .requested = requested };
            if (self.core_data_device and std.ascii.eqlIgnoreCase(requested, "image/png") and
                std.ascii.eqlIgnoreCase(offered, "image/bmp")) return .{ .offered = mime.slice(), .requested = requested };
        }
        return null;
    }

    fn start(self: *Connection) !void {
        const display = self.symbols.wl_display_connect(null) orelse return error.ConnectFailed;
        // libwayland before 1.23 has no cap symbol and uses fixed-size bounded buffers instead.
        if (self.symbols.wl_display_set_max_buffer_size) |set_max_buffer_size| {
            set_max_buffer_size(display, WAYLAND_CONNECTION_BUFFER_SIZE_MAX);
        }
        self.display = display;
        const registry = self.marshal(@ptrCast(display), 1, self.symbols.wl_registry_interface, 1, 0, &.{}) orelse
            return error.RegistryFailed;
        self.registry = registry;
        if (self.addListener(registry, &registry_listener) != 0) return error.ListenerFailed;
        self.phase = .registry;
        if (!self.sendSync()) return error.SyncFailed;
        if (self.queueFlush() == .failed) return error.FlushFailed;
    }

    fn sendSync(self: *Connection) bool {
        const display = self.display orelse return false;
        const callback = self.marshal(@ptrCast(display), 0, self.symbols.wl_callback_interface, 1, 0, &.{}) orelse
            return false;
        self.sync_callback = callback;
        return self.addListener(callback, &callback_listener) == 0 and self.queueFlush() != .failed;
    }

    fn dispatchAvailable(self: *Connection) bool {
        if (comptime builtin.os.tag != .linux) return false;
        const display = self.display orelse return false;
        if (self.symbols.wl_display_dispatch_pending_single) |dispatch_single| {
            var dispatched_count: u32 = 0;
            while (dispatched_count < DISPATCH_EVENTS_PER_DRIVE_MAX) {
                const dispatched = dispatch_single(display);
                if (dispatched < 0) return false;
                if (dispatched == 0) break;
                dispatched_count += 1;
            }
            if (self.queueFlush() == .failed) return false;
            if (dispatched_count == DISPATCH_EVENTS_PER_DRIVE_MAX) return true;
        } else {
            // libwayland before 1.25 has no single-event dispatch. The pending queue is
            // bounded by the connection receive buffer, so one bulk dispatch stays bounded.
            if (self.symbols.wl_display_dispatch_pending(display) < 0) return false;
            if (self.queueFlush() == .failed) return false;
        }
        if (self.symbols.wl_display_prepare_read(display) != 0) {
            return self.dispatchPendingBounded(display) >= 0;
        }

        var descriptor = [_]std.posix.pollfd{.{
            .fd = self.symbols.wl_display_get_fd(display),
            .events = std.posix.POLL.IN,
            .revents = 0,
        }};
        const count = std.posix.poll(&descriptor, 0) catch {
            self.symbols.wl_display_cancel_read(display);
            return false;
        };
        if (count == 0 or descriptor[0].revents & std.posix.POLL.IN == 0) {
            self.symbols.wl_display_cancel_read(display);
            return descriptor[0].revents & (std.posix.POLL.ERR | std.posix.POLL.HUP | std.posix.POLL.NVAL) == 0;
        }
        if (self.symbols.wl_display_read_events(display) < 0) return false;
        return true;
    }

    fn dispatchPendingBounded(self: *Connection, display: *linux.WlDisplay) c_int {
        if (self.symbols.wl_display_dispatch_pending_single) |dispatch_single| return dispatch_single(display);
        return self.symbols.wl_display_dispatch_pending(display);
    }

    fn queueFlush(self: *Connection) FlushResult {
        const result = self.flushOutput();
        if (result == .failed and self.failure == .none) self.failure = .flush;
        self.output_pending = result == .pending;
        return result;
    }

    fn flushOutput(self: *Connection) FlushResult {
        if (comptime builtin.is_test) {
            if (self.flush_outcome_override) |outcome| {
                self.test_flush_marshal_count = self.test_marshal_count;
                const flush_result = classifyFlush(outcome.result, outcome.errno);
                self.output_pending = flush_result == .pending;
                return flush_result;
            }
        }
        const result = self.symbols.wl_display_flush(self.display.?);
        const flush_result = classifyFlush(result, if (result < 0) std.posix.errno(result) else .SUCCESS);
        self.output_pending = flush_result == .pending;
        return flush_result;
    }

    fn offerSource(self: *Connection, source: *WlProxy, mime: []const u8) bool {
        if (mime.len > MAX_MIME_BYTES) return false;
        var mime_z: [MAX_MIME_BYTES:0]u8 = undefined;
        @memcpy(mime_z[0..mime.len], mime);
        mime_z[mime.len] = 0;
        var arguments = [_]WlArgument{.{ .s = mime_z[0..mime.len :0].ptr }};
        _ = self.marshal(source, 0, null, 1, 0, &arguments);
        return self.displayHealthy();
    }

    fn freeProviderSlot(self: *Connection) ?*?*Provider {
        for (&self.providers) |*slot| if (slot.* == null) return slot;
        return null;
    }

    fn canPublishProvider(self: *Connection, primary: bool) bool {
        self.reclaimCancelledProviders();
        var count: u8 = 0;
        for (self.providers) |candidate| {
            const provider = candidate orelse continue;
            if (provider.primary == primary) count += 1;
        }
        return count < 2;
    }

    fn reclaimCancelledProviders(self: *Connection) void {
        for (self.providers) |slot| {
            const provider = slot orelse continue;
            if (!provider.cancelled or provider.transfer_count > 0) continue;
            self.retireProvider(provider);
        }
    }

    fn retireProvider(self: *Connection, provider: *Provider) void {
        if (self.clipboard_provider == provider) self.clipboard_provider = null;
        if (self.primary_provider == provider) self.primary_provider = null;
        if (!provider.cancelled or provider.transfer_count > 0) return;
        for (&self.providers) |*slot| {
            if (slot.* != provider) continue;
            self.freeProvider(provider);
            slot.* = null;
            return;
        }
    }

    fn freeProvider(self: *Connection, provider: *Provider) void {
        for (provider.transfers[0..provider.transfer_count]) |transfer| posix_io.close(transfer.fd);
        self.allocator.free(provider.transfers);
        if (provider.data.len > 0) self.allocator.free(provider.data);
        self.destroyProtocolProxy(provider.source, 1);
        self.allocator.destroy(provider);
    }

    fn destroyProtocolProxy(self: *Connection, proxy: *WlProxy, opcode: u32) void {
        _ = self.marshal(proxy, opcode, null, self.symbols.wl_proxy_get_version(proxy), 1, &.{});
    }

    fn destroyOffer(self: *Connection, proxy: *WlProxy) void {
        self.destroyProtocolProxy(proxy, if (self.core_data_device) 2 else 1);
    }

    fn createCoreHelper(self: *Connection) bool {
        if (comptime builtin.os.tag != .linux) return false;
        std.debug.assert(self.core_data_device);
        std.debug.assert(self.helper_surface == null);
        // Core data-device selection is focus-scoped, so WSLg needs a transparent 1x1 focused surface.
        const fd = std.posix.memfd_create("opentui-clipboard", std.os.linux.MFD.CLOEXEC) catch return false;
        self.helper_fd = fd;
        posix_io.truncate(fd, 4) catch {
            self.destroyCoreHelper();
            return false;
        };

        var new_id = [_]WlArgument{.{ .n = 0 }};
        self.helper_surface = self.marshal(
            self.compositor.?,
            0,
            self.symbols.wl_surface_interface,
            2,
            0,
            &new_id,
        ) orelse {
            self.destroyCoreHelper();
            return false;
        };
        var shell_arguments = [_]WlArgument{ .{ .n = 0 }, .{ .o = self.helper_surface.? } };
        self.helper_shell_surface = self.marshal(
            self.shell.?,
            0,
            self.symbols.wl_shell_surface_interface,
            1,
            0,
            &shell_arguments,
        ) orelse {
            self.destroyCoreHelper();
            return false;
        };
        if (self.addListener(self.helper_shell_surface.?, &shell_surface_listener) != 0) {
            self.destroyCoreHelper();
            return false;
        }
        _ = self.marshal(self.helper_shell_surface.?, 3, null, 1, 0, &.{});
        var title = [_]WlArgument{.{ .s = "OpenTUI Clipboard" }};
        _ = self.marshal(self.helper_shell_surface.?, 8, null, 1, 0, &title);

        var pool_arguments = [_]WlArgument{ .{ .n = 0 }, .{ .h = fd }, .{ .i = 4 } };
        self.helper_pool = self.marshal(
            self.shm.?,
            0,
            self.symbols.wl_shm_pool_interface,
            1,
            0,
            &pool_arguments,
        ) orelse {
            self.destroyCoreHelper();
            return false;
        };
        var buffer_arguments = [_]WlArgument{
            .{ .n = 0 },
            .{ .i = 0 },
            .{ .i = 1 },
            .{ .i = 1 },
            .{ .i = 4 },
            .{ .u = 0 },
        };
        self.helper_buffer = self.marshal(
            self.helper_pool.?,
            0,
            self.symbols.wl_buffer_interface,
            1,
            0,
            &buffer_arguments,
        ) orelse {
            self.destroyCoreHelper();
            return false;
        };
        var attach_arguments = [_]WlArgument{ .{ .o = self.helper_buffer.? }, .{ .i = 0 }, .{ .i = 0 } };
        _ = self.marshal(self.helper_surface.?, 1, null, 2, 0, &attach_arguments);
        var damage_arguments = [_]WlArgument{ .{ .i = 0 }, .{ .i = 0 }, .{ .i = 1 }, .{ .i = 1 } };
        _ = self.marshal(self.helper_surface.?, 2, null, 2, 0, &damage_arguments);
        _ = self.marshal(self.helper_surface.?, 6, null, 2, 0, &.{});
        if (self.queueFlush() != .failed) return true;
        self.destroyCoreHelper();
        return false;
    }

    fn destroyCoreHelper(self: *Connection) void {
        if (self.helper_buffer) |proxy| self.destroyProtocolProxy(proxy, 0);
        if (self.helper_pool) |proxy| self.destroyProtocolProxy(proxy, 1);
        if (self.helper_shell_surface) |proxy| self.symbols.wl_proxy_destroy(proxy);
        if (self.helper_surface) |proxy| self.destroyProtocolProxy(proxy, 0);
        if (self.helper_fd) |fd| posix_io.close(fd);
        self.helper_shell_surface = null;
        self.helper_surface = null;
        self.helper_buffer = null;
        self.helper_pool = null;
        self.helper_fd = null;
        self.core_focus_entered = false;
        self.core_focus_lost = false;
        self.core_selection_seen = false;
        if (self.display != null) _ = self.queueFlush();
    }

    fn driveProviderTransfer(_: *Connection, provider: *Provider, index: u32) void {
        const transfer = &provider.transfers[index];
        const now_ns = clipboard_clock.nowNs();
        if (providerTransferExpired(transfer.last_progress_ns, now_ns)) {
            finishProviderTransfer(provider, index);
            return;
        }
        const remaining = provider.data[transfer.offset..];
        const chunk = remaining[0..@min(remaining.len, 64 * 1024)];
        const count = writeProviderPipe(transfer.fd, chunk) catch |err| switch (err) {
            error.WouldBlock => return,
            else => 0,
        };
        transfer.offset += count;
        if (count > 0) transfer.last_progress_ns = now_ns;
        if (count == 0 or transfer.offset == provider.data.len) {
            finishProviderTransfer(provider, index);
        }
    }

    fn bindDevice(self: *Connection) SelectionResult {
        const seat = self.selectSeat() orelse return .unsupported;
        if (self.ext_global == null and self.wlr_global == null) return self.bindCoreDevice(seat);
        const kind: protocol.Kind = if (self.ext_global != null) .ext else .wlr;
        self.metadata.init(kind, self.symbols.wl_seat_interface);
        const manager_version: u32 = if (kind == .ext) 1 else @min(self.wlr_version, 2);
        const manager_global = if (kind == .ext) self.ext_global.? else self.wlr_global.?;
        const manager = self.bind(manager_global, &self.metadata.manager, manager_version) orelse return .failed;
        self.manager = manager;
        self.bound_manager_global = manager_global;
        var arguments = [_]WlArgument{ .{ .n = 0 }, .{ .o = seat.proxy } };
        const device = self.marshal(manager, 1, &self.metadata.device, manager_version, 0, &arguments) orelse return .failed;
        self.device = device;
        self.bound_seat_global = seat.global_name;
        if (self.addListener(device, &device_listener) != 0) return .failed;
        self.primary_supported = false;
        return switch (self.queueFlush()) {
            .complete => .ok,
            .pending => .pending,
            .failed => .failed,
        };
    }

    fn coreDataDeviceAvailable(self: *const Connection) bool {
        return self.allow_core_data_device and self.core_manager_global != null and
            self.compositor_global != null and self.shm_global != null and self.shell_global != null;
    }

    fn bindCoreDevice(self: *Connection, seat: *const Seat) SelectionResult {
        if (!self.coreDataDeviceAvailable()) return .unsupported;
        if (seat.capabilities & WL_SEAT_CAPABILITY_KEYBOARD == 0) return .unsupported;
        const manager = self.bind(
            self.core_manager_global.?,
            self.symbols.wl_data_device_manager_interface,
            1,
        ) orelse return .failed;
        self.manager = manager;
        self.core_data_device = true;
        self.bound_manager_global = self.core_manager_global.?;
        self.compositor = self.bind(
            self.compositor_global.?,
            self.symbols.wl_compositor_interface,
            2,
        ) orelse return .failed;
        self.shm = self.bind(self.shm_global.?, self.symbols.wl_shm_interface, 1) orelse return .failed;
        self.shell = self.bind(self.shell_global.?, self.symbols.wl_shell_interface, 1) orelse return .failed;

        var device_arguments = [_]WlArgument{ .{ .n = 0 }, .{ .o = seat.proxy } };
        self.device = self.marshal(
            manager,
            1,
            self.symbols.wl_data_device_interface,
            1,
            0,
            &device_arguments,
        ) orelse return .failed;
        if (self.addListener(self.device.?, &core_device_listener) != 0) return .failed;

        var keyboard_arguments = [_]WlArgument{.{ .n = 0 }};
        self.keyboard = self.marshal(
            seat.proxy,
            1,
            self.symbols.wl_keyboard_interface,
            1,
            0,
            &keyboard_arguments,
        ) orelse return .failed;
        if (self.addListener(self.keyboard.?, &keyboard_listener) != 0) return .failed;
        self.bound_seat_global = seat.global_name;
        self.primary_supported = false;
        return switch (self.queueFlush()) {
            .complete => .ok,
            .pending => .pending,
            .failed => .failed,
        };
    }

    fn selectSeat(self: *Connection) ?*Seat {
        if (self.seat_count == 0) return null;
        if (self.requested_seat.len > 0) {
            for (self.seats[0..self.seat_count]) |*seat| {
                if (std.mem.eql(u8, seat.nameSlice(), self.requested_seat)) return seat;
            }
            return null;
        }
        if (self.seats_overflowed) return null;
        if (self.environment_seat.len > 0) {
            for (self.seats[0..self.seat_count]) |*seat| {
                if (std.mem.eql(u8, seat.nameSlice(), self.environment_seat)) return seat;
            }
        }
        if (self.seat_count != 1) return null;
        return &self.seats[0];
    }

    fn bind(self: *Connection, name: u32, interface: *const WlInterface, version: u32) ?*WlProxy {
        var arguments = [_]WlArgument{
            .{ .u = name },
            .{ .s = interface.name },
            .{ .u = version },
            .{ .n = 0 },
        };
        return self.marshal(self.registry.?, 0, interface, version, 0, &arguments);
    }

    fn marshal(
        self: *Connection,
        proxy: *WlProxy,
        opcode: u32,
        interface: ?*const WlInterface,
        version: u32,
        flags: u32,
        arguments: []const WlArgument,
    ) ?*WlProxy {
        if (comptime builtin.is_test) self.test_marshal_count += 1;
        var empty: [1]WlArgument = undefined;
        const pointer: [*]WlArgument = if (arguments.len == 0) &empty else @constCast(arguments.ptr);
        return self.symbols.wl_proxy_marshal_array_flags(proxy, opcode, interface, version, flags, pointer);
    }

    fn displayHealthy(self: *const Connection) bool {
        if (comptime builtin.is_test) {
            if (self.display_error_override) |display_error| return display_error == 0;
        }
        const display = self.display orelse return false;
        return self.symbols.wl_display_get_error(display) == 0;
    }

    fn addListener(self: *Connection, proxy: *WlProxy, listener: []const *const anyopaque) c_int {
        return self.symbols.wl_proxy_add_listener(proxy, listener.ptr, self);
    }

    fn fail(self: *Connection, failure: Failure) Progress {
        if (self.barrier_callback) |callback| self.symbols.wl_proxy_destroy(callback);
        self.barrier_callback = null;
        if (self.failure == .none) self.failure = failure;
        self.phase = .failed;
        return .failed;
    }

    fn selectionFailure(self: *Connection, failure: Failure) SelectionResult {
        if (self.failure == .none) self.failure = failure;
        return .failed;
    }

    fn registryGlobal(
        data: ?*anyopaque,
        _: ?*WlProxy,
        name: u32,
        interface_pointer: [*:0]const u8,
        version: u32,
    ) callconv(.c) void {
        const self: *Connection = @ptrCast(@alignCast(data.?));
        const interface = std.mem.span(interface_pointer);
        if (std.mem.eql(u8, interface, "ext_data_control_manager_v1")) {
            self.ext_global = name;
        } else if (std.mem.eql(u8, interface, "zwlr_data_control_manager_v1")) {
            self.wlr_global = name;
            self.wlr_version = version;
        } else if (std.mem.eql(u8, interface, "wl_data_device_manager")) {
            self.core_manager_global = name;
        } else if (std.mem.eql(u8, interface, "wl_compositor")) {
            self.compositor_global = name;
        } else if (std.mem.eql(u8, interface, "wl_shm")) {
            self.shm_global = name;
        } else if (std.mem.eql(u8, interface, "wl_shell")) {
            self.shell_global = name;
        } else if (std.mem.eql(u8, interface, "wl_seat")) {
            self.addSeat(name, version);
        }
    }

    fn registryGlobalRemove(data: ?*anyopaque, _: ?*WlProxy, name: u32) callconv(.c) void {
        const self: *Connection = @ptrCast(@alignCast(data.?));
        if (self.removeGlobal(name)) |proxy| self.symbols.wl_proxy_destroy(proxy);
    }

    fn removeGlobal(self: *Connection, name: u32) ?*WlProxy {
        if (self.ext_global == name) self.ext_global = null;
        if (self.wlr_global == name) {
            self.wlr_global = null;
            self.wlr_version = 0;
        }
        if (self.core_manager_global == name) self.core_manager_global = null;
        if (self.compositor_global == name) self.compositor_global = null;
        if (self.shm_global == name) self.shm_global = null;
        if (self.shell_global == name) self.shell_global = null;
        if (self.bound_manager_global == name) {
            const manager = self.manager;
            self.manager = null;
            self.bound_manager_global = null;
            _ = self.fail(.protocol);
            return manager;
        }

        var index: u8 = 0;
        while (index < self.seat_count) : (index += 1) {
            if (self.seats[index].global_name != name) continue;
            const proxy = self.seats[index].proxy;
            self.seat_count -= 1;
            self.seats[index] = self.seats[self.seat_count];
            if (self.bound_seat_global == name) {
                _ = self.fail(.protocol);
            }
            return proxy;
        }
        return null;
    }

    fn addSeat(self: *Connection, name: u32, version: u32) void {
        if (self.seat_count == MAX_SEATS) {
            self.seats_overflowed = true;
            return;
        }
        const proxy = self.bind(name, self.symbols.wl_seat_interface, @min(version, 2)) orelse {
            self.seats_overflowed = true;
            return;
        };
        const seat = &self.seats[self.seat_count];
        seat.* = .{ .global_name = name, .proxy = proxy };
        self.seat_count += 1;
        _ = self.addListener(proxy, &seat_listener);
    }

    fn seatCapabilities(data: ?*anyopaque, proxy: ?*WlProxy, capabilities: u32) callconv(.c) void {
        const self: *Connection = @ptrCast(@alignCast(data.?));
        for (self.seats[0..self.seat_count]) |*seat| {
            if (seat.proxy != proxy) continue;
            const had_keyboard = seat.capabilities & WL_SEAT_CAPABILITY_KEYBOARD != 0;
            seat.capabilities = capabilities;
            const has_keyboard = capabilities & WL_SEAT_CAPABILITY_KEYBOARD != 0;
            if (self.core_data_device and self.bound_seat_global == seat.global_name and had_keyboard and !has_keyboard) {
                self.core_focus_lost = true;
                _ = self.fail(.protocol);
            }
            return;
        }
    }

    fn seatName(data: ?*anyopaque, proxy: ?*WlProxy, name_pointer: [*:0]const u8) callconv(.c) void {
        const self: *Connection = @ptrCast(@alignCast(data.?));
        const name = std.mem.span(name_pointer);
        if (name.len > MAX_SEAT_NAME_BYTES) return;
        for (self.seats[0..self.seat_count]) |*seat| {
            if (seat.proxy != proxy) continue;
            @memcpy(seat.name[0..name.len], name);
            seat.name_length = @intCast(name.len);
            return;
        }
    }

    fn callbackDone(data: ?*anyopaque, callback: ?*WlProxy, _: u32) callconv(.c) void {
        const self: *Connection = @ptrCast(@alignCast(data.?));
        if (callback) |proxy| self.symbols.wl_proxy_destroy(proxy);
        self.sync_callback = null;
        self.sync_done = true;
    }

    fn deviceDataOffer(data: ?*anyopaque, _: ?*WlProxy, offer_proxy: ?*WlProxy) callconv(.c) void {
        const self: *Connection = @ptrCast(@alignCast(data.?));
        const proxy = offer_proxy orelse return;
        if (self.offer_count == MAX_OFFERS) {
            self.destroyOffer(proxy);
            return;
        }
        self.offers[self.offer_count] = .{ .proxy = proxy };
        self.offer_count += 1;
        _ = self.addListener(proxy, &offer_listener);
    }

    fn deviceSelection(data: ?*anyopaque, _: ?*WlProxy, offer: ?*WlProxy) callconv(.c) void {
        const self: *Connection = @ptrCast(@alignCast(data.?));
        if (self.core_data_device and (self.core_focus_users == 0 or self.helper_surface == null)) {
            if (offer) |proxy| self.removeOffer(proxy);
            return;
        }
        if (self.clipboard_offer) |previous| {
            if (previous != offer and previous != self.primary_offer) self.removeOffer(previous);
        }
        self.clipboard_offer = offer;
        if (self.core_data_device) self.core_selection_seen = true;
    }

    fn coreDeviceEnter(
        data: ?*anyopaque,
        _: ?*WlProxy,
        _: u32,
        _: ?*WlProxy,
        _: i32,
        _: i32,
        offer: ?*WlProxy,
    ) callconv(.c) void {
        const self: *Connection = @ptrCast(@alignCast(data.?));
        if (offer) |proxy| self.removeOffer(proxy);
    }

    fn coreDeviceLeave(_: ?*anyopaque, _: ?*WlProxy) callconv(.c) void {}

    fn coreDeviceMotion(_: ?*anyopaque, _: ?*WlProxy, _: u32, _: i32, _: i32) callconv(.c) void {}

    fn coreDeviceDrop(_: ?*anyopaque, _: ?*WlProxy) callconv(.c) void {}

    fn keyboardKeymap(_: ?*anyopaque, _: ?*WlProxy, _: u32, fd: std.posix.fd_t, _: u32) callconv(.c) void {
        posix_io.close(fd);
    }

    fn keyboardEnter(
        data: ?*anyopaque,
        _: ?*WlProxy,
        _: u32,
        surface: ?*WlProxy,
        _: ?*anyopaque,
    ) callconv(.c) void {
        const self: *Connection = @ptrCast(@alignCast(data.?));
        if (surface == self.helper_surface) self.core_focus_entered = true;
    }

    fn keyboardLeave(data: ?*anyopaque, _: ?*WlProxy, _: u32, surface: ?*WlProxy) callconv(.c) void {
        const self: *Connection = @ptrCast(@alignCast(data.?));
        if (surface != self.helper_surface) return;
        self.core_focus_entered = false;
        self.core_selection_seen = false;
        self.core_focus_lost = true;
        if (self.clipboard_offer) |offer| self.removeOffer(offer);
        self.clipboard_offer = null;
    }

    fn keyboardKey(_: ?*anyopaque, _: ?*WlProxy, _: u32, _: u32, _: u32, _: u32) callconv(.c) void {}

    fn keyboardModifiers(
        _: ?*anyopaque,
        _: ?*WlProxy,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
        _: u32,
    ) callconv(.c) void {}

    fn shellSurfacePing(data: ?*anyopaque, shell_surface: ?*WlProxy, serial: u32) callconv(.c) void {
        const self: *Connection = @ptrCast(@alignCast(data.?));
        var arguments = [_]WlArgument{.{ .u = serial }};
        _ = self.marshal(shell_surface.?, 0, null, 1, 0, &arguments);
        _ = self.queueFlush();
    }

    fn shellSurfaceConfigure(_: ?*anyopaque, _: ?*WlProxy, _: u32, _: i32, _: i32) callconv(.c) void {}

    fn shellSurfacePopupDone(_: ?*anyopaque, _: ?*WlProxy) callconv(.c) void {}

    fn deviceFinished(data: ?*anyopaque, _: ?*WlProxy) callconv(.c) void {
        const self: *Connection = @ptrCast(@alignCast(data.?));
        _ = self.fail(.protocol);
    }

    fn devicePrimarySelection(data: ?*anyopaque, _: ?*WlProxy, offer: ?*WlProxy) callconv(.c) void {
        const self: *Connection = @ptrCast(@alignCast(data.?));
        self.primary_supported = true;
        if (self.primary_offer) |previous| {
            if (previous != offer and previous != self.clipboard_offer) self.removeOffer(previous);
        }
        self.primary_offer = offer;
    }

    fn removeOffer(self: *Connection, proxy: *WlProxy) void {
        var index: u8 = 0;
        while (index < self.offer_count) : (index += 1) {
            if (self.offers[index].proxy != proxy) continue;
            self.destroyOffer(proxy);
            self.offer_count -= 1;
            self.offers[index] = self.offers[self.offer_count];
            return;
        }
    }

    fn offerMime(data: ?*anyopaque, offer_proxy: ?*WlProxy, mime_pointer: [*:0]const u8) callconv(.c) void {
        const self: *Connection = @ptrCast(@alignCast(data.?));
        const proxy = offer_proxy orelse return;
        const mime = std.mem.span(mime_pointer);
        if (!isRelevantMime(mime)) return;
        for (self.offers[0..self.offer_count]) |*offer| {
            if (offer.proxy != proxy) continue;
            const essence = canonicalMimeEssence(mime).?;
            for (offer.mimes[0..offer.mime_count]) |*existing| {
                const existing_essence = canonicalMimeEssence(existing.slice()).?;
                if (std.ascii.eqlIgnoreCase(existing_essence, essence)) return;
            }
            if (offer.mime_count == MAX_OFFER_MIME_TYPES) return;
            const entry = &offer.mimes[offer.mime_count];
            @memcpy(entry.bytes[0..mime.len], mime);
            entry.length = @intCast(mime.len);
            offer.mime_count += 1;
            return;
        }
    }

    fn sourceSend(data: ?*anyopaque, _: ?*WlProxy, mime_pointer: [*:0]const u8, fd: i32) callconv(.c) void {
        if (comptime builtin.os.tag != .linux) return;
        const provider: *Provider = @ptrCast(@alignCast(data.?));
        const mime = std.mem.span(mime_pointer);
        const essence = canonicalMimeEssence(mime);
        if (essence == null or !std.ascii.eqlIgnoreCase(essence.?, "text/plain") or
            provider.cancelled or provider.transfer_count == provider.transfers.len)
        {
            posix_io.close(fd);
            return;
        }
        const flags = posix_io.getFlags(fd) catch {
            posix_io.close(fd);
            return;
        };
        const nonblocking: u32 = @bitCast(std.posix.O{ .NONBLOCK = true });
        posix_io.setFlags(fd, flags | nonblocking) catch {
            posix_io.close(fd);
            return;
        };
        provider.transfers[provider.transfer_count] = .{
            .fd = fd,
            .last_progress_ns = clipboard_clock.nowNs(),
        };
        provider.transfer_count += 1;
    }

    fn sourceCancelled(data: ?*anyopaque, _: ?*WlProxy) callconv(.c) void {
        const provider: *Provider = @ptrCast(@alignCast(data.?));
        provider.cancelled = true;
        if (provider.connection.clipboard_provider == provider) provider.connection.clipboard_provider = null;
        if (provider.connection.primary_provider == provider) provider.connection.primary_provider = null;
    }
};

fn writeProviderPipe(fd: std.posix.fd_t, bytes: []const u8) std.Io.File.Writer.Error!usize {
    if (comptime builtin.os.tag != .linux) return posix_io.write(fd, bytes);

    const Signal = struct {
        extern "c" fn sigpending(set: *std.posix.sigset_t) c_int;
        extern "c" fn sigtimedwait(
            set: *const std.posix.sigset_t,
            info: ?*std.posix.siginfo_t,
            timeout: *const std.posix.timespec,
        ) c_int;
    };

    var blocked = std.posix.sigemptyset();
    std.posix.sigaddset(&blocked, std.posix.SIG.PIPE);
    var previous: std.posix.sigset_t = undefined;
    std.posix.sigprocmask(std.posix.SIG.BLOCK, &blocked, &previous);
    defer std.posix.sigprocmask(std.posix.SIG.SETMASK, &previous, null);

    var pending = std.posix.sigemptyset();
    const pipe_was_pending = Signal.sigpending(&pending) != 0 or std.posix.sigismember(&pending, std.posix.SIG.PIPE);
    return posix_io.write(fd, bytes) catch |err| {
        if (err == error.BrokenPipe and !pipe_was_pending) {
            const timeout: std.posix.timespec = .{ .sec = 0, .nsec = 0 };
            while (true) {
                const result = Signal.sigtimedwait(&blocked, null, &timeout);
                if (result >= 0 or std.posix.errno(result) != .INTR) break;
            }
        }
        return err;
    };
}

fn finishProviderTransfer(provider: *Provider, index: u32) void {
    posix_io.close(provider.transfers[index].fd);
    provider.transfer_count -= 1;
    provider.transfers[index] = provider.transfers[provider.transfer_count];
    if (provider.transfer_count == 0) provider.transfer_cursor = 0 else provider.transfer_cursor %= provider.transfer_count;
}

fn providerTransferExpired(last_progress_ns: i128, now_ns: i128) bool {
    return now_ns - last_progress_ns >= PROVIDER_TRANSFER_IDLE_TIMEOUT_NS;
}

fn isRelevantMime(mime: []const u8) bool {
    if (mime.len > MAX_MIME_BYTES) return false;
    return canonicalMimeEssence(mime) != null;
}

pub fn canonicalMimeEssence(mime: []const u8) ?[]const u8 {
    var parts = std.mem.splitScalar(u8, mime, ';');
    const raw_essence = std.mem.trim(u8, parts.next() orelse return null, " \t\r\n");
    const essence: []const u8 = if (std.ascii.eqlIgnoreCase(raw_essence, "text/plain"))
        "text/plain"
    else if (std.ascii.eqlIgnoreCase(raw_essence, "image/png"))
        "image/png"
    else if (std.ascii.eqlIgnoreCase(raw_essence, "image/jpeg"))
        "image/jpeg"
    else if (std.ascii.eqlIgnoreCase(raw_essence, "image/webp"))
        "image/webp"
    else if (std.ascii.eqlIgnoreCase(raw_essence, "image/gif"))
        "image/gif"
    else if (std.ascii.eqlIgnoreCase(raw_essence, "image/bmp"))
        "image/bmp"
    else
        return null;

    while (parts.next()) |raw_parameter| {
        const parameter = std.mem.trim(u8, raw_parameter, " \t\r\n");
        if (parameter.len == 0) continue;
        const separator = std.mem.indexOfScalar(u8, parameter, '=') orelse continue;
        const name = std.mem.trim(u8, parameter[0..separator], " \t\r\n");
        if (!std.ascii.eqlIgnoreCase(name, "charset")) continue;
        if (!std.ascii.eqlIgnoreCase(essence, "text/plain")) continue;
        var value = std.mem.trim(u8, parameter[separator + 1 ..], " \t\r\n");
        if (value.len >= 2 and value[0] == '"' and value[value.len - 1] == '"') {
            value = std.mem.trim(u8, value[1 .. value.len - 1], " \t\r\n");
        }
        if (!std.ascii.eqlIgnoreCase(value, "utf-8")) return null;
    }
    return essence;
}

fn classifyFlush(result: c_int, errno: std.posix.E) FlushResult {
    if (result >= 0) return .complete;
    return if (errno == .AGAIN) .pending else .failed;
}

const registry_listener = [_]*const anyopaque{
    @ptrCast(&Connection.registryGlobal),
    @ptrCast(&Connection.registryGlobalRemove),
};
const seat_listener = [_]*const anyopaque{
    @ptrCast(&Connection.seatCapabilities),
    @ptrCast(&Connection.seatName),
};
const callback_listener = [_]*const anyopaque{@ptrCast(&Connection.callbackDone)};
const barrier_listener = [_]*const anyopaque{@ptrCast(&Connection.barrierDone)};
const device_listener = [_]*const anyopaque{
    @ptrCast(&Connection.deviceDataOffer),
    @ptrCast(&Connection.deviceSelection),
    @ptrCast(&Connection.deviceFinished),
    @ptrCast(&Connection.devicePrimarySelection),
};
const core_device_listener = [_]*const anyopaque{
    @ptrCast(&Connection.deviceDataOffer),
    @ptrCast(&Connection.coreDeviceEnter),
    @ptrCast(&Connection.coreDeviceLeave),
    @ptrCast(&Connection.coreDeviceMotion),
    @ptrCast(&Connection.coreDeviceDrop),
    @ptrCast(&Connection.deviceSelection),
};
const keyboard_listener = [_]*const anyopaque{
    @ptrCast(&Connection.keyboardKeymap),
    @ptrCast(&Connection.keyboardEnter),
    @ptrCast(&Connection.keyboardLeave),
    @ptrCast(&Connection.keyboardKey),
    @ptrCast(&Connection.keyboardModifiers),
};
const shell_surface_listener = [_]*const anyopaque{
    @ptrCast(&Connection.shellSurfacePing),
    @ptrCast(&Connection.shellSurfaceConfigure),
    @ptrCast(&Connection.shellSurfacePopupDone),
};
const offer_listener = [_]*const anyopaque{@ptrCast(&Connection.offerMime)};
const source_listener = [_]*const anyopaque{
    @ptrCast(&Connection.sourceSend),
    @ptrCast(&Connection.sourceCancelled),
};

test "Wayland seat selection treats XDG_SEAT as advisory but explicit configuration as strict" {
    const seat_interface: WlInterface = .{
        .name = "wl_seat",
        .version = 2,
        .method_count = 0,
        .methods = null,
        .event_count = 0,
        .events = null,
    };
    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_proxy_marshal_array_flags = testMarshalFailure;
    symbols.wl_seat_interface = &seat_interface;
    var connection = Connection.init(std.testing.allocator, &symbols, "", "", 1);
    connection.registry = @ptrFromInt(3);
    connection.seat_count = 1;
    connection.seats[0] = .{ .global_name = 1, .proxy = @ptrFromInt(1) };
    @memcpy(connection.seats[0].name[0..8], "Hyprland");
    connection.seats[0].name_length = 8;

    connection.requested_seat = "";
    connection.environment_seat = "seat0";
    try std.testing.expectEqual(@as(u32, 1), connection.selectSeat().?.global_name);

    connection.requested_seat = "seat0";
    try std.testing.expect(connection.selectSeat() == null);

    connection.requested_seat = "Hyprland";
    try std.testing.expectEqual(@as(u32, 1), connection.selectSeat().?.global_name);

    connection.requested_seat = "";
    connection.environment_seat = "seat0";
    connection.seat_count = 2;
    connection.seats[1] = .{ .global_name = 2, .proxy = @ptrFromInt(2) };
    @memcpy(connection.seats[1].name[0..5], "other");
    connection.seats[1].name_length = 5;
    try std.testing.expect(connection.selectSeat() == null);

    // Removing one valid global leaves the remaining sole seat unambiguous.
    try std.testing.expect(connection.removeGlobal(2) == @as(*WlProxy, @ptrFromInt(2)));
    try std.testing.expect(connection.selectSeat() == &connection.seats[0]);

    // A failed bind makes automatic fallback conservative without retaining removed globals.
    connection.addSeat(3, 2);
    try std.testing.expect(connection.seats_overflowed);
    connection.requested_seat = "Hyprland";
    try std.testing.expect(connection.selectSeat() == &connection.seats[0]);
    connection.requested_seat = "";
    try std.testing.expect(connection.selectSeat() == null);
}

test "Wayland core helper destroys its role before its surface" {
    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_proxy_marshal_array_flags = testMarshal;
    symbols.wl_proxy_destroy = testRoleDestroy;
    symbols.wl_proxy_get_version = testProxyVersion;
    var connection = Connection.init(std.testing.allocator, &symbols, "", "", 1);
    connection.helper_surface = @ptrFromInt(1);
    connection.helper_shell_surface = @ptrFromInt(2);
    test_role_destroyed_before_surface = false;
    test_role_connection = &connection;

    connection.destroyCoreHelper();

    try std.testing.expect(test_role_destroyed_before_surface);
}

test "Wayland connection setup applies the finite receive buffer cap" {
    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_display_connect = testDisplayConnect;
    symbols.wl_display_set_max_buffer_size = testSetMaxBufferSize;
    symbols.wl_proxy_marshal_array_flags = testMarshal;
    symbols.wl_proxy_add_listener = testAddListener;
    var connection = Connection.init(std.testing.allocator, &symbols, "", "", 1);
    connection.flush_outcome_override = .{ .result = 0, .errno = .SUCCESS };
    test_max_buffer_size = 0;

    try connection.start();

    try std.testing.expectEqual(@as(usize, WAYLAND_CONNECTION_BUFFER_SIZE_MAX), test_max_buffer_size);

    // libwayland before 1.23 has no cap symbol; setup must still succeed because
    // those versions already use fixed-size bounded connection buffers.
    symbols.wl_display_set_max_buffer_size = null;
    var uncapped = Connection.init(std.testing.allocator, &symbols, "", "", 1);
    uncapped.flush_outcome_override = .{ .result = 0, .errno = .SUCCESS };
    test_max_buffer_size = 0;

    try uncapped.start();

    try std.testing.expectEqual(@as(usize, 0), test_max_buffer_size);
}

test "Wayland dispatch drains queued callbacks up to the per-drive bound" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_display_dispatch_pending_single = testDispatchQueue;
    symbols.wl_display_prepare_read = testPrepareReadBlocked;
    var connection = Connection.init(std.testing.allocator, &symbols, "", "", 1);
    connection.display = @ptrFromInt(1);
    connection.flush_outcome_override = .{ .result = 0, .errno = .SUCCESS };
    for ([_]u32{ 3, DISPATCH_EVENTS_PER_DRIVE_MAX, DISPATCH_EVENTS_PER_DRIVE_MAX + 5 }) |queued| {
        test_dispatch_call_count = 0;
        test_dispatched_callback_count = 0;
        test_dispatch_queue_length = queued;

        try std.testing.expect(connection.dispatchAvailable());
        const dispatched = @min(queued, DISPATCH_EVENTS_PER_DRIVE_MAX);
        try std.testing.expectEqual(dispatched, test_dispatched_callback_count);
        try std.testing.expectEqual(queued - dispatched, test_dispatch_queue_length);
    }
}

test "Wayland dispatch bulk-drains pending events without the 1.25 single-event symbol" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    // Ubuntu 26.04 ships libwayland 1.24, which lacks wl_display_dispatch_pending_single.
    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_display_dispatch_pending_single = null;
    symbols.wl_display_dispatch_pending = testDispatchQueueBulk;
    symbols.wl_display_prepare_read = testPrepareReadBlocked;
    var connection = Connection.init(std.testing.allocator, &symbols, "", "", 1);
    connection.display = @ptrFromInt(1);
    connection.flush_outcome_override = .{ .result = 0, .errno = .SUCCESS };
    test_dispatch_call_count = 0;
    test_dispatched_callback_count = 0;
    test_dispatch_queue_length = DISPATCH_EVENTS_PER_DRIVE_MAX + 5;

    try std.testing.expect(connection.dispatchAvailable());
    try std.testing.expectEqual(@as(u32, DISPATCH_EVENTS_PER_DRIVE_MAX + 5), test_dispatched_callback_count);
    try std.testing.expectEqual(@as(u32, 0), test_dispatch_queue_length);
}

test "Wayland selection barrier orders admissions across in-flight syncs" {
    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_proxy_marshal_array_flags = testMarshal;
    symbols.wl_proxy_add_listener = testAddListener;
    symbols.wl_proxy_destroy = testDestroyProxy;
    var connection = Connection.init(std.testing.allocator, &symbols, "", "", 1);
    connection.display = @ptrFromInt(1);
    connection.flush_outcome_override = .{ .result = 0, .errno = .SUCCESS };

    try std.testing.expect(!connection.hasWork());
    const first = connection.requestSelectionBarrier().?;
    try std.testing.expectEqual(@as(u64, 1), first);
    try std.testing.expectEqual(@as(u8, 1), connection.test_marshal_count);
    try std.testing.expect(!connection.selectionBarrierReached(first));
    try std.testing.expect(connection.hasWork());

    // A read admitted while a sync is in flight must wait for the follow-up.
    const second = connection.requestSelectionBarrier().?;
    try std.testing.expectEqual(@as(u64, 2), second);
    try std.testing.expectEqual(@as(u8, 1), connection.test_marshal_count);

    Connection.barrierDone(&connection, connection.barrier_callback, 0);
    try std.testing.expect(connection.selectionBarrierReached(first));
    try std.testing.expect(!connection.selectionBarrierReached(second));
    try std.testing.expectEqual(@as(u8, 2), connection.test_marshal_count);

    Connection.barrierDone(&connection, connection.barrier_callback, 0);
    try std.testing.expect(connection.selectionBarrierReached(second));
    try std.testing.expect(connection.barrier_callback == null);
    try std.testing.expectEqual(@as(u8, 2), connection.test_marshal_count);
    try std.testing.expect(!connection.hasWork());
}

test "Wayland selection barrier reports sync issue failure to the caller" {
    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_proxy_marshal_array_flags = testMarshalFailure;
    var connection = Connection.init(std.testing.allocator, &symbols, "", "", 1);
    connection.display = @ptrFromInt(1);

    try std.testing.expect(connection.requestSelectionBarrier() == null);
    try std.testing.expect(connection.barrier_callback == null);

    symbols.wl_proxy_marshal_array_flags = testMarshal;
    symbols.wl_proxy_add_listener = testAddListener;
    symbols.wl_proxy_destroy = testDestroyProxy;
    var flush_failure = Connection.init(std.testing.allocator, &symbols, "", "", 1);
    flush_failure.display = @ptrFromInt(1);
    flush_failure.flush_outcome_override = .{ .result = -1, .errno = .PIPE };
    try std.testing.expect(flush_failure.requestSelectionBarrier() == null);
    try std.testing.expect(flush_failure.barrier_callback == null);
    try std.testing.expectEqual(Phase.failed, flush_failure.phase);
    try std.testing.expect(!flush_failure.hasWork());
}

test "Wayland read queues callbacks for the next dispatch invocation" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    const pipe = try posix_io.pipe(.{ .CLOEXEC = true });
    defer posix_io.close(pipe[0]);
    defer posix_io.close(pipe[1]);
    _ = try posix_io.write(pipe[1], "x");
    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_display_dispatch_pending_single = testDispatchQueue;
    symbols.wl_display_prepare_read = testPrepareReadReady;
    symbols.wl_display_get_fd = testDisplayGetFd;
    symbols.wl_display_read_events = testReadEvents;
    symbols.wl_display_cancel_read = testCancelRead;
    var connection = Connection.init(std.testing.allocator, &symbols, "", "", 1);
    connection.display = @ptrFromInt(1);
    connection.flush_outcome_override = .{ .result = 0, .errno = .SUCCESS };
    test_display_fd = pipe[0];
    test_dispatch_call_count = 0;
    test_dispatched_callback_count = 0;
    test_dispatch_queue_length = 0;
    test_read_event_count = 0;

    try std.testing.expect(connection.dispatchAvailable());
    try std.testing.expectEqual(@as(u32, 1), test_dispatch_call_count);
    try std.testing.expectEqual(@as(u32, 1), test_read_event_count);
    try std.testing.expectEqual(@as(u32, 0), test_dispatched_callback_count);
    try std.testing.expectEqual(@as(u32, 1), test_dispatch_queue_length);

    try std.testing.expect(connection.dispatchAvailable());
    try std.testing.expectEqual(@as(u32, 1), test_dispatched_callback_count);
    try std.testing.expectEqual(@as(u32, 0), test_dispatch_queue_length);
}

test "Wayland writes and clears settle deterministically after marshalling for every flush outcome" {
    const TestCase = struct {
        flush: FlushOutcome,
        selection: SelectionResult,
        output_pending: bool,
        phase: Phase,
    };
    const cases = [_]TestCase{
        .{ .flush = .{ .result = 0, .errno = .SUCCESS }, .selection = .ok, .output_pending = false, .phase = .ready },
        .{ .flush = .{ .result = -1, .errno = .AGAIN }, .selection = .committed, .output_pending = true, .phase = .ready },
        .{ .flush = .{ .result = -1, .errno = .PIPE }, .selection = .failed, .output_pending = false, .phase = .failed },
    };

    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_proxy_marshal_array_flags = testMarshal;
    symbols.wl_proxy_add_listener = testAddListener;
    symbols.wl_proxy_destroy = testDestroyProxy;
    symbols.wl_proxy_get_version = testProxyVersion;

    for (cases) |case| {
        var write = testReadyConnection(&symbols, case.flush);
        try std.testing.expectEqual(case.selection, write.publishText(false, &.{}));
        try std.testing.expectEqual(case.output_pending, write.output_pending);
        try std.testing.expectEqual(case.phase, write.phase);
        try std.testing.expectEqual(@as(u8, 4), write.test_flush_marshal_count);
        write.releaseProviders();

        var clear = testReadyConnection(&symbols, case.flush);
        try std.testing.expectEqual(case.selection, clear.clearSelection(false));
        try std.testing.expectEqual(case.output_pending, clear.output_pending);
        try std.testing.expectEqual(case.phase, clear.phase);
        try std.testing.expectEqual(@as(u8, 1), clear.test_flush_marshal_count);
    }
}

test "Wayland fatal selection flush preserves local ownership state" {
    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_proxy_marshal_array_flags = testMarshal;
    symbols.wl_proxy_add_listener = testAddListener;
    symbols.wl_proxy_destroy = testDestroyProxy;
    symbols.wl_proxy_get_version = testProxyVersion;

    var failed_write = testReadyConnection(&symbols, .{ .result = -1, .errno = .PIPE });
    const caller_data = try std.testing.allocator.dupe(u8, "caller-owned");
    defer std.testing.allocator.free(caller_data);
    try std.testing.expectEqual(SelectionResult.failed, failed_write.publishText(false, caller_data));
    try std.testing.expect(!failed_write.hasProviders());

    var failed_clear = testReadyConnection(&symbols, .{ .result = 0, .errno = .SUCCESS });
    const provider_data = try std.testing.allocator.dupe(u8, "provider-owned");
    try std.testing.expectEqual(SelectionResult.ok, failed_clear.publishText(false, provider_data));
    const provider = failed_clear.clipboard_provider.?;
    failed_clear.flush_outcome_override = .{ .result = -1, .errno = .PIPE };
    try std.testing.expectEqual(SelectionResult.failed, failed_clear.clearSelection(false));
    try std.testing.expect(failed_clear.clipboard_provider == provider);
    failed_clear.releaseProviders();
}

fn testReadyConnection(symbols: *const linux.WaylandSymbols, flush: FlushOutcome) Connection {
    var connection = Connection.init(std.testing.allocator, symbols, "", "", 1);
    connection.display = @ptrFromInt(1);
    connection.manager = @ptrFromInt(2);
    connection.device = @ptrFromInt(3);
    connection.phase = .ready;
    connection.flush_outcome_override = flush;
    connection.display_error_override = 0;
    return connection;
}

var test_max_buffer_size: usize = 0;
var test_dispatch_call_count: u32 = 0;
var test_dispatched_callback_count: u32 = 0;
var test_dispatch_queue_length: u32 = 0;
var test_display_fd: std.posix.fd_t = -1;
var test_read_event_count: u32 = 0;
var test_display_error_call_count: u32 = 0;
var test_role_connection: ?*Connection = null;
var test_role_destroyed_before_surface = false;

fn testDisplayConnect(_: ?[*:0]const u8) callconv(.c) ?*linux.WlDisplay {
    return @ptrFromInt(1);
}

fn testSetMaxBufferSize(_: *linux.WlDisplay, size: usize) callconv(.c) void {
    test_max_buffer_size = size;
}

fn testDispatchQueue(_: *linux.WlDisplay) callconv(.c) c_int {
    test_dispatch_call_count += 1;
    if (test_dispatch_queue_length == 0) return 0;
    test_dispatch_queue_length -= 1;
    test_dispatched_callback_count += 1;
    return 1;
}

fn testDispatchQueueBulk(_: *linux.WlDisplay) callconv(.c) c_int {
    test_dispatch_call_count += 1;
    const dispatched: c_int = @intCast(test_dispatch_queue_length);
    test_dispatched_callback_count += test_dispatch_queue_length;
    test_dispatch_queue_length = 0;
    return dispatched;
}

fn testPrepareReadBlocked(_: *linux.WlDisplay) callconv(.c) c_int {
    return -1;
}

fn testPrepareReadReady(_: *linux.WlDisplay) callconv(.c) c_int {
    return 0;
}

fn testDisplayGetFd(_: *linux.WlDisplay) callconv(.c) c_int {
    return test_display_fd;
}

fn testReadEvents(_: *linux.WlDisplay) callconv(.c) c_int {
    test_read_event_count += 1;
    if (test_read_event_count == 1) test_dispatch_queue_length += 1;
    return 0;
}

fn testCancelRead(_: *linux.WlDisplay) callconv(.c) void {}

fn testDisplayError(_: *linux.WlDisplay) callconv(.c) c_int {
    test_display_error_call_count += 1;
    return 1;
}

fn testMarshal(
    _: *WlProxy,
    _: u32,
    _: ?*const WlInterface,
    _: u32,
    _: u32,
    _: [*]WlArgument,
) callconv(.c) ?*WlProxy {
    return @ptrFromInt(4);
}

fn testMarshalFailure(
    _: *WlProxy,
    _: u32,
    _: ?*const WlInterface,
    _: u32,
    _: u32,
    _: [*]WlArgument,
) callconv(.c) ?*WlProxy {
    return null;
}

fn testRoleDestroy(proxy: *WlProxy) callconv(.c) void {
    test_role_destroyed_before_surface = @intFromPtr(proxy) == 2 and test_role_connection.?.test_marshal_count == 0;
}

fn testAddListener(_: *WlProxy, _: [*]const *const anyopaque, _: ?*anyopaque) callconv(.c) c_int {
    return 0;
}

fn testDestroyProxy(_: *WlProxy) callconv(.c) void {}

fn testProxyVersion(_: *WlProxy) callconv(.c) u32 {
    return 1;
}

test "Wayland MIME retention ignores irrelevant metadata without consuming the bounded set" {
    try std.testing.expect(!isRelevantMime("application/x-irrelevant"));
    try std.testing.expect(!isRelevantMime(&([_]u8{'x'} ** (MAX_MIME_BYTES + 1))));

    const proxy: *WlProxy = @ptrFromInt(1);
    var connection = testOfferConnection(proxy);
    var index: u8 = 0;
    while (index < MAX_OFFER_MIME_TYPES) : (index += 1) {
        Connection.offerMime(&connection, proxy, "application/x-irrelevant");
    }
    Connection.offerMime(&connection, proxy, "image/png");
    try std.testing.expectEqual(@as(u8, 1), connection.offers[0].mime_count);
    try std.testing.expectEqualStrings("image/png", connection.offers[0].mimes[0].slice());
}

test "Wayland MIME matching parses essence and UTF-8 charset parameters" {
    const proxy: *WlProxy = @ptrFromInt(1);
    var connection = testOfferConnection(proxy);
    Connection.offerMime(&connection, proxy, " Text/Plain ; format=flowed ; charset=\"UtF-8\" ");
    Connection.offerMime(&connection, proxy, "text/plain;charset=iso-8859-1");
    Connection.offerMime(&connection, proxy, " IMAGE/PNG ; version=1 ");

    try std.testing.expectEqualStrings(
        "text/plain",
        connection.offeredMime(&connection.offers[0], " TEXT/PLAIN ; charset=UTF-8 ").?.requested,
    );
    try std.testing.expectEqualStrings(
        " Text/Plain ; format=flowed ; charset=\"UtF-8\" ",
        connection.offeredMime(&connection.offers[0], "text/plain").?.offered,
    );
    try std.testing.expectEqualStrings(
        "image/png",
        connection.offeredMime(&connection.offers[0], "image/png").?.requested,
    );
}

test "Wayland MIME retention preserves all supported essences and deduplicates aliases" {
    const proxy: *WlProxy = @ptrFromInt(1);
    var connection = testOfferConnection(proxy);

    Connection.offerMime(&connection, proxy, "image/jpeg");
    Connection.offerMime(&connection, proxy, "image/webp");
    Connection.offerMime(&connection, proxy, "IMAGE/JPEG; version=1");
    Connection.offerMime(&connection, proxy, "image/gif");
    Connection.offerMime(&connection, proxy, "image/bmp");
    Connection.offerMime(&connection, proxy, "text/plain; charset=utf-8; format=flowed");
    Connection.offerMime(&connection, proxy, "image/png; version=1");

    try std.testing.expectEqual(@as(u8, MAX_OFFER_MIME_TYPES), connection.offers[0].mime_count);
    inline for (.{ "image/jpeg", "image/webp", "image/gif", "image/bmp", "text/plain", "image/png" }) |mime| {
        try std.testing.expect(connection.offeredMime(&connection.offers[0], mime) != null);
    }
    try std.testing.expectEqualStrings("image/jpeg", connection.offers[0].mimes[0].slice());
}

test "Wayland BMP conversion fallback is restricted to WSL core compatibility" {
    const proxy: *WlProxy = @ptrFromInt(1);
    var connection = testOfferConnection(proxy);
    Connection.offerMime(&connection, proxy, "image/bmp");

    try std.testing.expect(connection.offeredMime(&connection.offers[0], "image/png") == null);

    connection.core_data_device = true;
    try std.testing.expectEqualStrings(
        "image/bmp",
        connection.offeredMime(&connection.offers[0], "image/png").?.offered,
    );
}

fn testOfferConnection(proxy: *WlProxy) Connection {
    var connection: Connection = undefined;
    connection.core_data_device = false;
    connection.offer_count = 1;
    connection.offers[0] = .{ .proxy = proxy };
    return connection;
}

test "Wayland core data-device fallback is WSL-gated and read-only" {
    var connection: Connection = undefined;
    connection.allow_core_data_device = false;
    connection.core_manager_global = 1;
    connection.compositor_global = 2;
    connection.shm_global = 3;
    connection.shell_global = 4;
    try std.testing.expect(!connection.coreDataDeviceAvailable());
    connection.allow_core_data_device = true;
    try std.testing.expect(connection.coreDataDeviceAvailable());

    connection.core_data_device = true;
    connection.failure = .provider;
    try std.testing.expectEqual(SelectionResult.unsupported, connection.publishText(false, &.{}));
    try std.testing.expectEqual(SelectionResult.unsupported, connection.clearSelection(false));
    try std.testing.expectEqual(Failure.none, connection.failure);
}

test "Wayland core helper acquisition fails closed outside Linux" {
    if (comptime builtin.os.tag == .linux) return error.SkipZigTest;
    var connection: Connection = undefined;
    connection.core_data_device = true;
    connection.phase = .ready;
    connection.core_focus_users = 0;
    connection.clipboard_offer = null;

    try std.testing.expectEqual(Progress.failed, connection.acquireCoreSelection());
    try std.testing.expectEqual(@as(u32, 0), connection.core_focus_users);
}

test "Wayland core helper requires an advertised keyboard capability" {
    const seat_proxy: *WlProxy = @ptrFromInt(1);
    var connection: Connection = undefined;
    connection.seat_count = 1;
    connection.seats[0] = .{ .global_name = 1, .proxy = seat_proxy };

    try std.testing.expectEqual(@as(u32, 0), connection.seats[0].capabilities);
    Connection.seatCapabilities(&connection, seat_proxy, WL_SEAT_CAPABILITY_KEYBOARD);
    try std.testing.expectEqual(WL_SEAT_CAPABILITY_KEYBOARD, connection.seats[0].capabilities);
    Connection.seatCapabilities(&connection, seat_proxy, 0);
    try std.testing.expectEqual(@as(u32, 0), connection.seats[0].capabilities);

    connection.allow_core_data_device = true;
    connection.core_manager_global = 1;
    connection.compositor_global = 2;
    connection.shm_global = 3;
    connection.shell_global = 4;
    try std.testing.expectEqual(SelectionResult.unsupported, connection.bindCoreDevice(&connection.seats[0]));
}

test "Wayland core focus lifecycle rejects stale and unfocused offers" {
    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_proxy_marshal_array_flags = testMarshal;
    symbols.wl_proxy_get_version = testProxyVersion;
    const offer: *WlProxy = @ptrFromInt(1);
    const surface: *WlProxy = @ptrFromInt(2);
    var connection: Connection = undefined;
    connection.symbols = &symbols;
    connection.core_data_device = true;
    connection.core_focus_entered = false;
    connection.core_focus_users = 0;
    connection.helper_surface = null;
    connection.offer_count = 1;
    connection.offers[0] = .{ .proxy = offer };
    connection.clipboard_offer = null;
    connection.primary_offer = null;
    connection.test_marshal_count = 0;

    Connection.deviceSelection(&connection, null, offer);
    try std.testing.expectEqual(@as(u8, 0), connection.offer_count);
    try std.testing.expect(connection.clipboard_offer == null);

    connection.core_focus_entered = true;
    connection.core_focus_lost = false;
    connection.core_selection_seen = true;
    connection.helper_surface = surface;
    connection.offer_count = 1;
    connection.offers[0] = .{ .proxy = offer };
    connection.clipboard_offer = offer;
    Connection.keyboardLeave(&connection, null, 1, surface);
    try std.testing.expect(!connection.core_focus_entered);
    try std.testing.expect(connection.core_focus_lost);
    try std.testing.expect(!connection.core_selection_seen);
    try std.testing.expectEqual(@as(u8, 0), connection.offer_count);
    try std.testing.expect(connection.clipboard_offer == null);
}

test "Wayland core selection becomes ready after focus and selection in either order" {
    const offer: *WlProxy = @ptrFromInt(1);
    const surface: *WlProxy = @ptrFromInt(2);
    var connection: Connection = undefined;
    connection.core_data_device = true;
    connection.phase = .ready;
    connection.core_focus_users = 1;
    connection.helper_surface = surface;
    connection.core_focus_entered = false;
    connection.core_focus_lost = false;
    connection.core_selection_seen = false;
    connection.clipboard_offer = null;
    connection.primary_offer = null;
    connection.offer_count = 1;
    connection.offers[0] = .{ .proxy = offer };

    Connection.deviceSelection(&connection, null, offer);
    try std.testing.expectEqual(offer, connection.clipboard_offer.?);
    try std.testing.expectEqual(Progress.pending, connection.coreSelectionProgress());
    Connection.keyboardEnter(&connection, null, 1, surface, null);
    try std.testing.expectEqual(Progress.ready, connection.coreSelectionProgress());

    connection.core_focus_entered = false;
    connection.core_selection_seen = false;
    connection.clipboard_offer = null;
    Connection.keyboardEnter(&connection, null, 2, surface, null);
    try std.testing.expectEqual(Progress.pending, connection.coreSelectionProgress());
    Connection.deviceSelection(&connection, null, offer);
    try std.testing.expectEqual(Progress.ready, connection.coreSelectionProgress());
}

test "Wayland bound core seat keyboard loss fails active and future acquisitions" {
    const seat_proxy: *WlProxy = @ptrFromInt(1);
    var connection: Connection = undefined;
    connection.core_data_device = true;
    connection.bound_seat_global = 7;
    connection.seat_count = 1;
    connection.seats[0] = .{
        .global_name = 7,
        .proxy = seat_proxy,
        .capabilities = WL_SEAT_CAPABILITY_KEYBOARD,
    };
    connection.core_focus_users = 1;
    connection.helper_surface = @ptrFromInt(2);
    connection.core_focus_lost = false;
    connection.failure = .none;
    connection.phase = .ready;
    connection.barrier_callback = null;

    Connection.seatCapabilities(&connection, seat_proxy, 0);

    try std.testing.expectEqual(Progress.failed, connection.coreSelectionProgress());
    connection.core_focus_users = 0;
    try std.testing.expectEqual(Progress.failed, connection.acquireCoreSelection());
    try std.testing.expectEqual(Phase.failed, connection.phase);
    try std.testing.expectEqual(Failure.protocol, connection.failure);
}

test "Wayland failed connection cancels providers and frees idle generations" {
    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_proxy_marshal_array_flags = testMarshal;
    symbols.wl_proxy_get_version = testProxyVersion;
    var connection = Connection.init(std.testing.allocator, &symbols, "", "", 1);
    const provider = try std.testing.allocator.create(Provider);
    provider.* = .{
        .connection = &connection,
        .source = @ptrFromInt(1),
        .primary = false,
        .data = &.{},
        .transfers = try std.testing.allocator.alloc(Transfer, 1),
    };
    connection.providers[0] = provider;
    connection.clipboard_provider = provider;

    connection.retireProviders();

    try std.testing.expect(connection.providers[0] == null);
    try std.testing.expect(!connection.hasWork());
}

test "Wayland failed connection lets active transfers drain but rejects new sends" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_proxy_marshal_array_flags = testMarshal;
    symbols.wl_proxy_get_version = testProxyVersion;
    var connection = Connection.init(std.testing.allocator, &symbols, "", "", 1);
    const provider = try std.testing.allocator.create(Provider);
    provider.* = .{
        .connection = &connection,
        .source = @ptrFromInt(1),
        .primary = false,
        .data = &.{},
        .transfers = try std.testing.allocator.alloc(Transfer, 1),
        .transfer_count = 1,
    };
    const active_pipe = try posix_io.pipe(.{ .CLOEXEC = true });
    defer posix_io.close(active_pipe[0]);
    provider.transfers[0] = .{ .fd = active_pipe[1], .last_progress_ns = 0 };
    connection.providers[0] = provider;
    connection.clipboard_provider = provider;

    connection.retireProviders();
    try std.testing.expect(provider.cancelled);
    try std.testing.expect(connection.providers[0] == provider);

    const rejected_pipe = try posix_io.pipe(.{ .CLOEXEC = true });
    defer posix_io.close(rejected_pipe[0]);
    Connection.sourceSend(provider, null, "text/plain", rejected_pipe[1]);
    try std.testing.expectEqual(@as(u32, 1), provider.transfer_count);

    finishProviderTransfer(provider, 0);
    _ = connection.driveProviderUnit();
    try std.testing.expect(connection.providers[0] == null);
    try std.testing.expect(!connection.hasWork());
}

test "Wayland retired provider accepts queued sends until compositor cancellation" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    try clipboard_clock.init();
    var connection: Connection = undefined;
    var transfers: [1]Transfer = undefined;
    var provider: Provider = .{
        .connection = &connection,
        .source = undefined,
        .primary = false,
        .data = &.{},
        .transfers = &transfers,
    };
    connection.clipboard_provider = null;
    connection.primary_provider = null;
    connection.providers = .{ &provider, null, null, null };
    const pipe = try posix_io.pipe(.{ .CLOEXEC = true });
    defer posix_io.close(pipe[0]);

    Connection.sourceSend(&provider, null, "text/plain", pipe[1]);

    try std.testing.expectEqual(@as(u32, 1), provider.transfer_count);
    Connection.sourceCancelled(&provider, null);
    finishProviderTransfer(&provider, 0);
}

test "Wayland reserves provider capacity independently for each selection" {
    var connection: Connection = undefined;
    var current: Provider = undefined;
    current.primary = false;
    var retired: Provider = undefined;
    retired.primary = false;
    connection.clipboard_provider = &current;
    connection.primary_provider = null;
    connection.providers = .{ &current, &retired, null, null };

    try std.testing.expect(!connection.canPublishProvider(false));
    try std.testing.expect(connection.canPublishProvider(true));
    connection.clipboard_provider = null;
    try std.testing.expect(!connection.canPublishProvider(false));
    connection.providers[1] = null;
    try std.testing.expect(connection.canPublishProvider(false));
}

test "Wayland publication reclaims cancelled providers before checking capacity" {
    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_proxy_marshal_array_flags = testMarshal;
    symbols.wl_proxy_add_listener = testAddListener;
    symbols.wl_proxy_destroy = testDestroyProxy;
    symbols.wl_proxy_get_version = testProxyVersion;
    var connection = testReadyConnection(&symbols, .{ .result = 0, .errno = .SUCCESS });

    for (connection.providers[0..2], 0..) |*slot, index| {
        const provider = try std.testing.allocator.create(Provider);
        provider.* = .{
            .connection = &connection,
            .source = @ptrFromInt(10 + index),
            .primary = false,
            .data = &.{},
            .transfers = try std.testing.allocator.alloc(Transfer, 1),
            .cancelled = index == 1,
        };
        slot.* = provider;
    }
    connection.clipboard_provider = connection.providers[0];

    try std.testing.expectEqual(SelectionResult.ok, connection.publishText(false, &.{}));
    connection.releaseProviders();
}

test "Wayland clear retires the current provider at the generation bound" {
    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_proxy_marshal_array_flags = testMarshal;
    symbols.wl_proxy_destroy = testDestroyProxy;
    symbols.wl_proxy_get_version = testProxyVersion;
    var connection = testReadyConnection(&symbols, .{ .result = 0, .errno = .SUCCESS });
    var old_transfers: [1]Transfer = undefined;
    var current_transfers: [1]Transfer = undefined;
    var old: Provider = .{
        .connection = &connection,
        .source = @ptrFromInt(4),
        .primary = false,
        .data = &.{},
        .transfers = &old_transfers,
        .transfer_count = 1,
    };
    var current: Provider = .{
        .connection = &connection,
        .source = @ptrFromInt(5),
        .primary = false,
        .data = &.{},
        .transfers = &current_transfers,
        .transfer_count = 1,
    };
    connection.providers = .{ &old, &current, null, null };
    connection.clipboard_provider = &current;

    try std.testing.expectEqual(SelectionResult.ok, connection.clearSelection(false));
    try std.testing.expect(connection.clipboard_provider == null);
    try std.testing.expect(connection.providers[0] == &old);
    try std.testing.expect(connection.providers[1] == &current);
    try std.testing.expectEqual(@as(u8, 1), old.transfer_count);
    try std.testing.expectEqual(@as(u8, 1), current.transfer_count);
}

test "Wayland provider transfers expire after a bounded idle interval" {
    try std.testing.expect(!providerTransferExpired(1, 1 + PROVIDER_TRANSFER_IDLE_TIMEOUT_NS - 1));
    try std.testing.expect(providerTransferExpired(1, 1 + PROVIDER_TRANSFER_IDLE_TIMEOUT_NS));
}

test "Wayland provider handles a closed consumer pipe locally" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;

    const State = struct {
        var sigpipe_count: std.atomic.Value(u32) = .init(0);

        fn handleSigpipe(_: std.posix.SIG) callconv(.c) void {
            _ = sigpipe_count.fetchAdd(1, .seq_cst);
        }
    };

    var old_action: std.posix.Sigaction = undefined;
    const action: std.posix.Sigaction = .{
        .handler = .{ .handler = &State.handleSigpipe },
        .mask = std.posix.sigemptyset(),
        .flags = 0,
    };
    std.posix.sigaction(std.posix.SIG.PIPE, &action, &old_action);
    defer std.posix.sigaction(std.posix.SIG.PIPE, &old_action, null);

    var old_mask: std.posix.sigset_t = undefined;
    var unblocked = std.posix.sigemptyset();
    std.posix.sigaddset(&unblocked, std.posix.SIG.PIPE);
    std.posix.sigprocmask(std.posix.SIG.UNBLOCK, &unblocked, &old_mask);
    defer std.posix.sigprocmask(std.posix.SIG.SETMASK, &old_mask, null);

    const pipe = try posix_io.pipe(.{ .CLOEXEC = true });
    posix_io.close(pipe[0]);
    defer posix_io.close(pipe[1]);

    try std.testing.expectError(error.BrokenPipe, writeProviderPipe(pipe[1], "clipboard"));
    try std.testing.expectEqual(@as(u32, 0), State.sigpipe_count.load(.seq_cst));
}

test "Wayland registry removal invalidates cached globals and selected seats" {
    var connection: Connection = undefined;
    connection.ext_global = 10;
    connection.wlr_global = 11;
    connection.wlr_version = 2;
    connection.seat_count = 1;
    connection.seats[0] = .{ .global_name = 12, .proxy = @ptrFromInt(1) };
    connection.bound_seat_global = 12;
    connection.failure = .none;
    connection.phase = .ready;
    connection.barrier_callback = null;

    try std.testing.expect(connection.removeGlobal(10) == null);
    try std.testing.expect(connection.ext_global == null);
    try std.testing.expectEqual(@as(u32, 11), connection.wlr_global.?);
    try std.testing.expect(connection.removeGlobal(12) != null);
    try std.testing.expectEqual(@as(u8, 0), connection.seat_count);
    try std.testing.expectEqual(Phase.failed, connection.phase);
    try std.testing.expectEqual(Failure.protocol, connection.failure);
}

test "Wayland registry removal invalidates the bound manager" {
    const manager: *WlProxy = @ptrFromInt(1);
    var connection: Connection = undefined;
    connection.ext_global = 20;
    connection.wlr_global = null;
    connection.manager = manager;
    connection.bound_manager_global = 20;
    connection.failure = .none;
    connection.phase = .ready;
    connection.barrier_callback = null;

    try std.testing.expectEqual(manager, connection.removeGlobal(20).?);
    try std.testing.expect(connection.ext_global == null);
    try std.testing.expect(connection.manager == null);
    try std.testing.expect(connection.bound_manager_global == null);
    try std.testing.expectEqual(Phase.failed, connection.phase);
    try std.testing.expectEqual(Failure.protocol, connection.failure);
}

test "Wayland finished device invalidates the connection" {
    var connection: Connection = undefined;
    connection.failure = .none;
    connection.phase = .ready;
    connection.barrier_callback = null;

    Connection.deviceFinished(&connection, null);

    try std.testing.expect(connection.isFailed());
    try std.testing.expectEqual(Failure.protocol, connection.failure);
}

test "Wayland selection failures do not leak across operations" {
    var connection: Connection = undefined;
    connection.failure = .provider;
    connection.phase = .ready;
    connection.primary_supported = false;
    connection.manager = null;

    try std.testing.expectEqual(SelectionResult.failed, connection.publishText(false, &.{}));
    try std.testing.expectEqual(Failure.protocol, connection.failure);
    try std.testing.expectEqual(Failure.protocol, connection.takeFailure());
    try std.testing.expectEqual(Failure.none, connection.failure);
}

test "Wayland local marshal failure preserves the current provider" {
    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_proxy_marshal_array_flags = testMarshal;
    symbols.wl_proxy_add_listener = testAddListener;
    symbols.wl_proxy_destroy = testDestroyProxy;
    symbols.wl_proxy_get_version = testProxyVersion;
    symbols.wl_display_get_error = testDisplayError;
    var connection = testReadyConnection(&symbols, .{ .result = 0, .errno = .SUCCESS });
    connection.display_error_override = null;
    var transfers: [1]Transfer = undefined;
    var current: Provider = .{
        .connection = &connection,
        .source = @ptrFromInt(8),
        .primary = false,
        .data = &.{},
        .transfers = &transfers,
    };
    connection.providers = .{ &current, null, null, null };
    connection.clipboard_provider = &current;

    test_display_error_call_count = 0;
    try std.testing.expectEqual(SelectionResult.failed, connection.clearSelection(false));
    try std.testing.expectEqual(@as(u32, 1), test_display_error_call_count);
    try std.testing.expect(connection.clipboard_provider == &current);
}

test "Wayland failed source offer does not replace the current provider" {
    var symbols: linux.WaylandSymbols = undefined;
    symbols.wl_proxy_marshal_array_flags = testMarshal;
    symbols.wl_proxy_add_listener = testAddListener;
    symbols.wl_proxy_destroy = testDestroyProxy;
    symbols.wl_proxy_get_version = testProxyVersion;
    var connection = testReadyConnection(&symbols, .{ .result = 0, .errno = .SUCCESS });
    connection.display_error_override = 1;
    var transfers: [1]Transfer = undefined;
    var current: Provider = .{
        .connection = &connection,
        .source = @ptrFromInt(8),
        .primary = false,
        .data = &.{},
        .transfers = &transfers,
    };
    connection.providers = .{ &current, null, null, null };
    connection.clipboard_provider = &current;

    try std.testing.expectEqual(SelectionResult.failed, connection.publishText(false, &.{}));
    try std.testing.expect(connection.clipboard_provider == &current);
}
