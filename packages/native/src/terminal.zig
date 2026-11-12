const std = @import("std");
const builtin = @import("builtin");
const atomic = std.atomic;
const assert = std.debug.assert;
const api = @import("context_abi_c");
const ansi = @import("ansi.zig");
const base64Encode = @import("utils.zig").base64Encode;
const utf8 = @import("utf8.zig");

const WidthMethod = utf8.WidthMethod;

/// Terminal capability detection and management
pub const Terminal = @This();

const kitty_queries_max = 4;
/// Kitty keyboard flags that stop raw ESC: disambiguate and report all keys.
const kitty_escape_flags: u8 = api.OT_KITTY_KEYBOARD_DISAMBIGUATE | api.OT_KITTY_KEYBOARD_ALL_KEYS_AS_ESCAPES;

pub const Capabilities = struct {
    kitty_keyboard: bool = false,
    kitty_graphics: bool = false,
    rgb: bool = false,
    ansi256: bool = false,
    unicode: WidthMethod = .unicode,
    sgr_pixels: bool = false,
    color_scheme_updates: bool = false,
    explicit_width: bool = false,
    scaled_text: bool = false,
    sixel: bool = false,
    focus_tracking: bool = false,
    sync: bool = false,
    bracketed_paste: bool = false,
    hyperlinks: bool = false,
    osc52: bool = false,
    notifications: bool = false,
    explicit_cursor_positioning: bool = false,
    remote: bool = false,
    program_status: bool = false,
};

pub const NotificationProtocol = enum {
    none,
    osc9,
    osc777,
    osc99,
};

const NotificationProtocolSource = enum {
    none,
    heuristic,
    xtversion,
    query,
    override,
};

pub const RemoteMode = enum(u8) {
    auto,
    local,
    remote,
};

/// Wraps frames in DEC mode 2026 (synchronized output). Once the startup replies have passed the
/// 2026 query, `auto` leaves it out for a remote endpoint that did not report the mode or whose app
/// runs inside tmux, screen or Zellij on its own host.
pub const SynchronizedOutput = enum(u8) {
    auto,
    always,
    never,
};

pub const ImageProtocol = enum(u8) {
    auto,
    kitty,
    sixel,
    blocks,
};

pub const Multiplexer = enum(u8) {
    none,
    tmux,
    zellij,
    screen,
    unknown,
};

pub const Osc52Support = enum(u8) {
    unknown,
    supported,
    unsupported,
};

const NOTIFICATION_QUERY_ID = "opentui-notifications";
pub const SCREEN_PASSTHROUGH_CHUNK_SIZE = 252;
pub const CLIPBOARD_PAYLOAD_SIZE_MAX = std.math.maxInt(u32);
const OSC52_FRAMING_SIZE = "\x1b]52;c;".len + "\x1b\\".len;
const SCREEN_OSC52_FRAMING_SIZE = "\x1b]52;c;".len + "\x07".len;

pub const MouseLevel = enum {
    none,
    basic, // click only
    drag, // click + drag
    motion, // all motion
    pixels, // pixel coordinates
};

/// Ordinals are opentui.h's OT_CURSOR_STYLE_* values.
pub const CursorStyle = enum {
    block,
    line,
    underline,
    default,

    comptime {
        for (.{ .{ .block, api.OT_CURSOR_STYLE_BLOCK }, .{ .line, api.OT_CURSOR_STYLE_LINE }, .{ .underline, api.OT_CURSOR_STYLE_UNDERLINE }, .{ .default, api.OT_CURSOR_STYLE_DEFAULT } }) |pair|
            if (@backingInt(@as(CursorStyle, pair[0])) != pair[1]) @compileError("CursorStyle differs from opentui.h");
    }
};

pub const MousePointerStyle = enum(u8) {
    auto = 0, // Kitty OSC 22 does not support this name.
    default = 1,
    none = 2, // Kitty OSC 22 does not support this name.
    context_menu = 3, // Kitty OSC 22 does not support this name.
    help = 4,
    pointer = 5,
    progress = 6,
    wait = 7,
    cell = 8,
    crosshair = 9,
    text = 10,
    vertical_text = 11,
    alias = 12,
    copy = 13,
    move = 14,
    no_drop = 15,
    not_allowed = 16,
    grab = 17,
    grabbing = 18,
    all_scroll = 19, // Kitty OSC 22 does not support this name.
    col_resize = 20, // Kitty OSC 22 does not support this name.
    row_resize = 21, // Kitty OSC 22 does not support this name.
    n_resize = 22,
    e_resize = 23,
    s_resize = 24,
    w_resize = 25,
    ne_resize = 26,
    nw_resize = 27,
    se_resize = 28,
    sw_resize = 29,
    ew_resize = 30,
    ns_resize = 31,
    nesw_resize = 32,
    nwse_resize = 33,
    zoom_in = 34,
    zoom_out = 35,

    pub fn toName(self: MousePointerStyle) []const u8 {
        return switch (self) {
            .context_menu => "context-menu",
            .vertical_text => "vertical-text",
            .no_drop => "no-drop",
            .not_allowed => "not-allowed",
            .all_scroll => "all-scroll",
            .col_resize => "col-resize",
            .row_resize => "row-resize",
            .n_resize => "n-resize",
            .e_resize => "e-resize",
            .s_resize => "s-resize",
            .w_resize => "w-resize",
            .ne_resize => "ne-resize",
            .nw_resize => "nw-resize",
            .se_resize => "se-resize",
            .sw_resize => "sw-resize",
            .ew_resize => "ew-resize",
            .ns_resize => "ns-resize",
            .nesw_resize => "nesw-resize",
            .nwse_resize => "nwse-resize",
            .zoom_in => "zoom-in",
            .zoom_out => "zoom-out",
            else => @tagName(self),
        };
    }
};

pub const ClipboardTarget = enum(u8) {
    clipboard = 0, // "c"
    primary = 1, // "p"
    select = 2, // "s"
    secondary = 3, // "q"

    pub fn toChar(self: ClipboardTarget) u8 {
        return switch (self) {
            .clipboard => 'c',
            .primary => 'p',
            .select => 's',
            .secondary => 'q',
        };
    }
};

pub const Options = struct {
    // Kitty keyboard protocol flags (progressive enhancement), opentui.h's OT_KITTY_KEYBOARD_*:
    // See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/#progressive-enhancement
    // Add EVENT_TYPES for key release detection.
    kitty_keyboard_flags: u8 = api.OT_KITTY_KEYBOARD_DISAMBIGUATE | api.OT_KITTY_KEYBOARD_ALTERNATE_KEYS,
    remote_mode: RemoteMode = .local,
    // Optional forwarded environment values. Caller owns the map.
    env_map: ?*const std.process.Environ.Map = null,
};

pub const TerminalInfo = struct {
    name: [64]u8 = @splat(0),
    name_len: usize = 0,
    version: [32]u8 = @splat(0),
    version_len: usize = 0,
    from_xtversion: bool = false,
};

caps: Capabilities = .{},
opts: Options = .{},
host_env_map: ?std.process.Environ.Map = null,
remote: bool = false,
multiplexer: Multiplexer = .none,
osc52_support: Osc52Support = .unknown,
is_foot: bool = false,
skip_graphics_query: bool = false,
graphics_enabled: bool = true,
image_protocol: ImageProtocol = .auto,
kitty_graphics_queried: bool = false,
sixel_queried: bool = false,
skip_explicit_width_query: bool = false,
startup_cursor_query_pending: bool = false,
startup_cursor_query_captured: bool = false,
explicit_width_probe_reports_pending: u8 = 0,
explicit_width_probe_first_column: u16 = 0,
/// Setup probes OSC 66 (an alternate screen of 3+ rows), so the probe's answer, not XTVERSION, decides explicit width.
explicit_width_probed: bool = false,
/// The host ends each query batch with DA1 and waits for its reply (sentinel mode).
reply_sentinel: bool = false,
synchronized_output: SynchronizedOutput = .auto,
/// A reply ordered after the DECRQM 2026 query arrived, so `caps.sync` is final.
sync_reply_settled: bool = false,
/// The host says a multiplexer runs between the app and the link. Never derived from forwarded or
/// client environment, which can describe the other side of the link.
multiplexer_on_host: bool = false,
/// The last DECRPM reply for mode 2027 (grapheme clusters), 0 (unrecognized) to 4 (permanently reset).
mode_2027: ?u8 = null,
host_env_hyperlinks: bool = false,
hyperlinks_override: ?bool = null,

state: struct {
    alt_screen: bool = false,
    kitty_keyboard: bool = false,
    kitty_keyboard_flags: u8 = 0,
    /// Every Kitty keyboard push or pop starts a generation; only a reply to its own query confirms it.
    kitty_generation: u32 = 0,
    /// The terminal reported disambiguate or report-all for the current push.
    kitty_confirmed: bool = false,
    /// Generations of the unanswered `CSI ? u` queries, oldest first. Terminals answer in order, so a
    /// reply answers the oldest; a lost reply only makes later ones answer older generations.
    kitty_queries: [kitty_queries_max]u32 = @splat(0),
    kitty_query_count: u8 = 0,
    bracketed_paste: bool = false,
    mouse: bool = false,
    mouse_movement: bool = true,
    mouse_was_enabled: bool = false,
    pixel_mouse: bool = false,
    color_scheme_updates: bool = false,
    theme_queries_sent: bool = false,
    focus_tracking: bool = false,
    modify_other_keys: bool = false,
    unicode: bool = false,
    mouse_pointer: MousePointerStyle = .default,
    cursor: struct {
        row: u16 = 0,
        col: u16 = 0,
        x: u32 = 1, // 1-based for rendering
        y: u32 = 1, // 1-based for rendering
        visible: bool = true,
        style: CursorStyle = .default,
        blinking: bool = false,
        color: ansi.RGBA = ansi.rgbColor(255, 255, 255, 255),
    } = .{},
} = .{},

term_info: TerminalInfo = .{},
notification_protocol: NotificationProtocol = .none,
notification_protocol_authoritative: bool = false,
notification_protocol_source: NotificationProtocolSource = .none,
notification_id_counter: u64 = 0,

pub fn init(opts: Options) Terminal {
    var term: Terminal = .{
        .opts = opts,
    };

    term.checkEnvironmentOverrides();
    return term;
}

pub fn deinit(self: *Terminal) void {
    if (self.host_env_map) |*env_map| {
        env_map.deinit();
        self.host_env_map = null;
    }
    self.opts.env_map = null;
    self.* = undefined;
}

pub fn setHostEnvVar(self: *Terminal, allocator: std.mem.Allocator, key: []const u8, value: []const u8) !void {
    if (self.host_env_map == null) {
        self.host_env_map = std.process.Environ.Map.init(allocator);
    }

    const env_map = &self.host_env_map.?;
    try env_map.put(key, value);
    self.opts.env_map = env_map;
    self.checkEnvironmentOverrides();
}

pub fn adoptHostEnvironment(self: *Terminal, environment: std.process.Environ.Map) void {
    std.debug.assert(self.host_env_map == null and self.opts.env_map == null);
    self.host_env_map = environment;
    self.opts.env_map = &self.host_env_map.?;
    self.checkEnvironmentOverrides();
}

