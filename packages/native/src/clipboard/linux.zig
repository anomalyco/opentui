const std = @import("std");
const sync = @import("sync.zig");
const posix_io = @import("posix-io.zig");

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

const LibraryKind = enum { wayland, x11 };
pub const WaylandSymbols = struct {
    wl_display_connect: *const fn (?[*:0]const u8) callconv(.c) ?*WlDisplay,
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
    wl_proxy_marshal_array_flags: *const fn (*WlProxy, u32, ?*const WlInterface, u32, u32, [*]WlArgument) callconv(.c) ?*WlProxy,
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
    var libraries: Libraries = .{ .is_wsl = env.is_wsl };
    if (env.has_wayland_display) libraries.wayland = loader.load(.wayland);
    if (env.has_x11_display) libraries.x11 = loader.load(.x11);
    return libraries;
}

const ProductionLoader = struct {
    fn load(_: ProductionLoader, kind: LibraryKind) bool {
        cache_mutex.lock();
        defer cache_mutex.unlock();

        return switch (kind) {
            .wayland => loadCachedLibrary(WaylandSymbols, &wayland_cache, "libwayland-client.so.0"),
            .x11 => loadCachedLibrary(XcbSymbols, &xcb_cache, "libxcb.so.1"),
        };
    }
};

fn loadCachedLibrary(
    comptime Symbols: type,
    cache: *CachedLibrary(Symbols),
    name: []const u8,
) bool {
    if (cache.symbols != null) return true;

    var library = std.DynLib.open(name) catch return false;
    const symbols = loadSymbols(Symbols, &library) orelse {
        library.close();
        return false;
    };
    cache.library = library;
    cache.symbols = symbols;
    return true;
}

fn loadSymbols(comptime Symbols: type, library: *std.DynLib) ?Symbols {
    var symbols: Symbols = undefined;
    inline for (@typeInfo(Symbols).@"struct".fields) |field| {
        switch (@typeInfo(field.type)) {
            // Optional fields name symbols missing from older library versions.
            .optional => |optional| @field(symbols, field.name) = library.lookup(optional.child, field.name),
            else => @field(symbols, field.name) = library.lookup(field.type, field.name) orelse return null,
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
    return std.ascii.indexOfIgnoreCase(release, "microsoft") != null or
        std.ascii.indexOfIgnoreCase(release, "wsl") != null;
}

const FakeLoader = struct {
    wayland_available: bool = false,
    x11_available: bool = false,
    wayland_attempts: u32 = 0,
    x11_attempts: u32 = 0,

    fn load(self: *FakeLoader, kind: LibraryKind) bool {
        return switch (kind) {
            .wayland => blk: {
                self.wayland_attempts += 1;
                break :blk self.wayland_available;
            },
            .x11 => blk: {
                self.x11_attempts += 1;
                break :blk self.x11_available;
            },
        };
    }
};

fn expectLibraries(libraries: Libraries, wayland: bool, x11: bool) !void {
    try std.testing.expectEqual(wayland, libraries.wayland);
    try std.testing.expectEqual(x11, libraries.x11);
}

test "clipboard linux routing loads only applicable and available libraries" {
    const TestCase = struct {
        environment: Environment,
        available: Libraries,
        expected: Libraries,
        attempts: [2]u32,
    };
    const cases = [_]TestCase{
        .{ .environment = .{ .is_wsl = true, .has_wayland_display = false, .has_x11_display = false }, .available = .{ .wayland = true, .x11 = true }, .expected = .{ .is_wsl = true }, .attempts = .{ 0, 0 } },
        .{ .environment = .{ .is_wsl = false, .has_wayland_display = true, .has_x11_display = false }, .available = .{ .wayland = true }, .expected = .{ .wayland = true }, .attempts = .{ 1, 0 } },
        .{ .environment = .{ .is_wsl = false, .has_wayland_display = false, .has_x11_display = true }, .available = .{ .x11 = true }, .expected = .{ .x11 = true }, .attempts = .{ 0, 1 } },
        .{ .environment = .{ .is_wsl = true, .has_wayland_display = true, .has_x11_display = true }, .available = .{ .wayland = true, .x11 = true }, .expected = .{ .wayland = true, .x11 = true, .is_wsl = true }, .attempts = .{ 1, 1 } },
        .{ .environment = .{ .is_wsl = false, .has_wayland_display = true, .has_x11_display = true }, .available = .{ .x11 = true }, .expected = .{ .x11 = true }, .attempts = .{ 1, 1 } },
        .{ .environment = .{ .is_wsl = false, .has_wayland_display = true, .has_x11_display = true }, .available = .{ .wayland = true }, .expected = .{ .wayland = true }, .attempts = .{ 1, 1 } },
    };
    for (cases) |case| {
        var loader: FakeLoader = .{
            .wayland_available = case.available.wayland,
            .x11_available = case.available.x11,
        };
        const libraries = selectLibraries(case.environment, &loader);
        try expectLibraries(libraries, case.expected.wayland, case.expected.x11);
        try std.testing.expectEqual(case.expected.is_wsl, libraries.is_wsl);
        try std.testing.expectEqual(case.attempts[0], loader.wayland_attempts);
        try std.testing.expectEqual(case.attempts[1], loader.x11_attempts);
    }
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
