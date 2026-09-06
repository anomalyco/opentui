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

pub const TextOptions = struct {
    foreground: ansi.RGBA = .{ 255, 255, 255, 255 },
    background: ansi.RGBA = .{ 0, 0, 0, 0 },
    attributes: u32 = 0,
    wrap_mode: text_buffer_view.WrapMode = .word,
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
    mouse_pointer: u32 = 6,
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
    membership_epoch: u64,
    destination: BufferIdentity,
};

const Attempt = struct {
    root: handles.Handle,
    frame_id: u64,
    options: FrameOptions,
    rounds: u32 = 0,
    filter_selected: bool = false,
    requests: u32 = 0,
    request_id: u64 = 0,
    pending: ?FrameRequest = null,
    remaining_work: u32,
    bounded_work: bool,
    feedback_work_remaining: usize = 0,
    preparing: enum { none, traversal, views } = .none,
    prepare_depth: usize = 0,
    prepare_cursor: usize = 0,
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
            1 => if (self.box) |details| details.destroy(allocator),
            4 => self.arrow.deinit(allocator),
            8 => self.image.deinit(),
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
    paint_rank: u32 = 0,
    sort_dirty: bool = false,
    child_order_frame: u64 = 0,
    layout_flags: packed struct {
        // Newly placed hidden children expose geometry once, without paint membership.
        needs_layout: bool = true,
        display_none: bool = false,
        clips_children: bool = false,
    } = .{},
    paint: Paint = .{},
    layout: Layout = .{},
    observed_layout: Layout = .{},
    viewport: ?handles.Handle = null,
    focus_frame: u64 = 0,
    text: ?*Text = null,
    editor: ?*Editor = null,
    measure_overridden: bool = false,
    control: Control = .{ .slider = .{} },
    hook_flags: u32 = 0,
    hook_generation: u64 = 0,
    update_frame: u64 = 0,
    observed_frame: u64 = 0,
    observed_round: u32 = 0,
    prepared_frame: u64 = 0,
    prepared_round: u32 = 0,
    feedback_state: enum { unseen, queued, started } = .unseen,
    placement: u64 = 0,
    resize_width: f64 = 0,
    resize_height: f64 = 0,
};

const Work = struct {
    node: *native.NativeRenderable,
    layout: Layout,
    clip: buffer.ClipRect,
    opacity: f32,
    visible: bool,
    filtered: bool,
};

const Prepared = struct {
    node: handles.Handle,
    layout: Layout,
    clip: buffer.ClipRect,
    opacity: f32,
    visible: bool,
    filtered: bool,
};

fn PreparationFrame(comptime retained: bool) type {
    return struct {
        node: if (retained) handles.Handle else *native.NativeRenderable,
        parent: Layout,
        clip: buffer.ClipRect,
        opacity: f32,
        child: usize = 0,
        entered: bool = false,
        filtered: bool = false,
        filter: ?Filter = null,
    };
}

const PaintMember = struct {
    node: handles.Handle,
    clip: buffer.ClipRect,
    opacity: f32,
    filtered: bool,
};

const Prefix = struct {
    destination: BufferIdentity,
    membership_epoch: u64,
    remaining: u32,
    cursor: u32 = 0,
    phase: enum { before, self, after, hit } = .before,
    editor_cursor_pending: bool = false,
    text_paint_pending: bool = false,
    text_paint_selected: bool = false,
    image_native_pending: bool = false,
    removed: ?struct {
        kind: u32,
        layout: Layout,
        paint: Paint,
        control: Control,
        hook_flags: u32,
        hook_generation: u64,
        num: u32,
        token: u32,
    } = null,
};

const Filter = struct {
    viewport: Layout,
    row: bool,
};

