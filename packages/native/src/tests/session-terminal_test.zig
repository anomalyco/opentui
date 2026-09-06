const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const session = @import("../session.zig");
const renderer = @import("../renderer.zig");
const ansi = @import("../ansi.zig");
const image = @import("../image.zig");
const grapheme = @import("../grapheme.zig");
const scene = @import("../scene.zig");
const yoga = @import("../yoga.zig");

const transport: session.Options = .{
    .chunk_size = 4096,
    .chunk_count = 3,
    .span_capacity = 3,
    .control_capacity = 4096,
};
pub const environment = std.process.Environ.Map.init(testing.allocator);
const scene_options: scene.FrameOptions = .{
    .background = .{ 0, 0, 0, 255 },
    .use_mouse = true,
    .excluded_hit_num = 0,
    .max_layout_rounds = 8,
    .max_host_requests = 64,
};

pub const Fixture = struct {
    owner: *context.Context,
    id: context.Handle,
    value: *session.Session,
    cli: *renderer.CliRenderer,

    const Snapshot = struct {
        terminal: @FieldType(renderer.CliRenderer, "terminal"),
        lifecycle: @FieldType(session.Session, "lifecycle"),
        stats: @import("../native-span-feed.zig").Stats,
        pending: ?session.OutputTicket,
        frame_end: ?u64,
    };

    pub fn snapshot(self: Fixture) Snapshot {
        return .{
            .terminal = self.cli.terminal,
            .lifecycle = self.value.lifecycle,
            .stats = self.value.getStats(),
            .pending = self.value.pending,
            .frame_end = self.value.frame_end_offset,
        };
    }

    pub fn init(allocator: std.mem.Allocator, io: std.Io, width: u32, height: u32) !Fixture {
        return initWithOptions(allocator, io, width, height, transport, .{});
    }

    pub fn initWithOptions(allocator: std.mem.Allocator, io: std.Io, width: u32, height: u32, output: session.Options, limits: context.Options) !Fixture {
        const owner = try context.Context.init(allocator, io, limits);
        errdefer owner.deinit() catch unreachable;
        const id = try owner.createSession(output);
        try owner.attachSessionRenderer(id, width, height, .{ .env_map = &environment });
        return .{
            .owner = owner,
            .id = id,
            .value = try owner.getSession(id),
            .cli = try owner.getSessionRenderer(id),
        };
    }

    pub fn deinit(self: Fixture) void {
        self.owner.cancelSession(self.id) catch unreachable;
        self.owner.deinit() catch unreachable;
    }

    pub fn drain(self: Fixture, bytes: []u8) ![]const u8 {
        var len: usize = 0;
        while (try self.owner.readOutput(self.id, bytes[len..])) |ticket| {
            len += ticket.len;
            try self.owner.completeOutput(self.id, ticket, .written);
        }
        try testing.expect(self.value.isDrained());
        return bytes[0..len];
    }

    pub fn drive(self: Fixture, now_ns: *u64, phase: session.TerminalPhase) !void {
        var bytes: [16 * 1024]u8 = undefined;
        _ = try self.driveOutput(now_ns, phase, &bytes, 256);
    }

    pub fn driveOutput(self: Fixture, now_ns: *u64, phase: session.TerminalPhase, bytes: []u8, limit: u32) ![]const u8 {
        var len: usize = 0;
        for (0..limit) |_| {
            const before = self.value.getStats().bytes_written;
            const result = try self.owner.pumpSession(self.id, now_ns.*, 1);
            try testing.expect(self.value.getStats().bytes_written - before <= session.control_packet_bytes_max);
            switch (result.status) {
                .output_pending => len += (try self.drain(bytes[len..])).len,
                .wait_until => now_ns.* = result.deadline_ns.?,
                .again => {},
                .idle, .closed => {
                    try testing.expectEqual(phase, self.value.getTerminalState().phase);
                    return bytes[0..len];
                },
            }
        }
        return error.TestUnexpectedResult;
    }

    fn paint(self: Fixture, text: []const u8, hit: u32) !void {
        try self.cli.getNextBuffer().drawText(text, 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
        self.cli.addToHitGrid(0, 0, self.cli.width, self.cli.height, hit);
    }
};

test "Scene feedback gates setup and suspension without stranding terminal restoration" {
    const f = try Fixture.init(testing.allocator, testing.io, 4, 2);
    defer f.deinit();
    const root = try f.owner.sceneCreateNode(f.id, 0, 1);
    try f.owner.sceneSetHooks(root, 1, 1, 0, 0);
    const options: @import("../scene.zig").FrameOptions = .{
        .background = .{ 0, 0, 0, 255 },
        .use_mouse = false,
        .excluded_hit_num = 0,
        .max_layout_rounds = 8,
        .max_host_requests = 16,
    };
    var request = try f.owner.sceneFrameStep(f.id, null, options);
    try testing.expectError(error.FrameBusy, f.owner.setupSessionTerminal(f.id, .{}));
    try testing.expectEqual(.uninitialized, f.value.getTerminalState().phase);
    try f.owner.sceneFrameCancel(f.id, request.frame_id);
    try f.owner.setupSessionTerminal(f.id, .{});
    var now_ns: u64 = 0;
    try f.drive(&now_ns, .active);
    request = try f.owner.sceneFrameStep(f.id, null, options);
    try testing.expectError(error.FrameBusy, f.owner.suspendSession(f.id));
    try testing.expectEqual(.active, f.value.getTerminalState().phase);
    try testing.expectEqual(request, f.value.scene.?.attempt.?.pending.?);
    try f.owner.beginSessionClose(f.id);
    try testing.expect(f.value.scene.?.attempt == null);
    try f.drive(&now_ns, .restored);
    try testing.expect(f.value.canDestroy());
    try testing.expectEqual(@as(u64, 0), f.cli.renderStats.frameCount);
}

test "Session suspension cancels every work-only preparation and feedback yield" {
    var saw_feedback = false;
    for (0..128) |pause_at| {
        const f = try Fixture.init(testing.allocator, testing.io, 8, 2);
        defer f.deinit();
        try f.owner.setupSessionTerminal(f.id, .{});
        var now_ns: u64 = 0;
        try f.drive(&now_ns, .active);
        const root = try f.owner.sceneCreateNode(f.id, 0, 1);
        try f.owner.sceneSetHooks(root, 1, 1, 8, 2);
        for (0..3) |index| {
            const child = try f.owner.sceneCreateNode(f.id, 1, @intCast(index + 2));
            try f.owner.sceneSetStyle(child, 4, 0, 0, 1, 1, 1);
            try f.owner.sceneSetStyle(child, 4, 1, 0, 1, 1, 1);
            try f.owner.sceneSetHooks(child, 1, 1, 1, 1);
            try f.owner.sceneMoveNode(child, root, @intCast(index));
        }
        const state = f.value.scene.?;
        var previous: ?scene.FrameRequest = null;
        var yields: usize = 0;
        var updates: u32 = 0;
        const paused: ?scene.FrameRequest = for (0..256) |_| {
            const request = try f.owner.sceneFrameStepWorkBudgeted(f.id, previous, scene_options, std.math.maxInt(u32), 1);
            if (request.kind == 0) break null;
            if (request.kind == 1) updates += 1;
            if (request.kind == 6) {
                try testing.expect(state.prefix == null);
                if (yields == pause_at) break request;
                yields += 1;
            }
            previous = request;
        } else return error.TestUnexpectedResult;
        const request = paused orelse {
            try testing.expect(pause_at > 0 and saw_feedback);
            break;
        };
        saw_feedback = saw_feedback or updates != 0;
        try f.owner.suspendSession(f.id);
        try testing.expectEqual(.suspending, f.value.getTerminalState().phase);
        try testing.expect(state.attempt == null and state.prefix == null and state.painted == null);
        try testing.expectError(error.StaleFrame, f.owner.sceneFrameCancel(f.id, request.frame_id));
        try testing.expectEqual(@as(u64, 0), f.cli.renderStats.frameCount);
        try f.drive(&now_ns, .suspended);
        try f.owner.resumeSession(f.id);
        try f.drive(&now_ns, .active);
        try testing.expectError(error.StaleFrame, f.owner.sceneFrameStepWorkBudgeted(f.id, request, scene_options, std.math.maxInt(u32), 1));
    } else return error.TestUnexpectedResult;
}

test "Session suspension rejection preserves yielded and synchronous preparation" {
    const SuspendProbe = struct {
        var target: *session.Session = undefined;
        var rejection: ?anyerror = null;
        var calls: u32 = 0;

        fn measure(_: u64, _: u32, _: u32, _: f32, _: u32, _: f32, _: u32, result: *yoga.ExternalYogaSize) callconv(.c) void {
            calls += 1;
            target.suspendTerminal() catch |err| {
                rejection = err;
            };
            result.* = .{ .width = 1, .height = 1 };
        }
    };
    const f = try Fixture.init(testing.allocator, testing.io, 8, 2);
    defer f.deinit();
    const root = try f.owner.sceneCreateNode(f.id, 0, 1);
    try f.owner.sceneSetHooks(root, 1, 1, 8, 2);
    const request = try f.owner.sceneFrameStepWorkBudgeted(f.id, null, scene_options, std.math.maxInt(u32), 1);
    try testing.expectEqual(@as(u32, 6), request.kind);
    try testing.expectError(error.InvalidTerminalState, f.owner.suspendSession(f.id));
    try testing.expectEqual(.uninitialized, f.value.getTerminalState().phase);
    try testing.expectEqualDeep(request, f.value.scene.?.attempt.?.pending.?);
    try f.owner.sceneFrameCancel(f.id, request.frame_id);
    try f.owner.setupSessionTerminal(f.id, .{});
    var now_ns: u64 = 0;
    try f.drive(&now_ns, .active);
    const child = try f.owner.sceneCreateNode(f.id, 6, 2);
    try f.owner.sceneMoveNode(child, root, 0);
    SuspendProbe.target = f.value;
    SuspendProbe.rejection = null;
    SuspendProbe.calls = 0;
    try f.owner.sceneSetMeasure(child, &SuspendProbe.measure);
    const synchronous = try f.owner.sceneFrameStep(f.id, null, scene_options);
    try testing.expect(SuspendProbe.calls > 0);
    try testing.expectEqual(error.FrameBusy, SuspendProbe.rejection.?);
    try testing.expectEqual(@as(u32, 1), synchronous.kind);
    try testing.expectError(error.FrameBusy, f.owner.suspendSession(f.id));
    try testing.expectEqual(.active, f.value.getTerminalState().phase);
    try testing.expectEqualDeep(synchronous, f.value.scene.?.attempt.?.pending.?);
}

test "Session screen changes transfer Kitty keyboard state and preserve rejected drafts" {
    const f = try Fixture.init(testing.allocator, testing.io, 4, 2);
    defer f.deinit();
    f.cli.terminal.caps.kitty_keyboard = true;
    try f.owner.setupSessionTerminal(f.id, .{ .use_alternate_screen = false });
    var now_ns: u64 = 0;
    try f.drive(&now_ns, .active);
    var bytes: [16 * 1024]u8 = undefined;
    const before_oversize = f.cli.terminal.state;
    try testing.expectError(error.InvalidOptions, f.value.setScreen(true, 5, 3, &([_]u8{'x'} ** 4096)));
    try testing.expectEqualDeep(before_oversize, f.cli.terminal.state);
    try testing.expectEqual(@as(u32, 4), f.cli.width);
    try testing.expectEqual(@as(u32, 2), f.cli.height);
    for ([_]bool{ true, false, true }) |alternate| {
        try f.value.setScreen(alternate, 4, 2, "\x1b[7T");
        const packet = try f.drain(&bytes);
        const expected = if (alternate) "\x1b[<u\x1b[?1049h\x1b[>5u\x1b[7T" else "\x1b[<u\x1b[?1049l\x1b[>5u\x1b[7T";
        try testing.expectEqualStrings(expected, packet);
        try testing.expect(f.cli.terminal.state.kitty_keyboard);
    }
    try f.value.write(&([_]u8{'x'} ** 8192));
    const before = f.cli.terminal.state;
    try testing.expectError(error.NoSpace, f.value.setScreen(false, 5, 3, "\x1b[7T"));
    try testing.expectEqualDeep(before, f.cli.terminal.state);
    try testing.expectEqual(@as(u32, 4), f.cli.width);
    try testing.expectEqual(@as(u32, 2), f.cli.height);
    try testing.expect(f.cli.useAlternateScreen);
    try testing.expectEqualStrings("x" ** 8192, try f.drain(&bytes));
    try f.value.setScreen(false, 5, 3, "\x1b[7T");
    try testing.expectEqualStrings("\x1b[<u\x1b[?1049l\x1b[>5u\x1b[7T", try f.drain(&bytes));
    try testing.expectEqual(@as(u32, 5), f.cli.width);
    try testing.expectEqual(@as(u32, 3), f.cli.height);
    const prefix = "\x1b[<u\x1b[?1049h\x1b[>5u";
    const suffix = "x" ** (session.control_packet_bytes_max - prefix.len);
    try testing.expectError(error.InvalidOptions, f.value.setScreen(true, 5, 3, suffix ++ "x"));
    try testing.expectEqualStrings("", try f.drain(&bytes));
    try f.value.setScreen(true, 5, 3, suffix);
    try testing.expectEqualStrings(prefix ++ suffix, try f.drain(&bytes));
    f.cli.terminal.setCursorPosition(5, 3, true);
    try f.value.setScreen(true, 2, 1, "");
    const cursor = f.cli.terminal.getCursorPosition();
    try testing.expectEqual(@as(u32, 2), cursor.x);
    try testing.expectEqual(@as(u32, 1), cursor.y);
    try f.owner.beginSessionClose(f.id);
    try f.drive(&now_ns, .restored);
    try testing.expect(!f.cli.terminal.state.kitty_keyboard);
    try testing.expect(!f.cli.terminal.state.alt_screen);
}

test "Session early width replies preserve forced text widths during setup and resume" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(transport);
    defer owner.cancelSession(id) catch unreachable;
    try owner.attachSessionRenderer(id, 8, 2, .{ .forwarded_env = &.{
        .{ .key = "OPENTUI_FORCE_WCWIDTH", .value = "1" },
    } });
    const f: Fixture = .{ .owner = owner, .id = id, .value = try owner.getSession(id), .cli = try owner.getSessionRenderer(id) };
    const root = try owner.sceneCreateNode(id, 0, 1);
    var now_ns: u64 = 0;
    var bytes: [16 * 1024]u8 = undefined;
    try owner.setupSessionTerminal(id, .{});
    for (0..2) |pass| {
        _ = try owner.pumpSession(id, now_ns, 1);
        const queued = f.value.getStats().bytes_written;
        try f.value.control(.{ .capability_response = "\x1b[?2027;2$y\x1b[?7u" });
        try testing.expectEqual(queued, f.value.getStats().bytes_written);
        try testing.expect(!f.cli.terminal.state.kitty_keyboard);
        const text = try owner.sceneCreateNode(id, 2, @intCast(pass + 2));
        try owner.sceneSetStyle(text, 4, 0, 0, 1, 8, 1);
        try owner.sceneSetStyle(text, 4, 1, 0, 1, 1, 1);
        try owner.sceneSetText(text, "\u{1f469}\u{200d}\u{1f680}X");
        try owner.sceneMoveNode(text, root, @intCast(pass));
        try testing.expectEqual(@as(u32, 5), (try owner.sceneGetTextInfo(text)).width_cols_max);
        try testing.expectEqual(.wcwidth, f.cli.terminal.caps.unicode);
        try testing.expectEqual(.wcwidth, f.cli.getNextBuffer().width_method);
        _ = try f.drain(&bytes);
        try f.drive(&now_ns, .active);
        try testing.expectEqual(.wcwidth, f.cli.terminal.caps.unicode);
        try testing.expectEqual(@as(u32, 5), (try owner.sceneGetTextInfo(text)).width_cols_max);
        try owner.scenePaint(id, .{ 0, 0, 0, 255 }, false, 0);
        try testing.expectEqual(@as(u32, 'X'), f.cli.getNextBuffer().buffer.char[pass * 8 + 4]);
        try testing.expectEqual(.pending, try owner.renderSession(id, true));
        _ = try f.drain(&bytes);
        if (pass == 0) {
            try owner.suspendSession(id);
            try f.drive(&now_ns, .suspended);
            try owner.resumeSession(id);
        }
    }
}

