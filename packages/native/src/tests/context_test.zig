const std = @import("std");
const context = @import("../context.zig");
const handles = @import("../context-handles.zig");
const yoga = @import("../yoga.zig");
const ansi = @import("../ansi.zig");
const buffer = @import("../buffer.zig");
const gp = @import("../grapheme.zig");
const Fixture = @import("scene_fixture_test.zig").Fixture;

test {
    _ = @import("context-reuse_test.zig");
}

const Clock = struct {
    time_us: i64,
    calls: u32 = 0,

    const vtable: std.Io.VTable = blk: {
        var value = std.Io.failing.vtable.*;
        value.now = now;
        break :blk value;
    };

    fn io(self: *Clock) std.Io {
        return .{ .userdata = self, .vtable = &vtable };
    }

    fn now(user_data: ?*anyopaque, _: std.Io.Clock) std.Io.Timestamp {
        const self: *Clock = @ptrCast(@alignCast(user_data.?));
        self.calls += 1;
        return .{ .nanoseconds = @as(i96, self.time_us) * 1000 };
    }
};

const Callbacks = struct {
    width: f32,
    measurements: u32 = 0,
    dirtied: u32 = 0,

    fn measure(user_data: ?*anyopaque, _: yoga.YGNodeConstRef, _: f32, _: u32, _: f32, _: u32) yoga.ExternalYogaSize {
        const self: *Callbacks = @ptrCast(@alignCast(user_data.?));
        self.measurements += 1;
        return .{ .width = self.width, .height = 1 };
    }

    fn dirty(user_data: ?*anyopaque, _: yoga.YGNodeConstRef) void {
        const self: *Callbacks = @ptrCast(@alignCast(user_data.?));
        self.dirtied += 1;
    }
};

fn layout(owner: *context.Context, node: context.Handle) !@import("../scene.zig").Layout {
    const session = (try owner.raw().getRenderable(node)).scene_node.?.owner.session;
    try @import("scene_fixture_test.zig").repaint(owner, session, .{ 0, 0, 0, 255 }, false, 0);
    return owner.sceneGetLayout(node, true);
}

test "Session scene teardown releases measure borrowers without destroying shared text" {
    const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{});
    defer owner.deinit() catch unreachable;
    const text = try owner.createTextBuffer(.unicode);
    const view = try owner.createTextBufferView(text);
    try owner.textBufferSetText(text, "owned text");

    for (0..3) |_| {
        const session = try owner.createSession(.{});
        try owner.attachSessionRenderer(session, 12, 4, .{ .remote_mode = .remote });
        const root = try owner.sceneCreateNode(session, 0, 1);
        const node = try owner.sceneCreateNode(session, 7, 2);
        try owner.sceneMoveNode(node, root, 0);
        try owner.sceneSetTextView(node, view);
        _ = try owner.scenePaint(session, .{ 0, 0, 0, 255 }, false, 0);
        const cli = try owner.raw().getSessionRenderer(session);
        try std.testing.expectEqual(@as(u32, 'o'), cli.getNextBuffer().get(0, 0).?.char);
        try std.testing.expect((try owner.raw().getTextBufferView(view)).view.measure_dependents != null);

        try owner.destroy(session);
        try std.testing.expectError(error.StaleHandle, owner.raw().getRenderable(node));
        try std.testing.expectError(error.StaleHandle, owner.raw().getRenderable(root));
        const resource = try owner.raw().getTextBufferView(view);
        try std.testing.expect(resource.node == null);
        try std.testing.expect(resource.view.measure_dependents == null);
        try std.testing.expectEqual(@as(u32, 2), owner.objects.live_count);
        try std.testing.expectEqual(@as(u32, 2), owner.node_pool_count);
    }
    try owner.destroy(text);
    try std.testing.expectError(error.StaleHandle, owner.raw().getTextBufferView(view));
    try std.testing.expectEqual(@as(u32, 0), owner.objects.live_count);
}

