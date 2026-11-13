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
    /// The top-level blocks the last call committed (no later byte changes them).
    committed: u32 = 0,

    /// Takes in the changes after a call; returns them.
    fn update(self: *Mirror, f: *Fixture, arena: std.mem.Allocator, result: c.ot_markdown_result) ![]c.ot_markdown_block {
        self.committed = result.committed_top_level_count;
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
        var result: c.ot_markdown_result = .{ .changed_block_count = 0, .committed_top_level_count = 0, .removed_from_index = 0 };
        if (source.len > 0) result = try f.append(source);
        if (finished) try expectOk(md.ot_markdown_finish(f.context, &fresh, &result));
        if (result.committed_top_level_count != self.committed) {
            std.debug.print("host was told {d} blocks are committed, a fresh doc {d}\n", .{ self.committed, result.committed_top_level_count });
            return false;
        }
        const blocks = try f.changes(arena);
        // A committed block is closed: its last line is not pending.
        var top: u32 = 0;
        for (self.blocks.items) |block| {
            if (block.parent_index != std.math.maxInt(u32)) continue;
            if (top < self.committed and block.flags & c.OT_MD_BLOCK_OPEN != 0) {
                std.debug.print("committed block {d} is open\n", .{block.index});
                return false;
            }
            top += 1;
        }
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

fn hostWrites(set: OptionSet, block: c.ot_markdown_block) bool {
    return !set.live() or block.flags & c.OT_MD_BLOCK_HOOKED != 0;
}

test "Markdown ABI: a host that reads changes holds a fresh doc's blocks and leaves; bound nodes show read_leaf (seeded)" {
    var env_arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer env_arena.deinit();
    // CI runs 48 seeds of 40 calls; MODEL_SEEDS widens it. Seed n starts with option set n % 24.
    // MODEL_SEED runs one seed.
    const model = @import("model.zig");
    const seeds = if (model.environment(env_arena.allocator(), "MODEL_SEEDS")) |text| try std.fmt.parseInt(usize, text, 10) else 48;
    const only = if (model.environment(env_arena.allocator(), "MODEL_SEED")) |text| try std.fmt.parseInt(usize, text, 10) else null;
    // Seed 647 also runs: a hooked leaf latches after the doc's last write to its node, and the
    // next append parses its pending line again (535e21c1f).
    var list: std.ArrayListUnmanaged(usize) = .empty;
    if (only) |seed| try list.append(env_arena.allocator(), seed) else for (0..seeds) |seed| try list.append(env_arena.allocator(), seed);
    if (only == null and seeds <= 647) try list.append(env_arena.allocator(), 647);
    for (list.items) |seed| {
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
        var host_wrote: std.AutoArrayHashMapUnmanaged(u32, void) = .empty;
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
                        _ = host_wrote.swapRemove(nodes.keys()[i]);
                        nodes.swapRemoveAt(i);
                    }
                }
            }
            // The doc never writes a node the host writes (P5): not while a hooked leaf's
            // pending line is parsed again, nor as it closes.
            for (nodes.keys(), nodes.values()) |index, node| {
                if (!host_wrote.contains(index) or !hostWrites(set, mirror.blocks.items[index])) continue;
                var shown: [16]u8 = undefined;
                var count: u32 = 0;
                try expectOk(abi.ot_scene_get_text(f.context, &node, &shown, shown.len, &count));
                try std.testing.expectEqualStrings("host", shown[0..count]);
            }
            for (blocks) |block| {
                const prose = block.kind == c.OT_MD_PARAGRAPH or block.kind == c.OT_MD_HEADING;
                if (nodes.get(block.index)) |node| {
                    if (prose) {
                        // A leaf the host wrote that the doc writes now: the doc unbound the node
                        // and listed the leaf; binding it again hands it over.
                        if (host_wrote.contains(block.index) and !hostWrites(set, block)) {
                            try expectOk(md.ot_markdown_bind(f.context, &f.doc, block.index, &node));
                            _ = host_wrote.swapRemove(block.index);
                        }
                        continue;
                    }
                    // A kind change (a paragraph that becomes a table): the host drops its node.
                    try expectOk(abi.ot_scene_destroy_node(f.context, &node));
                    _ = nodes.swapRemove(block.index);
                    _ = host_wrote.swapRemove(block.index);
                    continue;
                }
                if (!prose) continue;
                const node = try f.textNode();
                try expectOk(md.ot_markdown_bind(f.context, &f.doc, block.index, &node));
                try nodes.put(arena, block.index, node);
            }
            // The doc writes the nodes of leaves that are not hooked while its display is live;
            // the host writes the others.
            for (nodes.keys(), nodes.values()) |index, node| {
                if (hostWrites(set, mirror.blocks.items[index])) {
                    try expectOk(abi.ot_scene_set_text(f.context, &node, "host", 4));
                    try host_wrote.put(arena, index, {});
                    continue;
                }
                _ = host_wrote.swapRemove(index);
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
    // A link's parts as OpenCode's frames show them: `markup.link` around the label and
    // `markup.link.url`; the space before a URL suffix and the `]` of a link's source are text.
    const parts = [_]struct { u32, []const u8, []const u16 }{
        .{ c.OT_MD_CONCEAL, "[c](https://u.test)", &.{ 9, 0, 6, 3, 6 } },
        .{ 0, "[c](https://u.test) <https://v.test>", &.{ 6, 9, 0, 6, 3, 6, 0, 6, 9, 6 } },
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
    // Seventeen items (sixteen are the most), at create too.
    for (0..17) |i| options.hook_filter[2 * i ..][0..2].* = .{ 'a' + @as(u8, @intCast(i)), 0 };
    options.hook_filter_byte_count = 2 * 17 - 1;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, md.ot_markdown_set_options(f.context, &f.doc, &options, &result));
    var rejected: c.ot_handle = undefined;
    try std.testing.expectEqual(c.OT_INVALID_ARGUMENT, md.ot_markdown_create(f.context, &options, &rejected));
    options.hook_filter_byte_count = 2 * 16 - 1;
    try expectOk(md.ot_markdown_create(f.context, &options, &rejected));
    try expectOk(md.ot_markdown_destroy(f.context, &rejected));
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

test "Markdown ABI: a paragraph a table header leaves without its hook goes back to the host to hand over" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var f = try Fixture.initWith(.{ .flags = live_flags | c.OT_MD_HOOK, .filter = "ses_" });
    defer f.deinit();
    _ = try f.append("a\nses_ | c\n");
    const blocks = try f.changes(arena);
    try std.testing.expect(blocks[0].flags & c.OT_MD_BLOCK_HOOKED != 0);
    const node = try f.textNode();
    try expectOk(md.ot_markdown_bind(f.context, &f.doc, 0, &node));
    try expectOk(abi.ot_scene_set_text(f.context, &node, "host", 4));
    _ = try f.append("| - | - |\n");
    // The doc does not write over the host's text: it lists the leaf and unbinds the node.
    try std.testing.expect((try f.changes(arena))[0].flags & c.OT_MD_BLOCK_HOOKED == 0);
    var shown: [16]u8 = undefined;
    var count: u32 = 0;
    try expectOk(abi.ot_scene_get_text(f.context, &node, &shown, shown.len, &count));
    try std.testing.expectEqualStrings("host", shown[0..count]);
    _ = try f.append("more\n");
    try expectOk(abi.ot_scene_get_text(f.context, &node, &shown, shown.len, &count));
    try std.testing.expectEqualStrings("host", shown[0..count]);
    // Binding it again hands it over.
    try expectOk(md.ot_markdown_bind(f.context, &f.doc, 0, &node));
    try std.testing.expect(try f.nodeShowsLeaf(arena, 0, node));
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

/// An allocator whose `countdown`-th allocation (or growth) from now fails, once.
const OneFailure = struct {
    inner: std.mem.Allocator,
    countdown: usize = std.math.maxInt(usize),
    failed: bool = false,
    /// From the failing allocation on, every one fails until `failed` is cleared (memory that
    /// stays short: recovery code cannot allocate either).
    sustained: bool = false,

    fn allocator(self: *OneFailure) std.mem.Allocator {
        return .{ .ptr = self, .vtable = &.{ .alloc = alloc, .resize = resize, .remap = remap, .free = free } };
    }

    fn fails(self: *OneFailure) bool {
        if (self.sustained and self.failed) return true;
        if (self.countdown == std.math.maxInt(usize)) return false;
        if (self.countdown > 0) {
            self.countdown -= 1;
            return false;
        }
        self.countdown = std.math.maxInt(usize);
        self.failed = true;
        return true;
    }

    fn alloc(ctx: *anyopaque, len: usize, alignment: std.mem.Alignment, ra: usize) ?[*]u8 {
        const self: *OneFailure = @ptrCast(@alignCast(ctx));
        if (self.fails()) return null;
        return self.inner.rawAlloc(len, alignment, ra);
    }

    fn resize(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ra: usize) bool {
        const self: *OneFailure = @ptrCast(@alignCast(ctx));
        if (new_len > memory.len and self.fails()) return false;
        return self.inner.rawResize(memory, alignment, new_len, ra);
    }

    fn remap(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, new_len: usize, ra: usize) ?[*]u8 {
        const self: *OneFailure = @ptrCast(@alignCast(ctx));
        if (new_len > memory.len and self.fails()) return null;
        return self.inner.rawRemap(memory, alignment, new_len, ra);
    }

    fn free(ctx: *anyopaque, memory: []u8, alignment: std.mem.Alignment, ra: usize) void {
        const self: *OneFailure = @ptrCast(@alignCast(ctx));
        self.inner.rawFree(memory, alignment, ra);
    }
};

test "Markdown ABI: a call that fails at any allocation changes nothing, bound nodes included" {
    const Context = context_mod.Context;
    const live: context_mod.MarkdownOptions = .{};
    const host: context_mod.MarkdownOptions = .{ .flags = 0 };
    // Each call from live options, and (bigboi-r2-1) the hand-off of host-written nodes to the doc.
    const calls = [_]struct { context_mod.MarkdownOptions, Context.MarkdownCall }{
        .{ live, .{ .options = .{ .flags = live.flags | c.OT_MD_MATH } } },
        .{ live, .{ .append = " more **e** and `f` text\n\nnext *g*" } },
        // A kept layer that outgrows its storage: the set must take the reserved spare.
        .{ live, .{ .append = " *a* *b* *c* *d* *e* *f* *g* *h* *i* *j* *k* *l* *m* *n* *o* *p* *q* *r* *s* *t*" } },
        .{ live, .{ .set = "one $x$ **two**\n\nthree **d** four" } },
        .{ live, .finish },
        .{ host, .{ .options = live } },
    };
    for (calls) |row| {
        const start, const request = row;
        var failure: OneFailure = .{ .inner = std.testing.allocator };
        var countdown: usize = 0;
        while (true) : (countdown += 1) {
            failure.countdown = std.math.maxInt(usize);
            failure.failed = false;
            const owner = try Context.init(failure.allocator(), std.testing.io, .{});
            defer owner.deinit() catch unreachable;
            const session = try owner.createSession(.{});
            try owner.attachSessionRenderer(session, 40, 10, .{ .remote_mode = .remote });
            _ = try owner.sceneCreateNode(session, c.OT_SCENE_ROOT, 1);
            const doc = try owner.createMarkdown(start);
            _ = try owner.markdownCall(doc, .{ .append = "one $x$ **two**\n\nthree **d** four" });
            // The changes are in the Markdown scratch, which the next call reuses.
            const blocks = try owner.markdownReadChanges(doc, 64);
            const indexes = [2]u32{ blocks.changes[0].index, blocks.changes[1].index };
            var nodes: [2]context_mod.Handle = undefined;
            for (&nodes, indexes, 2..) |*node, index, num| {
                node.* = try owner.sceneCreateNode(session, c.OT_SCENE_TEXT, @intCast(num));
                try owner.markdownBind(doc, index, node.*);
                // The host writes the nodes the doc does not.
                if (start.flags != live.flags) try owner.sceneSetText(node.*, "host custom");
            }
            var before: [2][64]u8 = undefined;
            var before_count: [2]u32 = undefined;
            for (nodes, 0..) |node, i| before_count[i] = try owner.sceneGetText(node, &before[i]);
            const source = try std.testing.allocator.dupe(u8, try owner.markdownSource(doc));
            defer std.testing.allocator.free(source);
            failure.countdown = countdown;
            const rejected = if (owner.markdownCall(doc, request)) |_| false else |err| switch (err) {
                error.OutOfMemory => true,
                else => return err,
            };
            failure.countdown = std.math.maxInt(usize);
            if (!rejected and start.flags != live.flags) {
                // Accepted (bigboi-r3-3): the doc hands no host node over by itself, so the host's
                // text stands, and a later rejected call leaves it too.
                for (nodes) |node| {
                    var shown: [64]u8 = undefined;
                    try std.testing.expectEqualStrings("host custom", shown[0..try owner.sceneGetText(node, &shown)]);
                }
                try std.testing.expectError(error.InvalidUnicode, owner.markdownCall(doc, .{ .append = "\xff" }));
                for (nodes) |node| {
                    var shown: [64]u8 = undefined;
                    try std.testing.expectEqualStrings("host custom", shown[0..try owner.sceneGetText(node, &shown)]);
                }
            }
            if (!failure.failed) break;
            if (!rejected) continue;
            // Rejected: the source, the pending changes and every node as before.
            errdefer std.debug.print("{s} from flags {d}, failing allocation {d}\n", .{ @tagName(request), start.flags, countdown });
            try std.testing.expectEqualStrings(source, try owner.markdownSource(doc));
            try std.testing.expectEqual(@as(u32, 0), (try owner.markdownReadChanges(doc, 0)).count);
            for (nodes, 0..) |node, i| {
                var shown: [64]u8 = undefined;
                try std.testing.expectEqualStrings(before[i][0..before_count[i]], shown[0..try owner.sceneGetText(node, &shown)]);
            }
        }
    }
}

test "Markdown ABI: a style swap lists the leaves whose read_leaf styles the host copied" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    // Hooked prose, a table cell and source mode: the host writes each from read_leaf.
    for ([_]struct { OptionSet, []const u8 }{
        .{ .{ .flags = live_flags | c.OT_MD_HOOK }, "**example**\n" },
        .{ .{ .flags = live_flags }, "| **a** |\n| - |\n" },
        .{ .{ .flags = c.OT_MD_HYPERLINKS }, "**example**\n" },
    }) |row| {
        var f = try Fixture.initWith(row[0]);
        defer f.deinit();
        _ = try f.append(row[1]);
        var result: c.ot_markdown_result = undefined;
        try expectOk(md.ot_markdown_finish(f.context, &f.doc, &result));
        const before = try f.changes(arena);
        const leaf = before[before.len - 1].index;
        try std.testing.expect((try f.readLeaf(arena, leaf)).chunks[0].flags & c.OT_SCENE_TEXT_FOREGROUND != 0);
        var empty: c.ot_handle = undefined;
        try expectOk(abi.ot_syntax_style_create(f.context, &empty));
        var options = row[0].options(empty);
        try expectOk(md.ot_markdown_set_options(f.context, &f.doc, &options, &result));
        try std.testing.expect(result.changed_block_count > 0);
        var listed = false;
        for (try f.changes(arena)) |block| listed = listed or block.index == leaf;
        try std.testing.expect(listed);
        try std.testing.expect((try f.readLeaf(arena, leaf)).chunks[0].flags & c.OT_SCENE_TEXT_FOREGROUND == 0);
    }
}

