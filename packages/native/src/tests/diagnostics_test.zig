const std = @import("std");
const logger = @import("../logger.zig");
const context = @import("../context.zig");
const buffer = @import("../buffer.zig");
const CompatibilityOwner = @import("../compatibility-context.zig").CompatibilityOwner;

test "Context Yoga warnings use only their owning diagnostic queues with bounded formatting" {
    const yoga = @import("../yoga.zig");
    const InvalidMeasure = struct {
        fn measure(data: ?*anyopaque, _: yoga.YGNodeConstRef, _: f32, _: u32, _: f32, _: u32) yoga.ExternalYogaSize {
            const height: *f32 = @ptrCast(@alignCast(data.?));
            return .{ .width = std.math.nan(f32), .height = height.* };
        }
    };
    LegacyProbe.calls.store(0, .monotonic);
    logger.setLogCallback(LegacyProbe.callback);
    defer logger.setLogCallback(null);
    var heights = [_]f32{ 11, 22 };
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const first = try context.Context.init(failing.allocator(), std.testing.io, .{
        .diagnostic_capacity = 3,
        .yoga_callbacks = .{ .user_data = &heights[0], .measure = InvalidMeasure.measure },
    });
    var first_alive = true;
    defer if (first_alive) first.deinit() catch unreachable;
    const second = try context.Context.init(failing.allocator(), std.testing.io, .{
        .diagnostic_capacity = 3,
        .yoga_callbacks = .{ .user_data = &heights[1], .measure = InvalidMeasure.measure },
    });
    defer second.deinit() catch unreachable;
    var nodes: [2]context.Handle = undefined;
    for ([_]*context.Context{ first, second }, 0..) |owner, index| {
        const id = try owner.createSession(.{});
        try owner.attachSessionRenderer(id, 1, 1, .{ .remote_mode = .remote });
        _ = try owner.sceneCreateNode(id, 0, 1);
        nodes[index] = try owner.sceneCreateNode(id, 1, 2);
    }
    var events: [3]logger.Diagnostic = undefined;
    failing.fail_index = failing.alloc_index;
    yoga.testFailAfter(0);
    defer yoga.testFailAfter(-1);
    for ([_]*context.Context{ first, second }, 0..) |owner, index| {
        const node = try owner.getRenderable(nodes[index]);
        try yoga.check(yoga.yogaNodeSetMeasureFuncChecked(node.yoga_node, 1));
        try yoga.check(yoga.yogaNodeCalculateLayoutChecked(node.yoga_node, std.math.nan(f32), std.math.nan(f32), 1));
        try std.testing.expectEqual(heights[index], (try owner.sceneGetLayout(nodes[index], true)).height);
    }
    for ([_]*context.Context{ first, second }, 0..) |owner, index| {
        try std.testing.expectEqual(@as(u32, 1), owner.diagnostics.drain(&events).count);
        const event = &events[0];
        try std.testing.expectEqual(.warn, event.level);
        try std.testing.expect(!event.truncated);
        const message = event.message[0..event.message_len];
        try std.testing.expect(std.mem.startsWith(u8, message, "Yoga: Measure function returned an invalid dimension"));
        try std.testing.expect(std.mem.find(u8, message, if (index == 0) "height=11.000000" else "height=22.000000") != null);
    }
    try first.deinit();
    first_alive = false;
    const remaining = try second.getRenderable(nodes[1]);
    try yoga.check(yoga.yogaNodeMarkDirtyChecked(remaining.yoga_node));
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(remaining.yoga_node, std.math.nan(f32), std.math.nan(f32), 1));
    const long_message = [_:0]u8{'x'} ** (logger.Diagnostic.message_bytes_max + 1);
    yoga.testLogMessage(second.yoga_config.ref, &long_message);
    try std.testing.expectEqual(@as(u32, 2), second.diagnostics.drain(&events).count);
    try std.testing.expect(events[1].truncated);
    try std.testing.expectEqual(@as(u32, logger.Diagnostic.message_bytes_max), events[1].message_len);
    try std.testing.expectEqualStrings("Yoga: ", events[1].message[0..6]);
    try std.testing.expect(std.mem.allEqual(u8, events[1].message[6..], 'x'));
    second.logger = .{ .callback = LegacyProbe.callback };
    yoga.testLogMessage(second.yoga_config.ref, "must not invoke host code");
    second.logger = .{ .diagnostics = &second.diagnostics };
    try std.testing.expectEqual(@as(u32, 0), LegacyProbe.calls.load(.monotonic));
    try std.testing.expect(!failing.has_induced_failure);
    try std.testing.expectEqual(@as(u64, 0), yoga.testAllocationCount());
}

