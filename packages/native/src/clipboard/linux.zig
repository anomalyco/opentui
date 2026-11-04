const std = @import("std");
const sync = @import("sync.zig");
const posix_io = @import("posix-io.zig");
const logger = @import("../logger.zig");

pub const Environment = struct {
    is_wsl: bool,
    has_wayland_display: bool,
    has_x11_display: bool,

    pub fn fromMap(env: *const std.process.Environ.Map) Environment {
        return .{
            .is_wsl = env.get("WSL_DISTRO_NAME") != null or env.get("WSL_INTEROP") != null,
            .has_wayland_display = hasNonEmptyValue(env, "WAYLAND_DISPLAY") or hasNonEmptyValue(env, "WAYLAND_SOCKET"),
            .has_x11_display = hasNonEmptyValue(env, "DISPLAY"),
        };
    }

    pub fn detect(env: *const std.process.Environ.Map) Environment {
        var result = fromMap(env);
        if (!result.is_wsl) {
            const uts = std.posix.uname();
            result.is_wsl = isWslKernelRelease(std.mem.sliceTo(&uts.release, 0));
        }
        return result;
    }

    pub fn detectProcess() Environment {
        var result: Environment = .{
            .is_wsl = posix_io.getEnv("WSL_DISTRO_NAME") != null or posix_io.getEnv("WSL_INTEROP") != null,
            .has_wayland_display = hasNonEmptyProcessValue("WAYLAND_DISPLAY") or hasNonEmptyProcessValue("WAYLAND_SOCKET"),
            .has_x11_display = hasNonEmptyProcessValue("DISPLAY"),
        };
        if (!result.is_wsl) {
            const uts = std.posix.uname();
            result.is_wsl = isWslKernelRelease(std.mem.sliceTo(&uts.release, 0));
        }
        return result;
    }
};

pub const Libraries = struct {
    wayland: bool = false,
    x11: bool = false,
    is_wsl: bool = false,
};

pub const Mechanism = enum { wayland, x11 };

pub const WlDisplay = opaque {};
pub const WlProxy = opaque {};
pub const WlInterface = extern struct {
    name: [*:0]const u8,
    version: c_int,
    method_count: c_int,
    methods: ?[*]const WlMessage,
    event_count: c_int,
    events: ?[*]const WlMessage,
};
pub const WlMessage = extern struct {
    name: [*:0]const u8,
    signature: [*:0]const u8,
    types: ?[*]const ?*const WlInterface,
};
pub const WlArgument = extern union {
    i: i32,
    u: u32,
    f: i32,
    s: ?[*:0]const u8,
    o: ?*WlProxy,
    n: u32,
    a: ?*anyopaque,
    h: i32,
};

pub const XcbConnection = opaque {};
pub const XcbAuthInfo = extern struct {
    name_length: c_int,
    name: [*]u8,
    data_length: c_int,
    data: [*]u8,
};
pub const XcbGenericEvent = extern struct {
    response_type: u8,
    pad0: u8,
    sequence: u16,
    pad: [7]u32,
    full_sequence: u32,
};
pub const XcbGenericError = extern struct {
    response_type: u8,
    error_code: u8,
    sequence: u16,
    resource_id: u32,
    minor_code: u16,
    major_code: u8,
    pad0: u8,
    pad: [5]u32,
    full_sequence: u32,
};
pub const XcbCookie = extern struct { sequence: u32 };
pub const XcbInternAtomReply = extern struct {
    response_type: u8,
    pad0: u8,
    sequence: u16,
    length: u32,
    atom: u32,
};
pub const XcbGetSelectionOwnerReply = extern struct {
    response_type: u8,
    pad0: u8,
    sequence: u16,
    length: u32,
    owner: u32,
    pad1: [20]u8,
};
pub const XcbGetPropertyReply = extern struct {
    response_type: u8,
    format: u8,
    sequence: u16,
    length: u32,
    atom_type: u32,
    bytes_after: u32,
    value_length: u32,
    pad0: [12]u8,
};
pub const XcbSetup = extern struct {
    status: u8,
    pad0: u8,
    protocol_major_version: u16,
    protocol_minor_version: u16,
    length: u16,
    release_number: u32,
    resource_id_base: u32,
    resource_id_mask: u32,
    motion_buffer_size: u32,
    vendor_length: u16,
    maximum_request_length: u16,
    roots_length: u8,
    pixmap_formats_length: u8,
    image_byte_order: u8,
    bitmap_format_bit_order: u8,
    bitmap_format_scanline_unit: u8,
    bitmap_format_scanline_pad: u8,
    min_keycode: u8,
    max_keycode: u8,
    pad1: [4]u8,
};
pub const XcbScreen = extern struct {
    root: u32,
    default_colormap: u32,
    white_pixel: u32,
    black_pixel: u32,
    current_input_masks: u32,
    width_in_pixels: u16,
    height_in_pixels: u16,
    width_in_millimeters: u16,
    height_in_millimeters: u16,
    min_installed_maps: u16,
    max_installed_maps: u16,
    root_visual: u32,
    backing_stores: u8,
    save_unders: u8,
    root_depth: u8,
    allowed_depths_length: u8,
};
pub const XcbScreenIterator = extern struct {
    data: *XcbScreen,
    remaining: c_int,
    index: c_int,
};
pub const XcbPropertyNotifyEvent = extern struct {
    response_type: u8,
    pad0: u8,
    sequence: u16,
    window: u32,
    atom: u32,
    time: u32,
    state: u8,
    pad1: [3]u8,
};
pub const XcbSelectionClearEvent = extern struct {
    response_type: u8,
    pad0: u8,
    sequence: u16,
    time: u32,
    owner: u32,
    selection: u32,
};
pub const XcbSelectionRequestEvent = extern struct {
    response_type: u8,
    pad0: u8,
    sequence: u16,
    time: u32,
    owner: u32,
    requestor: u32,
    selection: u32,
    target: u32,
    property: u32,
};
pub const XcbSelectionNotifyEvent = extern struct {
    response_type: u8,
    pad0: u8,
    sequence: u16,
    time: u32,
    requestor: u32,
    selection: u32,
    target: u32,
    property: u32,
};

