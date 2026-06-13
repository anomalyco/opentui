const std = @import("std");
const builtin = @import("builtin");
const testing = std.testing;
const ansi = @import("../ansi.zig");
const Terminal = @import("../terminal.zig");
const utf8 = @import("../utf8.zig");

test "parseXtversion - kitty format" {
    var term = Terminal.init(.{});
    const response = "\x1bP>|kitty(0.40.1)\x1b\\";
    term.processCapabilityResponse(response);

    try testing.expectEqualStrings("kitty", term.getTerminalName());
    try testing.expectEqualStrings("0.40.1", term.getTerminalVersion());
    try testing.expect(term.term_info.from_xtversion);
    try testing.expect(term.caps.osc52);
}

test "parseXtversion - ghostty format" {
    var term = Terminal.init(.{});
    const response = "\x1bP>|ghostty 1.1.3\x1b\\";
    term.processCapabilityResponse(response);

    try testing.expectEqualStrings("ghostty", term.getTerminalName());
    try testing.expectEqualStrings("1.1.3", term.getTerminalVersion());
    try testing.expect(term.term_info.from_xtversion);
    try testing.expect(term.caps.osc52);
}

test "parseXtversion - tmux format" {
    var term = Terminal.init(.{});
    const response = "\x1bP>|tmux 3.5a\x1b\\";
    term.processCapabilityResponse(response);

    try testing.expectEqualStrings("tmux", term.getTerminalName());
    try testing.expectEqualStrings("3.5a", term.getTerminalVersion());
    try testing.expect(term.term_info.from_xtversion);
    try testing.expectEqual(Terminal.Multiplexer.tmux, term.multiplexer);
    try testing.expect(term.caps.osc52);
}

test "parseXtversion - with prefix data" {
    var term = Terminal.init(.{});
    const response = "\x1b[1;1R\x1bP>|tmux 3.5a\x1b\\";
    term.processCapabilityResponse(response);

    try testing.expectEqualStrings("tmux", term.getTerminalName());
    try testing.expectEqualStrings("3.5a", term.getTerminalVersion());
    try testing.expect(term.term_info.from_xtversion);
}

test "parseXtversion - full kitty response" {
    var term = Terminal.init(.{});
    const response = "\x1b[?1016;2$y\x1b[?2027;0$y\x1b[?2031;2$y\x1b[?1004;1$y\x1b[?2026;2$y\x1b[1;2R\x1b[1;3R\x1bP>|kitty(0.40.1)\x1b\\\x1b[?0u\x1b_Gi=1;EINVAL:Zero width/height not allowed\x1b\\\x1b[?62;c";
    term.processCapabilityResponse(response);

    try testing.expectEqualStrings("kitty", term.getTerminalName());
    try testing.expectEqualStrings("0.40.1", term.getTerminalVersion());
    try testing.expect(term.term_info.from_xtversion);
    try testing.expect(term.caps.kitty_keyboard);
    try testing.expect(term.caps.kitty_graphics);
    try testing.expect(term.caps.osc52);
}

test "parseXtversion - full ghostty response" {
    var term = Terminal.init(.{});
    const response = "\x1b[?1016;1$y\x1b[?2027;1$y\x1b[?2031;2$y\x1b[?1004;1$y\x1b[?2004;2$y\x1b[?2026;2$y\x1b[1;1R\x1b[1;1R\x1bP>|ghostty 1.1.3\x1b\\\x1b[?0u\x1b_Gi=1;OK\x1b\\\x1b[?62;22c";
    term.processCapabilityResponse(response);

    try testing.expectEqualStrings("ghostty", term.getTerminalName());
    try testing.expectEqualStrings("1.1.3", term.getTerminalVersion());
    try testing.expect(term.term_info.from_xtversion);
}

test "notifications - OSC99 query response enables OSC99 protocol" {
    var term = Terminal.init(.{});

    term.processCapabilityResponse("\x1b]99;i=opentui-notifications:p=?;p=title,body:o=always:u=0,1,2\x1b\\");

    try testing.expect(term.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.osc99, term.notification_protocol);
}

test "notifications - OSC99 query response ignores mismatched identifier" {
    var term = Terminal.init(.{ .remote_mode = .remote });

    term.processCapabilityResponse("\x1b]99;i=other:p=?;p=title,body\x1b\\");

    try testing.expect(!term.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.none, term.notification_protocol);
}

test "notifications - iTerm2 feature reporting enables OSC9 protocol" {
    var term = Terminal.init(.{});

    term.processCapabilityResponse("\x1b]1337;Capabilities=T2NoH\x1b\\");

    try testing.expect(term.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.osc9, term.notification_protocol);
}

test "notifications - iTerm2 feature reporting without No leaves disabled" {
    var term = Terminal.init(.{ .remote_mode = .remote });

    term.processCapabilityResponse("\x1b]1337;Capabilities=T2H\x1b\\");

    try testing.expect(!term.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.none, term.notification_protocol);
}

test "notifications - xtversion heuristics prefer documented protocols" {
    var kitty = Terminal.init(.{});
    kitty.processCapabilityResponse("\x1bP>|kitty(0.46.2)\x1b\\");
    try testing.expect(kitty.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.osc99, kitty.notification_protocol);

    var ghostty = Terminal.init(.{});
    ghostty.processCapabilityResponse("\x1bP>|ghostty 1.3.1\x1b\\");
    try testing.expect(ghostty.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.osc777, ghostty.notification_protocol);

    var iterm = Terminal.init(.{});
    iterm.processCapabilityResponse("\x1bP>|iTerm2 3.6.9\x1b\\");
    try testing.expect(iterm.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.osc9, iterm.notification_protocol);
}