test "diagnostics copy messages and drain FIFO with drop-newest overflow" {
    var queue = try logger.Diagnostics.init(std.testing.allocator, 2);
    defer queue.deinit();
    const log: logger.Logger = .{ .diagnostics = &queue };
    var events: [2]logger.Diagnostic = undefined;
    try std.testing.expectEqual(@as(u32, 0), queue.drain(&events).count);

    var source = "first".*;
    log.err("{s}", .{&source});
    @memset(&source, '!');
    log.info("", .{});
    log.warn("dropped", .{});
    const snapshot = queue.drain(&.{});
    try std.testing.expectEqual(@as(u32, 0), snapshot.count);
    try std.testing.expectEqual(@as(u32, 2), snapshot.remaining);
    try std.testing.expectEqual(@as(u64, 1), snapshot.dropped);

    const first = queue.drain(events[0..1]);
    try std.testing.expectEqual(@as(u32, 1), first.count);
    try std.testing.expectEqual(@as(u32, 1), first.remaining);
    try std.testing.expectEqual(.err, events[0].level);
    try std.testing.expectEqualStrings("first", events[0].message[0..events[0].message_len]);
    try std.testing.expect(!events[0].truncated);
    try std.testing.expect(std.mem.allEqual(u8, events[0].message[events[0].message_len..], 0));
    log.debug("wrapped", .{});
    const rest = queue.drain(&events);
    try std.testing.expectEqual(@as(u32, 2), rest.count);
    try std.testing.expectEqual(@as(u32, 0), rest.remaining);
    try std.testing.expectEqual(@as(u64, 1), rest.dropped);
    try std.testing.expectEqual(.info, events[0].level);
    try std.testing.expectEqual(@as(u32, 0), events[0].message_len);
    try std.testing.expectEqual(.debug, events[1].level);
    try std.testing.expectEqualStrings("wrapped", events[1].message[0..events[1].message_len]);
}

test "diagnostics truncate only over-limit messages and do not allocate while logging" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    var queue = try logger.Diagnostics.init(failing.allocator(), 3);
    defer queue.deinit();
    const log: logger.Logger = .{ .diagnostics = &queue };
    failing.fail_index = failing.alloc_index;
    const source = [_]u8{'x'} ** (logger.Diagnostic.message_bytes_max + 1);
    for ([_]usize{ source.len - 2, source.len - 1, source.len }) |length| {
        log.warn("{s}", .{source[0..length]});
    }
    var events: [3]logger.Diagnostic = undefined;
    try std.testing.expectEqual(@as(u32, 3), queue.drain(&events).count);
    for (&events, 0..) |*event, index| {
        try std.testing.expectEqual(.warn, event.level);
        try std.testing.expectEqual(index == 2, event.truncated);
        try std.testing.expectEqual(@min(source.len - 2 + index, source.len - 1), event.message_len);
        try std.testing.expectEqualStrings(source[0..event.message_len], event.message[0..event.message_len]);
    }
    try std.testing.expectEqual(failing.fail_index, failing.alloc_index);
    try std.testing.expect(!failing.has_induced_failure);
}

test "diagnostics zero capacity drops messages and drop counts saturate" {
    var queue = try logger.Diagnostics.init(std.testing.allocator, 0);
    defer queue.deinit();
    const log: logger.Logger = .{ .diagnostics = &queue };
    log.info("disabled", .{});
    try std.testing.expectEqual(@as(u64, 1), queue.drain(&.{}).dropped);
    queue.dropped_count = std.math.maxInt(u64) - 1;
    log.err("last counted", .{});
    log.err("saturated", .{});
    const result = queue.drain(&.{});
    try std.testing.expectEqual(@as(u64, std.math.maxInt(u64)), result.dropped);
    try std.testing.expectEqual(@as(u32, 0), result.remaining);
}