test "Session suspended resize requires drained output and preserves rendering gates" {
    const f = try Fixture.init(testing.allocator, testing.io, 4, 2);
    defer f.deinit();
    _ = try f.owner.sceneCreateNode(f.id, 0, 1);
    var now_ns: u64 = 0;
    var bytes: [4096]u8 = undefined;
    try f.owner.setupSessionTerminal(f.id, .{});
    try f.drive(&now_ns, .active);
    try f.owner.suspendSession(f.id);
    try testing.expectError(error.TerminalInactive, f.owner.resizeSessionRenderer(f.id, 2, 4));
    try f.drive(&now_ns, .suspended);

    try f.owner.writeSession(f.id, "shell");
    try testing.expectError(error.Busy, f.owner.resizeSessionRenderer(f.id, 2, 4));
    const ticket = (try f.owner.readOutput(f.id, bytes[0..2])).?;
    try testing.expectError(error.Busy, f.owner.resizeSessionRenderer(f.id, 2, 4));
    try f.owner.completeOutput(f.id, ticket, .written);
    _ = try f.drain(&bytes);
    const written = f.value.getStats().bytes_written;

    try f.owner.resizeSessionRenderer(f.id, 2, 4);
    try testing.expectEqual(@as(u32, 2), f.cli.width);
    try testing.expectEqual(@as(u32, 4), f.cli.height);
    try testing.expectEqual(@as(u32, 2), f.cli.getCurrentBuffer().width);
    try testing.expectEqual(@as(u32, 4), f.cli.getNextBuffer().height);
    try testing.expectEqual(written, f.value.getStats().bytes_written);
    try testing.expectEqual(.suspended, f.value.getTerminalState().phase);
    try testing.expectError(error.TerminalInactive, f.owner.renderSession(f.id, true));
    try testing.expectError(error.TerminalInactive, f.owner.scenePaint(f.id, .{ 0, 0, 0, 255 }, false, 0));
    try f.owner.resumeSession(f.id);
    try testing.expectError(error.TerminalInactive, f.owner.resizeSessionRenderer(f.id, 4, 2));
    try f.drive(&now_ns, .active);
    try f.owner.scenePaint(f.id, .{ 0, 0, 0, 255 }, false, 0);
}