pub fn resetInputModes(self: *Terminal, tty: anytype) !void {
    try tty.writeAll(ansi.ANSI.showCursor);
    try tty.writeAll(ansi.ANSI.reset);
    try tty.writeAll(ansi.ANSI.resetMousePointer);
    self.state.mouse_pointer = .default;

    if (self.state.kitty_keyboard) {
        try self.setKittyKeyboard(tty, false, 0);
    }

    if (self.state.modify_other_keys) {
        try self.setModifyOtherKeys(tty, false);
    }

    if (self.state.mouse_was_enabled) {
        try self.forceDisableMouseMode(tty);
    }

    if (self.state.bracketed_paste) {
        try self.setBracketedPaste(tty, false);
    }

    if (self.state.focus_tracking) {
        try self.setFocusTracking(tty, false);
    }
}

pub fn resetOutputModes(self: *Terminal, tty: anytype) !void {
    if (self.state.color_scheme_updates) {
        try self.setColorSchemeUpdates(tty, false);
    }

    // The DECRPM reply describes the terminal before setup. Put a mode it can change (not 3 or 4,
    // permanent) back as it was: set for 1, reset otherwise.
    const before = self.mode_2027 == 1;
    if ((self.mode_2027 orelse 0) < 3 and self.state.unicode != before) {
        try tty.writeAll(if (before) ansi.ANSI.unicodeSet else ansi.ANSI.unicodeReset);
    }
    self.state.unicode = false;

    try ansi.ANSI.setTerminalTitleOutput(tty, "");

    // OSC 111 is intentionally disabled for now. In Ghostty, sending the
    // reset alone is enough to poison later OSC 11 background reporting for
    // system light/dark theme changes, which breaks theme detection on the
    // next app startup even though the immediate reset appears to work.
    // try tty.writeAll(ansi.ANSI.resetTerminalBgColor);
}

pub fn enterAltScreen(self: *Terminal, tty: anytype) !void {
    try tty.writeAll(ansi.ANSI.switchToAlternateScreen);
    self.state.alt_screen = true;
}

pub fn exitAltScreen(self: *Terminal, tty: anytype) !void {
    try tty.writeAll(ansi.ANSI.switchToMainScreen);
    self.state.alt_screen = false;
}

pub fn queryTerminalSend(self: *Terminal, tty: anytype) !void {
    self.checkEnvironmentOverrides();
    self.startup_cursor_query_pending = true;
    self.startup_cursor_query_captured = false;

    // We intentionally do not send CSI ?996n here. Terminals disagree on the
    // meaning and reliability of the ?997 reply, so startup theme detection is
    // derived from fresh OSC 10/11 fg/bg colors instead.
    try self.setColorSchemeUpdates(tty, true);

    try self.queryThemeColors(tty);
    self.state.theme_queries_sent = true;

    // Send xtversion first (used for tmux detection)
    try tty.writeAll(ansi.ANSI.xtversion ++ ansi.ANSI.hideCursor);

    // Capture the startup cursor position, which seeds the split scrollback.
    try tty.writeAll(ansi.ANSI.cursorPositionRequest);

    // Probes are never DCS wrapped, and screen prints a DCS body as text. tmux
    // answers the probes it implements and drops the rest; passthrough replies
    // are not routed back to the pane that asked.
    if (!self.insideScreen()) try tty.writeAll(ansi.ANSI.xtgettcapMs);
    if (self.is_foot) {
        try tty.writeAll(ansi.ANSI.capabilityQueriesFootIsBroken);
    } else {
        try tty.writeAll(ansi.ANSI.capabilityQueries);
        if (!self.caps.rgb and !self.consoleTruecolor() and !self.insideScreen()) try tty.writeAll(ansi.ANSI.xtgettcapTruecolor);
    }
    // Each setup starts a new queue with its startup query.
    self.state.kitty_query_count = 0;
    self.recordKittyQuery();

    // Inside tmux, graphics replies cannot describe the passthrough endpoint.
    if (!self.skip_graphics_query and !self.isInTmux()) try tty.writeAll(ansi.ANSI.kittyGraphicsQuery);
    // Its reply settles the 2026 decision and Sixel; sentinel mode sends it at the end of setup instead.
    if (!self.reply_sentinel) try tty.writeAll(ansi.ANSI.primaryDeviceAttrs);

    // Only queryExplicitWidth's own reports count; a key between packets is not one.
    self.explicit_width_probe_reports_pending = 0;
}

/// Draws OSC 66 probes: call only on the alternate screen just entered; it saves its own cursor, not another app's.
/// They run on row 2 (the 2-row `s=2` cell needs row 3), so no reply equals a modified F3 key (`CSI 1;m R`).
pub fn queryExplicitWidth(self: *Terminal, tty: anytype) !void {
    if (self.skip_explicit_width_query) return;
    self.explicit_width_probe_reports_pending = 2;
    const row_two = "\x1b[2H";
    try tty.writeAll(ansi.ANSI.saveCursorState ++ row_two ++ ansi.ANSI.explicitWidthQuery ++ ansi.ANSI.cursorPositionRequest ++
        row_two ++ ansi.ANSI.scaledTextQuery ++ ansi.ANSI.cursorPositionRequest ++ ansi.ANSI.restoreCursorState);
}

/// ConPTY draws 24-bit color, but a remote app's output never reaches this process's console.
fn consoleTruecolor(self: *const Terminal) bool {
    return builtin.os.tag == .windows and self.opts.remote_mode != .remote;
}

pub fn enableDetectedFeatures(self: *Terminal, tty: anytype, use_kitty_keyboard: bool) !void {
    if (self.consoleTruecolor()) self.caps.rgb = true;
    self.checkEnvironmentOverrides();

    if (!self.state.modify_other_keys and !self.state.kitty_keyboard) {
        try self.setModifyOtherKeys(tty, true);
    }

    if (self.caps.kitty_keyboard and use_kitty_keyboard) {
        if (self.state.modify_other_keys) {
            try self.setModifyOtherKeys(tty, false);
        }
        try self.setKittyKeyboard(tty, true, self.opts.kitty_keyboard_flags);
    }

    // A reply can arrive after setup enabled mode 2027 and switch the width method away from it.
    const unicode = (self.caps.unicode == .unicode or self.caps.unicode == .unicode_wide) and !self.caps.explicit_width;
    if (unicode != self.state.unicode) {
        try tty.writeAll(if (unicode) ansi.ANSI.unicodeSet else ansi.ANSI.unicodeReset);
        self.state.unicode = unicode;
    }

    if (self.caps.bracketed_paste) {
        try self.setBracketedPaste(tty, true);
    }

    if (self.caps.focus_tracking) {
        try self.setFocusTracking(tty, true);
    }

    // queryTerminalSend already enabled mode 2031 during normal startup.
    if (!self.state.color_scheme_updates) {
        try self.setColorSchemeUpdates(tty, true);
    }

    if (!self.state.theme_queries_sent) {
        try self.queryThemeColors(tty);
        self.state.theme_queries_sent = true;
    }
}

pub fn queryThemeColors(_: *Terminal, tty: anytype) !void {
    // We only use the ?997 notification as a refresh trigger. The actual theme
    // mode is derived from the returned OSC 10/11 fg/bg colors, so callers
    // should query those colors directly instead of sending CSI ?996n.
    // tmux handles OSC 10/11 as plain OSC; DCS passthrough replies are not
    // routed back to the pane that asked.
    try tty.writeAll(ansi.ANSI.oscThemeQueries);
}

fn clearNotificationProtocol(self: *Terminal) void {
    self.notification_protocol = .none;
    self.notification_protocol_authoritative = false;
    self.notification_protocol_source = .none;
    self.caps.notifications = false;
}

fn notificationProtocolSourcePriority(source: NotificationProtocolSource) u8 {
    return switch (source) {
        .none => 0,
        .heuristic => 1,
        .xtversion => 2,
        .query => 3,
        .override => 4,
    };
}

fn setNotificationProtocol(self: *Terminal, protocol: NotificationProtocol, source: NotificationProtocolSource) void {
    if (protocol == .none) return;

    // Zellij only forwards OSC 99 desktop notifications. Ignore inherited
    // host-terminal heuristics such as TERM_PROGRAM=ghostty inside Zellij;
    // enable notifications there only from the OSC 99 protocol query or an
    // explicit user override.
    if (self.isInZellij() and source != .override) {
        if (source != .query or protocol != .osc99) return;
    }

    const current_source_priority = notificationProtocolSourcePriority(self.notification_protocol_source);
    const next_source_priority = notificationProtocolSourcePriority(source);
    if (next_source_priority < current_source_priority) return;
    if (next_source_priority == current_source_priority and notificationProtocolPriority(protocol) < notificationProtocolPriority(self.notification_protocol)) return;

    self.notification_protocol = protocol;
    self.notification_protocol_authoritative = source != .heuristic;
    self.notification_protocol_source = source;
    self.caps.notifications = true;
}

fn enforceNotificationProtocolForMultiplexer(self: *Terminal) void {
    if (!self.isInZellij() or self.notification_protocol_source == .override) return;
    if (self.notification_protocol_source == .query and self.notification_protocol == .osc99) return;

    self.clearNotificationProtocol();
}

fn notificationProtocolPriority(protocol: NotificationProtocol) u8 {
    return switch (protocol) {
        .none => 0,
        .osc9 => 1,
        .osc777 => 2,
        .osc99 => 3,
    };
}

fn applyNotificationHeuristic(self: *Terminal, value: []const u8) void {
    if (self.isInZellij()) return;
    if (detectNotificationProtocol(value)) |protocol| {
        self.setNotificationProtocol(protocol, .heuristic);
    }
}

fn applyNotificationProtocolOverride(self: *Terminal, value: []const u8) void {
    if (std.mem.eql(u8, value, "0") or
        std.ascii.eqlIgnoreCase(value, "false") or
        std.ascii.eqlIgnoreCase(value, "off") or
        std.ascii.eqlIgnoreCase(value, "none"))
    {
        self.clearNotificationProtocol();
        self.notification_protocol_authoritative = true;
        self.notification_protocol_source = .override;
        return;
    }

    if (std.mem.eql(u8, value, "1") or std.ascii.eqlIgnoreCase(value, "true") or std.ascii.eqlIgnoreCase(value, "on")) {
        return;
    }

    if (std.ascii.eqlIgnoreCase(value, "osc99")) {
        self.setNotificationProtocol(.osc99, .override);
    } else if (std.ascii.eqlIgnoreCase(value, "osc777")) {
        self.setNotificationProtocol(.osc777, .override);
    } else if (std.ascii.eqlIgnoreCase(value, "osc9")) {
        self.setNotificationProtocol(.osc9, .override);
    }
}

