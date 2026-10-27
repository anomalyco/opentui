const std = @import("std");
const builtin = @import("builtin");
const handles = @import("context-handles.zig");
const yoga = @import("yoga.zig");
const native = @import("native-renderable.zig");
const renderer = @import("renderer.zig");
const buffer = @import("buffer.zig");
const ansi = @import("ansi.zig");
const Text = @import("context.zig").Text;
const Editor = @import("context.zig").Editor;
const TextView = @import("context.zig").TextView;
const text_buffer_view = @import("text-buffer-view.zig");
const utf8 = @import("utf8.zig");
const image = @import("image.zig");
const Context = @import("context.zig").Context;
const nextPaintEpoch = @import("utils.zig").nextPaintEpoch;
const scene_record = @import("scene-record.zig");
const api = @import("context_abi_c");

pub const StyleValue = struct { unit: u32, value: f32 };

pub const BoxDetails = struct {
    title: []const u8 = "",
    bottom_title: []const u8 = "",
    title_alignment: u32 = 0,
    bottom_title_alignment: u32 = 0,
    title_color: ?ansi.RGBA = null,
    custom_border_chars: ?[11]u32 = null,

    fn destroy(self: *BoxDetails, allocator: std.mem.Allocator) void {
        allocator.free(self.title);
        allocator.free(self.bottom_title);
        allocator.destroy(self);
    }
};

pub const SliderOptions = struct {
    min: f64 = 0,
    max: f64 = 100,
    value: f64 = 0,
    viewport_size: f64 = 10,
    orientation: u32 = 0,
    foreground: ansi.RGBA = .{ 154, 158, 163, 255 },
    background: ansi.RGBA = .{ 37, 37, 39, 255 },
};

pub const SliderThumb = struct { size: f64, start: f64 };

pub const ArrowOptions = struct {
    direction: u32 = 0,
    attributes: u32 = 0,
    foreground: ansi.RGBA = .{ 255, 255, 255, 255 },
    background: ansi.RGBA = .{ 0, 0, 0, 0 },
    text: ?[]const u8 = null,

    pub fn deinit(self: ArrowOptions, allocator: std.mem.Allocator) void {
        if (self.text) |text| allocator.free(text);
    }
};

pub const ScrollBarOptions = struct {
    policy: u32 = api.OT_SCENE_SCROLL_BAR_AUTO,
    overlay: bool = false,
    thickness: u32 = 1,
    gap: u32 = 0,
    arrows: bool = false,
    foreground: ansi.RGBA = (SliderOptions{}).foreground,
    background: ansi.RGBA = (SliderOptions{}).background,
};

pub const ScrollOptions = struct {
    axes: u32 = api.OT_SCENE_SCROLL_Y,
    follow: u32 = api.OT_SCENE_SCROLL_FOLLOW_NONE,
    culling: bool = false,
    // Viewport padding in cells: left, top, right, bottom.
    padding: [4]f32 = @splat(0),
    // Wrapper, viewport, and content fills.
    fills: [3]?ansi.RGBA = @splat(null),
    // Horizontal, vertical.
    bars: [2]ScrollBarOptions = @splat(.{}),
};

/// A scroll node's state. Axis 0 is x, axis 1 is y. The two Yoga nodes are owned and are
/// never scene nodes: the viewport node is the box's only Yoga child, and the content node,
/// the viewport node's only child, holds the box's scene children.
pub const ScrollState = struct {
    viewport_node: yoga.YGNodeRef,
    content_node: yoga.YGNodeRef,
    options: ScrollOptions = .{},
    arrows: [2][2]ArrowOptions = @splat(@splat(.{})),
    stuck: bool = true,
    offset: [2]f64 = @splat(0),
    max: [2]f64 = @splat(0),
    extent: [2]f32 = @splat(0),
    // The hidden viewport node's rect, local to the box.
    viewport: Layout = .{},
    // The content node's origin, local to the box.
    content_origin: [2]f32 = @splat(0),
    visible: [2]bool = @splat(false),
    toggle_frame: u64 = 0,
    toggles: u32 = 0,
    reported: [6]f64 = @splat(0),
    // OT_SCENE_SCROLL_CHANGED_* bits of the last SCROLL request.
    changes: u32 = 0,
    // The box's screen position, which the reported geometry follows.
    screen: [2]f64 = @splat(0),
    generation: u64 = 0,

    fn deinit(self: *ScrollState, allocator: std.mem.Allocator) void {
        for (self.arrows) |pair| for (pair) |arrow| arrow.deinit(allocator);
        yoga.yogaNodeFree(self.content_node);
        yoga.yogaNodeFree(self.viewport_node);
        allocator.destroy(self);
    }

    fn followAxis(self: *const ScrollState) ?usize {
        return switch (self.options.follow) {
            api.OT_SCENE_SCROLL_FOLLOW_TOP, api.OT_SCENE_SCROLL_FOLLOW_BOTTOM => 1,
            api.OT_SCENE_SCROLL_FOLLOW_LEFT, api.OT_SCENE_SCROLL_FOLLOW_RIGHT => 0,
            else => null,
        };
    }

    fn followEdge(self: *const ScrollState, axis: usize) f64 {
        const far = self.options.follow == api.OT_SCENE_SCROLL_FOLLOW_BOTTOM or self.options.follow == api.OT_SCENE_SCROLL_FOLLOW_RIGHT;
        return if (far) self.max[axis] else 0;
    }

    /// An explicit scroll or a follow change: the view is stuck at the follow edge when it
    /// reached it, or when the range is noise (at most one cell).
    pub fn restick(self: *ScrollState) void {
        const axis = self.followAxis() orelse return;
        self.stuck = self.max[axis] <= 1 or self.offset[axis] == self.followEdge(axis);
    }

    /// What a SCROLL request reports: offset, content size, viewport size.
    pub fn observed(self: *const ScrollState) [6]f64 {
        return .{ self.offset[0], self.offset[1], self.extent[0], self.extent[1], self.viewport.width, self.viewport.height };
    }

    fn gutter(self: *const ScrollState, axis: usize) f32 {
        const bar = self.options.bars[axis];
        return if (self.visible[axis] and !bar.overlay) @floatFromInt(bar.gap + bar.thickness) else 0;
    }

    /// Writes the gutters of visible inset bars as the box's right and bottom padding.
    /// Returns whether a gutter changed.
    pub fn applyGutters(self: *const ScrollState, box: yoga.YGNodeRef) !bool {
        var changed = false;
        for ([_]u32{ api.OT_EDGE_BOTTOM, api.OT_EDGE_RIGHT }, 0..) |edge, axis| {
            var encoded: u64 = 0;
            try yoga.check(yoga.yogaNodeStyleGetValueChecked(box, api.OT_STYLE_VALUE_PADDING, edge, &encoded));
            const value = self.gutter(axis);
            if (@as(u32, @truncate(encoded)) == api.OT_UNIT_POINT and @as(f32, @bitCast(@as(u32, @truncate(encoded >> 32)))) == value) continue;
            try yoga.check(yoga.yogaNodeStyleSetValueChecked(box, api.OT_STYLE_VALUE_PADDING, edge, api.OT_UNIT_POINT, value));
            changed = true;
        }
        return changed;
    }

    /// A bar's track and arrow rects in screen cells, from the box's paint layout.
    pub fn barRects(self: *const ScrollState, axis: usize, box: Layout, sides: u32) struct { bar: Layout, track: Layout, arrows: [2]Layout } {
        const options = self.options.bars[axis];
        const left: f32 = @floatFromInt(@intFromBool(sides & api.OT_BORDER_LEFT != 0));
        const top: f32 = @floatFromInt(@intFromBool(sides & api.OT_BORDER_TOP != 0));
        const right: f32 = @floatFromInt(@intFromBool(sides & api.OT_BORDER_RIGHT != 0));
        const bottom: f32 = @floatFromInt(@intFromBool(sides & api.OT_BORDER_BOTTOM != 0));
        const thickness: f32 = @floatFromInt(options.thickness);
        var bar: Layout = .{ .screenX = box.screenX + left, .screenY = box.screenY + top, .width = @max(0, box.width - left - right), .height = @max(0, box.height - top - bottom) };
        if (axis == 1) {
            bar.screenX += @max(0, bar.width - thickness);
            bar.width = @min(bar.width, thickness);
        } else {
            bar.width = @max(0, bar.width - self.gutter(1));
            bar.screenY += @max(0, bar.height - thickness);
            bar.height = @min(bar.height, thickness);
        }
        var track = bar;
        var ends_at: [2]Layout = .{ .{}, .{} };
        if (options.arrows) {
            const along: [2]f32 = if (axis == 1) .{ 0, 1 } else .{ 1, 0 };
            const length = if (axis == 1) bar.height else bar.width;
            const ends = @min(2, length);
            ends_at[0] = .{ .screenX = bar.screenX + @floor((bar.width - 1) / 2) * along[1], .screenY = bar.screenY + @floor((bar.height - 1) / 2) * along[0], .width = @min(1, bar.width), .height = @min(1, bar.height) };
            ends_at[1] = ends_at[0];
            ends_at[1].screenX += @max(0, length - 1) * along[0];
            ends_at[1].screenY += @max(0, length - 1) * along[1];
            if (axis == 1) {
                track.screenY += @min(1, ends);
                track.height -= ends;
            } else {
                track.screenX += @min(1, ends);
                track.width -= ends;
            }
        }
        return .{ .bar = bar, .track = track, .arrows = ends_at };
    }

    pub fn slider(self: *const ScrollState, axis: usize) SliderOptions {
        const size = if (axis == 1) self.viewport.height else self.viewport.width;
        const inner = size - self.options.padding[axis] - self.options.padding[axis + 2];
        return .{
            .max = self.max[axis],
            .value = self.offset[axis],
            .viewport_size = @max(1, inner),
            .orientation = @intCast(axis),
            .foreground = self.options.bars[axis].foreground,
            .background = self.options.bars[axis].background,
        };
    }
};

pub const TextOptions = struct {
    foreground: ansi.RGBA = .{ 255, 255, 255, 255 },
    background: ansi.RGBA = .{ 0, 0, 0, 0 },
    attributes: u32 = 0,
    wrap_mode: text_buffer_view.WrapMode = .word,
    text_align: text_buffer_view.TextAlign = .left,
    truncate: bool = false,
    first_line_offset: u32 = 0,
    scroll_x: f64 = 0,
    scroll_y: f64 = 0,
    tab_indicator: ?u32 = null,
    tab_color: ?ansi.RGBA = null,
};

pub const TextInfo = struct {
    byte_count: u32,
    text_length: u32,
    line_count: u32,
    virtual_line_count: u32,
    width_cols_max: u32,
};

pub const EditorOptions = struct {
    show_cursor: bool = true,
    style: u32 = 0,
    blinking: bool = true,
    color: ansi.RGBA = .{ 255, 255, 255, 255 },
    mouse_pointer: u32 = api.OT_MOUSE_POINTER_UNCHANGED,
};

pub const TextLine = extern struct {
    start_cols: u32,
    width_cols: u32,
    source_line: u32,
    wrap_index: u32,
};

pub const CursorState = struct {
    x: u32,
    y: u32,
    visible: bool,
    style: u32,
    blinking: bool,
    color: [4]f32,
};

pub const Layout = struct {
    left: f32 = 0,
    top: f32 = 0,
    right: f32 = 0,
    bottom: f32 = 0,
    width: f32 = 0,
    height: f32 = 0,
    screenX: f64 = 0,
    screenY: f64 = 0,
};

pub const Paint = struct {
    zIndex: i32 = 0,
    opacity: f32 = 1,
    translateX: f64 = 0,
    translateY: f64 = 0,
    borderSides: u32 = 0,
    shouldFill: u32 = 1,
    background: ansi.RGBA = .{ 0, 0, 0, 0 },
    borderColor: ansi.RGBA = .{ 255, 255, 255, 255 },
    borderStyle: u32 = 0,
    focusable: bool = false,
    focusedBorderColor: ansi.RGBA = .{ 0, 170, 255, 255 },
};

// Field order is the partial-property wire order; bool occupies a u32 on the wire.
pub const paint_fields = .{ "zIndex", "opacity", "translateX", "translateY", "borderSides", "shouldFill", "background", "borderColor", "borderStyle", "focusable", "focusedBorderColor" };
pub const paint_fields_all: u32 = (1 << paint_fields.len) - 1;
const scene_hook_flags_all: u32 = api.OT_SCENE_HOOK_UPDATE | api.OT_SCENE_HOOK_RESIZE | api.OT_SCENE_HOOK_LAYOUT_CHANGED | api.OT_SCENE_HOOK_RENDER_BEFORE | api.OT_SCENE_HOOK_RENDER_AFTER | api.OT_SCENE_HOOK_RENDER_SELF | api.OT_SCENE_HOOK_IDLE_UPDATE | api.OT_SCENE_HOOK_SCROLL;
const scene_layout_hook_flags: u32 = api.OT_SCENE_HOOK_UPDATE | api.OT_SCENE_HOOK_RESIZE | api.OT_SCENE_HOOK_LAYOUT_CHANGED | api.OT_SCENE_HOOK_SCROLL;
const scene_paint_hook_flags: u32 = api.OT_SCENE_HOOK_RENDER_BEFORE | api.OT_SCENE_HOOK_RENDER_AFTER | api.OT_SCENE_HOOK_RENDER_SELF;

pub const FrameOptions = struct {
    background: ansi.RGBA,
    use_mouse: bool,
    excluded_hit_num: u32,
    max_layout_rounds: u32,
    max_host_requests: u32,
    preserve_unwritten: bool = false,
};

pub const FrameRequest = struct {
    session: handles.Handle,
    root: handles.Handle,
    node: handles.Handle,
    frame_id: u64,
    request_id: u64,
    layout_epoch: u64,
    hook_generation: u64,
    kind: u32,
    num: u32,
    width: u32,
    height: u32,
};

pub const BufferIdentity = struct {
    destination: usize,
    storage: usize,
    generation: u64,

    pub fn init(target: *buffer.OptimizedBuffer) BufferIdentity {
        return .{
            .destination = @intFromPtr(target),
            .storage = @intFromPtr(target.storage),
            .generation = target.storage.generation,
        };
    }

    pub fn matches(self: BufferIdentity, target: *buffer.OptimizedBuffer) bool {
        return std.meta.eql(self, init(target));
    }
};

const Painted = struct {
    ticket: FrameRequest,
    destination: BufferIdentity,
    work: renderer.FrameWork,
    // Rows that may differ from the presented frame, or null for every row.
    damage: ?*const std.DynamicBitSetUnmanaged,
};

/// What a member's cells depend on. Equal inputs paint equal cells in the same rows.
const PaintInputs = struct {
    layout: Layout,
    clip: buffer.ClipRect,
    opacity: f32,
    // Position in paint order: an order change repaints both members it swaps.
    rank: u32,
    focused: bool,
    node_epoch: u64,
    resource_epoch: u64,
    // A destroyed style unbinds its borrowers without a mutation gate.
    styled: bool,
    // What the member's paint hooks recorded this frame, or 0.
    record_digest: u64,
};

/// One painted member of a frame and the rows it paints.
const Record = struct {
    token: u32,
    top: u32,
    bottom: u32,
    // Bodies native code cannot fingerprint (surfaces) always repaint.
    stable: bool,
    inputs: PaintInputs,
};

const Damage = enum { all, rows, none };

/// Rows [top, bottom) that a band frame clears and repaints.
const Band = struct {
    top: u32,
    bottom: u32,

    fn meets(self: Band, rows: Band) bool {
        return self.top < rows.bottom and rows.top < self.bottom;
    }
};
const bands_max = 16;
const whole_screen = [1]Band{.{ .top = 0, .bottom = std.math.maxInt(u32) }};

const Attempt = struct {
    root: handles.Handle,
    frame_id: u64,
    options: FrameOptions,
    rounds: u32 = 0,
    // A round of this attempt walked the candidates.
    walked: bool = false,
    // Advances per feedback pass; a node's feedback state from another pass reads as unseen.
    feedback_id: u64 = 0,
    // A host reply marked a node, so feedback runs again in this round; the pass running is such
    // a follow-up.
    followup: bool = false,
    followup_pass: bool = false,
    requests: u32 = 0,
    request_id: u64 = 0,
    pending: ?FrameRequest = null,
    // Scene.visibility_epoch when this round stamped prepared_visible.
    visibility_epoch: u64 = 0,
};

pub const ImageState = struct {
    source: ?*image.Image = null,
    buffer: ?*buffer.OptimizedBuffer = null,
    fit: image.Fit = .fit,
    protocol: image.RenderProtocol = .auto,

    pub fn deinit(self: ImageState) void {
        if (self.source) |source| source.deinit();
        if (self.buffer) |target| target.deinit();
    }
};

const Control = union {
    box: ?*BoxDetails,
    slider: SliderOptions,
    arrow: ArrowOptions,
    editor: EditorOptions,
    text_view: struct { view: ?*TextView = null, paint: bool = true },
    image: ImageState,

    fn deinit(self: Control, kind: u32, allocator: std.mem.Allocator) void {
        switch (kind) {
            api.OT_SCENE_BOX => if (self.box) |details| details.destroy(allocator),
            api.OT_SCENE_ARROW => self.arrow.deinit(allocator),
            api.OT_SCENE_IMAGE => self.image.deinit(),
            else => {},
        }
    }
};

/// Scene state extends the existing Yoga owner; it never owns a second layout node.
pub const Node = struct {
    owner: *Scene,
    handle: handles.Handle,
    kind: u32,
    num: u32,
    token: u32,
    previous: ?*native.NativeRenderable = null,
    next: ?*native.NativeRenderable = null,
    parent: ?*native.NativeRenderable = null,
    children: std.ArrayListUnmanaged(*native.NativeRenderable) = .empty,
    paint_children: std.ArrayListUnmanaged(*native.NativeRenderable) = .empty,
    // Strictly increasing along paint_children, so a sorted batch of children is in paint order.
    paint_rank: u64 = 0,
    sort_dirty: bool = false,
    child_order_frame: u64 = 0,
    layout_flags: packed struct {
        // Newly placed hidden children expose geometry once, without paint membership.
        needs_layout: bool = true,
        display_none: bool = false,
        clips_children: bool = false,
        // Visible with every ancestor when this round prepared the node.
        prepared_visible: bool = false,
    } = .{},
    skip: Skip = .{},
    culling: Culling = .{},
    pass: Pass = .{},
    paint: Paint = .{},
    layout: Layout = .{},
    observed_layout: Layout = .{},
    viewport: ?handles.Handle = null,
    scroll: ?*ScrollState = null,
    focus_frame: u64 = 0,
    text: ?*Text = null,
    editor: ?*Editor = null,
    measure_overridden: bool = false,
    // A custom measurement failed since the last retry pass.
    measure_failed: bool = false,
    // The last retry pass measured the node again or kept it at zero.
    measure_retried: bool = false,
    control: Control = .{ .slider = .{} },
    hook_flags: u32 = 0,
    hook_generation: u64 = 0,
    update_frame: u64 = 0,
    observed_frame: u64 = 0,
    observed_round: u32 = 0,
    // Scene.layout_epoch when node.layout took the solved geometry; a new node never did.
    geometry_epoch: u64 = std.math.maxInt(u64),
    // Scene.candidates_gen of the walk that listed the node.
    prepared_gen: u64 = 0,
    feedback_id: u64 = 0,
    feedback_state: FeedbackState = .unseen,
    placement: u64 = 0,
    resize_width: f64 = 0,
    resize_height: f64 = 0,
    // Changes with every setter of what the node itself paints.
    paint_epoch: u64 = 0,
    // The node's record in a frame's records: two slots, for the presented and the draft frame.
    records: [2]struct { frame: u64 = 0, index: u32 = 0 } = .{ .{}, .{} },

    /// The Yoga node that holds the scene children's Yoga nodes.
    pub fn childYoga(self: *const Node, value: *const native.NativeRenderable) yoga.YGNodeRef {
        return if (self.scroll) |state| state.content_node else value.yoga_node;
    }

    pub fn filtersChildren(self: *const Node) bool {
        return self.viewport != null or (self.scroll != null and self.scroll.?.options.culling);
    }

    fn feedback(self: *const Node, active: *const Attempt) FeedbackState {
        return if (self.feedback_id == active.feedback_id) self.feedback_state else .unseen;
    }

    fn setFeedback(self: *Node, active: *const Attempt, state: FeedbackState) void {
        self.feedback_id = active.feedback_id;
        self.feedback_state = state;
    }
};

const FeedbackState = enum { unseen, queued, started };

/// Whether feedback must visit a node's subtree. A node whose next refresh may differ from its
/// last one is self_stale, and no ancestor of it, or of a parent whose children's order
/// changed, is clean. The counts cover the subtree, the node included. The attention list
/// holds, unordered, at least every child that may need feedback (needsFeedback).
const Skip = struct {
    attention: std.ArrayListUnmanaged(*native.NativeRenderable) = .empty,
    attention_index: u32 = no_slot,
    update_below: u32 = 0,
    filters_below: u32 = 0,
    // Clean: every node feedback would visit in the subtree needs nothing, for the selection of
    // Culling.clean_selection. Culled and hidden nodes keep their own state.
    subtree: enum(u8) { clean, running, stale } = .stale,
    self_stale: bool = true,
    // A child was marked since the node's last refresh batch.
    refresh_due: bool = false,
    // The node is listed in Scene.view_dirty.
    view_queued: bool = false,
    // The feedback pass in which a host reply listed the node in Scene.marked.
    marked_pass: u64 = 0,
};

