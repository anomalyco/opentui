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

test "parseXtversion - terminology format enables hyperlinks and osc777 notifications" {
    var term = Terminal.init(.{});
    const response = "\x1bP>|terminology 1.14.0\x1b\\";
    term.processCapabilityResponse(response);

    try testing.expectEqualStrings("terminology", term.getTerminalName());
    try testing.expectEqualStrings("1.14.0", term.getTerminalVersion());
    try testing.expect(term.term_info.from_xtversion);
    try testing.expect(term.caps.hyperlinks);
    try testing.expectEqual(Terminal.NotificationProtocol.osc777, term.notification_protocol);
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

test "graphics detection - tmux ignores unowned Kitty replies" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("TMUX", "/tmp/tmux-1000/default,12345,0");

    var known_tmux = Terminal.init(.{ .env_map = &env });
    known_tmux.processCapabilityResponse("\x1b_Gi=31337;OK\x1b\\");
    try testing.expect(!known_tmux.kitty_graphics_queried);
    try testing.expect(!known_tmux.caps.kitty_graphics);

    var late_tmux = Terminal.init(.{});
    late_tmux.processCapabilityResponse("\x1b_Gi=31337;OK\x1b\\\x1bP>|tmux 3.5a\x1b\\");
    try testing.expect(!late_tmux.kitty_graphics_queried);
    try testing.expect(!late_tmux.caps.kitty_graphics);
}

test "tmux reports focus tracking without DECRQM" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("TMUX", "/tmp/tmux-1000/default,12345,0");

    var term = Terminal.init(.{ .env_map = &env });
    term.processCapabilityResponse("\x1bP>|tmux 3.5a\x1b\\");
    try testing.expect(term.caps.focus_tracking);
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

test "tmux DA does not describe the passthrough Sixel endpoint" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("TERM_PROGRAM", "Apple_Terminal");
    var term = Terminal.init(.{ .env_map = &env });
    term.processCapabilityResponse("\x1bP>|tmux 3.5a\x1b\\");
    try testing.expect(!term.caps.sixel);
    try testing.expect(!term.refusesForcedSixel());

    term.processCapabilityResponse("\x1b[?62;4c");
    try testing.expect(!term.caps.sixel);
    try testing.expect(!term.refusesForcedSixel());
}

test "known tmux ignores its own Sixel DA response" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("TMUX", "/tmp/tmux-1000/default,12345,0");

    var supported_tmux = Terminal.init(.{ .env_map = &env });
    supported_tmux.processCapabilityResponse("\x1b[?1;2;4c");
    try testing.expect(!supported_tmux.caps.sixel);
    try testing.expect(!supported_tmux.refusesForcedSixel());

    var unsupported_tmux = Terminal.init(.{ .env_map = &env });
    unsupported_tmux.processCapabilityResponse("\x1b[?1;2c");
    try testing.expect(!unsupported_tmux.caps.sixel);
    try testing.expect(!unsupported_tmux.refusesForcedSixel());
}

