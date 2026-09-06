const std = @import("std");
const builtin = @import("builtin");
const ansi = @import("ansi.zig");
const handles = @import("context-handles.zig");
const feed = @import("native-span-feed.zig");
const renderer = @import("renderer.zig");
const terminal = @import("terminal.zig");
const scene = @import("scene.zig");
const buffer = @import("buffer.zig");
const Context = @import("context.zig").Context;

test {
    _ = @import("tests/session-split_test.zig");
}

pub const Error = feed.StreamError || error{
    SessionClosed,
    SessionFailed,
    SessionCancelled,
    WrongContext,
    WrongSession,
    StaleHandle,
    StaleRequest,
    InvalidTicket,
    RequestLimit,
    RendererAlreadyAttached,
    RendererNotAttached,
    PresentationPending,
    PresentationFailed,
    IncompatibleOutput,
    SplitRenderPending,
    InvalidOptions,
    InvalidTerminalState,
    TerminalInactive,
    InvalidClock,
    InvalidBudget,
    ControlPacketTooLarge,
    FrameBusy,
    StaleFrame,
    SceneNotAttached,
};

pub const Options = struct {
    /// Fixed chunk storage and retained-payload limit: chunk_size * chunk_count.
    /// Atomic writes use a whole chunk for each span, even for short writes.
    chunk_size: u32 = 64 * 1024,
    chunk_count: u32 = 2,
    span_capacity: u32 = 2,
    /// Control bytes held inside chunk storage, rounded up to whole chunks.
    /// Zero disables reservation; leave at least one ordinary chunk and span slot.
    control_capacity: u32 = 0,
};

pub const RendererOptions = struct {
    remote_mode: terminal.RemoteMode = .local,
    /// Borrowed until Session destruction. An empty map excludes the host environment.
    env_map: ?*const std.process.Environ.Map = null,
    /// Copied during attachment. Mutually exclusive with the authoritative env_map.
    forwarded_env: ?[]const EnvironmentEntry = null,
};

pub const EnvironmentEntry = struct { key: []const u8, value: []const u8 };
// Initialization budgets include the two u32 lengths encoded for each entry.
pub const environment_entries_max: u32 = 256;
pub const environment_bytes_max: u32 = 65_536;

pub const TerminalOptions = struct {
    use_alternate_screen: bool = true,
    mouse: bool = true,
    mouse_movement: bool = true,
    kitty_keyboard_flags: u8 = (terminal.Options{}).kitty_keyboard_flags,
    /// Applies to both suspension and close, as in renderer restoration.
    clear_on_close: bool = true,
};

pub const TerminalPhase = enum(u8) {
    uninitialized,
    setting_up,
    active,
    suspending,
    suspended,
    resuming,
    closing,
    restored,
    failed,
    cancelled,
};

pub const TerminalState = struct {
    phase: TerminalPhase,
    deadline_ns: ?u64,
};

pub const MouseMode = enum(u8) { disabled, drag, motion };

pub const CursorOptions = struct {
    position: ?struct { x: i32, y: i32, visible: bool } = null,
    style: ?terminal.CursorStyle = null,
    blinking: ?bool = null,
    color: ?ansi.RGBA = null,
    cursor: ?terminal.MousePointerStyle = null,
};

/// Byte slices are borrowed for this call only. Replies must contain complete
/// 7-bit ASCII CSI, DCS, OSC, or APC capability responses, not input-stream chunks.
pub const Control = union(enum) {
    capability_response: []const u8,
    /// UTF-8 without C0, DEL, or C1 controls; at most title_bytes_max bytes.
    title: []const u8,
    mouse: MouseMode,
    /// Zero disables Kitty keyboard; other flags apply when support is detected.
    kitty_keyboard_flags: u8,
    restore_modes,
    query_pixel_resolution,
    query_theme_colors,
    /// Complete read-only OSC palette queries, optionally wrapped for tmux.
    palette_query: []const u8,
    reset_background,
    /// Desired cursor state only; the frame encoder owns output admission.
    cursor: CursorOptions,
};

pub const PumpStatus = enum(u8) { idle, again, output_pending, wait_until, closed };
pub const PumpResult = struct {
    status: PumpStatus,
    deadline_ns: ?u64 = null,
};

pub const control_packet_bytes_max: u32 = 4096;
pub const capability_response_bytes_max: u32 = control_packet_bytes_max;
pub const title_bytes_max: u32 = control_packet_bytes_max - "\x1b]0;\x07".len;
pub const cursor_settle_ns: u64 = 10 * std.time.ns_per_ms;
pub const split_snapshots_max: u32 = 64;

pub const SplitControl = union(enum) {
    reset: struct { seed_rows: u32, pinned_render_offset: u32 },
    sync: u32,
    output_offset: u32,
    render_offset: u32,
    transition: renderer.SplitFooterTransition,
    clear_transition,
};

const Lifecycle = struct {
    phase: TerminalPhase = .uninitialized,
    step: enum {
        idle,
        query,
        setup_screen,
        reserve_rows,
        enable,
        activate,
        delete_images,
        reset_input,
        restore_rows,
        reset_output,
        settle_first,
        show_cursor,
        settle_second,
    } = .idle,
    mouse: bool = false,
    mouse_movement: bool = true,
    rows_remaining: u32 = 0,
    image_index: usize = 0,
    deadline_ns: ?u64 = null,
};

pub const State = enum { open, closing, closed, failed, cancelled };

pub const RenderStatus = enum {
    /// This frame has completed presentation.
    presented,
    /// One accepted frame still awaits output completion; no second frame is accepted.
    pending,
    /// Backpressure rejected and cleared the drawn frame before output admission.
    skipped,
    /// Encoding or admission failed without publishing bytes. Transport stays open.
    failed,
};

pub const OutputTicket = struct {
    session: handles.Handle,
    request_id: u64,
    len: u32,
};

/// Written acknowledges the entire copy. The host handles partial I/O itself.
pub const OutputResult = enum { written, failed };

