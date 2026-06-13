const std = @import("std");
const renderer = @import("../renderer.zig");
const text_buffer = @import("../text-buffer.zig");
const text_buffer_view = @import("../text-buffer-view.zig");
const buffer = @import("../buffer.zig");
const gp = @import("../grapheme.zig");
const ss = @import("../syntax-style.zig");
const link = @import("../link.zig");
const ansi = @import("../ansi.zig");
const test_renderer_mod = @import("test-renderer.zig");

const CliRenderer = renderer.CliRenderer;
const TextBuffer = text_buffer.TextBuffer;
const TextBufferView = text_buffer_view.TextBufferView;
const OptimizedBuffer = buffer.OptimizedBuffer;
const RGBA = text_buffer.RGBA;
const TestMemoryOutput = test_renderer_mod.TestMemoryOutput;
const TestRenderer = test_renderer_mod.TestRenderer;

const SlowThreadSafeOutput = struct {
    delay_ns: u64,
    writes: std.atomic.Value(u32) = std.atomic.Value(u32).init(0),
    payloads: [2][64]u8 = [_][64]u8{[_]u8{0} ** 64} ** 2,
    lengths: [2]usize = [_]usize{0} ** 2,

    fn bufferedOutput(self: *SlowThreadSafeOutput) @import("../renderer-output.zig").BufferedOutput {
        return .{ .ctx = self, .write_fn = write, .thread_safe = true };
    }

    fn write(ctx: *anyopaque, data: []const u8) void {
        const self: *SlowThreadSafeOutput = @ptrCast(@alignCast(ctx));
        const index = self.writes.fetchAdd(1, .monotonic);
        if (index < self.payloads.len) {
            self.lengths[index] = @min(data.len, self.payloads[index].len);
            @memcpy(self.payloads[index][0..self.lengths[index]], data[0..self.lengths[index]]);
        }
        std.Thread.sleep(self.delay_ns);
    }
};

fn createWithOptionsOnce(allocator: std.mem.Allocator, width: u32, height: u32) !void {
    const pool = gp.initGlobalPool(allocator);
    defer gp.deinitGlobalPool();
    defer link.deinitGlobalLinkPool();

    var memory = TestMemoryOutput.init(allocator);
    defer memory.deinit();

    var cli_renderer = try CliRenderer.createWithOptions(allocator, width, height, pool, .{
        .output = .{ .buffered = memory.bufferedOutput() },
    });
    cli_renderer.destroy();
}

test "renderer - createWithOptions late allocation failure cleans up" {
    const allocation_count = blk: {
        var counting_allocator = std.testing.FailingAllocator.init(std.testing.allocator, .{});
        try createWithOptionsOnce(counting_allocator.allocator(), 80, 24);
        break :blk counting_allocator.alloc_index;
    };

    try std.testing.expect(allocation_count > 0);

    var failing_allocator = std.testing.FailingAllocator.init(std.testing.allocator, .{
        .fail_index = allocation_count - 1,
    });

    try std.testing.expectError(error.OutOfMemory, createWithOptionsOnce(failing_allocator.allocator(), 80, 24));
    try std.testing.expect(failing_allocator.has_induced_failure);
    try std.testing.expectEqual(failing_allocator.allocated_bytes, failing_allocator.freed_bytes);
}

test "renderer - create and destroy" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_renderer.deinit();
    const cli_renderer = test_renderer.renderer;

    try std.testing.expectEqual(@as(u32, 80), cli_renderer.width);
    try std.testing.expectEqual(@as(u32, 24), cli_renderer.height);
}

test "renderer - simple text rendering to currentRenderBuffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello World");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);

    _ = cli_renderer.render(false);

    const current_buffer = cli_renderer.getCurrentBuffer();

    const cell_h = current_buffer.get(0, 0);
    try std.testing.expect(cell_h != null);
    try std.testing.expectEqual(@as(u32, 'H'), cell_h.?.char);

    const cell_e = current_buffer.get(1, 0);
    try std.testing.expect(cell_e != null);
    try std.testing.expectEqual(@as(u32, 'e'), cell_e.?.char);

    const cell_w = current_buffer.get(6, 0);
    try std.testing.expect(cell_w != null);
    try std.testing.expectEqual(@as(u32, 'W'), cell_w.?.char);
}

test "renderer - multi-line text rendering" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Line 1\nLine 2\nLine 3");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = cli_renderer.render(false);

    const current_buffer = cli_renderer.getCurrentBuffer();

    const cell_line1 = current_buffer.get(0, 0);
    try std.testing.expect(cell_line1 != null);
    try std.testing.expectEqual(@as(u32, 'L'), cell_line1.?.char);

    const cell_line2 = current_buffer.get(0, 1);
    try std.testing.expect(cell_line2 != null);
    try std.testing.expectEqual(@as(u32, 'L'), cell_line2.?.char);

    const cell_line3 = current_buffer.get(0, 2);
    try std.testing.expect(cell_line3 != null);
    try std.testing.expectEqual(@as(u32, 'L'), cell_line3.?.char);
}

test "renderer - emoji (wide grapheme) rendering" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hi 👋 there");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = cli_renderer.render(false);

    const current_buffer = cli_renderer.getCurrentBuffer();

    const cell_h = current_buffer.get(0, 0);
    try std.testing.expect(cell_h != null);
    try std.testing.expectEqual(@as(u32, 'H'), cell_h.?.char);

    const cell_i = current_buffer.get(1, 0);
    try std.testing.expect(cell_i != null);
    try std.testing.expectEqual(@as(u32, 'i'), cell_i.?.char);

    const cell_space1 = current_buffer.get(2, 0);
    try std.testing.expect(cell_space1 != null);
    try std.testing.expectEqual(@as(u32, ' '), cell_space1.?.char);

    const cell_emoji = current_buffer.get(3, 0);
    try std.testing.expect(cell_emoji != null);
    try std.testing.expect(gp.isGraphemeChar(cell_emoji.?.char));

    const cell_emoji_continuation = current_buffer.get(4, 0);
    try std.testing.expect(cell_emoji_continuation != null);
    try std.testing.expect(gp.isContinuationChar(cell_emoji_continuation.?.char));

    const cell_space2 = current_buffer.get(5, 0);
    try std.testing.expect(cell_space2 != null);
    try std.testing.expectEqual(@as(u32, ' '), cell_space2.?.char);

    const cell_t = current_buffer.get(6, 0);
    try std.testing.expect(cell_t != null);
    try std.testing.expectEqual(@as(u32, 't'), cell_t.?.char);
}

test "renderer - CJK characters rendering" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("Hello 世界");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = cli_renderer.render(false);

    const current_buffer = cli_renderer.getCurrentBuffer();

    const cell_h = current_buffer.get(0, 0);
    try std.testing.expect(cell_h != null);
    try std.testing.expectEqual(@as(u32, 'H'), cell_h.?.char);

    const cell_space = current_buffer.get(5, 0);
    try std.testing.expect(cell_space != null);
    try std.testing.expectEqual(@as(u32, ' '), cell_space.?.char);

    const cell_cjk1 = current_buffer.get(6, 0);
    try std.testing.expect(cell_cjk1 != null);
    try std.testing.expect(gp.isGraphemeChar(cell_cjk1.?.char));

    const cell_cjk1_continuation = current_buffer.get(7, 0);
    try std.testing.expect(cell_cjk1_continuation != null);
    try std.testing.expect(gp.isContinuationChar(cell_cjk1_continuation.?.char));

    const cell_cjk2 = current_buffer.get(8, 0);
    try std.testing.expect(cell_cjk2 != null);
    try std.testing.expect(gp.isGraphemeChar(cell_cjk2.?.char));

    const cell_cjk2_continuation = current_buffer.get(9, 0);
    try std.testing.expect(cell_cjk2_continuation != null);
    try std.testing.expect(gp.isContinuationChar(cell_cjk2_continuation.?.char));
}