test "Shared text releases every provisional view during failed construction" {
    const Probe = struct {
        fn run(allocator: std.mem.Allocator) !void {
            const owner = try context.Context.init(allocator, std.testing.io, .{ .object_capacity = 8 });
            defer owner.deinit() catch unreachable;
            const text = try owner.createTextBuffer(.unicode);
            _ = try owner.createTextBufferView(text);
            _ = try owner.createTextBufferView(text);
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Probe.run, .{});
}

test "Context editors qualify ordered events and reject callback reentry" {
    const Probe = struct {
        owner: *context.Context,
        handles: [8]context.Handle = undefined,
        events: [8]context.EditEvent = undefined,
        count: usize = 0,
        rejection: ?anyerror = null,

        fn receive(data: ?*anyopaque, handle: context.Handle, event: context.EditEvent) void {
            const self: *@This() = @ptrCast(@alignCast(data.?));
            self.handles[self.count] = handle;
            self.events[self.count] = event;
            self.count += 1;
            self.owner.destroy(handle) catch |err| {
                self.rejection = err;
            };
        }
    };
    const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{});
    defer owner.deinit() catch unreachable;
    const first = try owner.createEditBuffer(.unicode);
    const second = try owner.createEditBuffer(.unicode);
    var probe: Probe = .{ .owner = owner };
    try owner.setEditEventCallback(Probe.receive, &probe);
    try owner.editSetText(first, "one", false);
    try owner.editSetText(second, "two", false);
    try owner.editInsertText(first, "three");
    try std.testing.expectEqual(error.ContextBusy, probe.rejection.?);
    try std.testing.expectEqualSlices(context.EditEvent, &.{ .cursor_changed, .content_changed, .cursor_changed, .content_changed, .cursor_changed, .content_changed }, probe.events[0..probe.count]);
    try std.testing.expectEqualSlices(context.Handle, &.{ first, first, second, second, first, first }, probe.handles[0..probe.count]);
    try owner.setEditEventCallback(null, null);
    _ = try owner.editHistory(first, false);
    try std.testing.expectEqual(@as(usize, 6), probe.count);
    try owner.destroy(second);
}

