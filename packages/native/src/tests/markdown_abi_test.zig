//! The Markdown ABI (step M2): a host that learns blocks only from read_changes holds what a
//! fresh document given the whole text lists, under every option set; bound scene text nodes
//! show read_leaf, bytes and styles, after every call; host-written modes, removals, styles and
//! rejections.
const std = @import("std");
const c = @import("context_abi_c");
const abi = @import("../context-abi.zig");
const md = @import("../context-markdown-abi.zig");
const context_mod = @import("../context.zig");
const markdown = @import("../markdown.zig");
const soup = @import("markdown_test.zig").soup;

const Fixture = struct {
    context: *abi.ContextHandle,
    session: c.ot_handle,
    style: c.ot_handle,
    doc: c.ot_handle,
    next_num: u32 = 1,

    fn init(flags: u32) !Fixture {
        return initWith(.{ .flags = flags });
    }

    fn initWith(set: OptionSet) !Fixture {
        const context = try abi.createTestContext(.{ .object_capacity = 64, .render_cells_max = 800 });
        errdefer _ = abi.ot_context_destroy(context);
        const session = try context.core.createSession(.{});
        try context.core.attachSessionRenderer(session, 40, 20, .{ .remote_mode = .remote });
        var self: Fixture = .{ .context = context, .session = abi.handleToC(session), .style = undefined, .doc = undefined };
        var root: c.ot_handle = undefined;
        try expectOk(abi.ot_scene_create_node(context, &self.session, c.OT_SCENE_ROOT, self.next_num, &root));
        self.next_num += 1;
        try expectOk(abi.ot_syntax_style_create(context, &self.style));
        // Names of each kind of field, so a wrong scope shows as a wrong style.
        for ([_]struct { []const u8, u32, [4]u16 }{
            .{ "markup.strong", 1, .{ 9, 0, 0, 255 } },    .{ "markup.italic", 4, .{ 0, 0, 0, 0 } },
            .{ "markup.raw", 0, .{ 0, 9, 0, 255 } },       .{ "markup.link.label", 8, .{ 0, 0, 9, 255 } },
            .{ "markup.heading.1", 1, .{ 7, 7, 0, 255 } }, .{ "markup.strikethrough", 128, .{ 0, 0, 0, 0 } },
            .{ "string.escape", 0, .{ 5, 5, 5, 255 } },    .{ "markup.link", 0, .{ 6, 0, 0, 255 } },
            .{ "markup.link.url", 0, .{ 3, 3, 3, 255 } },
        }) |entry| try self.register(entry[0], entry[1], entry[2]);
        var options = set.options(self.style);
        try expectOk(md.ot_markdown_create(context, &options, &self.doc));
        return self;
    }

    fn deinit(self: *Fixture) void {
        std.testing.expectEqual(c.OT_OK, abi.ot_context_destroy(self.context)) catch unreachable;
    }

    fn register(self: *Fixture, name: []const u8, attributes: u32, fg: [4]u16) !void {
        var definition = std.mem.zeroes(c.ot_editor_style);
        definition.struct_size = @sizeOf(c.ot_editor_style);
        definition.abi_version = c.OT_CONTEXT_ABI_VERSION;
        definition.flags = c.OT_EDITOR_STYLE_ATTRIBUTES | if (fg[3] != 0) c.OT_EDITOR_STYLE_FOREGROUND else 0;
        definition.attributes = attributes;
        definition.foreground = fg;
        var id: u32 = 0;
        try expectOk(@import("../context-editor-abi.zig").ot_syntax_style_register(self.context, &self.style, name.ptr, @intCast(name.len), &definition, &id));
    }

    fn textNode(self: *Fixture) !c.ot_handle {
        var node: c.ot_handle = undefined;
        try expectOk(abi.ot_scene_create_node(self.context, &self.session, c.OT_SCENE_TEXT, self.next_num, &node));
        self.next_num += 1;
        return node;
    }

    fn append(self: *Fixture, bytes: []const u8) !c.ot_markdown_result {
        var result: c.ot_markdown_result = undefined;
        try expectOk(md.ot_markdown_append(self.context, &self.doc, bytes.ptr, @intCast(bytes.len), &result));
        return result;
    }

    fn source(self: *Fixture) ![]const u8 {
        var bytes: [*c]const u8 = undefined;
        var count: u32 = 0;
        try expectOk(md.ot_markdown_get_source(self.context, &self.doc, &bytes, &count));
        return bytes[0..count];
    }

    fn changes(self: *Fixture, arena: std.mem.Allocator) ![]c.ot_markdown_block {
        var count: u32 = 0;
        try expectOk(md.ot_markdown_read_changes(self.context, &self.doc, null, 0, &count));
        const blocks = try arena.alloc(c.ot_markdown_block, count);
        if (count > 0) try expectOk(md.ot_markdown_read_changes(self.context, &self.doc, blocks.ptr, count, &count));
        return blocks;
    }

    const Leaf = struct { bytes: []u8, chunks: []c.ot_styled_text_chunk, spans: []u32, urls: []u8 };

    fn readLeaf(self: *Fixture, arena: std.mem.Allocator, index: u32) !Leaf {
        var counts: [3]u32 = undefined;
        try expectOk(md.ot_markdown_read_leaf(self.context, &self.doc, index, null, 0, &counts[0], null, null, 0, &counts[1], null, 0, &counts[2]));
        const leaf: Leaf = .{ .bytes = try arena.alloc(u8, counts[0]), .chunks = try arena.alloc(c.ot_styled_text_chunk, counts[1]), .spans = try arena.alloc(u32, counts[1]), .urls = try arena.alloc(u8, counts[2]) };
        if (counts[0] + counts[1] + counts[2] > 0) {
            try expectOk(md.ot_markdown_read_leaf(self.context, &self.doc, index, leaf.bytes.ptr, counts[0], &counts[0], leaf.chunks.ptr, leaf.spans.ptr, counts[1], &counts[1], leaf.urls.ptr, counts[2], &counts[2]));
        }
        return leaf;
    }

    /// Whether the node shows read_leaf: its text, and per byte the style its Markdown layer's
    /// run composes through the doc's style (fg, bg, attributes, link URL).
    fn nodeShowsLeaf(self: *Fixture, arena: std.mem.Allocator, index: u32, node: c.ot_handle) !bool {
        const leaf = try self.readLeaf(arena, index);
        var shown: [4096]u8 = undefined;
        var count: u32 = 0;
        try expectOk(abi.ot_scene_get_text(self.context, &node, &shown, shown.len, &count));
        if (!std.mem.eql(u8, leaf.bytes, shown[0..count])) {
            std.debug.print("node of block {d} shows '{s}', read_leaf '{s}'\n", .{ index, shown[0..count], leaf.bytes });
            return false;
        }
        const core = self.context.core;
        const buffer = (try core.raw().getRenderable(abi.handleFromC(node))).scene_node.?.text.?.buffer;
        const style = try core.raw().getSyntaxStyle(abi.handleFromC(self.style));
        const layers = buffer.layers.slice();
        const runs: []const @import("../highlight-layers.zig").LayerRun = if (layers.len == 0) &.{} else layers[0].runs.items;
        var at: u32 = 0;
        var run: usize = 0;
        for (leaf.chunks) |chunk| {
            for (at..at + chunk.byte_count) |byte| {
                while (run < runs.len and runs[run].end_byte <= byte) run += 1;
                const covered = run < runs.len and runs[run].start_byte <= byte;
                const definition = if (covered) style.resolveGroupSet(&core.group_sets, runs[run].group_set) else null;
                const fg = if (definition) |d| d.fg else null;
                const attributes = if (definition) |d| d.attributes & 0xFF else 0;
                const expected_fg: ?[4]u16 = if (chunk.flags & c.OT_SCENE_TEXT_FOREGROUND != 0) chunk.foreground else null;
                const url: []const u8 = if (covered and runs[run].link_id != 0) try core.links.get(runs[run].link_id) else "";
                if (!std.meta.eql(fg, expected_fg) or attributes != chunk.attributes or !std.mem.eql(u8, url, leaf.urls[chunk.link_offset..][0..chunk.link_byte_count])) {
                    std.debug.print("node of block {d} '{s}': byte {d} styled {any}/{d}/'{s}' (link {d}), read_leaf {any}/{d}/'{s}'\n", .{ index, leaf.bytes, byte, fg, attributes, url, if (covered) runs[run].link_id else 0, expected_fg, chunk.attributes, leaf.urls[chunk.link_offset..][0..chunk.link_byte_count] });
                    return false;
                }
            }
            at += chunk.byte_count;
        }
        return true;
    }
};