pub const WaylandSymbols = struct {
    wl_display_connect: *const fn (?[*:0]const u8) callconv(.c) ?*WlDisplay,
    wl_display_connect_to_fd: *const fn (c_int) callconv(.c) ?*WlDisplay,
    wl_display_disconnect: *const fn (*WlDisplay) callconv(.c) void,
    wl_display_get_fd: *const fn (*WlDisplay) callconv(.c) c_int,
    wl_display_dispatch_pending: *const fn (*WlDisplay) callconv(.c) c_int,
    // Single-event dispatch needs libwayland 1.25 (Ubuntu 26.04 ships 1.24). When it is
    // missing, wayland.zig bulk-dispatches a queue bounded by the connection buffer cap.
    wl_display_dispatch_pending_single: ?*const fn (*WlDisplay) callconv(.c) c_int,
    wl_display_get_error: *const fn (*WlDisplay) callconv(.c) c_int,
    // The buffer cap needs libwayland 1.23 (Ubuntu 24.04 ships 1.22). Older clients use
    // fixed-size connection buffers, so a missing cap still bounds the receive queue.
    wl_display_set_max_buffer_size: ?*const fn (*WlDisplay, usize) callconv(.c) void,
    wl_display_flush: *const fn (*WlDisplay) callconv(.c) c_int,
    wl_display_prepare_read: *const fn (*WlDisplay) callconv(.c) c_int,
    wl_display_read_events: *const fn (*WlDisplay) callconv(.c) c_int,
    wl_display_cancel_read: *const fn (*WlDisplay) callconv(.c) void,
    // Exported since libwayland 1.10; 1.20 added the flags variant, which Ubuntu 20.04 lacks.
    wl_proxy_marshal_array_constructor_versioned: *const fn (*WlProxy, u32, [*]WlArgument, ?*const WlInterface, u32) callconv(.c) ?*WlProxy,
    wl_proxy_add_listener: *const fn (*WlProxy, [*]const *const anyopaque, ?*anyopaque) callconv(.c) c_int,
    wl_proxy_destroy: *const fn (*WlProxy) callconv(.c) void,
    wl_proxy_get_version: *const fn (*WlProxy) callconv(.c) u32,
    wl_registry_interface: *const WlInterface,
    wl_callback_interface: *const WlInterface,
    wl_seat_interface: *const WlInterface,
    wl_compositor_interface: *const WlInterface,
    wl_surface_interface: *const WlInterface,
    wl_shm_interface: *const WlInterface,
    wl_shm_pool_interface: *const WlInterface,
    wl_buffer_interface: *const WlInterface,
    wl_shell_interface: *const WlInterface,
    wl_shell_surface_interface: *const WlInterface,
    wl_keyboard_interface: *const WlInterface,
    wl_data_device_manager_interface: *const WlInterface,
    wl_data_device_interface: *const WlInterface,
};