test "Session suspended snapshots preserve restoration through deferred presentation and close" {
    for ([_]renderer.SplitFooterTransitionMode{ .none, .viewport_scroll, .clear_stale_rows }) |mode| {
        const f = try Fixture.init(testing.allocator, testing.io, 8, 2);
        defer f.deinit();
        var bytes: [16 * 1024]u8 = undefined;
        var now_ns: u64 = 0;
        f.cli.terminal.caps.kitty_keyboard = true;
        try f.owner.setupSessionTerminal(f.id, .{ .use_alternate_screen = false });
        try f.drive(&now_ns, .active);
        _ = try f.value.splitControl(.{ .reset = .{ .seed_rows = 5, .pinned_render_offset = 5 } });
        try f.paint("footer", 42);
        _ = try f.value.render(true);
        _ = try f.drain(&bytes);
        try f.owner.suspendSession(f.id);
        try f.drive(&now_ns, .suspended);
        const transition: renderer.SplitFooterTransition = .{
            .mode = mode,
            .source_top_line = 8,
            .source_height = 2,
            .target_top_line = 6,
            .target_height = 2,
            .scroll_lines = 2,
        };
        if (mode != .none) _ = try f.value.splitControl(.{ .transition = transition });
        const restored = f.cli.terminal.state;
        const frames = f.cli.renderStats.frameCount;
        const split_state = f.cli.splitScrollback;
        const snapshot = try f.owner.getBuffer(try f.owner.createBuffer(8, 1, .{}));
        try snapshot.drawTextChecked("late", 0, 0, ansi.rgbColor(255, 255, 255, 255), null, 0);
        const commits = [_]renderer.SplitSnapshot{.{ .snapshot = snapshot, .row_columns = 4, .trailing_newline = false }};
        try f.value.write("raw-");
        try testing.expectError(error.TerminalInactive, f.value.render(true));
        try testing.expectError(error.TerminalInactive, f.value.control(.{ .title = "inactive" }));
        try testing.expectError(error.TerminalInactive, f.value.renderSplit(std.mem.zeroes(@import("../scene.zig").FrameRequest), &commits, 5, false));
        try testing.expectEqual(.pending, try f.value.renderSplit(null, &commits, 5, false));
        try testing.expectEqualDeep(split_state, f.cli.splitScrollback);
        try testing.expectEqual(frames, f.cli.renderStats.frameCount);
        try testing.expectEqual(.suspended, f.value.getTerminalState().phase);
        try testing.expectEqualDeep(restored, f.cli.terminal.state);
        try f.owner.beginSessionClose(f.id);
        try testing.expectEqual(.closing, f.value.state);
        var len: usize = 0;
        while (try f.owner.readOutput(f.id, bytes[len..][0..1])) |ticket| {
            len += ticket.len;
            try f.owner.completeOutput(f.id, ticket, .written);
            if (f.value.frame_end_offset != null) {
                try testing.expectEqual(frames, f.cli.renderStats.frameCount);
                try testing.expectEqualDeep(split_state, f.cli.splitScrollback);
            }
        }
        const output = bytes[0..len];
        try testing.expect(std.mem.startsWith(u8, output, "raw-"));
        try testing.expect(std.mem.find(u8, output, "late") != null);
        try testing.expect(std.mem.find(u8, output, "footer") == null);
        try testing.expect(std.mem.find(u8, output, "\x1b[2S") == null);
        try testing.expect(std.mem.find(u8, output, "\x1b[2K") == null);
        if (mode != .none) try testing.expectEqualDeep(transition, f.cli.pendingSplitFooterTransition);
        try testing.expect(std.mem.find(u8, output, "\x1b[1;5r") != null);
        try testing.expect(std.mem.endsWith(u8, output, "\x1b[r\x1b[6;1H" ++ ansi.ANSI.showCursor ++ ansi.ANSI.syncReset));
        try testing.expect(std.mem.find(u8, output, "\x1b[?2004h") == null);
        try testing.expect(std.mem.find(u8, output, "\x1b[?1000h") == null);
        try testing.expectEqual(frames + 1, f.cli.renderStats.frameCount);
        try testing.expectEqual(@as(u32, 4), f.cli.splitScrollback.tail_column);
        try testing.expectEqual(@as(u32, 'f'), f.cli.getCurrentBuffer().buffer.char[0]);
        try testing.expectEqual(@as(u32, 42), f.cli.checkHit(0, 0));
        try testing.expectEqual(.closed, f.value.state);
        try testing.expectEqual(.restored, f.value.getTerminalState().phase);
        try testing.expect(f.value.canDestroy());
    }
}