test "renderer - mixed ASCII, emoji, and CJK" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("A 😀 世");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = cli_renderer.render(false);

    const current_buffer = cli_renderer.getCurrentBuffer();

    const cell_a = current_buffer.get(0, 0);
    try std.testing.expect(cell_a != null);
    try std.testing.expectEqual(@as(u32, 'A'), cell_a.?.char);

    const cell_space1 = current_buffer.get(1, 0);
    try std.testing.expect(cell_space1 != null);
    try std.testing.expectEqual(@as(u32, ' '), cell_space1.?.char);

    const cell_emoji = current_buffer.get(2, 0);
    try std.testing.expect(cell_emoji != null);
    try std.testing.expect(gp.isGraphemeChar(cell_emoji.?.char));

    const cell_emoji_continuation = current_buffer.get(3, 0);
    try std.testing.expect(cell_emoji_continuation != null);
    try std.testing.expect(gp.isContinuationChar(cell_emoji_continuation.?.char));

    const cell_space2 = current_buffer.get(4, 0);
    try std.testing.expect(cell_space2 != null);
    try std.testing.expectEqual(@as(u32, ' '), cell_space2.?.char);

    const cell_cjk = current_buffer.get(5, 0);
    try std.testing.expect(cell_cjk != null);
    try std.testing.expect(gp.isGraphemeChar(cell_cjk.?.char));

    const cell_cjk_continuation = current_buffer.get(6, 0);
    try std.testing.expect(cell_cjk_continuation != null);
    try std.testing.expect(gp.isContinuationChar(cell_cjk_continuation.?.char));
}

test "renderer - resize updates dimensions" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    try std.testing.expectEqual(@as(u32, 80), cli_renderer.width);
    try std.testing.expectEqual(@as(u32, 24), cli_renderer.height);

    try cli_renderer.resize(120, 40);

    try std.testing.expectEqual(@as(u32, 120), cli_renderer.width);
    try std.testing.expectEqual(@as(u32, 40), cli_renderer.height);
}

test "renderer - resize clears stale hit grid coordinates" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        4,
        2,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.addToCurrentHitGridClipped(2, 0, 1, 1, 99);
    try std.testing.expectEqual(@as(u32, 99), cli_renderer.checkHit(2, 0));

    try cli_renderer.resize(2, 2);

    try std.testing.expectEqual(@as(u32, 0), cli_renderer.checkHit(0, 1));

    _ = cli_renderer.render(false);
    try std.testing.expect(cli_renderer.getHitGridDirty());
}

test "renderer - background color setting" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const bg_color = ansi.rgbaFromFloats(0.1, 0.2, 0.3, 1.0);
    cli_renderer.setBackgroundColor(bg_color);

    try std.testing.expectEqual(bg_color, cli_renderer.backgroundColor);
    try std.testing.expectEqual(bg_color, cli_renderer.getNextBuffer().getBlendBackdropColor().?);

    const transparent_bg = ansi.rgbaFromFloats(0.25, 0.5, 0.75, 0.0);
    cli_renderer.setBackgroundColor(transparent_bg);

    try std.testing.expectEqual(transparent_bg, cli_renderer.backgroundColor);
    try std.testing.expectEqual(ansi.rgbaFromFloats(0.25, 0.5, 0.75, 1.0), cli_renderer.getNextBuffer().getBlendBackdropColor().?);
}

test "renderer - theme color query tracks pending background restore" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.setBackgroundColor(ansi.rgbaFromFloats(0.1, 0.2, 0.3, 1.0));
    cli_renderer.queryThemeColors();
    try std.testing.expectEqual(ansi.rgbaFromFloats(0.1, 0.2, 0.3, 1.0), cli_renderer.backgroundColor);
}

test "renderer - empty text buffer renders correctly" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = cli_renderer.render(false);
}

test "renderer - multiple renders update currentRenderBuffer" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    try tb.setText("Hello");
    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);
    _ = cli_renderer.render(false);

    var current_buffer = cli_renderer.getCurrentBuffer();
    var first_cell = current_buffer.get(0, 0);
    try std.testing.expect(first_cell != null);
    try std.testing.expectEqual(@as(u32, 'H'), first_cell.?.char);

    try tb.setText("World");
    const next_buffer2 = cli_renderer.getNextBuffer();
    next_buffer2.drawTextBuffer(view, 0, 0);
    _ = cli_renderer.render(false);

    current_buffer = cli_renderer.getCurrentBuffer();
    first_cell = current_buffer.get(0, 0);
    try std.testing.expect(first_cell != null);
    try std.testing.expectEqual(@as(u32, 'W'), first_cell.?.char);
}

test "renderer - 1000 frame render loop with setStyledText" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    tb.setSyntaxStyle(style);

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    var opt_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        80,
        24,
        .{ .pool = pool, .width_method = .unicode },
    );
    defer opt_buffer.deinit();

    const frame_texts = [_][]const u8{
        "Frame ASCII",
        "Frame 👋 emoji",
        "Frame 世界 CJK",
        "Mixed 😀 世",
    };

    const fg_color = ansi.rgbaFromFloats(1.0, 0.8, 0.6, 1.0);
    const bg_color = ansi.rgbaFromFloats(0.1, 0.1, 0.2, 1.0);

    var frame: u32 = 0;
    while (frame < 1000) : (frame += 1) {
        const text_idx = frame % frame_texts.len;
        const text = frame_texts[text_idx];

        const chunks = [_]text_buffer.StyledChunk{.{
            .text_ptr = text.ptr,
            .text_len = text.len,
            .fg_ptr = @ptrCast(&fg_color),
            .bg_ptr = @ptrCast(&bg_color),
            .attributes = 0,
        }};

        try tb.setStyledText(&chunks);
        opt_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
        opt_buffer.drawTextBuffer(view, 0, 0);

        const next_buffer = cli_renderer.getNextBuffer();
        next_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
        next_buffer.drawFrameBuffer(0, 0, opt_buffer, null, null, null, null);

        _ = cli_renderer.render(false);

        if (frame % 100 == 0) {
            const current_buffer = cli_renderer.getCurrentBuffer();
            const first_cell = current_buffer.get(0, 0);
            try std.testing.expect(first_cell != null);
            try std.testing.expect(first_cell.?.char != 32);

            try std.testing.expectEqual(frame + 1, cli_renderer.renderStats.frameCount);
        }
    }

    try std.testing.expectEqual(@as(u64, 1000), cli_renderer.renderStats.frameCount);

    const current_buffer = cli_renderer.getCurrentBuffer();
    const final_cell = current_buffer.get(0, 0);
    try std.testing.expect(final_cell != null);
    try std.testing.expectEqual(@as(u32, 'M'), final_cell.?.char);
}

