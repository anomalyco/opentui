const std = @import("std");
const context = @import("../context.zig");
const handles = @import("../context-handles.zig");
const yoga = @import("../yoga.zig");
const renderer = @import("../renderer.zig");
const ansi = @import("../ansi.zig");
const buffer = @import("../buffer.zig");
const gp = @import("../grapheme.zig");
const utf8 = @import("../utf8.zig");
const TestRenderer = @import("test-renderer.zig").TestRenderer;
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
    const session = (try owner.getRenderable(node)).scene_node.?.owner.session;
    try owner.scenePaint(session, .{ 0, 0, 0, 255 }, false, 0);
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
        try owner.scenePaint(session, .{ 0, 0, 0, 255 }, false, 0);
        const cli = try owner.getSessionRenderer(session);
        try std.testing.expectEqual(@as(u32, 'o'), cli.getNextBuffer().get(0, 0).?.char);
        try std.testing.expect((try owner.getTextBufferView(view)).view.measure_dependents != null);

        try owner.destroy(session);
        try std.testing.expectError(error.StaleHandle, owner.getRenderable(node));
        try std.testing.expectError(error.StaleHandle, owner.getRenderable(root));
        const resource = try owner.getTextBufferView(view);
        try std.testing.expect(resource.node == null);
        try std.testing.expect(resource.view.measure_dependents == null);
        try std.testing.expectEqual(@as(u32, 2), owner.objects.live_count);
        try std.testing.expectEqual(@as(u32, 2), owner.node_pool_count);
    }
    try owner.destroy(text);
    try std.testing.expectError(error.StaleHandle, owner.getTextBufferView(view));
    try std.testing.expectEqual(@as(u32, 0), owner.objects.live_count);
}

test "Shared text preserves explicit measure providers and never transfers node ownership" {
    const Probe = struct {
        fn measure(_: u64, _: u32, _: u32, _: f32, _: u32, _: f32, _: u32, result: *yoga.ExternalYogaSize) callconv(.c) void {
            result.* = .{ .width = 3, .height = 2 };
        }
    };
    const f = try Fixture.init(std.testing.allocator, 12, 4, .{ .output = .{} });
    defer f.deinit();
    const owner = f.owner;
    const node = try owner.sceneCreateNode(f.id, 7, 2);
    const text = try owner.createTextBuffer(.unicode);
    const first = try owner.createTextBufferView(text);
    const second = try owner.createTextBufferView(text);
    try owner.sceneMoveNode(node, f.root, 0);
    try owner.sceneSetMeasure(node, null);
    try owner.sceneSetTextView(node, first);
    try owner.textBufferSetText(text, "shared text");
    try std.testing.expect(!(try owner.sceneHasMeasure(node)));
    try owner.sceneSetMeasure(node, Probe.measure);
    try owner.sceneSetTextView(node, second);
    try owner.scenePaint(f.id, .{ 0, 0, 0, 255 }, false, 0);
    try std.testing.expectEqual(@as(f32, 2), (try owner.sceneGetLayout(node, true)).height);
    try owner.destroy(second);
    try std.testing.expect(try owner.sceneHasMeasure(node));
    try std.testing.expect((try owner.getRenderable(node)).scene_node.?.control.text_view.view == null);
    try owner.sceneSetMeasure(node, null);
    try owner.sceneSetTextView(node, first);
    try owner.sceneDestroyNode(node);
    try std.testing.expect((try owner.getTextBufferView(first)).node == null);
    const replacement = try owner.sceneCreateNode(f.id, 7, 3);
    try owner.sceneSetTextView(replacement, first);
    try owner.destroy(text);
    try std.testing.expect((try owner.getRenderable(replacement)).scene_node.?.control.text_view.view == null);
    try std.testing.expect(!(try owner.sceneHasMeasure(replacement)));
}

test "Shared text pending paint retains native geometry viewport and hits" {
    const f = try Fixture.init(std.testing.allocator, 12, 4, .{ .output = .{} });
    defer f.deinit();
    const owner = f.owner;
    const node = try owner.sceneCreateNode(f.id, 7, 2);
    const text = try owner.createTextBuffer(.unicode);
    const view = try owner.createTextBufferView(text);
    try owner.sceneSetTextView(node, view);
    try owner.sceneMoveNode(node, f.root, 0);
    try owner.sceneSetStyle(node, 4, 0, 0, 1, 4, 1);
    try owner.sceneSetStyle(node, 4, 1, 0, 1, 2, 1);
    (try owner.getTextBufferView(view)).view.setWrapMode(.char);
    try owner.textBufferSetText(text, "abcdef");
    try owner.sceneSetTextViewPaint(node, false);
    try owner.scenePaint(f.id, .{ 0, 0, 0, 255 }, true, 0);
    try std.testing.expectEqual(@as(u32, ' '), f.cli.getNextBuffer().get(0, 0).?.char);
    try std.testing.expectEqual((try owner.getRenderable(node)).scene_node.?.token, f.cli.nextHitGrid[0]);
    const resource = try owner.getTextBufferView(view);
    try std.testing.expectEqual(@as(u32, 4), resource.view.getViewport().?.width);
    try std.testing.expectEqual(@as(u32, 2), resource.view.getVirtualLineCount());
    try owner.sceneSetTextViewPaint(node, true);
    try owner.scenePaint(f.id, .{ 0, 0, 0, 255 }, true, 0);
    try std.testing.expectEqual(@as(u32, 'a'), f.cli.getNextBuffer().get(0, 0).?.char);
    try std.testing.expectEqual(@as(u32, 'e'), f.cli.getNextBuffer().get(0, 1).?.char);
    const target = try owner.createBuffer(6, 3, .{});
    try owner.drawTextBufferView(target, null, view, 1, 1);
    try std.testing.expectEqual(@as(u32, 'a'), (try owner.getBuffer(target)).get(1, 1).?.char);
    try owner.drawTextBufferView(target, null, view, std.math.maxInt(i32), 0);
    try owner.drawTextBufferView(target, null, view, std.math.minInt(i32), std.math.minInt(i32));
    try std.testing.expectError(error.WrongKind, owner.drawTextBufferView(f.id, null, view, 0, 0));
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

// Every zero-width C0, DEL, and C1 control, excluding TAB and line separators.
const document_controls = blk: {
    var bytes: [94]u8 = undefined;
    var length: usize = 0;
    for (0..0xa0) |codepoint| {
        if (codepoint == '\t' or codepoint == '\r' or codepoint == '\n' or
            (codepoint >= 0x20 and codepoint < 0x7f)) continue;
        length += std.unicode.utf8Encode(@intCast(codepoint), bytes[length..]) catch unreachable;
    }
    std.debug.assert(length == bytes.len);
    break :blk bytes;
};

test "Context stored controls preserve source across text mutations" {
    const source = "A" ++ document_controls ++ "B\tC\r\nD";
    const normalized = "A" ++ document_controls ++ "B\tC\nD";
    const Mutation = enum { set, append, styled };
    for (std.meta.tags(utf8.WidthMethod)) |method| {
        const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{});
        defer owner.deinit() catch unreachable;
        const text = try owner.createTextBuffer(method);
        for (std.meta.tags(Mutation)) |mutation| {
            const stored = switch (mutation) {
                .set => blk: {
                    try owner.textBufferSetText(text, source);
                    break :blk (try owner.getTextBuffer(text)).buffer;
                },
                .append => blk: {
                    try owner.textBufferSetText(text, source[0..1]);
                    try owner.textBufferAppend(text, source[1..]);
                    break :blk (try owner.getTextBuffer(text)).buffer;
                },
                .styled => blk: {
                    try owner.textBufferSetStyledText(text, source, &.{
                        .{ .byte_count = 1, .attributes = 1 },
                        .{ .byte_count = source.len - 1, .attributes = 2 },
                    });
                    break :blk (try owner.getTextBuffer(text)).buffer;
                },
            };
            var bytes: [source.len]u8 = undefined;
            try std.testing.expectEqual(normalized.len, stored.getByteSize());
            try std.testing.expectEqualStrings(normalized, bytes[0..stored.getPlainTextIntoBuffer(&bytes)]);
        }
    }
}

