const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const session = @import("../session.zig");
const ansi = @import("../ansi.zig");
const builtin = @import("builtin");

const transport: session.Options = .{
    .chunk_size = 4096,
    .chunk_count = 4,
    .span_capacity = 4,
    .control_capacity = 4096,
};
const environment = &@import("session-terminal_test.zig").environment;

const Fixture = @import("session-terminal_test.zig").Fixture;

test "Session controls gate inactive phases and reject malformed or over-limit inputs" {
    const f = try Fixture.initWithOptions(testing.allocator, testing.io, 4, 2, transport, .{ .object_capacity = 2 });
    defer f.deinit();
    const unattached = try f.owner.createSession(transport);
    try testing.expectError(error.RendererNotAttached, (try f.owner.getSession(unattached)).control(.query_theme_colors));
    const commands = [_]session.Control{
        .{ .capability_response = "\x1b[?0u" },
        .{ .title = "title" },
        .{ .mouse = .drag },
        .{ .kitty_keyboard_flags = 31 },
        .restore_modes,
        .query_pixel_resolution,
        .query_theme_colors,
        .reset_background,
    };
    for (commands) |command| try testing.expectError(error.TerminalInactive, f.value.control(command));
    var bytes: [8192]u8 = undefined;
    var now_ns: u64 = 0;
    try f.owner.setupSessionTerminal(f.id, .{});
    for (commands) |command| try testing.expectError(error.TerminalInactive, f.value.control(command));
    _ = try f.owner.pumpSession(f.id, now_ns, 1);
    const query = (try f.owner.readOutput(f.id, bytes[0..1])).?;
    const setting_up = f.cli.terminal;
    const queued = f.value.getStats();
    for (commands[1..]) |command| try testing.expectError(error.TerminalInactive, f.value.control(command));
    try testing.expectEqualDeep(setting_up, f.cli.terminal);
    try testing.expectEqualDeep(queued, f.value.getStats());
    try testing.expectEqualDeep(query, f.value.pending.?);
    try f.owner.completeOutput(f.id, query, .written);
    _ = try f.drain(&bytes);
    _ = try f.driveOutput(&now_ns, .active, &bytes, 32);

    const long_title = [_]u8{'x'} ** (session.title_bytes_max + 1);
    const long_response = [_]u8{'x'} ** (session.capability_response_bytes_max + 1);
    const invalid = [_]session.Control{
        .{ .title = "nul\x00" },
        .{ .title = "\x1b]0;injected\x07" },
        .{ .title = "newline\n" },
        .{ .title = "\x7f" },
        .{ .title = "\xc2\x9b" },
        .{ .title = "\xff" },
        .{ .title = &long_title },
        .{ .capability_response = &long_response },
        .{ .capability_response = "" },
        .{ .capability_response = "tmux" },
        .{ .capability_response = "\x1bP>|tmux 3.5a" },
        .{ .capability_response = "\x1bP>|kitty\x00\x1b\\" },
        .{ .capability_response = "\x1bP1+r4d73=zz\x1b\\" },
        .{ .capability_response = "\x1bP1+rtmux\x1b\\" },
        .{ .capability_response = "\x1b]1337;Capabilities=No" },
        .{ .capability_response = "\x1b_Gi=31337;OK\x07" },
        .{ .capability_response = "\x1b_Gtmux;OK\x1b\\" },
        .{ .capability_response = "\x1b_Gi=31337oops;OK\x1b\\" },
        .{ .capability_response = "\x1b[?0u\x1b[?2004;2" },
        .{ .capability_response = "\x1b[?0uX" },
        .{ .capability_response = "\x1b[?32u" },
        .{ .capability_response = "\x1b[?1004;5$y" },
        .{ .capability_response = "\x1b[?11016;2$y" },
        .{ .capability_response = "\x1b[0;1R" },
        .{ .capability_response = "\x1b[65536;1R" },
        .{ .kitty_keyboard_flags = 32 },
        .{ .kitty_keyboard_flags = 255 },
    };
    const before = f.snapshot();
    for (invalid) |command| {
        try testing.expectError(error.InvalidOptions, f.value.control(command));
        try testing.expectEqualDeep(before, f.snapshot());
    }
    try f.value.control(commands[0]);
    try testing.expect(f.cli.terminal.caps.kitty_keyboard);
}