test "Context editors release partially created resources on allocation failure" {
    const Probe = struct {
        fn run(allocator: std.mem.Allocator) !void {
            const owner = try context.Context.init(allocator, std.testing.io, .{ .object_capacity = 8 });
            defer owner.deinit() catch unreachable;
            const edit = try owner.createEditBuffer(.unicode);
            _ = try owner.createEditorView(edit, 4, 2);
            _ = try owner.createEditorView(edit, 2, 1);
            const style = try owner.createSyntaxStyle();
            try owner.editSetSyntaxStyle(edit, style);
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Probe.run, .{});
}

test "Context Yoga target rejection preserves target ownership on non-leaf nodes" {
    const f = try Fixture.init(std.testing.allocator, 12, 4, .{ .output = .{} });
    defer f.deinit();
    const owner = f.owner;
    const text = try owner.createTextBuffer(.unicode);
    const first_id = try owner.createTextBufferView(text);
    const next_id = try owner.createTextBufferView(text);
    const node_id = try owner.sceneCreateNode(f.id, 7, 2);
    const child_id = try owner.sceneCreateNode(f.id, 1, 3);
    const first = try owner.raw().getTextBufferView(first_id);
    const next = try owner.raw().getTextBufferView(next_id);
    const node = try owner.raw().getRenderable(node_id);
    const child = try owner.raw().getRenderable(child_id);
    try owner.sceneSetTextView(node_id, first_id);
    try yoga.check(yoga.yogaNodeUnsetMeasureFuncChecked(node.yoga_node));
    try owner.sceneMoveNode(child_id, node_id, 0);
    try std.testing.expectError(error.YogaInvalidArgument, owner.sceneSetTextView(node_id, next_id));
    try std.testing.expectEqual(first.view, node.measure_target.text_buffer_view);
    try std.testing.expect(first.view.measure_dependents == node);
    try std.testing.expect(next.view.measure_dependents == null);
    try owner.sceneSetTextView(node_id, null);
    try std.testing.expect(first.view.measure_dependents == null);
    try std.testing.expect(node.measure_target == .none);
    try std.testing.expectEqual(node.yoga_node, yoga.yogaNodeGetParent(child.yoga_node));
}

test "Context Yoga target rejection preserves targets during raw active layout" {
    const Probe = struct {
        owner: *context.Context = undefined,
        node: context.Handle = undefined,
        next: context.Handle = undefined,
        replacement: ?anyerror = null,
        removal: ?anyerror = null,

        fn measure(data: ?*anyopaque, _: yoga.YGNodeConstRef, _: f32, _: u32, _: f32, _: u32) yoga.ExternalYogaSize {
            const self: *@This() = @ptrCast(@alignCast(data.?));
            self.owner.sceneSetTextView(self.node, self.next) catch |err| {
                self.replacement = err;
            };
            self.owner.sceneSetTextView(self.node, null) catch |err| {
                self.removal = err;
            };
            return .{ .width = 5, .height = 1 };
        }
    };
    var probe: Probe = .{};
    const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{
        .yoga_callbacks = .{ .user_data = &probe, .measure = Probe.measure },
    });
    defer owner.deinit() catch unreachable;
    const session = try owner.createSession(.{});
    try owner.attachSessionRenderer(session, 12, 4, .{ .remote_mode = .remote });
    const root = try owner.sceneCreateNode(session, 0, 1);
    const text = try owner.createTextBuffer(.unicode);
    const first_id = try owner.createTextBufferView(text);
    const next_id = try owner.createTextBufferView(text);
    const node_id = try owner.sceneCreateNode(session, 7, 2);
    const first = try owner.raw().getTextBufferView(first_id);
    const next = try owner.raw().getTextBufferView(next_id);
    const node = try owner.raw().getRenderable(node_id);
    try owner.textBufferSetText(text, "replacement");
    try owner.sceneSetTextView(node_id, first_id);
    probe.owner = owner;
    probe.node = node_id;
    probe.next = next_id;
    try yoga.check(yoga.yogaNodeSetMeasureFuncChecked(node.yoga_node, 1));
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(node.yoga_node, std.math.nan(f32), std.math.nan(f32), 1));
    try std.testing.expectEqual(@as(?anyerror, error.YogaBusy), probe.replacement);
    try std.testing.expectEqual(@as(?anyerror, error.YogaBusy), probe.removal);
    try std.testing.expectEqual(first.view, node.measure_target.text_buffer_view);
    try std.testing.expect(first.view.measure_dependents == node);
    try std.testing.expect(next.view.measure_dependents == null);
    try owner.sceneSetTextView(node_id, next_id);
    try std.testing.expect(first.view.measure_dependents == null);
    try std.testing.expect(next.view.measure_dependents == node);
    try owner.sceneMoveNode(node_id, root, 0);
    try owner.sceneSetStyle(root, 0, 4, 0, 0, 1, 0);
    try std.testing.expectEqual(@as(f32, 11), (try layout(owner, node_id)).width);
    try owner.destroy(first_id);
    try std.testing.expectEqual(next.view, node.measure_target.text_buffer_view);
    try owner.destroy(next_id);
    try std.testing.expect(node.measure_target == .none);
}