pub const XcbSymbols = struct {
    xcb_connect_to_fd: *const fn (c_int, ?*XcbAuthInfo) callconv(.c) ?*XcbConnection,
    xcb_connection_has_error: *const fn (*XcbConnection) callconv(.c) c_int,
    xcb_disconnect: *const fn (*XcbConnection) callconv(.c) void,
    xcb_get_file_descriptor: *const fn (*XcbConnection) callconv(.c) c_int,
    xcb_get_setup: *const fn (*XcbConnection) callconv(.c) *const XcbSetup,
    xcb_setup_roots_iterator: *const fn (*const XcbSetup) callconv(.c) XcbScreenIterator,
    xcb_screen_next: *const fn (*XcbScreenIterator) callconv(.c) void,
    xcb_poll_for_event: *const fn (*XcbConnection) callconv(.c) ?*XcbGenericEvent,
    xcb_poll_for_reply: *const fn (*XcbConnection, u32, *?*anyopaque, *?*XcbGenericError) callconv(.c) c_int,
    xcb_discard_reply: *const fn (*XcbConnection, u32) callconv(.c) void,
    xcb_request_check: *const fn (*XcbConnection, XcbCookie) callconv(.c) ?*XcbGenericError,
    xcb_flush: *const fn (*XcbConnection) callconv(.c) c_int,
    xcb_generate_id: *const fn (*XcbConnection) callconv(.c) u32,
    xcb_create_window: *const fn (*XcbConnection, u8, u32, u32, i16, i16, u16, u16, u16, u16, u32, u32, ?*const anyopaque) callconv(.c) XcbCookie,
    xcb_change_window_attributes: *const fn (*XcbConnection, u32, u32, ?*const anyopaque) callconv(.c) XcbCookie,
    xcb_destroy_window: *const fn (*XcbConnection, u32) callconv(.c) XcbCookie,
    xcb_intern_atom: *const fn (*XcbConnection, u8, u16, [*]const u8) callconv(.c) XcbCookie,
    xcb_get_property: *const fn (*XcbConnection, u8, u32, u32, u32, u32, u32) callconv(.c) XcbCookie,
    xcb_change_property: *const fn (*XcbConnection, u8, u32, u32, u32, u8, u32, ?*const anyopaque) callconv(.c) XcbCookie,
    xcb_change_property_checked: *const fn (*XcbConnection, u8, u32, u32, u32, u8, u32, ?*const anyopaque) callconv(.c) XcbCookie,
    xcb_delete_property: *const fn (*XcbConnection, u32, u32) callconv(.c) XcbCookie,
    xcb_convert_selection: *const fn (*XcbConnection, u32, u32, u32, u32, u32) callconv(.c) XcbCookie,
    xcb_set_selection_owner: *const fn (*XcbConnection, u32, u32, u32) callconv(.c) XcbCookie,
    xcb_get_selection_owner: *const fn (*XcbConnection, u32) callconv(.c) XcbCookie,
    xcb_send_event: *const fn (*XcbConnection, u8, u32, u32, [*]const u8) callconv(.c) XcbCookie,
};

fn CachedLibrary(comptime Symbols: type) type {
    return struct {
        library: ?std.DynLib = null,
        symbols: ?Symbols = null,
    };
}

var cache_mutex: sync.Mutex = .{};
var wayland_cache: CachedLibrary(WaylandSymbols) = .{};
var xcb_cache: CachedLibrary(XcbSymbols) = .{};

pub fn initialize(env: Environment) Libraries {
    return selectLibraries(env, ProductionLoader{});
}

/// Why a backend is unavailable. Services and connections retry, so the process says each once.
pub const Report = enum(u3) { wayland_library, x11_library, wayland_connect, wayland_protocol, x11_connect };
// The last failure of each backend, recorded where it happens and cleared on a new attempt. A
// library failure and a connection failure of one backend exclude each other, so one slot holds it.
const Cause = struct { report: Report = .wayland_library, length: u16 = 0, text: [1024]u8 = undefined };
var causes_mutex: sync.Mutex = .{};
var causes: std.EnumArray(Mechanism, Cause) = .initFill(.{});
var reports_sent: std.atomic.Value(u8) = .init(0);

/// Bounds environment text so a line fits the logger's 4096-byte buffer.
pub fn bounded(text: []const u8) []const u8 {
    return text[0..@min(text.len, 256)];
}

