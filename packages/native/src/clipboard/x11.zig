const std = @import("std");
const builtin = @import("builtin");
const clipboard_clock = @import("clock.zig");
const sync = @import("sync.zig");
const posix_io = @import("posix-io.zig");

const SocketAddress = extern union {
    any: std.posix.sockaddr,
    in: std.posix.sockaddr.in,
    in6: std.posix.sockaddr.in6,
    un: std.posix.sockaddr.un,

    fn initUnix(path: []const u8) !SocketAddress {
        var address: std.posix.sockaddr.un = .{ .family = std.posix.AF.UNIX, .path = undefined };
        if (path.len + 1 > address.path.len) return error.NameTooLong;
        @memset(&address.path, 0);
        @memcpy(address.path[0..path.len], path);
        return .{ .un = address };
    }

    fn initIp4(bytes: [4]u8, port: u16) SocketAddress {
        return .{ .in = .{
            .port = std.mem.nativeToBig(u16, port),
            .addr = @as(*align(1) const u32, @ptrCast(&bytes)).*,
        } };
    }

    fn initIp6(bytes: [16]u8, port: u16) SocketAddress {
        return .{ .in6 = .{
            .addr = bytes,
            .port = std.mem.nativeToBig(u16, port),
            .flowinfo = 0,
            .scope_id = 0,
        } };
    }

    fn length(self: SocketAddress) std.posix.socklen_t {
        return switch (self.any.family) {
            std.posix.AF.INET => @sizeOf(std.posix.sockaddr.in),
            std.posix.AF.INET6 => @sizeOf(std.posix.sockaddr.in6),
            std.posix.AF.UNIX => @sizeOf(std.posix.sockaddr.un),
            else => unreachable,
        };
    }
};
const linux = @import("linux.zig");

pub const ATOM_PRIMARY: u32 = 1;
pub const ATOM_ATOM: u32 = 4;
pub const ATOM_STRING: u32 = 31;
const ATOM_INTEGER: u32 = 19;
const EVENT_PROPERTY_NOTIFY: u8 = 28;
const EVENT_SELECTION_CLEAR: u8 = 29;
const EVENT_SELECTION_REQUEST: u8 = 30;
const EVENT_SELECTION_NOTIFY: u8 = 31;
const EVENT_MASK_PROPERTY_CHANGE: u32 = 1 << 22;
const PROPERTY_DELETE: u8 = 1;
const MAX_PROVIDERS = 4;
const TRANSFER_IDLE_TIMEOUT_NS = 30 * std.time.ns_per_s;
const CONNECT_POLL_SLICE_MS: i32 = 20;
const CONNECT_POLL_COUNT_MAX: u16 = 500;
const XAUTHORITY_SIZE_MAX: usize = 1024 * 1024;
const XAUTHORITY_READ_CHUNK_SIZE: usize = 16 * 1024;
const DISPLAY_SIZE_MAX: usize = 4096;
const XAUTH_NAME = "MIT-MAGIC-COOKIE-1";
const XAUTH_FAMILY_INTERNET: u16 = 0;
const XAUTH_FAMILY_INTERNET6: u16 = 6;
const XAUTH_FAMILY_LOCAL: u16 = 256;
const XAUTH_FAMILY_WILD: u16 = 65535;

const ATOM_NAMES = [_][]const u8{
    "CLIPBOARD",
    "TARGETS",
    "UTF8_STRING",
    "TEXT",
    "text/plain",
    "text/plain;charset=utf-8",
    "image/png",
    "OPENTUI_CLIPBOARD",
    "INCR",
    "text/plain;charset=UTF-8",
    "TIMESTAMP",
    "image/jpeg",
    "image/webp",
    "image/gif",
};
const ATOM_TIMESTAMP_INDEX = 10;

pub const Progress = enum { pending, ready, unsupported, failed };
pub const Failure = enum { none, connection, flush, atom, protocol, provider };
pub const SelectionResult = enum { ok, pending, committed, unsupported, failed };
pub const ReadResult = enum { pending, ready, refused, candidate_failed, limit_exceeded, out_of_memory, failed };

const Phase = enum { idle, atoms, flush, replies, window, window_flush, ready, unsupported, failed };
const FlushReadiness = enum { pending, ready, failed };
const OutputResult = enum { complete, pending, failed };

const DisplayKind = enum { unix, tcp4, tcp6 };
const DisplayEndpoint = struct {
    kind: DisplayKind,
    display: u16,
    screen: c_int,
    unix_path: [108]u8 = @splat(0),
    unix_path_length: u8 = 0,
    unix_abstract_first: bool = false,
    tcp4_fallback: bool = false,
};

const DisplayAddress = struct {
    address: SocketAddress,
    length: std.posix.socklen_t,
    kind: DisplayKind,
};

const XauthorityMatch = struct {
    storage: []u8 = &.{},
    name: []u8 = &.{},
    data: []u8 = &.{},

    fn deinit(match: *XauthorityMatch, allocator: std.mem.Allocator) void {
        if (match.storage.len > 0) allocator.free(match.storage);
        match.* = .{};
    }
};

const ReadPhase = enum { idle, selection, property, incremental, ready, refused, limit_exceeded, failed };
pub const ReadState = struct {
    phase: ReadPhase = .idle,
    window: u32 = 0,
    selection: u32 = 0,
    target: u32 = 0,
    property_cookie: ?linux.XcbCookie = null,
    incremental: bool = false,
    max_bytes: u32 = 0,
    notification_pending: bool = false,
    actual_type: u32 = 0,
};

pub const WriteState = struct {
    provider: ?*Provider = null,
    clear: bool = false,
    selection: u32 = 0,
    owner_cookie: ?linux.XcbCookie = null,
    waiting_timestamp: bool = false,
    mutation_dispatched: bool = false,
    committed: bool = false,
    failed: bool = false,
    timestamp_window: u32 = 0,
    timestamp_window_sequence: u32 = 0,
    timestamp_property_sequence: u32 = 0,
};

const RetiredTimestamp = struct {
    window: u32 = 0,
    window_sequence: u32 = 0,
    property_sequence: u32 = 0,
};

const Transfer = struct {
    id: u64,
    provider: *Provider,
    data: []const u8,
    requestor: u32,
    property: u32,
    target: u32,
    offset: u32 = 0,
    sent_terminal: bool = false,
    last_progress_ns: i128,
    delete_pending: bool = false,
};

const PendingResponse = struct {
    request: linux.XcbSelectionRequestEvent,
    property_cookie: linux.XcbCookie,
    barrier_cookie: linux.XcbCookie,
    property: u32,
    transfer_id: u64 = 0,
    notify: bool = true,
    transfer_expired: bool = false,
};

pub const Provider = struct {
    selection: u32,
    data: []u8,
    latin1: []u8 = &.{},
    timestamp: u32 = 0,
    owns_data: bool = false,
    retired: bool = false,
    transfer_count: u32 = 0,
};

pub const Atoms = struct {
    clipboard: u32,
    targets: u32,
    utf8_string: u32,
    text: u32,
    text_plain: u32,
    text_plain_utf8: u32,
    text_plain_utf8_upper: u32,
    png: u32,
    jpeg: u32,
    webp: u32,
    gif: u32,
    property: u32,
    incr: u32,
    timestamp: u32,
};

