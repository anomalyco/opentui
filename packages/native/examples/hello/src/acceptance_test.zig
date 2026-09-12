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