test "Context teardown rejects raw active Yoga layout without losing scene ownership" {
    const Probe = struct {
        owner: *context.Context = undefined,
        session: context.Handle = undefined,
        deinit_error: ?anyerror = null,
        destroy_error: ?anyerror = null,

        fn measure(data: ?*anyopaque, _: yoga.YGNodeConstRef, _: f32, _: u32, _: f32, _: u32) yoga.ExternalYogaSize {
            const self: *@This() = @ptrCast(@alignCast(data.?));
            self.owner.deinit() catch |err| {
                self.deinit_error = err;
            };
            self.owner.destroy(self.session) catch |err| {
                self.destroy_error = err;
            };
            return .{ .width = 5, .height = 1 };
        }
    };
    var probe: Probe = .{};
    const f = try Fixture.init(std.testing.allocator, 12, 4, .{ .limits = .{
        .yoga_callbacks = .{ .user_data = &probe, .measure = Probe.measure },
    } });
    var alive = true;
    defer if (alive) f.deinit();
    const owner = f.owner;
    const node_id = try owner.sceneCreateNode(f.id, 1, 2);
    try owner.sceneMoveNode(node_id, f.root, 0);
    const node = try owner.raw().getRenderable(node_id);
    probe.owner = owner;
    probe.session = f.id;
    try yoga.check(yoga.yogaNodeSetMeasureFuncChecked(node.yoga_node, 1));
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(node.yoga_node, std.math.nan(f32), std.math.nan(f32), 1));
    try std.testing.expectEqual(@as(?anyerror, error.ContextBusy), probe.deinit_error);
    try std.testing.expectEqual(@as(?anyerror, error.YogaBusy), probe.destroy_error);
    try std.testing.expectEqual(node, try owner.raw().getRenderable(node_id));
    try owner.destroy(f.id);
    try std.testing.expectError(error.StaleHandle, owner.raw().getRenderable(node_id));
    try owner.deinit();
    alive = false;
}

test "Context checked Yoga reports native measurement OOM and remains teardown safe" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    const owner = try context.Context.init(failing.allocator(), std.testing.io, .{});
    defer owner.deinit() catch unreachable;
    const session = try owner.createSession(.{});
    try owner.attachSessionRenderer(session, 12, 4, .{ .remote_mode = .remote });
    const root = try owner.sceneCreateNode(session, 0, 1);
    const text_id = try owner.createTextBuffer(.unicode);
    const view_id = try owner.createTextBufferView(text_id);
    const replacement_id = try owner.createTextBufferView(text_id);
    const node_id = try owner.sceneCreateNode(session, 7, 2);
    try owner.textBufferSetText(text_id, "word tail");
    const text = try owner.raw().getTextBufferView(view_id);
    text.view.setWrapMode(.word);
    try owner.sceneSetTextView(node_id, view_id);
    const node = try owner.raw().getRenderable(node_id);
    failing.fail_index = failing.alloc_index;
    try std.testing.expectError(error.OutOfMemory, yoga.check(yoga.yogaNodeCalculateLayoutChecked(node.yoga_node, 8, std.math.nan(f32), 1)));
    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectError(error.YogaPoisoned, yoga.check(yoga.yogaNodeCalculateLayoutChecked(node.yoga_node, 8, std.math.nan(f32), 1)));
    try std.testing.expectError(error.YogaPoisoned, owner.sceneSetTextView(node_id, replacement_id));
    try std.testing.expectEqual(text.view, (try owner.raw().getRenderable(node_id)).measure_target.text_buffer_view);
    try std.testing.expect((try owner.raw().getTextBufferView(replacement_id)).view.measure_dependents == null);
    failing.fail_index = std.math.maxInt(usize);
    try std.testing.expectEqual(@as(f32, 12), (try layout(owner, root)).width);
    try owner.destroy(text_id);
    try owner.destroy(node_id);
}

test "Context handles distinguish context, kind, stale generation, and limits" {
    const first = try context.Context.init(std.testing.allocator, std.testing.io, .{ .object_capacity = 1, .render_cells_max = 2 });
    defer first.deinit() catch unreachable;
    const second = try context.Context.init(std.testing.allocator, std.testing.io, .{ .object_capacity = 1 });
    defer second.deinit() catch unreachable;
    const old = try first.createSession(.{});
    const foreign = try second.createSession(.{});
    try std.testing.expectEqual(old.slot, foreign.slot);
    try std.testing.expectError(error.WrongContext, first.raw().getSession(foreign));
    try std.testing.expectError(error.WrongKind, first.raw().getTextBuffer(old));
    try std.testing.expectError(error.ObjectLimit, first.createSession(.{}));
    try first.destroy(old);
    const replacement = try first.createSession(.{});
    try std.testing.expectEqual(old.slot, replacement.slot);
    try std.testing.expect(old.generation != replacement.generation);
    try std.testing.expectError(error.StaleHandle, first.raw().getSession(old));
    try std.testing.expectError(error.StaleHandle, first.destroy(old));
    try first.destroy(replacement);
    _ = try first.createTextBuffer(.unicode);
    try std.testing.expectEqual(@as(u32, 1), first.objects.live_count);
    try std.testing.expectEqual(@as(usize, 4), @sizeOf(handles.Kind));
}

