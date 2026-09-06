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
    try testing.expect(term.caps.hyperlinks);
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
    const response = "\x1b[?1016;2$y\x1b[?2027;0$y\x1b[?2031;2$y\x1b[?1004;1$y\x1b[?2026;2$y\x1b[1;2R\x1b[1;3R\x1bP>|kitty(0.40.1)\x1b\\\x1b[?0u\x1b_Gi=31337;OK\x1b\\\x1b[?62;c";
    term.processCapabilityResponse(response);

    try testing.expectEqualStrings("kitty", term.getTerminalName());
    try testing.expectEqualStrings("0.40.1", term.getTerminalVersion());
    try testing.expect(term.term_info.from_xtversion);
    try testing.expect(term.caps.kitty_keyboard);
    try testing.expect(term.caps.kitty_graphics);
    try testing.expect(term.caps.osc52);
}

test "graphics identity - exact direct Kitty enables Kitty graphics only" {
    var kitty = Terminal.init(.{});
    kitty.processCapabilityResponse("\x1bP>|kitty(0.46.2)\x1b\\");
    try testing.expect(kitty.caps.kitty_graphics);
    try testing.expect(!kitty.caps.sixel);

    var substring = Terminal.init(.{});
    substring.processCapabilityResponse("\x1bP>|notkitty(1.0)\x1b\\");
    try testing.expect(!substring.caps.kitty_graphics);
    try testing.expect(!substring.caps.sixel);

    var uppercase = Terminal.init(.{});
    uppercase.processCapabilityResponse("\x1bP>|KITTY(0.47.2)\x1b\\");
    try testing.expect(uppercase.caps.kitty_graphics);
}

test "graphics identity - exact direct Ghostty enables Kitty graphics only" {
    var term = Terminal.init(.{});
    term.processCapabilityResponse("\x1bP>|ghostty 1.3.1\x1b\\");
    try testing.expect(term.caps.kitty_graphics);
    try testing.expect(!term.caps.sixel);

    var substring = Terminal.init(.{});
    substring.processCapabilityResponse("\x1bP>|ghostty-wrapper 1.3.1\x1b\\");
    try testing.expect(!substring.caps.kitty_graphics);
}

test "graphics identity - foot enables Sixel from version 1.2" {
    var supported = Terminal.init(.{});
    supported.processCapabilityResponse("\x1bP>|foot(1.2.0)\x1b\\");
    try testing.expect(!supported.caps.kitty_graphics);
    try testing.expect(supported.caps.sixel);

    var old = Terminal.init(.{});
    old.processCapabilityResponse("\x1bP>|foot(1.1.0)\x1b\\");
    try testing.expect(!old.caps.sixel);

    var unknown_version = Terminal.init(.{});
    unknown_version.processCapabilityResponse("\x1bP>|foot\x1b\\");
    try testing.expect(!unknown_version.caps.sixel);

    var later_minor = Terminal.init(.{});
    later_minor.processCapabilityResponse("\x1bP>|foot(1.10.0)\x1b\\");
    try testing.expect(later_minor.caps.sixel);

    var patch_release = Terminal.init(.{});
    patch_release.processCapabilityResponse("\x1bP>|foot(1.2.3)\x1b\\");
    try testing.expect(patch_release.caps.sixel);

    var malformed = Terminal.init(.{});
    malformed.processCapabilityResponse("\x1bP>|foot(next)\x1b\\");
    try testing.expect(!malformed.caps.sixel);

    var incomplete = Terminal.init(.{});
    incomplete.processCapabilityResponse("\x1bP>|foot(1.2)\x1b\\");
    try testing.expect(!incomplete.caps.sixel);

    var malformed_patch = Terminal.init(.{});
    malformed_patch.processCapabilityResponse("\x1bP>|foot(1.2.invalid)\x1b\\");
    try testing.expect(!malformed_patch.caps.sixel);

    var prerelease = Terminal.init(.{});
    prerelease.processCapabilityResponse("\x1bP>|foot(1.2.0-rc1)\x1b\\");
    try testing.expect(!prerelease.caps.sixel);

    var git_build = Terminal.init(.{});
    git_build.processCapabilityResponse("\x1bP>|foot(1.2.0-36-g7db8e06f)\x1b\\");
    try testing.expect(git_build.caps.sixel);
}

test "graphics identity - WezTerm enables Sixel from documented build" {
    var supported = Terminal.init(.{});
    supported.processCapabilityResponse("\x1bP>|WezTerm 20200620-160318-e00b076c\x1b\\");
    try testing.expect(supported.caps.sixel);
    try testing.expect(!supported.caps.kitty_graphics);

    var old = Terminal.init(.{});
    old.processCapabilityResponse("\x1bP>|WezTerm 20200619-000000-old\x1b\\");
    try testing.expect(!old.caps.sixel);

    var malformed = Terminal.init(.{});
    malformed.processCapabilityResponse("\x1bP>|WezTerm nightly\x1b\\");
    try testing.expect(!malformed.caps.sixel);

    var missing_separator = Terminal.init(.{});
    missing_separator.processCapabilityResponse("\x1bP>|WezTerm 20200620invalid\x1b\\");
    try testing.expect(!missing_separator.caps.sixel);

    var invalid_date = Terminal.init(.{});
    invalid_date.processCapabilityResponse("\x1bP>|WezTerm 20201340-160318-abcdef12\x1b\\");
    try testing.expect(!invalid_date.caps.sixel);

    var invalid_time = Terminal.init(.{});
    invalid_time.processCapabilityResponse("\x1bP>|WezTerm 20200620-256199-abcdef12\x1b\\");
    try testing.expect(!invalid_time.caps.sixel);

    var invalid_hash = Terminal.init(.{});
    invalid_hash.processCapabilityResponse("\x1bP>|WezTerm 20200620-160318-invalid!\x1b\\");
    try testing.expect(!invalid_hash.caps.sixel);

    var extra_field = Terminal.init(.{});
    extra_field.processCapabilityResponse("\x1bP>|WezTerm 20200620-160318-abcdef12-extra\x1b\\");
    try testing.expect(extra_field.caps.sixel);

    var empty_extra = Terminal.init(.{});
    empty_extra.processCapabilityResponse("\x1bP>|WezTerm 20200620-160318-abcdef12-\x1b\\");
    try testing.expect(!empty_extra.caps.sixel);

    var dot_decorated = Terminal.init(.{});
    dot_decorated.processCapabilityResponse("\x1bP>|WezTerm 20200620.160318.abcdef12.package\x1b\\");
    try testing.expect(dot_decorated.caps.sixel);

    var underscore_decorated = Terminal.init(.{});
    underscore_decorated.processCapabilityResponse("\x1bP>|WezTerm 20200620_160318_abcdef12_package\x1b\\");
    try testing.expect(underscore_decorated.caps.sixel);
}