test "Session controls preserve rejected drafts and leave restoration capacity untouched" {
    const f = try Fixture.initWithOptions(testing.allocator, testing.io, 4, 2, transport, .{ .object_capacity = 2 });
    defer f.deinit();
    var bytes: [3 * 4096]u8 = undefined;
    var now_ns: u64 = 0;
    try f.owner.setupSessionTerminal(f.id, .{ .mouse = false });
    _ = try f.driveOutput(&now_ns, .active, &bytes, 32);
    const reservation = f.value.output.control_sequence;
    try f.value.control(.{ .mouse = .drag });
    try testing.expect(f.cli.terminal.state.mouse and f.value.lifecycle.mouse);
    try testing.expect(!f.value.lifecycle.mouse_movement);
    try testing.expectEqualDeep(reservation, f.value.output.control_sequence);
    _ = try f.drain(&bytes);
    const blocker = [_]u8{'x'} ** (3 * 4096);
    try f.owner.writeSession(f.id, &blocker);
    const ticket = (try f.owner.readOutput(f.id, bytes[0..1])).?;
    const before = f.snapshot();
    for ([_]session.Control{
        .{ .capability_response = "\x1b[7;9R\x1b[1;2R\x1b[1;3R\x1bP>|tmux 3.5a\x1b\\" },
        .{ .mouse = .motion },
        .{ .kitty_keyboard_flags = 31 },
        .{ .title = "rejected" },
        .restore_modes,
        .query_pixel_resolution,
        .query_theme_colors,
        .reset_background,
    }) |command| {
        try testing.expectError(error.NoSpace, f.value.control(command));
        try testing.expectEqualDeep(before, f.snapshot());
        try testing.expectEqualDeep(reservation, f.value.output.control_sequence);
        try testing.expectEqual(.unicode, f.cli.getNextBuffer().width_method);
    }
    try f.owner.beginSessionClose(f.id);
    try testing.expectError(error.SessionClosed, f.value.control(.query_pixel_resolution));
    try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 1)).status);
    try f.owner.completeOutput(f.id, ticket, .written);
    try testing.expectEqualStrings(blocker[1..], try f.drain(&bytes));
    const restored = try f.driveOutput(&now_ns, .restored, &bytes, 32);
    try testing.expect(std.mem.find(u8, restored, ansi.ANSI.disableSGRMouseMode) != null);
    try testing.expectEqual(.closed, f.value.state);
    try testing.expect(f.value.canDestroy());
}

