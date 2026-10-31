//! Twin-Session parity harness. A reference Session forced to the full path
//! (OT_SCENE_DEBUG_FULL_FRAME) and a candidate Session run one seeded script of
//! scene mutations, host replies, and frames. After every frame the two must
//! agree on host requests, in order, draft cells and hits, render status, encoded
//! bytes, presented cells and hits, cursor, hit tests, public and paint layouts, and every
//! node's paint order. FULL_FRAME visits every child, but it shares the feedback
//! passes' rule for children a reply marks, so it is an independent reference for
//! cells, hits, observations, and paint order, not for the order of hook calls.
//!
//! Extending it for a Track B step:
//! - a mutation kind: add an `Op` variant, its arm in `applyOn`, and a draw in
//!   `generate` (and in `generateReply` if a hook reply may send it);
//! - a shortcut's proof: add the counter it lowers to `expectReference`, which
//!   checks every presented reference frame;
//! - a frame kind it must reach: count it in `Stats` and give it a minimum in
//!   the test.
//! The script has editors, focus moves, host cursors, text views of one shared
//! text buffer and syntax style, scroll nodes (D2b), recordings that read views, editors,
//! text bodies, composed and destroyed resources, clear, recolor, or draw an image (B7), linked
//! text, split renders with and without a frame (B4), arrows whose text reaches past
//! their rect, and boxes with titles and border glyphs of spaces, but no image nodes, so image
//! node shortcuts are invisible to it.
//! Retained paint (B3, B4) is its gate: the candidate verifies every row it keeps or repaints
//! in a band on even seeds and skips paint outright on odd seeds, and the script writes the
//! buffers outside scene paint, before and after a draft's paint.
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
const vt_decode = @import("vt-decode.zig");
const ansi = @import("../ansi.zig");
const utils = @import("../utils.zig");

const node_count_max = 40;
const root_slot = 0;
const viewport_slot = 1;
const content_slot = 2;
/// The root, the viewport, and its content are never moved or destroyed.
const scaffold_slots = 3;
/// Paint hooks stay on the slots below this one.
const paint_hook_slots_end = scaffold_slots + 4;
const reference = 0;
const candidate = 1;
// The largest screen a resize step picks (20×8).
const max_cells = 20 * 8;

const Kind = enum { box, text, slider, editor, text_view, scroll, arrow };

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
    /// Edits the readers, which only recordings show: the text of the view and the editor,
    /// and the colors of the scene text.
    reader: u32,
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
    /// An explicit scroll of a scroll node, or its new options.
    scroll_to: struct { slot: usize, target: [2]f64, relative: bool, reapply: bool },
    scroll_request: struct { slot: usize, kind: u32, target: ?usize, alignment: u32, inset: u32 },
    scroll_options: struct { slot: usize, options: scene.ScrollOptions },
    /// An arrow's options and text, or a scroll node's bar arrow.
    arrow: struct { slot: usize, seed: u32 },
    scroll_arrow: struct { slot: usize, seed: u32 },
    /// A box's titles and border glyphs, with top and bottom borders over a transparent
    /// background, lifted a row over the node above it.
    box: struct { slot: usize, seed: u32 },
};

/// Options drawn once per frame.
const FrameSpec = struct {
    options: scene.FrameOptions,
    force: bool,
    cancel_first: bool,
};

/// Reference tree: each node's children in Yoga order and its paint children in attachment
/// order. Paint sorts a copy stably by z, so equal z paints in attachment order.
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
    fn paintOrder(self: *const Model, out: []usize, count: usize, node: usize) usize {
        var sorted: [node_count_max]usize = undefined;
        const children = sorted[0..self.paint[node].items.len];
        @memcpy(children, self.paint[node].items);
        std.mem.sort(usize, children, self, zLessThan);
        var next = count;
        for (children) |child| {
            if (self.hidden[child]) continue;
            out[next] = child;
            next = self.paintOrder(out, next + 1, child);
        }
        return next;
    }

    /// Whether `node` is attached under the root, with no hidden node at or above it.
    fn shown(self: *const Model, node: usize) bool {
        return self.contains(root_slot, node) and !self.hidden[node] and !self.hiddenAbove(node);
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
    /// Filtered frames with a request that kept the last frame's lists (B5a).
    reused_filtered_requests: u32 = 0,
    /// Frames whose culled paint list was checked against the model's order.
    culled_orders: u32 = 0,
    /// Frames with a hooked node under a hidden ancestor.
    hidden_hooked: u32 = 0,
    /// Host replies that hid an ancestor of the requesting node mid-frame.
    reply_hides: u32 = 0,
    /// Host replies that detached the requesting node mid-frame.
    reply_detaches: u32 = 0,
    /// Host replies that destroyed a node mid-frame, and RECORD replies that changed the scene.
    reply_destroys: u32 = 0,
    record_replies: u32 = 0,
    /// Nodes a reply created, attached, and destroyed again, as a list remount does.
    remounts: u32 = 0,
    /// RESIZE requests from children of the viewport content.
    content_resizes: u32 = 0,
    /// Replies to those requests that changed text on a content child, mid-batch.
    content_reply_texts: u32 = 0,
    /// Replies that gave a sibling of the requester, or its child, a hook or a text change (B5b).
    sibling_marks: u32 = 0,
    /// Text replaced on a filtered content child without a measure function, so without a solve.
    unmeasured_texts: u32 = 0,
    updates: u32 = 0,
    resizes: u32 = 0,
    layout_changes: u32 = 0,
    records: u32 = 0,
    /// SELF recordings of a box that play its native body.
    bodies: u32 = 0,
    decoded: u32 = 0,
    /// Frames that end with an editor's cursor, and with a host cursor shown.
    editor_cursors: u32 = 0,
    host_cursors: u32 = 0,
    /// Candidate frames that skipped paint (no damaged row), that diffed some rows only, and
    /// that cleared some rows only (B4).
    skipped: u32 = 0,
    partial: u32 = 0,
    banded: u32 = 0,
    /// Frames presented by a split render, and snapshot-only split renders before a frame.
    split_frames: u32 = 0,
    split_snapshots: u32 = 0,
    /// Recorded candidate frames that kept some rows (B7), and recordings that clear, recolor,
    /// or draw an image.
    retained_records: u32 = 0,
    non_local_records: u32 = 0,
    /// Recordings that drew a reader or another node's view with the same bytes on every frame.
    steady_reads: u32 = 0,
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
    /// Frames that show a scroll node with children, scrolls and option changes, and SCROLL requests.
    scroll_frames: u32 = 0,
    scroll_changes: u32 = 0,
    scroll_requests: u32 = 0,
    scroll_layouts: u32 = 0,
    /// Frames that show an arrow wholly left of the screen, whose text may reach into it.
    arrows_beside: u32 = 0,
    /// Width changes of a shown text view node right after a recording drew its view.
    view_resizes: u32 = 0,
    /// Reference frames' records of an on-screen box with a border, some of whose glyphs are spaces.
    framed_boxes: u32 = 0,
    /// Frames that prepared a culled row's subtree where it showed (B5d).
    subtree_preparations: u32 = 0,
    /// Folds every candidate frame's work counts, to check that a seed replays identically.
    digest: u64 = 0,
};