test "notifications - TERM_FEATURES enables OSC9 protocol" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("TERM_FEATURES", "T2NoH");

    const term = Terminal.init(.{ .env_map = &env });

    try testing.expect(term.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.osc9, term.notification_protocol);
}

test "notifications - Zellij env suppresses inherited host notification heuristics" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("ZELLIJ", "0");
    try env.put("ZELLIJ_PANE_ID", "1");
    try env.put("TERM", "xterm-256color");
    try env.put("TERM_PROGRAM", "ghostty");
    try env.put("WT_SESSION", "outer-windows-terminal-session");
    try env.put("TERM_FEATURES", "T2NoH");

    var term = Terminal.init(.{ .env_map = &env });

    try testing.expectEqual(Terminal.Multiplexer.zellij, term.multiplexer);
    try testing.expectEqualStrings("Zellij", term.getTerminalName());
    try testing.expect(!term.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.none, term.notification_protocol);

    term.processCapabilityResponse("\x1b]1337;Capabilities=T2NoH\x1b\\");
    try testing.expect(!term.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.none, term.notification_protocol);

    term.processCapabilityResponse("\x1b]99;i=opentui-notifications:p=?;p=title,body:o=always\x1b\\");
    try testing.expect(term.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.osc99, term.notification_protocol);
}

test "notifications - Zellij XTVERSION overrides inherited tmux and clears heuristics" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("TMUX", "/tmp/tmux-1000/default,12345,0");
    try env.put("TERM", "screen-256color");
    try env.put("TERM_PROGRAM", "ghostty");

    var term = Terminal.init(.{ .env_map = &env });
    try testing.expectEqual(Terminal.Multiplexer.tmux, term.multiplexer);
    try testing.expect(term.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.osc777, term.notification_protocol);

    term.processCapabilityResponse("\x1bP>|Zellij(0.44.1)\x1b\\");
    try testing.expectEqual(Terminal.Multiplexer.zellij, term.multiplexer);
    try testing.expectEqualStrings("Zellij", term.getTerminalName());
    try testing.expectEqualStrings("0.44.1", term.getTerminalVersion());
    try testing.expect(!term.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.none, term.notification_protocol);

    term.processCapabilityResponse("\x1b]99;i=opentui-notifications:p=?;p=title,body:o=always\x1b\\");
    try testing.expect(term.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.osc99, term.notification_protocol);
}

test "notifications - explicit protocol override works in tmux" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("TMUX", "/tmp/tmux-1000/default,12345,0");
    try env.put("TERM", "screen-256color");
    try env.put("OPENTUI_NOTIFICATION_PROTOCOL", "osc9");

    const term = Terminal.init(.{ .env_map = &env });

    try testing.expectEqual(Terminal.Multiplexer.tmux, term.multiplexer);
    try testing.expect(term.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.osc9, term.notification_protocol);
}

test "notifications - explicit disable blocks later queries" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("OPENTUI_NOTIFICATION_PROTOCOL", "none");

    var term = Terminal.init(.{ .env_map = &env });
    try testing.expect(!term.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.none, term.notification_protocol);

    term.processCapabilityResponse("\x1b]99;i=opentui-notifications:p=?;p=title,body:o=always\x1b\\");
    try testing.expect(!term.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.none, term.notification_protocol);
}

test "remote detection - auto mode detects SSH environment" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("SSH_CONNECTION", "192.0.2.1 54231 192.0.2.2 22");

    const term = Terminal.init(.{ .remote_mode = .auto, .env_map = &env });

    try testing.expect(term.remote);
    try testing.expect(term.caps.remote);
}

test "remote detection - auto mode detects mosh environment" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("MOSH_CONNECTION", "192.0.2.1 60001");

    const term = Terminal.init(.{ .remote_mode = .auto, .env_map = &env });

    try testing.expect(term.remote);
    try testing.expect(term.caps.remote);
}

test "remote detection - explicit local mode ignores SSH environment" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("SSH_TTY", "/dev/pts/1");

    const term = Terminal.init(.{ .remote_mode = .local, .env_map = &env });

    try testing.expect(!term.remote);
    try testing.expect(!term.caps.remote);
}

test "processCapabilityResponse captures startup cursor report before home probes" {
    var term = Terminal.init(.{});
    term.startup_cursor_query_pending = true;
    term.startup_cursor_query_captured = false;

    term.processCapabilityResponse("\x1b[7;11R\x1b[1;2R\x1b[1;3R");

    const cursor = term.getCursorPosition();
    try testing.expectEqual(@as(u32, 11), cursor.x);
    try testing.expectEqual(@as(u32, 7), cursor.y);
    try testing.expect(term.startup_cursor_query_captured);
    try testing.expect(!term.startup_cursor_query_pending);
    try testing.expect(term.caps.explicit_width);
    try testing.expect(term.caps.scaled_text);
}

test "environment variables - should be overridden by xtversion" {
    var term = Terminal.init(.{});

    // First check environment (simulated by setting values directly)
    term.term_info.name_len = 6;
    @memcpy(term.term_info.name[0..6], "vscode");
    term.term_info.version_len = 5;
    @memcpy(term.term_info.version[0..5], "1.0.0");
    term.term_info.from_xtversion = false;

    try testing.expectEqualStrings("vscode", term.getTerminalName());
    try testing.expectEqualStrings("1.0.0", term.getTerminalVersion());
    try testing.expect(!term.term_info.from_xtversion);

    // Now process xtversion response - should override
    const response = "\x1bP>|kitty(0.40.1)\x1b\\";
    term.processCapabilityResponse(response);

    try testing.expectEqualStrings("kitty", term.getTerminalName());
    try testing.expectEqualStrings("0.40.1", term.getTerminalVersion());
    try testing.expect(term.term_info.from_xtversion);
}