fn detectNotificationProtocol(value: []const u8) ?NotificationProtocol {
    // OSC 99 is explicitly documented by kitty and supported by foot. Prefer it
    // where the terminal family is known because it has the only real queryable
    // notification protocol and robust text encoding.
    if (std.ascii.findIgnoreCase(value, "kitty") != null or
        std.ascii.findIgnoreCase(value, "foot") != null)
    {
        return .osc99;
    }

    // OSC 777 is documented by WezTerm, Warp, hterm/Blink, and is the
    // rxvt/VTE-style title+body notification sequence. Use it where sources
    // document support, or where the terminal is clearly VTE/rxvt-derived.
    if (std.ascii.findIgnoreCase(value, "ghostty") != null or
        std.ascii.findIgnoreCase(value, "wezterm") != null or
        std.ascii.findIgnoreCase(value, "warp") != null or
        std.ascii.findIgnoreCase(value, "hterm") != null or
        std.ascii.findIgnoreCase(value, "blink") != null or
        std.ascii.findIgnoreCase(value, "contour") != null or
        std.ascii.findIgnoreCase(value, "vte") != null or
        std.ascii.findIgnoreCase(value, "gnome") != null or
        std.ascii.findIgnoreCase(value, "tilix") != null or
        std.ascii.findIgnoreCase(value, "terminator") != null or
        std.ascii.findIgnoreCase(value, "xfce") != null or
        std.ascii.findIgnoreCase(value, "urxvt") != null or
        std.ascii.findIgnoreCase(value, "rxvt") != null or
        std.ascii.findIgnoreCase(value, "windows terminal") != null or
        std.ascii.findIgnoreCase(value, "windows_terminal") != null or
        std.ascii.findIgnoreCase(value, "terminology") != null)
    {
        return .osc777;
    }

    // OSC 9 is the iTerm2 notification sequence. ConEmu reads every OSC 9 as
    // one of its subcommands and shows no notification, so use it only for
    // terminal families with documented notification support.
    if (std.ascii.findIgnoreCase(value, "iterm") != null or
        std.ascii.findIgnoreCase(value, "Apple_Terminal") != null or
        std.ascii.findIgnoreCase(value, "Terminal.app") != null)
    {
        return .osc9;
    }

    return null;
}

fn termFeaturesHasCode(features: []const u8, code: []const u8) bool {
    var i: usize = 0;
    while (i < features.len) {
        const c = features[i];
        if (!std.ascii.isAlphanumeric(c)) break;
        if (!std.ascii.isUpper(c)) {
            i += 1;
            continue;
        }

        const start = i;
        i += 1;
        while (i < features.len and std.ascii.isLower(features[i])) : (i += 1) {}
        if (std.mem.eql(u8, features[start..i], code)) return true;
        while (i < features.len and std.ascii.isDigit(features[i])) : (i += 1) {}
    }

    return false;
}

fn findOscTerminator(payload: []const u8) usize {
    const bel_end = std.mem.findScalar(u8, payload, '\x07');
    const st_end = std.mem.find(u8, payload, "\x1b\\");

    if (bel_end) |bel| {
        if (st_end) |st| return @min(bel, st);
        return bel;
    }

    if (st_end) |st| return st;
    return payload.len;
}

fn parseItermCapabilities(self: *Terminal, response: []const u8) void {
    var search_start: usize = 0;
    const prefix = "\x1b]1337;Capabilities=";
    while (std.mem.find(u8, response[search_start..], prefix)) |rel_pos| {
        const start = search_start + rel_pos + prefix.len;
        const end = start + findOscTerminator(response[start..]);

        if (termFeaturesHasCode(response[start..end], "No")) {
            self.setNotificationProtocol(.osc9, .query);
            return;
        }

        search_start = end;
    }
}

fn parseOsc99NotificationQuery(self: *Terminal, response: []const u8) void {
    var search_start: usize = 0;
    const prefix = "\x1b]99;";
    while (std.mem.find(u8, response[search_start..], prefix)) |rel_pos| {
        const start = search_start + rel_pos;
        const payload_start = start + prefix.len;
        const end = payload_start + findOscTerminator(response[payload_start..]);
        const payload = response[payload_start..end];

        if (std.mem.find(u8, payload, "i=" ++ NOTIFICATION_QUERY_ID) != null and
            std.mem.find(u8, payload, "p=?") != null and
            std.mem.find(u8, payload, "p=") != null and
            std.mem.find(u8, payload, "title") != null)
        {
            self.setNotificationProtocol(.osc99, .query);
            return;
        }

        search_start = end;
    }
}

// A supporting terminal replies `OSC 7501 ; ? ST`, optionally followed by
// `:states=...:kinds=...`. Whitespace around the `?` is allowed.
fn parseProgramStatusReply(self: *Terminal, response: []const u8) void {
    const prefix = "\x1b]7501;";
    const start = (std.mem.find(u8, response, prefix) orelse return) + prefix.len;
    const payload = response[start .. start + findOscTerminator(response[start..])];
    const first = payload[0 .. std.mem.findScalar(u8, payload, ':') orelse payload.len];
    if (std.mem.eql(u8, std.mem.trim(u8, first, " "), "?")) self.caps.program_status = true;
}

pub fn checkEnvironmentOverrides(self: *Terminal) void {
    defer self.caps.unicode = self.selectWidthMethod();
    defer self.caps.ansi256 = self.caps.ansi256 or self.caps.rgb;
    if (self.isXtversionTmux()) {
        self.multiplexer = .tmux;
    } else if (self.isXtversionZellij()) {
        self.multiplexer = .zellij;
    } else if (self.term_info.from_xtversion) {
        self.multiplexer = .none;
    } else {
        self.multiplexer = .none;
    }
    self.is_foot = self.term_info.from_xtversion and std.ascii.findIgnoreCase(self.getTerminalName(), "foot") != null;
    self.skip_graphics_query = false;
    self.graphics_enabled = true;
    self.image_protocol = .auto;
    self.skip_explicit_width_query = false;
    self.hyperlinks_override = null;

    // Always just try to enable bracketed paste, even if it was reported as not supported
    self.caps.bracketed_paste = true;

    if (self.opts.remote_mode == .remote) {
        self.remote = true;
        self.caps.remote = true;
    } else if (self.opts.remote_mode == .local) {
        self.remote = false;
        self.caps.remote = false;
    }

    const env_map = self.opts.env_map orelse return;

    if (self.opts.remote_mode == .auto) {
        self.remote = self.remote or isRemoteSessionEnv(env_map);
        self.caps.remote = self.remote;
    }

    // Unlike the identity keys below, color depth describes the endpoint in every mode:
    // sshd takes TERM from the client's PTY request, and COLORTERM comes from the client or the session itself.
    if (env_map.get("TERM")) |term| {
        if (std.ascii.findIgnoreCase(term, "256color") != null) {
            self.caps.ansi256 = true;
        }
    }
    if (self.insideScreen()) {
        // Screen drops 24-bit colors unless its `truecolor` setting is on, and an inherited COLORTERM cannot tell.
        self.caps.rgb = false;
        self.caps.ansi256 = true;
    } else if (env_map.get("COLORTERM")) |colorterm| {
        if (std.mem.eql(u8, colorterm, "truecolor") or std.mem.eql(u8, colorterm, "24bit")) self.caps.rgb = true;
    }
    // The explicit override, for screen with `truecolor on` or a terminal that answers no query.
    const force_truecolor = env_map.get("OPENTUI_FORCE_TRUECOLOR") orelse "";
    if (std.mem.eql(u8, force_truecolor, "1") or std.mem.eql(u8, force_truecolor, "true")) self.caps.rgb = true;
    // A remote client's environment names only GNU screen, which answers no query: TERM forwarded by ssh, or STY.
    const remote_env = self.identityEnv() == null;
    if (!self.term_info.from_xtversion) {
        if (!remote_env and env_map.get("TMUX") != null) {
            self.multiplexer = .tmux;
            self.caps.explicit_cursor_positioning = true;
        } else if (!remote_env and (env_map.get("ZELLIJ") != null or env_map.get("ZELLIJ_SESSION_NAME") != null or env_map.get("ZELLIJ_PANE_ID") != null)) {
            self.multiplexer = .zellij;
            if (self.term_info.name_len == 0) {
                const name = "Zellij";
                @memcpy(self.term_info.name[0..name.len], name);
                self.term_info.name_len = name.len;
            }
        } else if (self.insideScreen()) {
            self.multiplexer = .screen;
            self.skip_graphics_query = true;
            self.caps.explicit_cursor_positioning = true;
            self.caps.osc52 = true;
        } else if (!remote_env) {
            const term = env_map.get("TERM") orelse "";
            if (std.mem.startsWith(u8, term, "tmux")) {
                self.multiplexer = .tmux;
                self.caps.explicit_cursor_positioning = true;
            }
            if (std.mem.find(u8, term, "alacritty") != null) {
                self.caps.explicit_cursor_positioning = true;
            }
        }
    }
    if (remote_env) return;

    if (env_map.get("TERM")) |term| {
        self.applyNotificationHeuristic(term);
        self.is_foot = self.is_foot or std.ascii.findIgnoreCase(term, "foot") != null;
    }

    if (env_map.get("TERM_FEATURES")) |features| {
        if (termFeaturesHasCode(features, "No")) {
            self.setNotificationProtocol(.osc9, .heuristic);
        }
    }

    if (env_map.get("OPENTUI_GRAPHICS")) |val| {
        if (std.mem.eql(u8, val, "false") or std.mem.eql(u8, val, "0")) {
            self.skip_graphics_query = true;
            self.graphics_enabled = false;
            self.kitty_graphics_queried = false;
            self.sixel_queried = false;
            self.caps.kitty_graphics = false;
            self.caps.sixel = false;
        } else if (std.mem.eql(u8, val, "true") or std.mem.eql(u8, val, "1")) {
            self.skip_graphics_query = false;
        }
    }

    if (env_map.get("OPENTUI_IMAGE_PROTOCOL")) |value| {
        if (std.ascii.eqlIgnoreCase(value, "auto")) {
            self.image_protocol = .auto;
        } else if (std.ascii.eqlIgnoreCase(value, "kitty")) {
            self.image_protocol = .kitty;
        } else if (std.ascii.eqlIgnoreCase(value, "sixel")) {
            self.image_protocol = .sixel;
        } else if (std.ascii.eqlIgnoreCase(value, "blocks")) {
            self.image_protocol = .blocks;
        }
    }

    if (!self.term_info.from_xtversion) {
        if (env_map.get("TERM_PROGRAM")) |prog| {
            if (!self.isInZellij()) {
                const copy_len = @min(prog.len, self.term_info.name.len);
                @memcpy(self.term_info.name[0..copy_len], prog[0..copy_len]);
                self.term_info.name_len = copy_len;
            }

            if (!self.isInZellij() and std.mem.eql(u8, prog, "tmux")) {
                self.multiplexer = .tmux;
                self.caps.explicit_cursor_positioning = true;
            }

            self.applyNotificationHeuristic(prog);

            if (!self.isInZellij()) {
                if (env_map.get("TERM_PROGRAM_VERSION")) |ver| {
                    const ver_len = @min(ver.len, self.term_info.version.len);
                    @memcpy(self.term_info.version[0..ver_len], ver[0..ver_len]);
                    self.term_info.version_len = ver_len;
                }
            }

            if (std.mem.eql(u8, prog, "vscode")) {
                self.caps.kitty_keyboard = false;
                self.caps.kitty_graphics = false;
            } else if (std.mem.eql(u8, prog, "Alacritty")) {
                self.caps.explicit_cursor_positioning = true;
            }
        }

        if (env_map.get("ALACRITTY_SOCKET") != null or env_map.get("ALACRITTY_LOG") != null) {
            self.caps.explicit_cursor_positioning = true;
            if (self.term_info.name_len == 0) {
                const name = "Alacritty";
                @memcpy(self.term_info.name[0..name.len], name);
                self.term_info.name_len = name.len;
            }
        }
    }

    if (env_map.get("WT_SESSION") != null) {
        if (!self.insideScreen()) self.caps.rgb = true;
        self.setNotificationProtocol(.osc777, .heuristic);
    }

    if (env_map.get("OPENTUI_NOTIFICATION_PROTOCOL")) |protocol| {
        self.applyNotificationProtocolOverride(protocol);
    }
    if (env_map.get("OPENTUI_NOTIFICATIONS")) |value| {
        if (std.mem.eql(u8, value, "0") or std.ascii.eqlIgnoreCase(value, "false") or std.ascii.eqlIgnoreCase(value, "off")) {
            self.applyNotificationProtocolOverride("none");
        }
    }

    self.enforceNotificationProtocolForMultiplexer();

    if (!self.term_info.from_xtversion and env_map.get("VHS_RECORD") != null) {
        self.caps.kitty_keyboard = false;
        self.caps.kitty_graphics = false;
    }

    if (env_map.get("OPENTUI_FORCE_EXPLICIT_WIDTH")) |val| {
        if (std.mem.eql(u8, val, "true") or std.mem.eql(u8, val, "1")) {
            self.caps.explicit_width = true;
        } else if (std.mem.eql(u8, val, "false") or std.mem.eql(u8, val, "0")) {
            self.caps.explicit_width = false;
            self.skip_explicit_width_query = true;
        }
    }

    // Multiplexed panes inherit TERM, TERM_PROGRAM, and VTE_VERSION from the outer terminal.
    if ((self.is_foot or self.host_env_hyperlinks) and self.multiplexer != .none) {
        self.caps.hyperlinks = false;
        self.host_env_hyperlinks = false;
    }

    if (!self.caps.hyperlinks and self.term_info.from_xtversion) {
        if (isHyperlinkTerm(self.getTerminalName())) {
            self.caps.hyperlinks = true;
        }
    }

    if (!self.caps.hyperlinks and !self.term_info.from_xtversion) {
        if (env_map.get("TERM")) |term| {
            if (isHyperlinkTerm(term) and (!self.is_foot or self.multiplexer == .none)) {
                self.caps.hyperlinks = true;
            }
        }
    }

    if (!self.caps.hyperlinks and !self.term_info.from_xtversion and self.multiplexer == .none) {
        if (isHyperlinkHostEnv(env_map)) {
            self.caps.hyperlinks = true;
            self.host_env_hyperlinks = true;
        }
    }

    if (env_map.get("FORCE_HYPERLINK")) |value| {
        self.hyperlinks_override = !(std.mem.eql(u8, value, "0") or std.ascii.eqlIgnoreCase(value, "false") or std.ascii.eqlIgnoreCase(value, "off"));
    }
    if (self.hyperlinks_override) |enabled| {
        self.caps.hyperlinks = enabled;
    }

    if (!self.caps.osc52 and !self.term_info.from_xtversion) {
        if (env_map.get("WT_SESSION") != null) {
            self.caps.osc52 = true;
        }

        if (!self.caps.osc52 and (self.isInTmux() or env_map.get("STY") != null)) {
            self.caps.osc52 = true;
        }

        if (!self.caps.osc52) {
            if (env_map.get("TERM_PROGRAM")) |prog| {
                if (isOsc52Term(prog)) {
                    self.caps.osc52 = true;
                }
            }
        }

        if (!self.caps.osc52) {
            if (env_map.get("TERM")) |term| {
                if (isOsc52Term(term) or std.mem.find(u8, term, "256color") != null or std.mem.find(u8, term, "xterm") != null) {
                    self.caps.osc52 = true;
                }
            }
        }
    }
}

