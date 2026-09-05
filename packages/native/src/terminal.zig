const std = @import("std");
const builtin = @import("builtin");
const atomic = std.atomic;
const assert = std.debug.assert;
const ansi = @import("ansi.zig");
const utf8 = @import("utf8.zig");

const WidthMethod = utf8.WidthMethod;

/// Terminal capability detection and management
pub const Terminal = @This();

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

pub const CursorStyle = enum {
    block,
    line,
    underline,
    default,
};

pub const MousePointerStyle = enum(u8) {
    default = 0,
    pointer = 1,
    text = 2,
    crosshair = 3,
    move = 4,
    not_allowed = 5,

    pub fn toName(self: MousePointerStyle) []const u8 {
        return if (self == .not_allowed) "not-allowed" else @tagName(self);
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
    // Kitty keyboard protocol flags (progressive enhancement):
    // See: https://sw.kovidgoyal.net/kitty/keyboard-protocol/#progressive-enhancement
    // Bit 0 (0b1):     Disambiguate escape codes (fixes ESC timing, alt+key ambiguity, ctrl+c as event)
    // Bit 1 (0b10):    Report event types (press/repeat/release)
    // Bit 2 (0b100):   Report alternate keys (e.g., numpad vs regular, shifted, base layout)
    // Bit 3 (0b1000):  Report all keys as escape codes
    // Bit 4 (0b10000): Report text associated with key events
    // Default 0b00101 (5) = disambiguate + alternate keys
    // Use 0b00111 (7) to also enable event types for key release detection
    kitty_keyboard_flags: u8 = 0b00101,
    remote_mode: RemoteMode = .local,
    // Optional forwarded environment values. Caller owns the map.
    env_map: ?*const std.process.Environ.Map = null,
};

pub const TerminalInfo = struct {
    name: [64]u8 = [_]u8{0} ** 64,
    name_len: usize = 0,
    version: [32]u8 = [_]u8{0} ** 32,
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
graphics_query_pending: bool = false,
sixel_query_pending: bool = false,
capability_queries_pending: bool = false,
startup_cursor_query_pending: bool = false,
startup_cursor_query_captured: bool = false,
explicit_width_probe_reports_pending: u8 = 0,
unicode_wide_locked: ?bool = null,

state: struct {
    alt_screen: bool = false,
    kitty_keyboard: bool = false,
    kitty_keyboard_flags: u8 = 0,
    bracketed_paste: bool = false,
    mouse: bool = false,
    mouse_movement: bool = true,
    mouse_was_enabled: bool = false,
    pixel_mouse: bool = false,
    color_scheme_updates: bool = false,
    theme_queries_sent: bool = false,
    focus_tracking: bool = false,
    modify_other_keys: bool = false,
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

pub fn resetState(self: *Terminal, tty: anytype) !void {
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

    if (self.state.alt_screen) {
        try self.exitAltScreen(tty);
    } else {
        switch (builtin.os.tag) {
            .windows => {
                try tty.writeByte('\r');
                var i: u16 = 0;
                while (i < self.state.cursor.row) : (i += 1) {
                    try tty.writeAll(ansi.ANSI.reverseIndex);
                }
                try tty.writeAll(ansi.ANSI.eraseBelowCursor);
            },
            else => {},
        }
    }

    if (self.state.color_scheme_updates) {
        try self.setColorSchemeUpdates(tty, false);
    }

    self.setTerminalTitle(tty, "");

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
    const is_tmux = self.isInTmux();
    self.unicode_wide_locked = self.caps.unicode == .unicode_wide;
    self.graphics_query_pending = !self.skip_graphics_query and !is_tmux;
    self.sixel_query_pending = !self.skip_graphics_query and !is_tmux;
    self.capability_queries_pending = false;
    self.startup_cursor_query_pending = true;
    self.startup_cursor_query_captured = false;

    // We intentionally do not send CSI ?996n here. Terminals disagree on the
    // meaning and reliability of the ?997 reply, so startup theme detection is
    // derived from fresh OSC 10/11 fg/bg colors instead.
    try self.setColorSchemeUpdates(tty, true);

    try self.queryThemeColors(tty);
    self.state.theme_queries_sent = true;

    // Send xtversion first (doesn't need DCS wrapping - used for tmux detection)
    try tty.writeAll(ansi.ANSI.xtversion ++
        ansi.ANSI.hideCursor ++
        ansi.ANSI.saveCursorState);

    // Capture the current cursor position before temporary home-position queries.
    try tty.writeAll(ansi.ANSI.cursorPositionRequest);

    if (is_tmux) {
        if (self.is_foot) {
            try tty.writeAll(ansi.ANSI.capabilityQueriesFootIsBroken);
        } else {
            try tty.writeAll(ansi.ANSI.capabilityQueries);
        }
    } else {
        if (self.is_foot) {
            try tty.writeAll(ansi.ANSI.capabilityQueriesFootIsBroken);
        } else {
            try tty.writeAll(ansi.ANSI.capabilityQueries);
        }
        self.capability_queries_pending = true;
    }

    if (!self.skip_graphics_query) {
        if (is_tmux) {
            // tmux can answer DA for its virtual terminal. A passthrough Kitty
            // reply has no pane ownership and may reach a different active pane.
            try tty.writeAll(ansi.ANSI.primaryDeviceAttrs);
        } else {
            try tty.writeAll(ansi.ANSI.kittyGraphicsQuery);
            try tty.writeAll(ansi.ANSI.primaryDeviceAttrs);
        }
    }

    if (!self.skip_explicit_width_query) {
        self.explicit_width_probe_reports_pending = 2;
        try tty.writeAll(ansi.ANSI.home ++
            ansi.ANSI.explicitWidthQuery ++
            ansi.ANSI.cursorPositionRequest ++
            ansi.ANSI.home ++
            ansi.ANSI.scaledTextQuery ++
            ansi.ANSI.cursorPositionRequest);
    } else {
        self.explicit_width_probe_reports_pending = 0;
    }

    try tty.writeAll(ansi.ANSI.restoreCursorState);
}

pub fn sendPendingQueries(self: *Terminal, _: anytype) !bool {
    if (!self.term_info.from_xtversion) return false;

    // Startup already queried either the direct terminal or tmux's virtual
    // terminal. Never retry through passthrough: replies are not pane-scoped.
    self.capability_queries_pending = false;
    self.graphics_query_pending = false;
    self.sixel_query_pending = false;

    return false;
}

pub fn enableDetectedFeatures(self: *Terminal, tty: anytype, use_kitty_keyboard: bool) !void {
    if (builtin.os.tag == .windows) {
        // Windows-specific defaults for ConPTY
        self.caps.rgb = true;
        self.caps.ansi256 = true;
        self.caps.bracketed_paste = true;
    }

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

    if ((self.caps.unicode == .unicode or self.caps.unicode == .unicode_wide) and !self.caps.explicit_width) {
        try tty.writeAll(ansi.ANSI.unicodeSet);
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
        std.ascii.findIgnoreCase(value, "windows_terminal") != null)
    {
        return .osc777;
    }

    // OSC 9 is the iTerm2 notification sequence. ConEmu also uses OSC 9 for
    // multiple extensions, so use it only for terminal families with documented
    // notification support rather than as a generic fallback.
    if (std.ascii.findIgnoreCase(value, "iterm") != null or
        std.ascii.findIgnoreCase(value, "Apple_Terminal") != null or
        std.ascii.findIgnoreCase(value, "Terminal.app") != null or
        std.ascii.findIgnoreCase(value, "conemu") != null)
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

fn checkEnvironmentOverrides(self: *Terminal) void {
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

    // Always just try to enable bracketed paste, even if it was reported as not supported
    self.caps.bracketed_paste = true;

    if (self.caps.rgb) {
        self.caps.ansi256 = true;
    }

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

    const env_is_forwarded = if (self.host_env_map) |*host_env_map| env_map == host_env_map else false;
    self.applyKnownUnicodeWidthIdentity();
    if (self.opts.remote_mode == .auto and self.remote and env_is_forwarded) {
        return;
    }

    if (!self.term_info.from_xtversion) {
        if (env_map.get("TMUX")) |_| {
            self.multiplexer = .tmux;
            self.caps.unicode = .wcwidth;
            self.caps.explicit_cursor_positioning = true;
        } else if (env_map.get("ZELLIJ") != null or env_map.get("ZELLIJ_SESSION_NAME") != null or env_map.get("ZELLIJ_PANE_ID") != null) {
            self.multiplexer = .zellij;
            if (self.term_info.name_len == 0) {
                const name = "Zellij";
                @memcpy(self.term_info.name[0..name.len], name);
                self.term_info.name_len = name.len;
            }
        } else if (env_map.get("STY") != null) {
            self.multiplexer = .screen;
            self.skip_graphics_query = true;
            self.caps.unicode = .wcwidth;
            self.caps.explicit_cursor_positioning = true;
        } else if (env_map.get("TERM")) |term| {
            if (std.mem.startsWith(u8, term, "tmux")) {
                self.multiplexer = .tmux;
                self.caps.unicode = .wcwidth;
                self.caps.explicit_cursor_positioning = true;
            } else if (std.mem.startsWith(u8, term, "screen")) {
                self.multiplexer = .screen;
                self.skip_graphics_query = true;
                self.caps.unicode = .wcwidth;
                self.caps.explicit_cursor_positioning = true;
            }
            if (std.mem.find(u8, term, "alacritty") != null) {
                self.caps.explicit_cursor_positioning = true;
            }
        }
    }

    if (env_map.get("TERM")) |term| {
        if (std.ascii.findIgnoreCase(term, "256color") != null) {
            self.caps.ansi256 = true;
        }
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
                self.caps.unicode = .wcwidth;
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
        }

        if (env_map.get("TERM_PROGRAM")) |prog| {
            if (std.mem.eql(u8, prog, "vscode")) {
                self.caps.kitty_keyboard = false;
                self.caps.kitty_graphics = false;
                self.caps.unicode = .unicode;
            } else if (std.mem.eql(u8, prog, "Apple_Terminal")) {
                self.caps.unicode = .wcwidth;
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

    if (env_map.get("COLORTERM")) |colorterm| {
        if (std.mem.eql(u8, colorterm, "truecolor") or
            std.mem.eql(u8, colorterm, "24bit"))
        {
            self.caps.rgb = true;
            self.caps.ansi256 = true;
        }
    }

    if (env_map.get("WT_SESSION") != null) {
        self.caps.rgb = true;
        self.caps.ansi256 = true;
        if (builtin.os.tag == .windows and !self.term_info.from_xtversion and self.multiplexer == .none) {
            self.caps.hyperlinks = true;
        }
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

    if (!self.term_info.from_xtversion) {
        if (env_map.get("TERMUX_VERSION")) |_| {
            self.caps.unicode = .wcwidth;
        }

        if (env_map.get("VHS_RECORD")) |_| {
            self.caps.unicode = .wcwidth;
            self.caps.kitty_keyboard = false;
            self.caps.kitty_graphics = false;
        }
    }

    self.applyKnownUnicodeWidthIdentity();

    if (env_map.get("OPENTUI_FORCE_WCWIDTH")) |_| {
        self.caps.unicode = .wcwidth;
    }
    if (env_map.get("OPENTUI_FORCE_UNICODE")) |_| {
        self.caps.unicode = .unicode;
    }
    if (env_map.get("OPENTUI_FORCE_NOZWJ")) |_| {
        self.caps.unicode = .no_zwj;
    }

    if (env_map.get("OPENTUI_FORCE_EXPLICIT_WIDTH")) |val| {
        if (std.mem.eql(u8, val, "true") or std.mem.eql(u8, val, "1")) {
            self.caps.explicit_width = true;
        } else if (std.mem.eql(u8, val, "false") or std.mem.eql(u8, val, "0")) {
            self.caps.explicit_width = false;
            self.skip_explicit_width_query = true;
        }
    }

    if (self.is_foot and self.multiplexer != .none) {
        self.caps.hyperlinks = false;
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

    if (!self.caps.hyperlinks and !self.term_info.from_xtversion) {
        const is_wsl = env_map.get("WSL_DISTRO_NAME") != null or env_map.get("WSL_INTEROP") != null;
        const has_wt_session = env_map.get("WT_SESSION") != null;
        if (is_wsl and has_wt_session) {
            if (env_map.get("TERM")) |term| {
                if (std.mem.startsWith(u8, term, "xterm")) {
                    self.caps.hyperlinks = true;
                }
            }
        }
    }

    if (!self.caps.osc52 and !self.term_info.from_xtversion) {
        if (env_map.get("WT_SESSION") != null) {
            self.caps.osc52 = true;
        }

        if (!self.caps.osc52 and (self.isInTmux() or self.isInScreen() or env_map.get("STY") != null)) {
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
        // Arms the shutdown cleanup path so resetState() will still emit mouse
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

pub fn setKittyKeyboard(self: *Terminal, tty: anytype, enable: bool, flags: u8) !void {
    if (enable) {
        if (!self.state.kitty_keyboard) {
            try tty.print(ansi.ANSI.csiUPush, .{flags});
            self.state.kitty_keyboard = true;
            self.state.kitty_keyboard_flags = flags;
        }
    } else {
        if (self.state.kitty_keyboard) {
            try tty.writeAll(ansi.ANSI.csiUPop);
            self.state.kitty_keyboard = false;
            self.state.kitty_keyboard_flags = 0;
        }
    }
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
        try tty.writeAll(ansi.ANSI.csiUPop);
        try tty.print(ansi.ANSI.csiUPush, .{self.state.kitty_keyboard_flags});
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

fn parseSixelDeviceAttributes(self: *Terminal, response: []const u8) void {
    // Inside tmux, an unwrapped DA response describes tmux's virtual terminal,
    // not the outer terminal that receives passthrough Sixel output.
    if (!self.graphics_enabled or self.isInTmux()) return;
    var offset: usize = 0;
    while (std.mem.findPos(u8, response, offset, "\x1b[?")) |start| {
        var end = start + 3;
        while (end < response.len and (std.ascii.isDigit(response[end]) or response[end] == ';')) : (end += 1) {}
        if (end >= response.len) return;
        if (response[end] != 'c') {
            offset = end + 1;
            continue;
        }
        var params = std.mem.splitScalar(u8, response[start + 3 .. end], ';');
        while (params.next()) |param| {
            if (std.mem.eql(u8, param, "4")) {
                self.sixel_queried = true;
                self.caps.sixel = true;
                return;
            }
        }
        offset = end + 1;
    }
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

fn applyKnownUnicodeWidthIdentity(self: *Terminal) void {
    if (self.unicode_wide_locked) |enabled| {
        if (enabled) {
            self.caps.unicode = .unicode_wide;
        }
        return;
    }

    if (self.caps.unicode == .unicode_wide) {
        self.caps.unicode = .unicode;
    }
    if (self.remote or self.multiplexer != .none) return;
    const env_map = self.opts.env_map orelse return;
    const term_program = env_map.get("TERM_PROGRAM") orelse return;
    if (!std.ascii.eqlIgnoreCase(term_program, "ghostty")) return;
    const version = env_map.get("TERM_PROGRAM_VERSION") orelse return;
    if (!ghosttyWideGraphemeWidths(version)) return;
    if (self.term_info.from_xtversion and !std.ascii.eqlIgnoreCase(self.getTerminalName(), "ghostty")) return;
    self.caps.unicode = .unicode_wide;
}

pub fn processCapabilityResponse(self: *Terminal, response: []const u8) void {
    self.parseOsc99NotificationQuery(response);
    self.parseItermCapabilities(response);
    self.parseXtgettcapMs(response);
    self.parseKittyGraphicsResponse(response);
    self.parseSixelDeviceAttributes(response);

    // DECRPM responses
    if (std.mem.find(u8, response, "1016;2$y")) |_| {
        self.caps.sgr_pixels = true;
    }
    if (std.mem.find(u8, response, "2027;2$y")) |_| {
        self.caps.unicode = .unicode;
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
        } else if (self.explicit_width_probe_reports_pending > 0) {
            const probe_index = 2 - self.explicit_width_probe_reports_pending;
            self.explicit_width_probe_reports_pending -= 1;

            if (row == 1 and probe_index == 0 and col == 2) {
                self.caps.explicit_width = true;
            } else if (row == 1 and probe_index == 1 and col == 3) {
                self.caps.explicit_width = true;
                self.caps.scaled_text = true;
            }
        }

        scan_pos = pos + 1;
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
        self.caps.unicode = .unicode;
        self.caps.rgb = true;
        self.caps.ansi256 = true;
        self.caps.bracketed_paste = true;
        self.caps.hyperlinks = true;
    }

    // Kitty keyboard protocol detection via CSI ? u response
    // Terminals supporting the protocol respond to CSI ? u with CSI ? <flags> u
    // Examples: \x1b[?0u (ghostty, alacritty), \x1b[?1u, etc.
    if (std.mem.find(u8, response, "\x1b[?") != null and std.mem.find(u8, response, "u") != null) {
        // Look for pattern \x1b[?Nu where N is 0-31
        var i: usize = 0;
        while (i + 4 < response.len) : (i += 1) {
            if (response[i] == '\x1b' and i + 1 < response.len and response[i + 1] == '[' and i + 2 < response.len and response[i + 2] == '?') {
                var num_end = i + 3;
                while (num_end < response.len and response[num_end] >= '0' and response[num_end] <= '9') : (num_end += 1) {}
                if (num_end > i + 3 and num_end < response.len and response[num_end] == 'u') {
                    self.caps.kitty_keyboard = true;
                    break;
                }
            }
        }
    }

    if (std.mem.find(u8, response, "tmux")) |_| {
        self.caps.unicode = .wcwidth;
        self.caps.explicit_cursor_positioning = true;
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

    if (self.isInTmux()) {
        // Graphics replies inside tmux either have no pane ownership (Kitty
        // passthrough) or describe tmux itself rather than the passthrough
        // endpoint (DA/Sixel). Neither can select an outer image protocol.
        self.kitty_graphics_queried = false;
        self.caps.kitty_graphics = false;
        self.sixel_queried = false;
        self.caps.sixel = false;
    }
}

fn parseXtgettcapMs(self: *Terminal, response: []const u8) void {
    const prefix = "\x1bP";
    var scan_pos: usize = 0;
    while (std.mem.findPos(u8, response, scan_pos, prefix)) |start| {
        const body_start = start + prefix.len;
        const end = std.mem.findPos(u8, response, body_start, "\x1b\\") orelse return;
        const body = response[body_start..end];
        scan_pos = end + 2;

        if (body.len < 6 or body[0] != '1') continue;
        if (!std.mem.eql(u8, body[1..3], "+r")) continue;

        const result = body[3..];
        const separator = std.mem.findScalar(u8, result, '=') orelse continue;
        if (!std.ascii.eqlIgnoreCase(result[0..separator], "4d73")) continue;

        const value = result[separator + 1 ..];
        if (value.len == 0 or value.len % 2 != 0) continue;
        for (value) |byte| {
            if (!std.ascii.isHex(byte)) break;
        } else {
            self.osc52_support = .supported;
            self.caps.osc52 = true;
        }
    }
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
        std.ascii.findIgnoreCase(value, "iterm") != null;
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

pub fn setTerminalTitle(_: *Terminal, tty: anytype, title: []const u8) void {
    // For Windows, we might need to use different approach, but ANSI sequences work in Windows Terminal, ConPTY, etc.
    // For other platforms, ANSI OSC sequences work reliably
    ansi.ANSI.setTerminalTitleOutput(tty, title) catch {};
}

fn writePassthroughSequence(self: *Terminal, tty: anytype, sequence: []const u8) !void {
    const is_tmux = self.isInTmux();
    if (is_tmux) {
        try tty.writeAll(ansi.ANSI.tmuxDcsStart);
        for (sequence) |c| {
            if (c == '\x1b') try tty.writeByte('\x1b');
            try tty.writeByte(c);
        }
        try tty.writeAll(ansi.ANSI.tmuxDcsEnd);
        return;
    }

    if (!self.remote) {
        if (self.opts.env_map) |map| {
            if (map.get("STY") != null) {
                try tty.writeAll(ansi.ANSI.screenDcsStart);
                for (sequence) |c| {
                    if (c == '\x1b') try tty.writeByte('\x1b');
                    try tty.writeByte(c);
                }
                try tty.writeAll(ansi.ANSI.screenDcsEnd);
                return;
            }
        }
    }

    try tty.writeAll(sequence);
}

fn writeSanitizedNotificationText(writer: anytype, text: []const u8, replace_semicolon: bool) !void {
    for (text) |c| {
        if (c < 0x20 or c == 0x7f or c == '\x1b' or (replace_semicolon and c == ';')) {
            try writer.writeByte(' ');
        } else {
            try writer.writeByte(c);
        }
    }
}

fn writeOsc99Payload(allocator: std.mem.Allocator, writer: anytype, id: []const u8, payload_type: []const u8, payload: []const u8, done: bool) !void {
    const encoded_len = std.base64.standard.Encoder.calcSize(payload.len);
    const encoded_buf = try allocator.alloc(u8, encoded_len);
    defer allocator.free(encoded_buf);
    const encoded = std.base64.standard.Encoder.encode(encoded_buf, payload);

    try writer.print("\x1b]99;i={s}:p={s}:e=1:d={d};", .{ id, payload_type, @intFromBool(done) });
    try writer.writeAll(encoded);
    try writer.writeAll("\x1b\\");
}

pub fn writeNotification(self: *Terminal, allocator: std.mem.Allocator, tty: anytype, message: []const u8, title: ?[]const u8) !bool {
    if (!self.caps.notifications or self.notification_protocol == .none) {
        return false;
    }

    self.notification_id_counter +%= 1;

    var buffer: std.Io.Writer.Allocating = .init(allocator);
    defer buffer.deinit();
    const writer = &buffer.writer;

    switch (self.notification_protocol) {
        .none => return false,
        .osc99 => {
            const id = try std.fmt.allocPrint(allocator, "opentui-{d}", .{self.notification_id_counter});
            defer allocator.free(id);

            if (title) |notification_title| {
                if (notification_title.len > 0) {
                    try writeOsc99Payload(allocator, writer, id, "title", notification_title, false);
                    try writeOsc99Payload(allocator, writer, id, "body", message, true);
                } else {
                    try writeOsc99Payload(allocator, writer, id, "body", message, true);
                }
            } else {
                try writeOsc99Payload(allocator, writer, id, "body", message, true);
            }
        },
        .osc777 => {
            try writer.writeAll("\x1b]777;notify;");
            if (title) |notification_title| {
                try writeSanitizedNotificationText(writer, notification_title, true);
                try writer.writeByte(';');
                try writeSanitizedNotificationText(writer, message, true);
            } else {
                try writeSanitizedNotificationText(writer, message, true);
                try writer.writeByte(';');
            }
            try writer.writeAll("\x1b\\");
        },
        .osc9 => {
            try writer.writeAll("\x1b]9;");
            if (title) |notification_title| {
                if (notification_title.len > 0) {
                    try writeSanitizedNotificationText(writer, notification_title, false);
                    try writer.writeAll(": ");
                }
            }
            try writeSanitizedNotificationText(writer, message, false);
            try writer.writeAll("\x1b\\");
        },
    }

    try self.writePassthroughSequence(tty, buffer.written());
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

    if (self.isInTmux()) {
        try tty.writeAll(ansi.ANSI.tmuxDcsStart);
        try writeClipboardSequence(tty, target, text_utf8, true, "\x1b\\");
        try tty.writeAll(ansi.ANSI.tmuxDcsEnd);
        return;
    }

    if (self.isInScreen()) {
        var screen_writer = ScreenPassthroughWriter(@TypeOf(tty)).init(tty);
        try writeClipboardSequence(&screen_writer, target, text_utf8, false, "\x07");
        try screen_writer.finish();
        return;
    }

    try writeClipboardSequence(tty, target, text_utf8, false, "\x1b\\");
}

fn ScreenPassthroughWriter(comptime Writer: type) type {
    return struct {
        writer: Writer,
        buffer: [SCREEN_PASSTHROUGH_CHUNK_SIZE]u8 = undefined,
        length: usize = 0,

        const Self = @This();

        fn init(writer: Writer) Self {
            return .{ .writer = writer };
        }

        pub fn writeAll(self: *Self, bytes: []const u8) !void {
            for (bytes) |byte| try self.writeByte(byte);
        }

        pub fn writeByte(self: *Self, byte: u8) !void {
            if (self.length == self.buffer.len) try self.flush();
            self.buffer[self.length] = byte;
            self.length += 1;
        }

        fn finish(self: *Self) !void {
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

fn writeClipboardSequence(writer: anytype, target: ClipboardTarget, text_utf8: []const u8, escape: bool, terminator: []const u8) !void {
    try writeClipboardBytes(writer, "\x1b]52;", escape);
    try writer.writeByte(target.toChar());
    try writer.writeByte(';');
    try writeClipboardBase64(writer, text_utf8);
    try writeClipboardBytes(writer, terminator, escape);
}

fn writeClipboardBase64(writer: anytype, source: []const u8) !void {
    const source_chunk_size = 3 * 1024;
    var encoded_buffer: [4 * 1024]u8 = undefined;
    var offset: usize = 0;

    while (offset < source.len) {
        const chunk_len = @min(source.len - offset, source_chunk_size);
        const chunk = source[offset .. offset + chunk_len];
        const encoded = std.base64.standard.Encoder.encode(&encoded_buffer, chunk);
        try writer.writeAll(encoded);
        offset += chunk_len;
    }
}

fn writeClipboardBytes(writer: anytype, bytes: []const u8, escape: bool) !void {
    if (!escape) {
        try writer.writeAll(bytes);
        return;
    }

    for (bytes) |byte| {
        if (byte == '\x1b') try writer.writeByte('\x1b');
        try writer.writeByte(byte);
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
    // tmux's outer terminal is intentionally not probed because replies are
    // not pane-scoped. An explicit override is therefore the authority; tmux's
    // own DA response must neither authorize nor reject passthrough output.
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