test "renderer - grapheme pool refcounting with frame buffer fast path" {
    const limited_pool = gp.initGlobalPoolWithOptions(std.testing.allocator, .{
        .slots_per_page = [_]u32{ 2, 2, 2, 2, 2 },
    });
    defer gp.deinitGlobalPool();

    var tb = try TextBuffer.init(std.testing.allocator, limited_pool, link.initGlobalLinkPool(std.testing.allocator), .unicode);
    defer tb.deinit();

    const style = try ss.SyntaxStyle.init(std.testing.allocator);
    defer style.deinit();
    tb.setSyntaxStyle(style);

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        limited_pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    var frame_buffer = try OptimizedBuffer.init(
        std.testing.allocator,
        80,
        24,
        .{ .pool = limited_pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer frame_buffer.deinit();

    const fg_color = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg_color = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0);

    const text_with_emoji = "👋";
    const chunks = [_]text_buffer.StyledChunk{.{
        .text_ptr = text_with_emoji.ptr,
        .text_len = text_with_emoji.len,
        .fg_ptr = @ptrCast(&fg_color),
        .bg_ptr = @ptrCast(&bg_color),
        .attributes = 0,
    }};
    try tb.setStyledText(&chunks);
    frame_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    frame_buffer.drawTextBuffer(view, 0, 0);

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.setRespectAlpha(false);
    next_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);

    next_buffer.drawFrameBuffer(0, 0, frame_buffer, null, null, null, null);

    frame_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);

    var i: usize = 0;
    while (i < 10) : (i += 1) {
        const new_text = "🎉🚀💯";
        const new_chunks = [_]text_buffer.StyledChunk{.{
            .text_ptr = new_text.ptr,
            .text_len = new_text.len,
            .fg_ptr = @ptrCast(&fg_color),
            .bg_ptr = @ptrCast(&bg_color),
            .attributes = 0,
        }};
        try tb.setStyledText(&new_chunks);
        frame_buffer.drawTextBuffer(view, 0, 0);
        frame_buffer.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 32);
    }

    _ = cli_renderer.render(false);

    const current_buffer = cli_renderer.getCurrentBuffer();
    const rendered_cell = current_buffer.get(0, 0);
    try std.testing.expect(rendered_cell != null);
}

test "renderer - unchanged grapheme should not churn IDs across frames" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        4,
        1,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    const first_next_buffer = cli_renderer.getNextBuffer();
    try first_next_buffer.drawText("👋", 0, 0, fg, bg, 0);
    _ = cli_renderer.render(false);

    const first_output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.indexOf(u8, first_output, "👋") != null);

    const current_buffer = cli_renderer.getCurrentBuffer();
    const first_cell = current_buffer.get(0, 0);
    try std.testing.expect(first_cell != null);
    try std.testing.expect(gp.isGraphemeChar(first_cell.?.char));
    const first_gid = gp.graphemeIdFromChar(first_cell.?.char);

    const second_next_buffer = cli_renderer.getNextBuffer();
    try second_next_buffer.drawText("👋", 0, 0, fg, bg, 0);

    const second_cell = second_next_buffer.get(0, 0);
    try std.testing.expect(second_cell != null);
    try std.testing.expect(gp.isGraphemeChar(second_cell.?.char));
    const second_gid = gp.graphemeIdFromChar(second_cell.?.char);

    // Same grapheme content in consecutive frames should keep a stable ID,
    // otherwise diff/write treats unchanged cells as modified every frame.
    try std.testing.expectEqual(first_gid, second_gid);

    _ = cli_renderer.render(false);

    const second_output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.indexOf(u8, second_output, "👋") == null);
}

test "renderer - hyperlinks enabled with OSC 8 output" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const local_link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    // Enable hyperlinks capability
    cli_renderer.terminal.caps.hyperlinks = true;

    // Allocate a link
    const link_id = try local_link_pool.alloc("https://example.com");
    const attributes = ansi.TextAttributes.setLinkId(ansi.TextAttributes.BOLD, link_id);

    const next_buffer = cli_renderer.getNextBuffer();

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("Click here", 0, 0, fg, bg, attributes);

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    // Verify OSC 8 contains id parameter
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b]8;id=") != null);
    // Verify OSC 8 contains the URL
    try std.testing.expect(std.mem.indexOf(u8, output, ";https://example.com\x1b\\") != null);

    // Verify output contains OSC 8 end sequence
    const end_seq = "\x1b]8;;\x1b\\";
    var count: usize = 0;
    var pos: usize = 0;
    while (std.mem.indexOf(u8, output[pos..], end_seq)) |found| {
        count += 1;
        pos += found + end_seq.len;
    }
    try std.testing.expect(count >= 1);
}

test "renderer - hyperlinks disabled no OSC 8 output" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const local_link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    // Hyperlinks disabled by default
    cli_renderer.terminal.caps.hyperlinks = false;

    // Allocate a link
    const link_id = try local_link_pool.alloc("https://example.com");
    const attributes = ansi.TextAttributes.setLinkId(0, link_id);

    const next_buffer = cli_renderer.getNextBuffer();

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("Click here", 0, 0, fg, bg, attributes);

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    // Verify output does NOT contain OSC 8 sequences
    try std.testing.expect(std.mem.indexOf(u8, output, "]8;;") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "]8;id=") == null);
}

test "renderer - link transition mid-line" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    const local_link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    // Enable hyperlinks
    cli_renderer.terminal.caps.hyperlinks = true;

    const next_buffer = cli_renderer.getNextBuffer();

    // Allocate two different links
    const link_id1 = try local_link_pool.alloc("https://first.com");
    const link_id2 = try local_link_pool.alloc("https://second.com");

    const attr1 = ansi.TextAttributes.setLinkId(0, link_id1);
    const attr2 = ansi.TextAttributes.setLinkId(0, link_id2);

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    // Draw first link
    try next_buffer.drawText("First", 0, 0, fg, bg, attr1);
    // Draw second link
    try next_buffer.drawText("Second", 6, 0, fg, bg, attr2);
    // Draw no link
    try next_buffer.drawText("Normal", 13, 0, fg, bg, 0);

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    // Should contain both URLs
    try std.testing.expect(std.mem.indexOf(u8, output, "https://first.com") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "https://second.com") != null);

    // Should have multiple OSC 8 end sequences (at least 2 transitions)
    const end_seq = "\x1b]8;;\x1b\\";
    var count: usize = 0;
    var pos: usize = 0;
    while (std.mem.indexOf(u8, output[pos..], end_seq)) |found| {
        count += 1;
        pos += found + end_seq.len;
    }
    try std.testing.expect(count >= 2);
}