/// A child a reply marked, grouped by its parent's token for the later pass.
const Remark = struct { parent: u32, child: handles.Handle };

fn remarkLessThan(_: void, left: Remark, right: Remark) bool {
    return left.parent < right.parent;
}

/// A filtering parent's last overlap scan, the scan a child last overlapped in, and the
/// selection for which the subtree was clean, all Scene.selection_epoch values.
const Culling = struct {
    selected_epoch: u64 = 0,
    selected_at: u64 = 0,
    clean_selection: u64 = 0,
};

/// How far feedback passed a parent's children in a frame: children sort there, once per
/// frame, and an idle-update node uses its update. A child is passed if its rank is below cursor
/// and limit and, if the parent culls, a scan of this frame selected it. Ranks of children
/// attached later are at least limit. The cursor keeps the frame's first round, so a culling
/// parent's later round passes a child as soon as it selects it, before the child pops, which
/// the old walk did only with that child earlier in paint order.
const Pass = struct {
    frame: u64 = 0,
    cursor: u64 = 0,
    limit: u64 = 0,
    // A selection of the frame ended: it decided which of its children were passed.
    finished: bool = false,
    // The parent's selected_epoch at its first culling selection of the frame, kept through
    // later scans, which do not undo what an earlier one passed; and whether the last culled.
    epoch: u64 = 0,
    culls: bool = false,
    // The frame in which the node moved away from where feedback had passed it.
    moved_frame: u64 = 0,
};

const Work = struct {
    node: *native.NativeRenderable,
    layout: Layout,
    clip: buffer.ClipRect,
    opacity: f32,
    visible: bool,
    filtered: bool,
    // A scroll node's bars, painted after its children.
    bars: bool = false,
};

const PreparationFrame = struct {
    node: *native.NativeRenderable,
    parent: Layout,
    clip: buffer.ClipRect,
    opacity: f32,
    child: usize = 0,
    entered: bool = false,
    filtered: bool = false,
    filter: ?Filter = null,
    // The node's work entry, which a scroll node's bars repeat after its children.
    work_index: usize = 0,
};

const no_slot = std.math.maxInt(u32);

/// A prepared member of a recorded frame. Handles survive the host's record batch.
const PaintMember = struct {
    node: handles.Handle,
    layout: Layout,
    clip: buffer.ClipRect,
    opacity: f32,
    filtered: bool,
    bars: bool,
    slot: u32,
};

/// A node whose paint hooks the host records for the pending RECORD request.
pub const PaintSlot = struct {
    node: handles.Handle,
    num: u32,
    hooks: u32,
    hook_generation: u64,
    layout: Layout,
    public_layout: ?Layout,
    clip: buffer.ClipRect,
    opacity: f32,
};

/// A painted member's rect within its clip, in screen cells.
pub const Hit = struct { x: u32, y: u32, width: u32, height: u32, token: u32 };

/// The index of the last hit in paint order that covers a cell: what a grid that every
/// member overwrote in paint order would hold there.
pub fn topmostHit(hits: []const Hit, x: u32, y: u32) ?usize {
    var index = hits.len;
    while (index != 0) {
        index -= 1;
        const hit = hits[index];
        if (x >= hit.x and y >= hit.y and x - hit.x < hit.width and y - hit.y < hit.height) return index;
    }
    return null;
}

const Filter = struct {
    viewport: Layout,
    row: bool,
};

const Feedback = struct {
    node: handles.Handle,
    kind: enum { update, refresh, prepass, placed, children, filtered_refresh, select, scroll, done },
    placement: u64 = 0,
    // A queued child's parent and paint rank, and whether its parent's selection needed it:
    // FULL_FRAME queues every child.
    parent: ?handles.Handle = null,
    rank: u64 = 0,
    needed: bool = true,
};