const Feedback = struct {
    node: handles.Handle,
    kind: enum { update, refresh, prepass, placed, children, filtered_refresh, select },
    placement: u64 = 0,
    parent: ?handles.Handle = null,
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
    focus: ?handles.Handle = null,
    // Do not hide host-managed cursors in scenes that have not placed an editor cursor.
    editor_cursor_owned: bool = false,
    last_token: u32 = 0,
    last_placement: u64 = 0,
    tokens: std.AutoHashMapUnmanaged(u32, handles.Handle) = .empty,
    style_node: yoga.YGNodeRef,
    work: std.ArrayListUnmanaged(Work) = .empty,
    prepared: std.ArrayListUnmanaged(Prepared) = .empty,
    preparation_stack: std.ArrayListUnmanaged(PreparationFrame(true)) = .empty,
    // Incomplete frames retain only handles; completed unbudgeted frames may reuse work.
    feedback: std.ArrayListUnmanaged(Feedback) = .empty,
    paint_members: std.ArrayListUnmanaged(PaintMember) = .empty,
    prefix: ?Prefix = null,
    attempt: ?Attempt = null,
    painted: ?Painted = null,
    cancelled_paint: bool = false,
    membership_epoch: u64 = 0,
    last_frame_id: u64 = 0,
    layout_epoch: u64 = 0,
    solve_frame: u64 = 0,
    solve_round: u32 = 0,
    layout_pending: bool = false,
    layout_width: u32 = 0,
    layout_height: u32 = 0,
    preparation_dirty: bool = true,
    test_prepare_steps: if (builtin.is_test) u64 else void = if (builtin.is_test) 0 else {},
    test_geometry_reads: if (builtin.is_test) u64 else void = if (builtin.is_test) 0 else {},
    test_style_reads: if (builtin.is_test) u64 else void = if (builtin.is_test) 0 else {},
    test_visibility_steps: if (builtin.is_test) u64 else void = if (builtin.is_test) 0 else {},
    test_sort_steps: if (builtin.is_test) u64 else void = if (builtin.is_test) 0 else {},
    test_filtered_refresh_steps: if (builtin.is_test) u64 else void = if (builtin.is_test) 0 else {},
    test_paint_setups: if (builtin.is_test) u64 else void = if (builtin.is_test) 0 else {},

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
        std.debug.assert(self.painted == null and self.prefix == null);
        std.debug.assert(self.focus == null);
        yoga.yogaNodeFree(self.style_node);
        self.tokens.deinit(self.allocator);
        self.work.deinit(self.allocator);
        self.prepared.deinit(self.allocator);
        self.preparation_stack.deinit(self.allocator);
        self.feedback.deinit(self.allocator);
        self.paint_members.deinit(self.allocator);
        self.allocator.destroy(self);
    }

    pub fn prepareInsert(self: *Scene, kind: u32, num: u32) !void {
        if (kind > 8 or num == 0) return error.InvalidOptions;
        if (kind == 0 and self.root != null) return error.SceneAlreadyAttached;
        if (self.last_token == std.math.maxInt(u32)) return error.ObjectLimit;
        try self.tokens.ensureUnusedCapacity(self.allocator, 1);
    }

    pub fn insert(self: *Scene, storage: native.NodeStorage, handle: handles.Handle, kind: u32, num: u32) void {
        const value = storage.node;
        self.last_token += 1;
        value.scene_node = .{
            .owner = self,
            .handle = handle,
            .kind = kind,
            .num = num,
            .token = self.last_token,
            .next = self.head,
            .children = storage.children,
            .paint_children = storage.paint_children,
        };
        if (kind == 1) value.scene_node.?.control = .{ .box = null };
        if (kind == 4) value.scene_node.?.control = .{ .arrow = .{} };
        if (kind == 5) value.scene_node.?.control = .{ .editor = .{} };
        if (kind == 7) value.scene_node.?.control = .{ .text_view = .{} };
        if (kind == 8) value.scene_node.?.control = .{ .image = .{} };
        if (self.head) |head| head.scene_node.?.previous = value;
        self.head = value;
        self.count += 1;
        self.tokens.putAssumeCapacity(self.last_token, handle);
        if (kind == 0) self.root = value;
        self.preparation_dirty = true;
        self.work.clearRetainingCapacity();
    }

    pub fn move(self: *Scene, value: *native.NativeRenderable, destination: ?*native.NativeRenderable, index: u32) !void {
        const node = &value.scene_node.?;
        if (node.kind == 0) return error.YogaInvalidArgument;
        const reparented = node.parent != destination;
        const new_placement = destination != null and (reparented or node.placement == 0);
        if (new_placement and self.last_placement == std.math.maxInt(u64)) return error.ObjectLimit;
        if (destination) |parent| {
            const target = &parent.scene_node.?;
            if (target.owner != self) return error.WrongSession;
            if (index > target.children.items.len - @intFromBool(node.parent == parent)) return error.YogaInvalidArgument;
            if (node.parent != parent) {
                try target.children.ensureUnusedCapacity(self.allocator, 1);
                try target.paint_children.ensureUnusedCapacity(self.allocator, 1);
            }
            try yoga.check(yoga.yogaNodeMoveChildChecked(parent.yoga_node, value.yoga_node, index));
            const previous = node.parent;
            if (previous) |old| removeChild(&old.scene_node.?.children, value);
            target.children.insertAssumeCapacity(index, value);
            if (previous != parent) {
                if (previous) |old| removeChild(&old.scene_node.?.paint_children, value);
                const siblings = target.paint_children.items;
                if (siblings.len != 0 and siblings[siblings.len - 1].scene_node.?.paint.zIndex > node.paint.zIndex) {
                    target.sort_dirty = true;
                }
                target.paint_children.appendAssumeCapacity(value);
            }
            node.parent = parent;
        } else {
            if (index != 0) return error.YogaInvalidArgument;
            if (node.parent) |old| {
                try yoga.check(yoga.yogaNodeRemoveChildChecked(old.yoga_node, value.yoga_node));
                removeChild(&old.scene_node.?.children, value);
                removeChild(&old.scene_node.?.paint_children, value);
                node.parent = null;
            }
        }
        if (self.attempt) |active| {
            if (reparented and node.prepared_frame == active.frame_id and
                node.prepared_round == active.rounds and node.feedback_state == .queued)
            {
                // Unstarted work follows accepted parentage; an entered node keeps its continuation.
                for (self.feedback.items, 0..) |operation, queued_index| {
                    if (operation.kind == .update and std.meta.eql(operation.node, node.handle)) {
                        _ = self.feedback.orderedRemove(queued_index);
                        node.feedback_state = .unseen;
                        break;
                    }
                } else unreachable;
            }
        }
        // Work is transient; an active paint prefix keeps only qualified handles.
        if (new_placement) {
            self.last_placement += 1;
            node.placement = self.last_placement;
        } else if (destination == null) node.placement = 0;
        node.layout_flags.needs_layout = true;
        self.preparation_dirty = true;
        self.work.clearRetainingCapacity();
    }

    pub fn remove(self: *Scene, value: *native.NativeRenderable) native.NodeStorage {
        const node = &value.scene_node.?;
        if (self.prefix) |*prefix| {
            // Future destroyed entries skip; an entered node finishes its paint phases.
            if (prefix.phase != .before and std.meta.eql(self.paint_members.items[prefix.cursor].node, node.handle)) {
                std.debug.assert(node.kind != 0);
                prefix.removed = .{
                    .kind = node.kind,
                    .layout = node.layout,
                    .paint = node.paint,
                    .control = node.control,
                    .hook_flags = node.hook_flags,
                    .hook_generation = node.hook_generation,
                    .num = node.num,
                    .token = node.token,
                };
                // The entered render() continuation now owns the copied title bytes.
                if (node.kind == 1) node.control.box = null;
                if (node.kind == 4) node.control.arrow.text = null;
                if (node.kind == 8) node.control.image = .{};
            }
        }
        node.control.deinit(node.kind, self.allocator);
        if (node.parent) |parent| {
            yoga.yogaNodeRemoveChild(parent.yoga_node, value.yoga_node);
            removeChild(&parent.scene_node.?.children, value);
            removeChild(&parent.scene_node.?.paint_children, value);
        }
        // Bulk detachment avoids repeated shifting of a wide Yoga child vector.
        yoga.check(yoga.yogaNodeRemoveAllChildrenChecked(value.yoga_node)) catch unreachable;
        for (node.children.items) |child| {
            child.scene_node.?.parent = null;
            child.scene_node.?.placement = 0;
        }
        node.children.clearRetainingCapacity();
        node.paint_children.clearRetainingCapacity();
        if (node.previous) |previous| previous.scene_node.?.next = node.next else self.head = node.next;
        if (node.next) |next| next.scene_node.?.previous = node.previous;
        if (self.root == value) {
            self.root = null;
            self.layout_pending = false;
            // A pending paint scope retains its bytes until resume or explicit cancel.
            if (self.attempt != null and self.prefix == null) self.cancelFrame();
        }
        const removed = self.tokens.remove(node.token);
        std.debug.assert(removed);
        self.count -= 1;
        self.hook_count -= @intFromBool(node.hook_flags & ~@as(u32, 64) != 0);
        self.layout_hook_count -= @intFromBool(node.hook_flags & 7 != 0);
        self.filter_count -= @intFromBool(node.viewport != null);
        if (self.focus) |focused| {
            if (std.meta.eql(focused, node.handle)) self.focus = null;
        }
        self.preparation_dirty = true;
        self.work.clearRetainingCapacity();
        const storage: native.NodeStorage = .{ .node = value, .children = node.children, .paint_children = node.paint_children };
        value.scene_node = null;
        return storage;
    }

    /// Before Session teardown, detach every edge once. Subsequent node releases
    /// are allocation-free and do not scan the registry or shift sibling arrays.
    pub fn detachAll(self: *Scene) void {
        self.cancelFrame();
        var cursor = self.head;
        while (cursor) |value| : (cursor = value.scene_node.?.next) {
            yoga.check(yoga.yogaNodeRemoveAllChildrenChecked(value.yoga_node)) catch unreachable;
            value.scene_node.?.parent = null;
            value.scene_node.?.placement = 0;
            value.scene_node.?.children.clearRetainingCapacity();
            value.scene_node.?.paint_children.clearRetainingCapacity();
        }
    }

    pub fn setPaint(self: *Scene, value: *native.NativeRenderable, paint: Paint) !void {
        try buffer.validateColor(paint.background);
        try buffer.validateColor(paint.borderColor);
        try buffer.validateColor(paint.focusedBorderColor);
        if (!std.math.isFinite(paint.opacity) or paint.opacity < 0 or paint.opacity > 1 or
            !std.math.isFinite(paint.translateX) or !std.math.isFinite(paint.translateY) or
            paint.borderSides > 15 or paint.shouldFill > 1 or paint.borderStyle > 3)
        {
            return error.InvalidOptions;
        }
        const node = &value.scene_node.?;
        if (node.kind != 1 and paint.borderSides != 0) return error.InvalidOptions;
        // Check even a paint-only change against a poisoned/active Yoga owner.
        try yoga.check(yoga.nodeTeardownStatus(value.yoga_node));
        var unused: u32 = 0;
        try yoga.check(yoga.yogaNodeIsDirtyChecked(value.yoga_node, &unused));
        if (node.paint.borderSides != paint.borderSides) {
            // Only the final copy publishes; rejected preparation changes scratch style alone.
            try yoga.check(yoga.yogaNodeCopyStyleChecked(self.style_node, value.yoga_node));
            for ([_]u32{ 1, 8, 4, 2 }, 0..) |side, edge| {
                try yoga.check(yoga.yogaNodeStyleSetBorderChecked(self.style_node, @intCast(edge), if (paint.borderSides & side != 0) 1 else 0));
            }
            try yoga.check(yoga.yogaNodeCopyStyleChecked(value.yoga_node, self.style_node));
        }
        if (node.paint.zIndex != paint.zIndex) {
            if (node.parent) |parent| parent.scene_node.?.sort_dirty = true;
        }
        if (self.attempt) |active| {
            if ((active.filter_selected or active.preparing != .none) and (node.paint.translateX != paint.translateX or node.paint.translateY != paint.translateY)) {
                // Restart retained geometry or refresh newly revealed descendants before paint.
                self.preparation_dirty = true;
            }
        }
        if (self.prefix != null) {
            // Legacy transform setters refresh this node's cache, not descendants.
            if (node.paint.translateX != paint.translateX) {
                const parent_x = if (node.parent) |parent| parent.scene_node.?.layout.screenX else 0;
                node.layout.screenX = parent_x + @as(f64, node.layout.left) + paint.translateX;
            }
            if (node.paint.translateY != paint.translateY) {
                const parent_y = if (node.parent) |parent| parent.scene_node.?.layout.screenY else 0;
                node.layout.screenY = parent_y + @as(f64, node.layout.top) + paint.translateY;
            }
        }
        if (self.attempt != null or node.paint.zIndex != paint.zIndex or
            node.paint.opacity != paint.opacity or node.paint.translateX != paint.translateX or
            node.paint.translateY != paint.translateY or node.paint.borderSides != paint.borderSides)
        {
            self.work.clearRetainingCapacity();
        }
        node.paint = paint;
    }

    pub fn setBoxDetails(self: *Scene, value: *native.NativeRenderable, options: BoxDetails) !void {
        const node = if (value.scene_node) |*state| state else return error.WrongKind;
        if (node.owner != self) return error.WrongSession;
        if (node.kind != 1) return error.WrongKind;
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
        try yoga.check(yoga.nodeTeardownStatus(value.yoga_node));
        var unused: u32 = 0;
        try yoga.check(yoga.yogaNodeIsDirtyChecked(value.yoga_node, &unused));
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
        const node = &value.scene_node.?;
        if (flags & ~@as(u32, 255) != 0 or generation == 0 or flags & 65 == 65 or
            (flags & 184 != 0 and node.kind == 0) or
            (flags & 128 != 0 and (flags & 32 == 0 or node.kind != 7)) or
            (flags & 8 != 0 and flags & 32 == 0 and (node.kind == 2 or node.kind == 5 or node.kind == 7)) or
            (flags & 4 != 0 and node.kind != 0)) return error.InvalidOptions;
        for ([_]f64{ initial_width, initial_height }) |dimension| {
            if (!std.math.isFinite(dimension) or dimension < 0 or dimension > std.math.maxInt(i32)) return error.InvalidDimensions;
        }
        if (generation <= node.hook_generation) return error.StaleFrame;
        if (node.observed_frame == 0) {
            if (node.kind == 3) _ = try sliderThumb(node.control.slider, initial_width, initial_height);
            node.resize_width = initial_width;
            node.resize_height = initial_height;
        }
        self.hook_count -= @intFromBool(node.hook_flags & ~@as(u32, 64) != 0);
        self.hook_count += @intFromBool(flags & ~@as(u32, 64) != 0);
        self.layout_hook_count -= @intFromBool(node.hook_flags & 7 != 0);
        self.layout_hook_count += @intFromBool(flags & 7 != 0);
        node.hook_flags = flags;
        node.hook_generation = generation;
        self.preparation_dirty = true;
        self.work.clearRetainingCapacity();
    }

    pub fn cancelFrame(self: *Scene) void {
        if (self.painted != null or self.prefix != null) self.cancelled_paint = true;
        self.painted = null;
        if (self.prefix) |prefix| {
            if (prefix.removed) |removed| {
                removed.control.deinit(removed.kind, self.allocator);
            }
        }
        self.prefix = null;
        self.attempt = null;
        self.feedback.clearRetainingCapacity();
        self.paint_members.clearRetainingCapacity();
        self.work.clearRetainingCapacity();
        self.prepared.clearRetainingCapacity();
        self.preparation_stack.clearRetainingCapacity();
    }

    pub fn checkPainted(self: *Scene, ticket: FrameRequest) error{ WrongContext, WrongSession, StaleFrame }!*Painted {
        if (ticket.session.context_id != self.session.context_id) return error.WrongContext;
        if (!std.meta.eql(ticket.session, self.session)) return error.WrongSession;
        const painted = if (self.painted) |*value| value else return error.StaleFrame;
        if (!std.meta.eql(ticket, painted.ticket)) return error.StaleFrame;
        return painted;
    }

    /// Lease authority follows the issued request, not the node's current hooks.
    /// Context additionally checks the destination and releases scopes before resume.
    pub fn checkFrameAccess(self: *Scene, ticket: FrameRequest) error{ WrongContext, WrongSession, StaleFrame }!Painted {
        if (ticket.kind == 0) return (try self.checkPainted(ticket)).*;
        if (ticket.session.context_id != self.session.context_id) return error.WrongContext;
        if (!std.meta.eql(ticket.session, self.session)) return error.WrongSession;
        const prefix = self.prefix orelse return error.StaleFrame;
        const pending = (self.attempt orelse return error.StaleFrame).pending orelse return error.StaleFrame;
        if (!std.meta.eql(ticket, pending)) return error.StaleFrame;
        if (ticket.kind != 4 and ticket.kind != 5 and ticket.kind != 7) return error.StaleFrame;
        return .{ .ticket = ticket, .membership_epoch = prefix.membership_epoch, .destination = prefix.destination };
    }

    pub fn selectTextViewPaint(self: *Scene, value: *native.NativeRenderable, ticket: FrameRequest, enabled: bool) !void {
        const node = &value.scene_node.?;
        if (node.kind != 7) return error.WrongKind;
        _ = try self.checkFrameAccess(ticket);
        if (ticket.kind != 7 or !std.meta.eql(ticket.node, node.handle)) return error.StaleFrame;
        const prefix = &self.prefix.?;
        if (prefix.phase != .after or prefix.removed != null or prefix.text_paint_selected) return error.StaleFrame;
        prefix.text_paint_pending = enabled;
        prefix.text_paint_selected = true;
    }

    pub fn requalifyPainted(self: *Scene, cli: *renderer.CliRenderer) void {
        if (self.painted) |*painted| painted.destination = BufferIdentity.init(cli.getNextBuffer());
        if (self.prefix) |*prefix| prefix.destination = BufferIdentity.init(cli.getNextBuffer());
    }

    pub fn isPainting(self: *const Scene) bool {
        return self.prefix != null;
    }

    pub fn isYielded(self: *const Scene) bool {
        const active = self.attempt orelse return false;
        const pending = active.pending orelse return false;
        return pending.kind == 6;
    }

    /// Limits stay fixed; paint options can change on a checked acknowledgement.
    /// Validate the complete ticket before resolving any ticket node or consuming work.
    pub fn frameStep(self: *Scene, objects: *const handles.Table, cli: *renderer.CliRenderer, previous: ?FrameRequest, options: FrameOptions, allow_host: bool) !FrameRequest {
        return self.frameStepWorkBudgeted(objects, cli, previous, options, allow_host, std.math.maxInt(u32), std.math.maxInt(u32));
    }

    pub fn frameStepWorkBudgeted(self: *Scene, objects: *const handles.Table, cli: *renderer.CliRenderer, previous: ?FrameRequest, options: FrameOptions, allow_host: bool, max_paint_members: u32, max_work_items: u32) !FrameRequest {
        errdefer self.work.clearRetainingCapacity();
        try buffer.validateColor(options.background);
        if (max_paint_members == 0 or max_work_items == 0) return error.InvalidOptions;
        // Reject before solving: a rejected one-call paint must not consume layout notifications.
        if (!allow_host and self.hook_count != 0) return error.UnsupportedResource;
        if (previous) |reply| {
            if (reply.session.context_id != self.session.context_id) return error.WrongContext;
            if (!std.meta.eql(reply.session, self.session)) return error.WrongSession;
            const active = self.attempt orelse return error.StaleFrame;
            const pending = active.pending orelse return error.StaleFrame;
            if (!std.meta.eql(reply, pending)) return error.StaleFrame;
            if (options.max_layout_rounds != active.options.max_layout_rounds or
                options.max_host_requests != active.options.max_host_requests) return error.InvalidOptions;
            if (self.prefix) |*prefix| {
                prefix.remaining = if (reply.kind == 6) max_paint_members else @min(prefix.remaining, max_paint_members);
            }
            self.attempt.?.remaining_work = if (reply.kind == 6) max_work_items else @min(active.remaining_work, max_work_items);
            self.attempt.?.bounded_work = max_work_items != std.math.maxInt(u32) or (reply.kind != 6 and active.bounded_work);
            self.attempt.?.options = options;
            self.attempt.?.pending = null;
        } else {
            if (self.attempt != null or self.painted != null) return error.FrameBusy;
            if (options.max_layout_rounds == 0 or options.max_host_requests == 0) return error.InvalidOptions;
            const frame_id = std.math.add(u64, self.last_frame_id, 1) catch return error.RequestLimit;
            self.attempt = .{
                .root = if (self.root) |root| root.scene_node.?.handle else std.mem.zeroes(handles.Handle),
                .frame_id = frame_id,
                .options = options,
                .remaining_work = max_work_items,
                .bounded_work = max_work_items != std.math.maxInt(u32),
            };
            self.last_frame_id = frame_id;
        }
        errdefer {
            if (self.editor_cursor_owned) {
                cli.terminal.setCursorPosition(1, 1, false);
                self.editor_cursor_owned = false;
            }
            if (self.prefix != null) {
                cli.getNextBuffer().clearScissorRects();
                cli.getNextBuffer().clearOpacity();
                @memset(cli.nextHitGrid, 0);
            }
            self.cancelFrame();
        }
        defer if (self.attempt != null) self.work.clearRetainingCapacity();
        const active = &self.attempt.?;
        const reusable_work = active.request_id == 0 and !active.bounded_work and
            max_paint_members == std.math.maxInt(u32) and self.hook_count == 0 and self.filter_count == 0;
        const root = if (active.root.context_id != 0) blk: {
            const value = objects.get(active.root, .native_renderable, native.NativeRenderable) catch return error.StaleFrame;
            if (self.root != value or value.scene_node == null or value.scene_node.?.owner != self) return error.StaleFrame;
            break :blk value;
        } else null;
        if (self.prefix) |prefix| {
            if (!prefix.destination.matches(cli.getNextBuffer())) return error.StaleFrame;
            if (try self.continuePaint(objects, cli)) |request_value| return request_value;
            return self.finishPaint(cli, prefix.membership_epoch, false);
        }
        const restart_feedback = previous != null and previous.?.kind == 6 and
            active.preparing == .none and active.feedback_work_remaining == 0 and
            (self.preparation_dirty or try self.needsSolve(cli, root));
        if (active.rounds == 0 or active.preparing != .none or restart_feedback) {
            if (!try self.prepareRound(objects, cli, root, reusable_work)) return self.request(&root.?.scene_node.?, 6);
        }
        while (true) {
            if (self.layout_pending) {
                if (root) |value| {
                    if (value.scene_node.?.hook_flags & 4 != 0 and try self.isVisibleMember(value)) {
                        const result = try self.request(&value.scene_node.?, 3);
                        self.layout_pending = false;
                        return result;
                    }
                }
                self.layout_pending = false;
            }
            // No host call or scene mutation intervenes while this proof is reused.
            var visible_member: ?*native.NativeRenderable = null;
            while (self.feedback.items.len != 0) {
                if (active.remaining_work == 0) return self.request(&root.?.scene_node.?, 6);
                active.remaining_work -= 1;
                active.feedback_work_remaining -|= 1;
                const operation = self.feedback.pop().?;
                if (builtin.is_test and operation.kind == .filtered_refresh) self.test_filtered_refresh_steps += 1;
                const value = objects.get(operation.node, .native_renderable, native.NativeRenderable) catch continue;
                if (value.scene_node == null or value.scene_node.?.owner != self) continue;
                const node = &value.scene_node.?;
                if (operation.kind == .update) node.feedback_state = .unseen;
                const member = if (operation.kind == .filtered_refresh) blk: {
                    const parent = node.parent orelse continue;
                    if (!std.meta.eql(parent.scene_node.?.handle, operation.parent.?)) continue;
                    break :blk parent;
                } else if (operation.kind == .placed) blk: {
                    if (node.placement != operation.placement) continue;
                    break :blk node.parent orelse continue;
                } else value;
                if (member != visible_member) {
                    if (!try self.isVisibleMember(member)) continue;
                    visible_member = member;
                }
                var result: ?FrameRequest = null;
                switch (operation.kind) {
                    .update => {
                        node.feedback_state = .started;
                        self.feedback.appendAssumeCapacity(.{ .node = node.handle, .kind = .children });
                        self.feedback.appendAssumeCapacity(.{ .node = node.handle, .kind = .prepass });
                        self.feedback.appendAssumeCapacity(.{ .node = node.handle, .kind = .refresh });
                        if (node.hook_flags & 65 != 0 and node.update_frame != active.frame_id) {
                            if (node.hook_flags & 1 != 0) result = try self.request(node, 1);
                            node.update_frame = active.frame_id;
                        }
                    },
                    .refresh, .placed, .filtered_refresh => {
                        result = try self.refresh(value, member != value);
                        if (operation.kind == .placed) node.placement = 0;
                    },
                    .prepass => {
                        // A resize callback can append to the live placement Set.
                        self.feedback.appendAssumeCapacity(operation);
                        const start = self.feedback.items.len;
                        for (node.children.items) |child| {
                            const state = &child.scene_node.?;
                            if (state.prepared_frame != active.frame_id or state.prepared_round != active.rounds) continue;
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
                            std.mem.sort(Feedback, self.feedback.items[start..], {}, placementGreaterThan);
                        }
                    },
                    .children, .select => {
                        if (operation.kind == .children) {
                            // Capture child order after the parent's callbacks, never midway through siblings.
                            sortChildren(node, active.frame_id);
                            if (node.viewport != null) {
                                self.feedback.appendAssumeCapacity(.{ .node = node.handle, .kind = .select });
                                for (node.paint_children.items, 0..) |child, index| {
                                    const state = &child.scene_node.?;
                                    if (state.prepared_frame != active.frame_id or state.prepared_round != active.rounds) continue;
                                    if (try self.refresh(child, true)) |request_value| {
                                        // Snapshot the remaining batch before a host callback can change siblings.
                                        var remaining = node.paint_children.items.len;
                                        while (remaining > index + 1) {
                                            remaining -= 1;
                                            const next = &node.paint_children.items[remaining].scene_node.?;
                                            if (next.prepared_frame != active.frame_id or next.prepared_round != active.rounds) continue;
                                            self.feedback.appendAssumeCapacity(.{ .node = next.handle, .kind = .filtered_refresh, .parent = node.handle });
                                        }
                                        return request_value;
                                    }
                                }
                                continue;
                            }
                        }
                        // Drain every direct refresh before selecting a fixed update batch.
                        const filter = try self.childFilter(objects, value);
                        const parent_layout = if (filter != null) try composedLayout(value, false) else Layout{};
                        if (node.viewport != null) active.filter_selected = true;
                        var index = node.paint_children.items.len;
                        while (index != 0) {
                            index -= 1;
                            const state = &node.paint_children.items[index].scene_node.?;
                            if (state.prepared_frame != active.frame_id or state.prepared_round != active.rounds or state.feedback_state != .unseen) continue;
                            if (filter) |bounds| {
                                var layout = state.layout;
                                layout.screenX = parent_layout.screenX + @as(f64, layout.left) + state.paint.translateX;
                                layout.screenY = parent_layout.screenY + @as(f64, layout.top) + state.paint.translateY;
                                try validateLayout(layout);
                                if (!overlaps(bounds, layout)) continue;
                            }
                            self.feedback.appendAssumeCapacity(.{ .node = state.handle, .kind = .update });
                            state.feedback_state = .queued;
                        }
                    },
                }
                if (result) |request_value| return request_value;
            }
            if (self.preparation_dirty or try self.needsSolve(cli, root)) {
                if (!try self.prepareRound(objects, cli, root, reusable_work)) return self.request(&root.?.scene_node.?, 6);
                continue;
            }
            // Resumed calls rebuild transient paint pointers from current accepted topology.
            if (self.work.items.len == 0 or self.hook_count != 0 or self.filter_count != 0) {
                self.work.clearRetainingCapacity();
                try self.work.ensureTotalCapacity(self.allocator, self.count);
                if (root) |value| _ = try self.prepare(objects, value, cli.width, cli.height, .paint, false);
            }
            var focused = if (self.focus) |handle| try objects.get(handle, .native_renderable, native.NativeRenderable) else null;
            var focus_depth: u32 = 0;
            while (focused) |value| : (focused = value.scene_node.?.parent) {
                if (focus_depth == yoga.depth_max) return error.YogaDepthLimit;
                focus_depth += 1;
                value.scene_node.?.focus_frame = active.frame_id;
            }
            const membership_epoch = std.math.add(u64, self.membership_epoch, 1) catch return error.RequestLimit;
            var paint_count: u32 = 0;
            var paint_hooks = false;
            if (self.hook_count != 0 or self.work.items.len > max_paint_members) {
                for (self.work.items) |entry| {
                    if (!entry.visible or entry.node.scene_node.?.kind == 0) continue;
                    paint_count += 1;
                    paint_hooks = paint_hooks or entry.node.scene_node.?.hook_flags & 56 != 0;
                }
            }
            if (paint_hooks or paint_count > max_paint_members) {
                // One member per prepared node; host insertions cannot grow this list.
                try self.paint_members.ensureTotalCapacityPrecise(self.allocator, paint_count);
                for (self.work.items) |member| {
                    member.node.scene_node.?.layout.screenX = member.layout.screenX;
                    member.node.scene_node.?.layout.screenY = member.layout.screenY;
                    if (!member.visible or member.node.scene_node.?.kind == 0) continue;
                    self.paint_members.appendAssumeCapacity(.{
                        .node = member.node.scene_node.?.handle,
                        .clip = member.clip,
                        .opacity = member.opacity,
                        .filtered = member.filtered,
                    });
                }
                self.prefix = .{
                    .destination = BufferIdentity.init(cli.getNextBuffer()),
                    .membership_epoch = membership_epoch,
                    .remaining = max_paint_members,
                };
                try self.beginPaint(cli, active.options);
                if (try self.continuePaint(objects, cli)) |request_value| return request_value;
                return self.finishPaint(cli, membership_epoch, false);
            }
            try self.paintPrepared(cli, active.options);
            return self.finishPaint(cli, membership_epoch, reusable_work);
        }
    }

    fn finishPaint(self: *Scene, cli: *renderer.CliRenderer, membership_epoch: u64, retain_work: bool) FrameRequest {
        const active = self.attempt.?;
        std.debug.assert(!retain_work or active.request_id == 0);
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
        const work = if (retain_work) self.work.items else self.work.items[0..0];
        // clearRetainingCapacity invalidates elements, so detach retained work during cleanup.
        if (retain_work) self.work.items.len = 0;
        self.cancelFrame();
        self.work.items = work;
        self.cancelled_paint = false;
        self.membership_epoch = membership_epoch;
        self.painted = .{
            .ticket = done,
            .membership_epoch = membership_epoch,
            .destination = BufferIdentity.init(cli.getNextBuffer()),
        };
        return done;
    }

    fn request(self: *Scene, node: *Node, kind: u32) !FrameRequest {
        const active = &self.attempt.?;
        if (kind != 6) {
            if (active.requests == active.options.max_host_requests) return error.FrameRequestLimit;
            active.requests += 1;
        }
        active.request_id = std.math.add(u64, active.request_id, 1) catch return error.RequestLimit;
        const result: FrameRequest = .{
            .session = self.session,
            .root = active.root,
            .node = node.handle,
            .frame_id = active.frame_id,
            .request_id = active.request_id,
            .layout_epoch = self.layout_epoch,
            .hook_generation = if (kind == 6) 0 else node.hook_generation,
            .kind = kind,
            .num = if (kind == 6) 0 else node.num,
            .width = if (kind == 6) 0 else @intFromFloat(node.layout.width),
            .height = if (kind == 6) 0 else @intFromFloat(node.layout.height),
        };
        active.pending = result;
        return result;
    }

    fn refresh(self: *Scene, value: *native.NativeRenderable, check_display: bool) !?FrameRequest {
        const node = &value.scene_node.?;
        const active = &self.attempt.?;
        if (node.observed_frame == active.frame_id and node.observed_round == active.rounds) return null;
        const changed = node.resize_width != node.layout.width or node.resize_height != node.layout.height;
        var visible = true;
        if (check_display and (node.text != null or node.editor != null or node.kind == 7 or (changed and node.hook_flags & 2 != 0))) {
            // Placement and filtered refresh already checked the parent's membership.
            var display: u32 = 0;
            try yoga.check(yoga.yogaNodeStyleGetEnumChecked(value.yoga_node, 9, &display));
            visible = display != 1;
        }
        if (visible) try prepareView(node, node.layout);
        const result = if (changed and node.hook_flags & 2 != 0 and visible)
            try self.request(node, 2)
        else
            null;
        node.observed_layout = node.layout;
        node.resize_width = node.layout.width;
        node.resize_height = node.layout.height;
        node.observed_frame = active.frame_id;
        node.observed_round = active.rounds;
        node.layout_flags.needs_layout = false;
        return result;
    }

    fn isVisibleMember(self: *Scene, value: *native.NativeRenderable) !bool {
        var cursor: ?*native.NativeRenderable = value;
        var depth: u32 = 0;
        while (cursor) |current| : (cursor = current.scene_node.?.parent) {
            if (depth == yoga.depth_max) return error.YogaDepthLimit;
            depth += 1;
            if (builtin.is_test) self.test_visibility_steps += 1;
            var display: u32 = 0;
            try yoga.check(yoga.yogaNodeStyleGetEnumChecked(current.yoga_node, 9, &display));
            if (display == 1) return false;
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
        if (self.attempt != null or self.painted != null) return error.FrameBusy;
        const root = try objects.get(root_handle, .native_renderable, native.NativeRenderable);
        const node = root.scene_node orelse return error.WrongKind;
        if (node.owner != self) return error.WrongSession;
        if (self.root != root) return error.InvalidOptions;
        const next_frame = std.math.add(u64, self.last_frame_id, 1) catch return error.RequestLimit;
        try self.solveLayout(cli, root, next_frame, 0);
    }

    fn solveLayout(self: *Scene, cli: *renderer.CliRenderer, root: *native.NativeRenderable, frame_id: u64, round: u32) !void {
        if (!try self.needsSolve(cli, root)) return;
        const epoch = std.math.add(u64, self.layout_epoch, 1) catch return error.RequestLimit;
        try yoga.check(yoga.yogaNodeCalculateLayoutChecked(root.yoga_node, @floatFromInt(cli.width), @floatFromInt(cli.height), 1));
        self.layout_epoch = epoch;
        // A measurement-only solve must invalidate locals before the next prepared frame.
        self.solve_frame = frame_id;
        self.solve_round = round;
        self.layout_width = cli.width;
        self.layout_height = cli.height;
        self.layout_pending = true;
    }

    fn prepareRound(self: *Scene, objects: *const handles.Table, cli: *renderer.CliRenderer, root: ?*native.NativeRenderable, reusable_work: bool) !bool {
        const active = &self.attempt.?;
        const phases = self.layout_hook_count != 0 or self.filter_count != 0;
        const root_node = if (root) |value| &value.scene_node.? else null;
        const reuse = reusable_work and active.rounds == 0 and root_node != null and
            self.work.items.len != 0 and !self.preparation_dirty and !try self.needsSolve(cli, root) and
            (root_node.?.prepared_frame > self.solve_frame or
                (root_node.?.prepared_frame == self.solve_frame and root_node.?.prepared_round >= self.solve_round));
        // Mutations accepted between preparation yields require another bounded round.
        if (active.preparing != .none and (self.preparation_dirty or try self.needsSolve(cli, root))) {
            active.preparing = .none;
        }
        if (active.preparing == .none) {
            if (active.rounds == active.options.max_layout_rounds) return error.LayoutLimit;
            if (!reuse) self.work.clearRetainingCapacity();
            self.prepared.clearRetainingCapacity();
            self.preparation_stack.clearRetainingCapacity();
            self.feedback.clearRetainingCapacity();
            try self.work.ensureTotalCapacity(self.allocator, self.count);
            if (root) |value| try self.solveLayout(cli, value, active.frame_id, active.rounds + 1);
            active.rounds += 1;
            active.filter_selected = false;
            self.preparation_dirty = false;
            if (root != null and active.bounded_work) {
                try self.prepared.ensureTotalCapacity(self.allocator, self.count);
                try self.preparation_stack.resize(self.allocator, @min(self.count, yoga.depth_max));
                self.preparation_stack.items[0] = .{
                    .node = root.?.scene_node.?.handle,
                    .parent = .{},
                    .clip = .{ .x = 0, .y = 0, .width = cli.width, .height = cli.height },
                    .opacity = 1,
                };
                active.prepare_depth = 1;
                active.prepare_cursor = 0;
                active.preparing = .traversal;
            } else if (root) |value| {
                if (!reuse) _ = try self.prepare(objects, value, cli.width, cli.height, .candidates, false);
            }
        }
        if (active.preparing == .traversal) {
            if (!try self.prepare(objects, root.?, cli.width, cli.height, .candidates, true)) return false;
            active.preparing = .views;
        }
        if (active.preparing == .views) {
            while (active.prepare_cursor < self.prepared.items.len) {
                if (active.remaining_work == 0) return false;
                active.remaining_work -= 1;
                const entry = self.prepared.items[active.prepare_cursor];
                active.prepare_cursor += 1;
                const value = objects.get(entry.node, .native_renderable, native.NativeRenderable) catch continue;
                if (!entry.filtered) try prepareView(&value.scene_node.?, entry.layout);
            }
            // Publish only after every candidate and view has validated. Raw pointers never survive a yield.
            for (self.prepared.items) |entry| {
                const value = objects.get(entry.node, .native_renderable, native.NativeRenderable) catch continue;
                self.work.appendAssumeCapacity(.{ .node = value, .layout = entry.layout, .clip = entry.clip, .opacity = entry.opacity, .visible = entry.visible, .filtered = entry.filtered });
            }
        } else {
            for (self.work.items) |entry| {
                if (reuse and !entry.visible) continue;
                // Yoga measurement is observational; culled text keeps its last refreshed viewport.
                if (!entry.filtered) try prepareView(&entry.node.scene_node.?, entry.layout);
            }
        }
        if (phases) {
            // Seven node phases plus a repeated parent prepass per placement bound a stable round.
            // Dirty retries get a new round at the next scheduling boundary, not inside host hooks.
            active.feedback_work_remaining = std.math.mul(usize, self.work.items.len, 8) catch return error.ObjectLimit;
            // Prepass, filtered refresh, and selected updates never hold simultaneous batches for one parent.
            const capacity = std.math.mul(usize, self.work.items.len, 4) catch return error.ObjectLimit;
            try self.feedback.ensureTotalCapacity(self.allocator, capacity);
        }
        for (self.work.items) |entry| {
            // Newly placed hidden nodes were observed by the producer, not subsequent frames.
            if (reuse and !entry.visible) continue;
            const node = &entry.node.scene_node.?;
            node.layout = entry.layout;
            node.prepared_frame = active.frame_id;
            node.prepared_round = active.rounds;
            node.feedback_state = .unseen;
            if (!phases) {
                if (entry.visible and node.hook_flags & 64 != 0) node.update_frame = active.frame_id;
                // With hooks, hidden roots never enter refresh; placed hidden children still do.
                if (self.hook_count != 0 and !entry.visible and node.parent == null) continue;
                node.observed_layout = entry.layout;
                node.resize_width = entry.layout.width;
                node.resize_height = entry.layout.height;
                node.observed_frame = active.frame_id;
                node.observed_round = active.rounds;
                node.placement = 0;
                node.layout_flags.needs_layout = false;
            }
        }
        self.prepared.clearRetainingCapacity();
        self.preparation_stack.clearRetainingCapacity();
        if (phases and self.work.items.len != 0) {
            const node = &self.work.items[0].node.scene_node.?;
            self.feedback.appendAssumeCapacity(.{ .node = node.handle, .kind = .update });
            node.feedback_state = .queued;
        }
        if (active.preparing == .views) self.work.clearRetainingCapacity();
        active.preparing = .none;
        return true;
    }

    fn beginPaint(self: *Scene, cli: *renderer.CliRenderer, options: FrameOptions) !void {
        if (self.editor_cursor_owned) {
            cli.terminal.setCursorPosition(1, 1, false);
            self.editor_cursor_owned = false;
        }
        const target = cli.getNextBuffer();
        target.clearScissorRects();
        target.clearOpacity();
        cli.hitGridClearScissorRects();
        try target.scissor_stack.ensureTotalCapacity(self.allocator, 1);
        try target.opacity_stack.ensureTotalCapacity(self.allocator, 1);
        cli.setBackgroundColor(options.background);
        target.clear(options.background, if (options.preserve_unwritten) 0 else null);
        @import("utils.zig").fillU32(cli.nextHitGrid, 0);
    }

    fn paintPrepared(self: *Scene, cli: *renderer.CliRenderer, options: FrameOptions) !void {
        const target = cli.getNextBuffer();
        errdefer {
            target.clear(cli.backgroundColor, null);
            @memset(cli.nextHitGrid, 0);
        }
        defer target.clearScissorRects();
        defer target.clearOpacity();
        try self.beginPaint(cli, options);
        for (self.work.items) |entry| {
            const node = &entry.node.scene_node.?;
            if (node.kind == 0 or !entry.visible) continue;
            if (node.kind != 1 or hasBoxPaint(&node.paint)) {
                if (builtin.is_test) self.test_paint_setups += 1;
                try target.pushScissorRect(entry.clip.x, entry.clip.y, entry.clip.width, entry.clip.height);
                try target.pushOpacity(entry.opacity);
                if (node.kind == 8) try beginImagePaint(node.control.image, entry.layout);
                try self.paintNode(cli, entry);
                if (node.kind == 8) try finishImagePaint(target, node.control.image, entry.layout);
                if (node.kind == 5) try self.paintEditorCursor(cli, node, entry.layout);
                target.popOpacity();
                target.popScissorRect();
            }
            addHit(cli, entry.layout, entry.clip, node.num, node.token, options);
        }
    }

    fn continuePaint(self: *Scene, objects: *const handles.Table, cli: *renderer.CliRenderer) !?FrameRequest {
        const prefix = &self.prefix.?;
        const target = cli.getNextBuffer();
        while (prefix.cursor < self.paint_members.items.len) {
            if (prefix.remaining == 0) {
                std.debug.assert(prefix.phase == .before and prefix.removed == null and !prefix.editor_cursor_pending and !prefix.text_paint_pending);
                target.clearScissorRects();
                target.clearOpacity();
                return try self.request(&self.root.?.scene_node.?, 6);
            }
            // Charge once on completion or skip, so hook replies cannot replenish the run.
            const member = self.paint_members.items[prefix.cursor];
            target.clearScissorRects();
            target.clearOpacity();
            try target.pushScissorRect(member.clip.x, member.clip.y, member.clip.width, member.clip.height);
            try target.pushOpacity(member.opacity);
            if (prefix.removed) |removed| {
                const layout = removed.layout;
                try validateLayout(layout);
                var node: Node = .{ .owner = self, .handle = member.node, .kind = removed.kind, .num = removed.num, .token = removed.token, .layout = layout, .hook_generation = removed.hook_generation };
                if (prefix.phase == .self) {
                    prefix.phase = .after;
                    if (removed.hook_flags & 32 != 0) return try self.request(&node, 7);
                    if (removed.kind == 8) {
                        try paintImage(cli, removed.control.image, layout);
                    } else try paintControl(target, removed.kind, removed.control, removed.paint, layout, member.clip, false);
                }
                if (prefix.phase == .after) {
                    prefix.editor_cursor_pending = false;
                    prefix.text_paint_pending = false;
                    prefix.phase = .hit;
                    if (removed.hook_flags & 16 != 0) {
                        return try self.request(&node, 5);
                    }
                }
                std.debug.assert(prefix.phase == .hit);
                if (prefix.image_native_pending) try finishImagePaint(target, removed.control.image, layout);
                prefix.image_native_pending = false;
                // The retired token cannot identify a live node after slot reuse.
                addHit(cli, layout, member.clip, removed.num, removed.token, self.attempt.?.options);
                prefix.remaining -= 1;
                prefix.cursor += 1;
                prefix.phase = .before;
                removed.control.deinit(removed.kind, self.allocator);
                prefix.removed = null;
                continue;
            }
            const value = objects.get(member.node, .native_renderable, native.NativeRenderable) catch {
                prefix.text_paint_pending = false;
                prefix.remaining -= 1;
                prefix.cursor += 1;
                prefix.phase = .before;
                continue;
            };
            const node = &value.scene_node.?;
            std.debug.assert(node.owner == self);
            // Layout dimensions stay prepared; only this node's transform setter
            // refreshes its paint coordinates while a prefix is active.
            const layout = node.layout;
            try validateLayout(layout);
            if (prefix.phase == .before) {
                prefix.image_native_pending = node.kind == 8;
                if (prefix.image_native_pending) try beginImagePaint(node.control.image, layout);
                prefix.phase = .self;
                if (node.hook_flags & 8 != 0) return try self.request(node, 4);
            }
            if (prefix.phase == .self) {
                prefix.editor_cursor_pending = node.kind == 5;
                prefix.text_paint_pending = node.hook_flags & 128 != 0;
                prefix.text_paint_selected = false;
                prefix.phase = .after;
                if (node.hook_flags & 32 != 0) return try self.request(node, 7);
                if (node.paint.focusable) {
                    node.focus_frame = 0;
                    var focused = if (self.focus) |handle| try objects.get(handle, .native_renderable, native.NativeRenderable) else null;
                    var depth: u32 = 0;
                    while (focused) |current| : (focused = current.scene_node.?.parent) {
                        if (depth == yoga.depth_max) return error.YogaDepthLimit;
                        depth += 1;
                        if (current == value) {
                            node.focus_frame = self.attempt.?.frame_id;
                            break;
                        }
                    }
                }
                const entry: Work = .{ .node = value, .layout = layout, .clip = member.clip, .opacity = member.opacity, .visible = true, .filtered = member.filtered };
                try self.paintNode(cli, entry);
            }
            if (prefix.phase == .after) {
                if (prefix.text_paint_pending) {
                    prefix.text_paint_pending = false;
                    try self.paintNode(cli, .{ .node = value, .layout = layout, .clip = member.clip, .opacity = member.opacity, .visible = true, .filtered = member.filtered });
                }
                if (prefix.editor_cursor_pending) {
                    prefix.editor_cursor_pending = false;
                    try self.paintEditorCursor(cli, node, layout);
                }
                prefix.phase = .hit;
                if (node.hook_flags & 16 != 0) return try self.request(node, 5);
            }
            std.debug.assert(prefix.phase == .hit);
            if (prefix.image_native_pending) try finishImagePaint(target, node.control.image, layout);
            prefix.image_native_pending = false;
            addHit(cli, layout, member.clip, node.num, node.token, self.attempt.?.options);
            prefix.remaining -= 1;
            prefix.cursor += 1;
            prefix.phase = .before;
        }
        target.clearScissorRects();
        target.clearOpacity();
        return null;
    }

    fn paintNode(self: *Scene, cli: *renderer.CliRenderer, entry: Work) !void {
        const target = cli.getNextBuffer();
        const node = &entry.node.scene_node.?;
        const x: i32 = @intFromFloat(entry.layout.screenX);
        const y: i32 = @intFromFloat(entry.layout.screenY);
        const width: u32 = @intFromFloat(entry.layout.width);
        const height: u32 = @intFromFloat(entry.layout.height);
        if (node.text) |text| {
            if (entry.filtered) try prepareView(node, entry.layout);
            const hit = intersection(.{ .x = x, .y = y, .width = width, .height = height }, entry.clip);
            if (hit.width != 0 and hit.height != 0) try target.drawTextBufferChecked(text.view, x, y);
        } else if (node.kind == 7) {
            const view = node.control.text_view.view orelse return;
            if (entry.filtered or self.preparation_dirty) try prepareView(node, entry.layout);
            if (!node.control.text_view.paint) return;
            const hit = intersection(.{ .x = x, .y = y, .width = width, .height = height }, entry.clip);
            if (hit.width != 0 and hit.height != 0) try target.drawTextBufferChecked(view.view, x, y);
        } else if (node.kind == 5) {
            const editor = node.editor orelse return;
            // A budgeted prefix may resume with a newly bound view and saved geometry.
            if (entry.filtered or self.preparation_dirty) try prepareView(node, entry.layout);
            const hit = intersection(.{ .x = x, .y = y, .width = width, .height = height }, entry.clip);
            if (hit.width != 0 and hit.height != 0) try target.drawEditorViewChecked(editor.view, x, y);
        } else if (node.kind == 8) {
            try paintImage(cli, node.control.image, entry.layout);
        } else if (entry.node.surface) |source| {
            var display: u32 = 0;
            try yoga.check(yoga.yogaNodeStyleGetEnumChecked(entry.node.yoga_node, 9, &display));
            if (display != 1) try Context.drawContextBuffer(target, source, x, y, .{});
        } else {
            try paintControl(target, node.kind, node.control, node.paint, entry.layout, entry.clip, node.focus_frame == self.attempt.?.frame_id);
        }
    }

    fn beginImagePaint(state: ImageState, layout: Layout) !void {
        const target = state.buffer orelse return;
        const width: u32 = @intFromFloat(@max(1, layout.width));
        const height: u32 = @intFromFloat(@max(1, layout.height));
        try target.resize(width, height);
        target.clear(ansi.rgbColor(0, 0, 0, 0), null);
    }

    fn finishImagePaint(target: *buffer.OptimizedBuffer, state: ImageState, layout: Layout) !void {
        const source = state.buffer orelse return;
        if (layout.width == 0 or layout.height == 0) return;
        try Context.drawContextBuffer(target, source, @intFromFloat(layout.screenX), @intFromFloat(layout.screenY), .{});
    }

    fn paintImage(cli: *renderer.CliRenderer, state: ImageState, layout: Layout) !void {
        const source = state.source orelse return;
        if (layout.width <= 0 or layout.height <= 0) return;
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
        const pixel_width = if (has_resolution) @max(1, @round(width * cell_width)) else 0;
        const pixel_height = if (has_resolution) @max(1, @round(height * cell_height)) else 0;
        if (x < std.math.minInt(i32) or x > std.math.maxInt(i32) or y < std.math.minInt(i32) or y > std.math.maxInt(i32) or
            pixel_width > std.math.maxInt(u32) or pixel_height > std.math.maxInt(u32)) return error.InvalidDimensions;
        const target = state.buffer orelse cli.getNextBuffer();
        _ = try target.drawImage(source, source.render_id, @intFromFloat(x), @intFromFloat(y), @intFromFloat(width), @intFromFloat(height), @intFromFloat(pixel_width), @intFromFloat(pixel_height), source_x, source_y, source_width, source_height, state.protocol);
    }

    fn paintEditorCursor(self: *Scene, cli: *renderer.CliRenderer, node: *const Node, layout: Layout) !void {
        // Cursor maintenance follows self drawing even when a host hook replaces the body.
        const editor = node.editor orelse return;
        if (self.focus == null or !std.meta.eql(self.focus.?, node.handle)) return;
        if (node.control.editor.mouse_pointer < 6) cli.terminal.setMousePointerStyle(@enumFromInt(node.control.editor.mouse_pointer));
        if (!node.control.editor.show_cursor) return;
        const cursor = editor.view.getVisualCursor();
        const cursor_x = @max(1, layout.screenX + @as(f64, @floatFromInt(cursor.visual_col)) + 1);
        const cursor_y = @max(1, layout.screenY + @as(f64, @floatFromInt(cursor.visual_row)) + 1);
        // Terminal keeps zero-based row/column in u16 alongside its public position.
        const position_max = @as(f64, std.math.maxInt(u16)) + 1;
        if (cursor_x > position_max or cursor_y > position_max) return error.InvalidDimensions;
        const style: @import("terminal.zig").CursorStyle = switch (node.control.editor.style) {
            0 => .block,
            1 => .line,
            2 => .underline,
            3 => .default,
            else => return error.InvalidOptions,
        };
        cli.terminal.setCursorPosition(@intFromFloat(cursor_x), @intFromFloat(cursor_y), true);
        cli.terminal.setCursorStyle(style, node.control.editor.blinking);
        cli.terminal.setCursorColor(node.control.editor.color);
        self.editor_cursor_owned = true;
    }

    fn paintControl(target: *buffer.OptimizedBuffer, kind: u32, control: Control, paint: Paint, layout: Layout, clip: buffer.ClipRect, focused: bool) !void {
        if (kind == 1) {
            try paintBox(target, paint, layout, focused, control.box);
        } else if (kind == 3) {
            try paintSlider(target, control.slider, layout, clip);
        } else if (kind == 4) {
            const arrow = control.arrow;
            const x: i32 = @intFromFloat(layout.screenX);
            const y: i32 = @intFromFloat(layout.screenY);
            if (x >= 0 and y >= 0) try target.drawTextChecked(
                arrow.text orelse arrows[arrow.direction],
                @intCast(x),
                @intCast(y),
                arrow.foreground,
                arrow.background,
                arrow.attributes,
            );
        }
    }

    fn hasBoxPaint(paint_options: *const Paint) bool {
        return paint_options.borderSides != 0 or (paint_options.shouldFill != 0 and paint_options.background[3] != 0);
    }

    fn paintBox(target: *buffer.OptimizedBuffer, paint_options: Paint, layout: Layout, focused: bool, details: ?*const BoxDetails) !void {
        if (hasBoxPaint(&paint_options)) {
            const border_color = if (paint_options.focusable and focused) paint_options.focusedBorderColor else paint_options.borderColor;
            const options = details orelse &BoxDetails{};
            const chars = if (options.custom_border_chars) |*custom| custom else &borders[paint_options.borderStyle];
            try target.drawBoxChecked(@intFromFloat(layout.screenX), @intFromFloat(layout.screenY), @intFromFloat(layout.width), @intFromFloat(layout.height), chars, .{
                .left = paint_options.borderSides & 1 != 0,
                .bottom = paint_options.borderSides & 2 != 0,
                .right = paint_options.borderSides & 4 != 0,
                .top = paint_options.borderSides & 8 != 0,
            }, border_color, paint_options.background, options.title_color orelse border_color, paint_options.shouldFill != 0, if (options.title.len != 0) options.title else null, @intCast(options.title_alignment), if (options.bottom_title.len != 0) options.bottom_title else null, @intCast(options.bottom_title_alignment));
        }
    }

    fn addHit(cli: *renderer.CliRenderer, layout: Layout, clip: buffer.ClipRect, num: u32, token: u32, options: FrameOptions) void {
        if (!options.use_mouse or num == options.excluded_hit_num) return;
        const hit = intersection(.{
            .x = @intFromFloat(layout.screenX),
            .y = @intFromFloat(layout.screenY),
            .width = @intFromFloat(layout.width),
            .height = @intFromFloat(layout.height),
        }, clip);
        cli.addToHitGrid(hit.x, hit.y, hit.width, hit.height, token);
    }

    fn viewportNode(self: *Scene, objects: *const handles.Table, handle: handles.Handle) !*native.NativeRenderable {
        const value = try objects.get(handle, .native_renderable, native.NativeRenderable);
        const node = value.scene_node orelse return error.WrongKind;
        if (node.owner != self) return error.WrongSession;
        if (node.kind > 1) return error.WrongKind;
        return value;
    }

    fn childFilter(self: *Scene, objects: *const handles.Table, value: *native.NativeRenderable) !?Filter {
        const node = &value.scene_node.?;
        const viewport = try self.viewportNode(objects, node.viewport orelse return null);
        const layout = try composedLayout(viewport, false);
        try validateLayout(layout);
        // The cutoff includes hidden children and changes selection, not refresh ordering.
        if (node.children.items.len < 16 and layout.width > 0 and layout.height > 0) return null;
        var direction: u32 = 0;
        try yoga.check(yoga.yogaNodeStyleGetEnumChecked(value.yoga_node, 1, &direction));
        return .{ .viewport = layout, .row = direction == 2 or direction == 3 };
    }

    fn prepare(self: *Scene, objects: *const handles.Table, root: *native.NativeRenderable, width: u32, height: u32, mode: enum { candidates, paint }, comptime retained: bool) !bool {
        var local_stack: [if (retained) 0 else yoga.depth_max]PreparationFrame(false) = undefined;
        const stack = if (retained) self.preparation_stack.items else &local_stack;
        if (!retained) stack[0] = .{ .node = root, .parent = .{}, .clip = .{ .x = 0, .y = 0, .width = width, .height = height }, .opacity = 1 };
        var depth: usize = if (retained) self.attempt.?.prepare_depth else 1;
        defer if (retained) {
            self.attempt.?.prepare_depth = depth;
        };
        while (depth != 0) {
            const frame = &stack[depth - 1];
            const value = if (retained) objects.get(frame.node, .native_renderable, native.NativeRenderable) catch {
                depth -= 1;
                continue;
            } else frame.node;
            const node = &value.scene_node.?;
            if (!frame.entered) {
                if (retained) {
                    if (self.attempt.?.remaining_work == 0) return false;
                    self.attempt.?.remaining_work -= 1;
                }
                if (builtin.is_test) self.test_prepare_steps += 1;
                // Yoga style changes dirty layout; the completed preparation stamps qualify both caches.
                const refresh_layout = mode == .candidates and (node.prepared_frame == 0 or node.prepared_frame < self.solve_frame or
                    (node.prepared_frame == self.solve_frame and node.prepared_round < self.solve_round));
                if (refresh_layout) {
                    var display: u32 = 0;
                    if (builtin.is_test) self.test_style_reads += 1;
                    try yoga.check(yoga.yogaNodeStyleGetEnumChecked(value.yoga_node, 9, &display));
                    node.layout_flags.display_none = display == 1;
                }
                const visible = !node.layout_flags.display_none;
                const filtered_child = if (node.parent) |parent| parent.scene_node.?.viewport != null else false;
                if (!visible and (mode == .paint or (!node.layout_flags.needs_layout and !filtered_child))) {
                    depth -= 1;
                    continue;
                }
                var layout = node.layout;
                if (refresh_layout) {
                    var computed: yoga.ExternalYogaLayout = undefined;
                    if (builtin.is_test) self.test_geometry_reads += 1;
                    try yoga.check(yoga.yogaNodeGetComputedLayoutChecked(value.yoga_node, &computed));
                    if (!std.math.isFinite(computed.width) or !std.math.isFinite(computed.height)) return error.InvalidDimensions;
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
                    std.debug.assert(node.prepared_frame == self.attempt.?.frame_id);
                    std.debug.assert(node.prepared_round == self.attempt.?.rounds);
                }
                layout.screenX = frame.parent.screenX + @as(f64, layout.left) + node.paint.translateX;
                layout.screenY = frame.parent.screenY + @as(f64, layout.top) + node.paint.translateY;
                try validateLayout(layout);
                if (frame.filter) |filter| {
                    if (!overlaps(filter, layout)) {
                        depth -= 1;
                        continue;
                    }
                }
                if (node.kind == 3) _ = try sliderThumb(node.control.slider, layout.width, layout.height);
                frame.opacity *= node.paint.opacity;
                if (retained) {
                    self.prepared.appendAssumeCapacity(.{ .node = node.handle, .layout = layout, .clip = frame.clip, .opacity = frame.opacity, .visible = visible, .filtered = frame.filtered });
                } else {
                    self.work.appendAssumeCapacity(.{ .node = value, .layout = layout, .clip = frame.clip, .opacity = frame.opacity, .visible = visible, .filtered = frame.filtered });
                }
                if (node.viewport) |handle| _ = try self.viewportNode(objects, handle);
                if (!visible or (node.paint_children.items.len == 0 and node.viewport == null)) {
                    depth -= 1;
                    continue;
                }
                frame.parent = layout;
                if (refresh_layout) {
                    var overflow: u32 = 0;
                    if (builtin.is_test) self.test_style_reads += 1;
                    try yoga.check(yoga.yogaNodeStyleGetEnumChecked(value.yoga_node, 8, &overflow));
                    node.layout_flags.clips_children = overflow != 0;
                }
                if (node.layout_flags.clips_children) {
                    const left: u32 = @intFromBool(node.paint.borderSides & 1 != 0);
                    const top: u32 = @intFromBool(node.paint.borderSides & 8 != 0);
                    const horizontal = left + @as(u32, @intFromBool(node.paint.borderSides & 4 != 0));
                    const vertical = top + @as(u32, @intFromBool(node.paint.borderSides & 2 != 0));
                    frame.clip = intersection(frame.clip, .{
                        .x = @intFromFloat(layout.screenX + @as(f64, @floatFromInt(left))),
                        .y = @intFromFloat(layout.screenY + @as(f64, @floatFromInt(top))),
                        .width = @as(u32, @intFromFloat(layout.width)) -| horizontal,
                        .height = @as(u32, @intFromFloat(layout.height)) -| vertical,
                    });
                }
                if (mode == .paint) frame.filter = try self.childFilter(objects, value);
                if (mode == .paint or (!retained and self.hook_count == 0 and self.filter_count == 0)) sortChildren(node, self.attempt.?.frame_id);
                frame.entered = true;
            }
            if (frame.child == node.paint_children.items.len) {
                depth -= 1;
                continue;
            }
            if (depth == stack.len) return error.YogaDepthLimit;
            const child = node.paint_children.items[frame.child];
            frame.child += 1;
            stack[depth] = .{ .node = if (retained) child.scene_node.?.handle else child, .parent = frame.parent, .clip = frame.clip, .opacity = frame.opacity, .filtered = frame.filtered or node.viewport != null, .filter = frame.filter };
            depth += 1;
        }
        return true;
    }
};