test "late tmux detection clears its Sixel DA response" {
    var term = Terminal.init(.{});
    term.processCapabilityResponse("\x1b[?1;2;4c\x1bP>|tmux 3.7b\x1b\\");
    try testing.expect(term.isInTmux());
    try testing.expect(!term.caps.sixel);
    try testing.expect(!term.sixel_queried);
    try testing.expect(!term.refusesForcedSixel());

    var da_first = Terminal.init(.{});
    da_first.processCapabilityResponse("\x1b[?1;2;4c");
    da_first.processCapabilityResponse("\x1bP>|tmux 3.7b\x1b\\");
    try testing.expect(!da_first.caps.sixel);
    try testing.expect(!da_first.sixel_queried);

    var da_last = Terminal.init(.{});
    da_last.processCapabilityResponse("\x1bP>|tmux 3.7b\x1b\\");
    da_last.processCapabilityResponse("\x1b[?1;2;4c");
    try testing.expect(!da_last.caps.sixel);
    try testing.expect(!da_last.sixel_queried);
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

test "program status - only an OSC 7501 query reply enables the capability" {
    for ([_]struct { []const u8, bool }{
        .{ "\x1b]7501;?\x1b\\", true },
        .{ "\x1b]7501;?\x07", true },
        .{ "\x1b]7501; ? : states=idle,working,done,blocked,error : kinds=permission,question,auth\x1b\\", true },
        .{ "\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\", true },
        .{ "\x1b]7501;state=idle\x1b\\", false },
        .{ "\x1b]7501;??\x1b\\", false },
        .{ "\x1b]7501;\x1b\\", false },
        .{ "\x1b]75010;?\x1b\\", false },
        .{ "\x1b]99;?\x1b\\", false },
    }) |case| {
        var term = Terminal.init(.{});
        term.processCapabilityResponse(case[0]);
        try testing.expectEqual(case[1], term.caps.program_status);
    }
}

test "queryTerminalSend - foot skips OSC capability queries" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("TERM", "foot");
    var term = Terminal.init(.{ .env_map = &env });
    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();
    try term.queryTerminalSend(&writer);
    try testing.expect(std.mem.find(u8, writer.getWritten(), ansi.ANSI.notificationQueries) == null);
    try testing.expect(std.mem.find(u8, writer.getWritten(), ansi.ANSI.programStatusQuery) == null);
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
    // ConEmu reads every OSC 9 as a subcommand (sleep, message box, macro, process) and shows no notification.
    for ([_]struct { []const u8, Terminal.NotificationProtocol }{
        .{ "\x1bP>|kitty(0.46.2)\x1b\\", .osc99 },
        .{ "\x1bP>|ghostty 1.3.1\x1b\\", .osc777 },
        .{ "\x1bP>|iTerm2 3.6.9\x1b\\", .osc9 },
        .{ "\x1bP>|ConEmu 230724\x1b\\", .none },
    }) |case| {
        var term = Terminal.init(.{ .remote_mode = .remote });
        term.processCapabilityResponse(case[0]);
        try testing.expectEqual(case[1] != .none, term.caps.notifications);
        try testing.expectEqual(case[1], term.notification_protocol);
    }
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

test "remote detection - auto mode ignores forwarded terminal identity after SSH marker" {
    var term = Terminal.init(.{ .remote_mode = .auto });
    defer term.deinit();

    try term.setHostEnvVar(testing.allocator, "SSH_CONNECTION", "192.0.2.1 54231 192.0.2.2 22");
    try term.setHostEnvVar(testing.allocator, "TERM", "xterm-256color");
    try term.setHostEnvVar(testing.allocator, "TERM_PROGRAM", "ghostty");
    try term.setHostEnvVar(testing.allocator, "TERM_PROGRAM_VERSION", "1.3.1");

    try testing.expect(term.caps.remote);
    try testing.expectEqual(utf8.WidthMethod.unicode, term.caps.unicode);
    try testing.expect(!term.caps.notifications);
    try testing.expectEqualStrings("", term.getTerminalName());
}

test "remote detection - TERM and COLORTERM set color depth in every remote mode" {
    const cases = [_]struct { term: []const u8, colorterm: ?[]const u8 = null, force: ?[]const u8 = null, tmux: bool = false, ansi256: bool, rgb: bool }{
        // GNU screen drops 24-bit colors by default, and an inherited COLORTERM describes the terminal outside it.
        .{ .term = "screen-256color", .ansi256 = true, .rgb = false },
        .{ .term = "screen", .ansi256 = true, .rgb = false },
        .{ .term = "screen", .colorterm = "truecolor", .ansi256 = true, .rgb = false },
        .{ .term = "screen", .colorterm = "24bit", .ansi256 = true, .rgb = false },
        .{ .term = "screen", .colorterm = "truecolor", .force = "1", .ansi256 = true, .rgb = true },
        .{ .term = "screen-256color", .colorterm = "truecolor", .tmux = true, .ansi256 = true, .rgb = true },
        .{ .term = "xterm", .force = "true", .ansi256 = true, .rgb = true },
        .{ .term = "xterm", .force = "yes", .ansi256 = false, .rgb = false },
        .{ .term = "xterm-256color-italic", .colorterm = "yes", .ansi256 = true, .rgb = false },
        .{ .term = "dumb", .colorterm = "256", .ansi256 = false, .rgb = false },
        .{ .term = "", .colorterm = "", .ansi256 = false, .rgb = false },
    };
    // The authoritative env_map takes the full path in every mode; setHostEnvVar forwards one key at a time.
    for ([_]Terminal.RemoteMode{ .local, .auto, .remote }) |mode| for ([_]bool{ false, true }) |forwarded| {
        for (cases) |case| {
            var env = std.process.Environ.Map.init(testing.allocator);
            defer env.deinit();
            try env.put("SSH_CONNECTION", "192.0.2.1 54231 192.0.2.2 22");
            try env.put("TERM", case.term);
            if (case.colorterm) |colorterm| try env.put("COLORTERM", colorterm);
            if (case.force) |force| try env.put("OPENTUI_FORCE_TRUECOLOR", force);
            if (case.tmux) try env.put("TMUX", "/tmp/tmux-1000/default,1,0");

            var term = Terminal.init(.{ .remote_mode = mode, .env_map = if (forwarded) null else &env });
            defer term.deinit();
            if (forwarded) {
                var entries = env.iterator();
                while (entries.next()) |entry| try term.setHostEnvVar(testing.allocator, entry.key_ptr.*, entry.value_ptr.*);
            }

            try testing.expectEqual(mode != .local, term.caps.remote);
            try testing.expectEqual(case.ansi256, term.caps.ansi256);
            try testing.expectEqual(case.rgb, term.caps.rgb);
        }
    };
}

test "remote detection - explicit local mode ignores SSH environment" {
    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("SSH_TTY", "/dev/pts/1");

    const term = Terminal.init(.{ .remote_mode = .local, .env_map = &env });

    try testing.expect(!term.remote);
    try testing.expect(!term.caps.remote);
}

test "processCapabilityResponse captures startup cursor report before the width probes" {
    var term = Terminal.init(.{});
    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();
    try term.queryTerminalSend(&writer);
    try term.queryExplicitWidth(&writer);

    term.processCapabilityResponse("\x1b[7;11R\x1b[2;2R\x1b[2;3R");

    const cursor = term.getCursorPosition();
    try testing.expectEqual(@as(u32, 11), cursor.x);
    try testing.expectEqual(@as(u32, 7), cursor.y);
    try testing.expect(term.startup_cursor_query_captured);
    try testing.expect(!term.startup_cursor_query_pending);
    try testing.expect(term.caps.explicit_width);
    try testing.expect(term.caps.scaled_text);
}

test "a DA1 reply ends startup cursor reports in sentinel mode and reports Sixel only for a graphics query" {
    // Rows: sentinel, multiplexer variable, replies (one capability response each), explicit width, Sixel.
    const rows = .{
        .{ false, "", .{ "\x1b[?62;4c", "\x1b[7;11R", "\x1b[2;2R", "\x1b[2;3R" }, true, true },
        .{ true, "", .{ "\x1b[7;11R", "\x1b[2;2R", "\x1b[2;3R", "\x1b[?62;4c" }, true, true },
        .{ true, "", .{ "\x1b[7;11R\x1b[2;2R\x1b[2;3R\x1b[?62;4c", "", "", "" }, true, true },
        .{ true, "", .{ "\x1b[7;11R", "\x1b[?62;4c", "\x1b[2;2R", "\x1b[2;3R" }, false, true },
        .{ true, "TMUX", .{ "\x1b[7;11R", "\x1b[2;2R", "\x1b[2;3R", "\x1b[?62;4c" }, true, false },
        .{ true, "STY", .{ "\x1b[7;11R", "\x1b[2;2R", "\x1b[2;3R", "\x1b[?62;4c" }, true, false },
    };
    inline for (rows) |row| {
        var env = std.process.Environ.Map.init(testing.allocator);
        defer env.deinit();
        if (row[1].len != 0) try env.put(row[1], "fixture");
        var term = Terminal.init(.{ .env_map = &env });
        term.reply_sentinel = row[0];
        var writer = TestWriter.init(testing.allocator);
        defer writer.deinit();
        try term.queryTerminalSend(&writer);
        try term.queryExplicitWidth(&writer);
        inline for (row[2]) |reply| term.processCapabilityResponse(reply);
        try testing.expectEqual(row[3], term.caps.explicit_width);
        try testing.expectEqual(row[4], term.caps.sixel);
    }
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
    try startup_on_row_one.queryExplicitWidth(&startup_writer);
    startup_on_row_one.processCapabilityResponse("\x1b[1;5R");
    startup_on_row_one.processCapabilityResponse("\x1b[2;2R");
    startup_on_row_one.processCapabilityResponse("\x1b[2;3R");
    const cursor = startup_on_row_one.getCursorPosition();
    try testing.expectEqual(@as(u32, 5), cursor.x);
    try testing.expectEqual(@as(u32, 1), cursor.y);
    try testing.expect(startup_on_row_one.caps.explicit_width);
    try testing.expect(startup_on_row_one.caps.scaled_text);

    // The probes run on row 2: the wrong columns there (#1383), or the right ones on row 1, where Shift+F3 and
    // Alt+F3 send the same bytes, are no answer. Nor is a repeated startup report at (2,2) before a terminal that
    // ignores OSC 66 answers column 1 twice: only a pair of replies that both moved counts.
    for ([_][]const u8{ "\x1b[7;11R\x1b[2;12R\x1b[2;8R", "\x1b[7;11R\x1b[1;2R\x1b[1;3R", "\x1b[2;2R\x1b[2;2R\x1b[2;1R\x1b[2;1R" }) |replies| {
        var echoed = Terminal.init(.{});
        var echoed_writer = TestWriter.init(testing.allocator);
        defer echoed_writer.deinit();
        try echoed.queryTerminalSend(&echoed_writer);
        try echoed.queryExplicitWidth(&echoed_writer);
        echoed.processCapabilityResponse(replies);
        try testing.expect(!echoed.caps.explicit_width);
        try testing.expect(!echoed.caps.scaled_text);
    }
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

// WT_SESSION names Windows Terminal at the endpoint on every host OS: locally, in WSL, or forwarded to an
// explicit remote session. A multiplexer, a non-xterm TERM, or an old VTE sits between, and auto mode ignores a
// forwarded one. Its 24-bit color holds outside GNU screen, which drops 24-bit colors unless forced.
test "environment overrides - WT_SESSION enables hyperlinks and rgb for Windows Terminal" {
    const Row = struct { env: []const u8, mode: Terminal.RemoteMode = .local, hyperlinks: bool, rgb: bool };
    const rows = [_]Row{
        .{ .env = "WT_SESSION=1", .hyperlinks = true, .rgb = true },
        .{ .env = "WT_SESSION=1 TERM=", .hyperlinks = true, .rgb = true },
        .{ .env = "WT_SESSION=1 TERM=xterm-256color WSL_DISTRO_NAME=Ubuntu", .hyperlinks = true, .rgb = true },
        .{ .env = "TERM=xterm-256color WSL_DISTRO_NAME=Ubuntu", .hyperlinks = false, .rgb = false },
        .{ .env = "WT_SESSION=1 TERM=screen-256color WSL_INTEROP=/run/WSL/1_interop", .hyperlinks = false, .rgb = false },
        .{ .env = "WT_SESSION=1 TERM=screen", .mode = .remote, .hyperlinks = false, .rgb = false },
        .{ .env = "WT_SESSION=1 TERM=xterm-256color STY=1.pts-0.host", .hyperlinks = false, .rgb = false },
        .{ .env = "WT_SESSION=1 TERM=xterm-256color STY=1.pts-0.host TMUX=/tmp/tmux-1000/default,1,0", .hyperlinks = false, .rgb = false },
        .{ .env = "WT_SESSION=1 TERM=screen-256color STY=1.pts-0.host OPENTUI_FORCE_TRUECOLOR=1", .hyperlinks = false, .rgb = true },
        .{ .env = "WT_SESSION=1 TERM=xterm-256color WSL_DISTRO_NAME=Ubuntu ZELLIJ=0", .hyperlinks = false, .rgb = true },
        .{ .env = "WT_SESSION=1 TERM=xterm-256color VTE_VERSION=5000", .hyperlinks = false, .rgb = true },
        .{ .env = "WT_SESSION=1 TERM=xterm-256color SSH_CONNECTION=1", .mode = .auto, .hyperlinks = false, .rgb = false },
        .{ .env = "WT_SESSION=1 TERM=xterm-256color", .mode = .remote, .hyperlinks = true, .rgb = true },
        .{ .env = "WT_SESSION=1", .mode = .remote, .hyperlinks = true, .rgb = true },
        .{ .env = "WT_SESSION=1 TERM=rxvt-unicode-256color", .mode = .remote, .hyperlinks = false, .rgb = true },
        .{ .env = "WT_SESSION=1 TERM=xterm-256color TMUX=/tmp/tmux-1000/default,1,0", .mode = .remote, .hyperlinks = false, .rgb = true },
    };
    for (rows, 0..) |row, index| {
        errdefer std.debug.print("WT_SESSION row {d}\n", .{index});
        var env = std.process.Environ.Map.init(testing.allocator);
        try putEnv(&env, row.env);
        var term = Terminal.init(.{ .remote_mode = row.mode });
        term.adoptHostEnvironment(env);
        defer term.deinit();
        try testing.expectEqual(row.hyperlinks, term.caps.hyperlinks);
        try testing.expectEqual(row.rgb, term.caps.rgb);
    }
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

test "environment overrides - STY forwarded after WT_SESSION revokes rgb and hyperlinks" {
    var term = Terminal.init(.{});
    defer term.deinit();

    try term.setHostEnvVar(testing.allocator, "TERM", "xterm-256color");
    try term.setHostEnvVar(testing.allocator, "WT_SESSION", "test-session");

    try testing.expect(term.caps.rgb);
    try testing.expect(term.caps.hyperlinks);

    try term.setHostEnvVar(testing.allocator, "STY", "1234.pts-0.host");

    try testing.expect(!term.caps.rgb);
    try testing.expect(!term.caps.hyperlinks);
}

test "environment overrides - TERM_PROGRAM and VTE_VERSION enable hyperlinks for OSC 8 terminals" {
    const cases = [_]struct { key: []const u8, value: []const u8, hyperlinks: bool }{
        .{ .key = "TERM_PROGRAM", .value = "vscode", .hyperlinks = true },
        .{ .key = "TERM_PROGRAM", .value = "zed", .hyperlinks = true },
        .{ .key = "TERM_PROGRAM", .value = "mintty", .hyperlinks = true },
        .{ .key = "TERM_PROGRAM", .value = "Apple_Terminal", .hyperlinks = false },
        .{ .key = "VTE_VERSION", .value = "5202", .hyperlinks = true },
        .{ .key = "VTE_VERSION", .value = "5201", .hyperlinks = false },
        .{ .key = "VTE_VERSION", .value = "invalid", .hyperlinks = false },
    };
    for (cases) |case| {
        var env = std.process.Environ.Map.init(testing.allocator);
        defer env.deinit();
        try env.put("TERM", "xterm-256color");
        try env.put(case.key, case.value);

        const term = Terminal.init(.{ .env_map = &env });
        try testing.expectEqual(case.hyperlinks, term.caps.hyperlinks);
    }
}

test "environment overrides - TERM_PROGRAM and WT_SESSION hyperlinks require a direct terminal" {
    const multiplexers = [_]struct {
        key: []const u8,
        value: []const u8,
        kind: Terminal.Multiplexer,
    }{
        .{ .key = "STY", .value = "1234.session", .kind = .screen },
        .{ .key = "TMUX", .value = "/tmp/tmux-1000/default,1,0", .kind = .tmux },
        .{ .key = "ZELLIJ", .value = "0", .kind = .zellij },
    };

    for ([_][2][]const u8{ .{ "TERM_PROGRAM", "vscode" }, .{ "WT_SESSION", "1" } }) |host| for (multiplexers) |multiplexer| {
        var term = Terminal.init(.{});
        defer term.deinit();

        try term.setHostEnvVar(testing.allocator, host[0], host[1]);
        try testing.expect(term.caps.hyperlinks);

        try term.setHostEnvVar(testing.allocator, multiplexer.key, multiplexer.value);
        try testing.expectEqual(multiplexer.kind, term.multiplexer);
        try testing.expect(!term.caps.hyperlinks);
    };
}

test "environment overrides - Rex hyperlinks match exact TERM and XTVersion names" {
    const cases = [_]struct { term: []const u8, reply: ?[]const u8 = null, hyperlinks: bool }{
        .{ .term = "xterm-256color", .reply = "\x1bP>|rex 0.0.1793047680-g2db882\x1b\\", .hyperlinks = true },
        .{ .term = "xterm-rex", .hyperlinks = true },
        .{ .term = "ReX", .hyperlinks = true },
        .{ .term = "xterm-rex-extra", .hyperlinks = false },
    };
    for (cases) |case| {
        var env = std.process.Environ.Map.init(testing.allocator);
        defer env.deinit();
        try env.put("TERM", case.term);

        var term = Terminal.init(.{ .env_map = &env });
        if (case.reply) |reply| {
            term.processCapabilityResponse(reply);
            term.checkEnvironmentOverrides();
        }
        try testing.expectEqual(case.hyperlinks, term.caps.hyperlinks);
    }
}

test "environment overrides - FORCE_HYPERLINK forces hyperlink support" {
    const enabled_values = [_][]const u8{ "1", "" };
    for (enabled_values) |value| {
        var env = std.process.Environ.Map.init(testing.allocator);
        defer env.deinit();
        try env.put("TERM", "xterm-256color");
        try env.put("ZELLIJ", "0");
        try env.put("FORCE_HYPERLINK", value);

        const term = Terminal.init(.{ .env_map = &env });
        try testing.expect(term.caps.hyperlinks);
    }

    var env = std.process.Environ.Map.init(testing.allocator);
    defer env.deinit();
    try env.put("TERM", "xterm-kitty");
    try env.put("FORCE_HYPERLINK", "0");

    var term = Terminal.init(.{ .env_map = &env });
    try testing.expect(!term.caps.hyperlinks);

    term.processCapabilityResponse("\x1bP>|kitty(0.40.1)\x1b\\");
    try testing.expect(!term.caps.hyperlinks);
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

    try testing.expect(idx_osc_theme_queries < idx_xtversion);
    try testing.expect(std.mem.find(u8, output, "\x1b[?996n") == null);

    // Should contain unwrapped DECRQM queries (single ESC)
    try testing.expect(std.mem.find(u8, output, "\x1b[?1016$p") != null);
    try testing.expect(std.mem.find(u8, output, "\x1b[?2027$p") != null);
    try testing.expect(std.mem.find(u8, output, "\x1b[?u") != null);
    try testing.expect(std.mem.find(u8, output, "\x1bP+q4d73\x1b\\") != null);
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.kittyGraphicsQuery) != null);
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.primaryDeviceAttrs) != null);
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.programStatusQuery) != null);

    // Should NOT contain tmux DCS wrapper
    try testing.expect(std.mem.find(u8, output, "\x1bPtmux;") == null);
}