fn isRemoteSessionEnv(env_map: *const std.process.Environ.Map) bool {
    return env_map.get("SSH_CONNECTION") != null or
        env_map.get("SSH_CLIENT") != null or
        env_map.get("SSH_TTY") != null or
        env_map.get("MOSH_CONNECTION") != null;
}

fn writeMouseDisableSequences(tty: anytype) !void {
    try tty.writeAll(ansi.ANSI.disableAnyEventTracking);
    try tty.writeAll(ansi.ANSI.disableButtonEventTracking);
    try tty.writeAll(ansi.ANSI.disableMouseTracking);
    try tty.writeAll(ansi.ANSI.disableSGRMouseMode);
}

// TODO: Allow pixel mouse mode to be enabled,
// currently does not make sense and is not supported by higher levels
pub fn setMouseMode(self: *Terminal, tty: anytype, enable: bool, enable_movement: bool) !void {
    if (enable) {
        if (self.state.mouse and self.state.mouse_movement == enable_movement) return;
    } else if (!self.state.mouse) {
        return;
    }

    if (enable) {
        self.state.mouse = true;
        self.state.mouse_movement = enable_movement;
        // Arms the shutdown cleanup path so resetInputModes() will still emit mouse
        // disable sequences even if a later best-effort disable silently fails.
        self.state.mouse_was_enabled = true;
        if (!enable_movement) {
            // Some terminals treat ?1000/?1002/?1003 as one family and let the
            // last sequence win. Reset any-event tracking first, then enable
            // click/drag modes so they remain active.
            try tty.writeAll(ansi.ANSI.disableAnyEventTracking);
        }
        try tty.writeAll(ansi.ANSI.enableMouseTracking);
        try tty.writeAll(ansi.ANSI.enableButtonEventTracking);
        if (enable_movement) {
            try tty.writeAll(ansi.ANSI.enableAnyEventTracking);
        }
        try tty.writeAll(ansi.ANSI.enableSGRMouseMode);
    } else {
        self.state.mouse = false;
        self.state.pixel_mouse = false;
        try writeMouseDisableSequences(tty);
    }
}

// Best-effort shutdown path: emit the reset sequences even if tracked state
// already drifted to false because earlier writes failed.
pub fn forceDisableMouseMode(self: *Terminal, tty: anytype) !void {
    self.state.mouse = false;
    self.state.pixel_mouse = false;
    try writeMouseDisableSequences(tty);
}

pub fn setBracketedPaste(self: *Terminal, tty: anytype, enable: bool) !void {
    const seq = if (enable) ansi.ANSI.bracketedPasteSet else ansi.ANSI.bracketedPasteReset;
    try tty.writeAll(seq);
    self.state.bracketed_paste = enable;
}

pub fn setFocusTracking(self: *Terminal, tty: anytype, enable: bool) !void {
    const seq = if (enable) ansi.ANSI.focusSet else ansi.ANSI.focusReset;
    try tty.writeAll(seq);
    self.state.focus_tracking = enable;
}

/// Every push and pop goes through here, so each one starts a generation.
pub fn setKittyKeyboard(self: *Terminal, tty: anytype, enable: bool, flags: u8) !void {
    if (enable == self.state.kitty_keyboard) return;
    if (enable) try tty.print(ansi.ANSI.csiUPush, .{flags}) else try tty.writeAll(ansi.ANSI.csiUPop);
    self.state.kitty_keyboard = enable;
    self.state.kitty_keyboard_flags = if (enable) flags else 0;
    self.state.kitty_generation +%= 1;
    self.state.kitty_confirmed = false;
    // Without the sentinel the host's parser does not hold split replies, so it must see no new reply. A full queue
    // means replies stopped; the push then stays unconfirmed.
    if (!enable or !self.reply_sentinel or self.state.kitty_query_count == kitty_queries_max) return;
    try tty.writeAll(ansi.ANSI.csiUQuery);
    self.recordKittyQuery();
}

/// Whether the current push's own query is unanswered, so its reply may still come.
pub fn kittyQueryOutstanding(self: *const Terminal) bool {
    const count = self.state.kitty_query_count;
    return self.reply_sentinel and self.state.kitty_keyboard and count != 0 and
        self.state.kitty_queries[count - 1] == self.state.kitty_generation;
}

fn recordKittyQuery(self: *Terminal) void {
    const count = self.state.kitty_query_count;
    std.debug.assert(count < kitty_queries_max);
    self.state.kitty_queries[count] = self.state.kitty_generation;
    self.state.kitty_query_count = count + 1;
}

/// A `CSI ? flags u` reply answers the oldest query; it confirms only a query of the current push.
fn answerKittyQuery(self: *Terminal, flags: u32) void {
    const count = self.state.kitty_query_count;
    if (count == 0) return;
    const generation = self.state.kitty_queries[0];
    std.mem.copyForwards(u32, self.state.kitty_queries[0 .. count - 1], self.state.kitty_queries[1..count]);
    self.state.kitty_query_count = count - 1;
    if (generation != self.state.kitty_generation) return;
    if (self.state.kitty_keyboard_flags & kitty_escape_flags == 0 or flags & kitty_escape_flags == 0) return;
    self.state.kitty_confirmed = true;
}

pub fn setModifyOtherKeys(self: *Terminal, tty: anytype, enable: bool) !void {
    const seq = if (enable) ansi.ANSI.modifyOtherKeysSet else ansi.ANSI.modifyOtherKeysReset;
    try tty.writeAll(seq);
    self.state.modify_other_keys = enable;
}

pub fn setColorSchemeUpdates(self: *Terminal, tty: anytype, enable: bool) !void {
    const seq = if (enable) ansi.ANSI.colorSchemeSet else ansi.ANSI.colorSchemeReset;
    try tty.writeAll(seq);
    self.state.color_scheme_updates = enable;
}