const Harness = struct {
    twins: [2]Fixture,
    model: Model = .{},
    random: std.Random,
    /// Draws for sibling marks, apart from `random`, so the script keeps its mix of frames.
    side: std.Random,
    stats: Stats = .{},
    bytes: [2]std.ArrayListUnmanaged(u8) = .{ .empty, .empty },
    /// Decodes the candidate's bytes independently of the encoder.
    terminal: vt_decode.Terminal,
    /// The decoder holds the whole screen: false after a resize until a forced frame.
    decoder_synced: bool = true,
    /// Per twin: the shared text buffer, its syntax style, a 2x1 buffer that raw writes draw,
    /// a destroyed view, and an image that recordings draw.
    shared: [2]context.Handle = undefined,
    style: [2]?context.Handle = .{ null, null },
    scratch: [2]context.Handle = undefined,
    stale: [2]context.Handle = undefined,
    image: [2]context.Handle = undefined,
    /// Per twin: a text view, an editor view, and a scene text, none of them on a node,
    /// which only recordings draw; the view's text buffer and the editor's edit buffer.
    readers: [2][3]context.Handle = undefined,
    reader_text: [2]context.Handle = undefined,
    reader_edit: [2]context.Handle = undefined,
    /// Which hooked nodes draw steadily, and what, fixed per seed.
    read_base: usize = 0,
    /// Hooks draw differently when it advances, with no scene change.
    hook_tick: usize = 0,
    recorded: bool = false,
    /// A split render moved the output, so the decoder no longer follows the screen.
    split: bool = false,

    fn init(random: std.Random, side: std.Random, verify: bool) !Harness {
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
        var self: Harness = .{ .twins = twins, .random = random, .side = side, .terminal = try vt_decode.newTerminal(16, 6), .read_base = random.uintLessThan(usize, 16) };
        for (twins, 0..) |twin, index| {
            self.shared[index] = try twin.owner.createTextBuffer(.unicode);
            try twin.owner.textBufferSetText(self.shared[index], "shared text");
            self.scratch[index] = try twin.owner.createBuffer(2, 1, .{});
            try twin.owner.drawBufferText(self.scratch[index], "\u{754c}", 0, 0, ansi.rgbColor(255, 255, 0, 255), ansi.rgbColor(0, 0, 255, 255), 0);
            self.stale[index] = try twin.owner.createTextBufferView(self.shared[index]);
            try twin.owner.destroy(self.stale[index]);
            self.image[index] = try twin.owner.createImagePixels(utils.repeat(u8, &.{ 200, 40, 0, 255 }, 4), 2, 2, .{ .stride = 8 });
            self.reader_text[index] = try twin.owner.createTextBuffer(.unicode);
            try twin.owner.textBufferSetText(self.reader_text[index], "rv");
            self.reader_edit[index] = try twin.owner.createEditBuffer(.unicode);
            try twin.owner.editSetText(self.reader_edit[index], "ed", false);
            const text = try twin.owner.sceneCreateNode(twin.id, c.OT_SCENE_TEXT, 99);
            try twin.owner.sceneSetText(text, "body");
            self.readers[index] = .{ try twin.owner.createTextBufferView(self.reader_text[index]), try twin.owner.createEditorView(self.reader_edit[index], 4, 1), text };
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
            .scroll_to, .scroll_options, .scroll_request => self.stats.scroll_changes += 1,
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
                self.terminal = try vt_decode.newTerminal(value.width, value.height);
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
                    .text => c.OT_SCENE_TEXT,
                    .slider => c.OT_SCENE_SLIDER,
                    .arrow => c.OT_SCENE_ARROW,
                    .editor => c.OT_SCENE_EDITOR,
                    .text_view => c.OT_SCENE_TEXT_VIEW,
                    .box, .scroll => c.OT_SCENE_BOX,
                };
                const created = try f.owner.sceneCreateNode(f.id, kind, Model.num(value.slot));
                if (value.kind == .scroll) try f.owner.sceneSetScroll(created, .{ .follow = c.OT_SCENE_SCROLL_FOLLOW_BOTTOM });
                if (self.model.handles[value.slot] == null) self.model.handles[value.slot] = .{ undefined, undefined };
                self.model.handles[value.slot].?[twin] = created;
                if (value.kind == .editor) {
                    const edit = try f.owner.createEditBuffer(.unicode);
                    try f.owner.sceneSetEditorView(created, try f.owner.createEditorView(edit, 1, 1));
                    self.model.edits[value.slot][twin] = edit;
                }
                if (value.kind == .text_view) try self.bindView(twin, value.slot);
                // 1x1, so its rect can lie wholly beside the clip while its text reaches in.
                if (value.kind == .arrow) for (0..2) |axis| try f.owner.sceneSetStyle(created, c.OT_STYLE_DIMENSION, @intCast(axis), 0, 1, 1, 1);
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
            .reader => |seed| {
                try f.owner.textBufferSetText(self.reader_text[twin], ([_][]const u8{ "", "rv", "r\nv", "\u{754c}v" })[(seed / 4) % 4]);
                try f.owner.editSetText(self.reader_edit[twin], ([_][]const u8{ "", "ab", "a\nbc", "\u{754c}x" })[seed % 4], false);
                try f.owner.sceneSetTextOptions(self.readers[twin][2], .{ .foreground = .{ @intCast(seed % 256), 255, 255, 255 } });
            },
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
                // Some texts are links, so link references reach band edges.
                if (value.seed & 0x40000 == 0) return f.owner.sceneSetText(self.handle(twin, value.slot), bytes[0..len]);
                try f.owner.sceneSetStyledText(self.handle(twin, value.slot), bytes[0..len], &.{.{ .byte_count = @intCast(len), .foreground = .{ 255, 255, 255, 255 }, .background = .{ 0, 0, 0, 0 }, .link_url = "https://example.test/band" }});
            },
            .arrow => |value| try f.owner.sceneSetArrow(self.handle(twin, value.slot), arrowOptions(value.seed)),
            .box => |value| {
                try f.owner.sceneSetBoxDetails(self.handle(twin, value.slot), boxDetails(value.seed));
                try f.owner.scenePatchPaint(self.handle(twin, value.slot), c.OT_SCENE_PROPERTY_BORDER | c.OT_SCENE_PROPERTY_BACKGROUND | c.OT_SCENE_PROPERTY_TRANSLATE_Y, .{ .borderSides = c.OT_BORDER_TOP | c.OT_BORDER_BOTTOM | ((value.seed >> 24) & 5), .translateY = -1 });
            },
            .scroll_arrow => |value| {
                var options = arrowOptions(value.seed >> 2);
                options.direction = 0;
                try f.owner.sceneSetScrollArrow(self.handle(twin, value.slot), value.seed & 1, (value.seed >> 1) & 1, options);
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
            .scroll_to => |value| _ = try f.owner.sceneScrollTo(self.handle(twin, value.slot), value.target, .{ value.relative, value.relative }, value.reapply),
            .scroll_request => |value| _ = try f.owner.sceneScrollRequest(self.handle(twin, value.slot), value.kind, if (value.target) |target| self.handle(twin, target) else null, value.alignment, value.inset),
            .scroll_options => |value| try f.owner.sceneSetScroll(self.handle(twin, value.slot), value.options),
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

    fn contentBox(self: *const Harness) ?usize {
        const rows = self.model.children[content_slot].items;
        if (rows.len == 0) return null;
        const start = self.random.uintLessThan(usize, rows.len);
        for (0..rows.len) |offset| {
            const row = rows[(start + offset) % rows.len];
            if (self.model.kind[row] == .box) return row;
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
        if (self.model.handles[empty] == null) return .{
            .create = .{
                .slot = empty,
                // The first slot that takes paint hooks holds a box, so recordings play box bodies.
                .kind = if (empty == scaffold_slots) .box else switch (random.uintLessThan(u32, 10)) {
                    0 => .box,
                    // Half the boxes are scroll nodes, so the mix of the other kinds stays as before.
                    1 => if (random.boolean()) .box else .scroll,
                    2 => if (random.boolean()) .slider else .arrow,
                    8 => .editor,
                    9 => .text_view,
                    else => .text,
                },
            },
        };
        const slot = self.liveSlot(scaffold_slots) orelse return null;
        return switch (random.uintLessThan(u32, 27)) {
            // Moves favor the content so its children pass the filter cutoff.
            0...7 => blk: {
                const parent: ?usize = switch (random.uintLessThan(u32, 8)) {
                    0...4 => content_slot,
                    5 => self.model.parent[slot] orelse root_slot,
                    6 => null,
                    // Half into a content row, so culled rows hold subtrees; paint hooks stay out.
                    else => if (slot >= paint_hook_slots_end and random.boolean()) self.contentBox() orelse self.boxSlot() else self.boxSlot(),
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
            24 => if (self.model.kind[slot] == .text) .{ .selection = .{ .slot = slot, .set = random.boolean(), .focus = random.intRangeAtMost(i32, 0, 8) } } else if (self.model.kind[slot] == .box) .{ .box = .{ .slot = slot, .seed = random.int(u32) } } else .{ .resend = slot },
            25 => if (self.scrollSlot()) |scroll| (if (random.uintLessThan(u32, 4) != 0) self.generateScroll(scroll) else .{ .resend = slot }) else .{ .resend = slot },
            26 => if (random.uintLessThan(u32, 6) == 0) .{ .palette = random.uintLessThan(u32, 4) } else .{ .raw = .{ .kind = random.uintLessThan(u32, 4), .x = random.intRangeAtMost(i32, -1, 20), .y = random.intRangeAtMost(i32, -1, 8) } },
            else => self.generateReply(slot),
        };
    }

    fn scrollSlot(self: *const Harness) ?usize {
        const start = self.random.uintLessThan(usize, node_count_max);
        for (0..node_count_max) |offset| {
            const slot = (start + offset) % node_count_max;
            if (self.model.handles[slot] != null and self.model.kind[slot] == .scroll) return slot;
        }
        return null;
    }

    /// A scroll, new scroll options (follow edge, culling, bars, fills, viewport padding), a
    /// style of the scroll node's content, its SCROLL hook set or cleared, or a node moved in.
    fn generateScroll(self: *Harness, slot: usize) Op {
        const random = self.random;
        switch (random.uintLessThan(u32, 6)) {
            // A move into the node itself or its subtree is rejected by both twins.
            5 => return .{ .move = .{ .slot = self.liveSlot(scaffold_slots) orelse slot, .parent = slot, .index = @intCast(self.model.children[slot].items.len) } },
            4 => return if (random.boolean()) .{ .scroll_arrow = .{ .slot = slot, .seed = random.int(u32) } } else .{ .hooks = .{ .slot = slot, .flags = if (random.boolean()) c.OT_SCENE_HOOK_SCROLL else 0 } },
            0 => return .{ .scroll_to = .{ .slot = slot, .target = .{ @floatFromInt(random.intRangeAtMost(i32, -3, 12)), @floatFromInt(random.intRangeAtMost(i32, -3, 12)) }, .relative = random.boolean(), .reapply = random.boolean() } },
            // A node to reveal or anchor, from anywhere: one outside the subtree is rejected by both twins.
            1 => {
                const kind = random.uintLessThan(u32, 3);
                // A LAYOUT request arrives only with the SCROLL hook.
                if (kind == c.OT_SCENE_SCROLL_REQUEST_LAYOUT and self.model.hooks[slot] & c.OT_SCENE_HOOK_SCROLL == 0) return .{ .hooks = .{ .slot = slot, .flags = self.model.hooks[slot] | c.OT_SCENE_HOOK_SCROLL } };
                const children = self.model.children[slot].items;
                const target = if (kind == c.OT_SCENE_SCROLL_REQUEST_LAYOUT or (kind == c.OT_SCENE_SCROLL_REQUEST_ANCHOR and random.uintLessThan(u32, 4) == 0))
                    null
                else if (children.len != 0 and random.uintLessThan(u32, 4) != 0) children[random.uintLessThan(usize, children.len)] else self.liveSlot(scaffold_slots);
                const into_view = kind == c.OT_SCENE_SCROLL_REQUEST_INTO_VIEW;
                return .{ .scroll_request = .{ .slot = slot, .kind = kind, .target = target, .alignment = if (into_view) random.uintLessThan(u32, 3) else 0, .inset = if (into_view) random.uintLessThan(u32, 2) else 0 } };
            },
            2 => {
                var bars: [2]scene.ScrollBarOptions = undefined;
                for (&bars) |*bar| bar.* = .{
                    .policy = random.uintLessThan(u32, 3),
                    .overlay = random.uintLessThan(u32, 4) == 0,
                    .thickness = random.intRangeAtMost(u32, 1, 2),
                    .gap = random.uintLessThan(u32, 2),
                    .arrows = random.boolean(),
                    .foreground = .{ 255, random.int(u8), 0, 255 },
                };
                var fills: [3]?ansi.RGBA = undefined;
                for (&fills, 0..) |*fill, index| fill.* = if (random.uintLessThan(u32, 3) == 0) .{ @intCast(40 * index), 0, random.int(u8), 255 } else null;
                return .{ .scroll_options = .{ .slot = slot, .options = .{
                    .axes = random.intRangeAtMost(u32, 1, 3),
                    .follow = random.uintLessThan(u32, 5),
                    .culling = random.uintLessThan(u32, 4) == 0,
                    .padding = .{ @floatFromInt(random.uintLessThan(u32, 2)), @floatFromInt(random.uintLessThan(u32, 2)), 0, @floatFromInt(random.uintLessThan(u32, 2)) },
                    .fills = fills,
                    .bars = bars,
                } } };
            },
            else => return .{ .style = switch (random.uintLessThan(u32, 3)) {
                0 => .{ .slot = slot, .group = c.OT_STYLE_ENUM, .kind = c.OT_STYLE_ENUM_FLEX_DIRECTION, .unit = 0, .value = @floatFromInt(random.uintLessThan(u32, 4)), .flags = c.OT_STYLE_CONTENT },
                1 => .{ .slot = slot, .group = c.OT_STYLE_ENUM, .kind = c.OT_STYLE_ENUM_JUSTIFY_CONTENT, .unit = 0, .value = @floatFromInt(random.uintLessThan(u32, 3)), .flags = c.OT_STYLE_CONTENT },
                else => .{ .slot = slot, .group = c.OT_STYLE_VALUE, .kind = c.OT_STYLE_VALUE_MIN_HEIGHT, .unit = c.OT_UNIT_POINT, .value = 0, .flags = c.OT_STYLE_CONTENT },
            } },
        }
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
                const hooked = random.intRangeLessThan(usize, scaffold_slots, paint_hook_slots_end);
                if (self.model.handles[hooked] == null) break :blk null;
                var flags = random.intRangeLessThan(u32, 1, 128) & ~@as(u32, c.OT_SCENE_HOOK_LAYOUT_CHANGED);
                // A box with a BEFORE hook also replaces its body, so recordings play native box bodies;
                // boxes with only AFTER keep the native body under their recording.
                if (self.model.kind[hooked] == .box and flags & c.OT_SCENE_HOOK_RENDER_BEFORE != 0) flags |= c.OT_SCENE_HOOK_RENDER_SELF;
                if (self.model.kind[hooked] == .scroll and random.boolean()) flags |= c.OT_SCENE_HOOK_SCROLL;
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
                // A border change also sets focusable, so focus moves change border colors, and the
                // border's style and colors; a background change also sets whether it fills.
                var field = fields[random.uintLessThan(usize, fields.len)];
                if (field == c.OT_SCENE_PROPERTY_BORDER) field |= c.OT_SCENE_PROPERTY_FOCUSABLE | c.OT_SCENE_PROPERTY_BORDER_STYLE | c.OT_SCENE_PROPERTY_BORDER_COLOR | c.OT_SCENE_PROPERTY_FOCUSED_BORDER_COLOR;
                if (field == c.OT_SCENE_PROPERTY_BACKGROUND) field |= c.OT_SCENE_PROPERTY_SHOULD_FILL;
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
                            .shouldFill = @intFromBool(random.uintLessThan(u32, 4) != 0),
                            .borderStyle = random.uintLessThan(u32, 4),
                            // Opaque, so a border over a transparent background takes the fast path.
                            .borderColor = .{ 255, random.int(u8), 0, 255 },
                            .focusedBorderColor = .{ 0, random.int(u8), 255, 255 },
                        },
                    },
                };
            },
            2 => .{ .style = .{ .slot = slot, .group = c.OT_STYLE_ENUM, .kind = c.OT_STYLE_ENUM_DISPLAY, .unit = 0, .value = @floatFromInt(@intFromBool(random.uintLessThan(u32, 4) == 0)), .flags = 0 } },
            3 => .{ .style = .{ .slot = slot, .group = c.OT_STYLE_DIMENSION, .kind = random.uintLessThan(u32, 2), .unit = 1, .value = @floatFromInt(random.intRangeAtMost(u32, 1, 6)), .flags = 1 } },
            4 => if (self.model.kind[slot] == .arrow) .{ .arrow = .{ .slot = slot, .seed = random.int(u32) } } else if (self.model.kind[slot] == .text) self.generateText(slot) else if (self.model.kind[slot] == .slider)
                .{ .slider = .{ .slot = slot, .value = @floatFromInt(random.uintLessThan(u32, 101)), .orientation = random.uintLessThan(u32, 2) } }
            else if ((self.model.kind[slot] == .box or self.model.kind[slot] == .scroll) and random.boolean())
                .{ .box = .{ .slot = slot, .seed = random.int(u32) } }
            else
                .{ .style = .{ .slot = slot, .group = c.OT_STYLE_ENUM, .kind = c.OT_STYLE_ENUM_OVERFLOW, .unit = 0, .value = @floatFromInt(random.uintLessThan(u32, 2)), .flags = 0 } },
            else => if (random.uintLessThan(u32, 3) == 0)
                .{ .style = .{ .slot = slot, .group = c.OT_STYLE_ENUM, .kind = c.OT_STYLE_ENUM_POSITION_TYPE, .unit = 0, .value = @floatFromInt(1 + random.uintLessThan(u32, 2)), .flags = 0 } }
            else
                .{ .position = .{ .slot = slot, .left = @floatFromInt(random.intRangeLessThan(i32, -8, 14)), .top = @floatFromInt(random.uintLessThan(u32, 8)) } },
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
        var recordings: [2]Recording = .{ .{}, .{} };
        var records: [2]?[]const u8 = .{ null, null };
        while (true) {
            const results = [2]anyerror!scene.FrameRequest{
                self.twins[reference].owner.sceneFrameStepWithRecording(self.twins[reference].id, requests[reference], spec.options, records[reference]),
                self.twins[candidate].owner.sceneFrameStepWithRecording(self.twins[candidate].id, requests[candidate], spec.options, records[candidate]),
            };
            const first = results[reference] catch |err| {
                try testing.expectError(err, results[candidate]);
                return false;
            };
            const second = try results[candidate];
            try self.expectSameRequest(first, second);
            requests = .{ first, second };
            records = .{ null, null };
            switch (first.kind) {
                0 => return true,
                c.OT_SCENE_FRAME_RECORD => {
                    self.stats.records += 1;
                    self.recorded = true;
                    recordings = .{ .{}, .{} };
                    const bound = try self.expectSameSlots(first, second, &recordings);
                    records = .{ recordings[reference].view(), recordings[candidate].view() };
                    // Paint hooks may edit what steady recordings read, or change the scene.
                    if (self.generateRead(bound)) |op| try self.apply(op);
                    if (self.random.uintLessThan(u32, 4) == 0) {
                        try self.reply();
                        self.stats.record_replies += 1;
                    }
                },
                else => {
                    switch (first.kind) {
                        c.OT_SCENE_FRAME_UPDATE => self.stats.updates += 1,
                        c.OT_SCENE_FRAME_RESIZE => self.stats.resizes += 1,
                        c.OT_SCENE_FRAME_SCROLL => {
                            self.stats.scroll_requests += 1;
                            const changes = (try self.twins[reference].owner.sceneGetScroll(first.node)).changes;
                            self.stats.scroll_layouts += @intFromBool(changes & c.OT_SCENE_SCROLL_CHANGED_LAYOUT != 0);
                        },
                        else => self.stats.layout_changes += 1,
                    }
                    const requester = self.model.slotOf(reference, first.node).?;
                    // The hook reads its request's paint geometry after its own changes.
                    const asked = try self.twins[candidate].owner.sceneGetPaintLayout(second.node);
                    // A scroll in the reply paints at the new offset in the same frame.
                    if (first.kind == c.OT_SCENE_FRAME_SCROLL and self.random.boolean()) try self.apply(self.generateScroll(requester));
                    // A LAYOUT request from a reply arrives in the next frame.
                    if (first.kind == c.OT_SCENE_FRAME_SCROLL and self.random.boolean()) try self.apply(.{ .scroll_request = .{ .slot = requester, .kind = c.OT_SCENE_SCROLL_REQUEST_LAYOUT, .target = null, .alignment = 0, .inset = 0 } });
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
                    try self.reply();
                    if (self.side.uintLessThan(u32, 3) == 0) try self.markSibling(requester);
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
                    if (self.twins[candidate].owner.sceneGetPaintLayout(second.node)) |after| {
                        try testing.expectEqualSlices(u8, std.mem.asBytes(&asked), std.mem.asBytes(&after));
                    } else |_| {}
                },
            }
        }
    }

    /// Zero to two changes, and sometimes a destroyed node, from a host reply.
    fn reply(self: *Harness) !void {
        for (0..self.random.uintLessThan(u32, 3)) |_| {
            const slot = self.liveSlot(scaffold_slots) orelse break;
            try self.apply(self.generateReply(slot));
        }
        // A remount marks more nodes in one pass than the scene holds. It draws from `side`, as
        // sibling marks do, and leaves the tree as it was.
        if (self.side.uintLessThan(u32, 32) == 0) for (scaffold_slots..node_count_max) |free| {
            if (self.model.handles[free] != null) continue;
            for (0..self.side.intRangeAtMost(u32, 8, 64)) |_| {
                try self.apply(.{ .create = .{ .slot = free, .kind = if (self.side.boolean()) .text else .box } });
                try self.apply(.{ .move = .{ .slot = free, .parent = content_slot, .index = 0 } });
                try self.apply(.{ .destroy = free });
                self.stats.remounts += 1;
            }
            break;
        };
        if (self.random.uintLessThan(u32, 8) != 0) return;
        const slot = self.liveSlot(scaffold_slots) orelse return;
        // Content rows stay, so viewport scenes keep enough children to cull.
        if (self.model.parent[slot] == content_slot) return;
        try self.apply(.{ .destroy = slot });
        self.stats.reply_destroys += 1;
    }

    /// A sibling of the requester, before or after it in paint order, or the sibling's first
    /// child, gets or loses UPDATE, or a text change, while their parent's batch runs.
    fn markSibling(self: *Harness, requester: usize) !void {
        const parent = self.model.parent[requester] orelse return;
        const siblings = self.model.paint[parent].items;
        var target = siblings[self.side.uintLessThan(usize, siblings.len)];
        if (target == requester) return;
        if (self.model.children[target].items.len != 0 and self.side.boolean()) target = self.model.children[target].items[0];
        if (target < scaffold_slots) return;
        self.stats.sibling_marks += 1;
        if (self.model.kind[target] == .text and self.side.boolean()) {
            var text_options = self.model.text_options[target];
            text_options.truncate = !text_options.truncate;
            return self.apply(.{ .text_options = .{ .slot = target, .options = text_options } });
        }
        // Half the changes clear the hooks they set, so hooked siblings do not pile up.
        const kept = self.model.hooks[target] & ~@as(u32, c.OT_SCENE_HOOK_IDLE_UPDATE | c.OT_SCENE_HOOK_UPDATE | c.OT_SCENE_HOOK_RESIZE);
        const flags: u32 = if (self.side.boolean()) c.OT_SCENE_HOOK_UPDATE | c.OT_SCENE_HOOK_RESIZE else 0;
        try self.apply(.{ .hooks = .{ .slot = target, .flags = kept | flags } });
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
        if (first.kind == c.OT_SCENE_FRAME_DONE or first.kind == c.OT_SCENE_FRAME_RECORD) return;
        // The geometry the request carries, culled nodes' too (B5d).
        const painted = .{ try self.twins[reference].owner.sceneGetPaintLayout(first.node), try self.twins[candidate].owner.sceneGetPaintLayout(second.node) };
        try testing.expectEqualSlices(u8, std.mem.asBytes(&painted[0]), std.mem.asBytes(&painted[1]));
    }

    /// The RECORD snapshots must match; both twins then get the same recording, except that a box body names
    /// each twin's own node. Returns whether a steady recording drew the view of another, shown node.
    fn expectSameSlots(self: *Harness, first: scene.FrameRequest, second: scene.FrameRequest, recordings: *[2]Recording) !bool {
        var bound_read = false;
        const slots = [2][]const scene.PaintSlot{
            try self.twins[reference].owner.sceneFramePaintSlots(self.twins[reference].id, first),
            try self.twins[candidate].owner.sceneFramePaintSlots(self.twins[candidate].id, second),
        };
        try testing.expectEqual(slots[0].len, slots[1].len);
        for (slots[0], slots[1], 0..) |a, b, index| {
            try testing.expectEqual(a.num, b.num);
            try testing.expectEqual(a.hooks, b.hooks);
            try testing.expectEqual(a.hook_generation, b.hook_generation);
            try testing.expectEqual(a.public_layout == null, b.public_layout == null);
            // Bitwise, as below: NaN layouts compare equal.
            if (a.public_layout) |layout| try testing.expectEqualSlices(u8, std.mem.asBytes(&layout), std.mem.asBytes(&b.public_layout.?));
            try testing.expectEqual(a.layout, b.layout);
            try testing.expectEqual(a.clip, b.clip);
            try testing.expectEqual(a.opacity, b.opacity);
            // One phase per slot keeps the recording within its buffer.
            if (index >= 12) continue;
            // A box with a SELF hook plays its native body; other slots draw text or a fill.
            const body = a.hooks & c.OT_SCENE_HOOK_RENDER_SELF != 0 and self.model.kind[self.model.slotOf(reference, a.node).?] == .box;
            const phase: u32 = if (body) c.OT_SCENE_RECORD_PHASE_SELF else if (a.hooks & c.OT_SCENE_HOOK_RENDER_BEFORE != 0) c.OT_SCENE_RECORD_PHASE_BEFORE else if (a.hooks & c.OT_SCENE_HOOK_RENDER_SELF != 0) c.OT_SCENE_RECORD_PHASE_SELF else c.OT_SCENE_RECORD_PHASE_AFTER;
            const x: i32 = @intFromFloat(a.layout.screenX);
            const y: i32 = @intFromFloat(a.layout.screenY);
            if (body) self.stats.bodies += 1;
            // Other slots draw text or a fill, in their node or beside it, a view, an editor, a text
            // body, a composed buffer, or a destroyed view; the first one now and then clears,
            // recolors, or draws an image. Three nodes in four draw the same reader, or half of them
            // the view of a shown text view node, on the last row of their clip on every frame, so
            // only the resource's own changes, or that node's size, repaint them.
            const steady = (a.num + self.read_base) % 4 != 0 and !body;
            const variant = (index + self.hook_tick) % 8;
            const read = (a.num + self.read_base / 4) % 4;
            const bound = if (read % 3 == 0) self.slotWith(.text_view) else null;
            const rare = if (index == 0) self.random.uintLessThan(u32, 64) else 64;
            self.stats.non_local_records += @intFromBool(!body and rare < 4);
            self.stats.steady_reads += @intFromBool(steady and rare >= 4);
            bound_read = bound_read or (steady and rare >= 4 and bound != null);
            const view_slot = self.slotWith(.text_view);
            for (recordings, [2]context.Handle{ a.node, b.node }, 0..) |*recording, node, twin| {
                recording.slot(@intCast(index), phase);
                const operations = [3]u32{ c.OT_SCENE_RECORD_TEXT_VIEW, c.OT_SCENE_RECORD_EDITOR_VIEW, c.OT_SCENE_RECORD_SCENE_BODY };
                const view = struct {
                    fn append(target: *Recording, operation: u32, source: context.Handle, at_x: i32, at_y: i32) void {
                        target.append(c.ot_scene_record_view{ .header = .{ .size = 0, .operation = operation }, .source = .{ .context_id = source.context_id, .slot = source.slot, .generation = source.generation }, .x = at_x, .y = at_y }, &.{});
                    }
                };
                if (!body and rare < 4) {
                    appendNonLocal(recording, rare, self.image[twin]);
                } else if (body) {
                    view.append(recording, c.OT_SCENE_RECORD_SCENE_BODY, node, x, y);
                } else if (steady) {
                    const bottom = a.clip.y + @as(i32, @intCast(a.clip.height)) - 1;
                    if (bound) |slot| view.append(recording, c.OT_SCENE_RECORD_TEXT_VIEW, self.model.views[slot][twin].?, a.clip.x, bottom) else view.append(recording, operations[read % 3], self.readers[twin][read % 3], a.clip.x, bottom);
                } else switch (variant) {
                    0 => recording.text("r", x, y),
                    1 => recording.fill(x, y, 2, .{ @intCast(a.num), 40, 0, 255 }),
                    2 => recording.text("o", x + 3, y + 1),
                    3 => view.append(recording, c.OT_SCENE_RECORD_TEXT_VIEW, if (view_slot) |slot| self.model.views[slot][twin].? else self.stale[twin], x, y),
                    4 => view.append(recording, c.OT_SCENE_RECORD_EDITOR_VIEW, if (self.slotWith(.editor)) |slot| (try self.twins[twin].owner.raw().getRenderable(self.handle(twin, slot))).scene_node.?.editor.?.handle else self.stale[twin], x, y),
                    5 => if (self.slotWith(.text)) |slot| view.append(recording, c.OT_SCENE_RECORD_SCENE_BODY, self.handle(twin, slot), x, y) else view.append(recording, c.OT_SCENE_RECORD_TEXT_VIEW, self.stale[twin], x, y),
                    7 => view.append(recording, c.OT_SCENE_RECORD_TEXT_VIEW, self.stale[twin], x, y),
                    else => recording.compose(self.scratch[twin], x),
                }
            }
        }
        if (self.random.uintLessThan(u32, 4) == 0) self.hook_tick +%= 1;
        return bound_read;
    }

    /// Five times in eight, an edit to what a steady recording reads: a highlight of the
    /// shared text, the readers, or the width of a node that shows a view. After a recording
    /// that drew that view, always its width, which no epoch tracks.
    fn generateRead(self: *Harness, bound: bool) ?Op {
        const random = self.random;
        const op: ?Op = switch (if (bound) 3 else random.uintLessThan(u32, 8)) {
            0 => .{ .highlight = .{ .start = random.uintLessThan(u32, 4), .end = random.uintLessThan(u32, 8) } },
            1, 2, 4 => .{ .reader = random.int(u32) },
            3 => .{ .style = .{ .slot = self.slotWith(.text_view) orelse return null, .group = c.OT_STYLE_DIMENSION, .kind = 0, .unit = 1, .value = @floatFromInt(random.intRangeAtMost(u32, 2, 8)), .flags = 1 } },
            else => null,
        };
        if (op) |value| self.stats.view_resizes += @intFromBool(bound and value == .style and value.style.slot == self.slotWith(.text_view) and value.style.group == c.OT_STYLE_DIMENSION and value.style.kind == 0);
        return op;
    }

    /// The first slot of a kind whose resource a recording can read, past the slots that
    /// take paint hooks, so a recording reads another node's resource. A text view must be
    /// shown, so that its node's size reaches the view.
    fn slotWith(self: *const Harness, kind: Kind) ?usize {
        for (self.model.handles[paint_hook_slots_end..], paint_hook_slots_end..) |maybe, slot| {
            if (maybe != null and self.model.kind[slot] == kind and (kind != .text_view or (self.model.views[slot][0] != null and self.model.shown(slot)))) return slot;
        }
        return null;
    }

    /// One frame: optional cancelled draft, lockstep steps, commit, output, and every comparison.
    fn frame(self: *Harness) !void {
        const spec = self.frameSpec();
        if (spec.cancel_first and try self.drive(spec)) {
            for (self.twins) |twin| try twin.owner.sceneFrameCancel(twin.id, twin.state.painted.?.ticket.frame_id);
        }
        const stamps = self.twins[candidate].state.test_stamp_steps;
        const preparations = self.twins[candidate].state.test_subtree_preparations;
        self.recorded = false;
        // Late in a run, since the decoder cannot follow a split's scrollback: a split render
        // before the frame without one, and the frame presented by a split render.
        const split = self.stats.frames >= 300 and self.random.uintLessThan(u32, 4) == 0;
        if (split and self.random.boolean()) {
            for (self.twins, self.scratch, 0..) |twin, scratch, index| {
                const commits = [_]renderer.SplitSnapshot{.{ .snapshot = try twin.owner.raw().getBuffer(scratch), .row_columns = 2 }};
                _ = try (try twin.owner.raw().getSession(twin.id)).renderSplit(null, &commits, 0, spec.force);
                self.bytes[index].clearRetainingCapacity();
                try self.drain(index);
            }
            try testing.expectEqualSlices(u8, self.bytes[reference].items, self.bytes[candidate].items);
            self.stats.split_snapshots += 1;
        }
        if (split) self.split = true;
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
        // The draft holds the frame with consistent grapheme and link accounting: a band clear
        // releases the references of the cells it clears.
        try expectBufferInvariants(self.twins[candidate].cli.getNextBuffer());
        try self.expectSameChildOrder();
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
        const split_commit = split and self.random.boolean();
        self.stats.split_frames += @intFromBool(split_commit);
        for (self.twins, self.scratch, 0..) |twin, scratch, index| {
            const commits = [_]renderer.SplitSnapshot{.{ .snapshot = try twin.owner.raw().getBuffer(scratch), .row_columns = 2 }};
            const ticket = twin.state.painted.?.ticket;
            statuses[index] = if (split_commit) try (try twin.owner.raw().getSession(twin.id)).renderSplit(ticket, &commits, 0, spec.force) else try twin.owner.sceneFrameCommit(twin.id, ticket, spec.force);
            self.bytes[index].clearRetainingCapacity();
            try self.drain(index);
        }
        try testing.expectEqual(statuses[0], statuses[1]);
        try testing.expectEqualSlices(u8, self.bytes[reference].items, self.bytes[candidate].items);
        // The encoder synced every drafted cell into the presented buffer, and the hits followed.
        // A committed image also presents its placeholder cells.
        if (self.twins[candidate].cli.currentImages.items.len == 0) try testing.expectEqual(drafted, cellHash(self.twins[candidate].cli.currentRenderBuffer));
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
        // A frame that keeps its candidates keeps their stamps too (B5a).
        if (work.candidate_visits == 0) try testing.expectEqual(stamps, self.twins[candidate].state.test_stamp_steps);
        self.stats.subtree_preparations += @intFromBool(self.twins[candidate].state.test_subtree_preparations != preparations);
        self.stats.skipped += @intFromBool(work.damage_rows == 0);
        self.stats.partial += @intFromBool(work.damage_rows != 0 and work.damage_rows < self.twins[candidate].cli.height);
        self.stats.banded += @intFromBool(work.damage_rows != 0 and work.cells_cleared < @as(u64, self.twins[candidate].cli.width) * self.twins[candidate].cli.height);
        self.stats.retained_records += @intFromBool(self.recorded and work.damage_rows < self.twins[candidate].cli.height);
        // The content culls; a frame whose selection did not change tests no overlap (B5b).
        const culling = work.overlap_tests != 0 or (self.model.bound and !self.model.hidden[content_slot] and
            !self.model.hiddenAbove(content_slot) and self.model.children[content_slot].items.len >= 16);
        self.stats.filtered += @intFromBool(culling);
        self.stats.filtered_requests += @intFromBool(culling and work.host_requests != 0);
        self.stats.reused_filtered_requests += @intFromBool(work.candidate_visits == 0 and culling and work.host_requests != 0);
        self.stats.hidden_hooked += @intFromBool(hidden_hooked);
        for (self.model.handles, 0..) |maybe, slot| {
            if (maybe == null or self.model.kind[slot] != .scroll or self.model.children[slot].items.len == 0) continue;
            if (!self.model.contains(root_slot, slot) or self.model.hidden[slot] or self.model.hiddenAbove(slot)) continue;
            self.stats.scroll_frames += 1;
            break;
        }
        for (self.model.handles, 0..) |maybe, slot| {
            const pair = maybe orelse continue;
            if (self.model.kind[slot] != .arrow or !self.model.shown(slot)) continue;
            const layout = try self.twins[candidate].owner.sceneGetLayout(pair[candidate], false);
            if (layout.screenX + layout.width > 0) continue;
            self.stats.arrows_beside += 1;
            break;
        }
        const cursor = try self.twins[candidate].owner.sceneGetCursorState(self.twins[candidate].id);
        self.stats.editor_cursors += @intFromBool(self.twins[candidate].state.editor_cursor_owned);
        self.stats.host_cursors += @intFromBool(cursor.visible and !self.twins[candidate].state.editor_cursor_owned);
        // Field by field: the struct's padding is unspecified.
        inline for (@typeInfo(renderer.FrameWork).@"struct".field_names) |name| {
            self.stats.digest = std.hash.Wyhash.hash(self.stats.digest, std.mem.asBytes(&@field(work, name)));
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
            if (views[candidate] != null and self.model.shown(slot)) return true;
        }
        return false;
    }

    /// Both twins hold every node's paint children in the same order.
    fn expectSameChildOrder(self: *Harness) !void {
        for (self.model.handles) |maybe| {
            const pair = maybe orelse continue;
            const lists = .{ (try self.twins[reference].owner.raw().getRenderable(pair[reference])).scene_node.?.paint_children.items, (try self.twins[candidate].owner.raw().getRenderable(pair[candidate])).scene_node.?.paint_children.items };
            try testing.expectEqual(lists[0].len, lists[1].len);
            for (lists[0], lists[1]) |a, b| try testing.expectEqual(a.scene_node.?.num, b.scene_node.?.num);
        }
    }

    /// A paint list that the next frame may keep is in the model's order. The model does not
    /// cull: a culled list drops members, with their subtrees, and keeps the order of the rest.
    fn expectPaintOrder(self: *Harness) !void {
        const f = self.twins[candidate];
        var order: [node_count_max]usize = undefined;
        const count = self.model.paintOrder(&order, 0, root_slot);
        if (f.state.members.items.len == 0) return;
        // A reply after paint changed layout or a view: the next frame prepares again.
        var dirty: u32 = 0;
        try yoga.check(yoga.yogaNodeIsDirtyChecked((try f.owner.raw().getRenderable(self.handle(candidate, root_slot))).yoga_node, &dirty));
        if (dirty != 0 or f.state.preparation_dirty) return;
        const culled = f.state.filter_count != 0;
        self.stats.culled_orders += @intFromBool(culled);
        var painted: usize = 0;
        for (f.state.members.items) |entry| {
            if (entry.node.scene_node.?.kind == c.OT_SCENE_ROOT or !entry.visible or entry.bars) continue;
            const node = entry.node.scene_node.?.handle;
            if (culled) while (painted < count and !std.meta.eql(self.handle(candidate, order[painted]), node)) {
                painted += 1;
            };
            try testing.expect(painted < count);
            try testing.expectEqual(self.handle(candidate, order[painted]), node);
            painted += 1;
        }
        if (!culled) try testing.expectEqual(count, painted);
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
        for (self.model.handles, 0..) |maybe, slot| {
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
            const painted = .{ try owners[0].owner.sceneGetPaintLayout(pair[0]), try owners[1].owner.sceneGetPaintLayout(pair[1]) };
            try testing.expectEqualSlices(u8, std.mem.asBytes(&painted[0]), std.mem.asBytes(&painted[1]));
            // Resize baselines and prepared text views, including culled children's (B2 invariant 3).
            const nodes = .{ (try owners[0].owner.raw().getRenderable(pair[0])).scene_node.?, (try owners[1].owner.raw().getRenderable(pair[1])).scene_node.? };
            try testing.expectEqual(nodes[0].resize_width, nodes[1].resize_width);
            try testing.expectEqual(nodes[0].resize_height, nodes[1].resize_height);
            // Only a shown node is painted. A recording that reads another node's text prepares
            // its view when it replays, and a recorded frame with no damaged rows replays none.
            if (!self.model.shown(slot)) continue;
            // Where the reference left a view to paint, which prepares it as drawing does, the
            // candidate may have prepared it already (B5b): a refresh of the round skipped it.
            if (nodes[0].text) |text| if (!text.view.needsPrepare()) {
                const views = .{ text.view, nodes[1].text.?.view };
                try testing.expectEqualDeep(views[0].getViewport(), views[1].getViewport());
                try testing.expectEqual(views[0].virtual_lines_dirty, views[1].virtual_lines_dirty);
                try testing.expectEqual(views[0].truncation_applied, views[1].truncation_applied);
            };
        }
    }

    /// The candidate's bytes, decoded by an independent terminal, show the presented cells.
    fn expectDecoded(self: *Harness) !void {
        var stream = self.terminal.vtStream();
        defer stream.deinit();
        stream.nextSlice(self.bytes[candidate].items);
        if (!self.decoder_synced or self.split) return;
        self.stats.decoded += 1;
        try vt_decode.expectScreen(&self.terminal, .of(self.twins[candidate].cli.currentRenderBuffer));
    }

    /// Every presented reference frame takes today's full path. Each Track B shortcut adds
    /// the counter it lowers here.
    fn expectReference(self: *Harness) !void {
        const f = self.twins[reference];
        const work = (try f.owner.sceneGetStats(f.id)).frameWork;
        const cells = @as(u64, f.cli.width) * f.cli.height;
        try testing.expect(work.full_path_reasons & renderer.FrameWork.full_path_forced != 0);
        // Every visible node, the root included, at least once (B5a).
        var order: [node_count_max]usize = undefined;
        try testing.expect(work.candidate_visits > self.model.paintOrder(&order, 0, root_slot));
        // Retained paint (B3, B4): the reference clears every cell, paints every member in full, and
        // diffs every row.
        // A frame the encoder does not keep (tainted or with images) is cleared after encode too.
        try testing.expectEqual(cells * (1 + @as(u64, @intFromBool(f.cli.retained_frame_id != work.work_frame_id))), work.cells_cleared);
        try testing.expectEqual(f.cli.height, work.damage_rows);
        try testing.expectEqual(f.state.records.items.len, work.members_painted);
        var member_cells: u64 = 0;
        for (f.state.records.items) |record| {
            const node = (try f.owner.raw().getRenderable(f.state.tokens.get(record.token).?)).scene_node.?;
            const box = node.kind == c.OT_SCENE_BOX and record.inputs.record_digest == 0 and node.paint.borderSides == c.OT_BORDER_NONE and
                (node.paint.shouldFill == 0 or node.paint.background[3] == 0) and (node.scroll == null or std.meta.eql(node.scroll.?.options.fills, .{ null, null, null }));
            if (box) continue;
            // As paint casts them: toward zero.
            const cell = scene.cellLayout(record.inputs.layout);
            const clip = record.inputs.clip;
            const x: i64 = @intFromFloat(cell.screenX);
            const y: i64 = @intFromFloat(cell.screenY);
            const width = @min(x + @as(i64, @intFromFloat(cell.width)), clip.x + @as(i64, clip.width)) - @max(x, clip.x);
            const height = @min(y + @as(i64, @intFromFloat(cell.height)), clip.y + @as(i64, clip.height)) - @max(y, clip.y);
            if (width > 0 and height > 0) member_cells += @intCast(width * height);
            if (width > 0 and height > 0 and node.kind == c.OT_SCENE_BOX and node.paint.borderSides != 0) if (node.control.box) |details| if (details.custom_border_chars) |chars| {
                self.stats.framed_boxes += @intFromBool(std.mem.indexOfScalar(u32, &chars, ' ') != null);
            };
        }
        try testing.expectEqual(member_cells, work.member_cells);
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
                    try yoga.check(yoga.yogaNodeGetChildChecked(node.childYoga(value), @intCast(position), &yoga_child));
                    try testing.expectEqual(actual.yoga_node, yoga_child);
                    try testing.expectEqual(self.handle(twin, child), actual.scene_node.?.handle);
                }
                try testing.expectEqual(self.model.paint[index].items.len, node.paint_children.items.len);
            }
            // The reader text is a scene node outside the tree.
            try testing.expectEqual(live + 1, f.state.count);
            try testing.expectEqual(live + 1, f.state.tokens.count());
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
            // An arrow's change too: its record must hold the rows its text reaches.
            if (op_paint != .paint and op_paint != .arrow) return;
            try self.apply(op_paint);
            try self.frame();
        }
    }
};