pub fn clearCause(kind: Mechanism) void {
    causes_mutex.lock();
    defer causes_mutex.unlock();
    causes.getPtr(kind).length = 0;
}

pub fn recordCause(kind: Mechanism, report: Report, comptime format: []const u8, args: anytype) void {
    causes_mutex.lock();
    defer causes_mutex.unlock();
    const cause = causes.getPtr(kind);
    var writer: std.Io.Writer = .fixed(&cause.text);
    writer.print(format, args) catch {};
    cause.report = report;
    cause.length = @intCast(writer.end);
}

/// Reports the recorded causes. The host calls it only when no backend serves an operation, so a
/// desktop where some backend works stays silent. A cause counts as sent only when this thread's
/// line reaches the process callback, which leaves a Worker's cause to a thread that can deliver it.
pub fn reportUnavailable() void {
    if (!logger.processLogReady()) return;
    for ([_]Mechanism{ .wayland, .x11 }) |kind| {
        causes_mutex.lock();
        const cause = causes.get(kind);
        causes_mutex.unlock();
        if (cause.length == 0) continue;
        const bit = @as(u8, 1) << @backingInt(cause.report);
        if (reports_sent.fetchOr(bit, .monotonic) & bit != 0) continue;
        logger.warn("Clipboard: {s}", .{cause.text[0..cause.length]});
    }
}

pub fn waylandSymbols() ?*const WaylandSymbols {
    cache_mutex.lock();
    defer cache_mutex.unlock();
    if (wayland_cache.symbols) |*symbols| return symbols;
    return null;
}

pub fn xcbSymbols() ?*const XcbSymbols {
    cache_mutex.lock();
    defer cache_mutex.unlock();
    if (xcb_cache.symbols) |*symbols| return symbols;
    return null;
}

fn selectLibraries(env: Environment, loader: anytype) Libraries {
    if (!env.has_wayland_display) clearCause(.wayland);
    if (!env.has_x11_display) clearCause(.x11);
    return .{
        .wayland = env.has_wayland_display and loader.load(.wayland),
        .x11 = env.has_x11_display and loader.load(.x11),
        .is_wsl = env.is_wsl,
    };
}

// Called while the loader's message is valid: until this thread's next dl* call.
fn recordLoad(kind: Mechanism, missing_symbol: bool, detail: []const u8) bool {
    const name = if (kind == .wayland) "libwayland-client.so.0" else "libxcb.so.1";
    const report: Report = if (kind == .wayland) .wayland_library else .x11_library;
    if (missing_symbol) {
        recordCause(kind, report, "{s} has no symbol {s}", .{ name, detail });
    } else {
        recordCause(kind, report, "cannot load {s}: {s}", .{ name, detail });
    }
    return false;
}

const ProductionLoader = struct {
    fn load(_: ProductionLoader, kind: Mechanism) bool {
        cache_mutex.lock();
        defer cache_mutex.unlock();
        return switch (kind) {
            .wayland => loadCachedLibrary(WaylandSymbols, &wayland_cache, .wayland),
            .x11 => loadCachedLibrary(XcbSymbols, &xcb_cache, .x11),
        };
    }
};

fn loadCachedLibrary(comptime Symbols: type, cache: *CachedLibrary(Symbols), kind: Mechanism) bool {
    if (cache.symbols != null) return true;
    const name = if (kind == .wayland) "libwayland-client.so.0" else "libxcb.so.1";
    var library = std.DynLib.open(name) catch {
        return recordLoad(kind, false, std.mem.span(std.c.dlerror() orelse "no loader message"));
    };
    const symbols = loadSymbols(Symbols, &library, kind) orelse {
        library.close();
        return false;
    };
    cache.library = library;
    cache.symbols = symbols;
    return true;
}

fn loadSymbols(comptime Symbols: type, library: *std.DynLib, kind: Mechanism) ?Symbols {
    var symbols: Symbols = undefined;
    const info = @typeInfo(Symbols).@"struct";
    inline for (info.field_names, info.field_types) |name, Field| {
        switch (@typeInfo(Field)) {
            // Optional fields name symbols missing from older library versions.
            .optional => |optional| @field(symbols, name) = library.lookup(optional.child, name),
            else => @field(symbols, name) = library.lookup(Field, name) orelse {
                _ = recordLoad(kind, true, name);
                return null;
            },
        }
    }
    return symbols;
}

fn hasNonEmptyValue(env: *const std.process.Environ.Map, name: []const u8) bool {
    const value = env.get(name) orelse return false;
    return value.len > 0;
}