/// Re-send all currently-active terminal mode escape sequences unconditionally.
///
/// When the terminal loses and regains focus (e.g. alt-tab, tab switch, minimize),
/// some terminal emulators (notably Windows Terminal / ConPTY) strip or reset
/// DEC private modes like mouse tracking (?1000/?1002/?1003/?1006), focus
/// tracking (?1004), and bracketed paste (?2004). This function re-emits the
/// enable sequences for every mode that our state tracking says is currently on,
/// without checking whether the mode "should" already be enabled — because the
/// terminal may have silently disabled it.
///
/// This should be called in response to the focus-in event (\x1b[I).
///
/// Per the xterm ctlseqs spec (Patch #401, 2025/06/22) and the Microsoft
/// Console Virtual Terminal Sequences documentation, the relevant DECSET
/// private modes are:
///   ?1000h  - Normal mouse tracking (sends button press/release)
///   ?1002h  - Button-event tracking (adds drag reporting)
///   ?1003h  - Any-event tracking (adds all motion reporting)
///   ?1006h  - SGR extended mouse mode (extended coordinate encoding)
///   ?1004h  - Focus event tracking (sends \x1b[I / \x1b[O)
///   ?2004h  - Bracketed paste mode (wraps pasted text in markers)
///   Kitty keyboard protocol (CSI > flags u) - progressive enhancement
///   modifyOtherKeys (CSI > 4 ; 1 m) - xterm key modification
pub fn restoreTerminalModes(self: *Terminal, tty: anytype) !void {
    // Re-enable mouse tracking modes if active
    if (self.state.mouse) {
        if (!self.state.mouse_movement) {
            try tty.writeAll(ansi.ANSI.disableAnyEventTracking);
        }
        try tty.writeAll(ansi.ANSI.enableMouseTracking);
        try tty.writeAll(ansi.ANSI.enableButtonEventTracking);
        if (self.state.mouse_movement) {
            try tty.writeAll(ansi.ANSI.enableAnyEventTracking);
        }
        try tty.writeAll(ansi.ANSI.enableSGRMouseMode);
    }

    // Re-enable focus tracking if active
    if (self.state.focus_tracking) {
        try tty.writeAll(ansi.ANSI.focusSet);
    }

    // Re-enable bracketed paste if active
    if (self.state.bracketed_paste) {
        try tty.writeAll(ansi.ANSI.bracketedPasteSet);
    }

    // Pop stale entry then re-push kitty keyboard protocol to avoid stack growth.
    // Both sequences are in the same write buffer so the terminal processes them atomically.
    if (self.state.kitty_keyboard) {
        const flags = self.state.kitty_keyboard_flags;
        try self.setKittyKeyboard(tty, false, 0);
        try self.setKittyKeyboard(tty, true, flags);
    }

    // Re-enable modifyOtherKeys if active
    if (self.state.modify_other_keys) {
        try tty.writeAll(ansi.ANSI.modifyOtherKeysSet);
    }
}

/// The responses look like these:
/// kitty - '\x1B[?1016;2$y\x1B[?2027;0$y\x1B[?2031;2$y\x1B[?1004;1$y\x1B[?2026;2$y\x1B[1;2R\x1B[1;3R\x1BP>|kitty(0.40.1)\x1B\\\x1B[?0u\x1B_Gi=1;EINVAL:Zero width/height not allowed\x1B\\\x1B[?62;c'
/// ghostty - '\x1B[?1016;1$y\x1B[?2027;1$y\x1B[?2031;2$y\x1B[?1004;1$y\x1B[?2004;2$y\x1B[?2026;2$y\x1B[1;1R\x1B[1;1R\x1BP>|ghostty 1.1.3\x1B\\\x1B[?0u\x1B_Gi=1;OK\x1B\\\x1B[?62;22c'
/// tmux - '\x1B[1;1R\x1B[1;1R\x1BP>|tmux 3.5a\x1B\\\x1B[?1;2;4c\x1B[?2;3;0S'
/// vscode - '\x1B[?1016;2$y'
/// alacritty - '\x1B[?1016;0$y\x1B[?2027;0$y\x1B[?2031;0$y\x1B[?1004;2$y\x1B[?2004;2$y\x1B[?2026;2$y\x1B[1;1R\x1B[1;1R\x1B[?0u\x1B[?6c'
///
/// Parsing these is not complete yet
fn parseKittyGraphicsResponse(self: *Terminal, response: []const u8) void {
    if (!self.graphics_enabled) return;
    var offset: usize = 0;
    while (std.mem.findPos(u8, response, offset, "\x1b_G")) |start| {
        const end = std.mem.findPos(u8, response, start + 3, "\x1b\\") orelse return;
        const frame = response[start + 3 .. end];
        const control_end = std.mem.findScalar(u8, frame, ';') orelse frame.len;
        var fields = std.mem.splitScalar(u8, frame[0..control_end], ',');
        while (fields.next()) |field| {
            if (std.mem.eql(u8, field, "i=31337")) {
                self.kitty_graphics_queried = true;
                self.caps.kitty_graphics = true;
                return;
            }
        }
        offset = end + 2;
    }
}

/// Returns whether the response holds a DA1 reply.
fn parseSixelDeviceAttributes(self: *Terminal, response: []const u8) bool {
    // With the graphics query skipped, DA1 answers only the sentinel. Inside tmux the caller clears Sixel.
    const graphics = self.graphics_enabled and !self.skip_graphics_query;
    var found = false;
    var offset: usize = 0;
    while (std.mem.findPos(u8, response, offset, "\x1b[?")) |start| {
        var end = start + 3;
        while (end < response.len and (std.ascii.isDigit(response[end]) or response[end] == ';')) : (end += 1) {}
        if (end >= response.len) return found;
        offset = end + 1;
        if (response[end] != 'c') continue;
        found = true;
        if (!graphics) continue;
        var params = std.mem.splitScalar(u8, response[start + 3 .. end], ';');
        while (params.next()) |param| {
            if (std.mem.eql(u8, param, "4")) {
                self.sixel_queried = true;
                self.caps.sixel = true;
            }
        }
    }
    return found;
}

fn semanticVersionAtLeast(version: []const u8, required_major: u32, required_minor: u32) bool {
    const suffix_start = std.mem.findScalar(u8, version, '-');
    const core = if (suffix_start) |index| version[0..index] else version;
    var parts = std.mem.splitScalar(u8, core, '.');
    const major_text = parts.next() orelse return false;
    const minor_text = parts.next() orelse return false;
    const patch_text = parts.next() orelse return false;
    if (parts.next() != null) return false;
    const major = std.fmt.parseInt(u32, major_text, 10) catch return false;
    const minor = std.fmt.parseInt(u32, minor_text, 10) catch return false;
    const patch = std.fmt.parseInt(u32, patch_text, 10) catch return false;
    if (major > required_major or (major == required_major and minor > required_minor)) return true;
    if (major != required_major or minor != required_minor) return false;
    if (patch > 0) return true;
    const suffix = if (suffix_start) |index| version[index + 1 ..] else return true;
    var suffix_parts = std.mem.splitScalar(u8, suffix, '-');
    const commits = suffix_parts.next() orelse return false;
    const revision = suffix_parts.next() orelse return false;
    if (suffix_parts.next() != null or commits.len == 0 or revision.len < 2 or revision[0] != 'g') return false;
    _ = std.fmt.parseInt(u32, commits, 10) catch return false;
    for (revision[1..]) |char| if (!std.ascii.isHex(char)) return false;
    return true;
}

fn ghosttyWideGraphemeWidths(version: []const u8) bool {
    if (semanticVersionAtLeast(version, 1, 3)) return true;
    const prefix = "0.0.0-";
    if (!std.mem.startsWith(u8, version, prefix) or version.len <= prefix.len + 8 or version[prefix.len + 8] != '.') return false;
    const date_text = version[prefix.len .. prefix.len + 8];
    for (date_text) |char| if (!std.ascii.isDigit(char)) return false;
    const date = std.fmt.parseInt(u32, date_text, 10) catch return false;
    return date >= 20260224;
}

fn wezTermBuildAtLeast(version: []const u8, required_date: u32) bool {
    var parts = std.mem.splitAny(u8, version, "-._");
    const date_text = parts.next() orelse return false;
    const time_text = parts.next() orelse return false;
    const hash_text = parts.next() orelse return false;
    if (date_text.len != 8 or time_text.len != 6 or hash_text.len != 8) return false;
    while (parts.next()) |supplement| if (supplement.len == 0) return false;
    for (date_text) |char| if (!std.ascii.isDigit(char)) return false;
    for (time_text) |char| if (!std.ascii.isDigit(char)) return false;
    for (hash_text) |char| if (!std.ascii.isHex(char)) return false;
    const year = std.fmt.parseInt(u16, date_text[0..4], 10) catch return false;
    const month = std.fmt.parseInt(u8, date_text[4..6], 10) catch return false;
    const day = std.fmt.parseInt(u8, date_text[6..8], 10) catch return false;
    if (month < 1 or month > 12) return false;
    const leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0);
    const days = [_]u8{ 31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    if (day < 1 or day > days[month - 1]) return false;
    const hour = std.fmt.parseInt(u8, time_text[0..2], 10) catch return false;
    const minute = std.fmt.parseInt(u8, time_text[2..4], 10) catch return false;
    const second = std.fmt.parseInt(u8, time_text[4..6], 10) catch return false;
    if (hour > 23 or minute > 59 or second > 59) return false;
    const date = std.fmt.parseInt(u32, date_text, 10) catch return false;
    return date >= required_date;
}

fn applyKnownGraphicsIdentity(self: *Terminal) void {
    if (!self.graphics_enabled or self.multiplexer != .none or !self.term_info.from_xtversion) return;
    const name = self.getTerminalName();
    const version = self.getTerminalVersion();

    if (std.ascii.eqlIgnoreCase(name, "kitty")) {
        self.caps.kitty_graphics = true;
        return;
    }
    if (std.ascii.eqlIgnoreCase(name, "ghostty")) {
        self.caps.kitty_graphics = true;
        return;
    }
    if (std.ascii.eqlIgnoreCase(name, "foot") and semanticVersionAtLeast(version, 1, 2)) {
        self.caps.sixel = true;
        return;
    }
    if (std.ascii.eqlIgnoreCase(name, "wezterm") and wezTermBuildAtLeast(version, 20200620)) {
        self.caps.sixel = true;
    }
}

/// What a terminal's identity says about its widths, before or beside its DECRPM 2027 reply.
const WidthIdentity = enum { unknown, wcwidth, graphemes, ghostty };

/// Chooses the width method from the strongest evidence: an OPENTUI_FORCE_* variable (applied over
/// SSH too: it configures the app, not the terminal), the multiplexer that draws the cells, the
/// DECRPM 2027 reply, then the terminal's identity.
fn selectWidthMethod(self: *Terminal) WidthMethod {
    if (self.opts.env_map) |env| {
        if (env.get("OPENTUI_FORCE_NOZWJ") != null) return .no_zwj;
        if (env.get("OPENTUI_FORCE_UNICODE") != null) return .unicode;
        if (env.get("OPENTUI_FORCE_WCWIDTH") != null) return .wcwidth;
    }
    const env_map = self.identityEnv();
    // TMUX and TERM_PROGRAM=tmux are inherited by terminals and multiplexers started inside tmux. tmux
    // answers XTVERSION before DECRPM 2027, so a 2027 reply without it comes from another terminal, and
    // an inner screen or Zellij answers neither.
    const env_tmux_inner = if (env_map) |env| env.get("STY") != null or env.get("ZELLIJ") != null else false;
    switch (self.multiplexer) {
        .none => {},
        .tmux => if (self.term_info.from_xtversion or self.mode_2027 == null) {
            const graphemes = std.mem.eql(u8, self.getTerminalName(), "tmux") and tmuxGraphemes(self.getTerminalVersion());
            return if (graphemes and (self.term_info.from_xtversion or !env_tmux_inner)) .unicode else .wcwidth;
        },
        else => return .wcwidth,
    }
    const identity: WidthIdentity = if (self.term_info.from_xtversion)
        xtversionWidthIdentity(self.getTerminalName(), self.getTerminalVersion())
    else if (env_map) |env| self.envWidthIdentity(env) else .unknown;
    const mode = self.mode_2027 orelse return switch (identity) {
        .unknown, .graphemes => .unicode,
        .wcwidth => .wcwidth,
        .ghostty => .unicode_wide,
    };
    // kitty and iTerm2 cluster graphemes without mode 2027; other terminals that lack it draw code points.
    if ((mode == 0 or mode == 4) and identity != .graphemes) return .wcwidth;
    return if (identity == .ghostty) .unicode_wide else .unicode;
}

