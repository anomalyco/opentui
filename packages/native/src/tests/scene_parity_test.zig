//! Twin-Session parity harness. A reference Session forced to the full path
//! (OT_SCENE_DEBUG_FULL_FRAME) and a candidate Session run one seeded script of
//! scene mutations, host replies, and frames. After every frame the two must
//! agree on host requests, draft cells and hits, render status, encoded bytes,
//! presented cells and hits, cursor, hit tests, and public layouts.
//!
//! Extending it for a Track B step:
//! - a mutation kind: add an `Op` variant, its arm in `applyOn`, and a draw in
//!   `generate` (and in `generateReply` if a hook reply may send it);
//! - a shortcut's proof: add the counter it lowers to `expectReference`, which
//!   checks every presented reference frame;
//! - a frame kind it must reach: count it in `Stats` and give it a minimum in
//!   the test.
//! The script has editors, focus moves, host cursors, and text views of one
//! shared text buffer and syntax style, but no image or linked text, so image
//! and link shortcuts are invisible to it. Retained paint (B3) is its gate: the
//! candidate verifies every row it keeps on even seeds and skips paint outright
//! on odd seeds, and the script writes the buffers outside scene paint, before
//! and after a draft's paint.
const std = @import("std");
const testing = std.testing;
const c = @import("context_abi_c");
const context = @import("../context.zig");
const scene = @import("../scene.zig");
const renderer = @import("../renderer.zig");
const yoga = @import("../yoga.zig");
const fixture = @import("scene_fixture_test.zig");
const Fixture = fixture.Fixture;
const Recording = @import("scene_record_test.zig").Recording;
const expectBufferInvariants = @import("buffer-invariants.zig").expectBufferInvariants;
const ghostty_vt = @import("../ghostty-vt.zig");
const ansi = @import("../ansi.zig");
const gp = @import("../grapheme.zig");

const node_count_max = 40;
const root_slot = 0;
const viewport_slot = 1;
const content_slot = 2;
/// The root, the viewport, and its content are never moved or destroyed.
const scaffold_slots = 3;
const reference = 0;
const candidate = 1;
// The largest screen a resize step picks (20×8).
const max_cells = 20 * 8;

const Kind = enum { box, text, slider, editor, text_view };

/// One scripted step, drawn once and applied to both twins.
const Op = union(enum) {
    create: struct { slot: usize, kind: Kind },
    move: struct { slot: usize, parent: ?usize, index: u32 },
    destroy: usize,
    paint: struct { slot: usize, fields: u32, paint: scene.Paint },
    style: struct { slot: usize, group: u32, kind: u32, unit: u32, value: f32, flags: u32 },
    position: struct { slot: usize, left: f32, top: f32 },
    focus: struct { slot: usize, focused: bool },
    text: struct { slot: usize, seed: u32 },
    text_options: struct { slot: usize, options: scene.TextOptions },
    /// Removes the Yoga measure function, so later text changes do not solve.
    measure: usize,
    hooks: struct { slot: usize, flags: u32 },
    slider: struct { slot: usize, value: f64, orientation: u32 },
    viewport: bool,
    resize: struct { width: u32, height: u32 },
    editor: struct { slot: usize, seed: u32, show_cursor: bool, style: u32 },
    /// A cursor the host places itself, as a Textarea-free app or a hook does.
    host_cursor: struct { x: i32, y: i32, visible: bool },
    /// Replaces a text view node's view with a fresh one, or only destroys it.
    rebind: struct { slot: usize, bind: bool },
    /// Replaces the shared text, which every text view shows.
    shared_text: u32,
    /// Highlights a range of the shared text with the shared style's first name.
    highlight: struct { start: u32, end: u32 },
    /// Registers the shared style's name with a new color, or destroys the style first,
    /// so borrowers draw without it until a registration binds a new one.
    register: struct { foreground: u8, destroy: bool },
    /// Sets or resets a text node's selection.
    selection: struct { slot: usize, set: bool, focus: i32 },
    /// Sends a node's current paint again: an equal value changes nothing.
    resend: usize,
    palette: u32,
    /// Writes outside scene paint between frames: 0 draws on next, 1 and 2 write a cell
    /// through a lease of next or current, 3 draws and renders without the scene.
    raw: struct { kind: u32, x: i32, y: i32 },
};

/// Options drawn once per frame.
const FrameSpec = struct {
    options: scene.FrameOptions,
    force: bool,
    cancel_first: bool,
};

/// Reference tree: each node's children in Yoga order and its paint children in attachment
/// order. A frame stably sorts the paint children of every parent it visits by z.
const Model = struct {
    handles: [node_count_max]?[2]context.Handle = @splat(null),
    /// Each editor node's edit buffer, per twin.
    edits: [node_count_max][2]context.Handle = undefined,
    /// Each text view node's view, per twin, if bound.
    views: [node_count_max][2]?context.Handle = @splat(.{ null, null }),
    kind: [node_count_max]Kind = @splat(.box),
    parent: [node_count_max]?usize = @splat(null),
    children: [node_count_max]std.ArrayListUnmanaged(usize) = @splat(.empty),
    paint: [node_count_max]std.ArrayListUnmanaged(usize) = @splat(.empty),
    z: [node_count_max]i32 = @splat(0),
    hidden: [node_count_max]bool = @splat(false),
    hook_generation: [node_count_max]u64 = @splat(0),
    text_options: [node_count_max]scene.TextOptions = @splat(.{}),
    hooks: [node_count_max]u32 = @splat(0),
    focusable: [node_count_max]bool = @splat(false),
    /// The viewport content filters its children.
    bound: bool = false,
    /// Text whose Yoga measure function was removed.
    unmeasured: [node_count_max]bool = @splat(false),

    fn deinit(self: *Model) void {
        for (&self.children, &self.paint) |*children, *paint| {
            children.deinit(testing.allocator);
            paint.deinit(testing.allocator);
        }
    }

    fn move(self: *Model, node: usize, parent: ?usize, index: usize) !void {
        const previous = self.parent[node];
        if (previous) |old| _ = self.children[old].orderedRemove(std.mem.indexOfScalar(usize, self.children[old].items, node).?);
        if (previous != parent) {
            if (previous) |old| _ = self.paint[old].orderedRemove(std.mem.indexOfScalar(usize, self.paint[old].items, node).?);
            if (parent) |new| try self.paint[new].append(testing.allocator, node);
        }
        if (parent) |new| try self.children[new].insert(testing.allocator, index, node);
        self.parent[node] = parent;
    }

    fn destroy(self: *Model, node: usize) !void {
        try self.move(node, null, 0);
        for (self.children[node].items) |child| self.parent[child] = null;
        self.children[node].clearRetainingCapacity();
        self.paint[node].clearRetainingCapacity();
        self.handles[node] = null;
    }

    fn contains(self: *const Model, ancestor: usize, node: usize) bool {
        var cursor: ?usize = node;
        while (cursor) |value| : (cursor = self.parent[value]) {
            if (value == ancestor) return true;
        }
        return false;
    }

    fn zLessThan(self: *const Model, left: usize, right: usize) bool {
        return self.z[left] < self.z[right];
    }

    /// Writes the visible descendants of `node` in paint order and returns the new count.
    fn paintOrder(self: *Model, out: []usize, count: usize, node: usize) usize {
        std.mem.sort(usize, self.paint[node].items, self, zLessThan);
        var next = count;
        for (self.paint[node].items) |child| {
            if (self.hidden[child]) continue;
            out[next] = child;
            next = self.paintOrder(out, next + 1, child);
        }
        return next;
    }

    /// Whether a hidden node lies strictly above `node`.
    fn hiddenAbove(self: *const Model, node: usize) bool {
        var cursor = self.parent[node];
        while (cursor) |value| : (cursor = self.parent[value]) {
            if (self.hidden[value]) return true;
        }
        return false;
    }

    fn slotOf(self: *const Model, twin: usize, handle: context.Handle) ?usize {
        for (self.handles, 0..) |maybe, slot| {
            if (maybe) |pair| if (std.meta.eql(pair[twin], handle)) return slot;
        }
        return null;
    }

    fn num(slot: usize) u32 {
        return @intCast(10 + slot);
    }
};