test "Markdown ABI: a span that closes in the last, undecided word of a stream is styled" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    // OpenCode's compaction summary never ends its stream (oc-rust E.6b).
    for ([_][]const u8{ "The user is fixing the **parser**.", "fixing the **parser**.\n", "a *b*, ~~c~~! _d_" }) |text| {
        for ([_]u32{ live_flags, c.OT_MD_CONCEAL }) |flags| {
            var f = try Fixture.init(flags);
            defer f.deinit();
            const node = try f.textNode();
            _ = try f.append(text[0 .. text.len / 2]);
            _ = try f.changes(arena);
            try expectOk(md.ot_markdown_bind(f.context, &f.doc, 0, &node));
            _ = try f.append(text[text.len / 2 ..]);
            _ = try f.changes(arena);
            const leaf = try f.readLeaf(arena, 0);
            var styled = false;
            for (leaf.chunks) |chunk| styled = styled or chunk.attributes & (1 | 4 | 128) != 0;
            errdefer std.debug.print("'{s}' flags {d}: '{s}'\n", .{ text, flags, leaf.bytes });
            try std.testing.expect(styled);
            if (flags == live_flags) try std.testing.expect(try f.nodeShowsLeaf(arena, 0, node));
        }
    }
}

test "Markdown ABI: tear's D2 rows close a setext leaf in host-written modes" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    // investigations/tear-for-opentui.md rows C (math, conceal and hyperlinks off), E (flags 0) and
    // F (hyperlinks off): the live finish restyled a setext leaf against read_leaf's source display.
    for ([_]struct { u32, []const []const u8 }{
        .{ c.OT_MD_MATH, &.{"&amp;\n===\n"} },
        .{ 0, &.{"&mp;\n=\n"} },
        .{ c.OT_MD_CONCEAL, &.{"[x](/u) \n===\n"} },
        .{ 0, &.{ "&mp;", "\n=\n" } },
    }) |row| {
        var f = try Fixture.init(row[0]);
        defer f.deinit();
        const node = try f.textNode();
        var mirror: Mirror = .{};
        for (row[1], 0..) |piece, i| {
            const result = try f.append(piece);
            _ = try mirror.update(&f, arena, result);
            if (i == 0) try expectOk(md.ot_markdown_bind(f.context, &f.doc, 0, &node));
            try std.testing.expect(try mirror.matchesFresh(&f, arena, .{ .flags = row[0] }, false));
        }
    }
}