test "Context stored controls do not relax UTF8 size editing or direct output validation" {
    const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{});
    defer owner.deinit() catch unreachable;
    const text = try owner.createTextBuffer(.unicode);
    const edit = try owner.createEditBuffer(.unicode);
    const kept = "A\x1bB";
    try owner.textBufferSetStyledText(text, kept, &.{.{ .byte_count = kept.len, .attributes = 1 }});
    try owner.editSetText(edit, "AB", false);
    for ([_][]const u8{ "\xff", "\xc0\xaf", "\xe2\x82", "\xed\xa0\x80" }) |invalid| {
        try std.testing.expectError(error.InvalidUnicode, owner.textBufferSetText(text, invalid));
        try std.testing.expectError(error.InvalidUnicode, owner.textBufferAppend(text, invalid));
        try std.testing.expectError(error.InvalidUnicode, owner.textBufferSetStyledText(text, invalid, &.{.{ .byte_count = @intCast(invalid.len) }}));
        try std.testing.expectError(error.InvalidUnicode, owner.editSetText(edit, invalid, false));
        try std.testing.expectError(error.InvalidUnicode, owner.editInsertText(edit, invalid));
    }
    const stored = (try owner.getTextBuffer(text)).buffer;
    var bytes: [kept.len]u8 = undefined;
    try std.testing.expectEqualStrings(kept, bytes[0..stored.getPlainTextIntoBuffer(&bytes)]);
    try std.testing.expectEqualStrings("AB", bytes[0..(try owner.getEditBuffer(edit)).buffer.getText(&bytes)]);
    const bytes_max = (std.math.maxInt(u32) - 1) / @as(u32, @max(stored.tabWidth(), 1));
    try context.Context.validateTextBytes(stored, &document_controls, bytes_max - @as(u32, document_controls.len));
    try std.testing.expectError(error.TextLimit, context.Context.validateTextBytes(stored, &document_controls, bytes_max - @as(u32, document_controls.len) + 1));
    try std.testing.expectError(error.TextLimit, context.Context.validateTextBytes(stored, "", bytes_max + 1));

    const target = try owner.createBuffer(4, 1, .{});
    var controls = (try std.unicode.Utf8View.init(&document_controls)).iterator();
    while (controls.nextCodepointSlice()) |control| {
        try std.testing.expectError(error.InvalidUnicode, owner.createUnicode(control, .unicode));
        try std.testing.expectError(error.InvalidUnicode, owner.drawBufferText(target, control, 0, 0, .{ 255, 255, 255, 255 }, null, 0));
        try std.testing.expectError(error.InvalidUnicode, owner.editSetText(edit, control, false));
        try std.testing.expectError(error.InvalidUnicode, owner.editInsertText(edit, control));
    }
    try std.testing.expectEqualStrings("AB", bytes[0..(try owner.getEditBuffer(edit)).buffer.getText(&bytes)]);
}

test "Context stored controls have printable-equivalent framebuffer and terminal output" {
    const decorated = document_controls ++ "A" ++ document_controls ++ "B CD" ++ document_controls;
    const Case = struct {
        source: []const u8,
        printable: []const u8,
        wrap: @import("../text-buffer.zig").WrapMode = .none,
        x: u32 = 0,
        width: u32 = 8,
    };
    for (std.meta.tags(utf8.WidthMethod)) |method| {
        for ([_]Case{
            .{ .source = &document_controls, .printable = "" },
            .{ .source = decorated, .printable = "AB CD" },
            .{ .source = "\x1b[2J\x07\u{9b}3m", .printable = "[2J3m" },
            .{ .source = decorated, .printable = "AB CD", .wrap = .char, .width = 2 },
            .{ .source = decorated, .printable = "AB CD", .wrap = .word, .width = 3 },
            .{ .source = decorated, .printable = "AB CD", .x = 1, .width = 2 },
        }) |case| {
            const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{});
            defer owner.deinit() catch unreachable;
            var actual = try TestRenderer.createWithLinkPool(std.testing.allocator, 8, 4, &owner.graphemes, &owner.links);
            defer actual.deinit();
            var expected = try TestRenderer.createWithLinkPool(std.testing.allocator, 8, 4, &owner.graphemes, &owner.links);
            defer expected.deinit();
            for ([_]*TestRenderer{ &actual, &expected }, [_][]const u8{ case.source, case.printable }) |fixture, source| {
                const text = try owner.createTextBuffer(method);
                const view = try owner.getTextBufferView(try owner.createTextBufferView(text));
                try owner.textBufferSetText(text, source);
                view.view.setWrapMode(case.wrap);
                view.view.setViewport(.{ .x = case.x, .y = 0, .width = case.width, .height = 4 });
                try view.prepareView();
                fixture.renderer.terminal.caps.unicode = method;
                fixture.renderer.getCurrentBuffer().width_method = method;
                const target = fixture.renderer.getNextBuffer();
                target.width_method = method;
                target.clear(ansi.rgbColor(0, 0, 0, 255), ' ');
                try target.drawTextBufferChecked(view.view, 0, 0);
                try std.testing.expectEqual(.rendered, fixture.renderer.render(true));
            }
            const actual_frame = actual.renderer.getCurrentBuffer();
            const expected_frame = expected.renderer.getCurrentBuffer();
            try std.testing.expectEqualSlices(u32, expected_frame.buffer.char, actual_frame.buffer.char);
            try std.testing.expectEqualSlices(ansi.RGBA, expected_frame.buffer.fg, actual_frame.buffer.fg);
            try std.testing.expectEqualSlices(ansi.RGBA, expected_frame.buffer.bg, actual_frame.buffer.bg);
            try std.testing.expectEqualSlices(u32, expected_frame.buffer.attributes, actual_frame.buffer.attributes);
            for (actual_frame.buffer.char) |char| try std.testing.expect(char >= 0x20 and char < 0x7f);
            // Renderer-owned ANSI remains; source ESC, BEL, and CSI must add no output bytes.
            try std.testing.expect(actual.lastOutput().len > 0);
            try std.testing.expectEqualStrings(expected.lastOutput(), actual.lastOutput());
        }
    }
}