test "graphics identity - multiplexers do not imply outer graphics" {
    var tmux = Terminal.init(.{});
    tmux.processCapabilityResponse("\x1bP>|tmux 3.5a\x1b\\");
    try testing.expect(!tmux.caps.kitty_graphics);
    try testing.expect(!tmux.caps.sixel);

    var zellij = Terminal.init(.{});
    zellij.processCapabilityResponse("\x1bP>|Zellij 0.41.2\x1b\\");
    try testing.expect(!zellij.caps.kitty_graphics);
    try testing.expect(!zellij.caps.sixel);
}

test "graphics identity - query response upgrades an unknown terminal" {
    var term = Terminal.init(.{});
    term.processCapabilityResponse("\x1bP>|unknown 1.0\x1b\\");
    try testing.expect(!term.caps.kitty_graphics);
    term.processCapabilityResponse("\x1b_Gi=31337;OK\x1b\\");
    try testing.expect(term.caps.kitty_graphics);

    var old_foot = Terminal.init(.{});
    old_foot.processCapabilityResponse("\x1bP>|foot(1.1.0)\x1b\\");
    try testing.expect(!old_foot.caps.sixel);
    old_foot.processCapabilityResponse("\x1b[?62;1;2;4;6c");
    try testing.expect(old_foot.caps.sixel);

    term.processCapabilityResponse("\x1bP>|another-unknown 2.0\x1b\\");
    try testing.expect(term.caps.kitty_graphics);
}

test "graphics identity - a new identity replaces only identity-derived capabilities" {
    var term = Terminal.init(.{});
    term.processCapabilityResponse("\x1bP>|kitty(0.47.2)\x1b\\");
    try testing.expect(term.caps.kitty_graphics);
    term.processCapabilityResponse("\x1bP>|unknown 1.0\x1b\\");
    try testing.expect(!term.caps.kitty_graphics);
}

test "graphics identity - malformed XTVERSION cannot reuse environment version" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("TERM_PROGRAM", "foot");
    try env.put("TERM_PROGRAM_VERSION", "1.20.2");
    var term = Terminal.init(.{ .env_map = &env });
    term.processCapabilityResponse("\x1bP>|foot(\x1b\\");
    try testing.expectEqualStrings("", term.getTerminalVersion());
    try testing.expect(!term.caps.sixel);
}

test "refusesForcedSixel - XTVERSION replaces leftover Apple Terminal env" {
    var leftover = std.process.Environ.Map.init(testing.allocator);
    defer leftover.deinit();
    try leftover.put("TERM_PROGRAM", "Apple_Terminal");
    var foot = Terminal.init(.{ .env_map = &leftover });
    foot.processCapabilityResponse("\x1bP>|foot(1.20.2)\x1b\\");
    try testing.expect(!foot.refusesForcedSixel());

    var iterm = Terminal.init(.{});
    iterm.processCapabilityResponse("\x1bP>|iTerm2 3.6.9\x1b\\");
    try testing.expect(!iterm.refusesForcedSixel());
}

test "refusesForcedSixel - tmux XTVERSION is not a Sixel endpoint" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("TERM_PROGRAM", "Apple_Terminal");
    var term = Terminal.init(.{ .env_map = &env });
    term.processCapabilityResponse("\x1bP>|tmux 3.5a\x1b\\");
    try testing.expect(term.refusesForcedSixel());

    term.processCapabilityResponse("\x1b[?62;4c");
    try testing.expect(!term.refusesForcedSixel());
}

test "graphics identity - environment name alone is not authoritative" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("TERM_PROGRAM", "kitty");
    try env.put("TERM_PROGRAM_VERSION", "0.47.2");
    const term = Terminal.init(.{ .env_map = &env });
    try testing.expect(!term.term_info.from_xtversion);
    try testing.expect(!term.caps.kitty_graphics);
    try testing.expect(!term.caps.sixel);
}

test "graphics identity - explicit graphics disable blocks identity and queries" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("OPENTUI_GRAPHICS", "0");

    var kitty = Terminal.init(.{ .env_map = &env });
    kitty.processCapabilityResponse("\x1bP>|kitty(0.47.2)\x1b\\");
    kitty.processCapabilityResponse("\x1b_Gi=31337;OK\x1b\\");
    try testing.expect(!kitty.caps.kitty_graphics);

    var foot = Terminal.init(.{ .env_map = &env });
    foot.processCapabilityResponse("\x1bP>|foot(1.20.2)\x1b\\");
    foot.processCapabilityResponse("\x1b[?62;1;2;4;6c");
    try testing.expect(!foot.caps.sixel);
}

test "image protocol override - parses every forced protocol" {
    const cases = [_]struct { value: []const u8, expected: Terminal.ImageProtocol }{
        .{ .value = "auto", .expected = .auto },
        .{ .value = "kitty", .expected = .kitty },
        .{ .value = "sixel", .expected = .sixel },
        .{ .value = "blocks", .expected = .blocks },
    };
    for (cases) |case| {
        var env = std.process.Environ.Map.init(testing.allocator);
        defer env.deinit();
        try env.put("OPENTUI_IMAGE_PROTOCOL", case.value);
        const term = Terminal.init(.{ .env_map = &env });
        try testing.expectEqual(case.expected, term.image_protocol);
    }
}

test "image protocol override - ignores invalid value" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("OPENTUI_IMAGE_PROTOCOL", "invalid");
    const term = Terminal.init(.{ .env_map = &env });
    try testing.expectEqual(Terminal.ImageProtocol.auto, term.image_protocol);
}

test "graphics detection - kitty response matches exact id in the same APC" {
    var term = Terminal.init(.{});
    term.processCapabilityResponse("\x1b_Gi=31337;OK\x1b\\");
    try testing.expect(term.caps.kitty_graphics);

    var wrong = Terminal.init(.{});
    wrong.processCapabilityResponse("\x1b_Gi=313370;OK\x1b\\");
    try testing.expect(!wrong.caps.kitty_graphics);

    var split = Terminal.init(.{});
    split.processCapabilityResponse("\x1b_Gi=1;OK\x1b\\unrelated i=31337");
    try testing.expect(!split.caps.kitty_graphics);
}

test "graphics detection - parses exact sixel DA1 parameter" {
    var direct = Terminal.init(.{});
    direct.processCapabilityResponse("\x1b[?1;2;4c");
    try testing.expect(direct.caps.sixel);

    var later = Terminal.init(.{});
    later.processCapabilityResponse("\x1b[?62;22c\x1b[?62;1;2;4;6c");
    try testing.expect(later.caps.sixel);

    var absent = Terminal.init(.{});
    absent.processCapabilityResponse("\x1b[?62;14;40c");
    try testing.expect(!absent.caps.sixel);
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
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("TERM_FEATURES", "T2NoH");

    const term = Terminal.init(.{ .env_map = &env });

    try testing.expect(term.caps.notifications);
    try testing.expectEqual(Terminal.NotificationProtocol.osc9, term.notification_protocol);
}