test "renderer - hyperlink spanning multiple rows uses same id" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();

    const link_pool = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    // Enable hyperlinks
    cli_renderer.terminal.caps.hyperlinks = true;

    const next_buffer = cli_renderer.getNextBuffer();

    // Allocate a single link
    const link_id = try link_pool.alloc("https://example.com/long-url");
    const attributes = ansi.TextAttributes.setLinkId(0, link_id);

    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    // Fill entire row 0 with linked text so link is never interrupted by empty cells
    try next_buffer.drawText("01234567890123456789012345678901234567890123456789012345678901234567890123456789", 0, 0, fg, bg, attributes);
    // Continue the same link on row 1
    try next_buffer.drawText("Here", 0, 1, fg, bg, attributes);

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    // Build expected OSC 8 open sequence with the link id
    var buf: [256]u8 = undefined;
    const expected_open = std.fmt.bufPrint(&buf, "\x1b]8;id={d};https://example.com/long-url\x1b\\", .{link_id}) catch unreachable;
    var count: usize = 0;
    var pos: usize = 0;
    while (std.mem.indexOf(u8, output[pos..], expected_open)) |found| {
        count += 1;
        pos += found + expected_open.len;
    }
    // Should appear exactly once: the link stays open across rows without
    // close/reopen at row boundaries, so terminals treat it as one contiguous link.
    try std.testing.expectEqual(@as(usize, 1), count);
}

test "renderer - explicit default and indexed tags use ANSI default/indexed output" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        4,
        1,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = true;
    cli_renderer.terminal.caps.ansi256 = true;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.set(0, 0, .{
        .char = 'A',
        .fg = ansi.defaultColor(255, 255, 255, 255),
        .bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0),
        .attributes = 0,
    });
    next_buffer.set(1, 0, .{
        .char = 'B',
        .fg = ansi.indexedColor(6, 51, 179, 230),
        .bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0),
        .attributes = 0,
    });

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[39m") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[38;5;6m") != null);
}

test "renderer - indexed snapshots fall back to rgb and explicit bg default resets without ansi256" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        2,
        1,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = true;
    cli_renderer.terminal.caps.ansi256 = false;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.set(0, 0, .{
        .char = 'A',
        .fg = ansi.indexedColor(6, 51, 102, 153),
        .bg = ansi.defaultColor(0, 0, 0, 255),
        .attributes = 0,
    });

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[38;2;51;102;153m") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[38;5;6m") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[49m") != null);
}

test "renderer - rgb colors fall back to ANSI256 mapping when rgb is unavailable" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        2,
        1,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = false;
    cli_renderer.terminal.caps.ansi256 = true;

    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("A", 0, 0, ansi.rgbaFromFloats(0.95, 0.1, 0.1, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 0);

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[38;5;") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[38;2;") == null);
}

test "renderer - rgb fallback uses published palette state" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        2,
        1,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = false;
    cli_renderer.terminal.caps.ansi256 = true;

    const target = ansi.rgbaFromFloats(0.3, 0.6, 0.9, 1.0);
    var palette = [_]RGBA{ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0)} ** 256;
    palette[42] = target;
    cli_renderer.setPaletteState(palette[0..], ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 1);

    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("A", 0, 0, target, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0), 0);

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[38;5;42m") != null);
}

test "renderer - palette epoch changes force repaint and use new palette mapping" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        2,
        1,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = false;
    cli_renderer.terminal.caps.ansi256 = true;

    const target = ansi.rgbaFromFloats(0.3, 0.6, 0.9, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);

    var palette_a = [_]RGBA{ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0)} ** 256;
    palette_a[42] = target;
    cli_renderer.setPaletteState(palette_a[0..], ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0), bg, 1);

    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("A", 0, 0, target, bg, 0);
    _ = cli_renderer.render(false);

    const first_output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.indexOf(u8, first_output, "\x1b[38;5;42m") != null);

    try next_buffer.drawText("A", 0, 0, target, bg, 0);
    _ = cli_renderer.render(false);

    const second_output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.indexOf(u8, second_output, "A") == null);

    var palette_b = [_]RGBA{ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0)} ** 256;
    palette_b[77] = target;
    cli_renderer.setPaletteState(palette_b[0..], ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0), bg, 2);

    try next_buffer.drawText("A", 0, 0, target, bg, 0);
    _ = cli_renderer.render(false);

    const third_output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.indexOf(u8, third_output, "A") != null);
    try std.testing.expect(std.mem.indexOf(u8, third_output, "\x1b[38;5;77m") != null);
}

test "renderer - transparent rgb backgrounds still emit 49 reset" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        2,
        1,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = true;

    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("A", 0, 0, ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[49m") != null);
}

// ============================================================================
// GRAPHEME CURSOR POSITIONING TESTS
// ============================================================================

test "renderer - default cursor style emits reset cursor ANSI" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.setCursorPosition(4, 2, true);
    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    try std.testing.expect(std.mem.indexOf(u8, output, ansi.ANSI.defaultCursorStyle) != null);
    try std.testing.expect(std.mem.indexOf(u8, output, ansi.ANSI.cursorBlock) == null);
}

test "renderer - explicit_cursor_positioning emits cursor move after wide graphemes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("👋X");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.explicit_cursor_positioning = true;
    cli_renderer.terminal.caps.explicit_width = false;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[1;3H") != null);
}

test "renderer - explicit_cursor_positioning produces more cursor moves" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();
    try tb.setText("👋🎉🚀");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer1 = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer1.deinit();
    const cli_renderer1 = test_cli_renderer1.renderer;

    cli_renderer1.terminal.caps.explicit_cursor_positioning = false;
    cli_renderer1.terminal.caps.explicit_width = false;

    const next_buffer1 = cli_renderer1.getNextBuffer();
    next_buffer1.drawTextBuffer(view, 0, 0);
    _ = cli_renderer1.render(false);
    const output_without = test_cli_renderer1.lastOutput();

    var test_cli_renderer2 = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer2.deinit();
    const cli_renderer2 = test_cli_renderer2.renderer;

    cli_renderer2.terminal.caps.explicit_cursor_positioning = true;
    cli_renderer2.terminal.caps.explicit_width = false;

    const next_buffer2 = cli_renderer2.getNextBuffer();
    next_buffer2.drawTextBuffer(view, 0, 0);
    _ = cli_renderer2.render(false);
    const output_with = test_cli_renderer2.lastOutput();

    var count_without: usize = 0;
    var count_with: usize = 0;

    var i: usize = 0;
    while (i + 3 < output_without.len) : (i += 1) {
        if (output_without[i] == '\x1b' and output_without[i + 1] == '[') {
            var j = i + 2;
            while (j < output_without.len and ((output_without[j] >= '0' and output_without[j] <= '9') or output_without[j] == ';')) : (j += 1) {}
            if (j < output_without.len and output_without[j] == 'H') {
                count_without += 1;
            }
        }
    }

    i = 0;
    while (i + 3 < output_with.len) : (i += 1) {
        if (output_with[i] == '\x1b' and output_with[i + 1] == '[') {
            var j = i + 2;
            while (j < output_with.len and ((output_with[j] >= '0' and output_with[j] <= '9') or output_with[j] == ';')) : (j += 1) {}
            if (j < output_with.len and output_with[j] == 'H') {
                count_with += 1;
            }
        }
    }

    try std.testing.expect(count_with > count_without);
}

test "renderer - explicit_cursor_positioning with CJK characters" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var tb = try TextBuffer.init(std.testing.allocator, pool, &local_link_pool, .unicode);
    defer tb.deinit();

    try tb.setText("世X");

    var view = try TextBufferView.init(std.testing.allocator, tb);
    defer view.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        80,
        24,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.explicit_cursor_positioning = true;
    cli_renderer.terminal.caps.explicit_width = false;

    const next_buffer = cli_renderer.getNextBuffer();
    next_buffer.drawTextBuffer(view, 0, 0);

    _ = cli_renderer.render(false);

    const output = test_cli_renderer.lastOutput();

    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[1;3H") != null);
}