fn expectOk(status: c.ot_status) !void {
    try std.testing.expectEqual(c.OT_OK, status);
}

fn optionsWith(flags: u32, style: c.ot_handle) c.ot_markdown_options {
    var options = std.mem.zeroes(c.ot_markdown_options);
    options.struct_size = @sizeOf(c.ot_markdown_options);
    options.abi_version = c.OT_CONTEXT_ABI_VERSION;
    options.flags = flags;
    options.syntax_style = style;
    return options;
}

const live_flags = c.OT_MD_CONCEAL | c.OT_MD_HYPERLINKS;

/// A document's options: its OT_MD_* flags and hook filter.
const OptionSet = struct {
    flags: u32,
    filter: []const u8 = "",

    fn options(self: OptionSet, style: c.ot_handle) c.ot_markdown_options {
        var result = optionsWith(self.flags, style);
        @memcpy(result.hook_filter[0..self.filter.len], self.filter);
        result.hook_filter_byte_count = @intCast(self.filter.len);
        return result;
    }

    /// Whether the doc writes bound nodes of leaves that are not hooked.
    fn live(self: OptionSet) bool {
        return self.flags & live_flags == live_flags;
    }
};

/// Every OT_MD_* combination; with the hook, every leaf hooked and only leaves with `ses_`.
const option_sets = sets: {
    var sets: [24]OptionSet = undefined;
    var count = 0;
    for (0..16) |flags| {
        sets[count] = .{ .flags = flags };
        count += 1;
        if (flags & c.OT_MD_HOOK != 0) {
            sets[count] = .{ .flags = flags, .filter = "ses_" };
            count += 1;
        }
    }
    break :sets sets;
};

