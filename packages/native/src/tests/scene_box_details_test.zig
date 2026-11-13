const std = @import("std");
const repaint = @import("scene_fixture_test.zig").repaint;
const present = @import("scene_fixture_test.zig").present;
const testing = std.testing;
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const buffer = @import("../buffer.zig");

const options: scene.FrameOptions = .{
    .background = .{ 0, 0, 0, 255 },
    .use_mouse = true,
    .excluded_hit_num = 0,
    .max_layout_rounds = 8,
    .max_host_requests = 64,
};
const custom = [11]u32{ 'A', 'B', 'C', 'D', '-', '|', '+', '+', '+', '+', '+' };
const indexed = @import("../ansi.zig").indexedColor(42, 0, 200, 0);
const utils = @import("../utils.zig");

const Fixture = struct { session: context.Handle, root: context.Handle, box: context.Handle };

fn setup(owner: *context.Context) !Fixture {
    const id = try owner.createSession(.{ .chunk_size = 4096 });
    try owner.attachSessionRenderer(id, 16, 5, .{ .remote_mode = .remote });
    const root = try owner.sceneCreateNode(id, 0, 1);
    const box = try owner.sceneCreateNode(id, 1, 2);
    try owner.sceneSetStyle(box, 4, 0, 0, 1, 12, 1);
    try owner.sceneSetStyle(box, 4, 1, 0, 1, 3, 1);
    try owner.sceneSetPaint(box, .{ .borderSides = 15 });
    try owner.sceneMoveNode(box, root, 0);
    return .{ .session = id, .root = root, .box = box };
}

fn expectRow(target: *buffer.OptimizedBuffer, y: u32, text: []const u8) !void {
    for (text, 0..) |char, x| try testing.expectEqual(@as(u32, char), target.get(@intCast(x), y).?.char);
}

const c = @import("context_abi_c");
const ansi = @import("../ansi.zig");

/// Styles in OT_BORDER_* order: single, double, rounded, heavy.
const horizontals = [4]u32{ '─', '═', '─', '━' };
const verticals = [4]u32{ '│', '║', '│', '┃' };

/// Corners (top-left, top-right, bottom-left, bottom-right) where top and bottom sides of
/// the first style meet left and right sides of the second: Unicode's mixed glyph where one
/// exists (rounded strokes are light), otherwise the top or bottom side's own corner.
const joins = [4][4][4]u32{
    .{ .{ '┌', '┐', '└', '┘' }, .{ '╓', '╖', '╙', '╜' }, .{ '┌', '┐', '└', '┘' }, .{ '┎', '┒', '┖', '┚' } },
    .{ .{ '╒', '╕', '╘', '╛' }, .{ '╔', '╗', '╚', '╝' }, .{ '╒', '╕', '╘', '╛' }, .{ '╔', '╗', '╚', '╝' } },
    .{ .{ '╭', '╮', '╰', '╯' }, .{ '╓', '╖', '╙', '╜' }, .{ '╭', '╮', '╰', '╯' }, .{ '┎', '┒', '┖', '┚' } },
    .{ .{ '┍', '┑', '┕', '┙' }, .{ '┏', '┓', '┗', '┛' }, .{ '┍', '┑', '┕', '┙' }, .{ '┏', '┓', '┗', '┛' } },
};

/// Overrides every side's style; styles are given top, right, bottom, left.
fn styled(top: u32, right: u32, bottom: u32, left: u32) scene.BoxSides {
    return .{ .style_sides = c.OT_BORDER_ALL, .styles = .{ left, bottom, right, top } };
}

fn corners(target: *buffer.OptimizedBuffer) [4]u32 {
    return .{ target.get(0, 0).?.char, target.get(11, 0).?.char, target.get(0, 2).?.char, target.get(11, 2).?.char };
}