/// Arrow text from one to eight cells, a wide glyph, or the standard glyph.
fn arrowOptions(seed: u32) scene.ArrowOptions {
    const texts = [_]?[]const u8{ null, "A", "ABCD", "ABCDEFGH", "\u{754c}x", "ABCE" };
    return .{ .direction = seed % 4, .foreground = .{ 255, @intCast((seed >> 2) % 256), 0, 255 }, .text = texts[(seed >> 10) % texts.len] };
}

/// Titles at each alignment, and border glyphs that are all spaces, or some of them.
fn boxDetails(seed: u32) scene.BoxDetails {
    const titles = [_][]const u8{ "", "T", "title", "\u{754c}t" };
    var chars: [11]u32 = undefined;
    for (&chars, 0..) |*char, index| char.* = if (seed & 0x800 != 0 and (seed >> @intCast(index)) & 1 != 0) "+-|="[index % 4] else ' ';
    return .{ .title = titles[(seed >> 12) % 4], .bottom_title = titles[(seed >> 14) % 4], .title_alignment = (seed >> 16) % 3, .bottom_title_alignment = (seed >> 18) % 3, .title_color = if ((seed >> 20) & 1 != 0) .{ 255, 255, 0, 255 } else null, .custom_border_chars = if ((seed >> 21) % 4 == 0) null else chars };
}