test "Shared text append copies bytes and keeps styled content on rejection" {
    const Probe = struct {
        fn run(allocator: std.mem.Allocator) !void {
            const owner = try context.Context.init(allocator, std.testing.io, .{ .object_capacity = 8 });
            defer owner.deinit() catch unreachable;
            const text = try owner.createTextBuffer(.unicode);
            _ = try owner.createTextBufferView(text);
            try owner.textBufferSetStyledText(text, "kept", &.{.{ .byte_count = 4, .attributes = 1 }});
            const resource = try owner.getTextBuffer(text);
            const epoch = resource.buffer.getContentEpoch();
            const style = resource.owned_style;
            const slots = resource.buffer.memRegistry().getUsedSlots();
            var suffix = " append".*;
            var bytes: [16]u8 = undefined;
            owner.textBufferAppend(text, &suffix) catch |err| {
                try std.testing.expectEqualStrings("kept", bytes[0..resource.buffer.getPlainTextIntoBuffer(&bytes)]);
                try std.testing.expectEqual(epoch, resource.buffer.getContentEpoch());
                try std.testing.expectEqual(style, resource.owned_style);
                try std.testing.expectEqual(slots, resource.buffer.memRegistry().getUsedSlots());
                return err;
            };
            @memset(&suffix, 'x');
            try std.testing.expectEqualStrings("kept append", bytes[0..resource.buffer.getPlainTextIntoBuffer(&bytes)]);
            try std.testing.expectEqual(style, resource.owned_style);
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Probe.run, .{});
    const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{});
    defer owner.deinit() catch unreachable;
    const text = try owner.createTextBuffer(.unicode);
    for (0..300) |_| {
        try owner.textBufferAppend(text, "append");
        try owner.textBufferSetText(text, "");
        try std.testing.expectEqual(@as(usize, 1), (try owner.getTextBuffer(text)).buffer.memRegistry().getUsedSlots());
    }
}

test "Shared text native self epilogue follows controller work and survives hook replacement" {
    const f = try Fixture.init(std.testing.allocator, 8, 2, .{ .output = .{} });
    defer f.deinit();
    const owner = f.owner;
    const node = try owner.sceneCreateNode(f.id, 7, 2);
    const text = try owner.createTextBuffer(.unicode);
    const view = try owner.createTextBufferView(text);
    try owner.sceneSetTextView(node, view);
    try owner.sceneMoveNode(node, f.root, 0);
    try owner.sceneSetStyle(node, 4, 0, 0, 1, 8, 1);
    try owner.sceneSetStyle(node, 4, 1, 0, 1, 2, 1);
    try owner.sceneSetHooks(node, 32 | 128 | 16, 1, 8, 2);
    const options: @import("../scene.zig").FrameOptions = .{
        .background = .{ 0, 0, 0, 255 },
        .use_mouse = true,
        .excluded_hit_num = 0,
        .max_layout_rounds = 8,
        .max_host_requests = 64,
    };
    const target = f.cli.getNextBuffer();
    const self = try owner.sceneFrameStep(f.id, null, options);
    try std.testing.expectEqual(@as(u32, 7), self.kind);
    try std.testing.expectEqual(@as(u32, ' '), target.get(0, 0).?.char);
    try owner.textBufferSetText(text, "custom");
    try owner.drawTextBufferView(f.id, self, view, 0, 0);
    try std.testing.expectEqual(@as(u32, 'c'), target.get(0, 0).?.char);
    try owner.textBufferSetText(text, "updated");
    try owner.sceneSetHooks(node, 32 | 16, 2, 8, 2);
    const after = try owner.sceneFrameStep(f.id, self, options);
    try std.testing.expectEqual(@as(u32, 5), after.kind);
    try std.testing.expectEqual(@as(u32, 'u'), target.get(0, 0).?.char);
    try owner.sceneFrameCancel(f.id, after.frame_id);
    try std.testing.expectError(error.StaleFrame, owner.drawTextBufferView(f.id, self, view, 0, 0));
    try owner.sceneSetHooks(node, 32 | 128 | 16, 3, 8, 2);
    const removed = try owner.sceneFrameStep(f.id, null, options);
    try owner.destroy(text);
    const empty = try owner.sceneFrameStep(f.id, removed, options);
    try std.testing.expectEqual(@as(u32, 5), empty.kind);
    try std.testing.expectEqual(@as(u32, ' '), target.get(0, 0).?.char);
    try owner.sceneFrameCancel(f.id, empty.frame_id);
}

test "Shared text self selection requires the exact active ticket and survives later hook changes" {
    const Case = struct { registered: bool, selected: bool, paint: bool };
    for ([_]Case{
        .{ .registered = true, .selected = false, .paint = true },
        .{ .registered = false, .selected = true, .paint = true },
        .{ .registered = false, .selected = true, .paint = false },
    }) |case| {
        const f = try Fixture.init(std.testing.allocator, 8, 2, .{ .output = .{} });
        defer f.deinit();
        const owner = f.owner;
        const node = try owner.sceneCreateNode(f.id, 7, 2);
        const other = try owner.sceneCreateNode(f.id, 7, 3);
        const text = try owner.createTextBuffer(.unicode);
        const view = try owner.createTextBufferView(text);
        try owner.textBufferSetText(text, "native");
        try owner.sceneSetTextView(node, view);
        try owner.sceneMoveNode(node, f.root, 0);
        try owner.sceneSetStyle(node, 4, 0, 0, 1, 8, 1);
        try owner.sceneSetStyle(node, 4, 1, 0, 1, 2, 1);
        const hooks: u32 = 8 | 32 | 16;
        try owner.sceneSetHooks(node, hooks | @as(u32, if (case.registered) 128 else 0), 1, 8, 2);
        const options: @import("../scene.zig").FrameOptions = .{
            .background = .{ 0, 0, 0, 255 },
            .use_mouse = true,
            .excluded_hit_num = 0,
            .max_layout_rounds = 8,
            .max_host_requests = 64,
        };
        const before = try owner.sceneFrameStep(f.id, null, options);
        try std.testing.expectEqual(@as(u32, 4), before.kind);
        try std.testing.expectError(error.StaleFrame, owner.sceneSelectTextViewPaint(node, before, !case.registered));
        const self = try owner.sceneFrameStep(f.id, before, options);
        try std.testing.expectEqual(@as(u32, 7), self.kind);
        try std.testing.expectEqual(case.registered, f.state.prefix.?.text_paint_pending);
        var forged = self;
        forged.request_id += 1;
        try std.testing.expectError(error.StaleFrame, owner.sceneSelectTextViewPaint(node, forged, !case.registered));
        forged = self;
        forged.kind = 5;
        try std.testing.expectError(error.StaleFrame, owner.sceneSelectTextViewPaint(node, forged, !case.registered));
        try std.testing.expectError(error.StaleFrame, owner.sceneSelectTextViewPaint(other, self, !case.registered));
        try std.testing.expectError(error.WrongKind, owner.sceneSelectTextViewPaint(f.root, self, !case.registered));
        try std.testing.expectEqual(case.registered, f.state.prefix.?.text_paint_pending);

        try owner.sceneSetHooks(node, hooks | @as(u32, if (case.selected) 128 else 0), 2, 8, 2);
        try owner.sceneSelectTextViewPaint(node, self, case.selected);
        try std.testing.expectError(error.StaleFrame, owner.sceneSelectTextViewPaint(node, self, !case.selected));
        try owner.sceneSetHooks(node, hooks | @as(u32, if (!case.selected) 128 else 0), 3, 8, 2);
        try owner.sceneSetTextViewPaint(node, false);
        try owner.sceneSetTextViewPaint(node, case.paint);
        try std.testing.expectEqual(case.selected, f.state.prefix.?.text_paint_pending);
        const after = try owner.sceneFrameStep(f.id, self, options);
        try std.testing.expectEqual(@as(u32, 5), after.kind);
        const target = f.cli.getNextBuffer();
        try std.testing.expectEqual(@as(u32, if (case.selected and case.paint) 'n' else ' '), target.get(0, 0).?.char);
        try std.testing.expectError(error.StaleFrame, owner.sceneSelectTextViewPaint(node, self, !case.selected));
        try std.testing.expectError(error.StaleFrame, owner.sceneSelectTextViewPaint(node, after, !case.selected));
        try owner.sceneFrameCancel(f.id, after.frame_id);
        try std.testing.expectError(error.StaleFrame, owner.sceneSelectTextViewPaint(node, self, !case.selected));
        const next_before = try owner.sceneFrameStep(f.id, null, options);
        const next_self = try owner.sceneFrameStep(f.id, next_before, options);
        try owner.sceneSelectTextViewPaint(node, next_self, !case.selected);
        try owner.sceneFrameCancel(f.id, next_self.frame_id);
    }
}