test "renderer - commitSplitFooterSnapshot writes append before footer repaint in one output" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        3,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(2, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        11,
        1,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try snapshot.drawText("append-line", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    const appended = "append-line";
    // This test documents the critical ordering contract:
    // 1) append payload is emitted in the same sync frame as repaint
    // 2) DECSTBM is active only during append when pinned
    // 3) footer repaint cursor move happens after append payload
    _ = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, 11, false, true, 2, false, true, true);

    const output = test_cli_renderer.lastOutput();
    const append_index = std.mem.indexOf(u8, output, appended);
    const scroll_region_set_index = std.mem.indexOf(u8, output, "\x1b[1;2r");
    const scroll_region_reset_index = std.mem.indexOf(u8, output, "\x1b[r");
    const sync_index = std.mem.indexOf(u8, output, ansi.ANSI.syncSet);
    const footer_move_after_sync = if (sync_index) |sync_start|
        std.mem.indexOf(u8, output[sync_start + ansi.ANSI.syncSet.len ..], "\x1b[3;1H")
    else
        null;

    try std.testing.expect(append_index != null);
    try std.testing.expect(scroll_region_set_index != null);
    try std.testing.expect(scroll_region_reset_index != null);
    try std.testing.expect(sync_index != null);
    try std.testing.expect(footer_move_after_sync != null);
    try std.testing.expect(sync_index.? < append_index.?);
    try std.testing.expect(scroll_region_set_index.? < append_index.?);
    try std.testing.expect(append_index.? < scroll_region_reset_index.?);

    var sync_count: usize = 0;
    var pos: usize = 0;
    while (std.mem.indexOf(u8, output[pos..], ansi.ANSI.syncSet)) |found| {
        sync_count += 1;
        pos += found + ansi.ANSI.syncSet.len;
    }

    try std.testing.expectEqual(@as(usize, 1), sync_count);
}

test "renderer - commitSplitFooterSnapshot settling phase moves footer downward" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        3,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(0, 3);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        6,
        1,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try snapshot.drawText("settle", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    const appended = "settle";
    // During settling we intentionally avoid bounded DECSTBM and instead clear rows
    // that transition from footer surface to scrollback before append.
    _ = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, 6, false, true, 3, false, true, true);

    const output = test_cli_renderer.lastOutput();
    const settling_clear_index = std.mem.indexOf(u8, output, "\x1b[1;1H\x1b[J");
    const stale_footer_clear_top_index = std.mem.indexOf(u8, output, "\x1b[1;1H\x1b[2K");
    const stale_footer_clear_next_index = std.mem.indexOf(u8, output, "\x1b[2;1H\x1b[2K");
    const append_index = std.mem.indexOf(u8, output, appended);
    const scroll_region_reset_index = std.mem.indexOf(u8, output, "\x1b[r");
    const footer_clear_index = std.mem.indexOf(u8, output, "\x1b[3;1H\x1b[2K");
    const footer_erase_below_index = std.mem.indexOf(u8, output, "\x1b[3;1H\x1b[J");
    const sync_index = std.mem.indexOf(u8, output, ansi.ANSI.syncSet);

    try std.testing.expectEqual(@as(u32, 2), cli_renderer.renderOffset);
    try std.testing.expect(settling_clear_index == null);
    try std.testing.expect(stale_footer_clear_top_index != null);
    try std.testing.expect(stale_footer_clear_next_index != null);
    try std.testing.expect(append_index != null);
    try std.testing.expect(scroll_region_reset_index == null);
    try std.testing.expect(footer_clear_index == null);
    try std.testing.expect(footer_erase_below_index == null);
    try std.testing.expect(sync_index != null);
    try std.testing.expect(sync_index.? < append_index.?);
    try std.testing.expect(stale_footer_clear_top_index.? < append_index.?);
}

test "renderer - commitSplitFooterSnapshot multiline settling enables bounded scroll at pin" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        3,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(1, 3);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        6,
        2,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try snapshot.drawText("line-a", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try snapshot.drawText("line-b", 0, 1, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, 6, false, true, 3, false, true, true);

    const output = test_cli_renderer.lastOutput();
    const expanded_region_index = std.mem.indexOf(u8, output, "\x1b[1;3r");
    const collapsed_region_index = std.mem.indexOf(u8, output, "\x1b[r");

    try std.testing.expectEqual(@as(u32, 3), cli_renderer.renderOffset);
    try std.testing.expect(expanded_region_index != null);
    try std.testing.expect(collapsed_region_index != null);
    try std.testing.expect(expanded_region_index.? < collapsed_region_index.?);
}

test "renderer - commitSplitFooterSnapshot multiline short final row keeps continuation column" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        20,
        4,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(2, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var first_snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        16,
        3,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer first_snapshot.deinit();

    first_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try first_snapshot.drawText("1234567890123456", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try first_snapshot.drawText("short", 0, 2, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(first_snapshot, 16, false, false, 2, false, true, true);

    try std.testing.expectEqual(@as(u32, 5), cli_renderer.splitScrollback.tail_column);

    var second_snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        1,
        1,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer second_snapshot.deinit();

    second_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try second_snapshot.drawText(",", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(second_snapshot, 1, false, false, 2, false, true, true);

    const output = test_cli_renderer.lastOutput();
    const move_index = std.mem.indexOf(u8, output, "\x1b[2;6H");
    const comma_index = std.mem.indexOf(u8, output, ",");

    try std.testing.expect(move_index != null);
    try std.testing.expect(comma_index != null);
    try std.testing.expect(move_index.? < comma_index.?);
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[2;17H") == null);
}

test "renderer - commitSplitFooterSnapshot exact-width continuation preserves autowrap" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        20,
        4,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(2, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var first_snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        20,
        1,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer first_snapshot.deinit();

    first_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try first_snapshot.drawText("12345678901234567890", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(first_snapshot, 20, false, false, 2, false, true, true);

    var second_snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        8,
        1,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer second_snapshot.deinit();

    second_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try second_snapshot.drawText(" letters", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(second_snapshot, 8, false, false, 2, false, true, true);

    const output = test_cli_renderer.lastOutput();
    const wrap_index = std.mem.indexOf(u8, output, "\x1b[2;20H\r\n");
    const text_index = std.mem.indexOf(u8, output, " letters");

    try std.testing.expectEqual(@as(u32, 8), cli_renderer.splitScrollback.tail_column);
    try std.testing.expect(wrap_index != null);
    try std.testing.expect(text_index != null);
    try std.testing.expect(wrap_index.? < text_index.?);
}

test "renderer - commitSplitFooterSnapshot does not emit continuation spaces for wide graphemes" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        4,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(2, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        2,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try snapshot.drawText("│甲│乙│丙│", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try snapshot.drawText("│😀│🚀│🧪│", 0, 1, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, 10, false, false, 2, false, true, true);

    const output = test_cli_renderer.lastOutput();

    try std.testing.expect(std.mem.indexOf(u8, output, "│甲│乙│丙│") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "│😀│🚀│🧪│") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "甲 ") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "乙 ") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "丙 ") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "😀 ") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "🚀 ") == null);
    try std.testing.expect(std.mem.indexOf(u8, output, "🧪 ") == null);
}

test "renderer - repaintSplitFooter repaints footer without append payload" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        3,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(2, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    _ = cli_renderer.repaintSplitFooter(2, true);

    const output = test_cli_renderer.lastOutput();
    const footer_text_index = std.mem.indexOf(u8, output, "FOOT");
    const footer_clear_index = std.mem.indexOf(u8, output, "\x1b[3;1H\x1b[2K");
    const footer_erase_below_index = std.mem.indexOf(u8, output, "\x1b[3;1H\x1b[J");
    const sync_index = std.mem.indexOf(u8, output, ansi.ANSI.syncSet);

    try std.testing.expect(footer_text_index != null);
    try std.testing.expect(footer_clear_index == null);
    try std.testing.expect(footer_erase_below_index == null);
    try std.testing.expect(sync_index != null);
    try std.testing.expect(sync_index.? < footer_text_index.?);
}

test "renderer - repaintSplitFooter applies pending viewport scroll transition in one frame" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        1,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(4, 4);
    cli_renderer.setRenderOffset(3);
    cli_renderer.setPendingSplitFooterTransition(.viewport_scroll, 4, 2, 5, 1, 1);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    _ = cli_renderer.repaintSplitFooter(4, true);

    const output = test_cli_renderer.lastOutput();
    const sync_index = std.mem.indexOf(u8, output, ansi.ANSI.syncSet);
    const scroll_index = std.mem.indexOf(u8, output, "\x1b[1T");
    const footer_move_index = std.mem.indexOf(u8, output, "\x1b[5;1H");
    const footer_text_index = std.mem.indexOf(u8, output, "FOOT");

    try std.testing.expect(sync_index != null);
    try std.testing.expect(scroll_index != null);
    try std.testing.expect(footer_move_index != null);
    try std.testing.expect(footer_text_index != null);
    try std.testing.expect(sync_index.? < scroll_index.?);
    try std.testing.expect(scroll_index.? < footer_move_index.?);
    try std.testing.expect(footer_move_index.? < footer_text_index.?);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncSet));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncReset));
}