const Stats = struct {
    frames: u32 = 0,
    reused: u32 = 0,
    filtered: u32 = 0,
    /// Filtered frames that also sent a host request.
    filtered_requests: u32 = 0,
    /// Frames with a hooked node under a hidden ancestor.
    hidden_hooked: u32 = 0,
    /// Host replies that hid an ancestor of the requesting node mid-frame.
    reply_hides: u32 = 0,
    /// Host replies that detached the requesting node mid-frame.
    reply_detaches: u32 = 0,
    /// RESIZE requests from children of the viewport content.
    content_resizes: u32 = 0,
    /// Replies to those requests that changed text on a content child, mid-batch.
    content_reply_texts: u32 = 0,
    /// Text replaced on a filtered content child without a measure function, so without a solve.
    unmeasured_texts: u32 = 0,
    updates: u32 = 0,
    resizes: u32 = 0,
    layout_changes: u32 = 0,
    records: u32 = 0,
    decoded: u32 = 0,
    /// Frames that end with an editor's cursor, and with a host cursor shown.
    editor_cursors: u32 = 0,
    host_cursors: u32 = 0,
    /// Candidate frames that skipped paint (no damaged row), and that diffed some rows only.
    skipped: u32 = 0,
    partial: u32 = 0,
    /// Draft writes after paint, and buffer writes or renders between frames.
    draft_writes: u32 = 0,
    raw_writes: u32 = 0,
    /// Shared text, highlight, style, and view changes while a text view is shown.
    shared_changes: u32 = 0,
    style_changes: u32 = 0,
    rebinds: u32 = 0,
    selections: u32 = 0,
    resends: u32 = 0,
    palettes: u32 = 0,
    /// Folds every candidate frame's work counts, to check that a seed replays identically.
    digest: u64 = 0,
};

