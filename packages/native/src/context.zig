const std = @import("std");
const handles = @import("context-handles.zig");
const grapheme = @import("grapheme.zig");
const link = @import("link.zig");
const yoga = @import("yoga.zig");
const renderer = @import("renderer.zig");
const session = @import("session.zig");
const scene = @import("scene.zig");
const native_span_feed = @import("native-span-feed.zig");
const buf = @import("buffer.zig");
const buffer_effects = @import("buffer-methods.zig");
const native_renderable = @import("native-renderable.zig");
const text_buffer = @import("text-buffer.zig");
const text_buffer_view = @import("text-buffer-view.zig");
const logger = @import("logger.zig");
const utf8 = @import("utf8.zig");
const syntax_style = @import("syntax-style.zig");
const edit_buffer = @import("edit-buffer.zig");
const editor_view = @import("editor-view.zig");
const event_bus = @import("event-bus.zig");
const ansi = @import("ansi.zig");
const image = @import("image.zig");
const encoded_unicode = @import("encoded-unicode.zig");
pub const embedded_terminal = if (@import("ghostty_vt_options").available)
    @import("embedded-terminal/main.zig")
else
    @import("embedded-terminal/unavailable.zig");

pub const EncodedChar = encoded_unicode.EncodedChar;
pub const EncodedUnicode = encoded_unicode.EncodedUnicode;

pub const terminal_input_bytes_max: u32 = 1024 * 1024;
pub const EmbeddedTerminalKey = struct {
    action: u32 = 1,
    composing: bool = false,
    mods: u32 = 0,
    consumed_mods: u32 = 0,
    unshifted_codepoint: u32 = 0,
    key: []const u8 = "",
    text: []const u8 = "",
};
pub const EmbeddedTerminalMouse = struct {
    action: u32,
    button: i32 = -1,
    mods: u32 = 0,
    any_button_pressed: bool = false,
    x: f32,
    y: f32,
};

pub const Handle = handles.Handle;
pub const Diagnostic = logger.Diagnostic;
pub const Error = handles.Error || yoga.Error || session.Error || error{
    InvalidOptions,
    InvalidDimensions,
    ContextClosed,
    ContextBusy,
    LeaseLimit,
    LeaseBytesLimit,
    StaleLease,
    UnsupportedResource,
};

pub const RendererBuffer = enum { current, next };

const FrameBufferLease = struct {
    frame: scene.FrameRequest,
    membership_epoch: u64,
    which: RendererBuffer,
    destination: scene.BufferIdentity,
    lease: buf.BufferLease,
};

pub const BufferOptions = struct {
    respect_alpha: bool = false,
    width_method: utf8.WidthMethod = .unicode,
};

pub const BufferCrop = struct { x: u32 = 0, y: u32 = 0, width: ?u32 = null, height: ?u32 = null };

pub const ImageDraw = struct {
    x: i32 = 0,
    y: i32 = 0,
    width: u32,
    height: u32,
    pixel_width: u32 = 0,
    pixel_height: u32 = 0,
    source_x: u32 = 0,
    source_y: u32 = 0,
    source_width: ?u32 = null,
    source_height: ?u32 = null,
    protocol: image.RenderProtocol = .auto,
};

pub const BufferGrid = struct {
    border_chars: [11]u32,
    foreground: buf.RGBA,
    background: buf.RGBA,
    draw_inner: bool,
    draw_outer: bool,
};

pub const BufferDraw = struct {
    pub const Operation = enum(u32) { clear, fill, text, cell, cell_blend, char, box, compose, respect_alpha };
    operation: Operation,
    x: i32 = 0,
    y: i32 = 0,
    width: u32 = 0,
    height: u32 = 0,
    char: u32 = ' ',
    attributes: u32 = 0,
    foreground: buf.RGBA = .{ 0, 0, 0, 0 },
    background: ?buf.RGBA = null,
    title_color: buf.RGBA = .{ 0, 0, 0, 0 },
    packed_options: u32 = 0,
    border_chars: [11]u32 = @splat(0),
    source: ?Handle = null,
    crop: BufferCrop = .{},
};

pub const BufferStack = struct {
    // Custom scopes are bounded independently of the scene's single inherited entry.
    pub const depth_max: u32 = 256;
    pub const Operation = enum(u32) {
        get_opacity,
        push_scissor,
        pop_scissor,
        clear_scissors,
        push_opacity,
        pop_opacity,
        clear_opacity,
    };
    operation: Operation,
    x: i32 = 0,
    y: i32 = 0,
    width: u32 = 0,
    height: u32 = 0,
    opacity: f32 = 1,
};

pub const EditEvent = enum(u32) { cursor_changed = 1, content_changed = 2, history_cursor_changed = 4 };
pub const EditEventCallback = *const fn (?*anyopaque, Handle, EditEvent) void;

pub const Edit = struct {
    owner: *Context,
    handle: Handle,
    buffer: *edit_buffer.EditBuffer,
    sink: event_bus.EventSink,
    views: ?*Editor = null,
    content_epoch: u64 = 0,
    input_mem_id: ?u8 = null,

    fn receive(data: *anyopaque, name: []const u8, _: []const u8) void {
        const self: *Edit = @ptrCast(@alignCast(data));
        const event: EditEvent = if (std.mem.eql(u8, name, "eb_cursor-changed")) .cursor_changed else if (std.mem.eql(u8, name, "eb_content-changed")) .content_changed else event: {
            std.debug.assert(std.mem.eql(u8, name, "eb_cursorChanged"));
            break :event .history_cursor_changed;
        };
        const owner = self.owner;
        const epoch = self.buffer.tb.getContentEpoch();
        const content_changed = epoch != self.content_epoch;
        if (content_changed) {
            self.content_epoch = epoch;
        }
        var next = self.views;
        while (next) |view| : (next = view.next) {
            if (content_changed) {
                view.invalidate();
            } else {
                view.invalidatePreparation();
            }
        }
        if (owner.edit_event_callback) |callback| callback(owner.edit_event_userdata, self.handle, event);
    }

    pub fn checkMutable(self: *Edit) !void {
        var next = self.views;
        while (next) |view| : (next = view.next) try view.checkMutable();
    }

    pub fn invalidate(self: *Edit) void {
        var next = self.views;
        while (next) |view| : (next = view.next) view.invalidate();
    }
};

pub const Editor = struct {
    handle: Handle,
    edit: *Edit,
    view: *editor_view.EditorView,
    previous: ?*Editor = null,
    next: ?*Editor = null,
    node: ?*native_renderable.NativeRenderable = null,

    pub fn checkMutable(self: *Editor) yoga.Error!void {
        if (self.node) |node| try yoga.check(yoga.nodeTeardownStatus(node.yoga_node));
        var next = self.view.measure_dependents;
        while (next) |node| : (next = node.measure_next) try yoga.check(yoga.nodeTeardownStatus(node.yoga_node));
    }

    pub fn invalidate(self: *Editor) void {
        var next = self.view.measure_dependents;
        while (next) |node| : (next = node.measure_next) yoga.yogaNodeInvalidateMeasure(node.yoga_node);
        if (self.node) |node| {
            yoga.yogaNodeInvalidateMeasure(node.yoga_node);
            node.scene_node.?.owner.preparation_dirty = true;
            node.scene_node.?.owner.work.clearRetainingCapacity();
        }
    }

    pub fn invalidatePreparation(self: *Editor) void {
        if (self.node) |node| {
            // Idle frames reuse geometry but still prepare the view and follow its cursor.
            if (node.scene_node.?.owner.attempt == null) return;
            node.scene_node.?.owner.preparation_dirty = true;
            node.scene_node.?.owner.work.clearRetainingCapacity();
        }
    }

    pub fn prepareView(self: *Editor) !void {
        try Context.prepareTextBuffer(self.edit.buffer.tb);
        if (self.view.text_buffer_view.text_buffer != self.edit.buffer.tb)
            try Context.prepareTextBuffer(self.view.text_buffer_view.text_buffer);
        _ = self.view.text_buffer_view.getVirtualLines();
        if (self.view.text_buffer_view.virtual_lines_dirty) return error.OutOfMemory;
    }
};

pub const SharedText = struct {
    handle: Handle,
    buffer: *text_buffer.UnifiedTextBuffer,
    input_mem_id: u8,
    owned_style: ?*syntax_style.SyntaxStyle = null,
    views: ?*TextView = null,

    pub fn checkMutable(self: *SharedText) yoga.Error!void {
        var next = self.views;
        while (next) |view| : (next = view.next) try view.checkMutable();
    }

    pub fn invalidate(self: *SharedText) void {
        var next = self.views;
        while (next) |view| : (next = view.next) view.invalidate();
    }

    fn reclaimAppendBuffers(self: *SharedText) void {
        const registry = &self.buffer.mem_registry;
        // Shared text reserves slot zero for replacement; other slots only hold appends.
        std.debug.assert(self.input_mem_id == 0 and registry.free_slots.items.len == 0);
        for (registry.buffers.items[1..]) |memory| {
            std.debug.assert(memory.active and memory.owned);
            registry.allocator.free(memory.data);
        }
        registry.buffers.items.len = 1;
    }
};

pub const TextView = struct {
    handle: Handle,
    text: *SharedText,
    view: *text_buffer_view.UnifiedTextBufferView,
    previous: ?*TextView = null,
    next: ?*TextView = null,
    node: ?*native_renderable.NativeRenderable = null,

    pub fn checkMutable(self: *TextView) yoga.Error!void {
        if (self.node) |node| try yoga.check(yoga.nodeTeardownStatus(node.yoga_node));
        var next = self.view.measure_dependents;
        while (next) |node| : (next = node.measure_next) try yoga.check(yoga.nodeTeardownStatus(node.yoga_node));
    }

    pub fn invalidate(self: *TextView) void {
        var next = self.view.measure_dependents;
        while (next) |node| : (next = node.measure_next) yoga.yogaNodeInvalidateMeasure(node.yoga_node);
        self.invalidatePreparation();
    }

    pub fn invalidatePreparation(self: *TextView) void {
        if (self.node) |node| {
            node.scene_node.?.owner.preparation_dirty = true;
            node.scene_node.?.owner.work.clearRetainingCapacity();
        }
    }

    pub fn prepareView(self: *TextView) !void {
        try self.view.prepare();
    }
};

pub const EditCommand = union(enum) {
    delete_forward,
    backspace,
    new_line,
    delete_line,
    move_left,
    move_right,
    move_up,
    move_down,
    goto_line: u32,
    cursor_offset: u32,
    clear,
    clear_history,
    debug_rope,
};

pub const EditorCommand = union(enum) {
    move_up,
    move_down,
    goto_line_end,
    delete_selection,
    cursor_offset: u32,
    wrap_mode: text_buffer_view.WrapMode,
    tab_indicator: ?u32,
};

pub const TextViewCommand = union(enum) {
    wrap_width: ?u32,
    wrap_mode: text_buffer_view.WrapMode,
    first_line_offset: u32,
    tab_indicator: ?u32,
    truncate: bool,
};

pub const TextDefaults = struct {
    pub const Fields = packed struct(u3) {
        foreground: bool = false,
        background: bool = false,
        attributes: bool = false,
    };
    fields: Fields,
    foreground: ?buf.RGBA = null,
    background: ?buf.RGBA = null,
    attributes: ?u32 = null,
};

pub const TextHighlight = union(enum) {
    pub const Range = struct {
        start: u32,
        end: u32,
        style_id: u32,
        priority: u8 = 0,
        ref: u16 = 0,
    };
    add_line: struct { line: u32, range: Range },
    add_range: Range,
    remove_ref: u16,
    clear_line: u32,
    clear_all,
};

pub const TextSelection = struct {
    pub const Operation = enum { set, update, reset, local, local_update, local_reset, cell, occupancy, inclusive, colors };
    operation: Operation,
    start: u32 = 0,
    end: u32 = 0,
    anchor_x: i32 = 0,
    anchor_y: i32 = 0,
    focus_x: i32 = 0,
    focus_y: i32 = 0,
    foreground: ?buf.RGBA = null,
    background: ?buf.RGBA = null,
    behavior: text_buffer_view.SelectionBehavior = .cell,
    occupancy: text_buffer_view.SelectionOccupancy = .cell,
    update_cursor: bool = false,
    follow_cursor: bool = false,
};

pub const StyledTextChunk = struct {
    byte_count: u32,
    foreground: ?buf.RGBA = null,
    background: ?buf.RGBA = null,
    attributes: u32 = 0,
    link_url: ?[]const u8 = null,
};

pub const SceneTextSelectionOptions = struct {
    operation: u32,
    behavior: u32 = 0,
    anchor_x: i32 = 0,
    anchor_y: i32 = 0,
    focus_x: i32 = 0,
    focus_y: i32 = 0,
    background: ?buf.RGBA = null,
    foreground: ?buf.RGBA = null,
};

pub const Options = struct {
    /// All checked handles, including leases, share this capacity.
    object_capacity: u32 = 4096,
    render_cells_max: u32 = 1_000_000,
    lease_count_max: u32 = buf.BufferLease.count_max_default,
    /// Distinct checked-leased storage, current or retired: headers, cell arrays,
    /// and reserved tracker/placement capacity. Shared resources are not storage allocations.
    lease_bytes_max: u64 = buf.BufferLease.bytes_max_default,
    /// Each entry holds at most Diagnostic.message_bytes_max bytes. Zero keeps
    /// only the cumulative drop count. Diagnostics are drained by the idle owner.
    diagnostic_capacity: u32 = 64,
    yoga_callbacks: yoga.Callbacks = .{},
};

/// The view and its backing buffer share one lifetime. Measure borrowers are
/// unlinked before either is freed, without scanning unrelated renderables.
pub const Text = struct {
    buffer: *text_buffer.UnifiedTextBuffer,
    view: *text_buffer_view.UnifiedTextBufferView,
    input_mem_id: ?u8 = null,
    owned_style: ?*syntax_style.SyntaxStyle = null,
    initial_viewport: ?text_buffer_view.Viewport = null,
    // Retain logical changes even when both positions truncate to the same cell.
    scroll_x: f64 = 0,
    scroll_y: f64 = 0,
    pool_next: ?*Text = null,

    pub fn prepareView(self: *Text) !void {
        try self.view.prepare();
    }
};

pub const SceneMeasureCallback = *const fn (u64, u32, u32, f32, u32, f32, u32, *yoga.ExternalYogaSize) callconv(.c) void;

const SceneMeasure = struct {
    owner: *Context,
    handle: Handle,
    callback: SceneMeasureCallback,

    fn measure(data: ?*anyopaque, width: f32, width_mode: u32, height: f32, height_mode: u32) callconv(.c) yoga.ExternalYogaSize {
        const self: *SceneMeasure = @ptrCast(@alignCast(data.?));
        const node = self.owner.sceneNode(self.handle) catch unreachable;
        std.debug.assert(node.scene_node.?.handle.generation == self.handle.generation);
        std.debug.assert(self.owner.mutating and !self.owner.scene_measuring);
        self.owner.scene_measuring = true;
        defer self.owner.scene_measuring = false;
        // Host exceptions leave unspecified dimensions and escape after the native
        // call. Unlike native measurement failures, they do not poison the tree.
        var result: yoga.ExternalYogaSize = .{ .width = std.math.nan(f32), .height = std.math.nan(f32) };
        self.callback(self.handle.context_id, self.handle.slot, self.handle.generation, width, width_mode, height, height_mode, &result);
        return result;
    }
};