test "notifications - Zellij env suppresses inherited host notification heuristics" {
    var env = std.process.Environ.Map.init(testing.allocator);
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
    var env = std.process.Environ.Map.init(testing.allocator);
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
    var env = std.process.Environ.Map.init(testing.allocator);
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
    var env = std.process.Environ.Map.init(testing.allocator);
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
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("SSH_CONNECTION", "192.0.2.1 54231 192.0.2.2 22");

    const term = Terminal.init(.{ .remote_mode = .auto, .env_map = &env });

    try testing.expect(term.remote);
    try testing.expect(term.caps.remote);
}

test "remote detection - auto mode detects mosh environment" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("MOSH_CONNECTION", "192.0.2.1 60001");

    const term = Terminal.init(.{ .remote_mode = .auto, .env_map = &env });

    try testing.expect(term.remote);
    try testing.expect(term.caps.remote);
}

test "remote detection - auto mode ignores local capabilities after forwarded SSH marker" {
    var term = Terminal.init(.{ .remote_mode = .auto });
    defer term.deinit();

    try term.setHostEnvVar(testing.allocator, "SSH_CONNECTION", "192.0.2.1 54231 192.0.2.2 22");
    try term.setHostEnvVar(testing.allocator, "TERM", "xterm-256color");
    try term.setHostEnvVar(testing.allocator, "TERM_PROGRAM", "ghostty");
    try term.setHostEnvVar(testing.allocator, "TERM_PROGRAM_VERSION", "1.3.1");

    try testing.expect(term.caps.remote);
    try testing.expectEqual(utf8.WidthMethod.unicode, term.caps.unicode);
    try testing.expect(!term.caps.ansi256);
    try testing.expect(!term.caps.notifications);
    try testing.expectEqualStrings("", term.getTerminalName());
}

test "remote detection - explicit local mode ignores SSH environment" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("SSH_TTY", "/dev/pts/1");

    const term = Terminal.init(.{ .remote_mode = .local, .env_map = &env });

    try testing.expect(!term.remote);
    try testing.expect(!term.caps.remote);
}

test "processCapabilityResponse captures startup cursor report before home probes" {
    var term = Terminal.init(.{});
    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();
    try term.queryTerminalSend(&writer);

    term.processCapabilityResponse("\x1b[7;11R\x1b[1;2R\x1b[1;3R");

    const cursor = term.getCursorPosition();
    try testing.expectEqual(@as(u32, 11), cursor.x);
    try testing.expectEqual(@as(u32, 7), cursor.y);
    try testing.expect(term.startup_cursor_query_captured);
    try testing.expect(!term.startup_cursor_query_pending);
    try testing.expect(term.caps.explicit_width);
    try testing.expect(term.caps.scaled_text);
}

test "processCapabilityResponse only accepts exact ordered explicit width probe reports" {
    var unrelated = Terminal.init(.{});
    unrelated.processCapabilityResponse("\x1b[1;5R");
    try testing.expect(!unrelated.caps.explicit_width);
    try testing.expect(!unrelated.caps.scaled_text);

    var startup_on_row_one = Terminal.init(.{});
    var startup_writer = TestWriter.init(testing.allocator);
    defer startup_writer.deinit();
    try startup_on_row_one.queryTerminalSend(&startup_writer);
    startup_on_row_one.processCapabilityResponse("\x1b[1;5R");
    startup_on_row_one.processCapabilityResponse("\x1b[1;2R");
    startup_on_row_one.processCapabilityResponse("\x1b[1;3R");
    const cursor = startup_on_row_one.getCursorPosition();
    try testing.expectEqual(@as(u32, 5), cursor.x);
    try testing.expectEqual(@as(u32, 1), cursor.y);
    try testing.expect(startup_on_row_one.caps.explicit_width);
    try testing.expect(startup_on_row_one.caps.scaled_text);

    var echoed = Terminal.init(.{});
    var echoed_writer = TestWriter.init(testing.allocator);
    defer echoed_writer.deinit();
    try echoed.queryTerminalSend(&echoed_writer);
    echoed.processCapabilityResponse("\x1b[7;11R\x1b[1;12R\x1b[1;8R");
    try testing.expect(!echoed.caps.explicit_width);
    try testing.expect(!echoed.caps.scaled_text);
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

    var env = std.process.Environ.Map.init(testing.allocator);
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

    var env = std.process.Environ.Map.init(testing.allocator);
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

test "environment overrides - direct Windows Terminal hyperlinks do not require TERM" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("WT_SESSION", "test-session");

    const term = Terminal.init(.{ .env_map = &env });

    try testing.expect(term.caps.rgb);
    try testing.expectEqual(builtin.os.tag == .windows, term.caps.hyperlinks);
}

test "environment overrides - enables hyperlinks for WSL Windows Terminal xterm" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("WSL_DISTRO_NAME", "Ubuntu");
    try env.put("WT_SESSION", "test-session");
    try env.put("TERM", "xterm-256color");

    const term = Terminal.init(.{ .env_map = &env });

    try testing.expect(term.caps.hyperlinks);
}

test "environment overrides - does not enable hyperlinks for WSL without WT_SESSION" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("WSL_DISTRO_NAME", "Ubuntu");
    try env.put("TERM", "xterm-256color");

    const term = Terminal.init(.{ .env_map = &env });

    try testing.expect(!term.caps.hyperlinks);
}

test "environment overrides - does not enable hyperlinks for WSL non-xterm terms" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("WSL_INTEROP", "/run/WSL/123_interop");
    try env.put("WT_SESSION", "test-session");
    try env.put("TERM", "screen-256color");

    const term = Terminal.init(.{ .env_map = &env });

    try testing.expect(!term.caps.hyperlinks);
}

test "environment overrides - foot hyperlinks require a direct terminal" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("TERM", "foot");

    const direct = Terminal.init(.{ .env_map = &env });
    try testing.expect(direct.caps.hyperlinks);

    try env.put("STY", "1234.session");
    const inherited = Terminal.init(.{ .env_map = &env });
    try testing.expectEqual(Terminal.Multiplexer.screen, inherited.multiplexer);
    try testing.expect(!inherited.caps.hyperlinks);
}

test "environment overrides - foot hyperlinks are revoked after forwarded multiplexer detection" {
    const multiplexers = [_]struct {
        key: []const u8,
        value: []const u8,
        kind: Terminal.Multiplexer,
    }{
        .{ .key = "STY", .value = "1234.session", .kind = .screen },
        .{ .key = "TERM_PROGRAM", .value = "tmux", .kind = .tmux },
    };

    for (multiplexers) |multiplexer| {
        var term = Terminal.init(.{});
        defer term.deinit();

        try term.setHostEnvVar(testing.allocator, "TERM", "foot");
        try testing.expect(term.caps.hyperlinks);

        try term.setHostEnvVar(testing.allocator, multiplexer.key, multiplexer.value);
        try testing.expectEqual(multiplexer.kind, term.multiplexer);
        try testing.expect(!term.caps.hyperlinks);
    }
}