const Harness = struct {
    twins: [2]Fixture,
    model: Model = .{},
    random: std.Random,
    stats: Stats = .{},
    bytes: [2]std.ArrayListUnmanaged(u8) = .{ .empty, .empty },
    /// Decodes the candidate's bytes independently of the encoder.
    terminal: ghostty_vt.vt.Terminal,
    /// The decoder holds the whole screen: false after a resize until a forced frame.
    decoder_synced: bool = true,
    /// Per twin: the shared text buffer, its syntax style, and a 2x1 buffer that raw writes draw.
    shared: [2]context.Handle = undefined,
    style: [2]?context.Handle = .{ null, null },
    scratch: [2]context.Handle = undefined,

    fn init(random: std.Random, verify: bool) !Harness {
        var twins: [2]Fixture = undefined;
        for (&twins, 0..) |*twin, index| {
            twin.* = try Fixture.init(testing.allocator, 16, 6, .{ .output = .{ .chunk_size = 8192, .chunk_count = 2, .span_capacity = 2 } });
            // Images keep byte parity only with equal ids.
            twin.cli.imageIdSalt = 100;
            twin.cli.kittyHistoryNextImageId = 100 + @import("../grapheme.zig").IMAGE_ID_MASK + 1;
            if (index == reference) {
                try twin.owner.sceneSetDebugFlags(twin.id, c.OT_SCENE_DEBUG_FULL_FRAME);
            } else if (verify) {
                // The candidate checks every row it keeps against the presented frame.
                try twin.owner.sceneSetDebugFlags(twin.id, c.OT_SCENE_DEBUG_VERIFY);
            }
        }
        var self: Harness = .{ .twins = twins, .random = random, .terminal = try newTerminal(16, 6) };
        for (twins, 0..) |twin, index| {
            self.shared[index] = try twin.owner.createTextBuffer(.unicode);
            try twin.owner.textBufferSetText(self.shared[index], "shared text");
            self.scratch[index] = try twin.owner.createBuffer(2, 1, .{});
            try twin.owner.drawBufferText(self.scratch[index], "\u{754c}", 0, 0, ansi.rgbColor(255, 255, 0, 255), ansi.rgbColor(0, 0, 255, 255), 0);
        }
        try self.apply(.{ .register = .{ .foreground = 0, .destroy = false } });
        self.model.handles[root_slot] = .{ twins[0].root, twins[1].root };
        try self.apply(.{ .create = .{ .slot = viewport_slot, .kind = .box } });
        try self.apply(.{ .style = .{ .slot = viewport_slot, .group = c.OT_STYLE_DIMENSION, .kind = 0, .unit = 1, .value = 12, .flags = 1 } });
        try self.apply(.{ .style = .{ .slot = viewport_slot, .group = c.OT_STYLE_DIMENSION, .kind = 1, .unit = 1, .value = 3, .flags = 1 } });
        try self.apply(.{ .style = .{ .slot = viewport_slot, .group = c.OT_STYLE_ENUM, .kind = c.OT_STYLE_ENUM_OVERFLOW, .unit = 0, .value = c.OT_OVERFLOW_HIDDEN, .flags = 0 } });
        try self.apply(.{ .move = .{ .slot = viewport_slot, .parent = root_slot, .index = 0 } });
        try self.apply(.{ .create = .{ .slot = content_slot, .kind = .box } });
        try self.apply(.{ .style = .{ .slot = content_slot, .group = c.OT_STYLE_FLOAT, .kind = c.OT_STYLE_FLOAT_FLEX_SHRINK, .unit = 0, .value = 0, .flags = 0 } });
        try self.apply(.{ .move = .{ .slot = content_slot, .parent = viewport_slot, .index = 0 } });
        try self.apply(.{ .viewport = true });
        return self;
    }

    fn newTerminal(width: u32, height: u32) !ghostty_vt.vt.Terminal {
        var terminal: ghostty_vt.vt.Terminal = try .init(testing.io, testing.allocator, .{ .cols = @intCast(width), .rows = @intCast(height) });
        var stream = terminal.vtStream();
        defer stream.deinit();
        // Grapheme clustering, as the renderer assumes.
        stream.nextSlice("\x1b[?2027h");
        return terminal;
    }

    fn deinit(self: *Harness) void {
        self.terminal.deinit(testing.allocator);
        self.model.deinit();
        for (&self.bytes) |*bytes| bytes.deinit(testing.allocator);
        for (self.twins) |twin| twin.deinit();
    }

    fn handle(self: *const Harness, twin: usize, slot: usize) context.Handle {
        return self.model.handles[slot].?[twin];
    }

    /// Applies one op to both twins, which must agree on the result, then to the model.
    fn apply(self: *Harness, op: Op) !void {
        const results = [2]anyerror!void{ self.applyOn(reference, op), self.applyOn(candidate, op) };
        try testing.expectEqual(results[0], results[1]);
        if (results[0]) |_| {} else |_| return;
        switch (op) {
            .create => |value| {
                self.model.kind[value.slot] = value.kind;
                self.model.z[value.slot] = 0;
                self.model.hidden[value.slot] = false;
                self.model.hook_generation[value.slot] = 0;
                self.model.text_options[value.slot] = .{};
                self.model.hooks[value.slot] = 0;
                self.model.focusable[value.slot] = false;
                self.model.unmeasured[value.slot] = false;
                if (value.kind == .text_view) self.stats.rebinds += 1;
            },
            .destroy => |slot| {
                self.model.views[slot] = .{ null, null };
                try self.model.destroy(slot);
                // Removal rehashes the token map before tombstones take half of its free slots.
                for (self.twins) |f| try testing.expect(f.state.token_tombstones < (f.state.tokens.capacity() - f.state.tokens.count()) / 2 + 1);
            },
            .rebind => self.stats.rebinds += 1,
            .shared_text, .highlight => self.stats.shared_changes += @intFromBool(self.viewShown()),
            .register => self.stats.style_changes += @intFromBool(self.viewShown()),
            .selection => self.stats.selections += 1,
            .resend => self.stats.resends += 1,
            .palette => self.stats.palettes += 1,
            .raw => |value| {
                self.stats.raw_writes += 1;
                // A written current buffer no longer matches the terminal.
                if (value.kind == 2) self.decoder_synced = false;
                if (value.kind == 3) {
                    try testing.expectEqualSlices(u8, self.bytes[reference].items, self.bytes[candidate].items);
                    var stream = self.terminal.vtStream();
                    defer stream.deinit();
                    stream.nextSlice(self.bytes[candidate].items);
                }
            },
            .move => |value| try self.model.move(value.slot, value.parent, value.index),
            .resize => |value| {
                self.terminal.deinit(testing.allocator);
                self.terminal = try newTerminal(value.width, value.height);
                self.decoder_synced = false;
            },
            .paint => |value| {
                if (value.fields & c.OT_SCENE_PROPERTY_Z_INDEX != 0) self.model.z[value.slot] = value.paint.zIndex;
                if (value.fields & c.OT_SCENE_PROPERTY_FOCUSABLE != 0) self.model.focusable[value.slot] = value.paint.focusable and value.paint.borderSides != 0;
            },
            .style => |value| if (value.group == c.OT_STYLE_ENUM and value.kind == c.OT_STYLE_ENUM_DISPLAY) {
                self.model.hidden[value.slot] = value.value != 0;
            },
            .hooks => |value| {
                self.model.hook_generation[value.slot] += 1;
                self.model.hooks[value.slot] = value.flags;
            },
            .text_options => |value| self.model.text_options[value.slot] = value.options,
            .viewport => |bound| self.model.bound = bound,
            .measure => |slot| self.model.unmeasured[slot] = true,
            .text => |value| self.stats.unmeasured_texts += @intFromBool(self.model.unmeasured[value.slot] and self.model.bound and self.model.parent[value.slot] == content_slot),
            else => {},
        }
    }

    fn applyOn(self: *Harness, twin: usize, op: Op) anyerror!void {
        const f = self.twins[twin];
        switch (op) {
            .create => |value| {
                const kind: u32 = switch (value.kind) {
                    .box => c.OT_SCENE_BOX,
                    .text => c.OT_SCENE_TEXT,
                    .slider => c.OT_SCENE_SLIDER,
                    .editor => c.OT_SCENE_EDITOR,
                    .text_view => c.OT_SCENE_TEXT_VIEW,
                };
                const created = try f.owner.sceneCreateNode(f.id, kind, Model.num(value.slot));
                if (self.model.handles[value.slot] == null) self.model.handles[value.slot] = undefined;
                self.model.handles[value.slot].?[twin] = created;
                if (value.kind == .editor) {
                    const edit = try f.owner.createEditBuffer(.unicode);
                    try f.owner.sceneSetEditorView(created, try f.owner.createEditorView(edit, 1, 1));
                    self.model.edits[value.slot][twin] = edit;
                }
                if (value.kind == .text_view) try self.bindView(twin, value.slot);
            },
            .rebind => |value| {
                if (self.model.views[value.slot][twin]) |view| {
                    try f.owner.destroy(view);
                    self.model.views[value.slot][twin] = null;
                }
                if (value.bind) try self.bindView(twin, value.slot);
            },
            .shared_text => |seed| {
                const texts = [_][]const u8{ "", "shared", "shared text\nsecond line", "\u{754c}\u{754c} wide", "e\u{301}e\u{301} marks" };
                try f.owner.textBufferSetText(self.shared[twin], texts[seed % texts.len]);
            },
            .highlight => |value| try f.owner.textBufferHighlight(self.shared[twin], .{ .add_range = .{ .start = value.start, .end = value.end, .style_id = 1 } }),
            .register => |value| {
                if (value.destroy) if (self.style[twin]) |style| {
                    try f.owner.destroy(style);
                    self.style[twin] = null;
                    return;
                };
                if (self.style[twin] == null) {
                    const style = try f.owner.createSyntaxStyle();
                    self.style[twin] = style;
                    try f.owner.textBufferSetSyntaxStyle(self.shared[twin], style);
                }
                _ = try f.owner.syntaxStyleRegister(self.style[twin].?, "name", .{ .fg = ansi.rgbColor(255, value.foreground, 0, 255), .bg = null, .attributes = 0 });
            },
            // Local coordinates: from the node's first cell.
            .selection => |value| _ = try f.owner.sceneSetTextSelection(self.handle(twin, value.slot), .{
                .operation = if (value.set) c.OT_SCENE_TEXT_SELECTION_SET else c.OT_SCENE_TEXT_SELECTION_RESET,
                .focus_x = value.focus,
                .background = ansi.rgbColor(0, 0, 255, 255),
            }),
            .resend => |slot| {
                const node = (try f.owner.raw().getRenderable(self.handle(twin, slot))).scene_node.?;
                try f.owner.scenePatchPaint(self.handle(twin, slot), c.OT_SCENE_PROPERTY_BACKGROUND | c.OT_SCENE_PROPERTY_OPACITY | c.OT_SCENE_PROPERTY_TRANSLATE_X, node.paint);
            },
            .palette => |epoch| f.cli.setPaletteState(&.{ ansi.rgbColor(0, 0, 0, 255), ansi.rgbColor(255, 0, 0, 255) }, ansi.rgbColor(255, 255, 255, 255), ansi.rgbColor(0, 0, 0, 255), epoch),
            .raw => |value| switch (value.kind) {
                0 => try f.owner.drawSessionBuffer(f.id, self.scratch[twin], value.x, value.y),
                1, 2 => {
                    const lease = try f.owner.acquireSessionBufferLease(f.id, if (value.kind == 1) .next else .current);
                    const snapshot = try f.owner.bufferLeaseSnapshot(lease);
                    // A color: raw character writes would bypass the buffer's grapheme accounting.
                    snapshot.buffer.bg[@as(usize, @intCast(value.x + 1)) % snapshot.buffer.bg.len] = ansi.rgbColor(0, 200, 0, 255);
                    try f.owner.releaseBufferLease(lease);
                },
                else => {
                    try f.owner.drawSessionBuffer(f.id, self.scratch[twin], value.x, value.y);
                    _ = try f.owner.renderSession(f.id, false);
                    self.bytes[twin].clearRetainingCapacity();
                    try self.drain(twin);
                },
            },
            .move => |value| try f.owner.sceneMoveNode(self.handle(twin, value.slot), if (value.parent) |parent| self.handle(twin, parent) else null, value.index),
            .destroy => |slot| try f.owner.sceneDestroyNode(self.handle(twin, slot)),
            .paint => |value| try f.owner.scenePatchPaint(self.handle(twin, value.slot), value.fields, value.paint),
            .style => |value| try f.owner.sceneSetStyle(self.handle(twin, value.slot), value.group, value.kind, 0, value.unit, value.value, value.flags),
            .position => |value| try f.owner.sceneSetPositions(self.handle(twin, value.slot), 3, .{ 1, 1, 0, 0 }, .{ value.left, value.top, 0, 0 }),
            .focus => |value| try f.owner.sceneSetFocus(self.handle(twin, value.slot), value.focused),
            .text => |value| {
                // ASCII words with a wide CJK cell and a combining mark, so graphemes reach the buffers.
                var bytes: [64]u8 = undefined;
                var len: usize = 0;
                for (0..value.seed % 20) |index| {
                    const piece: []const u8 = switch ((value.seed >> @intCast(index % 16)) % 11) {
                        0 => " ",
                        1 => "\u{754c}",
                        2 => "e\u{301}",
                        else => &.{@intCast('a' + (value.seed + index) % 26)},
                    };
                    @memcpy(bytes[len..][0..piece.len], piece);
                    len += piece.len;
                }
                try f.owner.sceneSetText(self.handle(twin, value.slot), bytes[0..len]);
            },
            .slider => |value| try f.owner.sceneSetSlider(self.handle(twin, value.slot), .{ .value = value.value, .orientation = value.orientation }),
            .text_options => |value| try f.owner.sceneSetTextOptions(self.handle(twin, value.slot), value.options),
            .measure => |slot| try f.owner.sceneSetMeasure(self.handle(twin, slot), null),
            .hooks => |value| try f.owner.sceneSetHooks(self.handle(twin, value.slot), value.flags, self.model.hook_generation[value.slot] + 1, 1, 1),
            .viewport => |bound| try f.owner.sceneSetViewport(self.handle(twin, content_slot), if (bound) self.handle(twin, viewport_slot) else null),
            .resize => |value| try f.owner.resizeSessionRenderer(f.id, value.width, value.height),
            .editor => |value| {
                const lines = [_][]const u8{ "", "ab", "a\nbc", "\u{754c}x\n\n" };
                try f.owner.editSetText(self.model.edits[value.slot][twin], lines[value.seed % lines.len], false);
                try f.owner.sceneSetEditorOptions(self.handle(twin, value.slot), .{ .show_cursor = value.show_cursor, .style = value.style });
            },
            .host_cursor => |value| try f.owner.controlSession(f.id, .{ .cursor = .{ .position = .{ .x = value.x, .y = value.y, .visible = value.visible } } }),
        }
    }

    fn liveSlot(self: *const Harness, first: usize) ?usize {
        const start = self.random.intRangeLessThan(usize, first, node_count_max);
        for (0..node_count_max - first) |offset| {
            const slot = first + (start - first + offset) % (node_count_max - first);
            if (self.model.handles[slot] != null) return slot;
        }
        return null;
    }

    fn boxSlot(self: *const Harness) usize {
        while (true) {
            const slot = self.random.uintLessThan(usize, node_count_max);
            if (self.model.handles[slot] != null and self.model.kind[slot] == .box) return slot;
        }
    }

    /// Draws one op. Kinds that a reply may also send come from `generateReply`.
    fn generate(self: *Harness) ?Op {
        const random = self.random;
        const empty = random.intRangeLessThan(usize, scaffold_slots, node_count_max);
        if (self.model.handles[empty] == null) return .{ .create = .{ .slot = empty, .kind = switch (random.uintLessThan(u32, 10)) {
            0, 1 => .box,
            2 => .slider,
            8 => .editor,
            9 => .text_view,
            else => .text,
        } } };
        const slot = self.liveSlot(scaffold_slots) orelse return null;
        return switch (random.uintLessThan(u32, 27)) {
            // Moves favor the content so its children pass the filter cutoff.
            0...7 => blk: {
                const parent: ?usize = switch (random.uintLessThan(u32, 8)) {
                    0...4 => content_slot,
                    5 => self.model.parent[slot] orelse root_slot,
                    6 => null,
                    else => self.boxSlot(),
                };
                const siblings = if (parent) |value| self.model.children[value].items.len else 0;
                break :blk .{ .move = .{ .slot = slot, .parent = parent, .index = random.uintLessThan(u32, @intCast(siblings + 2)) } };
            },
            8 => .{ .destroy = slot },
            // Focus moves favor editors, which own the cursor, and nodes with focusable borders,
            // where focus changes the border color.
            9 => .{ .focus = .{ .slot = for (scaffold_slots..node_count_max) |candidate_slot| {
                if (self.model.handles[candidate_slot] == null) continue;
                if ((self.model.focusable[candidate_slot] or self.model.kind[candidate_slot] == .editor) and random.boolean()) break candidate_slot;
            } else slot, .focused = random.boolean() } },
            10 => self.generateHooks() orelse self.generateReply(slot),
            15 => self.generateHookedChange() orelse self.generateReply(slot),
            11 => if (random.boolean()) .{ .viewport = random.boolean() } else .{ .resize = .{ .width = random.intRangeAtMost(u32, 10, 20), .height = random.intRangeAtMost(u32, 4, 8) } },
            13, 14 => if (self.model.kind[slot] == .text) self.generateText(slot) else self.generateReply(slot),
            16 => .{ .host_cursor = .{ .x = random.intRangeAtMost(i32, 0, 20), .y = random.intRangeAtMost(i32, 0, 8), .visible = random.boolean() } },
            17 => if (self.model.kind[slot] == .editor) .{ .editor = .{ .slot = slot, .seed = random.int(u32), .show_cursor = random.uintLessThan(u32, 4) != 0, .style = random.uintLessThan(u32, 4) } } else self.generateReply(slot),
            12 => .{ .paint = .{ .slot = content_slot, .fields = c.OT_SCENE_PROPERTY_TRANSLATE_Y, .paint = .{ .translateY = @as(f32, @floatFromInt(-random.intRangeAtMost(i32, 0, 24))) / 2 } } },
            21 => if (self.model.kind[slot] == .text_view) .{ .rebind = .{ .slot = slot, .bind = random.uintLessThan(u32, 4) != 0 } } else .{ .shared_text = random.int(u32) },
            22 => if (random.boolean()) .{ .shared_text = random.int(u32) } else .{ .highlight = .{ .start = random.uintLessThan(u32, 8), .end = random.uintLessThan(u32, 16) } },
            23 => .{ .register = .{ .foreground = random.int(u8), .destroy = random.uintLessThan(u32, 6) == 0 } },
            24 => if (self.model.kind[slot] == .text) .{ .selection = .{ .slot = slot, .set = random.boolean(), .focus = random.intRangeAtMost(i32, 0, 8) } } else .{ .resend = slot },
            25 => .{ .resend = slot },
            26 => if (random.uintLessThan(u32, 6) == 0) .{ .palette = random.uintLessThan(u32, 4) } else .{ .raw = .{ .kind = random.uintLessThan(u32, 4), .x = random.intRangeAtMost(i32, -1, 20), .y = random.intRangeAtMost(i32, -1, 8) } },
            else => self.generateReply(slot),
        };
    }

    /// Hooks stay on the root, a few slots, and content children, and half the changes clear
    /// them, so hook-free frames that reuse work recur. Only the root may take LAYOUT_CHANGED.
    fn generateHooks(self: *Harness) ?Op {
        const random = self.random;
        const clear = random.boolean();
        return switch (random.uintLessThan(u32, 4)) {
            0 => .{ .hooks = .{ .slot = root_slot, .flags = if (clear) 0 else c.OT_SCENE_HOOK_LAYOUT_CHANGED | (if (random.boolean()) c.OT_SCENE_HOOK_UPDATE else 0) } },
            1, 2 => blk: {
                const children = self.model.children[content_slot].items;
                if (children.len == 0) break :blk null;
                const child = children[random.uintLessThan(usize, children.len)];
                break :blk .{ .hooks = .{ .slot = child, .flags = if (clear) 0 else c.OT_SCENE_HOOK_RESIZE | (if (random.boolean()) c.OT_SCENE_HOOK_UPDATE else 0) } };
            },
            else => blk: {
                const hooked = random.intRangeLessThan(usize, scaffold_slots, scaffold_slots + 4);
                if (self.model.handles[hooked] == null) break :blk null;
                const flags = random.intRangeLessThan(u32, 1, 128) & ~@as(u32, c.OT_SCENE_HOOK_LAYOUT_CHANGED);
                break :blk .{ .hooks = .{ .slot = hooked, .flags = if (clear) 0 else flags } };
            },
        };
    }

    /// A size change on a content child with a RESIZE hook, or a display change on an ancestor
    /// of a hooked node.
    fn generateHookedChange(self: *Harness) ?Op {
        const random = self.random;
        const start = random.uintLessThan(usize, node_count_max);
        for (0..node_count_max) |offset| {
            const slot = (start + offset) % node_count_max;
            if (slot == root_slot or self.model.handles[slot] == null or self.model.hooks[slot] & ~@as(u32, 64) == 0) continue;
            if (self.model.hooks[slot] & c.OT_SCENE_HOOK_RESIZE != 0 and random.boolean()) {
                return .{ .style = .{ .slot = slot, .group = c.OT_STYLE_DIMENSION, .kind = random.uintLessThan(u32, 2), .unit = 1, .value = @floatFromInt(random.intRangeAtMost(u32, 1, 6)), .flags = 1 } };
            }
            var ancestor = self.model.parent[slot] orelse return null;
            while (ancestor != root_slot and random.boolean()) ancestor = self.model.parent[ancestor] orelse break;
            if (ancestor == root_slot) return null;
            return .{ .style = .{ .slot = ancestor, .group = c.OT_STYLE_ENUM, .kind = c.OT_STYLE_ENUM_DISPLAY, .unit = 0, .value = @floatFromInt(@intFromBool(!self.model.hidden[ancestor])), .flags = 0 } };
        }
        return null;
    }

    /// Ops a hook reply may also send.
    fn generateReply(self: *Harness, slot: usize) Op {
        const random = self.random;
        return switch (random.uintLessThan(u32, 6)) {
            0, 1 => blk: {
                const fields = [_]u32{ c.OT_SCENE_PROPERTY_Z_INDEX, c.OT_SCENE_PROPERTY_OPACITY, c.OT_SCENE_PROPERTY_TRANSLATE_X, c.OT_SCENE_PROPERTY_BORDER, c.OT_SCENE_PROPERTY_BACKGROUND };
                // Content children keep equal z most of the time, as scroll content does.
                // A border change also sets focusable, so focus moves change border colors.
                var field = fields[random.uintLessThan(usize, fields.len)];
                if (field == c.OT_SCENE_PROPERTY_BORDER) field |= c.OT_SCENE_PROPERTY_FOCUSABLE;
                const z = if (self.model.parent[slot] == content_slot and random.uintLessThan(u32, 4) != 0) 0 else random.intRangeAtMost(i32, -2, 2);
                break :blk .{
                    .paint = .{
                        .slot = slot,
                        .fields = field,
                        .paint = .{
                            .zIndex = z,
                            .opacity = @as(f32, @floatFromInt(random.uintLessThan(u32, 5))) / 4,
                            // Half cells too: sub-cell translations that round to the same cells.
                            .translateX = @as(f32, @floatFromInt(random.intRangeAtMost(i32, -6, 6))) / 2,
                            .borderSides = random.uintLessThan(u32, 16),
                            .focusable = random.boolean(),
                            .background = .{ random.int(u8), 0, 0, random.int(u8) },
                        },
                    },
                };
            },
            2 => .{ .style = .{ .slot = slot, .group = c.OT_STYLE_ENUM, .kind = c.OT_STYLE_ENUM_DISPLAY, .unit = 0, .value = @floatFromInt(@intFromBool(random.uintLessThan(u32, 4) == 0)), .flags = 0 } },
            3 => .{ .style = .{ .slot = slot, .group = c.OT_STYLE_DIMENSION, .kind = random.uintLessThan(u32, 2), .unit = 1, .value = @floatFromInt(random.intRangeAtMost(u32, 1, 6)), .flags = 1 } },
            4 => if (self.model.kind[slot] == .text) self.generateText(slot) else if (self.model.kind[slot] == .slider)
                .{ .slider = .{ .slot = slot, .value = @floatFromInt(random.uintLessThan(u32, 101)), .orientation = random.uintLessThan(u32, 2) } }
            else
                .{ .style = .{ .slot = slot, .group = c.OT_STYLE_ENUM, .kind = c.OT_STYLE_ENUM_OVERFLOW, .unit = 0, .value = @floatFromInt(random.uintLessThan(u32, 2)), .flags = 0 } },
            else => if (random.uintLessThan(u32, 3) == 0)
                .{ .style = .{ .slot = slot, .group = c.OT_STYLE_ENUM, .kind = c.OT_STYLE_ENUM_POSITION_TYPE, .unit = 0, .value = @floatFromInt(1 + random.uintLessThan(u32, 2)), .flags = 0 } }
            else
                .{ .position = .{ .slot = slot, .left = @floatFromInt(random.uintLessThan(u32, 14)), .top = @floatFromInt(random.uintLessThan(u32, 8)) } },
        };
    }

    /// A text replacement, new text options (color, attributes, or layout options alone), or
    /// the measure function's removal.
    fn generateText(self: *Harness, slot: usize) Op {
        const random = self.random;
        var options = self.model.text_options[slot];
        // Without a measure function, a replacement does not solve: the case B2 marks stale.
        if (self.model.unmeasured[slot] and random.boolean()) return .{ .text = .{ .slot = slot, .seed = random.int(u32) } };
        switch (random.uintLessThan(u32, 7)) {
            0 => return .{ .text = .{ .slot = slot, .seed = random.int(u32) } },
            6 => return .{ .measure = slot },
            1 => options.foreground = .{ random.int(u8), 255, 255, 255 },
            2 => options.attributes = random.uintLessThan(u32, 16),
            3 => options.wrap_mode = random.enumValue(@import("../text-buffer-view.zig").WrapMode),
            4 => options.truncate = !options.truncate,
            else => options.scroll_y = @floatFromInt(random.uintLessThan(u32, 2)),
        }
        return .{ .text_options = .{ .slot = slot, .options = options } };
    }

    /// A move the model predicts to be rejected must be rejected by both twins.
    fn expectMove(self: *Harness, op: Op) !void {
        const value = op.move;
        const same = value.parent != null and self.model.parent[value.slot] == value.parent;
        const valid = if (value.parent) |parent| !self.model.contains(value.slot, parent) and value.index <= self.model.children[parent].items.len - @intFromBool(same) else value.index == 0;
        if (valid) return self.apply(op);
        for (0..2) |twin| try testing.expectError(error.YogaInvalidArgument, self.applyOn(twin, op));
    }

    fn frameSpec(self: *Harness) FrameSpec {
        const random = self.random;
        var excluded: u32 = 0;
        if (random.uintLessThan(u32, 8) == 0) {
            if (self.liveSlot(0)) |slot| excluded = Model.num(slot);
        }
        return .{
            .options = .{
                .background = if (random.uintLessThan(u32, 16) == 0) .{ random.int(u8), 0, 0, 255 } else .{ 0, 0, 0, 255 },
                .use_mouse = random.uintLessThan(u32, 8) != 0,
                .excluded_hit_num = excluded,
                .max_layout_rounds = 8,
                .max_host_requests = 64,
            },
            .force = random.uintLessThan(u32, 16) == 0,
            .cancel_first = random.uintLessThan(u32, 16) == 0,
        };
    }

    /// Drives one frame on both twins in lockstep. Returns false if both rejected the attempt.
    fn drive(self: *Harness, spec: FrameSpec) !bool {
        var requests: [2]?scene.FrameRequest = .{ null, null };
        var recording: Recording = .{};
        var record: ?[]const u8 = null;
        while (true) {
            const results = [2]anyerror!scene.FrameRequest{
                self.twins[reference].owner.sceneFrameStepWithRecording(self.twins[reference].id, requests[reference], spec.options, record),
                self.twins[candidate].owner.sceneFrameStepWithRecording(self.twins[candidate].id, requests[candidate], spec.options, record),
            };
            const first = results[reference] catch |err| {
                try testing.expectError(err, results[candidate]);
                return false;
            };
            const second = try results[candidate];
            try self.expectSameRequest(first, second);
            requests = .{ first, second };
            record = null;
            switch (first.kind) {
                0 => return true,
                c.OT_SCENE_FRAME_RECORD => {
                    self.stats.records += 1;
                    recording = .{};
                    try self.expectSameSlots(first, second, &recording);
                    record = recording.view();
                },
                else => {
                    switch (first.kind) {
                        c.OT_SCENE_FRAME_UPDATE => self.stats.updates += 1,
                        c.OT_SCENE_FRAME_RESIZE => self.stats.resizes += 1,
                        else => self.stats.layout_changes += 1,
                    }
                    const requester = self.model.slotOf(reference, first.node).?;
                    if (first.kind == c.OT_SCENE_FRAME_RESIZE and self.model.parent[requester] == content_slot) {
                        self.stats.content_resizes += 1;
                        // A text change on a content child in the middle of the refresh batch (B2 argon-2).
                        const children = self.model.children[content_slot].items;
                        const start = self.random.uintLessThan(usize, children.len);
                        for (0..children.len) |offset| {
                            const target = children[(start + offset) % children.len];
                            if (self.model.kind[target] != .text) continue;
                            // Truncation changes the view without a solve.
                            var options = self.model.text_options[target];
                            options.truncate = !options.truncate;
                            try self.apply(.{ .text_options = .{ .slot = target, .options = options } });
                            self.stats.content_reply_texts += 1;
                            break;
                        }
                    }
                    for (0..self.random.uintLessThan(u32, 3)) |_| {
                        const slot = self.liveSlot(scaffold_slots) orelse break;
                        try self.apply(self.generateReply(slot));
                    }
                    // Hiding the requester's parent mid-frame makes the visibility walk meet a hidden
                    // ancestor of a node it already stamped (B2 invariant 7).
                    // Detaching it instead makes the walk meet a node whose ancestry moved.
                    if (self.model.parent[requester]) |parent| if (parent != root_slot and self.random.uintLessThan(u32, 4) == 0) {
                        if (requester >= scaffold_slots and self.random.boolean()) {
                            try self.apply(.{ .move = .{ .slot = requester, .parent = null, .index = 0 } });
                            self.stats.reply_detaches += 1;
                        } else {
                            try self.apply(.{ .style = .{ .slot = parent, .group = c.OT_STYLE_ENUM, .kind = c.OT_STYLE_ENUM_DISPLAY, .unit = 0, .value = 1, .flags = 0 } });
                            self.stats.reply_hides += 1;
                        }
                    };
                },
            }
        }
    }

    fn expectSameRequest(self: *const Harness, first: scene.FrameRequest, second: scene.FrameRequest) !void {
        try testing.expectEqual(first.kind, second.kind);
        try testing.expectEqual(first.num, second.num);
        try testing.expectEqual(first.width, second.width);
        try testing.expectEqual(first.height, second.height);
        try testing.expectEqual(first.frame_id, second.frame_id);
        try testing.expectEqual(first.request_id, second.request_id);
        try testing.expectEqual(first.layout_epoch, second.layout_epoch);
        try testing.expectEqual(first.hook_generation, second.hook_generation);
        try testing.expectEqual(self.model.slotOf(reference, first.node), self.model.slotOf(candidate, second.node));
    }

    /// The RECORD snapshots must match; both twins then get the same recording.
    fn expectSameSlots(self: *const Harness, first: scene.FrameRequest, second: scene.FrameRequest, recording: *Recording) !void {
        const slots = [2][]const scene.PaintSlot{
            try self.twins[reference].owner.sceneFramePaintSlots(self.twins[reference].id, first),
            try self.twins[candidate].owner.sceneFramePaintSlots(self.twins[candidate].id, second),
        };
        try testing.expectEqual(slots[0].len, slots[1].len);
        for (slots[0], slots[1], 0..) |a, b, index| {
            try testing.expectEqual(a.num, b.num);
            try testing.expectEqual(a.hooks, b.hooks);
            try testing.expectEqual(a.layout, b.layout);
            try testing.expectEqual(a.clip, b.clip);
            try testing.expectEqual(a.opacity, b.opacity);
            // One phase per slot keeps the recording within its buffer.
            if (index >= 12) continue;
            const phase: u32 = if (a.hooks & c.OT_SCENE_HOOK_RENDER_BEFORE != 0) c.OT_SCENE_RECORD_PHASE_BEFORE else if (a.hooks & c.OT_SCENE_HOOK_RENDER_SELF != 0) c.OT_SCENE_RECORD_PHASE_SELF else c.OT_SCENE_RECORD_PHASE_AFTER;
            recording.slot(@intCast(index), phase);
            const x: i32 = @intFromFloat(a.layout.screenX);
            const y: i32 = @intFromFloat(a.layout.screenY);
            if (index % 2 == 0) recording.text("r", x, y) else recording.fill(x, y, 2, .{ @intCast(a.num), 40, 0, 255 });
        }
    }

    /// One frame: optional cancelled draft, lockstep steps, commit, output, and every comparison.
    fn frame(self: *Harness) !void {
        const spec = self.frameSpec();
        if (spec.cancel_first and try self.drive(spec)) {
            for (self.twins) |twin| try twin.owner.sceneFrameCancel(twin.id, twin.state.painted.?.ticket.frame_id);
        }
        if (!try self.drive(spec)) return;
        // A write after paint must reach the terminal, on a skipped or partly diffed draft too.
        if (self.random.uintLessThan(u32, 8) == 0) {
            const kind = self.random.uintLessThan(u32, 3);
            const x = self.random.intRangeAtMost(i32, -1, 20);
            for (self.twins, self.scratch) |twin, scratch| {
                const ticket = twin.state.painted.?.ticket;
                if (kind == 0) {
                    try twin.owner.sceneFrameDrawBuffer(twin.id, ticket, scratch, x, @divTrunc(x, 4));
                } else {
                    const lease = try twin.owner.sceneFrameAcquireBufferLease(twin.id, ticket, if (kind == 1) .next else .current);
                    const snapshot = try twin.owner.bufferLeaseSnapshot(lease);
                    snapshot.buffer.bg[@as(usize, @intCast(x + 1)) % snapshot.buffer.bg.len] = ansi.rgbColor(0, 0, 200, 255);
                    try twin.owner.releaseBufferLease(lease);
                }
            }
            if (kind == 2) self.decoder_synced = false;
            self.stats.draft_writes += 1;
        }
        try self.twins[reference].expectSameCells(self.twins[candidate]);
        try self.expectPaintOrder();
        var hidden_hooked = false;
        for (self.model.handles, 0..) |maybe, slot| {
            if (maybe != null and self.model.hooks[slot] != 0 and self.model.hiddenAbove(slot)) hidden_hooked = true;
        }
        const drafted = cellHash(self.twins[candidate].cli.getNextBuffer());
        // The draft's hit token per cell, as a grid that every member overwrote in paint order.
        var drafted_hits: [max_cells]u32 = undefined;
        const draft = self.twins[candidate];
        const cells = draft.cli.width * draft.cli.height;
        for (drafted_hits[0..cells], 0..) |*hit, index| hit.* = draft.draftHit(index);
        var statuses: [2]@import("../session.zig").RenderStatus = undefined;
        for (self.twins, 0..) |twin, index| {
            statuses[index] = try twin.owner.sceneFrameCommit(twin.id, twin.state.painted.?.ticket, spec.force);
            self.bytes[index].clearRetainingCapacity();
            try self.drain(index);
        }
        try testing.expectEqual(statuses[0], statuses[1]);
        try testing.expectEqualSlices(u8, self.bytes[reference].items, self.bytes[candidate].items);
        // The encoder synced every drafted cell into the presented buffer, and the hits followed.
        try testing.expectEqual(drafted, cellHash(self.twins[candidate].cli.currentRenderBuffer));
        for (drafted_hits[0..cells], 0..) |hit, index| {
            try testing.expectEqual(hit, draft.state.hitToken(draft.cli, @intCast(index % draft.cli.width), @intCast(index / draft.cli.width)));
        }
        try self.expectSamePresentation();
        if (spec.force) self.decoder_synced = true;
        try self.expectDecoded();
        try self.expectReference();
        const work = (try self.twins[candidate].owner.sceneGetStats(self.twins[candidate].id)).frameWork;
        self.stats.frames += 1;
        self.stats.reused += @intFromBool(work.candidate_visits == 0);
        self.stats.skipped += @intFromBool(work.damage_rows == 0);
        self.stats.partial += @intFromBool(work.damage_rows != 0 and work.damage_rows < self.twins[candidate].cli.height);
        self.stats.filtered += @intFromBool(work.overlap_tests != 0);
        self.stats.filtered_requests += @intFromBool(work.overlap_tests != 0 and work.host_requests != 0);
        self.stats.hidden_hooked += @intFromBool(hidden_hooked);
        const cursor = try self.twins[candidate].owner.sceneGetCursorState(self.twins[candidate].id);
        self.stats.editor_cursors += @intFromBool(self.twins[candidate].state.editor_cursor_owned);
        self.stats.host_cursors += @intFromBool(cursor.visible and !self.twins[candidate].state.editor_cursor_owned);
        // Field by field: the struct's padding is unspecified.
        inline for (std.meta.fields(renderer.FrameWork)) |field| {
            self.stats.digest = std.hash.Wyhash.hash(self.stats.digest, std.mem.asBytes(&@field(work, field.name)));
        }
    }

    /// Appends a twin's pending output to its bytes.
    fn drain(self: *Harness, twin: usize) !void {
        const f = self.twins[twin];
        var chunk: [8192]u8 = undefined;
        while (try f.owner.readOutput(f.id, &chunk)) |ticket| {
            try self.bytes[twin].appendSlice(testing.allocator, chunk[0..ticket.len]);
            try f.owner.completeOutput(f.id, ticket, .written);
        }
    }

    fn bindView(self: *Harness, twin: usize, slot: usize) !void {
        const f = self.twins[twin];
        const view = try f.owner.createTextBufferView(self.shared[twin]);
        try f.owner.sceneSetTextView(self.handle(twin, slot), view);
        self.model.views[slot][twin] = view;
    }

    /// Whether a bound text view is attached under the root and shown.
    fn viewShown(self: *const Harness) bool {
        for (self.model.views, 0..) |views, slot| {
            if (views[candidate] != null and self.model.contains(root_slot, slot) and !self.model.hidden[slot] and !self.model.hiddenAbove(slot)) return true;
        }
        return false;
    }

    /// A candidate frame that retained its work list paints in the model's order. The model
    /// sorts on every frame, as the scene does, so tie orders stay in step.
    fn expectPaintOrder(self: *Harness) !void {
        const f = self.twins[candidate];
        var order: [node_count_max]usize = undefined;
        const count = self.model.paintOrder(&order, 0, root_slot);
        if (f.state.work.items.len == 0) return;
        var painted: usize = 0;
        for (f.state.work.items) |entry| {
            if (entry.node.scene_node.?.kind == c.OT_SCENE_ROOT or !entry.visible) continue;
            try testing.expect(painted < count);
            try testing.expectEqual(self.handle(candidate, order[painted]), entry.node.scene_node.?.handle);
            painted += 1;
        }
        try testing.expectEqual(count, painted);
    }

    fn expectSamePresentation(self: *Harness) !void {
        const expected = self.twins[reference].cli;
        const actual = self.twins[candidate].cli;
        const owners = .{ self.twins[reference], self.twins[candidate] };
        const cells = .{ expected.currentRenderBuffer.buffer, actual.currentRenderBuffer.buffer };
        try fixture.expectSameChars(expected.currentRenderBuffer, actual.currentRenderBuffer);
        try testing.expectEqualSlices([4]u16, cells[0].fg, cells[1].fg);
        try testing.expectEqualSlices([4]u16, cells[0].bg, cells[1].bg);
        try testing.expectEqualSlices(u32, cells[0].attributes, cells[1].attributes);
        for (0..expected.height) |y| {
            for (0..expected.width) |x| {
                try testing.expectEqual(try owners[0].owner.sceneHitTest(owners[0].id, @intCast(x), @intCast(y)), try owners[1].owner.sceneHitTest(owners[1].id, @intCast(x), @intCast(y)));
            }
        }
        // The presented buffer holds the frame with consistent grapheme accounting.
        for (self.twins) |twin| try expectBufferInvariants(twin.cli.currentRenderBuffer);
        try testing.expectEqualDeep(try owners[0].owner.sceneGetCursorState(owners[0].id), try owners[1].owner.sceneGetCursorState(owners[1].id));
        for (0..4) |_| {
            const x = self.random.intRangeLessThan(i32, -1, @intCast(expected.width + 1));
            const y = self.random.intRangeLessThan(i32, -1, @intCast(expected.height + 1));
            try testing.expectEqual(try owners[0].owner.sceneHitTest(owners[0].id, x, y), try owners[1].owner.sceneHitTest(owners[1].id, x, y));
        }
        for (self.model.handles) |maybe| {
            const pair = maybe orelse continue;
            for ([_]bool{ false, true }) |raw| {
                const layouts = [2]anyerror!scene.Layout{ owners[0].owner.sceneGetLayout(pair[0], raw), owners[1].owner.sceneGetLayout(pair[1], raw) };
                // Bitwise, so detached nodes' NaN layouts compare equal.
                const first = layouts[0] catch |err| {
                    try testing.expectError(err, layouts[1]);
                    continue;
                };
                try testing.expectEqualSlices(u8, std.mem.asBytes(&first), std.mem.asBytes(&try layouts[1]));
            }
            // Resize baselines and prepared text views, including culled children's (B2 invariant 3).
            const nodes = .{ (try owners[0].owner.raw().getRenderable(pair[0])).scene_node.?, (try owners[1].owner.raw().getRenderable(pair[1])).scene_node.? };
            try testing.expectEqual(nodes[0].resize_width, nodes[1].resize_width);
            try testing.expectEqual(nodes[0].resize_height, nodes[1].resize_height);
            if (nodes[0].text) |text| {
                const views = .{ text.view, nodes[1].text.?.view };
                try testing.expectEqualDeep(views[0].getViewport(), views[1].getViewport());
                try testing.expectEqual(views[0].virtual_lines_dirty, views[1].virtual_lines_dirty);
                try testing.expectEqual(views[0].truncation_applied, views[1].truncation_applied);
            }
        }
    }

    /// The candidate's bytes, decoded by an independent terminal, show the presented cells.
    /// Grapheme cells are skipped; colors are compared where the terminal holds RGB.
    fn expectDecoded(self: *Harness) !void {
        var stream = self.terminal.vtStream();
        defer stream.deinit();
        stream.nextSlice(self.bytes[candidate].items);
        if (!self.decoder_synced) return;
        self.stats.decoded += 1;
        const cli = self.twins[candidate].cli;
        const pages = &self.terminal.screens.active.pages;
        for (0..cli.height) |y| for (0..cli.width) |x| {
            const cell = cli.currentRenderBuffer.get(@intCast(x), @intCast(y)).?;
            if (cell.char & gp.CHAR_TYPE_MASK != 0) continue;
            const decoded = pages.getCell(.{ .active = .{ .x = @intCast(x), .y = @intCast(y) } }).?;
            const codepoint: u32 = decoded.cell.codepoint();
            const glyph = if (cell.char == 0) ' ' else cell.char;
            try testing.expectEqual(glyph, if (codepoint == 0) ' ' else codepoint);
            const style = decoded.style();
            switch (style.bg_color) {
                .rgb => |rgb| try testing.expectEqual([3]u8{ ansi.red(cell.bg), ansi.green(cell.bg), ansi.blue(cell.bg) }, [3]u8{ rgb.r, rgb.g, rgb.b }),
                else => {},
            }
            if (glyph != ' ') switch (style.fg_color) {
                .rgb => |rgb| try testing.expectEqual([3]u8{ ansi.red(cell.fg), ansi.green(cell.fg), ansi.blue(cell.fg) }, [3]u8{ rgb.r, rgb.g, rgb.b }),
                else => {},
            };
            const attributes = cell.attributes;
            try testing.expectEqual(attributes & ansi.TextAttributes.BOLD != 0, style.flags.bold);
            try testing.expectEqual(attributes & ansi.TextAttributes.ITALIC != 0, style.flags.italic);
            try testing.expectEqual(attributes & ansi.TextAttributes.INVERSE != 0, style.flags.inverse);
            try testing.expectEqual(attributes & ansi.TextAttributes.STRIKETHROUGH != 0, style.flags.strikethrough);
        };
    }

    /// Every presented reference frame takes today's full path. Each Track B shortcut adds
    /// the counter it lowers here.
    fn expectReference(self: *Harness) !void {
        const f = self.twins[reference];
        const work = (try f.owner.sceneGetStats(f.id)).frameWork;
        const cells = @as(u64, f.cli.width) * f.cli.height;
        try testing.expect(work.full_path_reasons & renderer.FrameWork.full_path_forced != 0);
        try testing.expect(work.candidate_visits != 0);
        // Retained paint (B3): the reference clears and repaints every frame and diffs every row.
        try testing.expect(work.cells_cleared >= cells);
        try testing.expectEqual(f.cli.height, work.damage_rows);
        // Every round refreshes every child of a bound, visible content (B2 W3).
        const content_shown = !self.model.hidden[content_slot] and !self.model.hiddenAbove(content_slot);
        if (self.model.bound and content_shown) try testing.expect(work.viewport_child_refreshes >= self.model.children[content_slot].items.len);
        // Every member that feedback visits walks to the root (B2 W4).
        if (work.feedback_operations != 0) try testing.expect(work.visibility_steps != 0);
    }

    /// The tree each twin holds matches the model.
    fn expectTree(self: *Harness) !void {
        for (self.twins, 0..) |f, twin| {
            var live: u32 = 0;
            for (self.model.handles, 0..) |maybe, index| {
                const pair = maybe orelse continue;
                live += 1;
                const value = try f.owner.raw().getRenderable(pair[twin]);
                const node = value.scene_node.?;
                try testing.expectEqual(if (self.model.parent[index]) |parent| try f.owner.raw().getRenderable(self.handle(twin, parent)) else null, node.parent);
                try testing.expectEqual(pair[twin], f.state.tokens.get(node.token).?);
                try testing.expectEqual(self.model.children[index].items.len, node.children.items.len);
                for (self.model.children[index].items, node.children.items, 0..) |child, actual, position| {
                    var yoga_child: yoga.YGNodeRef = null;
                    try yoga.check(yoga.yogaNodeGetChildChecked(value.yoga_node, @intCast(position), &yoga_child));
                    try testing.expectEqual(actual.yoga_node, yoga_child);
                    try testing.expectEqual(self.handle(twin, child), actual.scene_node.?.handle);
                }
                try testing.expectEqual(self.model.paint[index].items.len, node.paint_children.items.len);
            }
            try testing.expectEqual(live, f.state.count);
            try testing.expectEqual(live, f.state.tokens.count());
        }
    }

    fn step(self: *Harness) !void {
        const op = self.generate() orelse return;
        switch (op) {
            .move => try self.expectMove(op),
            else => try self.apply(op),
        }
        try self.expectTree();
        try self.frame();
        // A frame without a change keeps the presented frame.
        if (self.random.uintLessThan(u32, 4) == 0) try self.frame();
        // A paint-only change after a settled frame is where work reuse happens.
        if (self.random.boolean()) {
            const slot = self.liveSlot(scaffold_slots) orelse return;
            const op_paint = self.generateReply(slot);
            if (op_paint != .paint) return;
            try self.apply(op_paint);
            try self.frame();
        }
    }
};