fn hasNonEmptyProcessValue(name: [*:0]const u8) bool {
    const value = posix_io.getEnv(name) orelse return false;
    return value.len > 0;
}

fn isWslKernelRelease(release: []const u8) bool {
    return std.ascii.findIgnoreCase(release, "microsoft") != null or
        std.ascii.findIgnoreCase(release, "wsl") != null;
}

const FakeLoader = struct {
    const Outcome = union(enum) { loaded, open_failed: []const u8, symbol_missing: []const u8 };
    loads: std.EnumArray(Mechanism, Outcome),
    attempts: std.EnumArray(Mechanism, u32) = .initFill(0),

    fn load(self: *FakeLoader, kind: Mechanism) bool {
        self.attempts.getPtr(kind).* += 1;
        return switch (self.loads.get(kind)) {
            .loaded => true,
            .open_failed => |reason| recordLoad(kind, false, reason),
            .symbol_missing => |symbol| recordLoad(kind, true, symbol),
        };
    }
};

pub fn testCauseReport(kind: Mechanism) ?Report {
    const cause = causes.get(kind);
    return if (cause.length == 0) null else cause.report;
}

// Captures the process log for a test: warn lines as they are, other levels marked.
pub const test_log = struct {
    pub var buffer: [4096]u8 = undefined;
    pub var length: usize = 0;

    pub fn callback(level: u8, message: [*]const u8, message_length: u32) callconv(.c) void {
        var writer: std.Io.Writer = .fixed(buffer[length..]);
        if (level != @backingInt(logger.LogLevel.warn)) writer.print("level {d}: ", .{level}) catch {};
        writer.print("{s}\n", .{message[0..message_length]}) catch {};
        length += writer.end;
    }

    pub fn begin() void {
        length = 0;
        causes = .initFill(.{});
        reports_sent.store(0, .monotonic);
        logger.setLogCallback(callback);
    }

    pub fn end() []const u8 {
        logger.setLogCallback(null);
        return buffer[0..length];
    }
};

test "clipboard linux routing loads only applicable and available libraries" {
    const missing: FakeLoader.Outcome = .{ .open_failed = "missing.so: cannot open shared object file" };
    const TestCase = struct {
        environment: Environment,
        wayland: FakeLoader.Outcome = missing,
        x11: FakeLoader.Outcome = missing,
        expected: Libraries,
        attempts: [2]u32,
        reports: []const u8 = "",
    };
    const cases = [_]TestCase{
        .{ .environment = .{ .is_wsl = true, .has_wayland_display = false, .has_x11_display = false }, .wayland = .loaded, .x11 = .loaded, .expected = .{ .is_wsl = true }, .attempts = .{ 0, 0 } },
        .{ .environment = .{ .is_wsl = false, .has_wayland_display = true, .has_x11_display = false }, .wayland = .loaded, .expected = .{ .wayland = true }, .attempts = .{ 1, 0 } },
        .{ .environment = .{ .is_wsl = false, .has_wayland_display = false, .has_x11_display = true }, .x11 = .loaded, .expected = .{ .x11 = true }, .attempts = .{ 0, 1 } },
        .{ .environment = .{ .is_wsl = true, .has_wayland_display = true, .has_x11_display = true }, .wayland = .loaded, .x11 = .loaded, .expected = .{ .wayland = true, .x11 = true, .is_wsl = true }, .attempts = .{ 1, 1 } },
        .{ .environment = .{ .is_wsl = false, .has_wayland_display = true, .has_x11_display = true }, .x11 = .loaded, .expected = .{ .x11 = true }, .attempts = .{ 1, 1 }, .reports = "Clipboard: cannot load libwayland-client.so.0: missing.so: cannot open shared object file\n" },
        // Hyprland under a Nix wrapper: libxcb is missing but never needed.
        .{ .environment = .{ .is_wsl = false, .has_wayland_display = true, .has_x11_display = true }, .wayland = .loaded, .expected = .{ .wayland = true }, .attempts = .{ 1, 1 }, .reports = "Clipboard: cannot load libxcb.so.1: missing.so: cannot open shared object file\n" },
        .{ .environment = .{ .is_wsl = false, .has_wayland_display = true, .has_x11_display = true }, .wayland = .{ .symbol_missing = "wl_proxy_destroy" }, .expected = .{}, .attempts = .{ 1, 1 }, .reports = "Clipboard: libwayland-client.so.0 has no symbol wl_proxy_destroy\nClipboard: cannot load libxcb.so.1: missing.so: cannot open shared object file\n" },
    };
    for (cases) |case| {
        var loader: FakeLoader = .{ .loads = .init(.{ .wayland = case.wayland, .x11 = case.x11 }) };
        test_log.begin();
        defer _ = test_log.end();
        // A service in an environment without a display leaves no cause for that backend.
        if (!case.environment.has_wayland_display) recordCause(.wayland, .wayland_connect, "stale", .{});
        if (!case.environment.has_x11_display) recordCause(.x11, .x11_connect, "stale", .{});
        const libraries = selectLibraries(case.environment, &loader);
        try std.testing.expectEqual(case.expected, libraries);
        try std.testing.expectEqual(case.attempts[0], loader.attempts.get(.wayland));
        try std.testing.expectEqual(case.attempts[1], loader.attempts.get(.x11));
        const wayland_failed = case.environment.has_wayland_display and !libraries.wayland;
        try std.testing.expectEqual(if (wayland_failed) Report.wayland_library else null, testCauseReport(.wayland));
        try std.testing.expectEqual(if (case.environment.has_x11_display and !libraries.x11) Report.x11_library else null, testCauseReport(.x11));
        _ = selectLibraries(case.environment, &loader);
        try std.testing.expectEqualStrings("", test_log.buffer[0..test_log.length]);
        reportUnavailable();
        reportUnavailable();
        try std.testing.expectEqualStrings(case.reports, test_log.end());
    }
}