const pieces = soup ++ [_][]const u8{ "a@b.co ", "[x](/u) ", "\u{e9}", "e\u{301}", "\n===\n" };

fn isLeaf(kind: u16) bool {
    return switch (kind) {
        c.OT_MD_PARAGRAPH, c.OT_MD_HEADING, c.OT_MD_CODE, c.OT_MD_HTML, c.OT_MD_TABLE_CELL => true,
        else => false,
    };
}

fn sameLeaf(a: Fixture.Leaf, b: Fixture.Leaf) bool {
    return std.mem.eql(u8, a.bytes, b.bytes) and std.mem.eql(u32, a.spans, b.spans) and std.mem.eql(u8, a.urls, b.urls) and
        std.mem.eql(u8, std.mem.sliceAsBytes(a.chunks), std.mem.sliceAsBytes(b.chunks));
}

/// What a host knows of a doc, learned only from read_changes and the result's
/// removed_from_index: the blocks, and each leaf's read_leaf when it was listed.
const Mirror = struct {
    blocks: std.ArrayListUnmanaged(c.ot_markdown_block) = .empty,
    leaves: std.ArrayListUnmanaged(?Fixture.Leaf) = .empty,

    /// Takes in the changes after a call; returns them.
    fn update(self: *Mirror, f: *Fixture, arena: std.mem.Allocator, result: c.ot_markdown_result) ![]c.ot_markdown_block {
        if (result.removed_from_index != std.math.maxInt(u32) and result.removed_from_index < self.blocks.items.len) {
            self.blocks.shrinkRetainingCapacity(result.removed_from_index);
            self.leaves.shrinkRetainingCapacity(result.removed_from_index);
        }
        const changes = try f.changes(arena);
        for (changes) |block| {
            // Preorder: a listed block is known or the next one.
            try std.testing.expect(block.index <= self.blocks.items.len);
            if (block.index == self.blocks.items.len) {
                try self.blocks.append(arena, block);
                try self.leaves.append(arena, null);
            }
            self.blocks.items[block.index] = block;
            self.leaves.items[block.index] = if (isLeaf(block.kind)) try f.readLeaf(arena, block.index) else null;
        }
        return changes;
    }

    /// Whether the mirror holds what a fresh doc with the same options, given the whole
    /// source (and finished when `finished`), lists on its first read: P1, P5.
    fn matchesFresh(self: *const Mirror, f: *Fixture, arena: std.mem.Allocator, set: OptionSet, finished: bool) !bool {
        const source = try arena.dupe(u8, try f.source());
        var options = set.options(f.style);
        var fresh: c.ot_handle = undefined;
        try expectOk(md.ot_markdown_create(f.context, &options, &fresh));
        const doc = f.doc;
        f.doc = fresh;
        defer {
            f.doc = doc;
            expectOk(md.ot_markdown_destroy(f.context, &fresh)) catch unreachable;
        }
        var result: c.ot_markdown_result = undefined;
        if (source.len > 0) _ = try f.append(source);
        if (finished) try expectOk(md.ot_markdown_finish(f.context, &fresh, &result));
        const blocks = try f.changes(arena);
        if (blocks.len != self.blocks.items.len) {
            std.debug.print("host knows {d} blocks, a fresh doc lists {d}\n", .{ self.blocks.items.len, blocks.len });
            return false;
        }
        for (blocks, self.blocks.items, self.leaves.items) |expected, known, leaf| {
            if (!std.meta.eql(expected, known)) {
                std.debug.print("block {d}: host knows {any}, a fresh doc lists {any}\n", .{ expected.index, known, expected });
                return false;
            }
            if (leaf) |shown| {
                const want = try f.readLeaf(arena, expected.index);
                if (!sameLeaf(shown, want)) {
                    std.debug.print("leaf {d}: host read '{s}', a fresh doc shows '{s}'\n", .{ expected.index, shown.bytes, want.bytes });
                    return false;
                }
            }
        }
        return true;
    }
};