test "Session controls accept early capability replies in query order without enabling the wrong screen" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const f = try Fixture.initWithOptions(failing.allocator(), testing.io, 4, 2, transport, .{ .object_capacity = 2 });
    defer f.deinit();
    var bytes: [8192]u8 = undefined;
    var now_ns: u64 = 0;
    const allocated = failing.allocated_bytes;
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    try f.owner.setupSessionTerminal(f.id, .{});
    _ = try f.owner.pumpSession(f.id, now_ns, 1);
    const query = (try f.owner.readOutput(f.id, &bytes)).?;
    try testing.expect(f.cli.terminal.capability_queries_pending);
    try testing.expect(f.cli.terminal.graphics_query_pending);
    try testing.expect(f.cli.terminal.sixel_query_pending);
    const reservation = f.value.output.control_sequence;
    const lifecycle = f.value.lifecycle;
    const reply = "\x1b[7;9R\x1b[1;2R\x1b[1;3R\x1bP>|tmux 3.5a\x1b\\\x1b[?0u";
    try f.owner.controlSession(f.id, .{ .capability_response = reply });
    try testing.expectEqual(.setting_up, f.value.getTerminalState().phase);
    try testing.expectEqualDeep(lifecycle, f.value.lifecycle);
    try testing.expectEqualDeep(query, f.value.pending.?);
    try testing.expect(!f.cli.terminal.capability_queries_pending);
    try testing.expect(!f.cli.terminal.graphics_query_pending);
    try testing.expect(!f.cli.terminal.sixel_query_pending);
    try testing.expectEqual(.tmux, f.cli.terminal.multiplexer);
    try testing.expectEqual(.wcwidth, f.cli.getNextBuffer().width_method);
    try testing.expect(f.cli.terminal.caps.kitty_keyboard);
    try testing.expect(!f.cli.terminal.state.kitty_keyboard);
    try testing.expect(!f.cli.terminal.state.modify_other_keys);
    try testing.expect(f.cli.terminal.startup_cursor_query_captured);
    try testing.expect(!f.cli.terminal.startup_cursor_query_pending);
    try testing.expectEqual(@as(u16, 6), f.cli.terminal.state.cursor.row);
    try testing.expectEqual(@as(u16, 8), f.cli.terminal.state.cursor.col);
    try testing.expectEqual(@as(u8, 0), f.cli.terminal.explicit_width_probe_reports_pending);
    try testing.expect(f.cli.terminal.caps.explicit_width and f.cli.terminal.caps.scaled_text);
    try testing.expect(f.cli.terminal.opts.env_map == environment);
    try testing.expectEqualDeep(reservation, f.value.output.control_sequence);

    const before = f.snapshot();
    try testing.expectError(error.InvalidOptions, f.owner.controlSession(f.id, .{
        .capability_response = "\x1b[?1004;2$y\x1b[?2004;2",
    }));
    try testing.expectEqualDeep(before, f.snapshot());
    try testing.expectEqualDeep(reservation, f.value.output.control_sequence);
    try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 1)).status);
    try f.owner.completeOutput(f.id, query, .written);
    try testing.expectEqualStrings(ansi.ANSI.capabilityQueriesTmux ++
        ansi.ANSI.kittyGraphicsQueryTmux ++ ansi.ANSI.primaryDeviceAttrsTmux, try f.drain(&bytes));

    _ = try f.owner.pumpSession(f.id, now_ns, 1);
    try testing.expectEqualStrings(ansi.ANSI.saveCursorState ++ ansi.ANSI.switchToAlternateScreen, try f.drain(&bytes));
    _ = try f.owner.pumpSession(f.id, now_ns, 1);
    const enable = (try f.owner.readOutput(f.id, &bytes)).?;
    try testing.expectEqual(@as(usize, 1), std.mem.count(u8, bytes[0..enable.len], "\x1b[>5u"));
    try f.owner.controlSession(f.id, .{ .capability_response = "\x1b[?1004;2$y" });
    try testing.expect(f.cli.terminal.state.focus_tracking);
    try testing.expectEqual(.setting_up, f.value.getTerminalState().phase);
    try testing.expectEqualDeep(enable, f.value.pending.?);
    try f.owner.completeOutput(f.id, enable, .written);
    const enabled = try f.driveOutput(&now_ns, .active, &bytes, 32);
    try testing.expect(std.mem.find(u8, enabled, ansi.ANSI.focusSet) != null);
    try testing.expect(std.mem.find(u8, enabled, "\x1b[>5u") == null);
    try testing.expectEqual(@as(u16, 6), f.cli.terminal.state.cursor.row);
    try testing.expectEqual(@as(u16, 8), f.cli.terminal.state.cursor.col);
    try f.value.control(.{ .capability_response = reply });
    const repeated = try f.drain(&bytes);
    try testing.expect(std.mem.find(u8, repeated, ansi.ANSI.tmuxDcsStart) == null);
    try testing.expect(std.mem.find(u8, repeated, "\x1b[>5u") == null);
    try f.owner.beginSessionClose(f.id);
    const restored = try f.driveOutput(&now_ns, .restored, &bytes, 32);
    try testing.expect(std.mem.find(u8, restored, ansi.ANSI.csiUPop) != null);
    try testing.expect(std.mem.find(u8, restored, ansi.ANSI.focusReset) != null);
    try testing.expect(std.mem.find(u8, restored, ansi.ANSI.switchToMainScreen) != null);
    try testing.expectEqual(allocated, failing.allocated_bytes);
    try testing.expect(!failing.has_induced_failure);
}