test "Context handles tombstone before cleanup and retire exhausted generations" {
    var table = try handles.Table.init(std.testing.allocator, 1);
    defer table.deinit();
    var object: u32 = 0;
    var handle = try table.insert(.session, &object);
    table.slots[handle.slot].generation = std.math.maxInt(u32);
    handle.generation = std.math.maxInt(u32);
    const token = try table.beginDestroy(handle);
    try std.testing.expectError(error.StaleHandle, table.get(handle, .session, u32));
    table.finishDestroy(token);
    try std.testing.expectError(error.ObjectLimit, table.insert(.session, &object));
    try std.testing.expectEqual(@as(u32, 0), table.live_count);
}

test "Context rejects mutation reentry from Yoga dirtied callbacks" {
    const Reentry = struct {
        owner: *context.Context = undefined,
        node: context.Handle = undefined,
        observed_accepted_text: bool = false,
        rejected: ?anyerror = null,
        owner_rejected: ?anyerror = null,

        fn dirtied(user_data: ?*anyopaque, _: yoga.YGNodeConstRef) void {
            const self: *@This() = @ptrCast(@alignCast(user_data.?));
            const text = (self.owner.raw().getRenderable(self.node) catch unreachable).scene_node.?.text.?;
            self.observed_accepted_text = std.mem.eql(u8, text.buffer.getMemBuffer(text.input_mem_id.?).?, "changed") and
                !text.buffer.rope().can_undo();
            self.owner.destroy(self.node) catch |err| {
                self.rejected = err;
            };
            self.owner.deinit() catch |err| {
                self.owner_rejected = err;
            };
        }
    };
    var reentry: Reentry = .{};
    reentry.owner = try context.Context.init(std.testing.allocator, std.testing.io, .{
        .yoga_callbacks = .{ .user_data = &reentry, .dirtied = Reentry.dirtied },
    });
    defer reentry.owner.deinit() catch unreachable;
    const session = try reentry.owner.createSession(.{});
    try reentry.owner.attachSessionRenderer(session, 12, 4, .{ .remote_mode = .remote });
    const root = try reentry.owner.sceneCreateNode(session, 0, 1);
    try reentry.owner.sceneSetStyle(root, 0, 4, 0, 0, 1, 0);
    reentry.node = try reentry.owner.sceneCreateNode(session, 2, 2);
    try reentry.owner.sceneMoveNode(reentry.node, root, 0);
    const node = try reentry.owner.raw().getRenderable(reentry.node);
    yoga.yogaNodeSetDirtiedFunc(node.yoga_node, true);
    _ = try layout(reentry.owner, reentry.node);
    try node.scene_node.?.text.?.buffer.rope().store_undo("before");
    try reentry.owner.sceneSetText(reentry.node, "changed");
    try std.testing.expect(reentry.observed_accepted_text);
    try std.testing.expectEqual(error.ContextBusy, reentry.rejected.?);
    try std.testing.expectEqual(error.ContextBusy, reentry.owner_rejected.?);
    try std.testing.expectEqual(@as(f32, 7), (try layout(reentry.owner, reentry.node)).width);
}

fn drawTrackedCells(target: *buffer.OptimizedBuffer, count: u32, base: u8) !void {
    for (0..count) |x| {
        const glyph = [_]u8{ base + @as(u8, @intCast(x)), 0xcc, 0x81 };
        var url_buffer: [64]u8 = undefined;
        const url = try std.fmt.bufPrint(&url_buffer, "https://render.invalid/{d}", .{glyph[0]});
        const link_id = try target.link_pool.acquire(url);
        try target.drawText(&glyph, @intCast(x), 0, ansi.rgbColor(255, 255, 255, 255), null, ansi.TextAttributes.setLinkId(0, link_id));
        try target.link_pool.decref(link_id);
    }
}