test "remote without forwarded env map ignores local env overrides" {
    const term = Terminal.init(.{ .remote_mode = .remote });

    try testing.expect(term.remote);
    try testing.expect(term.caps.remote);
    try testing.expectEqual(Terminal.Multiplexer.none, term.multiplexer);
    try testing.expect(!term.caps.osc52);
    try testing.expect(!term.caps.explicit_cursor_positioning);
}

test "TERM_PROGRAM tmux provides initial tmux version before xtversion" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("TERM_PROGRAM", "tmux");
    try env.put("TERM_PROGRAM_VERSION", "3.6a");
    try env.put("TERM", "xterm-256color");

    var term = Terminal.init(.{ .env_map = &env });

    try testing.expectEqual(Terminal.Multiplexer.tmux, term.multiplexer);
    try testing.expectEqualStrings("tmux", term.getTerminalName());
    try testing.expectEqualStrings("3.6a", term.getTerminalVersion());
    try testing.expect(!term.term_info.from_xtversion);
}

test "remote applies forwarded env overrides and capability responses" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("TMUX", "/tmp/tmux-1000/default,12345,0");
    try env.put("TERM", "screen-256color");
    try env.put("TERM_PROGRAM", "iTerm.app");
    try env.put("WT_SESSION", "test-session");

    var term = Terminal.init(.{ .remote_mode = .remote, .env_map = &env });

    try testing.expect(term.remote);
    try testing.expect(term.caps.remote);
    try testing.expectEqual(Terminal.Multiplexer.tmux, term.multiplexer);
    try testing.expect(term.caps.osc52);
    try testing.expect(term.caps.explicit_cursor_positioning);
    try testing.expect(term.caps.ansi256);

    term.processCapabilityResponse("\x1bP>|kitty(0.40.1)\x1b\\");
    try testing.expect(term.caps.rgb);
    try testing.expect(term.caps.osc52);
}

test "setHostEnvVar applies env overrides in shared library mode" {
    var term = Terminal.init(.{});
    defer term.deinit();

    try term.setHostEnvVar(testing.allocator, "TERM", "screen");
    try testing.expectEqual(Terminal.Multiplexer.screen, term.multiplexer);
    try testing.expect(term.skip_graphics_query);
    try testing.expect(term.caps.unicode == .wcwidth);
    try testing.expect(term.caps.explicit_cursor_positioning);

    try term.setHostEnvVar(testing.allocator, "OPENTUI_FORCE_UNICODE", "1");
    try testing.expect(term.caps.unicode == .unicode);

    try term.setHostEnvVar(testing.allocator, "OPENTUI_GRAPHICS", "0");
    try testing.expect(term.skip_graphics_query);
}

test "environment overrides - enables hyperlinks for WSL Windows Terminal xterm" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("WSL_DISTRO_NAME", "Ubuntu");
    try env.put("WT_SESSION", "test-session");
    try env.put("TERM", "xterm-256color");

    const term = Terminal.init(.{ .env_map = &env });

    try testing.expect(term.caps.hyperlinks);
}

test "environment overrides - does not enable hyperlinks for WSL without WT_SESSION" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("WSL_DISTRO_NAME", "Ubuntu");
    try env.put("TERM", "xterm-256color");

    const term = Terminal.init(.{ .env_map = &env });

    try testing.expect(!term.caps.hyperlinks);
}

test "environment overrides - does not enable hyperlinks for WSL non-xterm terms" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("WSL_INTEROP", "/run/WSL/123_interop");
    try env.put("WT_SESSION", "test-session");
    try env.put("TERM", "screen-256color");

    const term = Terminal.init(.{ .env_map = &env });

    try testing.expect(!term.caps.hyperlinks);
}

test "setHostEnvVar detects ansi256 separately from rgb" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("TERM", "screen-256color");

    var term = Terminal.init(.{ .env_map = &env });
    defer term.deinit();

    try testing.expect(term.caps.ansi256);
    try testing.expect(!term.caps.rgb);

    try term.setHostEnvVar(testing.allocator, "COLORTERM", "truecolor");
    try testing.expect(term.caps.rgb);
    try testing.expect(term.caps.ansi256);
}

test "environment overrides - WT_SESSION enables rgb and ansi256" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("TERM", "xterm-256color");
    try env.put("WT_SESSION", "test-session");

    const term = Terminal.init(.{ .env_map = &env });

    try testing.expect(term.caps.rgb);
    try testing.expect(term.caps.ansi256);
}

test "parseXtversion - terminal name only" {
    var term = Terminal.init(.{});
    const response = "\x1bP>|wezterm\x1b\\";
    term.processCapabilityResponse(response);

    try testing.expectEqualStrings("wezterm", term.getTerminalName());
    try testing.expectEqualStrings("", term.getTerminalVersion());
    try testing.expect(term.term_info.from_xtversion);
    try testing.expect(term.caps.osc52);
}

test "parseXtversion - empty response" {
    var term = Terminal.init(.{});

    const initial_name_len = term.term_info.name_len;
    const initial_version_len = term.term_info.version_len;

    const response = "\x1bP>|\x1b\\";
    term.processCapabilityResponse(response);

    try testing.expectEqual(initial_name_len, term.term_info.name_len);
    try testing.expectEqual(initial_version_len, term.term_info.version_len);
}