pub const Connection = struct {
    allocator: std.mem.Allocator,
    symbols: *const linux.XcbSymbols,
    max_provider_transfers: u32,
    connection: ?*linux.XcbConnection = null,
    phase: Phase = .idle,
    failure: Failure = .none,
    cookies: [ATOM_NAMES.len]linux.XcbCookie = undefined,
    atom_values: [ATOM_NAMES.len]u32 = undefined,
    request_index: u8 = 0,
    reply_index: u8 = 0,
    output_ready_override: ?bool = null,
    screen_index: c_int = 0,
    root_window: u32 = 0,
    owner_window: u32 = 0,
    maximum_request_bytes: u32 = 0,
    providers: [MAX_PROVIDERS]?*Provider = .{null} ** MAX_PROVIDERS,
    clipboard_provider: ?*Provider = null,
    primary_provider: ?*Provider = null,
    transfers: []Transfer = &.{},
    transfer_count: u32 = 0,
    transfer_cursor: u32 = 0,
    transfer_id_next: u64 = 1,
    responses: []PendingResponse = &.{},
    response_count: u32 = 0,
    output_pending: bool = false,
    retired_timestamps: [2]RetiredTimestamp = .{ .{}, .{} },
    connect_thread: ?std.Thread = null,
    connect_exited: std.atomic.Value(bool) = .init(false),
    connect_result: ?*linux.XcbConnection = null,
    connect_screen_index: c_int = 0,
    connect_mutex: sync.Mutex = .{},
    connect_cancel_requested: bool = false,
    connect_cancel_fd: ?std.posix.fd_t = null,
    test_connected_fd: ?std.posix.fd_t = null,

    pub fn init(
        allocator: std.mem.Allocator,
        symbols: *const linux.XcbSymbols,
        max_provider_transfers: u32,
    ) Connection {
        return .{
            .allocator = allocator,
            .symbols = symbols,
            .max_provider_transfers = max_provider_transfers,
        };
    }

    pub fn deinit(self: *Connection) void {
        std.debug.assert(self.connect_thread == null);
        if (self.connection) |connection| {
            var index = self.reply_index;
            while (index < self.request_index) : (index += 1) {
                self.symbols.xcb_discard_reply(connection, self.cookies[index].sequence);
            }
            self.releaseProviders();
            for (self.retired_timestamps) |retired| {
                if (retired.window != 0) _ = self.symbols.xcb_destroy_window(connection, retired.window);
            }
            if (self.owner_window != 0) _ = self.symbols.xcb_destroy_window(connection, self.owner_window);
            self.symbols.xcb_disconnect(connection);
        }
        if (self.transfers.len > 0) self.allocator.free(self.transfers);
        if (self.responses.len > 0) self.allocator.free(self.responses);
        self.* = undefined;
    }

    pub fn drive(self: *Connection) Progress {
        switch (self.phase) {
            .idle => return self.connect(),
            .atoms => return self.requestAtom(),
            .flush => return self.flushAtoms(),
            .replies => return self.pollAtom(),
            .window => return self.createOwnerWindow(),
            .window_flush => return self.flushOwnerWindow(),
            .ready => return .ready,
            .unsupported => return .unsupported,
            .failed => return .failed,
        }
    }

    pub fn atoms(self: *const Connection) ?Atoms {
        if (self.phase != .ready) return null;
        return .{
            .clipboard = self.atom_values[0],
            .targets = self.atom_values[1],
            .utf8_string = self.atom_values[2],
            .text = self.atom_values[3],
            .text_plain = self.atom_values[4],
            .text_plain_utf8 = self.atom_values[5],
            .text_plain_utf8_upper = self.atom_values[9],
            .png = self.atom_values[6],
            .jpeg = self.atom_values[11],
            .webp = self.atom_values[12],
            .gif = self.atom_values[13],
            .property = self.atom_values[7],
            .incr = self.atom_values[8],
            .timestamp = self.atom_values[ATOM_TIMESTAMP_INDEX],
        };
    }

    pub fn takeFailure(self: *Connection) Failure {
        const failure = self.failure;
        if (self.phase == .ready) self.failure = .none;
        return failure;
    }

    fn connect(self: *Connection) Progress {
        if (self.connect_thread == null and self.connection == null) {
            self.connect_thread = std.Thread.spawn(.{}, connectWorker, .{self}) catch {
                self.phase = .unsupported;
                return .unsupported;
            };
            return .pending;
        }
        if (!self.joinConnectThread()) return .pending;
        const connection = self.connection orelse {
            self.phase = .unsupported;
            return .unsupported;
        };
        if (self.symbols.xcb_connection_has_error(connection) != 0) {
            self.phase = .unsupported;
            return .unsupported;
        }
        self.phase = .atoms;
        return .pending;
    }

    fn connectWorker(self: *Connection) void {
        self.connectWorkerRun() catch {};
        self.connect_mutex.lock();
        std.debug.assert(self.connect_cancel_fd == null);
        self.connect_mutex.unlock();
        self.connect_exited.store(true, .release);
    }

    fn connectWorkerRun(self: *Connection) !void {
        if (self.cancelRequested()) return;
        var endpoint: DisplayEndpoint = undefined;
        var fd: std.posix.fd_t = undefined;
        var fd_owned = false;
        defer if (fd_owned) posix_io.close(fd);
        if (comptime builtin.is_test) {
            if (self.test_connected_fd) |test_fd| {
                self.test_connected_fd = null;
                endpoint = .{ .kind = .unix, .display = 0, .screen = 0 };
                fd = test_fd;
                fd_owned = true;
            } else {
                endpoint = try parseDisplay(posix_io.getEnv("DISPLAY") orelse return error.UnsupportedDisplay);
                fd = try self.connectSocket(&endpoint);
                fd_owned = true;
            }
        } else {
            endpoint = try parseDisplay(posix_io.getEnv("DISPLAY") orelse return error.UnsupportedDisplay);
            fd = try self.connectSocket(&endpoint);
            fd_owned = true;
        }

        const cancel_fd = try duplicateCancellationFd(fd);
        if (!self.publishCancellationFd(cancel_fd)) {
            posix_io.close(cancel_fd);
            return;
        }
        defer self.unpublishCancellationFd(cancel_fd);
        if (self.cancelRequested()) return;

        var auth = if (builtin.is_test and endpoint.unix_path_length == 0)
            XauthorityMatch{}
        else
            try loadXauthority(self, endpoint);
        defer auth.deinit(self.allocator);
        var auth_info: linux.XcbAuthInfo = undefined;
        const auth_pointer: ?*linux.XcbAuthInfo = if (auth.name.len == 0) null else blk: {
            auth_info = .{
                .name_length = @intCast(auth.name.len),
                .name = auth.name.ptr,
                .data_length = @intCast(auth.data.len),
                .data = auth.data.ptr,
            };
            break :blk &auth_info;
        };
        fd_owned = false;
        const result = self.symbols.xcb_connect_to_fd(fd, auth_pointer);

        self.connect_mutex.lock();
        if (self.connect_cancel_requested) {
            self.connect_mutex.unlock();
            if (result) |connection| self.symbols.xcb_disconnect(connection);
            return;
        }
        self.connect_result = result;
        self.connect_screen_index = endpoint.screen;
        self.connect_mutex.unlock();
    }

    fn joinConnectThread(self: *Connection) bool {
        const thread = self.connect_thread orelse return true;
        if (!self.connect_exited.load(.acquire)) return false;
        thread.join();
        self.connect_thread = null;
        self.connection = self.connect_result;
        self.connect_result = null;
        self.screen_index = self.connect_screen_index;
        return true;
    }

    pub fn shutdownReady(self: *Connection) bool {
        return self.joinConnectThread();
    }

    pub fn requestShutdown(self: *Connection) void {
        self.connect_mutex.lock();
        self.connect_cancel_requested = true;
        if (self.connect_cancel_fd) |fd| posix_io.shutdownRead(fd);
        self.connect_mutex.unlock();
    }

    fn cancelRequested(self: *Connection) bool {
        self.connect_mutex.lock();
        defer self.connect_mutex.unlock();
        return self.connect_cancel_requested;
    }

    fn publishCancellationFd(self: *Connection, fd: std.posix.fd_t) bool {
        self.connect_mutex.lock();
        defer self.connect_mutex.unlock();
        std.debug.assert(self.connect_cancel_fd == null);
        if (self.connect_cancel_requested) return false;
        self.connect_cancel_fd = fd;
        return true;
    }

    fn unpublishCancellationFd(self: *Connection, fd: std.posix.fd_t) void {
        self.connect_mutex.lock();
        std.debug.assert(self.connect_cancel_fd == fd);
        self.connect_cancel_fd = null;
        posix_io.close(fd);
        self.connect_mutex.unlock();
    }

    fn connectSocket(self: *Connection, endpoint: *DisplayEndpoint) !std.posix.fd_t {
        const candidate_count: u8 = displayCandidateCount(endpoint.*);
        var candidate_index: u8 = 0;
        while (candidate_index < candidate_count) : (candidate_index += 1) {
            const candidate = try displayAddress(endpoint.*, candidate_index);
            const fd = self.connectCandidate(candidate) catch |err| {
                if (err == error.Cancelled) return err;
                continue;
            };
            endpoint.kind = candidate.kind;
            return fd;
        }
        return error.ConnectionRefused;
    }

    fn connectCandidate(self: *Connection, candidate: DisplayAddress) !std.posix.fd_t {
        if (self.cancelRequested()) return error.Cancelled;
        const fd = try posix_io.socket(
            candidate.address.any.family,
            std.posix.SOCK.STREAM | std.posix.SOCK.NONBLOCK | std.posix.SOCK.CLOEXEC,
            0,
        );
        errdefer posix_io.close(fd);

        posix_io.connect(fd, &candidate.address.any, candidate.length) catch |err| switch (err) {
            error.WouldBlock, error.ConnectionPending => {
                var poll_count: u16 = 0;
                while (poll_count < CONNECT_POLL_COUNT_MAX) : (poll_count += 1) {
                    if (self.cancelRequested()) return error.Cancelled;
                    var descriptors = [_]std.posix.pollfd{.{
                        .fd = fd,
                        .events = std.posix.POLL.OUT,
                        .revents = 0,
                    }};
                    const count = try std.posix.poll(&descriptors, CONNECT_POLL_SLICE_MS);
                    if (count == 0) continue;
                    if (descriptors[0].revents & std.posix.POLL.NVAL != 0) return error.SocketInvalid;
                    try posix_io.checkSocketError(fd);
                    break;
                }
                if (poll_count == CONNECT_POLL_COUNT_MAX) return error.ConnectionTimedOut;
            },
            else => return err,
        };
        return fd;
    }

    fn requestAtom(self: *Connection) Progress {
        const connection = self.connection orelse return self.fail(.connection);
        if (self.symbols.xcb_connection_has_error(connection) != 0) return self.fail(.connection);
        std.debug.assert(self.request_index < ATOM_NAMES.len);

        const name = ATOM_NAMES[self.request_index];
        self.cookies[self.request_index] = self.symbols.xcb_intern_atom(
            connection,
            0,
            @intCast(name.len),
            name.ptr,
        );
        self.request_index += 1;
        if (self.request_index < ATOM_NAMES.len) return .pending;
        self.phase = .flush;
        return .pending;
    }

    fn flushAtoms(self: *Connection) Progress {
        const connection = self.connection orelse return self.fail(.connection);
        switch (self.flushReadiness(connection)) {
            .pending => return .pending,
            .failed => return self.fail(.connection),
            .ready => {},
        }
        // This fresh private connection has only the fixed atom batch queued.
        if (self.symbols.xcb_flush(connection) <= 0) return self.fail(.flush);
        self.phase = .replies;
        return .pending;
    }

    fn flushReadiness(self: *Connection, connection: *linux.XcbConnection) FlushReadiness {
        if (comptime builtin.is_test) {
            if (self.output_ready_override) |ready| return if (ready) .ready else .pending;
        }
        if (comptime builtin.os.tag != .linux) return .failed;
        var descriptor = [_]std.posix.pollfd{.{
            .fd = self.symbols.xcb_get_file_descriptor(connection),
            .events = std.posix.POLL.OUT,
            .revents = 0,
        }};
        const count = std.posix.poll(&descriptor, 0) catch return .failed;
        if (descriptor[0].revents & (std.posix.POLL.ERR | std.posix.POLL.HUP | std.posix.POLL.NVAL) != 0) {
            return .failed;
        }
        if (count == 0 or descriptor[0].revents & std.posix.POLL.OUT == 0) return .pending;
        return .ready;
    }

    fn pollAtom(self: *Connection) Progress {
        const connection = self.connection orelse return self.fail(.connection);
        if (self.symbols.xcb_connection_has_error(connection) != 0) return self.fail(.connection);
        std.debug.assert(self.reply_index < self.request_index);

        var reply_pointer: ?*anyopaque = null;
        var error_pointer: ?*linux.XcbGenericError = null;
        const available = self.symbols.xcb_poll_for_reply(
            connection,
            self.cookies[self.reply_index].sequence,
            &reply_pointer,
            &error_pointer,
        );
        if (available == 0) return .pending;
        self.reply_index += 1;
        defer if (reply_pointer) |pointer| std.c.free(pointer);
        defer if (error_pointer) |pointer| std.c.free(pointer);
        if (error_pointer != null) return self.fail(.atom);
        const opaque_reply = reply_pointer orelse return self.fail(.atom);
        const reply: *const linux.XcbInternAtomReply = @ptrCast(@alignCast(opaque_reply));
        if (reply.atom == 0) return self.fail(.atom);
        const atom_index = self.reply_index - 1;
        self.atom_values[atom_index] = reply.atom;

        if (self.reply_index < self.request_index) return .pending;
        self.phase = .window;
        return .pending;
    }

    pub fn selectionAtom(self: *const Connection, primary: bool) u32 {
        return if (primary) ATOM_PRIMARY else self.atoms().?.clipboard;
    }

    pub fn targetAtoms(self: *const Connection, mime: []const u8, output: *[6]u32) []const u32 {
        const atoms_value = self.atoms().?;
        const image_atom = if (std.ascii.eqlIgnoreCase(mime, "image/png"))
            atoms_value.png
        else if (std.ascii.eqlIgnoreCase(mime, "image/jpeg"))
            atoms_value.jpeg
        else if (std.ascii.eqlIgnoreCase(mime, "image/webp"))
            atoms_value.webp
        else if (std.ascii.eqlIgnoreCase(mime, "image/gif"))
            atoms_value.gif
        else
            0;
        if (image_atom != 0) {
            output[0] = image_atom;
            return output[0..1];
        }
        if (!std.ascii.eqlIgnoreCase(mime, "text/plain")) return output[0..0];
        output.* = .{
            atoms_value.text_plain_utf8_upper,
            atoms_value.text_plain_utf8,
            atoms_value.utf8_string,
            atoms_value.text_plain,
            atoms_value.text,
            ATOM_STRING,
        };
        return output;
    }

    pub fn beginRead(self: *Connection, state: *ReadState, primary: bool, target: u32, max_bytes: u32) bool {
        const connection = self.connection orelse return false;
        std.debug.assert(state.phase == .idle or state.phase == .refused);
        if (state.window == 0) {
            state.window = self.symbols.xcb_generate_id(connection);
            if (state.window == 0 or state.window == std.math.maxInt(u32)) return false;
            const event_mask = [_]u32{EVENT_MASK_PROPERTY_CHANGE};
            _ = self.symbols.xcb_create_window(
                connection,
                0,
                state.window,
                self.root_window,
                0,
                0,
                1,
                1,
                0,
                1,
                0,
                1 << 11,
                &event_mask,
            );
        }
        const atoms_value = self.atoms().?;
        state.selection = self.selectionAtom(primary);
        state.target = target;
        state.max_bytes = max_bytes;
        state.phase = .selection;
        _ = self.symbols.xcb_delete_property(connection, state.window, atoms_value.property);
        _ = self.symbols.xcb_convert_selection(
            connection,
            state.window,
            state.selection,
            target,
            atoms_value.property,
            0,
        );
        return self.queueFlush() != .failed;
    }

    pub fn routeReadEvent(self: *Connection, state: *ReadState, event: *const linux.XcbGenericEvent) bool {
        const event_type = event.response_type & 0x7f;
        if (event_type == EVENT_SELECTION_NOTIFY) {
            const notify: *const linux.XcbSelectionNotifyEvent = @ptrCast(@alignCast(event));
            if (state.phase != .selection or notify.requestor != state.window or
                notify.selection != state.selection) return false;
            if (notify.target != state.target) {
                const atoms_value = self.atoms() orelse return false;
                if (state.target != atoms_value.text or notify.target != ATOM_STRING) return false;
            }
            if (notify.property == 0) {
                state.phase = .refused;
                return true;
            }
            state.property_cookie = self.symbols.xcb_get_property(
                self.connection.?,
                0,
                state.window,
                self.atoms().?.property,
                0,
                0,
                propertyLongLength(state.max_bytes +| 1),
            );
            state.phase = .property;
            _ = self.queueFlush();
            return true;
        }
        if (event_type == EVENT_PROPERTY_NOTIFY and state.phase == .incremental) {
            const notify: *const linux.XcbPropertyNotifyEvent = @ptrCast(@alignCast(event));
            if (notify.window != state.window or notify.atom != self.atoms().?.property or notify.state != 0) return false;
            state.property_cookie = self.symbols.xcb_get_property(
                self.connection.?,
                1,
                state.window,
                self.atoms().?.property,
                0,
                0,
                propertyLongLength(state.max_bytes +| 1),
            );
            state.phase = .property;
            _ = self.queueFlush();
            return true;
        }
        if (event_type == EVENT_PROPERTY_NOTIFY and state.phase == .property) {
            const notify: *const linux.XcbPropertyNotifyEvent = @ptrCast(@alignCast(event));
            if (notify.window != state.window or notify.atom != self.atoms().?.property or notify.state != 0) return false;
            state.notification_pending = true;
            return true;
        }
        return false;
    }

    pub fn driveRead(
        self: *Connection,
        state: *ReadState,
        data: *std.ArrayListUnmanaged(u8),
        max_bytes: u32,
    ) ReadResult {
        if (self.output_pending) switch (self.flushOutput()) {
            .complete => {},
            .pending => return .pending,
            .failed => {
                self.failure = .flush;
                self.phase = .failed;
                state.phase = .failed;
                return .failed;
            },
        };
        switch (state.phase) {
            .ready => return .ready,
            .refused => return .refused,
            .limit_exceeded => return .limit_exceeded,
            .failed => return .candidate_failed,
            .idle, .selection, .incremental => return .pending,
            .property => {},
        }
        const cookie = state.property_cookie orelse return .pending;
        var reply_pointer: ?*anyopaque = null;
        var error_pointer: ?*linux.XcbGenericError = null;
        const available = self.symbols.xcb_poll_for_reply(
            self.connection.?,
            cookie.sequence,
            &reply_pointer,
            &error_pointer,
        );
        if (available == 0) return .pending;
        state.property_cookie = null;
        defer if (reply_pointer) |pointer| std.c.free(pointer);
        defer if (error_pointer) |pointer| std.c.free(pointer);
        if (error_pointer != null) return failReadCandidate(state);
        const opaque_reply = reply_pointer orelse return failReadCandidate(state);
        const reply: *const linux.XcbGetPropertyReply = @ptrCast(@alignCast(opaque_reply));
        const bytes = propertyBytes(reply) orelse return failReadCandidate(state);
        if (reply.atom_type == self.atoms().?.incr) {
            if (reply.format != 32 or (bytes.len != 0 and bytes.len < 4)) return failReadCandidate(state);
            // xclip sends an empty INCR property instead of the ICCCM size hint.
            if (bytes.len >= 4) {
                const announced = std.mem.readInt(u32, bytes[0..4], builtin.cpu.arch.endian());
                if (announced > max_bytes) {
                    state.phase = .limit_exceeded;
                    return .limit_exceeded;
                }
            }
            state.incremental = true;
            state.phase = .incremental;
            _ = self.symbols.xcb_delete_property(self.connection.?, state.window, self.atoms().?.property);
            _ = self.queueFlush();
            return .pending;
        }
        const atoms_value = self.atoms().?;
        const text_type_supported = reply.atom_type == atoms_value.utf8_string or
            reply.atom_type == atoms_value.text_plain_utf8_upper or
            reply.atom_type == atoms_value.text_plain_utf8 or reply.atom_type == atoms_value.text_plain or
            reply.atom_type == ATOM_STRING;
        const target_is_text = state.target == atoms_value.text or state.target == atoms_value.utf8_string or
            state.target == atoms_value.text_plain_utf8_upper or
            state.target == atoms_value.text_plain_utf8 or state.target == atoms_value.text_plain or
            state.target == ATOM_STRING;
        const accepted_type = if (target_is_text)
            ((state.actual_type == 0 and text_type_supported) or reply.atom_type == state.actual_type)
        else
            reply.atom_type == state.target;
        if (reply.format != 8 or !accepted_type) {
            if (state.target == atoms_value.text and state.actual_type == 0 and reply.format == 8) {
                state.phase = .refused;
                return .refused;
            }
            return failReadCandidate(state);
        }
        if (state.actual_type == 0) state.actual_type = reply.atom_type;
        if (bytes.len == 0 and state.incremental) {
            state.phase = .ready;
            return .ready;
        }
        if (reply.bytes_after > 0 or bytes.len > max_bytes -| data.items.len) {
            state.phase = .limit_exceeded;
            return .limit_exceeded;
        }
        if (state.actual_type == ATOM_STRING) {
            const appended = appendLatin1(self.allocator, data, bytes, max_bytes) catch {
                state.phase = .failed;
                return .out_of_memory;
            };
            if (!appended) {
                state.phase = .limit_exceeded;
                return .limit_exceeded;
            }
        } else {
            data.appendSlice(self.allocator, bytes) catch {
                state.phase = .failed;
                return .out_of_memory;
            };
        }
        if (state.incremental) {
            state.phase = .incremental;
            if (state.notification_pending) {
                state.notification_pending = false;
                self.requestIncrementalProperty(state);
            }
            return .pending;
        }
        _ = self.symbols.xcb_delete_property(self.connection.?, state.window, self.atoms().?.property);
        _ = self.queueFlush();
        state.phase = .ready;
        return .ready;
    }

    pub fn cleanupRead(self: *Connection, state: *ReadState) void {
        defer state.* = .{};
        const connection = self.connection orelse return;
        if (state.property_cookie) |cookie| self.symbols.xcb_discard_reply(connection, cookie.sequence);
        if (state.window != 0) {
            _ = self.symbols.xcb_delete_property(connection, state.window, self.atom_values[7]);
            _ = self.symbols.xcb_destroy_window(connection, state.window);
            if (self.phase == .ready) _ = self.queueFlush();
        }
    }

    pub fn beginWrite(self: *Connection, state: *WriteState, primary: bool, data: []u8) SelectionResult {
        if (self.retiredTimestamp(self.selectionAtom(primary)).window != 0) return .pending;
        if (!self.canPublish(primary)) return self.selectionFailure(.provider);
        const slot = self.freeProviderSlot() orelse return self.selectionFailure(.provider);
        const provider = self.allocator.create(Provider) catch return self.selectionFailure(.provider);
        provider.* = .{
            .selection = self.selectionAtom(primary),
            .data = data,
            .latin1 = encodeLatin1(self.allocator, data) catch &.{},
        };
        const connection = self.connection orelse {
            self.allocator.destroy(provider);
            return self.selectionFailure(.connection);
        };
        state.* = .{
            .provider = provider,
            .selection = provider.selection,
            .waiting_timestamp = true,
        };
        slot.* = provider;
        if (!self.createTimestampWindow(state)) {
            self.removeProvider(provider, false);
            state.* = .{};
            return self.selectionFailure(.protocol);
        }
        state.timestamp_property_sequence = self.symbols.xcb_change_property(
            connection,
            0,
            state.timestamp_window,
            self.atoms().?.timestamp,
            ATOM_INTEGER,
            8,
            0,
            null,
        ).sequence;
        if (self.queueFlush() != .failed) return .pending;
        self.removeProvider(provider, false);
        self.destroyTimestampWindow(state);
        state.* = .{};
        return self.selectionFailure(.flush);
    }

    pub fn beginClear(self: *Connection, state: *WriteState, primary: bool) SelectionResult {
        if (self.retiredTimestamp(self.selectionAtom(primary)).window != 0) return .pending;
        const connection = self.connection orelse return self.selectionFailure(.connection);
        const selection = self.selectionAtom(primary);
        state.* = .{
            .clear = true,
            .selection = selection,
            .waiting_timestamp = true,
        };
        if (!self.createTimestampWindow(state)) {
            state.* = .{};
            return self.selectionFailure(.protocol);
        }
        state.timestamp_property_sequence = self.symbols.xcb_change_property(
            connection,
            0,
            state.timestamp_window,
            self.atoms().?.timestamp,
            ATOM_INTEGER,
            8,
            0,
            null,
        ).sequence;
        if (self.queueFlush() != .failed) return .pending;
        self.destroyTimestampWindow(state);
        state.* = .{};
        return self.selectionFailure(.flush);
    }

    pub fn driveWrite(self: *Connection, state: *WriteState) SelectionResult {
        if (state.failed) return .failed;
        if (state.committed) return .committed;
        if (self.output_pending) switch (self.flushOutput()) {
            .complete => {},
            .pending => return .pending,
            .failed => {
                if (!state.mutation_dispatched) return self.abortWrite(state);
                self.output_pending = false;
                _ = self.fail(.flush);
                state.failed = true;
                return .failed;
            },
        };
        const cookie = state.owner_cookie orelse return .pending;
        var reply_pointer: ?*anyopaque = null;
        var error_pointer: ?*linux.XcbGenericError = null;
        const available = self.symbols.xcb_poll_for_reply(
            self.connection.?,
            cookie.sequence,
            &reply_pointer,
            &error_pointer,
        );
        if (available == 0) return .pending;
        state.owner_cookie = null;
        defer if (reply_pointer) |pointer| std.c.free(pointer);
        defer if (error_pointer) |pointer| std.c.free(pointer);
        const opaque_reply = reply_pointer orelse {
            state.failed = true;
            return .failed;
        };
        if (error_pointer != null) {
            state.failed = true;
            return .failed;
        }
        const reply: *const linux.XcbGetSelectionOwnerReply = @ptrCast(@alignCast(opaque_reply));
        const expected_owner = if (state.clear) 0 else self.owner_window;
        if (reply.owner != expected_owner) {
            if (!state.clear) self.retireCurrent(state.selection);
            state.failed = true;
            return .failed;
        }
        state.committed = true;
        return .committed;
    }

    pub fn cleanupWrite(self: *Connection, state: *WriteState) void {
        if (state.owner_cookie) |cookie| {
            if (self.connection) |connection| self.symbols.xcb_discard_reply(connection, cookie.sequence);
        }
        if (state.provider) |provider| self.removeProvider(provider, false);
        if (state.waiting_timestamp) self.retireTimestampWindow(state) else self.destroyTimestampWindow(state);
        state.* = .{};
    }

    pub fn abandonMutationConfirmation(self: *Connection, state: *WriteState) void {
        std.debug.assert(state.mutation_dispatched);
        if (state.owner_cookie) |cookie| {
            if (self.connection) |connection| self.symbols.xcb_discard_reply(connection, cookie.sequence);
        }
        state.* = .{};
    }

    pub fn consumeRetiredTimestampEvent(self: *Connection, event: *const linux.XcbGenericEvent) bool {
        for (&self.retired_timestamps) |*retired| {
            if (retired.window == 0) continue;
            if (event.response_type == 0) {
                const x_error: *const linux.XcbGenericError = @ptrCast(@alignCast(event));
                if (x_error.resource_id != retired.window and
                    !requestSequenceMatches(retired.window_sequence, x_error.full_sequence) and
                    !requestSequenceMatches(retired.property_sequence, x_error.full_sequence))
                {
                    continue;
                }
                self.destroyRetiredTimestampWindow(retired);
                return true;
            }
            if ((event.response_type & 0x7f) != EVENT_PROPERTY_NOTIFY) continue;
            const notify: *const linux.XcbPropertyNotifyEvent = @ptrCast(@alignCast(event));
            if (notify.window != retired.window or
                notify.atom != self.atom_values[ATOM_TIMESTAMP_INDEX] or notify.state != 0)
            {
                continue;
            }
            self.destroyRetiredTimestampWindow(retired);
            return true;
        }
        return false;
    }

    pub fn routeWriteEvent(self: *Connection, state: *WriteState, event: *const linux.XcbGenericEvent) bool {
        if (state.waiting_timestamp and event.response_type == 0) {
            const x_error: *const linux.XcbGenericError = @ptrCast(@alignCast(event));
            if (x_error.resource_id != state.timestamp_window and
                !requestSequenceMatches(state.timestamp_window_sequence, x_error.full_sequence) and
                !requestSequenceMatches(state.timestamp_property_sequence, x_error.full_sequence))
            {
                return false;
            }
            state.waiting_timestamp = false;
            self.destroyTimestampWindow(state);
            if (state.provider) |provider| {
                self.removeProvider(provider, false);
                state.provider = null;
            }
            state.failed = true;
            return true;
        }
        if (!state.waiting_timestamp or (event.response_type & 0x7f) != EVENT_PROPERTY_NOTIFY) return false;
        const notify: *const linux.XcbPropertyNotifyEvent = @ptrCast(@alignCast(event));
        if (notify.window != state.timestamp_window or notify.atom != self.atoms().?.timestamp or notify.state != 0) return false;
        state.waiting_timestamp = false;
        self.destroyTimestampWindow(state);
        _ = self.symbols.xcb_set_selection_owner(
            self.connection.?,
            if (state.clear) 0 else self.owner_window,
            state.selection,
            notify.time,
        );
        state.mutation_dispatched = true;
        if (state.clear) {
            self.retireCurrent(state.selection);
        } else {
            const provider = state.provider.?;
            provider.timestamp = notify.time;
            provider.owns_data = true;
            if (self.currentProvider(provider.selection)) |old| self.retireProvider(old);
            self.setCurrentProvider(provider);
            state.provider = null;
        }
        state.owner_cookie = self.symbols.xcb_get_selection_owner(self.connection.?, state.selection);
        _ = self.queueFlush();
        return true;
    }

    pub fn isMutationTimestampEvent(
        self: *const Connection,
        state: *const WriteState,
        event: *const linux.XcbGenericEvent,
    ) bool {
        if (!state.waiting_timestamp or (event.response_type & 0x7f) != EVENT_PROPERTY_NOTIFY) return false;
        const notify: *const linux.XcbPropertyNotifyEvent = @ptrCast(@alignCast(event));
        return notify.window == state.timestamp_window and
            notify.atom == self.atom_values[ATOM_TIMESTAMP_INDEX] and notify.state == 0;
    }

    pub fn pollEvent(self: *Connection) ?*linux.XcbGenericEvent {
        const connection = self.connection orelse return null;
        if (self.phase != .ready) return null;
        return self.symbols.xcb_poll_for_event(connection);
    }

    pub fn handleProviderEvent(self: *Connection, event: *const linux.XcbGenericEvent) void {
        switch (event.response_type & 0x7f) {
            EVENT_SELECTION_REQUEST => self.handleSelectionRequest(@ptrCast(@alignCast(event))),
            EVENT_SELECTION_CLEAR => self.handleSelectionClear(@ptrCast(@alignCast(event))),
            EVENT_PROPERTY_NOTIFY => self.handleTransferProperty(@ptrCast(@alignCast(event))),
            else => {},
        }
    }

    pub fn driveProviderUnit(self: *Connection) bool {
        if (self.phase == .failed) {
            self.output_pending = false;
            self.releaseProviders();
            return false;
        }
        if (self.output_pending and self.flushOutput() == .failed) {
            self.failure = .flush;
            self.phase = .failed;
            self.releaseProviders();
            return false;
        }
        if (self.transfer_count > 0) {
            const now = clipboard_clock.nowNs();
            const index = self.transfer_cursor % self.transfer_count;
            self.transfer_cursor = (self.transfer_cursor + 1) % self.transfer_count;
            if (now - self.transfers[index].last_progress_ns >= TRANSFER_IDLE_TIMEOUT_NS) {
                self.expireTransferResponse(self.transfers[index].id);
                self.removeTransfer(index);
                return self.hasWork();
            }
        }
        if (self.response_count > 0) {
            self.drivePendingResponse();
            return self.hasWork();
        }
        return self.hasWork();
    }

    pub fn hasWork(self: *const Connection) bool {
        if (self.phase == .failed) return false;
        return self.output_pending or self.retired_timestamps[0].window != 0 or self.retired_timestamps[1].window != 0 or
            self.response_count > 0 or self.clipboard_provider != null or
            self.primary_provider != null or self.transfer_count > 0;
    }

    pub fn releaseProviders(self: *Connection) void {
        if (self.connection) |connection| {
            for (self.responses[0..self.response_count]) |response| {
                self.symbols.xcb_discard_reply(connection, response.barrier_cookie.sequence);
            }
        }
        self.response_count = 0;
        self.transfer_count = 0;
        for (&self.providers) |*slot| {
            const provider = slot.* orelse continue;
            if (provider.owns_data and provider.data.len > 0) self.allocator.free(provider.data);
            if (provider.latin1.len > 0) self.allocator.free(provider.latin1);
            self.allocator.destroy(provider);
            slot.* = null;
        }
        self.clipboard_provider = null;
        self.primary_provider = null;
    }

    fn queueFlush(self: *Connection) OutputResult {
        const result = self.flushOutput();
        if (result == .failed) {
            if (self.failure == .none) self.failure = .flush;
            self.output_pending = false;
            self.phase = .failed;
        }
        return result;
    }

    fn flushOutput(self: *Connection) OutputResult {
        const connection = self.connection orelse return .failed;
        switch (self.flushReadiness(connection)) {
            .pending => {
                self.output_pending = true;
                return .pending;
            },
            .failed => return .failed,
            .ready => {},
        }
        if (self.symbols.xcb_flush(connection) <= 0) return .failed;
        self.output_pending = false;
        return .complete;
    }

    fn selectionFailure(self: *Connection, failure: Failure) SelectionResult {
        if (self.failure == .none) self.failure = failure;
        return .failed;
    }

    fn abortWrite(self: *Connection, state: *WriteState) SelectionResult {
        std.debug.assert(!state.mutation_dispatched);
        if (state.provider) |provider| self.removeProvider(provider, false);
        self.destroyTimestampWindow(state);
        state.* = .{};
        state.failed = true;
        return self.selectionFailure(.protocol);
    }

    fn requestIncrementalProperty(self: *Connection, state: *ReadState) void {
        state.property_cookie = self.symbols.xcb_get_property(
            self.connection.?,
            1,
            state.window,
            self.atoms().?.property,
            0,
            0,
            propertyLongLength(state.max_bytes +| 1),
        );
        state.phase = .property;
        _ = self.queueFlush();
    }

    fn createTimestampWindow(self: *Connection, state: *WriteState) bool {
        const connection = self.connection orelse return false;
        state.timestamp_window = self.symbols.xcb_generate_id(connection);
        if (state.timestamp_window == 0 or state.timestamp_window == std.math.maxInt(u32)) return false;
        const event_mask = [_]u32{EVENT_MASK_PROPERTY_CHANGE};
        state.timestamp_window_sequence = self.symbols.xcb_create_window(
            connection,
            0,
            state.timestamp_window,
            self.root_window,
            0,
            0,
            1,
            1,
            0,
            1,
            0,
            1 << 11,
            &event_mask,
        ).sequence;
        return true;
    }

    fn destroyTimestampWindow(self: *Connection, state: *WriteState) void {
        if (state.timestamp_window == 0) return;
        if (self.connection) |connection| _ = self.symbols.xcb_destroy_window(connection, state.timestamp_window);
        state.timestamp_window = 0;
        state.timestamp_window_sequence = 0;
        state.timestamp_property_sequence = 0;
    }

    fn retireTimestampWindow(self: *Connection, state: *WriteState) void {
        if (state.timestamp_window == 0) return;
        const retired = self.retiredTimestamp(state.selection);
        std.debug.assert(retired.window == 0);
        retired.* = .{
            .window = state.timestamp_window,
            .window_sequence = state.timestamp_window_sequence,
            .property_sequence = state.timestamp_property_sequence,
        };
        state.timestamp_window = 0;
        state.timestamp_window_sequence = 0;
        state.timestamp_property_sequence = 0;
        _ = self.queueFlush();
    }

    fn destroyRetiredTimestampWindow(self: *Connection, retired: *RetiredTimestamp) void {
        _ = self.symbols.xcb_destroy_window(self.connection.?, retired.window);
        retired.* = .{};
        _ = self.queueFlush();
    }

    fn retiredTimestamp(self: *Connection, selection: u32) *RetiredTimestamp {
        return &self.retired_timestamps[@intFromBool(selection == ATOM_PRIMARY)];
    }

    fn freeProviderSlot(self: *Connection) ?*?*Provider {
        for (&self.providers) |*slot| if (slot.* == null) return slot;
        return null;
    }

    fn canPublish(self: *const Connection, primary: bool) bool {
        const selection = self.selectionAtom(primary);
        var count: u8 = 0;
        for (self.providers) |candidate| {
            const provider = candidate orelse continue;
            if (provider.selection == selection) count += 1;
        }
        return count < 2;
    }

    fn currentProvider(self: *const Connection, selection: u32) ?*Provider {
        return if (selection == ATOM_PRIMARY) self.primary_provider else self.clipboard_provider;
    }

    fn setCurrentProvider(self: *Connection, provider: *Provider) void {
        if (provider.selection == ATOM_PRIMARY) self.primary_provider = provider else self.clipboard_provider = provider;
    }

    fn retireCurrent(self: *Connection, selection: u32) void {
        const provider = self.currentProvider(selection) orelse return;
        self.retireProvider(provider);
    }

    fn retireProvider(self: *Connection, provider: *Provider) void {
        if (self.clipboard_provider == provider) self.clipboard_provider = null;
        if (self.primary_provider == provider) self.primary_provider = null;
        provider.retired = true;
        if (provider.transfer_count == 0) self.removeProvider(provider, true);
    }

    fn removeProvider(self: *Connection, provider: *Provider, free_data: bool) void {
        for (&self.providers) |*slot| {
            if (slot.* != provider) continue;
            if (free_data and provider.data.len > 0) self.allocator.free(provider.data);
            if (provider.latin1.len > 0) self.allocator.free(provider.latin1);
            self.allocator.destroy(provider);
            slot.* = null;
            return;
        }
    }

    fn handleSelectionClear(self: *Connection, event: *const linux.XcbSelectionClearEvent) void {
        if (event.owner != self.owner_window) return;
        const provider = self.currentProvider(event.selection) orelse return;
        if (timestampBefore(event.time, provider.timestamp)) return;
        self.retireProvider(provider);
    }

    fn handleSelectionRequest(self: *Connection, event: *const linux.XcbSelectionRequestEvent) void {
        const provider = self.currentProvider(event.selection) orelse {
            self.sendSelectionNotify(event, 0);
            return;
        };
        if (event.time != 0 and timestampBefore(event.time, provider.timestamp)) {
            self.sendSelectionNotify(event, 0);
            return;
        }
        const property = if (event.property == 0) event.target else event.property;
        const atoms_value = self.atoms().?;
        if (self.response_count >= self.responses.len) {
            self.sendSelectionNotify(event, 0);
            return;
        }
        if (event.target == atoms_value.targets) {
            const targets = [_]u32{
                atoms_value.targets,
                atoms_value.timestamp,
                atoms_value.utf8_string,
                atoms_value.text_plain_utf8,
                atoms_value.text_plain,
                atoms_value.text,
                ATOM_STRING,
            };
            const target_count: usize = if (provider.latin1.len > 0) targets.len else targets.len - 1;
            const property_cookie = self.symbols.xcb_change_property_checked(
                self.connection.?,
                0,
                event.requestor,
                property,
                ATOM_ATOM,
                32,
                @intCast(target_count),
                &targets,
            );
            self.queuePropertyResponse(event, property_cookie, property, 0);
            return;
        }
        if (event.target == atoms_value.timestamp) {
            const timestamp = [_]u32{provider.timestamp};
            const property_cookie = self.symbols.xcb_change_property_checked(
                self.connection.?,
                0,
                event.requestor,
                property,
                ATOM_INTEGER,
                32,
                1,
                &timestamp,
            );
            self.queuePropertyResponse(event, property_cookie, property, 0);
            return;
        }
        const output_type = if (event.target == atoms_value.text) atoms_value.utf8_string else event.target;
        if (event.target != atoms_value.utf8_string and event.target != atoms_value.text_plain_utf8 and
            event.target != atoms_value.text_plain and event.target != atoms_value.text and
            (event.target != ATOM_STRING or provider.latin1.len == 0))
        {
            self.sendSelectionNotify(event, 0);
            return;
        }
        const output_data = if (event.target == ATOM_STRING) provider.latin1 else provider.data;
        if (output_data.len <= self.directPayloadBytes()) {
            const property_cookie = self.symbols.xcb_change_property_checked(
                self.connection.?,
                0,
                event.requestor,
                property,
                output_type,
                8,
                @intCast(output_data.len),
                if (output_data.len == 0) null else output_data.ptr,
            );
            self.queuePropertyResponse(event, property_cookie, property, 0);
            return;
        }
        if (self.transfer_count >= self.transfers.len or self.hasTransfer(event.requestor, property)) {
            self.sendSelectionNotify(event, 0);
            return;
        }
        const mask = [_]u32{EVENT_MASK_PROPERTY_CHANGE};
        _ = self.symbols.xcb_change_window_attributes(self.connection.?, event.requestor, 1 << 11, &mask);
        const length = [_]u32{@intCast(output_data.len)};
        const property_cookie = self.symbols.xcb_change_property_checked(
            self.connection.?,
            0,
            event.requestor,
            property,
            atoms_value.incr,
            32,
            1,
            &length,
        );
        const transfer_id = self.allocateTransferID();
        self.transfers[self.transfer_count] = .{
            .id = transfer_id,
            .provider = provider,
            .data = output_data,
            .requestor = event.requestor,
            .property = property,
            .target = output_type,
            .last_progress_ns = clipboard_clock.nowNs(),
        };
        self.transfer_count += 1;
        provider.transfer_count += 1;
        self.queuePropertyResponse(event, property_cookie, property, transfer_id);
    }

    fn sendSelectionNotify(self: *Connection, request: *const linux.XcbSelectionRequestEvent, property: u32) void {
        const notify: linux.XcbSelectionNotifyEvent = .{
            .response_type = EVENT_SELECTION_NOTIFY,
            .pad0 = 0,
            .sequence = 0,
            .time = request.time,
            .requestor = request.requestor,
            .selection = request.selection,
            .target = request.target,
            .property = property,
        };
        var event_bytes = [_]u8{0} ** 32;
        @memcpy(event_bytes[0..@sizeOf(linux.XcbSelectionNotifyEvent)], std.mem.asBytes(&notify));
        _ = self.symbols.xcb_send_event(self.connection.?, 0, request.requestor, 0, &event_bytes);
        _ = self.queueFlush();
    }

    fn queuePropertyResponse(
        self: *Connection,
        request: *const linux.XcbSelectionRequestEvent,
        property_cookie: linux.XcbCookie,
        property: u32,
        transfer_id: u64,
    ) void {
        std.debug.assert(self.response_count < self.responses.len);
        self.responses[self.response_count] = .{
            .request = request.*,
            .property_cookie = property_cookie,
            .barrier_cookie = self.symbols.xcb_get_selection_owner(self.connection.?, request.selection),
            .property = property,
            .transfer_id = transfer_id,
        };
        self.response_count += 1;
        _ = self.queueFlush();
    }

    fn drivePendingResponse(self: *Connection) void {
        const response = self.responses[0];
        var reply_pointer: ?*anyopaque = null;
        var error_pointer: ?*linux.XcbGenericError = null;
        const available = self.symbols.xcb_poll_for_reply(
            self.connection.?,
            response.barrier_cookie.sequence,
            &reply_pointer,
            &error_pointer,
        );
        if (available == 0) return;
        defer if (reply_pointer) |pointer| std.c.free(pointer);
        defer if (error_pointer) |pointer| std.c.free(pointer);
        const property_error = self.symbols.xcb_request_check(self.connection.?, response.property_cookie);
        defer if (property_error) |pointer| std.c.free(pointer);
        const success = !response.transfer_expired and reply_pointer != null and error_pointer == null and property_error == null;
        if (response.notify) self.sendSelectionNotify(&response.request, if (success) response.property else 0);
        if (!success and response.transfer_id != 0) {
            self.removeTransferByID(response.transfer_id);
        }
        self.response_count -= 1;
        if (self.response_count > 0) {
            std.mem.copyForwards(PendingResponse, self.responses[0..self.response_count], self.responses[1 .. self.response_count + 1]);
        }
        if (success and response.transfer_id != 0) {
            self.advancePendingTransfer(response.transfer_id);
        }
    }

    fn handleTransferProperty(self: *Connection, event: *const linux.XcbPropertyNotifyEvent) void {
        if (event.state != PROPERTY_DELETE) return;
        var index: u32 = 0;
        while (index < self.transfer_count) : (index += 1) {
            const transfer = &self.transfers[index];
            if (transfer.requestor != event.window or transfer.property != event.atom) continue;
            if (transfer.sent_terminal) {
                self.removeTransfer(index);
                return;
            }
            if (self.response_count >= self.responses.len or self.hasPendingResponseForTransfer(transfer.id)) {
                transfer.delete_pending = true;
                return;
            }
            self.advanceTransfer(index);
            return;
        }
    }

    fn advanceTransfer(self: *Connection, index: u32) void {
        const transfer = &self.transfers[index];
        transfer.delete_pending = false;
        const remaining = transfer.data.len - transfer.offset;
        const count = @min(remaining, self.directPayloadBytes());
        const property_cookie = self.symbols.xcb_change_property_checked(
            self.connection.?,
            0,
            transfer.requestor,
            transfer.property,
            transfer.target,
            8,
            @intCast(count),
            if (count == 0) null else transfer.data.ptr + transfer.offset,
        );
        transfer.offset += @intCast(count);
        transfer.sent_terminal = count == 0;
        transfer.last_progress_ns = clipboard_clock.nowNs();
        self.responses[self.response_count] = .{
            .request = std.mem.zeroes(linux.XcbSelectionRequestEvent),
            .property_cookie = property_cookie,
            .barrier_cookie = self.symbols.xcb_get_selection_owner(self.connection.?, transfer.provider.selection),
            .property = transfer.property,
            .transfer_id = transfer.id,
            .notify = false,
        };
        self.response_count += 1;
        _ = self.queueFlush();
    }

    fn directPayloadBytes(self: *const Connection) u32 {
        return @max(@as(u32, 1), self.maximum_request_bytes -| 24);
    }

    fn hasTransfer(self: *const Connection, requestor: u32, property: u32) bool {
        for (self.transfers[0..self.transfer_count]) |transfer| {
            if (transfer.requestor == requestor and transfer.property == property) return true;
        }
        return false;
    }

    fn hasPendingResponseForTransfer(self: *const Connection, transfer_id: u64) bool {
        std.debug.assert(transfer_id != 0);
        for (self.responses[0..self.response_count]) |response| {
            if (response.transfer_id == transfer_id) return true;
        }
        return false;
    }

    fn expireTransferResponse(self: *Connection, transfer_id: u64) void {
        std.debug.assert(transfer_id != 0);
        for (self.responses[0..self.response_count]) |*response| {
            if (response.transfer_id != transfer_id) continue;
            if (response.notify) response.transfer_expired = true;
            return;
        }
    }

    fn advancePendingTransfer(self: *Connection, transfer_id: u64) void {
        std.debug.assert(transfer_id != 0);
        var index: u32 = 0;
        while (index < self.transfer_count) : (index += 1) {
            const transfer = &self.transfers[index];
            if (transfer.id != transfer_id or !transfer.delete_pending) continue;
            if (transfer.sent_terminal) {
                self.removeTransfer(index);
            } else if (self.response_count < self.responses.len) {
                self.advanceTransfer(index);
            }
            return;
        }
    }

    fn removeTransfer(self: *Connection, index: u32) void {
        std.debug.assert(self.transfers[index].id != 0);
        const requestor = self.transfers[index].requestor;
        const provider = self.transfers[index].provider;
        std.debug.assert(provider.transfer_count > 0);
        provider.transfer_count -= 1;
        self.transfer_count -= 1;
        if (index != self.transfer_count) self.transfers[index] = self.transfers[self.transfer_count];
        if (self.transfer_count == 0) self.transfer_cursor = 0 else self.transfer_cursor %= self.transfer_count;
        if (provider.retired and provider.transfer_count == 0) self.removeProvider(provider, true);
        if (self.phase == .ready) {
            for (self.transfers[0..self.transfer_count]) |transfer| {
                if (transfer.requestor == requestor) return;
            }
            const mask = [_]u32{0};
            _ = self.symbols.xcb_change_window_attributes(self.connection.?, requestor, 1 << 11, &mask);
            _ = self.queueFlush();
        }
    }

    fn removeTransferByID(self: *Connection, transfer_id: u64) void {
        std.debug.assert(transfer_id != 0);
        var index: u32 = 0;
        while (index < self.transfer_count) : (index += 1) {
            if (self.transfers[index].id != transfer_id) continue;
            self.removeTransfer(index);
            return;
        }
    }

    fn allocateTransferID(self: *Connection) u64 {
        const transfer_id = self.transfer_id_next;
        std.debug.assert(transfer_id != 0);
        std.debug.assert(transfer_id < std.math.maxInt(u64));
        self.transfer_id_next = transfer_id + 1;
        return transfer_id;
    }

    fn createOwnerWindow(self: *Connection) Progress {
        const connection = self.connection orelse return self.fail(.connection);
        const setup = self.symbols.xcb_get_setup(connection);
        var iterator = self.symbols.xcb_setup_roots_iterator(setup);
        var screen_index: c_int = 0;
        while (screen_index < self.screen_index and iterator.remaining > 0) : (screen_index += 1) {
            self.symbols.xcb_screen_next(&iterator);
        }
        if (iterator.remaining <= 0) return self.fail(.protocol);
        const screen = iterator.data;
        self.root_window = screen.root;
        self.maximum_request_bytes = @as(u32, setup.maximum_request_length) * 4;
        self.owner_window = self.symbols.xcb_generate_id(connection);
        if (self.owner_window == 0 or self.owner_window == std.math.maxInt(u32)) return self.fail(.protocol);
        const event_mask = [_]u32{EVENT_MASK_PROPERTY_CHANGE};
        _ = self.symbols.xcb_create_window(
            connection,
            0,
            self.owner_window,
            self.root_window,
            0,
            0,
            1,
            1,
            0,
            1,
            0,
            1 << 11,
            &event_mask,
        );
        self.phase = .window_flush;
        return .pending;
    }

    fn flushOwnerWindow(self: *Connection) Progress {
        const connection = self.connection orelse return self.fail(.connection);
        switch (self.flushReadiness(connection)) {
            .pending => return .pending,
            .failed => return self.fail(.connection),
            .ready => {},
        }
        if (self.symbols.xcb_flush(connection) <= 0) return self.fail(.flush);
        self.transfers = self.allocator.alloc(Transfer, self.max_provider_transfers) catch return self.fail(.provider);
        self.responses = self.allocator.alloc(PendingResponse, self.max_provider_transfers) catch return self.fail(.provider);
        self.phase = .ready;
        return .ready;
    }

    fn fail(self: *Connection, failure: Failure) Progress {
        self.failure = failure;
        self.phase = .failed;
        return .failed;
    }
};

