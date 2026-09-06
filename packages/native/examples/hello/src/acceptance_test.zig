const std = @import("std");
const opentui = @import("opentui");

test "Yoga layout is available through the public Zig module" {
    const yoga = opentui.yoga_c;
    const node = yoga.YGNodeNew();
    defer yoga.YGNodeFree(node);

    yoga.YGNodeStyleSetWidth(node, 12);
    yoga.YGNodeStyleSetHeight(node, 3);
    yoga.YGNodeCalculateLayout(node, 80, 24, yoga.YGDirectionLTR);

    try std.testing.expectEqual(@as(f32, 12), yoga.YGNodeLayoutGetWidth(node));
    try std.testing.expectEqual(@as(f32, 3), yoga.YGNodeLayoutGetHeight(node));
}

const MemorySink = struct {
    const capacity = 16 * 1024;

    bytes: [capacity]u8 = undefined,
    length: usize = 0,

    fn output(self: *MemorySink) opentui.BufferedOutput {
        return .{ .ctx = self, .write_fn = write };
    }

    fn write(context: *anyopaque, bytes: []const u8) void {
        const self: *MemorySink = @ptrCast(@alignCast(context));
        std.debug.assert(bytes.len <= capacity - self.length);
        @memcpy(self.bytes[self.length..][0..bytes.len], bytes);
        self.length += bytes.len;
    }

    fn slice(self: *const MemorySink) []const u8 {
        return self.bytes[0..self.length];
    }
};