test "Markdown ABI: a pending fence opener's info string grows with its line, listed" {
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    // The seeded test's seed 965: in an item, the pending line's layout grew without its info.
    for ([_][]const []const u8{ &.{ "```", " ab" }, &.{ " 1. [x] ", "```", " ab" }, &.{ "- ", "```", " ab" } }) |parts| {
        var f = try Fixture.init(live_flags);
        defer f.deinit();
        var mirror: Mirror = .{};
        for (parts) |piece| {
            _ = try mirror.update(&f, arena, try f.append(piece));
            try std.testing.expect(try mirror.matchesFresh(&f, arena, .{ .flags = live_flags }, false));
        }
    }
}

test "Markdown ABI: a bind that fails at any allocation leaves the node and the bindings as they were" {
    const Context = context_mod.Context;
    var failure: OneFailure = .{ .inner = std.testing.allocator };
    var countdown: usize = 0;
    while (true) : (countdown += 1) {
        failure.countdown = std.math.maxInt(usize);
        failure.failed = false;
        const owner = try Context.init(failure.allocator(), std.testing.io, .{});
        defer owner.deinit() catch unreachable;
        const session = try owner.createSession(.{});
        try owner.attachSessionRenderer(session, 40, 10, .{ .remote_mode = .remote });
        _ = try owner.sceneCreateNode(session, c.OT_SCENE_ROOT, 1);
        const doc = try owner.createMarkdown(.{ .syntax_style = try owner.createSyntaxStyle() });
        _ = try owner.markdownCall(doc, .{ .append = "one [x](https://u.test) **two** `c`\n\nthree" });
        _ = try owner.markdownReadChanges(doc, 64);
        const node = try owner.sceneCreateNode(session, c.OT_SCENE_TEXT, 2);
        try owner.sceneSetText(node, "host custom");
        failure.countdown = countdown;
        const rejected = if (owner.markdownBind(doc, 0, node)) |_| false else |err| switch (err) {
            error.OutOfMemory => true,
            else => return err,
        };
        failure.countdown = std.math.maxInt(usize);
        if (!failure.failed) break;
        if (!rejected) continue;
        errdefer std.debug.print("bind, failing allocation {d}\n", .{countdown});
        var shown: [64]u8 = undefined;
        try std.testing.expectEqualStrings("host custom", shown[0..try owner.sceneGetText(node, &shown)]);
        // carbon-3: the node keeps the style it drew with too.
        try std.testing.expect((try owner.raw().getRenderable(node)).scene_node.?.text.?.buffer.getSyntaxStyle() == null);
        // Not bound: the doc's next change leaves it alone.
        _ = try owner.markdownCall(doc, .{ .append = " four" });
        try std.testing.expectEqualStrings("host custom", shown[0..try owner.sceneGetText(node, &shown)]);
    }
}