fn parseDisplay(display: []const u8) !DisplayEndpoint {
    if (display.len == 0 or display.len > DISPLAY_SIZE_MAX) return error.UnsupportedDisplay;
    if (display[0] == '/') {
        const base = std.fs.path.basename(display);
        if (base.len < 2 or base[0] != 'X') return error.UnsupportedDisplay;
        const number = try parseDisplayNumber(base[1..]);
        return unixEndpoint(number, 0, display);
    }

    var host: []const u8 = undefined;
    var suffix: []const u8 = undefined;
    if (display[0] == '[') {
        const close = std.mem.indexOfScalar(u8, display, ']') orelse return error.UnsupportedDisplay;
        if (close + 1 >= display.len or display[close + 1] != ':') return error.UnsupportedDisplay;
        host = display[1..close];
        suffix = display[close + 2 ..];
    } else {
        const colon = std.mem.lastIndexOfScalar(u8, display, ':') orelse return error.UnsupportedDisplay;
        host = display[0..colon];
        suffix = display[colon + 1 ..];
    }
    const dot = std.mem.indexOfScalar(u8, suffix, '.');
    const number_text = if (dot) |index| suffix[0..index] else suffix;
    const screen_text = if (dot) |index| suffix[index + 1 ..] else "0";
    const number = try parseDisplayNumber(number_text);
    const screen = std.fmt.parseInt(c_int, screen_text, 10) catch return error.UnsupportedDisplay;
    if (screen < 0) return error.UnsupportedDisplay;

    if (host.len == 0 or std.mem.eql(u8, host, "unix") or std.mem.eql(u8, host, "unix/")) {
        var path_buffer: [108]u8 = undefined;
        const path = std.fmt.bufPrint(&path_buffer, "/tmp/.X11-unix/X{d}", .{number}) catch
            return error.UnsupportedDisplay;
        var endpoint = try unixEndpoint(number, screen, path);
        endpoint.unix_abstract_first = true;
        return endpoint;
    }
    if (std.mem.endsWith(u8, host, "/unix")) {
        var path_buffer: [108]u8 = undefined;
        const path = std.fmt.bufPrint(&path_buffer, "/tmp/.X11-unix/X{d}", .{number}) catch
            return error.UnsupportedDisplay;
        var endpoint = try unixEndpoint(number, screen, path);
        endpoint.unix_abstract_first = true;
        return endpoint;
    }
    if (std.mem.eql(u8, host, "localhost")) {
        if (number > 59535) return error.UnsupportedDisplay;
        return .{ .kind = .tcp6, .display = number, .screen = screen, .tcp4_fallback = true };
    }
    if (std.mem.eql(u8, host, "127.0.0.1")) {
        if (number > 59535) return error.UnsupportedDisplay;
        return .{ .kind = .tcp4, .display = number, .screen = screen };
    }
    if (std.mem.eql(u8, host, "::1")) {
        if (number > 59535) return error.UnsupportedDisplay;
        return .{ .kind = .tcp6, .display = number, .screen = screen };
    }
    // Remote DNS is intentionally unsupported; this backend only connects to local displays.
    return error.UnsupportedDisplay;
}