/// The environment that may describe the terminal: not a remote client's forwarded map in auto mode.
fn identityEnv(self: *const Terminal) ?*const std.process.Environ.Map {
    const env_map = self.opts.env_map orelse return null;
    const forwarded = if (self.host_env_map) |*host_env_map| env_map == host_env_map else false;
    if (self.opts.remote_mode == .auto and self.remote and forwarded) return null;
    return env_map;
}

/// TERM comes from the innermost terminal. TERM_PROGRAM can be inherited from the terminal that
/// started it, so it counts only when TERM does not name another terminal.
fn envWidthIdentity(self: *const Terminal, env: *const std.process.Environ.Map) WidthIdentity {
    if (env.get("TERMUX_VERSION") != null or env.get("VHS_RECORD") != null) return .wcwidth;
    const term = env.get("TERM") orelse "";
    if (std.mem.startsWith(u8, term, "xterm-kitty")) return .graphemes;
    if (std.mem.startsWith(u8, term, "alacritty") or std.mem.startsWith(u8, term, "rxvt")) return .wcwidth;
    if (term.len != 0 and !std.mem.startsWith(u8, term, "xterm")) return .unknown;
    const program = env.get("TERM_PROGRAM") orelse "";
    if (std.ascii.eqlIgnoreCase(program, "ghostty") and !self.remote and ghosttyWideGraphemeWidths(env.get("TERM_PROGRAM_VERSION") orelse "")) return .ghostty;
    if (std.mem.eql(u8, program, "vscode") or std.mem.eql(u8, program, "Apple_Terminal")) return .wcwidth;
    if (program.len != 0 or env.get("KONSOLE_VERSION") != null) return .unknown;
    if (env.get("VTE_VERSION") != null or env.get("XTERM_VERSION") != null or env.get("ALACRITTY_SOCKET") != null or env.get("ALACRITTY_LOG") != null) return .wcwidth;
    return .unknown;
}

fn xtversionWidthIdentity(name: []const u8, version: []const u8) WidthIdentity {
    if (std.ascii.eqlIgnoreCase(name, "libghostty") or (std.ascii.eqlIgnoreCase(name, "ghostty") and ghosttyWideGraphemeWidths(version))) return .ghostty;
    if (std.ascii.eqlIgnoreCase(name, "kitty") or std.ascii.eqlIgnoreCase(name, "iTerm2")) return .graphemes;
    if (std.ascii.eqlIgnoreCase(name, "XTerm") or std.ascii.eqlIgnoreCase(name, "VTE") or std.ascii.eqlIgnoreCase(name, "xterm.js")) return .wcwidth;
    return .unknown;
}

/// tmux 3.6 draws VS16, keycap, ZWJ and emoji modifier sequences as one cluster. Accepts "3.6",
/// "3.6a", "3.6-rc" and "next-3.8"; not "openbsd-7.8".
fn tmuxGraphemes(version: []const u8) bool {
    const release = if (std.mem.startsWith(u8, version, "next-")) version["next-".len..] else version;
    const dot = std.mem.findScalar(u8, release, '.') orelse return false;
    const major = std.fmt.parseInt(u32, release[0..dot], 10) catch return false;
    const minor_text = release[dot + 1 ..];
    const minor = std.fmt.parseInt(u32, minor_text[0 .. std.mem.findNone(u8, minor_text, "0123456789") orelse minor_text.len], 10) catch return false;
    return major > 3 or (major == 3 and minor >= 6);
}

pub fn processCapabilityResponse(self: *Terminal, response: []const u8) void {
    self.parseOsc99NotificationQuery(response);
    self.parseItermCapabilities(response);
    self.parseProgramStatusReply(response);
    const truecolor_reply = self.parseXtgettcap(response);
    self.parseKittyGraphicsResponse(response);
    const device_attributes = self.parseSixelDeviceAttributes(response);

    // DECRPM responses
    if (std.mem.find(u8, response, "1016;2$y")) |_| {
        self.caps.sgr_pixels = true;
    }
    if (std.mem.find(u8, response, "?2027;")) |start| {
        const reply = response[start + "?2027;".len ..];
        if (reply.len >= 3 and reply[0] >= '0' and reply[0] <= '4' and std.mem.eql(u8, reply[1..3], "$y")) self.mode_2027 = reply[0] - '0';
    }
    if (std.mem.find(u8, response, "2031;1$y") != null or std.mem.find(u8, response, "2031;2$y") != null) {
        self.caps.color_scheme_updates = true;
    }
    if (std.mem.find(u8, response, "1004;1$y") != null or std.mem.find(u8, response, "1004;2$y") != null) {
        self.caps.focus_tracking = true;
    }
    if (std.mem.find(u8, response, "2026;1$y") != null or std.mem.find(u8, response, "2026;2$y") != null) {
        self.caps.sync = true;
    }
    if (std.mem.find(u8, response, "2004;1$y") != null or std.mem.find(u8, response, "2004;2$y") != null) {
        self.caps.bracketed_paste = true;
    }

    // Parse cursor position reports: ESC[row;colR
    // The first report after queryTerminalSend is the pre-home cursor position.
    var scan_pos: usize = 0;
    while (scan_pos < response.len) {
        const esc_rel = std.mem.find(u8, response[scan_pos..], "\x1b[") orelse break;
        const esc = scan_pos + esc_rel;
        var pos = esc + 2;

        const row_start = pos;
        while (pos < response.len and response[pos] >= '0' and response[pos] <= '9') : (pos += 1) {}
        if (pos == row_start or pos >= response.len or response[pos] != ';') {
            scan_pos = esc + 2;
            continue;
        }

        const row = std.fmt.parseInt(u16, response[row_start..pos], 10) catch {
            scan_pos = pos + 1;
            continue;
        };

        pos += 1;
        const col_start = pos;
        while (pos < response.len and response[pos] >= '0' and response[pos] <= '9') : (pos += 1) {}
        if (pos == col_start or pos >= response.len or response[pos] != 'R') {
            scan_pos = col_start;
            continue;
        }

        const col = std.fmt.parseInt(u16, response[col_start..pos], 10) catch {
            scan_pos = pos + 1;
            continue;
        };

        if (self.startup_cursor_query_pending and !self.startup_cursor_query_captured and row >= 1 and col >= 1) {
            self.setCursorPosition(col, row, self.state.cursor.visible);
            self.startup_cursor_query_captured = true;
            self.startup_cursor_query_pending = false;
        } else if (self.explicit_width_probe_reports_pending > 0 and row == 2 and col <= 3) {
            // A probe reply is on row 2, columns 1 to 3; a key or a repeated report forwarded as a reply is skipped.
            const probe_index = 2 - self.explicit_width_probe_reports_pending;
            self.explicit_width_probe_reports_pending -= 1;
            // Terminals answer in order, and the probes follow the capability queries.
            self.sync_reply_settled = true;

            // A terminal that draws `w=1` (column 2) also moves for `s=2`: kitty to column 3, foot to 2. Deciding on
            // the pair keeps a stray column-2 report, such as a repeated startup report, from passing alone.
            if (probe_index == 0) self.explicit_width_probe_first_column = col;
            if (probe_index == 1 and self.explicit_width_probe_first_column == 2 and col >= 2) {
                self.caps.explicit_width = true;
                self.caps.scaled_text = col == 3;
            }
        }

        scan_pos = pos + 1;
    }
    // Every DA1 query follows the 2026 query, so its reply settles the synchronized-output decision.
    if (device_attributes) self.sync_reply_settled = true;
    // The sentinel's reply follows every startup cursor report, so none is still coming.
    if (device_attributes and self.reply_sentinel) {
        self.startup_cursor_query_pending = false;
        self.explicit_width_probe_reports_pending = 0;
    }

    // Parse xtversion response: ESC P > | name version ESC \
    // Examples: "\x1BP>|kitty(0.40.1)\x1B\\" or "\x1BP>|ghostty 1.1.3\x1B\\" or "\x1BP>|tmux 3.5a\x1B\\"
    if (std.mem.find(u8, response, "\x1bP>|")) |pos| {
        const start = pos + 4; // Skip past "\x1BP>|"
        if (std.mem.find(u8, response[start..], "\x1b\\")) |end_offset| {
            const term_str = response[start .. start + end_offset];
            self.parseXtversion(term_str);
        }
    }

    // Exact Kitty identity features. Graphics identity is applied after a
    // complete XTVERSION response determines the direct endpoint.
    if (self.term_info.from_xtversion and std.ascii.eqlIgnoreCase(self.getTerminalName(), "kitty")) {
        self.caps.kitty_keyboard = true;
        self.caps.bracketed_paste = true;
        self.caps.hyperlinks = true;
    }
    // OSC 66 text sizing where setup runs no probe (the main screen): kitty since 0.40, foot since 1.21 (width only).
    if (self.term_info.from_xtversion and !self.skip_explicit_width_query and !self.explicit_width_probed) {
        const name = self.getTerminalName();
        const version = self.getTerminalVersion();
        const kitty = std.ascii.eqlIgnoreCase(name, "kitty") and semanticVersionAtLeast(version, 0, 40);
        if (kitty or (std.ascii.eqlIgnoreCase(name, "foot") and semanticVersionAtLeast(version, 1, 21))) self.caps.explicit_width = true;
        if (kitty) self.caps.scaled_text = true;
    }
    // Inside screen a reply may describe the terminal outside it, and screen drops 24-bit SGR.
    if (!self.insideScreen() and (truecolor_reply or (self.term_info.from_xtversion and isTruecolorTerminal(self.getTerminalName())))) {
        self.caps.rgb = true;
        self.caps.ansi256 = true;
    }

    // Kitty keyboard protocol detection via CSI ? u response
    // Terminals supporting the protocol respond to CSI ? u with CSI ? <flags> u
    // Examples: \x1b[?0u (ghostty, alacritty), \x1b[?1u, etc.
    var rest = response;
    while (std.mem.find(u8, rest, "\x1b[?")) |start| {
        rest = rest[start + 3 ..];
        const digits = std.mem.indexOfNone(u8, rest, "0123456789") orelse rest.len;
        if (digits != 0 and digits < rest.len and rest[digits] == 'u') {
            self.caps.kitty_keyboard = true;
            self.answerKittyQuery(std.fmt.parseInt(u32, rest[0..digits], 10) catch std.math.maxInt(u32));
            break;
        }
    }

    if (std.mem.find(u8, response, "alacritty")) |_| {
        self.caps.explicit_cursor_positioning = true;
    }

    if (!self.caps.osc52 and isOsc52Term(response)) {
        self.caps.osc52 = true;
    }

    if (!self.caps.hyperlinks and isHyperlinkTerm(response)) {
        self.caps.hyperlinks = true;
    }
    if (self.hyperlinks_override) |enabled| {
        self.caps.hyperlinks = enabled;
    }

    self.caps.unicode = self.selectWidthMethod();
    if (self.isInTmux()) {
        self.caps.explicit_cursor_positioning = true;
        // tmux has reported pane focus changes since 1.8 but answers DECRQM
        // for mode 1004 only since 3.6.
        self.caps.focus_tracking = true;

        // Graphics replies inside tmux either have no pane ownership (Kitty
        // passthrough) or describe tmux itself rather than the passthrough
        // endpoint (DA/Sixel). Neither can select an outer image protocol.
        self.kitty_graphics_queried = false;
        self.caps.kitty_graphics = false;
        self.sixel_queried = false;
        self.caps.sixel = false;
    }
}

