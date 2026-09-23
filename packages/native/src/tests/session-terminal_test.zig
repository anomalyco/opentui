const std = @import("std");
const testing = std.testing;
const context = @import("../context.zig");
const session = @import("../session.zig");
const renderer = @import("../renderer.zig");
const ansi = @import("../ansi.zig");
const image = @import("../image.zig");
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
            .value = try owner.raw().getSession(id),
            .cli = try owner.raw().getSessionRenderer(id),
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
    _ = try f.owner.scenePaint(f.id, .{ 0, 0, 0, 255 }, false, 0);
}

test "Session terminal rejects invalid setup and preserves a rejected control draft" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    {
        const id = try owner.createSession(.{
            .chunk_size = 1024,
            .chunk_count = 5,
            .span_capacity = 5,
            .control_capacity = 0,
        });
        try owner.attachSessionRenderer(id, 4, 2, .{ .env_map = &environment });
        const value = try owner.raw().getSession(id);
        const cli = try owner.raw().getSessionRenderer(id);
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
    // Enter the Windows-only row step directly so Linux exercises the per-pump bound.
    const packet_rows_max = 4096 / ansi.ANSI.reverseIndex.len;
    f.value.lifecycle.step = .restore_rows;
    f.value.lifecycle.rows_remaining = packet_rows_max + 10;
    try f.value.output.setControlSequenceReservation(.{ .bytes = 40 * 4096, .spans = 40 });
    var rows: u32 = 0;
    while (f.value.lifecycle.rows_remaining != 0) {
        const previous = f.value.lifecycle.rows_remaining;
        try testing.expectEqual(.output_pending, (try f.owner.pumpSession(f.id, now_ns, 1)).status);
        const packet = try f.drain(&bytes);
        const count = previous - f.value.lifecycle.rows_remaining;
        try testing.expect(count <= packet_rows_max);
        try testing.expectEqual(count * ansi.ANSI.reverseIndex.len, packet.len);
        rows += count;
    }
    try testing.expectEqual(packet_rows_max + 10, rows);
    try testing.expect(rows > packet_rows_max);
    try f.owner.beginSessionClose(f.id);
    try f.drive(&now_ns, .restored);
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
        .value = try f.owner.raw().getSession(sibling),
        .cli = try f.owner.raw().getSessionRenderer(sibling),
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