test "Markdown ABI: a host that reads changes holds a fresh doc's blocks and leaves; bound nodes show read_leaf (seeded)" {
    var env_arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer env_arena.deinit();
    // CI runs 48 seeds of 40 calls; MODEL_SEEDS widens it. Seed n starts with option set n % 24.
    // MODEL_SEED runs one seed.
    const model = @import("model.zig");
    const seeds = if (model.environment(env_arena.allocator(), "MODEL_SEEDS")) |text| try std.fmt.parseInt(usize, text, 10) else 48;
    const only = if (model.environment(env_arena.allocator(), "MODEL_SEED")) |text| try std.fmt.parseInt(usize, text, 10) else null;
    const first = only orelse 0;
    for (first..if (only) |seed| seed + 1 else seeds) |seed| {
        var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena_state.deinit();
        const arena = arena_state.allocator();
        var set = option_sets[seed % option_sets.len];
        var f = try Fixture.initWith(set);
        defer f.deinit();
        var prng = std.Random.DefaultPrng.init(seed);
        const random = prng.random();
        var mirror: Mirror = .{};
        var finished = false;
        // The host's bindings: block index -> node.
        var nodes: std.AutoArrayHashMapUnmanaged(u32, c.ot_handle) = .empty;
        var trace: std.ArrayListUnmanaged(u8) = .empty;
        try trace.print(arena, "  options {d} \"{s}\"\n", .{ set.flags, set.filter });
        for (0..40) |step| {
            errdefer std.debug.print("seed {d}, step {d}, source \"{f}\"\ncalls:\n{s}", .{ seed, step, std.zig.fmtString(f.source() catch ""), trace.items });
            const roll = random.uintLessThan(u8, 20);
            var result: c.ot_markdown_result = undefined;
            if (roll == 0) {
                try trace.appendSlice(arena, "  finish\n");
                try expectOk(md.ot_markdown_finish(f.context, &f.doc, &result));
                finished = true;
            } else if (roll == 1) {
                // A replace that keeps a prefix, as OpenCode's trim() does.
                const old = try arena.dupe(u8, try f.source());
                const keep = random.uintAtMost(usize, old.len);
                var cut = keep;
                while (cut > 0 and cut < old.len and old[cut] & 0xC0 == 0x80) cut -= 1;
                try trace.print(arena, "  set \"{f}\"\n", .{std.zig.fmtString(old[0..cut])});
                try expectOk(md.ot_markdown_set(f.context, &f.doc, old.ptr, @intCast(cut), &result));
                finished = false;
            } else if (roll == 2) {
                set = option_sets[random.uintLessThan(usize, option_sets.len)];
                try trace.print(arena, "  options {d} \"{s}\"\n", .{ set.flags, set.filter });
                var options = set.options(f.style);
                try expectOk(md.ot_markdown_set_options(f.context, &f.doc, &options, &result));
            } else {
                var bytes: std.ArrayListUnmanaged(u8) = .empty;
                for (0..random.uintAtMost(usize, 3) + 1) |_| try bytes.appendSlice(arena, pieces[random.uintLessThan(usize, pieces.len)]);
                try trace.print(arena, "  append \"{f}\"\n", .{std.zig.fmtString(bytes.items)});
                result = try f.append(bytes.items);
                finished = false;
            }
            const blocks = try mirror.update(&f, arena, result);
            if (!try mirror.matchesFresh(&f, arena, set, finished)) return error.HostDiffers;
            // Removed blocks' nodes are gone; listed paragraphs and headings get a node.
            if (result.removed_from_index != std.math.maxInt(u32)) {
                var i: usize = nodes.count();
                while (i > 0) {
                    i -= 1;
                    if (nodes.keys()[i] >= result.removed_from_index) {
                        try expectOk(abi.ot_scene_destroy_node(f.context, &nodes.values()[i]));
                        nodes.swapRemoveAt(i);
                    }
                }
            }
            for (blocks) |block| {
                const prose = block.kind == c.OT_MD_PARAGRAPH or block.kind == c.OT_MD_HEADING;
                if (nodes.get(block.index)) |node| {
                    if (prose) continue;
                    // A kind change (a paragraph that becomes a table): the host drops its node.
                    try expectOk(abi.ot_scene_destroy_node(f.context, &node));
                    _ = nodes.swapRemove(block.index);
                    continue;
                }
                if (!prose) continue;
                const node = try f.textNode();
                try expectOk(md.ot_markdown_bind(f.context, &f.doc, block.index, &node));
                try nodes.put(arena, block.index, node);
            }
            // The doc writes the nodes of leaves that are not hooked while its display is live.
            if (!set.live()) continue;
            for (nodes.keys(), nodes.values()) |index, node| {
                if (mirror.blocks.items[index].flags & c.OT_MD_BLOCK_HOOKED != 0) continue;
                if (!try f.nodeShowsLeaf(arena, index, node)) return error.NodeDiffers;
            }
        }
    }
}