/// Context-owned, address-stable transport and optional renderer. Use Context's
/// checked methods. Session owns output, presentation, terminal lifecycle, and
/// destruction. Legacy renderer setup must remain disabled.
pub const Session = struct {
    handle: handles.Handle,
    output: *feed.Stream,
    renderer: ?*renderer.CliRenderer = null,
    scene: ?*scene.Scene = null,
    state: State = .open,
    span: ?feed.SpanInfo = null,
    span_offset: u32 = 0,
    pending: ?OutputTicket = null,
    last_request_id: u64 = 0,
    /// Successful ticket bytes, not retained span charges or discarded output.
    completed_bytes: u64 = 0,
    frame_end_offset: ?u64 = null,
    lifecycle: Lifecycle = .{},
    last_pump_ns: ?u64 = null,
    // Cancel revokes authority, but outstanding scopes still pin renderer storage.
    frame_lease_count: u32 = 0,

    pub fn deinit(self: *Session) error{Busy}!void {
        if (!self.canDestroy()) return error.Busy;
        std.debug.assert(self.span == null and self.pending == null);
        if (self.renderer) |value| value.destroyStorage();
        if (self.scene) |value| value.deinit();
        self.output.destroy();
    }

    /// Copies a complete write or rejects it without publishing any bytes.
    pub fn write(self: *Session, bytes: []const u8) Error!void {
        try self.checkOpen();
        switch (self.lifecycle.phase) {
            .uninitialized, .active, .suspended => {},
            else => return error.Busy,
        }
        try self.output.writeAtomic(bytes);
    }

    pub fn checkOpen(self: *const Session) Error!void {
        switch (self.state) {
            .open => {},
            .closing, .closed => return error.SessionClosed,
            .failed => return error.SessionFailed,
            .cancelled => return error.SessionCancelled,
        }
    }

    /// Accepts at most one deferred frame. Even a no-byte frame waits for earlier
    /// raw output; later raw writes do not delay that frame's presentation.
    pub fn render(self: *Session, force: bool) Error!RenderStatus {
        try self.checkRendering();
        try self.checkFrameIdle();
        if (self.scene) |owned| {
            if (owned.cancelled_paint) return error.StaleFrame;
        }
        return self.renderReady(force, null);
    }

    pub fn commitSceneFrame(self: *Session, frame: scene.FrameRequest, force: bool) Error!RenderStatus {
        try self.checkRendering();
        const owned = self.scene orelse return error.SceneNotAttached;
        const painted = try owned.checkPainted(frame);
        if (self.frame_lease_count != 0) return error.FrameBusy;
        const attached = self.renderer orelse return error.RendererNotAttached;
        if (!painted.destination.matches(attached.getNextBuffer())) return error.StaleFrame;
        errdefer self.cancelSceneFrame();
        const status = try self.renderReady(force, null);
        owned.painted = null;
        // A failed encoder may leave scratch cells intact, but cannot authorize their replay.
        owned.cancelled_paint = status == .failed;
        return status;
    }

    pub fn copySceneFrame(self: *Session, frame: scene.FrameRequest, target: *buffer.OptimizedBuffer) !void {
        try self.checkRendering();
        if (self.frame_lease_count != 0) return error.FrameBusy;
        if (self.frame_end_offset != null) return error.PresentationPending;
        const owned = self.scene orelse return error.SceneNotAttached;
        const painted = try owned.checkPainted(frame);
        const source = (self.renderer orelse return error.RendererNotAttached).getNextBuffer();
        if (!painted.destination.matches(source)) return error.StaleFrame;
        if (target.owner_context_id != self.handle.context_id) return error.WrongContext;
        try target.copyFrom(source);
    }

    /// Snapshot serialization may materialize image fallbacks. Private, bounded
    /// copies keep both rejected admission and in-flight output from changing sources.
    pub fn renderSplit(self: *Session, frame: ?scene.FrameRequest, snapshots: []const renderer.SplitSnapshot, pinned_render_offset: u32, force: bool) !RenderStatus {
        const suspended_snapshots = frame == null and self.lifecycle.phase == .suspended;
        if (suspended_snapshots) {
            try self.checkOpen();
        } else {
            try self.checkRendering();
        }
        const attached = self.renderer orelse return error.RendererNotAttached;
        if (self.frame_end_offset != null) return .pending;
        if (snapshots.len > split_snapshots_max or pinned_render_offset > std.math.maxInt(u16)) return error.InvalidOptions;
        if (frame) |request| {
            const owned = self.scene orelse return error.SceneNotAttached;
            const painted = try owned.checkPainted(request);
            if (self.frame_lease_count != 0) return error.FrameBusy;
            if (!painted.destination.matches(attached.getNextBuffer())) return error.StaleFrame;
        } else try self.checkFrameIdle();
        var copies: [split_snapshots_max]renderer.SplitSnapshot = undefined;
        var count: usize = 0;
        defer for (copies[0..count]) |copy| copy.snapshot.deinit();
        var remaining = self.output.options.max_bytes;
        for (snapshots) |commit| {
            const source = commit.snapshot;
            const cells = @as(u64, source.width) * source.height;
            const bytes = std.math.mul(u64, cells, 24) catch return error.InvalidOptions;
            if (bytes > remaining or commit.row_columns > source.width) return error.InvalidOptions;
            remaining -= bytes;
            const copy = try buffer.OptimizedBuffer.init(attached.allocator, source.width, source.height, .{
                .pool = source.pool,
                .link_pool = source.link_pool,
                .width_method = source.width_method,
                .logger = source.logger,
            });
            copies[count] = commit;
            copies[count].snapshot = copy;
            count += 1;
            copy.owner_context_id = source.owner_context_id;
            try Context.drawContextBuffer(copy, source, 0, 0, .{});
        }
        const status = try self.renderReady(force, .{
            .snapshots = copies[0..count],
            .pinned_render_offset = pinned_render_offset,
            .paint_footer = frame != null,
            .suspended = suspended_snapshots,
        });
        if (frame != null) {
            self.scene.?.painted = null;
            self.scene.?.cancelled_paint = status == .failed;
        }
        return status;
    }

    fn renderReady(self: *Session, force: bool, split: ?renderer.SplitRender) Error!RenderStatus {
        const value = self.renderer orelse return error.RendererNotAttached;
        if (self.frame_end_offset != null) return .pending;
        const lifecycle_active = self.lifecycle.phase == .active;
        const previous_reservation = self.output.control_sequence;
        if (lifecycle_active) {
            const count = @max(value.currentImages.items.len, value.nextRenderBuffer.image_placements.items.len);
            try self.reserveControlSequence(try cleanupPackets(count));
        }
        var accepted = false;
        defer if (lifecycle_active and !accepted) {
            self.output.setControlSequenceReservation(previous_reservation) catch unreachable;
        };
        const result = if (split) |options|
            try value.renderSplitDeferred(options, force)
        else
            try value.renderDeferred(force);
        switch (result) {
            .skipped => return .skipped,
            .failed => return .failed,
            .rendered => {},
        }
        accepted = true;
        self.frame_end_offset = self.output.getStats().bytes_written;
        std.debug.assert(self.completed_bytes <= self.frame_end_offset.?);
        if (self.completed_bytes == self.frame_end_offset.?) {
            self.finishPresentation(.presented);
            return .presented;
        }
        return .pending;
    }

    pub fn checkRendering(self: *const Session) Error!void {
        try self.checkOpen();
        switch (self.lifecycle.phase) {
            .uninitialized, .active => {},
            else => return error.TerminalInactive,
        }
    }

    pub fn checkResizing(self: *const Session) Error!void {
        if (self.lifecycle.phase == .suspended) return self.checkOpen();
        try self.checkRendering();
    }

    pub fn splitControl(self: *Session, command: SplitControl) Error!u32 {
        try self.checkOpen();
        const value = self.renderer orelse return error.RendererNotAttached;
        if (command == .output_offset) return value.getSplitOutputOffset(command.output_offset);
        try self.checkFrameIdle();
        if (self.frame_end_offset != null) return error.PresentationPending;
        switch (command) {
            .reset => |options| {
                if (options.seed_rows > std.math.maxInt(u16) or options.pinned_render_offset > std.math.maxInt(u16)) return error.InvalidOptions;
                return value.resetSplitScrollback(options.seed_rows, options.pinned_render_offset);
            },
            .sync => |offset| {
                if (offset > std.math.maxInt(u16)) return error.InvalidOptions;
                return value.syncSplitScrollback(offset);
            },
            .render_offset => |offset| {
                if (offset > std.math.maxInt(u16)) return error.InvalidOptions;
                value.renderOffset = offset;
            },
            .transition => |transition| {
                if (@as(u64, transition.source_top_line) + transition.source_height > std.math.maxInt(u16) or
                    @as(u64, transition.target_top_line) + transition.target_height > std.math.maxInt(u16) or
                    transition.scroll_lines > std.math.maxInt(u16)) return error.InvalidOptions;
                value.pendingSplitFooterTransition = transition;
            },
            .clear_transition => value.clearPendingSplitFooterTransition(),
            .output_offset => unreachable,
        }
        return value.renderOffset;
    }

    pub fn setScreen(self: *Session, alternate: bool, width: u32, height: u32, trailing_output: []const u8) !void {
        try self.checkOpen();
        try self.checkFrameIdle();
        if (self.frame_end_offset != null) return error.PresentationPending;
        const value = self.renderer orelse return error.RendererNotAttached;
        var candidate = value.terminal;
        var bytes: [control_packet_bytes_max]u8 = undefined;
        var writer: std.Io.Writer = .fixed(&bytes);
        switch (self.lifecycle.phase) {
            .uninitialized, .suspended => {},
            .active => {
                if (value.useAlternateScreen != alternate) {
                    const keyboard_flags = candidate.state.kitty_keyboard_flags;
                    const keyboard_enabled = candidate.state.kitty_keyboard;
                    try candidate.setKittyKeyboard(&writer, false, 0);
                    if (alternate) try candidate.enterAltScreen(&writer) else try candidate.exitAltScreen(&writer);
                    if (keyboard_enabled) try candidate.setKittyKeyboard(&writer, true, keyboard_flags);
                }
            },
            else => return error.TerminalInactive,
        }
        if (trailing_output.len > bytes.len - writer.buffered().len) return error.InvalidOptions;
        try writer.writeAll(trailing_output);
        try value.resizeWithOutput(width, height, writer.buffered());
        candidate.state.cursor = value.terminal.state.cursor;
        value.terminal.state = candidate.state;
        value.useAlternateScreen = alternate;
        value.imageScreenInvalidated = true;
        value.invalidateTerminalState();
    }

    pub fn syncDetached(self: *Session, parent: *Session) Error!void {
        try self.checkOpen();
        try parent.checkOpen();
        try self.checkFrameIdle();
        if (self.handle.context_id != parent.handle.context_id) return error.WrongContext;
        if (self == parent or self.lifecycle.phase != .uninitialized or self.frame_end_offset != null) return error.InvalidOptions;
        const value = self.renderer orelse return error.RendererNotAttached;
        const source = parent.renderer orelse return error.RendererNotAttached;
        value.terminal.caps = source.terminal.caps;
        value.terminal.image_protocol = source.terminal.image_protocol;
        value.image_resolution = source.image_resolution;
        value.syncWidthMethod();
    }

    pub fn checkFrameIdle(self: *const Session) Error!void {
        if (self.frame_lease_count != 0) return error.FrameBusy;
        if (self.scene) |owned| {
            if (owned.attempt != null or owned.painted != null) return error.FrameBusy;
        }
    }

    pub fn checkLayoutIdle(self: *const Session) Error!void {
        if (self.scene) |owned| {
            if (owned.attempt != null and !owned.isPainting()) return error.FrameBusy;
        }
    }

    pub fn cancelSceneFrame(self: *Session) void {
        if (self.scene) |owned| {
            if (owned.painted != null or owned.isPainting()) {
                if (self.renderer) |attached| {
                    @memset(attached.nextHitGrid, 0);
                    attached.getNextBuffer().clearScissorRects();
                    attached.getNextBuffer().clearOpacity();
                    attached.hitGridClearScissorRects();
                }
            }
            owned.cancelFrame();
        }
    }

    /// Initial managed setup must precede accepted frames: switching screens would
    /// strand their image state. Earlier raw output may still be queued or copied.
    /// This accepts a request; pump emits its packets after that output completes.
    pub fn setupTerminal(self: *Session, options: TerminalOptions) Error!void {
        try self.checkOpen();
        try self.checkLayoutIdle();
        const value = self.renderer orelse return error.RendererNotAttached;
        if (self.lifecycle.phase != .uninitialized) return error.InvalidTerminalState;
        if (self.frame_end_offset != null or value.renderStats.frameCount != 0) return error.InvalidTerminalState;
        try self.checkTerminalStart(options.kitty_keyboard_flags);
        const rows = if (!options.use_alternate_screen and value.renderOffset == 0) value.height - 1 else 0;
        const packets = try setupPackets(try cleanupPackets(0), rows, true);
        try self.reserveControlSequence(packets);
        value.useAlternateScreen = options.use_alternate_screen;
        value.clearOnShutdown = options.clear_on_close;
        value.terminal.opts.kitty_keyboard_flags = options.kitty_keyboard_flags;
        self.lifecycle = .{
            .phase = .setting_up,
            .step = .query,
            .mouse = options.mouse,
            .mouse_movement = options.mouse_movement,
            .rows_remaining = rows,
        };
    }

    pub fn suspendTerminal(self: *Session) Error!void {
        try self.checkOpen();
        const preparation_yielded = if (self.scene) |owned| owned.isYielded() and !owned.isPainting() else false;
        if (!preparation_yielded) try self.checkLayoutIdle();
        switch (self.lifecycle.phase) {
            .suspending, .suspended => return,
            .active => {},
            else => return error.InvalidTerminalState,
        }
        if (preparation_yielded) self.cancelSceneFrame();
        const value = self.renderer.?;
        value.terminalSuspended = true;
        value.cancelKittyImageTransport(false);
        self.lifecycle.phase = .suspending;
        self.lifecycle.step = .delete_images;
        self.lifecycle.image_index = 0;
    }

    pub fn resumeTerminal(self: *Session) Error!void {
        try self.checkOpen();
        if (self.lifecycle.phase != .suspended) return error.InvalidTerminalState;
        const value = self.renderer.?;
        try self.checkTerminalStart(value.terminal.opts.kitty_keyboard_flags);
        const rows = if (!value.useAlternateScreen and value.renderOffset == 0) value.height - 1 else 0;
        const packets = try setupPackets(try cleanupPackets(value.currentImages.items.len), rows, false);
        try self.reserveControlSequence(packets);
        value.terminal.setCursorPosition(1, 1, false);
        value.terminalSuspended = false;
        self.lifecycle.phase = .resuming;
        self.lifecycle.step = .setup_screen;
        self.lifecycle.rows_remaining = rows;
    }

    pub fn getTerminalState(self: *const Session) TerminalState {
        return .{ .phase = self.lifecycle.phase, .deadline_ns = self.lifecycle.deadline_ns };
    }

    /// Emitting controls use ordinary capacity, never restoration storage or headroom.
    /// Also accepts capability replies during setup after query publication and during resume.
    /// Cursor intent is synchronous in any open phase; other controls require active.
    /// Queued and copied output stays ahead.
    /// Rejection preserves state and output. No allocation or host I/O occurs.
    pub fn control(self: *Session, command: Control) Error!void {
        try self.checkOpen();
        const value = self.renderer orelse return error.RendererNotAttached;
        if (command == .cursor) {
            const options = command.cursor;
            if (options.position) |position| {
                // Terminal restoration also stores zero-based rows and columns as u16.
                const position_max = @as(i32, std.math.maxInt(u16)) + 1;
                if (position.x > position_max or position.y > position_max) return error.InvalidOptions;
                value.terminal.setCursorPosition(@intCast(@max(1, position.x)), @intCast(@max(1, position.y)), position.visible);
                if (self.scene) |owned| owned.editor_cursor_owned = false;
            }
            const current = value.terminal.getCursorStyle();
            value.terminal.setCursorStyle(options.style orelse current.style, options.blinking orelse current.blinking);
            if (options.color) |color| value.terminal.setCursorColor(color);
            if (options.cursor) |cursor| value.terminal.setMousePointerStyle(cursor);
            return;
        }
        switch (self.lifecycle.phase) {
            .active => {},
            .setting_up, .resuming => {
                if (command != .capability_response or self.lifecycle.step == .query) {
                    return error.TerminalInactive;
                }
            },
            else => return error.TerminalInactive,
        }
        try self.checkTerminalOutput();
        switch (command) {
            .title => |title| {
                if (title.len > title_bytes_max) return error.InvalidOptions;
                const view = std.unicode.Utf8View.init(title) catch return error.InvalidOptions;
                var codepoints = view.iterator();
                while (codepoints.nextCodepoint()) |codepoint| {
                    if (codepoint < 0x20 or (codepoint >= 0x7f and codepoint <= 0x9f)) {
                        return error.InvalidOptions;
                    }
                }
            },
            .kitty_keyboard_flags => |flags| {
                if (flags & ~@as(u8, 0b11111) != 0) return error.InvalidOptions;
            },
            .palette_query => |bytes| try validatePaletteQuery(bytes),
            else => {},
        }
        try self.publishTerminalPacket(command);
    }

    pub fn setPaletteState(self: *Session, palette: []const ansi.RGBA, default_fg: ansi.RGBA, default_bg: ansi.RGBA, epoch: u32) Error!void {
        try self.checkOpen();
        const value = self.renderer orelse return error.RendererNotAttached;
        if (self.lifecycle.phase != .active) return error.TerminalInactive;
        if (palette.len > 256) return error.InvalidOptions;
        value.setPaletteState(palette, default_fg, default_bg, epoch);
    }

    /// Reuses terminal protocol selection and encoding; rejected output cannot consume an ID.
    pub fn triggerNotification(self: *Session, message: []const u8, title: ?[]const u8) Error!bool {
        try self.checkOpen();
        const value = self.renderer orelse return error.RendererNotAttached;
        if (self.lifecycle.phase != .active) return error.TerminalInactive;
        try self.checkTerminalOutput();
        const title_len = if (title) |text| text.len else 0;
        if (message.len > control_packet_bytes_max or title_len > control_packet_bytes_max - message.len) return false;
        var candidate = value.terminal;
        var bytes: [control_packet_bytes_max]u8 = undefined;
        var writer: std.Io.Writer = .fixed(&bytes);
        if (!(candidate.writeNotification(value.allocator, &writer, message, title) catch return false)) return false;
        self.output.writeAtomic(writer.buffered()) catch return false;
        value.terminal.notification_id_counter = candidate.notification_id_counter;
        return true;
    }

    pub fn setKittyImageTransport(self: *Session, mode: u32) Error!void {
        try self.checkOpen();
        const value = self.renderer orelse return error.RendererNotAttached;
        if (!value.setKittyImageTransport(mode)) return error.InvalidOptions;
        if (self.lifecycle.phase == .active) value.startKittyFileProbeFromSession();
    }

    pub fn kittyImageTransportStatus(self: *Session) Error![6]u32 {
        try self.checkOpen();
        const value = self.renderer orelse return error.RendererNotAttached;
        return value.kittyImageTransportStatus();
    }

    pub fn pollKittyImageTransport(self: *Session) Error!bool {
        try self.checkOpen();
        const value = self.renderer orelse return error.RendererNotAttached;
        return value.pollKittyImageTransport();
    }

    pub fn cancelKittyImageTransport(self: *Session, failed: bool) Error!void {
        try self.checkOpen();
        const value = self.renderer orelse return error.RendererNotAttached;
        value.cancelKittyImageTransport(failed);
    }

    pub fn processKittyImageReply(self: *Session, response: []const u8) Error!u32 {
        try self.checkOpen();
        const value = self.renderer orelse return error.RendererNotAttached;
        return value.processKittyImageReply(response);
    }

    pub fn startKittyFileProbe(self: *Session) Error!void {
        try self.checkOpen();
        const value = self.renderer orelse return error.RendererNotAttached;
        if (self.lifecycle.phase != .active) return;
        value.startKittyFileProbeFromSession();
    }

    fn validatePaletteQuery(bytes: []const u8) Error!void {
        if (bytes.len == 0 or bytes.len > control_packet_bytes_max) return error.InvalidOptions;
        const wrapped = std.mem.startsWith(u8, bytes, ansi.ANSI.tmuxDcsStart);
        var rest = bytes;
        if (wrapped) {
            if (!std.mem.endsWith(u8, rest, ansi.ANSI.tmuxDcsEnd)) return error.InvalidOptions;
            rest = rest[ansi.ANSI.tmuxDcsStart.len .. rest.len - ansi.ANSI.tmuxDcsEnd.len];
            if (rest.len == 0) return error.InvalidOptions;
        }
        const prefix = if (wrapped) "\x1b\x1b]4;" else "\x1b]";
        while (rest.len != 0) {
            if (!std.mem.startsWith(u8, rest, prefix)) return error.InvalidOptions;
            rest = rest[prefix.len..];
            const end = std.mem.findScalar(u8, rest, ';') orelse return error.InvalidOptions;
            if (end == 0 or end > 3) return error.InvalidOptions;
            const number = std.fmt.parseInt(u16, rest[0..end], 10) catch return error.InvalidOptions;
            rest = rest[end + 1 ..];
            if (!wrapped and number == 4) {
                const index_end = std.mem.findScalar(u8, rest, ';') orelse return error.InvalidOptions;
                if (index_end == 0 or index_end > 3) return error.InvalidOptions;
                _ = std.fmt.parseInt(u8, rest[0..index_end], 10) catch return error.InvalidOptions;
                rest = rest[index_end + 1 ..];
            } else if (wrapped) {
                if (number > 255) return error.InvalidOptions;
            } else if (!(number >= 10 and number <= 17) and number != 19) return error.InvalidOptions;
            if (!std.mem.startsWith(u8, rest, "?\x07")) return error.InvalidOptions;
            rest = rest[2..];
        }
    }

    /// Copies a complete OSC 52 sequence or returns false on unsupported capability,
    /// payload limits, allocation failure, or output pressure. No host I/O occurs.
    pub fn writeClipboard(self: *Session, target: terminal.ClipboardTarget, bytes: []const u8) Error!bool {
        try self.checkOpen();
        const value = self.renderer orelse return error.RendererNotAttached;
        if (self.lifecycle.phase != .active) return error.TerminalInactive;
        try self.checkTerminalOutput();
        if (self.output.staged_bytes != 0) return error.Busy;
        const output_len = value.terminal.clipboardSequenceSize(bytes.len) catch return false;
        // Charge ordinary capacity before allocating or encoding large payloads.
        // Clipboard writes cannot borrow restoration storage or counter headroom.
        self.output.setStagedBytes(output_len) catch return false;
        defer self.output.setStagedBytes(0) catch unreachable;
        const output_bytes = value.allocator.alloc(u8, output_len) catch return false;
        defer value.allocator.free(output_bytes);
        var writer: std.Io.Writer = .fixed(output_bytes);
        value.terminal.writeClipboard(&writer, target, bytes) catch return false;
        std.debug.assert(writer.buffered().len == output_len);
        self.output.setStagedBytes(0) catch unreachable;
        self.output.writeAtomic(writer.buffered()) catch return false;
        return true;
    }

    /// One work unit visits one image entry (including non-Kitty entries), emits
    /// at most 4096 control bytes, or advances one state. Budget must be nonzero.
    /// now_ns is monotone and caller-owned. Delays begin only when a pump observes
    /// completed output. The first wait requires room for both waits; a cursor
    /// retry requires room for the final wait. No allocation, clock reads, or sleeps.
    pub fn pump(self: *Session, now_ns: u64, work_budget: u32) Error!PumpResult {
        if (work_budget == 0) return error.InvalidBudget;
        if (self.last_pump_ns) |previous| {
            if (now_ns < previous) return error.InvalidClock;
        }
        switch (self.state) {
            .open, .closing => {},
            .closed => return .{ .status = .closed },
            .failed => return error.SessionFailed,
            .cancelled => return error.SessionCancelled,
        }
        const previous_now = self.last_pump_ns;
        self.last_pump_ns = now_ns;
        errdefer self.last_pump_ns = previous_now;
        return self.pumpWork(now_ns, work_budget);
    }

    /// Process-exit fallback only: stop admission and visit one restoration unit
    /// without cursor-settle waits. Output still requires successful completion;
    /// pending tickets and failed transports are never replayed or bypassed.
    pub fn pumpExit(self: *Session) Error!PumpStatus {
        try self.beginClose();
        if (self.state == .closed) return .closed;
        return (try self.pumpWork(null, 1)).status;
    }

    fn pumpWork(self: *Session, now_ns: ?u64, work_budget: u32) Error!PumpResult {
        var remaining = work_budget;
        while (remaining > 0) : (remaining -= 1) {
            if (!self.isDrained()) return .{ .status = .output_pending };
            switch (self.lifecycle.step) {
                .idle => return .{ .status = .idle },
                .activate => {
                    const value = self.renderer.?;
                    try self.reserveControlSequence(try cleanupPackets(value.currentImages.items.len));
                    value.invalidateTerminalState();
                    self.lifecycle.phase = .active;
                    self.lifecycle.step = .idle;
                    return .{ .status = .idle };
                },
                .settle_first, .settle_second => {
                    if (now_ns) |now| {
                        if (self.lifecycle.deadline_ns == null) {
                            const waits: u64 = if (self.lifecycle.step == .settle_first) 2 else 1;
                            _ = std.math.add(u64, now, waits * cursor_settle_ns) catch return error.InvalidClock;
                            self.lifecycle.deadline_ns = now + cursor_settle_ns;
                        }
                        const deadline = self.lifecycle.deadline_ns.?;
                        if (now < deadline) return .{ .status = .wait_until, .deadline_ns = deadline };
                    }
                    if (self.lifecycle.step == .settle_first) {
                        if (now_ns) |now| {
                            _ = std.math.add(u64, now, cursor_settle_ns) catch return error.InvalidClock;
                        }
                        self.lifecycle.step = .show_cursor;
                        self.lifecycle.deadline_ns = null;
                    } else {
                        try self.output.setControlSequenceReservation(.{});
                        const value = self.renderer.?;
                        value.currentImages.clearRetainingCapacity();
                        value.invalidateTerminalState();
                        self.lifecycle.deadline_ns = null;
                        self.lifecycle.step = .idle;
                        self.lifecycle.phase = if (self.state == .closing) .restored else .suspended;
                        if (self.state == .closing) {
                            try self.output.close();
                            self.state = .closed;
                            return .{ .status = .closed };
                        }
                        return .{ .status = .idle };
                    }
                },
                else => {
                    if (self.lifecycle.step == .show_cursor) {
                        if (now_ns) |now| {
                            _ = std.math.add(u64, now, cursor_settle_ns) catch return error.InvalidClock;
                        }
                    }
                    try self.publishTerminalPacket(null);
                },
            }
        }
        return .{ .status = if (self.isDrained()) .again else .output_pending };
    }

    fn checkTerminalOutput(self: *const Session) Error!void {
        const value = self.renderer.?;
        if (value.terminalSetup or value.backend != .feed or value.backend.feed.feed != self.output or
            self.output.callback != null or self.output.in_callback or value.backend.feed.frameActive)
        {
            return error.IncompatibleOutput;
        }
        if (value.splitBatchActive or value.pendingSplitFooterTransition.mode != .none) return error.SplitRenderPending;
    }

    fn checkTerminalStart(self: *Session, kitty_keyboard_flags: u8) Error!void {
        try self.checkTerminalOutput();
        const value = self.renderer.?;
        if (value.height == 0 or value.renderOffset == std.math.maxInt(u32) or
            kitty_keyboard_flags & ~@as(u8, 0b11111) != 0)
        {
            return error.InvalidOptions;
        }
        if (@as(u64, self.output.control_chunks) * self.output.options.chunk_size < control_packet_bytes_max) {
            return error.NoSpace;
        }
    }

    fn cleanupPackets(images: usize) Error!u64 {
        // Reserve the full Windows cursor-row range: a capability reply may still
        // update the saved row after setup. This is counter headroom, not storage.
        const rows: u64 = if (builtin.os.tag == .windows) std.math.maxInt(u16) else 0;
        const row_packets = std.math.divCeil(u64, rows, control_packet_bytes_max / ansi.ANSI.reverseIndex.len) catch unreachable;
        return std.math.add(u64, images, 4 + row_packets) catch error.NoSpace;
    }

    fn setupPackets(cleanup_packets: u64, rows: u32, query: bool) Error!u64 {
        const row_packets = std.math.divCeil(u64, rows, control_packet_bytes_max) catch unreachable;
        return std.math.add(u64, cleanup_packets, row_packets + 2 + @intFromBool(query)) catch error.NoSpace;
    }

    fn reserveControlSequence(self: *Session, packets: u64) Error!void {
        const bytes = std.math.mul(u64, packets, control_packet_bytes_max) catch return error.NoSpace;
        const spans_per_packet = std.math.divCeil(u64, control_packet_bytes_max, self.output.options.chunk_size) catch unreachable;
        const spans = std.math.mul(u64, packets, spans_per_packet) catch return error.NoSpace;
        // Tickets copy at least one byte, so byte headroom also covers their request IDs.
        try self.output.setControlSequenceReservation(.{ .bytes = bytes, .spans = spans });
    }

    fn publishTerminalPacket(self: *Session, command: ?Control) Error!void {
        const value = self.renderer.?;
        var candidate = value.terminal;
        var progress = self.lifecycle;
        const owned_environment = if (value.terminal.host_env_map) |*map| value.terminal.opts.env_map == map else false;
        // Environment policy distinguishes a forwarded, self-owned map by address.
        // The draft borrows its storage; only its self-relative pointer is rebased.
        if (owned_environment) candidate.opts.env_map = &candidate.host_env_map.?;
        var bytes: [control_packet_bytes_max]u8 = undefined;
        var writer: std.Io.Writer = .fixed(&bytes);
        if (command) |input| {
            writeControlPacket(input, &candidate, &progress, &writer) catch |err| return switch (err) {
                error.InvalidOptions => error.InvalidOptions,
                else => error.ControlPacketTooLarge,
            };
            try self.output.writeAtomic(writer.buffered());
        } else {
            self.writeTerminalPacket(&candidate, &progress, &writer) catch return error.ControlPacketTooLarge;
            try self.output.writeReservedControlAtomic(writer.buffered());
        }
        if (owned_environment) candidate.opts.env_map = &value.terminal.host_env_map.?;
        value.terminal = candidate;
        self.lifecycle = progress;
        value.syncWidthMethod();
        if (command != null and command.? == .capability_response) {
            value.invalidateTerminalState();
        }
    }

    fn writeControlPacket(command: Control, candidate: *terminal.Terminal, progress: *Lifecycle, writer: *std.Io.Writer) !void {
        switch (command) {
            .capability_response => |response| {
                try applyCapabilityResponses(candidate, response);
                _ = try candidate.sendPendingQueries(writer);
                // Setup enables modes after screen selection. Kitty's keyboard
                // stack belongs to that screen, not the previous one.
                if (progress.phase == .active or progress.step == .activate) {
                    try candidate.enableDetectedFeatures(writer, candidate.opts.kitty_keyboard_flags != 0);
                } else {
                    candidate.checkEnvironmentOverrides();
                }
            },
            .title => |title| try ansi.ANSI.setTerminalTitleOutput(writer, title),
            .mouse => |mode| {
                const enabled = mode != .disabled;
                const movement = if (enabled) mode == .motion else progress.mouse_movement;
                try candidate.setMouseMode(writer, enabled, movement);
                progress.mouse = enabled;
                progress.mouse_movement = movement;
            },
            .kitty_keyboard_flags => |flags| {
                if (candidate.state.kitty_keyboard and candidate.state.kitty_keyboard_flags != flags) {
                    try candidate.setKittyKeyboard(writer, false, 0);
                }
                candidate.setKittyKeyboardFlags(flags);
                try candidate.enableDetectedFeatures(writer, flags != 0);
            },
            .restore_modes => try candidate.restoreTerminalModes(writer),
            .query_pixel_resolution => try writer.writeAll(ansi.ANSI.queryPixelSize),
            .query_theme_colors => try candidate.queryThemeColors(writer),
            .palette_query => |bytes| try writer.writeAll(bytes),
            .reset_background => try writer.writeAll(ansi.ANSI.resetTerminalBgColor),
            .cursor => unreachable,
        }
    }

    fn writeTerminalPacket(self: *Session, candidate: *terminal.Terminal, progress: *Lifecycle, writer: *std.Io.Writer) !void {
        const value = self.renderer.?;
        switch (progress.step) {
            .query => {
                // Initialize before replies can supply the startup cursor position.
                candidate.setCursorPosition(1, 1, false);
                try candidate.queryTerminalSend(writer);
                progress.step = .setup_screen;
            },
            .setup_screen => {
                try writer.writeAll(ansi.ANSI.saveCursorState);
                if (value.useAlternateScreen) try candidate.enterAltScreen(writer);
                progress.step = if (progress.rows_remaining == 0) .enable else .reserve_rows;
            },
            .reserve_rows => {
                const count = @min(progress.rows_remaining, control_packet_bytes_max);
                try writer.splatByteAll('\n', count);
                progress.rows_remaining -= count;
                if (progress.rows_remaining == 0) progress.step = .enable;
            },
            .enable => {
                if (!value.useAlternateScreen and value.renderOffset == 0 and value.height > 1) {
                    try writer.print("\x1b[{d}A", .{value.height - 1});
                }
                try writer.writeAll(ansi.ANSI.hideCursor);
                try candidate.enableDetectedFeatures(writer, candidate.opts.kitty_keyboard_flags != 0);
                try candidate.setMouseMode(writer, progress.mouse, progress.mouse_movement);
                progress.step = .activate;
            },
            .delete_images => {
                if (progress.image_index < value.currentImages.items.len) {
                    try value.writeShutdownImage(writer, progress.image_index);
                    progress.image_index += 1;
                }
                if (progress.image_index == value.currentImages.items.len) progress.step = .reset_input;
            },
            .reset_input => {
                try candidate.resetInputModes(writer);
                progress.step = .reset_output;
                if (candidate.state.alt_screen) {
                    try candidate.exitAltScreen(writer);
                } else if (builtin.os.tag == .windows and !value.useAlternateScreen and
                    value.clearOnShutdown and value.renderOffset == 0)
                {
                    try writer.writeByte('\r');
                    progress.rows_remaining = candidate.state.cursor.row;
                    progress.step = .restore_rows;
                }
            },
            .restore_rows => {
                if (progress.rows_remaining != 0) {
                    const count = @min(progress.rows_remaining, control_packet_bytes_max / ansi.ANSI.reverseIndex.len);
                    try writer.splatBytesAll(ansi.ANSI.reverseIndex, count);
                    progress.rows_remaining -= count;
                } else {
                    try writer.writeAll(ansi.ANSI.eraseBelowCursor);
                    progress.step = .reset_output;
                }
            },
            .reset_output => {
                try candidate.resetOutputModes(writer);
                if (!value.useAlternateScreen and value.clearOnShutdown) {
                    if (value.renderOffset == 0) {
                        try writer.writeAll("\x1b[H\x1b[J");
                    } else {
                        try writer.writeAll("\x1b[r");
                        try ansi.ANSI.moveToOutput(writer, 1, value.renderOffset + 1);
                        try writer.writeAll(ansi.ANSI.eraseBelowCursor);
                        try ansi.ANSI.moveToOutput(writer, 1, value.renderOffset + 1);
                    }
                }
                try writer.writeAll(ansi.ANSI.resetCursorColorFallback ++ ansi.ANSI.resetCursorColor ++
                    ansi.ANSI.defaultCursorStyle ++ ansi.ANSI.showCursor);
                progress.step = .settle_first;
            },
            .show_cursor => {
                try writer.writeAll(ansi.ANSI.showCursor);
                progress.step = .settle_second;
            },
            .idle, .activate, .settle_first, .settle_second => unreachable,
        }
    }

    /// Copies only the next span's unacknowledged prefix into host-owned storage.
    /// Only out[0..ticket.len] is written. Empty reads consume no bytes or IDs.
    /// One copy may await completion; the whole span stays charged until completed.
    pub fn readOutput(self: *Session, out: []u8) Error!?OutputTicket {
        switch (self.state) {
            .open, .closing => {},
            .closed => return null,
            .failed => return error.SessionFailed,
            .cancelled => return error.SessionCancelled,
        }
        if (out.len == 0) return null;
        if (self.pending != null) return error.Busy;
        if (self.span == null and !self.output.hasPendingSpans()) return null;
        const request_id = std.math.add(u64, self.last_request_id, 1) catch
            return error.RequestLimit;
        if (self.span == null) {
            var spans: [1]feed.SpanInfo = undefined;
            const count = self.output.drainSpans(&spans);
            std.debug.assert(count == 1 and self.span_offset == 0);
            self.span = spans[0];
        }
        const bytes = self.span.?.slice()[self.span_offset..];
        const len: u32 = @intCast(@min(out.len, bytes.len));
        std.debug.assert(len > 0);
        @memcpy(out[0..len], bytes[0..len]);
        const ticket: OutputTicket = .{ .session = self.handle, .request_id = request_id, .len = len };
        self.pending = ticket;
        self.last_request_id = request_id;
        return ticket;
    }

    /// An invalid ticket changes nothing. A valid failed result consumes the
    /// request, not the bytes, and permanently stops transport without replay.
    pub fn completeOutput(self: *Session, ticket: OutputTicket, result: OutputResult) Error!void {
        if (ticket.session.context_id != self.handle.context_id) return error.WrongContext;
        if (ticket.session.slot != self.handle.slot) return error.WrongSession;
        if (ticket.session.generation != self.handle.generation) return error.StaleHandle;
        const pending = self.pending orelse return error.StaleRequest;
        if (ticket.request_id != pending.request_id) return error.StaleRequest;
        if (ticket.len != pending.len) return error.InvalidTicket;
        std.debug.assert(self.state == .open or self.state == .closing);
        self.pending = null;
        if (result == .failed) {
            self.cancelSceneFrame();
            self.state = .failed;
            self.lifecycle.phase = .failed;
            self.lifecycle.deadline_ns = null;
            self.finishPresentation(.failed);
            return;
        }
        const span = self.span.?;
        std.debug.assert(ticket.len <= span.len - self.span_offset);
        const published_bytes = self.output.getStats().bytes_written;
        std.debug.assert(self.completed_bytes <= published_bytes);
        std.debug.assert(ticket.len <= published_bytes - self.completed_bytes);
        self.completed_bytes += ticket.len;
        self.span_offset += ticket.len;
        if (self.span_offset == span.len) {
            self.output.releaseSpan(span.slot_index, span.release_id) catch unreachable;
            self.span = null;
            self.span_offset = 0;
        }
        if (self.frame_end_offset) |end_offset| {
            if (self.completed_bytes >= end_offset) self.finishPresentation(.presented);
        }
        if (self.state == .closing and self.output.closed and self.isDrained()) self.state = .closed;
    }

    /// Rejects further writes without waiting for the host to complete output.
    pub fn beginClose(self: *Session) Error!void {
        switch (self.state) {
            .open => {},
            .closing, .closed => return,
            .failed => return error.SessionFailed,
            .cancelled => return error.SessionCancelled,
        }
        self.cancelSceneFrame();
        switch (self.lifecycle.phase) {
            .uninitialized, .suspended, .restored => {
                try self.output.close();
                self.state = if (self.isDrained()) .closed else .closing;
                if (self.lifecycle.phase == .suspended) self.lifecycle.phase = .restored;
            },
            .active, .setting_up, .resuming, .suspending => {
                if (self.lifecycle.phase != .suspending) {
                    self.lifecycle.step = .delete_images;
                    self.lifecycle.image_index = 0;
                }
                self.lifecycle.phase = .closing;
                self.state = .closing;
            },
            .closing, .failed, .cancelled => unreachable,
        }
    }

    /// Explicitly discards disconnected output. Copies belong to the host, so
    /// cancellation leaves no native borrow and never retries accepted bytes.
    pub fn cancel(self: *Session) void {
        self.cancelSceneFrame();
        self.finishPresentation(.failed);
        if (self.span) |span| {
            self.output.releaseSpan(span.slot_index, span.release_id) catch unreachable;
            self.span = null;
        }
        var spans: [1]feed.SpanInfo = undefined;
        while (self.output.drainSpans(&spans) != 0) {
            self.output.releaseSpan(spans[0].slot_index, spans[0].release_id) catch unreachable;
        }
        self.output.close() catch unreachable;
        self.span_offset = 0;
        self.pending = null;
        self.state = .cancelled;
        self.lifecycle.phase = .cancelled;
        self.lifecycle.deadline_ns = null;
        std.debug.assert(self.isDrained());
    }

    pub fn canDestroy(self: *Session) bool {
        if (self.frame_lease_count != 0) return false;
        if (!self.isDrained()) return false;
        return switch (self.lifecycle.phase) {
            .uninitialized, .suspended, .restored, .cancelled => true,
            else => false,
        };
    }

    pub fn isDrained(self: *Session) bool {
        return self.frame_end_offset == null and self.output.getStats().outstanding_spans == 0;
    }

    pub fn getStats(self: *Session) feed.Stats {
        return self.output.getStats();
    }

    fn finishPresentation(self: *Session, outcome: renderer.PresentationOutcome) void {
        if (self.frame_end_offset == null) return;
        self.renderer.?.completePresentation(outcome) catch unreachable;
        self.frame_end_offset = null;
    }
};