fn duplicateCancellationFd(fd: std.posix.fd_t) !std.posix.fd_t {
    const duplicate = try posix_io.duplicate(fd);
    errdefer posix_io.close(duplicate);
    try posix_io.setDescriptorFlags(duplicate, std.posix.FD_CLOEXEC);
    return duplicate;
}

fn parseDisplayNumber(text: []const u8) !u16 {
    if (text.len == 0 or text.len > 5) return error.UnsupportedDisplay;
    return std.fmt.parseInt(u16, text, 10) catch error.UnsupportedDisplay;
}

fn unixEndpoint(display: u16, screen: c_int, path: []const u8) !DisplayEndpoint {
    if (path.len == 0 or path.len >= 108) return error.UnsupportedDisplay;
    var endpoint: DisplayEndpoint = .{ .kind = .unix, .display = display, .screen = screen };
    @memcpy(endpoint.unix_path[0..path.len], path);
    endpoint.unix_path_length = @intCast(path.len);
    return endpoint;
}

fn displayCandidateCount(endpoint: DisplayEndpoint) u8 {
    if (endpoint.kind == .unix and endpoint.unix_abstract_first) return 2;
    if (endpoint.kind == .tcp6 and endpoint.tcp4_fallback) return 2;
    return 1;
}

fn displayAddress(endpoint: DisplayEndpoint, candidate_index: u8) !DisplayAddress {
    std.debug.assert(candidate_index < displayCandidateCount(endpoint));
    if (endpoint.kind == .unix) {
        if (endpoint.unix_abstract_first and candidate_index == 0) {
            var abstract_path: [108]u8 = @splat(0);
            const path_length: usize = endpoint.unix_path_length;
            if (path_length + 1 > abstract_path.len) return error.UnsupportedDisplay;
            @memcpy(abstract_path[1 .. path_length + 1], endpoint.unix_path[0..path_length]);
            const address = try SocketAddress.initUnix(abstract_path[0 .. path_length + 1]);
            return .{
                .address = address,
                .length = @intCast(@offsetOf(std.posix.sockaddr.un, "path") + path_length + 1),
                .kind = .unix,
            };
        }
        const address = try SocketAddress.initUnix(endpoint.unix_path[0..endpoint.unix_path_length]);
        return .{ .address = address, .length = address.length(), .kind = .unix };
    }
    const kind: DisplayKind = if (endpoint.kind == .tcp6 and endpoint.tcp4_fallback and candidate_index == 1)
        .tcp4
    else
        endpoint.kind;
    const address = switch (kind) {
        .tcp4 => SocketAddress.initIp4(.{ 127, 0, 0, 1 }, 6000 + endpoint.display),
        .tcp6 => SocketAddress.initIp6(
            .{ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 },
            6000 + endpoint.display,
        ),
        .unix => unreachable,
    };
    return .{ .address = address, .length = address.length(), .kind = kind };
}