// Test buffer for capturing terminal output
const TestWriter = struct {
    buffer: std.ArrayListUnmanaged(u8),
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator) TestWriter {
        return .{ .buffer = .{}, .allocator = allocator };
    }

    pub fn deinit(self: *TestWriter) void {
        self.buffer.deinit(self.allocator);
        self.* = undefined;
    }

    pub fn writeAll(self: *TestWriter, data: []const u8) !void {
        try self.buffer.appendSlice(self.allocator, data);
    }

    pub fn writeByte(self: *TestWriter, byte: u8) !void {
        try self.buffer.append(self.allocator, byte);
    }

    pub fn print(self: *TestWriter, comptime fmt: []const u8, args: anytype) !void {
        try self.buffer.writer(self.allocator).print(fmt, args);
    }

    pub fn getWritten(self: *TestWriter) []const u8 {
        return self.buffer.items;
    }

    pub fn reset(self: *TestWriter) void {
        self.buffer.clearRetainingCapacity();
    }
};

test "queryTerminalSend - sends unwrapped queries when not in tmux" {
    // Note: This test may fail if running inside tmux since checkEnvironmentOverrides
    // reads TMUX/TERM env vars. We test the logic directly instead.
    var term = Terminal.init(.{});

    // Skip test if actually running in tmux
    if (term.isInTmux()) return error.SkipZigTest;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.queryTerminalSend(&writer);

    const output = writer.getWritten();

    const idx_osc_theme_queries = std.mem.indexOf(u8, output, ansi.ANSI.oscThemeQueries).?;
    const idx_xtversion = std.mem.indexOf(u8, output, "\x1b[>0q").?;

    // Should contain xtversion
    try testing.expect(std.mem.indexOf(u8, output, "\x1b[>0q") != null);
    try testing.expect(idx_osc_theme_queries < idx_xtversion);
    try testing.expect(std.mem.indexOf(u8, output, "\x1b[?996n") == null);

    // Should contain unwrapped DECRQM queries (single ESC)
    try testing.expect(std.mem.indexOf(u8, output, "\x1b[?1016$p") != null);
    try testing.expect(std.mem.indexOf(u8, output, "\x1b[?2027$p") != null);
    try testing.expect(std.mem.indexOf(u8, output, "\x1b[?u") != null);

    // Should NOT contain tmux DCS wrapper
    try testing.expect(std.mem.indexOf(u8, output, "\x1bPtmux;") == null);

    // Should mark capability queries as pending
    try testing.expect(term.capability_queries_pending);
}

test "queryTerminalSend - sends DCS wrapped queries when in tmux" {
    // Note: This test checks logic when tmux is detected.
    // We can't easily force tmux detection since checkEnvironmentOverrides resets it,
    // so we test this via sendPendingQueries tests instead.
    var term = Terminal.init(.{});

    // Only run the DCS wrapping test if actually in tmux
    if (!term.isInTmux()) return error.SkipZigTest;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.queryTerminalSend(&writer);

    const output = writer.getWritten();

    const idx_osc_theme_queries = std.mem.indexOf(u8, output, ansi.ANSI.oscThemeQueries).?;
    const idx_xtversion = std.mem.indexOf(u8, output, "\x1b[>0q").?;

    // Should contain xtversion (unwrapped - used for detection)
    try testing.expect(std.mem.indexOf(u8, output, "\x1b[>0q") != null);
    try testing.expect(idx_osc_theme_queries < idx_xtversion);
    try testing.expect(std.mem.indexOf(u8, output, "\x1b[?996n") == null);
    try testing.expect(std.mem.indexOf(u8, output, "\x1bPtmux;\x1b\x1b]10;?") == null);

    // Should contain tmux DCS wrapper start and doubled ESC for queries
    // wrapForTmux wraps all queries together with one DCS envelope
    try testing.expect(std.mem.indexOf(u8, output, "\x1bPtmux;\x1b\x1b[?1016$p") != null);

    // Should NOT mark capability queries as pending (already sent wrapped)
    try testing.expect(!term.capability_queries_pending);
}

test "queryTerminalSend - sends plain theme queries when TMUX is set" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("TMUX", "/tmp/tmux-1000/default,12345,0");
    try env.put("TERM", "screen-256color");

    var term = Terminal.init(.{ .env_map = &env });
    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.queryTerminalSend(&writer);

    const output = writer.getWritten();

    try testing.expectEqual(Terminal.Multiplexer.tmux, term.multiplexer);
    try testing.expect(std.mem.indexOf(u8, output, ansi.ANSI.oscThemeQueries) != null);
    try testing.expect(std.mem.indexOf(u8, output, "\x1bPtmux;\x1b\x1b]10;?") == null);
    try testing.expect(std.mem.indexOf(u8, output, "\x1b[?996n") == null);
}

test "sendPendingQueries - sends wrapped queries after tmux detected via xtversion" {
    var term = Terminal.init(.{});
    term.multiplexer = .none;
    term.capability_queries_pending = true;
    term.graphics_query_pending = true;

    // Simulate tmux detected via xtversion
    term.processCapabilityResponse("\x1bP>|tmux 3.5a\x1b\\");

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    const did_send = try term.sendPendingQueries(&writer);

    try testing.expect(did_send);

    const output = writer.getWritten();

    // Should send DCS wrapped capability queries (wrapForTmux wraps all queries together)
    try testing.expect(std.mem.indexOf(u8, output, "\x1bPtmux;\x1b\x1b[?1016$p") != null);

    // Should send DCS wrapped graphics query
    try testing.expect(std.mem.indexOf(u8, output, "\x1bPtmux;\x1b\x1b_G") != null);

    // Should clear pending flags
    try testing.expect(!term.capability_queries_pending);
    try testing.expect(!term.graphics_query_pending);
}

