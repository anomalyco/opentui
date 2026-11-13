//! The Markdown document ABI (`ot_markdown_*`, tracks/native-markdown-parser.md step M2).
const std = @import("std");
const c = @import("context_abi_c");
const abi = @import("context-abi.zig");
const context_mod = @import("context.zig");
const markdown = @import("markdown.zig");
const fail = @import("context-editor-abi.zig").fail;
const record = @import("context-editor-abi.zig").record;

comptime {
    for (.{
        .{ markdown.Kind.paragraph, c.OT_MD_PARAGRAPH }, .{ markdown.Kind.heading, c.OT_MD_HEADING },
        .{ markdown.Kind.code, c.OT_MD_CODE },           .{ markdown.Kind.html, c.OT_MD_HTML },
        .{ markdown.Kind.rule, c.OT_MD_RULE },           .{ markdown.Kind.table, c.OT_MD_TABLE },
        .{ markdown.Kind.table_row, c.OT_MD_TABLE_ROW }, .{ markdown.Kind.table_cell, c.OT_MD_TABLE_CELL },
        .{ markdown.Kind.quote, c.OT_MD_QUOTE },         .{ markdown.Kind.list, c.OT_MD_LIST },
        .{ markdown.Kind.item, c.OT_MD_ITEM },
    }) |pair| std.debug.assert(@backingInt(pair[0]) == pair[1]);
    std.debug.assert(@sizeOf(c.ot_markdown_block) == 32 and @sizeOf(c.ot_markdown_result) == 12);
    std.debug.assert(markdown.hook_filter_byte_count_max == c.OT_MD_HOOK_FILTER_BYTE_COUNT_MAX);
}

fn options(ptr: ?*const c.ot_markdown_options) !context_mod.MarkdownOptions {
    const value = try record(c.ot_markdown_options, ptr);
    if (value.reserved != 0 or value.hook_filter_byte_count > value.hook_filter.len) return error.InvalidOptions;
    const style = abi.handleFromC(value.syntax_style);
    return .{
        .flags = value.flags,
        .source_byte_limit = value.source_byte_limit,
        .syntax_style = if (style.context_id == 0 and style.slot == 0 and style.generation == 0) null else style,
        .hook_filter = value.hook_filter[0..value.hook_filter_byte_count],
    };
}

fn resultToC(result: context_mod.MarkdownResult, out: *c.ot_markdown_result) void {
    out.* = .{
        .changed_block_count = result.changed_block_count,
        .committed_top_level_count = result.committed_top_level_count,
        .removed_from_index = result.removed_from_index,
    };
}

fn call(context: ?*abi.ContextHandle, doc: ?*const c.ot_handle, request: context_mod.Context.MarkdownCall, out: ?*c.ot_markdown_result) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (doc == null or out == null) return fail(context, error.InvalidOptions);
    const result = context.?.core.markdownCall(abi.handleFromC(doc.?.*), request) catch |err| return fail(context, err);
    resultToC(result, out.?);
    return c.OT_OK;
}

fn bytesArgument(bytes: ?[*]const u8, count: u32) ![]const u8 {
    if (count != 0 and bytes == null) return error.InvalidOptions;
    return if (bytes) |p| p[0..count] else "";
}

pub fn ot_markdown_create(context: ?*abi.ContextHandle, options_ptr: ?*const c.ot_markdown_options, out: ?*c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    const value = options(options_ptr) catch |err| return fail(context, err);
    if (out == null) return fail(context, error.InvalidOptions);
    out.?.* = abi.handleToC(context.?.core.createMarkdown(value) catch |err| return fail(context, err));
    return c.OT_OK;
}

pub fn ot_markdown_destroy(context: ?*abi.ContextHandle, doc: ?*const c.ot_handle) callconv(.c) c.ot_status {
    return abi.destroyKind(context, doc, .markdown_doc);
}

pub fn ot_markdown_set_options(context: ?*abi.ContextHandle, doc: ?*const c.ot_handle, options_ptr: ?*const c.ot_markdown_options, out: ?*c.ot_markdown_result) callconv(.c) c.ot_status {
    const value = options(options_ptr) catch |err| return fail(context, err);
    return call(context, doc, .{ .options = value }, out);
}

pub fn ot_markdown_append(context: ?*abi.ContextHandle, doc: ?*const c.ot_handle, bytes: ?[*]const u8, byte_count: u32, out: ?*c.ot_markdown_result) callconv(.c) c.ot_status {
    return call(context, doc, .{ .append = bytesArgument(bytes, byte_count) catch |err| return fail(context, err) }, out);
}