test "Session controls persist mouse and Kitty intent through suspend resume and focus restore" {
    const f = try Fixture.initWithOptions(testing.allocator, testing.io, 4, 2, transport, .{ .object_capacity = 2 });
    defer f.deinit();
    var bytes: [8192]u8 = undefined;
    var now_ns: u64 = 0;
    try f.owner.setupSessionTerminal(f.id, .{});
    _ = try f.driveOutput(&now_ns, .active, &bytes, 32);
    try f.value.control(.{ .kitty_keyboard_flags = 31 });
    try testing.expect(!f.cli.terminal.state.kitty_keyboard);
    _ = try f.drain(&bytes);
    try f.value.control(.{ .capability_response = "\x1b[?0u\x1b[?1004;1$y" });
    try testing.expect(std.mem.find(u8, try f.drain(&bytes), "\x1b[>31u") != null);
    try f.value.control(.{ .mouse = .drag });
    _ = try f.drain(&bytes);
    try f.value.control(.{ .kitty_keyboard_flags = 7 });
    const changed = try f.drain(&bytes);
    try testing.expect(std.mem.startsWith(u8, changed, ansi.ANSI.csiUPop));
    try testing.expectEqual(@as(usize, 1), std.mem.count(u8, changed, "\x1b[>7u"));
    try testing.expectEqual(@as(u8, 7), f.cli.terminal.opts.kitty_keyboard_flags);
    try f.owner.suspendSession(f.id);
    try testing.expectError(error.TerminalInactive, f.value.control(.restore_modes));
    try testing.expectError(error.TerminalInactive, f.value.control(.{ .capability_response = "\x1b[?0u" }));
    _ = try f.driveOutput(&now_ns, .suspended, &bytes, 32);
    try testing.expect(!f.cli.terminal.state.mouse and !f.cli.terminal.state.kitty_keyboard);
    try testing.expectError(error.TerminalInactive, f.value.control(.{ .capability_response = "\x1b[?0u" }));
    const blocker = [_]u8{'x'} ** (3 * 4096);
    try f.owner.writeSession(f.id, &blocker);
    const pending = (try f.owner.readOutput(f.id, bytes[0..4096])).?;
    try f.owner.resumeSession(f.id);
    try testing.expectError(error.TerminalInactive, f.value.control(.query_theme_colors));
    const before = f.snapshot();
    const reservation = f.value.output.control_sequence;
    const reply: session.Control = .{ .capability_response = "\x1bP>|tmux 3.5a\x1b\\" };
    try testing.expectError(error.NoSpace, f.owner.controlSession(f.id, reply));
    try testing.expectEqualDeep(before, f.snapshot());
    try testing.expectEqualDeep(reservation, f.value.output.control_sequence);
    try f.owner.completeOutput(f.id, pending, .written);
    try testing.expectEqualStrings(blocker[pending.len..], try f.drain(&bytes));
    try f.owner.controlSession(f.id, reply);
    try testing.expectEqual(.resuming, f.value.getTerminalState().phase);
    try testing.expectEqual(.tmux, f.cli.terminal.multiplexer);
    try testing.expect(!f.cli.terminal.state.kitty_keyboard and !f.cli.terminal.state.focus_tracking);
    const resumed = try f.driveOutput(&now_ns, .active, &bytes, 32);
    try testing.expect(std.mem.find(u8, resumed, "\x1b[>7u") != null);
    try testing.expect(std.mem.find(u8, resumed, ansi.ANSI.disableAnyEventTracking) != null);
    try testing.expect(std.mem.find(u8, resumed, ansi.ANSI.enableAnyEventTracking) == null);
    try testing.expect(f.cli.terminal.state.mouse and !f.cli.terminal.state.mouse_movement);
    try f.value.control(.restore_modes);
    const restored = try f.drain(&bytes);
    try testing.expect(std.mem.find(u8, restored, ansi.ANSI.csiUPop ++ "\x1b[>7u") != null);
    try testing.expect(std.mem.find(u8, restored, ansi.ANSI.focusSet) != null);
    try testing.expect(std.mem.find(u8, restored, ansi.ANSI.bracketedPasteSet) != null);
    try f.value.control(.{ .kitty_keyboard_flags = 0 });
    _ = try f.drain(&bytes);
    try f.value.control(.{ .mouse = .disabled });
    _ = try f.drain(&bytes);
    try f.owner.suspendSession(f.id);
    _ = try f.driveOutput(&now_ns, .suspended, &bytes, 32);
    try f.owner.resumeSession(f.id);
    _ = try f.driveOutput(&now_ns, .active, &bytes, 32);
    try f.value.control(.{ .capability_response = "\x1b[?0u" });
    _ = try f.drain(&bytes);
    try testing.expect(!f.cli.terminal.state.kitty_keyboard and !f.cli.terminal.state.mouse);
    try testing.expect(f.cli.terminal.state.modify_other_keys);
    try testing.expectEqual(@as(u8, 0), f.cli.terminal.opts.kitty_keyboard_flags);
    try f.owner.beginSessionClose(f.id);
    _ = try f.driveOutput(&now_ns, .restored, &bytes, 32);
}