fn applyCapabilityResponses(candidate: *terminal.Terminal, response: []const u8) Error!void {
    if (response.len == 0 or response.len > capability_response_bytes_max) return error.InvalidOptions;
    var offset: usize = 0;
    while (offset < response.len) {
        const bytes = response[offset..];
        if (bytes.len < 3 or bytes[0] != '\x1b') return error.InvalidOptions;
        var end: usize = 2;
        switch (bytes[1]) {
            '[' => {
                while (end < bytes.len and bytes[end] >= 0x30 and bytes[end] <= 0x3f) : (end += 1) {}
                while (end < bytes.len and bytes[end] >= 0x20 and bytes[end] <= 0x2f) : (end += 1) {}
                if (end == bytes.len) return error.InvalidOptions;
                end += 1;
                try validateCapabilityCsi(bytes[2..end]);
            },
            'P', ']', '_' => {
                // These reply payloads are printable ASCII. Only OSC accepts BEL;
                // all other string replies require ST, without nested escapes.
                while (end < bytes.len and bytes[end] >= 0x20 and bytes[end] <= 0x7e) : (end += 1) {}
                const payload = bytes[2..end];
                if (bytes[1] == ']' and end < bytes.len and bytes[end] == '\x07') {
                    end += 1;
                } else if (std.mem.startsWith(u8, bytes[end..], "\x1b\\")) {
                    end += 2;
                } else return error.InvalidOptions;
                try validateCapabilityString(bytes[1], payload);
            },
            else => return error.InvalidOptions,
        }
        // The legacy parser searches within one reply; batching must retain wire order.
        candidate.processCapabilityResponse(bytes[0..end]);
        offset += end;
    }
}