test "Scene box sides join every pair of styles at each corner, and an absent side leaves no join" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner);
    const target = (try owner.raw().getSessionRenderer(fixture.session)).getNextBuffer();
    for (0..4) |horizontal| for (0..4) |vertical| {
        const h: u32 = @intCast(horizontal);
        const v: u32 = @intCast(vertical);
        try owner.sceneSetBoxSides(fixture.box, styled(h, v, h, v));
        try repaint(owner, fixture.session, options.background, true, 0);
        try testing.expectEqual(joins[h][v], corners(target));
        for ([_][2]u32{ .{ 5, 0 }, .{ 5, 2 } }) |cell| try testing.expectEqual(horizontals[h], target.get(cell[0], cell[1]).?.char);
        for ([_][2]u32{ .{ 0, 1 }, .{ 11, 1 } }) |cell| try testing.expectEqual(verticals[v], target.get(cell[0], cell[1]).?.char);
        if (h != v) continue;
        // Overrides equal to the paint draw what the uniform box draws.
        const sides_frame = try testing.allocator.dupe(u32, target.buffer.char);
        defer testing.allocator.free(sides_frame);
        try owner.sceneSetBoxSides(fixture.box, .{});
        try owner.sceneSetPaint(fixture.box, .{ .borderSides = 15, .borderStyle = h });
        try repaint(owner, fixture.session, options.background, true, 0);
        try testing.expectEqualSlices(u32, sides_frame, target.buffer.char);
        try owner.sceneSetPaint(fixture.box, .{ .borderSides = 15 });
    };
    // Each corner joins its own two sides; a side that is off leaves its neighbor's line or end.
    const rows = [_]struct { mask: u32, sides: scene.BoxSides, corners: [4]u32 }{
        .{ .mask = 15, .sides = styled(1, 3, 3, 0), .corners = .{ '╒', '╗', '┕', '┛' } },
        .{ .mask = 15 & ~c.OT_BORDER_LEFT, .sides = styled(1, 3, 3, 0), .corners = .{ '═', '╗', '━', '┛' } },
        .{ .mask = 15 & ~c.OT_BORDER_TOP, .sides = styled(1, 3, 3, 0), .corners = .{ '│', '┃', '┕', '┛' } },
        .{ .mask = c.OT_BORDER_TOP | c.OT_BORDER_LEFT, .sides = styled(3, 1, 1, 1), .corners = .{ '┏', '━', '║', ' ' } },
        // Custom glyphs win over side styles.
        .{ .mask = 15, .sides = styled(1, 3, 3, 0), .corners = .{ 'A', 'B', 'C', 'D' } },
    };
    for (rows, 0..) |row, index| {
        try owner.sceneSetPaint(fixture.box, .{ .borderSides = row.mask });
        try owner.sceneSetBoxSides(fixture.box, row.sides);
        if (index == rows.len - 1) try owner.sceneSetBoxDetails(fixture.box, .{ .custom_border_chars = custom });
        try repaint(owner, fixture.session, options.background, true, 0);
        try testing.expectEqual(row.corners, corners(target));
    }
}

test "Scene box sides color each side, corners and titles by their top or bottom side, and focus colors all" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner);
    const target = (try owner.raw().getSessionRenderer(fixture.session)).getNextBuffer();
    const red = ansi.rgbColor(255, 0, 0, 255);
    const green = ansi.rgbColor(0, 255, 0, 255);
    const blue = ansi.rgbColor(0, 0, 255, 255);
    const yellow = ansi.rgbColor(255, 255, 0, 255);
    try owner.sceneSetPaint(fixture.box, .{ .borderSides = 15, .focusable = true });
    try owner.sceneSetBoxSides(fixture.box, .{ .color_sides = c.OT_BORDER_ALL, .colors = .{ yellow, blue, green, red } });
    try owner.sceneSetBoxDetails(fixture.box, .{ .title = "t", .bottom_title = "b" });
    // Cells: top line, right line, bottom line, left line, the four corners, both titles.
    const cells = [_][2]u32{ .{ 5, 0 }, .{ 11, 1 }, .{ 5, 2 }, .{ 0, 1 }, .{ 0, 0 }, .{ 11, 0 }, .{ 0, 2 }, .{ 11, 2 }, .{ 2, 0 }, .{ 2, 2 } };
    const focus = (scene.Paint{}).focusedBorderColor;
    const rows = [_]struct { title_color: ?ansi.RGBA = null, focused: bool = false, colors: [cells.len]ansi.RGBA }{
        .{ .colors = .{ red, green, blue, yellow, red, red, blue, blue, red, blue } },
        .{ .title_color = green, .colors = .{ red, green, blue, yellow, red, red, blue, blue, green, green } },
        .{ .focused = true, .colors = @splat(focus) },
    };
    for (rows) |row| {
        try owner.sceneSetBoxDetails(fixture.box, .{ .title = "t", .bottom_title = "b", .title_color = row.title_color });
        try owner.sceneSetFocus(fixture.box, row.focused);
        try repaint(owner, fixture.session, options.background, true, 0);
        try testing.expectEqual('t', target.get(2, 0).?.char);
        for (cells, row.colors) |cell, color| try testing.expectEqual(color, target.get(cell[0], cell[1]).?.fg);
    }
}