pub fn sliderThumb(options: SliderOptions, width: f64, height: f64) !SliderThumb {
    if (options.orientation > 1) return error.InvalidOptions;
    for ([_]f64{ options.min, options.max, options.value, options.viewport_size }) |value| {
        if (!std.math.isFinite(value)) return error.InvalidOptions;
    }
    for ([_]f64{ width, height }) |dimension| {
        if (!std.math.isFinite(dimension) or dimension < 0 or dimension > std.math.maxInt(i32)) return error.InvalidDimensions;
    }
    const track_size = (if (options.orientation == 0) width else height) * 2;
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

/// Public geometry advances at legacy preparation points, separately from completed
/// paint layout. Accepted transforms and ancestry still compose immediately.
pub fn getLayout(value: *const native.NativeRenderable) !Layout {
    return composedLayout(value, true);
}

pub fn getPaintLayout(value: *const native.NativeRenderable) !Layout {
    const layout = value.scene_node.?.layout;
    try validateLayout(layout);
    return layout;
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
        const node = &ancestors[count].scene_node.?;
        const layout = if (observed) node.observed_layout else node.layout;
        result.screenX = result.screenX + @as(f64, layout.left) + node.paint.translateX;
        result.screenY = result.screenY + @as(f64, layout.top) + node.paint.translateY;
        if (!std.math.isFinite(result.screenX) or !std.math.isFinite(result.screenY)) return error.InvalidDimensions;
    }
    return result;
}