/// Applies a positive Ms reply and returns whether a positive RGB or Tc reply came. Only replies
/// with a well-formed value count; RGB and Tc may come without one.
fn parseXtgettcap(self: *Terminal, response: []const u8) bool {
    const prefix = "\x1bP1+r";
    var truecolor = false;
    var scan_pos: usize = 0;
    while (std.mem.findPos(u8, response, scan_pos, prefix)) |start| {
        const body_start = start + prefix.len;
        const end = std.mem.findPos(u8, response, body_start, "\x1b\\") orelse break;
        const result = response[body_start..end];
        scan_pos = end + 2;

        const separator = std.mem.findScalar(u8, result, '=');
        const name = result[0 .. separator orelse result.len];
        const value = if (separator) |index| result[index + 1 ..] else "";
        if ((separator != null and value.len == 0) or value.len % 2 != 0) continue;
        for (value) |byte| {
            if (!std.ascii.isHex(byte)) break;
        } else if (std.ascii.eqlIgnoreCase(name, "4d73") and value.len != 0) {
            self.osc52_support = .supported;
            self.caps.osc52 = true;
        } else if (std.ascii.eqlIgnoreCase(name, "524742") or std.ascii.eqlIgnoreCase(name, "5463")) {
            truecolor = true;
        }
    }
    return truecolor;
}

/// XTVERSION names of terminals that draw 24-bit color. tmux converts 24-bit colors for its client.
fn isTruecolorTerminal(name: []const u8) bool {
    for ([_][]const u8{ "kitty", "ghostty", "WezTerm", "foot", "XTerm", "iTerm2", "tmux" }) |known| {
        if (std.ascii.eqlIgnoreCase(name, known)) return true;
    }
    return false;
}

fn isOsc52Term(value: []const u8) bool {
    return std.ascii.findIgnoreCase(value, "iterm") != null or
        std.ascii.findIgnoreCase(value, "kitty") != null or
        std.ascii.findIgnoreCase(value, "alacritty") != null or
        std.ascii.findIgnoreCase(value, "wezterm") != null or
        std.ascii.findIgnoreCase(value, "contour") != null or
        std.ascii.findIgnoreCase(value, "foot") != null or
        std.ascii.findIgnoreCase(value, "rio") != null or
        std.ascii.findIgnoreCase(value, "ghostty") != null or
        std.ascii.findIgnoreCase(value, "tmux") != null or
        std.ascii.findIgnoreCase(value, "screen") != null;
}

fn isHyperlinkTerm(value: []const u8) bool {
    return std.ascii.findIgnoreCase(value, "ghostty") != null or
        std.ascii.findIgnoreCase(value, "kitty") != null or
        std.ascii.findIgnoreCase(value, "wezterm") != null or
        std.ascii.findIgnoreCase(value, "alacritty") != null or
        std.ascii.findIgnoreCase(value, "foot") != null or
        std.ascii.findIgnoreCase(value, "iterm") != null or
        std.ascii.findIgnoreCase(value, "xterm.js") != null or
        std.ascii.findIgnoreCase(value, "terminology") != null or
        std.ascii.eqlIgnoreCase(value, "rex") or
        std.ascii.eqlIgnoreCase(value, "xterm-rex");
}

fn isHyperlinkHostEnv(env_map: *const std.process.Environ.Map) bool {
    if (env_map.get("TERM_PROGRAM")) |program| {
        if (std.mem.eql(u8, program, "vscode") or
            std.mem.eql(u8, program, "zed") or
            std.mem.eql(u8, program, "mintty")) return true;
    }
    // VTE releases before 0.52.2 include OSC 8 versions that can crash.
    if (env_map.get("VTE_VERSION")) |version| {
        const parsed = std.fmt.parseInt(u32, version, 10) catch return false;
        return parsed >= 5202;
    }
    // WT_SESSION names Windows Terminal at the endpoint on any host OS, unless TERM names another terminal inside it.
    const term = env_map.get("TERM") orelse "";
    return env_map.get("WT_SESSION") != null and (term.len == 0 or std.mem.startsWith(u8, term, "xterm"));
}

pub fn synchronizedOutput(self: *const Terminal) bool {
    return switch (self.synchronized_output) {
        .always => true,
        .never => false,
        // A multiplexer on the app's host answers DECRQM 2026 from its own state and redraws every touched
        // line when an update ends; between the app and a slow link that redraw costs more than partial frames.
        .auto => !self.remote or !self.sync_reply_settled or (self.caps.sync and !self.multiplexer_on_host),
    };
}

pub fn getCapabilities(self: *Terminal) Capabilities {
    return self.caps;
}

pub fn setMousePointerStyle(self: *Terminal, style: MousePointerStyle) void {
    self.state.mouse_pointer = style;
}

pub fn getMousePointer(self: *Terminal) MousePointerStyle {
    return self.state.mouse_pointer;
}

pub fn setCursorPosition(self: *Terminal, x: u32, y: u32, visible: bool) void {
    self.state.cursor.x = @max(1, x);
    self.state.cursor.y = @max(1, y);
    self.state.cursor.visible = visible;

    // Update 0-based coordinates for terminal operations
    self.state.cursor.col = @intCast(@max(0, x - 1));
    self.state.cursor.row = @intCast(@max(0, y - 1));
}

pub fn setCursorStyle(self: *Terminal, style: CursorStyle, blinking: bool) void {
    self.state.cursor.style = style;
    self.state.cursor.blinking = blinking;
}

pub fn setCursorColor(self: *Terminal, color: ansi.RGBA) void {
    self.state.cursor.color = color;
}

pub fn getCursorPosition(self: *Terminal) struct { x: u32, y: u32, visible: bool } {
    return .{
        .x = self.state.cursor.x,
        .y = self.state.cursor.y,
        .visible = self.state.cursor.visible,
    };
}

pub fn getCursorStyle(self: *Terminal) struct { style: CursorStyle, blinking: bool } {
    return .{
        .style = self.state.cursor.style,
        .blinking = self.state.cursor.blinking,
    };
}

pub fn getCursorColor(self: *Terminal) ansi.RGBA {
    return self.state.cursor.color;
}

pub fn setKittyKeyboardFlags(self: *Terminal, flags: u8) void {
    self.opts.kitty_keyboard_flags = flags;
}

/// A C0, DEL, or C1 control in the text can end the OSC and start another one, so each becomes a space.
/// GNU screen forwards only the low byte of a code point (U+4E07 as BEL), so there every non-ASCII
/// code point becomes a space too.
fn writeSanitizedNotificationText(writer: anytype, text: []const u8, replace_semicolon: bool, ascii: bool) !void {
    var code_points = std.unicode.Utf8View.initUnchecked(text).iterator();
    while (code_points.nextCodepointSlice()) |slice| {
        const code_point = std.unicode.utf8Decode(slice) catch unreachable;
        if (utf8.isControl(code_point) or (ascii and code_point >= 0x80) or (replace_semicolon and code_point == ';')) {
            try writer.writeByte(' ');
        } else {
            try writer.writeAll(slice);
        }
    }
}

fn writeOsc99Payload(allocator: std.mem.Allocator, writer: anytype, id: []const u8, payload_type: []const u8, payload: []const u8, done: bool, end: []const u8) !void {
    const encoded_len = std.base64.standard.Encoder.calcSize(payload.len);
    const encoded_buf = try allocator.alloc(u8, encoded_len);
    defer allocator.free(encoded_buf);
    const encoded = base64Encode(encoded_buf, payload);

    try writer.print("\x1b]99;i={s}:p={s}:e=1:d={d};", .{ id, payload_type, @intFromBool(done) });
    try writer.writeAll(encoded);
    try writer.writeAll(end);
}

pub fn writeNotification(self: *Terminal, allocator: std.mem.Allocator, tty: anytype, message: []const u8, title: ?[]const u8) !bool {
    if (!self.caps.notifications or self.notification_protocol == .none) {
        return false;
    }
    const notification_title = title orelse "";
    if (!std.unicode.utf8ValidateSlice(message) or !std.unicode.utf8ValidateSlice(notification_title)) return false;

    self.notification_id_counter +%= 1;

    var buffer: std.Io.Writer.Allocating = .init(allocator);
    defer buffer.deinit();
    const writer = &buffer.writer;
    const end = oscEnd(self.multiplexer);
    const ascii = self.multiplexer == .screen;

    switch (self.notification_protocol) {
        .none => return false,
        .osc99 => {
            const id = try std.fmt.allocPrint(allocator, "opentui-{d}", .{self.notification_id_counter});
            defer allocator.free(id);

            if (notification_title.len > 0) try writeOsc99Payload(allocator, writer, id, "title", notification_title, false, end);
            try writeOsc99Payload(allocator, writer, id, "body", message, true, end);
        },
        .osc777 => {
            try writer.writeAll("\x1b]777;notify;");
            if (title != null) {
                try writeSanitizedNotificationText(writer, notification_title, true, ascii);
                try writer.writeByte(';');
                try writeSanitizedNotificationText(writer, message, true, ascii);
            } else {
                try writeSanitizedNotificationText(writer, message, true, ascii);
                try writer.writeByte(';');
            }
            try writer.writeAll(end);
        },
        .osc9 => {
            // OSC 9 parsers (ConEmu, Windows Terminal, Ghostty, iTerm2) read text that starts with a digit as
            // a ConEmu subcommand (progress, cwd, tab title, macro), so a space keeps it a notification.
            const lead = if (notification_title.len > 0) notification_title else message;
            try writer.writeAll(if (lead.len > 0 and std.ascii.isDigit(lead[0])) "\x1b]9; " else "\x1b]9;");
            if (notification_title.len > 0) {
                try writeSanitizedNotificationText(writer, notification_title, false, ascii);
                try writer.writeAll(": ");
            }
            try writeSanitizedNotificationText(writer, message, false, ascii);
            try writer.writeAll(end);
        },
    }

    var passthrough = try PassthroughWriter(@TypeOf(tty)).init(tty, self.multiplexer);
    try passthrough.writeAll(buffer.written());
    try passthrough.finish();
    return true;
}

/// Return the exact number of bytes emitted by writeClipboard.
pub fn clipboardSequenceSize(self: *Terminal, payload_len: usize) !usize {
    if (payload_len > CLIPBOARD_PAYLOAD_SIZE_MAX) return error.ClipboardPayloadTooLarge;
    const padded_len = try std.math.add(usize, payload_len, 2);
    const encoded_len = try std.math.mul(usize, @divFloor(padded_len, 3), 4);
    const sequence_len = try std.math.add(usize, encoded_len, OSC52_FRAMING_SIZE);

    if (self.isInTmux()) {
        const wrapped_len = try std.math.add(usize, sequence_len, 2);
        return std.math.add(usize, wrapped_len, ansi.ANSI.tmuxDcsStart.len + ansi.ANSI.tmuxDcsEnd.len);
    }

    if (self.isInScreen()) {
        const screen_sequence_len = try std.math.add(usize, encoded_len, SCREEN_OSC52_FRAMING_SIZE);
        const chunk_count = @divFloor(screen_sequence_len - 1, SCREEN_PASSTHROUGH_CHUNK_SIZE) + 1;
        const envelopes_len = try std.math.mul(usize, chunk_count, ansi.ANSI.screenDcsStart.len + ansi.ANSI.screenDcsEnd.len);
        return std.math.add(usize, screen_sequence_len, envelopes_len);
    }

    return sequence_len;
}