test "sendPendingQueries - sends unwrapped graphics query for non-tmux terminal" {
    var term = Terminal.init(.{});
    term.multiplexer = .none;
    term.capability_queries_pending = true;
    term.graphics_query_pending = true;

    // Simulate non-tmux terminal detected via xtversion
    term.term_info.from_xtversion = true;
    term.term_info.name_len = 5;
    @memcpy(term.term_info.name[0..5], "kitty");

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    const did_send = try term.sendPendingQueries(&writer);

    try testing.expect(did_send);

    const output = writer.getWritten();

    // Should NOT send DCS wrapped capability queries (not tmux)
    try testing.expect(std.mem.indexOf(u8, output, "\x1bPtmux;") == null);

    // Should send unwrapped graphics query
    try testing.expect(std.mem.indexOf(u8, output, "\x1b_Gi=31337") != null);

    // Should clear pending flags
    try testing.expect(!term.capability_queries_pending);
    try testing.expect(!term.graphics_query_pending);
}

test "sendPendingQueries - sends unwrapped graphics query even without xtversion response" {
    // This covers terminals that support kitty graphics but don't respond to xtversion.
    // The graphics query should still be sent (unwrapped) so we can detect graphics support.
    var term = Terminal.init(.{});
    term.multiplexer = .none;
    term.term_info.from_xtversion = false;
    term.capability_queries_pending = true;
    term.graphics_query_pending = true;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    const did_send = try term.sendPendingQueries(&writer);

    try testing.expect(did_send);

    const output = writer.getWritten();

    // Should send unwrapped graphics query (not tmux, so no DCS wrapper)
    try testing.expect(std.mem.indexOf(u8, output, "\x1b_Gi=31337") != null);
    try testing.expect(std.mem.indexOf(u8, output, "\x1bPtmux;") == null);

    // Should clear graphics pending flag
    try testing.expect(!term.graphics_query_pending);

    // Capability queries should NOT be re-sent (no xtversion means we don't know if tmux,
    // but they were already sent unwrapped in queryTerminalSend)
    try testing.expect(!term.capability_queries_pending);
}

test "sendPendingQueries - skips graphics when skip_graphics_query is set" {
    var term = Terminal.init(.{});
    term.multiplexer = .tmux;
    term.skip_graphics_query = true;
    term.graphics_query_pending = true;
    term.capability_queries_pending = false;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    const did_send = try term.sendPendingQueries(&writer);

    try testing.expect(!did_send);

    const output = writer.getWritten();
    try testing.expect(std.mem.indexOf(u8, output, "Gi=31337") == null);
}

test "isXtversionTmux - detects tmux from xtversion" {
    var term = Terminal.init(.{});

    // Not from xtversion
    term.term_info.from_xtversion = false;
    term.term_info.name_len = 4;
    @memcpy(term.term_info.name[0..4], "tmux");
    try testing.expect(!term.isXtversionTmux());

    // From xtversion but not tmux
    term.term_info.from_xtversion = true;
    term.term_info.name_len = 5;
    @memcpy(term.term_info.name[0..5], "kitty");
    try testing.expect(!term.isXtversionTmux());

    // From xtversion and is tmux
    term.term_info.name_len = 4;
    @memcpy(term.term_info.name[0..4], "tmux");
    try testing.expect(term.isXtversionTmux());
}

// ============================================================================
// GRAPHEME CURSOR POSITIONING CAPABILITY TESTS
// ============================================================================

test "processCapabilityResponse - tmux sets explicit_cursor_positioning" {
    var term: Terminal = .{};

    term.caps.explicit_cursor_positioning = false;
    term.caps.unicode = .unicode;

    const response = "\x1bP>|tmux 3.5a\x1b\\";
    term.processCapabilityResponse(response);

    try testing.expect(term.caps.explicit_cursor_positioning);
    try testing.expectEqual(utf8.WidthMethod.wcwidth, term.caps.unicode);
}

test "processCapabilityResponse - alacritty sets explicit_cursor_positioning" {
    var term: Terminal = .{};

    term.caps.explicit_cursor_positioning = false;

    const response = "\x1bP>|alacritty 0.13.0\x1b\\";
    term.processCapabilityResponse(response);

    try testing.expect(term.caps.explicit_cursor_positioning);
}

test "processCapabilityResponse - kitty does not set explicit_cursor_positioning" {
    var term: Terminal = .{};

    term.caps.explicit_cursor_positioning = false;

    const response = "\x1bP>|kitty(0.40.1)\x1b\\";
    term.processCapabilityResponse(response);

    try testing.expect(!term.caps.explicit_cursor_positioning);
}

test "processCapabilityResponse - ghostty does not set explicit_cursor_positioning" {
    var term: Terminal = .{};

    term.caps.explicit_cursor_positioning = false;

    const response = "\x1bP>|ghostty 1.1.3\x1b\\";
    term.processCapabilityResponse(response);

    try testing.expect(!term.caps.explicit_cursor_positioning);
}

test "processCapabilityResponse - wezterm applies osc52 and hyperlink heuristics" {
    var term: Terminal = .{};

    const response = "\x1bP>|wezterm\x1b\\";
    term.processCapabilityResponse(response);

    try testing.expect(!term.caps.rgb);
    try testing.expect(!term.caps.ansi256);
    try testing.expect(term.caps.osc52);
    try testing.expect(term.caps.hyperlinks);
}