test "renderer - repaintSplitFooter viewport scroll uses explicit split scroll delta when gap already exists" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        8,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(6, 6);
    cli_renderer.splitScrollback.noteViewportScroll(2);
    cli_renderer.setRenderOffset(6);
    cli_renderer.setPendingSplitFooterTransition(.viewport_scroll, 7, 4, 3, 8, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    _ = cli_renderer.repaintSplitFooter(2, true);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[2S") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[4S") == null);
    try std.testing.expectEqual(@as(u32, 2), cli_renderer.getSplitOutputOffset(2));
}

test "renderer - repaintSplitFooter applies pending stale row clear transition in one frame" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        3,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(1, 7);
    cli_renderer.setPendingSplitFooterTransition(.clear_stale_rows, 2, 4, 2, 3, 0);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    _ = cli_renderer.repaintSplitFooter(7, true);

    const output = test_cli_renderer.lastOutput();
    const sync_index = std.mem.indexOf(u8, output, ansi.ANSI.syncSet);
    const clear_index = std.mem.indexOf(u8, output, "\x1b[5;1H\x1b[2K");
    const footer_text_index = std.mem.indexOf(u8, output, "FOOT");

    try std.testing.expect(sync_index != null);
    try std.testing.expect(clear_index != null);
    try std.testing.expect(footer_text_index != null);
    try std.testing.expect(sync_index.? < clear_index.?);
    try std.testing.expect(clear_index.? < footer_text_index.?);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncSet));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncReset));
}

test "renderer - commitSplitFooterSnapshot appends styled snapshot before footer repaint" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        16,
        4,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = true;
    cli_renderer.terminal.caps.ansi256 = true;

    _ = cli_renderer.resetSplitScrollback(2, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        8,
        2,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try snapshot.drawText("SNAP", 0, 0, ansi.rgbaFromFloats(1.0, 0.5, 0.0, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), ansi.TextAttributes.BOLD);
    try snapshot.drawText("SHOT", 0, 1, ansi.rgbaFromFloats(0.2, 0.8, 0.9, 1.0), ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, 8, true, true, 2, false, true, true);

    const output = test_cli_renderer.lastOutput();
    const snapshot_text_index = std.mem.indexOf(u8, output, "SNAP");
    const orange_fg_index = std.mem.indexOf(u8, output, "\x1b[38;2;255;128;0m");
    const bold_index = std.mem.indexOf(u8, output, "\x1b[1m");
    const sync_index = std.mem.indexOf(u8, output, ansi.ANSI.syncSet);
    const footer_clear_index = std.mem.indexOf(u8, output, "\x1b[3;1H\x1b[2K");

    try std.testing.expect(snapshot_text_index != null);
    try std.testing.expect(orange_fg_index != null);
    try std.testing.expect(bold_index != null);
    try std.testing.expect(sync_index != null);
    try std.testing.expect(sync_index.? < snapshot_text_index.?);
    try std.testing.expect(footer_clear_index == null);
}

test "renderer - commitSplitFooterSnapshot preserves indexed and default color tags" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        8,
        4,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.caps.rgb = true;
    cli_renderer.terminal.caps.ansi256 = true;

    _ = cli_renderer.resetSplitScrollback(2, 2);

    var snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        2,
        1,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    snapshot.set(0, 0, .{
        .char = 'A',
        .fg = ansi.defaultColor(255, 255, 255, 255),
        .bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0),
        .attributes = 0,
    });
    snapshot.set(1, 0, .{
        .char = 'B',
        .fg = ansi.indexedColor(6, 51, 102, 153),
        .bg = ansi.defaultColor(0, 0, 0, 255),
        .attributes = 0,
    });

    _ = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, 2, true, false, 2, false, true, true);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.indexOf(u8, output, "A") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "B") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[39m") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[38;5;6m") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[49m") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "\x1b[38;2;51;102;153m") == null);
}

test "renderer - commitSplitFooterSnapshot does not emit NUL padding for short rows" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        20,
        4,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(2, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        16,
        2,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer snapshot.deinit();

    snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try snapshot.drawText("[tool:bash] Shell", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);
    try snapshot.drawText("$ pwd", 0, 1, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(snapshot, 16, true, true, 2, false, true, true);

    const output = test_cli_renderer.lastOutput();
    try std.testing.expect(std.mem.indexOfScalar(u8, output, 0) == null);
    try std.testing.expect(std.mem.indexOf(u8, output, ansi.ANSI.eraseToEndOfLine) != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "\r\n\x1b[0m\x1b[K") != null);
}

test "renderer - batched split commits share single sync frame" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        16,
        4,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    _ = cli_renderer.resetSplitScrollback(2, 2);

    const next_buffer = cli_renderer.getNextBuffer();
    const fg = ansi.rgbaFromFloats(1.0, 1.0, 1.0, 1.0);
    const bg = ansi.rgbaFromFloats(0.0, 0.0, 0.0, 1.0);
    try next_buffer.drawText("FOOT", 0, 0, fg, bg, 0);

    var first_snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        1,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer first_snapshot.deinit();
    first_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try first_snapshot.drawText("FIRST", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    var second_snapshot = try OptimizedBuffer.init(
        std.testing.allocator,
        10,
        1,
        .{ .pool = pool, .width_method = .unicode, .respectAlpha = false },
    );
    defer second_snapshot.deinit();
    second_snapshot.clear(ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 32);
    try second_snapshot.drawText("SECOND", 0, 0, fg, ansi.rgbaFromFloats(0.0, 0.0, 0.0, 0.0), 0);

    _ = cli_renderer.commitSplitFooterSnapshotBatched(
        first_snapshot,
        10,
        true,
        true,
        2,
        false,
        true,
        false,
    );

    _ = cli_renderer.commitSplitFooterSnapshotBatched(
        second_snapshot,
        10,
        true,
        true,
        2,
        false,
        false,
        true,
    );

    const output = test_cli_renderer.lastOutput();
    // Batching should keep both commits inside one synchronized update envelope.
    try std.testing.expect(std.mem.indexOf(u8, output, "FIRST") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "SECOND") != null);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncSet));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output, ansi.ANSI.syncReset));
}