/// A recorded clear, a color matrix without and with a mask, or an image.
fn appendNonLocal(recording: *Recording, kind: u32, image: context.Handle) void {
    const matrix = [16]f32{ 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 };
    switch (kind) {
        0 => recording.draw(c.ot_buffer_draw_clear{ .header = .{ .struct_size = @sizeOf(c.ot_buffer_draw_clear), .abi_version = c.OT_CONTEXT_ABI_VERSION, .operation = c.OT_BUFFER_DRAW_CLEAR, .flags = 0 }, .background = .{ 0, 0, 90, 255 } }, null, "", ""),
        1, 2 => recording.append(c.ot_scene_record_color_matrix{ .header = .{ .size = 0, .operation = c.OT_SCENE_RECORD_COLOR_MATRIX }, .matrix = matrix, .strength = 1, .channel = 2, .has_mask = kind - 1, .mask_count = 3 * (kind - 1) }, std.mem.sliceAsBytes(([_]f32{ 1, 0, 0.5 })[0 .. 3 * (kind - 1)])),
        else => recording.append(c.ot_scene_record_image{ .header = .{ .size = 0, .operation = c.OT_SCENE_RECORD_IMAGE }, .image = .{ .context_id = image.context_id, .slot = image.slot, .generation = image.generation }, .options = .{ .struct_size = @sizeOf(c.ot_image_draw_options), .abi_version = c.OT_CONTEXT_ABI_VERSION, .flags = 0, .protocol = c.OT_IMAGE_PROTOCOL_BLOCKS, .x = 1, .y = 1, .width = 2, .height = 1, .pixel_width = 0, .pixel_height = 0, .source_x = 0, .source_y = 0, .source_width = 0, .source_height = 0, .reserved = .{ 0, 0 } } }, &.{}),
    }
}