test "Markdown ABI: a call rejected while memory stays short writes no node, nor does a rejected call after it" {
    // carbon-3: with every allocation failing from one on, the rejected call's node writes could
    // not be undone, the node stayed stale, and a rejected invalid append wrote it over the host's
    // text.
    const Context = context_mod.Context;
    var failure: OneFailure = .{ .inner = std.testing.allocator, .sustained = true };
    var countdown: usize = 0;
    while (true) : (countdown += 1) {
        failure.countdown = std.math.maxInt(usize);
        failure.failed = false;
        const owner = try Context.init(failure.allocator(), std.testing.io, .{});
        defer owner.deinit() catch unreachable;
        const session = try owner.createSession(.{});
        try owner.attachSessionRenderer(session, 40, 10, .{ .remote_mode = .remote });
        _ = try owner.sceneCreateNode(session, c.OT_SCENE_ROOT, 1);
        const doc = try owner.createMarkdown(.{});
        _ = try owner.markdownCall(doc, .{ .append = "begin *a *b* mid " });
        _ = try owner.markdownReadChanges(doc, 64);
        const node = try owner.sceneCreateNode(session, c.OT_SCENE_TEXT, 2);
        try owner.markdownBind(doc, 0, node);
        var before: [64]u8 = undefined;
        const before_len = try owner.sceneGetText(node, &before);
        failure.countdown = countdown;
        const rejected = if (owner.markdownCall(doc, .{ .append = "c* [x](https://new-link.test) " })) |_| false else |err| switch (err) {
            error.OutOfMemory => true,
            else => return err,
        };
        const failed = failure.failed;
        failure.countdown = std.math.maxInt(usize);
        failure.failed = false;
        if (!failed) break;
        if (!rejected) continue;
        errdefer std.debug.print("append, memory short from allocation {d}\n", .{countdown});
        var shown: [64]u8 = undefined;
        try std.testing.expectEqualStrings(before[0..before_len], shown[0..try owner.sceneGetText(node, &shown)]);
        try owner.sceneSetText(node, "host custom");
        try std.testing.expectError(error.InvalidUnicode, owner.markdownCall(doc, .{ .append = "\xff" }));
        try std.testing.expectEqualStrings("host custom", shown[0..try owner.sceneGetText(node, &shown)]);
    }
}