test "renderer - unchanged frame with unchanged cursor emits no output" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        4,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.terminal.setCursorPosition(3, 2, true);
    _ = cli_renderer.render(false);

    _ = cli_renderer.render(false);
    const output = test_cli_renderer.lastOutput();

    // No-op frames must be byte-empty; otherwise repeated sync/cursor toggles can
    // produce visible shimmer in terminals that animate cursor or repaint eagerly.
    try std.testing.expectEqual(@as(usize, 0), output.len);
}

test "renderer - buffered debug dump includes non-threaded last render" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    var local_link_pool = link.LinkPool.init(std.testing.allocator);
    defer local_link_pool.deinit();

    var test_cli_renderer = try TestRenderer.create(
        std.testing.allocator,
        12,
        4,
        pool,
    );
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;
    try std.testing.expect(!cli_renderer.backend.isUseThread());

    const fg = RGBA{ 1.0, 1.0, 1.0, 1.0 };
    const bg = RGBA{ 0.0, 0.0, 0.0, 1.0 };
    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("DUMP", 0, 0, fg, bg, 0);

    _ = cli_renderer.render(false);

    var dump_buf: [4096]u8 = undefined;
    var stream = std.io.fixedBufferStream(&dump_buf);
    cli_renderer.backend.dumpTo(stream.writer());
    const dump = stream.getWritten();

    try std.testing.expect(std.mem.indexOf(u8, dump, "DUMP") != null);
    try std.testing.expect(std.mem.indexOf(u8, dump, "(no output rendered yet)") == null);
}

// ---- FeedBackend tests ----

const native_span_feed = @import("../native-span-feed.zig");

test "FeedBackend - renderer writes through feed" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    const feed = try native_span_feed.Stream.create(std.testing.allocator, null);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 80, 24, pool, .{
        .remote_mode = .remote,
        .output = .{ .feed = feed },
    });
    // LIFO: renderer destroys first (needs the feed alive for shutdown writes).
    defer feed.destroy();
    defer cli_renderer.destroy();

    const fg = RGBA{ 1.0, 1.0, 1.0, 1.0 };
    const bg = RGBA{ 0.0, 0.0, 0.0, 1.0 };
    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("Hello", 0, 0, fg, bg, 0);

    _ = cli_renderer.render(false);

    var span_out: [32]native_span_feed.SpanInfo = undefined;
    const count = feed.drainSpans(&span_out);
    try std.testing.expect(count > 0);

    var total_bytes: usize = 0;
    var found_hello = false;
    for (span_out[0..count]) |span| {
        total_bytes += span.len;
        const slice = span.slice();
        if (std.mem.indexOf(u8, slice, "Hello") != null) {
            found_hello = true;
        }
    }
    try std.testing.expect(total_bytes > 0);
    try std.testing.expect(found_hello);
}

test "FeedBackend - shouldSkipFrame when span queue saturated" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    // Create a feed with a very small span queue so we can saturate it easily.
    var opts = native_span_feed.defaultOptions();
    opts.span_queue_capacity = 2;
    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 80, 24, pool, .{
        .remote_mode = .remote,
        .output = .{ .feed = feed },
    });
    // LIFO: renderer destroys first.
    defer feed.destroy();
    defer cli_renderer.destroy();

    // Render a few frames to build up pending spans. Each render commits one
    // span, so after 2 renders without draining we should be at capacity.
    const fg = RGBA{ 1.0, 1.0, 1.0, 1.0 };
    const bg = RGBA{ 0.0, 0.0, 0.0, 1.0 };
    const next_buffer = cli_renderer.getNextBuffer();
    try next_buffer.drawText("A", 0, 0, fg, bg, 0);
    _ = cli_renderer.render(false);

    try next_buffer.drawText("B", 0, 0, fg, bg, 0);
    _ = cli_renderer.render(false);

    try std.testing.expect(cli_renderer.backend.shouldSkipFrame());

    // Catch-up semantics: a skipped render must NOT advance lastRenderTime,
    // so the next non-skipped frame sees the full accumulated delta.
    const before = cli_renderer.lastRenderTime;
    try next_buffer.drawText("C", 0, 0, fg, bg, 0);
    const status = cli_renderer.render(false);
    try std.testing.expectEqual(before, cli_renderer.lastRenderTime);
    try std.testing.expectEqual(renderer.RenderStatus.skipped, status);

    const current_cell = cli_renderer.getCurrentBuffer().get(0, 0).?;
    const next_cell = cli_renderer.getNextBuffer().get(0, 0).?;
    try std.testing.expectEqual(@as(u32, 'B'), current_cell.char);
    try std.testing.expect(next_cell.char != @as(u32, 'C'));
}

test "FeedBackend - prepareFrame commits existing pending bytes before new frames" {
    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 64;
    opts.initial_chunks = 1;
    opts.auto_commit_on_full = 0;

    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    defer feed.destroy();

    var backend = renderer.FeedBackend.create(feed);

    try feed.write("pending");
    try std.testing.expect(feed.hasPendingBytes());
    try std.testing.expectEqual(.skipped, backend.prepareFrame());

    var span_out: [4]native_span_feed.SpanInfo = undefined;
    const count = feed.drainSpans(&span_out);
    try std.testing.expectEqual(@as(u32, 1), count);
    try std.testing.expectEqualStrings("pending", span_out[0].slice());
    feed.markSpanConsumed(span_out[0]);

    try std.testing.expectEqual(.ok, backend.prepareFrame());
}

test "FeedBackend - failed frame write preserves pending bytes" {
    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 32;
    opts.initial_chunks = 1;
    opts.auto_commit_on_full = 0;

    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    defer feed.destroy();

    var backend = renderer.FeedBackend.create(feed);

    backend.beginFrame();
    var failed_writer = backend.writer();
    try failed_writer.writeAll("pending");
    try std.testing.expectError(error.BufferFull, failed_writer.writeAll("this-write-is-too-large-for-the-current-chunk"));
    try std.testing.expectEqual(.failed, backend.endFrame());

    var span_out: [4]native_span_feed.SpanInfo = undefined;
    const count = feed.drainSpans(&span_out);
    try std.testing.expectEqual(@as(u32, 1), count);
    const pending_span = span_out[0].slice();
    try std.testing.expect(std.mem.indexOf(u8, pending_span, "pending") != null);
}