fn cellHash(target: *const @import("../buffer.zig").OptimizedBuffer) u64 {
    var hash = std.hash.Wyhash.init(0);
    inline for (.{ target.buffer.char, target.buffer.fg, target.buffer.bg, target.buffer.attributes }) |slice| hash.update(std.mem.sliceAsBytes(slice));
    return hash.final();
}

fn runParity(seed: u64, steps: usize) !Stats {
    var prng = std.Random.DefaultPrng.init(seed);
    var harness = try Harness.init(prng.random(), seed % 2 == 0);
    defer harness.deinit();
    for (0..steps) |_| try harness.step();
    return harness.stats;
}

test "Scene twin Sessions match a forced full-frame reference on every frame" {
    var total: Stats = .{};
    for (0..64) |seed| {
        errdefer std.debug.print("seed {d}\n", .{seed});
        const stats = try runParity(seed, 256);
        inline for (std.meta.fields(Stats)) |field| @field(total, field.name) +%= @field(stats, field.name);
    }
    // Every frame kind B2 and B3 rely on is reached in quantity (about a quarter of today's
    // counts; decoded frames at about two thirds), and each minimum fails if the draw that
    // produces its kind is removed. Counts at 64 x 256: reused 780, filtered 1,708, filtered with
    // a request 335, hooked under a hidden ancestor 6,503, reply hid the requester's parent 36,
    // reply detached the requester 27, content-child RESIZE 49, a truncation change in its reply
    // 49, unmeasured content text replaced 15, UPDATE 3,081, RESIZE 56, LAYOUT_CHANGED 1,433,
    // recordings 251, decoded 12,767, an editor's cursor 1,679, a host cursor 8,837, skipped
    // paint 8,365, partly diffed 1,254, draft writes after paint 2,877, raw writes between frames
    // 387, shared text changes shown 399, style changes shown 216, view binds 297, selections
    // 231, equal re-sends 781, palette changes 84.
    const minimums: Stats = .{
        .reused = 145,
        .filtered = 250,
        .filtered_requests = 45,
        .hidden_hooked = 2000,
        .reply_hides = 8,
        .reply_detaches = 6,
        .content_resizes = 12,
        .content_reply_texts = 12,
        .unmeasured_texts = 4,
        .updates = 650,
        .resizes = 14,
        .layout_changes = 350,
        .records = 60,
        .decoded = 8000,
        .editor_cursors = 400,
        .host_cursors = 1600,
        .skipped = 2000,
        .partial = 300,
        .draft_writes = 700,
        .raw_writes = 90,
        .shared_changes = 100,
        .style_changes = 50,
        .rebinds = 70,
        .selections = 55,
        .resends = 190,
        .palettes = 20,
    };
    inline for (std.meta.fields(Stats)) |field| {
        if (comptime std.mem.eql(u8, field.name, "frames") or std.mem.eql(u8, field.name, "digest")) continue;
        errdefer std.debug.print("{s}: {d}\n", .{ field.name, @field(total, field.name) });
        try testing.expect(@field(total, field.name) >= @field(minimums, field.name));
    }
    // Work counts read no clock: a seed that reaches reuse, every request kind, recordings,
    // and filtering replays to the same counts.
    try testing.expectEqual((try runParity(17, 256)).digest, (try runParity(17, 256)).digest);
}