test "environment overrides - rgb does not imply hyperlinks after recheck for unknown truecolor terminals" {
    var term = Terminal.init(.{});
    defer term.deinit();

    try term.setHostEnvVar(testing.allocator, "TERM", "xterm-256color");
    try term.setHostEnvVar(testing.allocator, "COLORTERM", "truecolor");

    try testing.expect(term.caps.rgb);
    try testing.expect(!term.caps.hyperlinks);

    try term.setHostEnvVar(testing.allocator, "OPENTUI_FORCE_UNICODE", "1");

    try testing.expect(term.caps.rgb);
    try testing.expect(!term.caps.hyperlinks);
}

test "environment overrides - rgb does not imply hyperlinks after recheck for inherited Windows Terminal screen" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("WSL_INTEROP", "/run/WSL/123_interop");
    try env.put("WT_SESSION", "test-session");
    try env.put("TERM", "screen");

    var term = Terminal.init(.{ .env_map = &env });
    defer term.deinit();

    try testing.expect(term.caps.rgb);
    try testing.expect(!term.caps.hyperlinks);

    try term.setHostEnvVar(testing.allocator, "TERM", "screen");

    try testing.expect(term.caps.rgb);
    try testing.expect(!term.caps.hyperlinks);
}

test "setHostEnvVar detects ansi256 separately from rgb" {
    var env = std.process.Environ.Map.init(testing.allocator);
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
    var env = std.process.Environ.Map.init(testing.allocator);
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
    buffer: std.Io.Writer.Allocating,

    pub fn init(allocator: std.mem.Allocator) TestWriter {
        return .{ .buffer = .init(allocator) };
    }

    pub fn deinit(self: *TestWriter) void {
        self.buffer.deinit();
        self.* = undefined;
    }

    pub fn writeAll(self: *TestWriter, data: []const u8) !void {
        try self.buffer.writer.writeAll(data);
    }

    pub fn writeByte(self: *TestWriter, byte: u8) !void {
        try self.buffer.writer.writeByte(byte);
    }

    pub fn print(self: *TestWriter, comptime fmt: []const u8, args: anytype) !void {
        try self.buffer.writer.print(fmt, args);
    }

    pub fn getWritten(self: *TestWriter) []const u8 {
        return self.buffer.written();
    }

    pub fn reset(self: *TestWriter) void {
        self.buffer.clearRetainingCapacity();
    }
};

test "queryTerminalSend - sends unwrapped queries when not in tmux" {
    var term = Terminal.init(.{});

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.queryTerminalSend(&writer);

    const output = writer.getWritten();

    const idx_osc_theme_queries = std.mem.find(u8, output, ansi.ANSI.oscThemeQueries).?;
    const idx_xtversion = std.mem.find(u8, output, "\x1b[>0q").?;

    // Should contain xtversion
    try testing.expect(std.mem.find(u8, output, "\x1b[>0q") != null);
    try testing.expect(idx_osc_theme_queries < idx_xtversion);
    try testing.expect(std.mem.find(u8, output, "\x1b[?996n") == null);

    // Should contain unwrapped DECRQM queries (single ESC)
    try testing.expect(std.mem.find(u8, output, "\x1b[?1016$p") != null);
    try testing.expect(std.mem.find(u8, output, "\x1b[?2027$p") != null);
    try testing.expect(std.mem.find(u8, output, "\x1b[?u") != null);
    try testing.expect(std.mem.find(u8, output, "\x1bP+q4d73\x1b\\") != null);
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.kittyGraphicsQuery) != null);
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.primaryDeviceAttrs) != null);

    // Should NOT contain tmux DCS wrapper
    try testing.expect(std.mem.find(u8, output, "\x1bPtmux;") == null);

    // Should mark capability queries as pending
    try testing.expect(term.capability_queries_pending);
    try testing.expect(term.graphics_query_pending);
    try testing.expect(term.sixel_query_pending);
}

test "queryTerminalSend - sends DCS wrapped queries when in tmux" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("TMUX", "/tmp/tmux-1000/default,12345,0");
    var term = Terminal.init(.{ .env_map = &env });

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.queryTerminalSend(&writer);

    const output = writer.getWritten();

    const idx_osc_theme_queries = std.mem.find(u8, output, ansi.ANSI.oscThemeQueries).?;
    const idx_xtversion = std.mem.find(u8, output, "\x1b[>0q").?;

    // Should contain xtversion (unwrapped - used for detection)
    try testing.expect(std.mem.find(u8, output, "\x1b[>0q") != null);
    try testing.expect(idx_osc_theme_queries < idx_xtversion);
    try testing.expect(std.mem.find(u8, output, "\x1b[?996n") == null);
    try testing.expect(std.mem.find(u8, output, "\x1bPtmux;\x1b\x1b]10;?") == null);

    // Should contain tmux DCS wrapper start and doubled ESC for queries
    // wrapForTmux wraps all queries together with one DCS envelope
    try testing.expect(std.mem.find(u8, output, "\x1bPtmux;\x1b\x1bP+q4d73\x1b\x1b\\") != null);
    try testing.expect(std.mem.find(u8, output, "\x1b\x1b[?1016$p") != null);

    // Should NOT mark capability queries as pending (already sent wrapped)
    try testing.expect(!term.capability_queries_pending);
}

test "queryTerminalSend - sends plain theme queries when TMUX is set" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("TMUX", "/tmp/tmux-1000/default,12345,0");
    try env.put("TERM", "screen-256color");

    var term = Terminal.init(.{ .env_map = &env });
    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.queryTerminalSend(&writer);

    const output = writer.getWritten();

    try testing.expectEqual(Terminal.Multiplexer.tmux, term.multiplexer);
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.oscThemeQueries) != null);
    try testing.expect(std.mem.find(u8, output, "\x1bPtmux;\x1b\x1b]10;?") == null);
    try testing.expect(std.mem.find(u8, output, "\x1b[?996n") == null);
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
    try testing.expect(std.mem.find(u8, output, "\x1bPtmux;\x1b\x1bP+q4d73\x1b\x1b\\") != null);
    try testing.expect(std.mem.find(u8, output, "\x1b\x1b[?1016$p") != null);

    // Should send DCS wrapped graphics query
    try testing.expect(std.mem.find(u8, output, "\x1bPtmux;\x1b\x1b_G") != null);

    // Should clear pending flags
    try testing.expect(!term.capability_queries_pending);
    try testing.expect(!term.graphics_query_pending);
}

