const std = @import("std");
const text_buffer = @import("../text-buffer.zig");
const editor_view = @import("../editor-view.zig");
const link = @import("../link.zig");
const ansi = @import("../ansi.zig");

const TextBuffer = text_buffer.UnifiedTextBuffer;
const SyntaxStyle = text_buffer.SyntaxStyle;
const RGBA = text_buffer.RGBA;
const EditorView = editor_view.EditorView;

pub const Part = struct {
    text: []const u8,
    fg: ?RGBA = null,
    bg: ?RGBA = null,
    attributes: u32 = 0,
    url: []const u8 = "",
};

pub const Result = struct {
    mem_id: u8,
    style: *SyntaxStyle,
};

const Prepared = struct {
    text: []u8,
    style: *SyntaxStyle,
    ranges: []text_buffer.OwnedStyledChunk,
    links: link.LinkTracker,
};

pub fn replace(tb: *TextBuffer, mem_id: ?u8, parts: []const Part) !Result {
    const allocator = tb.global_allocator;
    var prepared = try prepareParts(allocator, tb, parts);
    defer allocator.free(prepared.ranges);
    defer prepared.links.deinit();
    errdefer {
        prepared.style.deinit();
        allocator.free(prepared.text);
    }
    const links = if (prepared.links.getLinkCount() == 0) null else &prepared.links;
    return .{
        .mem_id = try tb.replaceOwnedStyledText(prepared.text, mem_id, prepared.style, prepared.ranges, links),
        .style = prepared.style,
    };
}

pub fn replaceInPlace(tb: *TextBuffer, current: *?Result, parts: []const Part) !void {
    const next = try replace(tb, if (current.*) |c| c.mem_id else null, parts);
    if (current.*) |c| c.style.deinit();
    current.* = next;
}

pub fn setPlaceholder(ev: *EditorView, parts: []const Part) !void {
    if (parts.len == 0) {
        ev.clearPlaceholder();
        return;
    }
    const allocator = ev.global_allocator;
    var prepared = try prepareParts(allocator, ev.edit_buffer.tb, parts);
    defer allocator.free(prepared.ranges);
    defer prepared.links.deinit();
    errdefer {
        prepared.style.deinit();
        allocator.free(prepared.text);
    }
    const links = if (prepared.links.getLinkCount() == 0) null else &prepared.links;
    try ev.setPlaceholderOwnedStyledText(prepared.text, prepared.style, prepared.ranges, links);
}

fn prepareParts(allocator: std.mem.Allocator, tb: *const TextBuffer, parts: []const Part) !Prepared {
    const style = try SyntaxStyle.init(allocator);
    errdefer style.deinit();
    var prepared_links = link.LinkTracker.init(allocator, tb.link_pool);
    errdefer prepared_links.deinit();

    var total_len: usize = 0;
    var range_count: usize = 0;
    for (parts) |part| {
        total_len += part.text.len;
        if (part.text.len != 0) range_count += 1;
    }

    const ranges = try allocator.alloc(text_buffer.OwnedStyledChunk, range_count);
    errdefer allocator.free(ranges);
    const text = try allocator.alloc(u8, total_len);
    errdefer allocator.free(text);

    var offset: usize = 0;
    var range_index: usize = 0;
    for (parts, 0..) |part, index| {
        @memcpy(text[offset..][0..part.text.len], part.text);
        offset += part.text.len;
        if (part.text.len == 0) continue;

        const width = tb.measureText(part.text);
        var attributes = part.attributes;
        if (width > 0 and part.url.len != 0) {
            const id = try prepared_links.trackUrl(part.url);
            attributes = ansi.TextAttributes.setLinkId(attributes, id);
        }
        var name_buffer: [32]u8 = undefined;
        const name = try std.fmt.bufPrint(&name_buffer, "chunk{d}", .{index});
        ranges[range_index] = .{
            .byte_count = @intCast(part.text.len),
            .style_id = if (width == 0) 0 else try style.registerStyle(name, part.fg, part.bg, attributes),
        };
        range_index += 1;
    }

    return .{
        .text = text,
        .style = style,
        .ranges = ranges,
        .links = prepared_links,
    };
}