fn prepareView(node: *Node, layout: Layout) !void {
    if (node.kind == 7) {
        const text_view = node.control.text_view.view orelse return;
        var viewport = text_view.view.getViewport() orelse text_buffer_view.Viewport{ .x = 0, .y = 0, .width = 0, .height = 0 };
        viewport.width = @intFromFloat(layout.width);
        viewport.height = @intFromFloat(layout.height);
        text_view.view.setViewport(viewport);
        try text_view.prepareView();
        return;
    }
    if (node.editor) |editor| {
        const width: u32 = @intFromFloat(layout.width);
        const height: u32 = @intFromFloat(layout.height);
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
    viewport.width = @intFromFloat(layout.width);
    viewport.height = @intFromFloat(layout.height);
    text.view.setViewport(viewport);
    try text.prepareView();
    text.initial_viewport = null;
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
    const a = &left.scene_node.?;
    const b = &right.scene_node.?;
    if (builtin.is_test) a.owner.test_sort_steps += 1;
    return if (a.paint.zIndex == b.paint.zIndex) a.paint_rank < b.paint_rank else a.paint.zIndex < b.paint.zIndex;
}

fn sortChildren(node: *Node, frame_id: u64) void {
    // Feedback reruns refresh geometry, not sibling order already selected for this frame.
    if (node.child_order_frame == frame_id) return;
    node.child_order_frame = frame_id;
    if (!node.sort_dirty) return;
    for (node.paint_children.items, 0..) |child, index| {
        if (builtin.is_test) node.owner.test_sort_steps += 1;
        child.scene_node.?.paint_rank = @intCast(index);
    }
    std.mem.sort(*native.NativeRenderable, node.paint_children.items, {}, paintLessThan);
    node.sort_dirty = false;
}

fn placementGreaterThan(_: void, left: Feedback, right: Feedback) bool {
    return left.placement > right.placement;
}

fn validateLayout(layout: Layout) !void {
    const min: f64 = std.math.minInt(i32);
    const max: f64 = std.math.maxInt(i32);
    inline for (std.meta.fields(Layout)) |field| {
        if (!std.math.isFinite(@field(layout, field.name))) return error.InvalidDimensions;
    }
    if (layout.screenX < min or layout.screenY < min or layout.width > max or layout.height > max or
        layout.screenX + @as(f64, layout.width) > max or layout.screenY + @as(f64, layout.height) > max)
    {
        return error.InvalidDimensions;
    }
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