test "Markdown ABI: every two calls from the soup, under every option set (exhaustive)" {
    // Depth 2 over the pieces and finish: about 2,300 sequences per option set.
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const actions = pieces.len + 1;
    for (option_sets) |set| {
        var f = try Fixture.initWith(set);
        defer f.deinit();
        for (0..actions * actions) |sequence| {
            _ = arena_state.reset(.retain_capacity);
            const arena = arena_state.allocator();
            var options = set.options(f.style);
            var doc: c.ot_handle = undefined;
            try expectOk(md.ot_markdown_create(f.context, &options, &doc));
            const saved = f.doc;
            f.doc = doc;
            defer {
                f.doc = saved;
                expectOk(md.ot_markdown_destroy(f.context, &doc)) catch unreachable;
            }
            var mirror: Mirror = .{};
            var finished = false;
            for ([_]usize{ sequence / actions, sequence % actions }) |action| {
                errdefer std.debug.print("options {d} \"{s}\", calls {d} then {d} ({s})\n", .{ set.flags, set.filter, sequence / actions, sequence % actions, if (action < pieces.len) pieces[action] else "finish" });
                var result: c.ot_markdown_result = undefined;
                if (action == pieces.len) {
                    try expectOk(md.ot_markdown_finish(f.context, &f.doc, &result));
                    finished = true;
                } else {
                    result = try f.append(pieces[action]);
                    finished = false;
                }
                _ = try mirror.update(&f, arena, result);
                if (!try mirror.matchesFresh(&f, arena, set, finished)) return error.HostDiffers;
            }
        }
    }
}