fn drain(owner: *context.Context, session: context.Handle, output: []u8) ![]const u8 {
    var length: usize = 0;
    while (try owner.readOutput(session, output[length..])) |ticket| {
        length += ticket.len;
        try owner.completeOutput(session, ticket, .written);
    }
    try std.testing.expect((try owner.raw().getSession(session)).isDrained());
    return output[0..length];
}

test "Context render admission rejects tracker OOM before pooled cell sync" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    var output: [4096]u8 = undefined;
    const owner = try context.Context.init(failing.allocator(), std.testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(.{ .chunk_size = 4096 });
    try owner.attachSessionRenderer(id, 12, 1, .{ .remote_mode = .remote });
    const value = try owner.raw().getSessionRenderer(id);
    value.terminal.caps.hyperlinks = true;
    const current = value.getCurrentBuffer();
    const next = value.getNextBuffer();
    value.addToHitGrid(0, 0, 1, 1, 11);
    try std.testing.expectEqual(.pending, try owner.renderSession(id, true));
    try std.testing.expect((try drain(owner, id, &output)).len > 0);
    try std.testing.expectEqual(@as(u32, 0), current.grapheme_tracker.used_ids.capacity());
    const previous_stats = value.getRenderStats();
    const previous_written = (try owner.raw().getSession(id)).getStats().bytes_written;
    const previous_chars = current.buffer.char[0..12].*;
    try drawTrackedCells(next, 1, 'k');
    const glyph_id = gp.graphemeIdFromChar(next.buffer.char[0]);
    const link_id = ansi.TextAttributes.getLinkId(next.buffer.attributes[0]);
    value.addToHitGrid(0, 0, 1, 1, 22);

    failing.fail_index = failing.alloc_index;
    failing.resize_fail_index = failing.resize_index;
    try std.testing.expectEqual(.failed, try owner.renderSession(id, false));
    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectEqual(previous_written, (try owner.raw().getSession(id)).getStats().bytes_written);
    try std.testing.expectEqual(previous_stats, value.getRenderStats());
    try std.testing.expectEqualSlices(u32, &previous_chars, current.buffer.char);
    try std.testing.expectEqual(@as(u32, 11), value.checkHit(0, 0));
    try std.testing.expectEqual(@as(u32, 1), try owner.graphemes.getRefcount(glyph_id));
    try std.testing.expectEqual(@as(u32, 1), try owner.links.getRefcount(link_id));

    failing.fail_index = std.math.maxInt(usize);
    failing.resize_fail_index = std.math.maxInt(usize);
    value.addToHitGrid(0, 0, 1, 1, 22);
    try std.testing.expectEqual(.pending, try owner.renderSession(id, false));
    const bytes = try drain(owner, id, &output);
    try std.testing.expectEqual(@as(u32, 22), value.checkHit(0, 0));
    try std.testing.expect(std.mem.find(u8, bytes, "k\xcc\x81") != null);
    try std.testing.expect(std.mem.find(u8, bytes, try owner.links.get(link_id)) != null);
}