pub fn ot_markdown_set(context: ?*abi.ContextHandle, doc: ?*const c.ot_handle, bytes: ?[*]const u8, byte_count: u32, out: ?*c.ot_markdown_result) callconv(.c) c.ot_status {
    return call(context, doc, .{ .set = bytesArgument(bytes, byte_count) catch |err| return fail(context, err) }, out);
}

pub fn ot_markdown_finish(context: ?*abi.ContextHandle, doc: ?*const c.ot_handle, out: ?*c.ot_markdown_result) callconv(.c) c.ot_status {
    return call(context, doc, .finish, out);
}

pub fn ot_markdown_get_source(context: ?*abi.ContextHandle, doc: ?*const c.ot_handle, out_bytes: ?*?[*]const u8, out_count: ?*u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (doc == null or out_bytes == null or out_count == null) return fail(context, error.InvalidOptions);
    const source = context.?.core.markdownSource(abi.handleFromC(doc.?.*)) catch |err| return fail(context, err);
    out_bytes.?.* = source.ptr;
    out_count.?.* = @intCast(source.len);
    return c.OT_OK;
}

fn blockToC(change: markdown.Doc.Change) c.ot_markdown_block {
    const b = change.block;
    const f = b.flags;
    var flags: u32 = 0;
    inline for (.{
        .{ f.closed, c.OT_MD_BLOCK_CLOSED },           .{ f.setext, c.OT_MD_BLOCK_SETEXT }, .{ f.ordered, c.OT_MD_BLOCK_ORDERED },
        .{ f.tight, c.OT_MD_BLOCK_TIGHT },             .{ f.task, c.OT_MD_BLOCK_TASK },     .{ f.checked, c.OT_MD_BLOCK_CHECKED },
        .{ f.blank_after, c.OT_MD_BLOCK_BLANK_AFTER }, .{ f.fenced, c.OT_MD_BLOCK_FENCED }, .{ f.hooked, c.OT_MD_BLOCK_HOOKED },
        .{ f.math, c.OT_MD_BLOCK_MATH },               .{ f.header, c.OT_MD_BLOCK_HEADER },
    }) |pair| {
        if (pair[0]) flags |= pair[1];
    }
    // A paragraph the pending line's layout ends is shown closed.
    if (f.open and !f.ending) flags |= c.OT_MD_BLOCK_OPEN;
    if (b.kind == .table_cell) flags |= switch (@as(markdown.Alignment, @fromBackingInt(@intCast(b.payload[1])))) {
        .none => 0,
        .left => c.OT_MD_BLOCK_ALIGN_LEFT,
        .right => c.OT_MD_BLOCK_ALIGN_RIGHT,
        .center => c.OT_MD_BLOCK_ALIGN_LEFT | c.OT_MD_BLOCK_ALIGN_RIGHT,
    };
    const fenced = b.kind == .code and f.fenced;
    const numbered = switch (b.kind) {
        .heading, .list, .table, .table_cell => true,
        else => false,
    };
    return .{
        .index = change.index,
        .parent_index = b.parent_index,
        .kind = @backingInt(b.kind),
        .flags = @intCast(flags),
        .source_start_byte = b.source_start_byte,
        .source_end_byte = b.source_end_byte,
        .info_start_byte = if (fenced) b.payload[0] else b.source_start_byte,
        .info_end_byte = if (fenced) b.payload[1] else b.source_start_byte,
        .number = if (numbered) b.payload[0] else 0,
    };
}

pub fn ot_markdown_read_changes(context: ?*abi.ContextHandle, doc: ?*const c.ot_handle, blocks: ?[*]c.ot_markdown_block, capacity: u32, out_count: ?*u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (doc == null or out_count == null or (capacity != 0 and blocks == null)) return fail(context, error.InvalidOptions);
    const read = context.?.core.markdownReadChanges(abi.handleFromC(doc.?.*), capacity) catch |err| return fail(context, err);
    for (read.changes, 0..) |change, index| blocks.?[index] = blockToC(change);
    out_count.?.* = read.count;
    return c.OT_OK;
}