test "Session terminal rejects invalid setup and preserves a rejected control draft" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    for ([_]u32{ 0, 3072 }) |capacity| {
        const id = try owner.createSession(.{
            .chunk_size = 1024,
            .chunk_count = 5,
            .span_capacity = 5,
            .control_capacity = capacity,
        });
        try owner.attachSessionRenderer(id, 4, 2, .{ .env_map = &environment });
        const value = try owner.getSession(id);
        const cli = try owner.getSessionRenderer(id);
        const before = cli.terminal;
        try testing.expectError(error.NoSpace, owner.setupSessionTerminal(id, .{}));
        try testing.expectEqualDeep(before, cli.terminal);
        try testing.expectEqual(.uninitialized, value.getTerminalState().phase);
        try owner.destroy(id);
    }

    const f = try Fixture.init(testing.allocator, testing.io, 4, 2);
    defer f.deinit();
    const original = f.cli.terminal;
    try testing.expectError(error.InvalidOptions, f.owner.setupSessionTerminal(f.id, .{ .kitty_keyboard_flags = 32 }));
    f.cli.terminalSetup = true;
    try testing.expectError(error.IncompatibleOutput, f.owner.setupSessionTerminal(f.id, .{}));
    f.cli.terminalSetup = false;
    try testing.expectEqualDeep(original, f.cli.terminal);
    try testing.expectEqual(.uninitialized, f.value.getTerminalState().phase);
    try f.owner.setupSessionTerminal(f.id, .{ .kitty_keyboard_flags = 31 });
    const before = f.snapshot();
    const reservation = f.value.output.control_sequence;
    try f.value.output.setControlSequenceReservation(.{ .bytes = 1, .spans = 1 });
    try testing.expectError(error.NoSpace, f.owner.pumpSession(f.id, 100, 1));
    try testing.expectEqualDeep(before, f.snapshot());
    try testing.expect(f.value.last_pump_ns == null);
    try f.value.output.setControlSequenceReservation(reservation);
    var now_ns: u64 = 0;
    try f.drive(&now_ns, .active);
}

test "Session terminal first setup precedes accepted headless frames including pending images" {
    const pixels = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer pixels.deinit();
    for ([_]bool{ true, false }) |with_image| {
        for ([_]enum { presented, pending, copied }{ .presented, .pending, .copied }) |phase| {
            const f = try Fixture.init(testing.allocator, testing.io, 4, 2);
            defer f.deinit();
            var bytes: [4096]u8 = undefined;
            try f.paint("old", 11);
            if (with_image) {
                try testing.expect(try f.cli.getNextBuffer().drawImage(pixels, 1, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
            }
            try testing.expectEqual(.pending, try f.owner.renderSession(f.id, true));
            if (phase == .presented) {
                const packet = try f.drain(&bytes);
                if (with_image) try testing.expect(std.mem.find(u8, packet, "a=t,") != null);
            } else if (phase == .copied) {
                _ = (try f.owner.readOutput(f.id, bytes[0..1])).?;
            }
            const before = f.snapshot();
            const current = f.cli.currentImages.items;
            const pending = f.cli.pendingImages.items;
            try testing.expectError(error.InvalidTerminalState, f.owner.setupSessionTerminal(f.id, .{
                .use_alternate_screen = with_image,
            }));
            try testing.expectEqual(.uninitialized, f.value.getTerminalState().phase);
            try testing.expectEqualDeep(before, f.snapshot());
            try testing.expectEqual(current.ptr, f.cli.currentImages.items.ptr);
            try testing.expectEqual(current.len, f.cli.currentImages.items.len);
            try testing.expectEqual(pending.len, f.cli.pendingImages.items.len);
            try testing.expectEqual(@as(u32, if (phase == .presented) 11 else 0), f.cli.checkHit(0, 0));
        }
    }
}

test "Session terminal main-screen reservation is chunked and repositions once" {
    const f = try Fixture.init(testing.allocator, testing.io, 1, 8195);
    defer f.deinit();
    var bytes: [4096]u8 = undefined;
    try f.owner.setupSessionTerminal(f.id, .{ .use_alternate_screen = false });
    for (0..2) |_| {
        try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, 0, 1)).status);
        _ = try f.drain(&bytes);
    }
    for ([_]usize{ 4096, 4096, 2 }) |count| {
        const before = f.value.getStats().bytes_written;
        try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, 0, 1)).status);
        try testing.expectEqual(count, f.value.getStats().bytes_written - before);
        const rows = try f.drain(&bytes);
        try testing.expectEqual(count, rows.len);
        try testing.expect(std.mem.allEqual(u8, rows, '\n'));
        try testing.expectEqual(.setting_up, f.value.getTerminalState().phase);
    }
    try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, 0, 1)).status);
    try testing.expect(std.mem.startsWith(u8, try f.drain(&bytes), "\x1b[8194A"));
    try testing.expectEqual(.idle, (try f.owner.pumpSession(f.id, 0, 1)).status);
    try testing.expectEqual(.active, f.value.getTerminalState().phase);
}