test "styled text renders through the public Zig module without JavaScript" {
    const allocator = std.testing.allocator;
    var graphemes = opentui.GraphemePool.init(allocator);
    defer graphemes.deinit();
    var links = opentui.LinkPool.init(allocator);
    defer links.deinit();
    var environment = std.process.Environ.Map.init(allocator);
    defer environment.deinit();
    var sink: MemorySink = .{};

    const renderer = try opentui.CliRenderer.createWithOptions(allocator, 8, 1, &graphemes, .{
        .output = .{ .buffered = sink.output() },
        .clearOnShutdown = false,
        .link_pool = &links,
        .env_map = &environment,
    });
    defer renderer.destroy();
    renderer.terminal.caps.hyperlinks = true;
    renderer.terminal.caps.rgb = true;

    const text_buffer = try opentui.UnifiedTextBuffer.init(allocator, &graphemes, &links, .unicode);
    defer text_buffer.deinit();
    const syntax_style = try opentui.text_buffer.SyntaxStyle.init(allocator);
    defer syntax_style.deinit();
    text_buffer.setSyntaxStyle(syntax_style);
    const view = try opentui.UnifiedTextBufferView.init(allocator, text_buffer);
    defer view.deinit();
    view.setViewport(.{ .x = 0, .y = 0, .width = 8, .height = 1 });

    const amber = opentui.rgbColor(255, 180, 40, 255);
    const cyan = opentui.rgbColor(80, 220, 255, 255);
    const link_url = "https://opentui.com/native";
    const chunks = [_]opentui.text_buffer.StyledChunk{
        .{
            .text_ptr = "Open".ptr,
            .text_len = "Open".len,
            .fg_ptr = @ptrCast(&amber),
            .bg_ptr = null,
            .attributes = opentui.TextAttributes.BOLD,
        },
        .{
            .text_ptr = "TUI".ptr,
            .text_len = "TUI".len,
            .fg_ptr = @ptrCast(&cyan),
            .bg_ptr = null,
            .attributes = opentui.TextAttributes.UNDERLINE,
            .link_ptr = link_url.ptr,
            .link_len = link_url.len,
        },
    };
    try text_buffer.setStyledText(&chunks);

    renderer.getNextBuffer().drawTextBuffer(view, 0, 0);
    try std.testing.expectEqual(opentui.renderer.RenderStatus.rendered, renderer.render(true));

    const output = sink.slice();
    const amber_index = std.mem.find(u8, output, "\x1b[38;2;255;180;40m") orelse return error.TestUnexpectedResult;
    const open_index = std.mem.find(u8, output, "Open") orelse return error.TestUnexpectedResult;
    const cyan_index = std.mem.find(u8, output, "\x1b[38;2;80;220;255m") orelse return error.TestUnexpectedResult;
    const tui_index = std.mem.find(u8, output, "TUI") orelse return error.TestUnexpectedResult;
    try std.testing.expect(amber_index < open_index);
    try std.testing.expect(open_index < tui_index);
    try std.testing.expect(open_index < cyan_index);
    try std.testing.expect(cyan_index < tui_index);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[1m") != null);
    try std.testing.expect(std.mem.find(u8, output, "\x1b[4m") != null);
    try std.testing.expect(std.mem.find(u8, output, ";https://opentui.com/native\x1b\\") != null);
}

test "NativeRenderable owns an OpenTUI Yoga node without JavaScript" {
    var renderable = try opentui.NativeRenderable.init();
    defer renderable.deinit();

    const node = renderable.getYogaNode();
    try std.testing.expect(node != null);
    const config = opentui.yoga.yogaNodeGetConfig(node);
    try std.testing.expectEqual(@as(f32, 1), opentui.yoga.yogaConfigGetPointScaleFactor(config));
}

test "Session owns scene nodes and borrows shared measured text through the public Zig module" {
    var environment = std.process.Environ.Map.init(std.testing.allocator);
    defer environment.deinit();
    const owner = try opentui.Context.init(std.testing.allocator, std.testing.io, .{
        .object_capacity = 5,
        .render_cells_max = 8,
    });
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(.{ .chunk_size = 4096 });
    try owner.attachSessionRenderer(id, 8, 1, .{ .env_map = &environment });
    const root = try owner.sceneCreateNode(id, 0, 1);
    try owner.sceneSetStyle(root, 0, 4, 0, 0, 1, 0);
    const node_id = try owner.sceneCreateNode(id, 7, 2);
    const text_id = try owner.createTextBuffer(.unicode);
    const view_id = try owner.createTextBufferView(text_id);
    try owner.textBufferSetText(text_id, "initial");
    try owner.textBufferSetText(text_id, "context");
    try owner.sceneSetTextView(node_id, view_id);
    try owner.sceneMoveNode(node_id, root, 0);
    try owner.scenePaint(id, .{ 0, 0, 0, 255 }, false, 0);
    const layout = try owner.sceneGetLayout(node_id, true);
    try std.testing.expectEqual(@as(f32, 7), layout.width);
    try std.testing.expectEqual(@as(f32, 1), layout.height);

    try std.testing.expectEqual(.pending, try owner.renderSession(id, true));
    try std.testing.expectError(error.ContextBusy, owner.deinit());
    var bytes: [4096]u8 = undefined;
    const ticket = (try owner.readOutput(id, &bytes)).?;
    try std.testing.expect(std.mem.find(u8, bytes[0..ticket.len], "context") != null);
    try owner.completeOutput(id, ticket, .written);

    try owner.destroy(text_id);
    try std.testing.expectError(error.StaleHandle, owner.getTextBuffer(text_id));
    try std.testing.expectError(error.StaleHandle, owner.getTextBufferView(view_id));
    try std.testing.expect((try owner.getRenderable(node_id)).measure_target == .none);
    try owner.destroy(id);
    try std.testing.expectError(error.StaleHandle, owner.getRenderable(node_id));
}

test "Session terminal lifecycle renders and restores through the public Zig pump" {
    var environment = std.process.Environ.Map.init(std.testing.allocator);
    defer environment.deinit();
    const owner = try opentui.Context.init(std.testing.allocator, std.testing.io, .{
        .object_capacity = 3,
        .render_cells_max = 8,
    });
    defer owner.deinit() catch unreachable;
    const id = try owner.createSession(.{
        .chunk_size = 4096,
        .chunk_count = 2,
        .span_capacity = 2,
        .control_capacity = 4096,
    });
    defer owner.cancelSession(id) catch unreachable;
    var prefix = "prefix".*;
    try owner.writeSession(id, &prefix);
    @memset(&prefix, '!');
    try owner.attachSessionRenderer(id, 8, 1, .{ .env_map = &environment });
    try owner.setupSessionTerminal(id, .{ .mouse = false });
    const renderer = try owner.getSessionRenderer(id);
    var output: MemorySink = .{};
    var bytes: [13]u8 = undefined;
    var now_ns: u64 = 0;
    var restored = false;
    for (0..64) |_| {
        const result = try owner.pumpSession(id, now_ns, 1);
        switch (result.status) {
            .output_pending => while (try owner.readOutput(id, &bytes)) |ticket| {
                try std.testing.expectEqualDeep(id, ticket.session);
                MemorySink.write(&output, bytes[0..ticket.len]);
                try owner.completeOutput(id, ticket, .written);
            },
            .again => {},
            .wait_until => now_ns = result.deadline_ns.?,
            .idle => {
                try std.testing.expectEqual(.active, (try owner.getSessionTerminalState(id)).phase);
                const source = try owner.createBuffer(8, 1, .{});
                try owner.clearBuffer(source, opentui.rgbColor(0, 0, 0, 255));
                try owner.drawBufferText(source, "pumped\u{754c}", 0, 0, opentui.rgbColor(255, 180, 40, 255), null, 0);
                try owner.drawSessionBuffer(id, source, 0, 0);
                {
                    const lease = try owner.acquireSessionBufferLease(id, .next);
                    defer owner.releaseBufferLease(lease) catch unreachable;
                    const cells = try owner.bufferLeaseSnapshot(lease);
                    try std.testing.expectEqual(@as(u32, 'p'), cells.buffer.char[0]);
                }
                try owner.destroy(source);
                renderer.addToHitGrid(0, 0, 6, 1, 71);
                try std.testing.expectEqual(.pending, try owner.renderSession(id, true));
                try owner.beginSessionClose(id);
                try std.testing.expectError(error.ContextBusy, owner.destroy(id));
            },
            .closed => {
                restored = true;
                break;
            },
        }
    }
    try std.testing.expect(restored);
    try std.testing.expectEqual(.restored, (try owner.getSessionTerminalState(id)).phase);
    try std.testing.expectEqual(@as(u64, 1), renderer.getRenderStats().frameCount);
    try std.testing.expectEqual(@as(u32, 71), renderer.checkHit(0, 0));
    try std.testing.expectEqual(2 * opentui.session.cursor_settle_ns, now_ns);
    try std.testing.expect(std.mem.startsWith(u8, output.slice(), "prefix"));
    try std.testing.expect(std.mem.find(u8, output.slice(), "pumped\u{754c}") != null);
    try std.testing.expect(std.mem.find(u8, output.slice(), opentui.ansi.ANSI.switchToMainScreen) != null);
}