test "Session interrupted setup preserves rows outside its clearing policy" {
    if (builtin.os.tag != .windows) return error.SkipZigTest;
    const cases = [_]struct { alternate: bool, clear: bool, offset: u32 }{
        .{ .alternate = false, .clear = false, .offset = 0 },
        .{ .alternate = true, .clear = false, .offset = 0 },
        .{ .alternate = true, .clear = true, .offset = 0 },
        .{ .alternate = false, .clear = true, .offset = 8 },
    };
    for (cases) |case| {
        const f = try Fixture.initWithOptions(testing.allocator, testing.io, 4, 2, transport, .{ .object_capacity = 2 });
        defer f.deinit();
        var bytes: [8192]u8 = undefined;
        var now_ns: u64 = 0;
        f.cli.setRenderOffset(case.offset);
        try f.owner.setupSessionTerminal(f.id, .{
            .use_alternate_screen = case.alternate,
            .clear_on_close = case.clear,
        });
        _ = try f.owner.pumpSession(f.id, now_ns, 1);
        const query = (try f.owner.readOutput(f.id, &bytes)).?;
        try f.owner.controlSession(f.id, .{ .capability_response = "\x1b[9;1R" });
        try f.owner.beginSessionClose(f.id);
        try f.owner.completeOutput(f.id, query, .written);
        const restored = try f.driveOutput(&now_ns, .restored, &bytes, 32);
        try testing.expect(std.mem.find(u8, restored, ansi.ANSI.switchToAlternateScreen) == null);
        try testing.expect(std.mem.find(u8, restored, ansi.ANSI.reverseIndex) == null);
        if (case.offset == 0) {
            try testing.expect(std.mem.find(u8, restored, ansi.ANSI.eraseBelowCursor) == null);
        } else {
            try testing.expect(std.mem.find(u8, restored, "\x1b[r\x1b[9;1H\x1b[J\x1b[9;1H") != null);
        }
    }
}