fn loadXauthority(self: *Connection, endpoint: DisplayEndpoint) !XauthorityMatch {
    const allocator = self.allocator;
    var allocated_path: []u8 = &.{};
    defer if (allocated_path.len > 0) allocator.free(allocated_path);
    const path = if (posix_io.getEnv("XAUTHORITY")) |configured|
        configured
    else if (posix_io.getEnv("HOME")) |home| blk: {
        allocated_path = try std.fs.path.join(allocator, &.{ home, ".Xauthority" });
        break :blk allocated_path;
    } else return .{};
    if (path.len == 0 or path.len > std.fs.max_path_bytes) return .{};
    return loadXauthorityPath(self, endpoint, path);
}

fn loadXauthorityPath(self: *Connection, endpoint: DisplayEndpoint, path: []const u8) !XauthorityMatch {
    const open_flags: std.posix.O = .{
        .ACCMODE = .RDONLY,
        .NONBLOCK = true,
        .CLOEXEC = true,
        .NOFOLLOW = true,
    };
    // O_NONBLOCK bounds FIFOs and devices. A hostile FUSE filesystem may still block open itself.
    const fd = std.posix.openat(std.posix.AT.FDCWD, path, open_flags, 0) catch return .{};
    defer posix_io.close(fd);
    const stat = posix_io.stat(fd) catch return .{};
    if (stat.kind != .file) return .{};
    if (stat.size > XAUTHORITY_SIZE_MAX) return .{};
    const size_bytes: usize = @intCast(stat.size);
    const storage = try self.allocator.alloc(u8, size_bytes);
    errdefer self.allocator.free(storage);
    var offset: usize = 0;
    while (offset < storage.len) {
        if (self.cancelRequested()) return error.Cancelled;
        const chunk_end = @min(storage.len, offset + XAUTHORITY_READ_CHUNK_SIZE);
        const count = std.posix.read(fd, storage[offset..chunk_end]) catch {
            self.allocator.free(storage);
            return .{};
        };
        if (count == 0) break;
        offset += count;
    }
    if (offset != storage.len) {
        const resized = self.allocator.realloc(storage, offset) catch {
            self.allocator.free(storage);
            return .{};
        };
        return parseXauthority(resized, endpoint) catch return .{ .storage = resized };
    }
    return parseXauthority(storage, endpoint) catch return .{ .storage = storage };
}

fn parseXauthority(storage: []u8, endpoint: DisplayEndpoint) !XauthorityMatch {
    var hostname_buffer: [std.posix.HOST_NAME_MAX]u8 = undefined;
    const hostname = posix_io.getEnv("XAUTHLOCALHOSTNAME") orelse
        (std.posix.gethostname(&hostname_buffer) catch &.{});
    var best_score: u8 = 0;
    var best_name: []u8 = &.{};
    var best_data: []u8 = &.{};
    var offset: usize = 0;
    while (offset < storage.len) {
        const family = try readXauthorityU16(storage, &offset);
        const address = try readXauthorityField(storage, &offset);
        const number = try readXauthorityField(storage, &offset);
        const name = try readXauthorityField(storage, &offset);
        const data = try readXauthorityField(storage, &offset);
        // XDM-AUTHORIZATION-1 is intentionally unsupported; local MIT cookies cover the supported transports.
        if (!std.mem.eql(u8, name, XAUTH_NAME)) continue;
        if (!displayNumberMatches(number, endpoint.display)) continue;
        const score = xauthorityAddressScore(family, address, hostname, endpoint.kind);
        if (score <= best_score) continue;
        best_score = score;
        best_name = name;
        best_data = data;
    }
    return .{ .storage = storage, .name = best_name, .data = best_data };
}

fn readXauthorityU16(storage: []const u8, offset: *usize) !u16 {
    if (storage.len -| offset.* < 2) return error.InvalidXauthority;
    const value = std.mem.readInt(u16, storage[offset.*..][0..2], .big);
    offset.* += 2;
    return value;
}

fn readXauthorityField(storage: []u8, offset: *usize) ![]u8 {
    const length = try readXauthorityU16(storage, offset);
    if (length > storage.len -| offset.*) return error.InvalidXauthority;
    const field = storage[offset.*..][0..length];
    offset.* += length;
    return field;
}

fn displayNumberMatches(number: []const u8, display: u16) bool {
    // libXau semantics: an empty number field matches every display. Mutter's
    // Xwayland auth file writes its MIT cookies without a display number.
    if (number.len == 0) return true;
    if (number.len > 5) return false;
    return (std.fmt.parseInt(u16, number, 10) catch return false) == display;
}

fn xauthorityAddressScore(family: u16, address: []const u8, hostname: []const u8, kind: DisplayKind) u8 {
    if (family == XAUTH_FAMILY_WILD) return 1;
    if (family == XAUTH_FAMILY_LOCAL and std.mem.eql(u8, address, hostname)) return 4;
    if (kind == .tcp4 and family == XAUTH_FAMILY_INTERNET and std.mem.eql(u8, address, &.{ 127, 0, 0, 1 })) return 5;
    if (kind == .tcp6 and family == XAUTH_FAMILY_INTERNET6 and
        std.mem.eql(u8, address, &.{ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 })) return 5;
    return 0;
}

fn propertyLongLength(max_bytes: u32) u32 {
    return max_bytes / 4 + @intFromBool(max_bytes % 4 != 0);
}

fn propertyBytes(reply: *const linux.XcbGetPropertyReply) ?[]const u8 {
    const element_bytes: u32 = switch (reply.format) {
        0 => 0,
        8 => 1,
        16 => 2,
        32 => 4,
        else => return null,
    };
    const length = std.math.mul(u32, reply.value_length, element_bytes) catch return null;
    const framed_length = std.math.mul(u32, reply.length, 4) catch return null;
    if (length > framed_length) return null;
    const pointer: [*]const u8 = @ptrCast(reply);
    return pointer[@sizeOf(linux.XcbGetPropertyReply)..][0..length];
}

fn failReadCandidate(state: *ReadState) ReadResult {
    state.phase = .failed;
    return .candidate_failed;
}

fn timestampBefore(left: u32, right: u32) bool {
    const difference: i32 = @bitCast(left -% right);
    return difference < 0;
}

fn requestSequenceMatches(expected: u32, actual: u32) bool {
    return expected != 0 and expected == actual;
}

fn encodeLatin1(allocator: std.mem.Allocator, utf8: []const u8) ![]u8 {
    var count: usize = 0;
    var offset: usize = 0;
    while (offset < utf8.len) : (count += 1) {
        const sequence_length = std.unicode.utf8ByteSequenceLength(utf8[offset]) catch return error.InvalidUtf8;
        if (sequence_length > utf8.len - offset) return error.InvalidUtf8;
        const codepoint = std.unicode.utf8Decode(utf8[offset .. offset + sequence_length]) catch return error.InvalidUtf8;
        if (codepoint > 255) return error.NotRepresentable;
        offset += sequence_length;
    }
    const output = try allocator.alloc(u8, count);
    offset = 0;
    var output_index: usize = 0;
    while (offset < utf8.len) : (output_index += 1) {
        const sequence_length = std.unicode.utf8ByteSequenceLength(utf8[offset]) catch unreachable;
        output[output_index] = @intCast(std.unicode.utf8Decode(utf8[offset .. offset + sequence_length]) catch unreachable);
        offset += sequence_length;
    }
    return output;
}

fn appendLatin1(
    allocator: std.mem.Allocator,
    output: *std.ArrayListUnmanaged(u8),
    latin1: []const u8,
    max_bytes: u32,
) !bool {
    var required: usize = 0;
    for (latin1) |byte| required += if (byte < 0x80) 1 else 2;
    if (required > max_bytes -| output.items.len) return false;
    try output.ensureUnusedCapacity(allocator, required);
    for (latin1) |byte| {
        if (byte < 0x80) {
            output.appendAssumeCapacity(byte);
        } else {
            output.appendAssumeCapacity(0xc0 | (byte >> 6));
            output.appendAssumeCapacity(0x80 | (byte & 0x3f));
        }
    }
    return true;
}

test "X11 MIME candidates preserve caller order and deterministic target compatibility" {
    var connection: Connection = undefined;
    connection.phase = .ready;
    for (&connection.atom_values, 0..) |*atom, index| atom.* = @intCast(100 + index);
    var output: [6]u32 = undefined;

    const text = connection.targetAtoms("text/plain", &output);
    try std.testing.expectEqualSlices(u32, &.{ 109, 105, 102, 104, 103, 31 }, text);
    const png = connection.targetAtoms("image/png", &output);
    try std.testing.expectEqualSlices(u32, &.{106}, png);
    try std.testing.expectEqualSlices(u32, &.{111}, connection.targetAtoms("image/jpeg", &output));
    try std.testing.expectEqualSlices(u32, &.{112}, connection.targetAtoms("image/webp", &output));
    try std.testing.expectEqualSlices(u32, &.{113}, connection.targetAtoms("image/gif", &output));
    try std.testing.expectEqual(@as(usize, 0), connection.targetAtoms("application/octet-stream", &output).len);
}

test "X11 SelectionNotify routing isolates concurrent requestor windows" {
    var connection: Connection = undefined;
    var first: ReadState = .{ .phase = .selection, .window = 10, .selection = 1, .target = 2 };
    var second: ReadState = .{ .phase = .selection, .window = 11, .selection = 1, .target = 2 };
    const event: linux.XcbSelectionNotifyEvent = .{
        .response_type = EVENT_SELECTION_NOTIFY,
        .pad0 = 0,
        .sequence = 0,
        .time = 0,
        .requestor = 11,
        .selection = 1,
        .target = 2,
        .property = 0,
    };

    try std.testing.expect(!connection.routeReadEvent(&first, @ptrCast(&event)));
    try std.testing.expect(connection.routeReadEvent(&second, @ptrCast(&event)));
    try std.testing.expectEqual(ReadPhase.selection, first.phase);
    try std.testing.expectEqual(ReadPhase.refused, second.phase);
}

test "X11 SelectionNotify routing accepts the xsel TEXT to STRING alias" {
    var symbols: linux.XcbSymbols = undefined;
    symbols.xcb_get_property = fakeGetProperty;
    var connection = Connection.init(std.testing.allocator, &symbols, 1);
    connection.connection = @ptrFromInt(1);
    connection.phase = .ready;
    connection.output_ready_override = false;
    for (&connection.atom_values, 0..) |*atom, index| atom.* = @intCast(100 + index);
    var state: ReadState = .{
        .phase = .selection,
        .window = 10,
        .selection = 1,
        .target = connection.atoms().?.text,
    };
    var event: linux.XcbSelectionNotifyEvent = .{
        .response_type = EVENT_SELECTION_NOTIFY,
        .pad0 = 0,
        .sequence = 0,
        .time = 0,
        .requestor = 10,
        .selection = 1,
        .target = ATOM_STRING,
        .property = connection.atoms().?.property,
    };

    try std.testing.expect(connection.routeReadEvent(&state, @ptrCast(&event)));
    try std.testing.expectEqual(ReadPhase.property, state.phase);
    try std.testing.expect(state.property_cookie != null);

    state.phase = .selection;
    state.target = connection.atoms().?.utf8_string;
    try std.testing.expect(!connection.routeReadEvent(&state, @ptrCast(&event)));
    try std.testing.expectEqual(ReadPhase.selection, state.phase);
}

test "X11 property parsing enforces reply framing bounds" {
    const Property = extern struct {
        reply: linux.XcbGetPropertyReply,
        data: [4]u8,
    };
    var property: Property = .{
        .reply = .{
            .response_type = 1,
            .format = 8,
            .sequence = 0,
            .length = 1,
            .atom_type = 1,
            .bytes_after = 0,
            .value_length = 4,
            .pad0 = .{0} ** 12,
        },
        .data = "test".*,
    };
    try std.testing.expectEqualStrings("test", propertyBytes(&property.reply).?);
    property.reply.value_length = 5;
    try std.testing.expect(propertyBytes(&property.reply) == null);
}

test "X11 provider generations reserve capacity independently per selection" {
    var connection: Connection = undefined;
    connection.phase = .ready;
    connection.atom_values[0] = 100;
    var clipboard_current: Provider = .{ .selection = 100, .data = &.{} };
    var clipboard_retired: Provider = .{ .selection = 100, .data = &.{}, .retired = true, .transfer_count = 1 };
    connection.providers = .{ &clipboard_current, &clipboard_retired, null, null };
    connection.clipboard_provider = &clipboard_current;
    connection.primary_provider = null;

    try std.testing.expect(!connection.canPublish(false));
    try std.testing.expect(connection.canPublish(true));
}

test "X11 STRING conversion is Latin-1 aware and bounded after UTF-8 expansion" {
    const latin1 = try encodeLatin1(std.testing.allocator, "A\u{e9}");
    defer std.testing.allocator.free(latin1);
    try std.testing.expectEqualSlices(u8, &.{ 'A', 0xe9 }, latin1);
    try std.testing.expectError(error.NotRepresentable, encodeLatin1(std.testing.allocator, "\u{20ac}"));

    var output: std.ArrayListUnmanaged(u8) = .empty;
    defer output.deinit(std.testing.allocator);
    try std.testing.expect(try appendLatin1(std.testing.allocator, &output, latin1, 3));
    try std.testing.expectEqualStrings("A\u{e9}", output.items);
    try std.testing.expect(!(try appendLatin1(std.testing.allocator, &output, &.{0xff}, 4)));
}

test "X11 timestamp ordering handles server timestamp wraparound" {
    try std.testing.expect(timestampBefore(10, 20));
    try std.testing.expect(!timestampBefore(20, 10));
    try std.testing.expect(timestampBefore(std.math.maxInt(u32) - 2, 2));
}

test "X11 buffers early INCR notifications while the previous property reply is pending" {
    var connection: Connection = undefined;
    connection.phase = .ready;
    connection.atom_values[7] = 107;
    var state: ReadState = .{
        .phase = .property,
        .window = 10,
        .max_bytes = 1024,
        .incremental = true,
    };
    const event: linux.XcbPropertyNotifyEvent = .{
        .response_type = EVENT_PROPERTY_NOTIFY,
        .pad0 = 0,
        .sequence = 0,
        .window = 10,
        .atom = 107,
        .time = 1,
        .state = 0,
        .pad1 = .{0} ** 3,
    };
    try std.testing.expect(connection.routeReadEvent(&state, @ptrCast(&event)));
    try std.testing.expect(state.notification_pending);
    try std.testing.expectEqual(ReadPhase.property, state.phase);
}