/// Session-owned storage. Tokens never recycle, and only live nodes remain in the
/// map, so a completed old grid cannot identify a replacement after slot reuse.
pub const Scene = struct {
    allocator: std.mem.Allocator,
    session: handles.Handle,
    root: ?*native.NativeRenderable = null,
    head: ?*native.NativeRenderable = null,
    count: u32 = 0,
    hook_count: u32 = 0,
    layout_hook_count: u32 = 0,
    filter_count: u32 = 0,
    // Scroll nodes: each may add a bars entry to the work list.
    scroll_count: u32 = 0,
    // A scroll node toggled a bar in this preparation: its round solves again before any hook.
    scroll_toggled: bool = false,
    focus: ?handles.Handle = null,
    // Do not hide host-managed cursors in scenes that have not placed an editor cursor.
    editor_cursor_owned: bool = false,
    last_token: u32 = 0,
    last_placement: u64 = 0,
    tokens: std.AutoHashMapUnmanaged(u32, handles.Handle) = .empty,
    // Each removal leaves a tombstone that inserts never reclaim; see removeToken.
    token_tombstones: u32 = 0,
    style_node: yoga.YGNodeRef,
    // The preparation list that feedback reads, and the paint list. Both outlive frames and
    // host requests: every change to what they hold clears both, so a non-empty list is valid.
    // Their node pointers stay valid because storage is released or reused only after remove,
    // cancelFrame, or insert cleared them.
    candidates: std.ArrayListUnmanaged(Work) = .empty,
    members: std.ArrayListUnmanaged(Work) = .empty,
    // Advances with each candidates walk, which clears both lists first.
    candidates_gen: u64 = 0,
    last_feedback_id: u64 = 0,
    feedback: std.ArrayListUnmanaged(Feedback) = .empty,
    paint_members: std.ArrayListUnmanaged(PaintMember) = .empty,
    paint_slots: std.ArrayListUnmanaged(PaintSlot) = .empty,
    segments: std.ArrayListUnmanaged(scene_record.Segments) = .empty,
    // Hit rectangles in paint order: the draft frame's, and the presented frame's. A hit
    // test walks the presented ones from the top, so no frame writes a screen-sized grid.
    hits: std.ArrayListUnmanaged(Hit) = .empty,
    presented_hits: std.ArrayListUnmanaged(Hit) = .empty,
    hits_frame: u64 = 0,
    hits_generation: u64 = 0,
    presented_hits_frame: u64 = 0,
    // Paint records of the draft frame and of the presented frame, which retained paint
    // compares; the damaged rows of the draft.
    records: std.ArrayListUnmanaged(Record) = .empty,
    presented_records: std.ArrayListUnmanaged(Record) = .empty,
    records_frame: u64 = 0,
    presented_records_frame: u64 = 0,
    records_options: FrameOptions = undefined,
    presented_options: FrameOptions = undefined,
    damage: std.DynamicBitSetUnmanaged = .{},
    // Runs of damaged rows, closer runs merged: a frame with damage clears and paints only these,
    // or every row without a band.
    bands: [bands_max]Band = undefined,
    band_count: usize = 0,
    // The scratch buffer of a verified skip while it paints (OT_SCENE_DEBUG_VERIFY).
    verify_target: ?*buffer.OptimizedBuffer = null,
    attempt: ?Attempt = null,
    painted: ?Painted = null,
    cancelled_paint: bool = false,
    last_frame_id: u64 = 0,
    layout_epoch: u64 = 0,
    // Changes with any display or ancestry change, so stamped visibility goes stale mid-attempt.
    visibility_epoch: u64 = 0,
    // Changes with anything that can change which children a filtering parent selects.
    selection_epoch: u64 = 1,
    // Nodes whose view changed outside an attempt; a round that keeps its lists prepares them.
    view_dirty: std.ArrayListUnmanaged(*native.NativeRenderable) = .empty,
    // The nodes host replies marked in the running feedback pass, and those of the pass before,
    // which a later pass scans instead of a parent's whole attention list (see scanList).
    marked: std.ArrayListUnmanaged(handles.Handle) = .empty,
    remarked: std.ArrayListUnmanaged(Remark) = .empty,
    scratch: std.ArrayListUnmanaged(*native.NativeRenderable) = .empty,
    layout_pending: bool = false,
    layout_width: u32 = 0,
    layout_height: u32 = 0,
    preparation_dirty: bool = true,
    // Some node failed a custom measurement or ends a retry in the next retry pass.
    measure_failed: bool = false,
    // The active attempt's work; it moves into the DONE draft and dies with a cancelled attempt.
    frame_work: renderer.FrameWork = .{},
    // OT_SCENE_DEBUG_* bits. Every shortcut that skips frame work tests FULL_FRAME.
    debug_flags: u32 = 0,
    test_sort_steps: if (builtin.is_test) u64 else void = if (builtin.is_test) 0 else {},
    test_hit_steps: if (builtin.is_test) u64 else void = if (builtin.is_test) 0 else {},
    // Editor cursor work: placements tried and releases written.
    test_cursor_steps: if (builtin.is_test) u64 else void = if (builtin.is_test) 0 else {},
    // Preparation entries stamped as this round's candidates.
    test_stamp_steps: if (builtin.is_test) u64 else void = if (builtin.is_test) 0 else {},
    // Token lookups of recorded nodes while planning paint.
    test_record_lookups: if (builtin.is_test) u64 else void = if (builtin.is_test) 0 else {},
    // Child entries that feedback scans.
    test_feedback_child_steps: if (builtin.is_test) u64 else void = if (builtin.is_test) 0 else {},

    pub fn init(allocator: std.mem.Allocator, config: *yoga.Config, session: handles.Handle) !*Scene {
        const self = try allocator.create(Scene);
        errdefer allocator.destroy(self);
        self.* = .{ .allocator = allocator, .session = session, .style_node = try config.createNode() };
        return self;
    }

    pub fn deinit(self: *Scene) void {
        std.debug.assert(self.head == null and self.count == 0 and self.tokens.count() == 0);
        std.debug.assert(self.hook_count == 0 and self.filter_count == 0 and self.attempt == null);
        std.debug.assert(self.layout_hook_count == 0);
        std.debug.assert(self.painted == null);
        std.debug.assert(self.focus == null);
        yoga.yogaNodeFree(self.style_node);
        self.tokens.deinit(self.allocator);
        self.candidates.deinit(self.allocator);
        self.members.deinit(self.allocator);
        self.feedback.deinit(self.allocator);
        self.view_dirty.deinit(self.allocator);
        self.marked.deinit(self.allocator);
        self.remarked.deinit(self.allocator);
        self.scratch.deinit(self.allocator);
        self.paint_members.deinit(self.allocator);
        self.paint_slots.deinit(self.allocator);
        self.segments.deinit(self.allocator);
        self.hits.deinit(self.allocator);
        self.presented_hits.deinit(self.allocator);
        self.records.deinit(self.allocator);
        self.presented_records.deinit(self.allocator);
        self.damage.deinit(self.allocator);
        self.allocator.destroy(self);
    }

    pub fn prepareInsert(self: *Scene, kind: u32, num: u32) !void {
        std.debug.assert(kind <= api.OT_SCENE_IMAGE and num != 0);
        if (kind == api.OT_SCENE_ROOT and self.root != null) return error.SceneAlreadyAttached;
        if (self.last_token == std.math.maxInt(u32)) return error.ObjectLimit;
        try self.tokens.ensureUnusedCapacity(self.allocator, 1);
        try self.view_dirty.ensureTotalCapacity(self.allocator, self.count + 1);
        // A pass lists each live node at most once and keeps destroyed nodes' entries, so room
        // for every entry plus every node the pass has not listed yet is enough.
        try self.marked.ensureTotalCapacity(self.allocator, self.marked.items.len + self.count + 1);
        try self.remarked.ensureTotalCapacity(self.allocator, self.count + 1);
        try self.scratch.ensureTotalCapacity(self.allocator, self.count + 1);
    }

    pub fn insert(self: *Scene, storage: native.NodeStorage, handle: handles.Handle, kind: u32, num: u32) void {
        const value = storage.node;
        const node_ptr = storage.scene_node;
        self.last_token += 1;
        node_ptr.* = .{
            .owner = self,
            .handle = handle,
            .kind = kind,
            .num = num,
            .token = self.last_token,
            .next = self.head,
            .children = storage.children,
            .paint_children = storage.paint_children,
            .skip = .{ .attention = storage.attention },
        };
        value.scene_node = node_ptr;
        if (kind == api.OT_SCENE_BOX) value.scene_node.?.control = .{ .box = null };
        if (kind == api.OT_SCENE_ARROW) value.scene_node.?.control = .{ .arrow = .{} };
        if (kind == api.OT_SCENE_EDITOR) value.scene_node.?.control = .{ .editor = .{} };
        if (kind == api.OT_SCENE_TEXT_VIEW) value.scene_node.?.control = .{ .text_view = .{} };
        if (kind == api.OT_SCENE_IMAGE) value.scene_node.?.control = .{ .image = .{} };
        if (self.head) |head| head.scene_node.?.previous = value;
        self.head = value;
        self.count += 1;
        self.tokens.putAssumeCapacity(self.last_token, handle);
        if (kind == api.OT_SCENE_ROOT) self.root = value;
        self.preparation_dirty = true;
        self.clearPreparation();
    }

    /// Tokens only increase, so steady create/destroy churn fills the map with tombstones until
    /// every insert and miss probes the whole table. Rehashing once tombstones take half of the
    /// slots that live entries leave keeps probes short. The load limit leaves at least a fifth of
    /// the slots unused, so the cost is a bounded number of slots per removal.
    fn removeToken(self: *Scene, token: u32) void {
        const removed = self.tokens.remove(token);
        std.debug.assert(removed);
        self.token_tombstones += 1;
        const unused = self.tokens.capacity() - self.tokens.count();
        if (self.token_tombstones >= unused / 2) {
            self.tokens.rehash(std.hash_map.AutoContext(u32){});
            self.token_tombstones = 0;
        }
    }

    pub fn move(self: *Scene, value: *native.NativeRenderable, destination: ?*native.NativeRenderable, index: u32) !void {
        const node = value.scene_node.?;
        if (node.kind == api.OT_SCENE_ROOT) return error.YogaInvalidArgument;
        const reparented = node.parent != destination;
        const new_placement = destination != null and (reparented or node.placement == 0);
        if (new_placement and self.last_placement == std.math.maxInt(u64)) return error.ObjectLimit;
        if (destination) |parent| {
            const target = parent.scene_node.?;
            if (target.owner != self) return error.WrongSession;
            if (index > target.children.items.len - @intFromBool(node.parent == parent)) return error.YogaInvalidArgument;
            if (node.parent != parent) {
                try target.children.ensureUnusedCapacity(self.allocator, 1);
                try target.paint_children.ensureUnusedCapacity(self.allocator, 1);
                try target.skip.attention.ensureTotalCapacity(self.allocator, target.children.items.len + 1);
            }
            try yoga.check(yoga.yogaNodeMoveChildChecked(target.childYoga(parent), value.yoga_node, index));
            const previous = node.parent;
            // Children that feedback passed keep this frame's order wherever they go.
            if (previous != parent and self.attempt != null and node.child_order_frame != self.attempt.?.frame_id and self.passedThisFrame(value)) node.pass.moved_frame = self.attempt.?.frame_id;
            if (previous) |old| removeChild(&old.scene_node.?.children, value);
            target.children.insertAssumeCapacity(index, value);
            if (previous != parent) {
                if (previous) |old| self.detach(value, old);
                // A child moved into a parent feedback passed paints after its siblings.
                self.settleOrder(parent);
                const siblings = target.paint_children.items;
                if (siblings.len != 0 and siblings[siblings.len - 1].scene_node.?.paint.zIndex > node.paint.zIndex) self.orderChanged(parent);
                // At least limit: a reply may have detached the children a pass saw last.
                node.paint_rank = @max(target.pass.limit, if (siblings.len == 0) 0 else siblings[siblings.len - 1].scene_node.?.paint_rank + 1);
                target.paint_children.appendAssumeCapacity(value);
                node.parent = parent;
                countBelow(parent, node.skip.update_below, node.skip.filters_below, true);
            }
        } else {
            if (index != 0) return error.YogaInvalidArgument;
            if (node.parent) |old| {
                try yoga.check(yoga.yogaNodeRemoveChildChecked(old.scene_node.?.childYoga(old), value.yoga_node));
                removeChild(&old.scene_node.?.children, value);
                self.detach(value, old);
            }
        }
        if (self.attempt) |active| {
            if (reparented and node.feedback(&active) == .queued) {
                // Unstarted work follows accepted parentage; an entered node keeps its continuation.
                for (self.feedback.items, 0..) |operation, queued_index| {
                    if (operation.kind == .update and std.meta.eql(operation.node, node.handle)) {
                        _ = self.feedback.orderedRemove(queued_index);
                        node.setFeedback(&active, .unseen);
                        break;
                    }
                } else unreachable;
            }
        }
        // The lists hold node pointers; a pending RECORD request keeps only qualified handles.
        if (new_placement) {
            self.last_placement += 1;
            node.placement = self.last_placement;
        } else if (destination == null) node.placement = 0;
        node.layout_flags.needs_layout = true;
        self.visibility_epoch +%= 1;
        self.selection_epoch +%= 1;
        self.preparation_dirty = true;
        self.clearPreparation();
        markObservationStale(value);
    }

    /// Takes a node out of its parent's paint children, attention, and counts.
    fn detach(self: *Scene, value: *native.NativeRenderable, parent: *native.NativeRenderable) void {
        const node = value.scene_node.?;
        removeChild(&parent.scene_node.?.paint_children, value);
        if (node.skip.attention_index != no_slot) dropAttention(parent.scene_node.?, node.skip.attention_index);
        countBelow(parent, node.skip.update_below, node.skip.filters_below, false);
        node.parent = null;
        self.markSubtree(parent);
    }

    /// A child's paint order input changed. Children sort once per frame, where feedback passes
    /// their parent; if it already did, the change waits for the next frame, which must visit
    /// the parent: it may keep this frame's paint list.
    fn orderChanged(self: *Scene, parent: *native.NativeRenderable) void {
        self.settleOrder(parent);
        parent.scene_node.?.sort_dirty = true;
        self.markSubtree(parent);
    }

    /// Before a change to their order, sorts the children of a parent that feedback passed in
    /// this frame without sorting them. Every earlier change came through here, so they sort
    /// with the inputs they had when feedback passed them, as the paint walk would.
    fn settleOrder(self: *Scene, parent: *native.NativeRenderable) void {
        const active = self.attempt orelse return;
        const node = parent.scene_node.?;
        if (node.child_order_frame == active.frame_id or !self.passedThisFrame(parent)) return;
        if (sortChildren(node, active.frame_id)) self.clearPreparation();
    }

    /// Whether feedback passed the node in this frame: a selection passed its rank, or it lies
    /// in a subtree that was passed whole.
    fn passedThisFrame(self: *Scene, value: *native.NativeRenderable) bool {
        const active = self.attempt orelse return false;
        if (value.scene_node.?.child_order_frame == active.frame_id) return true;
        var current = value;
        while (true) {
            if (builtin.is_test) self.test_sort_steps += 1;
            const node = current.scene_node.?;
            if (node.pass.moved_frame == active.frame_id) return true;
            const parent = node.parent orelse return false;
            const target = parent.scene_node.?;
            if (target.pass.frame == active.frame_id) {
                if (node.paint_rank < @min(target.pass.cursor, target.pass.limit) and
                    (!target.pass.culls or node.culling.selected_at >= target.pass.epoch)) return true;
                // A running selection passes its children one by one, but an earlier pass may have
                // passed its parent whole.
                if (target.pass.finished) return false;
            }
            current = parent;
        }
    }

    fn countBelow(start: *native.NativeRenderable, updates: u32, filters: u32, comptime add: bool) void {
        var cursor: ?*native.NativeRenderable = start;
        while (cursor) |value| : (cursor = value.scene_node.?.parent) {
            const node = value.scene_node.?;
            if (add) {
                node.skip.update_below += updates;
                node.skip.filters_below += filters;
                attend(value);
            } else {
                node.skip.update_below -= updates;
                node.skip.filters_below -= filters;
            }
        }
    }

    fn needsFeedback(node: *const Node) bool {
        return node.skip.update_below != 0 or node.skip.subtree != .clean or node.skip.filters_below != 0;
    }

    /// Whether a pass must visit a node: something below changed, a selection change can reveal
    /// changed nodes, or a hook below can request. A later pass meets a clean hooked subtree only
    /// where it visits a parent for the first time in the frame (scanList).
    fn mustVisit(self: *const Scene, node: *const Node) bool {
        return node.skip.subtree != .clean or node.skip.update_below != 0 or
            (node.skip.filters_below != 0 and node.culling.clean_selection != self.selection_epoch);
    }

    fn dropAttention(node: *Node, index: usize) void {
        node.skip.attention.items[index].scene_node.?.skip.attention_index = no_slot;
        _ = node.skip.attention.swapRemove(index);
        if (index < node.skip.attention.items.len) node.skip.attention.items[index].scene_node.?.skip.attention_index = @intCast(index);
    }

    /// Lists a child that may need feedback with its parent, which reserved room for every child.
    fn attend(value: *native.NativeRenderable) void {
        const node = value.scene_node.?;
        const parent = node.parent orelse return;
        if (node.skip.attention_index != no_slot or !needsFeedback(node)) return;
        const list = &parent.scene_node.?.skip.attention;
        node.skip.attention_index = @intCast(list.items.len);
        list.appendAssumeCapacity(value);
    }

    /// Marks a node and its ancestors. A mark in a host reply runs feedback again in this round,
    /// which reaches the node wherever the running pass had got to.
    fn markSubtree(self: *Scene, value: *native.NativeRenderable) void {
        const reply = if (self.attempt) |active| active.pending != null else false;
        if (reply) self.attempt.?.followup = true;
        var cursor: ?*native.NativeRenderable = value;
        while (cursor) |current| : (cursor = current.scene_node.?.parent) {
            const node = current.scene_node.?;
            node.skip.subtree = .stale;
            attend(current);
            if (!reply or node.parent == null or node.skip.marked_pass == self.attempt.?.feedback_id) continue;
            node.skip.marked_pass = self.attempt.?.feedback_id;
            self.marked.appendAssumeCapacity(node.handle);
        }
    }

    /// The children a pass scans under a parent: its attention list, or, in a later pass of the
    /// round over a parent that already selected in this frame, the children that replies
    /// marked in the pass before. One reply's mark then costs its path, not a parent's list.
    fn scanList(self: *Scene, objects: *const handles.Table, node: *const Node) []*native.NativeRenderable {
        if (!self.laterScan(node)) return node.skip.attention.items;
        const items = self.remarked.items;
        var low: usize = 0;
        var high = items.len;
        while (low < high) {
            const middle = low + (high - low) / 2;
            if (items[middle].parent < node.token) low = middle + 1 else high = middle;
        }
        self.scratch.clearRetainingCapacity();
        for (items[low..]) |entry| {
            if (entry.parent != node.token) break;
            // A child that moved since stays in its old parent's group: its update and refresh
            // entries drop it on the parent check, and a placed refresh refreshes it once.
            self.scratch.appendAssumeCapacity(objects.get(entry.child, .native_renderable, native.NativeRenderable) catch continue);
        }
        return self.scratch.items;
    }

    fn laterScan(self: *const Scene, node: *const Node) bool {
        const active = &self.attempt.?;
        return active.followup_pass and node.pass.frame == active.frame_id;
    }

    /// Groups the nodes replies marked in the pass that ended by parent, for the next pass.
    fn startLaterPass(self: *Scene, objects: *const handles.Table, root: *native.NativeRenderable) void {
        self.remarked.clearRetainingCapacity();
        for (self.marked.items) |handle| {
            const value = objects.get(handle, .native_renderable, native.NativeRenderable) catch continue;
            const parent = value.scene_node.?.parent orelse continue;
            self.remarked.appendAssumeCapacity(.{ .parent = parent.scene_node.?.token, .child = handle });
        }
        self.marked.clearRetainingCapacity();
        std.mem.sort(Remark, self.remarked.items, {}, remarkLessThan);
        self.attempt.?.followup = false;
        self.attempt.?.followup_pass = true;
        self.startFeedback(root);
    }

    pub fn remove(self: *Scene, value: *native.NativeRenderable) native.NodeStorage {
        const node = value.scene_node.?;
        node.control.deinit(node.kind, self.allocator);
        self.filter_count -= @intFromBool(node.filtersChildren());
        if (node.parent) |parent| {
            yoga.yogaNodeRemoveChild(parent.scene_node.?.childYoga(parent), value.yoga_node);
            removeChild(&parent.scene_node.?.children, value);
            self.detach(value, parent);
        }
        if (node.skip.view_queued) {
            const index = std.mem.indexOfScalar(*native.NativeRenderable, self.view_dirty.items, value).?;
            _ = self.view_dirty.swapRemove(index);
        }
        // Bulk detachment avoids repeated shifting of a wide Yoga child vector.
        yoga.check(yoga.yogaNodeRemoveAllChildrenChecked(node.childYoga(value))) catch unreachable;
        if (node.scroll) |state| {
            yoga.check(yoga.yogaNodeRemoveAllChildrenChecked(value.yoga_node)) catch unreachable;
            state.deinit(self.allocator);
            node.scroll = null;
            self.scroll_count -= 1;
        }
        for (node.children.items) |child| {
            child.scene_node.?.parent = null;
            child.scene_node.?.placement = 0;
            child.scene_node.?.skip.attention_index = no_slot;
        }
        node.children.clearRetainingCapacity();
        node.paint_children.clearRetainingCapacity();
        node.skip.attention.clearRetainingCapacity();
        if (node.previous) |previous| previous.scene_node.?.next = node.next else self.head = node.next;
        if (node.next) |next| next.scene_node.?.previous = node.previous;
        if (self.root == value) {
            self.root = null;
            self.layout_pending = false;
            if (self.attempt != null) self.cancelFrame();
        }
        self.removeToken(node.token);
        self.count -= 1;
        self.hook_count -= @intFromBool(node.hook_flags & ~@as(u32, api.OT_SCENE_HOOK_IDLE_UPDATE) != 0);
        self.layout_hook_count -= @intFromBool(node.hook_flags & scene_layout_hook_flags != 0);
        if (self.focus) |focused| {
            if (std.meta.eql(focused, node.handle)) self.focus = null;
        }
        self.visibility_epoch +%= 1;
        self.preparation_dirty = true;
        self.clearPreparation();
        const storage: native.NodeStorage = .{
            .node = value,
            .scene_node = node,
            .children = node.children,
            .paint_children = node.paint_children,
            .attention = node.skip.attention,
        };
        value.scene_node = null;
        node.* = undefined;
        return storage;
    }

    /// Before Session teardown, detach every edge once. Subsequent node releases
    /// are allocation-free and do not scan the registry or shift sibling arrays.
    pub fn detachAll(self: *Scene) void {
        self.cancelFrame();
        var cursor = self.head;
        while (cursor) |value| : (cursor = value.scene_node.?.next) {
            yoga.check(yoga.yogaNodeRemoveAllChildrenChecked(value.scene_node.?.childYoga(value))) catch unreachable;
            value.scene_node.?.parent = null;
            value.scene_node.?.placement = 0;
            value.scene_node.?.children.clearRetainingCapacity();
            value.scene_node.?.paint_children.clearRetainingCapacity();
            value.scene_node.?.skip.attention.clearRetainingCapacity();
            value.scene_node.?.skip.attention_index = no_slot;
            value.scene_node.?.skip.view_queued = false;
        }
        self.view_dirty.clearRetainingCapacity();
    }

    /// Even paint-only setters reject a node whose Yoga tree is laying out or poisoned.
    pub fn checkWritable(value: *const native.NativeRenderable) !void {
        try yoga.check(yoga.nodeTeardownStatus(value.yoga_node));
        var unused: u32 = 0;
        try yoga.check(yoga.yogaNodeIsDirtyChecked(value.yoga_node, &unused));
    }

    pub fn setPaintPartial(self: *Scene, value: *native.NativeRenderable, fields: u32, patch: Paint) !void {
        if (fields == 0 or fields & ~paint_fields_all != 0) return error.InvalidOptions;
        if (fields & api.OT_SCENE_PROPERTY_BACKGROUND != 0) try buffer.validateColor(patch.background);
        if (fields & api.OT_SCENE_PROPERTY_BORDER_COLOR != 0) try buffer.validateColor(patch.borderColor);
        if (fields & api.OT_SCENE_PROPERTY_FOCUSED_BORDER_COLOR != 0) try buffer.validateColor(patch.focusedBorderColor);
        if ((fields & api.OT_SCENE_PROPERTY_OPACITY != 0 and (!std.math.isFinite(patch.opacity) or patch.opacity < 0 or patch.opacity > 1)) or
            (fields & api.OT_SCENE_PROPERTY_TRANSLATE_X != 0 and !(@abs(patch.translateX) <= std.math.floatMax(f32))) or
            (fields & api.OT_SCENE_PROPERTY_TRANSLATE_Y != 0 and !(@abs(patch.translateY) <= std.math.floatMax(f32))) or
            (fields & api.OT_SCENE_PROPERTY_BORDER != 0 and patch.borderSides > api.OT_BORDER_ALL) or
            (fields & api.OT_SCENE_PROPERTY_SHOULD_FILL != 0 and patch.shouldFill > 1) or
            (fields & api.OT_SCENE_PROPERTY_BORDER_STYLE != 0 and patch.borderStyle > api.OT_BORDER_HEAVY))
        {
            return error.InvalidOptions;
        }
        const node = value.scene_node.?;
        var paint = patch;
        if (fields != paint_fields_all) {
            paint = node.paint;
            inline for (paint_fields, 0..) |name, index| {
                if (fields & (@as(u32, 1) << index) != 0) @field(paint, name) = @field(patch, name);
            }
        }
        if (node.kind != api.OT_SCENE_BOX and paint.borderSides != api.OT_BORDER_NONE) return error.InvalidOptions;
        try checkWritable(value);
        if (node.paint.borderSides != paint.borderSides) {
            // Only the final copy publishes; rejected preparation changes scratch style alone.
            try yoga.check(yoga.yogaNodeCopyStyleChecked(self.style_node, value.yoga_node));
            for ([_]u32{ api.OT_BORDER_LEFT, api.OT_BORDER_TOP, api.OT_BORDER_RIGHT, api.OT_BORDER_BOTTOM }, api.OT_EDGE_LEFT..) |side, edge| {
                try yoga.check(yoga.yogaNodeStyleSetBorderChecked(self.style_node, @intCast(edge), if (paint.borderSides & side != 0) 1 else 0));
            }
            try yoga.check(yoga.yogaNodeCopyStyleChecked(value.yoga_node, self.style_node));
        }
        if (node.paint.zIndex != paint.zIndex) {
            if (node.parent) |parent| self.orderChanged(parent);
        }
        if (node.paint.translateX != paint.translateX or node.paint.translateY != paint.translateY) {
            self.selection_epoch +%= 1;
            // Refresh newly revealed descendants before paint: feedback may have skipped their
            // culling parent, and nothing else reaches it in this frame.
            if (self.attempt != null and self.filter_count != 0) self.preparation_dirty = true;
        }
        if (self.attempt != null or node.paint.zIndex != paint.zIndex or
            node.paint.opacity != paint.opacity or node.paint.translateX != paint.translateX or
            node.paint.translateY != paint.translateY or node.paint.borderSides != paint.borderSides)
        {
            self.clearPreparation();
        }
        if (!std.meta.eql(node.paint, paint)) node.paint_epoch = nextPaintEpoch();
        node.paint = paint;
    }

    pub fn setBoxDetails(self: *Scene, value: *native.NativeRenderable, options: BoxDetails) !void {
        const node = value.scene_node.?;
        std.debug.assert(node.owner == self);
        if (node.kind != api.OT_SCENE_BOX) return error.WrongKind;
        if (options.title_alignment > 2 or options.bottom_title_alignment > 2) return error.InvalidOptions;
        if (options.title_color) |rgba| try buffer.validateColor(rgba);
        try buffer.validateTextInput(options.title);
        try buffer.validateTextInput(options.bottom_title);
        if (options.custom_border_chars) |chars| {
            for (chars) |char| {
                if (char < 0x20 or (char >= 0x7f and char <= 0x9f) or
                    char > 0x10ffff or (char >= 0xd800 and char <= 0xdfff)) return error.InvalidUnicode;
                if (utf8.eastAsianWidth(@intCast(char)) != 1) return error.InvalidUnicode;
            }
        }
        try checkWritable(value);
        var replacement: ?*BoxDetails = null;
        if (options.title.len != 0 or options.bottom_title.len != 0 or options.title_color != null or
            options.custom_border_chars != null or options.title_alignment != 0 or options.bottom_title_alignment != 0)
        {
            const details = try self.allocator.create(BoxDetails);
            errdefer self.allocator.destroy(details);
            details.* = options;
            details.title = try self.allocator.dupe(u8, options.title);
            errdefer self.allocator.free(details.title);
            details.bottom_title = try self.allocator.dupe(u8, options.bottom_title);
            replacement = details;
        }
        if (node.control.box) |previous| previous.destroy(self.allocator);
        node.control.box = replacement;
    }

    pub fn setHooks(self: *Scene, value: *native.NativeRenderable, flags: u32, generation: u64, initial_width: f64, initial_height: f64) !void {
        const node = value.scene_node.?;
        if (flags & ~scene_hook_flags_all != 0 or generation == 0 or
            flags & (api.OT_SCENE_HOOK_UPDATE | api.OT_SCENE_HOOK_IDLE_UPDATE) == api.OT_SCENE_HOOK_UPDATE | api.OT_SCENE_HOOK_IDLE_UPDATE or
            (flags & scene_paint_hook_flags != 0 and node.kind == api.OT_SCENE_ROOT) or
            (flags & api.OT_SCENE_HOOK_LAYOUT_CHANGED != 0 and node.kind != api.OT_SCENE_ROOT) or
            (flags & api.OT_SCENE_HOOK_SCROLL != 0 and node.scroll == null)) return error.InvalidOptions;
        for ([_]f64{ initial_width, initial_height }) |dimension| {
            if (!std.math.isFinite(dimension) or dimension < 0 or dimension > std.math.maxInt(i32)) return error.InvalidDimensions;
        }
        if (generation <= node.hook_generation) return error.StaleFrame;
        if (node.observed_frame == 0) {
            if (node.kind == api.OT_SCENE_SLIDER) _ = try sliderThumb(node.control.slider, initial_width, initial_height);
            node.resize_width = initial_width;
            node.resize_height = initial_height;
        }
        // Today's walk stamped an idle-update node it passed shown, so UPDATE given in this frame
        // waits for the next one.
        const stamped = flags & api.OT_SCENE_HOOK_UPDATE != 0 and node.hook_flags & api.OT_SCENE_HOOK_IDLE_UPDATE != 0 and
            node.prepared_gen == self.candidates_gen and node.layout_flags.prepared_visible and self.passedThisFrame(value);
        self.hook_count -= @intFromBool(node.hook_flags & ~@as(u32, api.OT_SCENE_HOOK_IDLE_UPDATE) != 0);
        self.hook_count += @intFromBool(flags & ~@as(u32, api.OT_SCENE_HOOK_IDLE_UPDATE) != 0);
        self.layout_hook_count -= @intFromBool(node.hook_flags & scene_layout_hook_flags != 0);
        self.layout_hook_count += @intFromBool(flags & scene_layout_hook_flags != 0);
        // A new listener hears changes from now on, not the ones nobody heard.
        if (flags & ~node.hook_flags & api.OT_SCENE_HOOK_SCROLL != 0) node.scroll.?.reported = node.scroll.?.observed();
        const updates = [2]bool{ node.hook_flags & api.OT_SCENE_HOOK_UPDATE != 0, flags & api.OT_SCENE_HOOK_UPDATE != 0 };
        if (updates[0] and !updates[1]) countBelow(value, 1, 0, false);
        if (updates[1] and !updates[0]) countBelow(value, 1, 0, true);
        if (stamped) node.update_frame = self.attempt.?.frame_id;
        node.hook_flags = flags;
        node.hook_generation = generation;
        self.invalidateObservation(value);
    }

    pub fn setScroll(self: *Scene, config: *yoga.Config, value: *native.NativeRenderable, options: ScrollOptions) !void {
        const node = value.scene_node.?;
        if (node.kind != api.OT_SCENE_BOX) return error.WrongKind;
        if (options.axes > api.OT_SCENE_SCROLL_X | api.OT_SCENE_SCROLL_Y or options.follow > api.OT_SCENE_SCROLL_FOLLOW_RIGHT) return error.InvalidOptions;
        for (options.padding) |padding| {
            if (!(padding >= 0 and padding <= 65535) or @trunc(padding) != padding) return error.InvalidOptions;
        }
        for (options.fills) |fill| if (fill) |rgba| try buffer.validateColor(rgba);
        for (options.bars) |bar| {
            if (bar.policy > api.OT_SCENE_SCROLL_BAR_NEVER or bar.thickness == 0 or bar.thickness > 255 or bar.gap > 255) return error.InvalidOptions;
            try buffer.validateColor(bar.foreground);
            try buffer.validateColor(bar.background);
        }
        try checkWritable(value);
        if (node.viewport != null or (node.scroll == null and node.children.items.len != 0)) return error.InvalidOptions;
        const state = node.scroll orelse blk: {
            const created = try self.allocator.create(ScrollState);
            errdefer self.allocator.destroy(created);
            const viewport_node = try config.createNode();
            errdefer yoga.yogaNodeFree(viewport_node);
            const content_node = try config.createNode();
            errdefer yoga.yogaNodeFree(content_node);
            for ([_]struct { yoga.YGNodeRef, u32, u32 }{
                .{ viewport_node, api.OT_STYLE_ENUM_OVERFLOW, api.OT_OVERFLOW_HIDDEN },
                .{ content_node, api.OT_STYLE_ENUM_ALIGN_SELF, api.OT_ALIGN_FLEX_START },
            }) |entry| try yoga.check(yoga.yogaNodeStyleSetEnumChecked(entry[0], entry[1], entry[2]));
            try yoga.check(yoga.yogaNodeStyleSetFloatChecked(viewport_node, api.OT_STYLE_FLOAT_FLEX_GROW, 1));
            try yoga.check(yoga.yogaNodeStyleSetFloatChecked(viewport_node, api.OT_STYLE_FLOAT_FLEX_SHRINK, 1));
            for ([_]u32{ api.OT_STYLE_VALUE_MIN_WIDTH, api.OT_STYLE_VALUE_MIN_HEIGHT }) |kind| {
                try yoga.check(yoga.yogaNodeStyleSetValueChecked(content_node, kind, api.OT_EDGE_NONE, api.OT_UNIT_PERCENT, 100));
            }
            try yoga.check(yoga.yogaNodeInsertChildChecked(viewport_node, content_node, 0));
            try yoga.check(yoga.yogaNodeInsertChildChecked(value.yoga_node, viewport_node, 0));
            // Inverted axes write both content size limits below.
            created.* = .{ .viewport_node = viewport_node, .content_node = content_node, .options = .{ .axes = ~options.axes } };
            node.scroll = created;
            self.scroll_count += 1;
            break :blk created;
        };
        const previous = state.options;
        for ([_]u32{ api.OT_SCENE_SCROLL_X, api.OT_SCENE_SCROLL_Y }, [_]u32{ api.OT_STYLE_VALUE_MAX_WIDTH, api.OT_STYLE_VALUE_MAX_HEIGHT }) |axis, kind| {
            if ((previous.axes ^ options.axes) & axis == 0) continue;
            const scrolls = options.axes & axis != 0;
            try yoga.check(yoga.yogaNodeStyleSetValueChecked(state.content_node, kind, api.OT_EDGE_NONE, if (scrolls) api.OT_UNIT_UNDEFINED else api.OT_UNIT_PERCENT, if (scrolls) std.math.nan(f32) else 100));
        }
        for (options.padding, api.OT_EDGE_LEFT..) |padding, edge| {
            try yoga.check(yoga.yogaNodeStyleSetValueChecked(state.viewport_node, api.OT_STYLE_VALUE_PADDING, @intCast(edge), api.OT_UNIT_POINT, padding));
        }
        const filtered = node.filtersChildren();
        state.options = options;
        self.setFilters(value, filtered);
        // A changed policy applies now; the next solve corrects an auto bar's visibility.
        for (options.bars, previous.bars, &state.visible, state.max) |bar, old, *visible, max| {
            if (bar.policy != old.policy) visible.* = if (bar.policy == api.OT_SCENE_SCROLL_BAR_AUTO) max > 0 else bar.policy == api.OT_SCENE_SCROLL_BAR_ALWAYS;
        }
        _ = try state.applyGutters(value.yoga_node);
        if (previous.follow != options.follow) state.restick();
        state.generation += 1;
        self.invalidateObservation(value);
    }

    /// Binds or unbinds the viewport a box filters its children against.
    pub fn setViewport(self: *Scene, value: *native.NativeRenderable, viewport: ?handles.Handle) void {
        const node = value.scene_node.?;
        if (std.meta.eql(node.viewport, viewport)) return;
        const filtered = node.filtersChildren();
        node.viewport = viewport;
        self.setFilters(value, filtered);
        self.preparation_dirty = true;
        self.clearPreparation();
    }

    /// After a culling change, culled children may show: feedback visits the parent again.
    fn setFilters(self: *Scene, value: *native.NativeRenderable, filtered: bool) void {
        const filters = value.scene_node.?.filtersChildren();
        if (filters != filtered) {
            self.filter_count = self.filter_count + @intFromBool(filters) - @intFromBool(filtered);
            if (filters) countBelow(value, 0, 1, true) else countBelow(value, 0, 1, false);
            // Culled children the selection set aside need the list again.
            if (!filters) for (value.scene_node.?.children.items) |child| attend(child);
        }
        self.selection_epoch +%= 1;
        self.markSubtree(value);
    }

    pub fn setScrollArrow(self: *Scene, value: *native.NativeRenderable, axis: u32, end: u32, options: ArrowOptions) !void {
        const state = value.scene_node.?.scroll orelse return error.WrongKind;
        if (axis > 1 or end > 1 or options.direction != 0) return error.InvalidOptions;
        try checkWritable(value);
        var replacement = options;
        if (options.text) |text| replacement.text = try self.allocator.dupe(u8, text);
        state.arrows[axis][end].deinit(self.allocator);
        state.arrows[axis][end] = replacement;
        self.clearPreparation();
    }

    /// An explicit scroll: moves the offset in whole cells within the last solve's limits and
    /// recomputes stuck.
    pub fn scrollTo(self: *Scene, value: *native.NativeRenderable, target: [2]f64, relative: [2]bool) !void {
        const node = value.scene_node.?;
        const state = node.scroll orelse return error.WrongKind;
        for (target) |coordinate| if (std.math.isNan(coordinate)) return error.InvalidOptions;
        try checkWritable(value);
        const before = .{ state.offset, state.stuck };
        for (0..2) |axis| {
            const position = if (relative[axis]) state.offset[axis] + target[axis] else target[axis];
            state.offset[axis] = std.math.clamp(@floor(position + 0.5), 0, state.max[axis]);
        }
        state.restick();
        // The host knows the offset it wrote, not a size change it has not been told of.
        @memcpy(state.reported[0..2], &state.offset);
        if (std.meta.eql(before, .{ state.offset, state.stuck })) return;
        state.generation += 1;
        if (std.meta.eql(before[0], state.offset)) return;
        node.paint_epoch = nextPaintEpoch();
        self.selection_epoch +%= 1;
        // Children move; in an attempt the next round prepares and culls at the new offset.
        self.preparation_dirty = true;
        self.clearPreparation();
    }

    /// After a solve: read the hidden nodes, follow the stuck edge, clamp, and toggle bars.
    fn resolveScroll(self: *Scene, value: *native.NativeRenderable, state: *ScrollState) !void {
        var viewport: yoga.ExternalYogaLayout = undefined;
        var content: yoga.ExternalYogaLayout = undefined;
        self.frame_work.geometry_reads += 2;
        try yoga.check(yoga.yogaNodeGetComputedLayoutChecked(state.viewport_node, &viewport));
        try yoga.check(yoga.yogaNodeGetComputedLayoutChecked(state.content_node, &content));
        const before = .{ state.offset, state.max, state.extent, state.viewport, state.content_origin, state.visible };
        state.viewport = .{ .left = viewport.left, .top = viewport.top, .width = viewport.width, .height = viewport.height };
        state.content_origin = .{ viewport.left + content.left, viewport.top + content.top };
        state.extent = .{ content.width, content.height };
        const sizes = [2]f32{ viewport.width, viewport.height };
        for (0..2) |axis| {
            const range = @as(f64, state.extent[axis]) - (sizes[axis] - state.options.padding[axis] - state.options.padding[axis + 2]);
            // NaN and negative ranges have nothing to scroll; huge ones stay within exact integers.
            state.max[axis] = if (state.options.axes & (@as(u32, 1) << @intCast(axis)) != 0 and range > 0) @min(@ceil(range), std.math.maxInt(i32)) else 0;
        }
        // A stuck view moves only when its range changed, so a solve elsewhere keeps a reader
        // who scrolled within a noise range where they are.
        const moved = !std.meta.eql(.{ before[1], before[2], before[3] }, .{ state.max, state.extent, state.viewport });
        if (state.followAxis()) |axis| {
            if (state.stuck and moved) state.offset[axis] = state.followEdge(axis);
        }
        for (0..2) |axis| state.offset[axis] = std.math.clamp(state.offset[axis], 0, state.max[axis]);
        const frame_id = self.attempt.?.frame_id;
        if (state.toggle_frame != frame_id) {
            state.toggle_frame = frame_id;
            state.toggles = 0;
        }
        var toggled = false;
        for (state.options.bars, &state.visible, state.max) |bar, *visible, max| {
            const wanted = switch (bar.policy) {
                api.OT_SCENE_SCROLL_BAR_AUTO => max > 0,
                else => bar.policy == api.OT_SCENE_SCROLL_BAR_ALWAYS,
            };
            // Past two toggles a bar may still appear but not hide, so wrapping content cannot oscillate.
            if (wanted == visible.* or (state.toggles >= 2 and !wanted)) continue;
            visible.* = wanted;
            state.toggles += 1;
            toggled = true;
        }
        // An overlay bar's toggle changes no layout.
        if (toggled and try state.applyGutters(value.yoga_node)) self.scroll_toggled = true;
        if (!std.meta.eql(before, .{ state.offset, state.max, state.extent, state.viewport, state.content_origin, state.visible })) {
            state.generation += 1;
            value.scene_node.?.paint_epoch = nextPaintEpoch();
        }
        // An owed SCROLL request keeps the node's feedback due.
        if (value.scene_node.?.hook_flags & api.OT_SCENE_HOOK_SCROLL != 0 and !std.meta.eql(state.observed(), state.reported)) markObservationStale(value);
    }

    /// The node's next refresh may differ although its layout did not change, so feedback
    /// visits it again. Outside an attempt, a frame that keeps its lists prepares its view.
    pub fn markObservationStale(value: *native.NativeRenderable) void {
        const node = value.scene_node orelse return;
        const owner = node.owner;
        node.skip.self_stale = true;
        if (node.parent) |parent| parent.scene_node.?.skip.refresh_due = true;
        owner.markSubtree(value);
        if (owner.attempt != null or node.skip.view_queued) return;
        node.skip.view_queued = true;
        owner.view_dirty.appendAssumeCapacity(value);
    }

    pub fn invalidateObservation(self: *Scene, value: *native.NativeRenderable) void {
        self.preparation_dirty = true;
        self.clearPreparation();
        markObservationStale(value);
    }

    pub fn clearPreparation(self: *Scene) void {
        self.candidates.clearRetainingCapacity();
        self.members.clearRetainingCapacity();
    }

    pub fn cancelFrame(self: *Scene) void {
        if (self.painted != null) self.cancelled_paint = true;
        self.endAttempt();
        self.clearPreparation();
    }

    fn endAttempt(self: *Scene) void {
        self.painted = null;
        self.attempt = null;
        self.feedback.clearRetainingCapacity();
        self.marked.clearRetainingCapacity();
        self.remarked.clearRetainingCapacity();
        self.paint_members.clearRetainingCapacity();
        self.paint_slots.clearRetainingCapacity();
        self.segments.clearRetainingCapacity();
    }

    pub fn checkPainted(self: *Scene, ticket: FrameRequest) error{ WrongContext, WrongSession, StaleFrame }!*Painted {
        if (ticket.session.context_id != self.session.context_id) return error.WrongContext;
        if (!std.meta.eql(ticket.session, self.session)) return error.WrongSession;
        const painted = if (self.painted) |*value| value else return error.StaleFrame;
        if (!std.meta.eql(ticket, painted.ticket)) return error.StaleFrame;
        return painted;
    }

    /// The exact pending RECORD request exposes its slots until acknowledgement or cancellation.
    pub fn paintSlots(self: *Scene, ticket: FrameRequest) error{ WrongContext, WrongSession, StaleFrame }![]const PaintSlot {
        if (ticket.session.context_id != self.session.context_id) return error.WrongContext;
        if (!std.meta.eql(ticket.session, self.session)) return error.WrongSession;
        const pending = (self.attempt orelse return error.StaleFrame).pending orelse return error.StaleFrame;
        if (!std.meta.eql(ticket, pending) or ticket.kind != api.OT_SCENE_FRAME_RECORD) return error.StaleFrame;
        return self.paint_slots.items;
    }

    fn forcesFullFrame(self: *const Scene) bool {
        return self.debug_flags & api.OT_SCENE_DEBUG_FULL_FRAME != 0;
    }

    pub fn requalifyPainted(self: *Scene, cli: *renderer.CliRenderer) void {
        if (self.painted) |*painted| painted.destination = BufferIdentity.init(cli.getNextBuffer());
    }

    fn verifiesRetained(self: *const Scene) bool {
        return self.debug_flags & api.OT_SCENE_DEBUG_VERIFY != 0;
    }

    /// Limits stay fixed; paint options can change on a checked acknowledgement.
    /// Validate the complete ticket before resolving any ticket node or consuming work.
    /// recording acknowledges a RECORD request and must be null for every other step.
    pub fn frameStep(self: *Scene, owner: *Context, cli: *renderer.CliRenderer, previous: ?FrameRequest, options: FrameOptions, allow_host: bool, recording: ?[]const u8) !FrameRequest {
        const objects = &owner.objects;
        errdefer self.clearPreparation();
        try buffer.validateColor(options.background);
        // Reject before solving: a rejected one-call paint must not consume layout notifications.
        if (!allow_host and self.hook_count != 0) return error.UnsupportedResource;
        if (previous) |reply| {
            if (reply.session.context_id != self.session.context_id) return error.WrongContext;
            if (!std.meta.eql(reply.session, self.session)) return error.WrongSession;
            const active = self.attempt orelse return error.StaleFrame;
            // Every step that leaves an attempt returns its pending request.
            if (!std.meta.eql(reply, active.pending.?)) return error.StaleFrame;
            if (options.max_layout_rounds != active.options.max_layout_rounds or
                options.max_host_requests != active.options.max_host_requests or
                (reply.kind == api.OT_SCENE_FRAME_RECORD) != (recording != null)) return error.InvalidOptions;
            self.attempt.?.options = options;
            self.attempt.?.pending = null;
        } else {
            if (self.attempt != null or self.painted != null) return error.FrameBusy;
            // Every attempt ends in cancelFrame, so no attempt state survives into the next one.
            std.debug.assert(self.feedback.items.len == 0);
            std.debug.assert(self.paint_members.items.len == 0 and self.paint_slots.items.len == 0 and self.segments.items.len == 0);
            if (options.max_layout_rounds == 0 or options.max_host_requests == 0 or recording != null) return error.InvalidOptions;
            const frame_id = std.math.add(u64, self.last_frame_id, 1) catch return error.RequestLimit;
            self.attempt = .{
                .root = if (self.root) |root| root.scene_node.?.handle else std.mem.zeroes(handles.Handle),
                .frame_id = frame_id,
                .options = options,
            };
            self.frame_work = .{
                .work_frame_id = frame_id,
                .full_path_reasons = if (self.forcesFullFrame()) renderer.FrameWork.full_path_forced else 0,
            };
            self.last_frame_id = frame_id;
            self.retryFailedMeasures();
        }
        errdefer {
            self.releaseEditorCursor(cli);
            self.cancelFrame();
            // A failed frame is never retained, and keeps the reasons it consumed.
            cli.taint(renderer.FrameWork.full_path_unretained);
        }
        const active = &self.attempt.?;
        const root = if (active.root.context_id != 0) blk: {
            const value = objects.get(active.root, .native_renderable, native.NativeRenderable) catch return error.StaleFrame;
            if (self.root != value or value.scene_node == null or value.scene_node.?.owner != self) return error.StaleFrame;
            break :blk value;
        } else null;
        if (recording) |bytes| return self.paintRecorded(owner, cli, root, bytes);
        if (active.rounds == 0) try self.prepareRound(objects, cli, root);
        while (true) {
            if (self.layout_pending) {
                if (root) |value| {
                    if (value.scene_node.?.hook_flags & api.OT_SCENE_HOOK_LAYOUT_CHANGED != 0 and try self.isVisibleMember(value)) {
                        const result = try self.request(value.scene_node.?, api.OT_SCENE_FRAME_LAYOUT_CHANGED);
                        self.layout_pending = false;
                        return result;
                    }
                }
                self.layout_pending = false;
            }
            // No host call or scene mutation intervenes while this proof is reused.
            var visible_member: ?*native.NativeRenderable = null;
            const full = self.forcesFullFrame();
            while (self.feedback.items.len != 0) {
                const operation = self.feedback.pop().?;
                self.frame_work.feedback_operations += 1;
                if (operation.kind == .filtered_refresh) self.frame_work.viewport_child_refreshes += 1;
                const value = objects.get(operation.node, .native_renderable, native.NativeRenderable) catch continue;
                if (value.scene_node == null or value.scene_node.?.owner != self) continue;
                const node = value.scene_node.?;
                if (operation.kind == .update) node.setFeedback(active, .unseen);
                if (operation.kind == .done and node.pass.frame == active.frame_id) {
                    node.pass.cursor = @max(node.pass.cursor, node.pass.limit);
                    node.pass.finished = true;
                }
                const member = if (operation.kind == .filtered_refresh) blk: {
                    const parent = node.parent orelse continue;
                    if (!std.meta.eql(parent.scene_node.?.handle, operation.parent.?)) continue;
                    break :blk parent;
                } else if (operation.kind == .placed) blk: {
                    if (node.placement != operation.placement) continue;
                    break :blk node.parent orelse continue;
                } else value;
                if (operation.parent) |handle| {
                    // A child its destroyed parent left is never visible.
                    const parent = node.parent orelse continue;
                    if (!std.meta.eql(parent.scene_node.?.handle, handle)) continue;
                    // A dropped entry issues no request, so the next pop moves the cursor before any reply.
                    if (operation.kind == .update) parent.scene_node.?.pass.cursor = @max(parent.scene_node.?.pass.cursor, operation.rank);
                }
                if (member != visible_member) {
                    if (!try self.isVisibleMember(member)) continue;
                    visible_member = member;
                }
                var result: ?FrameRequest = null;
                switch (operation.kind) {
                    .update => {
                        // A child that needed nothing when FULL_FRAME queued it, but that a reply
                        // marked since, waits for the later pass the mark starts, as in a normal frame.
                        if (!operation.needed and node.skip.subtree != .clean) continue;
                        node.setFeedback(active, .started);
                        // Today's walk would issue no request below.
                        if (!full and !self.mustVisit(node)) continue;
                        node.skip.subtree = .running;
                        node.culling.clean_selection = self.selection_epoch;
                        self.feedback.appendAssumeCapacity(.{ .node = node.handle, .kind = .done });
                        self.feedback.appendAssumeCapacity(.{ .node = node.handle, .kind = .children });
                        self.feedback.appendAssumeCapacity(.{ .node = node.handle, .kind = .prepass });
                        if (node.hook_flags & api.OT_SCENE_HOOK_SCROLL != 0) self.feedback.appendAssumeCapacity(.{ .node = node.handle, .kind = .scroll });
                        self.feedback.appendAssumeCapacity(.{ .node = node.handle, .kind = .refresh });
                        if (node.hook_flags & (api.OT_SCENE_HOOK_UPDATE | api.OT_SCENE_HOOK_IDLE_UPDATE) != 0 and node.update_frame != active.frame_id) {
                            if (node.hook_flags & api.OT_SCENE_HOOK_UPDATE != 0) result = try self.request(node, api.OT_SCENE_FRAME_UPDATE);
                            node.update_frame = active.frame_id;
                        }
                    },
                    // A mark during the visit keeps the subtree stale for the next round.
                    .done => if (node.skip.subtree == .running and !node.skip.self_stale and !node.sort_dirty) {
                        node.skip.subtree = .clean;
                    } else if (node.sort_dirty) {
                        // An order frozen for this frame sorts in the next: keep the path to it due.
                        self.markSubtree(value);
                    },
                    .refresh, .placed, .filtered_refresh => {
                        if (operation.kind != .placed and !node.skip.self_stale and !full) continue;
                        result = try self.refresh(value, member != value);
                        if (operation.kind == .placed) node.placement = 0;
                    },
                    .scroll => {
                        // After the node's own refresh, so a reply reads this round's layout.
                        const state = node.scroll.?;
                        const current = state.observed();
                        if (!std.meta.eql(current, state.reported)) {
                            state.changes = 0;
                            for (current, state.reported, [_]u32{ api.OT_SCENE_SCROLL_CHANGED_OFFSET_X, api.OT_SCENE_SCROLL_CHANGED_OFFSET_Y, api.OT_SCENE_SCROLL_CHANGED_CONTENT, api.OT_SCENE_SCROLL_CHANGED_CONTENT, api.OT_SCENE_SCROLL_CHANGED_VIEWPORT, api.OT_SCENE_SCROLL_CHANGED_VIEWPORT }) |now, was, bit| {
                                if (now != was) state.changes |= bit;
                            }
                            state.reported = current;
                            result = try self.request(node, api.OT_SCENE_FRAME_SCROLL);
                        }
                    },
                    .prepass => {
                        // A resize callback can append to the live placement Set.
                        self.feedback.appendAssumeCapacity(.{ .node = operation.node, .kind = .prepass, .placement = 1 });
                        const start = self.feedback.items.len;
                        // Placed children are marked, so the attention list holds them. Children
                        // that no longer need feedback leave it here; none regains need before
                        // the parent selects.
                        // A later pass scans the children replies marked; others prune the list.
                        const later = !full and self.laterScan(node);
                        const marked = if (later) self.scanList(objects, node) else &.{};
                        const children = if (full) &node.children else &node.skip.attention;
                        var index: usize = 0;
                        while (index < if (later) marked.len else children.items.len) {
                            if (builtin.is_test) self.test_feedback_child_steps += 1;
                            const state = (if (later) marked else children.items)[index].scene_node.?;
                            if (!full and !later and !needsFeedback(state)) {
                                dropAttention(node, index);
                                continue;
                            }
                            index += 1;
                            if (state.prepared_gen != self.candidates_gen) continue;
                            if (state.placement != 0) self.feedback.appendAssumeCapacity(.{
                                .node = state.handle,
                                .kind = .placed,
                                .placement = state.placement,
                            });
                        }
                        if (self.feedback.items.len == start) {
                            _ = self.feedback.pop();
                        } else {
                            // LIFO preserves the legacy new-child Set's insertion order.
                            self.orderBatch(self.feedback.items[start..], .placement);
                        }
                    },
                    .children => {
                        // Capture child order after the parent's callbacks, never midway through siblings.
                        // The lists hold the old order, so the next frame prepares again.
                        if (sortChildren(node, active.frame_id)) self.clearPreparation();
                        if (!node.filtersChildren()) {
                            try self.selectChildren(objects, value);
                            continue;
                        }
                        // Refresh every stale child, culled ones too, before selecting a fixed update batch.
                        self.feedback.appendAssumeCapacity(.{ .node = node.handle, .kind = .select });
                        const start = self.feedback.items.len;
                        const due = full or node.skip.refresh_due;
                        node.skip.refresh_due = false;
                        for (if (due) (if (full) node.paint_children.items else self.scanList(objects, node)) else &.{}) |child| {
                            if (builtin.is_test) self.test_feedback_child_steps += 1;
                            const state = child.scene_node.?;
                            if (state.prepared_gen != self.candidates_gen or !(full or state.skip.self_stale)) continue;
                            self.feedback.appendAssumeCapacity(.{ .node = state.handle, .kind = .filtered_refresh, .parent = node.handle, .rank = state.paint_rank });
                        }
                        self.orderBatch(self.feedback.items[start..], .rank);
                    },
                    .select => try self.selectChildren(objects, value),
                }
                if (result) |request_value| return request_value;
            }
            // A reply marked nodes the pass may not reach again: feedback runs again on this
            // round's layout, before any new round, so the round count stays today's.
            if (active.followup) {
                self.startLaterPass(objects, root.?);
                continue;
            }
            if (self.preparation_dirty or try self.needsSolve(cli, root)) {
                try self.prepareRound(objects, cli, root);
                continue;
            }
            if (self.members.items.len == 0) try self.prepareMembers(objects, cli, root);
            if (self.verifiesRetained()) try self.verifyObservations();
            if (self.hook_count != 0) {
                for (self.members.items) |entry| {
                    if (entry.node.scene_node.?.kind != api.OT_SCENE_ROOT and !entry.bars and
                        entry.node.scene_node.?.hook_flags & scene_paint_hook_flags != 0) return self.requestRecord(cli, root.?);
                }
            }
            try self.markFocus(objects);
            return self.paintPlanned(owner, cli, null, false);
        }
    }

    /// Paints the frame, keeps the presented frame's cells, or diffs only the damaged rows.
    fn paintPlanned(self: *Scene, owner: *Context, cli: *renderer.CliRenderer, recording: ?[]const u8, refresh_views: bool) !FrameRequest {
        const options = self.attempt.?.options;
        const damage, const cursor = try self.planPaint(owner, cli, options, recording, refresh_views);
        const verify = damage != .all and self.verifiesRetained();
        // Next still holds the presented frame, unless a lease may have written current.
        if (verify and !cli.current_written) try self.verifyRows(cli.getNextBuffer(), cli.getCurrentBuffer(), false);
        if (damage == .none) {
            try self.skipPaint(cli);
            if (verify) try self.verifyRepaint(owner, cli, options, recording, refresh_views);
        } else {
            try self.paintFrame(owner, cli, options, recording, refresh_views, self.band_count != 0);
            if (verify and !cli.current_written) try self.verifyRows(cli.getNextBuffer(), cli.getCurrentBuffer(), true);
            if (verify) try self.verifyRepaint(owner, cli, options, recording, refresh_views);
        }
        // The focused editor among the members owns the cursor, wherever it paints.
        self.maintainCursor(cli, cursor);
        return self.finishPaint(cli, damage);
    }

    /// Queues the children that need feedback in paint order. A filtering parent tests overlap
    /// only after the selection changed, and sets aside culled children only a stale subtree lists.
    fn selectChildren(self: *Scene, objects: *const handles.Table, value: *native.NativeRenderable) !void {
        const node = value.scene_node.?;
        const active = &self.attempt.?;
        const full = self.forcesFullFrame();
        const filter = try self.childFilter(objects, value);
        const children = node.paint_children.items;
        const listed = self.scanList(objects, node);
        if (node.pass.frame != active.frame_id) node.pass = .{ .frame = active.frame_id, .moved_frame = node.pass.moved_frame };
        node.pass.limit = if (children.len == 0) node.pass.limit else children[children.len - 1].scene_node.?.paint_rank + 1;
        const rescans = full or (node.filtersChildren() and node.culling.selected_epoch != self.selection_epoch);
        if (rescans) node.culling.selected_epoch = self.selection_epoch;
        node.pass.culls = filter != null;
        if (node.pass.culls and node.pass.epoch == 0) node.pass.epoch = node.culling.selected_epoch;
        if (rescans) {
            const origin = if (filter != null) childOrigin(node, try composedLayout(value, false)) else [2]f64{ 0, 0 };
            var index = node.paint_children.items.len;
            while (index != 0) {
                index -= 1;
                if (builtin.is_test) self.test_feedback_child_steps += 1;
                const child = node.paint_children.items[index];
                const state = child.scene_node.?;
                if (state.prepared_gen != self.candidates_gen) {
                    try self.deferChild(value, child);
                    continue;
                }
                if (filter) |bounds| {
                    var layout = state.layout;
                    layout.screenX = origin[0] + @as(f64, layout.left) + state.paint.translateX;
                    layout.screenY = origin[1] + @as(f64, layout.top) + state.paint.translateY;
                    self.frame_work.overlap_tests += 1;
                    if (!overlaps(bounds, layout)) {
                        // Only its subtree's state keeps it listed; any change lists it again.
                        if (!full and state.skip.attention_index != no_slot and state.skip.update_below == 0 and state.skip.filters_below == 0 and
                            !state.skip.self_stale and state.placement == 0) dropAttention(node, state.skip.attention_index);
                        continue;
                    }
                }
                state.culling.selected_at = node.culling.selected_epoch;
                if (state.feedback(active) != .unseen) continue;
                const needed = self.mustVisit(state);
                if (full or needed) self.queueUpdate(node, state, needed);
            }
            return;
        }
        const start = self.feedback.items.len;
        for (listed) |child| {
            if (builtin.is_test) self.test_feedback_child_steps += 1;
            const state = child.scene_node.?;
            if (!needsFeedback(state)) continue;
            if (state.prepared_gen != self.candidates_gen) {
                try self.deferChild(value, child);
                continue;
            }
            if (state.feedback(active) != .unseen or !self.mustVisit(state)) continue;
            if (filter != null and state.culling.selected_at != node.culling.selected_epoch) continue;
            self.queueUpdate(node, state, true);
        }
        self.orderBatch(self.feedback.items[start..], .rank);
    }

    /// A shown child that the next round's walk lists keeps its parent's subtree from cleaning,
    /// so that round visits it. A hidden one waits for the display change that shows it.
    fn deferChild(self: *Scene, parent: *native.NativeRenderable, child: *native.NativeRenderable) !void {
        if (!needsFeedback(child.scene_node.?)) return;
        var display: u32 = 0;
        try yoga.check(yoga.yogaNodeStyleGetEnumChecked(child.yoga_node, api.OT_STYLE_ENUM_DISPLAY, &display));
        if (display != api.OT_DISPLAY_NONE) self.markSubtree(parent);
    }

    /// Orders a batch so its lowest key pops first (LIFO). A batch picked in key order, as an
    /// unpruned attention list gives it, only reverses; sorting counts in test_sort_steps.
    fn orderBatch(self: *Scene, batch: []Feedback, comptime key: BatchKey) void {
        if (batch.len < 2) return;
        for (batch[1..], batch[0 .. batch.len - 1]) |next, previous| {
            if (batchKey(next, key) < batchKey(previous, key)) break;
        } else return std.mem.reverse(Feedback, batch);
        std.mem.sort(Feedback, batch, self, keyGreaterThan(key));
    }

    fn queueUpdate(self: *Scene, parent: *const Node, state: *Node, needed: bool) void {
        self.feedback.appendAssumeCapacity(.{ .node = state.handle, .kind = .update, .parent = parent.handle, .rank = state.paint_rank, .needed = needed });
        state.setFeedback(&self.attempt.?, .queued);
    }

    /// Builds the paint list from current accepted topology, including transforms accepted
    /// after preparation. Without hooks or filters it is the candidates' visible entries.
    fn prepareMembers(self: *Scene, objects: *const handles.Table, cli: *renderer.CliRenderer, root: ?*native.NativeRenderable) !void {
        self.members.clearRetainingCapacity();
        try self.members.ensureTotalCapacity(self.allocator, self.count + self.scroll_count);
        if (self.hook_count == 0 and self.filter_count == 0 and self.candidates.items.len != 0) {
            for (self.candidates.items) |entry| if (entry.visible) self.members.appendAssumeCapacity(entry);
        } else if (root) |value| try self.prepare(objects, value, cli.width, cli.height, .paint, false, &self.members);
        // Paint layout reports where this frame paints.
        for (self.members.items) |entry| {
            entry.node.scene_node.?.layout.screenX = entry.layout.screenX;
            entry.node.scene_node.?.layout.screenY = entry.layout.screenY;
        }
    }

    fn finishPaint(self: *Scene, cli: *renderer.CliRenderer, damage: Damage) FrameRequest {
        const active = self.attempt.?;
        std.debug.assert(self.painted == null);
        cli.retained_lost = 0;
        const done: FrameRequest = .{
            .session = self.session,
            .root = active.root,
            .node = active.root,
            .frame_id = active.frame_id,
            .request_id = 0,
            .layout_epoch = self.layout_epoch,
            .hook_generation = 0,
            .kind = 0,
            .num = 0,
            .width = 0,
            .height = 0,
        };
        // Every change to what the lists hold cleared them, so they match the accepted scene.
        if (active.walked) self.compactCandidates();
        self.endAttempt();
        self.cancelled_paint = false;
        self.frame_work.host_requests = active.requests;
        self.frame_work.layout_rounds = active.rounds;
        self.painted = .{
            .ticket = done,
            .destination = BufferIdentity.init(cli.getNextBuffer()),
            .work = self.frame_work,
            .damage = if (damage == .all) null else &self.damage,
        };
        return done;
    }

    /// Drops the hidden entries that a fresh walk no longer admits, so a kept list equals one.
    fn compactCandidates(self: *Scene) void {
        var kept: usize = 0;
        for (self.candidates.items) |entry| {
            const node = entry.node.scene_node.?;
            const filtered_child = if (node.parent) |parent| parent.scene_node.?.filtersChildren() else false;
            if (entry.visible or node.layout_flags.needs_layout or filtered_child) {
                self.candidates.items[kept] = entry;
                kept += 1;
            } else node.prepared_gen = 0;
        }
        self.candidates.items.len = kept;
    }

    fn request(self: *Scene, node: *Node, kind: u32) !FrameRequest {
        const active = &self.attempt.?;
        std.debug.assert(active.pending == null);
        std.debug.assert(kind >= api.OT_SCENE_FRAME_UPDATE and kind <= api.OT_SCENE_FRAME_SCROLL);
        // RECORD names the root without describing it.
        const whole_frame = kind == api.OT_SCENE_FRAME_RECORD;
        if (active.requests == active.options.max_host_requests) return error.FrameRequestLimit;
        active.requests += 1;
        active.request_id = std.math.add(u64, active.request_id, 1) catch return error.RequestLimit;
        const result: FrameRequest = .{
            .session = self.session,
            .root = active.root,
            .node = node.handle,
            .frame_id = active.frame_id,
            .request_id = active.request_id,
            .layout_epoch = self.layout_epoch,
            .hook_generation = if (whole_frame) 0 else node.hook_generation,
            .kind = kind,
            .num = if (whole_frame) 0 else node.num,
            .width = if (whole_frame) 0 else cellSize(node.layout.width),
            .height = if (whole_frame) 0 else cellSize(node.layout.height),
        };
        active.pending = result;
        return result;
    }

    fn refresh(self: *Scene, value: *native.NativeRenderable, check_display: bool) !?FrameRequest {
        const node = value.scene_node.?;
        const active = &self.attempt.?;
        // Once per round, unless a reply marked the node since.
        if (node.observed_frame == active.frame_id and node.observed_round == active.rounds and !node.skip.self_stale) return null;
        const changed = node.resize_width != node.layout.width or node.resize_height != node.layout.height;
        var visible = true;
        if (check_display and (node.text != null or node.editor != null or node.kind == api.OT_SCENE_TEXT_VIEW or (changed and node.hook_flags & api.OT_SCENE_HOOK_RESIZE != 0))) {
            // Placement and filtered refresh already checked the parent's membership.
            var display: u32 = 0;
            try yoga.check(yoga.yogaNodeStyleGetEnumChecked(value.yoga_node, api.OT_STYLE_ENUM_DISPLAY, &display));
            visible = display != api.OT_DISPLAY_NONE;
        }
        if (visible) try prepareView(&self.frame_work, node, node.layout);
        const result = if (changed and node.hook_flags & api.OT_SCENE_HOOK_RESIZE != 0 and visible)
            try self.request(node, api.OT_SCENE_FRAME_RESIZE)
        else
            null;
        node.observed_layout = node.layout;
        node.resize_width = node.layout.width;
        node.resize_height = node.layout.height;
        node.observed_frame = active.frame_id;
        node.observed_round = active.rounds;
        node.layout_flags.needs_layout = false;
        node.skip.self_stale = false;
        return result;
    }

    fn isVisibleMember(self: *Scene, value: *native.NativeRenderable) !bool {
        const node = value.scene_node.?;
        const active = self.attempt.?;
        // Preparation enters only visible nodes, so its stamp answers until a display or ancestry change.
        if (node.prepared_gen == self.candidates_gen and active.visibility_epoch == self.visibility_epoch and
            !self.forcesFullFrame()) return node.layout_flags.prepared_visible;
        var cursor: ?*native.NativeRenderable = value;
        var depth: u32 = 0;
        while (cursor) |current| : (cursor = current.scene_node.?.parent) {
            if (depth == yoga.depth_max) return error.YogaDepthLimit;
            depth += 1;
            self.frame_work.visibility_steps += 1;
            var display: u32 = 0;
            try yoga.check(yoga.yogaNodeStyleGetEnumChecked(current.yoga_node, api.OT_STYLE_ENUM_DISPLAY, &display));
            if (display == api.OT_DISPLAY_NONE) return false;
            if (current == self.root) return true;
        }
        return false;
    }

    fn needsSolve(self: *Scene, cli: *renderer.CliRenderer, root: ?*native.NativeRenderable) !bool {
        const value = root orelse return false;
        var dirty: u32 = 0;
        try yoga.check(yoga.yogaNodeIsDirtyChecked(value.yoga_node, &dirty));
        return dirty != 0 or self.layout_width != cli.width or self.layout_height != cli.height;
    }

    pub fn measureLayout(self: *Scene, objects: *const handles.Table, cli: *renderer.CliRenderer, root_handle: handles.Handle) !void {
        // Session.checkFrameIdle admits measurement only without an attempt or draft.
        std.debug.assert(self.attempt == null and self.painted == null);
        const root = try objects.get(root_handle, .native_renderable, native.NativeRenderable);
        const node = root.scene_node orelse return error.WrongKind;
        if (node.owner != self) return error.WrongSession;
        if (self.root != root) return error.InvalidOptions;
        self.retryFailedMeasures();
        try self.solveLayout(cli, root);
    }

    /// Runs before each frame attempt or measurement-only solve, never between rounds.
    /// Yoga keeps no failed size. A failed node is measured once more; if that fails too,
    /// it stays zero until Yoga asks for a new size. A pass without failure ends the retry.
    fn retryFailedMeasures(self: *Scene) void {
        if (!self.measure_failed) return;
        self.measure_failed = false;
        var cursor = self.head;
        while (cursor) |value| : (cursor = value.scene_node.?.next) {
            const node = value.scene_node.?;
            if (!node.measure_failed) {
                node.measure_retried = false;
                continue;
            }
            node.measure_failed = false;
            if (node.measure_retried) yoga.yogaNodeForgetMeasurements(value.yoga_node) else yoga.yogaNodeInvalidateMeasure(value.yoga_node);
            node.measure_retried = true;
            self.measure_failed = true;
        }
    }

    fn solveLayout(self: *Scene, cli: *renderer.CliRenderer, root: *native.NativeRenderable) !void {
        if (!try self.needsSolve(cli, root)) return;
        const epoch = std.math.add(u64, self.layout_epoch, 1) catch return error.RequestLimit;
        try yoga.check(yoga.yogaNodeCalculateLayoutChecked(root.yoga_node, @floatFromInt(cli.width), @floatFromInt(cli.height), 1));
        // A measurement outside a frame counts into work that the next attempt resets.
        self.frame_work.yoga_solves += 1;
        // Every solve, a measurement-only one too, invalidates the geometry nodes hold.
        self.layout_epoch = epoch;
        self.selection_epoch +%= 1;
        self.layout_width = cli.width;
        self.layout_height = cli.height;
        self.layout_pending = true;
    }

    fn prepareRound(self: *Scene, objects: *const handles.Table, cli: *renderer.CliRenderer, root: ?*native.NativeRenderable) !void {
        const active = &self.attempt.?;
        const phases = self.layout_hook_count != 0 or self.filter_count != 0;
        const root_node = if (root) |value| value.scene_node.? else null;
        // Kept candidates hold no node whose geometry a solve changed.
        const reuse = !self.forcesFullFrame() and active.rounds == 0 and root_node != null and
            self.candidates.items.len != 0 and !self.preparation_dirty and !try self.needsSolve(cli, root) and
            root_node.?.geometry_epoch == self.layout_epoch;
        if (active.rounds == active.options.max_layout_rounds) return error.LayoutLimit;
        if (!reuse) self.clearPreparation();
        self.feedback.clearRetainingCapacity();
        try self.candidates.ensureTotalCapacity(self.allocator, self.count + self.scroll_count);
        if (root) |value| try self.solveLayout(cli, value);
        active.rounds += 1;
        self.preparation_dirty = false;
        if (root) |value| {
            self.scroll_toggled = false;
            if (reuse and self.verifiesRetained()) try self.verifyPreparation(objects, cli, value);
            if (!reuse) try self.walkCandidates(objects, cli, value);
            // Hooks never see the layout a bar toggle replaces.
            while (self.scroll_toggled) {
                self.scroll_toggled = false;
                if (active.rounds == active.options.max_layout_rounds) return error.LayoutLimit;
                self.clearPreparation();
                try self.solveLayout(cli, value);
                active.rounds += 1;
                try self.walkCandidates(objects, cli, value);
            }
        }
        // Yoga measurement is observational; culled text keeps its last refreshed viewport.
        if (reuse) {
            while (self.view_dirty.pop()) |queued| {
                const node = queued.scene_node.?;
                node.skip.view_queued = false;
                if (node.prepared_gen == self.candidates_gen and !filteredAncestry(node)) try prepareView(&self.frame_work, node, node.layout);
            }
        } else {
            for (self.candidates.items) |entry| {
                if (!entry.bars and !entry.filtered) try prepareView(&self.frame_work, entry.node.scene_node.?, entry.layout);
            }
            for (self.view_dirty.items) |queued| queued.scene_node.?.skip.view_queued = false;
            self.view_dirty.clearRetainingCapacity();
        }
        if (phases) {
            // Prepass, filtered refresh, and selected updates never hold simultaneous batches for one parent.
            const capacity = std.math.mul(usize, self.candidates.items.len, 5) catch return error.ObjectLimit;
            try self.feedback.ensureTotalCapacity(self.allocator, capacity);
        }
        // Kept candidates keep their stamps: their generation is still current.
        if (!reuse) self.stampCandidates(phases);
        active.visibility_epoch = self.visibility_epoch;
        active.followup = false;
        active.followup_pass = false;
        if (phases and self.candidates.items.len != 0) self.startFeedback(self.candidates.items[0].node);
    }

    fn startFeedback(self: *Scene, root: *native.NativeRenderable) void {
        const active = &self.attempt.?;
        self.last_feedback_id += 1;
        active.feedback_id = self.last_feedback_id;
        const node = root.scene_node.?;
        self.feedback.appendAssumeCapacity(.{ .node = node.handle, .kind = .update });
        node.setFeedback(active, .queued);
    }

    fn walkCandidates(self: *Scene, objects: *const handles.Table, cli: *renderer.CliRenderer, root: *native.NativeRenderable) !void {
        self.candidates_gen += 1;
        self.attempt.?.walked = true;
        try self.prepare(objects, root, cli.width, cli.height, .candidates, false, &self.candidates);
    }

    fn stampCandidates(self: *Scene, phases: bool) void {
        const active = &self.attempt.?;
        for (self.candidates.items) |entry| {
            if (entry.bars) continue;
            if (builtin.is_test) self.test_stamp_steps += 1;
            const node = entry.node.scene_node.?;
            node.layout = entry.layout;
            node.geometry_epoch = self.layout_epoch;
            node.prepared_gen = self.candidates_gen;
            node.layout_flags.prepared_visible = entry.visible;
            // An observed node's resize size is its observed one; a new node is stale anyway.
            if (phases and !sameBox(entry.layout, node.observed_layout)) markObservationStale(entry.node);
            if (!phases) {
                if (entry.visible and node.hook_flags & api.OT_SCENE_HOOK_IDLE_UPDATE != 0) node.update_frame = active.frame_id;
                // With hooks, hidden roots never enter refresh; placed hidden children still do.
                if (self.hook_count != 0 and !entry.visible and node.parent == null) continue;
                node.observed_layout = entry.layout;
                node.resize_width = entry.layout.width;
                node.resize_height = entry.layout.height;
                node.observed_frame = active.frame_id;
                node.observed_round = active.rounds;
                node.placement = 0;
                node.layout_flags.needs_layout = false;
                node.skip.self_stale = false;
            }
        }
    }

    /// OT_SCENE_DEBUG_VERIFY on a round that keeps its lists: fresh walks list the same
    /// entries. They read no geometry and change no stamp, order, or counter. Stale caches are
    /// the twin harness's to find.
    fn verifyPreparation(self: *Scene, objects: *const handles.Table, cli: *renderer.CliRenderer, root: *native.NativeRenderable) !void {
        const work = self.frame_work;
        defer self.frame_work = work;
        var fresh: std.ArrayListUnmanaged(Work) = .empty;
        defer fresh.deinit(self.allocator);
        try fresh.ensureTotalCapacity(self.allocator, self.count + self.scroll_count);
        try self.prepare(objects, root, cli.width, cli.height, .candidates, true, &fresh);
        if (!sameEntries(fresh.items, self.candidates.items)) return error.RetainedMismatch;
        if (self.members.items.len == 0) return;
        fresh.clearRetainingCapacity();
        try self.prepare(objects, root, cli.width, cli.height, .paint, true, &fresh);
        if (!sameEntries(fresh.items, self.members.items)) return error.RetainedMismatch;
    }

    /// OT_SCENE_DEBUG_VERIFY before paint: feedback refreshed every painted member that changed,
    /// a reply's marks included, and every unchanged view is prepared.
    fn verifyObservations(self: *const Scene) !void {
        const phases = self.layout_hook_count != 0 or self.filter_count != 0;
        for (self.members.items) |entry| {
            const node = entry.node.scene_node.?;
            if (entry.bars) continue;
            if (node.skip.self_stale) {
                if (phases) return error.RetainedMismatch;
            } else if (!entry.filtered and viewNeedsPrepare(node, entry.layout)) return error.RetainedMismatch;
        }
    }

    fn releaseEditorCursor(self: *Scene, cli: *renderer.CliRenderer) void {
        if (!self.editor_cursor_owned) return;
        if (builtin.is_test) self.test_cursor_steps += 1;
        cli.terminal.setCursorPosition(1, 1, false);
        self.editor_cursor_owned = false;
    }

    fn beginPaint(self: *Scene, cli: *renderer.CliRenderer, options: FrameOptions, members: usize, banded: bool) !void {
        const target = cli.getNextBuffer();
        target.clearScissorRects();
        target.clearOpacity();
        try target.scissor_stack.ensureTotalCapacity(self.allocator, 1);
        try target.opacity_stack.ensureTotalCapacity(self.allocator, 1);
        cli.setBackgroundColor(options.background);
        const char: ?u32 = if (options.preserve_unwritten) 0 else null;
        if (banded) {
            // Placements take the full path.
            std.debug.assert(target.image_placements.items.len == 0);
            for (self.bands[0..self.band_count]) |band| {
                target.clearRows(band.top, band.bottom, options.background, char);
                self.frame_work.cells_cleared += @as(u64, target.width) * (band.bottom - band.top);
            }
        } else {
            target.clear(options.background, char);
            self.frame_work.cells_cleared += @as(u64, target.width) * target.height;
        }
        // The draft replaces the retained frame until its presentation; raw users then see the
        // draft's cells, as before.
        cli.next_scene_retained = false;
        cli.retained_frame_id = 0;
        self.settleHits(cli);
        self.hits.clearRetainingCapacity();
        // A bars entry adds a second hit.
        try self.hits.ensureTotalCapacity(self.allocator, members + self.scroll_count);
        self.hits_frame = self.attempt.?.frame_id;
        self.hits_generation = cli.hits_generation;
    }

    /// The draft's hits become the presented ones once the renderer published its frame.
    fn settleHits(self: *Scene, cli: *const renderer.CliRenderer) void {
        if (self.hits_frame == 0 or self.hits_frame != cli.presented_hits_frame or self.hits_generation != cli.hits_generation) return;
        std.mem.swap(std.ArrayListUnmanaged(Hit), &self.hits, &self.presented_hits);
        self.presented_hits_frame = self.hits_frame;
        self.hits_frame = 0;
    }

    /// The token of the topmost presented hit rectangle at a cell, or 0.
    pub fn hitToken(self: *Scene, cli: *const renderer.CliRenderer, x: u32, y: u32) u32 {
        self.settleHits(cli);
        // Every hit lies inside the screen.
        if (x >= cli.width or y >= cli.height or self.presented_hits_frame != cli.presented_hits_frame) return 0;
        const hits = self.presented_hits.items;
        const index = topmostHit(hits, x, y);
        if (builtin.is_test) self.test_hit_steps += hits.len - (index orelse 0);
        return if (index) |found| hits[found].token else 0;
    }

    /// Paint a box body at a host-chosen cell with the node's paint size and the current focus.
    /// A node no frame has prepared has no cells and draws nothing.
    pub fn paintBody(self: *const Scene, objects: *const handles.Table, target: *buffer.OptimizedBuffer, value: *const native.NativeRenderable, x: i32, y: i32) !void {
        const node = value.scene_node.?;
        var layout = try getPaintLayout(value);
        // At its own cell a body keeps the fractional position, so slider thumbs land where paintNode puts them.
        if (x != @as(i32, @intFromFloat(layout.screenX)) or y != @as(i32, @intFromFloat(layout.screenY))) {
            layout.screenX = @floatFromInt(x);
            layout.screenY = @floatFromInt(y);
            layout = cellLayout(layout);
        }
        if (layout.width < 1 or layout.height < 1) return;
        // A host scissor can start outside the target; the slider casts its clip to cells.
        const bounds: buffer.ClipRect = .{ .x = 0, .y = 0, .width = target.width, .height = target.height };
        const clip = if (target.getCurrentScissorRect()) |scissor| intersection(bounds, scissor) else bounds;
        var focused = if (self.focus) |handle| try objects.get(handle, .native_renderable, native.NativeRenderable) else null;
        var depth: u32 = 0;
        const within = while (focused) |cursor| : (focused = cursor.scene_node.?.parent) {
            if (cursor == value) break true;
            if (depth == yoga.depth_max) return error.YogaDepthLimit;
            depth += 1;
        } else false;
        try paintControl(target, node.kind, node.control, node.paint, layout, clip, within);
    }

    fn markFocus(self: *Scene, objects: *const handles.Table) !void {
        const frame_id = self.attempt.?.frame_id;
        var focused = if (self.focus) |handle| try objects.get(handle, .native_renderable, native.NativeRenderable) else null;
        var depth: u32 = 0;
        while (focused) |value| : (focused = value.scene_node.?.parent) {
            if (depth == yoga.depth_max) return error.YogaDepthLimit;
            depth += 1;
            value.scene_node.?.focus_frame = frame_id;
        }
    }

    /// Counts every row as damaged and returns why the frame cannot compare its members with
    /// the presented frame's.
    fn fullPathReasons(self: *Scene, cli: *renderer.CliRenderer, options: FrameOptions) u32 {
        if (self.records_frame != 0 and self.records_frame == cli.retained_frame_id) {
            std.mem.swap(std.ArrayListUnmanaged(Record), &self.records, &self.presented_records);
            self.presented_records_frame = self.records_frame;
            self.presented_options = self.records_options;
        }
        // finishPaint consumes the reasons, so a failed frame keeps them.
        var reasons = cli.retained_lost;
        // Writes before this frame's paint are repainted; writes after it taint this frame.
        cli.encode_all_rows = false;
        if (self.forcesFullFrame()) reasons |= renderer.FrameWork.full_path_forced;
        if (self.presented_records_frame == 0 or self.presented_records_frame != cli.retained_frame_id) reasons |= renderer.FrameWork.full_path_unretained;
        if (reasons & renderer.FrameWork.full_path_unretained == 0 and
            (!std.meta.eql(options.background, self.presented_options.background) or options.use_mouse != self.presented_options.use_mouse or
                options.excluded_hit_num != self.presented_options.excluded_hit_num or options.preserve_unwritten != self.presented_options.preserve_unwritten))
        {
            reasons |= renderer.FrameWork.full_path_options;
        }
        if (cli.currentImages.items.len != 0 or cli.nextRenderBuffer.image_placements.items.len != 0) reasons |= renderer.FrameWork.full_path_images;
        self.frame_work.full_path_reasons |= reasons;
        self.frame_work.damage_rows = cli.height;
        return reasons;
    }

    /// Records the frame's members and decides which rows can differ from the presented frame.
    /// Also returns the focused editor member, which owns the cursor wherever it paints.
    fn planPaint(self: *Scene, owner: *Context, cli: *renderer.CliRenderer, options: FrameOptions, recording: ?[]const u8, refresh_views: bool) !struct { Damage, ?Work } {
        const objects = &owner.objects;
        const frame_id = self.attempt.?.frame_id;
        var reasons = self.fullPathReasons(cli, options);
        self.band_count = 0;
        self.records.clearRetainingCapacity();
        self.records_frame = frame_id;
        self.records_options = options;
        try self.records.ensureTotalCapacity(self.allocator, if (recording == null) self.members.items.len else self.paint_members.items.len);
        try self.damage.resize(self.allocator, cli.height, false);
        self.damage.unsetAll();
        var matched: usize = 0;
        var cursor: ?Work = null;
        // Rows of every member whose inputs changed, before and after, and of every member that left.
        var list: PaintList = .{ .scene = self, .objects = objects, .recording = recording, .refresh_views = refresh_views };
        while (list.next()) |item| {
            const entry, const phases = item;
            if (self.focusedEditor(entry.node.scene_node.?)) cursor = entry;
            // A scroll node's record covers its bars: their inputs change its paint epoch.
            if (entry.bars) continue;
            self.record(owner, cli, entry, phases, &reasons);
            if (reasons != 0) continue;
            const current = self.records.items[self.records.items.len - 1];
            const old = self.recordOf(entry.node.scene_node.?, self.presented_records_frame, self.presented_records.items);
            matched += @intFromBool(old != null);
            if (old != null and current.stable and old.?.stable and std.meta.eql(old.?.inputs, current.inputs)) continue;
            self.damage.setRangeValue(.{ .start = current.top, .end = current.bottom }, true);
            if (old) |previous| self.damageRows(previous);
        }
        self.frame_work.full_path_reasons |= reasons;
        if (reasons != 0) return .{ .all, cursor };
        // Each member matches at most one presented record, so a full match means none left.
        std.debug.assert(matched <= self.presented_records.items.len);
        const departed: []const Record = if (matched == self.presented_records.items.len) &.{} else self.presented_records.items;
        for (departed) |previous| {
            const node = self.recordNode(objects, previous.token) orelse {
                self.damageRows(previous);
                continue;
            };
            if (self.recordOf(node, frame_id, self.records.items) == null) self.damageRows(previous);
        }
        const rows = self.damage.count();
        self.frame_work.damage_rows = @intCast(rows);
        self.planBands();
        return .{ if (rows == 0) .none else .rows, cursor };
    }

    /// Bands are the runs of damaged rows; runs one row apart merge, and the last band takes
    /// every run past the limit. No band means a full repaint: every row is damaged.
    fn planBands(self: *Scene) void {
        var rows = self.damage.iterator(.{});
        while (rows.next()) |index| {
            const row: u32 = @intCast(index);
            if (self.band_count != 0 and (row <= self.bands[self.band_count - 1].bottom + 1 or self.band_count == bands_max)) {
                self.bands[self.band_count - 1].bottom = row + 1;
            } else {
                self.bands[self.band_count] = .{ .top = row, .bottom = row + 1 };
                self.band_count += 1;
            }
        }
        if (self.band_count == 1 and self.bands[0].top == 0 and self.bands[0].bottom == self.damage.bit_length) self.band_count = 0;
    }

    fn damageRows(self: *Scene, previous: Record) void {
        // A resize takes the full path, so presented rows fit the screen.
        self.damage.setRangeValue(.{ .start = previous.top, .end = @min(previous.bottom, self.damage.bit_length) }, true);
    }

    fn recordNode(self: *Scene, objects: *const handles.Table, token: u32) ?*Node {
        if (builtin.is_test) self.test_record_lookups += 1;
        const handle = self.tokens.get(token) orelse return null;
        const value = objects.get(handle, .native_renderable, native.NativeRenderable) catch return null;
        return value.scene_node;
    }

    fn recordOf(_: *const Scene, node: *const Node, frame: u64, records: []const Record) ?Record {
        std.debug.assert(frame != 0);
        for (node.records) |slot| {
            if (slot.frame == frame) return records[slot.index];
        }
        return null;
    }

    fn record(self: *Scene, owner: *Context, cli: *const renderer.CliRenderer, entry: Work, phases: Phases, reasons: *u32) void {
        const node = entry.node.scene_node.?;
        if (node.kind == api.OT_SCENE_IMAGE) reasons.* |= renderer.FrameWork.full_path_images;
        const cells = cellLayout(entry.layout);
        const x: i32 = @intFromFloat(cells.screenX);
        const y: i32 = @intFromFloat(cells.screenY);
        var painted = intersection(.{ .x = x, .y = y, .width = @intFromFloat(cells.width), .height = @intFromFloat(cells.height) }, entry.clip);
        // A surface draws at its own size, which can pass the node's rows.
        if (entry.node.surface) |source| {
            if (source.image_placements.items.len != 0) reasons.* |= renderer.FrameWork.full_path_images;
            painted = rowSpan(painted, intersection(.{ .x = x, .y = y, .width = source.width, .height = source.height }, entry.clip));
        }
        // Viewport padding can make the viewport, and so the fills, pass the node's rows.
        if (hasFills(node)) painted = rowSpan(painted, intersection(cellClip(scrollViewport(node.scroll.?, cells)), entry.clip));
        // A member without paint hooks has an empty print: no rows, digest 0.
        const print: scene_record.Fingerprint = if (phases.hooks == 0) .{} else scene_record.fingerprint(owner, entry.node, phases.recording, phases.segments, phases.hooks, self.attempt.?.frame_id);
        if (print.image) reasons.* |= renderer.FrameWork.full_path_images;
        if (print.non_local) reasons.* |= renderer.FrameWork.full_path_non_local;
        // Hooks draw inside the member clip, except non-local commands: a change to those, or
        // their member leaving, damages every row. Rows outside the clip draw nothing.
        const low = if (print.non_local) 0 else @max(print.top, entry.clip.y);
        const high = if (print.non_local) cli.height else @min(print.bottom, @as(i64, entry.clip.y) + entry.clip.height);
        var top: i64 = painted.y;
        var bottom: i64 = painted.y + @as(i64, painted.height);
        if (low < high) {
            top = if (painted.height == 0) low else @min(top, low);
            bottom = @max(bottom, high);
        }
        var resource_epoch: u64 = 0;
        var styled = false;
        if (node.kind == api.OT_SCENE_TEXT_VIEW) {
            if (node.control.text_view.view) |view| {
                resource_epoch = view.paint_epoch;
                styled = view.text.buffer.getSyntaxStyle() != null;
            }
        } else if (node.editor) |editor| {
            resource_epoch = editor.paint_epoch;
            styled = editor.edit.buffer.tb.getSyntaxStyle() != null;
        }
        const slot: usize = @intFromBool(node.records[0].frame == self.presented_records_frame and self.presented_records_frame != 0);
        node.records[slot] = .{ .frame = self.records_frame, .index = @intCast(self.records.items.len) };
        self.records.appendAssumeCapacity(.{
            .token = node.token,
            .top = @intCast(top),
            .bottom = @intCast(bottom),
            .stable = print.stable and entry.node.surface == null,
            .inputs = .{
                .layout = entry.layout,
                .clip = entry.clip,
                .opacity = entry.opacity,
                .rank = @intCast(self.records.items.len),
                .focused = node.focus_frame == self.attempt.?.frame_id,
                .node_epoch = node.paint_epoch,
                .resource_epoch = resource_epoch,
                .styled = styled,
                .record_digest = print.digest,
            },
        });
    }

    /// The presented frame stays: no cells, hits, or rows change.
    fn skipPaint(self: *Scene, cli: *renderer.CliRenderer) !void {
        self.settleHits(cli);
        self.hits.clearRetainingCapacity();
        try self.hits.appendSlice(self.allocator, self.presented_hits.items);
        self.hits_frame = self.attempt.?.frame_id;
        self.hits_generation = cli.hits_generation;
    }

    /// OT_SCENE_DEBUG_VERIFY: every row of two buffers, or every row outside the damage, holds
    /// the same cells.
    fn verifyRows(self: *const Scene, first: *const buffer.OptimizedBuffer, second: *const buffer.OptimizedBuffer, outside_damage: bool) !void {
        const width = first.width;
        for (0..first.height) |row| {
            if (outside_damage and self.damage.isSet(row)) continue;
            const start = row * width;
            const end = start + width;
            const a = first.buffer;
            const b = second.buffer;
            if (!std.mem.eql(u32, a.char[start..end], b.char[start..end]) or !std.mem.eql(u32, a.attributes[start..end], b.attributes[start..end]) or
                !std.mem.eql(u8, std.mem.sliceAsBytes(a.fg[start..end]), std.mem.sliceAsBytes(b.fg[start..end])) or
                !std.mem.eql(u8, std.mem.sliceAsBytes(a.bg[start..end]), std.mem.sliceAsBytes(b.bg[start..end]))) return error.RetainedMismatch;
        }
    }

    /// OT_SCENE_DEBUG_VERIFY on a skipped or band frame: a full repaint into a scratch buffer
    /// equals next, and its hits the draft's. It changes no view, cursor, counter, hit, or
    /// buffer the frame keeps.
    fn verifyRepaint(self: *Scene, owner: *Context, cli: *renderer.CliRenderer, options: FrameOptions, recording: ?[]const u8, refresh_views: bool) !void {
        const next = cli.getNextBuffer();
        const scratch = try buffer.OptimizedBuffer.init(self.allocator, next.width, next.height, .{ .pool = next.pool, .link_pool = next.link_pool, .logger = next.logger, .width_method = next.width_method, .id = "verify buffer" });
        defer scratch.deinit();
        scratch.respectAlpha = next.respectAlpha;
        scratch.blendBackdropColor = next.blendBackdropColor;
        try scratch.scissor_stack.ensureTotalCapacity(self.allocator, 1);
        try scratch.opacity_stack.ensureTotalCapacity(self.allocator, 1);
        scratch.clear(options.background, if (options.preserve_unwritten) 0 else null);
        const kept = self.hits;
        self.hits = .empty;
        defer {
            self.hits.deinit(self.allocator);
            self.hits = kept;
        }
        try self.hits.ensureTotalCapacity(self.allocator, @max(self.members.items.len, self.paint_members.items.len) + self.scroll_count);
        const work = self.frame_work;
        defer self.frame_work = work;
        self.verify_target = scratch;
        defer self.verify_target = null;
        try self.paintMembers(owner, cli, options, recording, refresh_views, false);
        try self.verifyRows(scratch, next, false);
        if (!std.mem.eql(u8, std.mem.sliceAsBytes(self.hits.items), std.mem.sliceAsBytes(kept.items))) return error.RetainedMismatch;
    }

    /// Where paint draws: next, or the scratch buffer of a verified skip.
    fn paintTarget(self: *const Scene, cli: *renderer.CliRenderer) *buffer.OptimizedBuffer {
        return self.verify_target orelse cli.getNextBuffer();
    }

    /// Snapshot prepared membership and return one request for every paint hook.
    fn requestRecord(self: *Scene, cli: *renderer.CliRenderer, root: *native.NativeRenderable) !FrameRequest {
        std.debug.assert(self.paint_members.items.len == 0 and self.paint_slots.items.len == 0);
        var member_count: usize = 0;
        var slot_count: usize = 0;
        for (self.members.items) |entry| {
            const node = entry.node.scene_node.?;
            // Paint-mode preparation never appends hidden members.
            std.debug.assert(entry.visible);
            if (node.kind == api.OT_SCENE_ROOT) continue;
            member_count += 1;
            slot_count += @intFromBool(!entry.bars and node.hook_flags & scene_paint_hook_flags != 0);
        }
        std.debug.assert(slot_count != 0);
        try self.paint_members.ensureTotalCapacityPrecise(self.allocator, member_count);
        try self.paint_slots.ensureTotalCapacityPrecise(self.allocator, slot_count);
        try self.segments.ensureTotalCapacityPrecise(self.allocator, slot_count);
        for (self.members.items) |entry| {
            const node = entry.node.scene_node.?;
            if (node.kind == api.OT_SCENE_ROOT) continue;
            const hooks = if (entry.bars) 0 else node.hook_flags & scene_paint_hook_flags;
            var slot: u32 = no_slot;
            if (hooks != 0) {
                slot = @intCast(self.paint_slots.items.len);
                self.paint_slots.appendAssumeCapacity(.{
                    .node = node.handle,
                    .num = node.num,
                    .hooks = hooks,
                    .hook_generation = node.hook_generation,
                    .layout = cellLayout(entry.layout),
                    .public_layout = composedLayout(entry.node, true) catch null,
                    .clip = entry.clip,
                    .opacity = entry.opacity,
                });
            }
            self.paint_members.appendAssumeCapacity(.{
                .node = node.handle,
                .layout = entry.layout,
                .clip = entry.clip,
                .opacity = entry.opacity,
                .filtered = entry.filtered,
                .bars = entry.bars,
                .slot = slot,
            });
        }
        // Hooks run before paint; a host cursor they place must survive paint setup.
        self.releaseEditorCursor(cli);
        return self.request(root.scene_node.?, api.OT_SCENE_FRAME_RECORD);
    }

    /// Paint the RECORD snapshot in one pass, playing each slot's recording in place.
    fn paintRecorded(self: *Scene, owner: *Context, cli: *renderer.CliRenderer, root: ?*native.NativeRenderable, recording: []const u8) !FrameRequest {
        self.segments.items.len = self.paint_slots.items.len;
        try scene_record.index(recording, self.paint_slots.items, self.segments.items);
        try self.markFocus(&owner.objects);
        // Hooks may change text or views after preparation; refresh them before drawing.
        const refresh_views = self.preparation_dirty or try self.needsSolve(cli, root);
        return self.paintPlanned(owner, cli, recording, refresh_views);
    }

    const Phases = struct {
        recording: []const u8 = &.{},
        segments: scene_record.Segments = .{ .{}, .{}, .{} },
        hooks: u32 = 0,
    };

    /// The frame's paint list in paint order: the visible members, or the RECORD snapshot with
    /// each slot's recording, without the members its hooks destroyed.
    const PaintList = struct {
        scene: *const Scene,
        objects: *const handles.Table,
        recording: ?[]const u8,
        refresh_views: bool,
        index: usize = 0,

        fn next(self: *PaintList) ?struct { Work, Phases } {
            const scene = self.scene;
            while (true) {
                const index = self.index;
                self.index += 1;
                const bytes = self.recording orelse {
                    if (index >= scene.members.items.len) return null;
                    const entry = scene.members.items[index];
                    // Paint-mode preparation never appends hidden members.
                    std.debug.assert(entry.visible);
                    if (entry.node.scene_node.?.kind != api.OT_SCENE_ROOT) return .{ entry, .{} };
                    continue;
                };
                if (index >= scene.paint_members.items.len) return null;
                const member = scene.paint_members.items[index];
                const value = self.objects.get(member.node, .native_renderable, native.NativeRenderable) catch continue;
                std.debug.assert(value.scene_node.?.owner == scene);
                const entry: Work = .{ .node = value, .layout = member.layout, .clip = member.clip, .opacity = member.opacity, .visible = true, .filtered = member.filtered or self.refresh_views, .bars = member.bars };
                return .{ entry, if (member.slot == no_slot) .{} else .{
                    .recording = bytes,
                    .segments = scene.segments.items[member.slot],
                    .hooks = scene.paint_slots.items[member.slot].hooks,
                } };
            }
        }
    };

    /// Paint prepared membership in one pass: the RECORD snapshot with its recording, or
    /// the visible paint list with native bodies only.
    fn paintFrame(self: *Scene, owner: *Context, cli: *renderer.CliRenderer, options: FrameOptions, recording: ?[]const u8, refresh_views: bool, banded: bool) !void {
        const target = cli.getNextBuffer();
        errdefer target.clear(cli.backgroundColor, null);
        defer target.clearScissorRects();
        defer target.clearOpacity();
        try self.beginPaint(cli, options, if (recording == null) self.members.items.len else self.paint_members.items.len, banded);
        try self.paintMembers(owner, cli, options, recording, refresh_views, banded);
    }

    /// Paints every member, or on a band frame each member on the bands its record's rows meet.
    fn paintMembers(self: *Scene, owner: *Context, cli: *renderer.CliRenderer, options: FrameOptions, recording: ?[]const u8, refresh_views: bool, banded: bool) !void {
        var list: PaintList = .{ .scene = self, .objects = &owner.objects, .recording = recording, .refresh_views = refresh_views };
        const bands: []const Band = if (banded) self.bands[0..self.band_count] else &whole_screen;
        var index: usize = 0;
        while (list.next()) |item| {
            const entry, const phases = item;
            var rows = whole_screen[0];
            if (banded) {
                // Records follow the paint list; a bars entry paints inside its scroll node's record.
                const found = if (entry.bars) self.recordOf(entry.node.scene_node.?, self.records_frame, self.records.items).? else self.records.items[index];
                std.debug.assert(found.token == entry.node.scene_node.?.token);
                rows = .{ .top = found.top, .bottom = found.bottom };
            }
            index += @intFromBool(!entry.bars);
            try self.paintMember(owner, cli, entry, options, phases, bands, rows);
        }
    }

    fn focusedEditor(self: *const Scene, node: *const Node) bool {
        return node.editor != null and self.focus != null and std.meta.eql(self.focus.?, node.handle);
    }

    /// Paints a member on each band that meets its rows, scissored to the band, and adds its
    /// hits once, so a band frame's hits equal a full frame's.
    fn paintMember(self: *Scene, owner: *Context, cli: *renderer.CliRenderer, entry: Work, options: FrameOptions, phases: Phases, bands: []const Band, rows: Band) !void {
        const node = entry.node.scene_node.?;
        if (entry.bars) return self.paintBars(cli, entry, options, bands, rows);
        const cells = cellLayout(entry.layout);
        const painted = intersection(.{
            .x = @intFromFloat(cells.screenX),
            .y = @intFromFloat(cells.screenY),
            .width = @intFromFloat(cells.width),
            .height = @intFromFloat(cells.height),
        }, entry.clip);
        const met = bandsMeet(bands, rows);
        self.frame_work.members_painted += @intFromBool(met);
        if (!met) {
            // A member no band meets still prepares its view, as its body would.
            if (phases.hooks & api.OT_SCENE_HOOK_RENDER_SELF == 0) try self.prepareMember(entry);
        } else if (phases.hooks != 0 or node.kind != api.OT_SCENE_BOX or hasBoxPaint(&node.paint) or hasFills(node)) for (bands) |band| {
            if (!band.meets(rows)) continue;
            const scissor = bandClip(entry.clip, band);
            const drawn = intersection(painted, scissor);
            self.frame_work.member_cells += @as(u64, drawn.width) * drawn.height;
            try self.drawMember(owner, cli, entry, phases, cells, scissor);
        };
        if (!options.use_mouse or node.num == options.excluded_hit_num) return;
        // The clip lies inside the screen, so hit coordinates are never negative.
        if (painted.width != 0 and painted.height != 0) self.hits.appendAssumeCapacity(.{ .x = @intCast(painted.x), .y = @intCast(painted.y), .width = painted.width, .height = painted.height, .token = node.token });
    }

    /// One member's phases and body inside a scissor. A member on several bands prepares its
    /// views on each; only the first preparation can change a view.
    fn drawMember(self: *Scene, owner: *Context, cli: *renderer.CliRenderer, entry: Work, phases: Phases, cells: Layout, scissor: buffer.ClipRect) !void {
        const node = entry.node.scene_node.?;
        const target = self.paintTarget(cli);
        // A natively composed image buffer receives its node's hook drawing, like its body.
        const surface = if (node.kind == api.OT_SCENE_IMAGE) node.control.image.buffer else null;
        try enterMember(target, scissor, entry.opacity);
        if (node.kind == api.OT_SCENE_IMAGE) try beginImagePaint(node.control.image, cells);
        try playPhase(owner, target, surface, scissor, entry.opacity, phases, api.OT_SCENE_RECORD_PHASE_BEFORE);
        if (phases.hooks & api.OT_SCENE_HOOK_RENDER_SELF != 0) {
            try playPhase(owner, target, surface, scissor, entry.opacity, phases, api.OT_SCENE_RECORD_PHASE_SELF);
        } else try self.paintNode(cli, entry, cells);
        try playPhase(owner, target, surface, scissor, entry.opacity, phases, api.OT_SCENE_RECORD_PHASE_AFTER);
        if (node.kind == api.OT_SCENE_IMAGE) try finishImagePaint(target, node.control.image, cells);
    }

    /// Each phase starts with only the member's inherited clip, narrowed to its band, and opacity.
    fn enterMember(target: *buffer.OptimizedBuffer, scissor: buffer.ClipRect, opacity: f32) !void {
        target.clearScissorRects();
        target.clearOpacity();
        try target.pushScissorRect(scissor.x, scissor.y, scissor.width, scissor.height);
        try target.pushOpacity(opacity);
    }

    /// Play one phase into the frame, or into the node's own buffer with empty stacks.
    fn playPhase(owner: *Context, target: *buffer.OptimizedBuffer, surface: ?*buffer.OptimizedBuffer, scissor: buffer.ClipRect, opacity: f32, phases: Phases, phase: u32) !void {
        const segment = phases.segments[phase];
        if (segment.start == segment.end) return;
        const local = surface orelse {
            try scene_record.play(owner, target, 1, phases.recording, segment);
            return enterMember(target, scissor, opacity);
        };
        defer local.clearScissorRects();
        defer local.clearOpacity();
        local.clearScissorRects();
        local.clearOpacity();
        try scene_record.play(owner, local, 0, phases.recording, segment);
    }

    /// Prepares a member's view for this frame's layout, as its body's paint does. Refresh
    /// prepares a changed culled text, and drawing applies its layout. A text view can lose its
    /// viewport to a rebind in a RECORD reply; an editor's preparation follows its cursor.
    fn prepareMember(self: *Scene, entry: Work) !void {
        const node = entry.node.scene_node.?;
        if (!(entry.filtered or self.preparation_dirty) or self.verify_target != null) return;
        if ((node.kind == api.OT_SCENE_TEXT_VIEW and viewNeedsPrepare(node, entry.layout)) or (node.kind == api.OT_SCENE_EDITOR and node.editor != null)) try prepareView(&self.frame_work, node, entry.layout);
    }

    fn paintNode(self: *Scene, cli: *renderer.CliRenderer, entry: Work, cells: Layout) !void {
        const target = self.paintTarget(cli);
        const node = entry.node.scene_node.?;
        const x: i32 = @intFromFloat(cells.screenX);
        const y: i32 = @intFromFloat(cells.screenY);
        const width: u32 = @intFromFloat(cells.width);
        const height: u32 = @intFromFloat(cells.height);
        try self.prepareMember(entry);
        if (node.text) |text| {
            const hit = intersection(.{ .x = x, .y = y, .width = width, .height = height }, entry.clip);
            if (hit.width != 0 and hit.height != 0) try target.drawTextBufferChecked(text.view, x, y);
        } else if (node.kind == api.OT_SCENE_TEXT_VIEW) {
            const view = node.control.text_view.view orelse return;
            if (!node.control.text_view.paint) return;
            const hit = intersection(.{ .x = x, .y = y, .width = width, .height = height }, entry.clip);
            if (hit.width != 0 and hit.height != 0) try target.drawTextBufferChecked(view.view, x, y);
        } else if (node.kind == api.OT_SCENE_EDITOR) {
            const editor = node.editor orelse return;
            const hit = intersection(.{ .x = x, .y = y, .width = width, .height = height }, entry.clip);
            if (hit.width != 0 and hit.height != 0) try target.drawEditorViewChecked(editor.view, x, y);
        } else if (node.kind == api.OT_SCENE_IMAGE) {
            try paintImage(cli, node.control.image, cells);
        } else if (entry.node.surface) |source| {
            try Context.drawContextBuffer(target, source, x, y, .{});
        } else {
            try paintControl(target, node.kind, node.control, node.paint, cells, entry.clip, node.focus_frame == self.attempt.?.frame_id);
            if (node.scroll != null) paintScrollFills(target, node, cells);
        }
    }

    /// The wrapper, viewport, and content fills, in that order, under the children.
    fn paintScrollFills(target: *buffer.OptimizedBuffer, node: *const Node, box: Layout) void {
        const state = node.scroll.?;
        const sides = node.paint.borderSides;
        const viewport = cellClip(scrollViewport(state, box));
        // The inner rect minus the vertical gutter: the horizontal bar's columns, the vertical bar's rows.
        const columns = state.barRects(0, box, sides).bar;
        const rows = state.barRects(1, box, sides).bar;
        const wrapper: Layout = .{ .screenX = columns.screenX, .screenY = rows.screenY, .width = columns.width, .height = rows.height };
        const origin = childOrigin(node, box);
        const content = intersection(viewport, cellClip(.{ .screenX = origin[0], .screenY = origin[1], .width = state.extent[0], .height = state.extent[1] }));
        for (state.options.fills, [_]buffer.ClipRect{ cellClip(wrapper), viewport, content }) |fill, area| {
            if (fill) |rgba| target.fillRectClipped(area.x, area.y, area.width, area.height, rgba);
        }
    }

    /// A scroll node's visible bars and arrows on each band that meets its node's rows, after its
    /// children; their cells hit the node.
    fn paintBars(self: *Scene, cli: *renderer.CliRenderer, entry: Work, options: FrameOptions, bands: []const Band, rows: Band) !void {
        const node = entry.node.scene_node.?;
        const state = node.scroll.?;
        const target = self.paintTarget(cli);
        const box = cellLayout(entry.layout);
        for (bands) |band| {
            if (!band.meets(rows)) continue;
            try enterMember(target, bandClip(entry.clip, band), entry.opacity);
            for (0..2) |axis| {
                if (!state.visible[axis]) continue;
                const rects = state.barRects(axis, box, node.paint.borderSides);
                if (rects.track.width >= 1 and rects.track.height >= 1) try paintSlider(target, state.slider(axis), rects.track, entry.clip);
                if (state.options.bars[axis].arrows) for (rects.arrows, 0..) |arrow, end| {
                    if (arrow.width < 1 or arrow.height < 1) continue;
                    const glyph = state.arrows[axis][end];
                    const direction = if (axis == 1) end else 2 + end;
                    try target.drawTextChecked(glyph.text orelse arrows[direction], @intFromFloat(arrow.screenX), @intFromFloat(arrow.screenY), glyph.foreground, glyph.background, glyph.attributes);
                };
            }
        }
        if (!options.use_mouse or node.num == options.excluded_hit_num) return;
        for (0..2) |axis| {
            if (!state.visible[axis]) continue;
            const hit = intersection(cellClip(state.barRects(axis, box, node.paint.borderSides).bar), entry.clip);
            if (hit.width != 0 and hit.height != 0) self.hits.appendAssumeCapacity(.{ .x = @intCast(hit.x), .y = @intCast(hit.y), .width = hit.width, .height = hit.height, .token = node.token });
        }
    }

    fn beginImagePaint(state: ImageState, layout: Layout) !void {
        const target = state.buffer orelse return;
        try target.resize(@intFromFloat(layout.width), @intFromFloat(layout.height));
        target.clear(ansi.rgbColor(0, 0, 0, 0), null);
    }

    fn finishImagePaint(target: *buffer.OptimizedBuffer, state: ImageState, layout: Layout) !void {
        const source = state.buffer orelse return;
        try Context.drawContextBuffer(target, source, @intFromFloat(layout.screenX), @intFromFloat(layout.screenY), .{});
    }

    fn paintImage(cli: *renderer.CliRenderer, state: ImageState, layout: Layout) !void {
        const source = state.source orelse return;
        const resolution = cli.image_resolution;
        const has_resolution = resolution.pixel_width != 0 and resolution.pixel_height != 0 and
            resolution.terminal_width != 0 and resolution.terminal_height != 0;
        const cell_width: f64 = if (has_resolution) @as(f64, @floatFromInt(resolution.pixel_width)) / @as(f64, @floatFromInt(resolution.terminal_width)) else 0;
        const cell_height: f64 = if (has_resolution) @as(f64, @floatFromInt(resolution.pixel_height)) / @as(f64, @floatFromInt(resolution.terminal_height)) else 0;
        const cell_aspect: f64 = if (has_resolution) cell_height / cell_width else 2;
        var width: f64 = layout.width;
        var height: f64 = layout.height;
        var source_width = source.width();
        var source_height = source.height();
        var source_x: u32 = 0;
        var source_y: u32 = 0;
        if (state.fit == .fit) {
            const aspect = @as(f64, @floatFromInt(source_width)) / @as(f64, @floatFromInt(source_height)) * cell_aspect;
            const scale = @min(width / aspect, height);
            width = @max(1, @round(aspect * scale));
            height = @max(1, @round(scale));
        } else if (state.fit == .cover) {
            const aspect = width / (height * cell_aspect);
            if (@as(f64, @floatFromInt(source_width)) / @as(f64, @floatFromInt(source_height)) > aspect) {
                source_width = @intFromFloat(@max(1, @round(@as(f64, @floatFromInt(source_height)) * aspect)));
                source_x = (source.width() - source_width) / 2;
            } else {
                source_height = @intFromFloat(@max(1, @round(@as(f64, @floatFromInt(source_width)) / aspect)));
                source_y = (source.height() - source_height) / 2;
            }
        }
        const x = (if (state.buffer != null) @as(f64, 0) else layout.screenX) + @floor((layout.width - width) / 2);
        const y = (if (state.buffer != null) @as(f64, 0) else layout.screenY) + @floor((layout.height - height) / 2);
        // Pixel sizes saturate like cell geometry; the terminal only shows the visible part.
        const pixel_width = if (has_resolution) std.math.clamp(@round(width * cell_width), 1, std.math.maxInt(u32)) else 0;
        const pixel_height = if (has_resolution) std.math.clamp(@round(height * cell_height), 1, std.math.maxInt(u32)) else 0;
        // Paint geometry fits i32 cells, and the image stays within its node.
        std.debug.assert(x >= std.math.minInt(i32) and x <= std.math.maxInt(i32) and y >= std.math.minInt(i32) and y <= std.math.maxInt(i32));
        const target = state.buffer orelse cli.getNextBuffer();
        _ = try target.drawImage(source, source.render_id, @intFromFloat(x), @intFromFloat(y), @intFromFloat(width), @intFromFloat(height), @intFromFloat(pixel_width), @intFromFloat(pixel_height), source_x, source_y, source_width, source_height, state.protocol);
    }

    /// Once per painted frame: place the cursor for the focused editor member, or release it.
    /// The cursor follows the editor even when a host hook replaces its body.
    fn maintainCursor(self: *Scene, cli: *renderer.CliRenderer, focused: ?Work) void {
        const entry = focused orelse return self.releaseEditorCursor(cli);
        if (builtin.is_test) self.test_cursor_steps += 1;
        const node = entry.node.scene_node.?;
        const layout = cellLayout(entry.layout);
        if (node.control.editor.mouse_pointer < std.meta.tags(@import("terminal.zig").MousePointerStyle).len) cli.terminal.setMousePointerStyle(@enumFromInt(node.control.editor.mouse_pointer));
        if (!node.control.editor.show_cursor) return self.releaseEditorCursor(cli);
        const cursor = node.editor.?.view.getVisualCursor();
        // Terminal keeps zero-based row/column in u16 alongside its public position.
        const position_max = @as(f64, std.math.maxInt(u16)) + 1;
        const cursor_x = std.math.clamp(layout.screenX + @as(f64, @floatFromInt(cursor.visual_col)) + 1, 1, position_max);
        const cursor_y = std.math.clamp(layout.screenY + @as(f64, @floatFromInt(cursor.visual_row)) + 1, 1, position_max);
        cli.terminal.setCursorPosition(@intFromFloat(cursor_x), @intFromFloat(cursor_y), true);
        // Styles 0 to 3 are the enum's order; sceneSetEditorOptions rejects others.
        cli.terminal.setCursorStyle(@enumFromInt(node.control.editor.style), node.control.editor.blinking);
        cli.terminal.setCursorColor(node.control.editor.color);
        self.editor_cursor_owned = true;
    }

    fn paintControl(target: *buffer.OptimizedBuffer, kind: u32, control: Control, paint: Paint, layout: Layout, clip: buffer.ClipRect, focused: bool) !void {
        if (kind == api.OT_SCENE_BOX) {
            try paintBox(target, paint, layout, focused, control.box);
        } else if (kind == api.OT_SCENE_SLIDER) {
            try paintSlider(target, control.slider, layout, clip);
        } else if (kind == api.OT_SCENE_ARROW) {
            const arrow = control.arrow;
            try target.drawTextChecked(
                arrow.text orelse arrows[arrow.direction],
                @intFromFloat(layout.screenX),
                @intFromFloat(layout.screenY),
                arrow.foreground,
                arrow.background,
                arrow.attributes,
            );
        }
    }

    fn hasFills(node: *const Node) bool {
        const state = node.scroll orelse return false;
        return state.options.fills[0] != null or state.options.fills[1] != null or state.options.fills[2] != null;
    }

    fn hasBoxPaint(paint_options: *const Paint) bool {
        return paint_options.borderSides != api.OT_BORDER_NONE or (paint_options.shouldFill != 0 and paint_options.background[3] != 0);
    }

    fn paintBox(target: *buffer.OptimizedBuffer, paint_options: Paint, layout: Layout, focused: bool, details: ?*const BoxDetails) !void {
        if (hasBoxPaint(&paint_options)) {
            const border_color = if (paint_options.focusable and focused) paint_options.focusedBorderColor else paint_options.borderColor;
            const options = details orelse &BoxDetails{};
            const chars = if (options.custom_border_chars) |*custom| custom else &borders[paint_options.borderStyle];
            try target.drawBoxChecked(@intFromFloat(layout.screenX), @intFromFloat(layout.screenY), @intFromFloat(layout.width), @intFromFloat(layout.height), chars, .{
                .left = paint_options.borderSides & api.OT_BORDER_LEFT != 0,
                .bottom = paint_options.borderSides & api.OT_BORDER_BOTTOM != 0,
                .right = paint_options.borderSides & api.OT_BORDER_RIGHT != 0,
                .top = paint_options.borderSides & api.OT_BORDER_TOP != 0,
            }, border_color, paint_options.background, options.title_color orelse border_color, paint_options.shouldFill != 0, if (options.title.len != 0) options.title else null, @intCast(options.title_alignment), if (options.bottom_title.len != 0) options.bottom_title else null, @intCast(options.bottom_title_alignment));
        }
    }

    fn viewportNode(self: *Scene, objects: *const handles.Table, handle: handles.Handle) !*native.NativeRenderable {
        const value = try objects.get(handle, .native_renderable, native.NativeRenderable);
        const node = value.scene_node orelse return error.WrongKind;
        if (node.owner != self) return error.WrongSession;
        if (node.kind > api.OT_SCENE_BOX) return error.WrongKind;
        return value;
    }

    fn childFilter(self: *Scene, objects: *const handles.Table, value: *native.NativeRenderable) !?Filter {
        const node = value.scene_node.?;
        if (!node.filtersChildren()) return null;
        const layout = if (node.scroll) |state|
            scrollViewport(state, try composedLayout(value, false))
        else
            try composedLayout(try self.viewportNode(objects, node.viewport.?), false);
        // The cutoff includes hidden children and changes selection, not refresh ordering.
        if (node.children.items.len < 16 and layout.width > 0 and layout.height > 0) return null;
        var direction: u32 = 0;
        try yoga.check(yoga.yogaNodeStyleGetEnumChecked(node.childYoga(value), api.OT_STYLE_ENUM_FLEX_DIRECTION, &direction));
        return .{ .viewport = layout, .row = direction == api.OT_FLEX_DIRECTION_ROW or direction == api.OT_FLEX_DIRECTION_ROW_REVERSE };
    }

    /// A dry walk lists what a walk would without reading geometry or changing order.
    fn prepare(self: *Scene, objects: *const handles.Table, root: *native.NativeRenderable, width: u32, height: u32, mode: enum { candidates, paint }, dry: bool, list: *std.ArrayListUnmanaged(Work)) !void {
        var stack: [yoga.depth_max]PreparationFrame = undefined;
        stack[0] = .{ .node = root, .parent = .{}, .clip = .{ .x = 0, .y = 0, .width = width, .height = height }, .opacity = 1 };
        var depth: usize = 1;
        while (depth != 0) {
            const frame = &stack[depth - 1];
            const value = frame.node;
            const node = value.scene_node.?;
            if (!frame.entered) {
                switch (mode) {
                    .candidates => self.frame_work.candidate_visits += 1,
                    .paint => self.frame_work.paint_visits += 1,
                }
                // Yoga style changes dirty layout; the completed preparation stamps qualify both caches.
                const refresh_layout = mode == .candidates and !dry and node.geometry_epoch != self.layout_epoch;
                if (refresh_layout) {
                    var display: u32 = 0;
                    try yoga.check(yoga.yogaNodeStyleGetEnumChecked(value.yoga_node, api.OT_STYLE_ENUM_DISPLAY, &display));
                    node.layout_flags.display_none = display == api.OT_DISPLAY_NONE;
                }
                const visible = !node.layout_flags.display_none;
                const filtered_child = if (node.parent) |parent| parent.scene_node.?.filtersChildren() else false;
                if (!visible and (mode == .paint or (!node.layout_flags.needs_layout and !filtered_child))) {
                    depth -= 1;
                    continue;
                }
                var layout = node.layout;
                if (refresh_layout) {
                    var computed: yoga.ExternalYogaLayout = undefined;
                    self.frame_work.geometry_reads += 1;
                    try yoga.check(yoga.yogaNodeGetComputedLayoutChecked(value.yoga_node, &computed));
                    layout = .{
                        .left = computed.left,
                        .top = computed.top,
                        .right = computed.right,
                        .bottom = computed.bottom,
                        .width = @max(computed.width, 1),
                        .height = @max(computed.height, 1),
                    };
                } else if (mode == .paint) {
                    // Final paint follows settled preparation, but transforms remain live.
                    std.debug.assert(node.prepared_gen == self.candidates_gen);
                }
                // Image paint and hit geometry rely on at least one cell per dimension.
                std.debug.assert(layout.width >= 1 and layout.height >= 1);
                if (node.scroll) |state| {
                    if (refresh_layout and visible) try self.resolveScroll(value, state);
                }
                layout.screenX = frame.parent.screenX + @as(f64, layout.left) + node.paint.translateX;
                layout.screenY = frame.parent.screenY + @as(f64, layout.top) + node.paint.translateY;
                if (node.scroll) |state| if (!std.meta.eql(state.screen, .{ layout.screenX, layout.screenY })) {
                    state.screen = .{ layout.screenX, layout.screenY };
                    state.generation += 1;
                };
                const cells = cellLayout(layout);
                if (frame.filter) |filter| {
                    self.frame_work.overlap_tests += 1;
                    if (!overlaps(filter, layout)) {
                        depth -= 1;
                        continue;
                    }
                }
                if (node.kind == api.OT_SCENE_SLIDER) _ = try sliderThumb(node.control.slider, cells.width, cells.height);
                frame.opacity *= node.paint.opacity;
                frame.work_index = list.items.len;
                list.appendAssumeCapacity(.{ .node = value, .layout = layout, .clip = frame.clip, .opacity = frame.opacity, .visible = visible, .filtered = frame.filtered });
                if (node.viewport) |handle| _ = try self.viewportNode(objects, handle);
                if (!visible or (node.paint_children.items.len == 0 and node.viewport == null and node.scroll == null)) {
                    depth -= 1;
                    continue;
                }
                frame.parent = layout;
                if (refresh_layout) {
                    var overflow: u32 = 0;
                    try yoga.check(yoga.yogaNodeStyleGetEnumChecked(value.yoga_node, api.OT_STYLE_ENUM_OVERFLOW, &overflow));
                    node.layout_flags.clips_children = overflow != api.OT_OVERFLOW_VISIBLE;
                }
                if (node.scroll) |state| {
                    const origin = childOrigin(node, layout);
                    frame.parent.screenX = origin[0];
                    frame.parent.screenY = origin[1];
                    frame.clip = intersection(frame.clip, cellClip(scrollViewport(state, layout)));
                } else if (node.layout_flags.clips_children) {
                    const left: u32 = @intFromBool(node.paint.borderSides & api.OT_BORDER_LEFT != 0);
                    const top: u32 = @intFromBool(node.paint.borderSides & api.OT_BORDER_TOP != 0);
                    const horizontal = left + @as(u32, @intFromBool(node.paint.borderSides & api.OT_BORDER_RIGHT != 0));
                    const vertical = top + @as(u32, @intFromBool(node.paint.borderSides & api.OT_BORDER_BOTTOM != 0));
                    frame.clip = intersection(frame.clip, .{
                        .x = @intFromFloat(cells.screenX + @as(f64, @floatFromInt(left))),
                        .y = @intFromFloat(cells.screenY + @as(f64, @floatFromInt(top))),
                        .width = @as(u32, @intFromFloat(cells.width)) -| horizontal,
                        .height = @as(u32, @intFromFloat(cells.height)) -| vertical,
                    });
                }
                if (mode == .paint) frame.filter = try self.childFilter(objects, value);
                if (!dry and (mode == .paint or (self.hook_count == 0 and self.filter_count == 0))) {
                    // The candidates walked the old order, so the next frame walks again.
                    if (sortChildren(node, self.attempt.?.frame_id) and mode == .paint) self.candidates.clearRetainingCapacity();
                }
                frame.entered = true;
            }
            if (frame.child == node.paint_children.items.len) {
                if (node.scroll) |state| if (state.visible[0] or state.visible[1]) {
                    var bars = list.items[frame.work_index];
                    bars.bars = true;
                    list.appendAssumeCapacity(bars);
                };
                depth -= 1;
                continue;
            }
            if (depth == stack.len) return error.YogaDepthLimit;
            const child = node.paint_children.items[frame.child];
            frame.child += 1;
            stack[depth] = .{ .node = child, .parent = frame.parent, .clip = frame.clip, .opacity = frame.opacity, .filtered = frame.filtered or node.filtersChildren(), .filter = frame.filter };
            depth += 1;
        }
    }
};