test "Session controls preserve reply order across capability batches and pending frames" {
    const identity = "\x1bP>|tmux 3.5a\x1b\\";
    const unicode = "\x1b[?2027;2$y";
    for ([_]bool{ false, true }) |pending| {
        var columns: [2]u32 = undefined;
        for ([_]bool{ false, true }, 0..) |batched, index| {
            const f = try Fixture.initWithOptions(testing.allocator, testing.io, 4, 2, transport, .{ .object_capacity = 2 });
            defer f.deinit();
            var bytes: [8192]u8 = undefined;
            var now_ns: u64 = 0;
            try f.owner.setupSessionTerminal(f.id, .{});
            _ = try f.driveOutput(&now_ns, .active, &bytes, 32);
            if (pending) try testing.expectEqual(.pending, try f.owner.renderSession(f.id, true));
            const endpoint = f.value.frame_end_offset;
            if (batched) {
                try f.value.control(.{ .capability_response = identity ++ unicode });
            } else {
                try f.value.control(.{ .capability_response = identity });
                try f.value.control(.{ .capability_response = unicode });
            }
            try testing.expectEqual(endpoint, f.value.frame_end_offset);
            _ = try f.drain(&bytes);
            try testing.expectEqual(.tmux, f.cli.terminal.multiplexer);
            const target = f.cli.getNextBuffer();
            try target.drawText("1\u{fe0f}\u{20e3}X", 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
            columns[index] = @intCast(std.mem.findScalar(u32, target.buffer.char, 'X') orelse return error.TestUnexpectedResult);
        }
        try testing.expectEqual(columns[0], columns[1]);
    }
}

test "Session controls bound input and output without allocation after attachment" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const f = try Fixture.initWithOptions(failing.allocator(), testing.io, 4, 2, transport, .{ .object_capacity = 2 });
    defer f.deinit();
    var bytes: [8192]u8 = undefined;
    var now_ns: u64 = 0;
    try f.owner.setupSessionTerminal(f.id, .{});
    _ = try f.driveOutput(&now_ns, .active, &bytes, 32);
    const allocated = failing.allocated_bytes;
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    const title = [_]u8{'t'} ** session.title_bytes_max;
    try f.value.control(.{ .title = &title });
    const maximum = try f.drain(&bytes);
    try testing.expectEqual(session.control_packet_bytes_max, maximum.len);
    try testing.expectEqualStrings(&title, maximum[4 .. maximum.len - 1]);
    try f.value.control(.{ .title = "\xc3\xb8" });
    try testing.expectEqualStrings("\x1b]0;\xc3\xb8\x07", try f.drain(&bytes));
    try f.value.control(.{ .title = "" });
    try testing.expectEqualStrings("\x1b]0;\x07", try f.drain(&bytes));
    var response = [_]u8{'v'} ** session.capability_response_bytes_max;
    @memcpy(response[0.."\x1bP>|kitty ".len], "\x1bP>|kitty ");
    @memcpy(response[response.len - 2 ..], "\x1b\\");
    for ([_]session.Control{
        .{ .capability_response = &response },
        .{ .capability_response = "\x1bP1+r4d73=7878\x1b\\\x1b_Gi=31337;OK\x1b\\\x1b[?62;4c" },
        .{ .capability_response = "\x1b]99;i=opentui-notifications:p=?;p=title\x07\x1b]1337;Capabilities=No\x1b\\" },
        .{ .mouse = .motion },
        .{ .kitty_keyboard_flags = 31 },
        .restore_modes,
    }) |command| {
        try f.value.control(command);
        try testing.expect((try f.drain(&bytes)).len <= session.control_packet_bytes_max);
    }
    try testing.expect(f.cli.terminal.caps.osc52 and f.cli.terminal.caps.kitty_graphics);
    try testing.expect(f.cli.terminal.caps.sixel and f.cli.terminal.caps.notifications);
    try f.value.control(.query_pixel_resolution);
    try testing.expectEqualStrings(ansi.ANSI.queryPixelSize, try f.drain(&bytes));
    try f.value.control(.query_theme_colors);
    try testing.expectEqualStrings(ansi.ANSI.oscThemeQueries, try f.drain(&bytes));
    try f.owner.beginSessionClose(f.id);
    _ = try f.driveOutput(&now_ns, .restored, &bytes, 32);
    try testing.expectEqual(allocated, failing.allocated_bytes);
    try testing.expect(!failing.has_induced_failure);
}