test "X11 buffers INCR deletions while a checked chunk response is pending" {
    var connection: Connection = undefined;
    var provider: Provider = .{ .selection = 1, .data = &.{}, .transfer_count = 1 };
    var transfers: [1]Transfer = .{.{
        .id = 1,
        .provider = &provider,
        .data = &.{},
        .requestor = 10,
        .property = 20,
        .target = 30,
        .last_progress_ns = 1,
    }};
    var responses = [_]PendingResponse{.{
        .request = std.mem.zeroes(linux.XcbSelectionRequestEvent),
        .property_cookie = .{ .sequence = 1 },
        .barrier_cookie = .{ .sequence = 2 },
        .property = 20,
        .transfer_id = 1,
    }};
    connection.transfers = &transfers;
    connection.transfer_count = 1;
    connection.responses = &responses;
    connection.response_count = 1;
    const event: linux.XcbPropertyNotifyEvent = .{
        .response_type = EVENT_PROPERTY_NOTIFY,
        .pad0 = 0,
        .sequence = 0,
        .window = 10,
        .atom = 20,
        .time = 1,
        .state = PROPERTY_DELETE,
        .pad1 = .{0} ** 3,
    };
    connection.handleTransferProperty(&event);
    try std.testing.expect(connection.transfers[0].delete_pending);
    try std.testing.expectEqual(@as(u32, 1), connection.transfer_count);
}

test "X11 read cleanup remains safe after the connection enters failed phase" {
    var symbols: linux.XcbSymbols = undefined;
    symbols.xcb_discard_reply = fakeDiscardReply;
    symbols.xcb_delete_property = fakeDeleteProperty;
    symbols.xcb_destroy_window = fakeDestroyWindow;
    var fake: FakeXcb = .{};
    var connection: Connection = undefined;
    connection.allocator = std.testing.allocator;
    connection.symbols = &symbols;
    connection.connection = @ptrCast(&fake);
    connection.phase = .failed;
    connection.atom_values[7] = 107;
    var state: ReadState = .{ .window = 42 };

    connection.cleanupRead(&state);

    try std.testing.expectEqual(@as(u32, 0), state.window);

    connection.connection = null;
    state = .{ .phase = .failed, .window = 43 };
    connection.cleanupRead(&state);
    try std.testing.expectEqual(ReadState{}, state);
}

test "X11 timestamp events are isolated by per-mutation windows" {
    var connection: Connection = undefined;
    connection.phase = .ready;
    connection.owner_window = 1;
    connection.atom_values[10] = 110;
    var successor: WriteState = .{
        .selection = ATOM_PRIMARY,
        .waiting_timestamp = true,
        .timestamp_window = 22,
    };
    const stale: linux.XcbPropertyNotifyEvent = .{
        .response_type = EVENT_PROPERTY_NOTIFY,
        .pad0 = 0,
        .sequence = 0,
        .window = 21,
        .atom = 110,
        .time = 7,
        .state = 0,
        .pad1 = .{0} ** 3,
    };

    try std.testing.expect(!connection.routeWriteEvent(&successor, @ptrCast(&stale)));
    try std.testing.expect(successor.waiting_timestamp);
}

test "X11 write and clear commit after the server confirms selection ownership" {
    var symbols: linux.XcbSymbols = undefined;
    symbols.xcb_destroy_window = fakeDestroyWindow;
    symbols.xcb_set_selection_owner = fakeSetSelectionOwner;
    symbols.xcb_get_selection_owner = fakeGetSelectionOwner;
    symbols.xcb_poll_for_reply = fakePollSelectionOwnerReply;
    symbols.xcb_flush = fakeFlush;
    var fake: FakeXcb = .{ .replies_ready = true };
    var connection = Connection.init(std.testing.allocator, &symbols, 1);
    connection.connection = @ptrCast(&fake);
    connection.phase = .ready;
    connection.output_ready_override = true;
    connection.owner_window = 1;
    connection.atom_values[10] = 110;
    const old_provider = try std.testing.allocator.create(Provider);
    old_provider.* = .{ .selection = ATOM_PRIMARY, .data = &.{}, .owns_data = true, .transfer_count = 1 };
    const new_provider = try std.testing.allocator.create(Provider);
    new_provider.* = .{ .selection = ATOM_PRIMARY, .data = &.{} };
    connection.providers = .{ old_provider, new_provider, null, null };
    connection.primary_provider = old_provider;
    var state: WriteState = .{
        .provider = new_provider,
        .selection = ATOM_PRIMARY,
        .waiting_timestamp = true,
        .timestamp_window = 22,
    };
    const event: linux.XcbPropertyNotifyEvent = .{
        .response_type = EVENT_PROPERTY_NOTIFY,
        .pad0 = 0,
        .sequence = 0,
        .window = 22,
        .atom = 110,
        .time = 7,
        .state = 0,
        .pad1 = .{0} ** 3,
    };

    try std.testing.expect(connection.routeWriteEvent(&state, @ptrCast(&event)));
    try std.testing.expect(state.mutation_dispatched);
    try std.testing.expect(!state.committed);
    try std.testing.expect(state.provider == null);
    try std.testing.expect(connection.primary_provider == new_provider);
    try std.testing.expect(old_provider.retired);
    try std.testing.expectEqual(SelectionResult.committed, connection.driveWrite(&state));
    try std.testing.expectEqual(@as(u32, 1), fake.get_owner_count);

    var clear_state: WriteState = .{
        .clear = true,
        .selection = ATOM_PRIMARY,
        .waiting_timestamp = true,
        .timestamp_window = 23,
    };
    var clear_event = event;
    clear_event.window = 23;
    clear_event.time = 8;
    try std.testing.expect(connection.routeWriteEvent(&clear_state, @ptrCast(&clear_event)));
    try std.testing.expect(!clear_state.committed);
    try std.testing.expect(connection.primary_provider == null);
    try std.testing.expectEqual(SelectionResult.committed, connection.driveWrite(&clear_state));
    try std.testing.expectEqual(@as(u32, 2), fake.get_owner_count);

    const rejected_provider = try std.testing.allocator.create(Provider);
    rejected_provider.* = .{ .selection = ATOM_PRIMARY, .data = &.{} };
    connection.providers[1] = rejected_provider;
    var rejected_state: WriteState = .{
        .provider = rejected_provider,
        .selection = ATOM_PRIMARY,
        .waiting_timestamp = true,
        .timestamp_window = 24,
    };
    var rejected_event = event;
    rejected_event.window = 24;
    rejected_event.time = 9;
    fake.reject_selection_owner = true;
    try std.testing.expect(connection.routeWriteEvent(&rejected_state, @ptrCast(&rejected_event)));
    try std.testing.expectEqual(SelectionResult.failed, connection.driveWrite(&rejected_state));
    try std.testing.expect(connection.primary_provider == null);
    try std.testing.expect(connection.providers[1] == null);

    fake.flush_fails = true;
    connection.phase = .ready;
    connection.output_pending = true;
    var flush_failure: WriteState = .{ .mutation_dispatched = true };
    try std.testing.expectEqual(SelectionResult.failed, connection.driveWrite(&flush_failure));
    try std.testing.expectEqual(Failure.flush, connection.failure);
    try std.testing.expectEqual(Phase.failed, connection.phase);
    try std.testing.expect(!connection.output_pending);

    connection.releaseProviders();
}

test "X11 SelectionClear ignores older timestamps and accepts equal timestamps" {
    var connection: Connection = undefined;
    connection.owner_window = 1;
    var provider: Provider = .{
        .selection = ATOM_PRIMARY,
        .data = &.{},
        .timestamp = 7,
        .owns_data = true,
        .transfer_count = 1,
    };
    connection.providers = .{ &provider, null, null, null };
    connection.primary_provider = &provider;
    var event: linux.XcbSelectionClearEvent = .{
        .response_type = EVENT_SELECTION_CLEAR,
        .pad0 = 0,
        .sequence = 0,
        .time = 6,
        .owner = 1,
        .selection = ATOM_PRIMARY,
    };

    connection.handleSelectionClear(&event);
    try std.testing.expect(connection.primary_provider == &provider);
    event.time = 7;
    connection.handleSelectionClear(&event);
    try std.testing.expect(connection.primary_provider == null);
    try std.testing.expect(provider.retired);
}

test "X11 INCR expiry runs while provider responses remain pending" {
    try clipboard_clock.init();
    var symbols: linux.XcbSymbols = undefined;
    symbols.xcb_poll_for_reply = fakePendingReply;
    symbols.xcb_change_window_attributes = fakeChangeWindowAttributes;
    symbols.xcb_flush = fakeFlush;
    var fake: FakeXcb = .{};
    var connection = Connection.init(std.testing.allocator, &symbols, 1);
    connection.connection = @ptrCast(&fake);
    connection.phase = .ready;
    connection.output_ready_override = true;
    var provider: Provider = .{ .selection = ATOM_PRIMARY, .data = &.{}, .transfer_count = 1 };
    var transfers = [_]Transfer{.{
        .id = 1,
        .provider = &provider,
        .data = &.{},
        .requestor = 10,
        .property = 20,
        .target = 30,
        .last_progress_ns = clipboard_clock.nowNs() - TRANSFER_IDLE_TIMEOUT_NS,
    }};
    var responses = [_]PendingResponse{.{
        .request = std.mem.zeroes(linux.XcbSelectionRequestEvent),
        .property_cookie = .{ .sequence = 1 },
        .barrier_cookie = .{ .sequence = 2 },
        .property = 20,
    }};
    connection.transfers = &transfers;
    connection.transfer_count = 1;
    connection.responses = &responses;
    connection.response_count = 1;

    _ = connection.driveProviderUnit();

    try std.testing.expectEqual(@as(u32, 0), connection.transfer_count);
    try std.testing.expectEqual(@as(u32, 0), provider.transfer_count);
    try std.testing.expectEqual(@as(u32, 1), connection.response_count);
    try std.testing.expectEqual(@as(u32, 1), fake.event_mask_clear_count);
}

test "X11 expired initial INCR response refuses its delayed checked reply" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    try clipboard_clock.init();
    var symbols: linux.XcbSymbols = undefined;
    symbols.xcb_poll_for_reply = fakePollForReply;
    symbols.xcb_request_check = fakeRequestCheck;
    symbols.xcb_send_event = fakeSendEvent;
    symbols.xcb_change_window_attributes = fakeChangeWindowAttributes;
    symbols.xcb_flush = fakeFlush;
    var fake: FakeXcb = .{ .replies_ready = true };
    var connection = Connection.init(std.testing.allocator, &symbols, 1);
    connection.connection = @ptrCast(&fake);
    connection.phase = .ready;
    connection.output_ready_override = true;
    var provider: Provider = .{ .selection = ATOM_PRIMARY, .data = &.{}, .transfer_count = 1 };
    var transfers = [_]Transfer{.{
        .id = 1,
        .provider = &provider,
        .data = &.{},
        .requestor = 10,
        .property = 20,
        .target = 30,
        .last_progress_ns = clipboard_clock.nowNs() - TRANSFER_IDLE_TIMEOUT_NS,
    }};
    var responses = [_]PendingResponse{.{
        .request = .{
            .response_type = EVENT_SELECTION_REQUEST,
            .pad0 = 0,
            .sequence = 0,
            .time = 1,
            .owner = 2,
            .requestor = 10,
            .selection = ATOM_PRIMARY,
            .target = 30,
            .property = 20,
        },
        .property_cookie = .{ .sequence = 1 },
        .barrier_cookie = .{ .sequence = 2 },
        .property = 20,
        .transfer_id = 1,
    }};
    connection.transfers = &transfers;
    connection.transfer_count = 1;
    connection.responses = &responses;
    connection.response_count = 1;

    _ = connection.driveProviderUnit();
    _ = connection.driveProviderUnit();

    try std.testing.expectEqual(@as(u32, 0), connection.transfer_count);
    try std.testing.expectEqual(@as(u32, 0), connection.response_count);
    try std.testing.expectEqual(@as(u32, 0), fake.last_notify_property);
    try std.testing.expectEqual(@as(u32, 1), fake.send_event_count);
}

test "X11 delayed expired INCR response preserves replacement transfer" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    try clipboard_clock.init();
    var symbols: linux.XcbSymbols = undefined;
    symbols.xcb_poll_for_reply = fakePollForReply;
    symbols.xcb_request_check = fakeRequestCheck;
    symbols.xcb_send_event = fakeSendEvent;
    symbols.xcb_change_window_attributes = fakeChangeWindowAttributes;
    symbols.xcb_flush = fakeFlush;
    var fake: FakeXcb = .{ .replies_ready = true };
    var connection = Connection.init(std.testing.allocator, &symbols, 2);
    connection.connection = @ptrCast(&fake);
    connection.phase = .ready;
    connection.output_ready_override = true;
    var provider_a: Provider = .{ .selection = ATOM_PRIMARY, .data = &.{}, .transfer_count = 1 };
    var provider_b: Provider = .{ .selection = ATOM_PRIMARY, .data = &.{}, .transfer_count = 0 };
    var transfers: [2]Transfer = undefined;
    transfers[0] = .{
        .id = 1,
        .provider = &provider_a,
        .data = &.{},
        .requestor = 10,
        .property = 20,
        .target = 30,
        .last_progress_ns = clipboard_clock.nowNs() - TRANSFER_IDLE_TIMEOUT_NS,
    };
    var responses = [_]PendingResponse{.{
        .request = std.mem.zeroes(linux.XcbSelectionRequestEvent),
        .property_cookie = .{ .sequence = 1 },
        .barrier_cookie = .{ .sequence = 2 },
        .property = 20,
        .transfer_id = 1,
    }};
    connection.transfers = &transfers;
    connection.transfer_count = 1;
    connection.responses = &responses;
    connection.response_count = 1;

    fake.replies_ready = false;
    _ = connection.driveProviderUnit();
    try std.testing.expectEqual(@as(u32, 0), connection.transfer_count);

    transfers[0] = .{
        .id = 2,
        .provider = &provider_b,
        .data = &.{},
        .requestor = 10,
        .property = 20,
        .target = 30,
        .last_progress_ns = clipboard_clock.nowNs(),
    };
    connection.transfer_count = 1;
    provider_b.transfer_count = 1;
    fake.replies_ready = true;
    _ = connection.driveProviderUnit();

    try std.testing.expectEqual(@as(u32, 1), connection.transfer_count);
    try std.testing.expect(connection.transfers[0].provider == &provider_b);
    try std.testing.expectEqual(@as(u32, 1), provider_b.transfer_count);
}

test "X11 cancelled timestamp windows remain tombstoned until their event is consumed" {
    var symbols: linux.XcbSymbols = undefined;
    symbols.xcb_destroy_window = fakeDestroyWindow;
    symbols.xcb_flush = fakeFlush;
    var fake: FakeXcb = .{};
    var connection = Connection.init(std.testing.allocator, &symbols, 1);
    connection.connection = @ptrCast(&fake);
    connection.phase = .ready;
    connection.output_ready_override = true;
    connection.atom_values[10] = 110;
    var clipboard: WriteState = .{ .selection = 100, .waiting_timestamp = true, .timestamp_window = 21 };
    var primary: WriteState = .{ .selection = ATOM_PRIMARY, .waiting_timestamp = true, .timestamp_window = 22 };
    connection.cleanupWrite(&clipboard);
    connection.cleanupWrite(&primary);
    const event: linux.XcbPropertyNotifyEvent = .{
        .response_type = EVENT_PROPERTY_NOTIFY,
        .pad0 = 0,
        .sequence = 0,
        .window = 21,
        .atom = 110,
        .time = 7,
        .state = 0,
        .pad1 = .{0} ** 3,
    };

    try std.testing.expect(connection.consumeRetiredTimestampEvent(@ptrCast(&event)));
    try std.testing.expectEqual(@as(u32, 0), connection.retired_timestamps[0].window);
    try std.testing.expectEqual(@as(u32, 22), connection.retired_timestamps[1].window);
}