test "Shared text rejects styled replacement without publishing explicit style changes" {
    const Probe = struct {
        fn run(allocator: std.mem.Allocator) !void {
            const owner = try context.Context.init(allocator, std.testing.io, .{ .object_capacity = 8 });
            defer owner.deinit() catch unreachable;
            const style_handle = try owner.createSyntaxStyle();
            const style = try owner.getSyntaxStyle(style_handle);
            const red = ansi.rgbColor(255, 0, 0, 255);
            const chunk = try style.registerStyle("chunk0", red, null, 0);
            const text = try owner.createTextBuffer(.unicode);
            const alias = try owner.createTextBuffer(.unicode);
            try owner.textBufferSetSyntaxStyle(text, style_handle);
            try owner.textBufferSetSyntaxStyle(alias, style_handle);
            try owner.textBufferSetText(text, "accepted");
            const resource = try owner.getTextBuffer(text);
            const epoch = resource.buffer.getContentEpoch();
            owner.textBufferSetStyledText(text, "new!", &.{ .{ .byte_count = 3, .attributes = 1 }, .{ .byte_count = 1, .attributes = 2, .link_url = "https://example.com/prepared" } }) catch |err| {
                var bytes: [16]u8 = undefined;
                try std.testing.expectEqualStrings("accepted", bytes[0..resource.buffer.getPlainTextIntoBuffer(&bytes)]);
                try std.testing.expectEqual(epoch, resource.buffer.getContentEpoch());
                try std.testing.expectEqual(style, resource.buffer.getSyntaxStyle().?);
                try std.testing.expectEqual(style, (try owner.getTextBuffer(alias)).buffer.getSyntaxStyle().?);
                try std.testing.expectEqual(red, style.resolveById(chunk).?.fg.?);
                try std.testing.expectEqual(@as(u32, 2), style.next_id);
                try std.testing.expectEqual(@as(usize, 1), style.getStyleCount());
                try std.testing.expectEqual(@as(u64, 0), owner.links.getLiveSlotCount());
                return err;
            };
            try std.testing.expectEqual(style, resource.buffer.getSyntaxStyle().?);
            try std.testing.expectEqual(@as(usize, 2), style.getStyleCount());
            try std.testing.expectEqual(@as(u32, 1), style.resolveById(chunk).?.attributes);
            try owner.destroy(style_handle);
            try std.testing.expect(resource.buffer.getSyntaxStyle() == null);
            try std.testing.expect((try owner.getTextBuffer(alias)).buffer.getSyntaxStyle() == null);
        }
    };
    try std.testing.checkAllAllocationFailures(std.testing.allocator, Probe.run, .{});
}

test "Shared text explicit styles retain linked definitions for surviving aliases" {
    const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{});
    defer owner.deinit() catch unreachable;
    const style_handle = try owner.createSyntaxStyle();
    const style = try owner.getSyntaxStyle(style_handle);
    const text = try owner.createTextBuffer(.unicode);
    const alias = try owner.createTextBuffer(.unicode);
    const view = try owner.createTextBufferView(alias);
    try owner.textBufferSetSyntaxStyle(text, style_handle);
    try owner.textBufferSetSyntaxStyle(alias, style_handle);
    try owner.textBufferSetStyledText(text, "link", &.{.{ .byte_count = 4, .link_url = "https://example.com/retained" }});
    const chunk = style.resolveByName("chunk0").?;
    const id = ansi.TextAttributes.getLinkId(style.resolveById(chunk).?.attributes);
    try owner.textBufferSetText(alias, "alias");
    try (try owner.getTextBuffer(alias)).buffer.addHighlight(0, 0, 5, chunk, 1, 0);
    try owner.destroy(text);
    try std.testing.expectEqualStrings("https://example.com/retained", try owner.links.get(id));
    const target = try owner.createBuffer(5, 1, .{});
    try owner.drawTextBufferView(target, null, view, 0, 0);
    try std.testing.expectEqual(id, ansi.TextAttributes.getLinkId((try owner.getBuffer(target)).get(0, 0).?.attributes));
    try owner.textBufferSetStyledText(alias, "clear", &.{.{ .byte_count = 5 }});
    try std.testing.expectEqual(@as(u32, 0), ansi.TextAttributes.getLinkId(style.resolveById(chunk).?.attributes));
    try owner.clearBuffer(target, ansi.rgbColor(0, 0, 0, 0));
    try std.testing.expectEqual(@as(u64, 0), owner.links.getLiveSlotCount());
}

test "Context checked history treats empty undo and redo as no changes" {
    const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{});
    defer owner.deinit() catch unreachable;
    const edit = try owner.createEditBuffer(.unicode);
    const resource = (try owner.getEditBuffer(edit)).buffer;
    const epoch = resource.tb.getContentEpoch();
    for ([_]bool{ true, false }) |redo| {
        try std.testing.expectEqualStrings("", try owner.editHistory(edit, redo));
        try std.testing.expectEqual(epoch, resource.tb.getContentEpoch());
    }
}