test "sendPendingQueries - clears already-sent direct graphics probes after non-tmux xtversion" {
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

    try testing.expect(!did_send);

    const output = writer.getWritten();

    // Should NOT send DCS wrapped capability queries (not tmux)
    try testing.expect(std.mem.find(u8, output, "\x1bPtmux;") == null);

    // Initial startup already sent the direct graphics query.
    try testing.expect(std.mem.find(u8, output, "\x1b_Gi=31337") == null);

    // Should clear pending flags
    try testing.expect(!term.capability_queries_pending);
    try testing.expect(!term.graphics_query_pending);
}

test "sendPendingQueries - waits for xtversion before any passthrough retry" {
    var term = Terminal.init(.{});
    term.multiplexer = .none;
    term.term_info.from_xtversion = false;
    term.capability_queries_pending = true;
    term.graphics_query_pending = true;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    const did_send = try term.sendPendingQueries(&writer);

    try testing.expect(!did_send);

    const output = writer.getWritten();

    // Initial startup already sent the direct graphics query.
    try testing.expect(std.mem.find(u8, output, "\x1b_Gi=31337") == null);
    try testing.expect(std.mem.find(u8, output, "\x1bPtmux;") == null);

    try testing.expect(term.graphics_query_pending);

    // Capability queries should NOT be re-sent (no xtversion means we don't know if tmux,
    // but they were already sent unwrapped in queryTerminalSend)
    try testing.expect(term.capability_queries_pending);
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
    try testing.expect(std.mem.find(u8, output, "Gi=31337") == null);
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
    try testing.expect(term.caps.hyperlinks);
    try testing.expect(!term.caps.explicit_cursor_positioning);
}

test "processCapabilityResponse - XTGETTCAP Ms only establishes positive support" {
    var supported: Terminal = .{};
    supported.processCapabilityResponse("\x1bP1+r4d73=2570312573\x1b\\");
    try testing.expectEqual(Terminal.Osc52Support.supported, supported.osc52_support);
    try testing.expect(supported.caps.osc52);

    var bare_negative: Terminal = .{};
    bare_negative.processCapabilityResponse("\x1bP>|iTerm2 3.5.0\x1b\\");
    bare_negative.processCapabilityResponse("\x1bP0+r\x1b\\");
    try testing.expectEqual(Terminal.Osc52Support.unknown, bare_negative.osc52_support);
    try testing.expect(bare_negative.caps.osc52);

    var named_negative: Terminal = .{};
    named_negative.processCapabilityResponse("\x1bP>|kitty(0.40.1)\x1b\\");
    named_negative.processCapabilityResponse("\x1bP0+r4D73\x1b\\");
    try testing.expectEqual(Terminal.Osc52Support.unknown, named_negative.osc52_support);
    try testing.expect(named_negative.caps.osc52);

    var unknown: Terminal = .{};
    unknown.processCapabilityResponse("\x1bP1+r4d73\x1b\\");
    try testing.expectEqual(Terminal.Osc52Support.unknown, unknown.osc52_support);
    unknown.processCapabilityResponse("\x1bP1+r4d73=\x1b\\");
    try testing.expectEqual(Terminal.Osc52Support.unknown, unknown.osc52_support);
    unknown.processCapabilityResponse("\x1bP1+r4d73=abc\x1b\\");
    try testing.expectEqual(Terminal.Osc52Support.unknown, unknown.osc52_support);
    unknown.processCapabilityResponse("\x1bP1+r4d73=zz\x1b\\");
    try testing.expectEqual(Terminal.Osc52Support.unknown, unknown.osc52_support);
    unknown.processCapabilityResponse("\x1bP1+r544e=787465726d\x1b\\");
    try testing.expectEqual(Terminal.Osc52Support.unknown, unknown.osc52_support);
}

// ============================================================================
// CLIPBOARD (OSC 52) TESTS
// ============================================================================

test "writeClipboard - generates basic OSC52 sequence" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();

    var term = Terminal.init(.{ .env_map = &env });
    term.caps.osc52 = true;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.writeClipboard(&writer, .clipboard, "hello");

    const output = writer.getWritten();
    // Should be: ESC]52;c;aGVsbG8=ESC\
    try testing.expectEqualStrings("\x1b]52;c;aGVsbG8=\x1b\\", output);
}

test "writeClipboard - maps every selection target to its OSC 52 byte" {
    const cases = [_]struct {
        target: Terminal.ClipboardTarget,
        expected: []const u8,
    }{
        .{ .target = .clipboard, .expected = "\x1b]52;c;eA==\x1b\\" },
        .{ .target = .primary, .expected = "\x1b]52;p;eA==\x1b\\" },
        .{ .target = .select, .expected = "\x1b]52;s;eA==\x1b\\" },
        .{ .target = .secondary, .expected = "\x1b]52;q;eA==\x1b\\" },
    };

    for (cases) |case| {
        var term: Terminal = .{};
        var writer = TestWriter.init(testing.allocator);
        defer writer.deinit();

        try term.writeClipboard(&writer, case.target, "x");
        try testing.expectEqualStrings(case.expected, writer.getWritten());
    }
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
    var env = std.process.Environ.Map.init(testing.allocator);
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
    var env = std.process.Environ.Map.init(testing.allocator);
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
    var env = std.process.Environ.Map.init(testing.allocator);
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
    var env = std.process.Environ.Map.init(testing.allocator);
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
    try testing.expect(std.mem.find(u8, writer.getWritten(), "\x1b\x1b]777;notify;Title;Body") != null);
    try testing.expect(std.mem.endsWith(u8, writer.getWritten(), "\x1b\\"));
}

test "writeNotification - wraps OSC99 in tmux passthrough" {
    var env = std.process.Environ.Map.init(testing.allocator);
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
    try testing.expect(std.mem.find(u8, writer.getWritten(), "\x1b\x1b]99;i=opentui-1:p=body:e=1:d=1;Qm9keQ==") != null);
    try testing.expect(std.mem.endsWith(u8, writer.getWritten(), "\x1b\\"));
}

test "writeNotification - writes raw OSC99 in Zellij" {
    var env = std.process.Environ.Map.init(testing.allocator);
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

    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();

    var term = Terminal.init(.{ .env_map = &env });
    term.caps.osc52 = true;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.writeClipboard(&writer, .primary, "test");
    try testing.expect(std.mem.find(u8, writer.getWritten(), "\x1b]52;p;") != null);

    writer.reset();
    try term.writeClipboard(&writer, .select, "test");
    try testing.expect(std.mem.find(u8, writer.getWritten(), "\x1b]52;s;") != null);

    writer.reset();
    try term.writeClipboard(&writer, .secondary, "test");
    try testing.expect(std.mem.find(u8, writer.getWritten(), "\x1b]52;q;") != null);
}

test "writeClipboard - returns error when OSC52 not supported" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var term = Terminal.init(.{});
    term.osc52_support = .unsupported;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    const result = term.writeClipboard(&writer, .clipboard, "test");
    try testing.expectError(error.NotSupported, result);
}