test "Scene box sides blend a translucent side as a uniform box of its color does" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner);
    const target = (try owner.raw().getSessionRenderer(fixture.session)).getNextBuffer();
    const translucent = ansi.rgbColor(200, 100, 50, 128);
    const white = (scene.Paint{}).borderColor;
    for ([_]ansi.RGBA{ .{ 0, 0, 0, 0 }, .{ 20, 20, 20, 255 } }) |background| {
        try owner.sceneSetPaint(fixture.box, .{ .borderSides = 15, .borderColor = translucent, .background = background });
        try repaint(owner, fixture.session, options.background, true, 0);
        const left = target.get(0, 1).?;
        try owner.sceneSetPaint(fixture.box, .{ .borderSides = 15, .background = background });
        try owner.sceneSetBoxSides(fixture.box, .{ .color_sides = c.OT_BORDER_LEFT, .colors = .{ translucent, @splat(0), @splat(0), @splat(0) } });
        try repaint(owner, fixture.session, options.background, true, 0);
        try testing.expectEqual(left, target.get(0, 1).?);
        try testing.expectEqual(white, target.get(5, 0).?.fg);
        try owner.sceneSetBoxSides(fixture.box, .{});
    }
}

test "Scene box sides validate, survive details and mask changes, repaint live, and free when cleared" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner);
    const red = ansi.rgbColor(255, 0, 0, 255);
    var invalid = [_]scene.BoxSides{
        .{ .style_sides = 16 },
        .{ .color_sides = 16 },
        .{ .style_sides = c.OT_BORDER_TOP, .styles = .{ 0, 0, 0, 4 } },
        .{ .styles = .{ 0, 0, 0, 1 } },
        .{ .colors = .{ @splat(0), @splat(0), @splat(0), red } },
        .{ .color_sides = c.OT_BORDER_TOP, .colors = .{ @splat(0), @splat(0), @splat(0), .{ 256, 0, 0, 255 } } },
    };
    for (&invalid) |sides| try testing.expectError(error.InvalidOptions, owner.sceneSetBoxSides(fixture.box, sides));
    try testing.expectError(error.WrongKind, owner.sceneSetBoxSides(fixture.root, styled(1, 1, 1, 1)));
    const node = (try owner.raw().getRenderable(fixture.box)).scene_node.?;
    try testing.expect(node.control.box.sides == null);

    var sides = styled(1, 0, 0, 0);
    sides.color_sides = c.OT_BORDER_TOP;
    sides.colors[3] = red;
    try owner.sceneSetBoxSides(fixture.box, sides);
    try owner.sceneSetBoxDetails(fixture.box, .{ .title = "x" });
    try owner.scenePatchPaint(fixture.box, c.OT_SCENE_PROPERTY_BORDER, .{ .borderSides = c.OT_BORDER_TOP });
    try owner.scenePatchPaint(fixture.box, c.OT_SCENE_PROPERTY_BORDER, .{ .borderSides = 15 });
    try repaint(owner, fixture.session, options.background, true, 0);
    _ = try present(owner, fixture.session, true);
    var bytes: [16 * 1024]u8 = undefined;
    while (try owner.readOutput(fixture.session, &bytes)) |ticket| try owner.completeOutput(fixture.session, ticket, .written);
    var target = (try owner.raw().getSessionRenderer(fixture.session)).getCurrentBuffer();
    for ([_]u32{ '╒', '═', 'x' }, 0..) |char, x| try testing.expectEqual(char, target.get(@intCast(x), 0).?.char);
    try testing.expectEqual(red, target.get(0, 0).?.fg);
    try testing.expectEqual(red, target.get(2, 0).?.fg);

    // A live change of one side's style and color paints in the next ordinary frame.
    sides.styles[3] = 3;
    sides.colors[3] = ansi.rgbColor(0, 255, 0, 255);
    try owner.sceneSetBoxSides(fixture.box, sides);
    try testing.expectEqual(@as(u32, 0), (try owner.sceneFrameStep(fixture.session, null, options)).kind);
    target = (try owner.raw().getSessionRenderer(fixture.session)).getNextBuffer();
    try testing.expectEqual(@as(u32, '┍'), target.get(0, 0).?.char);
    try testing.expectEqual(sides.colors[3], target.get(5, 0).?.fg);

    // Clearing either record frees it and keeps the other.
    try owner.sceneSetBoxSides(fixture.box, .{});
    try testing.expect(node.control.box.sides == null);
    try testing.expectEqualStrings("x", node.control.box.details.?.title);
    try owner.sceneSetBoxSides(fixture.box, sides);
    try owner.sceneSetBoxDetails(fixture.box, .{});
    try testing.expect(node.control.box.details == null);
    try testing.expectEqual(sides, node.control.box.sides.?.*);
}