pub fn sliderThumb(options: SliderOptions, width: f64, height: f64) !SliderThumb {
    if (options.orientation > 1) return error.InvalidOptions;
    for ([_]f64{ options.min, options.max, options.value, options.viewport_size }) |value| {
        if (!std.math.isFinite(value)) return error.InvalidOptions;
    }
    for ([_]f64{ width, height }) |dimension| {
        if (std.math.isNan(dimension) or dimension < 0) return error.InvalidDimensions;
    }
    // A track beyond the i32 cell range saturates, like paint geometry.
    const track_size = @min(if (options.orientation == 0) width else height, std.math.maxInt(i32)) * 2;
    const range = options.max - options.min;
    if (!std.math.isFinite(range)) return error.InvalidOptions;
    if (range == 0) return .{ .size = track_size, .start = 0 };
    const viewport_size = @max(1, options.viewport_size);
    const content_size = range + viewport_size;
    if (!std.math.isFinite(content_size)) return error.InvalidOptions;
    const size = if (content_size <= viewport_size)
        track_size
    else
        @max(1, @min(@floor(track_size * (viewport_size / content_size)), track_size));
    const distance = options.value - options.min;
    const ratio = distance / range;
    const offset = ratio * (track_size - size);
    if (!std.math.isFinite(distance) or !std.math.isFinite(ratio) or !std.math.isFinite(offset)) return error.InvalidOptions;
    // Math.round ties toward +infinity, retains -0, and does not add 0.5 before flooring.
    const lower = @floor(offset);
    const start = std.math.copysign(if (offset - lower < 0.5) lower else lower + 1, offset);
    if (!std.math.isFinite(start + size)) return error.InvalidOptions;
    return .{ .size = size, .start = start };
}