test "writeClipboard - emits optimistically when XTGETTCAP state is unknown" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    var term = Terminal.init(.{ .env_map = &env });
    try testing.expectEqual(Terminal.Osc52Support.unknown, term.osc52_support);

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();
    try term.writeClipboard(&writer, .clipboard, "test");

    try testing.expectEqualStrings("\x1b]52;c;dGVzdA==\x1b\\", writer.getWritten());
}

test "writeClipboard - writes large payload without a fixed buffer limit" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    var term = Terminal.init(.{ .env_map = &env });

    const payload = try testing.allocator.alloc(u8, 16 * 1024);
    defer testing.allocator.free(payload);
    @memset(payload, 'A');

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();
    try term.writeClipboard(&writer, .clipboard, payload);

    const encoded_len = std.base64.standard.Encoder.calcSize(payload.len);
    try testing.expectEqual(encoded_len + 9, writer.getWritten().len);
    try testing.expect(std.mem.startsWith(u8, writer.getWritten(), "\x1b]52;c;"));
    try testing.expect(std.mem.endsWith(u8, writer.getWritten(), "\x1b\\"));
}

test "writeClipboard - writes large payload through tmux passthrough" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("TMUX", "/tmp/tmux-1000/default,12345,0");
    var term = Terminal.init(.{ .env_map = &env });

    const payload = try testing.allocator.alloc(u8, 16 * 1024);
    defer testing.allocator.free(payload);
    @memset(payload, 'A');

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();
    try term.writeClipboard(&writer, .clipboard, payload);

    const output = writer.getWritten();
    const encoded_len = std.base64.standard.Encoder.calcSize(payload.len);
    try testing.expectEqual(encoded_len + 20, output.len);
    try testing.expect(std.mem.startsWith(u8, output, "\x1bPtmux;\x1b\x1b]52;c;"));
    try testing.expect(std.mem.endsWith(u8, output, "\x1b\x1b\\\x1b\\"));
}

test "writeClipboard - chunks large payload through GNU Screen passthrough" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("STY", "12345.pts-0.hostname");
    var term = Terminal.init(.{ .env_map = &env });

    const payload = try testing.allocator.alloc(u8, 16 * 1024);
    defer testing.allocator.free(payload);
    @memset(payload, 'A');

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();
    try term.writeClipboard(&writer, .clipboard, payload);

    const output = writer.getWritten();
    const forwarded_buffer = try testing.allocator.alloc(u8, output.len);
    defer testing.allocator.free(forwarded_buffer);
    const forwarded = try forwardScreenDcs(output, forwarded_buffer);
    const encoded_len = std.base64.standard.Encoder.calcSize(payload.len);
    const expected = try testing.allocator.alloc(u8, "\x1b]52;c;".len + encoded_len + 1);
    defer testing.allocator.free(expected);
    @memcpy(expected[0.."\x1b]52;c;".len], "\x1b]52;c;");
    _ = std.base64.standard.Encoder.encode(expected["\x1b]52;c;".len .. expected.len - 1], payload);
    expected[expected.len - 1] = '\x07';
    try testing.expectEqualSlices(u8, expected, forwarded);
}

test "writeClipboard - base64 encodes raw UTF-8 bytes" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    var term = Terminal.init(.{ .env_map = &env });

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();
    try term.writeClipboard(&writer, .clipboard, "世界 café 🚀");

    try testing.expectEqualStrings("\x1b]52;c;5LiW55WMIGNhZsOpIPCfmoA=\x1b\\", writer.getWritten());
}

test "writeClipboard - handles base64 padding and encoding chunk boundaries" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    var term = Terminal.init(.{ .env_map = &env });
    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    const cases = [_]struct { raw: []const u8, encoded: []const u8 }{
        .{ .raw = "", .encoded = "" },
        .{ .raw = "a", .encoded = "YQ==" },
        .{ .raw = "ab", .encoded = "YWI=" },
        .{ .raw = "abc", .encoded = "YWJj" },
    };
    for (cases) |case| {
        writer.reset();
        try term.writeClipboard(&writer, .clipboard, case.raw);
        try testing.expectEqualStrings("\x1b]52;c;", writer.getWritten()[0..7]);
        try testing.expectEqualStrings(case.encoded, writer.getWritten()[7 .. writer.getWritten().len - 2]);
        try testing.expect(std.mem.endsWith(u8, writer.getWritten(), "\x1b\\"));
    }

    const payload = [_]u8{'A'} ** (3 * 1024 + 1);
    const encoded_len = std.base64.standard.Encoder.calcSize(payload.len);
    const expected = try testing.allocator.alloc(u8, encoded_len);
    defer testing.allocator.free(expected);
    _ = std.base64.standard.Encoder.encode(expected, &payload);

    writer.reset();
    try term.writeClipboard(&writer, .clipboard, &payload);
    try testing.expectEqualSlices(u8, expected, writer.getWritten()[7 .. writer.getWritten().len - 2]);
}

test "clipboardSequenceSize - matches plain, tmux, and Screen output" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    const payload = "size me 世界";
    const environments = [_]struct { key: ?[]const u8, value: []const u8 }{
        .{ .key = null, .value = "" },
        .{ .key = "TMUX", .value = "/tmp/tmux-1000/default,12345,0" },
        .{ .key = "STY", .value = "12345.pts-0.hostname" },
    };

    for (environments) |environment| {
        var env = std.process.Environ.Map.init(testing.allocator);
        defer env.deinit();
        if (environment.key) |key| try env.put(key, environment.value);
        var term = Terminal.init(.{ .env_map = &env });

        var writer = TestWriter.init(testing.allocator);
        defer writer.deinit();
        try term.writeClipboard(&writer, .clipboard, payload);

        try testing.expectEqual(try term.clipboardSequenceSize(payload.len), writer.getWritten().len);
    }
}

test "clipboardSequenceSize - rejects payloads beyond the FFI limit" {
    if (std.math.maxInt(usize) == std.math.maxInt(u32)) return error.SkipZigTest;

    var term: Terminal = .{};
    try testing.expectError(
        error.ClipboardPayloadTooLarge,
        term.clipboardSequenceSize(@as(usize, Terminal.CLIPBOARD_PAYLOAD_SIZE_MAX) + 1),
    );
}

test "writeClipboard - Screen framing crosses the 252-byte boundary" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("STY", "12345.pts-0.hostname");
    var term = Terminal.init(.{ .env_map = &env });

    const payload_one_chunk = [_]u8{'A'} ** 183;
    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();
    try term.writeClipboard(&writer, .clipboard, &payload_one_chunk);
    try testing.expectEqual(@as(usize, 1), countSubstring(writer.getWritten(), ansi.ANSI.screenDcsStart));
    try testing.expectEqual(try term.clipboardSequenceSize(payload_one_chunk.len), writer.getWritten().len);

    writer.reset();
    const payload_two_chunks = [_]u8{'A'} ** 184;
    try term.writeClipboard(&writer, .clipboard, &payload_two_chunks);
    try testing.expectEqual(@as(usize, 2), countSubstring(writer.getWritten(), ansi.ANSI.screenDcsStart));
    try testing.expectEqual(try term.clipboardSequenceSize(payload_two_chunks.len), writer.getWritten().len);
}