test "processCapabilityResponse - foot applies osc52 heuristic without explicit cursor positioning" {
    var term: Terminal = .{};

    const response = "\x1bP>|foot 1.17.2\x1b\\";
    term.processCapabilityResponse(response);

    try testing.expect(!term.caps.rgb);
    try testing.expect(!term.caps.ansi256);
    try testing.expect(term.caps.osc52);
    try testing.expect(!term.caps.explicit_cursor_positioning);
}

// ============================================================================
// CLIPBOARD (OSC 52) TESTS
// ============================================================================

test "writeClipboard - generates basic OSC52 sequence" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();

    var term = Terminal.init(.{ .env_map = &env });
    term.caps.osc52 = true;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.writeClipboard(&writer, .clipboard, "aGVsbG8=");

    const output = writer.getWritten();
    // Should be: ESC]52;c;aGVsbG8=ESC\
    try testing.expectEqualStrings("\x1b]52;c;aGVsbG8=\x1b\\", output);
}

test "writeNotification - returns false when unsupported" {
    var term = Terminal.init(.{ .remote_mode = .remote });
    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    const ok = try term.writeNotification(testing.allocator, &writer, "Hello", null);

    try testing.expect(!ok);
    try testing.expectEqual(@as(usize, 0), writer.getWritten().len);
}

test "writeNotification - writes OSC99 title and body with base64 payloads" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    var term = Terminal.init(.{ .env_map = &env });
    term.caps.notifications = true;
    term.notification_protocol = .osc99;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    const ok = try term.writeNotification(testing.allocator, &writer, "Body", "Title");

    try testing.expect(ok);
    try testing.expectEqualStrings("\x1b]99;i=opentui-1:p=title:e=1:d=0;VGl0bGU=\x1b\\\x1b]99;i=opentui-1:p=body:e=1:d=1;Qm9keQ==\x1b\\", writer.getWritten());
}

test "writeNotification - writes OSC777 and sanitizes semicolons and controls" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    var term = Terminal.init(.{ .env_map = &env });
    term.caps.notifications = true;
    term.notification_protocol = .osc777;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    const ok = try term.writeNotification(testing.allocator, &writer, "Bo;dy\n", "Ti;tle");

    try testing.expect(ok);
    try testing.expectEqualStrings("\x1b]777;notify;Ti tle;Bo dy \x1b\\", writer.getWritten());
}

test "writeNotification - writes OSC9 combined title and message" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    var term = Terminal.init(.{ .env_map = &env });
    term.caps.notifications = true;
    term.notification_protocol = .osc9;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    const ok = try term.writeNotification(testing.allocator, &writer, "Body\n", "Title");

    try testing.expect(ok);
    try testing.expectEqualStrings("\x1b]9;Title: Body \x1b\\", writer.getWritten());
}

test "writeNotification - wraps OSC777 in tmux passthrough" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("TMUX", "/tmp/tmux-1000/default,12345,0");

    var term = Terminal.init(.{ .env_map = &env });
    term.caps.notifications = true;
    term.notification_protocol = .osc777;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    const ok = try term.writeNotification(testing.allocator, &writer, "Body", "Title");

    try testing.expect(ok);
    try testing.expect(std.mem.startsWith(u8, writer.getWritten(), "\x1bPtmux;"));
    try testing.expect(std.mem.indexOf(u8, writer.getWritten(), "\x1b\x1b]777;notify;Title;Body") != null);
    try testing.expect(std.mem.endsWith(u8, writer.getWritten(), "\x1b\\"));
}

test "writeNotification - wraps OSC99 in tmux passthrough" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("TMUX", "/tmp/tmux-1000/default,12345,0");

    var term = Terminal.init(.{ .env_map = &env });
    term.caps.notifications = true;
    term.notification_protocol = .osc99;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    const ok = try term.writeNotification(testing.allocator, &writer, "Body", null);

    try testing.expect(ok);
    try testing.expect(std.mem.startsWith(u8, writer.getWritten(), "\x1bPtmux;"));
    try testing.expect(std.mem.indexOf(u8, writer.getWritten(), "\x1b\x1b]99;i=opentui-1:p=body:e=1:d=1;Qm9keQ==") != null);
    try testing.expect(std.mem.endsWith(u8, writer.getWritten(), "\x1b\\"));
}

test "writeNotification - writes raw OSC99 in Zellij" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("TMUX", "/tmp/tmux-1000/default,12345,0");
    try env.put("TERM_PROGRAM", "ghostty");

    var term = Terminal.init(.{ .env_map = &env });
    term.processCapabilityResponse("\x1bP>|Zellij(0.44.1)\x1b\\");
    term.processCapabilityResponse("\x1b]99;i=opentui-notifications:p=?;p=title,body:o=always\x1b\\");

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    const ok = try term.writeNotification(testing.allocator, &writer, "Body", null);

    try testing.expect(ok);
    try testing.expect(!std.mem.startsWith(u8, writer.getWritten(), "\x1bPtmux;"));
    try testing.expectEqualStrings("\x1b]99;i=opentui-1:p=body:e=1:d=1;Qm9keQ==\x1b\\", writer.getWritten());
}