test "Session terminal Windows cursor-row work remains bounded at the saved-row limit" {
    const f = try Fixture.init(testing.allocator, testing.io, 4, 2);
    defer f.deinit();
    var now_ns: u64 = 0;
    var bytes: [4096]u8 = undefined;
    try f.owner.setupSessionTerminal(f.id, .{});
    try f.drive(&now_ns, .active);
    try f.owner.suspendSession(f.id);
    // Enter the Windows-only row step directly so Linux exercises its full bound.
    f.value.lifecycle.step = .restore_rows;
    f.value.lifecycle.rows_remaining = std.math.maxInt(u16);
    try f.value.output.setControlSequenceReservation(.{ .bytes = 40 * 4096, .spans = 40 });
    var rows: u32 = 0;
    while (f.value.lifecycle.rows_remaining != 0) {
        const previous = f.value.lifecycle.rows_remaining;
        try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 1)).status);
        const packet = try f.drain(&bytes);
        const count = previous - f.value.lifecycle.rows_remaining;
        try testing.expect(count <= 4096 / ansi.ANSI.reverseIndex.len);
        try testing.expectEqual(count * ansi.ANSI.reverseIndex.len, packet.len);
        var index: usize = 0;
        while (index < packet.len) : (index += ansi.ANSI.reverseIndex.len) {
            try testing.expectEqualStrings(ansi.ANSI.reverseIndex, packet[index..][0..ansi.ANSI.reverseIndex.len]);
        }
        rows += count;
    }
    try testing.expectEqual(std.math.maxInt(u16), rows);
    try f.owner.beginSessionClose(f.id);
    try f.drive(&now_ns, .restored);
}

test "Session terminal cleanup visits sparse committed images and non-Kitty entries by budget" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    const f = try Fixture.init(failing.allocator(), testing.io, 4, 2);
    defer f.deinit();
    const pixels = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer pixels.deinit();
    var now_ns: u64 = 0;
    var bytes: [8192]u8 = undefined;
    try f.owner.setupSessionTerminal(f.id, .{});
    try f.drive(&now_ns, .active);
    for (0..3) |x| {
        try testing.expect(try f.cli.getNextBuffer().drawImage(pixels, 1, @intCast(x), 0, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    }
    f.cli.addToHitGrid(0, 0, 4, 2, 11);
    try testing.expectEqual(.pending, try f.owner.renderSession(f.id, true));
    _ = try f.drain(&bytes);
    try testing.expectEqual(@as(usize, 3), f.cli.currentImages.items.len);
    f.cli.currentImages.items[0].protocol = .fallback;
    f.cli.currentImages.items[1].placement_id = grapheme.IMAGE_ID_MASK;
    f.cli.currentImages.items[2].protocol = .sixel;
    var expected: [128]u8 = undefined;
    var writer: std.Io.Writer = .fixed(&expected);
    try f.cli.writeShutdownImage(&writer, 1);
    const allocated = failing.allocated_bytes;
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    try f.owner.suspendSession(f.id);
    const before = f.value.getStats();
    try testing.expectEqual(.again, (try f.owner.pumpSession(f.id, now_ns, 1)).status);
    try testing.expectEqualDeep(before, f.value.getStats());
    try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 1)).status);
    try testing.expectEqualStrings(writer.buffered(), try f.drain(&bytes));
    try testing.expectEqual(@as(usize, 3), f.cli.currentImages.items.len);
    const deleted = f.value.getStats();
    try testing.expectEqual(.again, (try f.owner.pumpSession(f.id, now_ns, 1)).status);
    try testing.expectEqualDeep(deleted, f.value.getStats());
    try f.drive(&now_ns, .suspended);
    try testing.expectEqual(@as(usize, 0), f.cli.currentImages.items.len);
    try testing.expectEqual(@as(u32, 11), f.cli.checkHit(0, 0));
    try f.owner.resumeSession(f.id);
    try f.drive(&now_ns, .active);
    try testing.expectEqual(allocated, failing.allocated_bytes);
    try testing.expect(!failing.has_induced_failure);
    failing.fail_index = std.math.maxInt(usize);
    failing.resize_fail_index = std.math.maxInt(usize);
    try testing.expect(try f.cli.getNextBuffer().drawImage(pixels, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    try testing.expectEqual(.pending, try f.owner.renderSession(f.id, false));
    try testing.expect(std.mem.find(u8, try f.drain(&bytes), "a=t,") != null);
    try testing.expectEqual(@as(usize, 1), f.cli.currentImages.items.len);
    try f.owner.beginSessionClose(f.id);
    try f.drive(&now_ns, .restored);
}

test "Session terminal restoration uses renderer split policy and selected input modes" {
    for ([_]bool{ false, true }) |clear| {
        const f = try Fixture.init(testing.allocator, testing.io, 4, 2);
        defer f.deinit();
        f.cli.setRenderOffset(4);
        f.cli.terminal.caps.kitty_keyboard = true;
        try f.owner.setupSessionTerminal(f.id, .{
            .use_alternate_screen = false,
            .clear_on_close = clear,
            .mouse_movement = false,
            .kitty_keyboard_flags = if (clear) 31 else 0,
        });
        var now_ns: u64 = 0;
        var bytes: [4096]u8 = undefined;
        for (0..2) |_| {
            _ = try f.owner.pumpSession(f.id, now_ns, 1);
            _ = try f.drain(&bytes);
        }
        _ = try f.owner.pumpSession(f.id, now_ns, 1);
        const enable = try f.drain(&bytes);
        try testing.expect(std.mem.findScalar(u8, enable, '\n') == null);
        try testing.expect(std.mem.find(u8, enable, "\x1b[1A") == null);
        try testing.expect(std.mem.find(u8, enable, ansi.ANSI.disableAnyEventTracking) != null);
        try testing.expect(std.mem.find(u8, enable, ansi.ANSI.enableAnyEventTracking) == null);
        try testing.expectEqual(clear, f.cli.terminal.state.kitty_keyboard);
        if (clear) try testing.expect(std.mem.find(u8, enable, "\x1b[>31u") != null);
        try f.drive(&now_ns, .active);
        try f.owner.suspendSession(f.id);
        var reset_len: usize = 0;
        for (0..4) |_| {
            try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 32)).status);
            reset_len += (try f.drain(bytes[reset_len..])).len;
            if (f.value.lifecycle.step == .settle_first) break;
        }
        const reset = bytes[0..reset_len];
        try testing.expectEqual(clear, std.mem.find(u8, reset, "\x1b[r\x1b[5;1H\x1b[J\x1b[5;1H") != null);
        const waiting = try f.owner.pumpSession(f.id, now_ns, 1);
        try testing.expectEqual(.wait_until, waiting.status);
        try f.owner.beginSessionClose(f.id);
        try testing.expectEqualDeep(waiting, try f.owner.pumpSession(f.id, now_ns, 1));
        try f.drive(&now_ns, .restored);
    }
}