test "diagnostics legacy adapter preserves message levels and formatting failure" {
    const Capture = struct {
        var level: u8 = 0;
        var length: u32 = 0;
        var bytes: [logger.Diagnostic.message_bytes_max]u8 = undefined;

        fn callback(message_level: u8, message: [*]const u8, message_len: u32) callconv(.c) void {
            level = message_level;
            length = message_len;
            @memcpy(bytes[0..length], message[0..length]);
        }
    };
    logger.setLogCallback(Capture.callback);
    defer logger.setLogCallback(null);
    logger.debug("legacy {}", .{42});
    try std.testing.expectEqual(@intFromEnum(logger.LogLevel.debug), Capture.level);
    try std.testing.expectEqualStrings("legacy 42", Capture.bytes[0..Capture.length]);
    logger.info("{s}", .{&([_]u8{'x'} ** (logger.Diagnostic.message_bytes_max + 1))});
    try std.testing.expectEqual(@intFromEnum(logger.LogLevel.err), Capture.level);
    try std.testing.expectEqualStrings("Log formatting failed", Capture.bytes[0..Capture.length]);
}

const LegacyProbe = struct {
    var calls: std.atomic.Value(u32) = .init(0);

    fn callback(_: u8, _: [*]const u8, _: u32) callconv(.c) void {
        _ = calls.fetchAdd(1, .monotonic);
    }
};

test "diagnostics compatibility owners clear only their own callback on successful teardown" {
    LegacyProbe.calls.store(0, .monotonic);
    logger.setLogCallback(LegacyProbe.callback);
    defer logger.setLogCallback(null);
    const owner = try std.testing.allocator.create(CompatibilityOwner);
    defer std.testing.allocator.destroy(owner);
    owner.init();
    const log = &owner.logger;
    try std.testing.expect(log.callback == null);
    owner.logger = .{ .callback = LegacyProbe.callback };
    var value: u32 = 0;
    const handle = try owner.registry.insert(.renderer, &value);
    try std.testing.expectError(error.LiveHandles, owner.deinit());
    log.warn("busy owner keeps its callback", .{});
    try std.testing.expectEqual(@as(u32, 1), LegacyProbe.calls.load(.monotonic));
    owner.registry.invalidate(handle, .renderer);
    try std.testing.expectEqual(std.heap.Check.ok, try owner.deinit());
    try std.testing.expect(log.callback == null);
    log.warn("closed owner is silent", .{});
    try std.testing.expectEqual(@as(u32, 1), LegacyProbe.calls.load(.monotonic));
    logger.warn("default owner still registered", .{});
    try std.testing.expectEqual(@as(u32, 2), LegacyProbe.calls.load(.monotonic));
}

const LogTask = struct {
    owner: *context.Context,
    text_id: context.Handle,
    view_id: context.Handle,
    renderer_id: context.Handle,
    text: []const u8,
    gate: *std.Io.Event,
    failure: ?anyerror = null,
    thread_id: ?std.Thread.Id = null,

    fn run(self: *LogTask) void {
        self.gate.waitUncancelable(std.testing.io);
        self.thread_id = std.Thread.getCurrentId();
        self.render() catch |err| {
            self.failure = err;
        };
    }

    fn render(self: *LogTask) !void {
        self.owner.logger.err("context {s}", .{self.text});
        try self.owner.textBufferSetText(self.text_id, self.text);
        const text = try self.owner.getTextBuffer(self.text_id);
        text.buffer.debugLogRope();
        const view = (try self.owner.getTextBufferView(self.view_id)).view;
        view.setViewportSize(16, 1);
        const value = try self.owner.getSessionRenderer(self.renderer_id);
        value.logger.warn("renderer {s}", .{self.text});
        value.getNextBuffer().drawTextBuffer(view, 0, 0);
        try std.testing.expectEqual(.pending, try self.owner.renderSession(self.renderer_id, true));
        var bytes: [4096]u8 = undefined;
        const ticket = (try self.owner.readOutput(self.renderer_id, &bytes)).?;
        try std.testing.expect(std.mem.find(u8, bytes[0..ticket.len], self.text) != null);
        try self.owner.completeOutput(self.renderer_id, ticket, .written);
        try std.testing.expect((try self.owner.getSession(self.renderer_id)).isDrained());
    }
};