test "writeClipboard - supports different targets" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();

    var term = Terminal.init(.{ .env_map = &env });
    term.caps.osc52 = true;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.writeClipboard(&writer, .primary, "test");
    try testing.expect(std.mem.indexOf(u8, writer.getWritten(), "\x1b]52;p;") != null);

    writer.reset();
    try term.writeClipboard(&writer, .secondary, "test");
    try testing.expect(std.mem.indexOf(u8, writer.getWritten(), "\x1b]52;s;") != null);

    writer.reset();
    try term.writeClipboard(&writer, .query, "test");
    try testing.expect(std.mem.indexOf(u8, writer.getWritten(), "\x1b]52;q;") != null);
}

test "writeClipboard - returns error when OSC52 not supported" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var term = Terminal.init(.{});
    term.caps.osc52 = false;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    const result = term.writeClipboard(&writer, .clipboard, "test");
    try testing.expectError(error.NotSupported, result);
}

test "writeClipboard - wraps in DCS passthrough for tmux" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("TMUX", "/tmp/tmux-1000/default,12345,0");

    var term = Terminal.init(.{ .env_map = &env });
    term.caps.osc52 = true;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.writeClipboard(&writer, .clipboard, "test");

    const output = writer.getWritten();
    // Should start with tmux DCS wrapper
    try testing.expect(std.mem.startsWith(u8, output, "\x1bPtmux;"));
    // Should end with DCS terminator
    try testing.expect(std.mem.endsWith(u8, output, "\x1b\\"));
    // Should have doubled ESC characters inside
    try testing.expect(std.mem.indexOf(u8, output, "\x1b\x1b") != null);
}

test "writeClipboard - wraps in DCS passthrough for GNU Screen" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("STY", "12345.pts-0.hostname");

    var term = Terminal.init(.{ .env_map = &env });
    term.caps.osc52 = true;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.writeClipboard(&writer, .clipboard, "test");

    const output = writer.getWritten();
    // Should start with DCS (but not tmux prefix)
    try testing.expect(std.mem.startsWith(u8, output, "\x1bP"));
    try testing.expect(!std.mem.startsWith(u8, output, "\x1bPtmux;"));
    // Should end with DCS terminator
    try testing.expect(std.mem.endsWith(u8, output, "\x1b\\"));
    // Should have doubled ESC characters
    try testing.expect(std.mem.indexOf(u8, output, "\x1b\x1b") != null);
}

test "writeClipboard - handles tmux sessions" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("TMUX", "/tmp/tmux-1000/default,12345,0");

    var term = Terminal.init(.{ .env_map = &env });
    term.caps.osc52 = true;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.writeClipboard(&writer, .clipboard, "test");

    const output = writer.getWritten();
    // Should have tmux DCS wrapper
    try testing.expect(std.mem.startsWith(u8, output, "\x1bPtmux;"));
    // Should end with DCS terminator
    try testing.expect(std.mem.endsWith(u8, output, "\x1b\\"));
    // Should have doubled ESC characters
    try testing.expect(std.mem.indexOf(u8, output, "\x1b\x1b") != null);
}

test "caps.osc52 - clipboard capability flag" {
    var term = Terminal.init(.{});

    term.caps.osc52 = false;
    try testing.expect(!term.caps.osc52);

    term.caps.osc52 = true;
    try testing.expect(term.caps.osc52);
}

fn countSubstring(haystack: []const u8, needle: []const u8) usize {
    var count: usize = 0;
    var i: usize = 0;
    while (i < haystack.len) {
        if (std.mem.startsWith(u8, haystack[i..], needle)) {
            count += 1;
            i += needle.len;
        } else {
            i += 1;
        }
    }
    return count;
}

test "queryTerminalSend - skips OSC 66 queries when OPENTUI_FORCE_EXPLICIT_WIDTH=false" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("OPENTUI_FORCE_EXPLICIT_WIDTH", "false");

    var term = Terminal.init(.{ .env_map = &env });

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.queryTerminalSend(&writer);

    const output = writer.getWritten();

    // Should not contain OSC 66 queries
    try testing.expect(std.mem.indexOf(u8, output, "\x1b]66;") == null);

    // Should still contain other queries
    try testing.expect(std.mem.indexOf(u8, output, "\x1b[>0q") != null); // xtversion

    // Verify the flag was set correctly
    try testing.expect(term.skip_explicit_width_query);
    try testing.expect(!term.caps.explicit_width);
}

test "queryTerminalSend - sends OSC 66 queries by default" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();

    var term = Terminal.init(.{ .env_map = &env });

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.queryTerminalSend(&writer);

    const output = writer.getWritten();

    // Should contain OSC 66 explicit width query
    try testing.expect(std.mem.indexOf(u8, output, "\x1b]66;w=1; \x1b\\") != null);

    // Should contain OSC 66 scaled text query
    try testing.expect(std.mem.indexOf(u8, output, "\x1b]66;s=2; \x1b\\") != null);

    // Verify the flag was not set
    try testing.expect(!term.skip_explicit_width_query);
}

test "queryTerminalSend - sends OSC 66 queries when OPENTUI_FORCE_EXPLICIT_WIDTH=true" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();
    try env.put("OPENTUI_FORCE_EXPLICIT_WIDTH", "true");

    var term = Terminal.init(.{ .env_map = &env });

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.queryTerminalSend(&writer);

    const output = writer.getWritten();

    // Should contain OSC 66 queries
    try testing.expect(std.mem.indexOf(u8, output, "\x1b]66;w=1; \x1b\\") != null);
    try testing.expect(std.mem.indexOf(u8, output, "\x1b]66;s=2; \x1b\\") != null);

    // Verify the capability was forced on
    try testing.expect(term.caps.explicit_width);
    try testing.expect(!term.skip_explicit_width_query);
}