test "Session clipboard rejects pressure and allocation failures without consuming restoration capacity" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const f = try Fixture.initWithOptions(failing.allocator(), testing.io, 4, 2, transport, .{ .object_capacity = 2 });
    defer f.deinit();
    var bytes: [16 * 1024]u8 = undefined;
    var now_ns: u64 = 0;
    try f.owner.setupSessionTerminal(f.id, .{});
    _ = try f.driveOutput(&now_ns, .active, &bytes, 32);
    const reservation = f.value.output.control_sequence;
    const before = f.cli.terminal;
    const blocker = [_]u8{'x'} ** (3 * 4096);
    try f.owner.writeSession(f.id, &blocker);
    const ticket = (try f.owner.readOutput(f.id, bytes[0..1])).?;
    const stats = f.value.getStats();
    const allocated = failing.allocated_bytes;
    failing.fail_index = failing.alloc_index;
    for ([_][]const u8{ "", "text", &blocker }) |payload| {
        try testing.expect(!try f.value.writeClipboard(.clipboard, payload));
        try testing.expectEqualDeep(stats, f.value.getStats());
        try testing.expectEqualDeep(ticket, f.value.pending.?);
        try testing.expectEqualDeep(before, f.cli.terminal);
        try testing.expectEqualDeep(reservation, f.value.output.control_sequence);
        try testing.expectEqual(@as(usize, 0), f.value.output.staged_bytes);
    }
    try testing.expect(!failing.has_induced_failure);
    try testing.expectError(error.NoSpace, f.value.control(.reset_background));
    try f.owner.completeOutput(f.id, ticket, .written);
    try testing.expectEqualStrings(blocker[1..], try f.drain(&bytes));
    try testing.expect(!try f.value.writeClipboard(.clipboard, &blocker));
    try testing.expect(!failing.has_induced_failure);
    try testing.expect(!try f.value.writeClipboard(.clipboard, "allocation fails"));
    try testing.expect(failing.has_induced_failure);
    try testing.expectEqual(@as(usize, 0), f.value.output.staged_bytes);
    try testing.expect(f.value.isDrained());
    try testing.expectEqual(allocated, failing.allocated_bytes);
    failing.fail_index = std.math.maxInt(usize);
    try testing.expect(try f.value.writeClipboard(.clipboard, "accepted"));
    const accepted = (try f.owner.readOutput(f.id, bytes[0..1])).?;
    try f.owner.beginSessionClose(f.id);
    try testing.expectError(error.SessionClosed, f.value.writeClipboard(.clipboard, "late"));
    try testing.expectError(error.SessionClosed, f.value.control(.reset_background));
    try f.owner.completeOutput(f.id, accepted, .written);
    try testing.expectEqualStrings("]52;c;YWNjZXB0ZWQ=\x1b\\", try f.drain(&bytes));
    _ = try f.driveOutput(&now_ns, .restored, &bytes, 32);
    try testing.expect(f.value.canDestroy());
}