test "Session terminal cursor waits start after partial completion and resume waits for raw output" {
    const f = try Fixture.init(testing.allocator, testing.io, 4, 2);
    defer f.deinit();
    var now_ns: u64 = 0;
    var bytes: [4096]u8 = undefined;
    try f.owner.setupSessionTerminal(f.id, .{});
    try f.drive(&now_ns, .active);
    try f.paint("old", 11);
    try testing.expectEqual(.pending, try f.owner.renderSession(f.id, true));
    _ = try f.drain(&bytes);
    try f.owner.suspendSession(f.id);
    try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 32)).status);
    _ = try f.drain(&bytes);
    try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 32)).status);
    const prefix = (try f.owner.readOutput(f.id, bytes[0..1])).?;
    try f.owner.completeOutput(f.id, prefix, .written);
    now_ns = 1_000_000_000;
    try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 32)).status);
    try testing.expect(f.value.getTerminalState().deadline_ns == null);
    _ = try f.drain(&bytes);
    const first = try f.owner.pumpSession(f.id, now_ns, 32);
    try testing.expectEqual(.wait_until, first.status);
    try testing.expectEqual(now_ns + session.cursor_settle_ns, first.deadline_ns.?);
    try testing.expectError(error.ContextBusy, f.owner.destroy(f.id));
    try testing.expectEqualDeep(first, try f.owner.pumpSession(f.id, first.deadline_ns.? - 1, 32));
    now_ns = first.deadline_ns.?;
    try testing.expectEqual(.again, (try f.owner.pumpSession(f.id, now_ns, 1)).status);
    try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 1)).status);
    const retry = (try f.owner.readOutput(f.id, &bytes)).?;
    try testing.expectEqualStrings(ansi.ANSI.showCursor, bytes[0..retry.len]);
    now_ns += 50_000_000;
    try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 32)).status);
    try testing.expect(f.value.getTerminalState().deadline_ns == null);
    try f.owner.completeOutput(f.id, retry, .written);
    const second = try f.owner.pumpSession(f.id, now_ns, 32);
    try testing.expectEqual(.wait_until, second.status);
    try testing.expectEqual(now_ns + session.cursor_settle_ns, second.deadline_ns.?);
    now_ns = second.deadline_ns.?;
    try testing.expectEqual(.idle, (try f.owner.pumpSession(f.id, now_ns, 1)).status);
    try testing.expectEqual(.suspended, f.value.getTerminalState().phase);
    try testing.expect(f.value.canDestroy());
    try testing.expect(!f.cli.terminal.state.alt_screen and !f.cli.terminal.state.mouse);
    try testing.expectEqual(@as(u32, 11), f.cli.checkHit(0, 0));
    try testing.expectError(error.TerminalInactive, f.owner.renderSession(f.id, false));
    try f.owner.resizeSessionRenderer(f.id, 2, 4);
    try testing.expectEqual(.suspended, f.value.getTerminalState().phase);
    try f.owner.resizeSessionRenderer(f.id, 4, 2);

    try f.owner.writeSession(f.id, "shell");
    const shell = (try f.owner.readOutput(f.id, bytes[0..2])).?;
    try testing.expectEqualStrings("sh", bytes[0..shell.len]);
    try f.owner.resumeSession(f.id);
    try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 32)).status);
    try testing.expectError(error.TerminalInactive, f.owner.renderSession(f.id, false));
    try testing.expectError(error.Busy, f.owner.writeSession(f.id, "blocked"));
    try f.owner.completeOutput(f.id, shell, .written);
    try testing.expectEqualStrings("ell", try f.drain(&bytes));
    try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 1)).status);
    const resumed = try f.drain(&bytes);
    try testing.expect(std.mem.startsWith(u8, resumed, ansi.ANSI.saveCursorState));
    try testing.expect(std.mem.find(u8, resumed, ansi.ANSI.xtversion) == null);
    try f.drive(&now_ns, .active);
    try f.paint("old", 22);
    try testing.expectEqual(.pending, try f.owner.renderSession(f.id, false));
    try testing.expect(std.mem.find(u8, try f.drain(&bytes), "old") != null);
    try testing.expectEqual(@as(u32, 22), f.cli.checkHit(0, 0));
}

test "Session terminal close interrupts setup frames and suspension without closing the feed early" {
    for ([_]enum { setup, frame, suspension }{ .setup, .frame, .suspension }) |phase| {
        const f = try Fixture.init(testing.allocator, testing.io, 4, 2);
        defer f.deinit();
        var now_ns: u64 = 0;
        var bytes: [4096]u8 = undefined;
        try f.owner.setupSessionTerminal(f.id, .{});
        if (phase == .setup) {
            _ = try f.owner.pumpSession(f.id, now_ns, 1);
        } else {
            try f.drive(&now_ns, .active);
            try f.paint("new", 22);
            try testing.expectEqual(.pending, try f.owner.renderSession(f.id, true));
            if (phase == .suspension) try f.owner.suspendSession(f.id);
        }
        const ticket = (try f.owner.readOutput(f.id, bytes[0..1])).?;
        try f.owner.beginSessionClose(f.id);
        try f.owner.beginSessionClose(f.id);
        try testing.expectEqual(.closing, f.value.state);
        try testing.expect(!f.value.output.closed);
        try testing.expectError(error.SessionClosed, f.owner.writeSession(f.id, ""));
        try testing.expectError(error.SessionClosed, f.owner.renderSession(f.id, false));
        try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 32)).status);
        try f.owner.completeOutput(f.id, ticket, .written);
        _ = try f.drain(&bytes);
        try testing.expectEqual(.closing, f.value.state);
        try testing.expect(!f.value.output.closed);
        try f.drive(&now_ns, .restored);
        try testing.expectEqual(.closed, f.value.state);
        try testing.expect(f.value.output.closed);
        try testing.expect(now_ns >= 2 * session.cursor_settle_ns);
        try testing.expectEqual(@as(u32, if (phase == .setup) 0 else 22), f.cli.checkHit(0, 0));
    }
}