test "enableDetectedFeatures - sends initial theme queries" {
    var env = std.process.EnvMap.init(testing.allocator);
    defer env.deinit();

    var term = Terminal.init(.{ .env_map = &env });
    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.enableDetectedFeatures(&writer, false);

    const output = writer.getWritten();

    try testing.expect(std.mem.indexOf(u8, output, ansi.ANSI.colorSchemeSet) != null);
    try testing.expect(std.mem.indexOf(u8, output, "\x1b]10;?\x07") != null);
    try testing.expect(std.mem.indexOf(u8, output, "\x1b]11;?\x07") != null);
    try testing.expect(std.mem.indexOf(u8, output, "\x1b[?996n") == null);
    try testing.expect(term.state.theme_queries_sent);
}

test "setMouseMode - enable without movement keeps click/drag only" {
    var term = Terminal.init(.{});
    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.setMouseMode(&writer, true, false);

    const output = writer.getWritten();
    const idx_disable_any = std.mem.indexOf(u8, output, ansi.ANSI.disableAnyEventTracking).?;
    const idx_enable_mouse = std.mem.indexOf(u8, output, ansi.ANSI.enableMouseTracking).?;
    const idx_enable_button = std.mem.indexOf(u8, output, ansi.ANSI.enableButtonEventTracking).?;
    const idx_enable_sgr = std.mem.indexOf(u8, output, ansi.ANSI.enableSGRMouseMode).?;
    try testing.expect(std.mem.indexOf(u8, output, ansi.ANSI.enableAnyEventTracking) == null);
    try testing.expect(idx_disable_any < idx_enable_mouse);
    try testing.expect(idx_enable_mouse < idx_enable_button);
    try testing.expect(idx_enable_button < idx_enable_sgr);

    try testing.expect(term.state.mouse);
    try testing.expect(!term.state.mouse_movement);
}

test "setMouseMode - enable with movement enables any-event tracking" {
    var term = Terminal.init(.{});
    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.setMouseMode(&writer, true, true);

    const output = writer.getWritten();
    const idx_enable_mouse = std.mem.indexOf(u8, output, ansi.ANSI.enableMouseTracking).?;
    const idx_enable_button = std.mem.indexOf(u8, output, ansi.ANSI.enableButtonEventTracking).?;
    const idx_enable_any = std.mem.indexOf(u8, output, ansi.ANSI.enableAnyEventTracking).?;
    const idx_enable_sgr = std.mem.indexOf(u8, output, ansi.ANSI.enableSGRMouseMode).?;
    try testing.expect(idx_enable_mouse < idx_enable_button);
    try testing.expect(idx_enable_button < idx_enable_any);
    try testing.expect(idx_enable_any < idx_enable_sgr);
    try testing.expect(std.mem.indexOf(u8, output, ansi.ANSI.disableAnyEventTracking) == null);

    try testing.expect(term.state.mouse);
    try testing.expect(term.state.mouse_movement);
}

test "restoreTerminalModes - respects mouse movement setting" {
    var term = Terminal.init(.{});
    term.state.mouse = true;
    term.state.mouse_movement = false;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.restoreTerminalModes(&writer);

    const output = writer.getWritten();
    const idx_disable_any = std.mem.indexOf(u8, output, ansi.ANSI.disableAnyEventTracking).?;
    const idx_enable_mouse = std.mem.indexOf(u8, output, ansi.ANSI.enableMouseTracking).?;
    const idx_enable_button = std.mem.indexOf(u8, output, ansi.ANSI.enableButtonEventTracking).?;
    const idx_enable_sgr = std.mem.indexOf(u8, output, ansi.ANSI.enableSGRMouseMode).?;
    try testing.expect(idx_disable_any < idx_enable_mouse);
    try testing.expect(idx_enable_mouse < idx_enable_button);
    try testing.expect(idx_enable_button < idx_enable_sgr);
    try testing.expect(std.mem.indexOf(u8, output, ansi.ANSI.enableAnyEventTracking) == null);
}

test "resetState - force-disables mouse when cleanup is pending and state drifted false" {
    var term = Terminal.init(.{});
    term.state.mouse = false;
    term.state.mouse_movement = false;
    term.state.mouse_was_enabled = true;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.resetState(&writer);

    const output = writer.getWritten();
    const idx_disable_any = std.mem.indexOf(u8, output, ansi.ANSI.disableAnyEventTracking).?;
    const idx_disable_button = std.mem.indexOf(u8, output, ansi.ANSI.disableButtonEventTracking).?;
    const idx_disable_mouse = std.mem.indexOf(u8, output, ansi.ANSI.disableMouseTracking).?;
    const idx_disable_sgr = std.mem.indexOf(u8, output, ansi.ANSI.disableSGRMouseMode).?;
    try testing.expect(idx_disable_any < idx_disable_button);
    try testing.expect(idx_disable_button < idx_disable_mouse);
    try testing.expect(idx_disable_mouse < idx_disable_sgr);
    try testing.expect(!term.state.mouse);
}

test "resetState - skips mouse disable when mouse was never enabled" {
    var term = Terminal.init(.{});

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.resetState(&writer);

    const output = writer.getWritten();
    try testing.expect(std.mem.indexOf(u8, output, ansi.ANSI.disableAnyEventTracking) == null);
    try testing.expect(std.mem.indexOf(u8, output, ansi.ANSI.disableButtonEventTracking) == null);
    try testing.expect(std.mem.indexOf(u8, output, ansi.ANSI.disableMouseTracking) == null);
    try testing.expect(std.mem.indexOf(u8, output, ansi.ANSI.disableSGRMouseMode) == null);
}