test "Markdown ABI: host-written modes, URL suffixes and source display" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    const rows = [_]struct { u32, []const u8, []const u8 }{
        .{ live_flags, "**a** `b` [c](https://u.test) \\* x", "a b c * x" },
        .{ c.OT_MD_HYPERLINKS, "**a** `b` [c](https://u.test) \\* x", "**a** `b` [c](https://u.test) \\* x" },
        .{ c.OT_MD_HYPERLINKS, "## Title", "## Title" },
        .{ c.OT_MD_HYPERLINKS, "Title\n===", "Title\n===" },
        .{ c.OT_MD_CONCEAL, "see [c](https://u.test) now", "see c (https://u.test) now" },
        .{ c.OT_MD_CONCEAL, "<https://x.test> and [https://x.test](https://x.test)", "https://x.test and https://x.test" },
        .{ c.OT_MD_CONCEAL, "![alt](i.png)", "alt" },
    };
    for (rows) |row| {
        var f = try Fixture.init(row[0]);
        defer f.deinit();
        _ = try f.append(row[1]);
        var result: c.ot_markdown_result = undefined;
        try expectOk(md.ot_markdown_finish(f.context, &f.doc, &result));
        _ = try f.changes(arena);
        try std.testing.expectEqualStrings(row[2], (try f.readLeaf(arena, 0)).bytes);
        // The doc writes a bound node only when its live display is what read_leaf shows.
        const node = try f.textNode();
        try expectOk(md.ot_markdown_bind(f.context, &f.doc, 0, &node));
        var shown: [256]u8 = undefined;
        var count: u32 = 0;
        try expectOk(abi.ot_scene_get_text(f.context, &node, &shown, shown.len, &count));
        try std.testing.expectEqualStrings(if (row[0] == live_flags) row[2] else "", shown[0..count]);
    }
    // A link's parts take Core's names: `markup.link` around the label and `markup.link.url`.
    const parts = [_]struct { u32, []const u8, []const u16 }{
        .{ c.OT_MD_CONCEAL, "[c](https://u.test)", &.{ 9, 6, 3, 6 } },
        .{ 0, "[c](https://u.test) <https://v.test>", &.{ 6, 9, 6, 3, 6, 0, 6, 9, 6 } },
    };
    for (parts) |part| {
        var f = try Fixture.init(part[0]);
        defer f.deinit();
        _ = try f.append(part[1]);
        var result: c.ot_markdown_result = undefined;
        try expectOk(md.ot_markdown_finish(f.context, &f.doc, &result));
        _ = try f.changes(arena);
        const leaf = try f.readLeaf(arena, 0);
        const colors = try arena.alloc(u16, leaf.chunks.len);
        for (leaf.chunks, colors) |chunk, *color| color.* = chunk.foreground[0] | chunk.foreground[2];
        try std.testing.expectEqualSlices(u16, part[2], colors);
    }
}