const RenderTask = struct {
    owner: *context.Context,
    renderer_id: context.Handle,
    node_id: context.Handle,
    custom_id: context.Handle,
    text: []const u8,
    grapheme: []const u8,
    link_id: u32,
    expected_width: f32,
    gate: *std.Io.Event,
    failure: ?anyerror = null,
    thread_id: ?std.Thread.Id = null,
    output: [4096]u8 = undefined,
    output_len: usize = 0,

    fn run(self: *RenderTask) void {
        self.gate.waitUncancelable(std.testing.io);
        self.thread_id = std.Thread.getCurrentId();
        self.render() catch |err| {
            self.failure = err;
        };
    }

    fn render(self: *RenderTask) !void {
        try self.owner.sceneSetText(self.node_id, self.text);
        try std.testing.expectEqual(@as(f32, @floatFromInt(self.text.len)), (try layout(self.owner, self.node_id)).width);
        try std.testing.expectEqual(self.expected_width, (try layout(self.owner, self.custom_id)).width);
        const value = try self.owner.raw().getSessionRenderer(self.renderer_id);
        value.terminal.caps.hyperlinks = true;
        try value.getNextBuffer().drawText(self.grapheme, 0, 1, ansi.rgbColor(255, 255, 255, 255), null, ansi.TextAttributes.setLinkId(0, self.link_id));
        try std.testing.expectEqual(.pending, try @import("scene_fixture_test.zig").present(self.owner, self.renderer_id, true));
        const bytes = try drain(self.owner, self.renderer_id, &self.output);
        self.output_len = bytes.len;
        try std.testing.expect(std.mem.find(u8, bytes, self.text) != null);
        try std.testing.expect(std.mem.find(u8, bytes, self.grapheme) != null);
        try std.testing.expect(std.mem.find(u8, bytes, try self.owner.links.get(self.link_id)) != null);
    }
};

test "Context concurrently renders with independent pools, Yoga callbacks, clocks, and teardown" {
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    var first_clock: Clock = .{ .time_us = 10_000 };
    var second_clock: Clock = .{ .time_us = 90_000 };
    var first_callbacks: Callbacks = .{ .width = 3 };
    var second_callbacks: Callbacks = .{ .width = 7 };
    const first = try context.Context.init(std.testing.allocator, first_clock.io(), .{
        .yoga_callbacks = .{ .user_data = &first_callbacks, .measure = Callbacks.measure, .dirtied = Callbacks.dirty },
    });
    var first_alive = true;
    defer if (first_alive) first.deinit() catch unreachable;
    const second = try context.Context.init(std.testing.allocator, second_clock.io(), .{
        .yoga_callbacks = .{ .user_data = &second_callbacks, .measure = Callbacks.measure, .dirtied = Callbacks.dirty },
    });
    defer second.deinit() catch unreachable;
    try std.testing.expect(first.yoga_config.ref != second.yoga_config.ref);
    const first_grapheme = try first.graphemes.acquire("e\xcc\x81");
    const second_grapheme = try second.graphemes.acquire("o\xcc\x82");
    const first_link = try first.links.acquire("https://first.invalid");
    const second_link = try second.links.acquire("https://second.invalid");
    try std.testing.expectEqual(first_grapheme, second_grapheme);
    try std.testing.expectEqual(first_link, second_link);

    var gate: std.Io.Event = .unset;
    var tasks: [2]RenderTask = undefined;
    for ([_]*context.Context{ first, second }, 0..) |owner, index| {
        const id = try owner.createSession(.{ .chunk_size = 4096 });
        try owner.attachSessionRenderer(id, 20, 2, .{ .env_map = &env });
        const root = try owner.sceneCreateNode(id, 0, 1);
        try owner.sceneSetStyle(root, 0, 4, 0, 0, 1, 0);
        const node_id = try owner.sceneCreateNode(id, 2, 2);
        const custom_id = try owner.sceneCreateNode(id, 1, 3);
        try owner.sceneMoveNode(node_id, root, 0);
        try owner.sceneMoveNode(custom_id, root, 1);
        const custom = try owner.raw().getRenderable(custom_id);
        yoga.yogaNodeSetMeasureFunc(custom.yoga_node, true);
        yoga.yogaNodeSetDirtiedFunc(custom.yoga_node, true);
        tasks[index] = .{
            .owner = owner,
            .node_id = node_id,
            .renderer_id = id,
            .custom_id = custom_id,
            .text = if (index == 0) "alpha" else "bravo",
            .grapheme = if (index == 0) "e\xcc\x81" else "o\xcc\x82",
            .link_id = if (index == 0) first_link else second_link,
            .expected_width = if (index == 0) 3 else 7,
            .gate = &gate,
        };
    }
    try std.testing.expectError(error.WrongContext, first.sceneSetText(tasks[1].node_id, "foreign"));
    const first_thread = try std.Thread.spawn(.{}, RenderTask.run, .{&tasks[0]});
    const second_thread = std.Thread.spawn(.{}, RenderTask.run, .{&tasks[1]}) catch |err| {
        gate.set(std.testing.io);
        first_thread.join();
        return err;
    };
    gate.set(std.testing.io);
    first_thread.join();
    second_thread.join();
    for (tasks) |task| if (task.failure) |err| return err;
    for (tasks, 0..) |task, index| {
        try std.testing.expectError(error.WrongContext, tasks[1 - index].owner.raw().getRenderable(task.node_id));
        const bytes = task.output[0..task.output_len];
        try std.testing.expect(std.mem.find(u8, bytes, tasks[1 - index].text) == null);
        try std.testing.expect(std.mem.find(u8, bytes, tasks[1 - index].grapheme) == null);
    }
    try std.testing.expect(tasks[0].thread_id.? != tasks[1].thread_id.?);
    try std.testing.expectEqual(@as(u32, 1), first_callbacks.measurements);
    try std.testing.expectEqual(@as(u32, 1), second_callbacks.measurements);
    try std.testing.expectEqual(first_clock.time_us, (try first.raw().getSessionRenderer(tasks[0].renderer_id)).lastRenderTime);
    try std.testing.expectEqual(second_clock.time_us, (try second.raw().getSessionRenderer(tasks[1].renderer_id)).lastRenderTime);
    try std.testing.expect(first_clock.calls > 0);
    try std.testing.expectEqual(first_clock.calls, second_clock.calls);
    const first_identity = tasks[0].node_id;
    try first.deinit();
    first_alive = false;
    try std.testing.expectEqualStrings("o\xcc\x82", try second.graphemes.get(second_grapheme));
    try std.testing.expectEqualStrings("https://second.invalid", try second.links.get(second_link));
    try std.testing.expectError(error.WrongContext, second.raw().getRenderable(first_identity));
    const custom = try second.raw().getRenderable(tasks[1].custom_id);
    yoga.yogaNodeStyleSetValue(custom.yoga_node, @intFromEnum(yoga.YogaValueKind.min_width), 0, @intFromEnum(yoga.YogaUnit.point), 1);
    second_clock.time_us += 1000;
    try tasks[1].render();
    try std.testing.expect(second_callbacks.dirtied > 0);
    try std.testing.expectEqual(@as(u32, 2), second_callbacks.measurements);
    try std.testing.expectEqual(@as(u32, 1), first_callbacks.measurements);
    try std.testing.expectEqual(second_clock.time_us, (try second.raw().getSessionRenderer(tasks[1].renderer_id)).lastRenderTime);
}