test "Context diagnostics stay isolated across threads and teardown with a legacy callback registered" {
    LegacyProbe.calls.store(0, .monotonic);
    logger.setLogCallback(LegacyProbe.callback);
    defer logger.setLogCallback(null);
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    const first = try context.Context.init(std.testing.allocator, std.testing.io, .{
        .object_capacity = 3,
        .diagnostic_capacity = 8,
    });
    var first_alive = true;
    defer if (first_alive) first.deinit() catch unreachable;
    const second = try context.Context.init(std.testing.allocator, std.testing.io, .{
        .object_capacity = 3,
        .diagnostic_capacity = 8,
    });
    defer second.deinit() catch unreachable;

    var gate: std.Io.Event = .unset;
    var tasks: [2]LogTask = undefined;
    for ([_]*context.Context{ first, second }, 0..) |owner, index| {
        const text = try owner.createTextBuffer(.unicode);
        const id = try owner.createSession(.{ .chunk_size = 4096 });
        try owner.attachSessionRenderer(id, 16, 1, .{ .env_map = &env });
        tasks[index] = .{
            .owner = owner,
            .text_id = text,
            .view_id = try owner.createTextBufferView(text),
            .renderer_id = id,
            .text = if (index == 0) "alpha" else "bravo-two",
            .gate = &gate,
        };
    }
    const first_thread = try std.Thread.spawn(.{}, LogTask.run, .{&tasks[0]});
    const second_thread = std.Thread.spawn(.{}, LogTask.run, .{&tasks[1]}) catch |err| {
        gate.set(std.testing.io);
        first_thread.join();
        return err;
    };
    gate.set(std.testing.io);
    first_thread.join();
    second_thread.join();
    for (tasks) |task| if (task.failure) |err| return err;
    try std.testing.expect(tasks[0].thread_id.? != tasks[1].thread_id.?);

    var events: [8]logger.Diagnostic = undefined;
    for (tasks, 0..) |task, index| {
        const result = task.owner.diagnostics.drain(&events);
        try std.testing.expectEqual(@as(u32, 8), result.count);
        try std.testing.expectEqual(@as(u64, 0), result.dropped);
        try std.testing.expectEqual(.err, events[0].level);
        try std.testing.expectEqualStrings(task.text, events[0].message[8..events[0].message_len]);
        try std.testing.expectEqual(.debug, events[3].level);
        try std.testing.expectEqualStrings(if (index == 0) "Char count: 5" else "Char count: 9", events[3].message[0..events[3].message_len]);
        try std.testing.expectEqual(.warn, events[7].level);
        try std.testing.expectEqualStrings(task.text, events[7].message[9..events[7].message_len]);
    }
    try first.deinit();
    first_alive = false;
    try tasks[1].render();
    try std.testing.expectEqual(@as(u32, 8), second.diagnostics.drain(&events).count);
    try std.testing.expectEqualStrings("context bravo-two", events[0].message[0..events[0].message_len]);
    try std.testing.expectEqual(@as(u32, 0), LegacyProbe.calls.load(.monotonic));
    logger.warn("legacy still registered", .{});
    try std.testing.expectEqual(@as(u32, 1), LegacyProbe.calls.load(.monotonic));
}