fn paintSlider(target: *buffer.OptimizedBuffer, options: SliderOptions, layout: Layout, clip: buffer.ClipRect) !void {
    const thumb = try sliderThumb(options, layout.width, layout.height);
    if (clip.width == 0 or clip.height == 0) return;
    const x: i32 = @intFromFloat(layout.screenX);
    const y: i32 = @intFromFloat(layout.screenY);
    const foreground = options.foreground;
    const background = options.background;
    const fill = intersection(.{ .x = x, .y = y, .width = @intFromFloat(layout.width), .height = @intFromFloat(layout.height) }, clip);
    target.fillRect(@intCast(fill.x), @intCast(fill.y), fill.width, fill.height, background);
    const thumb_end = thumb.start + thumb.size;
    const axis = options.orientation;
    const origin = [2]f64{ layout.screenX, layout.screenY };
    const dimensions = [2]f64{ layout.width, layout.height };
    var first = [2]f64{ 0, 0 };
    var end = [2]f64{ @ceil(dimensions[0]), @ceil(dimensions[1]) };
    first[axis] = @max(0, @floor(thumb.start / 2));
    end[axis] = @min(@floor(dimensions[axis]), @ceil(thumb_end / 2));
    for ([_]i32{ clip.x, clip.y }, [_]u32{ clip.width, clip.height }, 0..) |clip_start, clip_size, index| {
        // Truncation maps both (-1, 0) and [0, 1) onto cell zero. Inverse arithmetic
        // can also round across a cell boundary, so include one neighbor on each
        // side and let the buffer clip the actual transformed coordinates.
        const local_start = if (clip_start == 0) @floor(-1 - origin[index]) + 1 else @ceil(@as(f64, @floatFromInt(clip_start)) - origin[index]);
        first[index] = @max(first[index], local_start - 1);
        end[index] = @min(end[index], @ceil(@as(f64, @floatFromInt(@as(i64, clip_start) + clip_size)) - origin[index]) + 1);
        if (first[index] >= end[index]) return;
    }
    const first_cell = [2]u32{ @intFromFloat(first[0]), @intFromFloat(first[1]) };
    const end_cell = [2]u32{ @intFromFloat(end[0]), @intFromFloat(end[1]) };
    var along = first_cell[axis];
    while (along < end_cell[axis]) : (along += 1) {
        const cell_start = @as(f64, @floatFromInt(along)) * 2;
        const start = @max(thumb.start, cell_start);
        const coverage = @min(thumb_end, cell_start + 2) - start;
        const char: u32 = if (coverage >= 2) 0x2588 else if (axis == 0)
            (if (start == cell_start) @as(u32, 0x258c) else 0x2590)
        else if (coverage > 0)
            (if (start == cell_start) @as(u32, 0x2580) else 0x2584)
        else
            ' ';
        var across = first_cell[1 - axis];
        while (across < end_cell[1 - axis]) : (across += 1) {
            const column = if (axis == 0) along else across;
            const row = if (axis == 0) across else along;
            const cell_x: i32 = @intFromFloat(origin[0] + @as(f64, @floatFromInt(column)));
            const cell_y: i32 = @intFromFloat(origin[1] + @as(f64, @floatFromInt(row)));
            if (cell_x < 0 or cell_y < 0) continue;
            target.setCellWithAlphaBlending(@intCast(cell_x), @intCast(cell_y), char, foreground, background, 0);
        }
    }
}