fn createWithFailures(allocator: std.mem.Allocator) !void {
    const owner = try context.Context.init(allocator, std.testing.io, .{ .object_capacity = 3 });
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(.{});
    try owner.attachSessionRenderer(id, 2, 1, .{ .remote_mode = .remote });
    _ = try owner.sceneCreateNode(id, 0, 1);
}

fn createTextWithFailures(allocator: std.mem.Allocator) !void {
    const owner = try context.Context.init(allocator, std.testing.io, .{ .object_capacity = 3 });
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(.{});
    try owner.attachSessionRenderer(id, 12, 4, .{ .remote_mode = .remote });
    _ = try owner.sceneCreateNode(id, 0, 1);
    const text = try owner.sceneCreateNode(id, 2, 2);
    try owner.sceneSetText(text, "first");
    try owner.sceneSetText(text, "replacement\ntext");
}

test "Context initialization and owned resource allocation failures release all storage" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, createWithFailures, .{});
    try std.testing.checkAllAllocationFailures(std.testing.allocator, createTextWithFailures, .{});
    try std.testing.expectError(error.InvalidOptions, context.Context.init(std.testing.allocator, std.testing.io, .{ .object_capacity = 0 }));
    try std.testing.expectError(error.InvalidOptions, context.Context.init(std.testing.allocator, std.testing.io, .{ .render_cells_max = 0 }));
}