fn validateCapabilityString(kind: u8, payload: []const u8) Error!void {
    switch (kind) {
        'P' => {
            if (std.mem.startsWith(u8, payload, ">|")) {
                if (payload.len == 2) return error.InvalidOptions;
                return;
            }
            if (std.mem.eql(u8, payload, "0+r")) return;
            if (!std.mem.startsWith(u8, payload, "0+r") and !std.mem.startsWith(u8, payload, "1+r")) {
                return error.InvalidOptions;
            }
            var fields = std.mem.splitScalar(u8, payload[3..], '=');
            var count: u8 = 0;
            while (fields.next()) |field| {
                if (count == 2 or field.len % 2 != 0 or (count == 0 and field.len == 0)) {
                    return error.InvalidOptions;
                }
                for (field) |byte| {
                    if (!std.ascii.isHex(byte)) return error.InvalidOptions;
                }
                count += 1;
            }
        },
        ']' => {
            if (!std.mem.startsWith(u8, payload, "99;") and
                !std.mem.startsWith(u8, payload, "1337;Capabilities=")) return error.InvalidOptions;
        },
        '_' => {
            if (!std.mem.startsWith(u8, payload, "G")) return error.InvalidOptions;
            const separator = std.mem.findScalar(u8, payload, ';') orelse return error.InvalidOptions;
            if (separator == 1 or separator + 1 == payload.len) return error.InvalidOptions;
            var fields = std.mem.splitScalar(u8, payload[1..separator], ',');
            while (fields.next()) |field| {
                if (field.len < 3 or !std.ascii.isAlphabetic(field[0]) or field[1] != '=') {
                    return error.InvalidOptions;
                }
                for (field[2..]) |byte| {
                    if (!std.ascii.isDigit(byte)) return error.InvalidOptions;
                }
                _ = std.fmt.parseInt(u32, field[2..], 10) catch return error.InvalidOptions;
            }
        },
        else => unreachable,
    }
}