test "Context checked style replacement invalidates shared text and editor dependents" {
    const owner = try context.Context.init(std.testing.allocator, std.testing.io, .{});
    defer owner.deinit() catch unreachable;
    const style = try owner.createSyntaxStyle();
    const text = try owner.createTextBuffer(.unicode);
    const alias = try owner.createTextBuffer(.unicode);
    const edit = try owner.createEditBuffer(.unicode);
    const text_view = try owner.createTextBufferView(alias);
    const edit_view = try owner.createEditorView(edit, 4, 2);
    try owner.textBufferSetSyntaxStyle(text, style);
    try owner.textBufferSetSyntaxStyle(alias, style);
    try owner.editSetSyntaxStyle(edit, style);
    const session = try owner.createSession(.{});
    try owner.attachSessionRenderer(session, 12, 4, .{ .remote_mode = .remote });
    const root = try owner.sceneCreateNode(session, 0, 1);
    const text_node = try owner.sceneCreateNode(session, 7, 2);
    const edit_node = try owner.sceneCreateNode(session, 5, 3);
    try owner.sceneSetTextView(text_node, text_view);
    try owner.sceneSetEditorView(edit_node, edit_view);
    try owner.sceneMoveNode(text_node, root, 0);
    try owner.sceneMoveNode(edit_node, root, 1);
    _ = try layout(owner, text_node);
    try owner.textBufferSetStyledText(text, "new", &.{.{ .byte_count = 3, .attributes = 1 }});
    for ([_]context.Handle{ text_node, edit_node }) |handle| {
        var dirty: u32 = 0;
        try yoga.check(yoga.yogaNodeIsDirtyChecked((try owner.getRenderable(handle)).yoga_node, &dirty));
        try std.testing.expectEqual(@as(u32, 1), dirty);
    }
    _ = try layout(owner, text_node);
    const resource = try owner.getSyntaxStyle(style);
    const chunk_id = resource.resolveByName("chunk0").?;
    try std.testing.expectEqual(@as(u32, 1), (try resource.mergeStyles(&.{chunk_id})).attributes);
    try std.testing.expectEqual(chunk_id, try owner.syntaxStyleRegister(style, "chunk0", .{ .fg = null, .bg = null, .attributes = 2 }));
    try std.testing.expectEqual(@as(u32, 2), (try resource.mergeStyles(&.{chunk_id})).attributes);
    for ([_]context.Handle{ text_node, edit_node }) |handle| {
        var dirty: u32 = 0;
        try yoga.check(yoga.yogaNodeIsDirtyChecked((try owner.getRenderable(handle)).yoga_node, &dirty));
        try std.testing.expectEqual(@as(u32, 1), dirty);
    }
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

test "Context editors preserve custom and empty measure slots through binding and edits" {
    const Probe = struct {
        fn measure(_: u64, _: u32, _: u32, _: f32, _: u32, _: f32, _: u32, result: *yoga.ExternalYogaSize) callconv(.c) void {
            result.* = .{ .width = 3, .height = 2 };
        }
    };
    const f = try Fixture.init(std.testing.allocator, 12, 4, .{ .output = .{} });
    defer f.deinit();
    const owner = f.owner;
    const node = try owner.sceneCreateNode(f.id, 5, 2);
    const edit = try owner.createEditBuffer(.unicode);
    const view = try owner.createEditorView(edit, 8, 2);
    const other = try owner.createEditorView(edit, 8, 2);
    try owner.sceneMoveNode(node, f.root, 0);
    try owner.sceneSetMeasure(node, null);
    try owner.sceneSetEditorView(node, view);
    try owner.editSetText(edit, "native editor", false);
    try std.testing.expect(!(try owner.sceneHasMeasure(node)));
    try owner.sceneSetMeasure(node, Probe.measure);
    try owner.sceneSetEditorView(node, other);
    try std.testing.expect(try owner.sceneHasMeasure(node));
    try std.testing.expectEqual(@as(u32, 1), owner.scene_measures.count());
    try owner.scenePaint(f.id, .{ 0, 0, 0, 255 }, false, 0);
    try std.testing.expectEqual(@as(f32, 2), (try owner.sceneGetLayout(node, true)).height);
    try owner.destroy(other);
    try std.testing.expect(try owner.sceneHasMeasure(node));
    try std.testing.expect((try owner.getRenderable(node)).scene_node.?.editor == null);
    try owner.sceneSetMeasure(node, null);
    try owner.sceneSetEditorView(node, view);
    try owner.editInsertText(edit, "!");
    try std.testing.expect(!(try owner.sceneHasMeasure(node)));
    try owner.destroy(edit);
    try std.testing.expect(!(try owner.sceneHasMeasure(node)));
}

test "Context scene measurement rejection preserves the native provider on allocation failure" {
    const Probe = struct {
        fn measure(_: u64, _: u32, _: u32, _: f32, _: u32, _: f32, _: u32, _: *yoga.ExternalYogaSize) callconv(.c) void {}
    };
    for (0..2) |offset| {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        const owner = try context.Context.init(failing.allocator(), std.testing.io, .{});
        defer owner.deinit() catch unreachable;
        const session = try owner.createSession(.{});
        try owner.attachSessionRenderer(session, 8, 2, .{ .remote_mode = .remote });
        _ = try owner.sceneCreateNode(session, 0, 1);
        const text = try owner.sceneCreateNode(session, 2, 2);
        const node = try owner.getRenderable(text);
        const view = node.measure_target.text_buffer_view;
        failing.fail_index = failing.alloc_index + offset;
        try std.testing.expectError(error.OutOfMemory, owner.sceneSetMeasure(text, &Probe.measure));
        failing.fail_index = std.math.maxInt(usize);
        try std.testing.expectEqual(@as(u32, 0), owner.scene_measures.count());
        try std.testing.expect(try owner.sceneHasMeasure(text));
        try std.testing.expectEqual(view, node.measure_target.text_buffer_view);
        try std.testing.expectEqual(node, view.measure_dependents);
        try owner.sceneSetMeasure(text, &Probe.measure);
        try owner.sceneSetMeasure(text, null);
        try std.testing.expect(!(try owner.sceneHasMeasure(text)));
    }
}

test "Context scene measurement text queries preserve viewport and measurement cache" {
    const Probe = struct {
        var owner: *context.Context = undefined;
        var node: context.Handle = undefined;
        var calls: u32 = 0;
        var failure: ?anyerror = null;

        fn measure(_: u64, _: u32, _: u32, _: f32, _: u32, _: f32, _: u32, result: *yoga.ExternalYogaSize) callconv(.c) void {
            calls += 1;
            check() catch |err| {
                failure = err;
            };
            result.* = .{ .width = 4, .height = 2 };
        }

        fn check() !void {
            const text = (try owner.getRenderable(node)).scene_node.?.text.?;
            const viewport = text.view.getViewport();
            const wrap_width = text.view.wrap_width;
            const measured = try text.view.measureForDimensions(3, 2);
            const cache = text.view.cached_measure_entries;
            const count = text.view.cached_measure_count;
            var bytes: [64]u8 = undefined;
            var lines: [32]@import("../scene.zig").TextLine = undefined;
            _ = try owner.sceneGetText(node, &bytes);
            _ = try owner.sceneGetTextInfo(node);
            _ = try owner.sceneGetTextLines(node, &lines);
            _ = try owner.sceneGetLayout(node, true);
            try std.testing.expectEqualDeep(viewport, text.view.getViewport());
            try std.testing.expectEqual(wrap_width, text.view.wrap_width);
            try std.testing.expectEqual(count, text.view.cached_measure_count);
            try std.testing.expectEqualDeep(cache[0..count], text.view.cached_measure_entries[0..count]);
            try std.testing.expectEqualDeep(measured, try text.view.measureForDimensions(3, 2));
            try std.testing.expectError(error.ContextBusy, owner.sceneSetText(node, "rejected"));
            try std.testing.expectError(error.ContextBusy, owner.sceneDestroyNode(node));
            try std.testing.expectError(error.ContextBusy, owner.sceneMarkDirty(node));
            try std.testing.expectError(error.ContextBusy, owner.sceneGetStats((try owner.getRenderable(node)).scene_node.?.owner.session));
        }
    };
    const f = try Fixture.init(std.testing.allocator, 8, 4, .{ .output = .{} });
    defer f.deinit();
    const owner = f.owner;
    const text = try owner.sceneCreateNode(f.id, 2, 2);
    try owner.sceneSetText(text, "one two three four");
    const view = (try owner.getRenderable(text)).scene_node.?.text.?.view;
    view.setViewport(.{ .x = 1, .y = 1, .width = 4, .height = 2 });
    view.setTruncate(true);
    try owner.sceneMoveNode(text, f.root, 0);
    Probe.owner = owner;
    Probe.node = text;
    Probe.calls = 0;
    Probe.failure = null;
    try owner.sceneSetMeasure(text, &Probe.measure);
    try owner.scenePaint(f.id, .{ 0, 0, 0, 255 }, false, 0);
    if (Probe.failure) |err| return err;
    try std.testing.expect(Probe.calls > 0);
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
    const first = try owner.getTextBufferView(first_id);
    const next = try owner.getTextBufferView(next_id);
    const node = try owner.getRenderable(node_id);
    const child = try owner.getRenderable(child_id);
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
    const first = try owner.getTextBufferView(first_id);
    const next = try owner.getTextBufferView(next_id);
    const node = try owner.getRenderable(node_id);
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
    const node = try owner.getRenderable(node_id);
    probe.owner = owner;
    probe.session = f.id;
    try yoga.check(yoga.yogaNodeSetMeasureFuncChecked(node.yoga_node, 1));
    try yoga.check(yoga.yogaNodeCalculateLayoutChecked(node.yoga_node, std.math.nan(f32), std.math.nan(f32), 1));
    try std.testing.expectEqual(@as(?anyerror, error.ContextBusy), probe.deinit_error);
    try std.testing.expectEqual(@as(?anyerror, error.YogaBusy), probe.destroy_error);
    try std.testing.expectEqual(node, try owner.getRenderable(node_id));
    try owner.destroy(f.id);
    try std.testing.expectError(error.StaleHandle, owner.getRenderable(node_id));
    try owner.deinit();
    alive = false;
}

test "Context Yoga target cleanup survives override unset and node reset" {
    for ([_]bool{ false, true }) |reset| {
        const f = try Fixture.init(std.testing.allocator, 12, 4, .{ .output = .{} });
        defer f.deinit();
        const owner = f.owner;
        try owner.sceneSetStyle(f.root, 0, 4, 0, 0, 1, 0);
        const text_id = try owner.createTextBuffer(.unicode);
        const view_id = try owner.createTextBufferView(text_id);
        const node_id = try owner.sceneCreateNode(f.id, 7, 2);
        const text = try owner.getTextBufferView(view_id);
        const node = try owner.getRenderable(node_id);
        try owner.textBufferSetText(text_id, "cached");
        try owner.sceneSetTextView(node_id, view_id);
        try owner.sceneMoveNode(node_id, f.root, 0);
        try std.testing.expectEqual(@as(f32, 6), (try layout(owner, node_id)).width);
        try owner.sceneMoveNode(node_id, null, 0);
        try yoga.check(yoga.yogaNodeSetMeasureFuncChecked(node.yoga_node, 1));
        try yoga.check(if (reset) yoga.yogaNodeResetChecked(node.yoga_node) else yoga.yogaNodeUnsetMeasureFuncChecked(node.yoga_node));
        try std.testing.expect(text.view.measure_dependents == node);
        try owner.destroy(text_id);
        try std.testing.expect(node.measure_target == .none);
        try std.testing.expect(node.measure_dependents == null);
        try owner.sceneMoveNode(node_id, f.root, 0);
        try std.testing.expectEqual(@as(f32, 0), (try layout(owner, node_id)).width);
    }
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
    const text = try owner.getTextBufferView(view_id);
    text.view.setWrapMode(.word);
    try owner.sceneSetTextView(node_id, view_id);
    const node = try owner.getRenderable(node_id);
    failing.fail_index = failing.alloc_index;
    try std.testing.expectError(error.OutOfMemory, yoga.check(yoga.yogaNodeCalculateLayoutChecked(node.yoga_node, 8, std.math.nan(f32), 1)));
    try std.testing.expect(failing.has_induced_failure);
    try std.testing.expectError(error.YogaPoisoned, yoga.check(yoga.yogaNodeCalculateLayoutChecked(node.yoga_node, 8, std.math.nan(f32), 1)));
    try std.testing.expectError(error.YogaPoisoned, owner.sceneSetTextView(node_id, replacement_id));
    try std.testing.expectEqual(text.view, (try owner.getRenderable(node_id)).measure_target.text_buffer_view);
    try std.testing.expect((try owner.getTextBufferView(replacement_id)).view.measure_dependents == null);
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
    try std.testing.expectError(error.WrongContext, first.getSession(foreign));
    try std.testing.expectError(error.WrongKind, first.getTextBuffer(old));
    try std.testing.expectError(error.ObjectLimit, first.createSession(.{}));
    try first.destroy(old);
    const replacement = try first.createSession(.{});
    try std.testing.expectEqual(old.slot, replacement.slot);
    try std.testing.expect(old.generation != replacement.generation);
    try std.testing.expectError(error.StaleHandle, first.getSession(old));
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

test "Context native measure targets remain stable and unlink only their dependents" {
    const f = try Fixture.init(std.testing.allocator, 12, 4, .{ .limits = .{ .object_capacity = 10_009 }, .output = .{} });
    defer f.deinit();
    const owner = f.owner;
    try owner.sceneSetStyle(f.root, 0, 4, 0, 0, 1, 0);
    const first_text_id = try owner.createTextBuffer(.unicode);
    const second_text_id = try owner.createTextBuffer(.unicode);
    const first_view = try owner.createTextBufferView(first_text_id);
    const alias = try owner.createTextBufferView(first_text_id);
    const second_view = try owner.createTextBufferView(second_text_id);
    const first_text = try owner.getTextBufferView(alias);
    const second_text = try owner.getTextBufferView(second_view);
    try owner.textBufferSetText(first_text_id, "first");
    try owner.textBufferSetText(second_text_id, "second text");
    const first_id = try owner.sceneCreateNode(f.id, 7, 2);
    const second_id = try owner.sceneCreateNode(f.id, 7, 3);
    const first = try owner.getRenderable(first_id);
    const second = try owner.getRenderable(second_id);
    try owner.sceneSetTextView(first_id, first_view);
    try owner.sceneSetTextView(second_id, alias);
    try owner.sceneMoveNode(first_id, f.root, 0);
    try owner.sceneMoveNode(second_id, f.root, 1);
    try std.testing.expectEqual(@as(f32, 5), (try layout(owner, first_id)).width);

    for (0..10_000) |index| _ = try owner.sceneCreateNode(f.id, 1, @intCast(index + 4));
    try std.testing.expect(first == try owner.getRenderable(first_id));
    try std.testing.expectEqual(@as(f32, 5), (try layout(owner, first_id)).width);
    try owner.sceneSetTextView(first_id, second_view);
    try std.testing.expect(first_text.view.measure_dependents == second);
    try owner.destroy(first_text_id);
    try std.testing.expect(second.measure_target == .none);
    try std.testing.expect(first.measure_target == .text_buffer_view);
    try std.testing.expectEqual(@as(f32, 11), (try layout(owner, first_id)).width);
    try owner.textBufferSetText(second_text_id, "updated");
    try std.testing.expectEqual(@as(f32, 7), (try layout(owner, first_id)).width);
    try owner.destroy(first_id);
    try std.testing.expect(second_text.view.measure_dependents == null);
}

test "Context text replacement preserves state on allocation failure" {
    for (0..128) |fail_offset| {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        var callbacks: Callbacks = .{ .width = 0 };
        const owner = try context.Context.init(failing.allocator(), std.testing.io, .{
            .yoga_callbacks = .{ .user_data = &callbacks, .dirtied = Callbacks.dirty },
        });
        defer owner.deinit() catch unreachable;
        const session = try owner.createSession(.{});
        try owner.attachSessionRenderer(session, 12, 4, .{ .remote_mode = .remote });
        const root = try owner.sceneCreateNode(session, 0, 1);
        try owner.sceneSetStyle(root, 0, 4, 0, 0, 1, 0);
        const node_id = try owner.sceneCreateNode(session, 2, 2);
        const node = try owner.getRenderable(node_id);
        const text = node.scene_node.?.text.?;
        try owner.sceneMoveNode(node_id, root, 0);
        yoga.yogaNodeSetDirtiedFunc(node.yoga_node, true);
        try owner.sceneSetText(node_id, "old");
        const old_layout = try layout(owner, node_id);
        try text.buffer.rope().store_undo("before");
        text.buffer.clearViewDirty(text.view.view_id);
        const old_epoch = text.buffer.getContentEpoch();
        const old_dirtied = callbacks.dirtied;
        const old_rope = text.buffer.rope().*;
        const old_capacity = text.buffer.arena.queryCapacity();
        const old_bytes = text.buffer.getMemBuffer(text.input_mem_id.?).?;
        // Owned replacement builds fresh rope pools, not the live rope's allocator.
        failing.fail_index = failing.alloc_index + fail_offset;
        failing.resize_fail_index = failing.resize_index;
        const input = "replacement\r\n\t\u{4e16}\u{754c}\n" ** 8;
        const result = owner.sceneSetText(node_id, input);
        failing.fail_index = std.math.maxInt(usize);
        failing.resize_fail_index = std.math.maxInt(usize);
        var actual: [256]u8 = undefined;
        if (result) |_| {
            try std.testing.expect(fail_offset > 0);
        } else |err| {
            try std.testing.expectEqual(error.OutOfMemory, err);
            try std.testing.expect(failing.has_induced_failure);
            try std.testing.expectEqual(old_rope.root, text.buffer.rope().root);
            try std.testing.expectEqual(old_rope.undo_history, text.buffer.rope().undo_history);
            try std.testing.expectEqual(old_capacity, text.buffer.arena.queryCapacity());
            try std.testing.expectEqual(old_bytes.ptr, text.buffer.getMemBuffer(text.input_mem_id.?).?.ptr);
            try std.testing.expectEqualStrings("old", actual[0..text.buffer.getPlainTextIntoBuffer(&actual)]);
            try std.testing.expectEqual(old_epoch, text.buffer.getContentEpoch());
            try std.testing.expect(!text.buffer.isViewDirty(text.view.view_id));
            try std.testing.expectEqual(old_dirtied, callbacks.dirtied);
            var dirty: u32 = 1;
            try yoga.check(yoga.yogaNodeIsDirtyChecked(node.yoga_node, &dirty));
            try std.testing.expectEqual(@as(u32, 0), dirty);
            try std.testing.expectEqualDeep(old_layout, try layout(owner, node_id));
            try owner.sceneSetText(node_id, input);
        }
        try std.testing.expectEqualStrings("replacement\n\t\u{4e16}\u{754c}\n" ** 8, actual[0..text.buffer.getPlainTextIntoBuffer(&actual)]);
        try std.testing.expectEqual(old_epoch + 1, text.buffer.getContentEpoch());
        try std.testing.expectEqual(old_dirtied + 1, callbacks.dirtied);
        try std.testing.expect(text.buffer.isViewDirty(text.view.view_id));
        try std.testing.expect(!text.buffer.rope().can_undo());
        try owner.sceneSetText(node_id, "latest");
        try std.testing.expectEqual(@as(f32, 6), (try layout(owner, node_id)).width);
        if (result) |_| return else |_| {}
    }
    return error.TestUnexpectedResult;
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
            const text = (self.owner.getRenderable(self.node) catch unreachable).scene_node.?.text.?;
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
    const node = try reentry.owner.getRenderable(reentry.node);
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
        const link_id = try target.link_pool.alloc(url);
        try target.drawText(&glyph, @intCast(x), 0, ansi.rgbColor(255, 255, 255, 255), null, ansi.TextAttributes.setLinkId(0, link_id));
    }
}

fn drain(owner: *context.Context, session: context.Handle, output: []u8) ![]const u8 {
    var length: usize = 0;
    while (try owner.readOutput(session, output[length..])) |ticket| {
        length += ticket.len;
        try owner.completeOutput(session, ticket, .written);
    }
    try std.testing.expect((try owner.getSession(session)).isDrained());
    return output[0..length];
}

test "Context render admission rejects tracker OOM before pooled cell sync" {
    for ([_]u32{ 0, 5 }) |previous_count| {
        for (0..2) |fail_offset| {
            var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
            var output: [4096]u8 = undefined;
            const owner = try context.Context.init(failing.allocator(), std.testing.io, .{});
            defer owner.deinit() catch unreachable;
            const id = try owner.createSession(.{ .chunk_size = 4096 });
            try owner.attachSessionRenderer(id, 12, 1, .{ .remote_mode = .remote });
            const value = try owner.getSessionRenderer(id);
            value.terminal.caps.hyperlinks = true;
            const current = value.getCurrentBuffer();
            const next = value.getNextBuffer();
            try drawTrackedCells(next, previous_count, 'a');
            value.addToHitGrid(0, 0, 1, 1, 11);
            try std.testing.expectEqual(.pending, try owner.renderSession(id, true));
            try std.testing.expect((try drain(owner, id, &output)).len > 0);
            if (previous_count == 0) {
                try std.testing.expectEqual(@as(u32, 0), current.grapheme_tracker.used_ids.capacity());
                try std.testing.expectEqual(@as(u32, 0), current.link_tracker.used_ids.capacity());
            }
            const previous_stats = value.getRenderStats();
            const previous_written = (try owner.getSession(id)).getStats().bytes_written;
            const previous_chars = current.buffer.char[0..12].*;
            try drawTrackedCells(next, if (previous_count == 0) 1 else 7, 'k');
            const glyph_id = gp.graphemeIdFromChar(next.buffer.char[0]);
            const link_id = ansi.TextAttributes.getLinkId(next.buffer.attributes[0]);
            value.addToHitGrid(0, 0, 1, 1, 22);

            failing.fail_index = failing.alloc_index + fail_offset;
            try std.testing.expectEqual(.failed, try owner.renderSession(id, false));
            try std.testing.expect(failing.has_induced_failure);
            try std.testing.expectEqual(previous_written, (try owner.getSession(id)).getStats().bytes_written);
            try std.testing.expectEqual(previous_stats, value.getRenderStats());
            try std.testing.expectEqualSlices(u32, &previous_chars, current.buffer.char);
            try std.testing.expectEqual(@as(u32, 11), value.checkHit(0, 0));
            try std.testing.expect(value.force_full_repaint);
            try std.testing.expectEqual(@as(u32, 1), try owner.graphemes.getRefcount(glyph_id));
            try std.testing.expectEqual(@as(u32, 1), try owner.links.getRefcount(link_id));

            failing.fail_index = std.math.maxInt(usize);
            value.addToHitGrid(0, 0, 1, 1, 22);
            try std.testing.expectEqual(.pending, try owner.renderSession(id, false));
            const bytes = try drain(owner, id, &output);
            try std.testing.expectEqual(@as(u32, 22), value.checkHit(0, 0));
            try std.testing.expectEqual(@as(u32, 12), value.getRenderStats().cellsUpdated);
            try std.testing.expect(std.mem.find(u8, bytes, "k\xcc\x81") != null);
            try std.testing.expect(std.mem.find(u8, bytes, try owner.links.get(link_id)) != null);
            try std.testing.expectEqual(@as(u32, 1), try owner.graphemes.getRefcount(glyph_id));
            try std.testing.expectEqual(@as(u32, 1), try owner.links.getRefcount(link_id));
            failing.fail_index = failing.alloc_index;
            try owner.destroy(id);
        }
    }
}

test "Context render admission reuses leased tracker capacity for disjoint frames" {
    var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
    var output: [4096]u8 = undefined;
    const owner = try context.Context.init(failing.allocator(), std.testing.io, .{});
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(.{ .chunk_size = 4096 });
    try owner.attachSessionRenderer(id, 5, 1, .{ .remote_mode = .remote });
    const value = try owner.getSessionRenderer(id);
    const lease = try owner.acquireSessionBufferLease(id, .current);
    defer owner.releaseBufferLease(lease) catch unreachable;
    const bytes = owner.lease_bytes;
    owner.lease_bytes_max = bytes;
    try drawTrackedCells(value.getNextBuffer(), 5, 'a');
    try std.testing.expectEqual(.pending, try owner.renderSession(id, true));
    _ = try drain(owner, id, &output);
    try drawTrackedCells(value.getNextBuffer(), 5, 'k');
    failing.fail_index = failing.alloc_index;
    try std.testing.expectEqual(.pending, try owner.renderSession(id, false));
    _ = try drain(owner, id, &output);
    try std.testing.expect(!failing.has_induced_failure);
    try std.testing.expectEqual(bytes, owner.lease_bytes);
    try std.testing.expectEqual(@as(u32, 5), value.getCurrentBuffer().grapheme_tracker.used_ids.count());
    try std.testing.expectEqual(@as(u32, 5), value.getCurrentBuffer().link_tracker.used_ids.count());
    try owner.destroy(id);
}

test "CliRenderer memory output reports append OOM and repaints on retry" {
    for ([_]bool{ false, true }) |previous_frame| {
        var failing = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        const owner = try context.Context.init(failing.allocator(), std.testing.io, .{});
        defer owner.deinit() catch unreachable;
        const value = try renderer.CliRenderer.createWithOptions(failing.allocator(), 2, 1, &owner.graphemes, .{
            .output = .memory,
            .link_pool = &owner.links,
        });
        defer value.destroy();
        const backend = &value.backend.buffered;
        const memory = backend.ownedMemoryOutput.?;
        const fg = ansi.rgbColor(255, 255, 255, 255);
        if (previous_frame) {
            try value.getNextBuffer().drawText("AB", 0, 0, fg, null, 0);
            value.addToHitGrid(0, 0, 1, 1, 11);
            try std.testing.expectEqual(.rendered, value.render(true));
            memory.bytes.shrinkAndFree(memory.allocator, memory.bytes.items.len);
        }
        const previous_bytes = try std.testing.allocator.dupe(u8, memory.bytes.items);
        defer std.testing.allocator.free(previous_bytes);
        const previous_stats = value.getRenderStats();
        const previous_samples = value.statSamples.cellsUpdated.items.len;
        try value.getNextBuffer().drawText("CD", 0, 0, fg, null, 0);
        value.addToHitGrid(0, 0, 1, 1, 22);
        failing.fail_index = failing.alloc_index;
        failing.resize_fail_index = failing.resize_index;

        try std.testing.expectEqual(.failed, value.render(true));
        try std.testing.expect(failing.has_induced_failure);
        try std.testing.expect(backend.outputLenA > 0 and backend.outputLenA < renderer.OUTPUT_BUFFER_SIZE);
        try std.testing.expectEqual(renderer.OUTPUT_BUFFER_SIZE, backend.outputA.len);
        try std.testing.expectEqualStrings(previous_bytes, memory.bytes.items);
        try std.testing.expectEqual(previous_stats, value.getRenderStats());
        try std.testing.expectEqual(previous_samples, value.statSamples.cellsUpdated.items.len);
        try std.testing.expectEqual(previous_frame, backend.hasCommittedFrame);
        try std.testing.expectEqual(@as(u32, if (previous_frame) 11 else 0), value.checkHit(0, 0));
        try std.testing.expect(value.force_full_repaint);

        failing.fail_index = std.math.maxInt(usize);
        failing.resize_fail_index = std.math.maxInt(usize);
        try value.getNextBuffer().drawText("CD", 0, 0, fg, null, 0);
        value.addToHitGrid(0, 0, 1, 1, 22);
        try std.testing.expectEqual(.rendered, value.render(false));
        try std.testing.expect(std.mem.find(u8, memory.bytes.items[previous_bytes.len..], "CD") != null);
        try std.testing.expectEqual(@as(u32, 22), value.checkHit(0, 0));
        try std.testing.expectEqual(previous_stats.frameCount + 1, value.getRenderStats().frameCount);
        try std.testing.expectEqual(@as(u32, 2), value.getRenderStats().cellsUpdated);
        try std.testing.expect(!value.force_full_repaint);
    }
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
        const value = try self.owner.getSessionRenderer(self.renderer_id);
        value.terminal.caps.hyperlinks = true;
        try value.getNextBuffer().drawText(self.grapheme, 0, 1, ansi.rgbColor(255, 255, 255, 255), null, ansi.TextAttributes.setLinkId(0, self.link_id));
        try std.testing.expectEqual(.pending, try self.owner.renderSession(self.renderer_id, true));
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
    const first_grapheme = try first.graphemes.alloc("e\xcc\x81");
    const second_grapheme = try second.graphemes.alloc("o\xcc\x82");
    const first_link = try first.links.alloc("https://first.invalid");
    const second_link = try second.links.alloc("https://second.invalid");
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
        const custom = try owner.getRenderable(custom_id);
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
        try std.testing.expectError(error.WrongContext, tasks[1 - index].owner.getRenderable(task.node_id));
        const bytes = task.output[0..task.output_len];
        try std.testing.expect(std.mem.find(u8, bytes, tasks[1 - index].text) == null);
        try std.testing.expect(std.mem.find(u8, bytes, tasks[1 - index].grapheme) == null);
    }
    try std.testing.expect(tasks[0].thread_id.? != tasks[1].thread_id.?);
    try std.testing.expectEqual(@as(u32, 1), first_callbacks.measurements);
    try std.testing.expectEqual(@as(u32, 1), second_callbacks.measurements);
    try std.testing.expectEqual(first_clock.time_us, (try first.getSessionRenderer(tasks[0].renderer_id)).lastRenderTime);
    try std.testing.expectEqual(second_clock.time_us, (try second.getSessionRenderer(tasks[1].renderer_id)).lastRenderTime);
    try std.testing.expect(first_clock.calls > 0);
    try std.testing.expectEqual(first_clock.calls, second_clock.calls);
    const first_identity = tasks[0].node_id;
    try first.deinit();
    first_alive = false;
    try std.testing.expectEqualStrings("o\xcc\x82", try second.graphemes.get(second_grapheme));
    try std.testing.expectEqualStrings("https://second.invalid", try second.links.get(second_link));
    try std.testing.expectError(error.WrongContext, second.getRenderable(first_identity));
    const custom = try second.getRenderable(tasks[1].custom_id);
    yoga.yogaNodeStyleSetValue(custom.yoga_node, @intFromEnum(yoga.YogaValueKind.min_width), 0, @intFromEnum(yoga.YogaUnit.point), 1);
    second_clock.time_us += 1000;
    try tasks[1].render();
    try std.testing.expect(second_callbacks.dirtied > 0);
    try std.testing.expectEqual(@as(u32, 2), second_callbacks.measurements);
    try std.testing.expectEqual(@as(u32, 1), first_callbacks.measurements);
    try std.testing.expectEqual(second_clock.time_us, (try second.getSessionRenderer(tasks[1].renderer_id)).lastRenderTime);
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