test "queryTerminalSend - keeps response-generating queries inside tmux" {
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

    try testing.expect(idx_osc_theme_queries < idx_xtversion);
    try testing.expect(std.mem.find(u8, output, "\x1b[?996n") == null);
    try testing.expect(std.mem.find(u8, output, "\x1bPtmux;\x1b\x1b]10;?") == null);

    // tmux answers the queries it implements through the originating pane's PTY.
    try testing.expect(std.mem.find(u8, output, "\x1b[?1016$p") != null);

    // Passthrough replies have no pane ownership and may reach another pane.
    try testing.expect(std.mem.find(u8, output, "\x1bPtmux;") == null);

    // tmux's graphics replies describe tmux, not the passthrough endpoint.
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.kittyGraphicsQuery) == null);
}

test "queryTerminalSend - one DA1 follows DECRQM 2026, and sentinel mode leaves it to the end of the setup" {
    // Without a graphics query too: the DA1 reply settles the 2026 decision when no width probe runs.
    for ([_][]const u8{ "", "TMUX=/tmp/tmux-1000/default,12345,0", "STY=1234.session", "OPENTUI_GRAPHICS=0" }) |vars| {
        var env = std.process.Environ.Map.init(testing.allocator);
        defer env.deinit();
        try putEnv(&env, vars);
        var clock = TestWriter.init(testing.allocator);
        defer clock.deinit();
        var sentinel = TestWriter.init(testing.allocator);
        defer sentinel.deinit();
        var clock_term = Terminal.init(.{ .env_map = &env });
        try clock_term.queryTerminalSend(&clock);
        var sentinel_term = Terminal.init(.{ .env_map = &env });
        sentinel_term.reply_sentinel = true;
        try sentinel_term.queryTerminalSend(&sentinel);

        const da1 = ansi.ANSI.primaryDeviceAttrs;
        try testing.expectEqual(@as(usize, 1), std.mem.count(u8, clock.getWritten(), da1));
        try testing.expect(std.mem.find(u8, clock.getWritten(), da1).? > std.mem.find(u8, clock.getWritten(), ansi.ANSI.decrqmSync).?);
        const moved = try std.mem.replaceOwned(u8, testing.allocator, clock.getWritten(), da1, "");
        defer testing.allocator.free(moved);
        try testing.expectEqualStrings(moved, sentinel.getWritten());
    }
}

/// Counts `CSI > flags u`; modifyOtherKeys (`CSI > 4 ; 1 m`) shares the introducer.
fn kittyPushes(bytes: []const u8) usize {
    var count: usize = 0;
    var rest = bytes;
    while (std.mem.find(u8, rest, "\x1b[>")) |start| {
        rest = rest[start + 3 ..];
        const digits = std.mem.indexOfNone(u8, rest, "0123456789") orelse rest.len;
        if (digits != 0 and digits < rest.len and rest[digits] == 'u') count += 1;
    }
    return count;
}