test "Scene box details rejects invalid replacement before publication" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner);
    try owner.sceneSetBoxDetails(fixture.box, .{ .title = "old", .custom_border_chars = custom });
    try testing.expectError(error.WrongKind, owner.sceneSetBoxDetails(fixture.root, .{ .title = "bad" }));
    for ([_][]const u8{ "\xff", "a\xc0\xaf", "\xc2" }) |invalid| {
        try testing.expectError(error.InvalidUnicode, owner.sceneSetBoxDetails(fixture.box, .{ .title = invalid }));
        try testing.expectError(error.InvalidUnicode, owner.sceneSetBoxDetails(fixture.box, .{ .bottom_title = invalid }));
    }
    try testing.expectError(error.InvalidOptions, owner.sceneSetBoxDetails(fixture.box, .{ .title_alignment = 3 }));
    try testing.expectError(error.InvalidOptions, owner.sceneSetBoxDetails(fixture.box, .{ .bottom_title_alignment = 3 }));
    for ([_]u32{ 0, 0x0301, 0x4e16, 0xd800, 0x110000, 0xffffffff }) |invalid| {
        var chars = custom;
        chars[4] = invalid;
        try testing.expectError(error.InvalidUnicode, owner.sceneSetBoxDetails(fixture.box, .{ .custom_border_chars = chars }));
    }
    const oversized = utils.repeat(u8, "a", buffer.text_bytes_max + 1);
    try testing.expectError(error.TextLimit, owner.sceneSetBoxDetails(fixture.box, .{ .title = oversized }));
    try repaint(owner, fixture.session, options.background, true, 0);
    try expectRow((try owner.raw().getSessionRenderer(fixture.session)).getNextBuffer(), 0, "A-old------B");
    // Titles keep controls; checked text gives them zero width when it draws the title.
    try owner.sceneSetBoxDetails(fixture.box, .{ .title = "o\nl\x1b\u{85}d", .custom_border_chars = custom });
    try repaint(owner, fixture.session, options.background, true, 0);
    try expectRow((try owner.raw().getSessionRenderer(fixture.session)).getNextBuffer(), 0, "A-old------B");
}

fn replaceTitles(allocator: std.mem.Allocator) !void {
    const owner = try context.Context.init(allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner);
    try owner.sceneSetBoxDetails(fixture.box, .{ .title = "old", .bottom_title = "old", .custom_border_chars = custom });
    const details = (try owner.raw().getRenderable(fixture.box)).scene_node.?.control.box.details.?;
    owner.sceneSetBoxDetails(fixture.box, .{ .title = "new", .bottom_title = "new", .custom_border_chars = custom }) catch |err| {
        try testing.expectEqualStrings("old", details.title);
        try testing.expectEqualStrings("old", details.bottom_title);
        return err;
    };
}

test "Scene box details allocation failure preserves old titles and releases replacements" {
    try testing.checkAllAllocationFailures(testing.allocator, replaceTitles, .{});
}