test "writeClipboard - wraps in DCS passthrough for tmux" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.Environ.Map.init(testing.allocator);
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
    try testing.expect(std.mem.find(u8, output, "\x1b\x1b") != null);
}

test "writeClipboard - wraps in DCS passthrough for GNU Screen" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("STY", "12345.pts-0.hostname");

    var term = Terminal.init(.{ .env_map = &env });

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.writeClipboard(&writer, .clipboard, "test");

    try testing.expectEqualStrings("\x1bP\x1b]52;c;dGVzdA==\x07\x1b\\", writer.getWritten());
}

test "writeClipboard - handles tmux sessions" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.Environ.Map.init(testing.allocator);
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
    try testing.expect(std.mem.find(u8, output, "\x1b\x1b") != null);
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

fn forwardScreenDcs(input: []const u8, output: []u8) ![]const u8 {
    var input_offset: usize = 0;
    var output_offset: usize = 0;
    while (input_offset < input.len) {
        if (!std.mem.startsWith(u8, input[input_offset..], ansi.ANSI.screenDcsStart)) {
            return error.InvalidScreenDcsStart;
        }
        const content_start = input_offset + ansi.ANSI.screenDcsStart.len;
        const end_offset = std.mem.find(u8, input[content_start..], ansi.ANSI.screenDcsEnd) orelse {
            return error.MissingScreenDcsEnd;
        };
        const content = input[content_start .. content_start + end_offset];
        if (content.len > Terminal.SCREEN_PASSTHROUGH_CHUNK_SIZE) return error.ScreenDcsPayloadTooLarge;
        if (output_offset + content.len > output.len) return error.ScreenDcsOutputTooSmall;
        @memcpy(output[output_offset .. output_offset + content.len], content);
        output_offset += content.len;
        input_offset = content_start + end_offset + ansi.ANSI.screenDcsEnd.len;
    }
    return output[0..output_offset];
}

test "queryTerminalSend - force-off rejects unrelated row-1 cursor reports" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("OPENTUI_FORCE_EXPLICIT_WIDTH", "0");

    var term = Terminal.init(.{ .env_map = &env });

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.queryTerminalSend(&writer);

    const output = writer.getWritten();

    // Should not contain OSC 66 queries
    try testing.expect(std.mem.find(u8, output, "\x1b]66;") == null);

    // Should still contain other queries
    try testing.expect(std.mem.find(u8, output, "\x1b[>0q") != null); // xtversion

    // Verify the flag was set correctly
    try testing.expect(term.skip_explicit_width_query);
    try testing.expect(!term.caps.explicit_width);

    term.processCapabilityResponse("\x1b[1;2R");
    try testing.expect(!term.caps.explicit_width);
    try testing.expect(!term.caps.scaled_text);
}

test "queryTerminalSend - sends OSC 66 queries by default" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();

    var term = Terminal.init(.{ .env_map = &env });

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.queryTerminalSend(&writer);

    const output = writer.getWritten();

    // Should contain OSC 66 explicit width query
    try testing.expect(std.mem.find(u8, output, "\x1b]66;w=1; \x1b\\") != null);

    // Should contain OSC 66 scaled text query
    try testing.expect(std.mem.find(u8, output, "\x1b]66;s=2; \x1b\\") != null);

    // Verify the flag was not set
    try testing.expect(!term.skip_explicit_width_query);
}

test "queryTerminalSend - sends OSC 66 queries when OPENTUI_FORCE_EXPLICIT_WIDTH=true" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("OPENTUI_FORCE_EXPLICIT_WIDTH", "true");

    var term = Terminal.init(.{ .env_map = &env });

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.queryTerminalSend(&writer);

    const output = writer.getWritten();

    // Should contain OSC 66 queries
    try testing.expect(std.mem.find(u8, output, "\x1b]66;w=1; \x1b\\") != null);
    try testing.expect(std.mem.find(u8, output, "\x1b]66;s=2; \x1b\\") != null);

    // Verify the capability was forced on
    try testing.expect(term.caps.explicit_width);
    try testing.expect(!term.skip_explicit_width_query);
}

test "enableDetectedFeatures - sends initial theme queries" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();

    var term = Terminal.init(.{ .env_map = &env });
    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.enableDetectedFeatures(&writer, false);

    const output = writer.getWritten();

    try testing.expect(std.mem.find(u8, output, ansi.ANSI.colorSchemeSet) != null);
    try testing.expect(std.mem.find(u8, output, "\x1b]10;?\x07") != null);
    try testing.expect(std.mem.find(u8, output, "\x1b]11;?\x07") != null);
    try testing.expect(std.mem.find(u8, output, "\x1b[?996n") == null);
    try testing.expect(term.state.theme_queries_sent);
}

const WidthEnv = struct { key: []const u8, value: []const u8 };

fn expectWidthMethodForEnv(entries: []const WidthEnv, expected: utf8.WidthMethod) !void {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    for (entries) |entry| try env.put(entry.key, entry.value);
    const term = Terminal.init(.{ .env_map = &env });
    try testing.expectEqual(expected, term.caps.unicode);
}

test "Ghostty width profile requires a direct terminal" {
    try expectWidthMethodForEnv(&.{.{ .key = "TERM_PROGRAM", .value = "WezTerm" }}, .unicode);
    try expectWidthMethodForEnv(&.{
        .{ .key = "TMUX", .value = "/tmp/tmux-1000/default,12345,0" },
        .{ .key = "TERM_PROGRAM", .value = "ghostty" },
        .{ .key = "TERM_PROGRAM_VERSION", .value = "1.3.1" },
    }, .wcwidth);
    try expectWidthMethodForEnv(&.{
        .{ .key = "TERM_PROGRAM", .value = "ghostty" },
        .{ .key = "TERM_PROGRAM_VERSION", .value = "1.2.3" },
    }, .unicode);
    try expectWidthMethodForEnv(&.{
        .{ .key = "TERM_PROGRAM", .value = "ghostty" },
        .{ .key = "TERM_PROGRAM_VERSION", .value = "0.0.0-20260223.r14707.gc61f184" },
    }, .unicode);
    try expectWidthMethodForEnv(&.{
        .{ .key = "TERM_PROGRAM", .value = "ghostty" },
        .{ .key = "TERM_PROGRAM_VERSION", .value = "0.0.0-20260224.r14762.gc51f0d7" },
    }, .unicode_wide);
}