/// Whether a filtering ancestor's selection decides when the node's view is prepared.
fn filteredAncestry(node: *const Node) bool {
    var cursor = node.parent;
    while (cursor) |value| : (cursor = value.scene_node.?.parent) {
        if (value.scene_node.?.filtersChildren()) return true;
    }
    return false;
}

fn sameBox(a: Layout, b: Layout) bool {
    inline for (.{ "left", "top", "right", "bottom", "width", "height" }) |name| {
        if (@as(u32, @bitCast(@field(a, name))) != @as(u32, @bitCast(@field(b, name)))) return false;
    }
    return true;
}

fn rect(layout: Layout) [4]f64 {
    return .{ layout.screenX, layout.screenY, layout.width, layout.height };
}

/// A copy of a scroll node's state, with screen geometry from its last prepared frame.
pub fn scrollReport(value: *const native.NativeRenderable) !api.ot_scene_scroll_state {
    const node = value.scene_node.?;
    const state = node.scroll orelse return error.WrongKind;
    const box = cellLayout(node.layout);
    var report: api.ot_scene_scroll_state = .{
        .struct_size = @sizeOf(api.ot_scene_scroll_state),
        .abi_version = api.OT_CONTEXT_ABI_VERSION,
        .stuck = @intFromBool(state.stuck),
        .changes = state.changes,
        .generation = state.generation,
        .offset = state.offset,
        .max = state.max,
        .content = .{ state.content_origin[0], state.content_origin[1], state.extent[0], state.extent[1] },
        .viewport = rect(scrollViewport(state, box)),
        .bars = undefined,
    };
    for (&report.bars, 0..) |*bar, axis| {
        const rects = state.barRects(axis, box, node.paint.borderSides);
        const thumb = sliderThumb(state.slider(axis), rects.track.width, rects.track.height) catch SliderThumb{ .size = 0, .start = 0 };
        bar.* = .{ .visible = @intFromBool(state.visible[axis]), .reserved = 0, .track = rect(rects.track), .start_arrow = rect(rects.arrows[0]), .end_arrow = rect(rects.arrows[1]), .thumb_start = thumb.start, .thumb_size = thumb.size };
    }
    return report;
}