test "Session terminal failed cleanup retains committed images and hit grid until explicit cancel" {
    const f = try Fixture.init(testing.allocator, testing.io, 4, 2);
    defer f.deinit();
    const pixels = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
    defer pixels.deinit();
    var now_ns: u64 = 0;
    var bytes: [4096]u8 = undefined;
    try f.owner.setupSessionTerminal(f.id, .{});
    try f.drive(&now_ns, .active);
    try f.paint("old", 11);
    try testing.expect(try f.cli.getNextBuffer().drawImage(pixels, 1, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
    try testing.expectEqual(.pending, try f.owner.renderSession(f.id, true));
    _ = try f.drain(&bytes);
    const image_state = f.cli.currentImages.items[0];
    const buffer = f.cli.currentRenderBuffer;
    const stats = f.cli.getRenderStats();
    try f.owner.beginSessionClose(f.id);
    try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 1)).status);
    const partial = (try f.owner.readOutput(f.id, bytes[0..1])).?;
    try f.owner.completeOutput(f.id, partial, .written);
    const failed = (try f.owner.readOutput(f.id, &bytes)).?;
    const retained = f.value.getStats();
    try f.owner.completeOutput(f.id, failed, .failed);
    try testing.expectEqual(.failed, f.value.getTerminalState().phase);
    try testing.expectEqualDeep(retained, f.value.getStats());
    try testing.expectEqualDeep(image_state, f.cli.currentImages.items[0]);
    try testing.expect(buffer == f.cli.currentRenderBuffer);
    try testing.expectEqualDeep(stats, f.cli.getRenderStats());
    try testing.expectEqual(@as(u32, 11), f.cli.checkHit(0, 0));
    try testing.expectError(error.SessionFailed, f.owner.pumpSession(f.id, now_ns, 32));
    try testing.expectError(error.SessionFailed, f.value.pumpExit());
    try testing.expectEqualDeep(retained, f.value.getStats());
    try testing.expectError(error.SessionFailed, f.owner.resumeSession(f.id));
    try testing.expectError(error.SessionFailed, f.owner.beginSessionClose(f.id));
    try testing.expectError(error.SessionFailed, f.owner.readOutput(f.id, &bytes));
    try testing.expectError(error.ContextBusy, f.owner.destroy(f.id));
    try testing.expectError(error.ContextBusy, f.owner.deinit());
    try f.owner.cancelSession(f.id);
    try testing.expectEqual(.cancelled, f.value.getTerminalState().phase);
    try testing.expectError(error.SessionCancelled, f.value.pumpExit());
    try testing.expect(f.value.canDestroy());
    try testing.expectError(error.StaleRequest, f.owner.completeOutput(f.id, failed, .written));
}

test "Session terminal clocks and budgets reject without partial state including the final u64 deadline" {
    const f = try Fixture.init(testing.allocator, testing.io, 4, 2);
    defer f.deinit();
    var now_ns: u64 = 100;
    var bytes: [4096]u8 = undefined;
    try f.owner.setupSessionTerminal(f.id, .{});
    try f.drive(&now_ns, .active);
    try f.owner.beginSessionClose(f.id);
    for (0..2) |_| {
        try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 32)).status);
        _ = try f.drain(&bytes);
    }
    const before = f.value.lifecycle;
    const stats = f.value.getStats();
    try testing.expectError(error.InvalidClock, f.owner.pumpSession(f.id, now_ns - 1, 1));
    try testing.expectError(error.InvalidClock, f.owner.pumpSession(f.id, std.math.maxInt(u64), 1));
    try testing.expectError(error.InvalidClock, f.owner.pumpSession(f.id, std.math.maxInt(u64) - 2 * session.cursor_settle_ns + 1, 1));
    try testing.expectError(error.InvalidBudget, f.owner.pumpSession(f.id, now_ns, 0));
    try testing.expectEqualDeep(before, f.value.lifecycle);
    try testing.expectEqualDeep(stats, f.value.getStats());
    try testing.expectEqual(now_ns, f.value.last_pump_ns.?);
    now_ns = std.math.maxInt(u64) - 2 * session.cursor_settle_ns;
    const first = try f.owner.pumpSession(f.id, now_ns, std.math.maxInt(u32));
    now_ns = first.deadline_ns.?;
    const waiting = f.value.lifecycle;
    try testing.expectError(error.InvalidClock, f.owner.pumpSession(f.id, now_ns + 1, 32));
    try testing.expectEqualDeep(waiting, f.value.lifecycle);
    try testing.expectEqual(.again, (try f.owner.pumpSession(f.id, now_ns, 1)).status);
    try testing.expectError(error.InvalidClock, f.owner.pumpSession(f.id, now_ns + 1, 1));
    try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 1)).status);
    _ = try f.drain(&bytes);
    const second = try f.owner.pumpSession(f.id, now_ns, 32);
    try testing.expectEqual(std.math.maxInt(u64), second.deadline_ns.?);
    try testing.expectEqual(.closed, (try f.owner.pumpSession(f.id, second.deadline_ns.?, 32)).status);
}

test "Session terminal setup resume and image admission retain full cleanup counter headroom" {
    for ([_]enum { bytes, spans }{ .bytes, .spans }) |counter| {
        const f = try Fixture.init(testing.allocator, testing.io, 4, 2);
        defer f.deinit();
        const terminal_before = f.cli.terminal;
        if (counter == .bytes) {
            f.value.output.stats.bytes_written = std.math.maxInt(u64) - 1;
            f.value.completed_bytes = f.value.output.stats.bytes_written;
        } else {
            f.value.output.span_ring.next_id = std.math.maxInt(u64) - 1;
        }
        try testing.expectError(error.NoSpace, f.owner.setupSessionTerminal(f.id, .{}));
        try testing.expectEqualDeep(terminal_before, f.cli.terminal);
        try testing.expectEqual(.uninitialized, f.value.getTerminalState().phase);
        f.value.output.stats.bytes_written = 0;
        f.value.completed_bytes = 0;
        f.value.output.span_ring.next_id = 1;
        var now_ns: u64 = 0;
        try f.owner.setupSessionTerminal(f.id, .{});
        try f.drive(&now_ns, .active);
        const reservation = f.value.output.control_sequence;
        if (counter == .bytes) {
            f.value.output.stats.bytes_written = std.math.maxInt(u64) - reservation.bytes;
            f.value.completed_bytes = f.value.output.stats.bytes_written;
        } else {
            f.value.output.span_ring.next_id = std.math.maxInt(u64) - reservation.spans;
        }
        const pixels = try image.createFromRgba(testing.allocator, &.{ 255, 0, 0, 255 }, 1, 1, 4);
        defer pixels.deinit();
        try f.paint("new", 22);
        try testing.expect(try f.cli.getNextBuffer().drawImage(pixels, 1, 0, 1, 1, 1, 0, 0, 0, 0, 1, 1, .kitty));
        const stats = f.value.getStats();
        try testing.expectError(error.NoSpace, f.owner.renderSession(f.id, true));
        try testing.expectError(error.NoSpace, f.owner.writeSession(f.id, "x"));
        try testing.expectEqualDeep(stats, f.value.getStats());
        try testing.expectEqualDeep(reservation, f.value.output.control_sequence);
        try testing.expectEqual(@as(usize, 1), f.cli.getNextBuffer().image_placements.items.len);
        try testing.expectEqual(@as(u32, 22), f.cli.nextHitGrid[0]);
        try testing.expectEqual(@as(u32, 0), f.cli.checkHit(0, 0));
        try f.owner.suspendSession(f.id);
        try f.drive(&now_ns, .suspended);
        const restored = f.cli.terminal;
        try testing.expectError(error.NoSpace, f.owner.resumeSession(f.id));
        try testing.expectEqualDeep(restored, f.cli.terminal);
        try testing.expectEqual(.suspended, f.value.getTerminalState().phase);
        try f.owner.beginSessionClose(f.id);
        try testing.expectEqual(.closed, f.value.state);
    }
}