test "Ghostty width profile preserves explicit wcwidth override" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("TERM_PROGRAM", "ghostty");
    try env.put("TERM_PROGRAM_VERSION", "1.3.1");
    try env.put("OPENTUI_FORCE_WCWIDTH", "1");

    var term = Terminal.init(.{ .env_map = &env });
    try testing.expectEqual(utf8.WidthMethod.wcwidth, term.caps.unicode);
    term.processCapabilityResponse("\x1b[?2027;2$y\x1bP>|ghostty 1.3.1\x1b\\");
    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();
    try term.enableDetectedFeatures(&writer, false);
    try testing.expectEqual(utf8.WidthMethod.wcwidth, term.caps.unicode);
}

test "Ghostty width profile enables mode 2027 and remains stable after setup starts" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("TERM_PROGRAM", "ghostty");
    try env.put("TERM_PROGRAM_VERSION", "1.3.1");

    var term = Terminal.init(.{ .env_map = &env });
    try testing.expectEqual(utf8.WidthMethod.unicode_wide, term.caps.unicode);
    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();
    try term.queryTerminalSend(&writer);

    term.processCapabilityResponse("\x1b[?2027;2$y\x1bP>|WezTerm 20240203-110809-5046fc22\x1b\\");
    try term.enableDetectedFeatures(&writer, false);
    try testing.expectEqual(utf8.WidthMethod.unicode_wide, term.caps.unicode);
    try testing.expect(std.mem.find(u8, writer.getWritten(), ansi.ANSI.unicodeSet) != null);
}

test "setMouseMode - enable without movement keeps click/drag only" {
    var term = Terminal.init(.{});
    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.setMouseMode(&writer, true, false);

    const output = writer.getWritten();
    const idx_disable_any = std.mem.find(u8, output, ansi.ANSI.disableAnyEventTracking).?;
    const idx_enable_mouse = std.mem.find(u8, output, ansi.ANSI.enableMouseTracking).?;
    const idx_enable_button = std.mem.find(u8, output, ansi.ANSI.enableButtonEventTracking).?;
    const idx_enable_sgr = std.mem.find(u8, output, ansi.ANSI.enableSGRMouseMode).?;
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.enableAnyEventTracking) == null);
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
    const idx_enable_mouse = std.mem.find(u8, output, ansi.ANSI.enableMouseTracking).?;
    const idx_enable_button = std.mem.find(u8, output, ansi.ANSI.enableButtonEventTracking).?;
    const idx_enable_any = std.mem.find(u8, output, ansi.ANSI.enableAnyEventTracking).?;
    const idx_enable_sgr = std.mem.find(u8, output, ansi.ANSI.enableSGRMouseMode).?;
    try testing.expect(idx_enable_mouse < idx_enable_button);
    try testing.expect(idx_enable_button < idx_enable_any);
    try testing.expect(idx_enable_any < idx_enable_sgr);
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.disableAnyEventTracking) == null);

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
    const idx_disable_any = std.mem.find(u8, output, ansi.ANSI.disableAnyEventTracking).?;
    const idx_enable_mouse = std.mem.find(u8, output, ansi.ANSI.enableMouseTracking).?;
    const idx_enable_button = std.mem.find(u8, output, ansi.ANSI.enableButtonEventTracking).?;
    const idx_enable_sgr = std.mem.find(u8, output, ansi.ANSI.enableSGRMouseMode).?;
    try testing.expect(idx_disable_any < idx_enable_mouse);
    try testing.expect(idx_enable_mouse < idx_enable_button);
    try testing.expect(idx_enable_button < idx_enable_sgr);
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.enableAnyEventTracking) == null);
}

test "resetState - checked helpers preserve legacy byte order" {
    const initial: Terminal = .{ .state = .{
        .alt_screen = true,
        .kitty_keyboard = true,
        .kitty_keyboard_flags = 5,
        .modify_other_keys = true,
        .mouse = true,
        .mouse_was_enabled = true,
        .pixel_mouse = true,
        .bracketed_paste = true,
        .focus_tracking = true,
        .color_scheme_updates = true,
        .mouse_pointer = .pointer,
    } };
    const prefix = ansi.ANSI.showCursor ++ ansi.ANSI.reset ++ ansi.ANSI.resetMousePointer ++
        ansi.ANSI.csiUPop ++ ansi.ANSI.modifyOtherKeysReset ++
        ansi.ANSI.disableAnyEventTracking ++ ansi.ANSI.disableButtonEventTracking ++
        ansi.ANSI.disableMouseTracking ++ ansi.ANSI.disableSGRMouseMode ++
        ansi.ANSI.bracketedPasteReset ++ ansi.ANSI.focusReset;
    const suffix = ansi.ANSI.colorSchemeReset ++ "\x1b]0;\x07";
    const expected = prefix ++ ansi.ANSI.switchToMainScreen ++ suffix;
    var bytes: [expected.len]u8 = undefined;

    for (0..prefix.len) |capacity| {
        var term = initial;
        var writer: std.Io.Writer = .fixed(bytes[0..capacity]);
        try testing.expectError(error.WriteFailed, term.resetInputModes(&writer));
    }
    for (expected.len - suffix.len..expected.len) |capacity| {
        var term = initial;
        var writer: std.Io.Writer = .fixed(bytes[0..capacity]);
        try testing.expectError(error.WriteFailed, term.resetState(&writer));
    }

    var term = initial;
    var writer: std.Io.Writer = .fixed(&bytes);
    try term.resetInputModes(&writer);
    try testing.expectEqualStrings(prefix, writer.buffered());
    try testing.expect(term.state.alt_screen);
    try testing.expect(term.state.color_scheme_updates);
    try testing.expectEqual(Terminal.MousePointerStyle.default, term.state.mouse_pointer);
    try testing.expect(!term.state.kitty_keyboard and term.state.kitty_keyboard_flags == 0);
    try testing.expect(!term.state.modify_other_keys and !term.state.mouse and !term.state.pixel_mouse);
    try testing.expect(!term.state.bracketed_paste and !term.state.focus_tracking);

    try term.exitAltScreen(&writer);
    try term.resetOutputModes(&writer);
    try testing.expectEqualStrings(expected, writer.buffered());
    try testing.expect(!term.state.alt_screen and !term.state.color_scheme_updates);

    var legacy = initial;
    writer = .fixed(&bytes);
    try legacy.resetState(&writer);
    try testing.expectEqualStrings(expected, writer.buffered());
    try testing.expectEqualDeep(term.state, legacy.state);
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
    const idx_disable_any = std.mem.find(u8, output, ansi.ANSI.disableAnyEventTracking).?;
    const idx_disable_button = std.mem.find(u8, output, ansi.ANSI.disableButtonEventTracking).?;
    const idx_disable_mouse = std.mem.find(u8, output, ansi.ANSI.disableMouseTracking).?;
    const idx_disable_sgr = std.mem.find(u8, output, ansi.ANSI.disableSGRMouseMode).?;
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
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.disableAnyEventTracking) == null);
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.disableButtonEventTracking) == null);
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.disableMouseTracking) == null);
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.disableSGRMouseMode) == null);
}