/// Public geometry advances at legacy preparation points, separately from completed
/// paint layout. Accepted transforms and ancestry still compose immediately.
pub fn getLayout(value: *const native.NativeRenderable) !Layout {
    return composedLayout(value, true);
}

pub fn getPaintLayout(value: *const native.NativeRenderable) !Layout {
    return cellLayout(value.scene_node.?.layout);
}

fn composedLayout(value: *const native.NativeRenderable, comptime observed: bool) !Layout {
    var ancestors: [yoga.depth_max]*const native.NativeRenderable = undefined;
    var count: usize = 0;
    var cursor: ?*const native.NativeRenderable = value;
    while (cursor) |node| : (cursor = node.scene_node.?.parent) {
        if (count == ancestors.len) return error.YogaDepthLimit;
        ancestors[count] = node;
        count += 1;
    }
    var result = if (observed) value.scene_node.?.observed_layout else value.scene_node.?.layout;
    result.screenX = 0;
    result.screenY = 0;
    while (count != 0) {
        count -= 1;
        const node = ancestors[count].scene_node.?;
        const layout = if (observed) node.observed_layout else node.layout;
        result.screenX = result.screenX + @as(f64, layout.left) + node.paint.translateX;
        result.screenY = result.screenY + @as(f64, layout.top) + node.paint.translateY;
        if (count != 0) {
            const origin = childOrigin(node, .{});
            result.screenX += origin[0];
            result.screenY += origin[1];
        }
    }
    return result;
}