test "FeedBackend - writeOut keeps pending bytes when commit is blocked" {
    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 64;
    opts.initial_chunks = 2;
    opts.span_queue_capacity = 1;
    opts.auto_commit_on_full = 0;
    opts.growth_policy = @intFromEnum(native_span_feed.GrowthPolicy.block);

    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    defer feed.destroy();

    var backend = renderer.FeedBackend.create(feed);

    try feed.write("queued");
    try feed.commit();
    try std.testing.expect(backend.shouldSkipFrame());

    backend.writeOut("shutdown");
    try std.testing.expect(feed.hasPendingBytes());

    var span_out: [4]native_span_feed.SpanInfo = undefined;
    var count = feed.drainSpans(&span_out);
    try std.testing.expectEqual(@as(u32, 1), count);
    feed.markSpanConsumed(span_out[0]);

    try std.testing.expectEqual(.skipped, backend.prepareFrame());

    count = feed.drainSpans(&span_out);
    try std.testing.expectEqual(@as(u32, 1), count);
    try std.testing.expectEqualStrings("shutdown", span_out[0].slice());
}

test "FeedBackend - writeOutMultiple keeps partial pending batch bytes" {
    var opts = native_span_feed.defaultOptions();
    opts.chunk_size = 32;
    opts.initial_chunks = 1;
    opts.auto_commit_on_full = 0;

    const feed = try native_span_feed.Stream.create(std.testing.allocator, opts);
    defer feed.destroy();

    var backend = renderer.FeedBackend.create(feed);
    const failed_batch = [_][]const u8{
        "pending",
        "this-write-is-too-large-for-the-current-chunk",
    };

    backend.writeOutMultiple(&failed_batch);
    try std.testing.expect(feed.hasPendingBytes());

    try std.testing.expectEqual(.skipped, backend.prepareFrame());

    var span_out: [4]native_span_feed.SpanInfo = undefined;
    const count = feed.drainSpans(&span_out);
    try std.testing.expectEqual(@as(u32, 1), count);
    try std.testing.expectEqualStrings("pending", span_out[0].slice());
}

test "FeedBackend - supportsThreading is false" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    const feed = try native_span_feed.Stream.create(std.testing.allocator, null);
    var cli_renderer = try CliRenderer.createWithOptions(std.testing.allocator, 80, 24, pool, .{
        .remote_mode = .remote,
        .output = .{ .feed = feed },
    });
    // LIFO: renderer destroys first.
    defer feed.destroy();
    defer cli_renderer.destroy();

    try std.testing.expect(!cli_renderer.backend.supportsThreading());
    cli_renderer.setUseThread(true); // no-op on feed backend
    try std.testing.expect(!cli_renderer.backend.isUseThread());
}

test "two renderers on buffered backend have independent buffers" {
    // Independent output buffers prevent concurrent renderers from clobbering
    // each other's output.
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var test_r1 = try TestRenderer.create(std.testing.allocator, 80, 24, pool);
    defer test_r1.deinit();
    const r1 = test_r1.renderer;
    var test_r2 = try TestRenderer.create(std.testing.allocator, 80, 24, pool);
    defer test_r2.deinit();
    const r2 = test_r2.renderer;

    const fg = RGBA{ 1.0, 1.0, 1.0, 1.0 };
    const bg = RGBA{ 0.0, 0.0, 0.0, 1.0 };

    const b1 = r1.getNextBuffer();
    try b1.drawText("AAA", 0, 0, fg, bg, 0);
    _ = r1.render(false);

    const b2 = r2.getNextBuffer();
    try b2.drawText("BBB", 0, 0, fg, bg, 0);
    _ = r2.render(false);

    const out1 = test_r1.lastOutput();
    const out2 = test_r2.lastOutput();

    try std.testing.expect(std.mem.indexOf(u8, out1, "AAA") != null);
    try std.testing.expect(std.mem.indexOf(u8, out1, "BBB") == null);
    try std.testing.expect(std.mem.indexOf(u8, out2, "BBB") != null);
    try std.testing.expect(std.mem.indexOf(u8, out2, "AAA") == null);
}

test "threaded buffered destroy: no stale write after shutdown ANSI" {
    const pool = gp.initGlobalPool(std.testing.allocator);
    defer gp.deinitGlobalPool();
    _ = link.initGlobalLinkPool(std.testing.allocator);
    defer link.deinitGlobalLinkPool();

    var test_cli_renderer = try TestRenderer.createThreadSafe(std.testing.allocator, 80, 24, pool);
    defer test_cli_renderer.deinit();
    const cli_renderer = test_cli_renderer.renderer;

    cli_renderer.setUseThread(true);
    try std.testing.expect(cli_renderer.backend.isUseThread());

    const fg = RGBA{ 1.0, 1.0, 1.0, 1.0 };
    const bg = RGBA{ 0.0, 0.0, 0.0, 1.0 };
    const nb = cli_renderer.getNextBuffer();
    try nb.drawText("STALE", 0, 0, fg, bg, 0);
    _ = cli_renderer.render(false);

    // Toggle threading off and back on — flags must be reset so the new
    // thread waits for a real renderRequested rather than replaying the
    // stale currentOutputBuffer from the prior thread era.
    cli_renderer.setUseThread(false);
    try std.testing.expect(!cli_renderer.backend.isUseThread());

    cli_renderer.setUseThread(true);
    try std.testing.expect(cli_renderer.backend.isUseThread());

    // The protocol invariant we assert: setUseThread toggles do not panic
    // or deadlock, and internal state is clean for destroy() to run.
}

test "threaded buffered backend skips instead of blocking behind output" {
    var output = SlowThreadSafeOutput{ .delay_ns = 200 * std.time.ns_per_ms };
    var backend = try renderer.BufferedBackend.create(std.testing.allocator, output.bufferedOutput());
    defer backend.deinit(std.testing.allocator);
    backend.setUseThread(true);

    backend.beginFrame();
    try backend.writer().writeAll("large graphics frame");
    try std.testing.expectEqual(@import("../renderer-output.zig").WriteStatus.ok, backend.endFrame());

    var timer = try std.time.Timer.start();
    try std.testing.expectEqual(@import("../renderer-output.zig").WriteStatus.skipped, backend.prepareFrame());
    try std.testing.expect(timer.read() < 100 * std.time.ns_per_ms);

    backend.setUseThread(false);
    try std.testing.expectEqualStrings("large graphics frame", output.payloads[0][0..output.lengths[0]]);

    backend.setUseThread(true);
    backend.beginFrame();
    try std.testing.expectEqual(@import("../renderer-output.zig").WriteStatus.ok, backend.endFrame());

    backend.beginFrame();
    try backend.writer().writeAll("next graphics frame");
    try std.testing.expectEqual(@import("../renderer-output.zig").WriteStatus.ok, backend.endFrame());
    backend.setUseThread(false);
    try std.testing.expectEqual(@as(u32, 2), output.writes.load(.monotonic));
    try std.testing.expectEqualStrings("next graphics frame", output.payloads[1][0..output.lengths[1]]);
}