/// Write OSC 52 clipboard sequence to the terminal from raw clipboard bytes.
/// Supports tmux/screen passthrough, including nested tmux sessions
pub fn writeClipboard(self: *Terminal, tty: anytype, target: ClipboardTarget, text_utf8: []const u8) !void {
    if (!self.canWriteClipboard()) {
        return error.NotSupported;
    }
    _ = try self.clipboardSequenceSize(text_utf8.len);

    var writer = try PassthroughWriter(@TypeOf(tty)).init(tty, self.multiplexer);
    try writer.writeAll("\x1b]52;");
    try writer.writeByte(target.toChar());
    try writer.writeByte(';');
    try writeClipboardBase64(&writer, text_utf8);
    try writer.writeAll(oscEnd(self.multiplexer));
    try writer.finish();
}

/// GNU screen ends its DCS at the first ST, so an OSC that passes through it ends with BEL.
fn oscEnd(multiplexer: Multiplexer) []const u8 {
    return if (multiplexer == .screen) "\x07" else "\x1b\\";
}

/// Writes sequences through the multiplexer around the terminal: tmux takes one DCS with every ESC
/// doubled, and GNU screen DCS chunks of at most SCREEN_PASSTHROUGH_CHUNK_SIZE bytes.
fn PassthroughWriter(comptime Writer: type) type {
    return struct {
        writer: Writer,
        multiplexer: Multiplexer,
        buffer: [SCREEN_PASSTHROUGH_CHUNK_SIZE]u8 = undefined,
        length: usize = 0,

        const Self = @This();

        fn init(writer: Writer, multiplexer: Multiplexer) !Self {
            if (multiplexer == .tmux) try writer.writeAll(ansi.ANSI.tmuxDcsStart);
            return .{ .writer = writer, .multiplexer = multiplexer };
        }

        pub fn writeAll(self: *Self, bytes: []const u8) !void {
            switch (self.multiplexer) {
                .tmux => {
                    var rest = bytes;
                    while (std.mem.findScalar(u8, rest, '\x1b')) |at| {
                        try self.writer.writeAll(rest[0..at]);
                        try self.writer.writeAll("\x1b\x1b");
                        rest = rest[at + 1 ..];
                    }
                    try self.writer.writeAll(rest);
                },
                .screen => {
                    // Screen forwards only the low byte of a code point, so its writers send ASCII.
                    for (bytes) |byte| assert(byte < 0x80);
                    var rest = bytes;
                    while (rest.len > 0) {
                        if (self.length == self.buffer.len) {
                            // An ESC that ends a full chunk starts the next one, with the byte after it.
                            const esc = self.buffer[self.length - 1] == '\x1b';
                            self.length -= @intFromBool(esc);
                            try self.flush();
                            if (esc) self.buffer[0] = '\x1b';
                            self.length = @intFromBool(esc);
                        }
                        const count = @min(rest.len, self.buffer.len - self.length);
                        @memcpy(self.buffer[self.length..][0..count], rest[0..count]);
                        self.length += count;
                        rest = rest[count..];
                    }
                },
                else => try self.writer.writeAll(bytes),
            }
        }

        pub fn writeByte(self: *Self, byte: u8) !void {
            try self.writeAll(&.{byte});
        }

        fn finish(self: *Self) !void {
            if (self.multiplexer == .tmux) try self.writer.writeAll(ansi.ANSI.tmuxDcsEnd);
            try self.flush();
        }

        fn flush(self: *Self) !void {
            if (self.length == 0) return;
            try self.writer.writeAll(ansi.ANSI.screenDcsStart);
            try self.writer.writeAll(self.buffer[0..self.length]);
            try self.writer.writeAll(ansi.ANSI.screenDcsEnd);
            self.length = 0;
        }
    };
}

fn writeClipboardBase64(writer: anytype, source: []const u8) !void {
    const source_chunk_size = 3 * 1024;
    var encoded_buffer: [4 * 1024]u8 = undefined;
    var offset: usize = 0;

    while (offset < source.len) {
        const chunk_len = @min(source.len - offset, source_chunk_size);
        const chunk = source[offset .. offset + chunk_len];
        const encoded = base64Encode(&encoded_buffer, chunk);
        try writer.writeAll(encoded);
        offset += chunk_len;
    }
}

/// Check if we can write to the clipboard (TTY and OSC 52 supported)
fn canWriteClipboard(self: *Terminal) bool {
    // In a real TTY environment, we'd check isTTY here
    // Missing or inconclusive capability responses must not block optimistic emission.
    return self.osc52_support != .unsupported;
}

/// Parse xtversion response string and extract terminal name and version
/// Examples: "kitty(0.40.1)", "ghostty 1.1.3", "tmux 3.5a"
fn parseXtversion(self: *Terminal, term_str: []const u8) void {
    if (term_str.len == 0) return;

    self.term_info.name_len = 0;
    self.term_info.version_len = 0;
    self.caps.kitty_graphics = self.kitty_graphics_queried;
    self.caps.sixel = self.sixel_queried;

    if (std.mem.find(u8, term_str, "(")) |paren_pos| {
        const name_len = @min(paren_pos, self.term_info.name.len);
        @memcpy(self.term_info.name[0..name_len], term_str[0..name_len]);
        self.term_info.name_len = name_len;

        if (std.mem.find(u8, term_str[paren_pos..], ")")) |close_offset| {
            const ver_start = paren_pos + 1;
            const ver_end = paren_pos + close_offset;
            const ver_len = @min(ver_end - ver_start, self.term_info.version.len);
            @memcpy(self.term_info.version[0..ver_len], term_str[ver_start .. ver_start + ver_len]);
            self.term_info.version_len = ver_len;
        }
    } else {
        if (std.mem.find(u8, term_str, " ")) |space_pos| {
            const name_len = @min(space_pos, self.term_info.name.len);
            @memcpy(self.term_info.name[0..name_len], term_str[0..name_len]);
            self.term_info.name_len = name_len;

            const ver_start = space_pos + 1;
            const ver_len = @min(term_str.len - ver_start, self.term_info.version.len);
            @memcpy(self.term_info.version[0..ver_len], term_str[ver_start .. ver_start + ver_len]);
            self.term_info.version_len = ver_len;
        } else {
            const name_len = @min(term_str.len, self.term_info.name.len);
            @memcpy(self.term_info.name[0..name_len], term_str[0..name_len]);
            self.term_info.name_len = name_len;
            self.term_info.version_len = 0;
        }
    }

    self.term_info.from_xtversion = true;
    self.is_foot = std.ascii.findIgnoreCase(self.getTerminalName(), "foot") != null;
    if (std.mem.eql(u8, self.getTerminalName(), "tmux")) {
        self.multiplexer = .tmux;
    } else if (std.ascii.eqlIgnoreCase(self.getTerminalName(), "Zellij")) {
        self.multiplexer = .zellij;
    } else {
        self.multiplexer = .none;
    }

    if (!self.isInZellij()) {
        if (detectNotificationProtocol(self.getTerminalName())) |protocol| {
            self.setNotificationProtocol(protocol, .xtversion);
        }
    }

    self.enforceNotificationProtocolForMultiplexer();
    self.applyKnownGraphicsIdentity();
}

pub fn isXtversionTmux(self: *Terminal) bool {
    return self.term_info.from_xtversion and std.mem.eql(u8, self.getTerminalName(), "tmux");
}

pub fn isXtversionZellij(self: *Terminal) bool {
    return self.term_info.from_xtversion and std.ascii.eqlIgnoreCase(self.getTerminalName(), "Zellij");
}

pub fn isInTmux(self: *Terminal) bool {
    return self.multiplexer == .tmux;
}

pub fn isInZellij(self: *Terminal) bool {
    return self.multiplexer == .zellij;
}

pub fn isInScreen(self: *Terminal) bool {
    return self.multiplexer == .screen;
}

/// GNU screen, also behind ssh started inside it, where the forwarded TERM names screen but STY is gone.
/// A screen TERM inside tmux is tmux; screen swallows XTVERSION, so a tmux reply means tmux is innermost.
fn insideScreen(self: *Terminal) bool {
    if (self.isXtversionTmux()) return false;
    const env = self.opts.env_map orelse return false;
    return env.get("STY") != null or (env.get("TMUX") == null and std.mem.startsWith(u8, env.get("TERM") orelse "", "screen"));
}

pub fn getTerminalInfo(self: *Terminal) TerminalInfo {
    return self.term_info;
}

pub fn getTerminalName(self: *Terminal) []const u8 {
    return self.term_info.name[0..self.term_info.name_len];
}

/// Forced Sixel bypasses detection. Refuse it when the direct endpoint cannot
/// be a Sixel host. Under tmux the passthrough endpoint is unknown, so the
/// explicit override is authoritative. Apple Terminal has no XTVERSION, so
/// TERM_PROGRAM is the only identity.
pub fn refusesForcedSixel(self: *Terminal) bool {
    if (self.isInTmux()) return false;
    if (self.caps.sixel) return false;
    if (self.term_info.from_xtversion) {
        if (self.multiplexer != .none) return true;
        return std.ascii.eqlIgnoreCase(self.getTerminalName(), "kitty");
    }
    return std.ascii.eqlIgnoreCase(self.getTerminalName(), "Apple_Terminal");
}

pub fn getTerminalVersion(self: *Terminal) []const u8 {
    return self.term_info.version[0..self.term_info.version_len];
}

/// Discard input that the terminal queued on process stdin and the host has not read, such as mouse reports sent
/// before mouse tracking was disabled. Best effort: a no-op when stdin is not a terminal.
pub fn flushInput() void {
    if (builtin.os.tag == .windows) {
        const WindowsConsole = struct {
            extern "kernel32" fn GetStdHandle(handle: std.os.windows.DWORD) callconv(.winapi) std.os.windows.HANDLE;
            extern "kernel32" fn FlushConsoleInputBuffer(handle: std.os.windows.HANDLE) callconv(.winapi) std.os.windows.BOOL;
        };
        const stdin_handle = WindowsConsole.GetStdHandle(@bitCast(@as(i32, -10)));
        _ = WindowsConsole.FlushConsoleInputBuffer(stdin_handle);
        return;
    }
    const tciflush: c_int = switch (builtin.os.tag) {
        .linux => 0,
        .macos => 1,
        else => return,
    };
    const PosixTerminal = struct {
        extern "c" fn tcflush(fd: c_int, queue_selector: c_int) c_int;
    };
    _ = PosixTerminal.tcflush(0, tciflush);
}