fn cellHash(target: *const @import("../buffer.zig").OptimizedBuffer) u64 {
    var hash = std.hash.Wyhash.init(0);
    inline for (.{ target.buffer.char, target.buffer.fg, target.buffer.bg, target.buffer.attributes }) |slice| hash.update(std.mem.sliceAsBytes(slice));
    return hash.final();
}

fn runParity(seed: u64, steps: usize) !Stats {
    var prng = std.Random.DefaultPrng.init(seed);
    var side = std.Random.DefaultPrng.init(~seed);
    var harness = try Harness.init(prng.random(), side.random(), seed % 2 == 0);
    defer harness.deinit();
    for (0..steps) |_| try harness.step();
    return harness.stats;
}

test "Scene twin Sessions match a forced full-frame reference on every frame" {
    var total: Stats = .{};
    for (0..64) |seed| {
        errdefer std.debug.print("seed {d}\n", .{seed});
        const stats = try runParity(seed, 256);
        inline for (@typeInfo(Stats).@"struct".field_names) |name| @field(total, name) +%= @field(stats, name);
    }
    // Every frame kind B2, B3, D2b, B4, and B5 rely on is reached in quantity, and each minimum
    // fails if the draw that produces its kind is removed. Minimums are about a quarter of the
    // counts at 64 x 256 (decoded frames about two thirds), derived again after resized views and
    // box details changed the mix. Replies that destroy nodes spare content rows, or viewport
    // scenes fall below the culling cutoff. Sibling marks and remounts draw from their own
    // stream, so they keep the script's mix. Counts: reused 8,784, culling 1,337, culling with a
    // request 353, kept lists in such a frame 35, culled paint lists checked 15,420, hooked under
    // a hidden ancestor 6,273, reply hid the requester's parent 44, reply detached the requester
    // 45, reply destroyed a node 412, a RECORD reply changed the scene 161, nodes remounted in a
    // reply 6,192, content-child RESIZE 66, a truncation change in its reply 65, a sibling marked
    // mid-batch 130, unmeasured content text replaced 17, UPDATE 3,350, RESIZE 116,
    // LAYOUT_CHANGED 1,661, recordings 723, box bodies 92, decoded 11,119, an editor's cursor
    // 1,833, a host cursor 8,412, skipped paint 8,432, partly diffed 1,332, band frames 1,170,
    // split renders with a frame 511 and before one 507, recorded frames that kept rows 231,
    // non-local or image recordings 44, steady reads 392, draft writes after paint 2,882, raw
    // writes between frames 412, shared text changes shown 440, style changes shown 174, view
    // binds 338, selections 238, equal re-sends 365, palette changes 82, frames showing a scroll
    // node with children 587, scrolls and option changes 110, SCROLL requests 26, an arrow left
    // of the screen 1,160, a drawn view's node resized 112, framed box records 1,160, and frames
    // that prepared a culled row's subtree where it showed 96.
    const minimums: Stats = .{
        // SCROLL requests that deliver a LAYOUT request: 9 in one run.
        .scroll_layouts = 2,
        .reused = 2200,
        .filtered = 350,
        .filtered_requests = 100,
        .reused_filtered_requests = 11,
        .culled_orders = 3800,
        .hidden_hooked = 1500,
        .reply_hides = 11,
        .reply_detaches = 12,
        .reply_destroys = 95,
        .record_replies = 39,
        .remounts = 1500,
        .content_resizes = 17,
        .content_reply_texts = 17,
        .sibling_marks = 32,
        .unmeasured_texts = 4,
        .updates = 800,
        .resizes = 30,
        .layout_changes = 420,
        .records = 180,
        .bodies = 23,
        .decoded = 7400,
        .editor_cursors = 460,
        .host_cursors = 2100,
        .skipped = 2100,
        .partial = 330,
        .banded = 290,
        .split_frames = 130,
        .split_snapshots = 130,
        .retained_records = 56,
        .non_local_records = 10,
        .steady_reads = 97,
        .draft_writes = 720,
        .raw_writes = 100,
        .shared_changes = 110,
        .style_changes = 44,
        .rebinds = 84,
        .selections = 60,
        .resends = 91,
        .palettes = 21,
        .scroll_frames = 150,
        .scroll_changes = 28,
        .scroll_requests = 6,
        .arrows_beside = 280,
        .view_resizes = 26,
        .framed_boxes = 290,
        .subtree_preparations = 24,
    };
    inline for (@typeInfo(Stats).@"struct".field_names) |name| {
        if (comptime std.mem.eql(u8, name, "frames") or std.mem.eql(u8, name, "digest")) continue;
        errdefer std.debug.print("{s}: {d}\n", .{ name, @field(total, name) });
        try testing.expect(@field(total, name) >= @field(minimums, name));
    }
    // Work counts read no clock: a seed that reaches reuse, every request kind, recordings,
    // and filtering replays to the same counts.
    try testing.expectEqual((try runParity(17, 256)).digest, (try runParity(17, 256)).digest);
}