test "Kitty keyboard is confirmed only by the reply to the current push's query" {
    // Ops: a capability reply (then features are enabled, as Session does), a push with flags, a pop, a mode restore.
    const Op = union(enum) { reply: []const u8, push: u8, pop, restore };
    const xtversion: Op = .{ .reply = "\x1bP>|kitty(0.40.1)\x1b\\" };
    const da1: Op = .{ .reply = "\x1b[?62;22c" };
    const rows = .{
        // XTVERSION pushes before the startup `?0u` arrives; that stale reply must not confirm.
        .{ true, .{ xtversion, Op{ .reply = "\x1b[?0u" } }, false },
        .{ true, .{ xtversion, Op{ .reply = "\x1b[?0u" }, Op{ .reply = "\x1b[?5u" } }, true },
        .{ true, .{Op{ .reply = "\x1b[?0u" }}, false },
        .{ true, .{ Op{ .reply = "\x1b[?0u" }, Op{ .reply = "\x1b[?1u" } }, true },
        .{ true, .{ Op{ .reply = "\x1b[?0u" }, Op{ .reply = "\x1b[?4u" } }, false },
        .{ true, .{ Op{ .reply = "\x1b[?0u" }, Op.pop, Op{ .push = 8 }, Op{ .reply = "\x1b[?5u" }, Op{ .reply = "\x1b[?8u" } }, true },
        .{ true, .{ Op{ .reply = "\x1b[?0u" }, Op.pop, Op{ .push = 2 }, Op{ .reply = "\x1b[?5u" }, Op{ .reply = "\x1b[?3u" } }, false },
        // Two-digit flags: 21 has disambiguate, 16 (report text) has neither bit.
        .{ true, .{ Op{ .reply = "\x1b[?0u" }, Op.pop, Op{ .push = 21 }, Op{ .reply = "\x1b[?5u" }, Op{ .reply = "\x1b[?21u" } }, true },
        .{ true, .{ Op{ .reply = "\x1b[?0u" }, Op.pop, Op{ .push = 17 }, Op{ .reply = "\x1b[?5u" }, Op{ .reply = "\x1b[?16u" } }, false },
        // Two pushes: the reply to the first answers the first query only.
        .{ true, .{ Op{ .reply = "\x1b[?0u" }, Op.pop, Op{ .push = 7 }, Op{ .reply = "\x1b[?5u" } }, false },
        .{ true, .{ Op{ .reply = "\x1b[?0u" }, Op{ .reply = "\x1b[?5u" }, Op.pop }, false },
        .{ true, .{ Op{ .reply = "\x1b[?0u" }, Op{ .reply = "\x1b[?5u" }, Op.pop, Op{ .reply = "\x1b[?5u" } }, false },
        // Focus restore and resume push again, and only their own reply confirms.
        .{ true, .{ Op{ .reply = "\x1b[?0u" }, Op{ .reply = "\x1b[?5u" }, Op.restore }, false },
        .{ true, .{ Op{ .reply = "\x1b[?0u" }, Op{ .reply = "\x1b[?5u" }, Op.restore, Op{ .reply = "\x1b[?5u" } }, true },
        .{ true, .{ Op{ .reply = "\x1b[?0u" }, Op{ .reply = "\x1b[?5u" }, Op.pop, Op{ .push = 5 }, Op{ .reply = "\x1b[?5u" } }, true },
        // The confirmation does not wait for DA1: OpenSSH ConPTY forwards `?5u` after its own DA1 (argon-1).
        .{ true, .{ Op{ .reply = "\x1b[?0u" }, da1, Op{ .reply = "\x1b[?5u" } }, true },
        // Four unanswered queries fill the queue; a fifth push sends none, so no reply can confirm it.
        .{ true, .{ Op{ .reply = "\x1b[?0u" }, Op.restore, Op.restore, Op.restore, Op.restore, Op{ .reply = "\x1b[?5u" }, Op{ .reply = "\x1b[?5u" }, Op{ .reply = "\x1b[?5u" }, Op{ .reply = "\x1b[?5u" }, Op{ .reply = "\x1b[?5u" } }, false },
        // Clock mode sends no new query, so the host's parser sees no new reply and nothing confirms.
        .{ false, .{ Op{ .reply = "\x1b[?0u" }, Op{ .reply = "\x1b[?5u" } }, false },
    };
    inline for (rows) |row| {
        var term = Terminal.init(.{});
        term.reply_sentinel = row[0];
        var writer = TestWriter.init(testing.allocator);
        defer writer.deinit();
        try term.queryTerminalSend(&writer);
        try testing.expectEqual(@as(usize, 1), std.mem.count(u8, writer.getWritten(), ansi.ANSI.csiUQuery));
        // Unanswered queries: a `?Nu` reply answers one, and a query follows a push only while fewer than four wait.
        var unanswered: usize = 1;
        inline for (row[1]) |op| {
            const before = writer.getWritten().len;
            switch (op) {
                .reply => |reply| {
                    if (reply[reply.len - 1] == 'u') unanswered -|= 1;
                    term.processCapabilityResponse(reply);
                    try term.enableDetectedFeatures(&writer, true);
                },
                .push => |flags| try term.setKittyKeyboard(&writer, true, flags),
                .pop => try term.setKittyKeyboard(&writer, false, 0),
                .restore => try term.restoreTerminalModes(&writer),
            }
            // In sentinel mode the query follows the push in the same packet.
            const written = writer.getWritten()[before..];
            const queried = row[0] and kittyPushes(written) != 0 and unanswered < 4;
            unanswered += @intFromBool(queried);
            try testing.expectEqual(@as(usize, @intFromBool(queried)), std.mem.count(u8, written, ansi.ANSI.csiUQuery));
            if (queried) try testing.expectEqual(@as(usize, 1), std.mem.count(u8, written, "u" ++ ansi.ANSI.csiUQuery));
        }
        try testing.expectEqual(row[2], term.state.kitty_confirmed);
    }
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

    try testing.expect(term.caps.osc52);
    try testing.expect(term.caps.hyperlinks);
}

test "processCapabilityResponse - xterm.js enables hyperlinks" {
    var term: Terminal = .{};

    term.processCapabilityResponse("\x1bP>|xterm.js(6.0.0)\x1b\\");

    try testing.expect(term.caps.hyperlinks);
}

test "processCapabilityResponse - foot applies osc52 heuristic without explicit cursor positioning" {
    var term: Terminal = .{};

    const response = "\x1bP>|foot 1.17.2\x1b\\";
    term.processCapabilityResponse(response);

    try testing.expect(term.caps.osc52);
    try testing.expect(term.caps.hyperlinks);
    try testing.expect(!term.caps.explicit_cursor_positioning);
}

/// Puts space-separated `KEY=VALUE` pairs.
fn putEnv(env: *std.process.Environ.Map, pairs: []const u8) !void {
    var it = std.mem.tokenizeScalar(u8, pairs, ' ');
    while (it.next()) |pair| {
        const eq = std.mem.findScalar(u8, pair, '=').?;
        try env.put(pair[0..eq], pair[eq + 1 ..]);
    }
}

test "processCapabilityResponse - XTGETTCAP and XTVERSION replies set clipboard and color only when positive" {
    // No COLORTERM, as over SSH. Replies are recorded from real terminals where named.
    const Row = struct { env: []const u8 = "", replies: []const []const u8, rgb: bool, osc52: ?bool = null, ms: bool = false };
    const rows = [_]Row{
        .{ .replies = &.{"\x1bP1+r4d73=2570312573\x1b\\"}, .rgb = false, .osc52 = true, .ms = true },
        // A negative reply keeps the name heuristic.
        .{ .replies = &.{ "\x1bP>|iTerm2 3.5.0\x1b\\", "\x1bP0+r\x1b\\" }, .rgb = true, .osc52 = true },
        .{ .replies = &.{ "\x1bP>|kitty(0.40.1)\x1b\\", "\x1bP0+r4D73\x1b\\" }, .rgb = true, .osc52 = true },
        .{ .replies = &.{ "\x1bP1+r4d73\x1b\\", "\x1bP1+r4d73=\x1b\\", "\x1bP1+r4d73=abc\x1b\\", "\x1bP1+r4d73=zz\x1b\\", "\x1bP1+r544e=787465726d\x1b\\" }, .rgb = false },
        .{ .replies = &.{"\x1bP1+r524742=38\x1b\\"}, .rgb = true }, // ghostty, foot, xterm
        .{ .replies = &.{"\x1bP1+r5463\x1b\\"}, .rgb = true }, // ghostty, kitty, foot
        .{ .replies = &.{ "\x1bP1+r4D73=1B5D35323B25703125733B257032257307\x1b\\", "\x1bP1+r524742=382F382F38\x1b\\" }, .rgb = true, .ms = true }, // WezTerm
        .{ .replies = &.{"\x1bP1+r5463=31\x1b\\"}, .rgb = true }, // WezTerm
        .{ .replies = &.{ "\x1bP0+r524742\x1b\\", "\x1bP0+r5463\x1b\\", "\x1bP0+r\x1b\\" }, .rgb = false },
        .{ .replies = &.{ "\x1bP1+r524742=zz\x1b\\", "\x1bP1+r524742=3\x1b\\", "\x1bP1+r52474\x1b\\", "\x1bP1+r5463524742\x1b\\", "\x1bP2+r5463\x1b\\", "\x1bP1+r524742=\x1b\\", "\x1bP1+r5463=\x1b\\" }, .rgb = false },
        .{ .replies = &.{"\x1bP1+r524742\x1b\\"}, .rgb = true }, // boolean form
        .{ .replies = &.{"\x1bP>|alacritty 0.13.0\x1b\\\x1bP1+r5463\x1b\\\x1b[?6c"}, .rgb = true },
        .{ .replies = &.{"\x1bP>|ghostty 1.3.1\x1b\\"}, .rgb = true },
        .{ .replies = &.{"\x1bP>|WezTerm 20260716-195552-76b606ec\x1b\\"}, .rgb = true },
        .{ .replies = &.{"\x1bP>|wezterm\x1b\\"}, .rgb = true },
        .{ .replies = &.{"\x1bP>|foot(1.28.0)\x1b\\"}, .rgb = true },
        .{ .replies = &.{"\x1bP>|XTerm(411)\x1b\\"}, .rgb = true },
        .{ .replies = &.{"\x1bP>|tmux 3.8\x1b\\"}, .rgb = true },
        .{ .replies = &.{"\x1bP>|notkitty(1.0)\x1b\\"}, .rgb = false },
        .{ .replies = &.{"\x1bP>|libghostty\x1b\\"}, .rgb = false },
        .{ .replies = &.{"\x1bP>|Zellij(0.44.1)\x1b\\"}, .rgb = false },
        // Only an XTVERSION reply names the terminal; an inherited TERM_PROGRAM does not.
        .{ .env = "TERM_PROGRAM=tmux", .replies = &.{"\x1b[?62;22c"}, .rgb = false },
        // Inside GNU screen no reply counts, also when ssh forwarded screen's TERM without STY.
        .{ .env = "STY=1234.session", .replies = &.{ "\x1bP1+r524742=38\x1b\\", "\x1bP>|kitty(0.40.1)\x1b\\" }, .rgb = false },
        .{ .env = "TERM=screen.xterm-256color", .replies = &.{ "\x1bP1+r5463\x1b\\", "\x1bP>|ghostty 1.3.1\x1b\\" }, .rgb = false },
        // A screen TERM in tmux, or behind ssh from tmux once tmux answers XTVERSION (screen swallows the query).
        .{ .env = "TERM=screen-256color TMUX=/tmp/tmux-1000/default,1,0", .replies = &.{"\x1bP1+r5463\x1b\\"}, .rgb = true },
        .{ .env = "TERM=screen-256color", .replies = &.{"\x1bP>|tmux 3.4\x1b\\"}, .rgb = true },
    };
    for (rows) |row| {
        var env = std.process.Environ.Map.init(testing.allocator);
        defer env.deinit();
        try putEnv(&env, row.env);
        var term = Terminal.init(.{ .env_map = &env });
        for (row.replies) |reply| term.processCapabilityResponse(reply);
        try testing.expectEqual(row.rgb, term.caps.rgb);
        if (row.rgb) try testing.expect(term.caps.ansi256);
        if (row.osc52) |osc52| try testing.expectEqual(osc52, term.caps.osc52);
        try testing.expectEqual(if (row.ms) Terminal.Osc52Support.supported else .unknown, term.osc52_support);
    }
}