test "Markdown ABI: an option change leaves text the host wrote to a node the doc writes" {
    // cmut-9: a rewrite after an option change took the host's text.
    var arena_state = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena_state.deinit();
    const arena = arena_state.allocator();
    var f = try Fixture.initWith(.{ .flags = live_flags });
    defer f.deinit();
    _ = try f.append("one $x$ two\n");
    _ = try f.changes(arena);
    const node = try f.textNode();
    try expectOk(md.ot_markdown_bind(f.context, &f.doc, 0, &node));
    try std.testing.expect(try f.nodeShowsLeaf(arena, 0, node));
    try expectOk(abi.ot_scene_set_text(f.context, &node, "host", 4));
    var options = optionsWith(live_flags | c.OT_MD_MATH, f.style);
    var result: c.ot_markdown_result = undefined;
    try expectOk(md.ot_markdown_set_options(f.context, &f.doc, &options, &result));
    var shown: [16]u8 = undefined;
    var count: u32 = 0;
    try expectOk(abi.ot_scene_get_text(f.context, &node, &shown, shown.len, &count));
    try std.testing.expectEqualStrings("host", shown[0..count]);
}

/// A Markdown doc's engine blocks, reached through its first leaf (none: no leaf).
fn engineBlocks(owner: *context_mod.Context, doc: anytype) ![]const markdown.Block {
    for (0..64) |index| {
        const read = owner.markdownReadLeaf(doc, @intCast(index)) catch |err| switch (err) {
            error.InvalidIndex => continue,
            else => return err,
        };
        return read.doc.doc.blocks.items;
    }
    return &.{};
}