test "Context diagnostics capture renderer and buffer failures without invoking the legacy callback" {
    LegacyProbe.calls.store(0, .monotonic);
    logger.setLogCallback(LegacyProbe.callback);
    defer logger.setLogCallback(null);
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), std.testing.io, .{
        .object_capacity = 3,
        .diagnostic_capacity = 3,
    });
    defer owner.deinit() catch unreachable;
    const renderer_id = try owner.createSession(.{});
    try owner.attachSessionRenderer(renderer_id, 2, 1, .{ .remote_mode = .remote });
    const value = try owner.getSessionRenderer(renderer_id);
    failing.fail_index = failing.alloc_index;
    value.hitGridPushScissorRect(0, 0, 2, 1);
    try std.testing.expect(failing.has_induced_failure);
    failing.fail_index = std.math.maxInt(usize);

    const text_id = try owner.createTextBuffer(.unicode);
    try owner.textBufferSetText(text_id, "a" ++ "\xcc\x81" ** 64);
    const view = (try owner.getTextBufferView(try owner.createTextBufferView(text_id))).view;
    view.setViewportSize(2, 1);
    value.getNextBuffer().drawTextBuffer(view, 0, 0);
    try std.testing.expectError(error.InvalidDimensions, buffer.OptimizedBuffer.init(std.testing.allocator, 0, 1, .{
        .pool = &owner.graphemes,
        .logger = &owner.logger,
    }));
    var events: [3]logger.Diagnostic = undefined;
    const result = owner.diagnostics.drain(&events);
    try std.testing.expectEqual(@as(u32, 3), result.count);
    try std.testing.expectEqual(@as(u64, 0), result.dropped);
    for (events) |event| try std.testing.expectEqual(.warn, event.level);
    try std.testing.expectEqualStrings("Failed to push hit-grid scissor rect: error.OutOfMemory", events[0].message[0..events[0].message_len]);
    try std.testing.expect(std.mem.find(u8, events[1].message[0..events[1].message_len], "error.GraphemeTooLong") != null);
    try std.testing.expectEqualStrings("OptimizedBuffer.init: Invalid dimensions 0x1", events[2].message[0..events[2].message_len]);
    try std.testing.expectEqual(@as(u32, 0), LegacyProbe.calls.load(.monotonic));
    try std.testing.expectError(error.InvalidDimensions, buffer.OptimizedBuffer.init(std.testing.allocator, 0, 1, .{
        .pool = &owner.graphemes,
    }));
    try std.testing.expectEqual(@as(u32, 1), LegacyProbe.calls.load(.monotonic));
}

test "Context diagnostics text resources use the supplied I/O" {
    const FileIo = struct {
        calls: u32 = 0,

        const vtable: std.Io.VTable = blk: {
            var result = std.Io.failing.vtable.*;
            result.dirOpenFile = openFile;
            break :blk result;
        };

        fn openFile(user_data: ?*anyopaque, _: std.Io.Dir, _: []const u8, _: std.Io.Dir.OpenFileOptions) std.Io.File.OpenError!std.Io.File {
            const self: *@This() = @ptrCast(@alignCast(user_data.?));
            self.calls += 1;
            return error.FileNotFound;
        }
    };
    var supplied: FileIo = .{};
    const owner = try context.Context.init(std.testing.allocator, .{ .userdata = &supplied, .vtable = &FileIo.vtable }, .{
        .object_capacity = 1,
    });
    defer owner.deinit() catch unreachable;
    const text = try owner.getTextBuffer(try owner.createTextBuffer(.unicode));
    try std.testing.expectError(error.InvalidIndex, text.buffer.loadFile("diagnostics-fixture.txt"));
    try std.testing.expectEqual(@as(u32, 1), supplied.calls);
}

test "Context diagnostics preserve rope log order after snapshot allocation failure" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), std.testing.io, .{
        .object_capacity = 1,
        .diagnostic_capacity = 6,
    });
    defer owner.deinit() catch unreachable;
    const text_id = try owner.createTextBuffer(.unicode);
    try owner.textBufferSetText(text_id, "owned");
    const text = try owner.getTextBuffer(text_id);
    failing.fail_index = failing.alloc_index;
    text.buffer.debugLogRope();
    try std.testing.expect(failing.has_induced_failure);
    failing.fail_index = std.math.maxInt(usize);
    var events: [6]logger.Diagnostic = undefined;
    try std.testing.expectEqual(@as(u32, 5), owner.diagnostics.drain(&events).count);
    for ([_][]const u8{
        "=== TextBuffer Rope Debug ===",
        "Line count: 1",
        "Char count: 5",
        "Byte size: 5",
        "Failed to generate rope text representation",
    }, 0..) |expected, index| {
        try std.testing.expectEqualStrings(expected, events[index].message[0..events[index].message_len]);
    }
    text.buffer.debugLogRope();
    try std.testing.expectEqual(@as(u32, 6), owner.diagnostics.drain(&events).count);
    try std.testing.expectEqualStrings("=== End Rope Debug ===", events[5].message[0..events[5].message_len]);
}