pub fn ot_markdown_read_leaf(
    context: ?*abi.ContextHandle,
    doc: ?*const c.ot_handle,
    block_index: u32,
    bytes: ?[*]u8,
    byte_capacity: u32,
    out_byte_count: ?*u32,
    chunks: ?[*]c.ot_styled_text_chunk,
    spans: ?[*]u32,
    chunk_capacity: u32,
    out_chunk_count: ?*u32,
    urls: ?[*]u8,
    url_byte_capacity: u32,
    out_url_byte_count: ?*u32,
) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (doc == null or out_byte_count == null or out_chunk_count == null or out_url_byte_count == null or
        (byte_capacity != 0 and bytes == null) or (chunk_capacity != 0 and chunks == null) or (url_byte_capacity != 0 and urls == null))
    {
        return fail(context, error.InvalidOptions);
    }
    const read = context.?.core.markdownReadLeaf(abi.handleFromC(doc.?.*), block_index) catch |err| return fail(context, err);
    const leaf = read.leaf;
    const counts = [3]usize{ leaf.bytes.items.len, leaf.chunks.items.len, leaf.urls.items.len };
    const report = byte_capacity == 0 and chunk_capacity == 0 and url_byte_capacity == 0;
    if (!report and (byte_capacity < counts[0] or chunk_capacity < counts[1] or url_byte_capacity < counts[2])) {
        return fail(context, error.BufferTooSmall);
    }
    if (!report) {
        // Resolve every chunk before writing any output.
        var values: [64]c.ot_styled_text_chunk = undefined;
        var done: usize = 0;
        while (done < counts[1]) {
            const batch = @min(values.len, counts[1] - done);
            for (leaf.chunks.items[done..][0..batch], values[0..batch]) |chunk, *value| {
                const definition = read.doc.resolve(chunk.scope) catch |err| return fail(context, err);
                var flags: u32 = 0;
                if (definition.fg != null) flags |= c.OT_SCENE_TEXT_FOREGROUND;
                if (definition.bg != null) flags |= c.OT_SCENE_TEXT_BACKGROUND;
                if (chunk.link_byte_count != 0) flags |= c.OT_SCENE_TEXT_LINK;
                value.* = .{
                    .struct_size = @sizeOf(c.ot_styled_text_chunk),
                    .abi_version = c.OT_CONTEXT_ABI_VERSION,
                    .byte_count = chunk.byte_count,
                    .flags = flags,
                    .foreground = definition.fg orelse .{ 0, 0, 0, 0 },
                    .background = definition.bg orelse .{ 0, 0, 0, 0 },
                    .attributes = definition.attributes & 0xFF,
                    .reserved = 0,
                    .link_offset = chunk.link_offset,
                    .link_byte_count = chunk.link_byte_count,
                };
            }
            @memcpy(chunks.?[done..][0..batch], values[0..batch]);
            if (spans) |out| for (leaf.chunks.items[done..][0..batch], out[done..][0..batch]) |chunk, *span| {
                span.* = @as(u32, @bitCast(chunk.span));
            };
            done += batch;
        }
        if (counts[0] > 0) @memcpy(bytes.?[0..counts[0]], leaf.bytes.items);
        if (counts[2] > 0) @memcpy(urls.?[0..counts[2]], leaf.urls.items);
    }
    out_byte_count.?.* = @intCast(counts[0]);
    out_chunk_count.?.* = @intCast(counts[1]);
    out_url_byte_count.?.* = @intCast(counts[2]);
    return c.OT_OK;
}

pub fn ot_markdown_read_source(context: ?*abi.ContextHandle, doc: ?*const c.ot_handle, block_index: u32, bytes: ?[*]u8, capacity: u32, out_count: ?*u32) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (doc == null or out_count == null or (capacity != 0 and bytes == null)) return fail(context, error.InvalidOptions);
    const source = context.?.core.markdownReadSource(abi.handleFromC(doc.?.*), block_index) catch |err| return fail(context, err);
    if (capacity != 0 and capacity < source.len) return fail(context, error.BufferTooSmall);
    if (capacity != 0 and source.len > 0) @memcpy(bytes.?[0..source.len], source);
    out_count.?.* = @intCast(source.len);
    return c.OT_OK;
}

pub fn ot_markdown_bind(context: ?*abi.ContextHandle, doc: ?*const c.ot_handle, block_index: u32, node: ?*const c.ot_handle) callconv(.c) c.ot_status {
    const status = abi.sessionContextStatus(context);
    if (status != c.OT_OK) return status;
    if (doc == null or node == null) return fail(context, error.InvalidOptions);
    context.?.core.markdownBind(abi.handleFromC(doc.?.*), block_index, abi.handleFromC(node.?.*)) catch |err| return fail(context, err);
    return c.OT_OK;
}