test "X11 timestamp request errors retire active and tombstoned windows" {
    var symbols: linux.XcbSymbols = undefined;
    symbols.xcb_destroy_window = fakeDestroyWindow;
    symbols.xcb_flush = fakeFlush;
    var fake: FakeXcb = .{};
    var connection: Connection = undefined;
    connection.allocator = std.testing.allocator;
    connection.symbols = &symbols;
    connection.connection = @ptrCast(&fake);
    connection.phase = .ready;
    connection.output_ready_override = true;

    const provider = try std.testing.allocator.create(Provider);
    provider.* = .{ .selection = 1, .data = &.{} };
    connection.providers = .{ provider, null, null, null };
    var active: WriteState = .{ .provider = provider, .waiting_timestamp = true, .timestamp_window = 21 };
    const active_error: linux.XcbGenericError = .{
        .response_type = 0,
        .error_code = 3,
        .sequence = 0,
        .resource_id = 21,
        .minor_code = 0,
        .major_code = 18,
        .pad0 = 0,
        .pad = .{0} ** 5,
        .full_sequence = 0,
    };
    try std.testing.expect(connection.routeWriteEvent(&active, @ptrCast(&active_error)));
    try std.testing.expect(active.failed);
    try std.testing.expect(!active.waiting_timestamp);
    try std.testing.expect(active.provider == null);
    try std.testing.expect(connection.providers[0] == null);

    connection.retired_timestamps[0].window = 22;
    var retired_error = active_error;
    retired_error.resource_id = 22;
    try std.testing.expect(connection.consumeRetiredTimestampEvent(@ptrCast(&retired_error)));
    try std.testing.expectEqual(@as(u32, 0), connection.retired_timestamps[0].window);
}

test "X11 DISPLAY parser accepts bounded local transports and rejects remote hosts" {
    const accepted = [_]struct { display: []const u8, kind: DisplayKind, number: u16, screen: c_int }{
        .{ .display = ":0", .kind = .unix, .number = 0, .screen = 0 },
        .{ .display = ":12.3", .kind = .unix, .number = 12, .screen = 3 },
        .{ .display = "unix:1", .kind = .unix, .number = 1, .screen = 0 },
        .{ .display = "unix/:2", .kind = .unix, .number = 2, .screen = 0 },
        .{ .display = "host/unix:3", .kind = .unix, .number = 3, .screen = 0 },
        .{ .display = "/tmp/.X11-unix/X4", .kind = .unix, .number = 4, .screen = 0 },
        .{ .display = "localhost:10.1", .kind = .tcp6, .number = 10, .screen = 1 },
        .{ .display = "127.0.0.1:11", .kind = .tcp4, .number = 11, .screen = 0 },
        .{ .display = "[::1]:12", .kind = .tcp6, .number = 12, .screen = 0 },
    };
    for (accepted) |expected| {
        const endpoint = try parseDisplay(expected.display);
        try std.testing.expectEqual(expected.kind, endpoint.kind);
        try std.testing.expectEqual(expected.number, endpoint.display);
        try std.testing.expectEqual(expected.screen, endpoint.screen);
    }
    try std.testing.expect((try parseDisplay(":0")).unix_abstract_first);
    try std.testing.expect((try parseDisplay("localhost:0")).tcp4_fallback);
    try std.testing.expect(!(try parseDisplay("127.0.0.1:0")).tcp4_fallback);
    try std.testing.expect(!(try parseDisplay("[::1]:0")).tcp4_fallback);
    const rejected = [_][]const u8{
        "", "example.com:0", "192.0.2.1:0", "[::2]:0", "localhost", ":", ":1.-1", "localhost:59536",
    };
    for (rejected) |display| try std.testing.expectError(error.UnsupportedDisplay, parseDisplay(display));
}

test "X11 Xauthority parser selects exact loopback MIT cookie and rejects truncation" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    var bytes: std.ArrayListUnmanaged(u8) = .empty;
    defer bytes.deinit(std.testing.allocator);
    try appendTestXauthorityRecord(&bytes, XAUTH_FAMILY_WILD, &.{}, "10", XAUTH_NAME, "wild");
    try appendTestXauthorityRecord(&bytes, XAUTH_FAMILY_INTERNET, &.{ 127, 0, 0, 1 }, "10", XAUTH_NAME, "best");
    const endpoint = try parseDisplay("127.0.0.1:10");
    const match = try parseXauthority(bytes.items, endpoint);
    try std.testing.expectEqualStrings(XAUTH_NAME, match.name);
    try std.testing.expectEqualStrings("best", match.data);
    try std.testing.expectError(error.InvalidXauthority, parseXauthority(bytes.items[0 .. bytes.items.len - 1], endpoint));
}

test "X11 Xauthority parser treats an empty display number as a wildcard" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    // Mutter writes Xwayland MIT cookies without a display number; libXau treats
    // that as matching every display, so rejecting it breaks GNOME Xwayland auth.
    var bytes: std.ArrayListUnmanaged(u8) = .empty;
    defer bytes.deinit(std.testing.allocator);
    try appendTestXauthorityRecord(&bytes, XAUTH_FAMILY_WILD, &.{}, "", XAUTH_NAME, "mutter");
    const endpoint = try parseDisplay(":0");
    const match = try parseXauthority(bytes.items, endpoint);
    try std.testing.expectEqualStrings(XAUTH_NAME, match.name);
    try std.testing.expectEqualStrings("mutter", match.data);

    try std.testing.expect(displayNumberMatches("", 0));
    try std.testing.expect(displayNumberMatches("", 42));
    try std.testing.expect(!displayNumberMatches("1", 0));
    try std.testing.expect(!displayNumberMatches("123456", 0));
}

test "X11 Xauthority loading accepts only bounded regular files and observes cancellation" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    try clipboard_clock.init();
    var symbols: linux.XcbSymbols = undefined;
    var connection = Connection.init(std.testing.allocator, &symbols, 1);
    const endpoint = try parseDisplay("127.0.0.1:10");
    var bytes: std.ArrayListUnmanaged(u8) = .empty;
    defer bytes.deinit(std.testing.allocator);
    try appendTestXauthorityRecord(&bytes, XAUTH_FAMILY_INTERNET, &.{ 127, 0, 0, 1 }, "10", XAUTH_NAME, "cookie");

    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(std.testing.io, .{ .sub_path = "authority", .data = bytes.items });
    const authority_path = try tmp.dir.realPathFileAlloc(std.testing.io, "authority", std.testing.allocator);
    defer std.testing.allocator.free(authority_path);

    var match = try loadXauthorityPath(&connection, endpoint, authority_path);
    defer match.deinit(std.testing.allocator);
    try std.testing.expectEqualStrings("cookie", match.data);

    const oversized = try tmp.dir.createFile(std.testing.io, "oversized", .{});
    try oversized.setLength(std.testing.io, XAUTHORITY_SIZE_MAX + 1);
    oversized.close(std.testing.io);
    const oversized_path = try tmp.dir.realPathFileAlloc(std.testing.io, "oversized", std.testing.allocator);
    defer std.testing.allocator.free(oversized_path);
    var oversized_match = try loadXauthorityPath(&connection, endpoint, oversized_path);
    defer oversized_match.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 0), oversized_match.storage.len);

    connection.requestShutdown();
    try std.testing.expectError(error.Cancelled, loadXauthorityPath(&connection, endpoint, authority_path));
}

test "X11 Xauthority FIFO is rejected without waiting for a writer" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    try clipboard_clock.init();
    var symbols: linux.XcbSymbols = undefined;
    var connection = Connection.init(std.testing.allocator, &symbols, 1);
    const endpoint = try parseDisplay(":0");
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var dir_path_buffer: [std.fs.max_path_bytes]u8 = undefined;
    const dir_path = dir_path_buffer[0..try tmp.dir.realPath(std.testing.io, &dir_path_buffer)];
    const fifo_path = try std.fs.path.join(std.testing.allocator, &.{ dir_path, "authority.fifo" });
    defer std.testing.allocator.free(fifo_path);
    const fifo_path_z = try std.testing.allocator.dupeZ(u8, fifo_path);
    defer std.testing.allocator.free(fifo_path_z);
    if (mkfifo(fifo_path_z, 0o600) != 0) return error.MkfifoFailed;

    const started_ns = clipboard_clock.nowNs();
    var match = try loadXauthorityPath(&connection, endpoint, fifo_path);
    defer match.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 0), match.storage.len);
    try std.testing.expect(clipboard_clock.nowNs() - started_ns < 500 * std.time.ns_per_ms);
}

test "X11 bare DISPLAY connects to an abstract-only listener" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    try clipboard_clock.init();
    var symbols: linux.XcbSymbols = undefined;
    var connection = Connection.init(std.testing.allocator, &symbols, 1);
    const listener = try testDisplayListener(.unix, 0);
    defer posix_io.close(listener.fd);
    var endpoint = listener.endpoint;

    const fd = try connection.connectSocket(&endpoint);
    defer posix_io.close(fd);
    try std.testing.expectEqual(DisplayKind.unix, endpoint.kind);
}

test "X11 bare DISPLAY falls back to a filesystem listener" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    try clipboard_clock.init();
    var symbols: linux.XcbSymbols = undefined;
    var connection = Connection.init(std.testing.allocator, &symbols, 1);
    const listener = try testDisplayListener(.unix, 1);
    defer posix_io.close(listener.fd);
    var endpoint = listener.endpoint;
    defer posix_io.unlink(endpoint.unix_path[0..endpoint.unix_path_length]) catch {};

    const fd = try connection.connectSocket(&endpoint);
    defer posix_io.close(fd);
    try std.testing.expectEqual(DisplayKind.unix, endpoint.kind);
}

test "X11 localhost DISPLAY connects to an IPv6-only listener" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    try clipboard_clock.init();
    var symbols: linux.XcbSymbols = undefined;
    var connection = Connection.init(std.testing.allocator, &symbols, 1);
    const listener = testDisplayListener(.tcp6, 0) catch |err| switch (err) {
        error.AddressFamilyNotSupported => return error.SkipZigTest,
        else => return err,
    };
    defer posix_io.close(listener.fd);
    var endpoint = listener.endpoint;

    const fd = try connection.connectSocket(&endpoint);
    defer posix_io.close(fd);
    try std.testing.expectEqual(DisplayKind.tcp6, endpoint.kind);
}

test "X11 localhost DISPLAY falls back to an IPv4-only listener" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    try clipboard_clock.init();
    var symbols: linux.XcbSymbols = undefined;
    var connection = Connection.init(std.testing.allocator, &symbols, 1);
    const listener = try testDisplayListener(.tcp4, 1);
    defer posix_io.close(listener.fd);
    var endpoint = listener.endpoint;

    const fd = try connection.connectSocket(&endpoint);
    defer posix_io.close(fd);
    try std.testing.expectEqual(DisplayKind.tcp4, endpoint.kind);
}

test "X11 shutdown before fd publication exits without joining early" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    try clipboard_clock.init();
    var symbols: linux.XcbSymbols = undefined;
    var connection = Connection.init(std.testing.allocator, &symbols, 1);
    connection.requestShutdown();
    connection.requestShutdown();
    try std.testing.expectEqual(Progress.pending, connection.drive());
    try expectShutdownReady(&connection);
    connection.deinit();
}

test "X11 connection establishment does not block a drive unit" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    try clipboard_clock.init();
    var symbols: linux.XcbSymbols = undefined;
    symbols.xcb_connect_to_fd = fakeSlowConnectToFd;
    symbols.xcb_connection_has_error = fakeConnectionHasError;
    symbols.xcb_disconnect = fakeDisconnect;
    var connection = Connection.init(std.testing.allocator, &symbols, 1);
    const sockets = try testSocketPair();
    defer posix_io.close(sockets[1]);
    connection.test_connected_fd = sockets[0];

    const started_ns = clipboard_clock.nowNs();
    try std.testing.expectEqual(Progress.pending, connection.drive());
    try std.testing.expect(clipboard_clock.nowNs() - started_ns < 50 * std.time.ns_per_ms);

    clipboard_clock.sleep(250 * std.time.ns_per_ms);
    try std.testing.expectEqual(Progress.pending, connection.drive());
    connection.deinit();
}

test "X11 shutdown cancels a silent setup connection" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    try clipboard_clock.init();
    var symbols: linux.XcbSymbols = undefined;
    symbols.xcb_connect_to_fd = fakeSilentConnectToFd;
    symbols.xcb_connection_has_error = fakeConnectionHasError;
    symbols.xcb_disconnect = fakeDisconnect;
    var connection = Connection.init(std.testing.allocator, &symbols, 1);
    const sockets = try testSocketPair();
    defer posix_io.close(sockets[1]);
    connection.test_connected_fd = sockets[0];
    fake_setup_started.store(false, .release);
    try std.testing.expectEqual(Progress.pending, connection.drive());
    try expectSetupStarted(&connection, &fake_setup_started);
    connection.requestShutdown();
    connection.requestShutdown();
    try expectShutdownReady(&connection);
    connection.deinit();
    var byte: [1]u8 = undefined;
    try std.testing.expectEqual(@as(usize, 0), try std.posix.read(sockets[1], &byte));
}

test "X11 shutdown immediately after setup completion still joins and closes" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    try clipboard_clock.init();
    var symbols: linux.XcbSymbols = undefined;
    symbols.xcb_connect_to_fd = fakeImmediateConnectToFd;
    symbols.xcb_disconnect = fakeDisconnect;
    var connection = Connection.init(std.testing.allocator, &symbols, 1);
    const sockets = try testSocketPair();
    defer posix_io.close(sockets[1]);
    connection.test_connected_fd = sockets[0];
    fake_slow_connection = .{};
    fake_setup_completed.store(false, .release);

    try std.testing.expectEqual(Progress.pending, connection.drive());
    try expectSetupStarted(&connection, &fake_setup_completed);
    connection.requestShutdown();
    try expectShutdownReady(&connection);
    connection.deinit();
    try std.testing.expect(fake_slow_connection.disconnected);
}

const FakeXcb = struct {
    next_sequence: u32 = 1,
    replies_ready: bool = false,
    error_sequence: u32 = 0,
    flush_count: u32 = 0,
    discard_count: u32 = 0,
    get_owner_count: u32 = 0,
    selection_owner: u32 = 0,
    reject_selection_owner: bool = false,
    event_mask_clear_count: u32 = 0,
    flush_fails: bool = false,
    disconnected: bool = false,
    send_event_count: u32 = 0,
    last_notify_property: u32 = std.math.maxInt(u32),
};

fn expectSetupStarted(connection: *Connection, flag: *std.atomic.Value(bool)) !void {
    const deadline_ns = clipboard_clock.nowNs() + 2 * std.time.ns_per_s;
    while (clipboard_clock.nowNs() < deadline_ns) {
        if (flag.load(.acquire)) return;
        clipboard_clock.sleep(std.time.ns_per_ms);
    }
    connection.requestShutdown();
    try expectShutdownReady(connection);
    connection.deinit();
    return error.TestConnectSetupTimeout;
}

fn expectShutdownReady(connection: *Connection) !void {
    const deadline_ns = clipboard_clock.nowNs() + 2 * std.time.ns_per_s;
    while (clipboard_clock.nowNs() < deadline_ns) {
        if (connection.shutdownReady()) return;
        clipboard_clock.sleep(std.time.ns_per_ms);
    }
    return error.TestConnectShutdownTimeout;
}