test "Markdown ABI: options, removal, styles, and rejections that change nothing" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var f = try Fixture.init(live_flags);
    defer f.deinit();
    var result = try f.append("one **two**\n\nthree");
    try std.testing.expectEqual(@as(u32, 1), result.committed_top_level_count);
    _ = try f.changes(arena);
    const first = try f.textNode();
    const second = try f.textNode();
    try expectOk(md.ot_markdown_bind(f.context, &f.doc, 0, &first));
    try expectOk(md.ot_markdown_bind(f.context, &f.doc, 1, &second));
    try std.testing.expect(try f.nodeShowsLeaf(arena, 0, first));
    // Tail writes: the open paragraph grows on its node, one slot, no new registry slot.
    _ = try f.append(" four");
    try std.testing.expect(try f.nodeShowsLeaf(arena, 1, second));
    const buffer = (try f.context.core.raw().getRenderable(abi.handleFromC(second))).scene_node.?.text.?.buffer;
    try std.testing.expect(buffer.mem_registry.buffers.items.len <= 2);

    // A style definition repaints the bound nodes (scene text depends on the style).
    const node_state = (try f.context.core.raw().getRenderable(abi.handleFromC(first))).scene_node.?;
    const epoch = node_state.paint_epoch;
    try f.register("markup.strong", 2, .{ 1, 2, 3, 255 });
    try std.testing.expect(node_state.paint_epoch > epoch);
    try std.testing.expect(try f.nodeShowsLeaf(arena, 0, first));

    // Rejections: invalid UTF-8, a source past the limit, bad options; nothing changes.
    const before = try arena.dupe(u8, try f.source());
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, md.ot_markdown_append(f.context, &f.doc, "\xff", 1, &result));
    var options = optionsWith(live_flags, f.style);
    options.source_byte_limit = @intCast(before.len);
    try expectOk(md.ot_markdown_set_options(f.context, &f.doc, &options, &result));
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, md.ot_markdown_append(f.context, &f.doc, "x", 1, &result));
    try std.testing.expectEqualStrings(before, try f.source());
    options.flags = 64;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, md.ot_markdown_set_options(f.context, &f.doc, &options, &result));
    options.flags = live_flags | c.OT_MD_HOOK;
    options.source_byte_limit = 0;
    options.hook_filter_byte_count = options.hook_filter.len + 1;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, md.ot_markdown_set_options(f.context, &f.doc, &options, &result));
    // A filter item over 64 bytes.
    @memset(options.hook_filter[0..65], 'a');
    options.hook_filter_byte_count = 65;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, md.ot_markdown_set_options(f.context, &f.doc, &options, &result));
    try std.testing.expect(try f.nodeShowsLeaf(arena, 0, first));
    // Reads: a list block is no leaf; a short capacity writes nothing.
    var counts: [3]u32 = .{ 9, 9, 9 };
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, md.ot_markdown_read_leaf(f.context, &f.doc, 99, null, 0, &counts[0], null, null, 0, &counts[1], null, 0, &counts[2]));
    var small: [2]u8 = .{ 'z', 'z' };
    var chunk_buffer: [8]c.ot_styled_text_chunk = undefined;
    var url_buffer: [8]u8 = undefined;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, md.ot_markdown_read_leaf(f.context, &f.doc, 0, &small, small.len, &counts[0], &chunk_buffer, null, chunk_buffer.len, &counts[1], &url_buffer, url_buffer.len, &counts[2]));
    try std.testing.expectEqualStrings("zz", &small);

    // A hooked leaf is the host's: with an empty filter every prose leaf latches.
    options = optionsWith(live_flags | c.OT_MD_HOOK, f.style);
    try expectOk(md.ot_markdown_set_options(f.context, &f.doc, &options, &result));
    try std.testing.expectEqual(@as(u32, 0), result.removed_from_index);
    const blocks = try f.changes(arena);
    try std.testing.expect(blocks[0].flags & c.OT_MD_BLOCK_HOOKED != 0);

    // A replace removes the blocks after the first that differs and unbinds their nodes.
    try expectOk(md.ot_markdown_set_options(f.context, &f.doc, &optionsWith(live_flags, f.style), &result));
    _ = try f.changes(arena);
    const third = try f.textNode();
    try expectOk(md.ot_markdown_bind(f.context, &f.doc, 1, &third));
    try expectOk(md.ot_markdown_set(f.context, &f.doc, "one **two**\n\nother", 18, &result));
    try std.testing.expectEqual(@as(u32, 1), result.removed_from_index);
    _ = try f.append(" more");
    var shown: [64]u8 = undefined;
    var count: u32 = 0;
    try expectOk(abi.ot_scene_get_text(f.context, &third, &shown, shown.len, &count));
    try std.testing.expectEqualStrings("three four", shown[0..count]);
    // A destroyed node is skipped; destroying the doc leaves nodes their text.
    try expectOk(abi.ot_scene_destroy_node(f.context, &first));
    _ = try f.append("\n\nnext");
    try expectOk(md.ot_markdown_destroy(f.context, &f.doc));
    try expectOk(abi.ot_scene_get_text(f.context, &third, &shown, shown.len, &count));
    try std.testing.expectEqualStrings("three four", shown[0..count]);
}