test "Session clipboard rejects inactive phases and unsupported capability without output" {
    const f = try Fixture.initWithOptions(testing.allocator, testing.io, 4, 2, transport, .{ .object_capacity = 2 });
    defer f.deinit();
    var bytes: [8192]u8 = undefined;
    var now_ns: u64 = 0;
    try testing.expectError(error.TerminalInactive, f.value.writeClipboard(.clipboard, "before setup"));
    try testing.expectError(error.TerminalInactive, f.value.control(.reset_background));
    try f.owner.setupSessionTerminal(f.id, .{});
    try testing.expectError(error.TerminalInactive, f.value.writeClipboard(.clipboard, "during setup"));
    _ = try f.driveOutput(&now_ns, .active, &bytes, 32);
    f.cli.terminal.osc52_support = .unsupported;
    const stats = f.value.getStats();
    try testing.expect(!try f.value.writeClipboard(.clipboard, "unsupported"));
    try testing.expect(!try f.value.writeClipboard(.primary, ""));
    try testing.expectEqualDeep(stats, f.value.getStats());
    f.cli.terminal.osc52_support = .unknown;
    try testing.expect(try f.value.writeClipboard(.clipboard, "optimistic"));
    _ = try f.drain(&bytes);
    try f.owner.suspendSession(f.id);
    try testing.expectError(error.TerminalInactive, f.value.writeClipboard(.clipboard, "suspending"));
    _ = try f.driveOutput(&now_ns, .suspended, &bytes, 32);
    try testing.expectError(error.TerminalInactive, f.value.writeClipboard(.clipboard, "suspended"));
    try testing.expectError(error.TerminalInactive, f.value.control(.reset_background));
    try f.owner.resumeSession(f.id);
    try testing.expectError(error.TerminalInactive, f.value.writeClipboard(.clipboard, "resuming"));
    _ = try f.driveOutput(&now_ns, .active, &bytes, 32);
    try testing.expect(try f.value.writeClipboard(.clipboard, "pending"));
    const ticket = (try f.owner.readOutput(f.id, bytes[0..1])).?;
    try f.owner.completeOutput(f.id, ticket, .failed);
    try testing.expectError(error.SessionFailed, f.value.writeClipboard(.clipboard, "failed"));
    f.value.cancel();
    try testing.expectError(error.SessionCancelled, f.value.writeClipboard(.clipboard, "cancelled"));
    try testing.expect(f.value.canDestroy());
    try testing.expectEqual(@as(usize, 0), f.value.output.staged_bytes);
}

test "Session Kitty image transport is readable before setup and probes only while active" {
    const f = try Fixture.initWithOptions(testing.allocator, testing.io, 4, 2, transport, .{ .object_capacity = 2 });
    defer f.deinit();
    try testing.expectError(error.InvalidOptions, f.value.setKittyImageTransport(3));
    try f.value.setKittyImageTransport(2);
    try testing.expectEqual(.file, f.cli.kittyTransport.mode);
    try testing.expectEqual(.disabled, f.cli.kittyTransport.file_state);
    try f.value.startKittyFileProbe();
    try testing.expectEqual(.disabled, f.cli.kittyTransport.file_state);

    var now_ns: u64 = 0;
    var bytes: [8192]u8 = undefined;
    try f.owner.setupSessionTerminal(f.id, .{});
    _ = try f.driveOutput(&now_ns, .active, &bytes, 32);
    try f.value.startKittyFileProbe();
    if (builtin.os.tag == .windows) {
        try testing.expectEqual(.unsupported, f.cli.kittyTransport.file_state);
    } else {
        try testing.expectEqual(.probing, f.cli.kittyTransport.file_state);
    }
    try f.value.cancelKittyImageTransport(false);
    try testing.expectEqual(.cancelled, f.cli.kittyTransport.file_state);
    try testing.expectEqual(@as(u32, 0), f.value.processKittyImageReply("not-a-reply"));
}

test "Session Kitty file transport selected while suspended probes on resume" {
    const f = try Fixture.initWithOptions(testing.allocator, testing.io, 4, 2, transport, .{ .object_capacity = 2 });
    defer f.deinit();
    var now_ns: u64 = 0;
    var bytes: [8192]u8 = undefined;
    try f.owner.setupSessionTerminal(f.id, .{});
    _ = try f.driveOutput(&now_ns, .active, &bytes, 32);
    try f.owner.suspendSession(f.id);
    _ = try f.driveOutput(&now_ns, .suspended, &bytes, 32);
    try f.value.setKittyImageTransport(2);
    try testing.expectEqual(.disabled, f.cli.kittyTransport.file_state);
    try f.owner.resumeSession(f.id);
    _ = try f.driveOutput(&now_ns, .active, &bytes, 32);
    try f.value.startKittyFileProbe();
    if (builtin.os.tag == .windows) {
        try testing.expectEqual(.unsupported, f.cli.kittyTransport.file_state);
    } else {
        try testing.expectEqual(.probing, f.cli.kittyTransport.file_state);
    }
}