fn validateCapabilityCsi(payload: []const u8) Error!void {
    const final = payload[payload.len - 1];
    var parameters = payload[0 .. payload.len - 1];
    switch (final) {
        'y', 'u', 'c' => {
            if (!std.mem.startsWith(u8, parameters, "?")) return error.InvalidOptions;
            parameters = parameters[1..];
        },
        'R' => {},
        else => return error.InvalidOptions,
    }
    if (final == 'y') {
        if (!std.mem.endsWith(u8, parameters, "$")) return error.InvalidOptions;
        parameters = parameters[0 .. parameters.len - 1];
    }
    var values: [2]u16 = .{ 0, 0 };
    var count: usize = 0;
    var parts = std.mem.splitScalar(u8, parameters, ';');
    while (parts.next()) |part| {
        for (part) |byte| {
            if (!std.ascii.isDigit(byte)) return error.InvalidOptions;
        }
        const value = if (part.len == 0 and final == 'c') 0 else std.fmt.parseInt(u16, part, 10) catch return error.InvalidOptions;
        if (count < values.len) values[count] = value;
        count += 1;
    }
    switch (final) {
        'y' => {
            if (count != 2 or values[1] > 4) return error.InvalidOptions;
            switch (values[0]) {
                1004, 1016, 2004, 2026, 2027, 2031 => {},
                else => return error.InvalidOptions,
            }
        },
        'u' => if (count != 1 or values[0] > 31) return error.InvalidOptions,
        'R' => if (count != 2 or values[0] == 0 or values[1] == 0) return error.InvalidOptions,
        'c' => {},
        else => unreachable,
    }
}