test "Markdown ABI: a replace that leaves a leaf's last line pending lists and writes the leaf" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var f = try Fixture.init(live_flags);
    defer f.deinit();
    _ = try f.append("]\r\n");
    _ = try f.changes(arena);
    const node = try f.textNode();
    try expectOk(md.ot_markdown_bind(f.context, &f.doc, 0, &node));
    try std.testing.expect(try f.nodeShowsLeaf(arena, 0, node));
    // The same block, its line pending again: B holds a trailing `]`, so its display changes.
    var result: c.ot_markdown_result = undefined;
    try expectOk(md.ot_markdown_set(f.context, &f.doc, "]\r", 2, &result));
    try std.testing.expectEqual(@as(u32, 1), result.changed_block_count);
    try std.testing.expect(try f.nodeShowsLeaf(arena, 0, node));
}

test "Markdown ABI: read_source gives an inline leaf's source without container markers" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var f = try Fixture.init(live_flags);
    defer f.deinit();
    _ = try f.append("# Plan x\n\n> first\n> ses_a\n\n- item `y`\n\n| a \\| b |\n| - |\n");
    const blocks = try f.changes(arena);
    var sources: std.ArrayListUnmanaged([]const u8) = .empty;
    for (blocks) |block| {
        if (block.kind != c.OT_MD_PARAGRAPH and block.kind != c.OT_MD_HEADING and block.kind != c.OT_MD_TABLE_CELL) continue;
        var count: u32 = 0;
        try expectOk(md.ot_markdown_read_source(f.context, &f.doc, block.index, null, 0, &count));
        const bytes = try arena.alloc(u8, count);
        try expectOk(md.ot_markdown_read_source(f.context, &f.doc, block.index, bytes.ptr, count, &count));
        try sources.append(arena, bytes);
    }
    try std.testing.expectEqual(@as(usize, 4), sources.items.len);
    for ([_][]const u8{ "Plan x", "first\nses_a", "item `y`", "a | b" }, sources.items) |expected, actual| try std.testing.expectEqualStrings(expected, actual);
    var count: u32 = 0;
    // A quote is no inline leaf.
    try std.testing.expectEqual(@as(u16, c.OT_MD_QUOTE), blocks[1].kind);
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, md.ot_markdown_read_source(f.context, &f.doc, blocks[1].index, null, 0, &count));
}