test "X11 atom initialization polls one reply per drive without blocking" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    var symbols: linux.XcbSymbols = undefined;
    symbols.xcb_connection_has_error = fakeConnectionHasError;
    symbols.xcb_disconnect = fakeDisconnect;
    symbols.xcb_poll_for_reply = fakePollForReply;
    symbols.xcb_discard_reply = fakeDiscardReply;
    symbols.xcb_flush = fakeFlush;
    symbols.xcb_intern_atom = fakeInternAtom;
    symbols.xcb_get_setup = fakeGetSetup;
    symbols.xcb_setup_roots_iterator = fakeRootsIterator;
    symbols.xcb_screen_next = fakeScreenNext;
    symbols.xcb_generate_id = fakeGenerateId;
    symbols.xcb_create_window = fakeCreateWindow;
    symbols.xcb_destroy_window = fakeDestroyWindow;

    var fake: FakeXcb = .{};
    var connection = Connection.init(std.testing.allocator, &symbols, 2);
    connection.connection = @ptrCast(&fake);
    connection.phase = .atoms;
    connection.output_ready_override = false;
    defer connection.deinit();

    for (0..ATOM_NAMES.len) |_| try std.testing.expectEqual(Progress.pending, connection.drive());
    try std.testing.expectEqual(Progress.pending, connection.drive());
    try std.testing.expectEqual(@as(u32, 0), fake.flush_count);
    connection.output_ready_override = true;
    try std.testing.expectEqual(Progress.pending, connection.drive());
    try std.testing.expectEqual(@as(u32, 1), fake.flush_count);
    try std.testing.expectEqual(Progress.pending, connection.drive());
    try std.testing.expectEqual(@as(u8, 0), connection.reply_index);

    fake.replies_ready = true;
    for (0..ATOM_NAMES.len - 1) |_| try std.testing.expectEqual(Progress.pending, connection.drive());
    try std.testing.expectEqual(Progress.pending, connection.drive());
    try std.testing.expectEqual(Progress.pending, connection.drive());
    try std.testing.expectEqual(Progress.ready, connection.drive());
    const atoms = connection.atoms().?;
    try std.testing.expectEqual(@as(u32, 101), atoms.clipboard);
    try std.testing.expectEqual(@as(u32, 111), atoms.timestamp);
    try std.testing.expectEqual(@as(u32, 0), fake.discard_count);
}

test "X11 atom initialization fails on a polled protocol error and discards remaining replies" {
    if (comptime builtin.os.tag != .linux) return error.SkipZigTest;
    var symbols: linux.XcbSymbols = undefined;
    symbols.xcb_connection_has_error = fakeConnectionHasError;
    symbols.xcb_disconnect = fakeDisconnect;
    symbols.xcb_poll_for_reply = fakePollForReply;
    symbols.xcb_discard_reply = fakeDiscardReply;
    symbols.xcb_flush = fakeFlush;
    symbols.xcb_intern_atom = fakeInternAtom;

    var fake: FakeXcb = .{ .replies_ready = true, .error_sequence = 2 };
    var connection = Connection.init(std.testing.allocator, &symbols, 2);
    connection.connection = @ptrCast(&fake);
    connection.phase = .atoms;
    connection.output_ready_override = true;

    for (0..ATOM_NAMES.len) |_| try std.testing.expectEqual(Progress.pending, connection.drive());
    try std.testing.expectEqual(Progress.pending, connection.drive());
    try std.testing.expectEqual(Progress.pending, connection.drive());
    try std.testing.expectEqual(Progress.failed, connection.drive());
    try std.testing.expectEqual(Failure.atom, connection.failure);
    connection.deinit();
    try std.testing.expectEqual(@as(u32, ATOM_NAMES.len - 2), fake.discard_count);
    try std.testing.expect(fake.disconnected);
}

fn fakeConnectionHasError(_: *linux.XcbConnection) callconv(.c) c_int {
    return 0;
}

fn fakeSlowConnectToFd(fd: c_int, _: ?*linux.XcbAuthInfo) callconv(.c) ?*linux.XcbConnection {
    clipboard_clock.sleep(200 * std.time.ns_per_ms);
    posix_io.close(fd);
    return @ptrCast(&fake_slow_connection);
}

fn fakeSilentConnectToFd(fd: c_int, _: ?*linux.XcbAuthInfo) callconv(.c) ?*linux.XcbConnection {
    fake_setup_started.store(true, .release);
    var byte: [1]u8 = undefined;
    _ = std.posix.read(fd, &byte) catch {};
    posix_io.close(fd);
    return null;
}

var fake_setup_started: std.atomic.Value(bool) = .init(false);
var fake_setup_completed: std.atomic.Value(bool) = .init(false);

fn fakeImmediateConnectToFd(fd: c_int, _: ?*linux.XcbAuthInfo) callconv(.c) ?*linux.XcbConnection {
    posix_io.close(fd);
    fake_setup_completed.store(true, .release);
    return @ptrCast(&fake_slow_connection);
}

fn testSocketPair() ![2]std.posix.fd_t {
    var sockets: [2]std.posix.fd_t = undefined;
    if (std.c.socketpair(std.posix.AF.UNIX, std.posix.SOCK.STREAM | std.posix.SOCK.CLOEXEC, 0, &sockets) != 0) {
        return error.SocketPairFailed;
    }
    return sockets;
}

const TestDisplayListener = struct {
    fd: std.posix.fd_t,
    endpoint: DisplayEndpoint,
};

fn testDisplayListener(kind: DisplayKind, candidate_index: u8) !TestDisplayListener {
    std.debug.assert(kind == .unix or kind == .tcp4 or kind == .tcp6);
    std.debug.assert(candidate_index < 2);
    const seed: u16 = @truncate(@as(u128, @bitCast(clipboard_clock.nowNs())));
    var attempt: u16 = 0;
    while (attempt < 128) : (attempt += 1) {
        const display: u16 = if (kind == .unix)
            seed +% attempt
        else
            (seed +% attempt) % 59536;
        const endpoint = if (kind == .unix)
            try parseDisplayNumberEndpoint(display)
        else
            DisplayEndpoint{ .kind = .tcp6, .display = display, .screen = 0, .tcp4_fallback = true };
        const candidate = try displayAddress(endpoint, candidate_index);
        std.debug.assert(candidate.kind == kind);
        const fd = try posix_io.socket(
            candidate.address.any.family,
            std.posix.SOCK.STREAM | std.posix.SOCK.CLOEXEC,
            0,
        );
        posix_io.bind(fd, &candidate.address.any, candidate.length) catch |err| {
            posix_io.close(fd);
            if (err == error.AddressInUse or err == error.AccessDenied) continue;
            return err;
        };
        errdefer posix_io.close(fd);
        try posix_io.listen(fd, 1);
        return .{ .fd = fd, .endpoint = endpoint };
    }
    return error.NoTestDisplayAddress;
}

fn parseDisplayNumberEndpoint(display: u16) !DisplayEndpoint {
    var path_buffer: [108]u8 = undefined;
    const path = try std.fmt.bufPrint(&path_buffer, "/tmp/.X11-unix/X{d}", .{display});
    var endpoint = try unixEndpoint(display, 0, path);
    endpoint.unix_abstract_first = true;
    return endpoint;
}

extern fn mkfifo(path: [*:0]const u8, mode: std.posix.mode_t) c_int;

fn appendTestXauthorityRecord(
    bytes: *std.ArrayListUnmanaged(u8),
    family: u16,
    address: []const u8,
    number: []const u8,
    name: []const u8,
    data: []const u8,
) !void {
    var family_bytes: [2]u8 = undefined;
    std.mem.writeInt(u16, &family_bytes, family, .big);
    try bytes.appendSlice(std.testing.allocator, &family_bytes);
    try appendTestXauthorityField(bytes, address);
    try appendTestXauthorityField(bytes, number);
    try appendTestXauthorityField(bytes, name);
    try appendTestXauthorityField(bytes, data);
}

fn appendTestXauthorityField(bytes: *std.ArrayListUnmanaged(u8), field: []const u8) !void {
    var length_bytes: [2]u8 = undefined;
    std.mem.writeInt(u16, &length_bytes, @intCast(field.len), .big);
    try bytes.appendSlice(std.testing.allocator, &length_bytes);
    try bytes.appendSlice(std.testing.allocator, field);
}

var fake_slow_connection: FakeXcb = .{};

fn fakeDisconnect(connection: *linux.XcbConnection) callconv(.c) void {
    const fake: *FakeXcb = @ptrCast(@alignCast(connection));
    fake.disconnected = true;
}

fn fakeInternAtom(
    connection: *linux.XcbConnection,
    _: u8,
    _: u16,
    _: [*]const u8,
) callconv(.c) linux.XcbCookie {
    const fake: *FakeXcb = @ptrCast(@alignCast(connection));
    const sequence = fake.next_sequence;
    fake.next_sequence += 1;
    return .{ .sequence = sequence };
}

fn fakeFlush(connection: *linux.XcbConnection) callconv(.c) c_int {
    const fake: *FakeXcb = @ptrCast(@alignCast(connection));
    fake.flush_count += 1;
    return if (fake.flush_fails) 0 else 1;
}

fn fakeSetSelectionOwner(
    connection: *linux.XcbConnection,
    owner: u32,
    _: u32,
    _: u32,
) callconv(.c) linux.XcbCookie {
    const fake: *FakeXcb = @ptrCast(@alignCast(connection));
    if (!fake.reject_selection_owner) fake.selection_owner = owner;
    const sequence = fake.next_sequence;
    fake.next_sequence += 1;
    return .{ .sequence = sequence };
}

fn fakeGetSelectionOwner(connection: *linux.XcbConnection, _: u32) callconv(.c) linux.XcbCookie {
    const fake: *FakeXcb = @ptrCast(@alignCast(connection));
    fake.get_owner_count += 1;
    const sequence = fake.next_sequence;
    fake.next_sequence += 1;
    return .{ .sequence = sequence };
}

fn fakeGetProperty(
    _: *linux.XcbConnection,
    _: u8,
    _: u32,
    _: u32,
    _: u32,
    _: u32,
    _: u32,
) callconv(.c) linux.XcbCookie {
    return .{ .sequence = 1 };
}

fn fakePollSelectionOwnerReply(
    connection: *linux.XcbConnection,
    _: u32,
    reply_pointer: *?*anyopaque,
    _: *?*linux.XcbGenericError,
) callconv(.c) c_int {
    const fake: *FakeXcb = @ptrCast(@alignCast(connection));
    if (!fake.replies_ready) return 0;
    const reply_memory = std.c.malloc(@sizeOf(linux.XcbGetSelectionOwnerReply)) orelse unreachable;
    const reply: *linux.XcbGetSelectionOwnerReply = @ptrCast(@alignCast(reply_memory));
    reply.* = .{
        .response_type = 1,
        .pad0 = 0,
        .sequence = 0,
        .length = 0,
        .owner = fake.selection_owner,
        .pad1 = .{0} ** 20,
    };
    reply_pointer.* = reply;
    return 1;
}

fn fakeChangeWindowAttributes(
    connection: *linux.XcbConnection,
    _: u32,
    _: u32,
    values: ?*const anyopaque,
) callconv(.c) linux.XcbCookie {
    const fake: *FakeXcb = @ptrCast(@alignCast(connection));
    const event_mask: *const u32 = @ptrCast(@alignCast(values.?));
    if (event_mask.* == 0) fake.event_mask_clear_count += 1;
    return .{ .sequence = fake.next_sequence };
}

fn fakePendingReply(
    _: *linux.XcbConnection,
    _: u32,
    _: *?*anyopaque,
    _: *?*linux.XcbGenericError,
) callconv(.c) c_int {
    return 0;
}

fn fakeRequestCheck(_: *linux.XcbConnection, _: linux.XcbCookie) callconv(.c) ?*linux.XcbGenericError {
    return null;
}

fn fakeSendEvent(
    connection: *linux.XcbConnection,
    _: u8,
    _: u32,
    _: u32,
    event: [*]const u8,
) callconv(.c) linux.XcbCookie {
    const fake: *FakeXcb = @ptrCast(@alignCast(connection));
    const notify = std.mem.bytesToValue(
        linux.XcbSelectionNotifyEvent,
        event[0..@sizeOf(linux.XcbSelectionNotifyEvent)],
    );
    fake.send_event_count += 1;
    fake.last_notify_property = notify.property;
    return .{ .sequence = fake.next_sequence };
}

fn fakePollForReply(
    connection: *linux.XcbConnection,
    sequence: u32,
    reply_pointer: *?*anyopaque,
    error_pointer: *?*linux.XcbGenericError,
) callconv(.c) c_int {
    const fake: *FakeXcb = @ptrCast(@alignCast(connection));
    if (!fake.replies_ready) return 0;
    if (fake.error_sequence == sequence) {
        const error_memory = std.c.malloc(@sizeOf(linux.XcbGenericError)) orelse unreachable;
        error_pointer.* = @ptrCast(@alignCast(error_memory));
        return 1;
    }
    const reply_memory = std.c.malloc(@sizeOf(linux.XcbInternAtomReply)) orelse unreachable;
    const reply: *linux.XcbInternAtomReply = @ptrCast(@alignCast(reply_memory));
    reply.* = .{
        .response_type = 1,
        .pad0 = 0,
        .sequence = @truncate(sequence),
        .length = 0,
        .atom = 100 + sequence,
    };
    reply_pointer.* = reply;
    return 1;
}

fn fakeDiscardReply(connection: *linux.XcbConnection, _: u32) callconv(.c) void {
    const fake: *FakeXcb = @ptrCast(@alignCast(connection));
    fake.discard_count += 1;
}

var fake_setup: linux.XcbSetup = .{
    .status = 1,
    .pad0 = 0,
    .protocol_major_version = 11,
    .protocol_minor_version = 0,
    .length = 0,
    .release_number = 0,
    .resource_id_base = 0,
    .resource_id_mask = 0,
    .motion_buffer_size = 0,
    .vendor_length = 0,
    .maximum_request_length = 65535,
    .roots_length = 1,
    .pixmap_formats_length = 0,
    .image_byte_order = 0,
    .bitmap_format_bit_order = 0,
    .bitmap_format_scanline_unit = 0,
    .bitmap_format_scanline_pad = 0,
    .min_keycode = 0,
    .max_keycode = 0,
    .pad1 = .{0} ** 4,
};
var fake_screen: linux.XcbScreen = .{
    .root = 1,
    .default_colormap = 0,
    .white_pixel = 0,
    .black_pixel = 0,
    .current_input_masks = 0,
    .width_in_pixels = 1,
    .height_in_pixels = 1,
    .width_in_millimeters = 1,
    .height_in_millimeters = 1,
    .min_installed_maps = 0,
    .max_installed_maps = 0,
    .root_visual = 0,
    .backing_stores = 0,
    .save_unders = 0,
    .root_depth = 0,
    .allowed_depths_length = 0,
};

fn fakeGetSetup(_: *linux.XcbConnection) callconv(.c) *const linux.XcbSetup {
    return &fake_setup;
}

fn fakeRootsIterator(_: *const linux.XcbSetup) callconv(.c) linux.XcbScreenIterator {
    return .{ .data = &fake_screen, .remaining = 1, .index = 0 };
}

fn fakeScreenNext(iterator: *linux.XcbScreenIterator) callconv(.c) void {
    iterator.remaining = 0;
}

fn fakeGenerateId(_: *linux.XcbConnection) callconv(.c) u32 {
    return 2;
}

fn fakeCreateWindow(
    _: *linux.XcbConnection,
    _: u8,
    _: u32,
    _: u32,
    _: i16,
    _: i16,
    _: u16,
    _: u16,
    _: u16,
    _: u16,
    _: u32,
    _: u32,
    _: ?*const anyopaque,
) callconv(.c) linux.XcbCookie {
    return .{ .sequence = 1 };
}

fn fakeDestroyWindow(_: *linux.XcbConnection, _: u32) callconv(.c) linux.XcbCookie {
    return .{ .sequence = 1 };
}

fn fakeDeleteProperty(_: *linux.XcbConnection, _: u32, _: u32) callconv(.c) linux.XcbCookie {
    return .{ .sequence = 1 };
}