test "Scene box details and paint replaced during a record batch paint live and destroyed boxes own nothing" {
    for (0..4) |exit| {
        const owner = try context.Context.init(testing.allocator, testing.io, .{});
        defer owner.deinit() catch unreachable;
        const fixture = try setup(owner);
        try owner.sceneSetBoxDetails(fixture.box, .{ .title = "old", .custom_border_chars = custom });
        try owner.sceneSetHooks(fixture.box, 24, 1, 12, 3);
        const request = try owner.sceneFrameStep(fixture.session, null, options);
        try testing.expectEqual(@as(u32, @import("context_abi_c").OT_SCENE_FRAME_RECORD), request.kind);
        var top = "new".*;
        var bottom = "end".*;
        try owner.sceneSetBoxDetails(fixture.box, .{ .title = &top, .bottom_title = &bottom, .custom_border_chars = custom });
        try owner.scenePatchPaint(fixture.box, @import("context_abi_c").OT_SCENE_PROPERTY_BACKGROUND, .{ .background = indexed });
        @memset(&top, 'x');
        @memset(&bottom, 'x');
        if (exit != 3) try owner.sceneDestroyNode(fixture.box);
        if (exit == 0) {
            try owner.sceneFrameCancel(fixture.session, request.frame_id);
            continue;
        }
        if (exit == 1) continue;
        if (exit == 2) {
            try owner.sceneDestroyNode(fixture.root);
            try testing.expectError(error.StaleFrame, owner.sceneFrameStepWithRecording(fixture.session, request, options, &.{}));
            continue;
        }
        const done = try owner.sceneFrameStepWithRecording(fixture.session, request, options, &.{});
        try testing.expectEqual(@as(u32, 0), done.kind);
        const target = (try owner.raw().getSessionRenderer(fixture.session)).getNextBuffer();
        try expectRow(target, 0, "A-new------B");
        try expectRow(target, 2, "C-end------D");
        try testing.expectEqual(indexed, target.get(1, 1).?.bg);
    }
}

test "Scene box details checked title draw reports allocation failure and default boxes allocate nothing" {
    const owner = try context.Context.init(testing.allocator, testing.io, .{});
    defer owner.deinit() catch unreachable;
    const fixture = try setup(owner);
    try owner.resizeSessionRenderer(fixture.session, 5000, 5);
    try owner.sceneSetStyle(fixture.box, 4, 0, 0, 1, 5000, 1);
    try repaint(owner, fixture.session, options.background, true, 0);
    const state = (try owner.raw().getSession(fixture.session)).scene.?;
    const target = (try owner.raw().getSessionRenderer(fixture.session)).getNextBuffer();
    var failing = testing.FailingAllocator.init(testing.allocator, .{ .fail_index = 0 });
    const allocator = target.allocator;
    target.allocator = failing.allocator();
    defer target.allocator = allocator;
    const scene_allocator = state.allocator;
    state.allocator = failing.allocator();
    defer state.allocator = scene_allocator;
    try repaint(owner, fixture.session, options.background, true, 0);
    try testing.expect(!failing.has_induced_failure);
    state.allocator = scene_allocator;
    // A printable ASCII title draws without the prepared copy and runs.
    const ascii_title: [4097]u8 = @splat('x');
    try owner.sceneSetBoxDetails(fixture.box, .{ .title = &ascii_title });
    try repaint(owner, fixture.session, options.background, true, 0);
    try testing.expect(!failing.has_induced_failure);
    // Keep a visible title large enough to exercise heap fallback, not the stack path.
    const title = @as([4096]u8, @splat('x')) ++ "\u{e9}".*;
    try owner.sceneSetBoxDetails(fixture.box, .{ .title = &title });
    try testing.expectError(error.OutOfMemory, repaint(owner, fixture.session, options.background, true, 0));
    try testing.expect(failing.has_induced_failure);
    try testing.expect(state.attempt == null);
    for (target.buffer.char) |char| try testing.expectEqual(@as(u32, ' '), char);
    target.allocator = allocator;
    try repaint(owner, fixture.session, options.background, true, 0);
    try testing.expectEqual(@as(u32, 'x'), target.get(2, 0).?.char);
}