test "clipboard reports count as sent only once a thread can deliver them" {
    const Worker = struct {
        fn report() void {
            reportUnavailable();
        }
    };
    test_log.begin();
    defer _ = test_log.end();
    recordCause(.x11, .x11_connect, "delivered", .{});
    const thread = try std.Thread.spawn(.{}, Worker.report, .{});
    thread.join();
    logger.setLogCallback(null);
    reportUnavailable();
    logger.setLogCallback(test_log.callback);
    reportUnavailable();
    reportUnavailable();
    try std.testing.expectEqualStrings("Clipboard: delivered\n", test_log.end());
}

test "clipboard linux environment treats display variables as nonempty and WSL as presence based" {
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put("WAYLAND_DISPLAY", "");
    try env.put("DISPLAY", ":0");
    try env.put("WSL_INTEROP", "");

    const detected = Environment.fromMap(&env);
    try std.testing.expect(detected.is_wsl);
    try std.testing.expect(!detected.has_wayland_display);
    try std.testing.expect(detected.has_x11_display);

    try env.put("WAYLAND_SOCKET", "7");
    try std.testing.expect(Environment.fromMap(&env).has_wayland_display);
}

test "clipboard linux environment recognizes WSL kernel releases without environment markers" {
    try std.testing.expect(isWslKernelRelease("4.4.0-19041-Microsoft"));
    try std.testing.expect(isWslKernelRelease("5.15.153.1-microsoft-standard-WSL2"));
    try std.testing.expect(!isWslKernelRelease("6.12.31-1-lts"));
}

test "clipboard XCB ABI types match the core protocol layouts" {
    try std.testing.expectEqual(@as(usize, 4), @sizeOf(XcbCookie));
    try std.testing.expectEqual(@as(usize, 12), @sizeOf(XcbInternAtomReply));
    try std.testing.expectEqual(@as(usize, 32), @sizeOf(XcbGetSelectionOwnerReply));
    try std.testing.expectEqual(@as(usize, 32), @sizeOf(XcbGetPropertyReply));
    try std.testing.expectEqual(@as(usize, 36), @sizeOf(XcbGenericEvent));
    try std.testing.expectEqual(@as(usize, 36), @sizeOf(XcbGenericError));
    try std.testing.expectEqual(@as(usize, 40), @sizeOf(XcbSetup));
    try std.testing.expectEqual(@as(usize, 40), @sizeOf(XcbScreen));
    try std.testing.expectEqual(@as(usize, 28), @sizeOf(XcbSelectionRequestEvent));
    try std.testing.expectEqual(@as(usize, 24), @sizeOf(XcbSelectionNotifyEvent));
}

// Replaces the loaded libwayland symbols so host tests can create a connection; returns the previous ones.
pub fn testSwapWaylandSymbols(symbols: ?WaylandSymbols) ?WaylandSymbols {
    cache_mutex.lock();
    defer cache_mutex.unlock();
    const previous = wayland_cache.symbols;
    wayland_cache.symbols = symbols;
    return previous;
}