test "Markdown ABI: a call rejected for memory lists no block again and reports no removal" {
    // bigboi-r5-3: a same-line append rebuilt the pending line's layout after the failure, and its
    // blocks (read already) were listed again. bigboi-r6-1: a multiline append aborted in its
    // rollback. bigboi-r6-2: a rejected finish listed the blocks and reported a removal from 0.
    // The same call accepted after it leaves the blocks a fresh doc of the text has (the layout
    // put back, and its log, are what the next call drops).
    const Context = context_mod.Context;
    const calls = [_]Context.MarkdownCall{ .{ .append = " c* [x](https://new-link.test) " }, .{ .append = "\nnext **b**\n\nend " }, .{ .append = "\n- c" }, .{ .append = "\n" }, .finish };
    for ([_]bool{ false, true }) |sustained| for (calls) |call| for ([_][]const u8{ "- item", "> quote", "para", "- a\n- item", "> a\n> quote", "[x]: /u\n", "- [x]: /u\n" }, [_]u32{ 2, 1, 0, 4, 1, 0, 2 }) |line, paragraph| {
        var failure: OneFailure = .{ .inner = std.testing.allocator, .sustained = sustained };
        var countdown: usize = 0;
        while (true) : (countdown += 1) {
            failure.countdown = std.math.maxInt(usize);
            failure.failed = false;
            const owner = try Context.init(failure.allocator(), std.testing.io, .{});
            defer owner.deinit() catch unreachable;
            const session = try owner.createSession(.{});
            try owner.attachSessionRenderer(session, 40, 10, .{ .remote_mode = .remote });
            _ = try owner.sceneCreateNode(session, c.OT_SCENE_ROOT, 1);
            const doc = try owner.createMarkdown(.{});
            const before = try owner.markdownCall(doc, .{ .append = line });
            _ = try owner.markdownReadChanges(doc, 64);
            try owner.markdownBind(doc, paragraph, try owner.sceneCreateNode(session, c.OT_SCENE_TEXT, 2));
            try std.testing.expectEqual(@as(u32, 0), (try owner.markdownReadChanges(doc, 0)).count);
            failure.countdown = countdown;
            const rejected = if (owner.markdownCall(doc, call)) |_| false else |err| switch (err) {
                error.OutOfMemory => true,
                else => return err,
            };
            const failed = failure.failed;
            failure.countdown = std.math.maxInt(usize);
            failure.failed = false;
            if (!failed) break;
            if (!rejected) continue;
            errdefer std.debug.print("{s}: {t}, failing allocation {d} (sustained {})\n", .{ line, call, countdown, sustained });
            try std.testing.expectEqualStrings(line, try owner.markdownSource(doc));
            try std.testing.expectEqual(@as(u32, 0), (try owner.markdownReadChanges(doc, 0)).count);
            try std.testing.expectEqual(before.removed_from_index, (try owner.markdownCall(doc, .{ .append = "" })).removed_from_index);
            _ = try owner.markdownCall(doc, call);
            const fresh = try owner.createMarkdown(.{});
            _ = try owner.markdownCall(fresh, .{ .append = try owner.markdownSource(doc) });
            if (call == .finish) _ = try owner.markdownCall(fresh, .finish);
            const blocks = try engineBlocks(owner, doc);
            const fresh_blocks = try engineBlocks(owner, fresh);
            try std.testing.expectEqual(fresh_blocks.len, blocks.len);
            for (blocks, fresh_blocks) |b, f| {
                try std.testing.expectEqual(.{ f.kind, f.parent_index, f.source_start_byte, f.source_end_byte, f.content_start_byte, f.content_end_byte, f.flags.open }, .{ b.kind, b.parent_index, b.source_start_byte, b.source_end_byte, b.content_start_byte, b.content_end_byte, b.flags.open });
            }
        }
    };
}