pub const Probe = struct {
    time_us: i64 = 0,
    clocks: u32 = 0,
    sleeps: u32 = 0,

    pub fn io(self: *Probe) std.Io {
        return .{ .userdata = self, .vtable = &vtable };
    }

    const vtable: std.Io.VTable = blk: {
        var value = std.Io.failing.vtable.*;
        value.now = now;
        value.sleep = sleep;
        break :blk value;
    };

    fn now(data: ?*anyopaque, _: std.Io.Clock) std.Io.Timestamp {
        const self: *Probe = @ptrCast(@alignCast(data.?));
        self.clocks += 1;
        return .{ .nanoseconds = @as(i96, self.time_us) * 1000 };
    }

    fn sleep(data: ?*anyopaque, _: std.Io.Timeout) std.Io.Cancelable!void {
        const self: *Probe = @ptrCast(@alignCast(data.?));
        self.sleeps += 1;
    }
};

test "Session exit pump preserves output order and restoration without clocks or sleeps" {
    for ([_]bool{ false, true }) |closing| {
        var failing = testing.FailingAllocator.init(testing.allocator, .{});
        var probe: Probe = .{};
        const io: std.Io = .{ .userdata = &probe, .vtable = &Probe.vtable };
        const f = try Fixture.init(failing.allocator(), io, 4, 2);
        defer f.deinit();
        var now_ns: u64 = 100;
        try f.owner.setupSessionTerminal(f.id, .{});
        try f.drive(&now_ns, .active);
        if (closing) {
            try f.owner.beginSessionClose(f.id);
            try testing.expectEqual(.output_pending, (try f.value.pump(now_ns, 32)).status);
            try testing.expect(!f.cli.terminal.state.alt_screen);
        } else {
            try f.value.write("queued-before-exit");
        }
        var bytes: [8192]u8 = undefined;
        const ticket = (try f.value.readOutput(bytes[0..1])).?;
        const clocks = probe.clocks;
        const allocated = failing.allocated_bytes;
        failing.fail_index = failing.alloc_index;
        failing.resize_fail_index = failing.resize_index;
        try testing.expectEqual(.output_pending, try f.value.pumpExit());
        try testing.expectEqualDeep(ticket, f.value.pending.?);
        try f.value.completeOutput(ticket, .written);
        var len: usize = ticket.len;
        for (0..32) |_| {
            switch (try f.value.pumpExit()) {
                .output_pending => len += (try f.drain(bytes[len..])).len,
                .again => {},
                .closed => break,
                else => return error.TestUnexpectedResult,
            }
        }
        try testing.expectEqual(.closed, f.value.state);
        try testing.expectEqual(.restored, f.value.getTerminalState().phase);
        try testing.expectEqual(now_ns, f.value.last_pump_ns.?);
        try testing.expectEqual(clocks, probe.clocks);
        try testing.expectEqual(@as(u32, 0), probe.sleeps);
        try testing.expectEqual(allocated, failing.allocated_bytes);
        try testing.expect(!failing.has_induced_failure);
        const output = bytes[0..len];
        if (!closing) try testing.expect(std.mem.startsWith(u8, output, "queued-before-exit"));
        try testing.expect(std.mem.find(u8, output, "\x1b[?1049l") != null);
        try testing.expect(std.mem.find(u8, output, "\x1b[?2004l") != null);
        try testing.expect(std.mem.endsWith(u8, output, ansi.ANSI.showCursor));
        try testing.expect(f.value.canDestroy());
    }
}

test "Session terminal pumps are allocation-free clock-free and independent after initialization" {
    var failing = testing.FailingAllocator.init(testing.allocator, .{});
    var probe: Probe = .{};
    const io: std.Io = .{ .userdata = &probe, .vtable = &Probe.vtable };
    const f = try Fixture.init(failing.allocator(), io, 4, 2);
    defer f.deinit();
    const sibling = try f.owner.createSession(transport);
    defer f.owner.cancelSession(sibling) catch unreachable;
    try f.owner.attachSessionRenderer(sibling, 1, 9000, .{ .env_map = &environment });
    const other: Fixture = .{
        .owner = f.owner,
        .id = sibling,
        .value = try f.owner.getSession(sibling),
        .cli = try f.owner.getSessionRenderer(sibling),
    };
    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    const allocated = failing.allocated_bytes;
    const clocks = probe.clocks;
    try f.owner.setupSessionTerminal(f.id, .{});
    try f.owner.setupSessionTerminal(sibling, .{ .use_alternate_screen = false });
    var first_ns: u64 = 1_000_000_000;
    var second_ns: u64 = 0;
    try f.drive(&first_ns, .active);
    try testing.expectEqual(.setting_up, other.value.getTerminalState().phase);
    try f.owner.suspendSession(f.id);
    try other.drive(&second_ns, .active);
    try f.drive(&first_ns, .suspended);
    try f.owner.resumeSession(f.id);
    try f.drive(&first_ns, .active);
    try f.owner.beginSessionClose(f.id);
    try f.drive(&first_ns, .restored);
    try testing.expectEqual(.active, other.value.getTerminalState().phase);
    try f.owner.beginSessionClose(sibling);
    try other.drive(&second_ns, .restored);
    try testing.expectEqual(clocks, probe.clocks);
    try testing.expectEqual(@as(u32, 0), probe.sleeps);
    try testing.expectEqual(allocated, failing.allocated_bytes);
    try testing.expect(!failing.has_induced_failure);
}