/// Where a parent's children compose from: its screen position, plus a scroll node's viewport
/// and content origins minus its offset.
fn childOrigin(node: *const Node, parent: Layout) [2]f64 {
    const state = node.scroll orelse return .{ parent.screenX, parent.screenY };
    return .{ parent.screenX + state.content_origin[0] - state.offset[0], parent.screenY + state.content_origin[1] - state.offset[1] };
}

/// A scroll node's viewport rect in screen cells, from the node's prepared layout.
fn scrollViewport(state: *const ScrollState, box: Layout) Layout {
    var viewport = state.viewport;
    viewport.screenX = box.screenX + viewport.left;
    viewport.screenY = box.screenY + viewport.top;
    return viewport;
}

fn cellClip(layout: Layout) buffer.ClipRect {
    const cells = cellLayout(layout);
    return .{ .x = @intFromFloat(cells.screenX), .y = @intFromFloat(cells.screenY), .width = @intFromFloat(@max(0, cells.width)), .height = @intFromFloat(@max(0, cells.height)) };
}

fn prepareView(work: *renderer.FrameWork, node: *Node, layout: Layout) !void {
    work.view_preparations += 1;
    if (node.kind == api.OT_SCENE_TEXT_VIEW) {
        const text_view = node.control.text_view.view orelse return;
        var viewport = text_view.view.getViewport() orelse text_buffer_view.Viewport{ .x = 0, .y = 0, .width = 0, .height = 0 };
        viewport.width = cellSize(layout.width);
        viewport.height = cellSize(layout.height);
        text_view.view.setViewport(viewport);
        try text_view.prepareView();
        return;
    }
    if (node.editor) |editor| {
        const width = cellSize(layout.width);
        const height = cellSize(layout.height);
        const viewport = editor.view.getViewport();
        if (viewport == null or viewport.?.width != width or viewport.?.height != height) {
            editor.view.setViewportSize(width, height);
        }
        _ = editor.view.getVirtualLines();
        const view = editor.view.getTextBufferView();
        if (view.virtual_lines_dirty or (view.truncate and view.viewport != null and !view.truncation_applied)) {
            return error.OutOfMemory;
        }
        return;
    }
    const text = node.text orelse return;
    var viewport: text_buffer_view.Viewport = text.view.getViewport() orelse text.initial_viewport orelse .{ .x = 0, .y = 0, .width = 0, .height = 0 };
    viewport.width = cellSize(layout.width);
    viewport.height = cellSize(layout.height);
    text.view.setViewport(viewport);
    try text.prepareView();
    text.initial_viewport = null;
}

/// Whether preparing a text or text view node's view at this layout would change it.
fn viewNeedsPrepare(node: *const Node, layout: Layout) bool {
    const view = if (node.kind == api.OT_SCENE_TEXT_VIEW) (node.control.text_view.view orelse return false).view else (node.text orelse return false).view;
    const viewport = view.getViewport() orelse return true;
    return viewport.width != cellSize(layout.width) or viewport.height != cellSize(layout.height) or view.needsPrepare();
}

fn overlaps(filter: Filter, layout: Layout) bool {
    const viewport = filter.viewport;
    if (viewport.width <= 0 or viewport.height <= 0) return false;
    if (filter.row) {
        return layout.screenX < viewport.screenX + viewport.width and layout.screenX + layout.width > viewport.screenX and
            layout.screenY <= viewport.screenY + viewport.height and layout.screenY + layout.height >= viewport.screenY;
    }
    return layout.screenY < viewport.screenY + viewport.height and layout.screenY + layout.height > viewport.screenY and
        layout.screenX <= viewport.screenX + viewport.width and layout.screenX + layout.width >= viewport.screenX;
}

fn removeChild(children: *std.ArrayListUnmanaged(*native.NativeRenderable), value: *native.NativeRenderable) void {
    for (children.items, 0..) |child, index| {
        if (child == value) {
            _ = children.orderedRemove(index);
            return;
        }
    }
    unreachable;
}

fn paintLessThan(_: void, left: *native.NativeRenderable, right: *native.NativeRenderable) bool {
    const a = left.scene_node.?;
    const b = right.scene_node.?;
    if (builtin.is_test) a.owner.test_sort_steps += 1;
    return if (a.paint.zIndex == b.paint.zIndex) a.paint_rank < b.paint_rank else a.paint.zIndex < b.paint.zIndex;
}

/// Returns whether the order changed.
fn sortChildren(node: *Node, frame_id: u64) bool {
    // Feedback reruns refresh geometry, not sibling order already selected for this frame.
    if (node.child_order_frame == frame_id) return false;
    node.child_order_frame = frame_id;
    if (!node.sort_dirty) return false;
    // Ranks increase along the children, so equal z keeps their order.
    std.mem.sort(*native.NativeRenderable, node.paint_children.items, {}, paintLessThan);
    for (node.paint_children.items, 0..) |child, index| {
        if (builtin.is_test) node.owner.test_sort_steps += 1;
        child.scene_node.?.paint_rank = index;
    }
    node.sort_dirty = false;
    return true;
}

/// Every field counts; layouts compare bitwise, so NaN layouts are equal.
fn sameEntries(first: []const Work, second: []const Work) bool {
    comptime std.debug.assert(@sizeOf(Layout) == 6 * @sizeOf(f32) + 2 * @sizeOf(f64));
    if (first.len != second.len) return false;
    for (first, second) |a, b| {
        if (!std.mem.eql(u8, std.mem.asBytes(&a.layout), std.mem.asBytes(&b.layout))) return false;
        var rest = .{ a, b };
        rest[0].layout = .{};
        rest[1].layout = .{};
        if (!std.meta.eql(rest[0], rest[1])) return false;
    }
    return true;
}

const BatchKey = enum { rank, placement };

fn batchKey(entry: Feedback, comptime key: BatchKey) u64 {
    return if (key == .rank) entry.rank else entry.placement;
}

fn keyGreaterThan(comptime key: BatchKey) fn (*Scene, Feedback, Feedback) bool {
    return struct {
        fn greater(owner: *Scene, left: Feedback, right: Feedback) bool {
            if (builtin.is_test) owner.test_sort_steps += 1;
            return batchKey(left, key) > batchKey(right, key);
        }
    }.greater;
}

/// Paint, clip, and hit geometry use i32 cells. An axis outside them keeps the truncated cells that paint covers
/// within 2^22 of the origin, at least one, so no node moves onto a terminal and every visible edge stays exact.
/// NaN, Yoga's f32 overflow, lands off screen with its subtree.
pub fn cellLayout(layout: Layout) Layout {
    var cells = layout;
    cellAxis(&cells.screenX, &cells.width);
    cellAxis(&cells.screenY, &cells.height);
    return cells;
}

fn cellAxis(start: *f64, size: *f32) void {
    const end = start.* + size.*;
    if (start.* >= std.math.minInt(i32) and end <= std.math.maxInt(i32) and @as(f64, size.*) <= std.math.maxInt(i32)) return;
    // f32 holds every integer up to 2^24, so the clamped size is exact.
    const bound: f64 = 1 << 22;
    const first = @trunc(start.*);
    start.* = @min(@max(first, -bound), bound - 1);
    size.* = @floatCast(@min(@max(first + @trunc(@as(f64, size.*)), start.* + 1), bound) - start.*);
}

/// A view or request size in cells; Yoga sizes can exceed u32.
fn cellSize(size: f32) u32 {
    return @intFromFloat(@min(size, 0x7fff_ff80));
}

/// Whether a band meets the rows; bands are sorted and disjoint, so rows outside their hull
/// meet none.
fn bandsMeet(bands: []const Band, rows: Band) bool {
    if (bands.len == 0 or rows.bottom <= bands[0].top or rows.top >= bands[bands.len - 1].bottom) return false;
    for (bands) |band| if (band.meets(rows)) return true;
    return false;
}

/// A clip's part on a band's rows; a band past the clip leaves no rows.
fn bandClip(clip: buffer.ClipRect, band: Band) buffer.ClipRect {
    const top = @max(@as(i64, clip.y), band.top);
    const bottom = @min(@as(i64, clip.y) + clip.height, band.bottom);
    return .{ .x = clip.x, .y = @intCast(top), .width = clip.width, .height = @intCast(@max(0, bottom - top)) };
}

/// The rows that `a` or `b` covers; an empty rect covers none.
fn rowSpan(a: buffer.ClipRect, b: buffer.ClipRect) buffer.ClipRect {
    if (b.height == 0) return a;
    if (a.height == 0) return b;
    const top = @min(a.y, b.y);
    return .{ .x = a.x, .y = top, .width = a.width, .height = @intCast(@max(a.y + @as(i64, a.height), b.y + @as(i64, b.height)) - top) };
}

fn intersection(a: buffer.ClipRect, b: buffer.ClipRect) buffer.ClipRect {
    const x: i64 = @max(a.x, b.x);
    const y: i64 = @max(a.y, b.y);
    const end_x = @min(@as(i64, a.x) + a.width, @as(i64, b.x) + b.width);
    const end_y = @min(@as(i64, a.y) + a.height, @as(i64, b.y) + b.height);
    if (x >= end_x or y >= end_y) return .{ .x = 0, .y = 0, .width = 0, .height = 0 };
    return .{ .x = @intCast(x), .y = @intCast(y), .width = @intCast(end_x - x), .height = @intCast(end_y - y) };
}

const arrows = [4][]const u8{ "\u{25b2}", "\u{25bc}", "\u{25c0}", "\u{25b6}" };

const borders = [4][11]u32{
    .{ 0x250c, 0x2510, 0x2514, 0x2518, 0x2500, 0x2502, 0x252c, 0x2534, 0x251c, 0x2524, 0x253c },
    .{ 0x2554, 0x2557, 0x255a, 0x255d, 0x2550, 0x2551, 0x2566, 0x2569, 0x2560, 0x2563, 0x256c },
    .{ 0x256d, 0x256e, 0x2570, 0x256f, 0x2500, 0x2502, 0x252c, 0x2534, 0x251c, 0x2524, 0x253c },
    .{ 0x250f, 0x2513, 0x2517, 0x251b, 0x2501, 0x2503, 0x2533, 0x253b, 0x2523, 0x252b, 0x254b },
};