/// A context is single-owner and address-stable until deinit. Callers may move
/// ownership between threads when idle, but must not enter one context concurrently.
/// Returned pointers and pool IDs are borrowed for the owning object's lifetime.
/// Pool IDs and render buffers must not cross contexts. Callbacks must not mutate
/// borrowed objects; checked context mutations reject reentry during layout/render.
/// Raw getters do not register borrowers. Callers must release raw BufferLeases
/// before context deinit; only checked lease handles prevent context teardown.
/// Pending output and active terminal lifecycle block teardown until restored or cancelled.
pub const Context = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    render_cells_max: u32,
    lease_count_max: u32,
    lease_bytes_max: u64,
    lease_count: u32 = 0,
    lease_bytes: u64 = 0,
    objects: handles.Table,
    last_image_id: u32 = 0,
    graphemes: grapheme.GraphemePool,
    links: link.LinkPool,
    diagnostics: logger.Diagnostics,
    logger: logger.Logger,
    yoga_config: yoga.Config,
    edit_event_callback: ?EditEventCallback = null,
    edit_event_userdata: ?*anyopaque = null,
    closing: bool = false,
    mutating: bool = false,
    scene_measuring: bool = false,
    scene_measures: std.AutoHashMapUnmanaged(u32, *SceneMeasure) = .empty,
    // Idle storage only: live handles and scene hit tokens still retire normally.
    node_pool: []native_renderable.NodeStorage = &.{},
    node_pool_count: u32 = 0,
    node_pool_bytes: usize = 0,
    text_pool: ?*Text = null,
    text_pool_count: u32 = 0,
    text_pool_bytes: usize = 0,

    // Cover a rebuilt grid without retaining a Context's entire object capacity.
    pub const node_pool_count_max = 512;
    pub const node_pool_bytes_max = 2 * 1024 * 1024;
    pub const text_pool_count_max = 256;
    pub const text_pool_bytes_max = 4 * 1024 * 1024;
    pub const text_storage_bytes_max = 64 * 1024;

    pub fn init(allocator: std.mem.Allocator, io: std.Io, options: Options) Error!*Context {
        if (options.object_capacity == 0 or options.render_cells_max == 0) return error.InvalidOptions;
        const self = try allocator.create(Context);
        errdefer allocator.destroy(self);
        var objects = try handles.Table.init(allocator, options.object_capacity);
        errdefer objects.deinit();
        var diagnostics = try logger.Diagnostics.init(allocator, options.diagnostic_capacity);
        errdefer diagnostics.deinit();
        self.* = .{
            .allocator = allocator,
            .io = io,
            .render_cells_max = options.render_cells_max,
            .lease_count_max = options.lease_count_max,
            .lease_bytes_max = options.lease_bytes_max,
            .objects = objects,
            .graphemes = grapheme.GraphemePool.init(allocator),
            .links = link.LinkPool.init(allocator),
            .diagnostics = diagnostics,
            .logger = .{ .diagnostics = &self.diagnostics },
            .yoga_config = undefined,
        };
        try self.yoga_config.init(allocator, options.yoga_callbacks);
        self.yoga_config.setLogger(&self.logger);
        return self;
    }

    pub fn deinit(self: *Context) error{ContextBusy}!void {
        if (self.closing or self.mutating or self.lease_count != 0) return error.ContextBusy;
        std.debug.assert(self.lease_bytes == 0);
        var session_cursor: usize = 0;
        while (self.objects.next(.session, &session_cursor)) |handle| {
            const value = self.objects.get(handle, .session, session.Session) catch unreachable;
            checkSessionTeardown(value) catch return error.ContextBusy;
        }
        var view_cursor: usize = 0;
        while (self.objects.next(.editor_view, &view_cursor)) |handle| {
            const view = self.objects.get(handle, .editor_view, Editor) catch unreachable;
            view.checkMutable() catch return error.ContextBusy;
        }
        view_cursor = 0;
        while (self.objects.next(.text_buffer_view, &view_cursor)) |handle| {
            const view = self.objects.get(handle, .text_buffer_view, TextView) catch unreachable;
            view.checkMutable() catch return error.ContextBusy;
        }
        self.closing = true;
        session_cursor = 0;
        while (self.objects.next(.session, &session_cursor)) |handle| {
            const value = self.objects.get(handle, .session, session.Session) catch unreachable;
            if (value.scene) |owned| owned.detachAll();
        }
        // Walk the registry once per kind; borrowers release before their resources.
        for ([_]handles.Kind{ .native_renderable, .text_buffer_view, .text_buffer, .editor_view, .edit_buffer, .syntax_style, .buffer, .session, .image, .encoded_unicode, .embedded_terminal }) |kind| {
            var cursor: usize = 0;
            while (self.objects.next(kind, &cursor)) |handle| {
                self.destroyToken(self.objects.beginDestroy(handle) catch unreachable);
            }
        }
        self.objects.deinit();
        std.debug.assert(self.scene_measures.count() == 0);
        self.scene_measures.deinit(self.allocator);
        for (self.node_pool[0..self.node_pool_count]) |storage| {
            self.freeNodeStorage(storage);
        }
        self.allocator.free(self.node_pool);
        while (self.text_pool) |text| {
            self.text_pool = text.pool_next;
            self.freeTextStorage(text);
        }
        self.yoga_config.deinit();
        self.graphemes.deinit();
        self.links.deinit();
        self.diagnostics.deinit();
        self.allocator.destroy(self);
    }

    /// A size query returns the interned URL byte count. Copies require that
    /// bound. Link id 0 and unknown IDs fail. URLs fit in MAX_URL_LENGTH bytes.
    pub fn getLinkUrl(self: *Context, id: u32, out: []u8) Error!u32 {
        if (id == 0) return error.InvalidOptions;
        const url = self.links.get(id) catch return error.InvalidOptions;
        std.debug.assert(url.len <= link.MAX_URL_LENGTH);
        const count: u32 = @intCast(url.len);
        if (out.len == 0) return count;
        if (out.len < url.len) return error.InvalidOptions;
        @memcpy(out[0..url.len], url);
        return count;
    }

    fn checkSessionTeardown(value: *session.Session) Error!void {
        if (!value.canDestroy()) return error.ContextBusy;
        const owned = value.scene orelse return;
        var cursor = owned.head;
        while (cursor) |node| : (cursor = node.scene_node.?.next) {
            try yoga.check(yoga.nodeTeardownStatus(node.yoga_node));
        }
    }

    pub fn createSession(self: *Context, options: session.Options) Error!Handle {
        try self.beginMutation();
        defer self.mutating = false;
        if (options.chunk_size == 0 or options.chunk_count == 0 or options.span_capacity == 0) {
            return error.InvalidOptions;
        }
        if (options.control_capacity != 0) {
            const control_chunks = std.math.divCeil(u32, options.control_capacity, options.chunk_size) catch
                return error.InvalidOptions;
            if (control_chunks >= options.chunk_count or control_chunks >= options.span_capacity) {
                return error.InvalidOptions;
            }
        }
        try self.objects.checkCapacity();
        const value = try self.allocator.create(session.Session);
        errdefer self.allocator.destroy(value);
        const output = try native_span_feed.Stream.create(self.allocator, .{
            .chunk_size = options.chunk_size,
            .initial_chunks = options.chunk_count,
            .max_bytes = @as(u64, options.chunk_size) * options.chunk_count,
            .growth_policy = @intFromEnum(native_span_feed.GrowthPolicy.block),
            .auto_commit_on_full = 1,
            .span_queue_capacity = options.span_capacity,
        });
        errdefer output.destroy();
        if (options.control_capacity != 0) try output.reserveControlCapacity(options.control_capacity);
        const handle = try self.objects.insert(.session, value);
        value.* = .{ .handle = handle, .output = output };
        return handle;
    }

    pub fn getSession(self: *Context, handle: Handle) Error!*session.Session {
        if (self.closing) return error.ContextClosed;
        return self.objects.get(handle, .session, session.Session);
    }

    /// Attaches one renderer without terminal setup or output. Queued raw output
    /// stays in order. Failure preserves the Session and publishes no renderer.
    pub fn attachSessionRenderer(
        self: *Context,
        handle: Handle,
        width: u32,
        height: u32,
        options: session.RendererOptions,
    ) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getSession(handle);
        try value.checkOpen();
        if (value.renderer != null) return error.RendererAlreadyAttached;
        const cells = std.math.mul(u32, width, height) catch return error.InvalidDimensions;
        if (width == 0 or height == 0 or cells > self.render_cells_max) return error.InvalidDimensions;
        var environment: ?std.process.Environ.Map = null;
        errdefer if (environment) |*map| map.deinit();
        if (options.forwarded_env) |entries| {
            if (options.env_map != null or entries.len > session.environment_entries_max) return error.InvalidOptions;
            environment = std.process.Environ.Map.init(self.allocator);
            var remaining: usize = session.environment_bytes_max;
            for (entries) |entry| {
                if (remaining < 8) return error.InvalidOptions;
                remaining -= 8;
                if (entry.key.len == 0 or entry.key.len > remaining) return error.InvalidOptions;
                remaining -= entry.key.len;
                if (entry.value.len > remaining) return error.InvalidOptions;
                remaining -= entry.value.len;
                if (std.mem.findScalar(u8, entry.key, 0) != null or
                    std.mem.findScalar(u8, entry.key, '=') != null or
                    std.mem.findScalar(u8, entry.value, 0) != null or
                    !std.unicode.utf8ValidateSlice(entry.key) or !std.unicode.utf8ValidateSlice(entry.value))
                {
                    return error.InvalidOptions;
                }
                try environment.?.put(entry.key, entry.value);
            }
        }
        const attached = try renderer.CliRenderer.createWithOptions(self.allocator, width, height, &self.graphemes, .{
            .io = self.io,
            .logger = &self.logger,
            .remote_mode = options.remote_mode,
            .output = .{ .feed = value.output },
            .link_pool = &self.links,
            .env_map = options.env_map,
        });
        attached.getCurrentBuffer().owner_context_id = self.objects.context_id;
        attached.getNextBuffer().owner_context_id = self.objects.context_id;
        attached.terminal.setCursorPosition(1, 1, false);
        if (environment) |map| {
            attached.terminal.adoptHostEnvironment(map);
            attached.syncWidthMethod();
        }
        value.renderer = attached;
    }

    /// Borrows the Session's renderer for buffer drawing and queries, not ownership.
    /// Draw only when no frame awaits completion. Output, presentation, resize,
    /// terminal lifecycle, and destruction must go through the Session's Context
    /// methods, never through this pointer.
    pub fn getSessionRenderer(self: *Context, handle: Handle) Error!*renderer.CliRenderer {
        const value = try self.getSession(handle);
        return value.renderer orelse error.RendererNotAttached;
    }

    /// Retains mutable storage, not a frame. Finish drawing before submitting a
    /// frame; later rendering can change these cells without retiring storage.
    pub fn acquireSessionBufferLease(self: *Context, handle: Handle, which: RendererBuffer) Error!Handle {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getSession(handle);
        try value.checkRendering();
        try value.checkFrameIdle();
        const attached = value.renderer orelse return error.RendererNotAttached;
        if (value.frame_end_offset != null or attached.pendingPresentation != null) {
            return error.PresentationPending;
        }
        return self.acquireBufferLease(switch (which) {
            .current => attached.getCurrentBuffer(),
            .next => attached.getNextBuffer(),
        });
    }

    /// Composites retained cells and image references into the next framebuffer.
    /// Rejection preserves cells and output, but can retain tracker capacity.
    pub fn drawSessionBuffer(self: *Context, handle: Handle, source_handle: Handle, x: i32, y: i32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getSession(handle);
        try value.checkRendering();
        try value.checkFrameIdle();
        const attached = value.renderer orelse return error.RendererNotAttached;
        if (value.frame_end_offset != null or attached.pendingPresentation != null) {
            return error.PresentationPending;
        }
        const source = try self.getBuffer(source_handle);
        const target = attached.getNextBuffer();
        try drawContextBuffer(target, source, x, y, .{});
    }

    pub fn drawContextBuffer(target: *buf.OptimizedBuffer, source: *buf.OptimizedBuffer, x: i32, y: i32, crop: BufferCrop) !void {
        std.debug.assert(target.pool == source.pool and target.link_pool == source.link_pool);
        if (target == source) return error.InvalidOptions;
        try source.checkImageResources();
        try target.checkImageResources();
        if (crop.x >= source.width or crop.y >= source.height) return;
        const width = @min(crop.width orelse source.width, source.width - crop.x);
        const height = @min(crop.height orelse source.height, source.height - crop.y);
        if (width == 0 or height == 0) return;
        const end_x = @as(i64, x) + width;
        const end_y = @as(i64, y) + height;
        if (x >= target.width or y >= target.height or end_x <= 0 or end_y <= 0) return;
        // The compositor adds the exclusive endpoint before subtracting one.
        if (target.width > std.math.maxInt(i32) or target.height > std.math.maxInt(i32) or
            end_x > std.math.maxInt(i32) or end_y > std.math.maxInt(i32))
        {
            return error.InvalidDimensions;
        }
        const entries = @as(u64, target.buffer.char.len) + 1;
        target.storage.ensureTrackerCapacity(
            if (source.grapheme_tracker.hasAny()) entries else 0,
            if (source.link_tracker.hasAny()) entries else 0,
        ) catch |err| return switch (err) {
            error.TrackerLimit => error.ObjectLimit,
            error.OutOfMemory => error.OutOfMemory,
        };
        try target.drawFrameBufferChecked(x, y, source, crop.x, crop.y, width, height);
    }

    pub fn sessionSetDebugOverlay(self: *Context, handle: Handle, enabled: bool, corner: u32) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getSession(handle);
        try value.checkOpen();
        const attached = value.renderer orelse return error.RendererNotAttached;
        if (corner > 3) return error.InvalidOptions;
        attached.setDebugOverlay(enabled, @enumFromInt(corner));
    }

    pub fn sessionUpdateStats(self: *Context, handle: Handle, overall_ms: f64, fps: u32, callback_ms: f64) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getSession(handle);
        try value.checkOpen();
        const attached = value.renderer orelse return error.RendererNotAttached;
        if (!std.math.isFinite(overall_ms) or overall_ms < 0 or !std.math.isFinite(callback_ms) or callback_ms < 0) return error.InvalidOptions;
        attached.updateStats(overall_ms, fps, callback_ms);
    }

    pub fn sessionUpdateMemoryStats(self: *Context, handle: Handle, heap_used: u32, heap_total: u32, array_buffers: u32) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getSession(handle);
        try value.checkOpen();
        const attached = value.renderer orelse return error.RendererNotAttached;
        attached.updateMemoryStats(heap_used, heap_total, array_buffers);
    }

    pub fn sessionDumpHitGrid(self: *Context, handle: Handle) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getSession(handle);
        try value.checkOpen();
        const attached = value.renderer orelse return error.RendererNotAttached;
        attached.dumpHitGrid();
    }

    pub fn renderSession(self: *Context, handle: Handle, force: bool) Error!session.RenderStatus {
        try self.beginMutation();
        defer self.mutating = false;
        return (try self.getSession(handle)).render(force);
    }

    /// Must precede accepted frames. Queued or copied raw middleware output is valid.
    pub fn setupSessionTerminal(self: *Context, handle: Handle, options: session.TerminalOptions) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        try (try self.getSession(handle)).setupTerminal(options);
    }

    pub fn suspendSession(self: *Context, handle: Handle) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        try (try self.getSession(handle)).suspendTerminal();
    }

    pub fn resumeSession(self: *Context, handle: Handle) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        try (try self.getSession(handle)).resumeTerminal();
    }

    pub fn pumpSession(self: *Context, handle: Handle, now_ns: u64, work_budget: u32) Error!session.PumpResult {
        try self.beginMutation();
        defer self.mutating = false;
        return (try self.getSession(handle)).pump(now_ns, work_budget);
    }

    pub fn getSessionTerminalState(self: *Context, handle: Handle) Error!session.TerminalState {
        return (try self.getSession(handle)).getTerminalState();
    }

    pub fn controlSession(self: *Context, handle: Handle, command: session.Control) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        try (try self.getSession(handle)).control(command);
    }

    pub fn writeSessionClipboard(self: *Context, handle: Handle, target: @import("terminal.zig").ClipboardTarget, bytes: []const u8) Error!bool {
        try self.beginMutation();
        defer self.mutating = false;
        return (try self.getSession(handle)).writeClipboard(target, bytes);
    }

    pub fn resizeSessionRenderer(self: *Context, handle: Handle, width: u32, height: u32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getSession(handle);
        try value.checkResizing();
        const yielded = if (value.scene) |owned| owned.isYielded() else false;
        if (!yielded) try value.checkLayoutIdle();
        const attached = value.renderer orelse return error.RendererNotAttached;
        const cells = std.math.mul(u32, width, height) catch return error.InvalidDimensions;
        if (width == 0 or height == 0 or cells > self.render_cells_max) return error.InvalidDimensions;
        if (!value.isDrained()) return error.Busy;
        const changed = attached.width != width or attached.height != height;
        try attached.resize(width, height);
        if (yielded and changed) {
            value.cancelSceneFrame();
        } else if (value.scene) |owned| owned.requalifyPainted(attached);
    }

    pub fn writeSession(self: *Context, handle: Handle, bytes: []const u8) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        try (try self.getSession(handle)).write(bytes);
    }

    pub fn readOutput(self: *Context, handle: Handle, out: []u8) Error!?session.OutputTicket {
        try self.beginMutation();
        defer self.mutating = false;
        return (try self.getSession(handle)).readOutput(out);
    }

    pub fn completeOutput(
        self: *Context,
        handle: Handle,
        ticket: session.OutputTicket,
        result: session.OutputResult,
    ) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        try (try self.getSession(handle)).completeOutput(ticket, result);
    }

    pub fn beginSessionClose(self: *Context, handle: Handle) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        try (try self.getSession(handle)).beginClose();
    }

    pub fn cancelSession(self: *Context, handle: Handle) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        (try self.getSession(handle)).cancel();
    }

    pub fn createBuffer(self: *Context, width: u32, height: u32, options: BufferOptions) !Handle {
        try self.beginMutation();
        defer self.mutating = false;
        try self.checkBufferDimensions(width, height);
        try self.objects.checkCapacity();
        const value = try buf.OptimizedBuffer.init(self.allocator, width, height, .{
            .pool = &self.graphemes,
            .link_pool = &self.links,
            .logger = &self.logger,
            .respectAlpha = options.respect_alpha,
            .width_method = options.width_method,
        });
        errdefer value.deinit();
        value.owner_context_id = self.objects.context_id;
        value.cells_max = self.render_cells_max;
        return self.objects.insert(.buffer, value);
    }

    pub fn importImage(self: *Context, source: *const image.Image) !Handle {
        try self.beginMutation();
        defer self.mutating = false;
        try self.objects.checkCapacity();
        if (self.last_image_id == std.math.maxInt(u32)) return error.ObjectLimit;
        const value = try source.cloneOwned(self.allocator, self.io);
        errdefer value.deinit();
        const handle = try self.objects.insert(.image, value);
        self.last_image_id += 1;
        value.render_id = self.last_image_id;
        value.owner_context_id = self.objects.context_id;
        return handle;
    }

    pub fn createUnicode(self: *Context, text: []const u8, width_method: utf8.WidthMethod) !Handle {
        try self.beginMutation();
        defer self.mutating = false;
        try self.objects.checkCapacity();
        const value = try EncodedUnicode.init(self.allocator, &self.graphemes, text, width_method);
        errdefer value.deinit(self.allocator, &self.graphemes);
        return self.objects.insert(.encoded_unicode, value);
    }

    pub fn getUnicode(self: *Context, handle: Handle) Error!*EncodedUnicode {
        if (self.closing) return error.ContextClosed;
        return self.objects.get(handle, .encoded_unicode, EncodedUnicode);
    }

    pub fn drawBufferUnicode(self: *Context, handle: Handle, frame: ?scene.FrameRequest, source_handle: Handle, index: u32, x: i32, y: i32, foreground: buf.RGBA, background: buf.RGBA, attributes: u32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const target = if (frame) |ticket| try self.frameDrawTarget(handle, ticket) else try self.getBuffer(handle);
        const source = try self.getUnicode(source_handle);
        if (index >= source.chars.len) return error.InvalidOptions;
        try buf.validateColor(foreground);
        try buf.validateColor(background);
        if (attributes & ~ansi.TextAttributes.ATTRIBUTE_BASE_MASK != 0) return error.InvalidOptions;
        try target.checkImageResources();
        if (x < 0 or y < 0 or x >= target.width or y >= target.height) return;
        const char = source.chars[index].char;
        const width = grapheme.encodedCharWidth(char);
        if (width > target.width - @as(u32, @intCast(x))) return;
        for (0..width) |offset| {
            if (!target.isPointInScissor(x + @as(i32, @intCast(offset)), y)) return;
        }
        if (grapheme.isGraphemeChar(char)) {
            const id = grapheme.graphemeIdFromChar(char);
            if ((try self.graphemes.getRefcount(id)) == std.math.maxInt(u32)) return error.TrackerLimit;
            try target.storage.ensureTrackerCapacity(
                @min(@as(u64, target.grapheme_tracker.getGraphemeCount()) + 1, @as(u64, target.buffer.char.len) + 1),
                target.link_tracker.getLinkCount(),
            );
        }
        target.drawChar(char, @intCast(x), @intCast(y), foreground, background, attributes);
    }

    pub fn createEmbeddedTerminal(self: *Context, cols: u32, rows: u32, max_scrollback: u32) !Handle {
        try self.beginMutation();
        defer self.mutating = false;
        try self.checkBufferDimensions(cols, rows);
        if (cols > std.math.maxInt(u16) or rows > std.math.maxInt(u16)) return error.InvalidDimensions;
        try self.objects.checkCapacity();
        const value = try embedded_terminal.EmbeddedTerminal.init(self.io, self.allocator, .{
            .cols = @intCast(cols),
            .rows = @intCast(rows),
            .max_scrollback = max_scrollback,
            .logger = &self.logger,
        });
        errdefer value.deinit();
        return self.objects.insert(.embedded_terminal, value);
    }

    pub fn getEmbeddedTerminal(self: *Context, handle: Handle) Error!*embedded_terminal.EmbeddedTerminal {
        if (self.closing) return error.ContextClosed;
        return self.objects.get(handle, .embedded_terminal, embedded_terminal.EmbeddedTerminal);
    }

    pub fn embeddedTerminalWrite(self: *Context, handle: Handle, bytes: []const u8) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getEmbeddedTerminal(handle);
        if (bytes.len > terminal_input_bytes_max) return error.TextLimit;
        try value.write(bytes);
    }

    pub fn embeddedTerminalResize(self: *Context, handle: Handle, cols: u32, rows: u32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getEmbeddedTerminal(handle);
        try self.checkBufferDimensions(cols, rows);
        if (cols > std.math.maxInt(u16) or rows > std.math.maxInt(u16)) return error.InvalidDimensions;
        try value.resize(@intCast(cols), @intCast(rows));
    }

    pub fn embeddedTerminalCommand(self: *Context, handle: Handle, command: u32, argument: i32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getEmbeddedTerminal(handle);
        if (command != 1 and argument != 0) return error.InvalidOptions;
        switch (command) {
            0 => value.invalidate(),
            1 => value.scroll(argument),
            2 => value.clearSelection(),
            else => return error.InvalidOptions,
        }
    }

    pub fn embeddedTerminalSetSelection(self: *Context, handle: Handle, start_x: u32, start_y: u32, end_x: u32, end_y: u32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getEmbeddedTerminal(handle);
        if (comptime !@import("ghostty_vt_options").available) return error.Unsupported;
        if (start_x >= value.cols or end_x >= value.cols or start_y >= value.rows or end_y >= value.rows) return error.InvalidOptions;
        try value.setSelection(.{ .x = @intCast(start_x), .y = @intCast(start_y) }, .{ .x = @intCast(end_x), .y = @intCast(end_y) });
    }

    pub fn embeddedTerminalGetSelectedText(self: *Context, handle: Handle, output: []u8) !u32 {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getEmbeddedTerminal(handle);
        const text = try value.selectedText();
        defer value.freeSelectedText(text);
        return copyTerminalOutput(output, text);
    }

    pub fn embeddedTerminalCompose(self: *Context, source_handle: Handle, handle: Handle, frame: ?scene.FrameRequest, x: i32, y: i32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const target = if (frame) |ticket| try self.frameDrawTarget(handle, ticket) else try self.getBuffer(handle);
        const source = try self.getEmbeddedTerminal(source_handle);
        // Session drafts are cleared between frames; only retained buffers keep clean rows.
        if (frame != null) source.invalidate();
        try source.composeChecked(target, x, y, self.render_cells_max);
    }

    pub fn embeddedTerminalCursor(self: *Context, handle: Handle) !embedded_terminal.Cursor {
        try self.checkSceneRead();
        return (try self.getEmbeddedTerminal(handle)).cursor();
    }

    pub fn embeddedTerminalEncodeKey(self: *Context, handle: Handle, options: EmbeddedTerminalKey, output: []u8) !u32 {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getEmbeddedTerminal(handle);
        if (comptime !@import("ghostty_vt_options").available) return error.Unsupported;
        if (options.action > 2 or options.mods & ~@as(u32, 0x3f) != 0 or options.consumed_mods & ~@as(u32, 0x3f) != 0 or
            options.unshifted_codepoint > 0x10ffff or (options.unshifted_codepoint >= 0xd800 and options.unshifted_codepoint <= 0xdfff)) return error.InvalidOptions;
        if (options.key.len > terminal_input_bytes_max or options.text.len > terminal_input_bytes_max) return error.TextLimit;
        if (!std.unicode.utf8ValidateSlice(options.text)) return error.InvalidUnicode;
        const vt = @import("ghostty-vt.zig").vt;
        const encoded = try value.encodeKey(.{
            .action = switch (options.action) {
                0 => .release,
                1 => .press,
                2 => .repeat,
                else => unreachable,
            },
            .key = vt.input.Key.fromW3C(options.key) orelse .unidentified,
            .mods = @bitCast(@as(u16, @intCast(options.mods))),
            .consumed_mods = @bitCast(@as(u16, @intCast(options.consumed_mods))),
            .composing = options.composing,
            .utf8 = options.text,
            .unshifted_codepoint = @intCast(options.unshifted_codepoint),
        });
        defer value.freeEncoded(encoded);
        return copyTerminalOutput(output, encoded);
    }

    pub fn embeddedTerminalEncodeMouse(self: *Context, handle: Handle, options: EmbeddedTerminalMouse, output: []u8) !u32 {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getEmbeddedTerminal(handle);
        if (comptime !@import("ghostty_vt_options").available) return error.Unsupported;
        if (options.action > 2 or options.button < -1 or options.button > 7 or options.mods & ~@as(u32, 0x3f) != 0 or
            !std.math.isFinite(options.x) or !std.math.isFinite(options.y)) return error.InvalidOptions;
        const previous = value.mouse_last_cell;
        errdefer value.mouse_last_cell = previous;
        const encoded = try value.encodeMouse(.{
            .action = switch (options.action) {
                0 => .press,
                1 => .release,
                2 => .motion,
                else => unreachable,
            },
            .button = switch (options.button) {
                -1 => null,
                0 => .unknown,
                1 => .left,
                2 => .right,
                3 => .middle,
                4 => .four,
                5 => .five,
                6 => .six,
                7 => .seven,
                else => unreachable,
            },
            .mods = @bitCast(@as(u16, @intCast(options.mods))),
            .x = options.x,
            .y = options.y,
            .any_button_pressed = options.any_button_pressed,
        });
        defer value.freeEncoded(encoded);
        // Sizing and rejected output must not suppress the caller's retry as duplicate motion.
        if (output.len == 0) value.mouse_last_cell = previous;
        return copyTerminalOutput(output, encoded);
    }

    pub fn embeddedTerminalEncodePaste(self: *Context, handle: Handle, input: []const u8, output: []u8) !u32 {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getEmbeddedTerminal(handle);
        if (input.len > terminal_input_bytes_max) return error.TextLimit;
        const encoded = try value.encodePaste(input);
        defer value.freeEncoded(encoded);
        return copyTerminalOutput(output, encoded);
    }

    pub fn embeddedTerminalEncodeFocus(self: *Context, handle: Handle, focused: bool, output: []u8) !u32 {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getEmbeddedTerminal(handle);
        const encoded = try value.encodeFocus(focused);
        defer value.freeEncoded(encoded);
        return copyTerminalOutput(output, encoded);
    }

    pub fn embeddedTerminalDrainResponses(self: *Context, handle: Handle, output: []u8) !u32 {
        try self.beginMutation();
        defer self.mutating = false;
        return @intCast(try (try self.getEmbeddedTerminal(handle)).drainResponses(output));
    }

    fn copyTerminalOutput(output: []u8, bytes: []const u8) !u32 {
        if (bytes.len > std.math.maxInt(u32)) return error.TextLimit;
        if (output.len != 0) {
            if (bytes.len > output.len) return error.BufferTooSmall;
            @memcpy(output[0..bytes.len], bytes);
        }
        return @intCast(bytes.len);
    }

    pub fn getImage(self: *Context, handle: Handle) Error!*image.Image {
        if (self.closing) return error.ContextClosed;
        return self.objects.get(handle, .image, image.Image);
    }

    pub fn drawBufferImage(self: *Context, handle: Handle, frame: ?scene.FrameRequest, source_handle: Handle, options: ImageDraw) !bool {
        try self.beginMutation();
        defer self.mutating = false;
        const target = if (frame) |ticket| try self.frameDrawTarget(handle, ticket) else try self.getBuffer(handle);
        const source = try self.getImage(source_handle);
        try target.checkImageResources();
        if (options.source_x > source.width() or options.source_y > source.height()) return error.InvalidOptions;
        const width = options.source_width orelse source.width() - options.source_x;
        const height = options.source_height orelse source.height() - options.source_y;
        if (width > source.width() - options.source_x or height > source.height() - options.source_y) return error.InvalidOptions;
        if (source.ref_count == std.math.maxInt(u32)) return error.ObjectLimit;
        return target.drawImage(source, source.render_id, options.x, options.y, options.width, options.height, options.pixel_width, options.pixel_height, options.source_x, options.source_y, width, height, options.protocol);
    }

    pub fn sessionSetImageResolution(self: *Context, handle: Handle, terminal_width: u32, terminal_height: u32, pixel_width: u32, pixel_height: u32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getSession(handle);
        try value.checkOpen();
        const attached = value.renderer orelse return error.RendererNotAttached;
        const cleared = terminal_width == 0 and terminal_height == 0 and pixel_width == 0 and pixel_height == 0;
        if (!cleared and (terminal_width == 0 or terminal_height == 0 or pixel_width == 0 or pixel_height == 0)) return error.InvalidOptions;
        attached.image_resolution = .{
            .terminal_width = terminal_width,
            .terminal_height = terminal_height,
            .pixel_width = pixel_width,
            .pixel_height = pixel_height,
        };
    }

    pub fn sessionSetKittyImageTransport(self: *Context, handle: Handle, mode: u32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        try (try self.getSession(handle)).setKittyImageTransport(mode);
    }

    pub fn sessionKittyImageTransportStatus(self: *Context, handle: Handle) ![6]u32 {
        return (try self.getSession(handle)).kittyImageTransportStatus();
    }

    pub fn sessionPollKittyImageTransport(self: *Context, handle: Handle) !bool {
        try self.beginMutation();
        defer self.mutating = false;
        return (try self.getSession(handle)).pollKittyImageTransport();
    }

    pub fn sessionCancelKittyImageTransport(self: *Context, handle: Handle, failed: bool) !void {
        try self.beginMutation();
        defer self.mutating = false;
        try (try self.getSession(handle)).cancelKittyImageTransport(failed);
    }

    pub fn sessionProcessKittyImageReply(self: *Context, handle: Handle, response: []const u8) !u32 {
        try self.beginMutation();
        defer self.mutating = false;
        return (try self.getSession(handle)).processKittyImageReply(response);
    }

    pub fn sessionStartKittyFileProbe(self: *Context, handle: Handle) !void {
        try self.beginMutation();
        defer self.mutating = false;
        try (try self.getSession(handle)).startKittyFileProbe();
    }

    pub fn getBuffer(self: *Context, handle: Handle) Error!*buf.OptimizedBuffer {
        if (self.closing) return error.ContextClosed;
        return self.objects.get(handle, .buffer, buf.OptimizedBuffer);
    }

    pub fn resizeBuffer(self: *Context, handle: Handle, width: u32, height: u32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getBuffer(handle);
        try self.checkBufferDimensions(width, height);
        try value.resize(width, height);
    }

    pub fn clearBuffer(self: *Context, handle: Handle, background: buf.RGBA) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getBuffer(handle);
        try buf.validateColor(background);
        value.clear(background, null);
    }

    pub fn drawBufferText(
        self: *Context,
        handle: Handle,
        text: []const u8,
        x: u32,
        y: u32,
        foreground: buf.RGBA,
        background: ?buf.RGBA,
        attributes: u32,
    ) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getBuffer(handle);
        try value.drawTextChecked(text, x, y, foreground, background, attributes);
    }

    pub fn fillBufferRect(self: *Context, handle: Handle, x: u32, y: u32, width: u32, height: u32, background: buf.RGBA) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getBuffer(handle);
        try buf.validateColor(background);
        if (x >= value.width or y >= value.height) return;
        // Clip before the native fill's signed scissor and unsigned endpoint arithmetic.
        value.fillRect(x, y, @min(width, value.width - x), @min(height, value.height - y), background);
    }

    /// A Session target requires the exact active prefix or painted-frame ticket.
    /// No handle or raw address can grant access to a Session's framebuffer alone.
    pub fn drawBuffer(self: *Context, handle: Handle, frame: ?scene.FrameRequest, options: BufferDraw, text: []const u8, bottom_title: []const u8) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const target = if (frame) |ticket| try self.frameDrawTarget(handle, ticket) else try self.getBuffer(handle);
        const background = options.background orelse ansi.rgbColor(0, 0, 0, 0);
        for ([_]buf.RGBA{ options.foreground, background, options.title_color }) |color| try buf.validateColor(color);
        if (options.attributes & ~ansi.TextAttributes.ATTRIBUTE_BASE_MASK != 0) return error.InvalidOptions;
        try target.checkImageResources();
        switch (options.operation) {
            .clear => target.clear(background, null),
            .respect_alpha => {
                if (frame != null or options.packed_options > 1) return error.InvalidOptions;
                target.respectAlpha = options.packed_options == 1;
            },
            .compose => try drawContextBuffer(target, try self.getBuffer(options.source orelse return error.InvalidOptions), options.x, options.y, options.crop),
            .box => {
                if (options.packed_options & ~@as(u32, 0x1ff) != 0 or
                    (options.packed_options >> 5) & 3 > 2 or (options.packed_options >> 7) & 3 > 2) return error.InvalidOptions;
                if (options.width == 0 or options.height == 0) return;
                if (options.width > std.math.maxInt(i32) or options.height > std.math.maxInt(i32) or
                    @as(i64, options.x) + options.width > std.math.maxInt(i32) or
                    @as(i64, options.y) + options.height > std.math.maxInt(i32)) return error.InvalidDimensions;
                for (options.border_chars) |char| {
                    if (char > 0x10ffff or (char >= 0xd800 and char <= 0xdfff) or
                        (char != 0 and (char < 32 or (char >= 127 and char <= 159)))) return error.InvalidOptions;
                }
                try buf.validateTextInput(text);
                try buf.validateTextInput(bottom_title);
                try target.drawBoxChecked(options.x, options.y, options.width, options.height, &options.border_chars, .{
                    .top = options.packed_options & 8 != 0,
                    .right = options.packed_options & 4 != 0,
                    .bottom = options.packed_options & 2 != 0,
                    .left = options.packed_options & 1 != 0,
                }, options.foreground, background, options.title_color, options.packed_options & 16 != 0, if (text.len == 0) null else text, @intCast((options.packed_options >> 5) & 3), if (bottom_title.len == 0) null else bottom_title, @intCast((options.packed_options >> 7) & 3));
            },
            .text, .fill, .cell, .cell_blend, .char => {
                if (options.operation == .text) try buf.validateTextInput(text);
                if (options.operation == .cell or options.operation == .cell_blend or options.operation == .char) {
                    if (options.char > 0x10ffff or (options.char >= 0xd800 and options.char <= 0xdfff) or
                        options.char < 32 or (options.char >= 127 and options.char <= 159)) return error.InvalidOptions;
                }
                if (options.x < 0 or options.y < 0) return;
                const x: u32 = @intCast(options.x);
                const y: u32 = @intCast(options.y);
                if (x >= target.width or y >= target.height) return;
                switch (options.operation) {
                    .text => try target.drawTextChecked(text, x, y, options.foreground, options.background, options.attributes),
                    .fill => target.fillRect(x, y, @min(options.width, target.width - x), @min(options.height, target.height - y), background),
                    .cell => target.set(x, y, .{ .char = options.char, .fg = options.foreground, .bg = background, .attributes = options.attributes }),
                    .cell_blend => target.setCellWithAlphaBlending(x, y, options.char, options.foreground, background, options.attributes),
                    .char => target.drawChar(options.char, x, y, options.foreground, background, options.attributes),
                    else => unreachable,
                }
            },
        }
    }

    pub fn bufferStack(self: *Context, handle: Handle, frame: ?scene.FrameRequest, options: BufferStack) !f32 {
        try self.beginMutation();
        defer self.mutating = false;
        const target = if (frame) |ticket| try self.frameDrawTarget(handle, ticket) else try self.getBuffer(handle);
        // Each paint request starts with exactly one scene-owned clip and opacity.
        const floor: usize = if (frame) |ticket| @intFromBool(ticket.kind != 0) else 0;
        std.debug.assert(target.scissor_stack.items.len >= floor);
        std.debug.assert(target.opacity_stack.items.len >= floor);
        switch (options.operation) {
            .get_opacity => {},
            .push_scissor => {
                if (options.width > std.math.maxInt(i32) or options.height > std.math.maxInt(i32) or
                    @as(i64, options.x) + options.width > std.math.maxInt(i32) or
                    @as(i64, options.y) + options.height > std.math.maxInt(i32)) return error.InvalidDimensions;
                if (target.scissor_stack.items.len - floor >= BufferStack.depth_max) return error.ObjectLimit;
                try target.pushScissorRect(options.x, options.y, options.width, options.height);
            },
            .pop_scissor => if (target.scissor_stack.items.len > floor) {
                target.popScissorRect();
            },
            .clear_scissors => target.scissor_stack.shrinkRetainingCapacity(floor),
            .push_opacity => {
                if (!std.math.isFinite(options.opacity)) return error.InvalidOptions;
                if (target.opacity_stack.items.len - floor >= BufferStack.depth_max) return error.ObjectLimit;
                try target.pushOpacity(options.opacity);
            },
            .pop_opacity => if (target.opacity_stack.items.len > floor) {
                target.popOpacity();
            },
            .clear_opacity => target.opacity_stack.shrinkRetainingCapacity(floor),
        }
        return target.getCurrentOpacity();
    }

    pub fn drawGrid(self: *Context, handle: Handle, frame: ?scene.FrameRequest, options: BufferGrid, columns: []const i32, rows: []const i32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const target = if (frame) |ticket| try self.frameDrawTarget(handle, ticket) else try self.getBuffer(handle);
        try target.checkImageResources();
        try buf.validateColor(options.foreground);
        try buf.validateColor(options.background);
        for (options.border_chars) |char| {
            if (char > 0x10ffff or (char >= 0xd800 and char <= 0xdfff) or
                (char != 0 and utf8.eastAsianWidth(@intCast(char)) != 1)) return error.InvalidOptions;
        }
        for ([_][]const i32{ columns, rows }) |offsets| {
            if (offsets.len > @as(u64, self.render_cells_max) + 1) return error.InvalidOptions;
            for (offsets, 0..) |offset, index| {
                if (index != 0 and offset <= offsets[index - 1]) return error.InvalidOptions;
            }
        }
        if (columns.len < 2 or rows.len < 2) return;
        target.drawGrid(&options.border_chars, options.foreground, options.background, columns.ptr, @intCast(columns.len - 1), rows.ptr, @intCast(rows.len - 1), options.draw_inner, options.draw_outer);
    }

    pub fn drawPackedBuffer(self: *Context, handle: Handle, frame: ?scene.FrameRequest, data: []const u8, x: u32, y: u32, width: u32, height: u32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const target = if (frame) |ticket| try self.frameDrawTarget(handle, ticket) else try self.getBuffer(handle);
        try target.drawPackedBufferChecked(data, x, y, width, height);
    }

    pub fn drawSuperSampleBuffer(self: *Context, handle: Handle, frame: ?scene.FrameRequest, data: []const u8, x: u32, y: u32, format: u32, stride: u32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const target = if (frame) |ticket| try self.frameDrawTarget(handle, ticket) else try self.getBuffer(handle);
        if (format > 1) return error.InvalidOptions;
        try target.drawSuperSampleBufferChecked(x, y, data, @intCast(format), stride);
    }

    pub fn drawGrayscaleBuffer(self: *Context, handle: Handle, frame: ?scene.FrameRequest, data: []align(1) const f32, x: i32, y: i32, width: u32, height: u32, foreground: ?buf.RGBA, background: ?buf.RGBA, supersampled: bool) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const target = if (frame) |ticket| try self.frameDrawTarget(handle, ticket) else try self.getBuffer(handle);
        try target.drawGrayscaleBufferChecked(x, y, data, width, height, foreground, background, supersampled);
    }

    pub fn colorMatrixBuffer(self: *Context, handle: Handle, frame: ?scene.FrameRequest, matrix: []align(1) const f32, mask: ?[]align(1) const f32, strength: f32, channel: u32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const target = if (frame) |ticket| try self.frameDrawTarget(handle, ticket) else try self.getBuffer(handle);
        if (matrix.len != 16 or !std.math.isFinite(strength) or channel < 1 or channel > 3) return error.InvalidOptions;
        for (matrix) |value| if (!std.math.isFinite(value)) return error.InvalidOptions;
        if (mask) |cells| {
            if (cells.len / 3 > self.render_cells_max) return error.InvalidOptions;
        }
        try target.checkImageResources();
        const channels: buffer_effects.ColorTarget = @enumFromInt(channel);
        if (mask) |cells| {
            buffer_effects.colorMatrix(target, matrix, cells, strength, channels);
        } else {
            buffer_effects.colorMatrixUniform(target, matrix, strength, channels);
        }
    }

    pub fn checkBufferDimensions(self: *const Context, width: u32, height: u32) Error!void {
        const cells = std.math.mul(u32, width, height) catch return error.InvalidDimensions;
        if (width == 0 or height == 0 or cells > self.render_cells_max or
            width > std.math.maxInt(i32) or height > std.math.maxInt(i32))
        {
            return error.InvalidDimensions;
        }
    }

    pub fn drawTextBufferView(self: *Context, handle: Handle, frame: ?scene.FrameRequest, view_handle: Handle, x: i32, y: i32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const target = if (frame) |ticket| try self.frameDrawTarget(handle, ticket) else try self.getBuffer(handle);
        const view = try self.getTextBufferView(view_handle);
        if (x >= target.width or y >= target.height) return;
        try view.prepareView();
        try target.drawTextBufferChecked(view.view, x, y);
    }

    pub fn drawEditorView(self: *Context, handle: Handle, frame: ?scene.FrameRequest, view_handle: Handle, x: i32, y: i32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const target = if (frame) |ticket| try self.frameDrawTarget(handle, ticket) else try self.getBuffer(handle);
        const editor = try self.getEditorView(view_handle);
        if (x >= target.width or y >= target.height) return;
        try target.drawEditorViewChecked(editor.view, x, y);
    }

    pub fn drawSceneText(self: *Context, handle: Handle, frame: ?scene.FrameRequest, node_handle: Handle, x: i32, y: i32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const target = if (frame) |ticket| try self.frameDrawTarget(handle, ticket) else try self.getBuffer(handle);
        const node = try self.sceneNode(node_handle);
        const text = node.scene_node.?.text orelse return error.WrongKind;
        if (x >= target.width or y >= target.height) return;
        try text.prepareView();
        try target.drawTextBufferChecked(text.view, x, y);
    }

    pub fn acquireOwnedBufferLease(self: *Context, handle: Handle) Error!Handle {
        try self.beginMutation();
        defer self.mutating = false;
        return self.acquireBufferLease(try self.getBuffer(handle));
    }

    fn acquireBufferLease(self: *Context, target: *buf.OptimizedBuffer) Error!Handle {
        std.debug.assert(self.mutating);
        if (self.lease_count >= self.lease_count_max) return error.LeaseLimit;
        try self.objects.checkCapacity();
        var lease = try buf.BufferLease.acquireChecked(
            target,
            &self.lease_count,
            self.lease_count_max,
            &self.lease_bytes,
            &self.lease_bytes_max,
        );
        errdefer lease.releaseChecked(&self.lease_count, &self.lease_bytes, &self.lease_bytes_max);
        const result = try self.objects.insert(.buffer_lease, lease.storage.?);
        lease.storage = null;
        return result;
    }

    /// Resize/destroy makes the snapshot stale without freeing its storage.
    /// Saved aliases remain allocated until release, but must not be used after
    /// release or to change tagged IDs without maintaining the buffer trackers.
    pub fn bufferLeaseSnapshot(self: *Context, handle: Handle) Error!buf.BufferSnapshot {
        if (self.closing) return error.ContextClosed;
        if (self.mutating) return error.ContextBusy;
        const lease: buf.BufferLease = switch (try self.objects.getKind(handle)) {
            .buffer_lease => .{ .storage = try self.objects.get(handle, .buffer_lease, buf.BufferStorage) },
            .frame_buffer_lease => qualified: {
                const access = try self.objects.get(handle, .frame_buffer_lease, FrameBufferLease);
                const value = self.getSession(access.frame.session) catch return error.StaleLease;
                const owned = value.scene orelse return error.StaleLease;
                const painted = owned.checkFrameAccess(access.frame) catch return error.StaleLease;
                const attached = value.renderer orelse return error.StaleLease;
                if (painted.membership_epoch != access.membership_epoch or
                    !painted.destination.matches(attached.getNextBuffer())) return error.StaleLease;
                const target = switch (access.which) {
                    .current => attached.getCurrentBuffer(),
                    .next => attached.getNextBuffer(),
                };
                if (!access.destination.matches(target) or access.lease.storage != target.storage) return error.StaleLease;
                break :qualified access.lease;
            },
            else => return error.WrongKind,
        };
        return lease.snapshot() catch |err| switch (err) {
            error.StaleLease => error.StaleLease,
            error.LeaseReleased => unreachable,
        };
    }

    pub fn releaseBufferLease(self: *Context, handle: Handle) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        switch (try self.objects.getKind(handle)) {
            .buffer_lease, .frame_buffer_lease => {},
            else => return error.WrongKind,
        }
        self.destroyToken(try self.objects.beginDestroy(handle));
    }

    pub fn sceneCreateNode(self: *Context, session_handle: Handle, kind: u32, num: u32) !Handle {
        try self.beginMutation();
        defer self.mutating = false;
        if (kind > 8 or num == 0) return error.InvalidOptions;
        const value = try self.getSession(session_handle);
        try value.checkOpen();
        const attached = value.renderer orelse return error.RendererNotAttached;
        try self.objects.checkCapacity();
        const owned = value.scene orelse blk: {
            if (kind != 0) return error.SceneNotAttached;
            if (value.frame_end_offset != null or attached.renderStats.frameCount != 0) return error.InvalidTerminalState;
            break :blk try scene.Scene.init(self.allocator, &self.yoga_config, session_handle);
        };
        errdefer if (value.scene == null) owned.deinit();
        try owned.prepareInsert(kind, num);
        const storage = try self.createNodeStorage();
        const node = storage.node;
        errdefer {
            node.detachMeasure();
            self.releaseNodeStorage(storage);
        }
        try yoga.check(yoga.yogaNodeStyleSetFloatChecked(node.yoga_node, 2, 1));
        for (0..4) |edge| try yoga.check(yoga.yogaNodeStyleSetBorderChecked(node.yoga_node, @intCast(edge), 0));
        const text = if (kind == 2) try self.createTextResource(attached.getNextBuffer().width_method) else null;
        errdefer if (text) |resource| self.destroyTextResource(resource);
        if (text) |resource| {
            resource.view.setWrapMode(.word);
            try node.setMeasureTarget(.{ .text_buffer_view = resource.view });
        }
        const handle = try self.objects.insert(.native_renderable, node);
        owned.insert(storage, handle, kind, num);
        node.scene_node.?.text = text;
        value.scene = owned;
        return handle;
    }

    fn createNodeStorage(self: *Context) !native_renderable.NodeStorage {
        if (self.node_pool_count != 0) {
            self.node_pool_count -= 1;
            const storage = self.node_pool[self.node_pool_count];
            self.node_pool[self.node_pool_count] = undefined;
            self.node_pool_bytes -= storage.retainedBytes();
            errdefer self.freeNodeStorage(storage);
            // Only useWebDefaults affects Yoga's initial style; other config fields are read live.
            if (storage.reuse_web_defaults != yoga.yogaConfigGetUseWebDefaults(self.yoga_config.ref)) {
                try yoga.check(yoga.yogaNodeResetChecked(storage.node.yoga_node));
            }
            return storage;
        }
        // Reserve idle entries during construction; retirement must never allocate.
        const capacity_max = @min(self.objects.slots.len, node_pool_count_max);
        if (self.node_pool.len < @min(self.objects.live_count + 1, capacity_max)) {
            const capacity = @min(capacity_max, @max(8, self.node_pool.len * 2));
            self.node_pool = try self.allocator.realloc(self.node_pool, capacity);
        }
        const node = try self.allocator.create(native_renderable.NativeRenderable);
        errdefer self.allocator.destroy(node);
        node.* = try native_renderable.NativeRenderable.initWithConfig(&self.yoga_config);
        node.context_owned = true;
        return .{ .node = node };
    }

    fn releaseNodeStorage(self: *Context, storage: native_renderable.NodeStorage) void {
        const node = storage.node;
        // Destruction and constructor rollback detach measurement before releasing storage.
        if (!self.closing and self.node_pool_count < self.node_pool.len and node.resetForReuse()) {
            const bytes = storage.retainedBytes();
            const entries_bytes = self.node_pool.len * @sizeOf(native_renderable.NodeStorage);
            if (bytes <= node_pool_bytes_max - entries_bytes - self.node_pool_bytes) {
                self.node_pool[self.node_pool_count] = storage;
                self.node_pool[self.node_pool_count].reuse_web_defaults = yoga.yogaConfigGetUseWebDefaults(self.yoga_config.ref);
                self.node_pool_count += 1;
                self.node_pool_bytes += bytes;
                return;
            }
        }
        self.freeNodeStorage(storage);
    }

    fn freeNodeStorage(self: *Context, storage: native_renderable.NodeStorage) void {
        var children = storage.children;
        var paint_children = storage.paint_children;
        children.deinit(self.allocator);
        paint_children.deinit(self.allocator);
        storage.node.deinit();
        self.allocator.destroy(storage.node);
    }

    fn sceneNode(self: *Context, handle: Handle) !*native_renderable.NativeRenderable {
        const node = try self.getRenderable(handle);
        if (node.scene_node == null) return error.WrongKind;
        return node;
    }

    fn sceneMutableNode(self: *Context, handle: Handle) !*native_renderable.NativeRenderable {
        const node = try self.sceneNode(handle);
        try (try self.getSession(node.scene_node.?.owner.session)).checkOpen();
        return node;
    }

    pub fn sceneDestroyNode(self: *Context, handle: Handle) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const node = try self.sceneNode(handle);
        try yoga.check(yoga.nodeTeardownStatus(node.yoga_node));
        self.destroyToken(try self.objects.beginDestroy(handle));
    }

    pub fn sceneSetMeasure(self: *Context, handle: Handle, callback: ?SceneMeasureCallback) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const node = try self.sceneMutableNode(handle);
        if (callback) |function| {
            if (self.scene_measures.get(handle.slot)) |registration| {
                try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(node.yoga_node, registration, &SceneMeasure.measure));
                registration.callback = function;
            } else {
                try self.scene_measures.ensureUnusedCapacity(self.allocator, 1);
                const registration = try self.allocator.create(SceneMeasure);
                errdefer self.allocator.destroy(registration);
                registration.* = .{ .owner = self, .handle = handle, .callback = function };
                try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(node.yoga_node, registration, &SceneMeasure.measure));
                self.scene_measures.putAssumeCapacity(handle.slot, registration);
            }
        } else {
            try yoga.check(yoga.yogaNodeSetNativeMeasureFunc(node.yoga_node, null, null));
            if (self.scene_measures.fetchRemove(handle.slot)) |entry| self.allocator.destroy(entry.value);
        }
        node.scene_node.?.measure_overridden = true;
        node.scene_node.?.owner.work.clearRetainingCapacity();
    }

    pub fn sceneSetBoxDetails(self: *Context, handle: Handle, details: scene.BoxDetails) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.sceneMutableNode(handle);
        try value.scene_node.?.owner.setBoxDetails(value, details);
    }

    pub fn sceneSetImage(self: *Context, handle: Handle, source_handle: ?Handle, fit: image.Fit, protocol: image.RenderProtocol, buffer_handle: ?Handle) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const node = try self.sceneMutableNode(handle);
        if (node.scene_node.?.kind != 8) return error.WrongKind;
        try yoga.check(yoga.nodeTeardownStatus(node.yoga_node));
        const source = if (source_handle) |id| try self.getImage(id) else null;
        const target = if (buffer_handle) |id| try self.getBuffer(id) else null;
        if (source) |value| {
            if (value.ref_count == std.math.maxInt(u32)) return error.ObjectLimit;
        }
        if (target) |value| try value.retain();
        if (source) |value| value.retain();
        node.scene_node.?.control.image.deinit();
        node.scene_node.?.control.image = .{ .source = source, .fit = fit, .protocol = protocol, .buffer = target };
    }

    pub fn sceneSetSurface(self: *Context, handle: Handle, buffer_handle: ?Handle) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const node = try self.sceneMutableNode(handle);
        if (node.scene_node.?.kind != 6) return error.WrongKind;
        try yoga.check(yoga.nodeTeardownStatus(node.yoga_node));
        const source = if (buffer_handle) |id| try self.getBuffer(id) else null;
        if (source) |value| try value.retain();
        if (node.surface) |previous| previous.deinit();
        node.surface = source;
    }

    pub fn sceneSetBoxBorderStyle(self: *Context, handle: Handle, style: u32, sides: u32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.sceneMutableNode(handle);
        const node = &value.scene_node.?;
        if (node.kind != 1) return error.WrongKind;
        var paint = node.paint;
        paint.borderStyle = style;
        paint.borderSides = sides;
        try node.owner.setPaint(value, paint);
        if (node.control.box) |details| details.custom_border_chars = null;
    }

    pub fn sceneSetEditorView(self: *Context, handle: Handle, view_handle: ?Handle) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.sceneMutableNode(handle);
        const node = &value.scene_node.?;
        if (node.kind != 5) return error.WrongKind;
        const editor = if (view_handle) |id| try self.getEditorView(id) else null;
        if (editor) |view| {
            if (view.node != null and view.node != value) return error.ContextBusy;
        }
        try value.setMeasureTargetPreservingProvider(if (editor) |view| .{ .editor_view = view.view } else .none, node.measure_overridden);
        if (node.editor) |previous| previous.node = null;
        node.editor = editor;
        if (editor) |view| view.node = value;
        node.owner.preparation_dirty = true;
        node.owner.work.clearRetainingCapacity();
    }

    pub fn sceneSetEditorOptions(self: *Context, handle: Handle, options: scene.EditorOptions) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.sceneMutableNode(handle);
        const node = &value.scene_node.?;
        if (node.kind != 5) return error.WrongKind;
        if (options.style > 3 or options.mouse_pointer > 6) return error.InvalidOptions;
        try buf.validateColor(options.color);
        node.control = .{ .editor = options };
    }

    pub fn sceneSetTextView(self: *Context, handle: Handle, view_handle: ?Handle) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.sceneMutableNode(handle);
        const node = &value.scene_node.?;
        if (node.kind != 7) return error.WrongKind;
        const text_view = if (view_handle) |id| try self.getTextBufferView(id) else null;
        if (text_view) |view| {
            if (view.node != null and view.node != value) return error.ContextBusy;
        }
        try value.setMeasureTargetPreservingProvider(if (text_view) |view| .{ .text_buffer_view = view.view } else .none, node.measure_overridden);
        if (node.control.text_view.view) |previous| previous.node = null;
        node.control.text_view.view = text_view;
        if (text_view) |view| view.node = value;
        node.owner.preparation_dirty = true;
        node.owner.work.clearRetainingCapacity();
    }

    pub fn sceneSetTextViewPaint(self: *Context, handle: Handle, enabled: bool) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.sceneMutableNode(handle);
        const node = &value.scene_node.?;
        if (node.kind != 7) return error.WrongKind;
        node.control.text_view.paint = enabled;
    }

    pub fn sceneSelectTextViewPaint(self: *Context, handle: Handle, frame: scene.FrameRequest, enabled: bool) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.sceneMutableNode(handle);
        try value.scene_node.?.owner.selectTextViewPaint(value, frame, enabled);
    }

    pub fn sceneHasMeasure(self: *Context, handle: Handle) !bool {
        try self.checkSceneRead();
        return yoga.yogaNodeHasMeasureFunc((try self.sceneNode(handle)).yoga_node);
    }

    pub fn sceneMarkDirty(self: *Context, handle: Handle) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const node = try self.sceneMutableNode(handle);
        try yoga.check(yoga.yogaNodeMarkDirtyChecked(node.yoga_node));
        node.scene_node.?.owner.work.clearRetainingCapacity();
    }

    pub fn checkSceneRead(self: *Context) Error!void {
        if (self.closing or (self.mutating and !self.scene_measuring)) return error.ContextBusy;
    }

    pub fn sceneMoveNode(self: *Context, handle: Handle, parent_handle: ?Handle, index: u32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        // Detachment is also used by child-first wrapper cleanup after cancellation.
        const node = if (parent_handle == null) try self.sceneNode(handle) else try self.sceneMutableNode(handle);
        const parent = if (parent_handle) |id| try self.sceneNode(id) else null;
        try node.scene_node.?.owner.move(node, parent, index);
    }

    pub fn sceneSetStyle(self: *Context, handle: Handle, group: u32, kind: u32, edge: u32, unit: u32, value: f32, flags: u32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        return self.sceneSetStyleLocked(handle, group, kind, edge, unit, value, flags);
    }

    /// Caller holds the mutation admission; used by ot_scene_flush to admit once per batch.
    pub fn sceneSetStyleLocked(
        self: *Context,
        handle: Handle,
        group: u32,
        kind: u32,
        edge: u32,
        unit: u32,
        value: f32,
        flags: u32,
    ) !void {
        std.debug.assert(self.mutating);
        if (group > 4 or group == 3 or (group != 4 and flags != 0) or flags > 1) return error.InvalidOptions;
        if ((group == 0 or group == 1) and (edge != 0 or unit != 0)) return error.InvalidOptions;
        if (group == 4 and edge != 0) return error.InvalidOptions;
        if (group == 0 and (!std.math.isFinite(value) or value < 0 or @as(f64, value) >= 4294967296 or @trunc(value) != value)) return error.InvalidOptions;
        // Display:contents has no box geometry and is outside this restricted scene.
        if (group == 0 and kind == 9 and value == 2) return error.InvalidOptions;
        const node = try self.sceneMutableNode(handle);
        try yoga.check(switch (group) {
            0 => yoga.yogaNodeStyleSetEnumChecked(node.yoga_node, kind, @intFromFloat(value)),
            1 => yoga.yogaNodeStyleSetFloatChecked(node.yoga_node, kind, value),
            2 => yoga.yogaNodeStyleSetValueChecked(node.yoga_node, kind, edge, unit, value),
            4 => yoga.yogaNodeStyleSetDimensionChecked(node.yoga_node, kind, unit, value, flags),
            else => unreachable,
        });
        node.scene_node.?.owner.work.clearRetainingCapacity();
    }

    pub fn sceneGetStyle(self: *Context, handle: Handle, group: u32, kind: u32, edge: u32) !scene.StyleValue {
        try self.checkSceneRead();
        if (group > 4) return error.InvalidOptions;
        if ((group == 0 or group == 1 or group == 4) and edge != 0) return error.InvalidOptions;
        const node = try self.sceneNode(handle);
        var result: scene.StyleValue = .{ .unit = 0, .value = 0 };
        switch (group) {
            0 => {
                var value: u32 = 0;
                try yoga.check(yoga.yogaNodeStyleGetEnumChecked(node.yoga_node, kind, &value));
                result.value = @floatFromInt(value);
            },
            1 => try yoga.check(yoga.yogaNodeStyleGetFloatChecked(node.yoga_node, kind, &result.value)),
            2, 4 => {
                if (group == 4 and kind > 1) return error.InvalidOptions;
                var encoded: u64 = 0;
                try yoga.check(yoga.yogaNodeStyleGetValueChecked(node.yoga_node, kind, edge, &encoded));
                result.unit = @truncate(encoded);
                result.value = @bitCast(@as(u32, @truncate(encoded >> 32)));
            },
            3 => {
                if (kind != 0) return error.InvalidOptions;
                result.unit = 1;
                try yoga.check(yoga.yogaNodeStyleGetBorderChecked(node.yoga_node, edge, &result.value));
            },
            else => unreachable,
        }
        return result;
    }

    pub fn sceneSetPositions(self: *Context, handle: Handle, mask: u32, units: [4]u32, values: [4]f32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const node = try self.sceneMutableNode(handle);
        try yoga.check(yoga.yogaNodeStyleSetPositionsChecked(node.yoga_node, mask, &units, &values));
        node.scene_node.?.owner.work.clearRetainingCapacity();
    }

    pub fn sceneSetPaint(self: *Context, handle: Handle, paint: scene.Paint) !void {
        try self.beginMutation();
        defer self.mutating = false;
        return self.sceneSetPaintLocked(handle, paint);
    }

    /// Caller holds the mutation admission; used by ot_scene_flush to admit once per batch.
    pub fn sceneSetPaintLocked(self: *Context, handle: Handle, paint: scene.Paint) !void {
        std.debug.assert(self.mutating);
        const node = try self.sceneMutableNode(handle);
        try node.scene_node.?.owner.setPaint(node, paint);
    }

    pub fn sceneSetBackground(self: *Context, handle: Handle, background: buf.RGBA) !void {
        try self.beginMutation();
        defer self.mutating = false;
        return self.sceneSetBackgroundLocked(handle, background);
    }

    /// Caller holds the mutation admission; used by ot_scene_flush to admit once per batch.
    pub fn sceneSetBackgroundLocked(self: *Context, handle: Handle, background: buf.RGBA) !void {
        std.debug.assert(self.mutating);
        const node = try self.sceneMutableNode(handle);
        var paint = node.scene_node.?.paint;
        paint.background = background;
        try node.scene_node.?.owner.setPaint(node, paint);
    }

    pub fn sceneSetViewport(self: *Context, handle: Handle, viewport_handle: ?Handle) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.sceneMutableNode(handle);
        const node = &value.scene_node.?;
        if (node.kind != 1) return error.WrongKind;
        if (viewport_handle) |id| {
            const viewport = try self.sceneNode(id);
            if (viewport.scene_node.?.owner != node.owner) return error.WrongSession;
            if (viewport.scene_node.?.kind > 1) return error.WrongKind;
        }
        try yoga.check(yoga.nodeTeardownStatus(value.yoga_node));
        var dirty: u32 = 0;
        try yoga.check(yoga.yogaNodeIsDirtyChecked(value.yoga_node, &dirty));
        if (std.meta.eql(node.viewport, viewport_handle)) return;
        node.owner.filter_count -= @intFromBool(node.viewport != null);
        node.owner.filter_count += @intFromBool(viewport_handle != null);
        node.viewport = viewport_handle;
        node.owner.preparation_dirty = true;
        node.owner.work.clearRetainingCapacity();
    }

    pub fn sceneSetFocus(self: *Context, handle: Handle, focused: bool) !void {
        try self.beginMutation();
        defer self.mutating = false;
        // Blur also participates in wrapper cleanup after Session cancellation.
        const value = if (focused) try self.sceneMutableNode(handle) else try self.sceneNode(handle);
        const owned = value.scene_node.?.owner;
        if (focused) {
            try yoga.check(yoga.nodeTeardownStatus(value.yoga_node));
            var dirty: u32 = 0;
            try yoga.check(yoga.yogaNodeIsDirtyChecked(value.yoga_node, &dirty));
            owned.focus = handle;
        } else if (owned.focus) |accepted| {
            if (std.meta.eql(accepted, handle)) owned.focus = null;
        }
        owned.work.clearRetainingCapacity();
    }

    pub fn sceneSetHooks(self: *Context, handle: Handle, flags: u32, generation: u64, initial_width: f64, initial_height: f64) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const node = try self.sceneMutableNode(handle);
        try node.scene_node.?.owner.setHooks(node, flags, generation, initial_width, initial_height);
    }

    pub fn sceneSetSlider(self: *Context, handle: Handle, options: scene.SliderOptions) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.sceneMutableNode(handle);
        const node = &value.scene_node.?;
        if (node.kind != 3) return error.WrongKind;
        try buf.validateColor(options.foreground);
        try buf.validateColor(options.background);
        try yoga.check(yoga.nodeTeardownStatus(value.yoga_node));
        var dirty: u32 = 0;
        try yoga.check(yoga.yogaNodeIsDirtyChecked(value.yoga_node, &dirty));
        _ = try scene.sliderThumb(options, node.resize_width, node.resize_height);
        _ = try scene.sliderThumb(options, node.layout.width, node.layout.height);
        node.control = .{ .slider = options };
        node.owner.work.clearRetainingCapacity();
    }

    pub fn sceneGetSliderThumb(self: *Context, handle: Handle) !scene.SliderThumb {
        try self.beginMutation();
        defer self.mutating = false;
        const node = &(try self.sceneNode(handle)).scene_node.?;
        if (node.kind != 3) return error.WrongKind;
        return scene.sliderThumb(node.control.slider, node.resize_width, node.resize_height);
    }

    pub fn sceneSetArrow(self: *Context, handle: Handle, options: scene.ArrowOptions) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.sceneMutableNode(handle);
        const node = &value.scene_node.?;
        if (node.kind != 4) return error.WrongKind;
        if (options.direction > 3 or options.attributes & ~@import("ansi.zig").TextAttributes.ATTRIBUTE_BASE_MASK != 0) return error.InvalidOptions;
        try buf.validateColor(options.foreground);
        try buf.validateColor(options.background);
        if (options.text) |text| try buf.validateTextInput(text);
        try yoga.check(yoga.nodeTeardownStatus(value.yoga_node));
        var dirty: u32 = 0;
        try yoga.check(yoga.yogaNodeIsDirtyChecked(value.yoga_node, &dirty));
        var replacement = options;
        if (options.text) |text| replacement.text = try self.allocator.dupe(u8, text);
        node.control.arrow.deinit(self.allocator);
        node.control = .{ .arrow = replacement };
        node.owner.work.clearRetainingCapacity();
    }

    pub fn sceneSetText(self: *Context, handle: Handle, bytes: []const u8) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const node = try self.sceneMutableNode(handle);
        const text = node.scene_node.?.text orelse return error.WrongKind;
        var dirty: u32 = 0;
        try yoga.check(yoga.yogaNodeIsDirtyChecked(node.yoga_node, &dirty));
        try validateTextBytes(text.buffer, bytes, 0);
        try self.replaceTextContent(text, bytes);
        textResourceChanged(text);
        if (text.owned_style) |style| {
            text.buffer.setSyntaxStyle(null);
            text.owned_style = null;
            style.deinit();
        }
        node.scene_node.?.owner.work.clearRetainingCapacity();
    }

    pub fn validateTextBytes(text: *const text_buffer.UnifiedTextBuffer, bytes: []const u8, retained_bytes: u32) !void {
        // Rope columns and line counts are u32. Tabs are the largest cell/byte
        // expansion; reserve one count for the trailing logical line.
        const bytes_max = (std.math.maxInt(u32) - 1) / @as(u32, @max(text.tabWidth(), 1));
        if (retained_bytes > bytes_max or bytes.len > bytes_max - retained_bytes) return error.TextLimit;
        if (!std.unicode.utf8ValidateSlice(bytes)) return error.InvalidUnicode;
    }

    fn validateEditTextBytes(text: *const text_buffer.UnifiedTextBuffer, bytes: []const u8, retained_bytes: u32) !void {
        try validateTextBytes(text, bytes, retained_bytes);
        // Cell-based editing cannot navigate standalone zero-width controls yet.
        var codepoints = std.unicode.Utf8View.initUnchecked(bytes).iterator();
        while (codepoints.nextCodepoint()) |codepoint| {
            if ((codepoint < 0x20 and codepoint != '\t' and codepoint != '\r' and codepoint != '\n') or
                (codepoint >= 0x7f and codepoint <= 0x9f)) return error.InvalidUnicode;
        }
    }

    pub fn sceneSetStyledText(self: *Context, handle: Handle, bytes: []const u8, chunks: []const StyledTextChunk) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const node = try self.sceneMutableNode(handle);
        const text = node.scene_node.?.text orelse return error.WrongKind;
        var dirty: u32 = 0;
        try yoga.check(yoga.yogaNodeIsDirtyChecked(node.yoga_node, &dirty));
        try self.replaceStyledTextResource(text, bytes, chunks);
        textResourceChanged(text);
        node.scene_node.?.owner.work.clearRetainingCapacity();
    }

    fn replaceStyledTextResource(self: *Context, text: anytype, bytes: []const u8, chunks: []const StyledTextChunk) !void {
        var prepared: PreparedStyledTextResource = undefined;
        try self.prepareStyledTextResource(&prepared, text, bytes, chunks);
        defer prepared.deinit(self.allocator);
        self.commitStyledTextResource(&prepared, text);
    }

    const PreparedStyledTextResource = struct {
        buffer: text_buffer.UnifiedTextBuffer.PreparedOwnedStyledText = undefined,
        buffer_ready: bool = false,
        bytes: ?[]const u8 = null,
        style: ?*syntax_style.SyntaxStyle = null,
        links: link.LinkTracker,

        fn deinit(prepared: *PreparedStyledTextResource, allocator: std.mem.Allocator) void {
            if (prepared.buffer_ready) prepared.buffer.deinit();
            if (prepared.style) |style| style.deinit();
            if (prepared.bytes) |bytes| allocator.free(bytes);
            prepared.links.deinit();
        }
    };

    fn prepareStyledTextResource(self: *Context, prepared: *PreparedStyledTextResource, text: anytype, bytes: []const u8, chunks: []const StyledTextChunk) !void {
        try validateTextBytes(text.buffer, bytes, 0);
        var offset: usize = 0;
        for (chunks) |chunk| {
            if ((chunk.byte_count == 0 and @TypeOf(text) != *SharedText) or chunk.byte_count > bytes.len - offset or
                chunk.attributes & ~@import("ansi.zig").TextAttributes.ATTRIBUTE_BASE_MASK != 0) return error.InvalidOptions;
            for ([_]?buf.RGBA{ chunk.foreground, chunk.background }) |color| {
                if (color) |rgba| try buf.validateColor(rgba);
            }
            _ = std.unicode.Utf8View.init(bytes[offset..][0..chunk.byte_count]) catch return error.InvalidUnicode;
            offset += chunk.byte_count;
        }
        if (offset != bytes.len) return error.InvalidOptions;
        const retained_style: ?*syntax_style.SyntaxStyle = if (@TypeOf(text) == *SharedText and text.owned_style == null)
            if (text.buffer.getSyntaxStyle()) |style| @constCast(style) else null
        else
            null;
        if (retained_style) |retained| try self.checkStyleDependents(retained);
        prepared.* = .{ .links = link.LinkTracker.init(self.allocator, &self.links) };
        errdefer prepared.deinit(self.allocator);
        const style = if (retained_style) |retained| try retained.prepareDefinitions() else try syntax_style.SyntaxStyle.init(self.allocator);
        prepared.style = style;
        const ranges = try self.allocator.alloc(text_buffer.OwnedStyledChunk, chunks.len);
        defer self.allocator.free(ranges);
        offset = 0;
        var range_count: usize = 0;
        for (chunks, 0..) |chunk, index| {
            if (chunk.byte_count == 0) continue;
            var attributes = chunk.attributes;
            if (chunk.link_url) |url| {
                // Legacy styled text omits empty/oversized URLs and zero-width chunks.
                if (url.len != 0 and url.len <= link.MAX_URL_LENGTH and
                    text.buffer.measureText(bytes[offset..][0..chunk.byte_count]) > 0)
                {
                    const id = try prepared.links.trackUrl(url);
                    attributes = @import("ansi.zig").TextAttributes.setLinkId(attributes, id);
                }
            }
            offset += chunk.byte_count;
            var name_bytes: [20]u8 = undefined;
            const name = if (retained_style != null)
                try std.fmt.bufPrint(&name_bytes, "chunk{d}", .{index})
            else
                try std.fmt.bufPrint(&name_bytes, "{d}", .{index});
            const register_chunk = if (retained_style != null)
                text.buffer.measureText(bytes[offset - chunk.byte_count .. offset]) > 0
            else
                chunk.foreground != null or chunk.background != null or attributes != 0;
            ranges[range_count] = .{
                .byte_count = chunk.byte_count,
                .style_id = if (register_chunk)
                    try style.registerStyle(name, chunk.foreground, chunk.background, attributes)
                else
                    0,
            };
            range_count += 1;
        }
        const copy = try self.allocator.dupe(u8, bytes);
        prepared.bytes = copy;
        if (retained_style != null) try style.retainLinks(&self.links);
        try text.buffer.prepareOwnedStyledText(&prepared.buffer, copy, text.input_mem_id, style, ranges[0..range_count], &prepared.links, retained_style);
        prepared.buffer_ready = true;
    }

    fn commitStyledTextResource(self: *Context, prepared: *PreparedStyledTextResource, text: anytype) void {
        text.input_mem_id = prepared.buffer.commit();
        prepared.bytes = null;
        if (prepared.buffer.retained_style) |retained| self.invalidateStyleDependents(retained);
        if (prepared.buffer.retained_style == null) {
            const previous = text.owned_style;
            text.owned_style = prepared.style;
            prepared.style = null;
            if (previous) |old| old.deinit();
        }
    }

    pub fn sceneSetTextOptions(self: *Context, handle: Handle, options: scene.TextOptions) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const node = try self.sceneMutableNode(handle);
        const text = node.scene_node.?.text orelse return error.WrongKind;
        if (options.attributes & ~@import("ansi.zig").TextAttributes.ATTRIBUTE_BASE_MASK != 0 or
            options.first_line_offset > std.math.maxInt(i32) or
            !std.math.isFinite(options.scroll_x) or options.scroll_x < 0 or options.scroll_x > std.math.maxInt(i32) or
            !std.math.isFinite(options.scroll_y) or options.scroll_y < 0 or options.scroll_y > std.math.maxInt(i32))
        {
            return error.InvalidOptions;
        }
        try buf.validateColor(options.foreground);
        try buf.validateColor(options.background);
        if (options.tab_color) |rgba| try buf.validateColor(rgba);
        if (options.tab_indicator) |indicator| {
            if (indicator < 0x20 or (indicator >= 0x7f and indicator <= 0x9f) or
                indicator > 0x10ffff or (indicator >= 0xd800 and indicator <= 0xdfff)) return error.InvalidOptions;
        }
        var dirty: u32 = 0;
        try yoga.check(yoga.yogaNodeIsDirtyChecked(node.yoga_node, &dirty));
        const previous_viewport = text.view.getViewport();
        var has_viewport = previous_viewport != null;
        var viewport = previous_viewport orelse text.initial_viewport orelse viewport: {
            var initial: text_buffer_view.Viewport = .{ .x = 0, .y = 0, .width = 0, .height = 0 };
            has_viewport = true;
            // Match constructor geometry before the first completed layout. Later
            // style changes keep this viewport until native layout resizes it.
            for ([_]*u32{ &initial.width, &initial.height }, 0..) |dimension, kind| {
                var encoded: u64 = 0;
                try yoga.check(yoga.yogaNodeStyleGetValueChecked(node.yoga_node, @intCast(kind), 0, &encoded));
                const unit: u32 = @truncate(encoded);
                const value: f32 = @bitCast(@as(u32, @truncate(encoded >> 32)));
                if (unit == 1 and value >= 0) {
                    if (!std.math.isFinite(value) or @as(f64, value) > std.math.maxInt(i32)) return error.InvalidDimensions;
                    dimension.* = @intFromFloat(value);
                    if (value == 0) has_viewport = false;
                } else {
                    has_viewport = false;
                }
            }
            break :viewport initial;
        };
        const wrap_changed = text.view.wrap_mode != options.wrap_mode;
        const scroll_changed = text.scroll_x != options.scroll_x or text.scroll_y != options.scroll_y;
        const measure_changed = wrap_changed or text.view.first_line_offset != options.first_line_offset;
        const prepare_changed = measure_changed or scroll_changed or text.view.truncate != options.truncate;
        text.buffer.setDefaultFg(options.foreground);
        text.buffer.setDefaultBg(options.background);
        text.buffer.setDefaultAttributes(options.attributes);
        text.view.setWrapMode(options.wrap_mode);
        text.view.setTruncate(options.truncate);
        text.view.setFirstLineOffset(options.first_line_offset);
        text.view.setTabIndicator(options.tab_indicator);
        text.view.setTabIndicatorColor(options.tab_color);
        text.scroll_x = options.scroll_x;
        text.scroll_y = options.scroll_y;
        viewport.x = @intFromFloat(options.scroll_x);
        viewport.y = @intFromFloat(options.scroll_y);
        if (has_viewport) {
            if (previous_viewport != null and wrap_changed and options.wrap_mode != .none) {
                text.view.setWrapWidth(if (viewport.width > 0) viewport.width else null);
            }
            if (previous_viewport == null or scroll_changed) {
                text.view.setViewport(viewport);
            }
        } else {
            // Unresolved constructor dimensions do not yet define a viewport.
            // Retain accepted offsets for the first layout without forcing wrap.
            text.initial_viewport = viewport;
            text.view.setWrapWidth(if (viewport.width > 0) viewport.width else null);
        }
        if (measure_changed) yoga.yogaNodeMarkDirty(node.yoga_node);
        if (prepare_changed) node.scene_node.?.owner.preparation_dirty = true;
        node.scene_node.?.owner.work.clearRetainingCapacity();
    }

    pub fn sceneSetTextSelection(self: *Context, handle: Handle, options: SceneTextSelectionOptions) !bool {
        try self.beginMutation();
        defer self.mutating = false;
        if (options.operation > 2 or options.behavior > 2) return error.InvalidOptions;
        for ([_]?buf.RGBA{ options.background, options.foreground }) |color| {
            if (color) |rgba| try buf.validateColor(rgba);
        }
        // Reset participates in wrapper cleanup after Session cancellation and
        // must not depend on Yoga health or allocate view caches.
        const node = if (options.operation == 0) try self.sceneNode(handle) else try self.sceneMutableNode(handle);
        const text = node.scene_node.?.text orelse return error.WrongKind;
        const changed = if (options.operation == 0) reset: {
            const had_selection = text.view.getSelection() != null;
            text.view.resetLocalSelection();
            break :reset had_selection;
        } else selection: {
            var dirty: u32 = 0;
            try yoga.check(yoga.yogaNodeIsDirtyChecked(node.yoga_node, &dirty));
            if (text.view.getViewport()) |viewport| {
                const x_offset: i32 = if (text.view.wrap_mode == .none) @intCast(viewport.x) else 0;
                const y_offset: i32 = @intCast(viewport.y);
                _ = std.math.add(i32, options.anchor_x, x_offset) catch return error.InvalidOptions;
                _ = std.math.add(i32, options.focus_x, x_offset) catch return error.InvalidOptions;
                _ = std.math.add(i32, options.anchor_y, y_offset) catch return error.InvalidOptions;
                _ = std.math.add(i32, options.focus_y, y_offset) catch return error.InvalidOptions;
            }
            if (text.buffer.lineWidthColsMax() > std.math.maxInt(i32)) return error.InvalidOptions;
            // The legacy view methods cannot report allocation failures. Prepare
            // their caches first so no failing work follows selection publication.
            // markerCount swallows rebuild OOM; the rope metrics do not allocate.
            if (text.buffer.rope().markerCount(.linestart) != text.buffer.lineCount()) return error.OutOfMemory;
            try text.prepareView();
            if (text.view.virtual_lines.items.len > std.math.maxInt(i32)) return error.InvalidOptions;
            const behavior: text_buffer_view.SelectionBehavior = @enumFromInt(options.behavior);
            break :selection if (options.operation == 1)
                text.view.setLocalSelectionBehavior(options.anchor_x, options.anchor_y, options.focus_x, options.focus_y, options.background, options.foreground, behavior)
            else
                text.view.updateLocalSelectionBehavior(options.anchor_x, options.anchor_y, options.focus_x, options.focus_y, options.background, options.foreground, behavior);
        };
        node.scene_node.?.owner.work.clearRetainingCapacity();
        return changed;
    }

    pub fn sceneGetTextSelection(self: *Context, handle: Handle) !u64 {
        try self.checkSceneRead();
        const node = try self.sceneNode(handle);
        const text = node.scene_node.?.text orelse return error.WrongKind;
        return text.view.packSelectionInfo();
    }

    /// A size query returns the full-document byte bound, or zero for no selection.
    /// Copies require that bound, then return only the selected UTF-8 bytes.
    pub fn sceneGetSelectedText(self: *Context, handle: Handle, out: []u8) !u32 {
        try self.checkSceneRead();
        const was_mutating = self.mutating;
        self.mutating = true;
        defer self.mutating = was_mutating;
        const node = try self.sceneNode(handle);
        const text = node.scene_node.?.text orelse return error.WrongKind;
        if (text.view.packSelectionInfo() == std.math.maxInt(u64)) return 0;
        const bound = text.buffer.getByteSize();
        if (out.len == 0) return bound;
        if (out.len < bound) return error.InvalidOptions;
        return @intCast(text.view.getSelectedTextIntoBuffer(out));
    }

    pub fn sceneGetText(self: *Context, handle: Handle, out: []u8) !u32 {
        try self.checkSceneRead();
        const was_mutating = self.mutating;
        self.mutating = true;
        defer self.mutating = was_mutating;
        const node = try self.sceneNode(handle);
        const text = node.scene_node.?.text orelse return error.WrongKind;
        const count = text.buffer.getByteSize();
        if (out.len == 0) return count;
        if (out.len < count) return error.InvalidOptions;
        const written = text.buffer.getPlainTextIntoBuffer(out);
        std.debug.assert(written == count);
        return count;
    }

    pub fn sceneGetTextInfo(self: *Context, handle: Handle) !scene.TextInfo {
        try self.checkSceneRead();
        const was_mutating = self.mutating;
        self.mutating = true;
        defer self.mutating = was_mutating;
        const node = try self.sceneNode(handle);
        const text = node.scene_node.?.text orelse return error.WrongKind;
        try text.prepareView();
        return .{
            .byte_count = text.buffer.getByteSize(),
            .text_length = text.buffer.getLength(),
            .line_count = text.buffer.lineCount(),
            .virtual_line_count = @intCast(text.view.virtual_lines.items.len),
            .width_cols_max = text.buffer.lineWidthColsMax(),
        };
    }

    pub fn sceneGetTextLines(self: *Context, handle: Handle, out: []scene.TextLine) !u32 {
        try self.checkSceneRead();
        const was_mutating = self.mutating;
        self.mutating = true;
        defer self.mutating = was_mutating;
        const node = try self.sceneNode(handle);
        const text = node.scene_node.?.text orelse return error.WrongKind;
        try text.prepareView();
        const lines = text.view.getLogicalLineInfo();
        const count: u32 = @intCast(lines.line_start_cols.len);
        if (out.len == 0) return count;
        if (out.len < count) return error.InvalidOptions;
        for (out[0..count], 0..) |*line, index| {
            line.* = .{
                .start_cols = lines.line_start_cols[index],
                .width_cols = lines.line_width_cols[index],
                .source_line = lines.line_sources[index],
                .wrap_index = lines.line_wraps[index],
            };
        }
        return count;
    }

    pub fn sceneGetLayout(self: *Context, handle: Handle, raw_yoga: bool) !scene.Layout {
        try self.checkSceneRead();
        const node = try self.sceneNode(handle);
        if (!raw_yoga) return scene.getLayout(node);
        var layout: yoga.ExternalYogaLayout = undefined;
        try yoga.check(yoga.yogaNodeGetComputedLayoutChecked(node.yoga_node, &layout));
        return .{
            .left = layout.left,
            .top = layout.top,
            .right = layout.right,
            .bottom = layout.bottom,
            .width = layout.width,
            .height = layout.height,
        };
    }

    pub fn sceneGetPaintLayout(self: *Context, handle: Handle) !scene.Layout {
        try self.checkSceneRead();
        return scene.getPaintLayout(try self.sceneNode(handle));
    }

    pub fn scenePaint(self: *Context, session_handle: Handle, background: buf.RGBA, use_mouse: bool, excluded_hit_num: u32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getSession(session_handle);
        try value.checkRendering();
        try value.checkFrameIdle();
        const attached = value.renderer orelse return error.RendererNotAttached;
        const owned = value.scene orelse return error.SceneNotAttached;
        if (value.frame_end_offset != null or attached.pendingPresentation != null) return error.PresentationPending;
        if (attached.width > std.math.maxInt(i32) or attached.height > std.math.maxInt(i32)) return error.InvalidDimensions;
        errdefer {
            attached.getNextBuffer().clear(attached.backgroundColor, null);
            @memset(attached.nextHitGrid, 0);
        }
        const result = try owned.frameStep(&self.objects, attached, null, .{
            .background = background,
            .use_mouse = use_mouse,
            .excluded_hit_num = excluded_hit_num,
            .max_layout_rounds = 8,
            .max_host_requests = 65536,
        }, false);
        std.debug.assert(result.kind == 0);
        // Direct Zig callers consume the paint synchronously without a host ticket.
        owned.painted = null;
    }

    pub fn sceneFrameStep(self: *Context, session_handle: Handle, previous: ?scene.FrameRequest, options: scene.FrameOptions) !scene.FrameRequest {
        return self.sceneFrameStepBudgeted(session_handle, previous, options, std.math.maxInt(u32));
    }

    pub fn sceneFrameStepBudgeted(self: *Context, session_handle: Handle, previous: ?scene.FrameRequest, options: scene.FrameOptions, max_paint_members: u32) !scene.FrameRequest {
        return self.sceneFrameStepWorkBudgeted(session_handle, previous, options, max_paint_members, std.math.maxInt(u32));
    }

    pub fn sceneFrameStepWorkBudgeted(self: *Context, session_handle: Handle, previous: ?scene.FrameRequest, options: scene.FrameOptions, max_paint_members: u32, max_work_items: u32) !scene.FrameRequest {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getSession(session_handle);
        try value.checkRendering();
        if (value.frame_lease_count != 0) return error.FrameBusy;
        const attached = value.renderer orelse return error.RendererNotAttached;
        const owned = value.scene orelse return error.SceneNotAttached;
        if (value.frame_end_offset != null or attached.pendingPresentation != null) return error.PresentationPending;
        if (attached.width > std.math.maxInt(i32) or attached.height > std.math.maxInt(i32)) return error.InvalidDimensions;
        return owned.frameStepWorkBudgeted(&self.objects, attached, previous, options, true, max_paint_members, max_work_items);
    }

    pub fn sceneFrameAcquireBufferLease(self: *Context, session_handle: Handle, frame: scene.FrameRequest, which: RendererBuffer) !Handle {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getSession(session_handle);
        try value.checkRendering();
        const owned = value.scene orelse return error.SceneNotAttached;
        const painted = try owned.checkFrameAccess(frame);
        const attached = value.renderer orelse return error.RendererNotAttached;
        if (!painted.destination.matches(attached.getNextBuffer())) return error.StaleFrame;
        if (self.lease_count >= self.lease_count_max) return error.LeaseLimit;
        try self.objects.checkCapacity();
        const access = try self.allocator.create(FrameBufferLease);
        errdefer self.allocator.destroy(access);
        const target = switch (which) {
            .current => attached.getCurrentBuffer(),
            .next => attached.getNextBuffer(),
        };
        access.* = .{
            .frame = frame,
            .membership_epoch = painted.membership_epoch,
            .which = which,
            .destination = scene.BufferIdentity.init(target),
            .lease = try buf.BufferLease.acquireChecked(target, &self.lease_count, self.lease_count_max, &self.lease_bytes, &self.lease_bytes_max),
        };
        errdefer access.lease.releaseChecked(&self.lease_count, &self.lease_bytes, &self.lease_bytes_max);
        const handle = try self.objects.insert(.frame_buffer_lease, access);
        value.frame_lease_count += 1;
        return handle;
    }

    pub fn sceneFrameDrawBuffer(self: *Context, session_handle: Handle, frame: scene.FrameRequest, source_handle: Handle, x: i32, y: i32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const target = try self.frameDrawTarget(session_handle, frame);
        const source = try self.getBuffer(source_handle);
        try drawContextBuffer(target, source, x, y, .{});
    }

    fn frameDrawTarget(self: *Context, session_handle: Handle, frame: scene.FrameRequest) !*buf.OptimizedBuffer {
        const value = try self.getSession(session_handle);
        try value.checkRendering();
        const attached = value.renderer orelse return error.RendererNotAttached;
        if (value.frame_end_offset != null or attached.pendingPresentation != null) return error.PresentationPending;
        const owned = value.scene orelse return error.SceneNotAttached;
        const access = try owned.checkFrameAccess(frame);
        const target = attached.getNextBuffer();
        if (!access.destination.matches(target)) return error.StaleFrame;
        return target;
    }

    pub fn sceneFrameCommit(self: *Context, session_handle: Handle, frame: scene.FrameRequest, force: bool) Error!session.RenderStatus {
        try self.beginMutation();
        defer self.mutating = false;
        return (try self.getSession(session_handle)).commitSceneFrame(frame, force);
    }

    pub fn sceneFrameCancel(self: *Context, session_handle: Handle, frame_id: u64) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getSession(session_handle);
        const owned = value.scene orelse return error.SceneNotAttached;
        const active_id = if (owned.attempt) |active| active.frame_id else if (owned.painted) |painted| painted.ticket.frame_id else return error.StaleFrame;
        if (active_id != frame_id) return error.StaleFrame;
        value.cancelSceneFrame();
    }

    pub fn sceneHitTest(self: *Context, session_handle: Handle, x: i32, y: i32) !u32 {
        try self.beginMutation();
        defer self.mutating = false;
        const value = try self.getSession(session_handle);
        const attached = value.renderer orelse return error.RendererNotAttached;
        const owned = value.scene orelse return error.SceneNotAttached;
        if (x < 0 or y < 0) return 0;
        const token = attached.checkHit(@intCast(x), @intCast(y));
        const handle = owned.tokens.get(token) orelse return 0;
        const node = self.objects.get(handle, .native_renderable, native_renderable.NativeRenderable) catch return 0;
        const state = node.scene_node orelse return 0;
        if (state.owner != owned or state.token != token) return 0;
        return state.num;
    }

    pub fn sceneGetStats(self: *Context, session_handle: Handle) !renderer.RenderStatsSnapshot {
        try self.beginMutation();
        defer self.mutating = false;
        return (try self.getSessionRenderer(session_handle)).getRenderStats();
    }

    pub fn sceneGetCursorState(self: *Context, session_handle: Handle) !scene.CursorState {
        try self.beginMutation();
        defer self.mutating = false;
        const terminal = &(try self.getSessionRenderer(session_handle)).terminal;
        const position = terminal.getCursorPosition();
        const style = terminal.getCursorStyle();
        const color = terminal.getCursorColor();
        return .{
            .x = position.x,
            .y = position.y,
            .visible = position.visible,
            .blinking = style.blinking,
            .style = switch (style.style) {
                .block => 0,
                .line => 1,
                .underline => 2,
                .default => 3,
            },
            .color = .{ ansi.redF(color), ansi.greenF(color), ansi.blueF(color), ansi.alphaF(color) },
        };
    }

    pub fn getRenderable(self: *Context, handle: Handle) Error!*native_renderable.NativeRenderable {
        if (self.closing) return error.ContextClosed;
        return self.objects.get(handle, .native_renderable, native_renderable.NativeRenderable);
    }

    fn createTextResource(self: *Context, width_method: utf8.WidthMethod) !*Text {
        // First sceneSetText registers the real bytes; an empty slot would be replaced.
        if (self.text_pool) |value| {
            self.text_pool = value.pool_next;
            self.text_pool_count -= 1;
            self.text_pool_bytes -= @sizeOf(Text) + value.buffer.retainedStorageBytes() + value.view.retainedStorageBytes();
            errdefer self.freeTextStorage(value);
            try value.buffer.reinitStorage(width_method);
            try value.view.reinitStorage();
            value.* = .{ .buffer = value.buffer, .view = value.view };
            return value;
        }
        const value = try self.allocator.create(Text);
        errdefer self.allocator.destroy(value);
        const buffer = try text_buffer.UnifiedTextBuffer.initWithOptions(self.allocator, &self.graphemes, &self.links, width_method, .{
            .io = self.io,
            .logger = &self.logger,
        });
        errdefer buffer.deinit();
        const view = try text_buffer_view.UnifiedTextBufferView.init(self.allocator, buffer);
        errdefer view.deinit();
        value.* = .{ .buffer = buffer, .view = view };
        return value;
    }

    pub fn createTextBuffer(self: *Context, width_method: utf8.WidthMethod) !Handle {
        try self.beginMutation();
        defer self.mutating = false;
        try self.objects.checkCapacity();
        const value = try self.allocator.create(SharedText);
        errdefer self.allocator.destroy(value);
        const buffer = try text_buffer.UnifiedTextBuffer.initWithOptions(self.allocator, &self.graphemes, &self.links, width_method, .{
            .io = self.io,
            .logger = &self.logger,
        });
        errdefer buffer.deinit();
        const input_mem_id = try buffer.registerMemBuffer("", false);
        const handle = try self.objects.insert(.text_buffer, value);
        value.* = .{ .handle = handle, .buffer = buffer, .input_mem_id = input_mem_id };
        return handle;
    }

    pub fn getTextBuffer(self: *Context, handle: Handle) Error!*SharedText {
        if (self.closing) return error.ContextClosed;
        return self.objects.get(handle, .text_buffer, SharedText);
    }

    pub fn createTextBufferView(self: *Context, text_handle: Handle) !Handle {
        try self.beginMutation();
        defer self.mutating = false;
        const text = try self.getTextBuffer(text_handle);
        try self.objects.checkCapacity();
        const value = try self.allocator.create(TextView);
        errdefer self.allocator.destroy(value);
        const view = try text_buffer_view.UnifiedTextBufferView.init(self.allocator, text.buffer);
        errdefer view.deinit();
        const handle = try self.objects.insert(.text_buffer_view, value);
        value.* = .{ .handle = handle, .text = text, .view = view, .next = text.views };
        if (text.views) |next| next.previous = value;
        text.views = value;
        return handle;
    }

    pub fn getTextBufferView(self: *Context, handle: Handle) Error!*TextView {
        if (self.closing) return error.ContextClosed;
        return self.objects.get(handle, .text_buffer_view, TextView);
    }

    pub fn textBufferSetText(self: *Context, handle: Handle, bytes: []const u8) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const text = try self.getTextBuffer(handle);
        try text.checkMutable();
        try validateTextBytes(text.buffer, bytes, 0);
        try self.replaceTextContent(text, bytes);
        text.reclaimAppendBuffers();
        if (text.owned_style) |style| {
            text.buffer.setSyntaxStyle(null);
            text.owned_style = null;
            style.deinit();
        }
        text.invalidate();
    }

    pub fn textBufferSetStyledText(self: *Context, handle: Handle, bytes: []const u8, chunks: []const StyledTextChunk) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const text = try self.getTextBuffer(handle);
        try text.checkMutable();
        try self.replaceStyledTextResource(text, bytes, chunks);
        text.reclaimAppendBuffers();
        text.invalidate();
    }

    pub const text_replacement_count_max = 256;
    pub const text_replacement_chunks_max = 4096;
    pub const text_replacement_bytes_max = 4 * 1024 * 1024;
    pub const text_replacement_url_bytes_max = 1024 * 1024;

    pub const TextReplacement = struct {
        buffer: Handle,
        view: Handle,
        bytes: []const u8,
        chunks: []const StyledTextChunk,
    };

    pub const TextReplacementInfo = extern struct { text_length: u32, byte_count: u32 };

    pub fn textBufferReplaceStyledBatch(self: *Context, replacements: []const TextReplacement, output: []TextReplacementInfo) !void {
        try self.beginMutation();
        defer self.mutating = false;
        if (replacements.len > text_replacement_count_max or output.len != replacements.len) return error.InvalidOptions;
        var views: [text_replacement_count_max]*TextView = undefined;
        var bytes_left: usize = text_replacement_bytes_max;
        var chunks_left: usize = text_replacement_chunks_max;
        var urls_left: usize = text_replacement_url_bytes_max;
        for (replacements, 0..) |replacement, index| {
            if (replacement.bytes.len > bytes_left or replacement.chunks.len > chunks_left) return error.InvalidOptions;
            bytes_left -= replacement.bytes.len;
            chunks_left -= replacement.chunks.len;
            for (replacement.chunks) |chunk| if (chunk.link_url) |url| {
                if (url.len > urls_left) return error.InvalidOptions;
                urls_left -= url.len;
            };
            const text = try self.getTextBuffer(replacement.buffer);
            const dependent = try self.getTextBufferView(replacement.view);
            if (dependent.text != text or text.buffer.getSyntaxStyle() != text.owned_style) return error.InvalidOptions;
            for (views[0..index]) |previous| if (previous.text == text) return error.InvalidOptions;
            try text.checkMutable();
            views[index] = dependent;
        }
        // Allocate once: moving a prepared arena would invalidate its allocator pointers.
        const prepared = try self.allocator.alloc(PreparedStyledTextResource, replacements.len);
        defer self.allocator.free(prepared);
        var ready: usize = 0;
        defer for (prepared[0..ready]) |*candidate| candidate.deinit(self.allocator);
        for (replacements, 0..) |replacement, index| {
            try self.prepareStyledTextResource(&prepared[index], views[index].text, replacement.bytes, replacement.chunks);
            ready += 1;
        }
        for (prepared, 0..) |*candidate, index| {
            const text = views[index].text;
            self.commitStyledTextResource(candidate, text);
            text.reclaimAppendBuffers();
            views[index].view.resetLocalSelection();
            text.invalidate();
            output[index] = .{ .text_length = text.buffer.getLength(), .byte_count = text.buffer.getByteSize() };
        }
    }

    pub fn textBufferAppend(self: *Context, handle: Handle, bytes: []const u8) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const text = try self.getTextBuffer(handle);
        try text.checkMutable();
        try validateTextBytes(text.buffer, bytes, text.buffer.getByteSize());
        if (bytes.len == 0) return;
        const copy = try self.allocator.dupe(u8, bytes);
        errdefer self.allocator.free(copy);
        try text.buffer.appendWithOwnership(copy, true);
        text.invalidate();
    }

    pub fn textBufferClear(self: *Context, handle: Handle, reset: bool) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const text = try self.getTextBuffer(handle);
        try text.checkMutable();
        if (reset) {
            try text.buffer.reset();
            // Reset retains registry capacity, including the reserved replacement slot.
            std.debug.assert(text.buffer.mem_registry.buffers.capacity > 0);
            text.input_mem_id = text.buffer.registerMemBuffer("", false) catch unreachable;
        } else {
            try text.buffer.clear();
        }
        text.invalidate();
    }

    pub fn textBufferSetSyntaxStyle(self: *Context, handle: Handle, style_handle: ?Handle) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const text = try self.getTextBuffer(handle);
        try text.checkMutable();
        const style = if (style_handle) |id| try self.getSyntaxStyle(id) else null;
        text.buffer.setSyntaxStyle(style);
        if (text.buffer.getSyntaxStyle() != style) return error.OutOfMemory;
        if (text.owned_style) |previous| {
            text.owned_style = null;
            previous.deinit();
        }
        text.invalidate();
    }

    pub fn textBufferSetDefaults(self: *Context, handle: Handle, options: TextDefaults) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const text = try self.getTextBuffer(handle);
        try text.checkMutable();
        try setBufferDefaults(text.buffer, options);
        text.invalidate();
    }

    pub fn editBufferSetTabWidth(self: *Context, handle: Handle, width: u8) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const edit = try self.getEditBuffer(handle);
        try edit.checkMutable();
        const tab_width: u32 = @min(254, @max(2, @as(u32, width) + width % 2));
        const bytes_max = (std.math.maxInt(u32) - 1) / tab_width;
        if (edit.buffer.tb.getByteSize() > bytes_max) return error.TextLimit;
        edit.buffer.setTabWidth(@intCast(tab_width));
        edit.invalidate();
    }

    pub fn textBufferSetTabWidth(self: *Context, handle: Handle, width: u8) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const text = try self.getTextBuffer(handle);
        try text.checkMutable();
        const tab_width: u32 = @min(254, @max(2, @as(u32, width) + width % 2));
        // Apply validateTextBytes' conservative cell bound before remeasuring.
        const bytes_max = (std.math.maxInt(u32) - 1) / tab_width;
        if (text.buffer.getByteSize() > bytes_max) return error.TextLimit;
        text.buffer.setTabWidth(@intCast(tab_width));
        text.invalidate();
    }

    pub fn textBufferHighlight(self: *Context, handle: Handle, operation: TextHighlight) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const text = try self.getTextBuffer(handle);
        try text.checkMutable();
        try highlightBuffer(text.buffer, operation);
        text.invalidate();
    }

    pub fn textViewSetViewport(self: *Context, handle: Handle, viewport: text_buffer_view.Viewport, size_only: bool) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const view = try self.getTextBufferView(handle);
        try view.checkMutable();
        try validateViewport(viewport);
        if (size_only) {
            if (view.view.getViewport()) |previous| try validateViewport(.{
                .x = previous.x,
                .y = previous.y,
                .width = viewport.width,
                .height = viewport.height,
            });
            view.view.setViewportSize(viewport.width, viewport.height);
        } else view.view.setViewport(viewport);
        view.invalidate();
    }

    pub fn textViewCommand(self: *Context, handle: Handle, command: TextViewCommand) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const view = try self.getTextBufferView(handle);
        try view.checkMutable();
        switch (command) {
            .wrap_width => |width| {
                if (width) |value| if (value > std.math.maxInt(i32)) return error.InvalidOptions;
                view.view.setWrapWidth(width);
            },
            .wrap_mode => |mode| view.view.setWrapMode(mode),
            .first_line_offset => |offset| {
                if (offset > std.math.maxInt(i32)) return error.InvalidOptions;
                view.view.setFirstLineOffset(offset);
            },
            .tab_indicator => |indicator| {
                try validateTabIndicator(indicator);
                view.view.setTabIndicator(indicator);
            },
            .truncate => |enabled| view.view.setTruncate(enabled),
        }
        view.invalidate();
    }

    pub fn textViewSetTabColor(self: *Context, handle: Handle, color: ?buf.RGBA) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const view = try self.getTextBufferView(handle);
        try view.checkMutable();
        if (color) |rgba| try buf.validateColor(rgba);
        view.view.setTabIndicatorColor(color);
        view.invalidate();
    }

    pub fn textViewSelect(self: *Context, handle: Handle, options: TextSelection) !bool {
        try self.beginMutation();
        defer self.mutating = false;
        const view = try self.getTextBufferView(handle);
        try view.checkMutable();
        if (options.update_cursor or options.follow_cursor) return error.InvalidOptions;
        return selectView(view, options);
    }

    pub fn createEditBuffer(self: *Context, width_method: utf8.WidthMethod) !Handle {
        try self.beginMutation();
        defer self.mutating = false;
        try self.objects.checkCapacity();
        const value = try self.allocator.create(Edit);
        errdefer self.allocator.destroy(value);
        value.* = .{
            .owner = self,
            .handle = undefined,
            .buffer = undefined,
            .sink = .{ .handler = .{ .userdata = value, .callback = Edit.receive } },
        };
        value.buffer = try edit_buffer.EditBuffer.initWithOptions(self.allocator, &self.graphemes, &self.links, width_method, &value.sink, .{
            .io = self.io,
            .logger = &self.logger,
        });
        errdefer value.buffer.deinit();
        value.handle = try self.objects.insert(.edit_buffer, value);
        value.content_epoch = value.buffer.tb.getContentEpoch();
        return value.handle;
    }

    pub fn getEditBuffer(self: *Context, handle: Handle) Error!*Edit {
        if (self.closing) return error.ContextClosed;
        return self.objects.get(handle, .edit_buffer, Edit);
    }

    pub fn createEditorView(self: *Context, edit_handle: Handle, width: u32, height: u32) !Handle {
        try self.beginMutation();
        defer self.mutating = false;
        const edit = try self.getEditBuffer(edit_handle);
        try self.objects.checkCapacity();
        const value = try self.allocator.create(Editor);
        errdefer self.allocator.destroy(value);
        const view = try editor_view.EditorView.init(self.allocator, edit.buffer, width, height);
        errdefer view.deinit();
        const handle = try self.objects.insert(.editor_view, value);
        value.* = .{ .handle = handle, .edit = edit, .view = view, .next = edit.views };
        if (edit.views) |next| next.previous = value;
        edit.views = value;
        return handle;
    }

    pub fn getEditorView(self: *Context, handle: Handle) Error!*Editor {
        if (self.closing) return error.ContextClosed;
        return self.objects.get(handle, .editor_view, Editor);
    }

    pub fn createSyntaxStyle(self: *Context) !Handle {
        try self.beginMutation();
        defer self.mutating = false;
        try self.objects.checkCapacity();
        const style = try syntax_style.SyntaxStyle.init(self.allocator);
        errdefer style.deinit();
        return self.objects.insert(.syntax_style, style);
    }

    pub fn getSyntaxStyle(self: *Context, handle: Handle) Error!*syntax_style.SyntaxStyle {
        if (self.closing) return error.ContextClosed;
        return self.objects.get(handle, .syntax_style, syntax_style.SyntaxStyle);
    }

    pub fn syntaxStyleRegister(self: *Context, handle: Handle, name: []const u8, definition: syntax_style.StyleDefinition) !u32 {
        try self.beginMutation();
        defer self.mutating = false;
        if (!std.unicode.utf8ValidateSlice(name)) return error.InvalidUnicode;
        if (definition.attributes & ~ansi.TextAttributes.ATTRIBUTE_BASE_MASK != 0) return error.InvalidOptions;
        if (definition.fg) |color| try buf.validateColor(color);
        if (definition.bg) |color| try buf.validateColor(color);
        const style = try self.getSyntaxStyle(handle);
        try self.checkStyleDependents(style);
        const id = try style.registerStyleDefinition(name, definition);
        style.clearCache();
        self.invalidateStyleDependents(style);
        return id;
    }

    fn checkStyleDependents(self: *Context, style: *const syntax_style.SyntaxStyle) !void {
        // Buffers subscribe before borrowing a style; construction has no dependents to scan.
        const listeners = style.emitter.listeners.get(.Destroy) orelse return;
        if (listeners.items.len == 0) return;
        for (self.objects.slots) |slot| {
            if (slot.kind == .edit_buffer and slot.ptr != null) {
                const dependent: *Edit = @ptrCast(@alignCast(slot.ptr.?));
                if (dependent.buffer.tb.getSyntaxStyle() == style) try dependent.checkMutable();
            } else if (slot.kind == .text_buffer and slot.ptr != null) {
                const dependent: *SharedText = @ptrCast(@alignCast(slot.ptr.?));
                if (dependent.buffer.getSyntaxStyle() == style) try dependent.checkMutable();
            }
        }
    }

    fn invalidateStyleDependents(self: *Context, style: *const syntax_style.SyntaxStyle) void {
        const listeners = style.emitter.listeners.get(.Destroy) orelse return;
        if (listeners.items.len == 0) return;
        for (self.objects.slots) |slot| {
            if (slot.kind == .edit_buffer and slot.ptr != null) {
                const dependent: *Edit = @ptrCast(@alignCast(slot.ptr.?));
                if (dependent.buffer.tb.getSyntaxStyle() == style) dependent.invalidate();
            } else if (slot.kind == .text_buffer and slot.ptr != null) {
                const dependent: *SharedText = @ptrCast(@alignCast(slot.ptr.?));
                if (dependent.buffer.getSyntaxStyle() == style) dependent.invalidate();
            }
        }
    }

    pub fn editSetSyntaxStyle(self: *Context, handle: Handle, style_handle: ?Handle) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const edit = try self.getEditBuffer(handle);
        try edit.checkMutable();
        const style = if (style_handle) |id| try self.getSyntaxStyle(id) else null;
        edit.buffer.tb.setSyntaxStyle(style);
        if (edit.buffer.tb.getSyntaxStyle() != style) return error.OutOfMemory;
        edit.invalidate();
    }

    pub fn editSetText(self: *Context, handle: Handle, bytes: []const u8, preserve_history: bool) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const edit = try self.getEditBuffer(handle);
        try edit.checkMutable();
        try validateEditTextBytes(edit.buffer.tb, bytes, 0);
        if (preserve_history) {
            try edit.buffer.replaceText(bytes);
        } else {
            edit.input_mem_id = try edit.buffer.setTextOwned(bytes, edit.input_mem_id);
        }
    }

    pub fn editInsertText(self: *Context, handle: Handle, bytes: []const u8) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const edit = try self.getEditBuffer(handle);
        try edit.checkMutable();
        try validateEditTextBytes(edit.buffer.tb, bytes, edit.buffer.tb.getByteSize());
        try edit.buffer.insertText(bytes);
    }

    pub fn editDeleteRange(self: *Context, handle: Handle, start: edit_buffer.Cursor, end: edit_buffer.Cursor) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const edit = try self.getEditBuffer(handle);
        try edit.checkMutable();
        try edit.buffer.deleteRange(start, end);
    }

    pub fn editSetCursor(self: *Context, handle: Handle, row: u32, col: u32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const edit = try self.getEditBuffer(handle);
        try edit.checkMutable();
        try edit.buffer.setCursor(row, col);
    }

    pub fn editHistory(self: *Context, handle: Handle, redo: bool) ![]const u8 {
        try self.beginMutation();
        defer self.mutating = false;
        const edit = try self.getEditBuffer(handle);
        try edit.checkMutable();
        if (!if (redo) edit.buffer.canRedo() else edit.buffer.canUndo()) return &.{};
        return if (redo) edit.buffer.redo() else edit.buffer.undo();
    }

    pub fn editCommand(self: *Context, handle: Handle, command: EditCommand) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const edit = try self.getEditBuffer(handle);
        try edit.checkMutable();
        try prepareTextBuffer(edit.buffer.tb);
        switch (command) {
            .delete_forward => try edit.buffer.deleteForward(),
            .backspace => try edit.buffer.backspace(),
            .new_line => {
                try validateEditTextBytes(edit.buffer.tb, "\n", edit.buffer.tb.getByteSize());
                try edit.buffer.insertText("\n");
            },
            .delete_line => try edit.buffer.deleteLine(),
            .move_left => edit.buffer.moveLeft(),
            .move_right => edit.buffer.moveRight(),
            .move_up => edit.buffer.moveUp(),
            .move_down => edit.buffer.moveDown(),
            .goto_line => |line| try edit.buffer.gotoLine(line),
            .cursor_offset => |offset| try edit.buffer.setCursorByOffset(offset),
            .clear => try edit.buffer.clear(),
            .clear_history => edit.buffer.clearHistory(),
            .debug_rope => edit.buffer.debugLogRope(),
        }
    }

    pub fn editSetDefaults(self: *Context, handle: Handle, options: TextDefaults) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const edit = try self.getEditBuffer(handle);
        try edit.checkMutable();
        try setBufferDefaults(edit.buffer.tb, options);
        edit.invalidate();
    }

    pub fn editHighlight(self: *Context, handle: Handle, operation: TextHighlight) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const edit = try self.getEditBuffer(handle);
        try edit.checkMutable();
        try highlightBuffer(edit.buffer.tb, operation);
        edit.invalidate();
    }

    pub fn editorSetViewport(self: *Context, handle: Handle, viewport: text_buffer_view.Viewport, size_only: bool, move_cursor: bool) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const view = try self.getEditorView(handle);
        try view.edit.checkMutable();
        try validateViewport(viewport);
        try view.prepareView();
        if (size_only) view.view.setViewportSize(viewport.width, viewport.height) else view.view.setViewport(viewport, move_cursor);
        view.invalidate();
    }

    pub fn editorSetScrollMargin(self: *Context, handle: Handle, margin: f32) !void {
        try self.beginMutation();
        defer self.mutating = false;
        if (!std.math.isFinite(margin)) return error.InvalidOptions;
        const view = try self.getEditorView(handle);
        try view.edit.checkMutable();
        view.view.setScrollMargin(margin);
        view.invalidate();
    }

    pub fn editorCommand(self: *Context, handle: Handle, command: EditorCommand) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const view = try self.getEditorView(handle);
        // Cursor commands synchronously update every view of the edit buffer.
        try view.edit.checkMutable();
        if (command == .tab_indicator) try validateTabIndicator(command.tab_indicator);
        try view.prepareView();
        switch (command) {
            .move_up => view.view.moveUpVisual(),
            .move_down => view.view.moveDownVisual(),
            .goto_line_end => view.view.gotoVisualLineEnd(),
            .delete_selection => try view.view.deleteSelectedText(),
            .cursor_offset => |offset| try view.view.setCursorByOffset(offset),
            .wrap_mode => |mode| view.view.setWrapMode(mode),
            .tab_indicator => |indicator| view.view.setTabIndicator(indicator),
        }
        switch (command) {
            .wrap_mode, .tab_indicator => view.invalidate(),
            else => view.invalidatePreparation(),
        }
    }

    pub fn editorSetTabColor(self: *Context, handle: Handle, color: ?buf.RGBA) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const view = try self.getEditorView(handle);
        try view.edit.checkMutable();
        if (color) |rgba| try buf.validateColor(rgba);
        view.view.setTabIndicatorColor(color);
        view.invalidatePreparation();
    }

    pub fn editorSelect(self: *Context, handle: Handle, options: TextSelection) !bool {
        try self.beginMutation();
        defer self.mutating = false;
        const view = try self.getEditorView(handle);
        try view.edit.checkMutable();
        return selectView(view, options);
    }

    pub fn editorPrepareView(self: *Context, handle: Handle, follow_cursor: bool) !*Editor {
        try self.checkSceneRead();
        const view = try self.getEditorView(handle);
        if (follow_cursor) view.view.updateBeforeRender();
        try view.prepareView();
        return view;
    }

    pub fn editorReplaceSelection(self: *Context, handle: Handle, bytes: []const u8) !u32 {
        try self.beginMutation();
        defer self.mutating = false;
        const view = try self.getEditorView(handle);
        try view.edit.checkMutable();
        try validateEditTextBytes(view.edit.buffer.tb, bytes, view.edit.buffer.tb.getByteSize());
        const steps = try view.view.replaceSelectedText(bytes);
        view.invalidate();
        return steps;
    }

    pub fn editorSetPlaceholder(self: *Context, handle: Handle, bytes: []const u8, chunks: []const StyledTextChunk) !void {
        try self.beginMutation();
        defer self.mutating = false;
        const view = try self.getEditorView(handle);
        try view.edit.checkMutable();
        try validateEditTextBytes(view.edit.buffer.tb, bytes, 0);
        var offset: usize = 0;
        for (chunks) |chunk| {
            if (chunk.byte_count == 0 or chunk.byte_count > bytes.len - offset or
                chunk.attributes & ~ansi.TextAttributes.ATTRIBUTE_BASE_MASK != 0 or chunk.link_url != null) return error.InvalidOptions;
            if (chunk.foreground) |color| try buf.validateColor(color);
            if (chunk.background) |color| try buf.validateColor(color);
            if (!std.unicode.utf8ValidateSlice(bytes[offset..][0..chunk.byte_count])) return error.InvalidUnicode;
            offset += chunk.byte_count;
        }
        if (offset != bytes.len) return error.InvalidOptions;
        if (chunks.len == 0) {
            try view.view.setPlaceholderStyledText(&.{});
            view.invalidate();
            return;
        }
        const style = try syntax_style.SyntaxStyle.init(self.allocator);
        errdefer style.deinit();
        const ranges = try self.allocator.alloc(text_buffer.OwnedStyledChunk, chunks.len);
        defer self.allocator.free(ranges);
        for (chunks, ranges, 0..) |chunk, *range, index| {
            var name_buffer: [10]u8 = undefined;
            const name = std.fmt.bufPrint(&name_buffer, "{d}", .{index}) catch unreachable;
            range.* = .{ .byte_count = chunk.byte_count, .style_id = try style.registerStyle(name, chunk.foreground, chunk.background, chunk.attributes) };
        }
        const copy = try self.allocator.dupe(u8, bytes);
        errdefer self.allocator.free(copy);
        try view.view.setPlaceholderOwnedStyledText(copy, style, ranges, null);
        view.invalidate();
    }

    pub fn prepareTextBuffer(buffer: *text_buffer.UnifiedTextBuffer) !void {
        if (buffer.rope().markerCount(.linestart) != buffer.lineCount()) return error.OutOfMemory;
    }

    fn setBufferDefaults(buffer: *text_buffer.UnifiedTextBuffer, options: TextDefaults) !void {
        if (@as(u3, @bitCast(options.fields)) == 0) return error.InvalidOptions;
        if (options.foreground) |color| try buf.validateColor(color);
        if (options.background) |color| try buf.validateColor(color);
        if (options.attributes) |attributes| if (attributes & ~ansi.TextAttributes.ATTRIBUTE_BASE_MASK != 0) return error.InvalidOptions;
        if (options.fields.foreground) buffer.setDefaultFg(options.foreground);
        if (options.fields.background) buffer.setDefaultBg(options.background);
        if (options.fields.attributes) buffer.setDefaultAttributes(options.attributes);
    }

    fn highlightBuffer(buffer: *text_buffer.UnifiedTextBuffer, operation: TextHighlight) !void {
        try prepareTextBuffer(buffer);
        switch (operation) {
            .add_line => |line| {
                const h = line.range;
                try buffer.addHighlight(line.line, h.start, h.end, h.style_id, h.priority, h.ref);
            },
            .add_range => |h| try buffer.addHighlightByCharRange(h.start, h.end, h.style_id, h.priority, h.ref),
            .remove_ref => |ref| try buffer.removeHighlightsByRefChecked(ref),
            .clear_line => |line| buffer.clearLineHighlights(line),
            .clear_all => buffer.clearAllHighlights(),
        }
    }

    fn validateViewport(viewport: text_buffer_view.Viewport) !void {
        if (@as(u64, viewport.x) + viewport.width > std.math.maxInt(i32) or
            @as(u64, viewport.y) + viewport.height > std.math.maxInt(i32)) return error.InvalidOptions;
    }

    fn validateTabIndicator(indicator: ?u32) !void {
        if (indicator) |value| {
            if (value < 0x20 or (value >= 0x7f and value <= 0x9f) or
                value > 0x10ffff or (value >= 0xd800 and value <= 0xdfff)) return error.InvalidOptions;
        }
    }

    fn selectView(value: anytype, options: TextSelection) !bool {
        const is_editor = @TypeOf(value) == *Editor;
        const view = if (is_editor) value.view.text_buffer_view else value.view;
        const buffer = if (is_editor) value.edit.buffer.tb else value.text.buffer;
        const local = options.operation == .local or options.operation == .local_update;
        if (options.foreground) |color| try buf.validateColor(color);
        if (options.background) |color| try buf.validateColor(color);
        if (local) {
            if (view.getViewport()) |viewport| {
                const x = if (view.wrap_mode == .none) std.math.cast(i32, viewport.x) orelse return error.InvalidOptions else 0;
                const y = std.math.cast(i32, viewport.y) orelse return error.InvalidOptions;
                _ = std.math.add(i32, options.anchor_x, x) catch return error.InvalidOptions;
                _ = std.math.add(i32, options.focus_x, x) catch return error.InvalidOptions;
                _ = std.math.add(i32, options.anchor_y, y) catch return error.InvalidOptions;
                _ = std.math.add(i32, options.focus_y, y) catch return error.InvalidOptions;
            }
            if (buffer.lineWidthColsMax() > std.math.maxInt(i32)) return error.InvalidOptions;
        }
        if (options.operation != .reset and options.operation != .local_reset) {
            if (!is_editor) try prepareTextBuffer(buffer);
            try value.prepareView();
        }
        const fg = options.foreground;
        const bg = options.background;
        if (is_editor and local) value.view.setSelectionFollowCursor(options.follow_cursor);
        var changed = false;
        switch (options.operation) {
            .set => value.view.setSelection(options.start, options.end, bg, fg),
            .update => value.view.updateSelection(options.end, bg, fg),
            .reset => value.view.resetSelection(),
            .local => changed = if (is_editor)
                value.view.setLocalSelectionBehavior(options.anchor_x, options.anchor_y, options.focus_x, options.focus_y, bg, fg, options.update_cursor, options.behavior)
            else
                value.view.setLocalSelectionBehavior(options.anchor_x, options.anchor_y, options.focus_x, options.focus_y, bg, fg, options.behavior),
            .local_update => changed = if (is_editor)
                value.view.updateLocalSelectionBehavior(options.anchor_x, options.anchor_y, options.focus_x, options.focus_y, bg, fg, options.update_cursor, options.behavior)
            else
                value.view.updateLocalSelectionBehavior(options.anchor_x, options.anchor_y, options.focus_x, options.focus_y, bg, fg, options.behavior),
            .local_reset => value.view.resetLocalSelection(),
            .cell => changed = value.view.convertSelectionToCell(),
            .occupancy => value.view.setSelectionOccupancy(options.occupancy),
            .inclusive => if (is_editor) value.view.setSelectionInclusive(options.start, options.end, bg, fg) else view.setSelectionInclusiveStyle(options.start, options.end, .{ .bgColor = bg, .fgColor = fg }),
            .colors => view.setSelectionColors(bg, fg),
        }
        value.invalidatePreparation();
        return changed;
    }

    /// During checked edits, the observer runs without admitting Context mutation.
    /// Hosts retaining legacy event order enqueue each notification before returning.
    pub fn setEditEventCallback(self: *Context, callback: ?EditEventCallback, userdata: ?*anyopaque) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        self.edit_event_callback = callback;
        self.edit_event_userdata = userdata;
    }

    fn replaceTextContent(self: *Context, text: anytype, bytes: []const u8) !void {
        const copy = try self.allocator.dupe(u8, bytes);
        errdefer self.allocator.free(copy);
        // Owned scene/shared text excludes registrations borrowed from the rope arena.
        text.input_mem_id = try text.buffer.replaceOwnedText(copy, text.input_mem_id);
    }

    fn textResourceChanged(text: *Text) void {
        var next = text.view.measure_dependents;
        while (next) |dependent| {
            yoga.yogaNodeMarkDirty(dependent.yoga_node);
            next = dependent.measure_next;
        }
    }

    fn destroyTextResource(self: *Context, text: *Text) void {
        text.view.retireStorage();
        text.buffer.retireStorage();
        if (text.owned_style) |style| style.deinit();
        text.owned_style = null;
        if (!self.closing and self.text_pool_count < @min(self.objects.slots.len, text_pool_count_max)) {
            const bytes = @sizeOf(Text) + text.buffer.retainedStorageBytes() + text.view.retainedStorageBytes();
            if (bytes <= text_storage_bytes_max and bytes <= text_pool_bytes_max - self.text_pool_bytes) {
                text.pool_next = self.text_pool;
                self.text_pool = text;
                self.text_pool_count += 1;
                self.text_pool_bytes += bytes;
                return;
            }
        }
        self.freeTextStorage(text);
    }

    fn freeTextStorage(self: *Context, text: *Text) void {
        text.view.deinit();
        text.buffer.deinit();
        if (text.owned_style) |style| style.deinit();
        self.allocator.destroy(text);
    }

    /// Destroys one object, not a subtree. An attached renderable detaches from
    /// its Yoga parent and invalidates that parent's layout.
    pub fn destroy(self: *Context, handle: Handle) Error!void {
        try self.beginMutation();
        defer self.mutating = false;
        const value: ?*session.Session = self.getSession(handle) catch |err| switch (err) {
            error.WrongKind => null,
            else => return err,
        };
        if (value) |owned| try checkSessionTeardown(owned);
        if (self.objects.get(handle, .native_renderable, native_renderable.NativeRenderable)) |node| {
            if (node.scene_node != null) try yoga.check(yoga.nodeTeardownStatus(node.yoga_node));
        } else |_| {}
        switch (try self.objects.getKind(handle)) {
            .edit_buffer => try (try self.getEditBuffer(handle)).checkMutable(),
            .editor_view => try (try self.getEditorView(handle)).checkMutable(),
            .text_buffer => try (try self.getTextBuffer(handle)).checkMutable(),
            .text_buffer_view => try (try self.getTextBufferView(handle)).checkMutable(),
            else => {},
        }
        const token = try self.objects.beginDestroy(handle);
        self.destroyToken(token);
    }

    pub fn beginMutation(self: *Context) Error!void {
        if (self.closing) return error.ContextClosed;
        if (self.mutating) return error.ContextBusy;
        self.mutating = true;
    }

    fn destroyToken(self: *Context, token: handles.DestroyToken) void {
        defer self.objects.finishDestroy(token);
        switch (token.kind) {
            .encoded_unicode => {
                const value: *EncodedUnicode = @ptrCast(@alignCast(token.ptr));
                value.deinit(self.allocator, &self.graphemes);
            },
            .embedded_terminal => {
                const value: *embedded_terminal.EmbeddedTerminal = @ptrCast(@alignCast(token.ptr));
                value.deinit();
            },
            .image => {
                const value: *image.Image = @ptrCast(@alignCast(token.ptr));
                value.deinit();
            },
            .text_buffer => {
                const value: *SharedText = @ptrCast(@alignCast(token.ptr));
                while (value.views) |view| self.destroyToken(self.objects.beginDestroy(view.handle) catch unreachable);
                value.buffer.deinit();
                if (value.owned_style) |style| style.deinit();
                self.allocator.destroy(value);
            },
            .text_buffer_view => {
                const value: *TextView = @ptrCast(@alignCast(token.ptr));
                if (value.node) |node| {
                    node.setMeasureTargetPreservingProvider(.none, node.scene_node.?.measure_overridden) catch unreachable;
                    node.scene_node.?.control.text_view.view = null;
                    node.scene_node.?.owner.preparation_dirty = true;
                    node.scene_node.?.owner.work.clearRetainingCapacity();
                }
                if (value.previous) |previous| previous.next = value.next else value.text.views = value.next;
                if (value.next) |next| next.previous = value.previous;
                value.view.deinit();
                self.allocator.destroy(value);
            },
            .edit_buffer => {
                const value: *Edit = @ptrCast(@alignCast(token.ptr));
                while (value.views) |view| self.destroyToken(self.objects.beginDestroy(view.handle) catch unreachable);
                value.buffer.deinit();
                self.allocator.destroy(value);
            },
            .editor_view => {
                const value: *Editor = @ptrCast(@alignCast(token.ptr));
                if (value.node) |node| {
                    node.setMeasureTargetPreservingProvider(.none, node.scene_node.?.measure_overridden) catch unreachable;
                    node.scene_node.?.editor = null;
                    node.scene_node.?.owner.preparation_dirty = true;
                    node.scene_node.?.owner.work.clearRetainingCapacity();
                }
                if (value.previous) |previous| previous.next = value.next else value.edit.views = value.next;
                if (value.next) |next| next.previous = value.previous;
                value.view.deinit();
                self.allocator.destroy(value);
            },
            .syntax_style => {
                const value: *syntax_style.SyntaxStyle = @ptrCast(@alignCast(token.ptr));
                value.deinit();
            },
            .session => {
                const value: *session.Session = @ptrCast(@alignCast(token.ptr));
                if (value.scene) |owned| {
                    owned.detachAll();
                    while (owned.head) |node| self.destroyToken(self.objects.beginDestroy(node.scene_node.?.handle) catch unreachable);
                }
                value.deinit() catch unreachable;
                self.allocator.destroy(value);
            },
            .buffer_lease => {
                const storage: *buf.BufferStorage = @ptrCast(@alignCast(token.ptr));
                var lease: buf.BufferLease = .{ .storage = storage };
                lease.releaseChecked(&self.lease_count, &self.lease_bytes, &self.lease_bytes_max);
            },
            .frame_buffer_lease => {
                const access: *FrameBufferLease = @ptrCast(@alignCast(token.ptr));
                const value = self.objects.get(access.frame.session, .session, session.Session) catch unreachable;
                std.debug.assert(value.frame_lease_count > 0);
                access.lease.releaseChecked(&self.lease_count, &self.lease_bytes, &self.lease_bytes_max);
                value.frame_lease_count -= 1;
                self.allocator.destroy(access);
            },
            .buffer => {
                const value: *buf.OptimizedBuffer = @ptrCast(@alignCast(token.ptr));
                value.deinit();
            },
            .native_renderable => {
                const value: *native_renderable.NativeRenderable = @ptrCast(@alignCast(token.ptr));
                const state = &value.scene_node.?;
                const text = state.text;
                if (state.editor) |editor| editor.node = null;
                if (state.kind == 7) {
                    if (state.control.text_view.view) |view| view.node = null;
                }
                const storage = state.owner.remove(value);
                if (value.surface) |surface| surface.deinit();
                value.surface = null;
                value.detachMeasure();
                if (self.scene_measures.fetchRemove(token.handle.slot)) |entry| self.allocator.destroy(entry.value);
                if (text) |resource| self.destroyTextResource(resource);
                self.releaseNodeStorage(storage);
            },
        }
    }
};