test "queryTerminalSend - asks for 24-bit color only when the environment does not settle it, and never screen" {
    // `ms`: the XTGETTCAP Ms query, which screen prints as text (ssh from screen forwards only its TERM).
    // `rgb`: after setup, without replies. ConPTY draws 24-bit color, also for Windows sshd's sessions, but not inside screen.
    const Row = struct { env: []const u8 = "", asks: bool, ms: bool = true, mode: Terminal.RemoteMode = .auto, rgb: bool = builtin.os.tag == .windows };
    const rows = [_]Row{
        .{ .asks = builtin.os.tag != .windows },
        .{ .env = "TERM=xterm-256color", .asks = builtin.os.tag != .windows },
        .{ .env = "TERM=xterm-256color SSH_CONNECTION=1", .asks = builtin.os.tag != .windows },
        .{ .env = "TERM=xterm-256color", .asks = true, .mode = .remote, .rgb = false },
        .{ .env = "TMUX=/tmp/tmux-1000/default,1,0", .asks = builtin.os.tag != .windows },
        .{ .env = "TERM=screen-256color TMUX=/tmp/tmux-1000/default,1,0", .asks = builtin.os.tag != .windows },
        .{ .env = "COLORTERM=truecolor", .asks = false, .rgb = true },
        .{ .env = "STY=1234.session", .asks = false, .ms = false, .rgb = false },
        .{ .env = "STY=1234.session TMUX=/tmp/tmux-1000/default,1,0", .asks = false, .ms = false, .rgb = false },
        .{ .env = "TERM=screen.xterm-256color SSH_CONNECTION=1", .asks = false, .ms = false, .rgb = false },
        .{ .env = "TERM=foot", .asks = false },
    };
    for (rows) |row| for ([_]bool{ false, true }) |sentinel| {
        var env = std.process.Environ.Map.init(testing.allocator);
        try putEnv(&env, row.env);
        var term = Terminal.init(.{ .remote_mode = row.mode });
        term.adoptHostEnvironment(env);
        defer term.deinit();
        term.reply_sentinel = sentinel;
        var writer = TestWriter.init(testing.allocator);
        defer writer.deinit();
        try term.queryTerminalSend(&writer);
        const output = writer.getWritten();
        try testing.expectEqual(row.ms, std.mem.find(u8, output, "\x1bP+q4d73\x1b\\") != null);
        try testing.expect(std.mem.find(u8, output, ansi.ANSI.xtversion) != null and std.mem.find(u8, output, ansi.ANSI.capabilityQueriesBase) != null);
        try testing.expectEqual(row.asks, std.mem.find(u8, output, "\x1bP+q524742\x1b\\") != null);
        try testing.expectEqual(row.asks, std.mem.find(u8, output, "\x1bP+q5463\x1b\\") != null);
        try term.enableDetectedFeatures(&writer, false);
        try testing.expectEqual(row.rgb, term.caps.rgb);
        try testing.expectEqual(row.rgb or !row.ms or std.mem.find(u8, row.env, "256color") != null, term.caps.ansi256);
    };
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

test "writeNotification - text cannot end or redirect its OSC" {
    // C0, DEL and C1 controls become spaces, OSC 777 fields lose their semicolons, and OSC 9 text that starts
    // with a digit gets a space first, so no OSC 9 parser reads it as a ConEmu subcommand. Invalid UTF-8 writes
    // nothing and consumes no ID. Null expects a rejection.
    for ([_]struct { Terminal.NotificationProtocol, []const u8, ?[]const u8, ?[]const u8 }{
        .{ .osc99, "Body", "Title", "\x1b]99;i=opentui-1:p=title:e=1:d=0;VGl0bGU=\x1b\\\x1b]99;i=opentui-1:p=body:e=1:d=1;Qm9keQ==\x1b\\" },
        .{ .osc99, "Body", "", "\x1b]99;i=opentui-1:p=body:e=1:d=1;Qm9keQ==\x1b\\" },
        .{ .osc777, "Bo;dy\n", "Ti;tle", "\x1b]777;notify;Ti tle;Bo dy \x1b\\" },
        .{ .osc777, "a\x00b\x1bc\x1fd\x7fe", null, "\x1b]777;notify;a b c d e;\x1b\\" },
        .{ .osc777, "Body", "", "\x1b]777;notify;;Body\x1b\\" },
        .{ .osc777, "done\u{9c}\u{9b}21t", "ci\u{9c}", "\x1b]777;notify;ci ;done  21t\x1b\\" },
        .{ .osc777, "€ Łódź\u{a0}", "\u{80}\u{9f}", "\x1b]777;notify;  ;€ Łódź\u{a0}\x1b\\" },
        .{ .osc9, "Body\n", "Title", "\x1b]9;Title: Body \x1b\\" },
        .{ .osc9, "x\u{9d}9;/tmp\u{9c}", null, "\x1b]9;x 9;/tmp \x1b\\" },
        .{ .osc9, "4;1;50", null, "\x1b]9; 4;1;50\x1b\\" },
        .{ .osc9, "9;/tmp/demo", null, "\x1b]9; 9;/tmp/demo\x1b\\" },
        .{ .osc9, "5 tests passed", null, "\x1b]9; 5 tests passed\x1b\\" },
        .{ .osc9, "12 files", "", "\x1b]9; 12 files\x1b\\" },
        .{ .osc9, "0", null, "\x1b]9; 0\x1b\\" },
        .{ .osc9, "done", "3;tab", "\x1b]9; 3;tab: done\x1b\\" },
        .{ .osc9, "4;1;50", "CI", "\x1b]9;CI: 4;1;50\x1b\\" },
        .{ .osc99, "\x9c", null, null },
        .{ .osc777, "ok", "\xc2", null },
        .{ .osc9, "\xff", "ok", null },
        .{ .osc9, "ok", "\xed\xa0\x80", null },
    }) |case| {
        var term = Terminal.init(.{ .remote_mode = .remote });
        term.caps.notifications = true;
        term.notification_protocol = case[0];
        var writer = TestWriter.init(testing.allocator);
        defer writer.deinit();
        try testing.expectEqual(case[3] != null, try term.writeNotification(testing.allocator, &writer, case[1], case[2]));
        try testing.expectEqualStrings(case[3] orelse "", writer.getWritten());
        try testing.expectEqual(@intFromBool(case[3] != null), term.notification_id_counter);
    }
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

    const payload: [3 * 1024 + 1]u8 = @splat('A');
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

    const payload_one_chunk: [183]u8 = @splat('A');
    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();
    try term.writeClipboard(&writer, .clipboard, &payload_one_chunk);
    try testing.expectEqual(@as(usize, 1), countSubstring(writer.getWritten(), ansi.ANSI.screenDcsStart));
    try testing.expectEqual(try term.clipboardSequenceSize(payload_one_chunk.len), writer.getWritten().len);

    writer.reset();
    const payload_two_chunks: [184]u8 = @splat('A');
    try term.writeClipboard(&writer, .clipboard, &payload_two_chunks);
    try testing.expectEqual(@as(usize, 2), countSubstring(writer.getWritten(), ansi.ANSI.screenDcsStart));
    try testing.expectEqual(try term.clipboardSequenceSize(payload_two_chunks.len), writer.getWritten().len);
}

// The environment is adopted as an app forwards it, so SSH_CONNECTION makes it a remote client's. GNU screen
// answers no query, so its TERM (forwarded by ssh) or STY names it there too; a tmux XTVERSION reply wins.
// With STY and TMUX both set, a local session checks TMUX first; a remote one counts it as screen (D71a).
test "multiplexer sets clipboard framing, OSC 52, widths and the graphics query, also behind ssh" {
    const screen = "\x1bP\x1b]52;c;dGVzdA==\x07\x1b\\";
    const tmux = "\x1bPtmux;\x1b\x1b]52;c;dGVzdA==\x1b\x1b\\\x1b\\";
    const plain = "\x1b]52;c;dGVzdA==\x1b\\";
    const Row = struct { env: []const u8, reply: []const u8 = "", mux: Terminal.Multiplexer, osc52: bool, width: utf8.WidthMethod, graphics: bool, clipboard: []const u8 };
    const rows = [_]Row{
        .{ .env = "STY=1.pts-0.box", .mux = .screen, .osc52 = true, .width = .wcwidth, .graphics = false, .clipboard = screen },
        .{ .env = "TERM=screen", .mux = .screen, .osc52 = true, .width = .wcwidth, .graphics = false, .clipboard = screen },
        .{ .env = "TMUX=/tmp/tmux-1000/default,1,0", .mux = .tmux, .osc52 = true, .width = .wcwidth, .graphics = false, .clipboard = tmux },
        .{ .env = "TERM=screen.xterm-256color SSH_CONNECTION=1", .mux = .screen, .osc52 = true, .width = .wcwidth, .graphics = false, .clipboard = screen },
        .{ .env = "STY=1.pts-0.box TMUX=/tmp/tmux-1000/default,1,0", .mux = .tmux, .osc52 = true, .width = .wcwidth, .graphics = false, .clipboard = tmux },
        .{ .env = "STY=1.pts-0.box TMUX=/tmp/tmux-1000/default,1,0 SSH_CONNECTION=1", .mux = .screen, .osc52 = true, .width = .wcwidth, .graphics = false, .clipboard = screen },
        .{ .env = "TERM=screen-256color TMUX=/tmp/tmux-1000/default,1,0 SSH_CONNECTION=1", .mux = .none, .osc52 = false, .width = .unicode, .graphics = true, .clipboard = plain },
        .{ .env = "TERM=screen-256color SSH_CONNECTION=1", .reply = "\x1bP>|tmux 3.8\x1b\\", .mux = .tmux, .osc52 = true, .width = .unicode, .graphics = false, .clipboard = tmux },
        .{ .env = "ZELLIJ=0 SSH_CONNECTION=1", .mux = .none, .osc52 = false, .width = .unicode, .graphics = true, .clipboard = plain },
        .{ .env = "TERM=tmux-256color SSH_CONNECTION=1", .mux = .none, .osc52 = false, .width = .unicode, .graphics = true, .clipboard = plain },
    };
    for (rows, 0..) |row, index| {
        errdefer std.debug.print("multiplexer row {d}\n", .{index});
        var env = std.process.Environ.Map.init(testing.allocator);
        try putEnv(&env, row.env);
        var term = Terminal.init(.{ .remote_mode = .auto });
        term.adoptHostEnvironment(env);
        defer term.deinit();
        var writer = TestWriter.init(testing.allocator);
        defer writer.deinit();
        try term.queryTerminalSend(&writer);
        try testing.expectEqual(row.graphics, std.mem.find(u8, writer.getWritten(), ansi.ANSI.kittyGraphicsQuery) != null);
        if (row.reply.len > 0) term.processCapabilityResponse(row.reply);
        try testing.expectEqual(row.mux, term.multiplexer);
        try testing.expectEqual(row.osc52, term.caps.osc52);
        try testing.expectEqual(row.mux != .none, term.caps.explicit_cursor_positioning);
        try testing.expectEqual(row.width, term.caps.unicode);
        writer.reset();
        try term.writeClipboard(&writer, .clipboard, "test");
        try testing.expectEqualStrings(row.clipboard, writer.getWritten());
        // A notification takes the clipboard's framing and terminator, also past one screen chunk. Screen
        // forwards only the low byte of a code point (U+4E07 as BEL, U+4E1B as ESC, U+039C as ST, U+0134
        // as '4'; a C locale ends its DCS at the 9C in U+00DC), so there non-ASCII text becomes spaces.
        term.caps.notifications = true;
        for ([_]struct { Terminal.NotificationProtocol, []const u8, []const u8, ?[]const u8 }{
            .{ .osc99, "test", "99;i=opentui-1:p=body:e=1:d=1;dGVzdA==", null },
            .{ .osc777, "dGVzdA==", "777;notify;dGVzdA==;", null },
            .{ .osc9, "42 tests", "9; 42 tests", null },
            .{ .osc9, "万丛]52;c;UFdORUQ=万", "9;万丛]52;c;UFdORUQ=万", "9;  ]52;c;UFdORUQ= " },
            .{ .osc9, "Ĵ;1;50", "9;Ĵ;1;50", "9; ;1;50" },
            .{ .osc777, "ΜΛ21tćě€Ü“", "777;notify;ΜΛ21tćě€Ü“;", "777;notify;  21t     ;" },
        }) |case| {
            term.notification_protocol = case[0];
            writer.reset();
            try testing.expect(try term.writeNotification(testing.allocator, &writer, case[1], null));
            const sent = if (row.mux == .screen) case[3] orelse case[2] else case[2];
            const notification = try std.mem.replaceOwned(u8, testing.allocator, row.clipboard, "52;c;dGVzdA==", sent);
            defer testing.allocator.free(notification);
            try testing.expectEqualStrings(notification, writer.getWritten());
        }
        if (row.mux != .screen) continue;
        writer.reset();
        const long: [1000]u8 = @splat('x');
        try testing.expect(try term.writeNotification(testing.allocator, &writer, &long, null));
        var forwarded: [1100]u8 = undefined;
        try testing.expectEqualStrings("\x1b]777;notify;" ++ long ++ ";\x07", try forwardScreenDcs(writer.getWritten(), &forwarded));
        // The body's ESC falls on the first chunk's last byte, so it starts the next chunk instead.
        writer.reset();
        term.notification_protocol = .osc99;
        term.notification_id_counter = 9;
        const title: [162]u8 = @splat('x');
        try testing.expect(try term.writeNotification(testing.allocator, &writer, "test", &title));
        try testing.expect(std.mem.find(u8, writer.getWritten(), "\x1b\x1b\\") == null);
        try testing.expect(std.mem.endsWith(u8, try forwardScreenDcs(writer.getWritten(), &forwarded), "\x07\x1b]99;i=opentui-10:p=body:e=1:d=1;dGVzdA==\x07"));
    }
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

test "queryExplicitWidth - OPENTUI_FORCE_EXPLICIT_WIDTH skips the probes or sets the capability" {
    if (builtin.os.tag == .windows) return error.SkipZigTest;

    // Rows: environment value ("" unset), probes sent, explicit width before any reply.
    const rows = .{ .{ "", true, false }, .{ "true", true, true }, .{ "0", false, false } };
    inline for (rows) |row| {
        var env = std.process.Environ.Map.init(testing.allocator);
        defer env.deinit();
        if (row[0].len != 0) try env.put("OPENTUI_FORCE_EXPLICIT_WIDTH", row[0]);
        var term = Terminal.init(.{ .env_map = &env });
        var writer = TestWriter.init(testing.allocator);
        defer writer.deinit();
        try term.queryTerminalSend(&writer);
        try term.queryExplicitWidth(&writer);
        const output = writer.getWritten();
        try testing.expectEqual(row[1], std.mem.find(u8, output, ansi.ANSI.explicitWidthQuery) != null);
        try testing.expectEqual(row[1], std.mem.find(u8, output, ansi.ANSI.scaledTextQuery) != null);
        try testing.expect(std.mem.find(u8, output, ansi.ANSI.xtversion) != null);
        try testing.expectEqual(row[2], term.caps.explicit_width);
        // foot's replies (it draws `w` only); without probes they are not evidence.
        term.processCapabilityResponse("\x1b[7;11R\x1b[2;2R\x1b[2;2R");
        try testing.expectEqual(row[1] or row[2], term.caps.explicit_width);
        try testing.expect(!term.caps.scaled_text);
    }
}

test "XTVERSION kitty 0.40 and foot 1.21 or later report text sizing without a probe" {
    // Rows: XTVERSION reply, OPENTUI_FORCE_EXPLICIT_WIDTH ("" unset), explicit width, scaled text (foot: width only).
    const rows = .{
        .{ "kitty(0.49.2)", "", true, true },   .{ "kitty(0.40.0)", "", true, true },  .{ "kitty(0.39.1)", "", false, false },
        .{ "kitty(1.0.0)", "", true, true },    .{ "kitty(0.9.0)", "", false, false }, .{ "kitty(0.49.2)", "0", false, false },
        .{ "foot(1.28.0)", "", true, false },   .{ "foot(1.21.0)", "", true, false },  .{ "foot(1.20.2)", "", false, false },
        .{ "foot(1.28.0)", "0", false, false }, .{ "tmux 3.5a", "", false, false },
    };
    inline for (rows) |row| {
        var env = std.process.Environ.Map.init(testing.allocator);
        defer env.deinit();
        if (row[1].len != 0) try env.put("OPENTUI_FORCE_EXPLICIT_WIDTH", row[1]);
        var term = Terminal.init(.{ .env_map = &env });
        var writer = TestWriter.init(testing.allocator);
        defer writer.deinit();
        try term.queryTerminalSend(&writer);
        term.processCapabilityResponse("\x1bP>|" ++ row[0] ++ "\x1b\\");
        errdefer std.debug.print("XTVERSION {s}\n", .{row[0]});
        try testing.expectEqual(row[2], term.caps.explicit_width);
        try testing.expectEqual(row[3], term.caps.scaled_text);
    }
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

// Rows: environment, replies (one capability response each), width method. Terminal rows carry
// the DECRPM 2027 and XTVERSION replies measured in that terminal. The environment is adopted as an app
// forwards it, so SSH_CONNECTION makes it a remote client's environment.
test "width method follows the environment, then the DECRPM 2027 reply and XTVERSION" {
    const ghostty = .{ .{ "TERM_PROGRAM", "ghostty" }, .{ "TERM_PROGRAM_VERSION", "1.3.1" } };
    const tmux = .{ "TMUX", "/tmp/tmux-1000/default,12345,0" };
    const ssh = .{ "SSH_CONNECTION", "192.0.2.1 54231 192.0.2.2 22" };
    const tmux38 = .{ tmux, .{ "TERM_PROGRAM", "tmux" }, .{ "TERM_PROGRAM_VERSION", "3.8" } };
    const rows = .{
        .{ .{}, .{}, .unicode },
        .{ .{.{ "TERM_PROGRAM", "WezTerm" }}, .{}, .unicode },
        .{ .{ .{ "TERM_PROGRAM", "WezTerm" }, .{ "VTE_VERSION", "7800" } }, .{}, .unicode },
        .{ ghostty, .{}, .unicode_wide },
        .{ ghostty ++ .{.{ "TERM", "xterm-ghostty" }}, .{}, .unicode_wide },
        .{ .{ .{ "TERM_PROGRAM", "ghostty" }, .{ "TERM_PROGRAM_VERSION", "1.2.3" } }, .{}, .unicode },
        .{ .{ .{ "TERM_PROGRAM", "ghostty" }, .{ "TERM_PROGRAM_VERSION", "0.0.0-20260223.r14707.gc61f184" } }, .{}, .unicode },
        .{ .{ .{ "TERM_PROGRAM", "ghostty" }, .{ "TERM_PROGRAM_VERSION", "0.0.0-20260224.r14762.gc51f0d7" } }, .{}, .unicode_wide },
        .{ ghostty ++ .{.{ "SSH_CONNECTION", "192.0.2.1 54231 192.0.2.2 22" }}, .{}, .unicode },
        .{ ghostty ++ .{.{ "TERM", "xterm-kitty" }}, .{}, .unicode },
        .{ ghostty ++ .{.{ "TERM", "foot" }}, .{}, .unicode },
        .{ ghostty ++ .{.{ "TERM", "alacritty" }}, .{}, .wcwidth },
        .{ .{.{ "TERM", "rxvt-unicode-256color" }}, .{}, .wcwidth },
        .{ .{.{ "TERM_PROGRAM", "vscode" }}, .{}, .wcwidth },
        .{ .{.{ "TERM_PROGRAM", "Apple_Terminal" }}, .{}, .wcwidth },
        .{ .{ .{ "TERM", "xterm-256color" }, .{ "VTE_VERSION", "7800" } }, .{}, .wcwidth },
        .{ .{.{ "XTERM_VERSION", "XTerm(411)" }}, .{}, .wcwidth },
        .{ .{.{ "ALACRITTY_LOG", "/tmp/Alacritty-1.log" }}, .{}, .wcwidth },
        .{ .{.{ "ALACRITTY_SOCKET", "/run/user/1000/Alacritty-wayland-1-1.sock" }}, .{}, .wcwidth },
        .{ .{.{ "TERMUX_VERSION", "0.118" }}, .{}, .wcwidth },
        .{ .{.{ "VHS_RECORD", "1" }}, .{}, .wcwidth },
        .{ .{.{ "ZELLIJ", "0" }}, .{}, .wcwidth },
        .{ .{.{ "TERM", "screen" }}, .{}, .wcwidth },
        .{ .{.{ "TERM", "tmux-256color" }}, .{}, .wcwidth },
        .{ .{tmux} ++ ghostty, .{}, .wcwidth },
        .{ .{ tmux, .{ "TERM_PROGRAM", "iTerm.app" }, .{ "TERM_PROGRAM_VERSION", "3.7.6" } }, .{}, .wcwidth },
        .{ .{ tmux, .{ "TERM_PROGRAM", "tmux" }, .{ "TERM_PROGRAM_VERSION", "3.6a" } }, .{}, .unicode },
        .{ .{ tmux, .{ "TERM_PROGRAM", "tmux" }, .{ "TERM_PROGRAM_VERSION", "3.5a" } }, .{}, .wcwidth },
        .{ .{ tmux, .{ "TERM_PROGRAM", "tmux" }, .{ "TERM_PROGRAM_VERSION", "3.5a" } }, .{"\x1bP>|tmux 3.7c\x1b\\"}, .unicode },
        .{ .{ tmux, .{ "TERM_PROGRAM", "tmux" }, .{ "TERM_PROGRAM_VERSION", "3.7c" } }, .{"\x1bP>|tmux 3.5a\x1b\\"}, .wcwidth },
        .{ .{}, .{"\x1b[?2027;0$y\x1bP>|tmux 3.7c\x1b\\"}, .unicode },
        .{ .{}, .{"\x1b]0;tmux\x07\x1bP>|kitty(0.40.1)\x1b\\"}, .unicode },
        // Alacritty, urxvt and conhost answer 2027;0$y and no XTVERSION.
        .{ .{.{ "TERM", "alacritty" }}, .{"\x1b[?2027;0$y"}, .wcwidth },
        .{ .{}, .{"\x1b[?2027;0$y"}, .wcwidth },
        .{ .{.{ "TERM", "xterm-256color" }}, .{"\x1b[?2027;0$y\x1bP>|XTerm(411)\x1b\\"}, .wcwidth },
        .{ .{}, .{"\x1bP>|XTerm(411)\x1b\\"}, .wcwidth },
        .{ .{.{ "VTE_VERSION", "7800" }}, .{"\x1bP>|VTE(7800)\x1b\\"}, .wcwidth },
        .{ .{.{ "TERM_PROGRAM", "vscode" }}, .{"\x1bP>|xterm.js(5.5.0)\x1b\\"}, .wcwidth },
        .{ .{.{ "TERM_PROGRAM", "vscode" }}, .{"\x1b[?2027;2$y\x1bP>|xterm.js(7.0.0)\x1b\\"}, .unicode },
        .{ .{}, .{"\x1bP>|Zellij(4501)\x1b\\"}, .wcwidth },
        .{ .{.{ "TERM", "foot" }}, .{"\x1b[?2027;4$y\x1bP>|foot(1.28.0)\x1b\\"}, .wcwidth },
        .{ .{.{ "TERM", "foot" }}, .{"\x1b[?2027;1$y\x1bP>|foot(1.28.0)\x1b\\"}, .unicode },
        .{ ghostty ++ .{.{ "TERM", "xterm-kitty" }}, .{"\x1b[?2027;0$y"}, .unicode },
        .{ ghostty, .{"\x1b[?2027;0$y"}, .wcwidth },
        .{ ghostty, .{ "\x1b[?2027;0$y", "\x1bP>|kitty(0.48.2)\x1b\\" }, .unicode },
        .{ ghostty, .{"\x1b[?2027;2$y\x1bP>|WezTerm 20240203-110809-5046fc22\x1b\\"}, .unicode },
        .{ ghostty, .{"\x1b[?2027;2$y\x1bP>|ghostty 1.3.1\x1b\\"}, .unicode_wide },
        .{ ghostty ++ .{.{ "OPENTUI_FORCE_WCWIDTH", "1" }}, .{"\x1b[?2027;2$y\x1bP>|ghostty 1.3.1\x1b\\"}, .wcwidth },
        .{ .{.{ "SSH_CONNECTION", "192.0.2.1 54231 192.0.2.2 22" }}, .{"\x1b[?2027;1$y\x1bP>|ghostty 1.3.1\x1b\\"}, .unicode_wide },
        .{ .{}, .{"\x1b[?2027;1$y\x1bP>|ghostty 1.1.3\x1b\\"}, .unicode },
        .{ .{}, .{"\x1b[?2027;2$y\x1bP>|libghostty\x1b\\"}, .unicode_wide },
        .{ .{.{ "TERM_PROGRAM", "iTerm.app" }}, .{"\x1b[?2027;4$y\x1bP>|iTerm2 3.7.6\x1b\\"}, .unicode },
        .{ .{.{ "TERM_PROGRAM", "WezTerm" }}, .{"\x1b[?2027;3$y\x1bP>|WezTerm 20260716-195552-76b606ec\x1b\\"}, .unicode },
        .{ .{.{ "WT_SESSION", "fixture" }}, .{"\x1b[?2027;3$y"}, .unicode },
        .{ .{.{ "OPENTUI_FORCE_WCWIDTH", "1" }}, .{"\x1bP>|kitty(0.48.2)\x1b\\"}, .wcwidth },
        .{ .{.{ "OPENTUI_FORCE_UNICODE", "1" }}, .{"\x1b[?2027;0$y"}, .unicode },
        .{ .{ .{ "OPENTUI_FORCE_UNICODE", "1" }, .{ "OPENTUI_FORCE_WCWIDTH", "1" } }, .{}, .unicode },
        .{ .{ tmux, .{ "OPENTUI_FORCE_NOZWJ", "1" } }, .{"\x1bP>|tmux 3.7c\x1b\\"}, .no_zwj },
        .{ tmux38 ++ .{ ssh, .{ "OPENTUI_FORCE_WCWIDTH", "1" } }, .{ "\x1bP>|tmux 3.8\x1b\\", "\x1b[?2027;0$y" }, .wcwidth },
        .{ ghostty ++ .{ ssh, .{ "OPENTUI_FORCE_WCWIDTH", "1" } }, .{"\x1b[?2027;1$y\x1bP>|ghostty 1.3.1\x1b\\"}, .wcwidth },
        .{ .{ ssh, .{ "TERM", "alacritty" }, .{ "OPENTUI_FORCE_UNICODE", "1" } }, .{"\x1b[?2027;0$y"}, .unicode },
        .{ .{ ssh, .{ "OPENTUI_FORCE_NOZWJ", "1" } }, .{"\x1b[?2027;0$y"}, .no_zwj },
        // Inside tmux 3.8 (inherited TMUX and TERM_PROGRAM=tmux): tmux itself, screen (answers only DA1),
        // Zellij, Alacritty and urxvt (2027;0$y, no XTVERSION); and tmux inside screen or Zellij.
        .{ tmux38, .{ "\x1bP>|tmux 3.8\x1b\\", "\x1b[?2027;0$y" }, .unicode },
        .{ tmux38 ++ .{ .{ "STY", "1.pts-0.box" }, .{ "TERM", "screen" } }, .{"\x1b[?1;2c"}, .wcwidth },
        .{ tmux38 ++ .{.{ "ZELLIJ", "0" }}, .{}, .wcwidth },
        .{ tmux38 ++ .{.{ "ZELLIJ", "0" }}, .{"\x1bP>|Zellij(4501)\x1b\\"}, .wcwidth },
        .{ tmux38 ++ .{.{ "TERM", "alacritty" }}, .{"\x1b[?2027;0$y\x1b[?6c"}, .wcwidth },
        .{ tmux38 ++ .{.{ "TERM", "rxvt-unicode-256color" }}, .{"\x1b[?2027;0$y\x1b[?1;2c"}, .wcwidth },
        .{ tmux38 ++ .{.{ "STY", "1.pts-0.box" }}, .{"\x1bP>|tmux 3.8\x1b\\"}, .unicode },
        .{ tmux38 ++ .{.{ "ZELLIJ", "0" }}, .{"\x1bP>|tmux 3.8\x1b\\"}, .unicode },
        .{ .{ .{ "TERM", "xterm-256color" }, .{ "XTERM_VERSION", "XTerm(411)" }, .{ "KONSOLE_VERSION", "250400" } }, .{}, .unicode },
        // Explicit widths (the probe moved the cursor to column 2) need no mode 2027.
        .{ .{}, .{ "\x1b[?2027;2$y", "\x1b[1;1R\x1b[2;2R\x1b[2;3R" }, .unicode },
        .{ .{}, .{ "\x1b[?2027;1$y", "\x1b[1;1R\x1b[2;2R\x1b[2;3R" }, .unicode },
    };
    inline for (rows, 0..) |row, index| {
        var env = std.process.Environ.Map.init(testing.allocator);
        inline for (row[0]) |entry| try env.put(entry[0], entry[1]);
        var term = Terminal.init(.{ .remote_mode = .auto });
        term.adoptHostEnvironment(env);
        defer term.deinit();
        var writer = TestWriter.init(testing.allocator);
        defer writer.deinit();
        // Session enables features before the replies arrive, and again after each reply.
        try term.queryTerminalSend(&writer);
        try term.queryExplicitWidth(&writer);
        try term.enableDetectedFeatures(&writer, false);
        inline for (row[1]) |reply| {
            term.processCapabilityResponse(reply);
            try term.enableDetectedFeatures(&writer, false);
        }
        errdefer std.debug.print("width row {d}\n", .{index});
        try testing.expectEqual(@as(utf8.WidthMethod, row[2]), term.caps.unicode);
        const graphemes = (row[2] == .unicode or row[2] == .unicode_wide) and !term.caps.explicit_width;
        try testing.expectEqual(graphemes, mode2027Change(writer.getWritten()) orelse false);
        // Another reply that changes nothing writes no mode 2027 change.
        var start = writer.getWritten().len;
        try term.enableDetectedFeatures(&writer, false);
        try testing.expect(std.mem.find(u8, writer.getWritten()[start..], "\x1b[?2027") == null);
        // Teardown puts a mode the terminal can change back as its DECRPM reply found it before setup.
        const before = term.mode_2027 == 1;
        const restore: ?bool = if ((term.mode_2027 orelse 0) < 3 and graphemes != before) before else null;
        start = writer.getWritten().len;
        try term.resetOutputModes(&writer);
        try testing.expectEqual(restore, mode2027Change(writer.getWritten()[start..]));
        // Resume enables it again.
        start = writer.getWritten().len;
        try term.enableDetectedFeatures(&writer, false);
        try testing.expectEqual(if (graphemes) true else null, mode2027Change(writer.getWritten()[start..]));
    }
}

/// The last mode 2027 change in `output`: true for set, false for reset, null for none.
fn mode2027Change(output: []const u8) ?bool {
    const reset = std.mem.lastIndexOf(u8, output, ansi.ANSI.unicodeReset);
    const set = std.mem.lastIndexOf(u8, output, ansi.ANSI.unicodeSet) orelse return if (reset == null) null else false;
    return set > (reset orelse return true);
}

test "tmux XTVERSION selects the width method by version" {
    const versions = .{
        .{ "3.5a", .wcwidth }, .{ "3.6", .unicode }, .{ "3.6a", .unicode },          .{ "3.6-rc", .unicode },
        .{ "3.10", .unicode }, .{ "4.0", .unicode }, .{ "next-3.8", .unicode },      .{ "next-3.5", .wcwidth },
        .{ "2.9", .wcwidth },  .{ "", .wcwidth },    .{ "openbsd-7.8", .wcwidth },   .{ "3", .wcwidth },
        .{ "3.x", .wcwidth },  .{ "x.6", .wcwidth }, .{ "99999999999.1", .wcwidth },
    };
    inline for (versions) |case| {
        var term = Terminal.init(.{});
        term.processCapabilityResponse("\x1bP>|tmux " ++ case[0] ++ "\x1b\\");
        errdefer std.debug.print("tmux version '{s}'\n", .{case[0]});
        try testing.expect(term.caps.explicit_cursor_positioning);
        try testing.expectEqual(@as(utf8.WidthMethod, case[1]), term.caps.unicode);
    }
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

test "resetInputModes - force-disables mouse when cleanup is pending and state drifted false" {
    var term = Terminal.init(.{});
    term.state.mouse = false;
    term.state.mouse_movement = false;
    term.state.mouse_was_enabled = true;

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.resetInputModes(&writer);

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

test "resetInputModes - skips mouse disable when mouse was never enabled" {
    var term = Terminal.init(.{});

    var writer = TestWriter.init(testing.allocator);
    defer writer.deinit();

    try term.resetInputModes(&writer);

    const output = writer.getWritten();
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.disableAnyEventTracking) == null);
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.disableButtonEventTracking) == null);
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.disableMouseTracking) == null);
    try testing.expect(std.mem.find(u8, output, ansi.ANSI.disableSGRMouseMode) == null);
}
